// Test fixtures for the workforce engine tests (wf-*.test.ts): the RuleParameter and GosiRate rows as seeded
// by prisma/migrations/5_… and 9_workforce_engine, plus small builders. Not a test file itself.
import type { AssumptionRow, GosiRateRow, RuleRow, WfCompanyInput, WfEmployeeInput } from '@/lib/workforce';

export const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const LAW = 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1';
const QIWA = 'https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis';
const HRDF = 'https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf';

const r = (key: string, value: number, from: string, status = 'VERIFIED_PRIMARY', unit = 'SAR', sourceUrl: string | null = null): RuleRow => ({
  key,
  label: key,
  value,
  unit,
  effectiveFrom: d(from),
  effectiveTo: null,
  status,
  sourceUrl,
  sourceQuote: null,
});

/** Same values and dates as the migration 9 seed. */
export const SEED_RULES: RuleRow[] = [
  r('GOSI_MAX_CONTRIBUTORY_WAGE', 45000, '2000-01-01', 'VERIFIED_PRIMARY', 'SAR_MONTH', 'https://laws.boe.gov.sa/si-law'),
  r('GOSI_MIN_CONTRIBUTORY_WAGE_OLD', 1500, '2000-01-01'),
  r('GOSI_MIN_CONTRIBUTORY_WAGE_NEW', 1500, '2024-07-03', 'PROVISIONAL'),
  r('GOSI_IN_KIND_HOUSING_MONTHS', 2, '2000-01-01'),
  r('OVERTIME_PREMIUM_PCT_OF_BASIC', 50, '2025-02-19', 'VERIFIED_PRIMARY', 'PERCENT', LAW),
  r('OVERTIME_ANNUAL_CAP_HOURS', 720, '2025-02-19'),
  r('NOTICE_DAYS_EMPLOYER', 60, '2025-02-19', 'VERIFIED_PRIMARY', 'DAYS', LAW),
  r('NOTICE_DAYS_EMPLOYEE', 30, '2025-02-19', 'VERIFIED_PRIMARY', 'DAYS', LAW),
  r('ART77_DAYS_PER_YEAR', 15, '2015-01-01', 'VERIFIED_PRIMARY', 'DAYS', LAW),
  r('ART77_MIN_MONTHS', 2, '2015-01-01', 'VERIFIED_PRIMARY', 'MONTHS', LAW),
  r('ANNUAL_LEAVE_DAYS', 21, '2005-01-01'),
  r('ANNUAL_LEAVE_DAYS_AFTER_5Y', 30, '2005-01-01'),
  r('PROBATION_MAX_DAYS', 180, '2025-02-19'),
  r('MATERNITY_WEEKS', 12, '2025-02-19'),
  r('EXPAT_LEVY_WITHIN_SAUDI_COUNT', 700, '2020-01-01', 'VERIFIED_PRIMARY', 'SAR_MONTH', QIWA),
  r('EXPAT_LEVY_ABOVE_SAUDI_COUNT', 800, '2020-01-01', 'VERIFIED_PRIMARY', 'SAR_MONTH', QIWA),
  r('INDUSTRIAL_LEVY_CANCELLED', 1, '2025-12-17', 'VERIFIED_PRIMARY', 'FLAG', 'https://www.spa.gov.sa/en/N2468180'),
  r('SMALL_EST_MAX_WORKERS', 9, '2024-02-01'),
  r('SMALL_EST_EXEMPT_OWNER_ONLY', 2, '2024-02-01'),
  r('SMALL_EST_EXEMPT_WITH_SAUDI', 4, '2024-02-01'),
  r('WORK_PERMIT_FEE_YEAR', 100, '2020-01-01', 'VERIFIED_PRIMARY', 'SAR_YEAR', QIWA),
  r('IQAMA_FEE_YEAR', 650, '2020-01-01', 'PROVISIONAL', 'SAR_YEAR'),
  r('DEPENDENT_FEE_MONTH', 400, '2020-07-01', 'VERIFIED_PRIMARY', 'SAR_MONTH'),
  r('EXIT_REENTRY_SINGLE_BASE', 200, '2019-10-16', 'CORROBORATED_SECONDARY'),
  r('EXIT_REENTRY_SINGLE_EXTRA_MONTH', 100, '2019-10-16', 'CORROBORATED_SECONDARY'),
  r('EXIT_REENTRY_MULTI_BASE', 500, '2019-10-16', 'CORROBORATED_SECONDARY'),
  r('EXIT_REENTRY_MULTI_EXTRA_MONTH', 200, '2019-10-16', 'CORROBORATED_SECONDARY'),
  r('HRDF_BASE_PCT', 30, '2026-08-01', 'VERIFIED_PRIMARY', 'PERCENT', HRDF),
  r('HRDF_BONUS_PCT_EACH', 10, '2026-08-01', 'VERIFIED_PRIMARY', 'PERCENT', HRDF),
  r('HRDF_CAP_SAR', 3000, '2026-08-01', 'VERIFIED_PRIMARY', 'SAR_MONTH', HRDF),
  r('HRDF_CAP_PCT_OF_WAGE', 50, '2026-08-01', 'VERIFIED_PRIMARY', 'PERCENT', HRDF),
  r('HRDF_MIN_WAGE', 4000, '2026-08-01', 'VERIFIED_PRIMARY', 'SAR_MONTH', HRDF),
  r('HRDF_MAX_WAGE', 15000, '2026-08-01', 'VERIFIED_PRIMARY', 'SAR_MONTH', HRDF),
  r('HRDF_MONTHS', 24, '2026-08-01', 'VERIFIED_PRIMARY', 'MONTHS', HRDF),
];

const g = (regime: 'OLD' | 'NEW', isSaudi: boolean, from: string, ee: number, er: number): GosiRateRow => ({
  regime,
  isSaudi,
  effectiveFrom: d(from),
  employeeRate: ee,
  employerRate: er,
  minWage: 1500,
  maxWage: 45000,
  isProvisional: false,
  source: 'test seed',
});

/** GosiRate rows as seeded by migration 5 (NEW rows verified by migration 9). */
export const SEED_GOSI: GosiRateRow[] = [
  g('OLD', true, '2000-01-01', 9.75, 11.75),
  g('OLD', false, '2000-01-01', 0, 2),
  g('NEW', true, '2024-07-03', 9.75, 11.75),
  g('NEW', true, '2025-07-01', 10.25, 12.25),
  g('NEW', true, '2026-07-01', 10.75, 12.75),
  g('NEW', true, '2027-07-01', 11.25, 13.25),
  g('NEW', true, '2028-07-01', 11.75, 13.75),
  g('NEW', false, '2024-07-03', 0, 2),
];

export const COMPANY: WfCompanyInput = { id: 'c1', name: 'شركة الاختبار', isIndustrialLicensed: false };
export const INDUSTRIAL: WfCompanyInput = { id: 'c-ind', name: 'مصنع', isIndustrialLicensed: true };

let seq = 0;
export function emp(over: Partial<WfEmployeeInput> = {}): WfEmployeeInput {
  seq++;
  return {
    id: over.id ?? `e${String(seq).padStart(4, '0')}`,
    name: 'موظف',
    nationality: 'سعودي',
    gender: 'MALE',
    dateOfBirth: d('1990-01-01'),
    joinDate: d('2020-01-01'),
    basicSalary: 8000,
    allowances: [],
    gosiRegime: 'OLD',
    legalCompanyId: 'c1',
    branchId: 'b1',
    branchName: 'الفرع',
    branchCity: 'الرياض',
    departmentId: 'd1',
    departmentName: 'الإدارة',
    contractType: 'FULL_TIME',
    ...over,
  };
}

export const housing = (amount: number) => ({ name: 'بدل سكن', amount, isMonthly: true, countsTowardGosi: true, allowanceType: 'HOUSING' });
export const transport = (amount: number) => ({ name: 'بدل نقل', amount, isMonthly: true, countsTowardGosi: false, allowanceType: 'TRANSPORT' });

export function assume(key: string, value: number | null, valueJson: string | null = null, companyId = ''): AssumptionRow {
  return { key, companyId, value, valueJson };
}
