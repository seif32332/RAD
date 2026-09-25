// Leave domain logic (Saudi labor law). PURE functions only: no prisma, no server imports,
// so they can be unit-tested and reused by pages, payroll and settlements.
//
// Storage convention: leave start/end dates are date-only values at UTC midnight
// (see src/lib/dates.ts). Leave day counts are inclusive calendar days.
import { dateKey, daysBetween, inclusiveDays, monthRange, today } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { LEAVE_STATUS } from '@/lib/constants';

export const LEAVE_TYPES = [
  'ANNUAL',
  'DEDUCTED',
  'SICK',
  'EMERGENCY',
  'UNPAID',
  'MATERNITY',
  'PATERNITY',
  'BEREAVEMENT',
  'MARRIAGE',
  'HAJJ',
] as const;
export type LeaveTypeCode = (typeof LEAVE_TYPES)[number];

/** Arabic label of every leave type (the ONE map: pages and APIs must not keep their own copy). */
export const LEAVE_TYPE_LABELS: Readonly<Record<LeaveTypeCode, string>> = {
  ANNUAL: 'سنوية',
  DEDUCTED: 'مستقطعة من الرصيد',
  SICK: 'مرضية',
  EMERGENCY: 'طارئة',
  UNPAID: 'بدون أجر',
  MATERNITY: 'وضع (أمومة)',
  PATERNITY: 'مولود (للأب)',
  BEREAVEMENT: 'وفاة قريب',
  MARRIAGE: 'زواج',
  HAJJ: 'حج',
};

/** Arabic label of a leave type code (unknown codes are returned unchanged). */
export function leaveTypeLabel(code: string | null | undefined): string {
  if (!code) return '';
  return (LEAVE_TYPE_LABELS as Record<string, string>)[code] ?? code;
}

// ---------------------------------------------------------------------------
// Statutory ("special") leaves — DEC-003 (docs/council/DECISIONS.md)
// ---------------------------------------------------------------------------
//
// Sources consulted 2026-09-24 (the council requires a documented human reading by the legal /
// payroll counsel before these values are treated as final — every value below is a
// CONFIGURABLE DEFAULT stored in SystemSetting, shown in /settings as
// "قيم افتراضية بانتظار تأكيد المستشار"):
//
// - Official gazette (Umm Al-Qura), amendment of some Labor Law articles (published 19/2/1446H =
//   2024-08-23, in force 180 days later = 2025-02-19; Royal Decree M/44 per Clyde & Co below —
//   article numbers below are as cited by the secondary sources and must be re-checked by counsel):
//     https://www.uqn.gov.sa/details?p=25379
//   Special leave (art. 113 as amended): 5 days full pay on marriage or on the death of a spouse,
//   an ascendant or a descendant; 3 days on the death of a brother or sister (counted from the
//   date of the event); 3 days on the birth of a child, taken within 7 days of the birth.
//   Maternity (art. 151 as amended): 12 weeks full pay, the 6 weeks after delivery are
//   mandatory, the rest may start up to 4 weeks before the expected delivery date; an optional
//   unpaid extension of one month.
// - HRSD (Ministry of Human Resources), "Women's Leaves":
//     https://www.hrsd.gov.sa/en/knowledge-centre/articles/64410
//   (12 weeks full pay; one extra month without pay; sick / disabled newborn: one month full pay
//   + one month unpaid — the sick-newborn month is NOT modelled here; iddah leave is NOT modelled.)
// - Clyde & Co, "KSA Labour Law amendments series: Part 2 - leave entitlements" (2025-04):
//     https://www.clydeco.com/en/insights/2025/04/ksa-labour-law-amendments-leave-entitlement
//   (secondary confirmation: 10 -> 12 weeks maternity, paternity within 7 days, new 3-day sibling
//   bereavement leave, effective 2025-02-19).
// - HRSD labor law text (Royal Decree M/51, art. 114, unchanged by the 2025 amendment as far as
//   the sources above show): Hajj leave with pay of not less than 10 and not more than 15 days
//   including the Eid al-Adha holiday, ONCE during the service, after at least 2 consecutive years
//   of service with the employer; the employer may cap how many workers take it each year.
//     https://www.hrsd.gov.sa/sites/default/files/2023-02/Labor.pdf
//
// Product rules (NOT from the law, documented here so nobody presents them as regulation):
// - PATERNITY is limited to MALE employees and MATERNITY to FEMALE employees (Employee.gender
//   holds 'MALE' / 'FEMALE'; Arabic labels are also accepted). A missing gender blocks both.
// - Days above the paid entitlement are refused (file the extra days as a separate annual /
//   unpaid leave) — except MATERNITY, whose optional unpaid extension is accepted when the
//   employee confirms the unpaid days (same confirmation as annual leave excess).
// - "Once per service" for Hajj = no other PENDING / APPROVED / COMPLETED HAJJ leave since the
//   current joinDate. Whether the employee performed Hajj before joining cannot be known by the
//   system: HR must check it.
// - None of these types consume the annual leave balance (BALANCE_LEAVE_TYPES below).

/** Statutory leave types handled by computeStatutoryLeave(). */
export const STATUTORY_LEAVE_TYPES = ['MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'MARRIAGE', 'HAJJ'] as const;
export type StatutoryLeaveType = (typeof STATUTORY_LEAVE_TYPES)[number];

export function isStatutoryLeaveType(t: string): t is StatutoryLeaveType {
  return (STATUTORY_LEAVE_TYPES as readonly string[]).includes(t);
}

/** Leave types that carry the date of the triggering event (birth / marriage / death). */
export const EVENT_DATED_LEAVE_TYPES: readonly string[] = ['PATERNITY', 'BEREAVEMENT', 'MARRIAGE'];

export const BEREAVEMENT_RELATIONS = ['FIRST_DEGREE', 'SIBLING'] as const;
export type BereavementRelation = (typeof BEREAVEMENT_RELATIONS)[number];
export const BEREAVEMENT_RELATION_LABELS: Readonly<Record<BereavementRelation, string>> = {
  FIRST_DEGREE: 'الزوج/الزوجة أو أحد الأصول أو الفروع',
  SIBLING: 'الأخ أو الأخت',
};

export interface StatutoryLeaveRules {
  maternityDays: number;
  maternityUnpaidExtensionDays: number;
  paternityDays: number;
  paternityWindowDays: number;
  marriageDays: number;
  bereavementDays: number;
  bereavementSiblingDays: number;
  hajjDays: number;
  hajjMinServiceYears: number;
}

/** SystemSetting keys of the statutory leave rules. */
export const LEAVE_RULE_SETTING_KEYS: Readonly<Record<keyof StatutoryLeaveRules, string>> = {
  maternityDays: 'leave_maternity_days',
  maternityUnpaidExtensionDays: 'leave_maternity_unpaid_extension_days',
  paternityDays: 'leave_paternity_days',
  paternityWindowDays: 'leave_paternity_window_days',
  marriageDays: 'leave_marriage_days',
  bereavementDays: 'leave_bereavement_days',
  bereavementSiblingDays: 'leave_bereavement_sibling_days',
  hajjDays: 'leave_hajj_days',
  hajjMinServiceYears: 'leave_hajj_min_service_years',
};

/**
 * Defaults (PROVISIONAL — pending counsel confirmation, see the sources above). Hajj: the law
 * gives 10 to 15 days including the Eid al-Adha holiday; the default is the statutory minimum and
 * the company may raise it up to 15.
 */
export const DEFAULT_STATUTORY_LEAVE_RULES: Readonly<StatutoryLeaveRules> = {
  maternityDays: 84, // 12 weeks
  maternityUnpaidExtensionDays: 30, // "one month" without pay
  paternityDays: 3,
  paternityWindowDays: 7,
  marriageDays: 5,
  bereavementDays: 5,
  bereavementSiblingDays: 3,
  hajjDays: 10,
  hajjMinServiceYears: 2,
};

/** Allowed ranges of the rule settings (used by /api/settings validation). */
export const LEAVE_RULE_LIMITS: Readonly<Record<keyof StatutoryLeaveRules, { min: number; max: number }>> = {
  maternityDays: { min: 1, max: 365 },
  maternityUnpaidExtensionDays: { min: 0, max: 365 },
  paternityDays: { min: 1, max: 60 },
  paternityWindowDays: { min: 1, max: 365 },
  marriageDays: { min: 1, max: 60 },
  bereavementDays: { min: 1, max: 60 },
  bereavementSiblingDays: { min: 1, max: 60 },
  hajjDays: { min: 1, max: 30 },
  hajjMinServiceYears: { min: 0, max: 40 },
};

/** Rules from SystemSetting values (key -> raw value); missing / invalid values use the defaults. */
export function parseStatutoryLeaveRules(values: ReadonlyMap<string, string | null | undefined> | Record<string, string | null | undefined>): StatutoryLeaveRules {
  const get = (k: string): string | null | undefined => (values instanceof Map ? values.get(k) : (values as Record<string, string | null | undefined>)[k]);
  const out = { ...DEFAULT_STATUTORY_LEAVE_RULES };
  for (const field of Object.keys(LEAVE_RULE_SETTING_KEYS) as Array<keyof StatutoryLeaveRules>) {
    const raw = get(LEAVE_RULE_SETTING_KEYS[field]);
    if (raw === null || raw === undefined) continue;
    const v = String(raw).trim().replace(/^"(.*)"$/, '$1');
    if (v === '') continue;
    const n = Number(v);
    const lim = LEAVE_RULE_LIMITS[field];
    if (Number.isInteger(n) && n >= lim.min && n <= lim.max) out[field] = n;
  }
  return out;
}

const MALE_VALUES = ['male', 'm', 'ذكر'];
const FEMALE_VALUES = ['female', 'f', 'أنثى', 'انثى', 'أنثي', 'انثي'];

/** Employee.gender -> 'MALE' | 'FEMALE' | null (blank / unknown). */
export function normalizeGender(gender: string | null | undefined): 'MALE' | 'FEMALE' | null {
  const s = String(gender ?? '').trim().toLowerCase();
  if (MALE_VALUES.includes(s)) return 'MALE';
  if (FEMALE_VALUES.includes(s)) return 'FEMALE';
  return null;
}

export interface StatutoryLeaveContext {
  rules: StatutoryLeaveRules;
  /** Employee.gender. */
  gender?: string | null;
  /** Completed years of service at the leave start (joinDate -> startDate). */
  serviceYears?: number;
  /** Other PENDING / APPROVED / COMPLETED HAJJ leaves in the current service. */
  priorHajjLeaves?: number;
  /** BEREAVEMENT only (default FIRST_DEGREE). */
  bereavementRelation?: BereavementRelation | null;
  /** Days from the event (birth / marriage / death) to the leave start; null / undefined = unknown. */
  daysFromEvent?: number | null;
}

/** Completed (anniversary-based) years of service from joinDate to asOf (0 when asOf is before joinDate). */
export function completedServiceYears(joinDate: Date | string, asOf: Date | string): number {
  const j = toUtcDay(joinDate);
  const a = toUtcDay(asOf);
  let years = a.getUTCFullYear() - j.getUTCFullYear();
  if (a.getUTCMonth() < j.getUTCMonth() || (a.getUTCMonth() === j.getUTCMonth() && a.getUTCDate() < j.getUTCDate())) years--;
  return Math.max(0, years);
}

/** Paid-day entitlement of a statutory leave type under `rules`. */
export function statutoryEntitlementDays(leaveType: StatutoryLeaveType, rules: StatutoryLeaveRules, relation?: BereavementRelation | null): number {
  switch (leaveType) {
    case 'MATERNITY':
      return rules.maternityDays;
    case 'PATERNITY':
      return rules.paternityDays;
    case 'MARRIAGE':
      return rules.marriageDays;
    case 'BEREAVEMENT':
      return relation === 'SIBLING' ? rules.bereavementSiblingDays : rules.bereavementDays;
    case 'HAJJ':
      return rules.hajjDays;
  }
}

/** Leave types whose paid days are taken from the annual leave balance. */
export const BALANCE_LEAVE_TYPES: readonly string[] = ['ANNUAL', 'DEDUCTED', 'EMERGENCY'];

/** Statuses whose paid days have been consumed from the balance. */
export const BALANCE_CONSUMING_STATUSES: readonly string[] = [LEAVE_STATUS.APPROVED, LEAVE_STATUS.COMPLETED];

/** Saudi labor law art. 109: 21 days/year, 30 days/year once the employee completes 5 years of service. */
export const STATUTORY_ANNUAL_LEAVE_DAYS = { UNDER_5_YEARS: 21, FROM_5_YEARS: 30 } as const;
export const SERVICE_YEARS_FOR_HIGHER_ACCRUAL = 5;
const DAYS_PER_YEAR = 365;

/** Saudi labor law art. 117 (sick leave within one year): 30 days full pay, 60 days at 75%, 30 days unpaid. */
export const SICK_LEAVE_TIERS = { FULL: 30, PARTIAL_UNTIL: 90, UNPAID_UNTIL: 120, PARTIAL_PAY_RATIO: 0.75 } as const;

/** Maximum length of a single leave request (days). */
export const MAX_LEAVE_DAYS = 365;

const SAUDI_NATIONALITY_VALUES = ['سعودي', 'سعودية', 'السعودية', 'saudi', 'saudi arabia', 'sa', 'ksa'];

export function isSaudiNationality(nationality: string | null | undefined): boolean {
  if (!nationality) return false;
  return SAUDI_NATIONALITY_VALUES.includes(nationality.trim().toLowerCase());
}

/**
 * Annual accrual rates. The statutory minimum always applies; a company setting
 * (SystemSetting `annual_leave_days`) can only grant more, never less.
 */
export function annualEntitlementRates(annualLeaveDaysSetting?: number | null): { under5: number; from5: number } {
  const s = typeof annualLeaveDaysSetting === 'number' && Number.isFinite(annualLeaveDaysSetting) ? annualLeaveDaysSetting : 0;
  return {
    under5: Math.max(STATUTORY_ANNUAL_LEAVE_DAYS.UNDER_5_YEARS, s),
    from5: Math.max(STATUTORY_ANNUAL_LEAVE_DAYS.FROM_5_YEARS, s),
  };
}

function addYearsUtc(d: Date, years: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
}

function toUtcDay(d: Date | string): Date {
  const key = dateKey(d);
  if (!key) throw new Error('invalid date');
  return new Date(`${key}T00:00:00.000Z`);
}

export interface LeaveBalanceLeave {
  id?: string;
  leaveType: string;
  status: string;
  paidDays: number | null;
  /** Legacy leaves without paidDays: paid days = totalDays - unpaidDays. */
  totalDays?: number | null;
  unpaidDays?: number | null;
  startDate: Date | string;
  endDate: Date | string;
  createdAt?: Date | string | null;
}

/** Paid days of a leave (legacy rows without paidDays fall back to totalDays - unpaidDays). */
function leavePaidDays(l: LeaveBalanceLeave): number {
  if (l.paidDays !== null && l.paidDays !== undefined) return Math.max(0, l.paidDays);
  if (l.totalDays === null || l.totalDays === undefined) return 0;
  return Math.max(0, l.totalDays - Math.max(0, l.unpaidDays ?? 0));
}

export interface LeaveBalanceInput {
  joinDate: Date | string;
  /** Set by a previous leave settlement / end of service / rehire / import. Null -> joinDate. */
  leaveAccrualStartDate?: Date | string | null;
  leaves: LeaveBalanceLeave[];
  /** Balance as of this day (default: today in Riyadh). */
  asOf?: Date | string;
  /** SystemSetting `annual_leave_days` (optional company policy above the statutory minimum). */
  annualLeaveDaysSetting?: number | null;
  /** Ignore this leave (e.g. when re-evaluating an existing leave). */
  excludeLeaveId?: string;
}

export interface LeaveBalance {
  /** 'YYYY-MM-DD' the accrual period starts from. */
  accrualStartDate: string;
  /** 'YYYY-MM-DD' the balance is computed for. */
  asOf: string;
  /** Total years of service since joinDate (2 decimals). */
  serviceYears: number;
  /** Current yearly entitlement (21 or 30 days, or the company setting). */
  annualEntitlement: number;
  /** Days accrued since accrualStartDate (2 decimals). */
  accrued: number;
  /** Paid days of approved/completed balance leaves in the accrual period. */
  taken: number;
  /** Paid days of pending balance leaves (informational, not subtracted). */
  pending: number;
  /** accrued - taken, never negative (2 decimals). */
  available: number;
}

/**
 * The ONE leave balance formula used everywhere:
 * accrued = prorated days of service since the accrual start (21/365 per day during the first
 * 5 years of service counted from joinDate, 30/365 per day after), minus paid days of
 * APPROVED/COMPLETED ANNUAL/DEDUCTED/EMERGENCY leaves recorded in that accrual period.
 */
export function computeLeaveBalance(input: LeaveBalanceInput): LeaveBalance {
  const rates = annualEntitlementRates(input.annualLeaveDaysSetting);
  const join = toUtcDay(input.joinDate);
  const accrualStart = input.leaveAccrualStartDate ? toUtcDay(input.leaveAccrualStartDate) : join;
  const start = accrualStart.getTime() < join.getTime() ? join : accrualStart;
  const asOf = toUtcDay(input.asOf ?? today());
  const fiveYears = addYearsUtc(join, SERVICE_YEARS_FOR_HIGHER_ACCRUAL);

  let accrued = 0;
  if (asOf.getTime() > start.getTime()) {
    const tier1End = asOf.getTime() < fiveYears.getTime() ? asOf : fiveYears;
    const tier1Days = Math.max(0, daysBetween(start, tier1End));
    const tier2Start = start.getTime() > fiveYears.getTime() ? start : fiveYears;
    const tier2Days = Math.max(0, daysBetween(tier2Start, asOf));
    accrued = (tier1Days * rates.under5 + tier2Days * rates.from5) / DAYS_PER_YEAR;
  }

  let taken = 0;
  let pending = 0;
  const startMs = start.getTime();
  for (const l of input.leaves) {
    if (input.excludeLeaveId && l.id === input.excludeLeaveId) continue;
    if (!BALANCE_LEAVE_TYPES.includes(l.leaveType)) continue;
    const end = toUtcDay(l.endDate).getTime();
    const recordedAt = l.createdAt ? new Date(l.createdAt).getTime() : toUtcDay(l.startDate).getTime();
    // Leaves recorded before the accrual start were already settled (or belong to a previous period).
    if (end < startMs || recordedAt < startMs) continue;
    const days = leavePaidDays(l);
    if (BALANCE_CONSUMING_STATUSES.includes(l.status)) taken += days;
    else if (l.status === LEAVE_STATUS.PENDING) pending += days;
  }

  const serviceDays = Math.max(0, daysBetween(join, asOf));
  const serviceYears = serviceDays / DAYS_PER_YEAR;
  return {
    accrualStartDate: dateKey(start) as string,
    asOf: dateKey(asOf) as string,
    serviceYears: round2(serviceYears),
    annualEntitlement: asOf.getTime() >= fiveYears.getTime() ? rates.from5 : rates.under5,
    accrued: round2(accrued),
    taken,
    pending,
    available: round2(Math.max(0, accrued - taken)),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface SickLeaveTiers {
  /** Sick days already taken in the 12 months before this leave. */
  past: number;
  /** Days at full pay. */
  full: number;
  /** Days at 75% pay. */
  partial: number;
  /** Days without pay (within the 120-day yearly limit). */
  unpaid: number;
  /** Days beyond the 120-day yearly limit. */
  beyond: number;
}

export function computeSickLeaveTiers(pastSickDays: number, totalDays: number): SickLeaveTiers {
  const past = Math.max(0, Math.floor(pastSickDays));
  const tiers: SickLeaveTiers = { past, full: 0, partial: 0, unpaid: 0, beyond: 0 };
  let day = past;
  for (let i = 0; i < totalDays; i++) {
    day++;
    if (day <= SICK_LEAVE_TIERS.FULL) tiers.full++;
    else if (day <= SICK_LEAVE_TIERS.PARTIAL_UNTIL) tiers.partial++;
    else if (day <= SICK_LEAVE_TIERS.UNPAID_UNTIL) tiers.unpaid++;
    else tiers.beyond++;
  }
  return tiers;
}

export type LeaveRequestIssue =
  | 'EXCESS_NOT_ACCEPTED'
  | 'UNPAID_WITH_BALANCE'
  | 'SICK_LIMIT_EXCEEDED'
  | 'MATERNITY_FEMALE_ONLY'
  | 'PATERNITY_MALE_ONLY'
  | 'HAJJ_ALREADY_TAKEN'
  | 'HAJJ_SERVICE_TOO_SHORT'
  | 'STATUTORY_MAX_EXCEEDED'
  | 'STATUTORY_EXTENSION_NOT_ACCEPTED'
  | 'EVENT_WINDOW_INVALID'
  | null;

export const LEAVE_ISSUE_MESSAGES: Record<Exclude<LeaveRequestIssue, null>, string> = {
  EXCESS_NOT_ACCEPTED:
    'رصيد الإجازة لا يكفي. الرجاء الموافقة على تحويل الأيام الزائدة لإجازة بدون مرتب، أو تقليل عدد أيام الإجازة لتطابق الرصيد.',
  UNPAID_WITH_BALANCE: 'لا يمكن طلب إجازة بدون مرتب والموظف لا يزال يمتلك رصيد إجازات سنوية متاح.',
  SICK_LIMIT_EXCEEDED: 'تم تجاوز الحد الأقصى للإجازة المرضية خلال السنة (120 يوماً).',
  MATERNITY_FEMALE_ONLY: 'إجازة الوضع للموظفات فقط. تحقق من حقل الجنس في ملف الموظف.',
  PATERNITY_MALE_ONLY: 'إجازة المولود مخصصة للموظف الأب. تحقق من حقل الجنس في ملف الموظف.',
  HAJJ_ALREADY_TAKEN: 'إجازة الحج تُمنح مرة واحدة طوال مدة الخدمة، ويوجد للموظف طلب أو إجازة حج سابقة.',
  HAJJ_SERVICE_TOO_SHORT: 'لم يكمل الموظف مدة الخدمة المطلوبة لاستحقاق إجازة الحج.',
  STATUTORY_MAX_EXCEEDED: 'مدة الإجازة تتجاوز الأيام المستحقة لهذا النوع. سجّل الأيام الإضافية كإجازة سنوية أو بدون أجر منفصلة.',
  STATUTORY_EXTENSION_NOT_ACCEPTED:
    'المدة تتجاوز أيام إجازة الوضع المدفوعة. يجب الموافقة على احتساب أيام التمديد بدون أجر، أو تقليل المدة.',
  EVENT_WINDOW_INVALID: 'تاريخ بداية الإجازة خارج الفترة المسموحة من تاريخ الواقعة (الولادة / الزواج / الوفاة).',
};

/** Detailed Arabic message (with the configured day counts) for an issue of a leave request. */
export function describeLeaveIssue(
  issue: Exclude<LeaveRequestIssue, null>,
  ctx: { leaveType?: string; rules?: StatutoryLeaveRules; bereavementRelation?: BereavementRelation | null } = {},
): string {
  const rules = ctx.rules ?? DEFAULT_STATUTORY_LEAVE_RULES;
  const t = ctx.leaveType && isStatutoryLeaveType(ctx.leaveType) ? ctx.leaveType : null;
  switch (issue) {
    case 'HAJJ_SERVICE_TOO_SHORT':
      return `إجازة الحج تُستحق بعد إكمال ${rules.hajjMinServiceYears} سنة خدمة متصلة على الأقل.`;
    case 'STATUTORY_MAX_EXCEEDED':
      if (t === 'MATERNITY') {
        return `مدة إجازة الوضع لا تتجاوز ${rules.maternityDays} يوماً مدفوعة + ${rules.maternityUnpaidExtensionDays} يوماً تمديداً بدون أجر.`;
      }
      if (t) {
        return `المستحق لإجازة ${LEAVE_TYPE_LABELS[t]} ${statutoryEntitlementDays(t, rules, ctx.bereavementRelation)} أيام تُحتسب من تاريخ الواقعة. سجّل الأيام الإضافية كإجازة سنوية أو بدون أجر منفصلة.`;
      }
      return LEAVE_ISSUE_MESSAGES.STATUTORY_MAX_EXCEEDED;
    case 'STATUTORY_EXTENSION_NOT_ACCEPTED':
      return `إجازة الوضع المدفوعة ${rules.maternityDays} يوماً. يجب الموافقة على احتساب الأيام الزائدة (حتى ${rules.maternityUnpaidExtensionDays} يوماً) بدون أجر، أو تقليل المدة.`;
    case 'EVENT_WINDOW_INVALID':
      if (t === 'PATERNITY') return `إجازة المولود (${rules.paternityDays} أيام) تؤخذ خلال ${rules.paternityWindowDays} أيام من تاريخ الولادة، ولا تبدأ قبلها.`;
      return LEAVE_ISSUE_MESSAGES.EVENT_WINDOW_INVALID;
    default:
      return LEAVE_ISSUE_MESSAGES[issue];
  }
}

/** Issues that block the request even when HR edits / extends it (unpaid confirmations are not blocking on edit). */
export const BLOCKING_LEAVE_ISSUES: readonly string[] = [
  'SICK_LIMIT_EXCEEDED',
  'MATERNITY_FEMALE_ONLY',
  'PATERNITY_MALE_ONLY',
  'HAJJ_ALREADY_TAKEN',
  'HAJJ_SERVICE_TOO_SHORT',
  'STATUTORY_MAX_EXCEEDED',
  'EVENT_WINDOW_INVALID',
];

export interface StatutoryLeaveResult {
  paidDays: number;
  unpaidDays: number;
  /** Paid-day entitlement that applied (after the event window). */
  entitlementDays: number;
  issue: LeaveRequestIssue;
}

/**
 * Paid / unpaid split and eligibility of a statutory leave (MATERNITY, PATERNITY, BEREAVEMENT,
 * MARRIAGE, HAJJ). Never touches the annual balance. See the rule notes at the top of this file.
 */
export function computeStatutoryLeave(
  leaveType: StatutoryLeaveType,
  totalDays: number,
  ctx: StatutoryLeaveContext,
  acceptUnpaidExtraDays = false,
): StatutoryLeaveResult {
  const total = Math.max(0, Math.floor(totalDays));
  const rules = ctx.rules;
  const gender = normalizeGender(ctx.gender);
  const relation = ctx.bereavementRelation ?? 'FIRST_DEGREE';
  let entitlement = statutoryEntitlementDays(leaveType, rules, relation);
  const fail = (issue: Exclude<LeaveRequestIssue, null>): StatutoryLeaveResult => ({
    paidDays: Math.min(total, Math.max(0, entitlement)),
    unpaidDays: Math.max(0, total - Math.max(0, entitlement)),
    entitlementDays: Math.max(0, entitlement),
    issue,
  });

  // Eligibility.
  if (leaveType === 'MATERNITY' && gender !== 'FEMALE') return fail('MATERNITY_FEMALE_ONLY');
  if (leaveType === 'PATERNITY' && gender !== 'MALE') return fail('PATERNITY_MALE_ONLY');
  if (leaveType === 'HAJJ') {
    if ((ctx.priorHajjLeaves ?? 0) > 0) return fail('HAJJ_ALREADY_TAKEN');
    if ((ctx.serviceYears ?? 0) + 1e-9 < rules.hajjMinServiceYears) return fail('HAJJ_SERVICE_TOO_SHORT');
  }

  // Event window (only when the event date is known).
  const offset = ctx.daysFromEvent;
  if (EVENT_DATED_LEAVE_TYPES.includes(leaveType) && typeof offset === 'number' && Number.isFinite(offset)) {
    if (offset < 0) return fail('EVENT_WINDOW_INVALID');
    if (leaveType === 'PATERNITY') {
      // The whole leave falls within `paternityWindowDays` days counted from the birth day.
      // (A leave longer than the entitlement is reported as STATUTORY_MAX_EXCEEDED below.)
      if (total <= entitlement && offset + total > rules.paternityWindowDays) return fail('EVENT_WINDOW_INVALID');
    } else {
      // MARRIAGE / BEREAVEMENT: the entitlement is counted from the date of the event.
      entitlement = Math.max(0, entitlement - offset);
      if (entitlement === 0) return fail('EVENT_WINDOW_INVALID');
    }
  }

  if (total <= entitlement) return { paidDays: total, unpaidDays: 0, entitlementDays: entitlement, issue: null };

  if (leaveType === 'MATERNITY' && total <= entitlement + rules.maternityUnpaidExtensionDays) {
    return {
      paidDays: entitlement,
      unpaidDays: total - entitlement,
      entitlementDays: entitlement,
      issue: acceptUnpaidExtraDays ? null : 'STATUTORY_EXTENSION_NOT_ACCEPTED',
    };
  }
  return fail('STATUTORY_MAX_EXCEEDED');
}

export interface LeaveRequestInput {
  leaveType: string;
  totalDays: number;
  /** Available annual balance (days, may be fractional). */
  availableBalance: number;
  /** Employee daily wage used for deductions (basic salary / 30). */
  dailyRate: number;
  /** Sick days taken in the 12 months before the leave (SICK only). */
  pastSickDays?: number;
  /** Employee accepted that days above the balance become unpaid (ANNUAL). */
  acceptUnpaidExtraDays?: boolean;
  /** HR waived the salary deduction for unpaid days. */
  waiveDeduction?: boolean;
  /** Statutory leave types: rules + eligibility facts (defaults when omitted: default rules, no facts). */
  statutory?: StatutoryLeaveContext;
}

export interface LeaveRequestResult {
  paidDays: number;
  unpaidDays: number;
  /** Salary deduction implied by this leave (unpaid days x daily wage, or the sick-leave tier deduction). */
  totalDeduction: number;
  sickTiers: SickLeaveTiers | null;
  issue: LeaveRequestIssue;
  /** Statutory leave types only: the paid-day entitlement that applied. */
  entitlementDays?: number | null;
}

/**
 * Server-side leave calculation (paid/unpaid days and salary deduction).
 * `totalDeduction` is the SAME money as the unpaid days: payroll must deduct either
 * this amount (split per month with leaveDeductionForMonth) or the unpaid days, never both.
 */
export function computeLeaveRequest(input: LeaveRequestInput): LeaveRequestResult {
  const total = Math.max(0, Math.floor(input.totalDays));
  const balanceDays = Math.max(0, Math.floor(input.availableBalance + 1e-9));
  const rate = Math.max(0, input.dailyRate);
  let paidDays = 0;
  let unpaidDays = 0;
  let deduction = 0;
  let sickTiers: SickLeaveTiers | null = null;
  let issue: LeaveRequestIssue = null;
  let entitlementDays: number | null = null;

  switch (input.leaveType) {
    case 'MATERNITY':
    case 'PATERNITY':
    case 'BEREAVEMENT':
    case 'MARRIAGE':
    case 'HAJJ': {
      // Full pay within the entitlement, never taken from the annual balance.
      const r = computeStatutoryLeave(input.leaveType, total, input.statutory ?? { rules: DEFAULT_STATUTORY_LEAVE_RULES }, input.acceptUnpaidExtraDays);
      paidDays = r.paidDays;
      unpaidDays = r.unpaidDays;
      deduction = unpaidDays * rate;
      entitlementDays = r.entitlementDays;
      issue = r.issue;
      break;
    }
    case 'ANNUAL':
    case 'DEDUCTED':
    case 'EMERGENCY': {
      paidDays = Math.min(total, balanceDays);
      unpaidDays = total - paidDays;
      deduction = unpaidDays * rate;
      if (input.leaveType === 'ANNUAL' && unpaidDays > 0 && !input.acceptUnpaidExtraDays) issue = 'EXCESS_NOT_ACCEPTED';
      break;
    }
    case 'UNPAID': {
      paidDays = 0;
      unpaidDays = total;
      deduction = unpaidDays * rate;
      if (balanceDays >= 1) issue = 'UNPAID_WITH_BALANCE';
      break;
    }
    case 'SICK': {
      sickTiers = computeSickLeaveTiers(input.pastSickDays ?? 0, total);
      paidDays = sickTiers.full + sickTiers.partial;
      unpaidDays = sickTiers.unpaid + sickTiers.beyond;
      deduction = sickTiers.partial * rate * (1 - SICK_LEAVE_TIERS.PARTIAL_PAY_RATIO) + unpaidDays * rate;
      if (sickTiers.beyond > 0) issue = 'SICK_LIMIT_EXCEEDED';
      break;
    }
    default: {
      paidDays = total;
      unpaidDays = 0;
    }
  }

  return {
    paidDays,
    unpaidDays,
    totalDeduction: input.waiveDeduction ? 0 : roundMoney(deduction),
    sickTiers,
    issue,
    entitlementDays,
  };
}

/**
 * Notes markers of statutory leaves (the Leave table has no dedicated columns): the date of the
 * triggering event and the bereavement relation, e.g. "[event:2026-05-01] [relation:SIBLING]".
 */
export const STATUTORY_NOTE_MARKERS = { EVENT: 'event', RELATION: 'relation' } as const;

export function buildStatutoryNoteMarkers(p: { eventDate?: string | null; bereavementRelation?: BereavementRelation | null }): string {
  const parts: string[] = [];
  if (p.eventDate) parts.push(`[${STATUTORY_NOTE_MARKERS.EVENT}:${p.eventDate}]`);
  if (p.bereavementRelation) parts.push(`[${STATUTORY_NOTE_MARKERS.RELATION}:${p.bereavementRelation}]`);
  return parts.join(' ');
}

/** Reads the markers written by buildStatutoryNoteMarkers (invalid values are ignored). */
export function parseStatutoryNoteMarkers(notes: string | null | undefined): { eventDate: string | null; bereavementRelation: BereavementRelation | null } {
  const s = notes ?? '';
  const ev = /\[event:(\d{4}-\d{2}-\d{2})\]/.exec(s);
  const rel = /\[relation:([A-Z_]+)\]/.exec(s);
  const relation = rel && (BEREAVEMENT_RELATIONS as readonly string[]).includes(rel[1]) ? (rel[1] as BereavementRelation) : null;
  return { eventDate: ev && dateKey(ev[1]) === ev[1] ? ev[1] : null, bereavementRelation: relation };
}

/** Removes the statutory markers (for display). */
export function stripStatutoryNoteMarkers(notes: string | null | undefined): string {
  return (notes ?? '').replace(/\s*\[(?:event|relation):[^\]]*\]/g, '').trim();
}

/** Employee daily wage used for leave deductions (basic salary / 30), rounded to halalas. */
export function dailyWage(basicSalary: number | null | undefined): number {
  return roundMoney((basicSalary ?? 0) / 30);
}

export interface LeaveMonthSplit {
  year: number;
  /** 1-12 */
  month: number;
  /** Leave days falling in this month. */
  days: number;
  /** Paid days in this month (paid days are allocated first, chronologically). */
  paidDays: number;
  unpaidDays: number;
}

/**
 * Splits an inclusive leave range by calendar month. Paid days are consumed first
 * (chronologically), the remaining days of the range are unpaid.
 */
export function splitLeaveDaysByMonth(startDate: Date | string, endDate: Date | string, paidDays?: number | null): LeaveMonthSplit[] {
  const start = toUtcDay(startDate);
  const end = toUtcDay(endDate);
  const total = inclusiveDays(start, end);
  if (!Number.isFinite(total) || total <= 0) return [];
  let paidLeft = Math.min(total, Math.max(0, paidDays ?? total));
  const out: LeaveMonthSplit[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  while (true) {
    const range = monthRange(y, m);
    const from = range.start.getTime() > start.getTime() ? range.start : start;
    const to = range.end.getTime() < end.getTime() ? range.end : end;
    if (from.getTime() > end.getTime()) break;
    const days = inclusiveDays(from, to);
    const paid = Math.min(days, paidLeft);
    paidLeft -= paid;
    out.push({ year: y, month: m, days, paidDays: paid, unpaidDays: days - paid });
    if (m === 12) {
      m = 1;
      y++;
    } else m++;
  }
  return out;
}

/**
 * Portion of a leave's totalDeduction that belongs to a payroll month, prorated by the
 * unpaid days falling in that month (or by all days when the deduction is not tied to
 * unpaid days, e.g. 75%-paid sick days).
 */
export function leaveDeductionForMonth(
  leave: { startDate: Date | string; endDate: Date | string; paidDays: number | null; unpaidDays: number | null; totalDeduction: number | null },
  year: number,
  month: number,
): number {
  const deduction = leave.totalDeduction ?? 0;
  if (deduction <= 0) return 0;
  const split = splitLeaveDaysByMonth(leave.startDate, leave.endDate, leave.paidDays);
  const row = split.find((s) => s.year === year && s.month === month);
  if (!row) return 0;
  const totalUnpaid = split.reduce((s, r) => s + r.unpaidDays, 0);
  if (totalUnpaid > 0) return roundMoney((deduction * row.unpaidDays) / totalUnpaid);
  const totalDays = split.reduce((s, r) => s + r.days, 0);
  return totalDays > 0 ? roundMoney((deduction * row.days) / totalDays) : 0;
}

export interface ShortenLeaveInput {
  leaveType: string;
  paidDays: number | null;
  unpaidDays: number | null;
  totalDeduction: number | null;
  dailyDeductionRate: number | null;
  /** New inclusive length of the leave (>= 1). */
  newTotalDays: number;
  /** SICK only: sick days taken in the 12 months before the leave. */
  pastSickDays?: number;
}

/**
 * Recalculates a leave that ends earlier than planned (early return / cancellation after it
 * started). Days are removed from the end, so unpaid days go first and paid days never grow.
 * A previously waived deduction stays waived.
 */
export function recalculateShortenedLeave(input: ShortenLeaveInput): { totalDays: number; paidDays: number; unpaidDays: number; totalDeduction: number } {
  const total = Math.max(0, Math.floor(input.newTotalDays));
  const rate = Math.max(0, input.dailyDeductionRate ?? 0);
  const wasWaived = (input.unpaidDays ?? 0) > 0 && !(input.totalDeduction ?? 0);
  if (input.leaveType === 'SICK') {
    const r = computeLeaveRequest({ leaveType: 'SICK', totalDays: total, availableBalance: 0, dailyRate: rate, pastSickDays: input.pastSickDays ?? 0, waiveDeduction: wasWaived || !(input.totalDeduction ?? 0) });
    return { totalDays: total, paidDays: r.paidDays, unpaidDays: r.unpaidDays, totalDeduction: r.totalDeduction };
  }
  const paidDays = Math.min(Math.max(0, input.paidDays ?? 0), total);
  const unpaidDays = total - paidDays;
  return { totalDays: total, paidDays, unpaidDays, totalDeduction: wasWaived ? 0 : roundMoney(unpaidDays * rate) };
}

/** True when two inclusive date ranges share at least one day. */
export function rangesOverlap(aStart: Date | string, aEnd: Date | string, bStart: Date | string, bEnd: Date | string): boolean {
  return daysBetween(aStart, bEnd) >= 0 && daysBetween(bStart, aEnd) >= 0;
}

/** Portal notes markers used by the self-service leave form. */
export const LEAVE_NOTE_MARKERS = { OUTSIDE: '[outside]', ACCEPT_EXCESS: '[ACCEPT_EXCESS]' } as const;
