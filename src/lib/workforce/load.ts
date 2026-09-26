// Workforce engine: the ONE database loader (server-only). Reads Prisma and builds the PURE inputs of
// src/lib/workforce (computeTrueCost / computeExitCost / computeOverview). No formula lives here.
import 'server-only';
import type { LeaveStatus, LeaveType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { BALANCE_CONSUMING_STATUSES, BALANCE_LEAVE_TYPES } from '@/lib/leave';
import { LOAN_DEDUCTIBLE_STATUSES, PAYROLL_STATUS } from '@/lib/constants';
import { DEFAULT_GOSI_RATES } from '@/lib/gosi';
import { loadPayrollSettings } from '@/lib/payroll';
import { monthOf } from '@/lib/settlement';
import { parseMonth, addMonthsYm, monthStartUtc, monthEndUtc } from '@/lib/workforce/formulas';
import { companyCostSettings } from '@/lib/workforce/company-settings';
import { RULE_KEYS, normalizeStatus } from '@/lib/workforce/rules';
import type { WorkforceCalculationRecord } from '@/lib/workforce/snapshot';
import type { NitaqatActivityRow, NitaqatCurveRow } from '@/lib/workforce/nitaqat';
import type { LocalizationDecisionRow } from '@/lib/workforce/saudization';
import type {
  AssumptionRow,
  ExitCostInput,
  GosiRateRow,
  RuleRow,
  Scenario,
  TrueCostInput,
  WfCompanyInput,
  WfEmployeeInput,
} from '@/lib/workforce/types';

type Db = Prisma.TransactionClient;

export const ANNUAL_LEAVE_DAYS_SETTING_KEY = 'annual_leave_days';

export interface WorkforceScope {
  /** Legal company. */
  companyId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  employeeIds?: ReadonlyArray<string> | null;
}

const EMPLOYEE_SELECT = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  nationality: true,
  gender: true,
  dateOfBirth: true,
  joinDate: true,
  isTerminated: true,
  terminationDate: true,
  contractEndDate: true,
  contractType: true,
  partTimeWeeklyHours: true,
  basicSalary: true,
  gosiRegime: true,
  legalCompanyId: true,
  actualCompanyId: true,
  branchId: true,
  departmentId: true,
  dependentsCount: true,
  dependentsFeePaidBy: true,
  isDisabled: true,
  medicalInsuranceClass: true,
  leaveAccrualStartDate: true,
  iqamaOrIdExp: true,
  // Phase 2 (Nitaqat / localization)
  muawamaCertExpiry: true,
  isStudent: true,
  qiwaContractDocumented: true,
  qiwaContractDocumentedAt: true,
  occupationName: true,
  occupationCode: true,
  branch: { select: { nameArabic: true, city: true } },
  department: { select: { nameArabic: true } },
  allowances: {
    where: { OR: [{ isMonthly: true }, { isMonthly: false, isPaid: false }] },
    select: { name: true, amount: true, isMonthly: true, countsTowardGosi: true, allowanceType: true, payrollMonth: true, payrollYear: true, isPaid: true },
  },
  salaryChanges: { select: { effectiveDate: true, basicSalary: true, isPlanned: true }, orderBy: { effectiveDate: 'asc' } },
} satisfies Prisma.EmployeeSelect;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

function toEmployeeInput(r: EmployeeRow): WfEmployeeInput {
  return {
    id: r.id,
    name: `${r.firstNameArabic ?? ''} ${r.lastNameArabic ?? ''}`.trim(),
    employeeNo: r.employeeId,
    nationality: r.nationality,
    gender: r.gender,
    dateOfBirth: r.dateOfBirth,
    joinDate: r.joinDate,
    terminationDate: r.isTerminated ? r.terminationDate : null,
    contractEndDate: r.contractEndDate,
    contractType: r.contractType,
    partTimeWeeklyHours: r.partTimeWeeklyHours,
    basicSalary: r.basicSalary,
    allowances: r.allowances,
    gosiRegime: r.gosiRegime,
    legalCompanyId: r.legalCompanyId,
    actualCompanyId: r.actualCompanyId,
    branchId: r.branchId,
    branchName: r.branch?.nameArabic ?? null,
    branchCity: r.branch?.city ?? null,
    departmentId: r.departmentId,
    departmentName: r.department?.nameArabic ?? null,
    dependentsCount: r.dependentsCount,
    dependentsFeePaidBy: r.dependentsFeePaidBy,
    isDisabled: r.isDisabled,
    medicalInsuranceClass: r.medicalInsuranceClass,
    leaveAccrualStartDate: r.leaveAccrualStartDate,
    iqamaExpiry: r.iqamaOrIdExp,
    salaryChanges: r.salaryChanges,
    muawamaCertExpiry: r.muawamaCertExpiry,
    isStudent: r.isStudent,
    qiwaContractDocumented: r.qiwaContractDocumented,
    qiwaContractDocumentedAt: r.qiwaContractDocumentedAt,
    occupationName: r.occupationName,
    occupationCode: r.occupationCode,
  };
}

/** Every RuleParameter version (resolution by date happens in the pure layer). */
export async function loadRuleRows(db: Db = prisma): Promise<RuleRow[]> {
  return db.ruleParameter.findMany({
    select: { key: true, label: true, domain: true, value: true, valueJson: true, unit: true, effectiveFrom: true, effectiveTo: true, status: true, sourceUrl: true, sourceQuote: true, notes: true },
    orderBy: [{ key: 'asc' }, { effectiveFrom: 'asc' }],
  });
}

/**
 * The rule register value of the iqama fee in force on `at` (IQAMA_FEE_YEAR): shown next to the company
 * setting «رسوم الإقامة السنوية» (blank = this value). null value when the register has no version.
 */
export async function loadIqamaFeeRule(at: Date, db: Db = prisma): Promise<{ value: number | null; status: string; effectiveFrom: string | null }> {
  const row = await db.ruleParameter.findFirst({
    where: { key: RULE_KEYS.IQAMA_YEAR, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
    select: { value: true, status: true, effectiveFrom: true },
  });
  return { value: row?.value ?? null, status: row ? normalizeStatus(row.status) : 'MISSING', effectiveFrom: row ? row.effectiveFrom.toISOString().slice(0, 10) : null };
}

export async function loadAssumptionRows(db: Db = prisma): Promise<AssumptionRow[]> {
  return db.workforceAssumption.findMany({
    select: { key: true, companyId: true, value: true, valueJson: true, note: true },
    orderBy: [{ key: 'asc' }, { companyId: 'asc' }],
  });
}

/** The dated GosiRate table with its source text (falls back to the documented OLD rows when empty). */
export async function loadGosiRateRows(db: Db = prisma): Promise<GosiRateRow[]> {
  const rows = await db.gosiRate.findMany({
    select: { regime: true, isSaudi: true, effectiveFrom: true, employeeRate: true, employerRate: true, minWage: true, maxWage: true, isProvisional: true, source: true },
    orderBy: [{ regime: 'asc' }, { isSaudi: 'asc' }, { effectiveFrom: 'asc' }],
  });
  return rows.length ? rows : DEFAULT_GOSI_RATES.map((r) => ({ ...r }));
}

export async function loadAnnualLeaveDaysSetting(db: Db = prisma): Promise<number | null> {
  const row = await db.systemSetting.findUnique({ where: { key: ANNUAL_LEAVE_DAYS_SETTING_KEY }, select: { value: true } });
  if (!row) return null;
  const raw = String(row.value).trim().replace(/^"(.*)"$/, '$1');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function loadCompanies(db: Db = prisma, ids?: ReadonlyArray<string>): Promise<WfCompanyInput[]> {
  const rows = await db.company.findMany({
    where: ids ? { id: { in: [...ids] } } : undefined,
    select: { id: true, nameArabic: true, isIndustrialLicensed: true, nitaqatActivity: true, nitaqatActivityKey: true, overtimeHourlyBasis: true, medicalPremiumsJson: true, iqamaFeeYear: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((c) => ({ id: c.id, name: c.nameArabic, isIndustrialLicensed: c.isIndustrialLicensed, nitaqatActivity: c.nitaqatActivity, nitaqatActivityKey: c.nitaqatActivityKey, costSettings: companyCostSettings(c) }));
}

export interface LoadedTrueCostInput {
  input: TrueCostInput;
  /** Pass as TrueCostOptions.employeeIds (null = everyone). */
  reportEmployeeIds: string[] | null;
}

/**
 * Builds TrueCostInput for the horizon [startMonth, startMonth + months). Loads EVERY employee employed
 * during the horizon (the levy tiers need the whole legal company); `scope` only decides which employees
 * are reported (reportEmployeeIds). Terminated employees whose termination date is before the horizon are
 * excluded; future joiners are included from their join date.
 */
export async function loadTrueCostInput(opts: { startMonth: string | Date; months?: number; scope?: WorkforceScope | null }, db: Db = prisma): Promise<LoadedTrueCostInput> {
  const start = parseMonth(opts.startMonth);
  const months = Math.max(1, Math.min(120, Math.floor(opts.months ?? 36)));
  const horizonStart = monthStartUtc(start.year, start.month);
  const endYm = addMonthsYm(start.year, start.month, months - 1);
  const horizonEnd = monthEndUtc(endYm.year, endYm.month);

  const [rows, rules, gosiRates, assumptions, payrollSettings, annualLeaveDaysSetting] = await Promise.all([
    db.employee.findMany({
      where: {
        joinDate: { lte: horizonEnd },
        OR: [{ isTerminated: false }, { isTerminated: true, terminationDate: { gte: horizonStart } }],
      },
      select: EMPLOYEE_SELECT,
      orderBy: { id: 'asc' },
    }),
    loadRuleRows(db),
    loadGosiRateRows(db),
    loadAssumptionRows(db),
    loadPayrollSettings(db),
    loadAnnualLeaveDaysSetting(db),
  ]);
  const employees = rows.map(toEmployeeInput);
  // Legal companies (levy, groups) + actual companies (their «إعدادات الكلفة» apply when no legal company).
  const companyIds = [...new Set(employees.flatMap((e) => [e.legalCompanyId, e.actualCompanyId]).filter((x): x is string => !!x))];
  const companies = await loadCompanies(db, companyIds);

  const s = opts.scope;
  const scoped = !!s && (!!s.companyId || !!s.branchId || !!s.departmentId || (!!s.employeeIds && s.employeeIds.length > 0));
  const ids = new Set(s?.employeeIds ?? []);
  const reportEmployeeIds = scoped
    ? employees
        .filter(
          (e) =>
            (!s!.companyId || e.legalCompanyId === s!.companyId) &&
            (!s!.branchId || e.branchId === s!.branchId) &&
            (!s!.departmentId || e.departmentId === s!.departmentId) &&
            (!s!.employeeIds || s!.employeeIds.length === 0 || ids.has(e.id)),
        )
        .map((e) => e.id)
    : null;

  return {
    input: { employees, companies, rules, gosiRates, assumptions, payrollSettings, annualLeaveDaysSetting },
    reportEmployeeIds,
  };
}

/**
 * Builds ExitCostInput for one employee: leaves and loans exactly as POST /api/settlements loads them,
 * plus the employees of the same legal company (levy tier change). null when the employee does not exist.
 */
export async function loadExitCostInput(
  opts: {
    employeeId: string;
    reason: string;
    lastWorkingDate: Date;
    noticeServed: boolean;
    whoGivesNotice?: 'EMPLOYER' | 'EMPLOYEE' | null;
    replacementIsSaudi?: boolean | null;
    salaryBasis?: 'basic' | 'total';
    scenario?: Scenario;
  },
  db: Db = prisma,
): Promise<ExitCostInput | null> {
  const row = await db.employee.findUnique({
    where: { id: opts.employeeId },
    select: {
      ...EMPLOYEE_SELECT,
      leaves: {
        where: { status: { in: [...BALANCE_CONSUMING_STATUSES] as LeaveStatus[] }, leaveType: { in: [...BALANCE_LEAVE_TYPES] as LeaveType[] } },
        select: { leaveType: true, status: true, startDate: true, endDate: true, createdAt: true, totalDays: true, paidDays: true },
      },
      loans: {
        where: { status: { in: [...LOAN_DEDUCTIBLE_STATUSES] }, isForgiven: false, remainingAmount: { gt: 0 } },
        select: { remainingAmount: true, installments: { where: { payroll: { status: PAYROLL_STATUS.DRAFT } }, select: { month: true, year: true, amount: true } } },
      },
    },
  });
  if (!row) return null;
  const employee = toEmployeeInput(row);
  // Same test as POST /api/settlements (lastMonthAlreadyPaid): an APPROVED / PAID payroll of that month.
  const lastMonth = monthOf(opts.lastWorkingDate);
  const lastMonthPaid = await db.payroll.findFirst({
    where: { employeeId: opts.employeeId, year: lastMonth.year, month: lastMonth.month, status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
    select: { id: true },
  });

  const settingsCompanyId = employee.legalCompanyId || employee.actualCompanyId || null;
  const [rules, gosiRates, assumptions, payrollSettings, annualLeaveDaysSetting, companies, peers] = await Promise.all([
    loadRuleRows(db),
    loadGosiRateRows(db),
    loadAssumptionRows(db),
    loadPayrollSettings(db),
    loadAnnualLeaveDaysSetting(db),
    // Legal company (levy) and, without one, the actual company («إعدادات الكلفة»).
    settingsCompanyId ? loadCompanies(db, [settingsCompanyId]) : Promise.resolve([] as WfCompanyInput[]),
    employee.legalCompanyId
      ? db.employee.findMany({
          where: { legalCompanyId: employee.legalCompanyId, OR: [{ isTerminated: false }, { isTerminated: true, terminationDate: { gte: opts.lastWorkingDate } }] },
          select: EMPLOYEE_SELECT,
          orderBy: { id: 'asc' },
        })
      : Promise.resolve([] as EmployeeRow[]),
  ]);

  return {
    employee: {
      ...employee,
      leaves: row.leaves.map((l) => ({ ...l, leaveType: String(l.leaveType), status: String(l.status) })),
      loans: row.loans,
    },
    reason: opts.reason,
    lastWorkingDate: opts.lastWorkingDate,
    noticeServed: opts.noticeServed,
    whoGivesNotice: opts.whoGivesNotice ?? null,
    replacementIsSaudi: opts.replacementIsSaudi ?? null,
    lastMonthAlreadyPaid: !!lastMonthPaid,
    companyEmployees: peers.map(toEmployeeInput),
    company: employee.legalCompanyId ? (companies[0] ?? null) : null,
    settingsCompany: companies[0] ?? null,
    rules,
    gosiRates,
    assumptions,
    payrollSettings,
    annualLeaveDaysSetting,
    salaryBasis: opts.salaryBasis,
    scenario: opts.scenario,
  };
}

/** Stores a snapshot built with buildSnapshot(). Returns the new row id. */
export async function saveWorkforceCalculation(record: WorkforceCalculationRecord, createdById: string | null, db: Db = prisma): Promise<string> {
  const row = await db.workforceCalculation.create({ data: { ...record, createdById }, select: { id: true } });
  return row.id;
}

// ---------------------------------------------------------------------------
// Phase 2: Nitaqat register, localization decisions, legal-company workforce
// ---------------------------------------------------------------------------

/** Every NitaqatActivity with its curves (the register is small: ~41 activities × 12 rows). */
export async function loadNitaqatRegister(db: Db = prisma): Promise<{ activities: NitaqatActivityRow[]; curves: Array<NitaqatCurveRow & { id: string; createdAt: Date; createdById: string | null }> }> {
  const [activities, curves] = await Promise.all([
    db.nitaqatActivity.findMany({ select: { key: true, nameAr: true, code: true, sizeSegment: true, status: true, sourceUrl: true, page: true, notes: true, createdAt: true }, orderBy: [{ nameAr: 'asc' }, { key: 'asc' }] }),
    db.nitaqatCurve.findMany({ select: { id: true, activityKey: true, band: true, year: true, m: true, c: true, status: true, sourceUrl: true, page: true, note: true, createdAt: true, createdById: true }, orderBy: [{ activityKey: 'asc' }, { year: 'asc' }, { band: 'asc' }] }),
  ]);
  return { activities, curves };
}

export async function loadLocalizationDecisions(db: Db = prisma): Promise<Array<LocalizationDecisionRow & { createdById: string | null; createdAt: Date }>> {
  return db.localizationDecision.findMany({ orderBy: [{ groupNameAr: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
}

/** Window of past employment loaded for the 26-week average (days). */
export const NITAQAT_HISTORY_DAYS = 26 * 7;

export interface LegalCompanyWorkforce {
  company: WfCompanyInput;
  /** Employees of the legal company active on the date or during the 26 weeks before it, or joining later. */
  employees: WfEmployeeInput[];
}

/**
 * Legal companies and their employees for the Saudization planner / hire scenarios. `companyId` = one
 * company; otherwise every company that has an active legal employee on the date or a Nitaqat activity.
 */
export async function loadLegalCompanyWorkforce(opts: { companyId?: string | null; date: Date }, db: Db = prisma): Promise<LegalCompanyWorkforce[]> {
  const since = new Date(opts.date.getTime() - NITAQAT_HISTORY_DAYS * 86400000);
  const rows = await db.employee.findMany({
    where: {
      legalCompanyId: opts.companyId ? opts.companyId : { not: null },
      OR: [{ isTerminated: false }, { isTerminated: true, terminationDate: { gte: since } }],
    },
    select: EMPLOYEE_SELECT,
    orderBy: { id: 'asc' },
  });
  const employees = rows.map(toEmployeeInput);
  const byCompany = new Map<string, WfEmployeeInput[]>();
  for (const e of employees) {
    const list = byCompany.get(e.legalCompanyId!) ?? [];
    list.push(e);
    byCompany.set(e.legalCompanyId!, list);
  }
  let ids: string[];
  if (opts.companyId) ids = [opts.companyId];
  else {
    const withActivity = await db.company.findMany({ where: { nitaqatActivityKey: { not: null } }, select: { id: true } });
    ids = [...new Set([...byCompany.keys(), ...withActivity.map((c) => c.id)])];
  }
  const companies = await loadCompanies(db, ids);
  return companies.map((c) => ({ company: c, employees: byCompany.get(c.id) ?? [] })).sort((a, b) => a.company.name.localeCompare(b.company.name) || a.company.id.localeCompare(b.company.id));
}

/** Engine inputs shared by the solver costs and the hire scenarios (rules, GOSI, assumptions, settings). */
export async function loadCostContextRows(db: Db = prisma) {
  const [rules, gosiRates, assumptions, payrollSettings, annualLeaveDaysSetting] = await Promise.all([loadRuleRows(db), loadGosiRateRows(db), loadAssumptionRows(db), loadPayrollSettings(db), loadAnnualLeaveDaysSetting(db)]);
  return { rules, gosiRates, assumptions, payrollSettings, annualLeaveDaysSetting };
}
