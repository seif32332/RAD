// Shared helpers for the logistics APIs (vehicles, claims, telecom, utilities, assets).
// Private module (underscore prefix): not a route.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict } from '@/lib/http';
import { zOptText, zText } from '@/lib/validation';

type Ref = string | null | undefined;

const present = (ids: Ref[] | undefined): string[] =>
  Array.from(new Set((ids ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0)));

/** 409 message when an asset, a SIM or a vehicle is handed to an employee whose service has ended. */
export const TERMINATED_HOLDER_MESSAGE =
  'لا يمكن الإسناد إلى موظف منتهية خدمته. اختر موظفاً على رأس العمل، أو احفظ الأصل شاغراً في المستودع.';

/** Pure: whether any of the referenced employees has left the company. */
export function hasTerminatedEmployee(employees: ReadonlyArray<{ isTerminated: boolean | null }>): boolean {
  return employees.some((e) => e.isTerminated === true);
}

/**
 * Verifies that every referenced id exists, so a bad id returns a clear 400 instead of a
 * foreign-key failure. null/undefined/'' ids are ignored (they mean "unset").
 *
 * With `activeOnly`, a referenced employee whose service has ended (isTerminated) is refused with
 * 409. Used whenever an asset, a SIM or a vehicle is handed to an employee.
 */
export async function ensureRefsExist(
  db: Prisma.TransactionClient,
  refs: { employeeIds?: Ref[]; companyIds?: Ref[]; branchIds?: Ref[]; vehicleIds?: Ref[] },
  opts: { activeOnly?: boolean } = {},
): Promise<void> {
  const employeeIds = present(refs.employeeIds);
  const companyIds = present(refs.companyIds);
  const branchIds = present(refs.branchIds);
  const vehicleIds = present(refs.vehicleIds);

  const [employees, companies, branches, vehicles] = await Promise.all([
    employeeIds.length
      ? db.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, isTerminated: true } })
      : [],
    companyIds.length ? db.company.count({ where: { id: { in: companyIds } } }) : 0,
    branchIds.length ? db.branch.count({ where: { id: { in: branchIds } } }) : 0,
    vehicleIds.length ? db.vehicle.count({ where: { id: { in: vehicleIds } } }) : 0,
  ]);

  if (employees.length !== employeeIds.length) throw badRequest('الموظف المحدد غير موجود');
  if (companies !== companyIds.length) throw badRequest('الشركة المحددة غير موجودة');
  if (branches !== branchIds.length) throw badRequest('الفرع المحدد غير موجود');
  if (vehicles !== vehicleIds.length) throw badRequest('المركبة المحددة غير موجودة');
  if (opts.activeOnly && hasTerminatedEmployee(employees)) throw conflict(TERMINATED_HOLDER_MESSAGE);
}

/** Query flag `?heldByTerminated=1`: only items still held by employees whose service has ended. */
export function wantsHeldByTerminated(url: string): boolean {
  const v = new URL(url).searchParams.get('heldByTerminated');
  return v === '1' || v === 'true';
}

/** Optional foreign key: '' / null -> null (unset), missing -> undefined (unchanged). */
export const zOptRef = zOptText(100);

/** Optional attachment URL / list of URLs (comma separated). */
export const zOptUrl = zOptText(4000);

// ---------------------------------------------------------------------------
// Telecom SIMs
// ---------------------------------------------------------------------------

export const telecomCreateSchema = z.object({
  simNumber: zText(50),
  accountNumber: zOptText(100),
  provider: zOptText(100),
  plan: zOptText(200),
  serviceType: zOptText(100),
  companyId: zOptRef,
  branchId: zOptRef,
  employeeId: zOptRef,
});

export const telecomUpdateSchema = telecomCreateSchema.partial().extend({
  simNumber: zText(50).optional(),
});

/** Safe employee projection for logistics listings (no salary / identity data). */
export const employeeBriefSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  isTerminated: true,
} as const;

// ---------------------------------------------------------------------------
// Utility meters
// ---------------------------------------------------------------------------

export const utilityCreateSchema = z.object({
  meterCode: zOptText(200),
  meterNumber: zText(100),
  accountNumber: zOptText(100),
  meterPhotoUrl: zOptUrl,
  branchId: zOptRef,
  legalCompanyId: zOptRef,
  actualCompanyId: zOptRef,
});

export const utilityUpdateSchema = utilityCreateSchema.partial().extend({
  meterNumber: zText(100).optional(),
});
