// Loader of the total rewards statement («بيان المكافآت الشاملة», SPEC §9), server-only. Shared by the HR
// view (GET /api/workforce/total-rewards) and the employee portal (GET /api/portal/total-rewards). Reads
// ONE employee's own rows only (profile, allowances, payrolls of the year) plus the settings of their
// company, the GOSI rates and the rule register; never another employee's data.
import 'server-only';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { today } from '@/lib/dates';
import { loadAnnualLeaveDaysSetting, loadCompanies, loadGosiRateRows, loadRuleRows } from '@/lib/workforce/load';
import { resolveAssumption } from '@/lib/workforce/assumptions';
import {
  PAID_PAYROLL_STATUSES,
  TOTAL_REWARDS_ASSUMPTION_KEY,
  computeTotalRewards,
  totalRewardsYearRange,
  type TotalRewardsStatement,
} from '@/lib/workforce/total-rewards';

/** ?year= of both statement endpoints (optional; default = current or exit year). */
export const zStatementYear = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : Number(v)),
  z.number({ invalid_type_error: 'السنة غير صالحة' }).int('السنة غير صالحة').min(2000, 'السنة غير صالحة').max(2100, 'السنة غير صالحة').optional(),
);

/** Owner decision: is the statement visible to employees in the portal (global WorkforceAssumption row)? */
export async function totalRewardsEnabled(): Promise<boolean> {
  const row = await prisma.workforceAssumption.findUnique({
    where: { key_companyId: { key: TOTAL_REWARDS_ASSUMPTION_KEY, companyId: '' } },
    select: { key: true, companyId: true, value: true, valueJson: true },
  });
  return resolveAssumption(row ? [row] : [], TOTAL_REWARDS_ASSUMPTION_KEY, null).value === true;
}

export interface LoadedTotalRewards {
  statement: TotalRewardsStatement;
  /** Years the statement can be requested for (join year .. current / exit year). */
  years: { first: number; last: number };
  /** Years with at least one approved / paid payroll (newest first). */
  payrollYears: number[];
}

/**
 * Statement of `employeeId` for `year` (default: the current year, or the exit year). null when the
 * employee does not exist. Throws nothing for a year outside the range: the caller validates `years`.
 */
export async function loadTotalRewards(employeeId: string, year?: number | null): Promise<LoadedTotalRewards | null> {
  const asOf = today();
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employeeId: true,
      firstNameArabic: true,
      lastNameArabic: true,
      jobTitle: true,
      nationality: true,
      joinDate: true,
      isTerminated: true,
      terminationDate: true,
      basicSalary: true,
      gosiRegime: true,
      medicalInsuranceClass: true,
      dependentsCount: true,
      legalCompanyId: true,
      actualCompanyId: true,
      allowances: { select: { name: true, amount: true, isMonthly: true, countsTowardGosi: true, allowanceType: true, payrollMonth: true, payrollYear: true, isPaid: true } },
    },
  });
  if (!emp) return null;
  const termination = emp.isTerminated ? emp.terminationDate : null;
  const years = totalRewardsYearRange({ joinDate: emp.joinDate, terminationDate: termination }, asOf);
  const y = year ?? years.last;
  const settingsCompanyId = emp.legalCompanyId || emp.actualCompanyId || null;
  const [payrolls, yearsRows, companies, rules, gosiRates, annualLeaveDaysSetting] = await Promise.all([
    prisma.payroll.findMany({
      where: { employeeId, year: y, status: { in: [...PAID_PAYROLL_STATUSES] } },
      select: { year: true, month: true, status: true, basicSalary: true, totalAllowances: true, overtimeCost: true, bonusAmount: true, gosiEmployer: true },
      orderBy: { month: 'asc' },
    }),
    prisma.payroll.groupBy({ by: ['year'], where: { employeeId, status: { in: [...PAID_PAYROLL_STATUSES] } }, orderBy: { year: 'desc' } }),
    settingsCompanyId ? loadCompanies(undefined, [settingsCompanyId]) : Promise.resolve([]),
    loadRuleRows(),
    loadGosiRateRows(),
    loadAnnualLeaveDaysSetting(),
  ]);
  const company = companies[0] ?? null;
  const statement = computeTotalRewards({
    year: y,
    asOf,
    employee: {
      id: emp.id,
      name: `${emp.firstNameArabic ?? ''} ${emp.lastNameArabic ?? ''}`.trim(),
      employeeNo: emp.employeeId,
      jobTitle: emp.jobTitle,
      nationality: emp.nationality,
      joinDate: emp.joinDate,
      terminationDate: termination,
      basicSalary: emp.basicSalary,
      allowances: emp.allowances,
      gosiRegime: emp.gosiRegime,
      medicalInsuranceClass: emp.medicalInsuranceClass,
      dependentsCount: emp.dependentsCount,
    },
    payrolls: payrolls.map((r) => ({ ...r, status: String(r.status) })),
    company: company ? { id: company.id, name: company.name, costSettings: company.costSettings ?? null } : null,
    rules,
    gosiRates,
    annualLeaveDaysSetting,
  });
  return { statement, years, payrollYears: yearsRows.map((r) => r.year) };
}
