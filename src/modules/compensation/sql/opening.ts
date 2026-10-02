// Reviewed raw SQL of compensation (ARCH-009): calls of the legacy-opening functions of migration 9zg
// (compensation_backfill_legacy_compensation, compensation_backfill_bank_identities). They write through
// the single writer of LEGACY_OPENING periods, effective_open_legacy_period (ARC-SYS-A3); TypeScript never
// re-implements them (single definition). Company-scoped: the caller passes its companies.
import type { TxClient } from '@/modules/platform';

export interface LegacyOpeningRow {
  /** OPENED | ALREADY_OPENED | SKIPPED | SKIPPED_HAS_PERIODS */
  outcome: string;
  reason: string | null;
  employees: number;
  employeeIds: string[] | null;
}

/** Employees of `companyIds` with pay on their row and no fact for it (the job's pre-check). */
export async function callMissingOpenings(tx: Pick<TxClient, '$queryRaw'>, companyIds: readonly string[]): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>`SELECT "compensation_missing_openings"(${[...companyIds]}::text[]) AS "n"`;
  return Number(rows[0]?.n ?? 0);
}

/** CompensationPeriod openings of the employees of `companyIds` that have none (legal, else actual company). */
export async function callBackfillLegacyCompensation(tx: TxClient, companyIds: readonly string[], actor: string | null): Promise<LegacyOpeningRow[]> {
  return tx.$queryRaw<LegacyOpeningRow[]>`
    SELECT "outcome", "reason", "employees", "employeeIds"
      FROM "compensation_backfill_legacy_compensation"(${[...companyIds]}::text[], ${actor})`;
}

/** BankIdentityPeriod openings of the employees of `companyIds` that have none. */
export async function callBackfillBankIdentities(tx: TxClient, companyIds: readonly string[], actor: string | null): Promise<LegacyOpeningRow[]> {
  return tx.$queryRaw<LegacyOpeningRow[]>`
    SELECT "outcome", "reason", "employees", "employeeIds"
      FROM "compensation_backfill_bank_identities"(${[...companyIds]}::text[], ${actor})`;
}
