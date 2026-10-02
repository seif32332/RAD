// offboarding transitions. First slice (P1-LCY): the Employee.exitReason / exitVoluntary projection,
// whose projector is offboarding (SOURCE_OF_TRUTH §3.1 "سبب الخروج وتاريخه", ARCH-003). Until the
// ExitCase of P3-OFF exists, the recorded exit reason is the one on the latest EmploymentStateChange
// (ARC-LCY-A1: reasonCode from the ExitReason dictionary); this function copies it onto the employee.
// It is called in the same transaction by the exit commands that already hold one (the routes), and
// by the consumer of the employment.* events (./consumers) for every other path, so the projection
// converges whatever the order (it always reads the latest fact, never an event's payload).
//
// Second slice (DEC-PO-128): the settlement effect log (recordSettlementEffects, table SettlementEffect).
import { Prisma } from '@prisma/client';
import { employeeForLifecycle } from '@/modules/people';
import { latestStateChange } from '@/modules/lifecycle';
import { assertTransactionClient, audit, idempotent, type AuditActor, type TxClient } from '@/modules/platform';
import { SETTLEMENT_EFFECT_KINDS, type SettlementEffectInput } from './effects';

export interface ProjectExitReasonResult {
  employeeId: string;
  changed: boolean;
  exitReason: string | null;
  exitVoluntary: boolean | null;
}

/**
 * Employee.exitReason / exitVoluntary := those of the latest employment state change (null after a
 * cancelled exit, a rehire or a void). Idempotent: on the operation key, and by nature (a repeat
 * finds nothing to change).
 */
export async function projectExitReason(tx: TxClient, employeeId: string, op: { key: string; actor: AuditActor }): Promise<ProjectExitReasonResult> {
  assertTransactionClient(tx, 'projectExitReason');
  if (!employeeId?.trim()) throw new Error('projectExitReason: employeeId is required');
  const outcome = await idempotent(tx, { key: op.key, operation: 'offboarding.exitReason.project', actorId: op.actor.type === 'USER' ? op.actor.id : null }, async (t) => {
    const [emp, latest] = await Promise.all([employeeForLifecycle(t, employeeId), latestStateChange(t, employeeId)]);
    if (!emp) throw new Error(`projectExitReason: employee ${employeeId} not found`);
    const exitReason = latest?.exitReason ?? null;
    const exitVoluntary = latest?.exitVoluntary ?? null;
    if (!latest || (emp.exitReason === exitReason && emp.exitVoluntary === exitVoluntary)) {
      return { employeeId, changed: false, exitReason: emp.exitReason, exitVoluntary: emp.exitVoluntary };
    }
    await t.employee.updateMany({ where: { id: employeeId }, data: { exitReason, exitVoluntary } });
    await audit(t, {
      actor: op.actor,
      action: 'offboarding.exitReason.project',
      entity: { type: 'Employee', id: employeeId, companyId: emp.legalCompanyId },
      before: { exitReason: emp.exitReason, exitVoluntary: emp.exitVoluntary },
      after: { exitReason, exitVoluntary, stateChangeId: latest.id },
      operationKey: op.key,
    });
    return { employeeId, changed: true, exitReason, exitVoluntary };
  });
  return outcome.result;
}

export interface RecordSettlementEffectsResult {
  settlementId: string;
  /** Rows written by this call. */
  recorded: number;
  /** Effects already on the log (a repeated call: nothing is added). */
  existing: number;
}

/**
 * Records the effects of a settlement approval (BL-LCY-015, SettlementEffect of 9zd) in the caller's
 * transaction: the owner approval (finance.approveSettlement) calls it after applying the effects, so
 * the approval and its log commit together. Append-only; idempotent on (settlement, kind, reference):
 * a repeated or concurrent call adds nothing.
 */
export async function recordSettlementEffects(
  tx: TxClient,
  input: { settlementId: string; effects: readonly SettlementEffectInput[]; recordedAt?: Date },
): Promise<RecordSettlementEffectsResult> {
  assertTransactionClient(tx, 'recordSettlementEffects');
  if (!input.settlementId?.trim()) throw new Error('recordSettlementEffects: settlementId is required');
  const seen = new Set<string>();
  for (const e of input.effects) {
    if (!(SETTLEMENT_EFFECT_KINDS as readonly string[]).includes(e.kind)) throw new Error(`recordSettlementEffects: unknown effect kind ${e.kind}`);
    if (!e.refId?.trim()) throw new Error(`recordSettlementEffects: ${e.kind} without a reference`);
    const k = `${e.kind}:${e.refId}`;
    if (seen.has(k)) throw new Error(`recordSettlementEffects: ${k} listed twice`);
    seen.add(k);
  }
  const settlement = await tx.settlement.findUnique({ where: { id: input.settlementId }, select: { id: true, employeeId: true } });
  if (!settlement) throw new Error(`recordSettlementEffects: settlement ${input.settlementId} not found`);
  if (!input.effects.length) return { settlementId: settlement.id, recorded: 0, existing: 0 };
  const json = (v: Prisma.InputJsonValue | null) => (v === null ? Prisma.DbNull : v);
  const res = await tx.settlementEffect.createMany({
    data: input.effects.map((e) => ({
      settlementId: settlement.id,
      employeeId: settlement.employeeId,
      kind: e.kind,
      refId: e.refId,
      before: json(e.before),
      after: json(e.after),
      ...(input.recordedAt ? { recordedAt: input.recordedAt } : {}),
    })),
    skipDuplicates: true,
  });
  return { settlementId: settlement.id, recorded: res.count, existing: input.effects.length - res.count };
}

/** The approval's dependency on the log writer (finance sits below offboarding and cannot import it, §5.3). */
export type RecordSettlementEffects = typeof recordSettlementEffects;
