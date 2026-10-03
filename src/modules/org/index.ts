// Public API of the org module (DOMAIN_BOUNDARIES §5.1). Owns AssignmentPeriod (§5.2) and the
// Employee assignment projection (legal/actual company, branch, department, direct manager, work pattern).
// P1-FND-EFF: the minimal applyAssignment only (ARC-SYS-A3); P3-ORG completes the module.
import type { PrismaClient } from '@prisma/client';
import { activeAt, type DateOnly, type PeriodReader, type PeriodView, type ReadOptions } from '@/modules/platform';

export {
  applyAssignment,
  AssignmentPlacementError,
  AssignmentScopeError,
  AssignmentScheduleError,
} from './transitions';
export type { ApplyAssignmentInput, ApplyAssignmentOp, ApplyAssignmentResult } from './transitions';

/** Every company of the tenant (ids, stable order): the per-company runs of the background jobs (P1-FND-JOBS). */
export async function listCompanyIds(db: Pick<PrismaClient, 'company'>): Promise<string[]> {
  const rows = await db.company.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}

/** BL-PAY-021: the display names of these companies (the owner digest and the controls banner name them). */
export async function companyNames(db: Pick<PrismaClient, 'company'>, companyIds: readonly string[]): Promise<Map<string, string>> {
  if (!companyIds.length) return new Map();
  const rows = await db.company.findMany({ where: { id: { in: [...companyIds] } }, select: { id: true, nameArabic: true } });
  return new Map(rows.map((r) => [r.id, r.nameArabic]));
}

/** The assignment period in force on `date` (or as recorded at `opts.asRecordedAt`). */
export function assignmentAt(db: PeriodReader, employeeId: string, date: DateOnly, opts?: ReadOptions): Promise<PeriodView<'ASSIGNMENT'> | null> {
  return activeAt(db, 'ASSIGNMENT', employeeId, date, opts);
}
