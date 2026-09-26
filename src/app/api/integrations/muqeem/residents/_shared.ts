// Server helpers shared by the resident sync routes (not a route: no route.ts here).
import 'server-only';
import { prisma } from '@/lib/prisma';
import { createMuqeemClient, findResidentRows, activeResidentsTotal, normalizeActiveResidents, type NormalizedResident } from '@/lib/muqeem';
import { collectReportPages, MAX_SYNC_RESIDENTS, SYNC_PAGE_SIZE, type CollectedReport, type SyncEmployee } from '@/lib/muqeem-sync';
import { notFound } from '@/lib/http';

/** The company, or 404. */
export async function loadCompany(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, nameArabic: true, moiNumber: true, muqeemPlatformId: true },
  });
  if (!company) throw notFound('الشركة غير موجودة');
  return company;
}

/**
 * Reads the whole active residents report of the company (pages of 500, capped at 5000 residents).
 * Read-only on Muqeem. Dependents are requested so each row carries a dependents count (only the count
 * is compared / stored, never the dependents' details). Throws MuqeemError (NOT_CONFIGURED / NOT_LINKED / AUTH / REJECTED / UNAVAILABLE).
 */
export async function fetchAllResidents(companyId: string): Promise<CollectedReport<NormalizedResident>> {
  const client = await createMuqeemClient({ companyId });
  return collectReportPages<NormalizedResident>(
    async (page, size) => {
      const raw = await client.getActiveResidentsReport({ page, size, withDependents: true });
      return { rows: normalizeActiveResidents(raw), rawCount: findResidentRows(raw).length, total: activeResidentsTotal(raw) };
    },
    { pageSize: SYNC_PAGE_SIZE, cap: MAX_SYNC_RESIDENTS, keyOf: (r) => r.iqamaNumber },
  );
}

const EMPLOYEE_SELECT = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  firstNameEnglish: true,
  lastNameEnglish: true,
  nationality: true,
  iqamaOrIdNumber: true,
  iqamaOrIdExp: true,
  passportNumber: true,
  passportExp: true,
  occupationName: true,
  dependentsCount: true,
  isTerminated: true,
  legalCompanyId: true,
} as const;

type EmployeeRow = {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic: string;
  firstNameEnglish: string | null;
  lastNameEnglish: string | null;
  nationality: string;
  iqamaOrIdNumber: string;
  iqamaOrIdExp: Date;
  passportNumber: string | null;
  passportExp: Date | null;
  occupationName: string | null;
  dependentsCount: number | null;
  isTerminated: boolean;
  legalCompanyId: string | null;
};

export function toSyncEmployee(e: EmployeeRow): SyncEmployee {
  const join = (...parts: (string | null)[]) => parts.map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  return {
    id: e.id,
    employeeCode: e.employeeId,
    nameArabic: join(e.firstNameArabic, e.lastNameArabic),
    nameEnglish: join(e.firstNameEnglish, e.lastNameEnglish) || null,
    nationality: e.nationality,
    iqamaOrIdNumber: e.iqamaOrIdNumber,
    iqamaOrIdExp: e.iqamaOrIdExp,
    passportNumber: e.passportNumber,
    passportExp: e.passportExp,
    occupationName: e.occupationName,
    dependentsCount: e.dependentsCount,
    isTerminated: e.isTerminated,
    legalCompanyId: e.legalCompanyId,
  };
}

/**
 * Employees of the legal company (terminated included) plus employees of other companies whose
 * iqama number appears in the report (to explain residents not found under this company).
 */
export async function loadEmployeesForDiff(companyId: string, iqamaNumbers: string[]): Promise<SyncEmployee[]> {
  const rows = await prisma.employee.findMany({
    where: {
      OR: [{ legalCompanyId: companyId }, ...(iqamaNumbers.length ? [{ iqamaOrIdNumber: { in: iqamaNumbers } }] : [])],
    },
    select: EMPLOYEE_SELECT,
  });
  return rows.map(toSyncEmployee);
}

export { EMPLOYEE_SELECT };
