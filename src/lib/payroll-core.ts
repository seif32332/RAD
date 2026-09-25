// Payroll domain logic: PURE part (no database access, no server-only imports).
//
// Safe to import from client components (e.g. the settlement preview in
// src/app/settlements/new/page.tsx) and from unit tests. The database helpers live in
// src/lib/payroll.ts, which re-exports everything from this module.
//
// Conventions (documented here so every screen computes the same numbers):
// - dailyRate(emp)   = monthly wage / 30 (30-day month convention, Saudi practice).
//                      monthly wage = basic + recurring (isMonthly) allowances.
//                      Used for EVERY per-day charge: unpaid leave, sick-leave tiers,
//                      penalty days, settlement working days / leave compensation.
// - basicHourlyRate  = basic / (30 * default_work_hours_per_day)   (8h by default).
//                      Overtime hour = basicHourlyRate * overtime_rate_multiplier
//                      (overtime_weekend_multiplier on Friday/Saturday for a 5-day week,
//                      Friday only for a 6-day week).
// - Proration of the monthly salary for joiners / leavers is on a CALENDAR-DAY basis:
//                      basic * eligibleDays / daysInMonth (same for recurring allowances).
// - GOSI (payroll generation): src/lib/gosi.ts calculateGosi with the dated GosiRate table
//                      (DEC-003): regime-aware rates effective on the month's first day, wage =
//                      basic + allowances flagged countsTowardGosi clamped to [1,500, 45,000],
//                      prorated; employee AND employer shares; UNKNOWN Saudi regime -> OLD rates
//                      + needsReview. Employee.gosiDeduction > 0 overrides the employee share.
//                      LEGACY (computePayrollLine without gosiRates, gosiEmployeeAmount): the
//                      gosi_employee_percentage settings of (basic + housing-named allowances).
// - Overtime is linked to the payroll / settlement that pays it (OvertimeRequest.paidInPayrollId
//   / paidInSettlementId), see "Overtime payment tracking" below. Overtime approved after its
//   month's payroll was generated is paid by the next generated month.
import { roundMoney, sumMoney } from '@/lib/money';
import { addDays, dateKey, monthRange, today, todayKey } from '@/lib/dates';
import { SETTLEMENT_STATUS } from '@/lib/constants';
import { validateSaudiIban } from '@/lib/iban';
import {
  calculateGosi,
  gosiBaseWage,
  GOSI_NOTES,
  isSaudiForGosi,
  joinReviewNotes,
  type GosiRateLike,
  type GosiRegimeValue,
} from '@/lib/gosi';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const PAYROLL_SETTING_KEYS = {
  overtimeMultiplier: 'overtime_rate_multiplier',
  overtimeWeekendMultiplier: 'overtime_weekend_multiplier',
  gosiEmployeePercentage: 'gosi_employee_percentage',
  gosiEmployeePercentageNonSaudi: 'gosi_employee_percentage_non_saudi',
  workHoursPerDay: 'default_work_hours_per_day',
  workDaysPerWeek: 'default_work_days_per_week',
} as const;

export interface PayrollSettings {
  overtimeMultiplier: number;
  overtimeWeekendMultiplier: number;
  gosiEmployeePercentage: number;
  gosiEmployeePercentageNonSaudi: number;
  workHoursPerDay: number;
  workDaysPerWeek: number;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  overtimeMultiplier: 1.5,
  overtimeWeekendMultiplier: 2.0,
  gosiEmployeePercentage: 9.75,
  gosiEmployeePercentageNonSaudi: 0,
  workHoursPerDay: 8,
  workDaysPerWeek: 5,
};

/** Maximum monthly wage subject to GOSI contributions (SAR). */
export const GOSI_MAX_CONTRIBUTORY_WAGE = 45000;

function settingNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** Build payroll settings from SystemSetting rows; invalid / missing values fall back to defaults. */
export function parsePayrollSettings(rows: ReadonlyArray<{ key: string; value: string }>): PayrollSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const d = DEFAULT_PAYROLL_SETTINGS;
  const k = PAYROLL_SETTING_KEYS;
  return {
    overtimeMultiplier: settingNumber(map.get(k.overtimeMultiplier), d.overtimeMultiplier, 0, 10),
    overtimeWeekendMultiplier: settingNumber(map.get(k.overtimeWeekendMultiplier), d.overtimeWeekendMultiplier, 0, 10),
    gosiEmployeePercentage: settingNumber(map.get(k.gosiEmployeePercentage), d.gosiEmployeePercentage, 0, 100),
    gosiEmployeePercentageNonSaudi: settingNumber(
      map.get(k.gosiEmployeePercentageNonSaudi),
      d.gosiEmployeePercentageNonSaudi,
      0,
      100,
    ),
    workHoursPerDay: settingNumber(map.get(k.workHoursPerDay), d.workHoursPerDay, 1, 24),
    workDaysPerWeek: Math.round(settingNumber(map.get(k.workDaysPerWeek), d.workDaysPerWeek, 1, 7)),
  };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

export interface AllowanceLike {
  name?: string | null;
  amount: number | null;
  isMonthly: boolean;
  /** Part of the GOSI contributory wage (explicit flag, DEC-003). */
  countsTowardGosi?: boolean | null;
}

export interface SalaryLike {
  basicSalary: number | null;
  /** Any allowances; only recurring (isMonthly) ones count towards the wage. */
  allowances?: ReadonlyArray<AllowanceLike> | null;
}

export type SalaryBasis = 'basic' | 'total';

/** Sum of recurring monthly allowances (one-off bonuses are excluded). */
export function monthlyAllowancesTotal(allowances: ReadonlyArray<AllowanceLike> | null | undefined): number {
  return sumMoney((allowances ?? []).filter((a) => a.isMonthly).map((a) => a.amount ?? 0));
}

/** Monthly wage: basic + recurring allowances ('total', default) or basic only ('basic'). */
export function monthlyWage(emp: SalaryLike, basis: SalaryBasis = 'total'): number {
  const basic = emp.basicSalary ?? 0;
  if (basis === 'basic') return roundMoney(basic);
  return roundMoney(basic + monthlyAllowancesTotal(emp.allowances));
}

/**
 * THE daily rate used for every per-day amount (30-day month convention).
 * basis 'total' (default) = (basic + recurring allowances) / 30; 'basic' = basic / 30.
 */
export function dailyRate(emp: SalaryLike, basis: SalaryBasis = 'total'): number {
  return roundMoney(monthlyWage(emp, basis) / 30);
}

/** Basic hourly rate used for overtime: basic / (30 * hoursPerDay). Not rounded (intermediate). */
export function basicHourlyRate(emp: Pick<SalaryLike, 'basicSalary'>, settings: PayrollSettings = DEFAULT_PAYROLL_SETTINGS): number {
  const basic = emp.basicSalary ?? 0;
  return basic / (30 * settings.workHoursPerDay);
}

/**
 * LEGACY housing detection (recurring allowances whose name mentions housing / سكن). Payroll
 * generation uses the explicit Allowance.countsTowardGosi flag instead (src/lib/gosi.ts).
 */
export function housingAllowance(allowances: ReadonlyArray<AllowanceLike> | null | undefined): number {
  return sumMoney(
    (allowances ?? [])
      .filter((a) => a.isMonthly && /سكن|housing/i.test(a.name ?? ''))
      .map((a) => a.amount ?? 0),
  );
}

/** Saudi nationality detection (single implementation in src/lib/gosi.ts). */
export function isSaudiNational(nationality: string | null | undefined): boolean {
  return isSaudiForGosi(nationality);
}

/** Friday (and Saturday for a 5-day week) are weekend days. Dates are date-only (UTC midnight). */
export function isWeekend(date: Date, workDaysPerWeek = DEFAULT_PAYROLL_SETTINGS.workDaysPerWeek): boolean {
  const day = date.getUTCDay(); // 5 = Friday, 6 = Saturday
  if (day === 5) return true;
  return day === 6 && workDaysPerWeek <= 5;
}

export interface OvertimeLike {
  date: Date;
  type: string | null;
  hours: number | null;
  amount: number | null;
}

/** Amount of one approved overtime request. LUMP_SUM / MAX_AMOUNT pay the fixed amount. */
export function overtimeAmount(
  ot: OvertimeLike,
  emp: Pick<SalaryLike, 'basicSalary'>,
  settings: PayrollSettings = DEFAULT_PAYROLL_SETTINGS,
): number {
  if (ot.type === 'LUMP_SUM' || ot.type === 'MAX_AMOUNT') return roundMoney(Math.max(0, ot.amount ?? 0));
  const hours = Math.max(0, ot.hours ?? 0);
  const multiplier = isWeekend(ot.date, settings.workDaysPerWeek)
    ? settings.overtimeWeekendMultiplier
    : settings.overtimeMultiplier;
  return roundMoney(hours * basicHourlyRate(emp, settings) * multiplier);
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

export interface DateRange {
  start: Date;
  end: Date;
}

/** 'YYYY-MM' key stored in Deduction.payrollMonth. */
export function payrollMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parsePayrollMonthKey(key: string | null | undefined): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
}

/** Month index (year*12 + month-1) for ordering comparisons. */
export function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function dayKeysOfMonth(year: number, month: number): string[] {
  const { days } = monthRange(year, month);
  const keys: string[] = [];
  for (let d = 1; d <= days; d++) keys.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return keys;
}

function inRange(key: string, range: DateRange): boolean {
  const s = dateKey(range.start);
  const e = dateKey(range.end);
  return !!s && !!e && key >= s && key <= e;
}

export interface EmploymentDays {
  eligibleDays: number;
  daysInMonth: number;
  /** eligibleDays / daysInMonth (calendar-day proration). */
  factor: number;
}

/**
 * Days of the month the employee must be paid for by payroll:
 * between joinDate and employmentEnd (inclusive) and outside `excluded` ranges
 * (periods already paid by a settlement).
 */
export function employmentDaysInMonth(opts: {
  year: number;
  month: number;
  joinDate: Date | null;
  employmentEnd?: Date | null;
  excluded?: ReadonlyArray<DateRange>;
}): EmploymentDays {
  const keys = dayKeysOfMonth(opts.year, opts.month);
  const join = dateKey(opts.joinDate);
  const end = dateKey(opts.employmentEnd ?? null);
  let eligible = 0;
  for (const k of keys) {
    if (join && k < join) continue;
    if (end && k > end) continue;
    if (opts.excluded?.some((r) => inRange(k, r))) continue;
    eligible++;
  }
  return { eligibleDays: eligible, daysInMonth: keys.length, factor: keys.length ? eligible / keys.length : 0 };
}

// ---------------------------------------------------------------------------
// Leave deductions (split per month by date overlap)
// ---------------------------------------------------------------------------

export interface LeaveLike {
  id: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: number | null;
  unpaidDays?: number | null;
  totalDeduction?: number | null;
}

export interface LeaveMonthDeduction {
  /** Unpaid (non-sick) leave days falling in the month. */
  unpaidDays: number;
  /** Sick days paid at 75% (i.e. 25% deducted) falling in the month. */
  sickReducedDays: number;
  /** Sick days beyond 90 in the year (fully unpaid) falling in the month. */
  sickUnpaidDays: number;
  /**
   * Recorded leave deduction that could not be tied to deductible days (charged in the month
   * the leave starts). 0 in the normal case, where the recorded amount is split by day.
   */
  adminCharge: number;
  amount: number;
}

/** Calendar day keys of a leave: `totalDays` consecutive days from startDate (fallback: start..end). */
export function leaveDayKeys(leave: Pick<LeaveLike, 'startDate' | 'endDate' | 'totalDays'>): string[] {
  const start = leave.startDate;
  let count = leave.totalDays ?? 0;
  if (!count || count < 0) {
    const s = dateKey(leave.startDate);
    const e = dateKey(leave.endDate);
    count = s && e ? Math.max(0, Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86400000) + 1) : 0;
  }
  count = Math.min(count, 3660);
  const startKey = dateKey(start);
  if (!startKey) return [];
  const base = new Date(`${startKey}T00:00:00.000Z`);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(addDays(base, i).toISOString().slice(0, 10));
  return keys;
}

/** Sick-leave days taken before this leave within the previous year (existing tier logic). */
export function priorSickDays(leave: LeaveLike, allLeaves: ReadonlyArray<LeaveLike>): number {
  const start = new Date(leave.startDate);
  const oneYearAgo = new Date(start);
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
  let past = 0;
  for (const p of allLeaves) {
    if (p.leaveType !== 'SICK' || p.id === leave.id) continue;
    if (new Date(p.endDate) >= oneYearAgo && new Date(p.startDate) <= start) past += p.totalDays ?? 0;
  }
  return past;
}

/** Share of the daily rate deducted for a 75%-paid sick day. */
const SICK_REDUCED_DEDUCTION_RATIO = 0.25;

/**
 * Deduction caused by one approved leave in the given month.
 * - Deductible days: non-sick leaves -> the last `unpaidDays` days of the leave are unpaid
 *   (UNPAID type: all days unless unpaidDays says otherwise); sick leave tiers within a year ->
 *   days 1-30 full pay, 31-90 at 75% (25% deducted), after 90 unpaid.
 * - leave.totalDeduction, when recorded (every leave created or recalculated through
 *   src/lib/leave.ts), IS the salary deduction of the whole leave (0 when HR waived it; see
 *   computeLeaveRequest). It is split across months in proportion to the deductible days
 *   (the per-month shares always add up to the recorded amount). It is never added on top of
 *   the unpaid days (that would deduct the same days twice). A recorded amount with no
 *   deductible days is charged in the month the leave starts (`adminCharge`).
 * - Legacy leaves without a recorded totalDeduction: deductible days x `rate`.
 */
export function leaveDeductionForMonth(
  leave: LeaveLike,
  allLeaves: ReadonlyArray<LeaveLike>,
  rate: number,
  year: number,
  month: number,
): LeaveMonthDeduction {
  const prefix = payrollMonthKey(year, month);
  const days = leaveDayKeys(leave);
  let unpaidDays = 0;
  let sickReducedDays = 0;
  let sickUnpaidDays = 0;
  // Deductible weight (1 = a full day's pay) before / within the month and over the whole leave.
  let weightBefore = 0;
  let weightInMonth = 0;
  let weightTotal = 0;

  const count = (k: string, weight: number) => {
    weightTotal += weight;
    if (k < prefix) weightBefore += weight;
    else if (k.startsWith(prefix)) weightInMonth += weight;
  };

  if (leave.leaveType === 'SICK') {
    let cumulative = priorSickDays(leave, allLeaves);
    for (const k of days) {
      cumulative++;
      const inMonth = k.startsWith(prefix);
      if (cumulative > 90) {
        count(k, 1);
        if (inMonth) sickUnpaidDays++;
      } else if (cumulative > 30) {
        count(k, SICK_REDUCED_DEDUCTION_RATIO);
        if (inMonth) sickReducedDays++;
      }
    }
  } else {
    let unpaid = Math.max(0, leave.unpaidDays ?? 0);
    if (leave.leaveType === 'UNPAID' && unpaid === 0) unpaid = days.length;
    unpaid = Math.min(unpaid, days.length);
    const unpaidKeys = unpaid > 0 ? days.slice(days.length - unpaid) : [];
    for (const k of unpaidKeys) count(k, 1);
    unpaidDays = unpaidKeys.filter((k) => k.startsWith(prefix)).length;
  }

  const recorded = leave.totalDeduction;
  if (recorded === null || recorded === undefined) {
    // Legacy leave: compute from the deductible days.
    const amount = roundMoney(
      unpaidDays * rate + sickReducedDays * rate * SICK_REDUCED_DEDUCTION_RATIO + sickUnpaidDays * rate,
    );
    return { unpaidDays, sickReducedDays, sickUnpaidDays, adminCharge: 0, amount };
  }

  const total = roundMoney(Math.max(0, recorded));
  if (total <= 0) return { unpaidDays, sickReducedDays, sickUnpaidDays, adminCharge: 0, amount: 0 };
  if (weightTotal <= 0) {
    const startKey = dateKey(leave.startDate) ?? '';
    const adminCharge = startKey.startsWith(prefix) ? total : 0;
    return { unpaidDays, sickReducedDays, sickUnpaidDays, adminCharge, amount: adminCharge };
  }
  // Cumulative rounding so the monthly shares add up exactly to the recorded total.
  const upTo = (w: number) => roundMoney((total * w) / weightTotal);
  const amount = roundMoney(upTo(weightBefore + weightInMonth) - upTo(weightBefore));
  return { unpaidDays, sickReducedDays, sickUnpaidDays, adminCharge: 0, amount };
}

// ---------------------------------------------------------------------------
// GOSI
// ---------------------------------------------------------------------------

export function gosiEmployeeAmount(
  opts: {
    nationality: string | null | undefined;
    gosiDeduction: number | null | undefined;
    basicSalary: number | null | undefined;
    housing: number;
    /** Proration factor for partial months (1 = full month). */
    factor: number;
  },
  settings: PayrollSettings = DEFAULT_PAYROLL_SETTINGS,
): number {
  const factor = Math.max(0, Math.min(1, opts.factor));
  if (opts.gosiDeduction && opts.gosiDeduction > 0) return roundMoney(opts.gosiDeduction * factor);
  const pct = isSaudiNational(opts.nationality) ? settings.gosiEmployeePercentage : settings.gosiEmployeePercentageNonSaudi;
  if (!pct) return 0;
  const base = Math.min(GOSI_MAX_CONTRIBUTORY_WAGE, (opts.basicSalary ?? 0) + opts.housing) * factor;
  return roundMoney((base * pct) / 100);
}

// ---------------------------------------------------------------------------
// One payroll line
// ---------------------------------------------------------------------------

export interface PayrollLineInput {
  year: number;
  month: number;
  employee: {
    basicSalary: number | null;
    nationality: string | null;
    gosiDeduction: number | null;
    joinDate: Date | null;
    /** Recurring allowances (isMonthly=true). Others are ignored here. */
    allowances: ReadonlyArray<AllowanceLike>;
    /** Employee.gosiRegime (used with gosiRates). */
    gosiRegime?: GosiRegimeValue | string | null;
  };
  /**
   * Dated GOSI rate table (loaded once per generation). When provided, GOSI uses calculateGosi
   * (employee + employer shares, review flags); when omitted, the legacy settings-based employee
   * share (gosiEmployeeAmount) is used and the employer share is 0.
   */
  gosiRates?: ReadonlyArray<GosiRateLike>;
  /** Last day the employee is paid for by payroll (termination date), if any. */
  employmentEnd?: Date | null;
  /** Periods already paid by a settlement. */
  excluded?: ReadonlyArray<DateRange>;
  bonuses: ReadonlyArray<{ id: string; amount: number }>;
  overtimes: ReadonlyArray<OvertimeLike>;
  deductions: ReadonlyArray<{ id: string; amount: number }>;
  /** All approved leaves of the employee (needed for the sick-leave year look-back). */
  leaves: ReadonlyArray<LeaveLike>;
  /** Deductible loans; `remaining` must already exclude installments reserved by other drafts. */
  loans: ReadonlyArray<{ id: string; monthlyInstallment: number; remaining: number }>;
  settings: PayrollSettings;
  /**
   * How the salary is paid (payment-readiness flags only, never changes a number). Omitted =
   * not checked. `iban` must be the DECRYPTED value (null / '' = none on file).
   */
  payment?: { method: string | null | undefined; iban: string | null | undefined };
}

export interface PayrollLineResult {
  basicSalary: number;
  totalAllowances: number;
  overtimeCost: number;
  totalDeductions: number;
  netSalary: number;
  eligibleDays: number;
  daysInMonth: number;
  factor: number;
  breakdown: {
    recurringAllowances: number;
    bonuses: number;
    penalties: number;
    leaveDeductions: number;
    /** Employee GOSI share (deducted). */
    gosi: number;
    /** Employer GOSI share (company cost, NOT deducted). */
    gosiEmployer: number;
    loanInstallments: number;
    /** Other employee-side deductions (none computed today; kept so the columns add up). */
    other: number;
  };
  /** Line flagged for HR review (never blocks the run). */
  needsReview: boolean;
  /** Arabic notes joined with ' | ' (null when none). */
  reviewNote: string | null;
  /** GOSI computed from a provisional rate row. */
  gosiProvisional: boolean;
  loanInstallments: Array<{ loanId: string; amount: number }>;
}

/** Stored Payroll breakdown columns (DEC-002 / DEC-003). */
export interface PayrollBreakdownColumns {
  gosiEmployee: number;
  gosiEmployer: number;
  loansDeduction: number;
  violationsDeduction: number;
  leaveDeduction: number;
  otherDeductions: number;
  bonusAmount: number;
  needsReview: boolean;
  reviewNote: string | null;
}

/** Maps a computed line to the stored Payroll breakdown columns. */
export function payrollBreakdownColumns(line: PayrollLineResult): PayrollBreakdownColumns {
  return {
    gosiEmployee: line.breakdown.gosi,
    gosiEmployer: line.breakdown.gosiEmployer,
    loansDeduction: line.breakdown.loanInstallments,
    violationsDeduction: line.breakdown.penalties,
    leaveDeduction: line.breakdown.leaveDeductions,
    otherDeductions: line.breakdown.other,
    bonusAmount: line.breakdown.bonuses,
    needsReview: line.needsReview,
    reviewNote: line.reviewNote,
  };
}

/** Employee-side deductions of a stored row: GOSI employee + loans + violations + leave + other (employer GOSI excluded). */
export function employeeDeductionsTotal(row: Pick<PayrollBreakdownColumns, 'gosiEmployee' | 'loansDeduction' | 'violationsDeduction' | 'leaveDeduction' | 'otherDeductions'>): number {
  return sumMoney([row.gosiEmployee, row.loansDeduction, row.violationsDeduction, row.leaveDeduction, row.otherDeductions]);
}

/** Note stored when the employee-side deductions reach or exceed what the month pays (net clamped to 0). */
export const DEDUCTIONS_EXCEED_NOTE = 'الخصومات تستغرق مستحقات الشهر كاملة أو تتجاوزها';

// ---------------------------------------------------------------------------
// Review codes (DOM-003 phase 1 / DEC-006(2)): flags only, NO number changes.
// Each coded note is stored in Payroll.reviewNote as "[CODE] Arabic text" so screens can filter
// by code; reviewNoteText() strips the codes for display.
// ---------------------------------------------------------------------------

export const PAYROLL_REVIEW_CODES = [
  'CAP_PENALTY',
  'CAP_LOAN',
  'CAP_HALF',
  'NET_ZERO',
  'DEDUCTIONS_EXCEED',
  'IBAN_MISSING',
  'IBAN_INVALID',
  'CASH',
  'BASIC_ZERO',
] as const;
export type PayrollReviewCode = (typeof PAYROLL_REVIEW_CODES)[number];
/** Filter keys: the coded flags plus GOSI notes (uncoded, from src/lib/gosi.ts) and anything else. */
export type PayrollReviewFilterKey = PayrollReviewCode | 'GOSI' | 'OTHER';

/** Short Arabic label of each review filter key (filters, approval confirmation). */
export const PAYROLL_REVIEW_LABELS: Record<PayrollReviewFilterKey, string> = {
  CAP_PENALTY: 'جزاءات الشهر تتجاوز أجر 5 أيام',
  CAP_LOAN: 'قسط السلفة يتجاوز 10% من الأجر',
  CAP_HALF: 'الحسومات تتجاوز نصف الأجر المستحق',
  NET_ZERO: 'صافي الراتب صفر',
  DEDUCTIONS_EXCEED: 'الخصومات تستغرق المستحقات',
  IBAN_MISSING: 'لا يوجد آيبان',
  IBAN_INVALID: 'آيبان غير صالح',
  CASH: 'صرف نقدي',
  BASIC_ZERO: 'الراتب الأساسي صفر',
  GOSI: 'ملاحظات التأمينات والجنسية',
  OTHER: 'أسباب أخرى',
};

/** Days of wage the monthly penalties may not exceed (Labor Law art. 70). */
export const PENALTY_CAP_DAYS = 5;
/** Share of the wage a loan installment may not exceed (art. 92/1). */
export const LOAN_CAP_RATIO = 0.1;
/** Share of the earned wage all deductions together may not exceed (art. 93). */
export const DEDUCTIONS_CAP_RATIO = 0.5;

const EPS = 0.001;
const fmt = (n: number) => roundMoney(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

export interface PayrollReviewFlagInput {
  /** Full-month basic salary (before proration). */
  basicFull: number;
  /** Daily wage (dailyRate: basic + recurring allowances / 30). */
  dailyRate: number;
  /** Wage earned this month (prorated basic + recurring allowances). */
  earnedWage: number;
  /** basic + allowances + bonuses + overtime of the month. */
  gross: number;
  leaveDeductions: number;
  penalties: number;
  gosi: number;
  other: number;
  /** Loan installments actually deducted this month. */
  loanTotal: number;
  totalDeductions: number;
  netSalary: number;
  payment?: PayrollLineInput['payment'];
}

/**
 * Payroll-readiness / statutory-cap review flags of one computed line. Pure and additive: it
 * reads the computed amounts and never changes them (the caps are NOT enforced, see DOM-003).
 */
export function payrollReviewFlags(i: PayrollReviewFlagInput): Array<{ code: PayrollReviewCode; note: string }> {
  const out: Array<{ code: PayrollReviewCode; note: string }> = [];
  const add = (code: PayrollReviewCode, text: string) => out.push({ code, note: `[${code}] ${text}` });

  if (i.basicFull <= 0) add('BASIC_ZERO', 'الراتب الأساسي صفر أو غير مسجل');

  const penaltyCap = roundMoney(i.dailyRate * PENALTY_CAP_DAYS);
  if (i.penalties > penaltyCap + EPS) {
    add('CAP_PENALTY', `جزاءات الشهر (${fmt(i.penalties)}) تتجاوز أجر ${PENALTY_CAP_DAYS} أيام (${fmt(penaltyCap)}) - المادة 70`);
  }

  const loanCap = roundMoney(Math.max(0, i.earnedWage) * LOAN_CAP_RATIO);
  if (i.loanTotal > loanCap + EPS) {
    add('CAP_LOAN', `قسط السلفة (${fmt(i.loanTotal)}) يتجاوز 10% من أجر الشهر (${fmt(loanCap)}) - المادة 92`);
  }

  // Absence / unpaid leave is not a deduction: the cap applies to what is due after it.
  const dueAfterAbsence = Math.max(0, roundMoney(i.gross - i.leaveDeductions));
  const capped = sumMoney([i.gosi, i.penalties, i.loanTotal, i.other]);
  const halfCap = roundMoney(dueAfterAbsence * DEDUCTIONS_CAP_RATIO);
  if (capped > halfCap + EPS) {
    add('CAP_HALF', `الحسومات (${fmt(capped)}) تتجاوز نصف الأجر المستحق بعد الغياب (${fmt(halfCap)}) - المادة 93`);
  }

  if (i.netSalary <= 0) add('NET_ZERO', 'صافي الراتب صفر');

  if (i.payment) {
    if (i.payment.method === 'CASH') {
      add('CASH', 'طريقة الصرف نقدية: الراتب خارج ملف التحويل البنكي');
    } else {
      const iban = (i.payment.iban ?? '').trim();
      if (!iban) add('IBAN_MISSING', 'لا يوجد آيبان مسجل للتحويل البنكي');
      else if (!validateSaudiIban(iban).valid) add('IBAN_INVALID', 'الآيبان المسجل غير صالح');
    }
  }
  return out;
}

const CODE_RE = /\[([A-Z_]+)\]/g;
const GOSI_REVIEW_TEXTS = [GOSI_NOTES.UNKNOWN_REGIME, GOSI_NOTES.NO_RATE, GOSI_NOTES.NO_NATIONALITY];

/** Codes present in a stored reviewNote ('GOSI' for the uncoded GOSI / nationality notes). */
export function reviewNoteCodes(note: string | null | undefined): Array<PayrollReviewCode | 'GOSI'> {
  if (!note) return [];
  const known = new Set<string>(PAYROLL_REVIEW_CODES);
  const out = new Set<PayrollReviewCode | 'GOSI'>();
  for (const m of note.matchAll(CODE_RE)) if (known.has(m[1])) out.add(m[1] as PayrollReviewCode);
  // Rows generated before the codes existed: recognize the old uncoded note.
  if (note.includes('الخصومات تتجاوز مستحقات الشهر') || note.includes(DEDUCTIONS_EXCEED_NOTE)) out.add('DEDUCTIONS_EXCEED');
  if (GOSI_REVIEW_TEXTS.some((t) => note.includes(t))) out.add('GOSI');
  return [...out];
}

/** Review filter keys of a stored row ('OTHER' when flagged for a reason with no known code). */
export function payrollReviewKeys(row: { needsReview?: boolean | null; reviewNote?: string | null }): PayrollReviewFilterKey[] {
  const codes: PayrollReviewFilterKey[] = reviewNoteCodes(row.reviewNote);
  if (row.needsReview && codes.length === 0) codes.push('OTHER');
  return codes;
}

/** Count of flagged rows per review key (a row with several codes counts once per code). */
export function countPayrollReviewKeys(
  rows: ReadonlyArray<{ needsReview?: boolean | null; reviewNote?: string | null }>,
): Partial<Record<PayrollReviewFilterKey, number>> {
  const counts: Partial<Record<PayrollReviewFilterKey, number>> = {};
  for (const r of rows) {
    if (!r.needsReview) continue;
    for (const k of payrollReviewKeys(r)) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** reviewNote for display: the "[CODE] " markers removed. */
export function reviewNoteText(note: string | null | undefined): string {
  return (note ?? '').replace(/\[[A-Z_]+\]\s*/g, '').trim();
}

/**
 * Computes one employee's payroll for a month. Loan installments are only taken from what is
 * left after the other deductions, so an installment is never recorded as collected when the
 * salary could not cover it (the rest stays on the loan for next month).
 */
export function computePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const { employee: emp, settings, year, month } = input;
  const days = employmentDaysInMonth({
    year,
    month,
    joinDate: emp.joinDate,
    employmentEnd: input.employmentEnd ?? null,
    excluded: input.excluded,
  });
  const factor = days.factor;
  const basicFull = emp.basicSalary ?? 0;
  const recurringFull = monthlyAllowancesTotal(emp.allowances);
  const basicSalary = roundMoney(basicFull * factor);
  const recurringAllowances = roundMoney(recurringFull * factor);
  const bonuses = sumMoney(input.bonuses.map((b) => b.amount));
  const totalAllowances = roundMoney(recurringAllowances + bonuses);

  const overtimeCost = sumMoney(input.overtimes.map((ot) => overtimeAmount(ot, emp, settings)));

  const rate = dailyRate({ basicSalary: basicFull, allowances: emp.allowances });
  const leaveDeductions = sumMoney(
    input.leaves.map((lv) => leaveDeductionForMonth(lv, input.leaves, rate, year, month).amount),
  );
  const penalties = sumMoney(input.deductions.map((d) => d.amount));
  const notes: string[] = [];
  let needsReview = false;
  let gosi: number;
  let gosiEmployer = 0;
  let gosiProvisional = false;
  if (input.gosiRates) {
    const isSaudi = isSaudiForGosi(emp.nationality);
    if (!(emp.nationality ?? '').trim()) {
      needsReview = true;
      notes.push(GOSI_NOTES.NO_NATIONALITY);
    }
    const g = calculateGosi({
      isSaudi,
      regime: emp.gosiRegime ?? 'UNKNOWN',
      contributoryWage: gosiBaseWage(basicFull, emp.allowances),
      month,
      year,
      rates: input.gosiRates,
      factor,
      employeeOverride: emp.gosiDeduction,
    });
    gosi = g.employee;
    gosiEmployer = g.employer;
    gosiProvisional = g.provisional;
    if (g.needsReview) needsReview = true;
    notes.push(...g.notes);
  } else {
    gosi = gosiEmployeeAmount(
      {
        nationality: emp.nationality,
        gosiDeduction: emp.gosiDeduction,
        basicSalary: basicFull,
        housing: housingAllowance(emp.allowances),
        factor,
      },
      settings,
    );
  }
  const other = 0;

  const gross = roundMoney(basicSalary + totalAllowances + overtimeCost);
  const otherDeductions = sumMoney([leaveDeductions, penalties, gosi, other]);
  let available = Math.max(0, roundMoney(gross - otherDeductions));

  const loanInstallments: Array<{ loanId: string; amount: number }> = [];
  for (const loan of input.loans) {
    const due = roundMoney(Math.min(Math.max(0, loan.monthlyInstallment), Math.max(0, loan.remaining)));
    const amount = roundMoney(Math.min(due, available));
    if (amount <= 0) continue;
    loanInstallments.push({ loanId: loan.id, amount });
    available = roundMoney(available - amount);
  }
  const loanTotal = sumMoney(loanInstallments.map((l) => l.amount));
  const totalDeductions = sumMoney([otherDeductions, loanTotal]);
  const netSalary = Math.max(0, roundMoney(gross - totalDeductions));
  // ">=": deductions that consume the whole month (net exactly 0) are flagged too.
  if (input.gosiRates && totalDeductions > 0 && totalDeductions >= gross - EPS) {
    needsReview = true;
    notes.push(`[DEDUCTIONS_EXCEED] ${DEDUCTIONS_EXCEED_NOTE}`);
  }
  // Review flags only: every amount above is final and unchanged by these checks.
  const flags = payrollReviewFlags({
    basicFull,
    dailyRate: rate,
    earnedWage: roundMoney(basicSalary + recurringAllowances),
    gross,
    leaveDeductions,
    penalties,
    gosi,
    other,
    loanTotal,
    totalDeductions,
    netSalary,
    payment: input.payment,
  });
  if (flags.length) {
    needsReview = true;
    notes.push(...flags.map((f) => f.note));
  }

  return {
    basicSalary,
    totalAllowances,
    overtimeCost,
    totalDeductions,
    netSalary,
    eligibleDays: days.eligibleDays,
    daysInMonth: days.daysInMonth,
    factor,
    breakdown: {
      recurringAllowances,
      bonuses,
      penalties,
      leaveDeductions,
      gosi,
      gosiEmployer,
      loanInstallments: loanTotal,
      other,
    },
    needsReview,
    reviewNote: joinReviewNotes(notes),
    gosiProvisional,
    loanInstallments,
  };
}

// ---------------------------------------------------------------------------
// Settlement coverage (what a settlement already paid, so payroll does not pay it again)
// ---------------------------------------------------------------------------

export interface SettlementCoverageLike {
  type: string;
  status: string;
  lastWorkingDate: Date | null;
  createdAt: Date;
  salaryBasis: string | null;
  leaveCompensation: number | null;
}

/**
 * - END_OF_SERVICE (not rejected): payroll stops the month of the last working day
 *   (the settlement pays that month's working days) -> returns `endsEmployment`.
 * - LEAVE_SETTLEMENT (not rejected): the settlement paid the working days of the month up to
 *   lastWorkingDate plus the compensated leave days after it -> excluded date ranges.
 */
export function settlementCoverage(
  settlements: ReadonlyArray<SettlementCoverageLike>,
  emp: SalaryLike,
): { finalDay: Date | null; excluded: DateRange[] } {
  let finalDay: Date | null = null;
  const excluded: DateRange[] = [];
  for (const s of settlements) {
    if (s.status === SETTLEMENT_STATUS.REJECTED) continue;
    const last = s.lastWorkingDate ?? today(s.createdAt);
    const lastKey = dateKey(last);
    if (!lastKey) continue;
    const lastDay = new Date(`${lastKey}T00:00:00.000Z`);
    if (s.type === 'END_OF_SERVICE') {
      if (!finalDay || lastDay < finalDay) finalDay = lastDay;
      continue;
    }
    if (s.type === 'LEAVE_SETTLEMENT') {
      const monthStart = new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), 1));
      excluded.push({ start: monthStart, end: lastDay });
      const basis: SalaryBasis = s.salaryBasis === 'basic' ? 'basic' : 'total';
      const rate = dailyRate(emp, basis);
      const paidLeaveDays = rate > 0 && (s.leaveCompensation ?? 0) > 0 ? Math.round((s.leaveCompensation ?? 0) / rate) : 0;
      if (paidLeaveDays > 0) excluded.push({ start: addDays(lastDay, 1), end: addDays(lastDay, paidLeaveDays) });
    }
  }
  return { finalDay, excluded };
}

/**
 * Whether settlements change the payroll of `year/month` (the same rule generatePayrollMonth
 * applies): an END_OF_SERVICE whose last working day falls in or before the month (the
 * employee gets no payroll), or a LEAVE_SETTLEMENT whose settled days intersect the month.
 * Used to refuse approving a draft generated before such a settlement existed.
 */
export function settlementCoversMonth(
  settlements: ReadonlyArray<SettlementCoverageLike>,
  emp: SalaryLike,
  year: number,
  month: number,
): boolean {
  if (!settlements.length) return false;
  const { start, end } = monthRange(year, month);
  const coverage = settlementCoverage(settlements, emp);
  if (coverage.finalDay && coverage.finalDay <= end) return true;
  return coverage.excluded.some((r) => r.start <= end && r.end >= start);
}

// ---------------------------------------------------------------------------
// Overtime payment tracking
//
// OvertimeRequest.paidInPayrollId / paidInSettlementId record who pays an APPROVED overtime:
// - generatePayrollMonth reserves the overtime it includes (paidInPayrollId = the DRAFT row);
//   regenerating / dropping the draft releases it (releaseDraftPayrolls); approving the draft
//   makes the link final (the payroll row becomes APPROVED/PAID),
// - an END_OF_SERVICE settlement reserves the overtime it pays at creation
//   (paidInSettlementId), releases it when rejected and re-checks it at owner approval.
// Unpaid overtime = APPROVED with both links null.
//
// Legacy rows (approved before the columns existed, never linked) keep the former timestamp
// inference (overtimePayState): a payroll paid the approved overtime that existed when it was
// generated (Payroll.createdAt). `legacyCutoff` is when the columns were added (null = unknown:
// every unlinked row is treated as legacy, the conservative choice).
// ---------------------------------------------------------------------------

export interface FinalizedPayrollRef {
  year: number;
  month: number;
  /** Generation time of the payroll row (a draft is re-created on every regeneration). */
  createdAt: Date;
}

export interface OvertimeTimingLike {
  date: Date;
  /** Approval time for legacy rows (they were only updated when they left PENDING). */
  updatedAt: Date;
}

export interface OvertimeLinkLike extends OvertimeTimingLike {
  paidInPayrollId?: string | null;
  paidInSettlementId?: string | null;
}

/** Payroll row an overtime is linked to (OvertimeRequest.paidInPayrollId). */
export interface OvertimeHolderRef {
  year: number;
  month: number;
  status: string;
}

export type OvertimeHolders = ReadonlyMap<string, OvertimeHolderRef>;

const DRAFT_STATUS = 'DRAFT';

/** Month index (year * 12 + month - 1) of a date-only value, or null when invalid. */
function monthIndexOfDate(d: Date): number | null {
  const key = dateKey(d);
  if (!key) return null;
  return monthIndex(Number(key.slice(0, 4)), Number(key.slice(5, 7)));
}

/** Unlinked row approved before the link columns existed (see the section comment). */
export function isLegacyOvertime(ot: OvertimeLinkLike, legacyCutoff: Date | null): boolean {
  if (ot.paidInPayrollId || ot.paidInSettlementId) return false;
  if (legacyCutoff === null) return true;
  return ot.updatedAt.getTime() < legacyCutoff.getTime();
}

/**
 * LEGACY timestamp inference (rows never linked):
 * - PAID: a finalized payroll generated after the approval already contains it (its own month,
 *   or a later month that carried it over).
 * - DUE_OWN_MONTH: its month has no finalized payroll yet (and no later month was finalized).
 * - CARRY_OVER: approved after its month's payroll was generated (the month is finalized) and no
 *   later finalized payroll was generated since: the next generated month pays it.
 * - LEGACY_UNPROCESSED: its month was never processed for the employee although later months
 *   were (historic data): never paid automatically.
 */
export type OvertimePayState = 'PAID' | 'DUE_OWN_MONTH' | 'CARRY_OVER' | 'LEGACY_UNPROCESSED';

export function overtimePayState(ot: OvertimeTimingLike, finalized: ReadonlyArray<FinalizedPayrollRef>): OvertimePayState {
  const otIdx = monthIndexOfDate(ot.date);
  if (otIdx === null) return 'LEGACY_UNPROCESSED';
  const approvedAt = ot.updatedAt.getTime();
  let own: FinalizedPayrollRef | null = null;
  let later = false;
  let laterAfterApproval = false;
  for (const p of finalized) {
    const idx = monthIndex(p.year, p.month);
    if (idx === otIdx) own = p;
    else if (idx > otIdx) {
      later = true;
      if (p.createdAt.getTime() > approvedAt) laterAfterApproval = true;
    }
  }
  if (!own) return later ? 'LEGACY_UNPROCESSED' : 'DUE_OWN_MONTH';
  if (own.createdAt.getTime() > approvedAt) return 'PAID';
  return laterAfterApproval ? 'PAID' : 'CARRY_OVER';
}

/** LEGACY: whether the payroll of year/month pays an unlinked legacy overtime. */
export function legacyOvertimeDueInMonth(
  ot: OvertimeTimingLike,
  finalized: ReadonlyArray<FinalizedPayrollRef>,
  year: number,
  month: number,
): boolean {
  const otIdx = monthIndexOfDate(ot.date);
  if (otIdx === null) return false;
  const thisIdx = monthIndex(year, month);
  if (otIdx > thisIdx) return false;
  const others = finalized.filter((p) => monthIndex(p.year, p.month) !== thisIdx);
  const state = overtimePayState(ot, others);
  if (otIdx === thisIdx) return state !== 'PAID';
  return state === 'CARRY_OVER';
}

export interface OvertimeDueOptions {
  /** When the link columns were added (null = unknown: unlinked rows are legacy). */
  legacyCutoff: Date | null;
  /** DRAFT payroll ids being replaced by this generation (their reservations are released). */
  replacing?: ReadonlySet<string>;
}

/**
 * Whether the payroll of `year/month` being generated pays an APPROVED overtime: every overtime
 * dated up to that month that no settlement reserved and no other payroll row holds (drafts
 * being replaced do not count). Legacy unlinked rows use the timestamp inference
 * (legacyOvertimeDueInMonth). `finalized` = the employee's APPROVED/PAID payrolls (legacy only).
 */
export function overtimeDueInMonth(
  ot: OvertimeLinkLike,
  finalized: ReadonlyArray<FinalizedPayrollRef>,
  year: number,
  month: number,
  opts: OvertimeDueOptions,
): boolean {
  if (ot.paidInSettlementId) return false;
  const otIdx = monthIndexOfDate(ot.date);
  if (otIdx === null || otIdx > monthIndex(year, month)) return false;
  if (ot.paidInPayrollId) return !!opts.replacing?.has(ot.paidInPayrollId);
  if (isLegacyOvertime(ot, opts.legacyCutoff)) return legacyOvertimeDueInMonth(ot, finalized, year, month);
  return true;
}

/**
 * Approved overtime nobody paid: both links null (legacy unlinked rows: not paid according to
 * the timestamp inference). Overtime held by a DRAFT payroll is reserved, not unpaid.
 */
export function isOvertimeUnpaid(
  ot: OvertimeLinkLike,
  finalized: ReadonlyArray<FinalizedPayrollRef>,
  legacyCutoff: Date | null,
): boolean {
  if (ot.paidInPayrollId || ot.paidInSettlementId) return false;
  if (!isLegacyOvertime(ot, legacyCutoff)) return true;
  const state = overtimePayState(ot, finalized);
  return state === 'DUE_OWN_MONTH' || state === 'CARRY_OVER';
}

export interface OvertimeSettlementOptions {
  legacyCutoff: Date | null;
  /** Payroll rows referenced by paidInPayrollId (id -> year / month / status). */
  holders?: OvertimeHolders;
  /** Overtime already reserved by THIS settlement counts as due (approval re-check). */
  settlementId?: string;
}

/**
 * Whether an END_OF_SERVICE settlement whose last working day is `lastWorkingDate` must pay an
 * APPROVED overtime. Payroll pays every month BEFORE the last working month (settlementCoverage
 * stops it from that month on), so the settlement pays overtime that no other settlement
 * reserved and that is either
 * - held by a DRAFT payroll of the last month or later (those drafts are dropped when the
 *   settlement is approved), or
 * - unlinked and dated in the last month or later, or dated earlier with every month from its
 *   own month up to the one before the last month already finalized (no payroll run is left
 *   to pay it). With an open month in between, payroll pays it.
 * Overtime held by a DRAFT of an earlier month is paid by that payroll; overtime held by a
 * finalized (or unknown) payroll row is paid. Legacy unlinked rows use the timestamp
 * inference (legacyOvertimeDueInSettlement).
 */
export function overtimeDueInSettlement(
  ot: OvertimeLinkLike,
  finalized: ReadonlyArray<FinalizedPayrollRef>,
  lastWorkingDate: Date,
  opts: OvertimeSettlementOptions,
): boolean {
  const otIdx = monthIndexOfDate(ot.date);
  const lastIdx = monthIndexOfDate(lastWorkingDate);
  if (otIdx === null || lastIdx === null) return false;
  if (ot.paidInSettlementId && ot.paidInSettlementId !== opts.settlementId) return false;
  if (ot.paidInPayrollId) {
    const holder = opts.holders?.get(ot.paidInPayrollId);
    if (!holder || holder.status !== DRAFT_STATUS) return false;
    return monthIndex(holder.year, holder.month) >= lastIdx;
  }
  if (!ot.paidInSettlementId && isLegacyOvertime(ot, opts.legacyCutoff)) {
    return legacyOvertimeDueInSettlement(ot, finalized, lastWorkingDate);
  }
  if (otIdx >= lastIdx) return true;
  const finalizedIdx = new Set(finalized.map((p) => monthIndex(p.year, p.month)));
  for (let i = otIdx; i < lastIdx; i++) if (!finalizedIdx.has(i)) return false;
  return true;
}

/** LEGACY: settlement rule of the timestamp inference (unlinked rows approved before the columns). */
export function legacyOvertimeDueInSettlement(
  ot: OvertimeTimingLike,
  finalized: ReadonlyArray<FinalizedPayrollRef>,
  lastWorkingDate: Date,
): boolean {
  const otIdx = monthIndexOfDate(ot.date);
  const lastIdx = monthIndexOfDate(lastWorkingDate);
  if (otIdx === null || lastIdx === null) return false;
  const state = overtimePayState(ot, finalized);
  if (state === 'DUE_OWN_MONTH') return otIdx >= lastIdx;
  if (state !== 'CARRY_OVER') return false;
  const finalizedIdx = new Set(finalized.map((p) => monthIndex(p.year, p.month)));
  for (let i = otIdx + 1; i < lastIdx; i++) if (!finalizedIdx.has(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reporting (dashboard / owner report / payroll hub): which month is "the" payroll month,
// what is actual (stored lines) and what is an estimate. Pure; no number of any payroll line
// is computed here.
// ---------------------------------------------------------------------------

export interface YearMonth {
  year: number;
  month: number;
}

/** The current payroll month in the Riyadh calendar. */
export function currentPayrollMonth(now: Date = new Date()): YearMonth {
  const [y, m] = todayKey(now).split('-').map(Number);
  return { year: y, month: m };
}

/** True when (year, month) is not after `ref` (a reference month may not be in the future). */
export function isMonthNotAfter(ym: YearMonth, ref: YearMonth): boolean {
  return monthIndex(ym.year, ym.month) <= monthIndex(ref.year, ref.month);
}

const MONTH_LABEL_LOCALE = 'ar-SA-u-ca-gregory-nu-latn';

/** Arabic month label, e.g. "مارس 2026" (Gregorian, Latin digits). */
export function payrollMonthLabel(year: number, month: number): string {
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(MONTH_LABEL_LOCALE, { timeZone: 'UTC', month: 'long' });
  return `${name} ${year}`;
}

/**
 * Default month of the payroll hub summary: the current month when it has lines, otherwise the
 * closest EARLIER month with lines. A month stored in the future (a draft for next month, or a
 * mistyped year) never becomes the default. null = no month on or before the current one.
 */
export function defaultPayrollMonth(monthsWithLines: ReadonlyArray<YearMonth>, current: YearMonth): YearMonth | null {
  let best: YearMonth | null = null;
  for (const m of monthsWithLines) {
    if (!isMonthNotAfter(m, current)) continue;
    if (!best || monthIndex(m.year, m.month) > monthIndex(best.year, best.month)) best = { year: m.year, month: m.month };
  }
  return best;
}

/** Calendar months touched by [from, to] ('YYYY-MM-DD' or stored dates), oldest first (max 120). */
export function monthsInRange(from: Date | string, to: Date | string): YearMonth[] {
  const a = dateKey(typeof from === 'string' && from.length === 10 ? `${from}T00:00:00Z` : from);
  const b = dateKey(typeof to === 'string' && to.length === 10 ? `${to}T00:00:00Z` : to);
  if (!a || !b || b < a) return [];
  const start = monthIndex(Number(a.slice(0, 4)), Number(a.slice(5, 7)));
  const end = Math.min(monthIndex(Number(b.slice(0, 4)), Number(b.slice(5, 7))), start + 119);
  const out: YearMonth[] = [];
  for (let i = start; i <= end; i++) out.push({ year: Math.floor(i / 12), month: (i % 12) + 1 });
  return out;
}

/**
 * How a month of the owner report is costed:
 * - ACTUAL:   it has APPROVED / PAID payroll lines on or before the current month (stored numbers).
 * - MISSING:  an elapsed month with no approved payroll (nothing is estimated for the past).
 * - ESTIMATE: the current month without an approved payroll, and every future month.
 */
export type ReportMonthKind = 'ACTUAL' | 'MISSING' | 'ESTIMATE';

export function reportMonthKind(ym: YearMonth, current: YearMonth, hasApprovedLines: boolean): ReportMonthKind {
  const idx = monthIndex(ym.year, ym.month);
  const cur = monthIndex(current.year, current.month);
  if (idx <= cur && hasApprovedLines) return 'ACTUAL';
  if (idx < cur) return 'MISSING';
  return 'ESTIMATE';
}

export interface EstimateEmployeeLike {
  basicSalary?: number | null;
  joinDate?: Date | string | null;
  allowances?: ReadonlyArray<{ amount?: number | null; isMonthly?: boolean | null }> | null;
}

/**
 * ESTIMATED wage cost of one future month from today's data: basic + recurring allowances of the
 * current employees, prorated by calendar days for a joiner's first month; employees who have not
 * started by the end of the month are excluded. No GOSI, overtime or bonuses (unknown ahead).
 */
export function estimateMonthWage(employees: ReadonlyArray<EstimateEmployeeLike>, year: number, month: number): { amount: number; employees: number } {
  const parts: number[] = [];
  for (const e of employees) {
    const join = e.joinDate ? new Date(e.joinDate) : null;
    const { factor } = employmentDaysInMonth({ year, month, joinDate: join && !Number.isNaN(join.getTime()) ? join : null });
    if (factor <= 0) continue;
    const recurring = sumMoney((e.allowances ?? []).filter((a) => a.isMonthly).map((a) => a.amount ?? 0));
    parts.push(roundMoney(((e.basicSalary ?? 0) + recurring) * factor));
  }
  return { amount: sumMoney(parts), employees: parts.length };
}
