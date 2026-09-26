// True cost engine ("الكلفة الحقيقية"): employer cost per employee and month, line by line. PURE.
//
// Deterministic: the same input + the same rule versions give the same output (no clock, no randomness;
// employees, companies and groups are processed in a stable order).
//
// Decisions (documented for "لماذا هذا الرقم؟" and the report to the owner):
// - Rules are resolved per projected month on its first day (see resolveRulesForMonth); GOSI rates per
//   month with calculateGosi (same convention).
// - Salary / allowances / GOSI are prorated by calendar days in join and exit months (payroll convention).
//   Government fees, medical premiums and the HRDF support are monthly equivalents charged for every
//   month with at least one employed day.
// - Wage basis for EOSB, leave and notice = options.salaryBasis, default 'total' (basic + recurring
//   allowances) = the settlement screen default. Day rate = wage / 30 (payroll-core dailyRate).
// - Raises: dated SalaryChange rows effective on/after the first projected month set the basic from the
//   month that contains their effective date. ANNUAL_RAISE_PCT compounds on the basic every January after
//   the first projected month, for employees who joined before that 1 January, except in a calendar year
//   that already has an explicit SalaryChange for that employee. Allowances are not raised.
// - Exit: the earlier of terminationDate and contractEndDate; nothing is charged after it (a fixed-term
//   contract end is flagged: renewal is not assumed).
// - The leave accrual is a provision (salary is paid during the leave): shown as MEMO unless
//   options.leaveAccrualInTotal. The EOSB accrual is counted (it is paid at exit).
// - «إعدادات الكلفة» of the company (single source of truth, company-settings.ts) of the employee's settings
//   company = legalCompanyId ?? actualCompanyId (same as payroll): overtime basis (line status USER_INPUT),
//   medical premium per class and per dependent (missing -> MISSING line + MISSING_MEDICAL_PREMIUM flag
//   with companyId), iqama fee (USER_INPUT when entered, else the IQAMA_FEE_YEAR rule). They are single
//   values: the low / high scenarios only move the WorkforceAssumption values. Lines cite the pseudo keys
//   COMPANY:* («لماذا؟» shows «إعدادات الشركة: <name>»). The levy still uses the LEGAL company only.
import { roundMoney } from '@/lib/money';
import { dailyRate, monthlyAllowancesTotal, monthlyWage, DEFAULT_PAYROLL_SETTINGS } from '@/lib/payroll-core';
import { mentionsSaudiAmbiguously, nationalityClass, type NationalityClass } from '@/lib/nationality';
import {
  RULE_KEYS as K,
  RuleUsage,
  indexRules,
  resolveRulesForMonth,
  ruleOf,
  ruleValue,
  weakestStatus,
} from '@/lib/workforce/rules';
import { ASSUMPTION_DEFS, assumptionRuleKey, normalizeClassKey, resolveCompanyAssumptions, type CompanyAssumptions } from '@/lib/workforce/assumptions';
import { COMPANY_SETTING_KEYS, OVERTIME_BASIS_SHORT, type CompanyCostSettings } from '@/lib/workforce/company-settings';
import {
  activeDays,
  addMonthsYm,
  ageOn,
  allocateLevy,
  contributoryWage,
  eosbLiability,
  fmt as fmtRaw,
  gosiEmployerMonthly,
  HRDF_APPLICATION_WINDOW_MONTHS,
  HRDF_START_OFFSET_MONTHS,
  hrdfSubsidyMonthly,
  isFemale,
  isFullTime,
  leaveLiabilityMonthly,
  monthEndUtc,
  monthStartUtc,
  monthsBetween,
  overtimeCost,
  parseMonth,
  pct,
  type HousingTypeConflict,
  type LevyAllocation,
  type LevyMember,
} from '@/lib/workforce/formulas';
import { ENGINE_VERSION } from '@/lib/workforce/version';
import type {
  CompanyMix,
  CostLine,
  CostLineKey,
  CostLineKind,
  EmployeeCostResult,
  EmployeeMonth,
  GroupTotals,
  HrdfCategory,
  LineExplanation,
  MoneyTriple,
  RuleSet,
  Scenario,
  TrueCostInput,
  TrueCostOptions,
  TrueCostResult,
  WfCompanyInput,
  WfEmployeeInput,
  WfFlag,
  WfStatus,
  WindowTotals,
} from '@/lib/workforce/types';

const DAY_MS = 86400000;
/** Pseudo legal company for employees without one (levy charged at the 'above' rate, flagged). */
export const NO_COMPANY_ID = '__NO_LEGAL_COMPANY__';

/** Arabic labels and formula text of every line (the order is the display order). */
export const COST_LINE_META: Record<CostLineKey, { label: string; formula: string }> = {
  BASIC: { label: 'الراتب الأساسي', formula: 'الأساسي × أيام العمل في الشهر ÷ أيام الشهر، مع الزيادات المؤرخة' },
  ALLOWANCES: { label: 'البدلات الشهرية', formula: 'مجموع البدلات المتكررة × أيام العمل ÷ أيام الشهر' },
  ONE_OFF_BONUS: { label: 'مكافآت لمرة واحدة', formula: 'المكافأة في شهر صرفها في المسير' },
  OVERTIME: { label: 'العمل الإضافي المتوقع', formula: 'الساعات × أجر الساعة حسب طريقة الحساب في إعدادات الشركة (المادة 107)' },
  GOSI_EMPLOYER: { label: 'حصة صاحب العمل في التأمينات', formula: 'النسبة حسب النظام وتاريخ الشهر × (الأساسي + السكن النقدي) بحد أعلى 45,000' },
  EOSB_ACCRUAL: { label: 'استحقاق مكافأة نهاية الخدمة', formula: 'المكافأة المستحقة آخر الشهر − المستحقة آخر الشهر السابق (المادة 84، على افتراض إنهاء صاحب العمل)' },
  LEAVE_ACCRUAL: { label: 'استحقاق الإجازة السنوية (مخصص)', formula: 'أيام الإجازة المكتسبة في الشهر (21 أو 30 يوماً سنوياً) × أجر اليوم (الأجر ÷ 30)' },
  EXPAT_LEVY: { label: 'المقابل المالي', formula: '700 لكل وافد لا يتجاوز عدد السعوديين في الكيان، و800 لما زاد، مع الإعفاءات' },
  WORK_PERMIT: { label: 'رخصة العمل', formula: 'الرسوم السنوية ÷ 12' },
  IQAMA: { label: 'رسوم الإقامة', formula: 'الرسوم السنوية ÷ 12 (من إعدادات الشركة إن أُدخلت، وإلا من سجل القواعد)' },
  DEPENDENTS_FEE: { label: 'رسوم المرافقين', formula: 'الرسوم الشهرية × عدد المرافقين (إن كانت الشركة تدفعها)' },
  EXIT_REENTRY: { label: 'تأشيرات الخروج والعودة', formula: 'عدد التأشيرات سنوياً × رسم التأشيرة المفردة ÷ 12' },
  ANNUAL_TICKET: { label: 'تذكرة السفر السنوية', formula: 'كلفة التذكرة السنوية ÷ 12 (افتراض المنشأة)' },
  MEDICAL: { label: 'التأمين الطبي', formula: 'القسط السنوي لفئة الموظف ÷ 12 (إعدادات الشركة)' },
  MEDICAL_DEPENDENTS: { label: 'التأمين الطبي للمرافقين', formula: 'عدد المرافقين × القسط السنوي للمرافق ÷ 12 (إعدادات الشركة)' },
  HRDF_SUBSIDY: { label: 'دعم هدف للتوظيف (مشروط)', formula: '−(30% + 10% لكل فئة) × الأجر، بحد أدنى من 3,000 و50% من الأجر، من الشهر 4 إلى 27 من المباشرة؛ الأهلية تُقرَّر مرة واحدة في فترة التقديم (الشهر 4–6 من المباشرة) بأجر 4,000–15,000 في ذلك الشهر، فلا يُكسبها رفع أجر لاحق' },
};

export const COST_LINE_ORDER = Object.keys(COST_LINE_META) as CostLineKey[];

// Shared (never mutated) rule-key arrays of lines that only depend on assumptions / law references.
const NO_KEYS: string[] = [];
const LAW84_KEYS = ['LAW:ART84'];
const TICKET_KEYS = [assumptionRuleKey('ANNUAL_TICKET_COST')];
// Company settings («إعدادات الكلفة»): medical premiums, iqama fee, overtime basis (company-settings.ts).
const MED_KEYS = [COMPANY_SETTING_KEYS.MEDICAL_PREMIUMS];
const IQAMA_COMPANY_KEYS = [COMPANY_SETTING_KEYS.IQAMA_FEE_YEAR];
/** Settings of a company with nothing entered (BASIC overtime, no premiums, rule iqama fee). */
const EMPTY_SETTINGS: CompanyCostSettings = { overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null };

const zero = (): MoneyTriple => ({ cost: 0, subsidy: 0, net: 0 });

function addTriple(t: MoneyTriple, cost: number, subsidy: number): void {
  t.cost += cost;
  t.subsidy += subsidy;
  t.net += cost + subsidy;
}

function roundTriple(t: MoneyTriple): MoneyTriple {
  return { cost: roundMoney(t.cost), subsidy: roundMoney(t.subsidy), net: roundMoney(t.net) };
}

function windowTotals(perMonth: ReadonlyArray<MoneyTriple>): WindowTotals {
  const w = { month1: zero(), next12: zero(), next24: zero(), next36: zero(), horizon: zero() };
  perMonth.forEach((m, i) => {
    if (i < 1) addTriple(w.month1, m.cost, m.subsidy);
    if (i < 12) addTriple(w.next12, m.cost, m.subsidy);
    if (i < 24) addTriple(w.next24, m.cost, m.subsidy);
    if (i < 36) addTriple(w.next36, m.cost, m.subsidy);
    addTriple(w.horizon, m.cost, m.subsidy);
  });
  return { month1: roundTriple(w.month1), next12: roundTriple(w.next12), next24: roundTriple(w.next24), next36: roundTriple(w.next36), horizon: roundTriple(w.horizon) };
}

function earliest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (a && b) return a.getTime() <= b.getTime() ? a : b;
  return a ?? b ?? null;
}

interface MonthCtx {
  i: number;
  year: number;
  month: number;
  key: string;
  start: Date;
  end: Date;
  days: number;
  /** Last day of the previous month. */
  prevEnd: Date;
  rules: RuleSet;
  /** Per-month memo of values shared by every employee (rule-key arrays, basis texts). */
  cache: Map<string, unknown>;
}

/** Per-employee precomputation shared by all months. */
interface EmpPrep {
  e: WfEmployeeInput;
  cls: NationalityClass;
  companyId: string;
  exit: Date | null;
  fullTime: boolean;
  basics: number[];
  basicNotes: Array<string | undefined>;
  activeDays: number[];
  assumptions: CompanyAssumptions;
  /** Company whose «إعدادات الكلفة» apply: legalCompanyId ?? actualCompanyId (payroll convention). */
  settingsCompanyId: string | null;
  settings: CompanyCostSettings;
}

function statusOfRule(rules: RuleSet, key: string): WfStatus {
  return ruleOf(rules, key).status;
}

/**
 * Projects the employer cost of every employee for `months` months from `startMonth`.
 * See the header of this file for the conventions and TrueCostResult for the output.
 */
export function computeTrueCost(input: TrueCostInput, options: TrueCostOptions): TrueCostResult {
  const scenario: Scenario = options.scenario ?? 'base';
  const nMonths = Math.max(1, Math.min(120, Math.floor(options.months ?? 36)));
  const basis = options.salaryBasis ?? 'total';
  const leaveInTotal = options.leaveAccrualInTotal === true;
  const settings = input.payrollSettings ?? DEFAULT_PAYROLL_SETTINGS;
  const start = parseMonth(options.startMonth);
  const usage = new RuleUsage();
  const explainIds = new Map<CostLineKey, Set<string>>();
  const globalFlags = new Map<string, WfFlag>();

  const index = indexRules(input.rules);
  const months: MonthCtx[] = [];
  for (let i = 0; i < nMonths; i++) {
    const ym = addMonthsYm(start.year, start.month, i);
    const s = monthStartUtc(ym.year, ym.month);
    const e = monthEndUtc(ym.year, ym.month);
    months.push({ i, year: ym.year, month: ym.month, key: `${ym.year}-${String(ym.month).padStart(2, '0')}`, start: s, end: e, days: e.getUTCDate(), prevEnd: new Date(s.getTime() - DAY_MS), rules: resolveRulesForMonth(index, ym.year, ym.month), cache: new Map() });
  }
  const horizonStart = months[0].start;
  const horizonIndex = start.year * 12 + (start.month - 1);
  const dayBeforeStart = new Date(horizonStart.getTime() - DAY_MS);

  // Companies and assumptions (company rows override global rows).
  const companies = new Map<string, WfCompanyInput>();
  for (const c of [...input.companies].sort((a, b) => a.id.localeCompare(b.id))) companies.set(c.id, c);
  const assumptionCache = new Map<string, CompanyAssumptions>();
  const assumptionsFor = (companyId: string): CompanyAssumptions => {
    let a = assumptionCache.get(companyId);
    if (!a) {
      a = resolveCompanyAssumptions(input.assumptions, companyId === NO_COMPANY_ID ? '' : companyId, scenario);
      assumptionCache.set(companyId, a);
    }
    return a;
  };
  assumptionsFor('');
  /** «إعدادات الكلفة» per settings company (single values: not moved by the scenario). */
  const settingsUsed = new Map<string, CompanyCostSettings>();
  const settingsFor = (companyId: string | null): CompanyCostSettings => {
    if (!companyId) return EMPTY_SETTINGS;
    const s = companies.get(companyId)?.costSettings ?? EMPTY_SETTINGS;
    settingsUsed.set(companyId, s);
    return s;
  };

  const note = (lineKey: CostLineKey, id: string) => {
    let s = explainIds.get(lineKey);
    if (!s) explainIds.set(lineKey, (s = new Set()));
    s.add(id);
  };
  const cited = new WeakMap<object, Set<CostLineKey>>();
  const citeRule = (lineKey: CostLineKey, rules: RuleSet, key: string): string => {
    const r = ruleOf(rules, key);
    let lines = cited.get(r);
    if (lines?.has(lineKey)) return key; // already recorded for this line (fast path)
    if (!lines) cited.set(r, (lines = new Set()));
    lines.add(lineKey);
    usage.rule(r);
    note(lineKey, RuleUsage.id(r));
    if (r.status === 'MISSING') addGlobalFlag({ code: 'MISSING_RULE', severity: 'ERROR', message: `قاعدة غير متوفرة في السجل: ${r.label}`, ruleKey: key, lineKey });
    else if (r.status === 'PROVISIONAL') addGlobalFlag({ code: 'PROVISIONAL_RULE', severity: 'INFO', message: `قيمة مؤقتة مستخدمة: ${r.label}`, ruleKey: key, lineKey });
    else if (r.status === 'CONFLICTING') addGlobalFlag({ code: 'CONFLICTING_RULE', severity: 'WARNING', message: `قيمة متعارضة المصادر: ${r.label}`, ruleKey: key, lineKey });
    return key;
  };
  /** Formatting cache: amounts repeat a lot across employees and months. */
  const fmtCache = new Map<number, string>();
  const fmt = (n: number): string => {
    let v = fmtCache.get(n);
    if (v === undefined) {
      v = fmtRaw(n);
      if (fmtCache.size < 50000) fmtCache.set(n, v);
    }
    return v;
  };
  /** Per-month memo (shared rule-key arrays etc.; callers must not mutate the result). */
  const perMonth = <T>(m: MonthCtx, id: string, make: () => T): T => {
    let v = m.cache.get(id) as T | undefined;
    if (v === undefined) {
      v = make();
      m.cache.set(id, v);
    }
    return v;
  };
  function addGlobalFlag(f: WfFlag) {
    const id = `${f.code}|${f.ruleKey ?? ''}|${f.companyId ?? ''}|${f.lineKey ?? ''}`;
    if (!globalFlags.has(id)) globalFlags.set(id, f);
  }

  // ---- Per-employee precomputation (salary path, activity) ----
  const employees = [...input.employees].sort((a, b) => a.id.localeCompare(b.id));
  const preps: EmpPrep[] = employees.map((e) => {
    const cls = nationalityClass(e.nationality);
    const companyId = e.legalCompanyId || NO_COMPANY_ID;
    const exit = earliest(e.terminationDate ?? null, e.contractEndDate ?? null);
    const a = assumptionsFor(companyId);
    const raisePct = typeof a.annualRaisePct.value === 'number' ? a.annualRaisePct.value : 0;
    const changes = [...(e.salaryChanges ?? [])]
      .filter((c) => c.effectiveDate.getTime() >= horizonStart.getTime() && Number.isFinite(c.basicSalary))
      .sort((x, y) => x.effectiveDate.getTime() - y.effectiveDate.getTime());
    const changeYears = new Set(changes.map((c) => c.effectiveDate.getUTCFullYear()));
    const basics: number[] = [];
    const basicNotes: Array<string | undefined> = [];
    let cur = roundMoney(e.basicSalary ?? 0);
    let ci = 0;
    const act: number[] = [];
    for (const m of months) {
      let n: string | undefined;
      if (m.month === 1 && m.i > 0 && raisePct !== 0 && !changeYears.has(m.year) && e.joinDate.getTime() < m.start.getTime()) {
        cur = roundMoney(cur * (1 + raisePct / 100));
        n = `زيادة سنوية ${pct(raisePct)} (افتراض)`;
      }
      while (ci < changes.length && changes[ci].effectiveDate.getTime() <= m.end.getTime()) {
        cur = roundMoney(changes[ci].basicSalary);
        n = changes[ci].isPlanned ? 'تغيير راتب مخطط' : 'تغيير راتب مؤرخ';
        ci++;
      }
      basics.push(cur);
      basicNotes.push(n);
      act.push(activeDays(m.start, m.end, e.joinDate, exit));
    }
    const settingsCompanyId = e.legalCompanyId || e.actualCompanyId || null;
    return { e, cls, companyId, exit, fullTime: isFullTime(e.contractType, e.partTimeWeeklyHours), basics, basicNotes, activeDays: act, assumptions: a, settingsCompanyId, settings: settingsFor(settingsCompanyId) };
  });

  // ---- Levy allocation per legal company and month (O(n) per month) ----
  const companyIds = [...new Set(preps.map((p) => p.companyId))].sort();
  const levyByMonth: Array<Map<string, LevyAllocation>> = months.map((m) => {
    const members = new Map<string, LevyMember[]>();
    for (const p of preps) {
      if (p.activeDays[m.i] <= 0) continue;
      if (p.companyId === NO_COMPANY_ID && p.cls !== 'EXPAT') continue;
      const list = members.get(p.companyId) ?? [];
      list.push({ id: p.e.id, cls: p.cls, joinDate: p.e.joinDate, fullTime: p.fullTime });
      members.set(p.companyId, list);
    }
    const out = new Map<string, LevyAllocation>();
    for (const cid of companyIds) {
      const company = companies.get(cid);
      const a = assumptionsFor(cid);
      out.set(
        cid,
        allocateLevy(members.get(cid) ?? [], {
          isIndustrialLicensed: company?.isIndustrialLicensed ?? false,
          industrialCancellation: ruleOf(m.rules, K.INDUSTRIAL_LEVY_CANCELLED),
          within: ruleOf(m.rules, K.LEVY_WITHIN),
          above: ruleOf(m.rules, K.LEVY_ABOVE),
          smallMax: ruleOf(m.rules, K.SMALL_EST_MAX),
          exemptOwnerOnly: ruleOf(m.rules, K.SMALL_EST_OWNER),
          exemptWithSaudi: ruleOf(m.rules, K.SMALL_EST_SAUDI),
          ownerFullTime: cid === NO_COMPANY_ID ? false : (a.ownerFullTime.value as boolean | null),
        }),
      );
    }
    return out;
  });

  // ---- Employee months ----
  const only = options.employeeIds ? new Set(options.employeeIds) : null;
  const results: EmployeeCostResult[] = preps.filter((p) => !only || only.has(p.e.id)).map((p) => computeEmployee(p));

  /**
   * HRDF eligibility decided ONCE in the application window (formulas.ts HRDF_APPLICATION_WINDOW_MONTHS):
   * the first month k in 3..5 after the join month whose criteria hold (wage 4,000–15,000 of THAT month,
   * full time, age) — support from month k on. Window months inside the horizon use the projected basic;
   * earlier ones the salary history (last applied SalaryChange on or before that month, else the current
   * basic when no change happened since; unknown when the salary changed later and nothing earlier is
   * recorded -> not eligible, flagged). A raise projected in the horizon therefore never creates a
   * subsidy for an employee whose window is past (review fix P2-1).
   */
  function hrdfWindowDecision(p: EmpPrep, female: boolean, sme: boolean | null): { firstK: number | null; unknownWage: boolean } {
    const e = p.e;
    const jy = e.joinDate.getUTCFullYear();
    const jm = e.joinDate.getUTCMonth() + 1;
    const history = (e.salaryChanges ?? [])
      .filter((c) => !c.isPlanned && c.effectiveDate.getTime() < horizonStart.getTime() && Number.isFinite(c.basicSalary))
      .sort((x, y) => x.effectiveDate.getTime() - y.effectiveDate.getTime());
    let unknownWage = false;
    for (let k = HRDF_START_OFFSET_MONTHS; k < HRDF_START_OFFSET_MONTHS + HRDF_APPLICATION_WINDOW_MONTHS; k++) {
      const ym = addMonthsYm(jy, jm, k);
      const idx = ym.year * 12 + (ym.month - 1) - horizonIndex;
      if (idx >= months.length) break; // after the horizon: no projected month depends on it
      const ms = monthStartUtc(ym.year, ym.month);
      const me = monthEndUtc(ym.year, ym.month);
      let basic: number | null;
      let rules: RuleSet;
      if (idx >= 0) {
        if (p.activeDays[idx] <= 0) continue;
        basic = p.basics[idx];
        rules = months[idx].rules;
      } else {
        if (activeDays(ms, me, e.joinDate, p.exit) <= 0) continue;
        const before = history.filter((c) => c.effectiveDate.getTime() <= me.getTime());
        if (before.length) basic = roundMoney(before[before.length - 1].basicSalary);
        else if (history.length) basic = null; // changed after the window, earlier wage not recorded
        else basic = roundMoney(e.basicSalary ?? 0);
        const r = resolveRulesForMonth(index, ym.year, ym.month);
        // The register may not reach back to that month: the criteria of the first projected month apply.
        rules = ruleValue(r, K.HRDF_MIN_WAGE) === null ? months[0].rules : r;
      }
      if (basic === null) {
        unknownWage = true;
        continue;
      }
      const h = hrdfSubsidyMonthly({
        isSaudi: p.cls === 'SAUDI',
        wage: contributoryWage(basic, e.allowances, null).raw,
        fullTime: p.fullTime,
        monthsSinceJoin: k,
        age: ageOn(e.dateOfBirth ?? null, ms),
        female,
        disabled: !!e.isDisabled,
        sme,
        city: e.branchCity,
        basePct: ruleOf(rules, K.HRDF_BASE_PCT),
        bonusPct: ruleOf(rules, K.HRDF_BONUS_PCT),
        cap: ruleOf(rules, K.HRDF_CAP),
        capPct: ruleOf(rules, K.HRDF_CAP_PCT),
        minWage: ruleOf(rules, K.HRDF_MIN_WAGE),
        maxWage: ruleOf(rules, K.HRDF_MAX_WAGE),
        months: ruleOf(rules, K.HRDF_MONTHS),
      });
      if (h.eligible) return { firstK: k, unknownWage: false };
    }
    return { firstK: null, unknownWage };
  }

  function computeEmployee(p: EmpPrep): EmployeeCostResult {
    const e = p.e;
    const flags = new Map<string, WfFlag>();
    const flag = (f: Omit<WfFlag, 'employeeId'>) => {
      const id = f.lineKey ? f.code + '|' + f.lineKey : f.code;
      if (!flags.has(id)) flags.set(id, { ...f, employeeId: e.id });
    };
    /** Cheap guard used inside the month loop before building a flag object. */
    const flagged = (code: string, lineKey?: string) => flags.has(lineKey ? code + '|' + lineKey : code);
    const company = companies.get(p.companyId) ?? null;
    const a = p.assumptions;
    const isSaudi = p.cls === 'SAUDI';

    if (!e.nationality || !e.nationality.trim()) flag({ code: 'MISSING_NATIONALITY', severity: 'ERROR', message: 'الجنسية غير محددة: حُسب كوافد' });
    else if (mentionsSaudiAmbiguously(e.nationality)) flag({ code: 'NATIONALITY_AMBIGUOUS', severity: 'WARNING', message: `الجنسية المسجلة تذكر السعودية مع كلمات أخرى، فلم تُعدّ سعودية (حُسب ${p.cls === 'GCC' ? 'كخليجي' : 'كوافد'}): صحّح الجنسية في ملف الموظف` });
    if (p.companyId === NO_COMPANY_ID) flag({ code: 'MISSING_LEGAL_COMPANY', severity: 'WARNING', message: 'لا توجد شركة قانونية: المقابل المالي بالشريحة الأعلى ولا تُطبَّق الإعفاءات' });
    if (p.cls === 'GCC') flag({ code: 'GCC_PENSION_NOT_MODELLED', severity: 'WARNING', message: 'مواطن خليجي: المعاش حسب نظام دولته غير محسوب، والمحسوب الأخطار المهنية فقط' });
    const horizonEnd = months[months.length - 1].end;
    if (p.exit && p.exit.getTime() <= horizonEnd.getTime()) {
      const byContract = !!e.contractEndDate && (!e.terminationDate || e.contractEndDate.getTime() < e.terminationDate.getTime());
      flag(
        byContract
          ? { code: 'CONTRACT_END_ASSUMED_EXIT', severity: 'INFO', message: `ينتهي العقد في ${p.exit.toISOString().slice(0, 10)}: لا كلفة بعده (التجديد غير مفترض)` }
          : { code: 'EXITS_DURING_HORIZON', severity: 'INFO', message: `ينتهي العمل في ${p.exit.toISOString().slice(0, 10)}: لا كلفة بعده` },
      );
    }

    const monthsOut: EmployeeMonth[] = [];
    const byLine: Partial<Record<CostLineKey, number>> = {};
    const allowanceMonthly = monthlyAllowancesTotal(e.allowances);
    let prevWage = monthlyWage({ basicSalary: e.basicSalary, allowances: e.allowances }, basis);
    /** Liability at the end of the previous month with that month's wage (reused as "before"). */
    let prevLiability: number | null = null;
    let otHoursYear = 0;
    let otYear = -1;
    // Per-employee invariants (hoisted out of the month loop).
    const oneOffs = e.allowances.filter((x) => !x.isMonthly && !x.isPaid);
    const medClass = e.medicalInsuranceClass ? normalizeClassKey(e.medicalInsuranceClass) : null;
    // Medical premiums: company settings only (no default premium, no scenario range).
    const cs = p.settings;
    const settingsName = (p.settingsCompanyId && companies.get(p.settingsCompanyId)?.name) || null;
    const fromSettings = settingsName ? `إعدادات الشركة: ${settingsName}` : 'إعدادات الشركة';
    const premiums = cs.medicalPremiums as Record<string, number | undefined>;
    const premium = medClass ? premiums[medClass] : undefined;
    const payerField = normalizePayer(e.dependentsFeePaidBy);
    const payer = payerField ?? ((a.dependentsFeePaidByDefault.value as string | null) === 'COMPANY' ? 'COMPANY' : 'EMPLOYEE');
    const female = isFemale(e.gender);
    const hrdfOn = isSaudi && (a.includeHrdf.value as boolean | null) !== false;
    const hrdfDecision = hrdfOn ? hrdfWindowDecision(p, female, a.companyIsSme.value as boolean | null) : null;
    let lines: CostLine[] = [];
    const push = (key: CostLineKey, amount: number, basisText: string, status: WfStatus, ruleKeys: string[], kind: CostLineKind = 'COST', lineNote?: string) => {
      const line: CostLine = { key, label: COST_LINE_META[key].label, amount: roundMoney(amount), basis: basisText, status, ruleKeys, kind };
      if (lineNote) line.note = lineNote;
      lines.push(line);
      byLine[key] = (byLine[key] ?? 0) + line.amount;
    };

    for (const m of months) {
      const days = p.activeDays[m.i];
      const basic = p.basics[m.i];
      const emp = { basicSalary: basic, allowances: e.allowances };
      const wage = monthlyWage(emp, basis);
      lines = [];

      if (days <= 0) {
        monthsOut.push({ month: m.key, active: false, factor: 0, basicSalary: basic, contributoryWage: 0, gosiRegimeUsed: null, gosiEmployerRatePct: null, levyTier: null, lines, totals: zero(), memo: 0 });
        prevWage = wage;
        prevLiability = null;
        continue;
      }
      const factor = days / m.days;
      const partial = days < m.days;
      const prorate = partial ? ` × ${days}/${m.days} يوم` : '';
      const lastDay = p.exit && p.exit.getTime() < m.end.getTime() ? p.exit : m.end;
      const prevLastDay = m.prevEnd;

      // Salary
      push('BASIC', basic * factor, partial ? fmt(basic) + prorate : fmt(basic), 'DERIVED', NO_KEYS, 'COST', p.basicNotes[m.i]);
      if (allowanceMonthly > 0) push('ALLOWANCES', allowanceMonthly * factor, partial ? fmt(allowanceMonthly) + prorate : fmt(allowanceMonthly), 'DERIVED', NO_KEYS);
      const bonuses = oneOffs.length ? oneOffs.filter((x) => x.payrollYear === m.year && x.payrollMonth === m.month) : oneOffs;
      if (bonuses.length) {
        const sum = bonuses.reduce((s, x) => s + (x.amount ?? 0), 0);
        push('ONE_OFF_BONUS', sum, bonuses.map((x) => `${x.name ?? 'مكافأة'} ${fmt(x.amount ?? 0)}`).join(' + '), 'DERIVED', NO_KEYS);
      }

      // Overtime (optional planning input)
      const otHours = e.overtimeHoursPerMonth ?? 0;
      if (otHours > 0) {
        if (otYear !== m.year) {
          otYear = m.year;
          otHoursYear = 0;
        }
        // Same hourly as payroll (payroll-core overtimeHourlyRate) with the company's basis setting.
        const otBasis = cs.overtimeHourlyBasis;
        const keys = [citeRule('OVERTIME', m.rules, K.OT_PREMIUM_PCT), citeRule('OVERTIME', m.rules, K.OT_ANNUAL_CAP), COMPANY_SETTING_KEYS.OVERTIME_HOURLY_BASIS];
        const ot = overtimeCost({
          hours: otHours,
          basicSalary: basic,
          allowances: e.allowances,
          basis: otBasis,
          settings,
          annualCapHours: ruleValue(m.rules, K.OT_ANNUAL_CAP),
          hoursYearToDate: otHoursYear,
        });
        otHoursYear += otHours;
        push(
          'OVERTIME',
          ot.amount,
          `${fmt(otHours)} ساعة × ${fmt(ot.hourly)} (${OVERTIME_BASIS_SHORT[otBasis]})`,
          'USER_INPUT',
          keys,
          'COST',
          ot.overCap ? `يتجاوز سقف 720 ساعة سنوياً: يلزم موافقة العامل؛ طريقة الحساب من ${fromSettings}` : `طريقة الحساب من ${fromSettings}`,
        );
      }

      // GOSI employer share
      const capRule = ruleOf(m.rules, K.GOSI_MAX_WAGE);
      const cw = contributoryWage(basic, e.allowances, ruleValue(m.rules, K.GOSI_MAX_WAGE));
      if (cw.housingInferredFromName && !flagged('HOUSING_INFERRED_FROM_NAME', 'GOSI_EMPLOYER')) flag({ code: 'HOUSING_INFERRED_FROM_NAME', severity: 'WARNING', message: 'بدل السكن عُرف من اسمه فقط: حدّد نوع البدل (سكن) ليطابق المسير', lineKey: 'GOSI_EMPLOYER' });
      if (cw.typeConflicts.length && !flagged('HOUSING_TYPE_CONFLICT', 'GOSI_EMPLOYER')) flag({ code: 'HOUSING_TYPE_CONFLICT', severity: 'WARNING', message: housingConflictMessage(cw.typeConflicts, cw.payrollDiff), lineKey: 'GOSI_EMPLOYER' });
      const g = gosiEmployerMonthly({ isSaudi, regime: e.gosiRegime, wage: cw.capped, year: m.year, month: m.month, rates: input.gosiRates, factor });
      const rate = g.rate;
      const gosiKeys = rate
        ? perMonth(m, 'GOSI|' + String(rate.regime) + '|' + rate.isSaudi, () => {
            const id = usage.gosi(rate);
            note('GOSI_EMPLOYER', id);
            return [citeRule('GOSI_EMPLOYER', m.rules, K.GOSI_MAX_WAGE), id];
          })
        : perMonth(m, 'GOSI|none', () => [citeRule('GOSI_EMPLOYER', m.rules, K.GOSI_MAX_WAGE)]);
      if (g.needsReview && isSaudi && !flagged('MISSING_GOSI_REGIME', 'GOSI_EMPLOYER')) flag({ code: 'MISSING_GOSI_REGIME', severity: 'WARNING', message: 'نظام التأمينات غير مؤكد: حُسب بنسب النظام القديم', lineKey: 'GOSI_EMPLOYER' });
      const gosiStatus = weakestStatus([g.rate ? (g.rate.isProvisional ? 'PROVISIONAL' : 'VERIFIED_PRIMARY') : 'MISSING', g.needsReview ? 'PROVISIONAL' : 'VERIFIED_PRIMARY', capRule.status === 'MISSING' ? 'VERIFIED_PRIMARY' : capRule.status]);
      let gosiNote = g.notes.length ? g.notes.join(' | ') : '';
      if (cw.raw > cw.capped) gosiNote += (gosiNote ? ' | ' : '') + `الأجر ${fmt(cw.raw)} فوق الحد الأعلى ${fmt(cw.capped)}`;
      if (cw.housing > 0) gosiNote += (gosiNote ? ' | ' : '') + 'يشمل السكن ' + fmt(cw.housing);
      push('GOSI_EMPLOYER', g.employer, rate ? perMonth(m, 'PCT|' + rate.employerRate, () => pct(rate.employerRate)) + ' × ' + fmt(g.contributoryWage) + prorate : 'لا يوجد معدل ساري', gosiStatus, gosiKeys, 'COST', gosiNote || undefined);

      // EOSB accrual (art. 84, employer-termination basis)
      const eosbNow = eosbLiability(wage, e.joinDate, lastDay, 'EMPLOYER');
      const eosbBefore = prevLiability ?? eosbLiability(prevWage, e.joinDate, prevLastDay, 'EMPLOYER');
      prevLiability = eosbNow;
      perMonth(m, 'LAW84', () => { note('EOSB_ACCRUAL', usage.law('LAW:ART84')); return true; });
      push('EOSB_ACCRUAL', eosbNow - eosbBefore, fmt(eosbNow) + ' − ' + fmt(eosbBefore), 'VERIFIED_PRIMARY', LAW84_KEYS, 'COST', wage !== prevWage ? 'يشمل أثر تغيّر الأجر على السنوات السابقة (المكافأة على آخر أجر)' : undefined);

      // Leave accrual (art. 109) — provision
      const daily = dailyRate(emp, basis);
      if (lastDay !== m.end) prevLiability = null; // exit month: next month is inactive anyway
      const lv = leaveLiabilityMonthly({ joinDate: e.joinDate, from: prevLastDay, to: lastDay, dailyWage: daily, annualLeaveDaysSetting: input.annualLeaveDaysSetting });
      const leaveKeys = perMonth(m, 'LEAVE', () => {
        note('LEAVE_ACCRUAL', usage.law('LAW:ART109'));
        return ['LAW:ART109', citeRule('LEAVE_ACCRUAL', m.rules, K.ANNUAL_LEAVE), citeRule('LEAVE_ACCRUAL', m.rules, K.ANNUAL_LEAVE_5Y)];
      });
      push('LEAVE_ACCRUAL', lv.amount, fmt(lv.days) + ' يوم × ' + fmt(daily) + ' (' + lv.entitlement + ' يوماً سنوياً)', 'VERIFIED_PRIMARY', leaveKeys, leaveInTotal ? 'COST' : 'MEMO', leaveInTotal ? undefined : 'مخصص محاسبي: الراتب يُدفع أثناء الإجازة، فلا يُضاف للإجمالي');

      // Expat fees
      let levyTier: EmployeeMonth['levyTier'] = null;
      if (p.cls === 'EXPAT') {
        const alloc = levyByMonth[m.i].get(p.companyId);
        const slot = alloc?.byEmployee.get(e.id);
        const withinR = ruleOf(m.rules, K.LEVY_WITHIN);
        const aboveR = ruleOf(m.rules, K.LEVY_ABOVE);
        let levyKeys = perMonth(m, 'LEVY', () => [citeRule('EXPAT_LEVY', m.rules, K.LEVY_WITHIN), citeRule('EXPAT_LEVY', m.rules, K.LEVY_ABOVE)]);
        if (slot && alloc) {
          levyTier = slot.tier;
          const s = alloc.summary;
          if (slot.tier === 'INDUSTRIAL_ZERO') {
            const baseKeys = levyKeys;
            levyKeys = perMonth(m, 'LEVY_IND', () => [...baseKeys, citeRule('EXPAT_LEVY', m.rules, K.INDUSTRIAL_LEVY_CANCELLED)]);
            push('EXPAT_LEVY', 0, 'منشأة صناعية مرخّصة: المقابل المالي ملغى', statusOfRule(m.rules, K.INDUSTRIAL_LEVY_CANCELLED), levyKeys);
          } else if (slot.tier === 'EXEMPT') {
            const baseKeys = levyKeys;
            const reason = alloc.exemption.reason;
            levyKeys = perMonth(m, 'LEVY_EX|' + reason, () => [...baseKeys, citeRule('EXPAT_LEVY', m.rules, K.SMALL_EST_MAX), citeRule('EXPAT_LEVY', m.rules, reason === 'OWNER_AND_SAUDI' ? K.SMALL_EST_SAUDI : K.SMALL_EST_OWNER), assumptionRuleKey('OWNER_FULL_TIME')]);
            // The extension's end (about Feb 2027) is only secondary-corroborated: no effectiveTo is invented;
            // months from SMALL_EST_EXTENSION_UNCERTAIN_FROM are flagged instead (unless the rule has an end).
            const extensionUncertain = m.key >= SMALL_EST_EXTENSION_UNCERTAIN_FROM && !ruleOf(m.rules, K.SMALL_EST_MAX).effectiveTo;
            push(
              'EXPAT_LEVY',
              0,
              `معفى: منشأة صغيرة (${s.headcount} عمال) — إعفاء ${alloc.exemption.count} وافدين`,
              extensionUncertain ? 'PROVISIONAL' : 'USER_INPUT',
              levyKeys,
              'COST',
              extensionUncertain ? `الإعفاء يعتمد على افتراض تفرغ المالك؛ و${SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE}` : 'الإعفاء يعتمد على افتراض تفرغ المالك',
            );
            flag({ code: 'SMALL_EST_EXEMPTION_ASSUMED', severity: 'INFO', message: 'إعفاء المنشأة الصغيرة مبني على افتراض تفرغ المالك، وتاريخ انتهاء التمديد مؤكد ثانوياً فقط', lineKey: 'EXPAT_LEVY' });
            if (extensionUncertain && !flagged('SMALL_EST_EXTENSION_UNCERTAIN', 'EXPAT_LEVY'))
              flag({ code: 'SMALL_EST_EXTENSION_UNCERTAIN', severity: 'WARNING', message: `${SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE} (الإعفاء مفترض مستمراً من ${m.key})`, lineKey: 'EXPAT_LEVY' });
          } else {
            const within = slot.tier === 'WITHIN';
            push(
              'EXPAT_LEVY',
              slot.amount,
              within ? `${fmt(slot.amount)}: ترتيبه ${slot.rank - s.exempt} ضمن عدد السعوديين (${s.saudi})` : `${fmt(slot.amount)}: ترتيبه ${slot.rank - s.exempt} يتجاوز عدد السعوديين (${s.saudi})`,
              within ? withinR.status : aboveR.status,
              levyKeys,
            );
          }
          if (alloc.exemptionUnknown) addGlobalFlag({ code: 'MISSING_ASSUMPTION', severity: 'WARNING', message: 'المنشأة 9 عمال فأقل: أدخل افتراض «المالك متفرغ» لاحتساب إعفاء المقابل المالي', companyId: p.companyId, lineKey: 'EXPAT_LEVY' });
        }
        const wpT = perMonth(m, 'WP', () => {
          const wp = ruleValue(m.rules, K.WORK_PERMIT_YEAR);
          return { amount: (wp ?? 0) / 12, basis: wp === null ? 'غير متوفر' : fmt(wp) + ' ÷ 12', status: statusOfRule(m.rules, K.WORK_PERMIT_YEAR), keys: [citeRule('WORK_PERMIT', m.rules, K.WORK_PERMIT_YEAR)] };
        });
        push('WORK_PERMIT', wpT.amount, wpT.basis, wpT.status, wpT.keys);
        // Iqama fee: the company setting when entered (USER_INPUT), else the rule register (PROVISIONAL 650).
        const companyFee = cs.iqamaFeeYear;
        if (companyFee !== null) {
          push('IQAMA', companyFee / 12, fmt(companyFee) + ' ÷ 12', 'USER_INPUT', IQAMA_COMPANY_KEYS, 'COST', fromSettings);
        } else {
          const iqT = perMonth(m, 'IQ', () => {
            const iq = ruleValue(m.rules, K.IQAMA_YEAR);
            return { amount: (iq ?? 0) / 12, basis: iq === null ? 'غير متوفر' : fmt(iq) + ' ÷ 12', status: statusOfRule(m.rules, K.IQAMA_YEAR), keys: [citeRule('IQAMA', m.rules, K.IQAMA_YEAR)] };
          });
          push('IQAMA', iqT.amount, iqT.basis, iqT.status, iqT.keys, 'COST', 'من سجل القواعد: لم تُدخل رسوم الإقامة في إعدادات الشركة');
        }

        if (payer === 'COMPANY') {
          const count = e.dependentsCount ?? 0;
          if ((e.dependentsCount === null || e.dependentsCount === undefined) && !flagged('DEPENDENTS_UNKNOWN', 'DEPENDENTS_FEE')) flag({ code: 'DEPENDENTS_UNKNOWN', severity: 'INFO', message: 'عدد المرافقين غير مسجّل (الشركة تدفع رسومهم)', lineKey: 'DEPENDENTS_FEE' });
          if (count > 0) {
            const fee = ruleValue(m.rules, K.DEPENDENT_MONTH);
            const keys = payerField
              ? perMonth(m, 'DEP', () => [citeRule('DEPENDENTS_FEE', m.rules, K.DEPENDENT_MONTH)])
              : perMonth(m, 'DEP_DEFAULT', () => [citeRule('DEPENDENTS_FEE', m.rules, K.DEPENDENT_MONTH), assumptionRuleKey('DEPENDENTS_FEE_PAID_BY_DEFAULT')]);
            push('DEPENDENTS_FEE', (fee ?? 0) * count, `${fmt(fee ?? 0)} × ${count} مرافق`, payerField ? statusOfRule(m.rules, K.DEPENDENT_MONTH) : weakestStatus([statusOfRule(m.rules, K.DEPENDENT_MONTH), 'USER_INPUT']), keys, 'COST', 'تدفعها الشركة');
          }
        }

        const visas = (a.exitReentryVisasPerYear.value as number | null) ?? 0;
        if (visas > 0) {
          const fee = ruleValue(m.rules, K.ERV_SINGLE);
          push('EXIT_REENTRY', ((fee ?? 0) * visas) / 12, `${fmt(visas)} × ${fmt(fee ?? 0)} ÷ 12`, weakestStatus([statusOfRule(m.rules, K.ERV_SINGLE), 'USER_INPUT']), perMonth(m, 'ERV', () => [citeRule('EXIT_REENTRY', m.rules, K.ERV_SINGLE), assumptionRuleKey('EXIT_REENTRY_VISAS_PER_YEAR')]));
        }

        const ticket = a.annualTicketCost.value as number | null;
        if (ticket !== null) push('ANNUAL_TICKET', ticket / 12, fmt(ticket) + ' ÷ 12', 'USER_INPUT', TICKET_KEYS);
        else {
          push('ANNUAL_TICKET', 0, 'غير مدخل', 'MISSING', TICKET_KEYS, 'COST', 'أدخل افتراض كلفة التذكرة السنوية إن كانت سياسة الشركة أو العقد تنص عليها');
          addGlobalFlag({ code: 'MISSING_ASSUMPTION', severity: 'INFO', message: `افتراض غير مدخل: ${ASSUMPTION_DEFS.ANNUAL_TICKET_COST.label}`, companyId: p.companyId, lineKey: 'ANNUAL_TICKET' });
        }
      }

      // Medical insurance (every employee)
      const cls = medClass;
      const companyRef = p.settingsCompanyId ? { companyId: p.settingsCompanyId } : {};
      if (typeof premium === 'number') {
        push('MEDICAL', premium / 12, `${fmt(premium)} ÷ 12 (فئة ${cls})`, 'USER_INPUT', MED_KEYS, 'COST', fromSettings);
      } else {
        push('MEDICAL', 0, 'القسط غير مدخل', 'MISSING', MED_KEYS, 'COST', cls ? `التأمين الطبي إلزامي: أدخل قسط الفئة ${cls} في إعدادات الشركة` : 'التأمين الطبي إلزامي: حدّد فئة التأمين في ملف الموظف');
        if (!flagged(cls ? 'MISSING_MEDICAL_PREMIUM' : 'MISSING_MEDICAL_CLASS', 'MEDICAL')) flag(
          cls
            ? { code: 'MISSING_MEDICAL_PREMIUM', severity: 'WARNING', message: `لا يوجد قسط تأمين طبي للفئة ${cls} في إعدادات الشركة${settingsName ? ` (${settingsName})` : ''}`, lineKey: 'MEDICAL', ...companyRef }
            : { code: 'MISSING_MEDICAL_CLASS', severity: 'WARNING', message: 'فئة التأمين الطبي غير محددة في ملف الموظف', lineKey: 'MEDICAL' },
        );
      }
      const deps = e.dependentsCount ?? 0;
      if (deps > 0) {
        const dp = premiums.DEPENDENT;
        if (typeof dp === 'number') push('MEDICAL_DEPENDENTS', (dp * deps) / 12, deps + ' × ' + fmt(dp) + ' ÷ 12', 'USER_INPUT', MED_KEYS, 'COST', fromSettings);
        else {
          push('MEDICAL_DEPENDENTS', 0, 'القسط غير مدخل', 'MISSING', MED_KEYS, 'COST', 'تأمين أسرة الموظف على صاحب العمل: أدخل القسط لكل مرافق في إعدادات الشركة');
          flag({ code: 'MISSING_MEDICAL_PREMIUM', severity: 'WARNING', message: `قسط التأمين الطبي لكل مرافق غير مدخل في إعدادات الشركة${settingsName ? ` (${settingsName})` : ''}`, lineKey: 'MEDICAL_DEPENDENTS', ...companyRef });
        }
      }

      // HRDF employment support (conditional, negative)
      const hrdfK = monthsBetween(e.joinDate, m.start);
      if (hrdfDecision && hrdfDecision.firstK === null && hrdfDecision.unknownWage && hrdfK >= HRDF_START_OFFSET_MONTHS && !flagged('HRDF_WINDOW_WAGE_UNKNOWN', 'HRDF_SUBSIDY')) {
        const supportMonths = ruleValue(m.rules, K.HRDF_MONTHS);
        if (supportMonths !== null && hrdfK < HRDF_START_OFFSET_MONTHS + supportMonths)
          flag({ code: 'HRDF_WINDOW_WAGE_UNKNOWN', severity: 'INFO', message: 'أجر فترة التقديم لدعم هدف (الشهر 4–6 من المباشرة) غير معروف: تغيّر الراتب بعدها ولا يوجد تغيير مسجّل قبلها، فلم يُحتسب الدعم', lineKey: 'HRDF_SUBSIDY' });
      }
      if (hrdfDecision && hrdfDecision.firstK !== null && hrdfK >= hrdfDecision.firstK) {
        const h = hrdfSubsidyMonthly({
          eligibilityDecided: true,
          isSaudi,
          wage: cw.raw,
          fullTime: p.fullTime,
          monthsSinceJoin: hrdfK,
          age: ageOn(e.dateOfBirth ?? null, m.start),
          female,
          disabled: !!e.isDisabled,
          sme: a.companyIsSme.value as boolean | null,
          city: e.branchCity,
          basePct: ruleOf(m.rules, K.HRDF_BASE_PCT),
          bonusPct: ruleOf(m.rules, K.HRDF_BONUS_PCT),
          cap: ruleOf(m.rules, K.HRDF_CAP),
          capPct: ruleOf(m.rules, K.HRDF_CAP_PCT),
          minWage: ruleOf(m.rules, K.HRDF_MIN_WAGE),
          maxWage: ruleOf(m.rules, K.HRDF_MAX_WAGE),
          months: ruleOf(m.rules, K.HRDF_MONTHS),
        });
        if (h.eligible && h.amount > 0) {
          const keys = [K.HRDF_BASE_PCT, K.HRDF_BONUS_PCT, K.HRDF_CAP, K.HRDF_CAP_PCT, K.HRDF_MIN_WAGE, K.HRDF_MAX_WAGE, K.HRDF_MONTHS].map((k) => citeRule('HRDF_SUBSIDY', m.rules, k));
          const statuses: WfStatus[] = keys.map((k) => statusOfRule(m.rules, k));
          if (h.categories.includes('SME')) {
            keys.push(assumptionRuleKey('COMPANY_IS_SME'));
            statuses.push('USER_INPUT');
          }
          const capText = h.cappedBy === 'SAR_CAP' ? ' (بالسقف 3,000)' : h.cappedBy === 'WAGE_PCT_CAP' ? ' (بسقف 50% من الأجر)' : '';
          push('HRDF_SUBSIDY', -h.amount, `${pct(h.pct)} × ${fmt(cw.raw)}${capText}`, weakestStatus(statuses), keys, 'SUBSIDY', hrdfNote(h.categories));
          // Structured codes next to the note: the API layer redacts them per viewer (privacy.ts).
          if (h.categories.length) lines[lines.length - 1].categories = [...h.categories];
          addGlobalFlag({ code: 'HRDF_CONDITIONAL', severity: 'INFO', message: 'دعم هدف مشروط بقبول الطلب والتقديم بين اليوم 91 و180 من التسجيل في التأمينات (الأهلية تُقرَّر بأجر تلك الفترة)، ويظهر سطراً سالباً مستقلاً' });
        }
      }

      let cost = 0;
      let subsidy = 0;
      let memo = 0;
      for (const l of lines) {
        if (l.kind === 'COST') cost += l.amount;
        else if (l.kind === 'SUBSIDY') subsidy += l.amount;
        else memo += l.amount;
      }
      monthsOut.push({
        month: m.key,
        active: true,
        factor: Math.round(factor * 10000) / 10000,
        basicSalary: basic,
        contributoryWage: g.contributoryWage,
        gosiRegimeUsed: g.rate ? g.regimeUsed : null,
        gosiEmployerRatePct: g.rate ? g.rate.employerRate : null,
        levyTier,
        lines,
        totals: roundTriple({ cost, subsidy, net: cost + subsidy }),
        memo: roundMoney(memo),
      });
      prevWage = wage;
    }

    for (const k of Object.keys(byLine) as CostLineKey[]) byLine[k] = roundMoney(byLine[k] ?? 0);

    const wageAtStart = monthlyWage({ basicSalary: e.basicSalary, allowances: e.allowances }, basis);
    const lastWage = monthlyWage({ basicSalary: p.basics[p.basics.length - 1], allowances: e.allowances }, basis);
    const endDay = p.exit && p.exit.getTime() < horizonEnd.getTime() ? p.exit : horizonEnd;
    return {
      employeeId: e.id,
      name: e.name,
      employeeNo: e.employeeNo ?? null,
      isPlanned: !!e.isPlanned,
      nationalityClass: p.cls,
      legalCompanyId: e.legalCompanyId ?? null,
      companyName: company?.name ?? null,
      settingsCompanyId: p.settingsCompanyId,
      branchId: e.branchId ?? null,
      branchName: e.branchName ?? null,
      departmentId: e.departmentId ?? null,
      departmentName: e.departmentName ?? null,
      exitDate: p.exit && p.exit.getTime() <= horizonEnd.getTime() ? p.exit.toISOString().slice(0, 10) : null,
      months: monthsOut,
      totals: windowTotals(monthsOut.map((x) => x.totals)),
      byLine,
      liabilities: {
        eosbEmployerAtStart: eosbLiability(wageAtStart, e.joinDate, dayBeforeStart, 'EMPLOYER'),
        eosbResignationAtStart: eosbLiability(wageAtStart, e.joinDate, dayBeforeStart, 'RESIGNATION'),
        eosbEmployerAtEnd: eosbLiability(lastWage, e.joinDate, endDay, 'EMPLOYER'),
        eosbResignationAtEnd: eosbLiability(lastWage, e.joinDate, endDay, 'RESIGNATION'),
        wageAtStart,
      },
      flags: [...flags.values()],
    };
  }

  // ---- Aggregation ----
  const series = months.map((m) => ({ month: m.key, cost: 0, subsidy: 0, net: 0, headcount: 0, byLine: {} as Partial<Record<CostLineKey, number>> }));
  const groupAcc = {
    company: new Map<string, { name: string; rows: EmployeeCostResult[] }>(),
    branch: new Map<string, { name: string; rows: EmployeeCostResult[] }>(),
    department: new Map<string, { name: string; rows: EmployeeCostResult[] }>(),
  };
  const addGroup = (map: Map<string, { name: string; rows: EmployeeCostResult[] }>, id: string, name: string, r: EmployeeCostResult) => {
    const g = map.get(id) ?? { name, rows: [] };
    g.rows.push(r);
    map.set(id, g);
  };
  for (const r of results) {
    r.months.forEach((mo, i) => {
      const s = series[i];
      s.cost += mo.totals.cost;
      s.subsidy += mo.totals.subsidy;
      s.net += mo.totals.net;
      if (mo.active) s.headcount++;
      for (const l of mo.lines) s.byLine[l.key] = (s.byLine[l.key] ?? 0) + l.amount;
    });
    addGroup(groupAcc.company, r.legalCompanyId ?? '', r.companyName ?? 'بدون شركة قانونية', r);
    addGroup(groupAcc.branch, r.branchId ?? '', r.branchName ?? 'بدون فرع', r);
    addGroup(groupAcc.department, r.departmentId ?? '', r.departmentName ?? 'بدون إدارة', r);
  }
  for (const s of series) {
    s.cost = roundMoney(s.cost);
    s.subsidy = roundMoney(s.subsidy);
    s.net = roundMoney(s.net);
    for (const k of Object.keys(s.byLine) as CostLineKey[]) s.byLine[k] = roundMoney(s.byLine[k] ?? 0);
  }

  const groupTotals = (map: Map<string, { name: string; rows: EmployeeCostResult[] }>): GroupTotals[] =>
    [...map.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([id, g]) => {
        const ser = months.map((m) => ({ month: m.key, cost: 0, subsidy: 0, net: 0 }));
        const byLine: Partial<Record<CostLineKey, number>> = {};
        let headcount = 0;
        for (const r of g.rows) {
          if (r.months[0]?.active) headcount++;
          r.months.forEach((mo, i) => addTriple(ser[i], mo.totals.cost, mo.totals.subsidy));
          for (const [k, v] of Object.entries(r.byLine)) byLine[k as CostLineKey] = (byLine[k as CostLineKey] ?? 0) + (v ?? 0);
        }
        for (const k of Object.keys(byLine) as CostLineKey[]) byLine[k] = roundMoney(byLine[k] ?? 0);
        const rounded = ser.map((s) => ({ month: s.month, ...roundTriple(s) }));
        return { id, name: g.name, headcount, totals: windowTotals(rounded), byLine, series: rounded };
      });

  const composition = COST_LINE_ORDER.filter((k) => series.some((s) => s.byLine[k] !== undefined)).map((k) => ({
    key: k,
    label: COST_LINE_META[k].label,
    kind: (k === 'HRDF_SUBSIDY' ? 'SUBSIDY' : k === 'LEAVE_ACCRUAL' && !leaveInTotal ? 'MEMO' : 'COST') as CostLineKind,
    next12: roundMoney(series.slice(0, 12).reduce((s, x) => s + (x.byLine[k] ?? 0), 0)),
    horizon: roundMoney(series.reduce((s, x) => s + (x.byLine[k] ?? 0), 0)),
  }));

  const companyMix: CompanyMix[] = companyIds.map((cid) => {
    const c = companies.get(cid);
    return {
      companyId: cid,
      name: c?.name ?? 'بدون شركة قانونية',
      isIndustrialLicensed: c?.isIndustrialLicensed ?? false,
      months: months.map((m) => {
        const s = levyByMonth[m.i].get(cid)!.summary;
        return { month: m.key, headcount: s.headcount, saudi: s.saudi, gcc: s.gcc, expat: s.expat, exempt: s.exempt, within: s.within, above: s.above, industrialZero: s.industrialZero, levyTotal: s.monthlyLevy };
      }),
    };
  });

  const explanations: Partial<Record<CostLineKey, LineExplanation>> = {};
  for (const k of COST_LINE_ORDER) {
    if (!series.some((s) => s.byLine[k] !== undefined)) continue;
    explanations[k] = { label: COST_LINE_META[k].label, formulaText: COST_LINE_META[k].formula, rules: usage.evidenceFor(explainIds.get(k) ?? []) };
  }

  const assumptionsUsed: TrueCostResult['assumptionsUsed'] = [];
  for (const [cid, a] of [...assumptionCache.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    for (const v of Object.values(a)) {
      if (!v || typeof v !== 'object' || !('key' in v)) continue;
      assumptionsUsed.push({ key: v.key, value: v.value, origin: v.origin, companyId: cid === NO_COMPANY_ID ? '' : cid });
    }
  }

  const companySettingsUsed: TrueCostResult['companySettingsUsed'] = [...settingsUsed.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([companyId, s]) => ({ companyId, name: companies.get(companyId)?.name ?? companyId, ...s }));

  const allFlags = [...globalFlags.values(), ...results.flatMap((r) => r.flags)];
  return {
    engineVersion: ENGINE_VERSION,
    scenario,
    startMonth: months[0].key,
    monthKeys: months.map((m) => m.key),
    employees: results,
    series,
    totals: windowTotals(series),
    composition,
    byCompany: groupTotals(groupAcc.company),
    byBranch: groupTotals(groupAcc.branch),
    byDepartment: groupTotals(groupAcc.department),
    companies: companyMix,
    flags: allFlags,
    explanations,
    rulesUsed: usage.refs(),
    assumptionsUsed,
    companySettingsUsed,
  };
}

export const HRDF_CATEGORY_LABELS: Record<HrdfCategory, string> = {
  FEMALE: 'امرأة',
  DISABLED: 'ذو إعاقة',
  SME: 'منشأة صغيرة أو متوسطة',
  OUTSIDE_MAJOR_CITIES: 'خارج الرياض وجدة والدمام والخبر',
};

/** Neutral replacement of the HRDF category list for viewers who may not see disability (privacy.ts). */
export const HRDF_NEUTRAL_CATEGORIES_TEXT = 'فئات دعم إضافية';

/**
 * Note of the HRDF_SUBSIDY line. 'REDACTED' = the list replaced by HRDF_NEUTRAL_CATEGORIES_TEXT for a viewer
 * who may not see disability (privacy.ts); the amount and percentage stay (SPEC «خصوصية بيانات الإعاقة»
 * documents the residual inference risk).
 */
export function hrdfNote(categories: ReadonlyArray<HrdfCategory> | 'REDACTED'): string {
  if (categories === 'REDACTED') return `مشروط بقبول هدف؛ الفئات: ${HRDF_NEUTRAL_CATEGORIES_TEXT}`;
  if (!categories.length) return 'مشروط بقبول هدف';
  return `مشروط بقبول هدف؛ الفئات: ${categories.map((c) => HRDF_CATEGORY_LABELS[c]).join('، ')}`;
}

/**
 * First month whose small-establishment levy exemption is uncertain: the 3-year extension from Feb 2024
 * ends about Feb 2027 (secondary sources only, SPEC §2.3). No effectiveTo is invented on the rule; the
 * months from here on are flagged SMALL_EST_EXTENSION_UNCERTAIN while the rule has no end date.
 */
export const SMALL_EST_EXTENSION_UNCERTAIN_FROM = '2027-02';
export const SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE = 'انتهاء تمديد إعفاء المنشآت الصغيرة غير مؤكد — راجع قوى';

const HOUSING_CONFLICT_TEXT: Record<HousingTypeConflict['reason'], string> = {
  TYPED_NOT_HOUSING_BUT_GOSI: 'نوعه ليس سكناً لكنه معلَّم «يدخل في التأمينات»',
  TYPED_NOT_HOUSING_BUT_NAME: 'اسمه سكن لكن نوعه ليس سكناً',
  HOUSING_NOT_GOSI: 'نوعه سكن لكنه غير معلَّم «يدخل في التأمينات»',
};

/** HOUSING_TYPE_CONFLICT message: which allowances, and the monthly difference vs payroll's GOSI base. */
export function housingConflictMessage(conflicts: ReadonlyArray<HousingTypeConflict>, payrollDiff: number): string {
  const list = conflicts.map((c) => `«${c.name || 'بدل'}» (${HOUSING_CONFLICT_TEXT[c.reason]})`).join('، ');
  const diff =
    payrollDiff === 0
      ? 'وعاء التأمينات هنا يساوي وعاء المسير'
      : `وعاء التأمينات في المسير ${payrollDiff > 0 ? 'أعلى' : 'أقل'} بـ ${fmtRaw(Math.abs(payrollDiff))} ريال شهرياً (المحرك يتبع نوع البدل، والمسير يتبع علامة «يدخل في التأمينات»)`;
  return `تعارض في بيانات البدل: ${list}؛ ${diff}. صحّح نوع البدل أو العلامة ليتطابقا`;
}

/** 'COMPANY' / 'EMPLOYEE' (Arabic accepted) or null. */
export function normalizePayer(v: string | null | undefined): 'COMPANY' | 'EMPLOYEE' | null {
  const s = (v ?? '').trim().toUpperCase();
  if (s === 'COMPANY' || s === 'الشركة' || s === 'المنشأة') return 'COMPANY';
  if (s === 'EMPLOYEE' || s === 'الموظف') return 'EMPLOYEE';
  return null;
}
