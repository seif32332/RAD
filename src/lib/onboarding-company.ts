// Company of a new hire and of recruitment / onboarding requests (P0-05 = BL-ONB-012, ARC-ONB-A4).
//
// The actual company follows the branch (INV-ORG-01: department -> branch -> actual company). The
// legal company is HR's choice and defaults to the actual company. When the database has exactly one
// company, that company is the only possible answer. Nothing else is ever guessed: without a
// derivation HR must choose, and approval is refused until it does (audit EV-0026, EV-0027).
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface HireCompanyInput {
  /** Company of the chosen branch (or of the department's branch / the administration); null without one. */
  orgCompanyId: string | null;
  /** HR's choice in the review form (null / undefined = not chosen). */
  legalCompanyId?: string | null;
  actualCompanyId?: string | null;
  /** The only company of the database, null when there are none or several. */
  onlyCompanyId: string | null;
}

export type HireCompanyResult =
  | { ok: true; legalCompanyId: string; actualCompanyId: string; actualFrom: 'ORG' | 'CHOSEN' | 'ONLY_COMPANY' }
  | { ok: false; message: string };

export const HIRE_COMPANY_MESSAGES = {
  missing: 'حدد الشركة النظامية والشركة الفعلية للموظف، أو اختر فرعاً تُشتق منه الشركة الفعلية',
  branchMismatch: 'الشركة الفعلية يجب أن تكون شركة الفرع المختار',
} as const;

/** Pure: the legal and actual company of a new hire, or why they cannot be determined. */
export function resolveHireCompanies(input: HireCompanyInput): HireCompanyResult {
  const chosenActual = input.actualCompanyId || null;
  const chosenLegal = input.legalCompanyId || null;
  if (input.orgCompanyId && chosenActual && chosenActual !== input.orgCompanyId) {
    return { ok: false, message: HIRE_COMPANY_MESSAGES.branchMismatch };
  }
  const actualCompanyId = input.orgCompanyId ?? chosenActual ?? input.onlyCompanyId;
  const actualFrom = input.orgCompanyId ? 'ORG' : chosenActual ? 'CHOSEN' : 'ONLY_COMPANY';
  const legalCompanyId = chosenLegal ?? actualCompanyId;
  if (!actualCompanyId || !legalCompanyId) return { ok: false, message: HIRE_COMPANY_MESSAGES.missing };
  return { ok: true, legalCompanyId, actualCompanyId, actualFrom };
}

/** The only company of the database, or null when there are none or several. */
export async function onlyCompanyId(db: Db): Promise<string | null> {
  const rows = await db.company.findMany({ select: { id: true }, take: 2 });
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Company derived from the org units (branch, else the department's branch, else the administration),
 * else the only company. null when it cannot be derived. Used for the scope key of new
 * JobRequest / OnboardingRequest rows (same order as migration 9r_onboarding_company).
 */
export async function deriveRequestCompanyId(
  db: Db,
  ids: { branchId?: string | null; departmentId?: string | null; administrationId?: string | null },
): Promise<string | null> {
  const [branch, department, administration] = await Promise.all([
    ids.branchId ? db.branch.findUnique({ where: { id: ids.branchId }, select: { companyId: true } }) : null,
    ids.departmentId ? db.department.findUnique({ where: { id: ids.departmentId }, select: { branch: { select: { companyId: true } } } }) : null,
    ids.administrationId ? db.administration.findUnique({ where: { id: ids.administrationId }, select: { companyId: true } }) : null,
  ]);
  return branch?.companyId ?? department?.branch.companyId ?? administration?.companyId ?? (await onlyCompanyId(db));
}
