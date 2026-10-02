// Read side of the outbox for the gates of the modules above (ARC-PAY-A9: payroll's employment gate is
// keyed on (event, month) — "no approval while an employment.* event of this employee is not consumed
// by payroll.employment"). platform owns DomainEvent / EventConsumption (§5.2), so the modules read them
// here, never through their tables (ARCH-001).
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface EventConsumptionView {
  eventId: string;
  type: string;
  aggregateId: string;
  companyId: string | null;
  effectiveDate: Date | null;
  recordedAt: Date;
  payload: Prisma.JsonValue;
  /** The consumer's row: null when it never ran on the event. */
  status: string | null;
  outcome: string | null;
  lastError: string | null;
}

export interface ConsumptionQuery {
  consumer: string;
  types: readonly string[];
  aggregateType: string;
  /** The aggregates (e.g. employees) to look at; empty = none. */
  aggregateIds?: readonly string[];
  /** Only events whose effective date (else recording day) is on or before this day. */
  effectiveOnOrBefore?: Date;
}

const SELECT = {
  id: true,
  type: true,
  aggregateId: true,
  companyId: true,
  effectiveDate: true,
  recordedAt: true,
  payload: true,
} as const;

function eventWhere(q: ConsumptionQuery): Prisma.DomainEventWhereInput {
  const where: Prisma.DomainEventWhereInput = { type: { in: [...q.types] }, aggregateType: q.aggregateType };
  if (q.aggregateIds) where.aggregateId = { in: [...q.aggregateIds] };
  if (q.effectiveOnOrBefore) {
    where.OR = [{ effectiveDate: { lte: q.effectiveOnOrBefore } }, { effectiveDate: null, recordedAt: { lte: q.effectiveOnOrBefore } }];
  }
  return where;
}

/**
 * Events of the given types and aggregates that `consumer` has not settled: no consumption row yet,
 * or a FAILED one being retried. DONE and DEAD are settled (a DEAD one surfaces as a discrepancy of the
 * owning module's invariant, where it can be explained). Oldest first.
 */
export async function eventsNotConsumed(db: Db, q: ConsumptionQuery): Promise<EventConsumptionView[]> {
  if (q.aggregateIds && !q.aggregateIds.length) return [];
  const rows = await db.domainEvent.findMany({
    where: { ...eventWhere(q), consumptions: { none: { consumer: q.consumer, status: { in: ['DONE', 'DEAD'] } } } },
    select: { ...SELECT, consumptions: { where: { consumer: q.consumer }, select: { status: true, outcome: true, lastError: true } } },
    orderBy: { seq: 'asc' },
    take: 500,
  });
  return rows.map((r) => ({
    eventId: r.id,
    type: r.type,
    aggregateId: r.aggregateId,
    companyId: r.companyId,
    effectiveDate: r.effectiveDate,
    recordedAt: r.recordedAt,
    payload: r.payload,
    status: r.consumptions[0]?.status ?? null,
    outcome: r.consumptions[0]?.outcome ?? null,
    lastError: r.consumptions[0]?.lastError ?? null,
  }));
}

/**
 * Consumptions of `consumer` in the given statuses and / or with the given outcomes (e.g. DEAD, or
 * DONE with outcome HELD), with their events. For the invariant checks of the owning module.
 */
export async function consumptionsOf(
  db: Db,
  q: { consumer: string; types: readonly string[]; statuses?: readonly string[]; outcomes?: readonly string[]; take?: number },
): Promise<EventConsumptionView[]> {
  const or: Prisma.EventConsumptionWhereInput[] = [];
  if (q.statuses?.length) or.push({ status: { in: [...q.statuses] } });
  if (q.outcomes?.length) or.push({ outcome: { in: [...q.outcomes] } });
  if (!or.length) return [];
  const rows = await db.eventConsumption.findMany({
    where: { consumer: q.consumer, OR: or, event: { type: { in: [...q.types] } } },
    select: { status: true, outcome: true, lastError: true, event: { select: SELECT } },
    orderBy: { createdAt: 'asc' },
    take: q.take ?? 5000,
  });
  return rows.map((r) => ({
    eventId: r.event.id,
    type: r.event.type,
    aggregateId: r.event.aggregateId,
    companyId: r.event.companyId,
    effectiveDate: r.event.effectiveDate,
    recordedAt: r.event.recordedAt,
    payload: r.event.payload,
    status: r.status,
    outcome: r.outcome,
    lastError: r.lastError,
  }));
}
