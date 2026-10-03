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
 * BL-PAY-021 (DEC-PO-144): the ONE legal company of these employees, for the controls mode of an act about them.
 * null when there is no employee, an employee without a company, or several companies (the mode then reads ENFORCED).
 */
export async function legalCompanyOfEmployees(db: Db, employeeIds: readonly (string | null | undefined)[]): Promise<string | null> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (!ids.length) return null;
  const rows = await db.employee.findMany({ where: { id: { in: ids } }, select: { legalCompanyId: true } });
  if (rows.length !== ids.length) return null;
  const companies = new Set(rows.map((r) => r.legalCompanyId));
  if (companies.size !== 1) return null;
  const [only] = [...companies];
  return only ?? null;
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

/**
 * The employee columns compensation reads (P1-PAY-B): the identity dates and company it needs to file and
 * apply a financial change, and its own projection columns (basicSalary, the bank columns, payrollReady),
 * which only compensation's projector writes (ARC-PAY-A4).
 */
export const EMPLOYEE_COMPENSATION_SELECT = {
  id: true,
  legalCompanyId: true,
  joinDate: true,
  isTerminated: true,
  basicSalary: true,
  payrollReady: true,
  ibanNumber: true,
  bankName: true,
  salaryPaymentMethod: true,
} as const satisfies Prisma.EmployeeSelect;

export type EmployeeCompensationRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_COMPENSATION_SELECT }>;

export async function employeeForCompensation(db: Db, employeeId: string): Promise<EmployeeCompensationRow | null> {
  return db.employee.findUnique({ where: { id: employeeId }, select: EMPLOYEE_COMPENSATION_SELECT });
}

/** Every employee in service (not terminated), with the compensation columns (INV-SAL-01 compares them with the facts). */
export async function employeesInServiceForCompensation(db: Db): Promise<EmployeeCompensationRow[]> {
  return db.employee.findMany({ where: { isTerminated: false }, select: EMPLOYEE_COMPENSATION_SELECT, orderBy: { id: 'asc' } });
}
