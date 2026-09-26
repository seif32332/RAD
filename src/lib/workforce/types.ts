// Workforce decision engine ("محرك القرارات") — shared types. PURE, client-safe.
// See docs/workforce-engine/SPEC.md. Every amount is SAR, rounded to halalas (roundMoney).
import type { PayrollSettings } from '@/lib/payroll-core';
import type { GosiRateLike } from '@/lib/gosi';
import type { NationalityClass } from '@/lib/nationality';
import type { SettlementLeaveLike, SettlementLoanLike } from '@/lib/settlement';
import type { CompanyCostSettings } from '@/lib/workforce/company-settings';

// ---------------------------------------------------------------------------
// Statuses, rules, assumptions
// ---------------------------------------------------------------------------

/**
 * Evidence status shown next to every number ("لماذا هذا الرقم؟").
 * VERIFIED_PRIMARY: official source. CORROBORATED_SECONDARY: two secondary sources. PROVISIONAL: pending
 * confirmation. CONFLICTING: sources disagree. USER_INPUT: an assumption entered by the company.
 * MISSING: needed value not available (the amount is 0 and flagged). DERIVED: computed from Radeef data
 * (salary, allowances) without a regulatory parameter.
 */
export type WfStatus =
  | 'VERIFIED_PRIMARY'
  | 'CORROBORATED_SECONDARY'
  | 'PROVISIONAL'
  | 'CONFLICTING'
  | 'USER_INPUT'
  | 'MISSING'
  | 'DERIVED';

/** A RuleParameter row (Prisma model RuleParameter; extra columns are ignored). */
export interface RuleRow {
  key: string;
  label?: string | null;
  domain?: string | null;
  value: number | null;
  valueJson?: string | null;
  unit?: string | null;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status: string;
  sourceUrl?: string | null;
  sourceQuote?: string | null;
  notes?: string | null;
}

/** The version of a rule in force at a date (or a MISSING placeholder). */
export interface ResolvedRule {
  key: string;
  label: string;
  value: number | null;
  valueJson: unknown;
  unit: string | null;
  status: WfStatus;
  sourceUrl: string | null;
  sourceQuote: string | null;
  notes: string | null;
  /** null when MISSING. */
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

/** key -> rule in force at the resolution date. Keys never seeded resolve to status MISSING. */
export type RuleSet = Readonly<Record<string, ResolvedRule>>;

/** GosiRate row (+ its source text for the explanations). */
export interface GosiRateRow extends GosiRateLike {
  source?: string | null;
}

/** A WorkforceAssumption row (companyId '' = all companies). */
export interface AssumptionRow {
  key: string;
  companyId: string;
  value: number | null;
  valueJson?: string | null;
  note?: string | null;
}

export type Scenario = 'low' | 'base' | 'high';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface WfAllowanceInput {
  name: string | null;
  amount: number | null;
  isMonthly: boolean;
  countsTowardGosi?: boolean | null;
  /** HOUSING / TRANSPORT / FOOD / OTHER; null = infer (countsTowardGosi, then the name). */
  allowanceType?: string | null;
  /** One-off bonus payroll month (isMonthly = false). */
  payrollMonth?: number | null;
  payrollYear?: number | null;
  isPaid?: boolean | null;
}

export interface WfSalaryChangeInput {
  effectiveDate: Date;
  basicSalary: number;
  isPlanned: boolean;
}

export interface WfEmployeeInput {
  id: string;
  /** Display name (Arabic). */
  name: string;
  employeeNo?: string | null;
  nationality: string | null;
  /** 'MALE' / 'FEMALE' (Arabic labels accepted). */
  gender: string | null;
  dateOfBirth?: Date | null;
  joinDate: Date;
  /** Termination date (terminated employees) — no cost after it. */
  terminationDate?: Date | null;
  /** Fixed-term contract end — treated as the exit date when earlier than any termination. */
  contractEndDate?: Date | null;
  contractType?: string | null;
  partTimeWeeklyHours?: number | null;
  basicSalary: number;
  allowances: ReadonlyArray<WfAllowanceInput>;
  gosiRegime?: string | null;
  legalCompanyId: string | null;
  actualCompanyId?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  /** Branch city (Arabic or English) — HRDF "outside the four big cities" category. */
  branchCity?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  dependentsCount?: number | null;
  /** COMPANY / EMPLOYEE; null = assumption DEPENDENTS_FEE_PAID_BY_DEFAULT. */
  dependentsFeePaidBy?: string | null;
  isDisabled?: boolean | null;
  medicalInsuranceClass?: string | null;
  leaveAccrualStartDate?: Date | null;
  /** Dated salary changes (only those effective on/after the first projected month are applied). */
  salaryChanges?: ReadonlyArray<WfSalaryChangeInput>;
  /** Hypothetical hire (scenario), not an existing employee. */
  isPlanned?: boolean;
  /** Expected overtime hours per month (0 / undefined = no overtime line). */
  overtimeHoursPerMonth?: number | null;
  /** Iqama expiry (expats): sunk prepaid fees in the exit cost. */
  iqamaExpiry?: Date | null;
  // --- Phase 2 (Nitaqat / localization, nitaqat.ts and saudization.ts) ---
  /** Muawama certificate expiry (disabled employees; entities of 50+ need a valid one for the weight 4). */
  muawamaCertExpiry?: Date | null;
  isStudent?: boolean | null;
  /** Contract documented in Qiwa: from 2026-04-15 only documented contracts count in Nitaqat. */
  qiwaContractDocumented?: boolean | null;
  qiwaContractDocumentedAt?: Date | null;
  occupationName?: string | null;
  occupationCode?: string | null;
}

export interface WfCompanyInput {
  id: string;
  name: string;
  isIndustrialLicensed: boolean;
  nitaqatActivity?: string | null;
  /** NitaqatActivity.key selected for the company (Phase 2); null = not selected. */
  nitaqatActivityKey?: string | null;
  /**
   * «إعدادات الكلفة» of the company (overtime basis, medical premiums, iqama fee): the single source of
   * truth for these values (company-settings.ts). Omitted = nothing entered (BASIC, no premiums, rule fee).
   */
  costSettings?: CompanyCostSettings;
}

export interface TrueCostInput {
  employees: ReadonlyArray<WfEmployeeInput>;
  companies: ReadonlyArray<WfCompanyInput>;
  rules: ReadonlyArray<RuleRow>;
  gosiRates: ReadonlyArray<GosiRateRow>;
  assumptions: ReadonlyArray<AssumptionRow>;
  payrollSettings?: PayrollSettings;
  /** SystemSetting annual_leave_days (company policy above the statutory 21/30). */
  annualLeaveDaysSetting?: number | null;
}

export interface TrueCostOptions {
  /** First projected month 'YYYY-MM' (or any Date inside it). */
  startMonth: string | Date;
  /** Horizon length (default 36). */
  months?: number;
  scenario?: Scenario;
  /**
   * The monthly leave accrual is a provision: salary keeps being paid during the leave, so adding it on
   * top of 12 salaries double counts unless the leave is paid out. Default false = shown as MEMO line.
   */
  leaveAccrualInTotal?: boolean;
  /** Wage basis for EOSB / leave / notice (settlement screen default 'total' = basic + recurring allowances). */
  salaryBasis?: 'basic' | 'total';
  /**
   * Report only these employees (results, groups, totals). All input employees are still used for the
   * levy tiers of their legal company (a branch view must not change the company's Saudi count).
   */
  employeeIds?: ReadonlyArray<string> | null;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type CostLineKey =
  | 'BASIC'
  | 'ALLOWANCES'
  | 'ONE_OFF_BONUS'
  | 'OVERTIME'
  | 'GOSI_EMPLOYER'
  | 'EOSB_ACCRUAL'
  | 'LEAVE_ACCRUAL'
  | 'EXPAT_LEVY'
  | 'WORK_PERMIT'
  | 'IQAMA'
  | 'DEPENDENTS_FEE'
  | 'EXIT_REENTRY'
  | 'ANNUAL_TICKET'
  | 'MEDICAL'
  | 'MEDICAL_DEPENDENTS'
  | 'HRDF_SUBSIDY';

/**
 * COST: counted in the employer cost. SUBSIDY: negative, conditional (totals are given before and after).
 * MEMO: shown for information, not counted (e.g. the leave provision).
 */
export type CostLineKind = 'COST' | 'SUBSIDY' | 'MEMO';

/**
 * HRDF employment-support categories (+10% each). DISABLED is health data: the API layer replaces the
 * category list with a neutral text for viewers who may not see disability (src/lib/workforce/privacy.ts).
 */
export type HrdfCategory = 'FEMALE' | 'DISABLED' | 'SME' | 'OUTSIDE_MAJOR_CITIES';

export interface CostLine {
  key: CostLineKey;
  label: string;
  /** SAR for the month; negative for SUBSIDY. */
  amount: number;
  /** Short Arabic formula with the actual numbers, e.g. "12.75% × 8,000". */
  basis: string;
  status: WfStatus;
  /** RuleParameter keys (or pseudo keys 'GOSI_RATE:…' / 'LAW:…' / 'ASSUMPTION:…') behind the amount. */
  ruleKeys: string[];
  kind: CostLineKind;
  note?: string;
  /** HRDF_SUBSIDY only: the categories that raised the percentage (structured codes; redacted per viewer). */
  categories?: HrdfCategory[];
}

export interface MoneyTriple {
  /** Employer cost before subsidies (COST lines). */
  cost: number;
  /** Subsidies (<= 0). */
  subsidy: number;
  /** cost + subsidy. */
  net: number;
}

export interface EmployeeMonth {
  /** 'YYYY-MM'. */
  month: string;
  /** Employed on at least one day of the month. */
  active: boolean;
  /** Share of the month employed (calendar days), 0..1. */
  factor: number;
  basicSalary: number;
  /** Clamped GOSI contributory wage used (0 when inactive). */
  contributoryWage: number;
  gosiRegimeUsed: string | null;
  gosiEmployerRatePct: number | null;
  /** Levy tier of this expat in this month (null for Saudi / GCC / inactive). */
  levyTier: 'EXEMPT' | 'WITHIN' | 'ABOVE' | 'INDUSTRIAL_ZERO' | null;
  lines: CostLine[];
  totals: MoneyTriple;
  /** Sum of MEMO lines (not counted). */
  memo: number;
}

export type FlagCode =
  | 'MISSING_GOSI_REGIME'
  | 'MISSING_LEGAL_COMPANY'
  | 'MISSING_MEDICAL_CLASS'
  | 'MISSING_MEDICAL_PREMIUM'
  | 'MISSING_ASSUMPTION'
  | 'HOUSING_INFERRED_FROM_NAME'
  | 'HOUSING_TYPE_CONFLICT'
  | 'PROVISIONAL_RULE'
  | 'CONFLICTING_RULE'
  | 'MISSING_RULE'
  | 'GCC_PENSION_NOT_MODELLED'
  | 'MISSING_NATIONALITY'
  | 'CONTRACT_END_ASSUMED_EXIT'
  | 'EXITS_DURING_HORIZON'
  | 'SMALL_EST_EXEMPTION_ASSUMED'
  | 'SMALL_EST_EXTENSION_UNCERTAIN'
  | 'NATIONALITY_AMBIGUOUS'
  | 'HRDF_CONDITIONAL'
  | 'HRDF_WINDOW_WAGE_UNKNOWN'
  | 'COUNSEL_PENDING'
  | 'DEPENDENTS_UNKNOWN';

export interface WfFlag {
  code: FlagCode;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  /** Arabic message for the UI. */
  message: string;
  employeeId?: string;
  companyId?: string;
  lineKey?: CostLineKey | string;
  ruleKey?: string;
}

export interface WindowTotals {
  /** First projected month. */
  month1: MoneyTriple;
  next12: MoneyTriple;
  next24: MoneyTriple;
  next36: MoneyTriple;
  /** Whole horizon (= next36 for the default 36 months). */
  horizon: MoneyTriple;
}

export interface EmployeeLiabilities {
  /** Art.84 award if the employer terminated on the day before the first projected month. */
  eosbEmployerAtStart: number;
  /** Art.85 award if the employee resigned on that day. */
  eosbResignationAtStart: number;
  /** Art.84 award at the end of the horizon (or at the exit date). */
  eosbEmployerAtEnd: number;
  eosbResignationAtEnd: number;
  /** Wage used for the liabilities (basis per options.salaryBasis). */
  wageAtStart: number;
}

export interface EmployeeCostResult {
  employeeId: string;
  name: string;
  employeeNo: string | null;
  isPlanned: boolean;
  nationalityClass: NationalityClass;
  legalCompanyId: string | null;
  companyName: string | null;
  /** Company whose «إعدادات الكلفة» apply (legalCompanyId ?? actualCompanyId; null = none). */
  settingsCompanyId: string | null;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  /** 'YYYY-MM-DD' last day with cost inside the horizon, null when employed through the horizon. */
  exitDate: string | null;
  months: EmployeeMonth[];
  totals: WindowTotals;
  /** Sum per line key over the whole horizon (COST and SUBSIDY lines; MEMO too, flagged by kind). */
  byLine: Partial<Record<CostLineKey, number>>;
  liabilities: EmployeeLiabilities;
  flags: WfFlag[];
}

export interface GroupTotals {
  id: string;
  name: string;
  /** Employees active in the first projected month. */
  headcount: number;
  totals: WindowTotals;
  byLine: Partial<Record<CostLineKey, number>>;
  /** Monthly series of the group. */
  series: Array<{ month: string } & MoneyTriple>;
}

export interface CompanyMonthMix {
  month: string;
  headcount: number;
  saudi: number;
  gcc: number;
  expat: number;
  /** Expats exempted by the small-establishment rule. */
  exempt: number;
  /** Expats at the 'within Saudi count' rate (700). */
  within: number;
  /** Expats at the 'above Saudi count' rate (800). */
  above: number;
  /** Levy cancelled for a licensed industrial establishment. */
  industrialZero: boolean;
  levyTotal: number;
}

export interface CompanyMix {
  companyId: string;
  name: string;
  isIndustrialLicensed: boolean;
  months: CompanyMonthMix[];
}

export interface RuleEvidence {
  key: string;
  label: string;
  value: number | null;
  unit: string | null;
  status: WfStatus;
  sourceUrl: string | null;
  sourceQuote: string | null;
  /** 'YYYY-MM-DD' or null (MISSING). */
  effectiveFrom: string | null;
}

export interface LineExplanation {
  label: string;
  formulaText: string;
  rules: RuleEvidence[];
}

/** Exact rule versions used by a calculation (stored with the snapshot). */
export interface RuleVersionRef {
  key: string;
  effectiveFrom: string | null;
  status: WfStatus;
  value: number | null;
}

export interface TrueCostResult {
  engineVersion: string;
  scenario: Scenario;
  startMonth: string;
  monthKeys: string[];
  employees: EmployeeCostResult[];
  /** Whole-workforce monthly series. */
  series: Array<{ month: string; byLine: Partial<Record<CostLineKey, number>>; headcount: number } & MoneyTriple>;
  totals: WindowTotals;
  /** Sum per line key over 12 months and the horizon. */
  composition: Array<{ key: CostLineKey; label: string; kind: CostLineKind; next12: number; horizon: number }>;
  byCompany: GroupTotals[];
  byBranch: GroupTotals[];
  byDepartment: GroupTotals[];
  companies: CompanyMix[];
  flags: WfFlag[];
  explanations: Partial<Record<CostLineKey, LineExplanation>>;
  rulesUsed: RuleVersionRef[];
  /** Assumptions as resolved (global), with their origin. */
  assumptionsUsed: Array<{ key: string; value: unknown; origin: 'COMPANY' | 'GLOBAL' | 'DEFAULT'; companyId: string }>;
  /** «إعدادات الكلفة» of every company whose settings were used (sorted by id; snapshot + «لماذا؟»). */
  companySettingsUsed: Array<{ companyId: string; name: string } & CompanyCostSettings>;
}

// Exit cost ------------------------------------------------------------------

export type ExitLineKey =
  | 'EOSB'
  | 'NOTICE_PAY'
  | 'NOTICE_OWED_BY_EMPLOYEE'
  | 'LEAVE_PAYOUT'
  | 'EXCESS_LEAVE_DEDUCTION'
  | 'LOANS_OFFSET'
  | 'ART77_RISK'
  | 'SUNK_IQAMA'
  | 'SUNK_WORK_PERMIT'
  | 'RECRUITMENT'
  | 'VACANCY'
  | 'LEVY_TIER_CHANGE';

/**
 * PAYABLE: paid by the company because of the exit. OFFSET: reduces what is paid (loans, notice owed by
 * the employee). RISK: possible liability if contested (Art.77), not in the payable total. SUNK: prepaid
 * government fees not recovered (information). REPLACEMENT: cost of the replacement (assumptions).
 * ONGOING: monthly change for the remaining workforce (levy tiers).
 */
export type ExitLineKind = 'PAYABLE' | 'OFFSET' | 'RISK' | 'SUNK' | 'REPLACEMENT' | 'ONGOING';

export interface ExitLine {
  key: ExitLineKey;
  label: string;
  /** Positive = cost to the company; negative = offset. ONGOING = per month. */
  amount: number;
  basis: string;
  status: WfStatus;
  ruleKeys: string[];
  kind: ExitLineKind;
  note?: string;
}

export interface ExitCostInput {
  employee: WfEmployeeInput & {
    leaves: ReadonlyArray<SettlementLeaveLike>;
    loans: ReadonlyArray<SettlementLoanLike>;
  };
  /** Settlement TERMINATION_REASONS value, or an Employee.exitReason (mapped, see reasons.ts). */
  reason: string;
  lastWorkingDate: Date;
  /** Whether the notice period is (or will be) worked. */
  noticeServed: boolean;
  /** Who gives notice; default from the reason (RESIGNATION -> EMPLOYEE, COMPANY_TERMINATION -> EMPLOYER). */
  whoGivesNotice?: 'EMPLOYER' | 'EMPLOYEE' | null;
  /** Other employees of the same legal company (for the levy tier change); the leaver may be included. */
  companyEmployees: ReadonlyArray<WfEmployeeInput>;
  company: WfCompanyInput | null;
  /**
   * Company whose «إعدادات الكلفة» apply to the employee (legal company, else actual company). Omitted =
   * `company`. Used for the sunk iqama fee and the vacancy month cost.
   */
  settingsCompany?: WfCompanyInput | null;
  rules: ReadonlyArray<RuleRow>;
  gosiRates: ReadonlyArray<GosiRateRow>;
  assumptions: ReadonlyArray<AssumptionRow>;
  scenario?: Scenario;
  annualLeaveDaysSetting?: number | null;
  payrollSettings?: PayrollSettings;
  salaryBasis?: 'basic' | 'total';
  /** Replacement nationality (default: same class as the leaver). */
  replacementIsSaudi?: boolean | null;
  /**
   * Whether an APPROVED / PAID payroll already covers the month of the last working day (the settlement
   * screen's lastMonthAlreadyPaid). Information only: the exit cost never counts the last month's salary
   * (it is payroll), but result.lastMonth tells what the settlement screen adds. null = unknown.
   */
  lastMonthAlreadyPaid?: boolean | null;
}

export interface LevySnapshot {
  saudi: number;
  gcc: number;
  expat: number;
  headcount: number;
  exempt: number;
  within: number;
  above: number;
  industrialZero: boolean;
  /** Monthly levy of the whole legal company. */
  monthlyLevy: number;
}

export interface ExitCostResult {
  engineVersion: string;
  employeeId: string;
  /** Settlement reason used (TERMINATION_REASONS). */
  reason: string;
  /** Reason as given (may be an Employee.exitReason). */
  reasonInput: string;
  /** Mapping note when the input was an Employee.exitReason. */
  reasonNote: string | null;
  lastWorkingDate: string;
  yearsOfService: number;
  wageUsed: number;
  lines: ExitLine[];
  totals: {
    /** EOSB + notice pay + leave payout. */
    payable: number;
    /** Loans, notice owed by the employee, excess leave (<= 0). */
    offsets: number;
    /** payable + offsets: net amount paid to the employee. */
    netToEmployee: number;
    /** Art.77 exposure if contested (not in netToEmployee). */
    risk: number;
    sunkFees: number;
    replacement: number;
    /** Monthly levy change for the remaining workforce. */
    ongoingMonthlyDelta: number;
  };
  /** computeSettlement() output used for EOSB / leave / loans (same numbers as the settlement screen). */
  settlement: import('@/lib/settlement').SettlementBreakdown;
  /**
   * Settlement amount WITHOUT the last month's working-day salary (computeSettlement with
   * lastMonthAlreadyPaid = true, no overtime / manual items). Equals the settlement screen only when the
   * month of the last working day is already covered by an approved / paid payroll.
   */
  settlementScreenTotal: number;
  /**
   * The last month's working-day salary exactly as the settlement screen computes it (computeSettlement
   * with lastMonthAlreadyPaid = false: day rate × day-of-month of the last working day) and the settlement
   * total including it (= the settlement screen while no approved / paid payroll covers that month).
   */
  lastMonth: {
    workingDays: number;
    salary: number;
    settlementTotalIfUnpaid: number;
    /** input.lastMonthAlreadyPaid (null = unknown). */
    paidByPayroll: boolean | null;
  };
  levyImpact: { month: string; before: LevySnapshot; after: LevySnapshot; deltaMonthly: number } | null;
  flags: WfFlag[];
  explanations: Partial<Record<ExitLineKey, LineExplanation>>;
  rulesUsed: RuleVersionRef[];
}
