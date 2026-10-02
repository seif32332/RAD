// Reviewed raw SQL of the people module (ARCH-009): the employee row lock of ADR-0002 #2.
import type { TxClient } from '@/modules/platform';

export interface LockedEmployeeRow {
  id: string;
  legalCompanyId: string | null;
}

/**
 * Locks the Employee rows of `employeeIds` that are inside `companyIds` (by legal company; 'ALL' =
 * every row), in ascending id order (one order everywhere: no two transactions wait on each other in
 * opposite directions), and returns them. A row outside the companies is neither locked nor returned.
 */
export async function lockEmployeeRows(tx: TxClient, employeeIds: readonly string[], companyIds: readonly string[] | 'ALL'): Promise<LockedEmployeeRow[]> {
  const ids = [...employeeIds];
  if (companyIds === 'ALL') {
    return tx.$queryRaw<LockedEmployeeRow[]>`
      SELECT "id", "legalCompanyId" FROM "Employee" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
  }
  const companies = [...companyIds];
  return tx.$queryRaw<LockedEmployeeRow[]>`
    SELECT "id", "legalCompanyId" FROM "Employee"
     WHERE "id" = ANY(${ids}::text[]) AND "legalCompanyId" = ANY(${companies}::text[])
     ORDER BY "id" FOR UPDATE`;
}
