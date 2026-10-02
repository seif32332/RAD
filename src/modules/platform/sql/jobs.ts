// Reviewed raw SQL of the job runner (ARCH-009). JobRun and NotificationOutbox are platform
// infrastructure tables without a company (DOMAIN_BOUNDARIES §5.4.2), so no companyIds parameter.
import type { RootClient, TxClient } from '../tx';

/**
 * Serialises the start of runs of one job for the rest of the transaction (a transaction-scoped
 * advisory lock): "is another run RUNNING?" and "create my RUNNING row" happen as one step, so two
 * processes started at the same second cannot both start.
 */
export async function lockJobStart(tx: TxClient, job: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'jobrun/' + job}::text, 0))`;
}

export interface ClaimedOutboxRow {
  id: string;
  idempotencyKey: string;
  recipient: string;
  subject: string | null;
  body: string;
}

/**
 * Claims up to `batch` sendable EMAIL rows (PENDING, or FAILED with attempts left) with a lease, in
 * creation order. Two dispatchers never take the same row (FOR UPDATE SKIP LOCKED).
 */
export async function claimOutboxBatch(db: RootClient, args: { leaseUntil: Date; maxAttempts: number; batch: number }): Promise<ClaimedOutboxRow[]> {
  const { leaseUntil, maxAttempts, batch } = args;
  return db.$queryRaw<ClaimedOutboxRow[]>`
    UPDATE "NotificationOutbox"
       SET "status" = 'SENDING', "leaseUntil" = ${leaseUntil}, "attempts" = "attempts" + 1, "updatedAt" = NOW()
     WHERE "id" IN (
       SELECT "id" FROM "NotificationOutbox"
        WHERE "channel" = 'EMAIL'
          AND ("status" = 'PENDING' OR ("status" = 'FAILED' AND "attempts" < ${maxAttempts}))
        ORDER BY "createdAt"
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED)
    RETURNING "id", "idempotencyKey", "recipient", "subject", "body"`;
}
