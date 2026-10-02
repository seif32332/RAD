// rules transitions (P1-RULE): the sole writer of CompanyRuleOverride. Each one is a runTransition
// (operation key + change + audit row + event in ONE transaction; a repeated key returns the recorded
// result). No side effect runs here; the owner digest of DEC-PO-116 consumes `rules.override.*`.
//
// The legal bound of each key (catalogue.ts): a MIN key (annual leave, notice, sick-leave tiers,
// end-of-service rates…) goes up freely, a MAX key (probation, hours ceilings, EOS thresholds) down
// freely, a FIXED key (government fees, GOSI) is never overridable. DEC-PO-126: a value past a MIN
// floor or a MAX ceiling is accepted only with an explicit acknowledgement and a reason; without one
// the call throws RuleOverrideAckRequiredError (the legal value, for the UI warning). An accepted one
// is recorded on the row, audited, and emits `rules.override.belowLegal` (the owner alert of
// DEC-PO-022 consumes it; INV-RULE-02 reports it as an EXPLAINED discrepancy). The check runs against
// every legal version the override would overlap.
//
// The platform primitives are imported lazily so the module index stays importable from client pages
// (the pure helpers read the catalogue through it); only type imports sit at the top.
import type { AuditActor, RootClient, TxClient } from '@/modules/platform';
import { RuleOverrideAckRequiredError, dayKey, overrideBoundBreach, ruleDef, type LegalVersion } from './resolve';
import { RULES_OVERRIDE_BELOW_LEGAL_EVENT } from './events';
import { assertCompanyInScope, type RuleCompanyScope } from './scope';

export class RuleOverrideInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleOverrideInputError';
  }
}

export interface RuleOverrideOp {
  /** Idempotency-Key of the request, or derived from (actor, company, key, date, value). */
  key: string;
  actor: AuditActor;
}

export interface SetCompanyRuleOverrideInput {
  companyId: string;
  key: string;
  value: number;
  /** First day ('YYYY-MM-DD' or a date-only Date). */
  effectiveFrom: Date | string;
  reason: string;
  /** The caller's companies (iam CompanySet), or 'ALL' / null for an explicit cross-company context. */
  companyIds: RuleCompanyScope;
  /**
   * DEC-PO-126: the caller acknowledges that `value` is outside the legal bound (below a MIN floor,
   * above a MAX ceiling). Needed only then; ignored for a value within the bound.
   */
  acknowledgeBelowLegal?: boolean;
  /** Why the company departs from the law (required with acknowledgeBelowLegal). */
  belowLegalReason?: string;
}

export interface RevokeCompanyRuleOverrideInput {
  companyId: string;
  overrideId: string;
  reason: string;
  companyIds: RuleCompanyScope;
}

export interface OverrideView {
  id: string;
  companyId: string;
  key: string;
  value: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  revoked: boolean;
  /** DEC-PO-126: the recorded acknowledgement of a value outside the legal bound, else null. */
  belowLegal: { legalValue: number; reason: string; acknowledgedAt: string; acknowledgedById: string | null } | null;
}

export interface SetCompanyRuleOverrideResult {
  override: OverrideView;
  /** UNCHANGED (same value from the same day) | CREATED | UPDATED (same first day) | SPLIT (the running one ends). */
  mode: 'UNCHANGED' | 'CREATED' | 'UPDATED' | 'SPLIT';
  legalValue: number | null;
  /** DEC-PO-126: the value is outside the legal bound and was accepted with an acknowledgement. */
  belowLegal: boolean;
}

type Row = {
  id: string;
  companyId: string;
  key: string;
  value: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  revokedAt: Date | null;
  belowLegalAckAt: Date | null;
  belowLegalAckById: string | null;
  belowLegalReason: string | null;
  belowLegalLegalValue: number | null;
};

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (k: string): Date => new Date(`${k}T00:00:00.000Z`);

function view(r: Row): OverrideView {
  const belowLegal =
    r.belowLegalAckAt && r.belowLegalReason !== null && r.belowLegalLegalValue !== null
      ? { legalValue: r.belowLegalLegalValue, reason: r.belowLegalReason, acknowledgedAt: r.belowLegalAckAt.toISOString(), acknowledgedById: r.belowLegalAckById }
      : null;
  return { id: r.id, companyId: r.companyId, key: r.key, value: r.value, effectiveFrom: day(r.effectiveFrom)!, effectiveTo: day(r.effectiveTo), revoked: r.revokedAt !== null, belowLegal };
}

async function registryOf(tx: TxClient, key: string): Promise<LegalVersion[]> {
  const rows = await tx.ruleParameter.findMany({
    where: { key },
    select: { id: true, value: true, effectiveFrom: true, effectiveTo: true, status: true, sourceUrl: true },
    orderBy: { effectiveFrom: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, effectiveFrom: day(r.effectiveFrom)!, effectiveTo: day(r.effectiveTo), value: r.value, status: r.status, sourceUrl: r.sourceUrl }));
}

function actorId(a: AuditActor): string | null {
  return a.type === 'USER' ? a.id : null;
}

/**
 * Sets the company's value of `key` from `effectiveFrom` on. The override running that day ends
 * there; a later override (if any) bounds the new one. Idempotent on op.key (a concurrent repeat
 * waits on the operation key and returns the recorded result). Two different requests for the same
 * company, key and first day collide on the unique (companyId, key, effectiveFrom); two concurrent
 * requests on different first days of the same key are not serialized (settings edits, rare): the
 * reader then takes the latest start in force, so the result is still one value per day.
 */
export async function setCompanyRuleOverride(prisma: RootClient, input: SetCompanyRuleOverrideInput, op: RuleOverrideOp) {
  if (!input?.companyId?.trim()) throw new RuleOverrideInputError('companyId is required');
  if (!input.reason?.trim()) throw new RuleOverrideInputError('a reason is required');
  if (input.acknowledgeBelowLegal && !input.belowLegalReason?.trim()) throw new RuleOverrideInputError('a reason for departing from the legal value is required with acknowledgeBelowLegal');
  assertCompanyInScope(input.companyIds, input.companyId);
  const def = ruleDef(input.key);
  const value = Number(input.value);
  const from = dayKey(input.effectiveFrom);
  const { runTransition, audit, emitEvent } = await import('@/modules/platform');

  return runTransition<SetCompanyRuleOverrideResult>(
    prisma,
    { key: op.key, operation: 'rules.override.set', actorId: actorId(op.actor), companyId: input.companyId },
    async (tx) => {
      const rows: Row[] = await tx.companyRuleOverride.findMany({ where: { companyId: input.companyId, key: def.key }, orderBy: { effectiveFrom: 'asc' } });
      const active = rows.filter((r) => r.revokedAt === null);
      const sameDay = rows.find((r) => day(r.effectiveFrom) === from) ?? null;
      const running = active.find((r) => day(r.effectiveFrom)! < from && (r.effectiveTo === null || day(r.effectiveTo)! > from)) ?? null;
      const next = active.find((r) => day(r.effectiveFrom)! > from) ?? null;
      const to = sameDay && sameDay.revokedAt === null ? day(sameDay.effectiveTo) : running ? day(running.effectiveTo) : next ? day(next.effectiveFrom) : null;

      const registry = await registryOf(tx, def.key);
      // FIXED keys and non-finite values throw here; a breach of a MIN / MAX bound needs the acknowledgement.
      const breach = overrideBoundBreach(def.key, value, from, to, registry);
      if (breach && !input.acknowledgeBelowLegal) throw new RuleOverrideAckRequiredError(def.key, breach.bound, value, breach.legalValue, breach.legalFrom);
      const legal = registry.length ? registry : null;
      const legalValue = legal ? (legal.filter((v) => v.effectiveFrom <= from).pop()?.value ?? legal[0].value) : null;
      const belowLegal = breach !== null;
      const ack = breach
        ? { belowLegalAckAt: new Date(), belowLegalAckById: actorId(op.actor), belowLegalReason: input.belowLegalReason!.trim(), belowLegalLegalValue: breach.legalValue }
        : { belowLegalAckAt: null, belowLegalAckById: null, belowLegalReason: null, belowLegalLegalValue: null };

      if (sameDay && sameDay.revokedAt === null && sameDay.value === value && (sameDay.belowLegalAckAt !== null) === belowLegal) {
        return { override: view(sameDay), mode: 'UNCHANGED', legalValue, belowLegal };
      }
      const auditBase = { actor: op.actor, action: 'rules.override.set', reason: input.reason, operationKey: op.key };
      let row: Row;
      let mode: SetCompanyRuleOverrideResult['mode'];
      if (sameDay) {
        row = await tx.companyRuleOverride.update({
          where: { id: sameDay.id },
          data: { value, reason: input.reason, revokedAt: null, revokedById: null, effectiveTo: to ? asDate(to) : null, ...ack },
        });
        mode = 'UPDATED';
        await audit(tx, { ...auditBase, entity: { type: 'CompanyRuleOverride', id: row.id, companyId: input.companyId }, before: view(sameDay), after: view(row) });
      } else {
        if (running) {
          const closed = await tx.companyRuleOverride.update({ where: { id: running.id }, data: { effectiveTo: asDate(from) } });
          await audit(tx, { ...auditBase, entity: { type: 'CompanyRuleOverride', id: running.id, companyId: input.companyId }, before: view(running), after: view(closed) });
        }
        row = await tx.companyRuleOverride.create({
          data: {
            companyId: input.companyId,
            key: def.key,
            value,
            effectiveFrom: asDate(from),
            effectiveTo: to ? asDate(to) : null,
            reason: input.reason,
            createdById: actorId(op.actor),
            ...ack,
          },
        });
        mode = running ? 'SPLIT' : 'CREATED';
        await audit(tx, { ...auditBase, entity: { type: 'CompanyRuleOverride', id: row.id, companyId: input.companyId }, before: null, after: view(row) });
      }
      await emitEvent(tx, {
        type: 'rules.override.set',
        aggregateType: 'CompanyRuleOverride',
        aggregateId: row.id,
        idempotencyKey: `${op.key}:rules.override.set`,
        companyId: input.companyId,
        actorId: actorId(op.actor),
        effectiveDate: asDate(from),
        payload: { key: def.key, value, legalValue, effectiveFrom: from, effectiveTo: to, mode, belowLegal },
      });
      if (breach) {
        // The owner alert (DEC-PO-022 channel) consumes it, after this transaction commits.
        await emitEvent(tx, {
          type: RULES_OVERRIDE_BELOW_LEGAL_EVENT,
          aggregateType: 'CompanyRuleOverride',
          aggregateId: row.id,
          idempotencyKey: `${op.key}:${RULES_OVERRIDE_BELOW_LEGAL_EVENT}`,
          companyId: input.companyId,
          actorId: actorId(op.actor),
          effectiveDate: asDate(from),
          payload: { key: def.key, value, bound: breach.bound, legalValue: breach.legalValue, legalFrom: breach.legalFrom, effectiveFrom: from, effectiveTo: to, mode },
        });
      }
      return { override: view(row), mode, legalValue, belowLegal };
    },
  );
}

/**
 * Revokes an override: from its first day the company uses the legal value again. The row is kept
 * (revokedAt) so the history and the audit read the same. Idempotent on op.key; revoking a revoked
 * override changes nothing.
 */
export async function revokeCompanyRuleOverride(prisma: RootClient, input: RevokeCompanyRuleOverrideInput, op: RuleOverrideOp) {
  if (!input?.overrideId?.trim()) throw new RuleOverrideInputError('overrideId is required');
  if (!input.reason?.trim()) throw new RuleOverrideInputError('a reason is required');
  assertCompanyInScope(input.companyIds, input.companyId);
  const { runTransition, audit, emitEvent } = await import('@/modules/platform');

  return runTransition<{ override: OverrideView; changed: boolean }>(
    prisma,
    { key: op.key, operation: 'rules.override.revoke', actorId: actorId(op.actor), companyId: input.companyId },
    async (tx) => {
      const row: Row | null = await tx.companyRuleOverride.findUnique({ where: { id: input.overrideId } });
      if (!row || row.companyId !== input.companyId) throw new RuleOverrideInputError(`override ${input.overrideId} not found for company ${input.companyId}`);
      if (row.revokedAt) return { override: view(row), changed: false };
      const after: Row = await tx.companyRuleOverride.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedById: actorId(op.actor) } });
      await audit(tx, {
        actor: op.actor,
        action: 'rules.override.revoke',
        entity: { type: 'CompanyRuleOverride', id: row.id, companyId: row.companyId },
        before: view(row),
        after: view(after),
        reason: input.reason,
        operationKey: op.key,
      });
      await emitEvent(tx, {
        type: 'rules.override.revoked',
        aggregateType: 'CompanyRuleOverride',
        aggregateId: row.id,
        idempotencyKey: `${op.key}:rules.override.revoked`,
        companyId: row.companyId,
        actorId: actorId(op.actor),
        effectiveDate: row.effectiveFrom,
        payload: { key: row.key, value: row.value, effectiveFrom: day(row.effectiveFrom), effectiveTo: day(row.effectiveTo) },
      });
      return { override: view(after), changed: true };
    },
  );
}
