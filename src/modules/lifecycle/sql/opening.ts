// Reviewed raw SQL of lifecycle (ARCH-009): calls of the LCY-J1 functions of migration 9y (the opening
// recreated by 9zd: its review codes become EmploymentMigrationReview rows)
// (lifecycle_open_state = THE opening of one employee's state; lifecycle_backfill_state_openings = the
// same over companies). TypeScript never re-implements them (single definition).
import type { TxClient } from '@/modules/platform';

export interface OpenStateRow {
  changeId: string | null;
  /** OPENED | ALREADY_OPENED */
  outcome: string;
  /** The review codes raised (also written as EmploymentMigrationReview rows by the function). */
  review: string[] | null;
}

/** The opening of one employee (idempotent). The caller has locked the employee inside its scope (people.lockEmployees). */
export async function callOpenState(tx: TxClient, employeeId: string, actor: string | null): Promise<OpenStateRow> {
  const rows = await tx.$queryRaw<OpenStateRow[]>`SELECT "changeId", "outcome", "review" FROM "lifecycle_open_state"(${employeeId}, ${actor})`;
  return rows[0];
}

export interface BackfillStateRow {
  outcome: string;
  review: string | null;
  employees: number;
  employeeIds: string[] | null;
}

/** LCY-J1 over the employees of `companyIds` (legal, else actual company); null = every employee (named data migration). */
export async function callBackfillStateOpenings(tx: TxClient, companyIds: readonly string[] | null, actor: string | null): Promise<BackfillStateRow[]> {
  const companies = companyIds === null ? null : [...companyIds];
  return tx.$queryRaw<BackfillStateRow[]>`
    SELECT "outcome", "review", "employees", "employeeIds" FROM "lifecycle_backfill_state_openings"(${companies}::text[], ${actor})`;
}
