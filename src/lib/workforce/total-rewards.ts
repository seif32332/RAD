// Total rewards statement («بيان المكافآت الشاملة», SPEC §1 module 9 and §9). PURE, deterministic, client-safe.
//
// ONE employee and ONE calendar year: what the employee was paid and what the company paid or set aside for
// them. Sources, in order of preference:
// - Paid amounts: the employee's APPROVED / PAID payroll rows of the year (basic, recurring allowances =
//   totalAllowances − bonusAmount, one-off bonuses = bonusAmount, overtime).
// - Employer GOSI: Payroll.gosiEmployer where stored (> 0); else computed by the engine
//   (gosiEmployerMonthly on basic + housing, capped) and labelled «محسوب بالمحرك».
// - Medical insurance: the premium of the employee's class in the company's «إعدادات الكلفة»
//   («حسب إعدادات الشركة») ÷ 12 × the months covered; never a default premium.
// - End of service: the engine's art. 84 liability (employer-termination basis) with the current wage
//   (basic + recurring allowances), «تقديري حسب المادة 84»: the accrual of the COVERED months only (the
//   months of the statement's payroll rows, like every other line) counts in the total; the balance accrued
//   since joining is shown for information.
// - Annual leave: entitlement days × day rate, for information only (the leave pay is part of the salary).
// The HRDF support is never part of this statement. No other employee's data is read.
import { roundMoney } from '@/lib/money';
import { dailyRate, monthlyWage } from '@/lib/payroll-core';
import { nationalityClass } from '@/lib/nationality';
import { annualEntitlementRates } from '@/lib/leave';
import { contributoryWage, eosbLiability, fmt, gosiEmployerMonthly, monthEndUtc, monthStartUtc } from '@/lib/workforce/formulas';
import { RULE_KEYS, resolveRules, ruleValue } from '@/lib/workforce/rules';
import { normalizeClassKey } from '@/lib/workforce/assumptions';
import type { CompanyCostSettings, MedicalPremiumKey } from '@/lib/workforce/company-settings';
import type { GosiRateRow, RuleRow, WfAllowanceInput } from '@/lib/workforce/types';

export const TOTAL_REWARDS_ASSUMPTION_KEY = 'TOTAL_REWARDS_ENABLED';
export const PAID_PAYROLL_STATUSES = ['APPROVED', 'PAID'] as const;

export type TotalRewardsLineKey =
  | 'BASIC'
  | 'ALLOWANCES'
  | 'BONUSES'
  | 'OVERTIME'
  | 'GOSI_EMPLOYER'
  | 'MEDICAL'
  | 'MEDICAL_DEPENDENTS'
  | 'EOSB_ACCRUAL'
  | 'EOSB_ACCRUED_TO_DATE'
  | 'ANNUAL_LEAVE_VALUE';

/**
 * CASH: paid to the employee. EMPLOYER: paid by the company for the employee. ACCRUAL: set aside (end of
 * service). MEMO: information, not in the total.
 */
export type TotalRewardsLineKind = 'CASH' | 'EMPLOYER' | 'ACCRUAL' | 'MEMO';

/** Where the number comes from (shown next to the line). */
export type TotalRewardsSource = 'PAYROLL' | 'ENGINE' | 'COMPANY_SETTING' | 'ESTIMATE_ART84' | 'MISSING';

export const TOTAL_REWARDS_SOURCE_LABELS: Record<TotalRewardsSource, string> = {
  PAYROLL: 'من مسيرات الرواتب',
  ENGINE: 'محسوب بالمحرك',
  COMPANY_SETTING: 'حسب إعدادات الشركة',
  ESTIMATE_ART84: 'تقديري حسب المادة 84',
  MISSING: 'غير متوفر',
};

export const ALLOWANCE_TYPE_LABELS: Record<string, string> = { HOUSING: 'بدل سكن', TRANSPORT: 'بدل نقل', FOOD: 'بدل طعام', OTHER: 'بدلات أخرى' };

export interface TotalRewardsLine {
  key: TotalRewardsLineKey;
  label: string;
  /** SAR for the covered months of the year (MEMO: the information value). */
  amount: number;
  kind: TotalRewardsLineKind;
  source: TotalRewardsSource;
  sourceLabel: string;
  /** Short Arabic explanation for the employee. */
  explanation: string;
  /** The calculation with the actual numbers. */
  basis: string;
  /** false = the value is not available (e.g. premium not entered): amount 0, not a real zero. */
  available: boolean;
  /** Sub-items (allowances by type, bonuses by name). */
  items?: Array<{ label: string; amount: number; note?: string }>;
}

export interface TotalRewardsPayrollRow {
  year: number;
  month: number;
  status: string;
  basicSalary: number;
  totalAllowances: number;
  overtimeCost: number;
  bonusAmount: number;
  gosiEmployer: number;
}

export interface TotalRewardsEmployee {
  id: string;
  name: string;
  employeeNo?: string | null;
  jobTitle?: string | null;
  nationality: string | null;
  joinDate: Date;
  /** Last day of employment (terminated employees only). */
  terminationDate?: Date | null;
  basicSalary: number;
  /** Current allowances (monthly) and one-off allowances (bonuses). */
  allowances: ReadonlyArray<WfAllowanceInput>;
  gosiRegime?: string | null;
  medicalInsuranceClass?: string | null;
  dependentsCount?: number | null;
}

export interface TotalRewardsInput {
  year: number;
  /** Today (Riyadh day). */
  asOf: Date;
  employee: TotalRewardsEmployee;
  payrolls: ReadonlyArray<TotalRewardsPayrollRow>;
  /** Company whose «إعدادات الكلفة» apply (legal company, else actual company). */
  company: { id: string; name: string; costSettings?: CompanyCostSettings | null } | null;
  rules: ReadonlyArray<RuleRow>;
  gosiRates: ReadonlyArray<GosiRateRow>;
  annualLeaveDaysSetting?: number | null;
}

export interface TotalRewardsStatement {
  year: number;
  employee: { id: string; name: string; employeeNo: string | null; jobTitle: string | null; joinDate: string; companyName: string | null };
  /** Months (1-12) of the year covered by an approved / paid payroll. */
  coveredMonths: number[];
  /** 'YYYY-MM-DD' last day covered (end of the last covered month, or the exit date); null = none. */
  through: string | null;
  /** false = no approved / paid payroll in the year (reason given). */
  available: boolean;
  reason: string | null;
  lines: TotalRewardsLine[];
  totals: {
    /** Paid to the employee (CASH). */
    cash: number;
    /** Paid by the company for the employee (EMPLOYER). */
    employerPaid: number;
    /** Set aside (ACCRUAL). */
    accrued: number;
    /** «كلفة المنشأة عليك» = cash + employerPaid + accrued. */
    total: number;
  };
  notes: string[];
}

const DAY_MS = 86400000;
const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function dayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Arabic count of months: شهر واحد، شهران (after a preposition or as an object: شهرين)، 3 أشهر، 11 شهراً. */
function monthsWord(n: number, oblique = false): string {
  if (n === 1) return 'شهر واحد';
  if (n === 2) return oblique ? 'شهرين' : 'شهران';
  return n <= 10 ? `${n} أشهر` : `${n} شهراً`;
}

function allowanceTypeKey(a: WfAllowanceInput): string {
  const t = (a.allowanceType ?? '').trim().toUpperCase();
  if (t && ALLOWANCE_TYPE_LABELS[t]) return t;
  if (a.countsTowardGosi === true || /سكن|housing/i.test(a.name ?? '')) return 'HOUSING';
  if (/نقل|مواصلات|transport/i.test(a.name ?? '')) return 'TRANSPORT';
  return 'OTHER';
}

/** Years the statement can be requested for: join year .. the year of asOf (or of the exit). */
export function totalRewardsYearRange(employee: Pick<TotalRewardsEmployee, 'joinDate' | 'terminationDate'>, asOf: Date): { first: number; last: number } {
  const last = Math.min(asOf.getUTCFullYear(), employee.terminationDate ? employee.terminationDate.getUTCFullYear() : Infinity);
  return { first: employee.joinDate.getUTCFullYear(), last: Math.max(employee.joinDate.getUTCFullYear(), last) };
}

export function computeTotalRewards(input: TotalRewardsInput): TotalRewardsStatement {
  const { year, employee: e } = input;
  const rows = input.payrolls
    .filter((r) => r.year === year && (PAID_PAYROLL_STATUSES as ReadonlyArray<string>).includes(r.status))
    .sort((a, b) => a.month - b.month);
  const coveredMonths = [...new Set(rows.map((r) => r.month))];
  const exit = e.terminationDate ? dayUtc(e.terminationDate) : null;
  const join = dayUtc(e.joinDate);
  const header = {
    id: e.id,
    name: e.name,
    employeeNo: e.employeeNo ?? null,
    jobTitle: e.jobTitle ?? null,
    joinDate: ymd(join),
    companyName: input.company?.name ?? null,
  };
  const notes: string[] = [];
  if (!rows.length) {
    return {
      year,
      employee: header,
      coveredMonths: [],
      through: null,
      available: false,
      reason: `لا توجد مسيرات رواتب معتمدة أو مصروفة لسنة ${year} بعد`,
      lines: [],
      totals: { cash: 0, employerPaid: 0, accrued: 0, total: 0 },
      notes,
    };
  }

  const lastMonth = coveredMonths[coveredMonths.length - 1];
  let through = monthEndUtc(year, lastMonth);
  if (exit && exit.getTime() < through.getTime()) through = exit;
  // Oblique form: the text follows a preposition («في») or is the object of «يغطي».
  const monthsText = coveredMonths.length === 12 ? 'السنة كاملة' : `${monthsWord(coveredMonths.length, true)} (${coveredMonths.map((m) => MONTH_NAMES[m - 1]).join('، ')})`;
  const lines: TotalRewardsLine[] = [];
  const push = (l: Omit<TotalRewardsLine, 'sourceLabel' | 'amount'> & { amount: number }) => lines.push({ ...l, amount: roundMoney(l.amount), sourceLabel: TOTAL_REWARDS_SOURCE_LABELS[l.source] });
  const sumRows = (f: (r: TotalRewardsPayrollRow) => number) => roundMoney(rows.reduce((s, r) => s + (f(r) || 0), 0));

  // --- Paid in cash (payroll) ---
  const basic = sumRows((r) => r.basicSalary);
  push({ key: 'BASIC', label: 'الراتب الأساسي', amount: basic, kind: 'CASH', source: 'PAYROLL', explanation: 'راتبك الأساسي كما صُرف في مسيرات الرواتب المعتمدة لهذه السنة.', basis: `مجموع الأساسي في المسيرات (${monthsWord(coveredMonths.length)}) = ${fmt(basic)}`, available: true });

  const recurring = sumRows((r) => r.totalAllowances - (r.bonusAmount || 0));
  const monthly = e.allowances.filter((a) => a.isMonthly && (a.amount ?? 0) > 0);
  const byType = new Map<string, number>();
  for (const a of monthly) byType.set(allowanceTypeKey(a), (byType.get(allowanceTypeKey(a)) ?? 0) + (a.amount ?? 0));
  push({
    key: 'ALLOWANCES',
    label: 'البدلات الشهرية',
    amount: recurring,
    kind: 'CASH',
    source: 'PAYROLL',
    explanation: 'البدلات المتكررة (السكن والنقل وغيرها) كما صُرفت في المسيرات. التفصيل أدناه هو بدلاتك الشهرية الحالية في ملفك.',
    basis: `مجموع البدلات في المسيرات − المكافآت لمرة واحدة = ${fmt(recurring)}`,
    available: true,
    items: [...byType.entries()]
      .sort((a, b) => Object.keys(ALLOWANCE_TYPE_LABELS).indexOf(a[0]) - Object.keys(ALLOWANCE_TYPE_LABELS).indexOf(b[0]))
      .map(([k, v]) => ({ label: ALLOWANCE_TYPE_LABELS[k] ?? k, amount: roundMoney(v), note: 'شهرياً حسب ملفك الحالي' })),
  });

  const bonuses = sumRows((r) => r.bonusAmount);
  const paidOneOff = e.allowances.filter((a) => !a.isMonthly && a.isPaid && a.payrollYear === year && (a.amount ?? 0) > 0);
  if (bonuses > 0 || paidOneOff.length) {
    push({
      key: 'BONUSES',
      label: 'المكافآت لمرة واحدة',
      amount: bonuses,
      kind: 'CASH',
      source: 'PAYROLL',
      explanation: 'المكافآت والبدلات غير المتكررة التي صُرفت لك في المسيرات.',
      basis: `مجموع المكافآت في المسيرات = ${fmt(bonuses)}`,
      available: true,
      items: paidOneOff.map((a) => ({ label: a.name || 'مكافأة', amount: roundMoney(a.amount ?? 0), note: a.payrollMonth ? `مسير ${MONTH_NAMES[a.payrollMonth - 1]}` : undefined })),
    });
  }

  const overtime = sumRows((r) => r.overtimeCost);
  if (overtime > 0) {
    push({ key: 'OVERTIME', label: 'العمل الإضافي', amount: overtime, kind: 'CASH', source: 'PAYROLL', explanation: 'مقابل ساعات العمل الإضافي المعتمدة التي صُرفت لك في المسيرات.', basis: `مجموع الإضافي في المسيرات = ${fmt(overtime)}`, available: true });
  }

  // --- Paid by the company for the employee ---
  const isSaudi = nationalityClass(e.nationality) === 'SAUDI';
  let gosiStored = 0;
  let gosiComputed = 0;
  const computedMonths: number[] = [];
  for (const r of rows) {
    if ((r.gosiEmployer ?? 0) > 0) {
      gosiStored += r.gosiEmployer;
      continue;
    }
    const rules = resolveRules(input.rules, monthStartUtc(year, r.month), [RULE_KEYS.GOSI_MAX_WAGE]);
    const cw = contributoryWage(e.basicSalary, e.allowances, ruleValue(rules, RULE_KEYS.GOSI_MAX_WAGE));
    const g = gosiEmployerMonthly({ isSaudi, regime: e.gosiRegime, wage: cw.capped, year, month: r.month, rates: input.gosiRates });
    gosiComputed += g.employer;
    computedMonths.push(r.month);
  }
  const gosi = roundMoney(gosiStored + gosiComputed);
  const gosiParts = [gosiStored > 0 ? `${fmt(gosiStored)} من المسيرات` : null, computedMonths.length ? `${fmt(gosiComputed)} محسوبة بالمحرك لأشهر لم تُخزَّن فيها الحصة (${monthsWord(computedMonths.length)})` : null].filter(Boolean);
  push({
    key: 'GOSI_EMPLOYER',
    label: 'حصة المنشأة في التأمينات الاجتماعية',
    amount: gosi,
    kind: 'EMPLOYER',
    source: computedMonths.length && gosiStored === 0 ? 'ENGINE' : 'PAYROLL',
    explanation: 'ما تدفعه المنشأة عنك للمؤسسة العامة للتأمينات الاجتماعية فوق راتبك، ولا يُخصم منك.',
    basis: gosiParts.join(' + ') || '0',
    available: true,
  });
  if (computedMonths.length && gosiStored > 0) notes.push('حصة التأمينات: جزء منها محسوب بالمحرك (أشهر لم تُخزَّن فيها الحصة في المسير).');

  const settings = input.company?.costSettings ?? null;
  const cls = e.medicalInsuranceClass ? normalizeClassKey(e.medicalInsuranceClass) : null;
  const premium = cls && settings ? settings.medicalPremiums[cls as MedicalPremiumKey] : undefined;
  const medMonths = coveredMonths.length;
  if (typeof premium === 'number') {
    const amt = (premium * medMonths) / 12;
    push({
      key: 'MEDICAL',
      label: 'التأمين الطبي',
      amount: amt,
      kind: 'EMPLOYER',
      source: 'COMPANY_SETTING',
      explanation: 'قسط تأمينك الطبي السنوي حسب فئتك في وثيقة الشركة، للأشهر المشمولة.',
      basis: `${fmt(premium)} سنوياً (فئة ${cls}) × ${medMonths} ÷ 12`,
      available: true,
    });
  } else {
    push({
      key: 'MEDICAL',
      label: 'التأمين الطبي',
      amount: 0,
      kind: 'EMPLOYER',
      source: 'MISSING',
      explanation: cls ? `قسط فئتك (${cls}) غير مدخل في إعدادات الشركة بعد، فلا يُعرض له مبلغ.` : 'فئة تأمينك الطبي غير محددة في ملفك، فلا يُعرض له مبلغ.',
      basis: 'غير متوفر',
      available: false,
    });
  }
  const deps = e.dependentsCount ?? 0;
  const depPremium = settings?.medicalPremiums.DEPENDENT;
  if (deps > 0 && typeof depPremium === 'number') {
    push({
      key: 'MEDICAL_DEPENDENTS',
      label: 'التأمين الطبي لأفراد أسرتك',
      amount: (depPremium * deps * medMonths) / 12,
      kind: 'EMPLOYER',
      source: 'COMPANY_SETTING',
      explanation: 'قسط التأمين الطبي للمرافقين المسجلين في ملفك.',
      basis: `${deps} × ${fmt(depPremium)} سنوياً × ${medMonths} ÷ 12`,
      available: true,
    });
  }

  // --- End of service (art. 84 estimate) ---
  // The accrual counts ONLY the covered months (the months of the statement's payroll rows), so every line
  // of the statement refers to the same months: Σ over covered months m of
  // liability(end of m, or the exit) − liability(the day before m starts).
  const wage = monthlyWage({ basicSalary: e.basicSalary, allowances: e.allowances }, 'total');
  const at = (d: Date) => (d.getTime() < join.getTime() ? 0 : eosbLiability(wage, join, d, 'EMPLOYER'));
  const atEnd = at(through);
  let accrualRaw = 0;
  const accrualParts: string[] = [];
  for (const m of coveredMonths) {
    const start = monthStartUtc(year, m);
    let end = monthEndUtc(year, m);
    if (exit && exit.getTime() < end.getTime()) end = exit;
    if (end.getTime() < start.getTime() || end.getTime() < join.getTime()) continue;
    const part = Math.max(0, at(end) - at(new Date(start.getTime() - DAY_MS)));
    accrualRaw += part;
    accrualParts.push(`${MONTH_NAMES[m - 1]} ${fmt(roundMoney(part))}`);
  }
  const accrual = roundMoney(accrualRaw);
  const contiguousFromJan = coveredMonths.every((m, i) => m === i + 1);
  push({
    key: 'EOSB_ACCRUAL',
    label: coveredMonths.length === 12 ? 'مكافأة نهاية الخدمة المتراكمة هذه السنة' : 'مكافأة نهاية الخدمة المتراكمة في الأشهر المشمولة',
    amount: accrual,
    kind: 'ACCRUAL',
    source: 'ESTIMATE_ART84',
    explanation: `ما تراكم لك من مكافأة نهاية الخدمة في ${monthsText} على أساس المادة 84 (إنهاء صاحب العمل) بأجرك الحالي، للأشهر نفسها التي يغطيها البيان. تقدير: المبلغ الفعلي يُحسب عند انتهاء الخدمة حسب سببها وأجرك الأخير.`,
    basis: contiguousFromJan
      ? `المستحق حتى ${ymd(through)} (${fmt(atEnd)}) − المستحق حتى ${ymd(new Date(Date.UTC(year - 1, 11, 31)))} (${fmt(at(new Date(Date.UTC(year - 1, 11, 31))))})، بأجر ${fmt(wage)} = ${fmt(accrual)}`
      : `مجموع الزيادة الشهرية في المستحق للأشهر المشمولة فقط (${accrualParts.join('، ')}) = ${fmt(accrual)}، بأجر ${fmt(wage)}`,
    available: true,
  });
  const serviceYears = Math.max(0, (through.getTime() - join.getTime()) / DAY_MS / 365);
  push({
    key: 'EOSB_ACCRUED_TO_DATE',
    label: 'رصيد مكافأة نهاية الخدمة منذ مباشرتك',
    amount: atEnd,
    kind: 'MEMO',
    source: 'ESTIMATE_ART84',
    explanation: `إجمالي ما تراكم لك منذ ${ymd(join)} حتى ${ymd(through)} (نحو ${Math.round(serviceYears * 10) / 10} سنة خدمة)، على أساس المادة 84: نصف أجر شهر عن كل سنة من السنوات الخمس الأولى، وأجر شهر عن كل سنة بعدها. للعلم، لا يدخل في الإجمالي.`,
    basis: `المادة 84 بأجر ${fmt(wage)} حتى ${ymd(through)} = ${fmt(atEnd)}`,
    available: true,
  });

  // --- Annual leave (information) ---
  const rates = annualEntitlementRates(input.annualLeaveDaysSetting);
  const five = new Date(Date.UTC(join.getUTCFullYear() + 5, join.getUTCMonth(), join.getUTCDate()));
  const days = through.getTime() >= five.getTime() ? rates.from5 : rates.under5;
  const dayRate = dailyRate({ basicSalary: e.basicSalary, allowances: e.allowances }, 'total');
  push({
    key: 'ANNUAL_LEAVE_VALUE',
    label: 'قيمة إجازتك السنوية مدفوعة الأجر',
    amount: days * dayRate,
    kind: 'MEMO',
    source: 'ENGINE',
    explanation: `${days} يوماً في السنة × أجر اليوم. أجر الإجازة جزء من راتبك، فتُعرض للعلم ولا تُضاف إلى الإجمالي.`,
    basis: `${days} × ${fmt(dayRate)} (الأجر ${fmt(wage)} ÷ 30)`,
    available: true,
  });

  const total = (k: TotalRewardsLineKind) => roundMoney(lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0));
  const cash = total('CASH');
  const employerPaid = total('EMPLOYER');
  const accrued = total('ACCRUAL');
  notes.unshift(`يغطي البيان ${monthsText} من سنة ${year} حسب مسيرات الرواتب المعتمدة.`);
  if (exit && exit.getUTCFullYear() === year) notes.push(`انتهت خدمتك في ${ymd(exit)}: المكافأة محسوبة حتى هذا التاريخ.`);
  return {
    year,
    employee: header,
    coveredMonths,
    through: ymd(through),
    available: true,
    reason: null,
    lines,
    totals: { cash, employerPaid, accrued, total: roundMoney(cash + employerPaid + accrued) },
    notes,
  };
}
