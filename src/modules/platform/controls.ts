// The controls mode of a legal company (BR-PAY-020, DEC-PO-018; BL-PAY-021, ADR-0009, DEC-PO-144). ENFORCED: every
// two-person condition applies. SINGLE_OPERATOR: a two-person condition that cannot be met does not refuse; the
// act is recorded (SELF_ACT_SINGLE_OPERATOR) and reported to the owner.
//
// The mode is COMPUTED per legal company from identity facts (iam: the attested approvers who can act in that
// company, once Radeef has marked the company ready), never a setting. platform sits below iam (DOMAIN_BOUNDARIES
// §5.3), so iam registers the one resolver here (a read port, like the workflow core's ports) when its index is
// loaded, and every reader (money.gateway, the maker-checker callers, the discrepancy transitions, the engine
// later) asks resolveOperatorMode with THE COMPANY OF THE ACT. Fail closed: no resolver registered (a process
// that never loaded iam), or no company (an act whose company is unknown), is ENFORCED, the stricter mode.
//
// The second half is the platform reads the owner digest needs (AuditRecord, Discrepancy and DomainEvent
// are platform tables, ARCH-001): the single-operator records of a period, the counts per action, the
// pending owner confirmations and the latest event of an aggregate.
import type { Prisma, PrismaClient } from '@prisma/client';
import type { OperatorMode } from './invariants/types';

type Db = PrismaClient | Prisma.TransactionClient;

/** iam's computation for one company (registered once; called only with a company id). */
export type OperatorModeResolver = (db: Db, companyId: string) => Promise<OperatorMode>;

let registered: { owner: string; resolve: OperatorModeResolver } | null = null;

/**
 * Registers THE resolver of the controls mode (iam, once per process). A second registration by another
 * owner is refused: there is one source of the mode. Re-registering the same owner (a reloaded module) is a no-op.
 */
export function registerOperatorModeResolver(owner: string, resolve: OperatorModeResolver): void {
  if (!owner?.trim() || typeof resolve !== 'function') throw new Error('registerOperatorModeResolver: owner and resolver are required');
  if (registered && registered.owner !== owner) throw new Error(`controls mode: a resolver is already registered by "${registered.owner}"`);
  registered = { owner, resolve };
}

/** Who registered the resolver (tests and the dashboard); null = none (the mode reads ENFORCED). */
export function operatorModeResolverOwner(): string | null {
  return registered?.owner ?? null;
}

/**
 * The controls mode of the company of an act, read on the server (never from a client), inside the caller's
 * transaction when it has one. No company, no resolver, or anything but SINGLE_OPERATOR: ENFORCED.
 */
export async function resolveOperatorMode(db: Db, companyId: string | null | undefined): Promise<OperatorMode> {
  if (!registered || typeof companyId !== 'string' || !companyId.trim()) return 'ENFORCED';
  const mode = await registered.resolve(db, companyId);
  return mode === 'SINGLE_OPERATOR' ? 'SINGLE_OPERATOR' : 'ENFORCED';
}

// ---------------------------------------------------------------------------------------------------
// Reads for the owner digest (BL-PAY-021)
// ---------------------------------------------------------------------------------------------------

export const SELF_ACT_ACTION = 'SELF_ACT_SINGLE_OPERATOR';

export interface Period {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

/** One act done alone because no eligible second person existed, as the owner sees it. */
export interface SelfActRecord {
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  /** The operation (money operation name, or the module's audit action). */
  operation: string;
  entityType: string;
  entityId: string | null;
  companyId: string | null;
  /** The rules the act broke (GuardReason names; empty when the record names none). */
  reasons: string[];
  operationKey: string | null;
}

function reasonsOf(after: Prisma.JsonValue | null, reason: string | null): string[] {
  const fromAfter = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>).reasons : null;
  if (Array.isArray(fromAfter)) return fromAfter.filter((r): r is string => typeof r === 'string');
  const m = /^SELF_ACT_SINGLE_OPERATOR:\s*([A-Z_,\s]+)/.exec(reason ?? '');
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The single-operator records of a period (AuditRecord): money.gateway's SELF_ACT_SINGLE_OPERATOR rows and the
 * modules' own rows whose reason starts with it (lifecycle, legacy writers). One record per operation key: the
 * gateway's row names the operation and the reasons, the module's row of the same key adds the entity.
 */
export async function selfActRecords(db: Db, period: Period, take = 5000): Promise<SelfActRecord[]> {
  const rows = await db.auditRecord.findMany({
    where: {
      occurredAt: { gte: period.from, lt: period.to },
      OR: [{ action: SELF_ACT_ACTION }, { reason: { startsWith: SELF_ACT_ACTION } }],
    },
    orderBy: { seq: 'asc' },
    take,
    select: { occurredAt: true, actorType: true, actorId: true, action: true, entityType: true, entityId: true, companyId: true, after: true, reason: true, operationKey: true },
  });
  const out: SelfActRecord[] = [];
  const byKey = new Map<string, SelfActRecord>();
  for (const r of rows) {
    const gateway = r.action === SELF_ACT_ACTION;
    const rec: SelfActRecord = {
      occurredAt: r.occurredAt,
      actorType: r.actorType,
      actorId: r.actorId,
      operation: gateway ? (r.entityId ?? r.action) : r.action,
      entityType: gateway ? 'MoneyOperation' : r.entityType,
      entityId: gateway ? null : r.entityId,
      companyId: r.companyId,
      reasons: reasonsOf(r.after, r.reason),
      operationKey: r.operationKey,
    };
    const prev = r.operationKey ? byKey.get(r.operationKey) : undefined;
    if (!prev) {
      out.push(rec);
      if (r.operationKey) byKey.set(r.operationKey, rec);
      continue;
    }
    // Same operation: keep one record, the reasons of both, the entity of the module's row.
    prev.reasons = [...new Set([...prev.reasons, ...rec.reasons])];
    if (!gateway) {
      prev.entityType = rec.entityType;
      prev.entityId = rec.entityId;
      prev.companyId = prev.companyId ?? rec.companyId;
    }
  }
  return out;
}

/** AuditRecord counts per action in a period, for the actions that start with one of `prefixes` (or equal one of `actions`). */
export async function auditActionCounts(db: Db, period: Period, q: { prefixes?: readonly string[]; actions?: readonly string[] }): Promise<Record<string, number>> {
  const or: Prisma.AuditRecordWhereInput[] = [
    ...(q.prefixes ?? []).map((p) => ({ action: { startsWith: p } })),
    ...(q.actions?.length ? [{ action: { in: [...q.actions] } }] : []),
  ];
  if (!or.length) return {};
  const groups = await db.auditRecord.groupBy({
    by: ['action'],
    where: { occurredAt: { gte: period.from, lt: period.to }, OR: or },
    _count: { _all: true },
  });
  return Object.fromEntries(groups.map((g) => [g.action, g._count._all]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

/** The audit rows of the given actions in a period (oldest first, capped). */
export async function auditRecordsOf(db: Db, period: Period, actions: readonly string[], take = 500) {
  if (!actions.length) return [];
  return db.auditRecord.findMany({
    where: { occurredAt: { gte: period.from, lt: period.to }, action: { in: [...actions] } },
    orderBy: { seq: 'asc' },
    take,
    select: { occurredAt: true, actorType: true, actorId: true, action: true, entityType: true, entityId: true, companyId: true, after: true, reason: true },
  });
}

/** Discrepancy explanations / waivers the sole operator made alone in a period, per company (null: tenant-level). */
export async function discrepancySelfActCounts(db: Db, period: Period): Promise<{ companyId: string | null; count: number }[]> {
  const groups = await db.auditRecord.groupBy({
    by: ['companyId'],
    where: {
      occurredAt: { gte: period.from, lt: period.to },
      entityType: 'Discrepancy',
      action: { in: ['platform.discrepancy.explain', 'platform.discrepancy.requestWaiver'] },
      after: { path: ['change', 'selfActSingleOperator'], equals: true },
    },
    _count: { _all: true },
  });
  return groups.map((g) => ({ companyId: g.companyId, count: g._count._all }));
}

/** A classification the sole operator made alone, waiting for the owner's answer over the DEC-PO-022 channel. */
export interface PendingOwnerConfirmation {
  id: string;
  ruleId: string;
  companyId: string | null;
  status: string;
  /** EXPLANATION | WAIVER while the confirmation blocks (INV-PAY-03); null when it was applied and is confirmed after. */
  pendingAction: string | null;
  blocking: boolean;
  version: number;
  explanation: string | null;
  explanationRef: string | null;
  waiverReason: string | null;
  actedById: string | null;
  actedAt: Date | null;
}

/** Every pending owner confirmation of the tenant (oldest first). */
export async function pendingOwnerConfirmations(db: Db, take = 500): Promise<PendingOwnerConfirmation[]> {
  const rows = await db.discrepancy.findMany({
    where: { selfActSingleOperator: true, ownerConfirmation: 'PENDING' },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true, ruleId: true, companyId: true, status: true, pendingAction: true, blocking: true, version: true,
      explanation: true, explanationRef: true, waiverReason: true, explainedById: true, explainedAt: true, waivedById: true, waivedAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    companyId: r.companyId,
    status: r.status,
    pendingAction: r.pendingAction,
    blocking: r.blocking,
    version: r.version,
    explanation: r.explanation,
    explanationRef: r.explanationRef,
    waiverReason: r.waiverReason,
    actedById: r.waivedById ?? r.explainedById,
    actedAt: r.waivedAt ?? r.explainedAt,
  }));
}

/** The latest event of an aggregate (optionally of one type), by recorded order. */
export async function latestEventOf(db: Db, q: { aggregateType: string; aggregateId: string; type?: string }) {
  return db.domainEvent.findFirst({
    where: { aggregateType: q.aggregateType, aggregateId: q.aggregateId, ...(q.type ? { type: q.type } : {}) },
    orderBy: { seq: 'desc' },
    select: { id: true, seq: true, type: true, payload: true, occurredAt: true },
  });
}

/** The events of an aggregate of one type, oldest first (capped). */
export async function eventsOf(db: Db, q: { aggregateType: string; aggregateId: string; type?: string }, take = 500) {
  return db.domainEvent.findMany({
    where: { aggregateType: q.aggregateType, aggregateId: q.aggregateId, ...(q.type ? { type: q.type } : {}) },
    orderBy: { seq: 'asc' },
    take,
    select: { id: true, seq: true, type: true, payload: true, occurredAt: true },
  });
}

/** Queued emails whose key starts with `prefix`, newest first (the owner digests). */
export async function outboxByPrefix(db: Db, prefix: string, take = 24) {
  if (!prefix) return [];
  return db.notificationOutbox.findMany({
    where: { idempotencyKey: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
    take,
    select: { idempotencyKey: true, recipient: true, subject: true, body: true, status: true, attempts: true, sentAt: true, createdAt: true, lastError: true },
  });
}
