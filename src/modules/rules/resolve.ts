// Pure resolution of regulatory values (P1-RULE): picks the version in force on a day, layers a
// company override on top within the key's legal bound, and assembles the typed law bundles the pure
// payroll / leave / settlement helpers take as parameters. No database access here (queries.ts reads).
import { RULE_CATALOGUE, type RuleBound, type RuleDef, type RuleSourceStatus } from './catalogue';

export type RuleKey = (typeof RULE_CATALOGUE)[number]['key'];

const BY_KEY: ReadonlyMap<string, RuleDef> = new Map(RULE_CATALOGUE.map((d) => [d.key, d]));

export class UnknownRuleKeyError extends Error {
  constructor(key: string) {
    super(`unknown rule key "${key}" (not in src/modules/rules/catalogue.ts)`);
    this.name = 'UnknownRuleKeyError';
  }
}

export class RuleOverrideBoundError extends Error {
  constructor(
    readonly key: string,
    readonly bound: RuleBound,
    readonly value: number,
    readonly legalValue: number | null,
    readonly legalFrom: string | null,
  ) {
    super(
      bound === 'FIXED'
        ? `rule ${key} cannot be overridden by a company`
        : `override ${value} of ${key} is ${bound === 'MIN' ? 'below the legal minimum' : 'above the legal maximum'} ${legalValue} (in force from ${legalFrom})`,
    );
    this.name = 'RuleOverrideBoundError';
  }
}

/**
 * DEC-PO-126: the value is outside the legal bound of a MIN / MAX key. It is not refused for good: the
 * caller may accept it by passing an explicit acknowledgement with a reason. The UI shows `messageAr`
 * (the legal value and what accepting means) and asks for that acknowledgement. FIXED keys throw the
 * plain RuleOverrideBoundError (no acknowledgement can accept them).
 */
export class RuleOverrideAckRequiredError extends RuleOverrideBoundError {
  readonly code = 'RULE_OVERRIDE_BELOW_LEGAL_ACK_REQUIRED';
  readonly requiresAcknowledgement = true;
  readonly messageAr: string;
  constructor(key: string, bound: 'MIN' | 'MAX', value: number, legalValue: number, legalFrom: string) {
    super(key, bound, value, legalValue, legalFrom);
    this.message += '; accept it only with acknowledgeBelowLegal and a reason (DEC-PO-126)';
    this.name = 'RuleOverrideAckRequiredError';
    this.messageAr =
      bound === 'MIN'
        ? `القيمة ${value} أقل من الحد النظامي الأدنى ${legalValue} (النافذ من ${legalFrom}). يمكن اعتمادها بإقرار صريح وسبب، وستظهر كتحذير أينما استُخدمت ويُبلَّغ بها المالك.`
        : `القيمة ${value} أعلى من الحد النظامي الأعلى ${legalValue} (النافذ من ${legalFrom}). يمكن اعتمادها بإقرار صريح وسبب، وستظهر كتحذير أينما استُخدمت ويُبلَّغ بها المالك.`;
  }
}

export function ruleDef(key: string): RuleDef {
  const d = BY_KEY.get(key);
  if (!d) throw new UnknownRuleKeyError(key);
  return d;
}

export function isRuleKey(key: string): key is RuleKey {
  return BY_KEY.has(key);
}

/** 'YYYY-MM-DD' of a Date (UTC) or a date string. */
export function dayKey(d: Date | string): string {
  if (typeof d === 'string') {
    const k = d.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) throw new Error(`invalid date "${d}"`);
    return k;
  }
  if (Number.isNaN(d.getTime())) throw new Error('invalid date');
  return d.toISOString().slice(0, 10);
}

/** A dated version of a legal value (a RuleParameter row or a catalogue version). */
export interface LegalVersion {
  id: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  value: number | null;
  status: RuleSourceStatus | string;
  sourceUrl: string | null;
}

/** A company override row (CompanyRuleOverride). */
export interface OverrideVersion {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  value: number;
  revoked: boolean;
  /** DEC-PO-126: the company acknowledged that this value is outside the legal bound. */
  belowLegalAck?: boolean;
}

export interface ResolvedRuleValue {
  key: string;
  /** The value to use: the override when there is one (kept within the bound), else the legal value. */
  value: number;
  /** The legal value in force (registry or catalogue). */
  legalValue: number;
  source: 'OVERRIDE' | 'REGISTRY' | 'CATALOGUE';
  status: string;
  sourceUrl: string | null;
  /** The legal version applied ('YYYY-MM-DD'). */
  legalFrom: string;
  ruleParameterId: string | null;
  overrideId: string | null;
  /**
   * The day is before the first known version: the earliest version is applied (what the code did
   * before P1-RULE, when one constant served every date). Callers may flag it.
   */
  beforeFirstVersion: boolean;
  /** An override that the legal value in force now contradicts was held at the legal bound. */
  clamped: boolean;
  /**
   * DEC-PO-126: the value used is an acknowledged override outside the legal bound (below a MIN floor,
   * above a MAX ceiling). Pay, leave and settlement screens show a warning when it is true.
   */
  belowLegal: boolean;
}

function covers(v: { effectiveFrom: string; effectiveTo: string | null }, day: string): boolean {
  return v.effectiveFrom <= day && (v.effectiveTo === null || v.effectiveTo > day);
}

/** The version in force on `day` (latest start wins), else the earliest version (flagged). */
export function pickVersion<T extends { effectiveFrom: string; effectiveTo: string | null }>(versions: readonly T[], day: string): { version: T; beforeFirst: boolean } | null {
  const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let hit: T | null = null;
  for (const v of sorted) if (covers(v, day)) hit = v;
  if (hit) return { version: hit, beforeFirst: false };
  if (sorted.length && day < sorted[0].effectiveFrom) return { version: sorted[0], beforeFirst: true };
  return null;
}

/** Catalogue versions as LegalVersions (each one ends where the next starts). */
export function catalogueVersions(key: string): LegalVersion[] {
  const d = ruleDef(key);
  return d.versions.map((v, i) => ({
    id: null,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: d.versions[i + 1]?.effectiveFrom ?? null,
    value: v.value,
    status: v.status,
    sourceUrl: v.sourceUrl,
  }));
}

/** True when `value` respects the key's bound against `legal`. */
export function withinBound(bound: RuleBound, value: number, legal: number): boolean {
  if (bound === 'MIN') return value >= legal;
  if (bound === 'MAX') return value <= legal;
  return bound === 'FREE';
}

/**
 * Resolves `key` on `day`: registry rows when there are any (they are the source of truth), else
 * the catalogue; then the company override in force, held at the bound if the law moved past it.
 */
export function resolveRule(key: string, day: Date | string, registry: readonly LegalVersion[], overrides: readonly OverrideVersion[] = []): ResolvedRuleValue {
  const d = ruleDef(key);
  const k = dayKey(day);
  const usable = registry.filter((r) => r.value !== null && Number.isFinite(r.value));
  const fromRegistry = usable.length > 0;
  const picked = pickVersion(fromRegistry ? usable : catalogueVersions(key), k);
  if (!picked) throw new Error(`rule ${key} has no version`);
  const legal = picked.version;
  const legalValue = legal.value as number;
  const base: ResolvedRuleValue = {
    key,
    value: legalValue,
    legalValue,
    source: fromRegistry ? 'REGISTRY' : 'CATALOGUE',
    status: String(legal.status),
    sourceUrl: legal.sourceUrl,
    legalFrom: legal.effectiveFrom,
    ruleParameterId: legal.id,
    overrideId: null,
    beforeFirstVersion: picked.beforeFirst,
    clamped: false,
    belowLegal: false,
  };
  if (d.bound === 'FIXED') return base;
  const ov = overrides.filter((o) => !o.revoked && covers(o, k)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (!ov) return base;
  const ok = withinBound(d.bound, ov.value, legalValue);
  // DEC-PO-126: an acknowledged override outside the bound is used as set and flagged; without an
  // acknowledgement (the law moved past it later) it is held at the bound.
  if (!ok && ov.belowLegalAck) return { ...base, value: ov.value, source: 'OVERRIDE', overrideId: ov.id, belowLegal: true };
  return { ...base, value: ok ? ov.value : legalValue, source: 'OVERRIDE', overrideId: ov.id, clamped: !ok };
}

/** The legal version a proposed override departs from (the most restrictive one it breaches). */
export interface OverrideBoundBreach {
  bound: 'MIN' | 'MAX';
  legalValue: number;
  legalFrom: string;
}

/**
 * Checks a proposed override against every legal version it would overlap ([from, to)). Throws
 * RuleOverrideBoundError on a FIXED key or a non-finite value (never acceptable); returns the breach
 * when the value is outside the bound of a MIN / MAX key (acceptable only with an acknowledgement,
 * DEC-PO-126), else null.
 */
export function overrideBoundBreach(key: string, value: number, from: string, to: string | null, registry: readonly LegalVersion[]): OverrideBoundBreach | null {
  const d = ruleDef(key);
  if (!Number.isFinite(value)) throw new RuleOverrideBoundError(key, d.bound, value, null, null);
  if (d.bound === 'FIXED') throw new RuleOverrideBoundError(key, 'FIXED', value, null, null);
  if (d.bound === 'FREE') return null;
  const bound = d.bound;
  const usable = registry.filter((r) => r.value !== null && Number.isFinite(r.value));
  const versions = usable.length ? usable : catalogueVersions(key);
  const first = pickVersion(versions, from);
  const overlapping = versions.filter((v) => (to === null || v.effectiveFrom < to) && (v.effectiveTo === null || v.effectiveTo > from));
  if (first) overlapping.push(first.version);
  let worst: OverrideBoundBreach | null = null;
  for (const v of overlapping) {
    const legal = v.value as number;
    if (withinBound(bound, value, legal)) continue;
    const stricter = !worst || (bound === 'MIN' ? legal > worst.legalValue : legal < worst.legalValue);
    if (stricter) worst = { bound, legalValue: legal, legalFrom: v.effectiveFrom };
  }
  return worst;
}

/**
 * Checks a proposed override without an acknowledgement: throws RuleOverrideBoundError on a FIXED
 * key, RuleOverrideAckRequiredError on a value outside the bound (DEC-PO-126).
 */
export function assertOverrideAllowed(key: string, value: number, from: string, to: string | null, registry: readonly LegalVersion[]): void {
  const breach = overrideBoundBreach(key, value, from, to, registry);
  if (breach) throw new RuleOverrideAckRequiredError(key, breach.bound, value, breach.legalValue, breach.legalFrom);
}

// ---------------------------------------------------------------------------
// Typed law bundles for the pure helpers (leave, payroll, settlement, termination, employee)
// ---------------------------------------------------------------------------

export interface AnnualLeaveLaw {
  /** Days per year before the threshold (art. 109: 21). */
  daysBeforeThreshold: number;
  /** Days per year from the threshold on (art. 109: 30). */
  daysFromThreshold: number;
  /** Completed years of continuous service for the higher entitlement (art. 109: 5). */
  thresholdYears: number;
}

export interface SickLeaveLaw {
  /** Cumulative sick days in a year paid in full (art. 117: 30). */
  fullPayDays: number;
  /** Last cumulative day paid at partialPayRatio (art. 117: 90). */
  partialPayUntilDay: number;
  /** Last cumulative unpaid day within the yearly entitlement (art. 117: 120). */
  unpaidUntilDay: number;
  /** Share of the wage paid in the second tier (art. 117: three quarters). */
  partialPayRatio: number;
}

export interface EosLaw {
  firstPeriodYears: number;
  firstPeriodMonthsPerYear: number;
  laterMonthsPerYear: number;
  resignationNoneBelowYears: number;
  resignationThirdBelowYears: number;
  resignationTwoThirdsBelowYears: number;
}

export interface NoticeLaw {
  employerDays: number;
  employeeDays: number;
}

export interface ProbationLaw {
  maxDays: number;
}

export interface OvertimeLaw {
  premiumPctOfBasic: number;
  annualCapHours: number;
}

export interface WorkHoursLaw {
  perDayMax: number;
  perWeekMax: number;
  ramadanPerDayMax: number;
  ramadanPerWeekMax: number;
}

export interface StatutoryLeaveLaw {
  maternityWeeks: number;
  maternityUnpaidExtensionDays: number;
  paternityDays: number;
  paternityWindowDays: number;
  marriageDays: number;
  bereavementDays: number;
  bereavementSiblingDays: number;
  hajjMinDays: number;
  hajjMaxDays: number;
  hajjMinServiceYears: number;
}

export interface LaborLaw {
  annualLeave: AnnualLeaveLaw;
  sickLeave: SickLeaveLaw;
  eos: EosLaw;
  notice: NoticeLaw;
  probation: ProbationLaw;
  overtime: OvertimeLaw;
  workHours: WorkHoursLaw;
  statutoryLeave: StatutoryLeaveLaw;
}

/** The keys a LaborLaw is assembled from. */
export const LABOR_LAW_KEYS = [
  'ANNUAL_LEAVE_DAYS', 'ANNUAL_LEAVE_DAYS_AFTER_5Y', 'ANNUAL_LEAVE_HIGHER_AFTER_YEARS',
  'SICK_LEAVE_FULL_PAY_DAYS', 'SICK_LEAVE_PARTIAL_PAY_UNTIL_DAY', 'SICK_LEAVE_UNPAID_UNTIL_DAY', 'SICK_LEAVE_PARTIAL_PAY_PCT',
  'EOS_FIRST_PERIOD_YEARS', 'EOS_MONTHS_PER_YEAR_FIRST_PERIOD', 'EOS_MONTHS_PER_YEAR_AFTER',
  'EOS_RESIGNATION_NONE_BELOW_YEARS', 'EOS_RESIGNATION_THIRD_BELOW_YEARS', 'EOS_RESIGNATION_TWO_THIRDS_BELOW_YEARS',
  'NOTICE_DAYS_EMPLOYER', 'NOTICE_DAYS_EMPLOYEE', 'PROBATION_MAX_DAYS',
  'OVERTIME_PREMIUM_PCT_OF_BASIC', 'OVERTIME_ANNUAL_CAP_HOURS',
  'WORK_HOURS_PER_DAY_MAX', 'WORK_HOURS_PER_WEEK_MAX', 'RAMADAN_WORK_HOURS_PER_DAY_MAX', 'RAMADAN_WORK_HOURS_PER_WEEK_MAX',
  'MATERNITY_WEEKS', 'MATERNITY_UNPAID_EXTENSION_DAYS', 'PATERNITY_DAYS', 'PATERNITY_WINDOW_DAYS', 'MARRIAGE_LEAVE_DAYS',
  'BEREAVEMENT_DAYS', 'BEREAVEMENT_SIBLING_DAYS', 'HAJJ_LEAVE_MIN_DAYS', 'HAJJ_LEAVE_MAX_DAYS', 'HAJJ_MIN_SERVICE_YEARS',
] as const satisfies readonly RuleKey[];

export type LaborLawKey = (typeof LABOR_LAW_KEYS)[number];

/** Builds the bundle from one value per key. */
export function laborLawFromValues(v: (key: LaborLawKey) => number): LaborLaw {
  return {
    annualLeave: { daysBeforeThreshold: v('ANNUAL_LEAVE_DAYS'), daysFromThreshold: v('ANNUAL_LEAVE_DAYS_AFTER_5Y'), thresholdYears: v('ANNUAL_LEAVE_HIGHER_AFTER_YEARS') },
    sickLeave: {
      fullPayDays: v('SICK_LEAVE_FULL_PAY_DAYS'),
      partialPayUntilDay: v('SICK_LEAVE_PARTIAL_PAY_UNTIL_DAY'),
      unpaidUntilDay: v('SICK_LEAVE_UNPAID_UNTIL_DAY'),
      partialPayRatio: v('SICK_LEAVE_PARTIAL_PAY_PCT') / 100,
    },
    eos: {
      firstPeriodYears: v('EOS_FIRST_PERIOD_YEARS'),
      firstPeriodMonthsPerYear: v('EOS_MONTHS_PER_YEAR_FIRST_PERIOD'),
      laterMonthsPerYear: v('EOS_MONTHS_PER_YEAR_AFTER'),
      resignationNoneBelowYears: v('EOS_RESIGNATION_NONE_BELOW_YEARS'),
      resignationThirdBelowYears: v('EOS_RESIGNATION_THIRD_BELOW_YEARS'),
      resignationTwoThirdsBelowYears: v('EOS_RESIGNATION_TWO_THIRDS_BELOW_YEARS'),
    },
    notice: { employerDays: v('NOTICE_DAYS_EMPLOYER'), employeeDays: v('NOTICE_DAYS_EMPLOYEE') },
    probation: { maxDays: v('PROBATION_MAX_DAYS') },
    overtime: { premiumPctOfBasic: v('OVERTIME_PREMIUM_PCT_OF_BASIC'), annualCapHours: v('OVERTIME_ANNUAL_CAP_HOURS') },
    workHours: {
      perDayMax: v('WORK_HOURS_PER_DAY_MAX'),
      perWeekMax: v('WORK_HOURS_PER_WEEK_MAX'),
      ramadanPerDayMax: v('RAMADAN_WORK_HOURS_PER_DAY_MAX'),
      ramadanPerWeekMax: v('RAMADAN_WORK_HOURS_PER_WEEK_MAX'),
    },
    statutoryLeave: {
      maternityWeeks: v('MATERNITY_WEEKS'),
      maternityUnpaidExtensionDays: v('MATERNITY_UNPAID_EXTENSION_DAYS'),
      paternityDays: v('PATERNITY_DAYS'),
      paternityWindowDays: v('PATERNITY_WINDOW_DAYS'),
      marriageDays: v('MARRIAGE_LEAVE_DAYS'),
      bereavementDays: v('BEREAVEMENT_DAYS'),
      bereavementSiblingDays: v('BEREAVEMENT_SIBLING_DAYS'),
      hajjMinDays: v('HAJJ_LEAVE_MIN_DAYS'),
      hajjMaxDays: v('HAJJ_LEAVE_MAX_DAYS'),
      hajjMinServiceYears: v('HAJJ_MIN_SERVICE_YEARS'),
    },
  };
}

/** The legal value of `key` on `day` from the catalogue alone (no registry, no override). */
export function catalogueValueAt(key: RuleKey, day: Date | string = new Date()): number {
  return resolveRule(key, day, []).value;
}

/**
 * The labour-law bundle on `day` from the catalogue alone. It is the default of the pure helpers
 * (previews, tests); operational server code passes `rules.laborLawFor(db, companyId, day)`, which
 * reads the registry and the company override.
 */
export function catalogueLaborLaw(day: Date | string = new Date()): LaborLaw {
  return laborLawFromValues((k) => catalogueValueAt(k, day));
}

/** The OVERTIME_PREMIUM as a pay multiplier (50% -> 1.5). */
export function overtimeMultiplierOf(law: OvertimeLaw): number {
  return 1 + law.premiumPctOfBasic / 100;
}
