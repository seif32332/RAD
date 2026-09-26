// Exit cost engine ("كلفة الإنهاء والإحلال"). PURE, deterministic.
//
// EOSB, leave payout and loans come from computeSettlement() (src/lib/settlement.ts) with the same
// inputs the settlement screen uses. settlementScreenTotal EXCLUDES the last month's working-day salary
// (lastMonthAlreadyPaid = true: that salary is payroll, not an exit cost); the settlement screen adds it
// while no approved / paid payroll covers that month, so result.lastMonth gives that salary and the total
// including it (same computeSettlement, only the switch differs). Notice pay (art. 75/76), the art. 77
// risk, sunk government fees, replacement cost and the levy tier change are added around it.
//
// Decisions:
// - Wage basis: input.salaryBasis, default 'total' (settlement screen default). Planned SalaryChange rows
//   effective on/before the last working day are applied to the basic.
// - Notice applies to COMPANY_TERMINATION (employer: NOTICE_DAYS_EMPLOYER, 60) and RESIGNATION (employee:
//   NOTICE_DAYS_EMPLOYEE, 30) only. Not served by the employer -> pay in lieu (cost). Not served by the
//   employee -> an amount the employee owes (offset, not a cost). Pay = wage × days / 30.
// - Art. 77 risk (separate, never in the payable total): only for COMPANY_TERMINATION (employer
//   termination without an art. 80 cause). Indefinite contract: 15 days' wage per year of service; fixed-
//   term contract (contractEndDate after the last day): wage for the remaining term; minimum 2 months.
// - Sunk fees: remaining whole months of the iqama × fee/12 (fee = Company.iqamaFeeYear of the settings
//   company when entered, else the IQAMA_FEE_YEAR rule); the work permit is assumed to run to the
//   same date (flagged). Information only.
// - Levy tier change: the legal company's allocation in the month after the last working day, with and
//   without the leaver (same allocateLevy as the true cost engine).
import { roundMoney } from '@/lib/money';
import { monthlyWage } from '@/lib/payroll-core';
import { nationalityClass } from '@/lib/nationality';
import {
  COUNSEL_PENDING_NOTE,
  TERMINATION_REASONS,
  TERMINATION_REASON_LABELS,
  computeSettlement,
  isCounselPendingReason,
  outstandingLoansForSettlement,
  type TerminationReasonValue,
} from '@/lib/settlement';
import { RULE_KEYS as K, RuleUsage, indexRules, resolveRules, resolveRulesForMonth, ruleOf, ruleValue, weakestStatus } from '@/lib/workforce/rules';
import { assumptionRuleKey, resolveCompanyAssumptions } from '@/lib/workforce/assumptions';
import { COMPANY_SETTING_KEYS } from '@/lib/workforce/company-settings';
import { activeDays, addMonthsYm, allocateLevy, fmt, isFullTime, monthEndUtc, monthStartUtc, type LevyMember } from '@/lib/workforce/formulas';
import { computeTrueCost, NO_COMPANY_ID, SMALL_EST_EXTENSION_UNCERTAIN_FROM, SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE } from '@/lib/workforce/true-cost';
import { ENGINE_VERSION } from '@/lib/workforce/version';
import { resolveTerminationReason } from '@/lib/workforce/reasons';
import type { ExitCostInput, ExitCostResult, ExitLine, ExitLineKey, ExitLineKind, LineExplanation, WfEmployeeInput, WfFlag, WfStatus } from '@/lib/workforce/types';

const DAY_MS = 86400000;

export const EXIT_LINE_META: Record<ExitLineKey, { label: string; formula: string }> = {
  EOSB: { label: 'مكافأة نهاية الخدمة', formula: 'نصف شهر عن كل سنة من الخمس الأولى وشهر عن كل سنة بعدها على آخر أجر، مع نسبة الاستقالة (المواد 84 و85 و87)' },
  NOTICE_PAY: { label: 'بدل الإشعار', formula: 'أجر مدة الإشعار: 60 يوماً عند إنهاء صاحب العمل (المادتان 75 و76)' },
  NOTICE_OWED_BY_EMPLOYEE: { label: 'بدل إشعار مستحق على الموظف', formula: 'أجر 30 يوماً إن استقال العامل دون إشعار (المادة 76)' },
  LEAVE_PAYOUT: { label: 'بدل الإجازة غير المستخدمة', formula: 'الأيام المستحقة × أجر اليوم (المادة 111)' },
  EXCESS_LEAVE_DEDUCTION: { label: 'خصم إجازة زائدة عن الرصيد', formula: 'الأيام الزائدة × كلفة اليوم (سياسة رديف للوافد)' },
  LOANS_OFFSET: { label: 'السلف المتبقية', formula: 'الرصيد المتبقي ناقص أقساط المسيرات المسودة السابقة' },
  ART77_RISK: { label: 'تعويض الإنهاء غير المشروع (خطر)', formula: '15 يوماً عن كل سنة (غير محدد) أو باقي مدة العقد (محدد)، بحد أدنى أجر شهرين (المادة 77)' },
  SUNK_IQAMA: { label: 'رسوم إقامة مدفوعة غير مستهلكة', formula: 'الأشهر المتبقية من الإقامة × الرسوم ÷ 12' },
  SUNK_WORK_PERMIT: { label: 'رسوم رخصة عمل مدفوعة غير مستهلكة', formula: 'الأشهر المتبقية × الرسوم ÷ 12 (مفترض انتهاؤها مع الإقامة)' },
  RECRUITMENT: { label: 'كلفة توظيف البديل', formula: 'افتراض المنشأة لكلفة التوظيف لمرة واحدة' },
  VACANCY: { label: 'كلفة الشغور', formula: 'أشهر الشغور × الكلفة الشهرية للوظيفة (افتراض)' },
  LEVY_TIER_CHANGE: { label: 'تغيّر المقابل المالي لبقية الوافدين', formula: 'الفرق الشهري في المقابل المالي للكيان بعد الخروج (عدد السعوديين مقابل الوافدين)' },
};

function defaultNoticeParty(reason: TerminationReasonValue): 'EMPLOYER' | 'EMPLOYEE' | null {
  if (reason === 'COMPANY_TERMINATION') return 'EMPLOYER';
  if (reason === 'RESIGNATION') return 'EMPLOYEE';
  return null;
}

function wholeMonthsBetween(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS / (365.25 / 12));
}

/** Basic salary on `date`: current basic, then planned changes effective on/before `date`. */
function basicAt(e: WfEmployeeInput, date: Date): number {
  let basic = e.basicSalary;
  const changes = [...(e.salaryChanges ?? [])].filter((c) => c.isPlanned && c.effectiveDate.getTime() <= date.getTime()).sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  for (const c of changes) basic = c.basicSalary;
  return roundMoney(basic);
}

/**
 * Exit cost of one employee. `input.reason` is a settlement TERMINATION_REASONS value or an
 * Employee.exitReason (EMPLOYEE_EXIT_REASONS, mapped with EXIT_REASON_TO_TERMINATION). Throws when the
 * reason is unknown or needs a choice (MUTUAL_AGREEMENT / OTHER): the caller must pass a settlement reason.
 */
export function computeExitCost(input: ExitCostInput): ExitCostResult {
  const mapped = resolveTerminationReason(input.reason);
  if (!mapped.terminationReason) throw new Error(`exit reason needs a settlement reason (${TERMINATION_REASONS.join(', ')}): ${input.reason}`);
  const reason: TerminationReasonValue = mapped.terminationReason;
  const e = input.employee;
  const lwd = input.lastWorkingDate;
  const basis = input.salaryBasis ?? 'total';
  const scenario = input.scenario ?? 'base';
  const index = indexRules(input.rules);
  const rules = resolveRules(index, lwd);
  const usage = new RuleUsage();
  const explainIds = new Map<ExitLineKey, Set<string>>();
  const flags: WfFlag[] = [];
  if (!mapped.certain) flags.push({ code: 'COUNSEL_PENDING', severity: 'WARNING', message: mapped.note, employeeId: e.id, lineKey: 'EOSB' });
  const cls = nationalityClass(e.nationality);
  const companyId = e.legalCompanyId || NO_COMPANY_ID;
  const a = resolveCompanyAssumptions(input.assumptions, companyId === NO_COMPANY_ID ? '' : companyId, scenario);
  /** Company whose «إعدادات الكلفة» apply (legal company, else actual company). */
  const settingsCompany = input.settingsCompany ?? input.company ?? null;

  const lines: ExitLine[] = [];
  const push = (key: ExitLineKey, amount: number, basisText: string, status: WfStatus, ruleKeys: string[], kind: ExitLineKind, note?: string) => {
    const l: ExitLine = { key, label: EXIT_LINE_META[key].label, amount: roundMoney(amount), basis: basisText, status, ruleKeys, kind };
    if (note) l.note = note;
    lines.push(l);
  };
  const cite = (line: ExitLineKey, id: string) => {
    let s = explainIds.get(line);
    if (!s) explainIds.set(line, (s = new Set()));
    s.add(id);
  };
  const citeRule = (line: ExitLineKey, key: string) => {
    const r = ruleOf(rules, key);
    usage.rule(r);
    cite(line, RuleUsage.id(r));
    if (r.status === 'MISSING') flags.push({ code: 'MISSING_RULE', severity: 'ERROR', message: `قاعدة غير متوفرة في السجل: ${r.label}`, ruleKey: key, lineKey: line, employeeId: e.id });
    return key;
  };
  const law = (line: ExitLineKey, key: string) => {
    usage.law(key);
    cite(line, key);
    return key;
  };

  // --- Settlement (same numbers as the settlement screen) ---
  const basic = basicAt(e, lwd);
  const salaryEmp = { basicSalary: basic, allowances: e.allowances.filter((x) => x.isMonthly) };
  const wage = monthlyWage(salaryEmp, basis);
  const outstandingLoans = outstandingLoansForSettlement(e.loans, lwd);
  const settlement = computeSettlement({
    type: 'END_OF_SERVICE',
    terminationReason: reason,
    salaryBasis: basis,
    employee: { ...salaryEmp, joinDate: e.joinDate, nationality: e.nationality, leaveAccrualStartDate: e.leaveAccrualStartDate ?? null },
    lastWorkingDate: lwd,
    asOf: lwd,
    leaves: e.leaves,
    lastMonthAlreadyPaid: true, // the last month's salary is payroll, not an exit cost
    outstandingLoans,
    overtime: 0,
    manualEntitlements: 0,
    manualDeductions: 0,
    annualLeaveDaysSetting: input.annualLeaveDaysSetting ?? null,
  });
  const years = settlement.yearsOfService;
  // The settlement screen adds the last month's working-day salary while no approved / paid payroll covers
  // that month (its lastMonthAlreadyPaid). Same computeSettlement call, only that switch differs, so
  // settlementScreenTotal + lastMonth.salary reconciles with the settlement screen to the halala.
  const withLastMonth = computeSettlement({
    type: 'END_OF_SERVICE',
    terminationReason: reason,
    salaryBasis: basis,
    employee: { ...salaryEmp, joinDate: e.joinDate, nationality: e.nationality, leaveAccrualStartDate: e.leaveAccrualStartDate ?? null },
    lastWorkingDate: lwd,
    asOf: lwd,
    leaves: e.leaves,
    lastMonthAlreadyPaid: false,
    outstandingLoans,
    overtime: 0,
    manualEntitlements: 0,
    manualDeductions: 0,
    annualLeaveDaysSetting: input.annualLeaveDaysSetting ?? null,
  });

  // --- EOSB ---
  const full = years <= 5 ? wage * 0.5 * years : wage * 0.5 * 5 + wage * (years - 5);
  const eosbKeys = [law('EOSB', 'LAW:ART84')];
  let eosbBasis = `${fmt(wage)} × (0.5 × ${fmt(Math.min(years, 5))}${years > 5 ? ` + ${fmt(years - 5)}` : ''}) = ${fmt(full)}`;
  let eosbStatus: WfStatus = 'VERIFIED_PRIMARY';
  let eosbNote: string | undefined;
  if (reason === 'RESIGNATION') {
    eosbKeys.push(law('EOSB', 'LAW:ART85'));
    eosbBasis += years < 2 ? ' ؛ استقالة قبل سنتين: لا شيء' : years < 5 ? ' × الثلث (استقالة)' : years < 10 ? ' × الثلثان (استقالة)' : ' كاملة (استقالة بعد 10 سنوات)';
  } else if (reason === 'PROBATION' || reason === 'ARTICLE_80') {
    eosbKeys.push(law('EOSB', 'LAW:ART54_80'));
    eosbBasis = `لا مكافأة (${TERMINATION_REASON_LABELS[reason]})`;
  } else if (isCounselPendingReason(reason)) {
    eosbKeys.push(law('EOSB', 'LAW:ART87'));
    eosbStatus = 'PROVISIONAL';
    eosbNote = `المكافأة كاملة: ${COUNSEL_PENDING_NOTE}`;
    flags.push({ code: 'COUNSEL_PENDING', severity: 'WARNING', message: `${TERMINATION_REASON_LABELS[reason]}: ${COUNSEL_PENDING_NOTE}`, lineKey: 'EOSB', employeeId: e.id });
  }
  push('EOSB', settlement.endOfServiceAmount, eosbBasis, eosbStatus, eosbKeys, 'PAYABLE', eosbNote);

  // --- Notice (art. 75/76) ---
  const party = input.whoGivesNotice ?? defaultNoticeParty(reason);
  const noticeApplies = reason === 'COMPANY_TERMINATION' || reason === 'RESIGNATION';
  if (noticeApplies && party === 'EMPLOYER') {
    const days = ruleValue(rules, K.NOTICE_EMPLOYER);
    const keys = [citeRule('NOTICE_PAY', K.NOTICE_EMPLOYER), law('NOTICE_PAY', 'LAW:ART76')];
    if (input.noticeServed) push('NOTICE_PAY', 0, `الإشعار ${fmt(days ?? 0)} يوماً يُعمل به: الأجر يُدفع في المسير`, ruleOf(rules, K.NOTICE_EMPLOYER).status, keys, 'PAYABLE');
    else push('NOTICE_PAY', (wage * (days ?? 0)) / 30, `${fmt(wage)} × ${fmt(days ?? 0)} ÷ 30`, ruleOf(rules, K.NOTICE_EMPLOYER).status, keys, 'PAYABLE', 'بدل إشعار لعدم العمل خلال مدة الإشعار');
  } else if (noticeApplies && party === 'EMPLOYEE') {
    const days = ruleValue(rules, K.NOTICE_EMPLOYEE);
    const keys = [citeRule('NOTICE_OWED_BY_EMPLOYEE', K.NOTICE_EMPLOYEE), law('NOTICE_OWED_BY_EMPLOYEE', 'LAW:ART76')];
    if (!input.noticeServed)
      push('NOTICE_OWED_BY_EMPLOYEE', -((wage * (days ?? 0)) / 30), `${fmt(wage)} × ${fmt(days ?? 0)} ÷ 30`, ruleOf(rules, K.NOTICE_EMPLOYEE).status, keys, 'OFFSET', 'مبلغ مستحق على الموظف لعدم الإشعار، وليس كلفة؛ خصمه من المستحقات يحتاج اتفاقاً أو حكماً');
  }

  // --- Art. 77 risk ---
  if (reason === 'COMPANY_TERMINATION') {
    const perYear = ruleValue(rules, K.ART77_DAYS);
    const minMonths = ruleValue(rules, K.ART77_MIN_MONTHS);
    const keys = [citeRule('ART77_RISK', K.ART77_DAYS), citeRule('ART77_RISK', K.ART77_MIN_MONTHS)];
    const fixedTerm = !!e.contractEndDate && e.contractEndDate.getTime() > lwd.getTime();
    let raw: number;
    let text: string;
    if (fixedTerm) {
      const remainingDays = Math.round((e.contractEndDate!.getTime() - lwd.getTime()) / DAY_MS);
      raw = (wage * remainingDays) / 30;
      text = `باقي مدة العقد ${remainingDays} يوماً × ${fmt(wage)} ÷ 30`;
    } else {
      raw = (wage / 30) * (perYear ?? 0) * years;
      text = `${fmt(wage)} ÷ 30 × ${fmt(perYear ?? 0)} × ${fmt(years)} سنة`;
    }
    const min = wage * (minMonths ?? 0);
    const amount = Math.max(raw, min);
    if (amount === min && min > raw) text += ` ← الحد الأدنى ${fmt(minMonths ?? 0)} شهر = ${fmt(min)}`;
    push('ART77_RISK', amount, text, weakestStatus([ruleOf(rules, K.ART77_DAYS).status, ruleOf(rules, K.ART77_MIN_MONTHS).status]), keys, 'RISK', 'يُستحق فقط إن حُكم بأن الإنهاء لسبب غير مشروع؛ لا يدخل في الإجمالي');
  }

  // --- Leave payout (art. 111) and excess leave ---
  if (settlement.leaveCompensation > 0) push('LEAVE_PAYOUT', settlement.leaveCompensation, `${fmt(settlement.leaveDaysToPay)} يوم × ${fmt(settlement.dailySalary)}`, 'VERIFIED_PRIMARY', [law('LEAVE_PAYOUT', 'LAW:ART111'), law('LEAVE_PAYOUT', 'LAW:ART109')], 'PAYABLE');
  if (settlement.excessDeduction > 0) push('EXCESS_LEAVE_DEDUCTION', -settlement.excessDeduction, `رصيد سالب ${fmt(Math.abs(settlement.accruedLeaveDays))} يوم`, 'DERIVED', [], 'OFFSET');

  // --- Loans ---
  if (settlement.loansDeduction > 0) push('LOANS_OFFSET', -settlement.loansDeduction, `رصيد السلف ${fmt(settlement.loansDeduction)}`, 'DERIVED', [], 'OFFSET');

  // --- Sunk prepaid government fees (expats, information) ---
  if (cls === 'EXPAT') {
    if (e.iqamaExpiry && e.iqamaExpiry.getTime() > lwd.getTime()) {
      const months = wholeMonthsBetween(lwd, e.iqamaExpiry);
      if (months > 0) {
        // Iqama fee: company setting when entered («إعدادات الكلفة»), else the rule register.
        const companyFee = settingsCompany?.costSettings?.iqamaFeeYear ?? null;
        if (companyFee !== null) {
          push('SUNK_IQAMA', (months * companyFee) / 12, `${months} شهر × ${fmt(companyFee)} ÷ 12`, 'USER_INPUT', [COMPANY_SETTING_KEYS.IQAMA_FEE_YEAR], 'SUNK', `معلومة: رسوم مدفوعة مقدماً لا تُسترد؛ الرسوم من إعدادات الشركة: ${settingsCompany?.name ?? ''}`.trim());
        } else {
          const iq = ruleValue(rules, K.IQAMA_YEAR) ?? 0;
          push('SUNK_IQAMA', (months * iq) / 12, `${months} شهر × ${fmt(iq)} ÷ 12`, ruleOf(rules, K.IQAMA_YEAR).status, [citeRule('SUNK_IQAMA', K.IQAMA_YEAR)], 'SUNK', 'معلومة: رسوم مدفوعة مقدماً لا تُسترد');
        }
        const wp = ruleValue(rules, K.WORK_PERMIT_YEAR) ?? 0;
        push('SUNK_WORK_PERMIT', (months * wp) / 12, `${months} شهر × ${fmt(wp)} ÷ 12`, weakestStatus([ruleOf(rules, K.WORK_PERMIT_YEAR).status, 'PROVISIONAL']), [citeRule('SUNK_WORK_PERMIT', K.WORK_PERMIT_YEAR)], 'SUNK', 'مفترض أن رخصة العمل تنتهي مع الإقامة');
      }
    }
  }

  // --- Replacement (assumptions) ---
  const replSaudi = input.replacementIsSaudi ?? cls === 'SAUDI';
  const rec = (replSaudi ? a.recruitmentCostSaudi.value : a.recruitmentCostExpat.value) as number | null;
  const recKey = assumptionRuleKey(replSaudi ? 'RECRUITMENT_COST_SAUDI' : 'RECRUITMENT_COST_EXPAT');
  if (typeof rec === 'number') push('RECRUITMENT', rec, `${fmt(rec)} (${replSaudi ? 'سعودي' : 'وافد'})`, 'USER_INPUT', [recKey], 'REPLACEMENT');
  else {
    push('RECRUITMENT', 0, 'غير مدخل', 'MISSING', [recKey], 'REPLACEMENT');
    flags.push({ code: 'MISSING_ASSUMPTION', severity: 'INFO', message: 'كلفة توظيف البديل غير مدخلة', lineKey: 'RECRUITMENT', employeeId: e.id });
  }
  const vacancy = a.vacancyMonths.value as number | null;
  if (typeof vacancy === 'number' && vacancy > 0) {
    const ym = { year: lwd.getUTCFullYear(), month: lwd.getUTCMonth() + 1 };
    // The role's monthly cost in the month of the exit, with the legal company around it (levy tier).
    const role: WfEmployeeInput = { ...e, terminationDate: null, contractEndDate: null, joinDate: e.joinDate.getTime() > monthStartUtc(ym.year, ym.month).getTime() ? monthStartUtc(ym.year, ym.month) : e.joinDate };
    const single = computeTrueCost(
      {
        employees: [role, ...input.companyEmployees.filter((x) => x.id !== e.id)],
        companies: [input.company, settingsCompany].filter((c, i, arr): c is NonNullable<typeof c> => !!c && arr.findIndex((x) => x?.id === c.id) === i),
        rules: input.rules,
        gosiRates: input.gosiRates,
        assumptions: input.assumptions,
        payrollSettings: input.payrollSettings,
        annualLeaveDaysSetting: input.annualLeaveDaysSetting,
      },
      { startMonth: `${ym.year}-${String(ym.month).padStart(2, '0')}`, months: 1, scenario, salaryBasis: basis, employeeIds: [e.id] },
    );
    const monthly = single.employees[0]?.totals.month1.cost ?? 0;
    push('VACANCY', vacancy * monthly, `${fmt(vacancy)} شهر × ${fmt(monthly)}`, 'USER_INPUT', [assumptionRuleKey('VACANCY_MONTHS')], 'REPLACEMENT', 'قيمة تقديرية للإنتاجية المفقودة بكلفة الوظيفة الشهرية');
  } else if (vacancy === null) {
    push('VACANCY', 0, 'غير مدخل', 'MISSING', [assumptionRuleKey('VACANCY_MONTHS')], 'REPLACEMENT');
  }

  // --- Levy tier change in the legal company ---
  let levyImpact: ExitCostResult['levyImpact'] = null;
  if (companyId !== NO_COMPANY_ID && input.company) {
    const after = addMonthsYm(lwd.getUTCFullYear(), lwd.getUTCMonth() + 1, 1);
    const ms = monthStartUtc(after.year, after.month);
    const me = monthEndUtc(after.year, after.month);
    const monthRules = resolveRulesForMonth(index, after.year, after.month);
    const others: LevyMember[] = [];
    const seen = new Set<string>([e.id]);
    for (const x of [...input.companyEmployees].sort((p, q) => p.id.localeCompare(q.id))) {
      if (seen.has(x.id) || (x.legalCompanyId || NO_COMPANY_ID) !== companyId) continue;
      seen.add(x.id);
      const exit = earliestDate(x.terminationDate ?? null, x.contractEndDate ?? null);
      if (activeDays(ms, me, x.joinDate, exit) <= 0) continue;
      others.push({ id: x.id, cls: nationalityClass(x.nationality), joinDate: x.joinDate, fullTime: isFullTime(x.contractType, x.partTimeWeeklyHours) });
    }
    const leaver: LevyMember = { id: e.id, cls, joinDate: e.joinDate, fullTime: isFullTime(e.contractType, e.partTimeWeeklyHours) };
    const ctx = {
      isIndustrialLicensed: input.company.isIndustrialLicensed,
      industrialCancellation: ruleOf(monthRules, K.INDUSTRIAL_LEVY_CANCELLED),
      within: ruleOf(monthRules, K.LEVY_WITHIN),
      above: ruleOf(monthRules, K.LEVY_ABOVE),
      smallMax: ruleOf(monthRules, K.SMALL_EST_MAX),
      exemptOwnerOnly: ruleOf(monthRules, K.SMALL_EST_OWNER),
      exemptWithSaudi: ruleOf(monthRules, K.SMALL_EST_SAUDI),
      ownerFullTime: a.ownerFullTime.value as boolean | null,
    };
    const before = allocateLevy([...others, leaver], ctx);
    const afterAlloc = allocateLevy(others, ctx);
    const leaverLevy = before.byEmployee.get(e.id)?.amount ?? 0;
    const delta = roundMoney(afterAlloc.summary.monthlyLevy - (before.summary.monthlyLevy - leaverLevy));
    const monthKey = `${after.year}-${String(after.month).padStart(2, '0')}`;
    levyImpact = { month: monthKey, before: before.summary, after: afterAlloc.summary, deltaMonthly: delta };
    if ((before.exemption.count > 0 || afterAlloc.exemption.count > 0) && monthKey >= SMALL_EST_EXTENSION_UNCERTAIN_FROM && !ruleOf(monthRules, K.SMALL_EST_MAX).effectiveTo)
      flags.push({ code: 'SMALL_EST_EXTENSION_UNCERTAIN', severity: 'WARNING', message: `${SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE} (الإعفاء مفترض مستمراً في ${monthKey})`, lineKey: 'LEVY_TIER_CHANGE', employeeId: e.id });
    for (const k of [K.LEVY_WITHIN, K.LEVY_ABOVE]) {
      const r = ruleOf(monthRules, k);
      usage.rule(r);
      cite('LEVY_TIER_CHANGE', RuleUsage.id(r));
    }
    const b = before.summary;
    const f = afterAlloc.summary;
    const text = `السعوديون ${b.saudi} → ${f.saudi}؛ الوافدون ${b.expat} → ${f.expat}؛ بشريحة ${fmt(ruleValue(monthRules, K.LEVY_WITHIN) ?? 0)}: ${b.within} → ${f.within}؛ بشريحة ${fmt(ruleValue(monthRules, K.LEVY_ABOVE) ?? 0)}: ${b.above} → ${f.above}`;
    push(
      'LEVY_TIER_CHANGE',
      delta,
      text,
      weakestStatus([ruleOf(monthRules, K.LEVY_WITHIN).status, ruleOf(monthRules, K.LEVY_ABOVE).status]),
      [K.LEVY_WITHIN, K.LEVY_ABOVE],
      'ONGOING',
      delta > 0 && cls === 'SAUDI' ? 'خروج سعودي ينقل وافداً أو أكثر من الشريحة الأدنى إلى الأعلى (شهرياً)' : delta < 0 ? 'وفر شهري لبقية الوافدين' : 'لا تغيير في شرائح بقية الوافدين',
    );
  } else if (companyId === NO_COMPANY_ID) {
    flags.push({ code: 'MISSING_LEGAL_COMPANY', severity: 'WARNING', message: 'لا توجد شركة قانونية: لا يمكن حساب أثر الخروج على المقابل المالي', employeeId: e.id });
  }

  const sum = (kind: ExitLineKind) => roundMoney(lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amount, 0));
  const payable = sum('PAYABLE');
  const offsets = sum('OFFSET');
  const explanations: Partial<Record<ExitLineKey, LineExplanation>> = {};
  for (const l of lines) {
    if (explanations[l.key]) continue;
    explanations[l.key] = { label: EXIT_LINE_META[l.key].label, formulaText: EXIT_LINE_META[l.key].formula, rules: usage.evidenceFor(explainIds.get(l.key) ?? []) };
  }

  return {
    engineVersion: ENGINE_VERSION,
    employeeId: e.id,
    reason,
    reasonInput: input.reason,
    reasonNote: mapped.note || null,
    lastWorkingDate: lwd.toISOString().slice(0, 10),
    yearsOfService: years,
    wageUsed: wage,
    lines,
    totals: {
      payable,
      offsets,
      netToEmployee: roundMoney(payable + offsets),
      risk: sum('RISK'),
      sunkFees: sum('SUNK'),
      replacement: sum('REPLACEMENT'),
      ongoingMonthlyDelta: sum('ONGOING'),
    },
    settlement,
    settlementScreenTotal: settlement.totalSettlement,
    lastMonth: {
      workingDays: withLastMonth.workingDaysInMonth,
      salary: withLastMonth.workingDaysSalary,
      settlementTotalIfUnpaid: withLastMonth.totalSettlement,
      paidByPayroll: typeof input.lastMonthAlreadyPaid === 'boolean' ? input.lastMonthAlreadyPaid : null,
    },
    levyImpact,
    flags,
    explanations,
    rulesUsed: usage.refs(),
  };
}

function earliestDate(a: Date | null, b: Date | null): Date | null {
  if (a && b) return a.getTime() <= b.getTime() ? a : b;
  return a ?? b;
}
