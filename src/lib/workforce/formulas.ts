// Workforce engine formulas (SPEC §3). PURE, deterministic, client-safe.
// Every formula REUSES the existing Radeef engines instead of re-implementing them:
// - GOSI: src/lib/gosi.ts calculateGosi (dated GosiRate rows, regime, clamp, UNKNOWN fallback).
// - EOSB: src/lib/settlement.ts yearsOfService + endOfServiceAward (art. 84/85/87/54/80).
// - Leave: src/lib/leave.ts rates (annualEntitlementRates, art. 109: 21 then 30 days/year) with the accrual part
//   of computeLeaveBalance evaluated inline (parity-tested in wf-true-cost.test.ts).
// - Wage / day rate / hourly: src/lib/payroll-core.ts monthlyWage / dailyRate / basicHourlyRate.
import { roundMoney } from '@/lib/money';
import { calculateGosi, type GosiResult } from '@/lib/gosi';
import { SERVICE_YEARS_FOR_HIGHER_ACCRUAL, annualEntitlementRates } from '@/lib/leave';
import { endOfServiceAward, yearsOfService } from '@/lib/settlement';
import { DEFAULT_PAYROLL_SETTINGS, housingAllowance, overtimeHourlyRate, type OvertimeHourlyBasis, type PayrollSettings } from '@/lib/payroll-core';
import { normalizeNationalityKey, type NationalityClass } from '@/lib/nationality';
import type { GosiRateRow, HrdfCategory, LevySnapshot, ResolvedRule, WfAllowanceInput } from '@/lib/workforce/types';

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Months and formatting
// ---------------------------------------------------------------------------

/** 'YYYY-MM' of a date (UTC). */
export function monthKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Parses 'YYYY-MM' (or a Date) into {year, month 1-12}. */
export function parseMonth(v: string | Date): { year: number; month: number } {
  if (v instanceof Date) return { year: v.getUTCFullYear(), month: v.getUTCMonth() + 1 };
  const m = /^(\d{4})-(\d{1,2})/.exec(v.trim());
  if (!m) throw new Error(`invalid month: ${v}`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`invalid month: ${v}`);
  return { year: Number(m[1]), month };
}

export function monthStartUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

export function monthEndUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

export function addMonthsYm(year: number, month: number, n: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Whole calendar months from the month of `from` to the month of `to` (same month = 0). */
export function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/** Days employed in [start, end] of a month (calendar days, inclusive). */
export function activeDays(monthStart: Date, monthEnd: Date, join: Date, exit: Date | null): number {
  const s = Math.max(monthStart.getTime(), dayStart(join));
  const e = Math.min(monthEnd.getTime(), exit ? dayStart(exit) : monthEnd.getTime());
  return e < s ? 0 : Math.round((e - s) / DAY_MS) + 1;
}

function dayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** "8,000" / "8,000.5" — cheap, locale-independent (Latin digits, like the rest of Radeef). */
export function fmt(n: number): string {
  const cents = Math.round(Math.abs(roundMoney(n)) * 100);
  const neg = n < 0 && cents > 0;
  const int = Math.floor(cents / 100);
  const frac = cents - int * 100;
  const s = String(int);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  const fracStr = frac === 0 ? '' : frac % 10 === 0 ? '.' + frac / 10 : '.' + (frac < 10 ? '0' : '') + frac;
  return (neg ? '-' : '') + out + fracStr;
}

/** "12.75%" */
export function pct(n: number): string {
  return `${Math.round(n * 10000) / 10000}%`;
}

// ---------------------------------------------------------------------------
// Contributory wage
// ---------------------------------------------------------------------------

const HOUSING_NAME = /سكن|housing/i;

export interface ContributoryWage {
  /** basic + housing, before the cap. */
  raw: number;
  /** min(raw, cap) (cap null = not capped here; calculateGosi still clamps with the rate row). */
  capped: number;
  housing: number;
  /** A housing amount was recognized only from the allowance name (no allowanceType / flag). */
  housingInferredFromName: boolean;
  /** Allowances whose allowanceType contradicts countsTowardGosi or the name (see housingForGosi). */
  typeConflicts: HousingTypeConflict[];
  /**
   * Allowances payroll puts in the GOSI base (monthly, countsTowardGosi = true: src/lib/gosi.ts gosiBaseWage)
   * minus the housing counted here. 0 = same base as payroll.
   */
  payrollDiff: number;
}

/**
 * An allowance whose allowanceType contradicts the payroll flag or its name:
 * - TYPED_NOT_HOUSING_BUT_GOSI: type FOOD / TRANSPORT / OTHER but countsTowardGosi = true (payroll counts it,
 *   the engine does not);
 * - TYPED_NOT_HOUSING_BUT_NAME: type is not HOUSING but the name says housing ("بدل سكن");
 * - HOUSING_NOT_GOSI: type HOUSING but countsTowardGosi = false (the engine counts it, payroll does not).
 */
export interface HousingTypeConflict {
  name: string;
  amount: number;
  allowanceType: string;
  reason: 'TYPED_NOT_HOUSING_BUT_GOSI' | 'TYPED_NOT_HOUSING_BUT_NAME' | 'HOUSING_NOT_GOSI';
}

/**
 * Monthly housing allowance counted in the GOSI wage (SI Law art. 8: basic + cash housing):
 * - allowanceType set: counts iff 'HOUSING' (conflicts with countsTowardGosi / the name are REPORTED in
 *   `conflicts`, never silently resolved: the engine follows the type, payroll follows countsTowardGosi);
 * - allowanceType empty: counts iff countsTowardGosi (the payroll flag), else when the NAME says housing
 *   (flagged: payroll does not include it until the allowance is typed / flagged).
 * `payrollAmount` = what payroll counts (monthly allowances with countsTowardGosi = true).
 */
export function housingForGosi(allowances: ReadonlyArray<WfAllowanceInput>): { amount: number; inferredFromName: boolean; conflicts: HousingTypeConflict[]; payrollAmount: number } {
  let amount = 0;
  let payroll = 0;
  let inferred = false;
  const conflicts: HousingTypeConflict[] = [];
  for (const a of allowances) {
    if (!a.isMonthly) continue;
    const v = a.amount ?? 0;
    if (a.countsTowardGosi === true) payroll += v;
    const type = (a.allowanceType ?? '').trim().toUpperCase();
    if (type) {
      const name = a.name ?? '';
      if (type === 'HOUSING') {
        amount += v;
        if (a.countsTowardGosi === false) conflicts.push({ name, amount: v, allowanceType: type, reason: 'HOUSING_NOT_GOSI' });
      } else if (a.countsTowardGosi === true) conflicts.push({ name, amount: v, allowanceType: type, reason: 'TYPED_NOT_HOUSING_BUT_GOSI' });
      else if (HOUSING_NAME.test(name)) conflicts.push({ name, amount: v, allowanceType: type, reason: 'TYPED_NOT_HOUSING_BUT_NAME' });
      continue;
    }
    if (a.countsTowardGosi === true) amount += v;
    else if (HOUSING_NAME.test(a.name ?? '') && housingAllowance([a]) > 0) {
      amount += v;
      inferred = true;
    }
  }
  return { amount: roundMoney(amount), inferredFromName: inferred, conflicts, payrollAmount: roundMoney(payroll) };
}

/** SPEC contributoryWage: basic + cash housing, capped (GOSI_MAX_CONTRIBUTORY_WAGE, 45,000). */
export function contributoryWage(basic: number, allowances: ReadonlyArray<WfAllowanceInput>, cap: number | null): ContributoryWage {
  const h = housingForGosi(allowances);
  const raw = roundMoney((basic > 0 ? basic : 0) + h.amount);
  return {
    raw,
    capped: cap !== null && cap > 0 ? Math.min(raw, cap) : raw,
    housing: h.amount,
    housingInferredFromName: h.inferredFromName,
    typeConflicts: h.conflicts,
    payrollDiff: roundMoney(h.payrollAmount - h.amount),
  };
}

/** SPEC gosiEmployerMonthly: calculateGosi for the month (regime-aware dated rates, proration factor). */
export function gosiEmployerMonthly(opts: {
  isSaudi: boolean;
  regime: string | null | undefined;
  wage: number;
  year: number;
  month: number;
  rates: ReadonlyArray<GosiRateRow>;
  factor?: number;
}): GosiResult {
  return calculateGosi({
    isSaudi: opts.isSaudi,
    regime: opts.regime,
    contributoryWage: opts.wage,
    year: opts.year,
    month: opts.month,
    rates: opts.rates,
    factor: opts.factor ?? 1,
  });
}

// ---------------------------------------------------------------------------
// End of service (art. 84 / 85)
// ---------------------------------------------------------------------------

export type EosbBasis = 'EMPLOYER' | 'RESIGNATION';

/** Award owed if the relation ended on `lastDay` (inclusive), with `wage` as the last wage. */
export function eosbLiability(wage: number, joinDate: Date, lastDay: Date, basis: EosbBasis = 'EMPLOYER'): number {
  if (lastDay.getTime() < dayStart(joinDate)) return 0;
  const years = yearsOfService(joinDate, lastDay);
  return endOfServiceAward(wage, years, basis === 'RESIGNATION' ? 'RESIGNATION' : 'COMPANY_TERMINATION');
}

/**
 * SPEC eosbAccrualMonthly: increase of the art. 84 award (employer-termination basis) over a month =
 * liability(end of month, wage of the month) - liability(end of previous month, wage of the previous month).
 * A raise therefore shows its catch-up on past years in the month it starts (the award uses the LAST wage).
 */
export function eosbAccrualMonthly(opts: { joinDate: Date; prevLastDay: Date; lastDay: Date; prevWage: number; wage: number; basis?: EosbBasis }): number {
  const now = eosbLiability(opts.wage, opts.joinDate, opts.lastDay, opts.basis);
  const before = eosbLiability(opts.prevWage, opts.joinDate, opts.prevLastDay, opts.basis);
  return roundMoney(now - before);
}

// ---------------------------------------------------------------------------
// Annual leave (art. 109)
// ---------------------------------------------------------------------------

/**
 * Leave days accrued between `from` and `to` = the accrual part of THE balance formula of src/lib/leave.ts
 * (computeLeaveBalance with leaveAccrualStartDate = from, asOf = to, no leaves): 21/365 per day during the
 * first 5 years from joinDate, 30/365 after, company setting only above the statutory minimum
 * (annualEntitlementRates). Evaluated inline with leave.ts's own rates because computeLeaveBalance's
 * date-string handling is too slow for 36 months × 1,000 employees; wf-true-cost.test.ts checks that both
 * give the same result.
 */
export function leaveDaysAccrued(joinDate: Date, from: Date, to: Date, annualLeaveDaysSetting?: number | null): number {
  const rates = annualEntitlementRates(annualLeaveDaysSetting);
  const join = dayStart(joinDate);
  const start = Math.max(dayStart(from), join);
  const asOf = dayStart(to);
  if (!(asOf > start)) return 0;
  const five = Date.UTC(joinDate.getUTCFullYear() + SERVICE_YEARS_FOR_HIGHER_ACCRUAL, joinDate.getUTCMonth(), joinDate.getUTCDate());
  const tier1Days = Math.max(0, Math.round((Math.min(asOf, five) - start) / DAY_MS));
  const tier2Days = Math.max(0, Math.round((asOf - Math.max(start, five)) / DAY_MS));
  return roundMoney((tier1Days * rates.under5 + tier2Days * rates.from5) / 365);
}

/** SPEC leaveLiabilityMonthly: days accrued in the month × the settlement day rate (wage / 30). */
export function leaveLiabilityMonthly(opts: {
  joinDate: Date;
  /** Last day of the previous month (or the day before the join date). */
  from: Date;
  /** Last employed day in the month. */
  to: Date;
  dailyWage: number;
  annualLeaveDaysSetting?: number | null;
}): { days: number; amount: number; entitlement: number } {
  const days = leaveDaysAccrued(opts.joinDate, opts.from, opts.to, opts.annualLeaveDaysSetting);
  const j = opts.joinDate;
  const fiveYears = Date.UTC(j.getUTCFullYear() + 5, j.getUTCMonth(), j.getUTCDate());
  const s = typeof opts.annualLeaveDaysSetting === 'number' ? opts.annualLeaveDaysSetting : 0;
  const entitlement = opts.to.getTime() >= fiveYears ? Math.max(30, s) : Math.max(21, s);
  return { days, amount: roundMoney(days * opts.dailyWage), entitlement };
}

// ---------------------------------------------------------------------------
// Expat levy (المقابل المالي) per legal company
// ---------------------------------------------------------------------------

export interface LevyMember {
  id: string;
  cls: NationalityClass;
  joinDate: Date;
  fullTime: boolean;
}

export interface LevyContext {
  isIndustrialLicensed: boolean;
  /** INDUSTRIAL_LEVY_CANCELLED rule in force (value 1) at the month. */
  industrialCancellation: ResolvedRule;
  within: ResolvedRule;
  above: ResolvedRule;
  smallMax: ResolvedRule;
  exemptOwnerOnly: ResolvedRule;
  exemptWithSaudi: ResolvedRule;
  /** Assumption OWNER_FULL_TIME (null = not entered -> no exemption, flagged). */
  ownerFullTime: boolean | null;
}

export type LevyTier = 'EXEMPT' | 'WITHIN' | 'ABOVE' | 'INDUSTRIAL_ZERO';

export interface LevyAllocation {
  /** employeeId -> tier and monthly amount (expats only). */
  byEmployee: Map<string, { tier: LevyTier; amount: number; rank: number }>;
  summary: LevySnapshot;
  /** Number of expats exempted and why. */
  exemption: { count: number; reason: 'NONE' | 'OWNER_ONLY' | 'OWNER_AND_SAUDI' };
  /** Small establishment but OWNER_FULL_TIME not entered: the exemption may apply. */
  exemptionUnknown: boolean;
}

function val(r: ResolvedRule): number | null {
  return r.status !== 'MISSING' && typeof r.value === 'number' ? r.value : null;
}

/**
 * SPEC expatMonthlyFees (levy part). Rank the legal company's expats (join date, then id): the small-
 * establishment exemption takes the first E, then the first S (S = Saudis in the legal company, canonical
 * isSaudi) pay the 'within' rate (700) and the rest the 'above' rate (800). GCC nationals are neither
 * Saudi nor expat for the levy. Licensed industrial establishment with the cancellation in force: 0.
 * Exemption: legal-company headcount <= SMALL_EST_MAX_WORKERS (9) and OWNER_FULL_TIME: 2 expats, or 4
 * when a full-time Saudi other than the owner exists (the owner is not an Employee row in Radeef, so any
 * full-time Saudi employee counts — flagged as an assumption).
 */
export function allocateLevy(members: ReadonlyArray<LevyMember>, ctx: LevyContext): LevyAllocation {
  const expats = members.filter((m) => m.cls === 'EXPAT').sort((a, b) => a.joinDate.getTime() - b.joinDate.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const saudi = members.filter((m) => m.cls === 'SAUDI').length;
  const gcc = members.filter((m) => m.cls === 'GCC').length;
  const headcount = members.length;
  const byEmployee = new Map<string, { tier: LevyTier; amount: number; rank: number }>();
  const industrialZero = ctx.isIndustrialLicensed && val(ctx.industrialCancellation) === 1;

  let exemptCount = 0;
  let reason: LevyAllocation['exemption']['reason'] = 'NONE';
  let exemptionUnknown = false;
  const smallMax = val(ctx.smallMax);
  if (!industrialZero && smallMax !== null && headcount <= smallMax && expats.length > 0) {
    if (ctx.ownerFullTime === true) {
      const hasSaudi = members.some((m) => m.cls === 'SAUDI' && m.fullTime);
      const n = hasSaudi ? val(ctx.exemptWithSaudi) : val(ctx.exemptOwnerOnly);
      if (n !== null && n > 0) {
        exemptCount = Math.min(expats.length, Math.floor(n));
        reason = hasSaudi ? 'OWNER_AND_SAUDI' : 'OWNER_ONLY';
      }
    } else if (ctx.ownerFullTime === null) exemptionUnknown = true;
  }

  const within = val(ctx.within) ?? 0;
  const above = val(ctx.above) ?? 0;
  let withinCount = 0;
  let aboveCount = 0;
  let total = 0;
  expats.forEach((m, i) => {
    if (industrialZero) {
      byEmployee.set(m.id, { tier: 'INDUSTRIAL_ZERO', amount: 0, rank: i + 1 });
      return;
    }
    if (i < exemptCount) {
      byEmployee.set(m.id, { tier: 'EXEMPT', amount: 0, rank: i + 1 });
      return;
    }
    const j = i - exemptCount; // position among the charged expats
    if (j < saudi) {
      withinCount++;
      total += within;
      byEmployee.set(m.id, { tier: 'WITHIN', amount: within, rank: i + 1 });
    } else {
      aboveCount++;
      total += above;
      byEmployee.set(m.id, { tier: 'ABOVE', amount: above, rank: i + 1 });
    }
  });

  return {
    byEmployee,
    summary: {
      saudi,
      gcc,
      expat: expats.length,
      headcount,
      exempt: industrialZero ? 0 : exemptCount,
      within: withinCount,
      above: aboveCount,
      industrialZero,
      monthlyLevy: roundMoney(total),
    },
    exemption: { count: exemptCount, reason },
    exemptionUnknown,
  };
}

// ---------------------------------------------------------------------------
// HRDF employment support (دعم التوظيف، دليل هدف أغسطس 2026)
// ---------------------------------------------------------------------------

/**
 * First supported month = join month + HRDF_START_OFFSET_MONTHS. Approximation of "apply between day 91
 * and day 180 of the GOSI registration": support is assumed to start in the 4th month of employment
 * (join month = month 1) and to last HRDF_MONTHS (24) months, i.e. months 4..27.
 */
export const HRDF_START_OFFSET_MONTHS = 3;

/**
 * Application window of the HRDF support: the employer applies between day 91 and day 180 of the GOSI
 * registration, approximated as the months HRDF_START_OFFSET_MONTHS .. + HRDF_APPLICATION_WINDOW_MONTHS − 1
 * after the join month (months 4–6 of employment). ELIGIBILITY (wage 4,000–15,000, full time, age) is
 * decided ONCE, in the first window month whose criteria hold; an employee who did not qualify during the
 * window never becomes eligible later (e.g. after a raise). The amount of an eligible employee follows the
 * actual wage of each supported month (percentage and caps). See true-cost.ts hrdfWindowDecision.
 */
export const HRDF_APPLICATION_WINDOW_MONTHS = 3;

const MAJOR_CITIES: ReadonlyArray<RegExp> = [
  /(^|\s)(ال)?رياض(\s|$)/,
  /(^|\s)جده(\s|$)/,
  /(^|\s)(ال)?دمام(\s|$)/,
  /(^|\s)(ال)?خبر(\s|$)/,
  /\b(ar |al )?riyadh\b/,
  /\bjedd?ah\b|\bjiddah?\b/,
  /\b(ad |al )?dammam\b/,
  /\b(al )?kh?obar\b/,
];

/** Riyadh / Jeddah / Dammam / Khobar (Arabic or English spellings). null = city unknown. */
export function isMajorCity(city: string | null | undefined): boolean | null {
  const key = normalizeNationalityKey(city ?? '');
  if (!key) return null;
  return MAJOR_CITIES.some((re) => re.test(key));
}

export interface HrdfInput {
  isSaudi: boolean;
  /** Wage registered in GOSI (basic + housing), the HRDF "wage". */
  wage: number;
  fullTime: boolean;
  /** Months since the join month (join month = 0). */
  monthsSinceJoin: number;
  /** Age at the month start (null = unknown, not checked). */
  age: number | null;
  female: boolean;
  disabled: boolean;
  /** Assumption COMPANY_IS_SME (null = not entered -> category not added). */
  sme: boolean | null;
  city: string | null | undefined;
  basePct: ResolvedRule;
  bonusPct: ResolvedRule;
  cap: ResolvedRule;
  capPct: ResolvedRule;
  minWage: ResolvedRule;
  maxWage: ResolvedRule;
  months: ResolvedRule;
  /**
   * Eligibility was already decided in the application window (true-cost.ts hrdfWindowDecision): the
   * wage band, full-time and age criteria are not re-checked for this month; only the support period and
   * the amount (percentage, caps) are computed with this month's wage.
   */
  eligibilityDecided?: boolean;
}

export interface HrdfResult {
  eligible: boolean;
  /** Monthly support (>= 0; the cost line shows it negative). */
  amount: number;
  pct: number;
  categories: HrdfCategory[];
  /** Why not eligible (Arabic), when not eligible. */
  reason: string | null;
  cappedBy: 'NONE' | 'SAR_CAP' | 'WAGE_PCT_CAP';
}

/** SPEC hrdfSubsidyMonthly. Conditional on HRDF acceptance: shown as a separate negative line. */
export function hrdfSubsidyMonthly(i: HrdfInput): HrdfResult {
  const none = (reason: string): HrdfResult => ({ eligible: false, amount: 0, pct: 0, categories: [], reason, cappedBy: 'NONE' });
  const base = val(i.basePct);
  const bonus = val(i.bonusPct);
  const cap = val(i.cap);
  const capPct = val(i.capPct);
  const minW = val(i.minWage);
  const maxW = val(i.maxWage);
  const months = val(i.months);
  if (base === null || cap === null || capPct === null || minW === null || maxW === null || months === null) return none('قواعد دعم التوظيف غير سارية في هذا الشهر');
  if (!i.isSaudi) return none('غير سعودي');
  if (!i.eligibilityDecided) {
    if (!i.fullTime) return none('ليس بدوام كامل');
    if (i.age !== null && (i.age < 18 || i.age > 60)) return none('العمر خارج 18 إلى 60');
    if (i.wage < minW || i.wage > maxW) return none(`الأجر خارج ${fmt(minW)} إلى ${fmt(maxW)}`);
  }
  const k = i.monthsSinceJoin;
  if (k < HRDF_START_OFFSET_MONTHS || k >= HRDF_START_OFFSET_MONTHS + months) return none('خارج مدة الدعم (الشهر 4 إلى 27 من المباشرة)');

  const categories: HrdfResult['categories'] = [];
  if (i.female) categories.push('FEMALE');
  if (i.disabled) categories.push('DISABLED');
  if (i.sme === true) categories.push('SME');
  if (isMajorCity(i.city) === false) categories.push('OUTSIDE_MAJOR_CITIES');
  const p = base + (bonus ?? 0) * categories.length;
  const raw = (i.wage * p) / 100;
  const pctCap = (i.wage * capPct) / 100;
  let amount = raw;
  let cappedBy: HrdfResult['cappedBy'] = 'NONE';
  const limit = Math.min(cap, pctCap);
  if (amount > limit) {
    amount = limit;
    cappedBy = cap <= pctCap ? 'SAR_CAP' : 'WAGE_PCT_CAP';
  }
  return { eligible: true, amount: roundMoney(amount), pct: p, categories, reason: null, cappedBy };
}

// ---------------------------------------------------------------------------
// Overtime (art. 107)
// ---------------------------------------------------------------------------

export type OvertimeBasis = OvertimeHourlyBasis;

/**
 * SPEC overtimeCost: the SAME hourly as payroll (payroll-core overtimeHourlyRate) with the weekday
 * multiplier (overtime_rate_multiplier). Basis = the company setting Company.overtimeHourlyBasis:
 * BASIC = basic hourly × multiplier; TOTAL_PLUS_HALF_BASIC = total hourly + (multiplier − 1) × basic hourly
 * (art. 107 literal reading). Hourly = monthly / (30 × work hours per day).
 */
export function overtimeCost(opts: {
  hours: number;
  basicSalary: number;
  allowances: ReadonlyArray<WfAllowanceInput>;
  basis: OvertimeBasis;
  settings?: PayrollSettings;
  annualCapHours?: number | null;
  /** Hours already worked in the year (cap check). */
  hoursYearToDate?: number;
}): { amount: number; hourly: number; overCap: boolean } {
  const settings = opts.settings ?? DEFAULT_PAYROLL_SETTINGS;
  const hours = Math.max(0, opts.hours);
  const hourly = overtimeHourlyRate({ basicSalary: opts.basicSalary, allowances: opts.allowances }, settings.overtimeMultiplier, settings, opts.basis);
  const cap = opts.annualCapHours ?? null;
  const overCap = cap !== null && (opts.hoursYearToDate ?? 0) + hours > cap;
  return { amount: roundMoney(hours * hourly), hourly: roundMoney(hourly), overCap };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function isFemale(gender: string | null | undefined): boolean {
  // normalizeNationalityKey is a generic Arabic/English normalizer: 'أنثى' -> 'انثي', 'امرأة' -> 'امراه'.
  const g = normalizeNationalityKey(gender ?? '');
  return g === 'female' || g === 'f' || g === 'انثي' || g === 'امراه' || g === 'woman';
}

export function isFullTime(contractType: string | null | undefined, partTimeWeeklyHours: number | null | undefined): boolean {
  if (typeof partTimeWeeklyHours === 'number' && partTimeWeeklyHours > 0) return false;
  const t = (contractType ?? 'FULL_TIME').toUpperCase();
  return t === 'FULL_TIME';
}

/** Age in whole years on `at`. */
export function ageOn(dob: Date | null | undefined, at: Date): number | null {
  if (!dob || Number.isNaN(dob.getTime())) return null;
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
