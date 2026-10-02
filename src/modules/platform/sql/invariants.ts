// Reviewed raw SQL of the invariant engine (ARCH-009: raw SQL lives in src/modules/*/sql/ only).
// Neither statement touches a table: one sets the snapshot mode of the checks' transaction, the other
// serialises the writes of reconcile per company.
import type { TxClient } from '../tx';

/**
 * Makes the current transaction one REPEATABLE READ, READ ONLY snapshot (must be its first statement)
 * and verifies it: PostgreSQL itself then refuses any write made by a check.
 */
export async function beginReadOnlySnapshot(tx: TxClient): Promise<void> {
  await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
  const mode = await tx.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
  if (mode[0]?.transaction_read_only !== 'on') throw new Error('reconcile: the snapshot transaction is not READ ONLY; refusing to run the checks');
}

/**
 * Transaction-scoped advisory lock on one company's reconcile writes (`companyKey` = the company id,
 * or '(tenant)' for the tenant-level pass). Two reconcile calls for the same company run their write
 * transactions one after the other; the second one sees the first one's rows.
 */
export async function lockReconcileWrites(tx: TxClient, companyKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`platform.reconcile:${companyKey}`}, 0))`;
}
