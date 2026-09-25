// GOSI (social insurance) contributions: PURE module (no database access, client-safe).
//
// Council decision DEC-003 (docs/council/DECISIONS.md):
// - Rates come from the dated GosiRate table (seeded by migrations). The row used for a payroll
//   month is the one effective on the FIRST DAY of that month for (regime, isSaudi), so a step
//   that starts on 1 July applies from the July payroll.
// - Employee.gosiRegime is explicit (OLD / NEW / UNKNOWN) and never derived from a date here.
//   A Saudi with regime UNKNOWN is computed with the OLD rates and the line is flagged for review
//   ("نظام التأمينات غير مؤكد"); the payroll run is never blocked by one employee.
// - Contributory wage = basic + recurring allowances flagged countsTowardGosi (explicit flag, not
//   a name regex), clamped to [minWage, maxWage] of the rate row (1,500 / 45,000 SAR by default).
//   A zero wage gives no contribution (nothing is registered).
// - Employee.gosiDeduction > 0 is an explicit manual override of the EMPLOYEE share only
//   (prorated like the salary); the employer share is still computed from the rate table.
// - The employer share is a company cost: it is never deducted from the employee.
// - NEW-regime rows are PROVISIONAL (awaiting the counsel's confirmation); results computed
//   from them carry `provisional: true`. They do not block anything.
import { roundMoney, sumMoney } from '@/lib/money';

export type GosiRegimeValue = 'OLD' | 'NEW' | 'UNKNOWN';

export interface GosiRateLike {
  regime: GosiRegimeValue | string;
  isSaudi: boolean;
  effectiveFrom: Date;
  /** Percentages, e.g. 9.75. */
  employeeRate: number;
  employerRate: number;
  minWage: number;
  maxWage: number;
  isProvisional: boolean;
}

/** Arabic review notes (stored in Payroll.reviewNote). */
export const GOSI_NOTES = {
  UNKNOWN_REGIME: 'نظام التأمينات غير مؤكد',
  NO_RATE: 'لا يوجد معدل تأمينات ساري لهذا الشهر',
  MANUAL: 'مبلغ يدوي',
  PROVISIONAL: 'نسبة تأمينات مؤقتة بانتظار تأكيد المستشار',
  NO_NATIONALITY: 'الجنسية غير محددة',
} as const;

/**
 * Fallback used only when the GosiRate table is empty: the OLD-regime rows documented in the
 * official GOSI employer FAQ (9.75% / 11.75% Saudi, 0% / 2% non-Saudi, wage 1,500 - 45,000).
 */
export const DEFAULT_GOSI_RATES: ReadonlyArray<GosiRateLike> = [
  {
    regime: 'OLD',
    isSaudi: true,
    effectiveFrom: new Date('2000-01-01T00:00:00.000Z'),
    employeeRate: 9.75,
    employerRate: 11.75,
    minWage: 1500,
    maxWage: 45000,
    isProvisional: false,
  },
  {
    regime: 'OLD',
    isSaudi: false,
    effectiveFrom: new Date('2000-01-01T00:00:00.000Z'),
    employeeRate: 0,
    employerRate: 2,
    minWage: 1500,
    maxWage: 45000,
    isProvisional: false,
  },
];

/** Saudi detection for GOSI: 'سعودي' / 'سعودية' / 'SAUDI' / 'Saudi Arabia' ... (not 'غير سعودي'). */
export function isSaudiForGosi(nationality: string | null | undefined): boolean {
  const nat = (nationality ?? '').trim().toLowerCase();
  if (!nat) return false;
  // "غير سعودي" / "non-saudi" mean the opposite even though they contain the word.
  if (nat.includes('غير') || /\bnon[\s-]?saudi\b/.test(nat)) return false;
  return (
    nat === 'saudi' ||
    nat === 'saudi arabia' ||
    nat === 'sa' ||
    nat === 'ksa' ||
    nat === 'السعودية' ||
    nat.includes('سعودي')
  );
}

export interface GosiAllowanceLike {
  amount: number | null;
  isMonthly: boolean;
  countsTowardGosi?: boolean | null;
}

/** Unclamped contributory wage: basic + recurring allowances flagged countsTowardGosi. */
export function gosiBaseWage(basicSalary: number | null | undefined, allowances: ReadonlyArray<GosiAllowanceLike> | null | undefined): number {
  const flagged = (allowances ?? []).filter((a) => a.isMonthly && a.countsTowardGosi === true).map((a) => a.amount ?? 0);
  return roundMoney(sumMoney([basicSalary ?? 0, ...flagged]));
}

/** First day (UTC) of a payroll month. */
function monthFirstDay(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Last day (UTC) of a payroll month. */
function monthLastDay(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

/**
 * Rate row for (regime, isSaudi) effective on the first day of the month (latest effectiveFrom
 * <= first day). When none is effective on the first day but one starts later in the same month
 * (e.g. the NEW regime starting on 2024-07-03), that row is used. null when nothing applies.
 */
export function pickGosiRate(
  rates: ReadonlyArray<GosiRateLike>,
  regime: string,
  isSaudi: boolean,
  year: number,
  month: number,
): GosiRateLike | null {
  const first = monthFirstDay(year, month).getTime();
  const last = monthLastDay(year, month).getTime();
  const rows = rates.filter((r) => r.regime === regime && r.isSaudi === isSaudi);
  let best: GosiRateLike | null = null;
  for (const r of rows) {
    const t = r.effectiveFrom.getTime();
    if (t <= first && (!best || t > best.effectiveFrom.getTime())) best = r;
  }
  if (best) return best;
  let starting: GosiRateLike | null = null;
  for (const r of rows) {
    const t = r.effectiveFrom.getTime();
    if (t > first && t <= last && (!starting || t < starting.effectiveFrom.getTime())) starting = r;
  }
  return starting;
}

export interface CalculateGosiInput {
  isSaudi: boolean;
  regime: GosiRegimeValue | string | null | undefined;
  /** Monthly contributory wage BEFORE clamping (see gosiBaseWage). */
  contributoryWage: number;
  month: number;
  year: number;
  rates: ReadonlyArray<GosiRateLike>;
  /** Proration factor for partial months (1 = full month). */
  factor?: number;
  /** Employee.gosiDeduction: > 0 overrides the employee share (monthly amount, prorated). */
  employeeOverride?: number | null;
}

export interface GosiResult {
  employee: number;
  employer: number;
  /** Clamped monthly contributory wage (0 when there is no wage). */
  contributoryWage: number;
  /** Regime whose rates were used (UNKNOWN Saudi -> OLD). */
  regimeUsed: string;
  rate: GosiRateLike | null;
  provisional: boolean;
  manualOverride: boolean;
  needsReview: boolean;
  notes: string[];
}

export function calculateGosi(input: CalculateGosiInput): GosiResult {
  const factor = Math.max(0, Math.min(1, input.factor ?? 1));
  const notes: string[] = [];
  let needsReview = false;

  const declared = (input.regime ?? 'UNKNOWN').toString().toUpperCase();
  let regimeUsed = declared === 'NEW' ? 'NEW' : 'OLD';
  if (input.isSaudi && declared !== 'OLD' && declared !== 'NEW') {
    regimeUsed = 'OLD';
    needsReview = true;
    notes.push(GOSI_NOTES.UNKNOWN_REGIME);
  }

  let rate = pickGosiRate(input.rates, regimeUsed, input.isSaudi, input.year, input.month);
  // Non-Saudi rates do not depend on the regime: fall back to the OLD row.
  if (!rate && !input.isSaudi && regimeUsed !== 'OLD') rate = pickGosiRate(input.rates, 'OLD', false, input.year, input.month);
  if (!rate && regimeUsed !== 'OLD') {
    // NEW regime without a row for this month: OLD rates, flagged.
    rate = pickGosiRate(input.rates, 'OLD', input.isSaudi, input.year, input.month);
    regimeUsed = 'OLD';
    if (input.isSaudi) {
      needsReview = true;
      notes.push(GOSI_NOTES.NO_RATE);
    }
  }

  const override = input.employeeOverride && input.employeeOverride > 0 ? input.employeeOverride : 0;
  if (!rate) {
    if (input.isSaudi) {
      needsReview = true;
      if (!notes.includes(GOSI_NOTES.NO_RATE)) notes.push(GOSI_NOTES.NO_RATE);
    }
    if (override) notes.push(GOSI_NOTES.MANUAL);
    return {
      employee: override ? roundMoney(override * factor) : 0,
      employer: 0,
      contributoryWage: 0,
      regimeUsed,
      rate: null,
      provisional: false,
      manualOverride: !!override,
      needsReview,
      notes,
    };
  }

  const raw = Number.isFinite(input.contributoryWage) ? input.contributoryWage : 0;
  const wage = raw > 0 ? Math.min(rate.maxWage, Math.max(rate.minWage, raw)) : 0;
  const base = wage * factor;
  const employer = roundMoney((base * rate.employerRate) / 100);
  let employee = roundMoney((base * rate.employeeRate) / 100);
  if (override) {
    employee = roundMoney(override * factor);
    notes.push(GOSI_NOTES.MANUAL);
  }
  if (rate.isProvisional) notes.push(GOSI_NOTES.PROVISIONAL);

  return {
    employee,
    employer,
    contributoryWage: roundMoney(wage),
    regimeUsed,
    rate,
    provisional: rate.isProvisional,
    manualOverride: !!override,
    needsReview,
    notes,
  };
}

/** Joins review notes into the stored Payroll.reviewNote (null when empty). */
export function joinReviewNotes(notes: ReadonlyArray<string>): string | null {
  const unique = [...new Set(notes.map((n) => n.trim()).filter(Boolean))];
  return unique.length ? unique.join(' | ').slice(0, 1000) : null;
}
