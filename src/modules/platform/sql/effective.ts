// Reviewed raw SQL of the effective-period primitive (ARCH-009). Both functions live in migration
// 9u_effective_periods: effective_open_legacy_period() is THE single writer of LEGACY_OPENING
// periods (ARC-SYS-A3), and effective_backfill_legacy_openings() is the P1-FND-EFF backfill that the
// migration itself ran once. TypeScript calls the same definitions; it never re-implements them.
import type { TxClient } from '../tx';

export interface LegacyOpenRow {
  periodId: string | null;
  /** OPENED | ALREADY_OPENED | SKIPPED_HAS_PERIODS */
  outcome: string;
}

export async function callOpenLegacyPeriod(
  tx: TxClient,
  args: { kind: string; employeeId: string; validFrom: string; validTo: string | null; attrs: Record<string, unknown>; createdById: string | null },
): Promise<LegacyOpenRow> {
  // Dates travel as 'YYYY-MM-DD' text: a JS Date would be cast through the session time zone.
  const rows = await tx.$queryRaw<LegacyOpenRow[]>`
    SELECT "periodId", "outcome"
      FROM "effective_open_legacy_period"(${args.kind}, ${args.employeeId}, ${args.validFrom}::date, ${args.validTo}::date,
                                          ${JSON.stringify(args.attrs)}::jsonb, ${args.createdById})`;
  return rows[0];
}

export interface BackfillRow {
  kind: string;
  /** OPENED | ALREADY_OPENED | SKIPPED | SKIPPED_HAS_PERIODS | NOTE */
  outcome: string;
  reason: string | null;
  employees: number;
  /** Listed for SKIPPED / SKIPPED_HAS_PERIODS / NOTE only. */
  employeeIds: string[] | null;
}

/**
 * Runs the legacy-opening backfill for the employees of `companyIds` (legal, else actual company),
 * or for every employee when `companyIds` is null (the named cross-company data migration).
 */
export async function callBackfillLegacyOpenings(tx: TxClient, companyIds: readonly string[] | null, actor: string | null): Promise<BackfillRow[]> {
  const companies = companyIds === null ? null : [...companyIds];
  return tx.$queryRaw<BackfillRow[]>`
    SELECT "kind", "outcome", "reason", "employees", "employeeIds"
      FROM "effective_backfill_legacy_openings"(${companies}::text[], ${actor})`;
}

/** The SQL twin of allowanceLine() (src/lib/payroll-core.ts), for the parity test. */
export async function callAllowanceLine(tx: TxClient, type: string | null, name: string | null): Promise<string> {
  const rows = await tx.$queryRaw<{ line: string }[]>`SELECT "effective_allowance_line"(${type}, ${name}) AS "line"`;
  return rows[0].line;
}
