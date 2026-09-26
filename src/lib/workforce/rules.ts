// Rules resolution for the workforce engine. PURE.
//
// Regulatory VALUES live in the RuleParameter table (dated, with source and status); this module picks
// the version in force at a date. A key that has no version in force resolves to a clearly flagged
// placeholder (status MISSING, value null): the engine then shows the line with amount 0 and a flag and
// never invents a legal value.
//
// FORMULAS that are fixed in the Labor Law text (art. 84/85 award, art. 109 leave days, art. 111 payout...)
// are code (src/lib/settlement.ts, src/lib/leave.ts). They are listed in LAW_REFERENCES so that
// "لماذا هذا الرقم؟" can show their source like any other rule.
import type { ResolvedRule, RuleEvidence, RuleRow, RuleSet, RuleVersionRef, WfStatus } from '@/lib/workforce/types';
import type { GosiRateRow } from '@/lib/workforce/types';

/** RuleParameter keys used by the engine (seeded by prisma/migrations/9_workforce_engine). */
export const RULE_KEYS = {
  GOSI_MAX_WAGE: 'GOSI_MAX_CONTRIBUTORY_WAGE',
  GOSI_MIN_WAGE_OLD: 'GOSI_MIN_CONTRIBUTORY_WAGE_OLD',
  GOSI_MIN_WAGE_NEW: 'GOSI_MIN_CONTRIBUTORY_WAGE_NEW',
  GOSI_IN_KIND_HOUSING_MONTHS: 'GOSI_IN_KIND_HOUSING_MONTHS',
  OT_PREMIUM_PCT: 'OVERTIME_PREMIUM_PCT_OF_BASIC',
  OT_ANNUAL_CAP: 'OVERTIME_ANNUAL_CAP_HOURS',
  NOTICE_EMPLOYER: 'NOTICE_DAYS_EMPLOYER',
  NOTICE_EMPLOYEE: 'NOTICE_DAYS_EMPLOYEE',
  ART77_DAYS: 'ART77_DAYS_PER_YEAR',
  ART77_MIN_MONTHS: 'ART77_MIN_MONTHS',
  ANNUAL_LEAVE: 'ANNUAL_LEAVE_DAYS',
  ANNUAL_LEAVE_5Y: 'ANNUAL_LEAVE_DAYS_AFTER_5Y',
  PROBATION_MAX: 'PROBATION_MAX_DAYS',
  MATERNITY_WEEKS: 'MATERNITY_WEEKS',
  LEVY_WITHIN: 'EXPAT_LEVY_WITHIN_SAUDI_COUNT',
  LEVY_ABOVE: 'EXPAT_LEVY_ABOVE_SAUDI_COUNT',
  INDUSTRIAL_LEVY_CANCELLED: 'INDUSTRIAL_LEVY_CANCELLED',
  SMALL_EST_MAX: 'SMALL_EST_MAX_WORKERS',
  SMALL_EST_OWNER: 'SMALL_EST_EXEMPT_OWNER_ONLY',
  SMALL_EST_SAUDI: 'SMALL_EST_EXEMPT_WITH_SAUDI',
  WORK_PERMIT_YEAR: 'WORK_PERMIT_FEE_YEAR',
  IQAMA_YEAR: 'IQAMA_FEE_YEAR',
  DEPENDENT_MONTH: 'DEPENDENT_FEE_MONTH',
  ERV_SINGLE: 'EXIT_REENTRY_SINGLE_BASE',
  ERV_SINGLE_EXTRA: 'EXIT_REENTRY_SINGLE_EXTRA_MONTH',
  ERV_MULTI: 'EXIT_REENTRY_MULTI_BASE',
  ERV_MULTI_EXTRA: 'EXIT_REENTRY_MULTI_EXTRA_MONTH',
  HRDF_BASE_PCT: 'HRDF_BASE_PCT',
  HRDF_BONUS_PCT: 'HRDF_BONUS_PCT_EACH',
  HRDF_CAP: 'HRDF_CAP_SAR',
  HRDF_CAP_PCT: 'HRDF_CAP_PCT_OF_WAGE',
  HRDF_MIN_WAGE: 'HRDF_MIN_WAGE',
  HRDF_MAX_WAGE: 'HRDF_MAX_WAGE',
  HRDF_MONTHS: 'HRDF_MONTHS',
} as const;

/** Arabic labels used when a key is MISSING from the table (the row label is used otherwise). */
const FALLBACK_LABELS: Record<string, string> = {
  GOSI_MAX_CONTRIBUTORY_WAGE: 'الحد الأعلى للأجر الخاضع للاشتراك',
  NOTICE_DAYS_EMPLOYER: 'مدة الإشعار عند إنهاء صاحب العمل',
  NOTICE_DAYS_EMPLOYEE: 'مدة الإشعار عند استقالة العامل',
  ART77_DAYS_PER_YEAR: 'تعويض الإنهاء غير المشروع (أيام عن كل سنة)',
  ART77_MIN_MONTHS: 'الحد الأدنى لتعويض الإنهاء غير المشروع',
  EXPAT_LEVY_WITHIN_SAUDI_COUNT: 'المقابل المالي للوافد ضمن عدد السعوديين',
  EXPAT_LEVY_ABOVE_SAUDI_COUNT: 'المقابل المالي للوافد الزائد عن عدد السعوديين',
  WORK_PERMIT_FEE_YEAR: 'رسوم رخصة العمل',
  IQAMA_FEE_YEAR: 'رسوم الإقامة',
  DEPENDENT_FEE_MONTH: 'رسوم المرافق',
  EXIT_REENTRY_SINGLE_BASE: 'تأشيرة خروج وعودة مفردة',
  HRDF_BASE_PCT: 'دعم التوظيف: النسبة الأساسية',
};

const LABOR_LAW_URL = 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1';

/**
 * Formulas fixed by the Labor Law text and implemented in code (not values in RuleParameter).
 * Pseudo keys 'LAW:…' so explanations can cite them.
 */
export const LAW_REFERENCES: Record<string, RuleEvidence> = {
  'LAW:ART84': {
    key: 'LAW:ART84',
    label: 'مكافأة نهاية الخدمة (المادة 84): نصف شهر عن كل سنة من الخمس الأولى، وشهر عن كل سنة بعدها',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: 'أجر نصف شهر عن كل سنة من السنوات الخمس الأولى، وأجر شهر عن كل سنة من السنوات التالية',
    effectiveFrom: null,
  },
  'LAW:ART85': {
    key: 'LAW:ART85',
    label: 'المكافأة عند الاستقالة (المادة 85): الثلث من 2 إلى 5 سنوات، الثلثان من 5 إلى 10، كاملة بعد 10',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'LAW:ART87': {
    key: 'LAW:ART87',
    label: 'المكافأة كاملة (المادة 87 والمادة 81 وانتهاء العقد): قراءة رديف بانتظار تأكيد المستشار',
    value: null,
    unit: null,
    status: 'PROVISIONAL',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'LAW:ART54_80': {
    key: 'LAW:ART54_80',
    label: 'لا مكافأة عند الإنهاء أثناء التجربة (المادة 54) أو الفصل بموجب المادة 80',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'LAW:ART109': {
    key: 'LAW:ART109',
    label: 'الإجازة السنوية (المادة 109): 21 يوماً، و30 بعد 5 سنوات متصلة',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: 'لا تقل مدتها عن واحد وعشرين يومًا، تزاد إلى ثلاثين يومًا إذا أمضى خمس سنوات متصلة',
    effectiveFrom: null,
  },
  'LAW:ART111': {
    key: 'LAW:ART111',
    label: 'صرف أجر الإجازة المستحقة عند انتهاء العلاقة (المادة 111)',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'LAW:ART76': {
    key: 'LAW:ART76',
    label: 'بدل الإشعار (المادة 76): أجر مدة الإشعار',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: LABOR_LAW_URL,
    sourceQuote: null,
    effectiveFrom: null,
  },
};

/** Normalizes a stored status string. Unknown values are treated as PROVISIONAL (never as verified). */
export function normalizeStatus(s: string | null | undefined): WfStatus {
  switch ((s ?? '').toUpperCase()) {
    case 'VERIFIED_PRIMARY':
    case 'CORROBORATED_SECONDARY':
    case 'PROVISIONAL':
    case 'CONFLICTING':
    case 'USER_INPUT':
    case 'MISSING':
    case 'DERIVED':
      return s!.toUpperCase() as WfStatus;
    default:
      return 'PROVISIONAL';
  }
}

/** Weakness order (lower = weaker). A line's status is the weakest of its inputs. */
const STATUS_RANK: Record<WfStatus, number> = {
  MISSING: 0,
  CONFLICTING: 1,
  PROVISIONAL: 2,
  USER_INPUT: 3,
  CORROBORATED_SECONDARY: 4,
  DERIVED: 5,
  VERIFIED_PRIMARY: 6,
};

export function weakestStatus(statuses: ReadonlyArray<WfStatus>, fallback: WfStatus = 'DERIVED'): WfStatus {
  let best: WfStatus | null = null;
  for (const s of statuses) if (best === null || STATUS_RANK[s] < STATUS_RANK[best]) best = s;
  return best ?? fallback;
}

function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Placeholder for a key with no version in force. */
export function missingRule(key: string): ResolvedRule {
  return {
    key,
    label: FALLBACK_LABELS[key] ?? key,
    value: null,
    valueJson: null,
    unit: null,
    status: 'MISSING',
    sourceUrl: null,
    sourceQuote: null,
    notes: 'لا توجد قيمة سارية لهذا المفتاح في سجل القواعد',
    effectiveFrom: null,
    effectiveTo: null,
  };
}

/** Rows grouped by key, sorted by effectiveFrom descending (pre-index once, resolve many times). */
export type RuleIndex = ReadonlyMap<string, ReadonlyArray<RuleRow>>;

export function indexRules(rows: ReadonlyArray<RuleRow>): RuleIndex {
  const map = new Map<string, RuleRow[]>();
  for (const r of rows) {
    if (!r || !r.key || !(r.effectiveFrom instanceof Date) || Number.isNaN(r.effectiveFrom.getTime())) continue;
    const list = map.get(r.key) ?? [];
    list.push(r);
    map.set(r.key, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return map;
}

function toResolved(r: RuleRow): ResolvedRule {
  return {
    key: r.key,
    label: r.label || FALLBACK_LABELS[r.key] || r.key,
    value: typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null,
    valueJson: parseJson(r.valueJson ?? null),
    unit: r.unit ?? null,
    status: normalizeStatus(r.status),
    sourceUrl: r.sourceUrl ?? null,
    sourceQuote: r.sourceQuote ?? null,
    notes: r.notes ?? null,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
  };
}

/**
 * key -> version in force at `date`: the latest effectiveFrom <= date whose effectiveTo is null or > date.
 * Accepts raw rows or an index from indexRules(). Keys in `expectKeys` without a version resolve to
 * missingRule(key); other absent keys are simply not in the map (use ruleOf() to read safely).
 */
export function resolveRules(rows: ReadonlyArray<RuleRow> | RuleIndex, date: Date, expectKeys: ReadonlyArray<string> = Object.values(RULE_KEYS)): RuleSet {
  const index: RuleIndex = rows instanceof Map ? (rows as RuleIndex) : indexRules(rows as ReadonlyArray<RuleRow>);
  const t = date.getTime();
  const out: Record<string, ResolvedRule> = {};
  for (const [key, list] of index) {
    for (const r of list) {
      if (r.effectiveFrom.getTime() > t) continue;
      if (r.effectiveTo && r.effectiveTo.getTime() <= t) continue;
      out[key] = toResolved(r);
      break;
    }
  }
  for (const k of expectKeys) if (!out[k]) out[k] = missingRule(k);
  return out;
}

/**
 * Rules for a projected month, with the same convention as the GOSI rates (DEC-003, pickGosiRate): the
 * version in force on the FIRST day of the month; when a key has no version on that day but one starts
 * later in the same month (e.g. INDUSTRIAL_LEVY_CANCELLED on 2025-12-17), that version is used for the
 * whole month. A new version replacing an older one mid-month applies from the next month.
 */
export function resolveRulesForMonth(index: RuleIndex, year: number, month: number, expectKeys: ReadonlyArray<string> = Object.values(RULE_KEYS)): RuleSet {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = Date.UTC(year, month, 0);
  const out = { ...resolveRules(index, first, []) } as Record<string, ResolvedRule>;
  for (const [key, list] of index) {
    if (out[key]) continue;
    let starting: RuleRow | null = null;
    for (const r of list) {
      const t = r.effectiveFrom.getTime();
      if (t > first.getTime() && t <= last && (!starting || t < starting.effectiveFrom.getTime())) starting = r;
    }
    if (starting) out[key] = toResolved(starting);
  }
  for (const k of expectKeys) if (!out[k]) out[k] = missingRule(k);
  return out;
}

/** Safe read: the resolved rule or a MISSING placeholder. */
export function ruleOf(rules: RuleSet, key: string): ResolvedRule {
  return rules[key] ?? missingRule(key);
}

/** Numeric value of a rule (null when MISSING / not numeric). */
export function ruleValue(rules: RuleSet, key: string): number | null {
  const r = rules[key];
  return r && r.status !== 'MISSING' && typeof r.value === 'number' ? r.value : null;
}

export function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function ruleEvidence(r: ResolvedRule): RuleEvidence {
  return {
    key: r.key,
    label: r.label,
    value: r.value,
    unit: r.unit,
    status: r.status,
    sourceUrl: r.sourceUrl,
    sourceQuote: r.sourceQuote,
    effectiveFrom: ymd(r.effectiveFrom),
  };
}

/** Pseudo key of a GosiRate row, e.g. 'GOSI_RATE:NEW:SA:2026-07-01'. */
export function gosiRateKey(r: { regime: string; isSaudi: boolean; effectiveFrom: Date }): string {
  return `GOSI_RATE:${r.regime}:${r.isSaudi ? 'SA' : 'NON_SA'}:${ymd(r.effectiveFrom)}`;
}

export function gosiRateEvidence(r: GosiRateRow): RuleEvidence {
  return {
    key: gosiRateKey({ regime: String(r.regime), isSaudi: r.isSaudi, effectiveFrom: r.effectiveFrom }),
    label: `نسبة التأمينات على صاحب العمل (${r.regime === 'NEW' ? 'النظام الجديد' : 'النظام القديم'}، ${r.isSaudi ? 'سعودي' : 'غير سعودي'})`,
    value: r.employerRate,
    unit: 'PERCENT',
    status: r.isProvisional ? 'PROVISIONAL' : 'VERIFIED_PRIMARY',
    sourceUrl: null,
    sourceQuote: r.source ?? null,
    effectiveFrom: ymd(r.effectiveFrom),
  };
}

const ruleIds = new WeakMap<ResolvedRule, string>();
const gosiIds = new WeakMap<object, string>();

/** Collects the exact rule versions used (deduplicated, sorted) for snapshots. */
export class RuleUsage {
  private readonly used = new Map<string, RuleVersionRef>();
  private readonly evidence = new Map<string, RuleEvidence>();
  private readonly seen = new WeakSet<ResolvedRule>();

  rule(r: ResolvedRule): string {
    if (this.seen.has(r)) return r.key;
    this.seen.add(r);
    const id = RuleUsage.id(r);
    if (!this.used.has(id)) {
      this.used.set(id, { key: r.key, effectiveFrom: ymd(r.effectiveFrom), status: r.status, value: r.value });
      this.evidence.set(id, ruleEvidence(r));
    }
    return r.key;
  }

  gosi(r: GosiRateRow): string {
    let key = gosiIds.get(r);
    if (key !== undefined && this.used.has(key)) return key;
    if (key === undefined) {
      key = gosiRateKey({ regime: String(r.regime), isSaudi: r.isSaudi, effectiveFrom: r.effectiveFrom });
      gosiIds.set(r, key);
    }
    if (!this.used.has(key)) {
      const ev = gosiRateEvidence(r);
      this.used.set(key, { key, effectiveFrom: ev.effectiveFrom, status: ev.status, value: r.employerRate });
      this.evidence.set(key, ev);
    }
    return key;
  }

  law(key: string): string {
    const ev = LAW_REFERENCES[key];
    if (ev && !this.used.has(key)) {
      this.used.set(key, { key, effectiveFrom: null, status: ev.status, value: null });
      this.evidence.set(key, ev);
    }
    return key;
  }

  /** Evidence by id ('KEY@date' for rules, the pseudo key otherwise). */
  evidenceFor(ids: Iterable<string>): RuleEvidence[] {
    const out: RuleEvidence[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const ev = this.evidence.get(id);
      if (ev) out.push(ev);
    }
    return out;
  }

  refs(): RuleVersionRef[] {
    return [...this.used.values()].sort((a, b) => (a.key === b.key ? String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)) : a.key.localeCompare(b.key)));
  }

  /** Id used by evidenceFor() for a resolved rule ('KEY@YYYY-MM-DD'), cached per rule object. */
  static id(r: ResolvedRule): string {
    let id = ruleIds.get(r);
    if (id === undefined) {
      id = `${r.key}@${ymd(r.effectiveFrom) ?? 'MISSING'}`;
      ruleIds.set(r, id);
    }
    return id;
  }
}
