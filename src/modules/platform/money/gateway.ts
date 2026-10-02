// money.gateway (ARCH-004; pay-to-be.md BR-PAY-018 as amended by ARC-PAY-A1 / ADR-0001 #2): the GUARD,
// not the writer. Every money operation is registered here by the module that owns its tables, with
// the act it performs, the tables / columns it may write and how its beneficiaries and approvers are
// found. The owning module's transition calls runMoneyOperation inside its own transaction:
//
//   await runMoneyOperation(tx, LOAN_APPROVE, { actor, input, operationKey }, async (tx) => {
//     …the owning module's guarded writes…
//   });
//
// The gateway then
//   1. refuses an unregistered operation (the static test also pins where operations are defined);
//   2. resolves the actor: a USER operation takes the session user the caller passes (never a client
//      value); a SYSTEM operation (payroll.generate, settlement.approve's named effects) acts under its
//      fixed name, and the person who triggered it is recorded;
//   3. applies BR-PAY-001 (actor ∉ beneficiaries) and BR-PAY-002 (payer ∉ approvers) for the act, in
//      the tenant's operator mode (platform.operatorMode, DEC-PO-018): ENFORCED refuses, recording
//      money.guard.blocked with the ROOT client (the refused transaction rolls back, the record stays,
//      keyed by the operation key so a retry records once); SINGLE_OPERATOR lets the act through and
//      records SELF_ACT_SINGLE_OPERATOR (audit + money.guard.selfAct event) in the transaction;
//   4. runs the writer inside a frozen AsyncLocalStorage context that the Prisma extension checks on
//      every write (extension.ts): a write outside the operation's tables fails.
// Rule values are company defaults (DEC-PO-116); the gateway, its extension and ARCH-004 are not settings.
import { audit, type AuditActor } from '../audit';
import { emitEvent } from '../events';
import { resolveOperatorMode } from '../invariants/policy';
import type { OperatorMode } from '../invariants/types';
import { assertTransactionClient, type TxClient } from '../tx';
import { HttpError } from '@/lib/http';
import { runInMoneyContext, type MoneyContext } from './context';
import { GUARD_MESSAGES, MONEY_ACTS, decideReversal, decideSelfDealing, type GuardActor, type GuardDecision, type GuardReason, type MoneyAct } from './guards';
import type { Columns } from './writes';

/** The session user as the gateway needs it (AuthUser / iam Actor shaped). */
export interface MoneyActor {
  /** User.id from the session. */
  id: string;
  role?: string | null;
  /** Employee linked to the user, from the session (never from the request body). */
  employeeId: string | null;
}

/** The gateway actor of an authenticated session user (AuthUser / iam Actor shaped): id, role, employee. */
export function moneyActorOf(user: { id: string; role?: string | null; employeeId?: string | null }): MoneyActor {
  if (!user?.id) throw new HttpError(401, 'يجب تسجيل الدخول أولاً');
  return { id: user.id, role: user.role ?? null, employeeId: user.employeeId ?? null };
}

export interface MoneyOperationDefinition<I> {
  /** `<module>.<entity>.<act>`, e.g. `payroll.month.approve`. Stable: it is recorded in audits and events. */
  name: string;
  /** The module that owns the tables written (DOMAIN_BOUNDARIES §5.2). */
  owner: string;
  act: MoneyAct;
  /** USER: acts under the session user. SYSTEM: acts under its own name (the trigger is recorded). */
  source: 'USER' | 'SYSTEM';
  /** Tables and columns the writer may touch ('*' = every column). */
  writes: Readonly<Record<string, Columns>>;
  /** Override of the act's BR-PAY-001 default (DEC-PO-015 turns it off for payroll line payment). */
  notBeneficiary?: boolean;
  /** Override of the act's BR-PAY-002 default. */
  notApprover?: boolean;
  /** Employee ids that receive the money of the subject. */
  beneficiaries?: (tx: TxClient, input: I) => Promise<readonly (string | null | undefined)[]>;
  /** User ids that approved the subject or its inputs (BR-PAY-002 "approvers"). */
  approvers?: (tx: TxClient, input: I) => Promise<readonly (string | null | undefined)[]>;
  /**
   * A legacy writer site that is wrapped, not yet moved into the owning module's transitions (listed
   * in the package report, shrinks with ARCH-004): the file that holds the write.
   */
  legacySite?: string;
}

export interface MoneyOperation<I> extends Readonly<MoneyOperationDefinition<I>> {
  readonly notBeneficiary: boolean;
  readonly notApprover: boolean;
}

const NAME = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,3}$/;
const registry = new Map<string, MoneyOperation<never>>();

/** Registers a money operation (once per name). Called at module load by the owning module. */
export function defineMoneyOperation<I>(def: MoneyOperationDefinition<I>): MoneyOperation<I> {
  if (!NAME.test(def.name)) throw new Error(`money.gateway: invalid operation name "${def.name}"`);
  if (!(MONEY_ACTS as readonly string[]).includes(def.act)) throw new Error(`money.gateway: unknown act "${def.act}" for ${def.name}`);
  if (!def.owner?.trim()) throw new Error(`money.gateway: ${def.name} has no owner`);
  if (!Object.keys(def.writes ?? {}).length) throw new Error(`money.gateway: ${def.name} writes nothing`);
  if (registry.has(def.name)) throw new Error(`money.gateway: operation "${def.name}" is already registered`);
  const op: MoneyOperation<I> = Object.freeze({
    ...def,
    writes: Object.freeze({ ...def.writes }),
    notBeneficiary: def.notBeneficiary ?? ['CREATE_EFFECTIVE', 'APPROVE', 'TRANSFER', 'PAY', 'WAIVE', 'FORGIVE', 'SUSPEND', 'APPLY_CHANGE', 'ATTEST', 'REVERSE'].includes(def.act),
    notApprover: def.notApprover ?? ['PAY', 'TRANSFER', 'EXPORT'].includes(def.act),
  });
  registry.set(def.name, op as MoneyOperation<never>);
  return op;
}

/** The registered operations (for the report, the dashboard and the tests). */
export function moneyOperations(): MoneyOperation<never>[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function moneyOperation(name: string): MoneyOperation<never> | undefined {
  return registry.get(name);
}

/** 403 of a refused money act, with the reason shown on the button (pay-to-be §8, N-PAY-001). */
export class MoneyGuardBlockedError extends HttpError {
  readonly operation: string;
  readonly reasons: GuardReason[];
  constructor(operation: string, reasons: GuardReason[]) {
    super(403, GUARD_MESSAGES[reasons[0]] ?? 'إجراء مالي محجوب', { code: 'MONEY_GUARD_BLOCKED', operation, reasons });
    this.name = 'MoneyGuardBlockedError';
    this.operation = operation;
    this.reasons = reasons;
  }
}

export interface MoneyRunSpec<I> {
  /** The session user (USER operations); the trigger of a SYSTEM operation (optional). */
  actor: MoneyActor | null;
  input: I;
  /** The operation key of the call (the Idempotency-Key, or derived; LIFECYCLE_MODEL §2.2). */
  operationKey: string;
  /** Company of the subject, recorded on the blocked / self-act records. */
  companyId?: string | null;
  /** Operator mode already read by the caller (else read here, in the transaction). */
  mode?: OperatorMode;
  /** An extra decision the caller already took (the two-person REVERSE, a maker-checker). */
  decision?: GuardDecision;
}

export interface MoneyRunInfo {
  operation: string;
  mode: OperatorMode;
  /** The act broke a rule and went through as SELF_ACT_SINGLE_OPERATOR. */
  selfAct: boolean;
  reasons: GuardReason[];
  /** Audit actor of the writer's records (USER, or SYSTEM named after the operation). */
  auditActor: AuditActor;
  /** User id for the *ById columns (the session user; for a SYSTEM operation, its trigger or null). */
  actorUserId: string | null;
}

function guardActor(actor: MoneyActor | null): GuardActor | null {
  return actor ? { userId: actor.id, employeeId: actor.employeeId ?? null } : null;
}

/** money.guard.blocked with the root client: the refused transaction rolls back, this record stays. */
async function recordBlocked(op: MoneyOperation<never>, spec: MoneyRunSpec<unknown>, reasons: GuardReason[]): Promise<void> {
  try {
    const { prisma } = await import('@/lib/prisma');
    await prisma.$transaction(async (t) => {
      const { created } = await emitEvent(t, {
        type: 'money.guard.blocked',
        aggregateType: 'MoneyOperation',
        aggregateId: op.name,
        idempotencyKey: `money.guard.blocked:${spec.operationKey}`,
        payload: { operation: op.name, act: op.act, reasons, operationKey: spec.operationKey },
        companyId: spec.companyId ?? null,
        actorId: spec.actor?.id ?? null,
      });
      if (!created) return;
      await audit(t, {
        actor: spec.actor ? { type: 'USER', id: spec.actor.id } : { type: 'SYSTEM', id: op.name },
        action: 'MONEY_GUARD_BLOCKED',
        entity: { type: 'MoneyOperation', id: op.name, companyId: spec.companyId ?? null },
        after: { reasons, act: op.act },
        reason: reasons.join(','),
        operationKey: spec.operationKey,
      });
    });
  } catch (err) {
    // The refusal stands whatever happens to its record (EX-PAY-004); the log names the failure.
    console.error('money.gateway: could not record money.guard.blocked', err);
  }
}

/**
 * Runs the owning module's money writer `fn` behind the gateway (see the header). `tx` is the
 * transaction of the transition: the guards read inside it, the self-act record commits with it.
 */
export async function runMoneyOperation<I, T>(
  tx: TxClient,
  op: MoneyOperation<I>,
  spec: MoneyRunSpec<I>,
  fn: (tx: TxClient, info: MoneyRunInfo) => Promise<T>,
): Promise<T> {
  assertTransactionClient(tx, `money.gateway ${op?.name}`);
  if (!op || registry.get(op.name) !== (op as unknown as MoneyOperation<never>)) {
    throw new Error(`money.gateway: operation "${op?.name}" is not registered`);
  }
  if (!spec.operationKey?.trim()) throw new Error(`money.gateway: ${op.name} needs an operation key`);
  if (op.source === 'USER' && !spec.actor?.id) throw new HttpError(401, 'يجب تسجيل الدخول أولاً');

  const mode = spec.mode ?? (await resolveOperatorMode(tx));
  const actor = guardActor(spec.actor);
  let decision: GuardDecision = { ok: true, reasons: [], selfAct: false };
  if (op.source === 'USER' && actor) {
    const [beneficiaries, approvers] = await Promise.all([
      op.notBeneficiary && op.beneficiaries ? op.beneficiaries(tx, spec.input) : Promise.resolve([]),
      op.notApprover && op.approvers ? op.approvers(tx, spec.input) : Promise.resolve([]),
    ]);
    decision = decideSelfDealing({ act: op.act, actor, beneficiaries, approvers, notBeneficiary: op.notBeneficiary, notApprover: op.notApprover, mode });
  }
  if (spec.decision) {
    const reasons = [...new Set([...decision.reasons, ...spec.decision.reasons])];
    decision = { ok: decision.ok && spec.decision.ok, reasons, selfAct: (decision.ok && spec.decision.ok) && reasons.length > 0 };
  }
  if (!decision.ok) {
    await recordBlocked(op as unknown as MoneyOperation<never>, spec as MoneyRunSpec<unknown>, decision.reasons);
    throw new MoneyGuardBlockedError(op.name, decision.reasons);
  }

  const auditActor: AuditActor = op.source === 'USER' && spec.actor ? { type: 'USER', id: spec.actor.id } : { type: 'SYSTEM', id: op.name };
  if (decision.selfAct) {
    await audit(tx, {
      actor: auditActor,
      action: 'SELF_ACT_SINGLE_OPERATOR',
      entity: { type: 'MoneyOperation', id: op.name, companyId: spec.companyId ?? null },
      after: { reasons: decision.reasons, act: op.act },
      reason: `SELF_ACT_SINGLE_OPERATOR: ${decision.reasons.join(',')}`,
      operationKey: spec.operationKey,
    });
    await emitEvent(tx, {
      type: 'money.guard.selfAct',
      aggregateType: 'MoneyOperation',
      aggregateId: op.name,
      idempotencyKey: `money.guard.selfAct:${spec.operationKey}`,
      payload: { operation: op.name, act: op.act, reasons: decision.reasons, operationKey: spec.operationKey },
      companyId: spec.companyId ?? null,
      actorId: spec.actor?.id ?? null,
    });
  }

  const info: MoneyRunInfo = {
    operation: op.name,
    mode,
    selfAct: decision.selfAct,
    reasons: decision.reasons,
    auditActor,
    actorUserId: spec.actor?.id ?? null,
  };
  const ctx: MoneyContext = {
    operation: op.name,
    operationKey: spec.operationKey,
    allow: new Map(Object.entries(op.writes)),
    actorUserId: info.actorUserId,
  };
  return runInMoneyContext(ctx, () => fn(tx, info));
}

/**
 * reverseMoney (§18; BR-PAY-015 "الإلغاء الحقيقي"): the REVERSE act of a registered operation, by a
 * second person (the actor) on the request of a first one, neither of them a beneficiary. The effects
 * (bonuses unpaid, deductions unlinked, loan balances and states restored, the payment request
 * returned) are the owning module's `fn`; BL-PAY-009 and BL-LCY-015 are its users.
 */
export async function reverseMoney<I, T>(
  tx: TxClient,
  op: MoneyOperation<I>,
  spec: MoneyRunSpec<I> & { requestedBy: MoneyActor },
  fn: (tx: TxClient, info: MoneyRunInfo) => Promise<T>,
): Promise<T> {
  if (op.act !== 'REVERSE') throw new Error(`money.gateway: ${op.name} is not a REVERSE operation`);
  if (!spec.actor) throw new HttpError(401, 'يجب تسجيل الدخول أولاً');
  const mode = spec.mode ?? (await resolveOperatorMode(tx));
  const beneficiaries = op.beneficiaries ? await op.beneficiaries(tx, spec.input) : [];
  const decision = decideReversal({ requestedBy: guardActor(spec.requestedBy)!, approver: guardActor(spec.actor)!, beneficiaries, mode });
  return runMoneyOperation(tx, op, { ...spec, mode, decision }, fn);
}
