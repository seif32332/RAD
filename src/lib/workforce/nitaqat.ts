// Nitaqat Mutawar 2026 estimate («نطاقات المطوّر»). PURE, deterministic, client-safe.
// SPEC §2.4. The official reference is always the Qiwa platform: this is an estimate for planning.
//
// Decisions and assumptions (each one is also returned in `assumptions` / `evidence` so «لماذا؟» shows it):
// - Wage used for the weights = the wage registered in GOSI = contributory wage (basic + cash housing,
//   formulas.ts contributoryWage, NOT capped at 45,000). Qiwa counts the wage registered in GOSI.
//   Status PROVISIONAL (the guide says «الأجر»; GOSI registration is how Qiwa reads it).
// - Weights (qiwa.sa, last modified 10/09/2026): Saudi < 3,000 -> 0; 3,000–3,999 -> 0.5; >= 4,000 -> 1;
//   disabled -> 4 (wage >= 4,000 and, for an entity of 50+ workers, a valid Muawama certificate on the
//   date; otherwise weight 1, as Qiwa states); student -> 0.5 (wage >= 2,000, else 0); part-time -> 0.5;
//   GCC national -> 1 on the Saudi side (never an expat).
//   Expats count 1 on the non-Saudi side. Released prisoners, social investment, flexible work, Ajeer
//   guards, remote work, displaced tribes, children of Saudi mothers, the owner and spouses of expats have
//   no data in Radeef: NOT modelled (flag CATEGORIES_NOT_MODELLED / OWNER_NOT_MODELLED).
// - Documentation gate: from 2026-04-15 (Council of Ministers decision 195) only contracts documented in
//   Qiwa count. An undocumented Saudi / GCC national counts 0, is left out of X, and is listed in the
//   UNDOCUMENTED_QIWA alert with the weight documenting would add (zero-cost action). Expats are counted
//   whatever their documentation status (the conservative side for the percentage).
// - Caps (generic table, capRules()): disabled 20% of Saudis (entity < 50) else 10%; students 10% (40% for
//   a retail / wholesale activity = activity code 460 on Qiwa); released 10%; disabled + released + students together 15% (40%
//   retail); GCC 10%; GCC + the other special categories together 15%. Cap base = number of counted Saudi
//   nationals (documented, head count, unweighted); a cap allows floor(pct × base) persons (PROVISIONAL).
//   Admission is greedy and deterministic: persons with the largest weight gain first, then by id; a
//   person must fit EVERY cap containing its category (i.e. the stricter cap applies). When a combined
//   cap refuses a person that the category's own cap would have admitted, the flag CAP_INTERPRETATION
//   says so (the guide does not say which cap applies first). A person over a cap counts as a regular
//   Saudi by wage (a disabled person: 1; GCC nationals: 0).
// - X (entity size in Y = m·ln(X) + c) = persons counted: documented Saudi-side persons (weight 0
//   included) + expats, unweighted (PROVISIONAL until confirmed by the rules file).
// - Saudization % = weighted Saudi side ÷ (weighted Saudi side + expats) × 100 (SPEC formula).
// - Bands: Y_band = m·ln(X) + c (natural log) with the curve of the activity for the calendar year of the
//   date; the constants of a year are assumed to apply from 1 January (the guide gives no switch-over
//   date: PROVISIONAL); years after the last curve year use the last year («3 سنوات وما بعدها», flag
//   YEAR_BEYOND_TABLE). No cap and no rounding on Y or on the percentage (guide p6); a band runs from its
//   threshold (inclusive) to the next band's threshold (exclusive).
//   X <= 5: LOW_GREEN when the weighted Saudi side >= 1, else RED (no other band).
// - The point-in-time estimate uses the employees active on the date; the 26-week average (Qiwa's
//   window) is shown next to it from weekly snapshots of the same data.
import { mentionsSaudiAmbiguously, nationalityClass, normalizeNationalityKey, type NationalityClass } from '@/lib/nationality';
import { contributoryWage, isFullTime } from '@/lib/workforce/formulas';
import { normalizeStatus, weakestStatus } from '@/lib/workforce/rules';
import type { RuleEvidence, WfEmployeeInput, WfStatus } from '@/lib/workforce/types';

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Bands, curves, consequences
// ---------------------------------------------------------------------------

export const NITAQAT_BANDS = ['RED', 'LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const;
export type NitaqatBand = (typeof NITAQAT_BANDS)[number];
/** Bands that have a curve (RED = below LOW_GREEN). */
export const CURVE_BANDS = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const;
export type CurveBand = (typeof CURVE_BANDS)[number];
/** Years with published constants (the phase from 26 April 2026 for three years). */
export const CURVE_YEARS = [2026, 2027, 2028] as const;

export const BAND_LABELS: Record<NitaqatBand, string> = {
  RED: 'أحمر',
  LOW_GREEN: 'أخضر منخفض',
  MEDIUM_GREEN: 'أخضر متوسط',
  HIGH_GREEN: 'أخضر مرتفع',
  PLATINUM: 'بلاتيني',
};

export function bandRank(b: NitaqatBand): number {
  return NITAQAT_BANDS.indexOf(b);
}

export function isNitaqatBand(v: unknown): v is NitaqatBand {
  return typeof v === 'string' && (NITAQAT_BANDS as ReadonlyArray<string>).includes(v);
}

export function isCurveBand(v: unknown): v is CurveBand {
  return typeof v === 'string' && (CURVE_BANDS as ReadonlyArray<string>).includes(v);
}

const GREEN_UP_ITEMS = [
  'استقبال طلبات رصيد التأشيرات للمهن المتاحة',
  'تغيير مهن العمالة الوافدة للمهن المتاحة (مع متطلبات تغيير المهنة)',
  'تجديد رخص العمل للعمالة الوافدة بشرط ألا يزيد المتبقي في الإقامة عن ستة أشهر عند التجديد',
  'نقل خدمات العمالة الوافدة من أي نطاق (مع ضوابط الخدمة)',
  'الاحتساب الفوري في برنامج نطاقات',
];

/** SPEC §2.4 «آثار النطاقات» (guide pp. 7–8, printed 6–7). */
export const BAND_CONSEQUENCES: Record<NitaqatBand, { items: string[]; conflict?: string }> = {
  PLATINUM: { items: GREEN_UP_ITEMS },
  HIGH_GREEN: { items: GREEN_UP_ITEMS },
  MEDIUM_GREEN: { items: GREEN_UP_ITEMS },
  LOW_GREEN: {
    items: [
      'إيقاف استقبال طلبات التأشيرات الجديدة',
      'إيقاف استقبال طلبات تغيير مهن العمالة الوافدة',
      'تجديد رخص العمل للعمالة الوافدة بشرط ألا يزيد المتبقي في الإقامة عن ستة أشهر (حسب الدليل)',
      'الاحتساب الفوري في برنامج نطاقات',
    ],
    conflict: 'متعارض: الدليل يسمح للأخضر المنخفض بتجديد رخص العمل، وقوى (10/09/2026) تقول إن التجديد والتأشيرات والنقل وتغيير المهنة «من الأخضر المتوسط فأعلى». والدليل لا يذكر نقل الخدمات إلى الأخضر المنخفض. راجع قوى قبل الاعتماد.',
  },
  RED: {
    items: [
      'عدم السماح بتغيير مهن العمالة الوافدة',
      'عدم السماح بنقل خدمات العمالة الوافدة إليها',
      'عدم السماح بطلب تأشيرات جديدة',
      'عدم السماح بإصدار رخص عمل للعمالة الوافدة الجديدة',
      'عدم السماح بتجديد رخص العمل للعمالة الوافدة',
    ],
    conflict: 'قوى تضيف: لا يُسمح بفتح ملف فرع أو منشأة جديدة (غير مذكور في الدليل).',
  },
};

/** A NitaqatActivity row (Prisma; extra columns ignored). */
export interface NitaqatActivityRow {
  key: string;
  nameAr: string;
  code?: string | null;
  sizeSegment?: string | null;
  status: string;
  sourceUrl?: string | null;
  page?: number | null;
  notes?: string | null;
}

/** A NitaqatCurve row (Prisma; extra columns ignored). */
export interface NitaqatCurveRow {
  activityKey: string;
  band: string;
  year: number;
  m: number;
  c: number;
  status: string;
  sourceUrl?: string | null;
  page?: number | null;
  note?: string | null;
}

/** Stored statuses of the register (NitaqatActivity / NitaqatCurve). AMBIGUOUS = needs matching with the annex. */
export const NITAQAT_ROW_STATUSES = ['VERIFIED_PRIMARY', 'AMBIGUOUS', 'PROVISIONAL', 'USER_INPUT'] as const;
export type NitaqatRowStatus = (typeof NITAQAT_ROW_STATUSES)[number];

/** Register status -> evidence status (AMBIGUOUS is shown apart as «يحتاج مطابقة مع ملحق الدليل»). */
export function curveEvidenceStatus(s: string | null | undefined): WfStatus {
  return (s ?? '').toUpperCase() === 'AMBIGUOUS' ? 'CONFLICTING' : normalizeStatus(s);
}

export const AMBIGUOUS_LABEL = 'يحتاج مطابقة مع ملحق الدليل';

/** Y = m·ln(X) + c (natural log). */
export function bandThreshold(m: number, c: number, x: number): number {
  return m * Math.log(Math.max(x, 1)) + c;
}

export interface CurveSet {
  /** Calendar year of the date. */
  year: number;
  /** Year whose constants are used (clamped into the curve years available). */
  curveYear: number | null;
  byBand: Partial<Record<CurveBand, NitaqatCurveRow>>;
  missingBands: CurveBand[];
}

/** Curve rows of the activity for `year`; years outside the available range use the nearest year. */
export function curveSetFor(curves: ReadonlyArray<NitaqatCurveRow>, activityKey: string, year: number): CurveSet {
  const rows = curves.filter((c) => c.activityKey === activityKey && isCurveBand(c.band) && Number.isFinite(c.m) && Number.isFinite(c.c));
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  if (!years.length) return { year, curveYear: null, byBand: {}, missingBands: [...CURVE_BANDS] };
  let curveYear = years[0];
  for (const y of years) if (y <= year) curveYear = y;
  const byBand: Partial<Record<CurveBand, NitaqatCurveRow>> = {};
  for (const r of rows) if (r.year === curveYear) byBand[r.band as CurveBand] = r;
  return { year, curveYear, byBand, missingBands: CURVE_BANDS.filter((b) => !byBand[b]) };
}

/** Band of weighted counts. X <= 5: LOW_GREEN with a weighted Saudi side >= 1, else RED. */
export function bandForCounts(saudiWeighted: number, expats: number, x: number, set: CurveSet): { band: NitaqatBand; pct: number; small: boolean } {
  const denom = saudiWeighted + expats;
  const pct = denom > 0 ? (saudiWeighted / denom) * 100 : 0;
  if (x <= SMALL_ENTITY_MAX) return { band: saudiWeighted >= 1 - 1e-9 ? 'LOW_GREEN' : 'RED', pct, small: true };
  let band: NitaqatBand = 'RED';
  for (const b of CURVE_BANDS) {
    const r = set.byBand[b];
    if (!r) continue;
    if (pct >= bandThreshold(r.m, r.c, x) - 1e-9) band = b;
  }
  return { band, pct, small: false };
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export const QIWA_DOCUMENTATION_FROM = '2026-04-15';
export const NITAQAT_MUTAWAR_FROM = '2026-04-26';
export const WAGE_FULL_WEIGHT = 4000;
export const WAGE_HALF_WEIGHT = 3000;
export const STUDENT_MIN_WAGE = 2000;
/** Entities of this size or more: the disabled cap is 10% and a Muawama certificate is required. */
export const LARGE_ENTITY_WORKERS = 50;
export const SMALL_ENTITY_MAX = 5;

export type WeightClass = 'EXPAT' | 'UNDOCUMENTED' | 'SAUDI_FULL' | 'SAUDI_HALF' | 'SAUDI_ZERO' | 'PART_TIME' | 'STUDENT' | 'DISABLED' | 'DISABLED_ONE' | 'GCC';
export type CapCategory = 'DISABLED' | 'STUDENT' | 'RELEASED' | 'GCC';

export const WEIGHT_CLASS_LABELS: Record<WeightClass | 'SPECIAL' | 'SAUDI_TOTAL', string> = {
  EXPAT: 'وافد (1 في جانب غير السعوديين)',
  UNDOCUMENTED: 'عقد غير موثّق في قوى (0)',
  SAUDI_FULL: 'سعودي أجره 4,000 فأكثر (1)',
  SAUDI_HALF: 'سعودي أجره 3,000 إلى 3,999 (0.5)',
  SAUDI_ZERO: 'سعودي أجره أقل من 3,000 (0)',
  PART_TIME: 'دوام جزئي (0.5)',
  STUDENT: 'طالب (0.5)',
  DISABLED: 'ذو إعاقة (4)',
  DISABLED_ONE: 'ذو إعاقة محتسب 1 (شرط الوزن 4 أو السقف غير مستوفى)',
  GCC: 'مواطن خليجي (1)',
  SPECIAL: 'فئات مرجّحة خاصة',
  SAUDI_TOTAL: 'السعوديون والخليجيون المحتسبون (كل الفئات، موزونون)',
};

export interface NitaqatContext {
  date: Date;
  /** X before caps (decides the disabled cap and the Muawama requirement). */
  entitySize: number;
  retail: boolean;
}

export interface NitaqatWeight {
  side: 'SAUDI' | 'EXPAT';
  nationalityClass: NationalityClass;
  weightClass: WeightClass;
  /** Weight before caps. */
  weight: number;
  /** Weight if a cap refuses the category (regular Saudi by wage; GCC 0). */
  fallbackWeight: number;
  fallbackClass: WeightClass;
  capCategory: CapCategory | null;
  /** Counted in X. */
  counted: boolean;
  /** Undocumented only: the weight once documented (before caps). */
  potentialWeight: number | null;
  wage: number;
  note: string | null;
}

/** GOSI registered wage (basic + cash housing, not capped): the wage the weights compare. */
export function nitaqatWage(e: Pick<WfEmployeeInput, 'basicSalary' | 'allowances'>): number {
  return contributoryWage(e.basicSalary ?? 0, e.allowances ?? [], null).raw;
}

/** Regular Saudi weight: part-time 0.5, else by wage (0 / 0.5 / 1). */
export function regularSaudiWeight(wage: number, partTime: boolean): { weight: number; cls: WeightClass } {
  if (partTime) return { weight: 0.5, cls: 'PART_TIME' };
  if (wage >= WAGE_FULL_WEIGHT) return { weight: 1, cls: 'SAUDI_FULL' };
  if (wage >= WAGE_HALF_WEIGHT) return { weight: 0.5, cls: 'SAUDI_HALF' };
  return { weight: 0, cls: 'SAUDI_ZERO' };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Documented in Qiwa on `date` (always true before 2026-04-15). */
export function isQiwaDocumentedOn(e: Pick<WfEmployeeInput, 'qiwaContractDocumented' | 'qiwaContractDocumentedAt'>, date: Date): boolean {
  if (ymd(date) < QIWA_DOCUMENTATION_FROM) return true;
  if (e.qiwaContractDocumented !== true) return false;
  return !e.qiwaContractDocumentedAt || e.qiwaContractDocumentedAt.getTime() <= date.getTime() + DAY_MS - 1;
}

function isPartTime(e: Pick<WfEmployeeInput, 'contractType' | 'partTimeWeeklyHours'>): boolean {
  return !isFullTime(e.contractType, e.partTimeWeeklyHours);
}

/** Weight of one Saudi-side person as if documented (before caps). */
function saudiSideWeight(e: WfEmployeeInput, cls: NationalityClass, wage: number, ctx: NitaqatContext): Omit<NitaqatWeight, 'counted' | 'potentialWeight' | 'side' | 'nationalityClass'> {
  if (cls === 'GCC') return { weightClass: 'GCC', weight: 1, fallbackWeight: 0, fallbackClass: 'GCC', capCategory: 'GCC', wage, note: null };
  const partTime = isPartTime(e);
  const regular = regularSaudiWeight(wage, partTime);
  if (e.isDisabled) {
    // Qiwa: below 4,000, or 50+ workers without a valid Muawama certificate -> weight 1.
    const one = { weightClass: 'DISABLED_ONE' as const, weight: 1, fallbackWeight: 1, fallbackClass: 'DISABLED_ONE' as const, capCategory: null, wage };
    if (wage < WAGE_FULL_WEIGHT) return { ...one, note: 'DISABLED_LOW_WAGE' };
    if (ctx.entitySize >= LARGE_ENTITY_WORKERS) {
      const valid = !!e.muawamaCertExpiry && e.muawamaCertExpiry.getTime() >= Date.UTC(ctx.date.getUTCFullYear(), ctx.date.getUTCMonth(), ctx.date.getUTCDate());
      if (!valid) return { ...one, note: 'MUAWAMA_MISSING' };
    }
    return { weightClass: 'DISABLED', weight: 4, fallbackWeight: 1, fallbackClass: 'DISABLED_ONE', capCategory: 'DISABLED', wage, note: null };
  }
  if (e.isStudent) {
    // A student paid 3,000+ counts at least as much as a regular Saudi: not a student slot.
    if (wage >= WAGE_HALF_WEIGHT) return { weightClass: regular.cls, weight: regular.weight, fallbackWeight: regular.weight, fallbackClass: regular.cls, capCategory: null, wage, note: null };
    if (wage < STUDENT_MIN_WAGE) return { weightClass: 'STUDENT', weight: 0, fallbackWeight: 0, fallbackClass: 'SAUDI_ZERO', capCategory: null, wage, note: 'STUDENT_LOW_WAGE' };
    return { weightClass: 'STUDENT', weight: 0.5, fallbackWeight: regular.weight, fallbackClass: regular.cls, capCategory: 'STUDENT', wage, note: null };
  }
  return { weightClass: regular.cls, weight: regular.weight, fallbackWeight: regular.weight, fallbackClass: regular.cls, capCategory: null, wage, note: null };
}

/** SPEC §2.4 weight of one employee on `ctx.date` (before caps). */
export function nitaqatWeight(e: WfEmployeeInput, ctx: NitaqatContext): NitaqatWeight {
  const cls = nationalityClass(e.nationality);
  const wage = nitaqatWage(e);
  if (cls === 'EXPAT') return { side: 'EXPAT', nationalityClass: cls, weightClass: 'EXPAT', weight: 1, fallbackWeight: 1, fallbackClass: 'EXPAT', capCategory: null, counted: true, potentialWeight: null, wage, note: null };
  const w = saudiSideWeight(e, cls, wage, ctx);
  if (!isQiwaDocumentedOn(e, ctx.date)) {
    return { side: 'SAUDI', nationalityClass: cls, weightClass: 'UNDOCUMENTED', weight: 0, fallbackWeight: 0, fallbackClass: 'UNDOCUMENTED', capCategory: null, counted: false, potentialWeight: w.weight, wage, note: w.note };
  }
  return { side: 'SAUDI', nationalityClass: cls, ...w, counted: true, potentialWeight: null };
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export interface CapRule {
  id: 'DISABLED' | 'STUDENT' | 'RELEASED' | 'DISABLED_RELEASED_STUDENT' | 'GCC' | 'SPECIAL_CATEGORIES';
  label: string;
  categories: ReadonlyArray<CapCategory>;
  pct: number;
  /** Combined cap (several categories). */
  combined: boolean;
}

/** The caps table for an entity (size before caps, retail / wholesale activity). */
export function capRules(ctx: { entitySize: number; retail: boolean }): CapRule[] {
  return [
    { id: 'DISABLED', label: 'ذوو الإعاقة', categories: ['DISABLED'], pct: ctx.entitySize < LARGE_ENTITY_WORKERS ? 20 : 10, combined: false },
    { id: 'STUDENT', label: 'الطلاب', categories: ['STUDENT'], pct: ctx.retail ? 40 : 10, combined: false },
    { id: 'RELEASED', label: 'المُفرَج عنهم', categories: ['RELEASED'], pct: 10, combined: false },
    { id: 'DISABLED_RELEASED_STUDENT', label: 'ذوو الإعاقة والمُفرَج عنهم والطلاب معاً', categories: ['DISABLED', 'RELEASED', 'STUDENT'], pct: ctx.retail ? 40 : 15, combined: true },
    { id: 'GCC', label: 'مواطنو الخليج', categories: ['GCC'], pct: 10, combined: false },
    { id: 'SPECIAL_CATEGORIES', label: 'الخليجيون والقبائل النازحة وأبناء السعوديات وأمهات وأرامل السعوديين معاً', categories: ['GCC'], pct: 15, combined: true },
  ];
}

export interface CapResult {
  id: CapRule['id'];
  label: string;
  pct: number;
  combined: boolean;
  /** floor(pct × base). */
  maxPersons: number;
  admitted: number;
  refused: number;
}

export interface WeightedPerson extends NitaqatWeight {
  id: string;
  name: string;
  isPlanned: boolean;
  /** Weight after caps. */
  finalWeight: number;
  finalClass: WeightClass;
  /** Cap that refused the category (null = admitted / not capped). */
  cappedBy: CapRule['id'] | null;
}

export interface CountsResult {
  date: string;
  /** Persons counted in X. */
  x: number;
  saudiWeighted: number;
  expats: number;
  /** Counted Saudi nationals (the cap base). */
  saudiPersons: number;
  gccPersons: number;
  undocumented: number;
  persons: WeightedPerson[];
  caps: CapResult[];
  /** A combined cap refused a person its own cap admitted (the stricter cap applied). */
  capConflict: boolean;
}

/** Active on `date`: joined on/before it and not terminated before it. */
export function isActiveOn(e: Pick<WfEmployeeInput, 'joinDate' | 'terminationDate'>, date: Date): boolean {
  const t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (e.joinDate.getTime() > t + DAY_MS - 1) return false;
  if (e.terminationDate && e.terminationDate.getTime() < t) return false;
  return true;
}

/**
 * Weighted counts of the employees active on `date` with the caps applied (see the header). Employees
 * are processed in id order (deterministic).
 */
export function nitaqatCounts(employees: ReadonlyArray<WfEmployeeInput>, date: Date, retail: boolean): CountsResult {
  const active = employees.filter((e) => isActiveOn(e, date)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Size before caps (documentation and nationality do not depend on the caps).
  const pre = active.map((e) => nitaqatWeight(e, { date, entitySize: 0, retail }));
  const entitySize = pre.filter((w) => w.counted).length;
  const ctx: NitaqatContext = { date, entitySize, retail };
  const persons: WeightedPerson[] = active.map((e) => {
    const w = nitaqatWeight(e, ctx);
    return { ...w, id: e.id, name: e.name, isPlanned: !!e.isPlanned, finalWeight: w.weight, finalClass: w.weightClass, cappedBy: null };
  });
  const base = persons.filter((p) => p.counted && p.nationalityClass === 'SAUDI').length;
  const rules = capRules({ entitySize, retail });
  const caps: CapResult[] = rules.map((r) => ({ id: r.id, label: r.label, pct: r.pct, combined: r.combined, maxPersons: Math.floor((r.pct * base) / 100 + 1e-9), admitted: 0, refused: 0 }));
  let capConflict = false;
  const special = persons
    .filter((p) => p.counted && p.capCategory && p.weight > p.fallbackWeight)
    .sort((a, b) => b.weight - b.fallbackWeight - (a.weight - a.fallbackWeight) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of special) {
    const idx = rules.map((r, i) => (r.categories.includes(p.capCategory as CapCategory) ? i : -1)).filter((i) => i >= 0);
    const blocked = idx.filter((i) => caps[i].admitted >= caps[i].maxPersons);
    if (!blocked.length) {
      for (const i of idx) caps[i].admitted++;
      continue;
    }
    for (const i of blocked) caps[i].refused++;
    const ownOk = idx.filter((i) => !rules[i].combined).every((i) => caps[i].admitted < caps[i].maxPersons);
    if (ownOk && blocked.every((i) => rules[i].combined)) capConflict = true;
    p.finalWeight = p.fallbackWeight;
    p.finalClass = p.fallbackClass;
    p.cappedBy = rules[blocked[0]].id;
  }
  let saudiWeighted = 0;
  let expats = 0;
  let x = 0;
  let gcc = 0;
  let undocumented = 0;
  for (const p of persons) {
    if (p.counted) x++;
    if (p.side === 'EXPAT') expats++;
    else if (p.counted) {
      saudiWeighted += p.finalWeight;
      if (p.weightClass === 'GCC') gcc++;
    } else undocumented++;
  }
  return { date: ymd(date), x, saudiWeighted: round4(saudiWeighted), expats, saudiPersons: base, gccPersons: gcc, undocumented, persons, caps, capConflict };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export type NitaqatFlagCode =
  | 'UNDOCUMENTED_QIWA'
  | 'CAP_APPLIED'
  | 'CAP_INTERPRETATION'
  | 'OWNER_NOT_MODELLED'
  | 'CATEGORIES_NOT_MODELLED'
  | 'YEAR_BEYOND_TABLE'
  | 'YEAR_BEFORE_TABLE'
  | 'CURVE_MISSING_BAND'
  | 'CURVE_AMBIGUOUS'
  | 'X_DEFINITION_PROVISIONAL'
  | 'SMALL_ENTITY_RULE'
  | 'MUAWAMA_MISSING'
  | 'DISABLED_LOW_WAGE'
  | 'STUDENT_LOW_WAGE'
  | 'NATIONALITY_AMBIGUOUS'
  | 'MISSING_NATIONALITY'
  | 'BEFORE_PHASE'
  | 'RETAIL_INFERRED'
  | 'THRESHOLD_UNREACHABLE';

export interface NitaqatFlag {
  code: NitaqatFlagCode;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  employeeIds?: string[];
  /** Health data (disability): the API replaces the message and drops employeeIds for viewers outside HR. */
  sensitive?: boolean;
  /**
   * Message for a viewer who may not see disability when `message` carries a per-person weight (e.g. the
   * weight documentation would add: "+4" for one undocumented disabled Saudi). restrictFlags uses it.
   */
  restrictedMessage?: string;
}

export interface BandThreshold {
  band: CurveBand;
  /** Required Saudization % (Y), rounded to 2 decimals. */
  y: number;
  m: number;
  c: number;
  year: number;
  status: WfStatus;
  rawStatus: string;
  page: number | null;
  sourceUrl: string | null;
}

export interface NitaqatMargin {
  up: {
    band: NitaqatBand;
    /** Percentage points missing (null in the ≤5 regime). */
    pctGap: number | null;
    /** Weight-1 Saudi hires (wage >= 4,000) to reach it; null = not reachable within the search limit. */
    saudiHires: number | null;
  } | null;
  down: {
    /** Band below the current one. */
    band: NitaqatBand;
    /** Percentage points above the current band's threshold (null in the ≤5 regime). */
    pctCushion: number | null;
    /** Expats that could be added before dropping (null = more than the search limit). */
    expatsBeforeDrop: number | null;
    /** Weight-1 Saudis that could leave before dropping. */
    saudiExitsBeforeDrop: number | null;
  } | null;
}

export interface NitaqatEstimate {
  status: 'OK' | 'NO_ACTIVITY' | 'NO_EMPLOYEES';
  message: string | null;
  companyId: string;
  companyName: string;
  date: string;
  activity: { key: string; nameAr: string; code: string | null; sizeSegment: string | null; status: string; page: number | null; sourceUrl: string | null } | null;
  retail: boolean;
  year: number;
  curveYear: number | null;
  counts: { x: number; saudiWeighted: number; expats: number; saudiPersons: number; gccPersons: number; undocumented: number };
  pct: number;
  band: NitaqatBand | null;
  smallEntity: boolean;
  thresholds: BandThreshold[];
  thresholdsByYear: Array<{ year: number; band: NitaqatBand; thresholds: Array<{ band: CurveBand; y: number }> }>;
  margin: NitaqatMargin;
  consequences: { items: string[]; conflict?: string } | null;
  breakdown: Array<{ weightClass: WeightClass; label: string; persons: number; weight: number }>;
  persons: WeightedPerson[];
  undocumented: Array<{ id: string; name: string; potentialWeight: number }>;
  caps: CapResult[];
  average26w: { weeks: number; saudiWeighted: number; expats: number; x: number; pct: number; band: NitaqatBand | null } | null;
  flags: NitaqatFlag[];
  evidence: RuleEvidence[];
  /** Weakest status of the evidence (curves + assumptions). */
  overallStatus: WfStatus;
  assumptions: string[];
}

export interface NitaqatEntityInput {
  companyId: string;
  companyName: string;
  activity: NitaqatActivityRow | null;
  curves: ReadonlyArray<NitaqatCurveRow>;
  /** Employees of the legal company (any dates: those active on the date are used). */
  employees: ReadonlyArray<WfEmployeeInput>;
  /** Retail / wholesale activity (student caps 40%); null = inferred from the activity name. */
  retailWholesale?: boolean | null;
}

/** Qiwa: the 40% student / combined caps apply to Activity 460 («البيع بالجملة والتجزئة العامة»). */
export const RETAIL_WHOLESALE_ACTIVITY_CODE = '460';
const RETAIL_NAME = /(^|\s)بالجمله والتجزئه العامه($|\s)/;

/**
 * Retail / wholesale activity for the caps: activity code 460; without a code, the exact name of that
 * activity (other retail activities, e.g. 435 / 436, keep the 10% / 15% caps).
 */
export function isRetailWholesaleActivity(activity: Pick<NitaqatActivityRow, 'nameAr' | 'code'> | null | undefined): boolean {
  if (!activity) return false;
  const code = (activity.code ?? '').trim();
  if (code) return code === RETAIL_WHOLESALE_ACTIVITY_CODE;
  return RETAIL_NAME.test(normalizeNationalityKey(activity.nameAr));
}

/** Search limit of the margin loops (persons). */
const SEARCH_LIMIT = 5000;

/** Weight-1 Saudi hires needed to reach `target` (null when not reachable within the limit). */
export function hiresToReach(s: number, e: number, x: number, set: CurveSet, target: NitaqatBand): number | null {
  for (let k = 0; k <= SEARCH_LIMIT; k++) if (bandRank(bandForCounts(s + k, e, x + k, set).band) >= bandRank(target)) return k;
  return null;
}

function expatsBeforeDrop(s: number, e: number, x: number, set: CurveSet, band: NitaqatBand): number | null {
  for (let j = 1; j <= SEARCH_LIMIT; j++) if (bandRank(bandForCounts(s, e + j, x + j, set).band) < bandRank(band)) return j - 1;
  return null;
}

function saudiExitsBeforeDrop(s: number, e: number, x: number, set: CurveSet, band: NitaqatBand): number {
  const max = Math.floor(s + 1e-9);
  for (let i = 1; i <= max; i++) if (bandRank(bandForCounts(s - i, e, x - i, set).band) < bandRank(band)) return i - 1;
  return max;
}

export const NITAQAT_SOURCES = {
  QIWA: 'https://www.qiwa.sa/en/business-owners/manage-establishment/what-nitaqat-and-how-it-calculated',
  CALCULATOR: 'https://es.hrsd.gov.sa/services/Inquiry/NitaqatCalculatorMotawar2026.aspx',
  GUIDE: 'https://www.hrsd.gov.sa/sites/default/files/2026-03/ntaqat-almtwr.pdf',
} as const;

/** Evidence of the fixed parts (weights, caps, gate, formula) and of the documented assumptions. */
export const NITAQAT_EVIDENCE: Record<string, RuleEvidence> = {
  'NITAQAT:WEIGHTS': {
    key: 'NITAQAT:WEIGHTS',
    label: 'أوزان احتساب السعوديين (قوى، لا ترد في الدليل): أقل من 3,000 = 0، و3,000–3,999 = 0.5، و4,000 فأكثر = 1، وذو الإعاقة 4 (أجر 4,000 فأكثر، وشهادة مواءمة للكيان 50 فأكثر، وإلا 1)، والطالب 0.5 (أجر 2,000 فأكثر)، والدوام الجزئي 0.5، والخليجي 1',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: NITAQAT_SOURCES.QIWA,
    sourceQuote: 'آخر تعديل 10/09/2026',
    effectiveFrom: '2026-04-26',
  },
  'NITAQAT:CAPS': {
    key: 'NITAQAT:CAPS',
    label: 'سقوف الفئات (قوى): ذوو الإعاقة 20% من السعوديين (أقل من 50 عاملاً) أو 10%، والطلاب 10% (40% للنشاط 460)، ومجموع ذوي الإعاقة والمُفرَج عنهم والطلاب 15% (40% للتجزئة والجملة)، والخليجيون 10% و15% مع الفئات الخاصة',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: NITAQAT_SOURCES.QIWA,
    sourceQuote: null,
    effectiveFrom: '2026-04-26',
  },
  'NITAQAT:CAP_ORDER': {
    key: 'NITAQAT:CAP_ORDER',
    label: 'أي السقفين يسري أولاً غير واضح: يطبَّق الأشد، ويُحتسب من تجاوز السقف سعودياً عادياً حسب أجره، وأساس السقف عدد السعوديين المحتسبين (أفراداً) ويُقرَّب لأسفل',
    value: null,
    unit: null,
    status: 'PROVISIONAL',
    sourceUrl: null,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'NITAQAT:QIWA_DOCUMENTED': {
    key: 'NITAQAT:QIWA_DOCUMENTED',
    label: 'منذ 15 أبريل 2026 لا يُحتسب إلا العقد الموثّق في قوى (قرار مجلس الوزراء 195)',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: NITAQAT_SOURCES.QIWA,
    sourceQuote: 'قرار مجلس الوزراء 195',
    effectiveFrom: QIWA_DOCUMENTATION_FROM,
  },
  'NITAQAT:FORMULA': {
    key: 'NITAQAT:FORMULA',
    label: 'الحد الأدنى لكل نطاق Y = m·ln(X) + c (لوغاريتم طبيعي، دون سقف أو تقريب)، ونسبة التوطين = السعوديون ÷ (السعوديون + الوافدون) × 100، والخليجي ليس وافداً (الدليل ص 3 و5 و6)',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: NITAQAT_SOURCES.GUIDE,
    sourceQuote: 'ص = م لوغ (س) + ث',
    effectiveFrom: NITAQAT_MUTAWAR_FROM,
  },
  'NITAQAT:SMALL_ENTITY': {
    key: 'NITAQAT:SMALL_ENTITY',
    label: 'الكيان بخمسة عمال فأقل: أخضر أو أحمر فقط، وعامل سعودي واحد يكفي للأخضر المنخفض؛ والمعادلة من 6 عمال (حاسبة الوزارة وقوى)',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: NITAQAT_SOURCES.CALCULATOR,
    sourceQuote: 'المنشأة التي لديها عدد العاملين 5 فأقل يتطلب إضافة عامل سعودي واحد فقط',
    effectiveFrom: NITAQAT_MUTAWAR_FROM,
  },
  // Review fix P2-3: the sources say "one Saudi employee" only; counting him with weight >= 1 is ours.
  'NITAQAT:SMALL_ENTITY_WEIGHT': {
    key: 'NITAQAT:SMALL_ENTITY_WEIGHT',
    label: 'تفسير: السعودي الذي يكفي للأخضر المنخفض في الكيان بخمسة عمال فأقل يجب أن يُحتسب بوزن 1 على الأقل (أجر مسجّل 4,000 فأكثر، أو مجموع أوزان السعوديين ≥ 1)؛ المصادر تقول «عامل سعودي واحد» ولا تذكر الوزن',
    value: null,
    unit: null,
    status: 'PROVISIONAL',
    sourceUrl: null,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'NITAQAT:YEAR_SWITCH': {
    key: 'NITAQAT:YEAR_SWITCH',
    label: 'ثابت c لكل سنة يُفترض سريانه من 1 يناير (الدليل لا يحدد تاريخ الانتقال)، وما بعد 2028 بثوابت 2028',
    value: null,
    unit: null,
    status: 'PROVISIONAL',
    sourceUrl: NITAQAT_SOURCES.GUIDE,
    sourceQuote: 'لفترة 3 سنوات وما بعدها',
    effectiveFrom: null,
  },
  'NITAQAT:X_DEFINITION': {
    key: 'NITAQAT:X_DEFINITION',
    label: 'X = إجمالي العمالة للكيان: عدد العاملين المحتسبين (السعوديون والخليجيون الموثّقة عقودهم والوافدون) دون أوزان، لحظياً. الدليل لا يحدد هل هو عدد موزون أو متوسط',
    value: null,
    unit: null,
    status: 'PROVISIONAL',
    sourceUrl: null,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'NITAQAT:WAGE_BASIS': {
    key: 'NITAQAT:WAGE_BASIS',
    label: 'الأجر المقارن بعتبات الأوزان = الأجر المسجّل في التأمينات (الأساسي + بدل السكن النقدي)',
    value: null,
    unit: null,
    status: 'PROVISIONAL',
    sourceUrl: null,
    sourceQuote: null,
    effectiveFrom: null,
  },
  'NITAQAT:WINDOW': {
    key: 'NITAQAT:WINDOW',
    label: 'قوى تحسب متوسط 26 أسبوعاً (أسبوعاً واحداً بعد 13 أسبوعاً متتالية في الأخضر المنخفض فأعلى وللكيانات الجديدة): التقدير هنا لحظي، مع متوسط 26 أسبوعاً من بيانات رديف للمقارنة',
    value: null,
    unit: null,
    status: 'VERIFIED_PRIMARY',
    sourceUrl: null,
    sourceQuote: null,
    effectiveFrom: NITAQAT_MUTAWAR_FROM,
  },
};

export const NITAQAT_ASSUMPTIONS: string[] = [
  'الأجر المستخدم للأوزان هو الأجر المسجّل في التأمينات (الأساسي + بدل السكن النقدي).',
  'X عدد العاملين المحتسبين دون أوزان: السعوديون والخليجيون الموثّقة عقودهم والوافدون (مؤقت حتى التأكيد).',
  'السعودي أو الخليجي غير الموثّق عقده في قوى لا يُحتسب (0) ولا يدخل في X منذ 15 أبريل 2026.',
  'عند تعارض سقف فئة مع السقف المجمّع يطبَّق الأشد، ومن تجاوز السقف يُحتسب بالوزن العادي (ذو الإعاقة 1، والطالب حسب أجره، والخليجي 0).',
  'ثابت c لكل سنة يُفترض سريانه من 1 يناير، وما بعد 2028 بثوابت 2028 (مؤقت).',
  'الدوام الجزئي 0.5 دون حد أدنى للأجر (صفحة قوى الحالية؛ خبر الوزارة 2020 ذكر 3,000).',
  'فئات بلا بيانات في رديف غير محسوبة: المُفرَج عنهم، والاستثمار الاجتماعي، والعمل المرن، وحراس الأمن عبر أجير، والعمل عن بُعد، والقبائل النازحة، وأبناء السعوديات، وأمهات وأرامل السعوديين، والمالك، وزوج أو زوجة الوافد.',
  'التقدير لحظي في التاريخ المختار؛ قوى تعتمد متوسط 26 أسبوعاً.',
];

function activityView(a: NitaqatActivityRow): NonNullable<NitaqatEstimate['activity']> {
  return { key: a.key, nameAr: a.nameAr, code: a.code ?? null, sizeSegment: a.sizeSegment ?? null, status: a.status, page: a.page ?? null, sourceUrl: a.sourceUrl ?? null };
}

function curveEvidence(r: NitaqatCurveRow): RuleEvidence {
  return {
    key: `NITAQAT_CURVE:${r.activityKey}:${r.band}:${r.year}`,
    label: `ثابتا منحنى ${BAND_LABELS[r.band as CurveBand] ?? r.band} لسنة ${r.year}: m = ${r.m}، c = ${r.c}${r.page ? ` (صفحة ${r.page} من ملحق الدليل)` : ''}${(r.status ?? '').toUpperCase() === 'AMBIGUOUS' ? ` — ${AMBIGUOUS_LABEL}` : ''}`,
    value: r.c,
    unit: null,
    status: curveEvidenceStatus(r.status),
    sourceUrl: r.sourceUrl ?? null,
    sourceQuote: r.note ?? null,
    effectiveFrom: `${r.year}-01-01`,
  };
}

/**
 * Nitaqat estimate of a legal company on `date` (SPEC §3 nitaqatEstimate). See the header for every
 * convention. `opts.average` (default true) adds the 26-week average from weekly snapshots.
 */
export function nitaqatEstimate(entity: NitaqatEntityInput, date: Date, opts: { average?: boolean } = {}): NitaqatEstimate {
  const flags: NitaqatFlag[] = [];
  const year = date.getUTCFullYear();
  const activity = entity.activity;
  const inferredRetail = isRetailWholesaleActivity(activity);
  const retail = typeof entity.retailWholesale === 'boolean' ? entity.retailWholesale : inferredRetail;
  if (entity.retailWholesale == null && inferredRetail) flags.push({ code: 'RETAIL_INFERRED', severity: 'INFO', message: 'نشاط البيع بالجملة والتجزئة العامة (460): سقف الطلاب والسقف المجمّع 40%' });
  const counts = nitaqatCounts(entity.employees, date, retail);
  const set = activity ? curveSetFor(entity.curves, activity.key, year) : ({ year, curveYear: null, byBand: {}, missingBands: [...CURVE_BANDS] } as CurveSet);

  const empty: NitaqatEstimate = {
    status: 'OK',
    message: null,
    companyId: entity.companyId,
    companyName: entity.companyName,
    date: ymd(date),
    activity: activity ? activityView(activity) : null,
    retail,
    year,
    curveYear: set.curveYear,
    counts: { x: counts.x, saudiWeighted: counts.saudiWeighted, expats: counts.expats, saudiPersons: counts.saudiPersons, gccPersons: counts.gccPersons, undocumented: counts.undocumented },
    pct: 0,
    band: null,
    smallEntity: counts.x <= SMALL_ENTITY_MAX,
    thresholds: [],
    thresholdsByYear: [],
    margin: { up: null, down: null },
    consequences: null,
    breakdown: breakdownOf(counts.persons),
    persons: counts.persons,
    undocumented: undocumentedOf(counts.persons),
    caps: counts.caps,
    average26w: null,
    flags,
    evidence: [],
    overallStatus: 'PROVISIONAL',
    assumptions: NITAQAT_ASSUMPTIONS,
  };
  addPersonFlags(entity.employees, counts, flags);

  if (!activity || set.curveYear === null) {
    return {
      ...empty,
      status: 'NO_ACTIVITY',
      message: !activity
        ? 'لم يُحدَّد نشاط الشركة في نطاقات: اختر النشاط من إعدادات الشركة (نطاقات والمقابل المالي) ليُحسب النطاق.'
        : 'لا توجد ثوابت منحنى لهذا النشاط في سجل نطاقات: أضفها من «سجل نطاقات والتوطين» أو اختر نشاطاً متحققاً منه.',
      evidence: [NITAQAT_EVIDENCE['NITAQAT:WEIGHTS'], NITAQAT_EVIDENCE['NITAQAT:QIWA_DOCUMENTED']],
    };
  }
  if (counts.x === 0) {
    return { ...empty, status: 'NO_EMPLOYEES', message: 'لا يوجد عاملون محتسبون في هذا الكيان في التاريخ المختار.', evidence: [NITAQAT_EVIDENCE['NITAQAT:QIWA_DOCUMENTED']] };
  }

  if (set.curveYear !== null && year > set.curveYear) flags.push({ code: 'YEAR_BEYOND_TABLE', severity: 'INFO', message: `لا توجد ثوابت لسنة ${year}: استُخدمت ثوابت ${set.curveYear} («3 سنوات وما بعدها»)` });
  if (set.curveYear !== null && year < set.curveYear) flags.push({ code: 'YEAR_BEFORE_TABLE', severity: 'WARNING', message: `التاريخ قبل أول سنة في الجدول: استُخدمت ثوابت ${set.curveYear}` });
  if (ymd(date) < NITAQAT_MUTAWAR_FROM) flags.push({ code: 'BEFORE_PHASE', severity: 'WARNING', message: 'التاريخ قبل بدء نطاقات المطوّر (26 أبريل 2026): التقدير بمعادلات المرحلة الجديدة' });
  if (set.missingBands.length) flags.push({ code: 'CURVE_MISSING_BAND', severity: 'WARNING', message: `ثوابت غير مسجلة لنطاق: ${set.missingBands.map((b) => BAND_LABELS[b]).join('، ')} (سنة ${set.curveYear})` });
  const usedRows = CURVE_BANDS.map((b) => set.byBand[b]).filter((r): r is NitaqatCurveRow => !!r);
  if (usedRows.some((r) => (r.status ?? '').toUpperCase() === 'AMBIGUOUS') || (activity.status ?? '').toUpperCase() === 'AMBIGUOUS') {
    flags.push({ code: 'CURVE_AMBIGUOUS', severity: 'WARNING', message: `ثوابت هذا النشاط ${AMBIGUOUS_LABEL}: النتيجة تقديرية حتى المطابقة` });
  }
  flags.push({ code: 'X_DEFINITION_PROVISIONAL', severity: 'INFO', message: `X = ${counts.x} عاملاً محتسباً (السعوديون والخليجيون الموثّقة عقودهم والوافدون دون أوزان): تعريف مؤقت حتى التأكيد` });
  flags.push({ code: 'OWNER_NOT_MODELLED', severity: 'INFO', message: 'قاعدة احتساب المالك (1، الفرع الرئيسي فقط) غير محسوبة: المالك ليس موظفاً في رديف' });

  const { band, pct, small } = bandForCounts(counts.saudiWeighted, counts.expats, counts.x, set);
  if (small) flags.push({ code: 'SMALL_ENTITY_RULE', severity: 'INFO', message: 'الكيان بخمسة عمال فأقل: أخضر منخفض بسعودي واحد (موثّق)، وإلا أحمر؛ واشتراط أن يُحتسب بوزن 1 (أجر 4,000 فأكثر) تفسير مؤقت' });

  const thresholds: BandThreshold[] = usedRows.map((r) => ({
    band: r.band as CurveBand,
    y: round2(bandThreshold(r.m, r.c, counts.x)),
    m: r.m,
    c: r.c,
    year: r.year,
    status: curveEvidenceStatus(r.status),
    rawStatus: r.status,
    page: r.page ?? null,
    sourceUrl: r.sourceUrl ?? null,
  }));
  const years = [...new Set(entity.curves.filter((c) => c.activityKey === activity.key).map((c) => c.year))].sort((a, b) => a - b);
  const thresholdsByYear = years.map((y) => {
    const s = curveSetFor(entity.curves, activity.key, y);
    return {
      year: y,
      band: bandForCounts(counts.saudiWeighted, counts.expats, counts.x, s).band,
      thresholds: CURVE_BANDS.filter((b) => s.byBand[b]).map((b) => ({ band: b, y: round2(bandThreshold(s.byBand[b]!.m, s.byBand[b]!.c, counts.x)) })),
    };
  });

  // Margins (weight-1 Saudis / expats; the solver recomputes caps exactly).
  const rank = bandRank(band);
  // Next band up that exists: LOW_GREEN always (≤5 rule or its curve), higher bands only with a curve.
  const nextBand = NITAQAT_BANDS.slice(rank + 1).find((b) => (b === 'LOW_GREEN' && small) || !!set.byBand[b as CurveBand]) as NitaqatBand | undefined;
  const thresholdOf = (b: NitaqatBand): number | null => (b === 'RED' || small ? null : set.byBand[b as CurveBand] ? bandThreshold(set.byBand[b as CurveBand]!.m, set.byBand[b as CurveBand]!.c, counts.x) : null);
  let up: NitaqatMargin['up'] = null;
  if (nextBand) {
    const hires = hiresToReach(counts.saudiWeighted, counts.expats, counts.x, set, nextBand);
    const y = thresholdOf(nextBand);
    up = { band: nextBand, pctGap: y === null ? null : round2(Math.max(0, y - pct)), saudiHires: hires };
    if (hires === null) flags.push({ code: 'THRESHOLD_UNREACHABLE', severity: 'WARNING', message: `لا يمكن بلوغ ${BAND_LABELS[nextBand]} بتعيينات إضافية ضمن حد البحث (${SEARCH_LIMIT})` });
  }
  let down: NitaqatMargin['down'] = null;
  if (band !== 'RED') {
    const lower = NITAQAT_BANDS[rank - 1];
    const y = thresholdOf(band);
    down = {
      band: lower,
      pctCushion: y === null ? null : round2(pct - y),
      expatsBeforeDrop: expatsBeforeDrop(counts.saudiWeighted, counts.expats, counts.x, set, band),
      saudiExitsBeforeDrop: saudiExitsBeforeDrop(counts.saudiWeighted, counts.expats, counts.x, set, band),
    };
  }

  // 26-week average (Qiwa's window) from weekly snapshots of the same data.
  let average26w: NitaqatEstimate['average26w'] = null;
  if (opts.average !== false) {
    let sw = 0;
    let ex = 0;
    let xx = 0;
    const weeks = 26;
    for (let i = 0; i < weeks; i++) {
      const c = i === 0 ? counts : nitaqatCounts(entity.employees, new Date(date.getTime() - i * 7 * DAY_MS), retail);
      sw += c.saudiWeighted;
      ex += c.expats;
      xx += c.x;
    }
    const aS = sw / weeks;
    const aE = ex / weeks;
    const aX = xx / weeks;
    const r = aX > 0 ? bandForCounts(aS, aE, aX, set) : null;
    average26w = { weeks, saudiWeighted: round2(aS), expats: round2(aE), x: round2(aX), pct: r ? round2(r.pct) : 0, band: r ? r.band : null };
  }

  const evidence = [
    NITAQAT_EVIDENCE['NITAQAT:FORMULA'],
    ...usedRows.map(curveEvidence),
    NITAQAT_EVIDENCE['NITAQAT:YEAR_SWITCH'],
    NITAQAT_EVIDENCE['NITAQAT:SMALL_ENTITY'],
    NITAQAT_EVIDENCE['NITAQAT:SMALL_ENTITY_WEIGHT'],
    NITAQAT_EVIDENCE['NITAQAT:WEIGHTS'],
    NITAQAT_EVIDENCE['NITAQAT:CAPS'],
    NITAQAT_EVIDENCE['NITAQAT:CAP_ORDER'],
    NITAQAT_EVIDENCE['NITAQAT:QIWA_DOCUMENTED'],
    NITAQAT_EVIDENCE['NITAQAT:X_DEFINITION'],
    NITAQAT_EVIDENCE['NITAQAT:WAGE_BASIS'],
    NITAQAT_EVIDENCE['NITAQAT:WINDOW'],
  ];
  return {
    ...empty,
    pct: round2(pct),
    band,
    smallEntity: small,
    thresholds,
    thresholdsByYear,
    margin: { up, down },
    consequences: BAND_CONSEQUENCES[band],
    average26w,
    flags,
    evidence,
    overallStatus: weakestStatus(evidence.map((e) => e.status)),
  };
}

function breakdownOf(persons: ReadonlyArray<WeightedPerson>): NitaqatEstimate['breakdown'] {
  const map = new Map<WeightClass, { persons: number; weight: number }>();
  for (const p of persons) {
    const cls = p.counted || p.side === 'EXPAT' ? p.finalClass : 'UNDOCUMENTED';
    const cur = map.get(cls) ?? { persons: 0, weight: 0 };
    cur.persons++;
    cur.weight += p.side === 'EXPAT' ? 1 : p.counted ? p.finalWeight : 0;
    map.set(cls, cur);
  }
  const order: WeightClass[] = ['SAUDI_FULL', 'SAUDI_HALF', 'SAUDI_ZERO', 'PART_TIME', 'STUDENT', 'DISABLED', 'DISABLED_ONE', 'GCC', 'UNDOCUMENTED', 'EXPAT'];
  return order.filter((c) => map.has(c)).map((c) => ({ weightClass: c, label: WEIGHT_CLASS_LABELS[c], persons: map.get(c)!.persons, weight: round4(map.get(c)!.weight) }));
}

function undocumentedOf(persons: ReadonlyArray<WeightedPerson>): NitaqatEstimate['undocumented'] {
  return persons.filter((p) => p.side === 'SAUDI' && !p.counted).map((p) => ({ id: p.id, name: p.name, potentialWeight: p.potentialWeight ?? 0 }));
}

function addPersonFlags(employees: ReadonlyArray<WfEmployeeInput>, counts: CountsResult, flags: NitaqatFlag[]): void {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const undoc = counts.persons.filter((p) => p.side === 'SAUDI' && !p.counted);
  if (undoc.length) {
    const potential = round4(undoc.reduce((s, p) => s + (p.potentialWeight ?? 0), 0));
    flags.push({
      code: 'UNDOCUMENTED_QIWA',
      severity: 'ERROR',
      message: `${undoc.length} ${undoc.length === 1 ? 'موظف سعودي أو خليجي' : 'موظفين سعوديين أو خليجيين'} بعقد غير موثّق في قوى لا يُحتسبون في نطاقات منذ 15 أبريل 2026. توثيقها يضيف ${potential} إلى السعوديين الموزونين دون كلفة.`,
      restrictedMessage: `${undoc.length} ${undoc.length === 1 ? 'موظف سعودي أو خليجي' : 'موظفين سعوديين أو خليجيين'} بعقد غير موثّق في قوى لا يُحتسبون في نطاقات منذ 15 أبريل 2026. توثيقها دون كلفة (الأسماء والأوزان لمدير الموارد البشرية).`,
      employeeIds: undoc.map((p) => p.id),
    });
  }
  const muawama = counts.persons.filter((p) => p.note === 'MUAWAMA_MISSING');
  if (muawama.length) flags.push({ code: 'MUAWAMA_MISSING', severity: 'WARNING', message: `${muawama.length} من ذوي الإعاقة بلا شهادة مواءمة سارية (الكيان 50 عاملاً فأكثر): احتُسبوا بوزن 1 بدل 4`, employeeIds: muawama.map((p) => p.id), sensitive: true });
  const lowDisabled = counts.persons.filter((p) => p.note === 'DISABLED_LOW_WAGE');
  if (lowDisabled.length) flags.push({ code: 'DISABLED_LOW_WAGE', severity: 'INFO', message: `${lowDisabled.length} من ذوي الإعاقة أجرهم أقل من 4,000: احتُسبوا بوزن 1 بدل 4`, employeeIds: lowDisabled.map((p) => p.id), sensitive: true });
  const lowStudent = counts.persons.filter((p) => p.note === 'STUDENT_LOW_WAGE');
  if (lowStudent.length) flags.push({ code: 'STUDENT_LOW_WAGE', severity: 'INFO', message: `${lowStudent.length} من الطلاب أجرهم أقل من 2,000: لا يُحتسبون`, employeeIds: lowStudent.map((p) => p.id) });
  const capped = counts.persons.filter((p) => p.cappedBy);
  if (capped.length) {
    flags.push({ code: 'CAP_APPLIED', severity: 'WARNING', message: `سقوف الفئات المرجّحة الخاصة حدّت احتساب ${capped.length} ${capped.length === 1 ? 'موظف' : 'موظفين'}: احتُسبوا بالوزن العادي (ذو الإعاقة 1، والطالب حسب أجره، والخليجي 0)`, employeeIds: capped.map((p) => p.id), sensitive: true });
  }
  if (counts.capConflict) flags.push({ code: 'CAP_INTERPRETATION', severity: 'WARNING', message: 'السقف المجمّع أشد من سقف الفئة نفسها: طُبِّق الأشد (أي السقفين يسري أولاً غير واضح في الدليل)', sensitive: true });
  const ambiguous = counts.persons.filter((p) => mentionsSaudiAmbiguously(byId.get(p.id)?.nationality));
  if (ambiguous.length) flags.push({ code: 'NATIONALITY_AMBIGUOUS', severity: 'WARNING', message: `${ambiguous.length} جنسية مسجلة تذكر السعودية مع كلمات أخرى: لم تُحتسب سعودية؛ صحّحها في ملف الموظف`, employeeIds: ambiguous.map((p) => p.id) });
  const missing = counts.persons.filter((p) => !(byId.get(p.id)?.nationality ?? '').trim());
  if (missing.length) flags.push({ code: 'MISSING_NATIONALITY', severity: 'ERROR', message: `${missing.length} موظف بلا جنسية: احتُسب وافداً`, employeeIds: missing.map((p) => p.id) });
  flags.push({ code: 'CATEGORIES_NOT_MODELLED', severity: 'INFO', message: 'فئات بلا بيانات في رديف غير محسوبة: المُفرَج عنهم، والاستثمار الاجتماعي، والعمل المرن، وحراس الأمن عبر أجير، والعمل عن بُعد، والفئات الخاصة غير الخليجيين' });
}

// ---------------------------------------------------------------------------
// Viewer restriction (disability is health data: SPEC «خصوصية بيانات الإعاقة»)
// ---------------------------------------------------------------------------

export const SPECIAL_WEIGHTED_TEXT = 'فئات مرجّحة خاصة';

/** Breakdown rows kept per class for a restricted viewer (not on the Saudi side: nothing to infer). */
const NON_SAUDI_ROWS: ReadonlySet<WeightClass> = new Set(['UNDOCUMENTED', 'EXPAT']);

export type RestrictedEstimate = Omit<NitaqatEstimate, 'persons' | 'undocumented' | 'breakdown' | 'caps'> & {
  persons: [];
  undocumented: [];
  undocumentedCount: number;
  breakdown: Array<{ weightClass: WeightClass | 'SAUDI_TOTAL'; label: string; persons: number; weight: number }>;
  caps: [];
  restricted: true;
};

/**
 * The estimate as a viewer who may not see disability receives it: no per-person list, undocumented
 * employees as a count only (no potential weight: one undocumented disabled Saudi would show "+4"),
 * caps detail removed, every sensitive flag replaced by a neutral message without employee ids, and the
 * breakdown with ONE Saudi-side row (every counted Saudi / GCC class together: persons and total weight)
 * next to the undocumented and expat rows. Review fix P2-2: a separate special-categories row — or the
 * ordinary rows next to a total, which give the special ones by subtraction — could isolate one disabled
 * employee (1 person, weight 4). The remaining inference from the total itself (pct, X) is the residual
 * risk accepted in SPEC §1.
 */
export function restrictEstimate(e: NitaqatEstimate): RestrictedEstimate {
  const saudiSide = e.breakdown.filter((b) => !NON_SAUDI_ROWS.has(b.weightClass));
  const breakdown: RestrictedEstimate['breakdown'] = [];
  if (saudiSide.length) {
    breakdown.push({ weightClass: 'SAUDI_TOTAL', label: WEIGHT_CLASS_LABELS.SAUDI_TOTAL, persons: saudiSide.reduce((s, b) => s + b.persons, 0), weight: round4(saudiSide.reduce((s, b) => s + b.weight, 0)) });
  }
  breakdown.push(...e.breakdown.filter((b) => NON_SAUDI_ROWS.has(b.weightClass)));
  return {
    ...e,
    persons: [],
    undocumented: [],
    undocumentedCount: e.undocumented.length,
    breakdown,
    caps: [],
    flags: restrictFlags(e.flags),
    restricted: true,
  };
}

/**
 * Stable key of a NitaqatActivity: slug of the Arabic name (+ "--" + slug of the size segment). Same
 * algorithm as scripts/seed-nitaqat.mjs (diacritics / tatweel removed, alef / ya / ta marbuta forms
 * unified, lower case, any other character run -> "-").
 */
export function nitaqatActivityKey(nameAr: string, sizeSegment?: string | null): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '')
      .replace(/ـ/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  const seg = (sizeSegment ?? '').trim();
  return slug(nameAr) + (seg ? `--${slug(seg)}` : '');
}

export function restrictFlags(flags: ReadonlyArray<NitaqatFlag>): NitaqatFlag[] {
  const out: NitaqatFlag[] = [];
  let sensitiveSeen = false;
  for (const f of flags) {
    if (f.sensitive) {
      if (!sensitiveSeen) out.push({ code: 'CAP_APPLIED', severity: 'INFO', message: `أوزان ${SPECIAL_WEIGHTED_TEXT} أو سقوفها أثّرت في الاحتساب (التفاصيل لمدير الموارد البشرية)` });
      sensitiveSeen = true;
      continue;
    }
    const { employeeIds: _ids, restrictedMessage, ...rest } = f;
    out.push(restrictedMessage ? { ...rest, message: restrictedMessage } : rest);
  }
  return out;
}
