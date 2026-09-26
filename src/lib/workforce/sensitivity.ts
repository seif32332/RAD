// Decision sensitivity («حساسية القرار», SPEC §11). PURE, deterministic, client-safe.
//
// For one decision — a hire-scenario candidate set, an exit, or a workforce plan — the SAME engine
// function the decision page uses (hireScenario / computeExitCost / projectPlan) is run:
//   1. under the three scenarios low / base / high of the assumption ranges ({low, base, high} stored in
//      WorkforceAssumption.valueJson, or given for this calculation only in `ranges`);
//   2. one factor at a time (every other input at its base value) for a small set of factors:
//      - the number assumptions that carry a range (annual raise, ticket, exit/re-entry visas,
//        recruitment cost, vacancy months) — low value / high value of that range;
//      - the medical insurance class (the cheapest / the most expensive class whose premium the company
//        entered in «إعدادات الكلفة»; single values, so the two extremes are the only honest range);
//      - the overtime hourly basis (BASIC / TOTAL_PLUS_HALF_BASIC, Art. 107), only when the decision has
//        overtime;
//      - the HRDF subsidy included / not included (it is conditional on HRDF accepting the application).
// Result: the three scenario totals and a tornado table (factor, low value -> result, high value ->
// result, swing = |high − low|) sorted by swing. No number is invented: a factor without an entered
// range (or with fewer than two entered premiums) is listed in `skipped` with the reason, never guessed.
// Nothing is written anywhere; company settings are overridden in memory only.
import { roundMoney } from '@/lib/money';
import { nationalityClass } from '@/lib/nationality';
import { ASSUMPTION_DEFS, resolveAssumption, scenarioNumber } from '@/lib/workforce/assumptions';
import { OVERTIME_BASIS_SHORT, type OvertimeHourlyBasis } from '@/lib/workforce/company-settings';
import { MEDICAL_INSURANCE_CLASSES } from '@/lib/workforce/reasons';
import { computeExitCost } from '@/lib/workforce/exit-cost';
import { hireScenario, type HireCandidate, type HireScenarioInput } from '@/lib/workforce/hiring';
import { projectPlan, type PlanBaseInput, type PlanDefinition } from '@/lib/workforce/planning';
import { ENGINE_VERSION, ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import type { AssumptionRow, ExitCostInput, Scenario, WfCompanyInput } from '@/lib/workforce/types';

// ---------------------------------------------------------------------------
// Factors
// ---------------------------------------------------------------------------

/** Number assumptions that may carry a {low, base, high} range. */
export const RANGE_FACTOR_KEYS = ['ANNUAL_RAISE_PCT', 'ANNUAL_TICKET_COST', 'EXIT_REENTRY_VISAS_PER_YEAR', 'RECRUITMENT_COST_SAUDI', 'RECRUITMENT_COST_EXPAT', 'VACANCY_MONTHS'] as const;
export type RangeFactorKey = (typeof RANGE_FACTOR_KEYS)[number];
export type SensitivityFactorKey = RangeFactorKey | 'MEDICAL_CLASS' | 'OVERTIME_BASIS' | 'INCLUDE_HRDF';

export const SENSITIVITY_FACTOR_LABELS: Record<SensitivityFactorKey, string> = {
  ANNUAL_RAISE_PCT: ASSUMPTION_DEFS.ANNUAL_RAISE_PCT.label,
  ANNUAL_TICKET_COST: ASSUMPTION_DEFS.ANNUAL_TICKET_COST.label,
  EXIT_REENTRY_VISAS_PER_YEAR: ASSUMPTION_DEFS.EXIT_REENTRY_VISAS_PER_YEAR.label,
  RECRUITMENT_COST_SAUDI: ASSUMPTION_DEFS.RECRUITMENT_COST_SAUDI.label,
  RECRUITMENT_COST_EXPAT: ASSUMPTION_DEFS.RECRUITMENT_COST_EXPAT.label,
  VACANCY_MONTHS: ASSUMPTION_DEFS.VACANCY_MONTHS.label,
  MEDICAL_CLASS: 'فئة التأمين الطبي (أرخص فئة مدخلة ← أغلى فئة)',
  OVERTIME_BASIS: 'طريقة حساب أجر العمل الإضافي (المادة 107)',
  INCLUDE_HRDF: 'احتساب دعم هدف (مشروط بقبول الطلب)',
};

const FACTOR_ORDER: ReadonlyArray<SensitivityFactorKey> = [...RANGE_FACTOR_KEYS, 'MEDICAL_CLASS', 'OVERTIME_BASIS', 'INCLUDE_HRDF'];

export type SensitivityDecision = 'HIRE' | 'EXIT' | 'PLAN';
export const SENSITIVITY_DECISION_LABELS: Record<SensitivityDecision, string> = { HIRE: 'سيناريو توظيف', EXIT: 'كلفة الإنهاء والإحلال', PLAN: 'خطة القوى العاملة' };

/** Ranges given for this calculation only (never stored): key -> {low, high} (base = the value in force). */
export type RangeOverrides = Partial<Record<RangeFactorKey, { low: number; base?: number | null; high: number }>>;

/** How one evaluation differs from the decision as entered. */
export interface SensitivityMod {
  /** Scenario of every assumption range. */
  scenario: Scenario;
  /** One range assumption moved to its low / high value (the others at `scenario`). */
  rangePin?: { key: RangeFactorKey; side: 'low' | 'high' } | null;
  /** INCLUDE_HRDF forced on / off. */
  hrdf?: boolean | null;
  /** Medical class forced to the cheapest ('low') / most expensive ('high') entered class. */
  medical?: 'low' | 'high' | null;
  /** Company overtime basis forced. */
  overtime?: OvertimeHourlyBasis | null;
}

export interface SensitivityFactorResult {
  key: SensitivityFactorKey;
  label: string;
  lowText: string;
  baseText: string;
  highText: string;
  /** Result with the factor at its low / high value (every other input at base). */
  low: number;
  high: number;
  lowDelta: number;
  highDelta: number;
  /** |high − low|. */
  swing: number;
}

export interface SensitivityOutcome {
  id: string;
  label: string;
  /** Result with every input at base (= the decision page's figure under the base scenario). */
  base: number;
  scenarios: Record<Scenario, number>;
  /** scenarios.high − scenarios.low (rounded like every figure here: the exports print it, never recompute it). */
  scenarioSpread: number;
  /** scenarios.low − base and scenarios.high − base (rounded). */
  scenarioDeltas: { low: number; high: number };
  /** Sorted by swing (largest first), then by factor order. */
  factors: SensitivityFactorResult[];
}

export interface SensitivityRangeUsed {
  key: RangeFactorKey;
  label: string;
  unit: string | null;
  low: number;
  base: number;
  high: number;
  origin: 'STORED' | 'REQUEST';
}

export interface SensitivityResult {
  engineVersion: string;
  disclaimer: string;
  decision: SensitivityDecision;
  title: string;
  /** What the figure is (Arabic). */
  metricLabel: string;
  horizonMonths: number;
  outcomes: SensitivityOutcome[];
  /** Factors not varied, with the reason (no range entered, not relevant to this decision...). */
  skipped: Array<{ key: SensitivityFactorKey; label: string; reason: string }>;
  /** The ranges used by the scenarios and the range factors. */
  ranges: SensitivityRangeUsed[];
  notes: string[];
  /** Number of engine runs. */
  runs: number;
  /**
   * Approved plan: the totals frozen at approval (the snapshot the plan was approved on), shown next to the
   * live recalculation of this page (outcome id -> value). Set by the API; absent otherwise.
   */
  reference?: SensitivityReference | null;
}

export interface SensitivityReference {
  label: string;
  createdAt: string;
  /** Outcome id -> the approved (frozen) value. */
  values: Record<string, number | null>;
  /** Outcome id -> live base − approved value (rounded; null when the approved value is absent). */
  diffs: Record<string, number | null>;
}

// ---------------------------------------------------------------------------
// Assumption rows for one evaluation
// ---------------------------------------------------------------------------

const isRangeKey = (k: string): k is RangeFactorKey => (RANGE_FACTOR_KEYS as ReadonlyArray<string>).includes(k);

function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const isRangeObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && ('low' in v || 'base' in v || 'high' in v);

/**
 * Assumption rows with every {low, base, high} range of a number assumption collapsed to one value: the
 * `scenario` value, or the pinned side for `rangePin.key`; INCLUDE_HRDF forced when `hrdf` is set.
 * The engines then resolve exactly one value per assumption whatever scenario they are given.
 */
export function sensitivityRows(rows: ReadonlyArray<AssumptionRow>, mod: Pick<SensitivityMod, 'scenario' | 'rangePin' | 'hrdf'>): AssumptionRow[] {
  let out: AssumptionRow[] = rows.map((r) => {
    if (!isRangeKey(r.key)) return r;
    const j = parseJson(r.valueJson);
    if (!isRangeObject(j)) return r;
    const side = mod.rangePin && mod.rangePin.key === r.key ? mod.rangePin.side : mod.scenario;
    return { ...r, value: scenarioNumber(j, side), valueJson: null };
  });
  if (mod.hrdf === true || mod.hrdf === false) {
    out = [...out.filter((r) => r.key !== 'INCLUDE_HRDF'), { key: 'INCLUDE_HRDF', companyId: '', value: null, valueJson: JSON.stringify(mod.hrdf), note: 'حساسية القرار' }];
  }
  return out;
}

/**
 * Applies ranges given for this calculation only: every stored row of the key is replaced by one row for
 * `companyId` ('' = all) carrying {low, base, high}; base = the explicit base, else the value in force.
 * A key whose base is not entered anywhere is returned in `missingBase` (nothing is invented).
 */
export function withRangeOverrides(
  rows: ReadonlyArray<AssumptionRow>,
  companyId: string | null,
  ranges: RangeOverrides | null | undefined,
): { rows: AssumptionRow[]; missingBase: RangeFactorKey[]; invalid: RangeFactorKey[] } {
  let out = [...rows];
  const missingBase: RangeFactorKey[] = [];
  const invalid: RangeFactorKey[] = [];
  for (const key of RANGE_FACTOR_KEYS) {
    const r = ranges?.[key];
    if (!r) continue;
    const resolved = resolveAssumption(rows, key, companyId, 'base').value;
    const base = typeof r.base === 'number' && Number.isFinite(r.base) ? r.base : typeof resolved === 'number' ? resolved : null;
    if (base === null) {
      missingBase.push(key);
      continue;
    }
    if (!(Number.isFinite(r.low) && Number.isFinite(r.high) && r.low <= base && base <= r.high)) {
      invalid.push(key);
      continue;
    }
    out = out.filter((x) => x.key !== key);
    out.push({ key, companyId: companyId ?? '', value: base, valueJson: JSON.stringify({ low: r.low, base, high: r.high }), note: 'نطاق لهذا الحساب فقط' });
  }
  return { rows: out, missingBase, invalid };
}

/** {low, base, high} of a range assumption for a company (null = no range, or low = base = high). */
export function assumptionRange(rows: ReadonlyArray<AssumptionRow>, key: RangeFactorKey, companyId: string | null): { low: number; base: number; high: number } | null {
  const r = resolveAssumption(rows, key, companyId, 'base').range;
  if (!r || (r.low === r.base && r.high === r.base)) return null;
  return r;
}

function anyRange(rows: ReadonlyArray<AssumptionRow>): boolean {
  return rows.some((r) => {
    if (!isRangeKey(r.key)) return false;
    const j = parseJson(r.valueJson);
    if (!isRangeObject(j)) return false;
    const lo = scenarioNumber(j, 'low');
    const b = scenarioNumber(j, 'base');
    const hi = scenarioNumber(j, 'high');
    return lo !== b || hi !== b;
  });
}

// ---------------------------------------------------------------------------
// Company settings overrides (in memory)
// ---------------------------------------------------------------------------

export interface MedicalExtremes {
  low: { cls: string; premium: number };
  high: { cls: string; premium: number };
}

/** Cheapest and most expensive entered class premium of a company (null when fewer than two distinct amounts). */
export function medicalExtremes(company: WfCompanyInput | null | undefined): MedicalExtremes | null {
  const premiums = company?.costSettings?.medicalPremiums ?? {};
  const entered = MEDICAL_INSURANCE_CLASSES.map((cls, i) => ({ cls: cls as string, premium: premiums[cls], i }))
    .filter((x): x is { cls: string; premium: number; i: number } => typeof x.premium === 'number' && Number.isFinite(x.premium))
    .sort((a, b) => a.premium - b.premium || a.i - b.i);
  if (entered.length < 2) return null;
  const low = entered[0];
  const high = entered[entered.length - 1];
  if (low.premium === high.premium) return null;
  return { low: { cls: low.cls, premium: low.premium }, high: { cls: high.cls, premium: high.premium } };
}

function withOvertimeBasis(c: WfCompanyInput, basis: OvertimeHourlyBasis): WfCompanyInput {
  const cs = c.costSettings ?? { overtimeHourlyBasis: 'BASIC' as OvertimeHourlyBasis, medicalPremiums: {}, iqamaFeeYear: null };
  return { ...c, costSettings: { ...cs, overtimeHourlyBasis: basis } };
}

// ---------------------------------------------------------------------------
// Formatting (value texts of the tornado)
// ---------------------------------------------------------------------------

const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const UNIT_TEXT: Record<string, string> = { SAR: 'ر.س', SAR_YEAR: 'ر.س سنوياً', MONTHS: 'شهر', PERCENT: '%', COUNT_YEAR: 'مرة سنوياً' };

function valueText(key: RangeFactorKey, v: number): string {
  const unit = ASSUMPTION_DEFS[key].unit as string | null;
  if (unit === 'PERCENT') return `${NF.format(v)}%`;
  return `${NF.format(v)}${unit && UNIT_TEXT[unit] ? ` ${UNIT_TEXT[unit]}` : ''}`;
}

const premiumText = (x: { cls: string; premium: number }) => `${x.cls} (${NF.format(x.premium)} ر.س سنوياً)`;

// ---------------------------------------------------------------------------
// Generic runner
// ---------------------------------------------------------------------------

interface FactorPlan {
  key: SensitivityFactorKey;
  lowText: string;
  baseText: string;
  highText: string;
  low: SensitivityMod;
  high: SensitivityMod;
}

interface CoreInput {
  decision: SensitivityDecision;
  title: string;
  metricLabel: string;
  horizonMonths: number;
  rows: ReadonlyArray<AssumptionRow>;
  companyId: string | null;
  /** Range assumptions relevant to the decision (in order); the others are listed as not relevant. */
  rangeKeys: ReadonlyArray<RangeFactorKey>;
  requestKeys: ReadonlySet<RangeFactorKey>;
  extraFactors: FactorPlan[];
  skipped: SensitivityResult['skipped'];
  notes: string[];
  evaluate: (mod: SensitivityMod) => { ids: string[]; labels: string[]; values: number[] };
}

const r2 = (n: number) => roundMoney(n);

function runCore(c: CoreInput): SensitivityResult {
  let runs = 0;
  const ev = (m: SensitivityMod) => {
    runs++;
    return c.evaluate(m);
  };
  const base = ev({ scenario: 'base' });
  const scenarioVaries = anyRange(c.rows);
  const low = scenarioVaries ? ev({ scenario: 'low' }) : base;
  const high = scenarioVaries ? ev({ scenario: 'high' }) : base;

  const skipped = [...c.skipped];
  const ranges: SensitivityRangeUsed[] = [];
  const plans: FactorPlan[] = [];
  for (const key of c.rangeKeys) {
    const r = assumptionRange(c.rows, key, c.companyId);
    if (!r) {
      skipped.push({ key, label: SENSITIVITY_FACTOR_LABELS[key], reason: 'لا نطاق مُدخل (منخفض/مرتفع) لهذا الافتراض: أدخله في «الافتراضات» ليظهر أثره' });
      continue;
    }
    ranges.push({ key, label: SENSITIVITY_FACTOR_LABELS[key], unit: ASSUMPTION_DEFS[key].unit, ...r, origin: c.requestKeys.has(key) ? 'REQUEST' : 'STORED' });
    plans.push({
      key,
      lowText: valueText(key, r.low),
      baseText: valueText(key, r.base),
      highText: valueText(key, r.high),
      low: { scenario: 'base', rangePin: { key, side: 'low' } },
      high: { scenario: 'base', rangePin: { key, side: 'high' } },
    });
  }
  plans.push(...c.extraFactors);
  const results = plans.map((p) => ({ p, lo: ev(p.low), hi: ev(p.high) }));

  const outcomes: SensitivityOutcome[] = base.ids.map((id, i) => {
    const b = r2(base.values[i]);
    const factors = results
      .map(({ p, lo, hi }): SensitivityFactorResult => {
        const l = r2(lo.values[i]);
        const h = r2(hi.values[i]);
        return { key: p.key, label: SENSITIVITY_FACTOR_LABELS[p.key], lowText: p.lowText, baseText: p.baseText, highText: p.highText, low: l, high: h, lowDelta: r2(l - b), highDelta: r2(h - b), swing: r2(Math.abs(h - l)) };
      })
      .sort((a, z) => z.swing - a.swing || FACTOR_ORDER.indexOf(a.key) - FACTOR_ORDER.indexOf(z.key));
    const lo = r2(low.values[i]);
    const hi = r2(high.values[i]);
    return { id, label: base.labels[i], base: b, scenarios: { low: lo, base: b, high: hi }, scenarioSpread: r2(hi - lo), scenarioDeltas: { low: r2(lo - b), high: r2(hi - b) }, factors };
  });

  const notes = [...c.notes];
  if (!scenarioVaries) notes.push('لا توجد افتراضات بنطاق منخفض/مرتفع: السيناريوهات الثلاثة متساوية.');
  notes.push('كل عامل يُحرَّك وحده وبقية المدخلات على قيمتها الأساسية؛ الأثر المجتمع لعدة عوامل ليس مجموع الأعمدة بالضرورة.');
  return {
    engineVersion: ENGINE_VERSION,
    disclaimer: ESTIMATE_DISCLAIMER,
    decision: c.decision,
    title: c.title,
    metricLabel: c.metricLabel,
    horizonMonths: c.horizonMonths,
    outcomes,
    skipped: skipped.sort((a, z) => FACTOR_ORDER.indexOf(a.key) - FACTOR_ORDER.indexOf(z.key)),
    ranges,
    notes,
    runs,
  };
}

/**
 * Sets `result.reference` (an approved plan: the totals frozen at approval) with the live − approved difference
 * of every outcome computed here, rounded like the other figures, so no export or page recomputes it.
 */
export function attachReference(result: SensitivityResult, ref: { label: string; createdAt: string; values: Record<string, number | null> }): SensitivityReference {
  const diffs: Record<string, number | null> = {};
  for (const o of result.outcomes) {
    const a = ref.values[o.id];
    diffs[o.id] = typeof a === 'number' && Number.isFinite(a) ? r2(o.base - r2(a)) : null;
  }
  result.reference = { label: ref.label, createdAt: ref.createdAt, values: ref.values, diffs };
  return result.reference;
}

function prepareRows(rows: ReadonlyArray<AssumptionRow>, companyId: string | null, ranges: RangeOverrides | null | undefined, notes: string[]) {
  const o = withRangeOverrides(rows, companyId, ranges);
  for (const k of o.missingBase) notes.push(`${SENSITIVITY_FACTOR_LABELS[k]}: القيمة الأساسية غير مدخلة، فلم يُطبَّق النطاق المرسل`);
  for (const k of o.invalid) notes.push(`${SENSITIVITY_FACTOR_LABELS[k]}: النطاق المرسل غير صالح (يجب أن يكون المنخفض ≤ الأساسي ≤ المرتفع)`);
  const requestKeys = new Set<RangeFactorKey>((Object.keys(ranges ?? {}) as RangeFactorKey[]).filter((k) => isRangeKey(k) && !o.missingBase.includes(k) && !o.invalid.includes(k)));
  return { rows: o.rows, requestKeys };
}

function hrdfFactor(rows: ReadonlyArray<AssumptionRow>, companyId: string | null): FactorPlan {
  const on = resolveAssumption(rows, 'INCLUDE_HRDF', companyId, 'base').value !== false;
  return { key: 'INCLUDE_HRDF', lowText: 'محتسب', baseText: on ? 'محتسب' : 'غير محتسب', highText: 'غير محتسب', low: { scenario: 'base', hrdf: true }, high: { scenario: 'base', hrdf: false } };
}

function overtimeFactor(company: WfCompanyInput | null | undefined): FactorPlan {
  const b = company?.costSettings?.overtimeHourlyBasis ?? 'BASIC';
  return {
    key: 'OVERTIME_BASIS',
    lowText: OVERTIME_BASIS_SHORT.BASIC,
    baseText: OVERTIME_BASIS_SHORT[b],
    highText: OVERTIME_BASIS_SHORT.TOTAL_PLUS_HALF_BASIC,
    low: { scenario: 'base', overtime: 'BASIC' },
    high: { scenario: 'base', overtime: 'TOTAL_PLUS_HALF_BASIC' },
  };
}

function medicalFactor(ext: MedicalExtremes, baseText: string): FactorPlan {
  return { key: 'MEDICAL_CLASS', lowText: premiumText(ext.low), baseText, highText: premiumText(ext.high), low: { scenario: 'base', medical: 'low' }, high: { scenario: 'base', medical: 'high' } };
}

const skip = (key: SensitivityFactorKey, reason: string) => ({ key, label: SENSITIVITY_FACTOR_LABELS[key], reason });

// ---------------------------------------------------------------------------
// Hire scenario
// ---------------------------------------------------------------------------

/**
 * Sensitivity of a hire-scenario candidate set: one outcome per candidate, the figure being the page's
 * comparison figure (after HRDF, with the levy effect on the other expats) over `horizon` months.
 */
export function hireSensitivity(input: HireScenarioInput, opts: { horizon: 12 | 24 | 36; ranges?: RangeOverrides | null }): SensitivityResult {
  const notes: string[] = [];
  const companyId = input.company.id;
  const { rows, requestKeys } = prepareRows(input.assumptions, companyId, opts.ranges, notes);
  const hires = input.candidates.filter((c) => c.kind === 'SAUDI' || c.kind === 'EXPAT');
  const skipped: SensitivityResult['skipped'] = [];
  const extra: FactorPlan[] = [];
  const ext = medicalExtremes(input.company);
  if (!hires.length) skipped.push(skip('MEDICAL_CLASS', 'لا يوجد مرشح للتوظيف (سعودي أو وافد) في السيناريو'));
  else if (!ext) skipped.push(skip('MEDICAL_CLASS', 'أقل من فئتين بقسط مدخل في إعدادات الكلفة للشركة'));
  else extra.push(medicalFactor(ext, 'كما أُدخل لكل مرشح'));
  if (input.candidates.some((c) => c.kind === 'OVERTIME')) extra.push(overtimeFactor(input.company));
  else skipped.push(skip('OVERTIME_BASIS', 'لا بديل عمل إضافي في السيناريو'));
  if (input.candidates.some((c) => c.kind === 'SAUDI')) extra.push(hrdfFactor(rows, companyId));
  else skipped.push(skip('INCLUDE_HRDF', 'لا مرشح سعودي: دعم هدف لا ينطبق'));
  for (const k of ['RECRUITMENT_COST_SAUDI', 'RECRUITMENT_COST_EXPAT', 'VACANCY_MONTHS'] as const) skipped.push(skip(k, 'لا تدخل في كلفة سيناريو التوظيف'));

  const h = opts.horizon;
  const evaluate = (mod: SensitivityMod) => {
    const company = mod.overtime ? withOvertimeBasis(input.company, mod.overtime) : input.company;
    const candidates: HireCandidate[] = mod.medical && ext ? input.candidates.map((c) => (c.kind === 'SAUDI' || c.kind === 'EXPAT' ? { ...c, medicalClass: ext[mod.medical!].cls } : c)) : [...input.candidates];
    const r = hireScenario({ ...input, company, candidates, assumptions: sensitivityRows(rows, mod) });
    return { ids: r.candidates.map((c) => `candidate-${c.index + 1}`), labels: r.candidates.map((c) => c.label), values: r.candidates.map((c) => c.windows[h].total) };
  };
  return runCore({
    decision: 'HIRE',
    title: `${SENSITIVITY_DECISION_LABELS.HIRE} — ${input.company.name}`,
    metricLabel: `الكلفة بعد دعم هدف مع أثر المقابل المالي على بقية الوافدين (${h} شهراً)`,
    horizonMonths: h,
    rows,
    companyId,
    rangeKeys: ['ANNUAL_RAISE_PCT', 'ANNUAL_TICKET_COST', 'EXIT_REENTRY_VISAS_PER_YEAR'],
    requestKeys,
    extraFactors: extra,
    skipped,
    notes,
    evaluate,
  });
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

/**
 * Sensitivity of an exit: the figure is net paid to the employee (payable + offsets) + replacement cost.
 * The Art. 77 risk is never added (reported apart in the notes), sunk fees are information only.
 */
export function exitSensitivity(input: ExitCostInput, opts: { ranges?: RangeOverrides | null } = {}): SensitivityResult {
  const notes: string[] = [];
  const companyId = input.employee.legalCompanyId || null;
  const { rows, requestKeys } = prepareRows(input.assumptions, companyId, opts.ranges, notes);
  const replSaudi = input.replacementIsSaudi ?? nationalityClass(input.employee.nationality) === 'SAUDI';
  const settings = input.settingsCompany ?? input.company ?? null;
  const ext = medicalExtremes(settings);
  const vacancyBase = resolveAssumption(rows, 'VACANCY_MONTHS', companyId, 'base').value;
  const skipped: SensitivityResult['skipped'] = [];
  const extra: FactorPlan[] = [];
  if (!(typeof vacancyBase === 'number' && vacancyBase > 0) && !assumptionRange(rows, 'VACANCY_MONTHS', companyId)) skipped.push(skip('MEDICAL_CLASS', 'لا كلفة شغور (أشهر الشغور غير مدخلة): فئة التأمين لا تؤثر'));
  else if (!ext) skipped.push(skip('MEDICAL_CLASS', 'أقل من فئتين بقسط مدخل في إعدادات الكلفة للشركة'));
  else extra.push(medicalFactor(ext, input.employee.medicalInsuranceClass ? `${input.employee.medicalInsuranceClass} (فئة الموظف)` : 'غير محددة للموظف'));
  skipped.push(skip(replSaudi ? 'RECRUITMENT_COST_EXPAT' : 'RECRUITMENT_COST_SAUDI', `البديل ${replSaudi ? 'سعودي' : 'وافد'}: تُستخدم كلفة توظيف ${replSaudi ? 'السعودي' : 'الوافد'}`));
  skipped.push(skip('INCLUDE_HRDF', 'كلفة الشغور قبل الدعم، ولا دعم في مستحقات الخروج'));
  skipped.push(skip('OVERTIME_BASIS', 'الإضافي غير المصروف لا يدخل في كلفة الإنهاء (تضيفه شاشة التصفية)'));
  skipped.push(skip('ANNUAL_RAISE_PCT', 'لا يدخل في كلفة الإنهاء'));

  let risk = 0;
  const evaluate = (mod: SensitivityMod) => {
    const employee = mod.medical && ext ? { ...input.employee, medicalInsuranceClass: ext[mod.medical].cls } : input.employee;
    const r = computeExitCost({ ...input, employee, scenario: 'base', assumptions: sensitivityRows(rows, mod) });
    if (mod.scenario === 'base' && !mod.rangePin && !mod.medical) risk = r.totals.risk;
    return { ids: ['exit'], labels: [input.employee.name], values: [r.totals.netToEmployee + r.totals.replacement] };
  };
  const result = runCore({
    decision: 'EXIT',
    title: `${SENSITIVITY_DECISION_LABELS.EXIT} — ${input.employee.name}`,
    metricLabel: 'صافي ما يُدفع للموظف + كلفة الإحلال (دون خطر المادة 77)',
    horizonMonths: 0,
    rows,
    companyId,
    rangeKeys: [replSaudi ? 'RECRUITMENT_COST_SAUDI' : 'RECRUITMENT_COST_EXPAT', 'VACANCY_MONTHS'],
    requestKeys,
    extraFactors: extra,
    skipped,
    notes,
    evaluate,
  });
  result.notes.unshift(`خطر التعويض عن الإنهاء غير المشروع (المادة 77) ${NF.format(risk)} ر.س سيناريو خطر منفصل: لا يُجمع مع الرقم.`);
  return result;
}

// ---------------------------------------------------------------------------
// Workforce plan
// ---------------------------------------------------------------------------

/**
 * Sensitivity of a workforce plan (live projection): two outcomes, the plan total after HRDF over the plan
 * horizon and what the plan adds (total − the current workforce without the plan).
 */
export function planSensitivity(base: PlanBaseInput, plan: PlanDefinition, opts: { turnoverAsOf?: Date | null; ranges?: RangeOverrides | null } = {}): SensitivityResult {
  const notes: string[] = ['التوقع معاد حسابه بالبيانات الحالية (لا باللقطة المجمّدة عند الاعتماد).'];
  const companyId = plan.companyId || null;
  const { rows, requestKeys } = prepareRows(base.assumptions, companyId, opts.ranges, notes);
  const companies = new Map(base.companies.map((c) => [c.id, c]));
  const hirePositions = plan.positions.filter((p) => p.kind !== 'EXIT');
  const extFor = (cid: string | null | undefined) => medicalExtremes(cid ? companies.get(cid) : null);
  const skipped: SensitivityResult['skipped'] = [];
  const extra: FactorPlan[] = [];
  const withExt = hirePositions.filter((p) => extFor(p.companyId ?? companyId));
  if (!hirePositions.length) skipped.push(skip('MEDICAL_CLASS', 'لا تعيينات مخططة في الخطة'));
  else if (!withExt.length) skipped.push(skip('MEDICAL_CLASS', 'أقل من فئتين بقسط مدخل في إعدادات الكلفة لشركة التعيينات'));
  else {
    const one = extFor(withExt[0].companyId ?? companyId)!;
    const single = new Set(withExt.map((p) => p.companyId ?? companyId)).size === 1;
    extra.push({ ...medicalFactor(one, 'كما أُدخل لكل تعيين'), ...(single ? {} : { lowText: 'أرخص فئة مدخلة لكل شركة', highText: 'أغلى فئة مدخلة لكل شركة' }) });
  }
  extra.push(hrdfFactor(rows, companyId));
  skipped.push(skip('OVERTIME_BASIS', 'لا عمل إضافي مخطط في الخطة'));
  skipped.push(skip('ANNUAL_RAISE_PCT', 'الخطة تنص على زياداتها صراحة: افتراض الزيادة السنوية لا يُطبَّق فيها'));
  for (const k of ['RECRUITMENT_COST_SAUDI', 'RECRUITMENT_COST_EXPAT', 'VACANCY_MONTHS'] as const) skipped.push(skip(k, 'لا تدخل في توقع الخطة'));

  const evaluate = (mod: SensitivityMod) => {
    const cs = mod.overtime ? base.companies.map((c) => withOvertimeBasis(c, mod.overtime!)) : base.companies;
    const positions = mod.medical
      ? plan.positions.map((p) => {
          if (p.kind === 'EXIT') return p;
          const e = extFor(p.companyId ?? companyId);
          return e ? { ...p, medicalClass: e[mod.medical!].cls } : p;
        })
      : plan.positions;
    const pr = projectPlan({ ...base, companies: cs, assumptions: sensitivityRows(rows, mod) }, { ...plan, positions }, { turnoverAsOf: opts.turnoverAsOf ?? null, scenario: 'base' });
    const t = pr.totals.horizon;
    return { ids: ['total', 'delta'], labels: ['إجمالي الخطة بعد دعم هدف', 'ما تضيفه الخطة (مقارنة بالقوى الحالية)'], values: [t?.totalAfterHrdf ?? 0, t?.deltaAfterHrdf ?? 0] };
  };
  const n = Math.max(1, Math.min(36, Math.floor(plan.months || 12)));
  return runCore({
    decision: 'PLAN',
    title: `${SENSITIVITY_DECISION_LABELS.PLAN} — ${plan.name}`,
    metricLabel: `إجمالي الخطة بعد دعم هدف لكامل مدتها (${n} شهراً)`,
    horizonMonths: n,
    rows,
    companyId,
    rangeKeys: ['ANNUAL_TICKET_COST', 'EXIT_REENTRY_VISAS_PER_YEAR'],
    requestKeys,
    extraFactors: extra,
    skipped,
    notes,
    evaluate,
  });
}
