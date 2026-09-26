// Saudization planner («مخطط السعودة»): occupation localization compliance and the band solver. PURE,
// deterministic, explainable (no AI). SPEC §2.4, §2.5, §3 nitaqatSolve / localizationCompliance.
//
// localizationCompliance — decisions (LocalizationDecision rows) whose phase is in force on the date:
// - Occupation matching: the employee's occupationCode equals a code of the decision (a value made of
//   digits), or the normalized occupationName equals a normalized Arabic OR English occupation name of the
//   decision (normalization of nationality.ts: lower case, Arabic letter forms, punctuation; leading «ال»
//   dropped per word). No substring matching (false positives). Some decisions publish English names only
//   (accounting). An employee with neither a name nor a code is listed as «مهنة غير محددة».
// - Counted Saudi: Saudi national (GCC nationals are not Saudis here), contract documented in Qiwa on the
//   date (same gate as Nitaqat), wage registered in GOSI (basic + cash housing) >= the decision's minimum
//   wage (unknown minimum = any wage, flagged).
// - minEstablishmentSize = minimum number of workers in the targeted occupations: below it the decision
//   does not apply (unknown = applies, flagged). A phase may carry its own size range (minWorkers /
//   maxWorkers, e.g. accounting 30% for 3–4 workers from 2029) and an activity variant (pharmacy: 35% /
//   65% / 55% by activity; the variant without activity codes is used, the others are listed).
// - Required Saudis = p × t rounded half up (the decisions' own rounding: 9.2 -> 9, 11.5 -> 12);
//   compliant when counted Saudis >= required. Shortfall: replacements = required − s (non-Saudis
//   replaced, total unchanged); hires = minimal k with s + k >= round(p × (t + k)) (none when p = 100%).
//
// solveToBand — minimum number of NEW weight-1 Saudi hires (GOSI wage >= 4,000) to reach a band on a date:
// 1. (documentFirst, default on) document the undocumented Saudi / GCC contracts (zero cost), largest
//    weight first;
// 2. (raiseHalfWeight, default on) raise counted Saudis paid 3,000–3,999 to 4,000 (raise on the basic),
//    cheapest first;
// 3. hire weight-1 Saudis one by one (exact recount with the caps each time) until the band is reached;
// 4. raises that are not needed any more with that number of hires are dropped (last first).
// Alternative (replaceExpats): the same from step 3 with expat -> Saudi replacements (cheapest 24-month
// cost first). Costs reuse the true cost engine (computeTrueCost): the hypothetical hire is a
// WfEmployeeInput (NEW GOSI regime, HRDF subsidy per the assumptions: he applies in his own window) and
// nothing is written to the database (no Employee / SalaryChange rows: the money gateway owns those
// writes). A raise's cost is the change of the employer COST only (wage, GOSI, EOSB), never an HRDF
// change: HRDF eligibility is decided once in the application window (true-cost.ts hrdfWindowDecision),
// so raising an existing employee cannot create a subsidy (review fix P2-1).
import { roundMoney } from '@/lib/money';
import { nationalityClass, normalizeNationalityKey } from '@/lib/nationality';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import {
  BAND_LABELS,
  NITAQAT_ASSUMPTIONS,
  NITAQAT_EVIDENCE,
  bandForCounts,
  bandRank,
  curveSetFor,
  isActiveOn,
  isQiwaDocumentedOn,
  nitaqatCounts,
  nitaqatEstimate,
  nitaqatWage,
  round2,
  WAGE_FULL_WEIGHT,
  WAGE_HALF_WEIGHT,
  type CountsResult,
  type CurveSet,
  type NitaqatBand,
  type NitaqatEntityInput,
  type NitaqatFlag,
} from '@/lib/workforce/nitaqat';
import type { AssumptionRow, GosiRateRow, RuleEvidence, RuleRow, TrueCostResult, WfCompanyInput, WfEmployeeInput } from '@/lib/workforce/types';
import type { PayrollSettings } from '@/lib/payroll-core';

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Localization decisions
// ---------------------------------------------------------------------------

/** A LocalizationDecision row (Prisma; extra columns ignored). */
export interface LocalizationDecisionRow {
  id: string;
  groupNameAr: string;
  occupationsJson: string;
  phasesJson: string;
  minEstablishmentSize?: number | null;
  minWage?: number | null;
  scope?: string | null;
  decisionNo?: string | null;
  decisionDate?: Date | null;
  status: string;
  sourceUrl?: string | null;
  page?: number | null;
  notes?: string | null;
  createdAt?: Date | null;
}

export interface DecisionPhase {
  pct: number;
  /** 'YYYY-MM-DD'. */
  effectiveFrom: string;
  /** Size range of this phase (workers in the targeted occupations); null = the decision's minimum. */
  minWorkers?: number | null;
  maxWorkers?: number | null;
  /** Activity variant (same date, different % by activity). */
  activity?: string | null;
  activityCodes?: string[];
  /** Free text of the source («establishments with 3 or 4 workers…»). */
  appliesTo?: string | null;
}

export interface ParsedDecision {
  id: string;
  groupNameAr: string;
  occupations: string[];
  phases: DecisionPhase[];
  minEstablishmentSize: number | null;
  minWage: number | null;
  scope: string | null;
  decisionNo: string | null;
  decisionDate: string | null;
  status: string;
  sourceUrl: string | null;
  page: number | null;
  notes: string | null;
  /** Unreadable JSON (the row is kept, with this message). */
  parseError: string | null;
}

export const DECISION_STATUS_LABELS: Record<string, string> = {
  VERIFIED_PRIMARY: 'موثّق',
  PARTIAL: 'موثّق جزئياً',
  PROVISIONAL: 'مؤقت',
  USER_INPUT: 'إدخال المنشأة',
  AMBIGUOUS: 'يحتاج مطابقة',
};

function parseJsonArray(raw: string | null | undefined): unknown[] | null {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** Occupations: strings, or objects {nameAr | name, nameEn, code}. */
export function parseOccupations(raw: string | null | undefined): string[] | null {
  const arr = parseJsonArray(raw);
  if (!arr) return null;
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (typeof v === 'number' && Number.isFinite(v)) out.push(String(v));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const name of [o.nameAr ?? o.name, o.nameEn]) if (typeof name === 'string' && name.trim()) out.push(name.trim());
      if ((typeof o.code === 'string' && o.code.trim()) || typeof o.code === 'number') out.push(String(o.code).trim());
    }
  }
  return out;
}

/** Phases [{pct, effectiveFrom}] sorted by date; invalid entries dropped. */
export function parsePhases(raw: string | null | undefined): DecisionPhase[] | null {
  const arr = parseJsonArray(raw);
  if (!arr) return null;
  const out: DecisionPhase[] = [];
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const pct = typeof o.pct === 'number' ? o.pct : typeof o.pct === 'string' ? Number(o.pct) : NaN;
    const from = typeof o.effectiveFrom === 'string' ? o.effectiveFrom.slice(0, 10) : '';
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || !/^\d{4}-\d{2}-\d{2}$/.test(from)) continue;
    const int = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
    const phase: DecisionPhase = { pct, effectiveFrom: from };
    if (int(o.minWorkers) !== null) phase.minWorkers = int(o.minWorkers);
    if (int(o.maxWorkers) !== null) phase.maxWorkers = int(o.maxWorkers);
    if (typeof o.activity === 'string' && o.activity.trim()) phase.activity = o.activity.trim();
    if (Array.isArray(o.activityCodes)) phase.activityCodes = o.activityCodes.filter((c): c is string => typeof c === 'string' && !!c.trim());
    if (typeof o.appliesTo === 'string' && o.appliesTo.trim()) phase.appliesTo = o.appliesTo.trim();
    out.push(phase);
  }
  return out.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || (a.activityCodes?.length ?? 0) - (b.activityCodes?.length ?? 0));
}

export function parseDecision(r: LocalizationDecisionRow): ParsedDecision {
  const occupations = parseOccupations(r.occupationsJson);
  const phases = parsePhases(r.phasesJson);
  const errors: string[] = [];
  if (occupations === null) errors.push('قائمة المهن ليست JSON صالحاً');
  if (phases === null) errors.push('المراحل ليست JSON صالحاً');
  return {
    id: r.id,
    groupNameAr: r.groupNameAr,
    occupations: occupations ?? [],
    phases: phases ?? [],
    minEstablishmentSize: typeof r.minEstablishmentSize === 'number' ? r.minEstablishmentSize : null,
    minWage: typeof r.minWage === 'number' ? r.minWage : null,
    scope: r.scope ?? null,
    decisionNo: r.decisionNo ?? null,
    decisionDate: r.decisionDate ? ymd(r.decisionDate) : null,
    status: r.status,
    sourceUrl: r.sourceUrl ?? null,
    page: r.page ?? null,
    notes: r.notes ?? null,
    parseError: errors.length ? errors.join('؛ ') : null,
  };
}

/** Normalized occupation (nationality.ts normalization; leading «ال» of each word dropped). */
export function normalizeOccupation(s: string | null | undefined): string {
  return normalizeNationalityKey(s ?? '')
    .split(' ')
    .map((w) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w))
    .join(' ');
}

export interface OccupationMatcher {
  names: ReadonlySet<string>;
  codes: ReadonlySet<string>;
}

export function occupationMatcher(occupations: ReadonlyArray<string>): OccupationMatcher {
  const names = new Set<string>();
  const codes = new Set<string>();
  for (const o of occupations) {
    const t = o.trim();
    if (/^\d+$/.test(t)) codes.add(t);
    else if (t) names.add(normalizeOccupation(t));
  }
  return { names, codes };
}

export function matchesOccupation(e: { occupationName?: string | null; occupationCode?: string | null }, m: OccupationMatcher): boolean {
  const code = (e.occupationCode ?? '').trim();
  if (code && m.codes.has(code)) return true;
  const name = normalizeOccupation(e.occupationName);
  return !!name && m.names.has(name);
}

export function hasOccupation(e: { occupationName?: string | null; occupationCode?: string | null }): boolean {
  return !!(e.occupationName ?? '').trim() || !!(e.occupationCode ?? '').trim();
}

/** Does a phase apply to `total` workers in the targeted occupations (its own range, else the decision minimum)? */
export function phaseFitsSize(p: DecisionPhase, total: number, decisionMin: number | null): boolean {
  const min = p.minWorkers ?? decisionMin;
  if (min !== null && min !== undefined && total < min) return false;
  if (p.maxWorkers !== null && p.maxWorkers !== undefined && total > p.maxWorkers) return false;
  return true;
}

/**
 * Phase in force on `date` for `total` workers: the latest effectiveFrom <= date among the phases whose
 * size range fits. Same-date activity variants: the one without activity codes, the others in `variants`.
 */
export function phaseOn(phases: ReadonlyArray<DecisionPhase>, date: string, total = Number.MAX_SAFE_INTEGER, decisionMin: number | null = null): { phase: DecisionPhase; variants: DecisionPhase[] } | null {
  const fit = phases.filter((p) => p.effectiveFrom <= date && phaseFitsSize(p, total, decisionMin));
  if (!fit.length) return null;
  const last = fit.reduce((m, p) => (p.effectiveFrom > m ? p.effectiveFrom : m), '');
  const same = fit.filter((p) => p.effectiveFrom === last);
  const main = same.find((p) => !p.activityCodes?.length && !p.activity) ?? same.find((p) => !p.activityCodes?.length) ?? same[0];
  return { phase: main, variants: same.filter((p) => p !== main) };
}

/** Saudis required: p × t rounded half up (the decisions' rounding, e.g. 9.2 -> 9, 11.5 -> 12). */
export function requiredSaudis(total: number, pctRequired: number): number {
  return Math.floor((pctRequired * total) / 100 + 0.5 + 1e-9);
}

/**
 * How the required head count was obtained, shown in the compliance table (review fix P2-5): with the
 * rounding explicit when p × t is not whole, e.g. «المطلوب 2 = 40% × 6 = 2.4 مقرّبة» (so 33.33% against
 * 40% can still be compliant).
 */
export function requiredSaudisText(total: number, pctRequired: number): string {
  const required = requiredSaudis(total, pctRequired);
  const exact = round2((pctRequired * total) / 100);
  const head = `المطلوب ${required} = ${pctRequired}% × ${total}`;
  return Math.abs(exact - required) < 1e-9 ? head : `${head} = ${exact} مقرّبة`;
}

/** Shortfall in heads for a required % of t workers with s counted Saudis (see the header). */
export function localizationShortfall(s: number, t: number, pctRequired: number): { required: number; replacements: number; hires: number | null } {
  const required = requiredSaudis(t, pctRequired);
  const replacements = Math.max(0, Math.min(t - s, required - s));
  if (s >= required) return { required, replacements: 0, hires: 0 };
  if (pctRequired >= 100) return { required, replacements, hires: null };
  for (let k = 1; k <= 10 * t + 1000; k++) if (s + k >= requiredSaudis(t + k, pctRequired)) return { required, replacements, hires: k };
  return { required, replacements, hires: null };
}

export interface ComplianceEmployee {
  id: string;
  name: string;
  occupation: string;
  isSaudi: boolean;
  counted: boolean;
  /** Why a Saudi is not counted (Arabic), null when counted or not Saudi. */
  reason: string | null;
}

export interface ComplianceItem {
  decisionId: string;
  groupNameAr: string;
  status: string;
  statusLabel: string;
  decisionNo: string | null;
  decisionDate: string | null;
  sourceUrl: string | null;
  page: number | null;
  scope: string | null;
  notes: string | null;
  parseError: string | null;
  phase: DecisionPhase | null;
  /** Other activity variants of the phase in force (e.g. pharmacy by activity). */
  variants: DecisionPhase[];
  inEffect: boolean;
  applies: boolean;
  appliesReason: string | null;
  minEstablishmentSize: number | null;
  minWage: number | null;
  total: number;
  saudisCounted: number;
  saudisBelowMinWage: number;
  saudisUndocumented: number;
  actualPct: number | null;
  requiredPct: number | null;
  /** Saudis required (p × t rounded half up). */
  requiredSaudis: number | null;
  /** p × t before rounding (2 decimals). */
  requiredExact: number | null;
  /** «المطلوب 2 = 40% × 6 = 2.4 مقرّبة» (requiredSaudisText), null when not applicable. */
  requiredText: string | null;
  compliant: boolean | null;
  shortfallHires: number | null;
  shortfallReplacements: number;
  upcoming: Array<DecisionPhase & { monthsAway: number }>;
  employees: ComplianceEmployee[];
}

export interface ComplianceResult {
  date: string;
  companyId: string;
  items: ComplianceItem[];
  unknownOccupation: { count: number; employees: Array<{ id: string; name: string }> };
  flags: NitaqatFlag[];
}

export interface ComplianceInput {
  companyId: string;
  employees: ReadonlyArray<WfEmployeeInput>;
  decisions: ReadonlyArray<LocalizationDecisionRow | ParsedDecision>;
  /** Upcoming phases listed within this many months (default 24). */
  upcomingMonths?: number;
}

function monthsAway(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function isParsed(d: LocalizationDecisionRow | ParsedDecision): d is ParsedDecision {
  return Array.isArray((d as ParsedDecision).phases);
}

/** SPEC §3 localizationCompliance (see the header). Decisions sorted by group name, then id. */
export function localizationCompliance(input: ComplianceInput, date: Date): ComplianceResult {
  const day = ymd(date);
  const horizon = input.upcomingMonths ?? 24;
  const limit = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + horizon, date.getUTCDate()));
  const limitDay = ymd(limit);
  const active = input.employees.filter((e) => isActiveOn(e, date)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const decisions = input.decisions.map((d) => (isParsed(d) ? d : parseDecision(d))).sort((a, b) => a.groupNameAr.localeCompare(b.groupNameAr) || a.id.localeCompare(b.id));
  const flags: NitaqatFlag[] = [];
  const unknown = active.filter((e) => !hasOccupation(e));
  if (unknown.length) flags.push({ code: 'CATEGORIES_NOT_MODELLED', severity: 'WARNING', message: `${unknown.length} موظف بلا مهنة محددة (مهنة غير محددة): لا يمكن فحصهم مقابل قرارات التوطين`, employeeIds: unknown.map((e) => e.id) });

  const items: ComplianceItem[] = [];
  for (const d of decisions) {
    const upcoming = d.phases.filter((p) => p.effectiveFrom > day && p.effectiveFrom <= limitDay).map((p) => ({ ...p, monthsAway: monthsAway(day, p.effectiveFrom) }));
    const started = d.phases.some((p) => p.effectiveFrom <= day);
    if (!started && !upcoming.length) continue;
    const matcher = occupationMatcher(d.occupations);
    const matched = active.filter((e) => matchesOccupation(e, matcher));
    const current = phaseOn(d.phases, day, matched.length, d.minEstablishmentSize);
    const phase = current?.phase ?? null;
    let counted = 0;
    let below = 0;
    let undocumented = 0;
    const emps: ComplianceEmployee[] = matched.map((e) => {
      const isSaudi = nationalityClass(e.nationality) === 'SAUDI';
      let reason: string | null = null;
      if (isSaudi) {
        if (!isQiwaDocumentedOn(e, date)) {
          reason = 'العقد غير موثّق في قوى';
          undocumented++;
        } else if (d.minWage !== null && nitaqatWage(e) < d.minWage) {
          reason = `الأجر المسجّل ${round2(nitaqatWage(e))} أقل من الحد الأدنى ${d.minWage}`;
          below++;
        } else counted++;
      }
      return { id: e.id, name: e.name, occupation: e.occupationName || e.occupationCode || '', isSaudi, counted: isSaudi && reason === null, reason };
    });
    const total = matched.length;
    const applies = total > 0 && !!phase;
    const appliesReason =
      total === 0
        ? 'لا يعمل في المنشأة أحد في المهن المستهدفة'
        : !started
          ? 'لم تبدأ أول مرحلة بعد'
          : !phase
            ? `عدد العاملين في المهن المستهدفة (${total}) أقل من الحد الأدنى للقرار (${d.minEstablishmentSize ?? '—'})`
            : d.minEstablishmentSize === null && phase.minWorkers == null
              ? 'الحد الأدنى لحجم المنشأة غير معروف: افتُرض أن القرار يسري'
              : null;
    const required = phase ? phase.pct : null;
    const actual = total > 0 ? round2((counted / total) * 100) : null;
    const sf = required !== null && applies ? localizationShortfall(counted, total, required) : { required: null, replacements: 0, hires: 0 };
    items.push({
      decisionId: d.id,
      groupNameAr: d.groupNameAr,
      status: d.status,
      statusLabel: DECISION_STATUS_LABELS[(d.status ?? '').toUpperCase()] ?? d.status,
      decisionNo: d.decisionNo,
      decisionDate: d.decisionDate,
      sourceUrl: d.sourceUrl,
      page: d.page,
      scope: d.scope,
      notes: d.notes,
      parseError: d.parseError,
      phase,
      variants: current?.variants ?? [],
      inEffect: started,
      applies,
      appliesReason,
      minEstablishmentSize: d.minEstablishmentSize,
      minWage: d.minWage,
      total,
      saudisCounted: counted,
      saudisBelowMinWage: below,
      saudisUndocumented: undocumented,
      actualPct: actual,
      requiredPct: required,
      requiredSaudis: sf.required,
      requiredExact: sf.required !== null && required !== null ? round2((required * total) / 100) : null,
      requiredText: sf.required !== null && required !== null ? requiredSaudisText(total, required) : null,
      compliant: required !== null && applies && sf.required !== null ? counted >= sf.required : null,
      shortfallHires: sf.hires,
      shortfallReplacements: sf.replacements,
      upcoming,
      employees: emps,
    });
  }
  return { date: day, companyId: input.companyId, items, unknownOccupation: { count: unknown.length, employees: unknown.map((e) => ({ id: e.id, name: e.name })) }, flags };
}

// ---------------------------------------------------------------------------
// Band solver
// ---------------------------------------------------------------------------

export interface SolveOptions {
  /** Document undocumented Saudi / GCC contracts first (zero cost). Default true. */
  documentFirst?: boolean;
  /** Raise counted Saudis paid 3,000–3,999 to 4,000. Default true. */
  raiseHalfWeight?: boolean;
  /** Also compute the expat -> Saudi replacement alternative. Default false. */
  replaceExpats?: boolean;
  /** Basic salary of a hypothetical hire (default 4,000: GOSI wage 4,000 = weight 1). */
  hireBasic?: number;
  /** Monthly cash housing of the hypothetical hire (default 0). */
  hireHousing?: number;
  hireGender?: 'MALE' | 'FEMALE';
  hireCity?: string | null;
  hireMedicalClass?: string | null;
}

/** What the cost figures need (true cost engine inputs). null = counts only, no costs. */
export interface SolveCostContext {
  company: WfCompanyInput;
  rules: ReadonlyArray<RuleRow>;
  gosiRates: ReadonlyArray<GosiRateRow>;
  assumptions: ReadonlyArray<AssumptionRow>;
  payrollSettings?: PayrollSettings;
  annualLeaveDaysSetting?: number | null;
  /** Cost horizon in months (default 12). */
  months?: number;
}

export interface SolveInput {
  entity: NitaqatEntityInput;
  targetBand: NitaqatBand;
  byDate: Date;
  options?: SolveOptions;
  cost?: SolveCostContext | null;
}

export type SolverActionKind = 'DOCUMENT' | 'RAISE' | 'HIRE' | 'REPLACE';

export interface SolverAction {
  rank: number;
  kind: SolverActionKind;
  employeeId: string | null;
  name: string | null;
  count: number;
  /**
   * Weighted Saudi side added by the action (after caps). null in the restricted form (viewer who may
   * not see disability): a per-line gain of +3 / +4 for one person would reveal a disabled employee.
   */
  weightGain: number | null;
  /** Percentage / band after the action; null for DOCUMENT / RAISE / REPLACE lines in the restricted form. */
  pctAfter: number | null;
  bandAfter: NitaqatBand | null;
  /** Change of the employer cost in the first month (before subsidy). null = no cost context. */
  monthlyCost: number | null;
  /**
   * Average monthly change over the cost horizon: HIRE / REPLACE after the HRDF subsidy and the levy tier
   * effect; RAISE = cost change only (no HRDF change, see the header).
   */
  monthlyNetAvg: number | null;
  oneOffCost: number | null;
  /** Involves disability (health data): merged for viewers outside HR. */
  sensitive: boolean;
  note: string | null;
}

export interface SolveSnapshot {
  pct: number;
  band: NitaqatBand;
  x: number;
  saudiWeighted: number;
  expats: number;
}

export interface SolvePlanTotals {
  monthlyCost: number | null;
  monthlyNetAvg: number | null;
  oneOffCost: number | null;
}

export interface SolveResult {
  status: 'OK' | 'ALREADY_REACHED' | 'UNREACHABLE' | 'NO_ACTIVITY' | 'NO_EMPLOYEES';
  message: string | null;
  companyId: string;
  targetBand: NitaqatBand;
  byDate: string;
  before: SolveSnapshot | null;
  after: SolveSnapshot | null;
  documentations: number;
  raises: number;
  hires: number | null;
  actions: SolverAction[];
  totals: SolvePlanTotals;
  alternative: { replacements: number | null; actions: SolverAction[]; totals: SolvePlanTotals; after: SolveSnapshot | null } | null;
  hireProfile: { basic: number; housing: number; gosiWage: number; gender: string; city: string | null; regime: 'NEW' };
  costHorizonMonths: number | null;
  /** First projected month of the cost figures ('YYYY-MM'). */
  costStartMonth: string | null;
  flags: NitaqatFlag[];
  assumptions: string[];
  evidence: RuleEvidence[];
}

/** Search limit of the hire loop. */
const MAX_HIRES = 2000;

function snapshotOf(c: CountsResult, set: CurveSet): SolveSnapshot {
  const r = bandForCounts(c.saudiWeighted, c.expats, c.x, set);
  return { pct: round2(r.pct), band: r.band, x: c.x, saudiWeighted: c.saudiWeighted, expats: c.expats };
}

/** Hypothetical weight-1 Saudi hire (never written anywhere). */
export function hypotheticalSaudi(id: string, name: string, companyId: string, joinDate: Date, o: SolveOptions = {}): WfEmployeeInput {
  const housing = Math.max(0, o.hireHousing ?? 0);
  return {
    id,
    name,
    nationality: 'سعودي',
    gender: o.hireGender ?? 'MALE',
    dateOfBirth: null,
    joinDate,
    basicSalary: Math.max(0, o.hireBasic ?? WAGE_FULL_WEIGHT),
    allowances: housing > 0 ? [{ name: 'بدل سكن', amount: housing, isMonthly: true, countsTowardGosi: true, allowanceType: 'HOUSING' }] : [],
    gosiRegime: 'NEW',
    legalCompanyId: companyId,
    contractType: 'FULL_TIME',
    branchCity: o.hireCity ?? null,
    medicalInsuranceClass: o.hireMedicalClass ?? null,
    isPlanned: true,
    qiwaContractDocumented: true,
    qiwaContractDocumentedAt: null,
  };
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

interface CostRunner {
  run(employees: ReadonlyArray<WfEmployeeInput>, reportIds: ReadonlyArray<string>): TrueCostResult;
  months: number;
  startMonth: string;
  companyId: string;
}

function costRunner(ctx: SolveCostContext, start: string): CostRunner {
  const months = Math.max(1, Math.min(36, Math.floor(ctx.months ?? 12)));
  return {
    months,
    startMonth: start,
    companyId: ctx.company.id,
    run: (employees, reportIds) =>
      computeTrueCost(
        { employees, companies: [ctx.company], rules: ctx.rules, gosiRates: ctx.gosiRates, assumptions: ctx.assumptions, payrollSettings: ctx.payrollSettings, annualLeaveDaysSetting: ctx.annualLeaveDaysSetting },
        { startMonth: start, months, employeeIds: [...reportIds] },
      ),
  };
}

/** Monthly levy of the legal company in each projected month. */
function levySeries(tc: TrueCostResult, companyId: string): number[] {
  return tc.companies.find((c) => c.companyId === companyId)?.months.map((m) => m.levyTotal) ?? tc.monthKeys.map(() => 0);
}

function sum(a: ReadonlyArray<number>): number {
  return a.reduce((s, x) => s + x, 0);
}

/**
 * SPEC §3 nitaqatSolve (see the header). Deterministic: same employees, curves, rules and options give
 * the same plan.
 */
export function solveToBand(input: SolveInput): SolveResult {
  const o = input.options ?? {};
  const documentFirst = o.documentFirst !== false;
  const raiseHalf = o.raiseHalfWeight !== false;
  const date = input.byDate;
  const entity = input.entity;
  const flags: NitaqatFlag[] = [];
  const hireBasic = Math.max(0, o.hireBasic ?? WAGE_FULL_WEIGHT);
  const hireHousing = Math.max(0, o.hireHousing ?? 0);
  const hireProfile = { basic: hireBasic, housing: hireHousing, gosiWage: hireBasic + hireHousing, gender: o.hireGender ?? 'MALE', city: o.hireCity ?? null, regime: 'NEW' as const };
  const evidence = [NITAQAT_EVIDENCE['NITAQAT:FORMULA'], NITAQAT_EVIDENCE['NITAQAT:WEIGHTS'], NITAQAT_EVIDENCE['NITAQAT:CAPS'], NITAQAT_EVIDENCE['NITAQAT:QIWA_DOCUMENTED'], NITAQAT_EVIDENCE['NITAQAT:X_DEFINITION'], NITAQAT_EVIDENCE['NITAQAT:WAGE_BASIS']];
  const base: SolveResult = {
    status: 'OK',
    message: null,
    companyId: entity.companyId,
    targetBand: input.targetBand,
    byDate: ymd(date),
    before: null,
    after: null,
    documentations: 0,
    raises: 0,
    hires: 0,
    actions: [],
    totals: { monthlyCost: null, monthlyNetAvg: null, oneOffCost: null },
    alternative: null,
    hireProfile,
    costHorizonMonths: input.cost ? Math.max(1, Math.min(36, Math.floor(input.cost.months ?? 12))) : null,
    costStartMonth: input.cost ? monthKey(date) : null,
    flags,
    assumptions: [
      ...NITAQAT_ASSUMPTIONS,
      `التعيين المفترض سعودي بدوام كامل، أجره المسجّل في التأمينات ${hireBasic + hireHousing} (وزن ${hireBasic + hireHousing >= WAGE_FULL_WEIGHT ? 1 : '< 1'})، بالنظام الجديد للتأمينات، ويُوثَّق عقده في قوى.`,
      'رفع أجر السعودي من 3,000–3,999 إلى 4,000 يكون على الراتب الأساسي، وكلفته فرق كلفة صاحب العمل من محرك الكلفة الحقيقية (الأجر والتأمينات ونهاية الخدمة) دون أي تغيير في دعم هدف: أهلية الدعم تُقرَّر مرة واحدة بأجر فترة التقديم (الشهر 4–6 من المباشرة)، فلا يُكسبها رفع لاحق.',
      'كلفة الإحلال: كلفة السعودي المعيَّن ناقص كلفة الوافد الشهرية، ومكافأة نهاية خدمة الوافد لمرة واحدة (دون الإشعار والإجازة: راجع «كلفة الإنهاء»).',
      'لا يُكتب شيء في بيانات الموظفين: السيناريو افتراضي بالكامل.',
    ],
    evidence,
  };
  if (hireBasic + hireHousing < WAGE_FULL_WEIGHT) flags.push({ code: 'THRESHOLD_UNREACHABLE', severity: 'WARNING', message: `أجر التعيين المفترض (${hireBasic + hireHousing}) أقل من 4,000: وزنه أقل من 1` });

  const est = nitaqatEstimate(entity, date, { average: false });
  if (est.status !== 'OK') return { ...base, status: est.status, message: est.message, hires: null };
  const retail = est.retail;
  const set = curveSetFor(entity.curves, entity.activity!.key, date.getUTCFullYear());
  const evalEmps = (emps: ReadonlyArray<WfEmployeeInput>) => {
    const c = nitaqatCounts(emps, date, retail);
    return { counts: c, snap: snapshotOf(c, set) };
  };
  const reached = (s: SolveSnapshot) => bandRank(s.band) >= bandRank(input.targetBand);
  const initial = evalEmps(entity.employees);
  base.before = initial.snap;
  if (reached(initial.snap)) return { ...base, status: 'ALREADY_REACHED', message: `الكيان في ${BAND_LABELS[initial.snap.band]} فعلاً في ${ymd(date)}`, after: initial.snap };

  const origById = new Map(entity.employees.map((e) => [e.id, e]));
  let working: WfEmployeeInput[] = entity.employees.map((e) => ({ ...e }));
  let current = initial;
  type Step = { kind: SolverActionKind; employeeId: string | null; name: string | null; gain: number; snap: SolveSnapshot; sensitive: boolean; note: string | null; raiseBy?: number };
  const steps: Step[] = [];

  // 1. Documentation (zero cost).
  if (documentFirst) {
    const undoc = initial.counts.persons.filter((p) => p.side === 'SAUDI' && !p.counted && (p.potentialWeight ?? 0) > 0).sort((a, b) => (b.potentialWeight ?? 0) - (a.potentialWeight ?? 0) || (a.id < b.id ? -1 : 1));
    for (const p of undoc) {
      if (reached(current.snap)) break;
      working = working.map((e) => (e.id === p.id ? { ...e, qiwaContractDocumented: true, qiwaContractDocumentedAt: null } : e));
      const next = evalEmps(working);
      steps.push({ kind: 'DOCUMENT', employeeId: p.id, name: p.name, gain: round4(next.snap.saudiWeighted - current.snap.saudiWeighted), snap: next.snap, sensitive: !!origById.get(p.id)?.isDisabled, note: 'توثيق العقد في قوى: دون كلفة' });
      current = next;
    }
  }

  // 2. Raises 3,000–3,999 -> 4,000 (cheapest first).
  if (raiseHalf && !reached(current.snap)) {
    const cands = current.counts.persons
      .filter((p) => p.counted && p.nationalityClass === 'SAUDI' && p.wage >= WAGE_HALF_WEIGHT && p.wage < WAGE_FULL_WEIGHT && p.finalClass !== 'PART_TIME' && !origById.get(p.id)?.isStudent)
      .sort((a, b) => WAGE_FULL_WEIGHT - a.wage - (WAGE_FULL_WEIGHT - b.wage) || (a.id < b.id ? -1 : 1));
    for (const p of cands) {
      if (reached(current.snap)) break;
      const by = roundMoney(WAGE_FULL_WEIGHT - p.wage);
      working = working.map((e) => (e.id === p.id ? { ...e, basicSalary: roundMoney((e.basicSalary ?? 0) + by) } : e));
      const next = evalEmps(working);
      steps.push({ kind: 'RAISE', employeeId: p.id, name: p.name, gain: round4(next.snap.saudiWeighted - current.snap.saudiWeighted), snap: next.snap, sensitive: !!origById.get(p.id)?.isDisabled, note: `رفع الأجر المسجّل من ${round2(p.wage)} إلى 4,000 (+${by} على الأساسي)`, raiseBy: by });
      current = next;
    }
  }

  // 3. Hires.
  const joinDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const beforeHires = working;
  let hires = 0;
  let hired: WfEmployeeInput[] = [];
  let reachedPlan = reached(current.snap);
  while (!reachedPlan && hires < MAX_HIRES) {
    hires++;
    hired = [...hired, hypotheticalSaudi(`plan-hire-${String(hires).padStart(4, '0')}`, `تعيين سعودي مخطط ${hires}`, entity.companyId, joinDate, o)];
    current = evalEmps([...beforeHires, ...hired]);
    reachedPlan = reached(current.snap);
  }
  if (!reachedPlan) {
    flags.push({ code: 'THRESHOLD_UNREACHABLE', severity: 'ERROR', message: `لا يمكن بلوغ ${BAND_LABELS[input.targetBand]} بـ ${MAX_HIRES} تعيين أو أقل` });
    return { ...base, status: 'UNREACHABLE', message: `لا يمكن بلوغ ${BAND_LABELS[input.targetBand]} ضمن حد البحث`, hires: null, actions: [] };
  }

  // 4. Drop raises not needed with this number of hires (last first).
  let finalWorking = beforeHires;
  {
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      if (st.kind !== 'RAISE') continue;
      const orig = origById.get(st.employeeId!)!;
      const trial = finalWorking.map((e) => (e.id === st.employeeId ? { ...e, basicSalary: orig.basicSalary } : e));
      if (reached(evalEmps([...trial, ...hired]).snap)) {
        finalWorking = trial;
        steps.splice(i, 1);
      }
    }
  }
  // Recompute the cumulative results of the kept steps (the gains shown are those of the final plan).
  const kept: Step[] = [];
  {
    let w: WfEmployeeInput[] = entity.employees.map((e) => ({ ...e }));
    let prev = initial;
    for (const st of steps) {
      w = w.map((e) => (e.id === st.employeeId ? (st.kind === 'DOCUMENT' ? { ...e, qiwaContractDocumented: true, qiwaContractDocumentedAt: null } : { ...e, basicSalary: roundMoney((e.basicSalary ?? 0) + (st.raiseBy ?? 0)) }) : e));
      const next = evalEmps(w);
      kept.push({ ...st, gain: round4(next.snap.saudiWeighted - prev.snap.saudiWeighted), snap: next.snap });
      prev = next;
    }
    finalWorking = w;
  }
  const finalEval = evalEmps([...finalWorking, ...hired]);

  // ---- Costs (true cost engine) ----
  const runner = input.cost ? costRunner(input.cost, monthKey(date)) : null;
  const actions: SolverAction[] = [];
  const hireCost = { monthlyCost: null as number | null, monthlyNetAvg: null as number | null };
  let baselineRun: TrueCostResult | null = null;
  const raiseIds = kept.filter((s) => s.kind === 'RAISE').map((s) => s.employeeId!);
  if (runner) {
    baselineRun = runner.run(entity.employees, raiseIds);
  }
  const raiseCost = new Map<string, { month1: number; avg: number }>();
  if (runner && baselineRun && raiseIds.length) {
    // The raise on the basic for the whole horizon (as before: no revaluation of the past EOSB years).
    // HRDF plays no part: the cost delta below excludes the subsidy.
    const raisedEmps = entity.employees.map((e) => {
      const st = kept.find((s) => s.kind === 'RAISE' && s.employeeId === e.id);
      return st ? { ...e, basicSalary: roundMoney((e.basicSalary ?? 0) + (st.raiseBy ?? 0)) } : e;
    });
    const after = runner.run(raisedEmps, raiseIds);
    const levyDelta = sum(levySeries(after, runner.companyId)) - sum(levySeries(baselineRun, runner.companyId));
    const levyDelta1 = (levySeries(after, runner.companyId)[0] ?? 0) - (levySeries(baselineRun, runner.companyId)[0] ?? 0);
    for (const id of raiseIds) {
      const a = after.employees.find((x) => x.employeeId === id);
      const b = baselineRun.employees.find((x) => x.employeeId === id);
      if (!a || !b) continue;
      // Cost only: an HRDF difference is never part of a raise's cost (review fix P2-1).
      raiseCost.set(id, { month1: roundMoney(a.totals.month1.cost - b.totals.month1.cost), avg: roundMoney((a.totals.horizon.cost - b.totals.horizon.cost) / runner.months) });
    }
    // Raises do not change the Saudi / expat head count: no levy effect (checked).
    if (Math.abs(levyDelta) > 0.001 || Math.abs(levyDelta1) > 0.001) flags.push({ code: 'CAP_APPLIED', severity: 'INFO', message: 'تغيّر المقابل المالي مع رفع الأجور (غير متوقع): راجع البيانات' });
  }
  if (runner && hires > 0) {
    const empsForHire = kept.length ? finalWorking : entity.employees;
    const withHires = runner.run([...empsForHire, ...hired], hired.map((h) => h.id));
    const noHires = runner.run(empsForHire, []);
    const levyNow = levySeries(withHires, runner.companyId);
    const levyBefore = levySeries(noHires, runner.companyId);
    const levyDeltaTotal = sum(levyNow) - sum(levyBefore);
    const hiredCost = withHires.employees.reduce((s, r) => s + r.totals.horizon.net, 0);
    const hiredMonth1 = withHires.employees.reduce((s, r) => s + r.totals.month1.cost, 0);
    hireCost.monthlyCost = roundMoney(hiredMonth1 + (levyNow[0] - levyBefore[0]));
    hireCost.monthlyNetAvg = roundMoney((hiredCost + levyDeltaTotal) / runner.months);
    if (levyDeltaTotal < 0) flags.push({ code: 'CAP_APPLIED', severity: 'INFO', message: `التعيينات تنقل وافدين من شريحة 800 إلى 700 في المقابل المالي: وفر ${roundMoney(-levyDeltaTotal / runner.months)} ريال شهرياً في المتوسط (محسوب ضمن الكلفة)` });
  }

  let rank = 0;
  for (const st of kept) {
    const rc = st.kind === 'RAISE' && st.employeeId ? raiseCost.get(st.employeeId) : null;
    actions.push({
      rank: ++rank,
      kind: st.kind,
      employeeId: st.employeeId,
      name: st.name,
      count: 1,
      weightGain: st.gain,
      pctAfter: st.snap.pct,
      bandAfter: st.snap.band,
      monthlyCost: st.kind === 'DOCUMENT' ? 0 : rc ? rc.month1 : null,
      monthlyNetAvg: st.kind === 'DOCUMENT' ? 0 : rc ? rc.avg : null,
      oneOffCost: st.kind === 'DOCUMENT' ? 0 : runner ? 0 : null,
      sensitive: st.sensitive,
      note: st.note,
    });
  }
  if (hires > 0) {
    actions.push({
      rank: ++rank,
      kind: 'HIRE',
      employeeId: null,
      name: null,
      count: hires,
      weightGain: round4(finalEval.snap.saudiWeighted - (kept.length ? kept[kept.length - 1].snap.saudiWeighted : initial.snap.saudiWeighted)),
      pctAfter: finalEval.snap.pct,
      bandAfter: finalEval.snap.band,
      monthlyCost: hireCost.monthlyCost,
      monthlyNetAvg: hireCost.monthlyNetAvg,
      oneOffCost: null,
      sensitive: false,
      note: `توظيف ${hires} ${hires === 1 ? 'سعودي' : 'سعوديين'} بأجر مسجّل ${hireBasic + hireHousing} (الكلفة بعد دعم هدف وأثر المقابل المالي على الوافدين)`,
    });
  }
  const totals: SolvePlanTotals = runner
    ? {
        monthlyCost: roundMoney(actions.reduce((s, a) => s + (a.monthlyCost ?? 0), 0)),
        monthlyNetAvg: roundMoney(actions.reduce((s, a) => s + (a.monthlyNetAvg ?? 0), 0)),
        oneOffCost: 0,
      }
    : { monthlyCost: null, monthlyNetAvg: null, oneOffCost: null };

  // ---- Alternative: replace expats ----
  let alternative: SolveResult['alternative'] = null;
  if (o.replaceExpats) alternative = replacementPlan({ input, o, set, retail, beforeReplacement: kept.length ? finalWorking : entity.employees, baseAfterSteps: kept.length ? kept[kept.length - 1].snap : initial.snap, runner, joinDate, flags });

  return {
    ...base,
    after: finalEval.snap,
    documentations: kept.filter((s) => s.kind === 'DOCUMENT').length,
    raises: kept.filter((s) => s.kind === 'RAISE').length,
    hires,
    actions,
    totals,
    alternative,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function replacementPlan(a: {
  input: SolveInput;
  o: SolveOptions;
  set: CurveSet;
  retail: boolean;
  beforeReplacement: ReadonlyArray<WfEmployeeInput>;
  baseAfterSteps: SolveSnapshot;
  runner: CostRunner | null;
  joinDate: Date;
  flags: NitaqatFlag[];
}): NonNullable<SolveResult['alternative']> {
  const { input, set, retail, runner, joinDate } = a;
  const date = input.byDate;
  const reached = (s: SolveSnapshot) => bandRank(s.band) >= bandRank(input.targetBand);
  const expats = a.beforeReplacement.filter((e) => isActiveOn(e, date) && nationalityClass(e.nationality) === 'EXPAT');
  // Cheapest 24-month replacement first: 24 × (hire − expat) + one-off EOSB (needs costs; else by id).
  const cost = new Map<string, { avg: number; month1: number; eosb: number; ownLevy: number }>();
  let hireAvg: number | null = null;
  let hireMonth1: number | null = null;
  if (runner) {
    const probe = hypotheticalSaudi('plan-replace-probe', 'تعيين سعودي مخطط', input.entity.companyId, joinDate, a.o);
    const r = runner.run([...a.beforeReplacement, probe], [probe.id, ...expats.map((e) => e.id)]);
    for (const e of expats) {
      const x = r.employees.find((y) => y.employeeId === e.id);
      if (!x) continue;
      const own = x.months[0]?.lines.find((l) => l.key === 'EXPAT_LEVY')?.amount ?? 0;
      cost.set(e.id, { avg: x.totals.horizon.net / runner.months, month1: x.totals.month1.cost, eosb: x.liabilities.eosbEmployerAtStart, ownLevy: own });
    }
    const h = r.employees.find((y) => y.employeeId === probe.id);
    hireAvg = h ? h.totals.horizon.net / runner.months : null;
    hireMonth1 = h ? h.totals.month1.cost : null;
  }
  const ordered = [...expats].sort((x, y) => {
    if (runner && hireAvg !== null) {
      const cx = cost.get(x.id);
      const cy = cost.get(y.id);
      const kx = cx ? 24 * (hireAvg - cx.avg) + cx.eosb : 0;
      const ky = cy ? 24 * (hireAvg - cy.avg) + cy.eosb : 0;
      if (kx !== ky) return kx - ky;
    }
    return x.id < y.id ? -1 : 1;
  });
  let working = [...a.beforeReplacement];
  let snap = a.baseAfterSteps;
  const actions: SolverAction[] = [];
  const removed: string[] = [];
  const added: WfEmployeeInput[] = [];
  for (const e of ordered) {
    if (reached(snap)) break;
    const hire = hypotheticalSaudi(`plan-replace-${String(added.length + 1).padStart(4, '0')}`, `سعودي بديل ${added.length + 1}`, input.entity.companyId, joinDate, a.o);
    working = [...working.filter((w) => w.id !== e.id), hire];
    removed.push(e.id);
    added.push(hire);
    const c = nitaqatCounts(working, date, retail);
    const next = snapshotOf(c, set);
    const ec = cost.get(e.id);
    actions.push({
      rank: actions.length + 1,
      kind: 'REPLACE',
      employeeId: e.id,
      name: e.name,
      count: 1,
      weightGain: round4(next.saudiWeighted - snap.saudiWeighted),
      pctAfter: next.pct,
      bandAfter: next.band,
      monthlyCost: runner && ec && hireMonth1 !== null ? roundMoney(hireMonth1 - ec.month1) : null,
      monthlyNetAvg: runner && ec && hireAvg !== null ? roundMoney(hireAvg - ec.avg) : null,
      oneOffCost: runner && ec ? roundMoney(ec.eosb) : null,
      sensitive: false,
      note: 'إحلال سعودي محل وافد: الفرق الشهري بعد دعم هدف، ومكافأة نهاية خدمة الوافد لمرة واحدة',
    });
    snap = next;
  }
  if (!reached(snap)) {
    a.flags.push({ code: 'THRESHOLD_UNREACHABLE', severity: 'WARNING', message: `الإحلال وحده لا يكفي لبلوغ ${BAND_LABELS[input.targetBand]} (كل الوافدين مُحلّون)` });
    return { replacements: null, actions, totals: { monthlyCost: null, monthlyNetAvg: null, oneOffCost: null }, after: snap };
  }
  // Levy effect on the remaining expats (tiers), beyond the removed expats' own levy.
  let levyAvg = 0;
  let levy1 = 0;
  if (runner && added.length) {
    const before = runner.run(a.beforeReplacement, []);
    const after = runner.run(working, []);
    const lb = levySeries(before, runner.companyId);
    const la = levySeries(after, runner.companyId);
    const ownTotal = removed.reduce((s, id) => s + (cost.get(id)?.ownLevy ?? 0), 0);
    levy1 = la[0] - lb[0] + ownTotal;
    // Own levy of the removed expats is already in their cost: only the tier change of the others is added.
    levyAvg = (sum(la) - sum(lb)) / runner.months + ownTotal;
  }
  const totals: SolvePlanTotals = runner
    ? {
        monthlyCost: roundMoney(actions.reduce((s, x) => s + (x.monthlyCost ?? 0), 0) + levy1),
        monthlyNetAvg: roundMoney(actions.reduce((s, x) => s + (x.monthlyNetAvg ?? 0), 0) + levyAvg),
        oneOffCost: roundMoney(actions.reduce((s, x) => s + (x.oneOffCost ?? 0), 0)),
      }
    : { monthlyCost: null, monthlyNetAvg: null, oneOffCost: null };
  return { replacements: added.length, actions, totals, after: snap };
}

// ---------------------------------------------------------------------------
// Viewer restriction (disability is health data)
// ---------------------------------------------------------------------------

/**
 * Solver result for a viewer who may not see disability (review fix P2-2). Every per-person weight is
 * removed, whether or not the plan involves a disabled employee (the form itself must not tell):
 * - DOCUMENT actions: one line (count, zero cost), no weight gain, no percentage after it;
 * - RAISE actions (disabled or not): one line (count, summed costs — a raise costs the same for anyone,
 *   HRDF excluded), no weight gain, no percentage after it: a disabled employee's raise to 4,000 adds +3
 *   and would single him out;
 * - HIRE line: kept with its percentage / band (= the plan's result), no weight gain (hires can lift a
 *   cap and carry a disabled employee's +3);
 * - alternative REPLACE lines: same (no weight gain, no percentage after each).
 * Flags restricted like the estimate. before / after / totals unchanged: the plan's result is the purpose
 * of the page (residual inference from the totals accepted, SPEC §1 and §7). Stored SAUDIZATION snapshots
 * use this form.
 */
export function restrictSolve(r: SolveResult, restrictFlags: (f: ReadonlyArray<NitaqatFlag>) => NitaqatFlag[]): SolveResult {
  const merge = (list: SolverAction[], kind: SolverActionKind, note: string): SolverAction | null => {
    if (!list.length) return null;
    const sumOrNull = (k: 'monthlyCost' | 'monthlyNetAvg' | 'oneOffCost') => (list.every((a) => a[k] === null) ? null : roundMoney(list.reduce((s, a) => s + (a[k] ?? 0), 0)));
    return { rank: 0, kind, employeeId: null, name: null, count: list.reduce((s, a) => s + a.count, 0), weightGain: null, pctAfter: null, bandAfter: null, monthlyCost: sumOrNull('monthlyCost'), monthlyNetAvg: sumOrNull('monthlyNetAvg'), oneOffCost: sumOrNull('oneOffCost'), sensitive: false, note };
  };
  const docs = r.actions.filter((a) => a.kind === 'DOCUMENT');
  const raises = r.actions.filter((a) => a.kind === 'RAISE');
  const out: SolverAction[] = [];
  const d = merge(docs, 'DOCUMENT', `توثيق ${docs.length} ${docs.length === 1 ? 'عقد' : 'عقود'} في قوى دون كلفة (الأسماء والأوزان لمدير الموارد البشرية)`);
  if (d) out.push(d);
  const rs = merge(raises, 'RAISE', `رفع الأجر المسجّل إلى 4,000 لـ ${raises.length} ${raises.length === 1 ? 'موظف' : 'موظفين'} (الأسماء والأثر لكل موظف لمدير الموارد البشرية)`);
  if (rs) out.push(rs);
  for (const a of r.actions) if (a.kind === 'HIRE') out.push({ ...a, weightGain: null });
  out.forEach((a, i) => (a.rank = i + 1));
  const alternative = r.alternative ? { ...r.alternative, actions: r.alternative.actions.map((a) => ({ ...a, weightGain: null, pctAfter: null, bandAfter: null })) } : null;
  return { ...r, actions: out, alternative, flags: restrictFlags(r.flags) };
}
