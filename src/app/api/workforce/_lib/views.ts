// Response shaping and input validation of the workforce API (src/app/api/workforce/**). PURE: no
// Prisma, no clock (the caller passes "today"). Unit-tested in src/lib/__tests__/wf-api-views.test.ts.
// The engine (src/lib/workforce) computes; this file only selects, groups and bounds what is sent.
import { ASSUMPTION_DEFS, resolveCompanyAssumptions, type AssumptionKey, type ResolvedAssumption } from '@/lib/workforce/assumptions';
import {
  COMPANY_SETTING_KEYS,
  MEDICAL_PREMIUM_KEYS,
  MEDICAL_PREMIUM_LABELS,
  OVERTIME_BASIS_LABELS,
  companySettingsHref,
  type CompanyCostSettings,
} from '@/lib/workforce/company-settings';
import { gosiRateEvidence, normalizeStatus } from '@/lib/workforce/rules';
import type { OverviewResult } from '@/lib/workforce/overview';
import type {
  AssumptionRow,
  CostLineKey,
  CostLineKind,
  EmployeeCostResult,
  FlagCode,
  GosiRateRow,
  MoneyTriple,
  RuleEvidence,
  RuleRow,
  Scenario,
  TrueCostResult,
  WfFlag,
  WfStatus,
} from '@/lib/workforce/types';
import { DOMAIN_ORDER, FLAG_FIX, type FixTarget, type Horizon } from './shared';

// ---------------------------------------------------------------------------
// True cost: employee summaries (bounded list payload)
// ---------------------------------------------------------------------------

export interface EmployeeSummary {
  employeeId: string;
  name: string;
  employeeNo: string | null;
  nationalityClass: string;
  legalCompanyId: string | null;
  companyName: string | null;
  branchName: string | null;
  departmentName: string | null;
  exitDate: string | null;
  month1: MoneyTriple;
  next12: MoneyTriple;
  next24: MoneyTriple;
  next36: MoneyTriple;
  levyTier: string | null;
  gosiRegime: string | null;
  eosbLiabilityEmployer: number;
  flags: Array<{ code: FlagCode; severity: WfFlag['severity']; message: string }>;
}

export function summarizeEmployee(e: EmployeeCostResult): EmployeeSummary {
  const first = e.months.find((m) => m.active) ?? e.months[0];
  const flags = new Map<string, EmployeeSummary['flags'][number]>();
  for (const f of e.flags) if (!flags.has(f.code)) flags.set(f.code, { code: f.code, severity: f.severity, message: f.message });
  return {
    employeeId: e.employeeId,
    name: e.name,
    employeeNo: e.employeeNo,
    nationalityClass: e.nationalityClass,
    legalCompanyId: e.legalCompanyId,
    companyName: e.companyName,
    branchName: e.branchName,
    departmentName: e.departmentName,
    exitDate: e.exitDate,
    month1: e.totals.month1,
    next12: e.totals.next12,
    next24: e.totals.next24,
    next36: e.totals.next36,
    levyTier: first?.levyTier ?? null,
    gosiRegime: first?.gosiRegimeUsed ?? null,
    eosbLiabilityEmployer: e.liabilities.eosbEmployerAtStart,
    flags: [...flags.values()],
  };
}

export type EmployeeSort = 'cost' | 'name' | 'flags';

/** Search (name / employee number), sort and page the summaries. */
export function pageSummaries(
  rows: ReadonlyArray<EmployeeSummary>,
  opts: { q?: string | null; sort?: EmployeeSort; take: number; skip: number; flagged?: boolean },
): { total: number; items: EmployeeSummary[] } {
  const q = (opts.q ?? '').trim().toLowerCase();
  let list = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.employeeNo ?? '').toLowerCase().includes(q)) : [...rows];
  if (opts.flagged) list = list.filter((r) => r.flags.some((f) => f.severity !== 'INFO'));
  const byName = (a: EmployeeSummary, b: EmployeeSummary) => a.name.localeCompare(b.name, 'ar') || a.employeeId.localeCompare(b.employeeId);
  if (opts.sort === 'name') list.sort(byName);
  else if (opts.sort === 'flags') list.sort((a, b) => b.flags.length - a.flags.length || byName(a, b));
  else list.sort((a, b) => b.next12.cost - a.next12.cost || byName(a, b));
  return { total: list.length, items: list.slice(opts.skip, opts.skip + opts.take) };
}

// ---------------------------------------------------------------------------
// Composition for a window (12 / 24 / 36)
// ---------------------------------------------------------------------------

export interface CompositionItem {
  key: CostLineKey;
  label: string;
  kind: CostLineKind;
  /** Sum over the window. */
  amount: number;
  /** First month. */
  month1: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function compositionForWindow(tc: Pick<TrueCostResult, 'composition' | 'series'>, months: number): CompositionItem[] {
  const series = tc.series.slice(0, Math.max(1, months));
  return tc.composition.map((c) => ({
    key: c.key,
    label: c.label,
    kind: c.kind,
    amount: round2(series.reduce((s, x) => s + (x.byLine[c.key] ?? 0), 0)),
    month1: round2(series[0]?.byLine[c.key] ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Overview response (bounded)
// ---------------------------------------------------------------------------

export interface DataQualityDetail {
  code: FlagCode;
  severity: WfFlag['severity'];
  count: number;
  employees: number;
  message: string;
  fix: FixTarget;
  /** First employees concerned (id + name) for "fix it" links. */
  sample: Array<{ id: string; name: string }>;
  ruleKeys: string[];
  /** Companies concerned (fix = 'COMPANY': link to their «إعدادات الكلفة»). */
  companies: Array<{ id: string; name: string }>;
}

export function dataQualityDetails(
  tc: Pick<TrueCostResult, 'flags' | 'employees'> & Partial<Pick<TrueCostResult, 'companySettingsUsed'>>,
  items: OverviewResult['dataQuality'],
  limit = 20,
): DataQualityDetail[] {
  const names = new Map(tc.employees.map((e) => [e.employeeId, e.name]));
  const companyNames = new Map((tc.companySettingsUsed ?? []).map((c) => [c.companyId, c.name]));
  return items.map((d) => {
    const ids: string[] = [];
    const keys = new Set<string>();
    const companyIds = new Set<string>();
    for (const f of tc.flags) {
      if (f.code !== d.code) continue;
      if (f.employeeId && !ids.includes(f.employeeId) && ids.length < limit) ids.push(f.employeeId);
      if (f.ruleKey) keys.add(f.ruleKey);
      if (f.companyId && companyNames.has(f.companyId)) companyIds.add(f.companyId);
    }
    const fix = FLAG_FIX[d.code] ?? 'NONE';
    const companies = [...companyIds].sort().map((id) => ({ id, name: companyNames.get(id) ?? id }));
    return { ...d, fix, sample: ids.map((id) => ({ id, name: names.get(id) ?? id })), ruleKeys: [...keys].sort(), companies };
  });
}

export interface GroupRow {
  id: string;
  name: string;
  headcount: number;
  month1: MoneyTriple;
  window: MoneyTriple;
  next12: MoneyTriple;
  next36: MoneyTriple;
}

function windowOf(t: { next12: MoneyTriple; next24: MoneyTriple; next36: MoneyTriple }, h: Horizon): MoneyTriple {
  return h === 12 ? t.next12 : h === 24 ? t.next24 : t.next36;
}

export function groupRows(groups: OverviewResult['byCompany'], h: Horizon): GroupRow[] {
  return groups
    .map((g) => ({ id: g.id, name: g.name, headcount: g.headcount, month1: g.totals.month1, window: windowOf(g.totals, h), next12: g.totals.next12, next36: g.totals.next36 }))
    .sort((a, b) => b.window.cost - a.window.cost || a.name.localeCompare(b.name, 'ar'));
}

export function buildOverviewResponse(tc: TrueCostResult, ov: OverviewResult, h: Horizon, scenario: Scenario) {
  const lastWindowMonth = tc.monthKeys[Math.min(h, tc.monthKeys.length) - 1];
  return {
    engineVersion: ov.engineVersion,
    disclaimer: ov.disclaimer,
    startMonth: ov.startMonth,
    months: ov.months,
    horizon: h,
    scenario,
    kpis: { ...ov.kpis, window: windowOf(tc.totals, h), next24: tc.totals.next24 },
    composition: compositionForWindow(tc, h),
    series: tc.series.map((s) => ({ month: s.month, cost: s.cost, subsidy: s.subsidy, net: s.net, headcount: s.headcount })),
    byCompany: groupRows(ov.byCompany, h),
    byBranch: groupRows(ov.byBranch, h),
    byDepartment: groupRows(ov.byDepartment, h),
    legalCompanies: [...ov.legalCompanies].sort((a, b) => b.headcount - a.headcount || a.name.localeCompare(b.name, 'ar')),
    upcomingEvents: ov.upcomingEvents.filter((e) => e.appliesFromMonth <= lastWindowMonth),
    dataQuality: dataQualityDetails(tc, ov.dataQuality),
    rulesUsed: tc.rulesUsed.length,
  };
}

export type OverviewResponse = ReturnType<typeof buildOverviewResponse>;

// ---------------------------------------------------------------------------
// Assumption evidence ("لماذا؟" for ASSUMPTION:* keys)
// ---------------------------------------------------------------------------

function assumptionStatus(a: ResolvedAssumption): WfStatus {
  if (a.entered) return 'USER_INPUT';
  return a.value === null || a.value === undefined ? 'MISSING' : 'DERIVED';
}

/** 'ASSUMPTION:KEY' -> evidence for one company (company rows override global rows). */
export function assumptionEvidence(rows: ReadonlyArray<AssumptionRow>, companyId: string | null, scenario: Scenario): Record<string, RuleEvidence> {
  const resolved = resolveCompanyAssumptions(rows, companyId, scenario);
  const out: Record<string, RuleEvidence> = {};
  for (const v of Object.values(resolved)) {
    if (!v || typeof v !== 'object' || !('key' in v)) continue;
    const a = v as ResolvedAssumption;
    const def = ASSUMPTION_DEFS[a.key];
    const origin = a.origin === 'COMPANY' ? 'مدخل لهذه الشركة' : a.origin === 'GLOBAL' ? 'مدخل لكل الشركات' : 'القيمة الافتراضية للنظام (لم تُدخل)';
    const shown = typeof a.value === 'number' ? a.value : null;
    const text =
      a.value === null || a.value === undefined
        ? 'لم تُدخل'
        : typeof a.value === 'object'
          ? Object.entries(a.value as Record<string, number>).map(([k, n]) => `${k}: ${n}`).join('، ')
          : typeof a.value === 'boolean'
            ? a.value ? 'نعم' : 'لا'
            : String(a.value);
    out[`ASSUMPTION:${a.key}`] = {
      key: `ASSUMPTION:${a.key}`,
      label: def.label,
      value: shown,
      unit: def.unit,
      status: assumptionStatus(a),
      sourceUrl: null,
      sourceQuote: `${origin}: ${text}${a.range ? ` (منخفض ${a.range.low}، أساسي ${a.range.base}، مرتفع ${a.range.high})` : ''}`,
      effectiveFrom: null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company settings evidence ("لماذا؟" for COMPANY:* keys, «إعدادات الكلفة»)
// ---------------------------------------------------------------------------

export type CompanySettingsView = { companyId: string; name: string } & CompanyCostSettings;

/**
 * 'COMPANY:*' -> evidence for the employee's settings company (legal ?? actual): the overtime basis, the
 * medical premiums and the iqama fee, each citing «إعدادات الشركة: <name>» with a link to its edit page.
 * No company -> the three keys are MISSING ("no company settings").
 */
export function companySettingsEvidence(c: CompanySettingsView | null | undefined): Record<string, RuleEvidence> {
  const K = COMPANY_SETTING_KEYS;
  const cite = c ? `إعدادات الشركة: ${c.name}` : 'لا توجد شركة للموظف: لا إعدادات شركة';
  const sourceUrl = c ? companySettingsHref(c.companyId) : null;
  const ev = (key: string, label: string, value: number | null, unit: string | null, status: WfStatus, text: string): RuleEvidence => ({
    key,
    label,
    value,
    unit,
    status,
    sourceUrl,
    sourceQuote: `${cite} — ${text}`,
    effectiveFrom: null,
  });
  const basis = c?.overtimeHourlyBasis ?? 'BASIC';
  const premiums = c?.medicalPremiums ?? {};
  const entered = MEDICAL_PREMIUM_KEYS.filter((k) => typeof premiums[k] === 'number');
  const missing = MEDICAL_PREMIUM_KEYS.filter((k) => typeof premiums[k] !== 'number');
  const premiumText = entered.length
    ? `${entered.map((k) => `${MEDICAL_PREMIUM_LABELS[k]}: ${(premiums[k] as number).toLocaleString('en-US')}`).join('، ')} ريال سنوياً${missing.length ? `؛ غير مدخل: ${missing.map((k) => MEDICAL_PREMIUM_LABELS[k]).join('، ')}` : ''}`
    : 'لم تُدخل أقساط التأمين الطبي';
  const fee = c?.iqamaFeeYear ?? null;
  return {
    [K.OVERTIME_HOURLY_BASIS]: ev(K.OVERTIME_HOURLY_BASIS, 'طريقة حساب أجر العمل الإضافي (إعداد الشركة)', null, null, c ? 'USER_INPUT' : 'MISSING', OVERTIME_BASIS_LABELS[basis]),
    [K.MEDICAL_PREMIUMS]: ev(K.MEDICAL_PREMIUMS, 'أقساط التأمين الطبي السنوية (إعداد الشركة)', null, 'SAR_YEAR', c && entered.length ? 'USER_INPUT' : 'MISSING', premiumText),
    [K.IQAMA_FEE_YEAR]: ev(K.IQAMA_FEE_YEAR, 'رسوم الإقامة السنوية (إعداد الشركة)', fee, 'SAR_YEAR', fee !== null ? 'USER_INPUT' : 'MISSING', fee !== null ? `${fee.toLocaleString('en-US')} ريال سنوياً` : 'غير مدخلة: تُستخدم قيمة سجل القواعد IQAMA_FEE_YEAR'),
  };
}

/** Settings company of a true-cost employee (null when none / not in the run). */
export function settingsOf(tc: Pick<TrueCostResult, 'companySettingsUsed'>, companyId: string | null | undefined): CompanySettingsView | null {
  if (!companyId) return null;
  return tc.companySettingsUsed.find((c) => c.companyId === companyId) ?? null;
}

// ---------------------------------------------------------------------------
// Rules register view
// ---------------------------------------------------------------------------

export interface RuleVersionView {
  key: string;
  domain: string;
  label: string;
  value: number | null;
  valueJson: string | null;
  unit: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: WfStatus;
  sourceUrl: string | null;
  sourceQuote: string | null;
  notes: string | null;
  /** CURRENT = in force today; FUTURE = starts later; SUPERSEDED = replaced by a later version in force. */
  state: 'CURRENT' | 'FUTURE' | 'SUPERSEDED';
  origin: 'RULE_PARAMETER' | 'GOSI_RATE';
  createdAt: string | null;
}

export interface RuleKeyView {
  key: string;
  domain: string;
  label: string;
  unit: string | null;
  current: RuleVersionView | null;
  versions: RuleVersionView[];
  origin: 'RULE_PARAMETER' | 'GOSI_RATE';
}

export interface RuleDomainView {
  domain: string;
  keys: RuleKeyView[];
}

type RuleRowWithMeta = RuleRow & { domain?: string | null; createdAt?: Date | null };

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function stateOf(versions: Array<{ effectiveFrom: string; effectiveTo: string | null }>, idx: number, today: string): RuleVersionView['state'] {
  const v = versions[idx];
  if (v.effectiveFrom > today) return 'FUTURE';
  // versions sorted by effectiveFrom ascending: a later version already in force supersedes this one.
  const later = versions.slice(idx + 1).some((x) => x.effectiveFrom <= today);
  if (later || (v.effectiveTo && v.effectiveTo <= today)) return 'SUPERSEDED';
  return 'CURRENT';
}

/**
 * RuleParameter rows grouped by domain then key (versions oldest first), plus the GosiRate table shown as
 * rules of the GOSI domain (one key per regime × nationality). `today` = 'YYYY-MM-DD'.
 */
export function buildRulesView(rules: ReadonlyArray<RuleRowWithMeta>, gosiRates: ReadonlyArray<GosiRateRow & { createdAt?: Date | null }>, today: string): RuleDomainView[] {
  const keys = new Map<string, RuleKeyView>();
  const byKey = new Map<string, RuleRowWithMeta[]>();
  for (const r of rules) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    const base = sorted.map((r) => ({ effectiveFrom: ymd(r.effectiveFrom)!, effectiveTo: ymd(r.effectiveTo ?? null) }));
    const versions: RuleVersionView[] = sorted.map((r, i) => ({
      key,
      domain: r.domain || 'OTHER',
      label: r.label || key,
      value: typeof r.value === 'number' ? r.value : null,
      valueJson: r.valueJson ?? null,
      unit: r.unit ?? null,
      effectiveFrom: base[i].effectiveFrom,
      effectiveTo: base[i].effectiveTo,
      status: normalizeStatus(r.status),
      sourceUrl: r.sourceUrl ?? null,
      sourceQuote: r.sourceQuote ?? null,
      notes: r.notes ?? null,
      state: stateOf(base, i, today),
      origin: 'RULE_PARAMETER',
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    }));
    const latest = versions[versions.length - 1];
    keys.set(key, {
      key,
      domain: latest.domain,
      label: latest.label,
      unit: latest.unit,
      current: versions.find((v) => v.state === 'CURRENT') ?? null,
      versions,
      origin: 'RULE_PARAMETER',
    });
  }

  const gosiGroups = new Map<string, Array<GosiRateRow & { createdAt?: Date | null }>>();
  for (const g of gosiRates) {
    const k = `GOSI_RATE:${g.regime}:${g.isSaudi ? 'SA' : 'NON_SA'}`;
    const list = gosiGroups.get(k) ?? [];
    list.push(g);
    gosiGroups.set(k, list);
  }
  for (const [key, list] of [...gosiGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    const base = sorted.map((r) => ({ effectiveFrom: ymd(r.effectiveFrom)!, effectiveTo: null }));
    const versions: RuleVersionView[] = sorted.map((g, i) => {
      const ev = gosiRateEvidence(g);
      return {
        key,
        domain: 'GOSI',
        label: ev.label,
        value: g.employerRate,
        valueJson: JSON.stringify({ employeeRate: g.employeeRate, employerRate: g.employerRate, minWage: g.minWage, maxWage: g.maxWage }),
        unit: 'PERCENT',
        effectiveFrom: base[i].effectiveFrom,
        effectiveTo: null,
        status: ev.status,
        sourceUrl: null,
        sourceQuote: g.source ?? null,
        notes: `حصة الموظف ${g.employeeRate}%، وصاحب العمل ${g.employerRate}% (جدول نسب التأمينات GosiRate)`,
        state: stateOf(base, i, today),
        origin: 'GOSI_RATE',
        createdAt: g.createdAt ? g.createdAt.toISOString() : null,
      };
    });
    const latest = versions[versions.length - 1];
    keys.set(key, { key, domain: 'GOSI', label: latest.label, unit: 'PERCENT', current: versions.find((v) => v.state === 'CURRENT') ?? null, versions, origin: 'GOSI_RATE' });
  }

  const domains = new Map<string, RuleKeyView[]>();
  for (const k of keys.values()) {
    const list = domains.get(k.domain) ?? [];
    list.push(k);
    domains.set(k.domain, list);
  }
  const order = (d: string) => {
    const i = (DOMAIN_ORDER as ReadonlyArray<string>).indexOf(d);
    return i < 0 ? 99 : i;
  };
  return [...domains.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([domain, list]) => ({
      domain,
      keys: list.sort((a, b) => (a.origin === b.origin ? a.key.localeCompare(b.key) : a.origin === 'GOSI_RATE' ? -1 : 1)),
    }));
}

// ---------------------------------------------------------------------------
// Assumptions: validation against ASSUMPTION_DEFS
// ---------------------------------------------------------------------------

/** Accepted numeric range per number assumption (inclusive). */
export const ASSUMPTION_BOUNDS: Partial<Record<AssumptionKey, { min: number; max: number; integer?: boolean }>> = {
  ANNUAL_TICKET_COST: { min: 0, max: 100_000 },
  EXIT_REENTRY_VISAS_PER_YEAR: { min: 0, max: 12 },
  RECRUITMENT_COST_SAUDI: { min: 0, max: 1_000_000 },
  RECRUITMENT_COST_EXPAT: { min: 0, max: 1_000_000 },
  VACANCY_MONTHS: { min: 0, max: 36 },
  ANNUAL_RAISE_PCT: { min: -20, max: 50 },
};

/** Number assumptions accept {low, base, high} sensitivity bounds (the engine picks one per scenario). */
export function assumptionAllowsRange(key: AssumptionKey): boolean {
  return ASSUMPTION_DEFS[key].kind === 'number';
}

export type AssumptionStore = { remove: true } | { remove: false; value: number | null; valueJson: string | null };
export type AssumptionCheck = { ok: true; store: AssumptionStore } | { ok: false; message: string };

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function checkNumber(key: AssumptionKey, raw: unknown, label: string): { ok: true; range: { low: number; base: number; high: number } | null; n: number } | { ok: false; message: string } {
  const b = ASSUMPTION_BOUNDS[key] ?? { min: 0, max: 1_000_000 };
  const inRange = (n: number) => n >= b.min && n <= b.max;
  const bad = `${label}: قيمة غير صالحة (المسموح من ${b.min} إلى ${b.max})`;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (!assumptionAllowsRange(key)) return { ok: false, message: `${label}: لا يقبل نطاق منخفض/أساسي/مرتفع` };
    const o = raw as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['low', 'base', 'high'].includes(k));
    if (extra.length) return { ok: false, message: `${label}: مفاتيح غير مقبولة (${extra.join('، ')}); المقبول low و base و high` };
    const base = toNum(o.base);
    if (base === null) return { ok: false, message: `${label}: القيمة الأساسية مطلوبة` };
    const low = o.low === undefined || o.low === null || o.low === '' ? base : toNum(o.low);
    const high = o.high === undefined || o.high === null || o.high === '' ? base : toNum(o.high);
    if (low === null || high === null || ![low, base, high].every(inRange)) return { ok: false, message: bad };
    if (!(low <= base && base <= high)) return { ok: false, message: `${label}: يجب أن تكون القيمة المنخفضة ≤ الأساسية ≤ المرتفعة` };
    return { ok: true, range: low === base && high === base ? null : { low, base, high }, n: base };
  }
  const n = toNum(raw);
  if (n === null || !inRange(n)) return { ok: false, message: bad };
  return { ok: true, range: null, n };
}

/**
 * Validates one assumption value for (key) and returns how to store it in WorkforceAssumption.
 * null / '' removes the row (falls back to the global row or the default). Types:
 * number -> value (or value = base + valueJson {low, base, high}); boolean -> valueJson true/false;
 * enum -> valueJson "OPTION". (Medical premiums / overtime basis / iqama fee are company settings now.)
 */
export function validateAssumptionValue(key: AssumptionKey, raw: unknown): AssumptionCheck {
  const def = ASSUMPTION_DEFS[key];
  if (raw === null || raw === undefined || raw === '') return { ok: true, store: { remove: true } };
  switch (def.kind) {
    case 'number': {
      const r = checkNumber(key, raw, def.label);
      if (!r.ok) return r;
      return { ok: true, store: { remove: false, value: r.n, valueJson: r.range ? JSON.stringify(r.range) : null } };
    }
    case 'boolean': {
      const v = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
      if (v === null) return { ok: false, message: `${def.label}: القيمة يجب أن تكون نعم أو لا` };
      return { ok: true, store: { remove: false, value: null, valueJson: JSON.stringify(v) } };
    }
    case 'enum': {
      const options = (def as { options?: ReadonlyArray<string> }).options ?? [];
      if (typeof raw !== 'string' || !options.includes(raw)) return { ok: false, message: `${def.label}: اختر إحدى القيم (${options.join('، ')})` };
      return { ok: true, store: { remove: false, value: null, valueJson: JSON.stringify(raw) } };
    }
  }
  return { ok: false, message: 'افتراض غير معروف' };
}

/** Stored row -> the editable value shown in the form (inverse of validateAssumptionValue). */
export function assumptionFormValue(key: AssumptionKey, row: Pick<AssumptionRow, 'value' | 'valueJson'> | null | undefined): unknown {
  if (!row) return null;
  const def = ASSUMPTION_DEFS[key];
  let j: unknown = undefined;
  if (row.valueJson) {
    try {
      j = JSON.parse(row.valueJson);
    } catch {
      j = row.valueJson;
    }
  }
  if (def.kind === 'number') return j && typeof j === 'object' ? j : row.value;
  if (def.kind === 'boolean') return typeof j === 'boolean' ? j : typeof row.value === 'number' ? row.value !== 0 : null;
  return typeof j === 'string' ? j : null;
}

// ---------------------------------------------------------------------------
// Exit cost: replacement assumptions entered for one calculation
// ---------------------------------------------------------------------------

/**
 * Replaces (for this calculation only) the replacement assumptions with the user's inputs: every stored
 * row of the key is dropped and one row for the employee's legal company ('' when none) is added, so it
 * wins over both the global and the company rows. Nothing is written to the database.
 */
export function withAssumptionOverrides(
  rows: ReadonlyArray<AssumptionRow>,
  companyId: string | null,
  o: { recruitmentCostSaudi?: number; recruitmentCostExpat?: number; vacancyMonths?: number } | undefined,
): AssumptionRow[] {
  if (!o) return [...rows];
  const map: Array<[AssumptionKey, number | undefined]> = [
    ['RECRUITMENT_COST_SAUDI', o.recruitmentCostSaudi],
    ['RECRUITMENT_COST_EXPAT', o.recruitmentCostExpat],
    ['VACANCY_MONTHS', o.vacancyMonths],
  ];
  let out = [...rows];
  for (const [key, v] of map) {
    if (v === undefined) continue;
    out = out.filter((r) => r.key !== key);
    out.push({ key, companyId: companyId ?? '', value: v, valueJson: null, note: 'إدخال لهذا الحساب فقط' });
  }
  return out;
}
