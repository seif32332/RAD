// Public API of the people module (DOMAIN_BOUNDARIES §5.1). people owns Employee (the identity);
// the projection columns on it belong to their projectors (§5.2 "Employee حالة خاصة", ARCH-003).
// This first slice (P1-LCY) holds what the modules above need to act on employees without reading
// the table themselves (ARCH-001): the employee lock of ADR-0002 #2 and a few reads.
import type { Prisma, PrismaClient } from '@prisma/client';
import { forbidden, notFound } from '@/lib/http';
import { assertTransactionClient, type TxClient } from '@/modules/platform';
import { lockEmployeeRows, type LockedEmployeeRow } from './sql/lock';

type Db = PrismaClient | Prisma.TransactionClient;

export type { LockedEmployeeRow };

/**
 * ADR-0002 #2 / ARCH-019: the FIRST lock of any transaction that writes employees. Locks the rows in
 * ascending id order and returns them in that order. `companyIds` is the caller's company scope
 * (legal company; 'ALL' only for an owner or an explicit cross-company / system context): an
 * employee outside it is refused (403), an unknown one is 404. No default scope on purpose.
 */
export async function lockEmployees(tx: TxClient, employeeIds: readonly string[], companyIds: readonly string[] | 'ALL'): Promise<LockedEmployeeRow[]> {
  assertTransactionClient(tx, 'lockEmployees');
  if (companyIds !== 'ALL' && !Array.isArray(companyIds)) throw new Error('lockEmployees: companyIds must be a list or ALL');
  const ids = [...new Set(employeeIds.filter((id) => typeof id === 'string' && id.trim()))].sort();
  if (!ids.length) return [];
  const rows = await lockEmployeeRows(tx, ids, companyIds);
  if (rows.length === ids.length) return rows;
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  const exist = await tx.employee.count({ where: { id: { in: missing } } });
  if (exist < missing.length) throw notFound('الموظف غير موجود');
  throw forbidden('هذا الموظف خارج نطاق شركاتك');
}

/** The employee columns lifecycle reads to decide a transition (its own projections + identity dates). */
export const EMPLOYEE_LIFECYCLE_SELECT = {
  id: true,
  userId: true,
  joinDate: true,
  legalCompanyId: true,
  actualCompanyId: true,
  isTerminated: true,
  terminationDate: true,
  employmentStatus: true,
  employmentState: true,
  exitReason: true,
  exitVoluntary: true,
} as const satisfies Prisma.EmployeeSelect;

export type EmployeeLifecycleRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_LIFECYCLE_SELECT }>;

export async function employeeForLifecycle(db: Db, employeeId: string): Promise<EmployeeLifecycleRow | null> {
  return db.employee.findUnique({ where: { id: employeeId }, select: EMPLOYEE_LIFECYCLE_SELECT });
}

/** Employees linked to login accounts (User.id -> Employee), with their state projections. */
export async function employeesOfUsers(db: Db, userIds: readonly string[]): Promise<{ id: string; userId: string | null; isTerminated: boolean; employmentState: EmployeeLifecycleRow['employmentState'] }[]> {
  if (!userIds.length) return [];
  return db.employee.findMany({
    where: { userId: { in: [...userIds] } },
    select: { id: true, userId: true, isTerminated: true, employmentState: true },
  });
}

/**
 * Ids of the employees of `companyIds` (legal company) matching `where`, ascending. For the modules
 * above that select employees by their own projection columns (e.g. lifecycle: the notices due).
 */
export async function listEmployeeIds(db: Db, where: Prisma.EmployeeWhereInput, companyIds: readonly string[] | 'ALL'): Promise<string[]> {
  const scope: Prisma.EmployeeWhereInput = companyIds === 'ALL' ? {} : { legalCompanyId: { in: [...companyIds] } };
  const rows = await db.employee.findMany({ where: { AND: [where, scope] }, select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}
