// Hiring scenarios («سيناريوهات التوظيف»): Saudi vs expat vs overtime vs outsourcing, side by side over
// 12 / 24 / 36 months. PURE, deterministic.
//
// - Saudi / expat candidates are hypothetical WfEmployeeInput rows (isPlanned) priced by THE true cost
//   engine (computeTrueCost) together with the legal company's employees, so the levy tiers, the HRDF
//   subsidy, GOSI (NEW regime for a new Saudi), fees and the company cost settings are exactly those of
//   the other screens. Nothing is written: Employee / SalaryChange rows belong to the money gateway.
// - Levy tier impact on the OTHER expats = company levy with the candidate − company levy without −
//   the candidate's own levy line (e.g. a new Saudi moves one expat from 800 to 700; crossing 9 workers
//   ends the small-establishment exemption).
// - Nitaqat effect = nitaqatEstimate() before / after with the candidate (documented contract assumed).
// - Localization effect = localizationCompliance() before / after for the decisions of the candidate's
//   occupation.
// - Overtime = hours × the payroll hourly rate (company overtime basis, formulas.ts overtimeCost), no GOSI
//   (not contributory), capacity note against the 720 h/year cap. Outsourcing = the monthly quote entered
//   by the user (USER_INPUT); neither changes the head count, the levy or Nitaqat here.
import { roundMoney } from '@/lib/money';
import { computeTrueCost, COST_LINE_META } from '@/lib/workforce/true-cost';
import { monthStartUtc, overtimeCost, parseMonth } from '@/lib/workforce/formulas';
import { RULE_KEYS, resolveRules, ruleValue } from '@/lib/workforce/rules';
import { ENGINE_VERSION, ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { nitaqatEstimate, type NitaqatActivityRow, type NitaqatBand, type NitaqatCurveRow, type WeightClass } from '@/lib/workforce/nitaqat';
import { localizationCompliance, matchesOccupation, occupationMatcher, parseDecision, type LocalizationDecisionRow, type ParsedDecision } from '@/lib/workforce/saudization';
import type { PayrollSettings } from '@/lib/payroll-core';
import type {
  AssumptionRow,
  CostLineKey,
  CostLineKind,
  GosiRateRow,
  LineExplanation,
  MoneyTriple,
  RuleRow,
  RuleVersionRef,
  TrueCostResult,
  WfAllowanceInput,
  WfCompanyInput,
  WfEmployeeInput,
  WfFlag,
} from '@/lib/workforce/types';

export const CANDIDATE_KINDS = ['SAUDI', 'EXPAT', 'OVERTIME', 'OUTSOURCING'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CANDIDATE_KIND_LABELS: Record<CandidateKind, string> = {
  SAUDI: 'توظيف سعودي',
  EXPAT: 'توظيف وافد',
  OVERTIME: 'عمل إضافي',
  OUTSOURCING: 'إسناد',
};

export interface HireCandidate {
  kind: CandidateKind;
  label?: string | null;
  // Saudi / expat
  basicSalary?: number | null;
  housingAllowance?: number | null;
  otherAllowances?: number | null;
  gender?: 'MALE' | 'FEMALE' | null;
  isDisabled?: boolean | null;
  isStudent?: boolean | null;
  partTime?: boolean | null;
  city?: string | null;
  occupationName?: string | null;
  occupationCode?: string | null;
  medicalClass?: string | null;
  dateOfBirth?: Date | null;
  // Expat
  nationality?: string | null;
  dependentsCount?: number | null;
  dependentsFeePaidBy?: 'COMPANY' | 'EMPLOYEE' | null;
  // Overtime
  overtimeHoursPerMonth?: number | null;
  /** Existing employee whose hourly rate is used (else basic / allowances above). */
  overtimeEmployeeId?: string | null;
  // Outsourcing
  monthlyQuote?: number | null;
}

export interface HireScenarioInput {
  company: WfCompanyInput;
  /** Employees of the legal company (levy tiers, Nitaqat, localization). */
  companyEmployees: ReadonlyArray<WfEmployeeInput>;
  nitaqat: { activity: NitaqatActivityRow | null; curves: ReadonlyArray<NitaqatCurveRow>; retailWholesale?: boolean | null };
  decisions: ReadonlyArray<LocalizationDecisionRow | ParsedDecision>;
  rules: ReadonlyArray<RuleRow>;
  gosiRates: ReadonlyArray<GosiRateRow>;
  assumptions: ReadonlyArray<AssumptionRow>;
  payrollSettings?: PayrollSettings;
  annualLeaveDaysSetting?: number | null;
  /** First projected month 'YYYY-MM' (the hire joins on its first day). */
  startMonth: string;
  candidates: ReadonlyArray<HireCandidate>;
}

export const SCENARIO_WINDOWS = [12, 24, 36] as const;
export type ScenarioWindow = (typeof SCENARIO_WINDOWS)[number];

export interface WindowResult extends MoneyTriple {
  /** Levy change of the OTHER expats over the window (negative = saving). */
  levyOthers: number;
  /** net + levyOthers: the figure to compare. */
  total: number;
}

export interface CandidateLine {
  key: CostLineKey | 'OVERTIME_HOURS' | 'OUTSOURCING_QUOTE' | 'LEVY_OTHERS';
  label: string;
  kind: CostLineKind;
  w12: number;
  w24: number;
  w36: number;
  /** Basis of the first active month (Arabic formula with the numbers). */
  basis: string;
  status: string;
  ruleKeys: string[];
  note?: string;
}

export interface CandidateResult {
  index: number;
  kind: CandidateKind;
  label: string;
  /** Hypothetical employee id used in the engine (null for overtime / outsourcing). */
  employeeId: string | null;
  windows: Record<ScenarioWindow, WindowResult>;
  firstMonthCost: number;
  lines: CandidateLine[];
  levy: { ownFirstMonth: number; othersFirstMonth: number; tierNote: string | null };
  nitaqat:
    | { status: 'OK'; before: { pct: number; band: NitaqatBand | null; x: number }; after: { pct: number; band: NitaqatBand | null; x: number }; candidateWeight: number; candidateClass: WeightClass | null; bandChanged: boolean }
    | { status: 'NO_ACTIVITY' | 'NO_EMPLOYEES' | 'NOT_APPLICABLE'; message: string };
  localization: Array<{
    decisionId: string;
    groupNameAr: string;
    requiredPct: number | null;
    before: { pct: number | null; compliant: boolean | null; shortfallReplacements: number; total: number };
    after: { pct: number | null; compliant: boolean | null; shortfallReplacements: number; total: number };
    candidateCounted: boolean;
    note: string | null;
  }>;
  localizationNote: string | null;
  capacity: { hoursPerYear: number; capHours: number | null; overCap: boolean; note: string } | null;
  flags: WfFlag[];
  explanations: Partial<Record<CostLineKey, LineExplanation>>;
  rulesUsed: RuleVersionRef[];
  notes: string[];
}

export interface HireScenarioResult {
  engineVersion: string;
  disclaimer: string;
  startMonth: string;
  date: string;
  company: { id: string; name: string };
  nitaqatBefore: { status: string; pct: number; band: NitaqatBand | null; x: number; message: string | null };
  candidates: CandidateResult[];
  assumptions: string[];
}

const SUM_WINDOWS = (series: ReadonlyArray<number>): Record<ScenarioWindow, number> => ({
  12: roundMoney(series.slice(0, 12).reduce((s, x) => s + x, 0)),
  24: roundMoney(series.slice(0, 24).reduce((s, x) => s + x, 0)),
  36: roundMoney(series.slice(0, 36).reduce((s, x) => s + x, 0)),
});

function levySeries(tc: TrueCostResult, companyId: string): number[] {
  return tc.companies.find((c) => c.companyId === companyId)?.months.map((m) => m.levyTotal) ?? tc.monthKeys.map(() => 0);
}

const num = (v: number | null | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Allowances of a hypothetical hire: typed housing (GOSI) + other (not GOSI). */
export function candidateAllowances(c: Pick<HireCandidate, 'housingAllowance' | 'otherAllowances'>): WfAllowanceInput[] {
  const out: WfAllowanceInput[] = [];
  if (num(c.housingAllowance) > 0) out.push({ name: 'بدل سكن', amount: num(c.housingAllowance), isMonthly: true, countsTowardGosi: true, allowanceType: 'HOUSING' });
  if (num(c.otherAllowances) > 0) out.push({ name: 'بدلات أخرى', amount: num(c.otherAllowances), isMonthly: true, countsTowardGosi: false, allowanceType: 'OTHER' });
  return out;
}

/** The hypothetical employee of a Saudi / expat candidate (never written anywhere). */
export function candidateEmployee(c: HireCandidate, index: number, companyId: string, joinDate: Date): WfEmployeeInput {
  const saudi = c.kind === 'SAUDI';
  return {
    id: `candidate-${index + 1}`,
    name: c.label || `${CANDIDATE_KIND_LABELS[c.kind]} ${index + 1}`,
    nationality: saudi ? 'سعودي' : (c.nationality ?? '').trim() || 'وافد',
    gender: c.gender ?? 'MALE',
    dateOfBirth: c.dateOfBirth ?? null,
    joinDate,
    basicSalary: Math.max(0, num(c.basicSalary)),
    allowances: candidateAllowances(c),
    gosiRegime: saudi ? 'NEW' : null,
    legalCompanyId: companyId,
    contractType: c.partTime ? 'PART_TIME' : 'FULL_TIME',
    branchCity: c.city ?? null,
    occupationName: c.occupationName ?? null,
    occupationCode: c.occupationCode ?? null,
    medicalInsuranceClass: c.medicalClass ?? null,
    dependentsCount: saudi ? null : c.dependentsCount ?? 0,
    dependentsFeePaidBy: saudi ? null : c.dependentsFeePaidBy ?? null,
    isDisabled: saudi ? !!c.isDisabled : false,
    isStudent: saudi ? !!c.isStudent : false,
    isPlanned: true,
    qiwaContractDocumented: true,
    qiwaContractDocumentedAt: null,
  };
}

/** SPEC module 3 «سيناريوهات التوظيف» (see the header). */
export function hireScenario(input: HireScenarioInput): HireScenarioResult {
  const ym = parseMonth(input.startMonth);
  const startMonth = `${ym.year}-${String(ym.month).padStart(2, '0')}`;
  const date = monthStartUtc(ym.year, ym.month);
  const months = 36;
  const companyId = input.company.id;
  const engineInput = (employees: ReadonlyArray<WfEmployeeInput>) => ({
    employees,
    companies: [input.company],
    rules: input.rules,
    gosiRates: input.gosiRates,
    assumptions: input.assumptions,
    payrollSettings: input.payrollSettings,
    annualLeaveDaysSetting: input.annualLeaveDaysSetting,
  });
  const baseline = computeTrueCost(engineInput(input.companyEmployees), { startMonth, months, employeeIds: [] });
  const baseLevy = levySeries(baseline, companyId);
  const entity = { companyId, companyName: input.company.name, activity: input.nitaqat.activity, curves: input.nitaqat.curves, retailWholesale: input.nitaqat.retailWholesale };
  const before = nitaqatEstimate({ ...entity, employees: input.companyEmployees }, date, { average: false });
  const decisions = input.decisions.map((d) => ('phases' in d && Array.isArray((d as ParsedDecision).phases) ? (d as ParsedDecision) : parseDecision(d as LocalizationDecisionRow)));
  const rulesAtStart = resolveRules(input.rules, date);
  const otCap = ruleValue(rulesAtStart, RULE_KEYS.OT_ANNUAL_CAP);

  const candidates = input.candidates.map((c, index): CandidateResult => {
    const label = (c.label ?? '').trim() || `${CANDIDATE_KIND_LABELS[c.kind]} ${index + 1}`;
    if (c.kind === 'OVERTIME' || c.kind === 'OUTSOURCING') return nonHireCandidate(c, index, label, input, rulesAtStart, otCap);

    const emp = candidateEmployee({ ...c, label }, index, companyId, date);
    const tc = computeTrueCost(engineInput([...input.companyEmployees, emp]), { startMonth, months, employeeIds: [emp.id] });
    const r = tc.employees[0];
    const withLevy = levySeries(tc, companyId);
    const own = r.months.map((m) => m.lines.filter((l) => l.key === 'EXPAT_LEVY').reduce((s, l) => s + l.amount, 0));
    const others = withLevy.map((v, i) => roundMoney(v - (baseLevy[i] ?? 0) - own[i]));
    const levyW = SUM_WINDOWS(others);
    const windows = {} as Record<ScenarioWindow, WindowResult>;
    for (const w of SCENARIO_WINDOWS) {
      const t = w === 12 ? r.totals.next12 : w === 24 ? r.totals.next24 : r.totals.next36;
      windows[w] = { ...t, levyOthers: levyW[w], total: roundMoney(t.net + levyW[w]) };
    }
    // Per line and window.
    const keys = [...new Set(r.months.flatMap((m) => m.lines.map((l) => l.key)))];
    const lines: CandidateLine[] = keys.map((k) => {
      const series = r.months.map((m) => m.lines.filter((l) => l.key === k).reduce((s, l) => s + l.amount, 0));
      const sums = SUM_WINDOWS(series);
      const first = r.months.find((m) => m.lines.some((l) => l.key === k))?.lines.find((l) => l.key === k);
      return { key: k, label: COST_LINE_META[k].label, kind: first?.kind ?? 'COST', w12: sums[12], w24: sums[24], w36: sums[36], basis: first?.basis ?? '', status: first?.status ?? 'DERIVED', ruleKeys: first?.ruleKeys ?? [], note: first?.note };
    });
    if (levyW[36] !== 0 || levyW[12] !== 0) {
      lines.push({ key: 'LEVY_OTHERS', label: 'أثر المقابل المالي على بقية الوافدين', kind: 'COST', w12: levyW[12], w24: levyW[24], w36: levyW[36], basis: 'المقابل المالي للكيان مع المرشح − بدونه − مقابل المرشح نفسه', status: 'DERIVED', ruleKeys: ['EXPAT_LEVY_WITHIN_SAUDI_COUNT', 'EXPAT_LEVY_ABOVE_SAUDI_COUNT'] });
    }
    const o1 = others[0] ?? 0;
    const tierNote =
      o1 < 0
        ? `ينتقل ${Math.round(-o1 / 100)} وافد من شريحة 800 إلى 700 تقريباً (وفر ${roundMoney(-o1)} شهرياً)`
        : o1 > 0
          ? `يرتفع المقابل المالي لبقية الوافدين ${roundMoney(o1)} شهرياً (تغيّر الشريحة أو انتهاء إعفاء المنشأة الصغيرة)`
          : null;

    // Nitaqat before / after.
    let nitaqat: CandidateResult['nitaqat'];
    if (before.status !== 'OK') nitaqat = { status: before.status, message: before.message ?? '' };
    else {
      const after = nitaqatEstimate({ ...entity, employees: [...input.companyEmployees, emp] }, date, { average: false });
      const p = after.persons.find((x) => x.id === emp.id);
      nitaqat = {
        status: 'OK',
        before: { pct: before.pct, band: before.band, x: before.counts.x },
        after: { pct: after.pct, band: after.band, x: after.counts.x },
        candidateWeight: p ? (p.side === 'EXPAT' ? 0 : p.finalWeight) : 0,
        candidateClass: p ? p.finalClass : null,
        bandChanged: before.band !== after.band,
      };
    }

    // Localization for the candidate's occupation.
    const own_ = decisions.filter((d) => matchesOccupation(emp, occupationMatcher(d.occupations)));
    const locBefore = own_.length ? localizationCompliance({ companyId, employees: input.companyEmployees, decisions: own_ }, date) : null;
    const locAfter = own_.length ? localizationCompliance({ companyId, employees: [...input.companyEmployees, emp], decisions: own_ }, date) : null;
    const localization: CandidateResult['localization'] = own_.map((d) => {
      const b = locBefore?.items.find((i) => i.decisionId === d.id);
      const a = locAfter?.items.find((i) => i.decisionId === d.id);
      const ce = a?.employees.find((x) => x.id === emp.id);
      return {
        decisionId: d.id,
        groupNameAr: d.groupNameAr,
        requiredPct: a?.requiredPct ?? b?.requiredPct ?? null,
        before: { pct: b?.actualPct ?? null, compliant: b?.compliant ?? null, shortfallReplacements: b?.shortfallReplacements ?? 0, total: b?.total ?? 0 },
        after: { pct: a?.actualPct ?? null, compliant: a?.compliant ?? null, shortfallReplacements: a?.shortfallReplacements ?? 0, total: a?.total ?? 0 },
        candidateCounted: !!ce?.counted,
        note: ce?.reason ?? (a && !a.inEffect ? 'لم تبدأ أول مرحلة بعد' : a?.appliesReason ?? null),
      };
    });
    const localizationNote = !(emp.occupationName || emp.occupationCode) ? 'لم تُحدَّد مهنة المرشح: لا يُفحص أثره على قرارات التوطين' : own_.length ? null : 'مهنة المرشح غير مشمولة بقرار توطين مسجّل';

    const notes: string[] = [];
    if (c.kind === 'SAUDI') notes.push('سعودي جديد بالنظام الجديد للتأمينات؛ ودعم هدف سطر سالب مشروط بقبول الطلب.');
    if (c.kind === 'EXPAT') notes.push('وافد: المقابل المالي حسب ترتيبه في الكيان (700 أو 800)، ورخصة العمل والإقامة وتأمين المرافقين حسب الإعدادات.');
    return {
      index,
      kind: c.kind,
      label,
      employeeId: emp.id,
      windows,
      firstMonthCost: r.totals.month1.cost,
      lines,
      levy: { ownFirstMonth: roundMoney(own[0] ?? 0), othersFirstMonth: roundMoney(o1), tierNote },
      nitaqat,
      localization,
      localizationNote,
      capacity: null,
      flags: tc.flags,
      explanations: tc.explanations,
      rulesUsed: tc.rulesUsed,
      notes,
    };
  });

  return {
    engineVersion: ENGINE_VERSION,
    disclaimer: ESTIMATE_DISCLAIMER,
    startMonth,
    date: date.toISOString().slice(0, 10),
    company: { id: companyId, name: input.company.name },
    nitaqatBefore: { status: before.status, pct: before.pct, band: before.band, x: before.counts.x, message: before.message },
    candidates,
    assumptions: [
      'المرشح يباشر في أول يوم من الشهر الأول، ويُفترض توثيق عقده في قوى.',
      'السعودي الجديد بالنظام الجديد للتأمينات، ودعم هدف حسب افتراض «احتساب دعم هدف» وشروطه (الأجر 4,000 إلى 15,000، الشهر 4 إلى 27).',
      'المقارنة بعد الدعم ومع أثر المقابل المالي على بقية الوافدين في الكيان.',
      'العمل الإضافي بأجر الساعة حسب طريقة الشركة، ولا يدخل في التأمينات؛ والإسناد بعرض السعر المدخل.',
      'لا يُكتب شيء في بيانات الموظفين: السيناريو افتراضي بالكامل.',
    ],
  };
}

function nonHireCandidate(c: HireCandidate, index: number, label: string, input: HireScenarioInput, _rules: ReturnType<typeof resolveRules>, otCap: number | null): CandidateResult {
  const zeroW = (amount: number, levy = 0): Record<ScenarioWindow, WindowResult> => {
    const out = {} as Record<ScenarioWindow, WindowResult>;
    for (const w of SCENARIO_WINDOWS) {
      const cost = roundMoney(amount * w);
      out[w] = { cost, subsidy: 0, net: cost, levyOthers: levy, total: cost };
    }
    return out;
  };
  const common = {
    index,
    kind: c.kind,
    label,
    employeeId: null,
    levy: { ownFirstMonth: 0, othersFirstMonth: 0, tierNote: null },
    nitaqat: { status: 'NOT_APPLICABLE' as const, message: c.kind === 'OVERTIME' ? 'العمل الإضافي لا يغيّر عدد العاملين ولا النطاق' : 'عمالة الإسناد لا تُحتسب هنا في نطاقات المنشأة (قوى تحتسب الإسناد السعودي لدى المنشأة المستفيدة بسقف 10%: غير محسوب)' },
    localization: [],
    localizationNote: null,
    flags: [] as WfFlag[],
    explanations: {},
    rulesUsed: [] as RuleVersionRef[],
  };
  if (c.kind === 'OUTSOURCING') {
    const quote = Math.max(0, num(c.monthlyQuote));
    return {
      ...common,
      windows: zeroW(quote),
      firstMonthCost: roundMoney(quote),
      lines: [{ key: 'OUTSOURCING_QUOTE', label: 'عرض الإسناد الشهري', kind: 'COST', w12: roundMoney(quote * 12), w24: roundMoney(quote * 24), w36: roundMoney(quote * 36), basis: `${quote} شهرياً × عدد الأشهر`, status: 'USER_INPUT', ruleKeys: [] }],
      capacity: null,
      notes: ['عرض السعر إدخال المستخدم (لا أرقام مخترعة). لا يشمل الإشراف والجودة ولا مخاطر الالتزام.'],
    };
  }
  // Overtime: the hourly of an existing employee, or of the basic / allowances entered.
  const ref = c.overtimeEmployeeId ? input.companyEmployees.find((e) => e.id === c.overtimeEmployeeId) : null;
  const basic = ref ? ref.basicSalary : Math.max(0, num(c.basicSalary));
  const allowances = ref ? ref.allowances : candidateAllowances(c);
  const hours = Math.max(0, num(c.overtimeHoursPerMonth));
  const basis = input.company.costSettings?.overtimeHourlyBasis ?? 'BASIC';
  const ot = overtimeCost({ hours, basicSalary: basic, allowances, basis, settings: input.payrollSettings, annualCapHours: otCap, hoursYearToDate: 0 });
  const perYear = hours * 12;
  const overCap = otCap !== null && perYear > otCap;
  return {
    ...common,
    windows: zeroW(ot.amount),
    firstMonthCost: ot.amount,
    lines: [
      {
        key: 'OVERTIME_HOURS',
        label: 'العمل الإضافي',
        kind: 'COST',
        w12: roundMoney(ot.amount * 12),
        w24: roundMoney(ot.amount * 24),
        w36: roundMoney(ot.amount * 36),
        basis: `${hours} ساعة × ${ot.hourly} (${basis === 'BASIC' ? 'من الأساسي' : 'الأجر الكلي + 50% من الأساسي'})`,
        status: 'USER_INPUT',
        ruleKeys: ['OVERTIME_PREMIUM_PCT_OF_BASIC', 'OVERTIME_ANNUAL_CAP_HOURS', 'COMPANY:OVERTIME_HOURLY_BASIS'],
        note: ref ? `بأجر ساعة الموظف ${ref.name}` : undefined,
      },
    ],
    capacity: {
      hoursPerYear: perYear,
      capHours: otCap,
      overCap,
      note: overCap ? `${perYear} ساعة سنوياً تتجاوز سقف ${otCap} ساعة: يلزم موافقة العامل، والطاقة محدودة` : `${perYear} ساعة سنوياً ضمن سقف ${otCap ?? '—'} ساعة`,
    },
    notes: ['أجر الساعة بنفس دالة المسير (طريقة الشركة في إعدادات الكلفة). العمل الإضافي لا يدخل في وعاء التأمينات.'],
  };
}
