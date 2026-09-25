// End-of-service / leave settlement calculator (PURE, no database access, client-safe).
//
// Used by POST /api/settlements (authoritative amounts, also served as a preview with
// { preview: true }) and imported directly by src/app/settlements/new/page.tsx for the instant
// estimate, so both run the very same formulas:
// - The wage uses RECURRING allowances only (one-off bonuses are not part of the wage).
// - Taken leave counts ANNUAL / DEDUCTED / EMERGENCY leaves in status APPROVED or COMPLETED.
// - The leave balance uses the single formula of src/lib/leave.ts (computeLeaveBalance: 21/30
//   days per 365 days, paid days only, SystemSetting annual_leave_days) so the settlement
//   matches the balance shown elsewhere.
// - Years of service count the last working day inclusively without over-counting month ends.
// - Overtime is computed with the payroll rules (src/lib/payroll-core.ts); only END_OF_SERVICE
//   settlements pay overtime, and only what payroll will not pay (overtimeDueInSettlement, based
//   on OvertimeRequest.paidInPayrollId / paidInSettlementId). The amounts are stored in
//   Settlement.overtimeAmount / Settlement.loansDeduction and re-checked at owner approval.
// - Loans: outstandingLoansForSettlement (remaining minus installments held by surviving drafts).
// - Dates are date-only values (UTC midnight), see src/lib/dates.ts.
import { roundMoney, sumMoney } from '@/lib/money';
import { dateKey } from '@/lib/dates';
import { DEFAULT_EXIT_REENTRY_VISA_FEE } from '@/lib/constants';
import {
  dailyRate,
  isSaudiNational,
  monthIndex,
  monthlyWage,
  type SalaryBasis,
  type SalaryLike,
} from '@/lib/payroll-core';
import { computeLeaveBalance, type LeaveBalanceLeave } from '@/lib/leave';

export const SETTLEMENT_TYPES = ['LEAVE_SETTLEMENT', 'END_OF_SERVICE'] as const;
export type SettlementTypeValue = (typeof SETTLEMENT_TYPES)[number];

export const TERMINATION_REASONS = [
  'COMPANY_TERMINATION',
  'RESIGNATION',
  'PROBATION',
  'ARTICLE_80',
  'ARTICLE_81',
  'ARTICLE_87',
  'CONTRACT_EXPIRY',
] as const;
export type TerminationReasonValue = (typeof TERMINATION_REASONS)[number];

/**
 * Reasons added by DEC-003 that pay the FULL end-of-service award (same as a termination by the
 * employer): article 81 (the worker leaves because of the employer's breach), article 87 (force
 * majeure, and the female worker's cases it lists) and the expiry of a fixed-term contract. This
 * reading is PROVISIONAL, pending the legal counsel's confirmation, and is shown as such.
 */
export const FULL_AWARD_PENDING_COUNSEL_REASONS: ReadonlyArray<TerminationReasonValue> = ['ARTICLE_81', 'ARTICLE_87', 'CONTRACT_EXPIRY'];

/** Visible note on the reasons whose rule awaits the counsel's confirmation. */
export const COUNSEL_PENDING_NOTE = 'بانتظار تأكيد المستشار';

export const TERMINATION_REASON_LABELS: Record<TerminationReasonValue, string> = {
  COMPANY_TERMINATION: 'إنهاء من قبل الشركة',
  RESIGNATION: 'استقالة',
  PROBATION: 'إنهاء خلال فترة التجربة',
  ARTICLE_80: 'فصل بموجب المادة 80',
  ARTICLE_81: 'ترك العمل لإخلال صاحب العمل (المادة 81)',
  ARTICLE_87: 'حالات المادة 87 (قوة قاهرة / حالات العاملة)',
  CONTRACT_EXPIRY: 'انتهاء العقد محدد المدة',
};

export function isCounselPendingReason(reason: string | null | undefined): boolean {
  return (FULL_AWARD_PENDING_COUNSEL_REASONS as ReadonlyArray<string>).includes(reason ?? '');
}

/** Default daily cost charged for leave days taken beyond the balance (sponsorship cost). */
export const DEFAULT_EXCESS_DAY_COST = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function utcParts(d: Date): { y: number; m: number; d: number } {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

/** `d` plus `months` calendar months (UTC), clamped to the last day of the target month. */
function addMonthsClamped(d: { y: number; m: number; d: number }, months: number): number {
  const total = d.m + months;
  const y = d.y + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.d, lastDay));
}

/**
 * Years of service per MLSD calculator: full years + months/12 + days/360, counting the last
 * working day inclusively (i.e. up to the day after it). Joining on 2020-01-01 with a last
 * working day of 2022-12-31 is exactly 3 years.
 */
export function yearsOfService(joinDate: Date | null | undefined, lastDate: Date): number {
  if (!joinDate) return 0;
  const s = utcParts(joinDate);
  const lastKey = dateKey(lastDate);
  if (!lastKey || Number.isNaN(joinDate.getTime())) return 0;
  const endMs = Date.parse(`${lastKey}T00:00:00.000Z`) + DAY_MS; // exclusive end (inclusive last day)
  const e = utcParts(new Date(endMs));
  let months = (e.y - s.y) * 12 + (e.m - s.m);
  while (months > 0 && addMonthsClamped(s, months) > endMs) months--;
  if (months < 0) return 0;
  const days = Math.max(0, Math.round((endMs - addMonthsClamped(s, months)) / DAY_MS));
  const years = Math.floor(months / 12) + (months % 12) / 12 + days / 360;
  return years > 0 ? years : 0;
}

/**
 * End-of-service award (Saudi Labor Law, articles 84/85):
 * half a month's wage per year for the first 5 years, a full month per year after that,
 * fractions prorated. Resignation: < 2y = 0, 2-5y = 1/3, 5-10y = 2/3, >= 10y = full.
 * Probation termination / Article 80 = 0.
 * Article 81 / Article 87 / contract expiry = the full award, like a termination by the employer
 * (FULL_AWARD_PENDING_COUNSEL_REASONS, provisional pending the counsel's confirmation).
 */
export function endOfServiceAward(
  monthlySalary: number,
  years: number,
  reason: TerminationReasonValue | null | undefined,
): number {
  if (!(years > 0) || !(monthlySalary > 0)) return 0;
  if (reason === 'PROBATION' || reason === 'ARTICLE_80') return 0;
  const raw = years <= 5 ? monthlySalary * 0.5 * years : monthlySalary * 0.5 * 5 + monthlySalary * (years - 5);
  if (reason && isCounselPendingReason(reason)) return roundMoney(raw);
  if (reason === 'RESIGNATION') {
    if (years < 2) return 0;
    if (years < 5) return roundMoney(raw / 3);
    if (years < 10) return roundMoney((raw * 2) / 3);
    return roundMoney(raw);
  }
  return roundMoney(raw);
}

export interface SettlementLeaveLike {
  leaveType: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date | null;
  totalDays: number | null;
  paidDays: number | null;
}

/**
 * Annual-leave balance on `asOf` (may be negative), using THE leave balance formula of
 * src/lib/leave.ts (computeLeaveBalance): 21 days/year during the first 5 years of service and
 * 30 days/year after (statutory minimum), from leaveAccrualStartDate (or joinDate), minus the
 * PAID days of approved/completed balance leaves recorded since. A leave that was entirely
 * unpaid (paidDays = 0) does not reduce the balance; legacy leaves without paidDays count
 * their totalDays. The leave being settled (same start or end date +/- 2 days) is not subtracted.
 * Unlike LeaveBalance.available this is not clamped at 0: a negative balance is charged as
 * excess leave by computeSettlement.
 */
export function accruedLeaveBalance(opts: {
  joinDate: Date | null | undefined;
  accrualStartDate?: Date | null;
  asOf: Date;
  leaves: ReadonlyArray<SettlementLeaveLike>;
  currentLeaveStart?: Date | null;
  currentLeaveEnd?: Date | null;
  /** SystemSetting `annual_leave_days` (company policy above the statutory minimum). */
  annualLeaveDaysSetting?: number | null;
}): number {
  if (!opts.joinDate || !dateKey(opts.joinDate) || !dateKey(opts.asOf)) return 0;
  const near = (a: Date | null | undefined, b: Date | null | undefined) =>
    !!a && !!b && Math.abs(a.getTime() - b.getTime()) < 2 * DAY_MS;

  const leaves: LeaveBalanceLeave[] = [];
  for (const l of opts.leaves) {
    const startDate = l.startDate ?? l.endDate;
    const endDate = l.endDate ?? l.startDate;
    if (!startDate || !endDate || !dateKey(startDate) || !dateKey(endDate)) continue;
    if (near(opts.currentLeaveStart, l.startDate) || near(opts.currentLeaveEnd, l.endDate)) continue;
    leaves.push({
      leaveType: l.leaveType,
      status: l.status,
      paidDays: l.paidDays ?? l.totalDays ?? 0,
      startDate,
      endDate,
      createdAt: l.createdAt,
    });
  }

  const balance = computeLeaveBalance({
    joinDate: opts.joinDate,
    leaveAccrualStartDate: opts.accrualStartDate ?? null,
    asOf: opts.asOf,
    leaves,
    annualLeaveDaysSetting: opts.annualLeaveDaysSetting ?? null,
  });
  return balance.accrued - balance.taken;
}

/** Exit/re-entry visa fee by leave length (borne by the company, not part of the total). */
export function exitReentryVisaFee(requestedDays: number, baseFee = DEFAULT_EXIT_REENTRY_VISA_FEE): number {
  if (requestedDays <= 60) return baseFee;
  if (requestedDays <= 90) return 300;
  return 300 + Math.ceil((requestedDays - 90) / 30) * 100;
}

export interface SettlementInput {
  type: SettlementTypeValue;
  terminationReason?: TerminationReasonValue | null;
  salaryBasis: SalaryBasis;
  employee: SalaryLike & {
    joinDate: Date | null;
    nationality: string | null;
    leaveAccrualStartDate?: Date | null;
  };
  /** Last working day (date-only). Defaults to `asOf`. */
  lastWorkingDate: Date | null;
  /** "Today" used when lastWorkingDate is missing. */
  asOf: Date;
  leaves: ReadonlyArray<SettlementLeaveLike>;
  /** LEAVE_SETTLEMENT: the leave being settled. */
  leaveStartDate?: Date | null;
  leaveEndDate?: Date | null;
  requestedLeaveDays?: number | null;
  /** True if the month of lastWorkingDate was already paid by an approved/paid payroll. */
  lastMonthAlreadyPaid?: boolean;
  excessDayCost?: number | null;
  waiveExcessCost?: boolean;
  flightTicketOption?: string | null;
  flightTicketAmount?: number | null;
  /** Loan balance to deduct (outstandingLoansForSettlement). */
  outstandingLoans: number;
  /** Server-computed unpaid overtime amount. */
  overtime: number;
  /** HR-entered extra entitlements / deductions. */
  manualEntitlements: number;
  manualDeductions: number;
  leaveOutsideKsa?: boolean;
  /** SystemSetting `annual_leave_days` (optional; the statutory 21/30 days apply otherwise). */
  annualLeaveDaysSetting?: number | null;
  /** SystemSetting `exit_reentry_visa_fee` (base fee for leaves up to 60 days). */
  visaBaseFee?: number | null;
}

export interface SettlementBreakdown {
  salaryUsed: number;
  dailySalary: number;
  workingDaysInMonth: number;
  workingDaysSalary: number;
  yearsOfService: number;
  endOfServiceAmount: number;
  accruedLeaveDays: number;
  unusedLeaveDays: number;
  leaveDaysToPay: number;
  requestedDays: number;
  excessDays: number;
  leaveCompensation: number;
  excessDeduction: number;
  loansDeduction: number;
  flightTicketAllowance: number;
  overtime: number;
  manualEntitlements: number;
  manualDeductions: number;
  visaFeeAmount: number;
  /** Stored in Settlement.additionalEntitlements (manual + flight ticket + overtime). */
  additionalEntitlements: number;
  /** Stored in Settlement.additionalDeductions (manual + excess leave + loans). */
  totalDeductions: number;
  totalSettlement: number;
}

export function computeSettlement(input: SettlementInput): SettlementBreakdown {
  const emp = input.employee;
  const salaryUsed = monthlyWage(emp, input.salaryBasis);
  const daily = dailyRate(emp, input.salaryBasis);
  const lastDate = input.lastWorkingDate ?? input.asOf;

  // Working days of the last month (calendar days 1..lastWorkingDate, incl. weekly rest days).
  const workingDaysInMonth = input.lastWorkingDate && !input.lastMonthAlreadyPaid ? input.lastWorkingDate.getUTCDate() : 0;
  const workingDaysSalary = roundMoney(daily * workingDaysInMonth);

  const years = yearsOfService(emp.joinDate, lastDate);
  const endOfServiceAmount =
    input.type === 'END_OF_SERVICE' ? endOfServiceAward(salaryUsed, years, input.terminationReason ?? null) : 0;

  const accrued = accruedLeaveBalance({
    joinDate: emp.joinDate,
    accrualStartDate: emp.leaveAccrualStartDate ?? null,
    asOf: lastDate,
    leaves: input.leaves,
    currentLeaveStart: input.leaveStartDate ?? null,
    currentLeaveEnd: input.leaveEndDate ?? null,
    annualLeaveDaysSetting: input.annualLeaveDaysSetting ?? null,
  });
  const accruedDays = Math.round(accrued * 100) / 100; // page shows/sends toFixed(2)
  const requestedDays = input.type === 'LEAVE_SETTLEMENT' ? Math.max(0, input.requestedLeaveDays ?? 0) : 0;
  const excessDayCost = input.waiveExcessCost ? 0 : Math.max(0, input.excessDayCost ?? DEFAULT_EXCESS_DAY_COST);

  let leaveDaysToPay = 0;
  let excessDays = 0;
  let excessDeduction = 0;
  if (input.type === 'END_OF_SERVICE') {
    if (accruedDays > 0) leaveDaysToPay = accruedDays;
    else if (accruedDays < 0 && !isSaudiNational(emp.nationality)) excessDeduction = Math.abs(accruedDays) * excessDayCost;
  } else if (requestedDays > 0) {
    if (accruedDays > 0) {
      leaveDaysToPay = Math.min(requestedDays, accruedDays);
      if (requestedDays > accruedDays) {
        excessDays = requestedDays - accruedDays;
        excessDeduction = excessDays * excessDayCost;
      }
    } else {
      excessDays = requestedDays;
      excessDeduction = excessDays * excessDayCost;
      if (accruedDays < 0) excessDeduction += Math.abs(accruedDays) * excessDayCost;
    }
  } else if (accruedDays > 0) {
    leaveDaysToPay = accruedDays;
  } else if (accruedDays < 0) {
    excessDeduction = Math.abs(accruedDays) * excessDayCost;
  }
  excessDeduction = roundMoney(excessDeduction);
  const leaveCompensation = roundMoney(daily * Math.max(0, leaveDaysToPay));

  const flightTicketAllowance =
    input.flightTicketOption === 'amount' ? roundMoney(Math.max(0, input.flightTicketAmount ?? 0)) : 0;
  const overtime = roundMoney(Math.max(0, input.overtime));
  const manualEntitlements = roundMoney(Math.max(0, input.manualEntitlements));
  const manualDeductions = roundMoney(Math.max(0, input.manualDeductions));
  const loansDeduction = roundMoney(Math.max(0, input.outstandingLoans));

  const visaFeeAmount =
    input.type === 'LEAVE_SETTLEMENT' && input.leaveOutsideKsa ? exitReentryVisaFee(requestedDays, input.visaBaseFee ?? DEFAULT_EXIT_REENTRY_VISA_FEE) : 0;

  const additionalEntitlements = sumMoney([manualEntitlements, flightTicketAllowance, overtime]);
  const totalDeductions = sumMoney([manualDeductions, excessDeduction, loansDeduction]);
  const totalSettlement = roundMoney(
    sumMoney([workingDaysSalary, endOfServiceAmount, leaveCompensation, additionalEntitlements]) - totalDeductions,
  );

  return {
    salaryUsed,
    dailySalary: daily,
    workingDaysInMonth,
    workingDaysSalary,
    yearsOfService: Math.round(years * 10000) / 10000,
    endOfServiceAmount,
    accruedLeaveDays: accruedDays,
    unusedLeaveDays: Math.max(0, accruedDays),
    leaveDaysToPay: Math.round(leaveDaysToPay * 100) / 100,
    requestedDays,
    excessDays: Math.round(excessDays * 100) / 100,
    leaveCompensation,
    excessDeduction,
    loansDeduction,
    flightTicketAllowance,
    overtime,
    manualEntitlements,
    manualDeductions,
    visaFeeAmount,
    additionalEntitlements,
    totalDeductions,
    totalSettlement,
  };
}

/** Month (year, 1-12) of a date-only value. */
export function monthOf(d: Date): { year: number; month: number } {
  const key = dateKey(d) ?? '';
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

/**
 * Whether an END_OF_SERVICE settlement must pay an approved overtime (based on
 * OvertimeRequest.paidInPayrollId / paidInSettlementId, with the timestamp fallback for legacy
 * rows). Defined in src/lib/payroll-core.ts next to the payroll rule it mirrors.
 * A LEAVE_SETTLEMENT never pays overtime: the employee stays on payroll, which pays it.
 */
export { overtimeDueInSettlement } from '@/lib/payroll-core';

export interface SettlementLoanLike {
  remainingAmount: number;
  /** Installments reserved by DRAFT payrolls (month / year / amount). */
  installments?: ReadonlyArray<{ month: number; year: number; amount: number }>;
}

/**
 * Loan balance a settlement deducts: remaining balance minus the installments held by DRAFT
 * payrolls of months before the last working month (those drafts survive the settlement
 * approval and collect their installments when approved). Drafts of the last month onwards
 * are dropped when the settlement is approved, so their installments are not subtracted.
 * The same formula is applied at creation and again at owner approval (see
 * src/lib/finance.ts approveSettlement), so installments collected in between are not charged twice.
 */
export function outstandingLoansForSettlement(loans: ReadonlyArray<SettlementLoanLike>, lastWorkingDate: Date): number {
  const last = monthOf(lastWorkingDate);
  const lastIdx = monthIndex(last.year, last.month);
  return sumMoney(
    loans.map((l) => {
      const held = sumMoney((l.installments ?? []).filter((i) => monthIndex(i.year, i.month) < lastIdx).map((i) => i.amount));
      return Math.max(0, roundMoney(l.remainingAmount - held));
    }),
  );
}
