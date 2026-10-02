// Reviewed raw SQL of the platform outbox (ARCH-009: raw SQL lives in src/modules/*/sql/ only).
// DomainEvent carries the companyId of its event. The dispatcher is either run per company
// (companyIds = the companies of a SystemContext) or, explicitly, across companies (companyIds = null):
// DOMAIN_BOUNDARIES §5.4.2 names the outbox as a job defined cross-company.
import type { Prisma } from '@prisma/client';
import type { RootClient, TxClient } from '../tx';

export interface ClaimedEventRow {
  id: string;
  seq: bigint;
  type: string;
  aggregateType: string;
  aggregateId: string;
  companyId: string | null;
  actorId: string | null;
  payload: Prisma.JsonValue;
  idempotencyKey: string;
  occurredAt: Date;
  effectiveDate: Date | null;
  recordedAt: Date;
}

/**
 * Claims up to `batch` due PENDING events of the given types with a lease. Two dispatchers never claim
 * the same row (FOR UPDATE SKIP LOCKED + lease). Ordering per aggregate: an event is not claimed while
 * an earlier event of the same aggregate (of a handled type) is still PENDING.
 */
export async function claimDueEvents(
  client: RootClient,
  /** Only events of these companies; null = every event, including those without a company (cross-company run). */
  companyIds: readonly string[] | null,
  args: { types: string[]; now: Date; leaseUntil: Date; batch: number },
): Promise<ClaimedEventRow[]> {
  const { types, now, leaseUntil, batch } = args;
  const companies = companyIds === null ? null : [...companyIds];
  return client.$queryRaw<ClaimedEventRow[]>`
    UPDATE "DomainEvent"
       SET "leaseUntil" = ${leaseUntil}, "attempts" = "attempts" + 1
     WHERE "id" IN (
       SELECT e."id" FROM "DomainEvent" e
        WHERE e."status" = 'PENDING'
          AND e."type" = ANY(${types}::text[])
          AND (${companies}::text[] IS NULL OR e."companyId" = ANY(${companies}::text[]))
          AND (e."nextAttemptAt" IS NULL OR e."nextAttemptAt" <= ${now})
          AND (e."leaseUntil" IS NULL OR e."leaseUntil" < ${now})
          AND NOT EXISTS (
            SELECT 1 FROM "DomainEvent" p
             WHERE p."aggregateType" = e."aggregateType"
               AND p."aggregateId" = e."aggregateId"
               AND p."seq" < e."seq"
               AND p."status" = 'PENDING'
               AND p."type" = ANY(${types}::text[]))
        ORDER BY e."seq"
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED)
    RETURNING "id", "seq", "type", "aggregateType", "aggregateId", "companyId", "actorId", "payload",
              "idempotencyKey", "occurredAt", "effectiveDate", "recordedAt"`;
}

/**
 * Serialises work on one (consumer, event) pair for the rest of the transaction, whether or not its
 * EventConsumption row exists yet (a transaction-scoped advisory lock; a hash collision only costs
 * extra serialisation).
 */
export async function lockConsumption(tx: TxClient, consumer: string, eventId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${consumer}::text || '/' || ${eventId}::text, 0))`;
}
