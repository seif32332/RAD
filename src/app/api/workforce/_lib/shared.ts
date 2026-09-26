// Workforce decision engine UI/API shared helpers ("محرك القرارات"). PURE and client-safe: imported by
// the API routes (src/app/api/workforce/**) and by the pages (src/app/workforce/**). Not a route.
// Labels, status badges, the "لماذا؟" evidence picker and the CSV builder live here so that the server and
// the pages use the very same wording (unit-tested in src/lib/__tests__/wf-api-shared.test.ts).
import type { CostLineKey, FlagCode, LineExplanation, RuleEvidence, Scenario, WfStatus } from '@/lib/workforce/types';

// ---------------------------------------------------------------------------
// Horizons and scenarios
// ---------------------------------------------------------------------------

export const HORIZONS = [12, 24, 36] as const;
export type Horizon = (typeof HORIZONS)[number];
export const DEFAULT_HORIZON: Horizon = 36;

/** Months computed by the API: always the full 36 (the horizon only selects the window shown). */
export const COMPUTE_MONTHS = 36;

export const SCENARIOS = ['low', 'base', 'high'] as const satisfies ReadonlyArray<Scenario>;
export const SCENARIO_LABELS: Record<Scenario, string> = {
  low: 'منخفض',
  base: 'أساسي',
  high: 'مرتفع',
};

/** WindowTotals field of a horizon. */
export function windowField(h: Horizon): 'next12' | 'next24' | 'next36' {
  return h === 12 ? 'next12' : h === 24 ? 'next24' : 'next36';
}

export function isHorizon(v: unknown): v is Horizon {
  return (HORIZONS as ReadonlyArray<unknown>).includes(v);
}

// ---------------------------------------------------------------------------
// Evidence statuses ("لماذا هذا الرقم؟")
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<WfStatus, string> = {
  VERIFIED_PRIMARY: 'موثّق من المصدر الرسمي',
  CORROBORATED_SECONDARY: 'مؤكَّد ثانوياً',
  PROVISIONAL: 'مؤقت',
  CONFLICTING: 'متعارض',
  USER_INPUT: 'إدخال المنشأة',
  MISSING: 'غير مُدخل',
  DERIVED: 'محسوب',
};

/** Static Tailwind classes per status (badge). */
export const STATUS_STYLES: Record<WfStatus, string> = {
  VERIFIED_PRIMARY: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  CORROBORATED_SECONDARY: 'bg-teal-50 text-teal-800 border-teal-200',
  PROVISIONAL: 'bg-amber-50 text-amber-800 border-amber-300',
  CONFLICTING: 'bg-rose-50 text-rose-800 border-rose-200',
  USER_INPUT: 'bg-blue-50 text-blue-800 border-blue-200',
  MISSING: 'bg-slate-100 text-slate-700 border-slate-300',
  DERIVED: 'bg-indigo-50 text-indigo-800 border-indigo-200',
};

/** Statuses a new RuleParameter version may carry (MISSING / DERIVED are computed, never stored). */
export const RULE_INPUT_STATUSES = ['VERIFIED_PRIMARY', 'CORROBORATED_SECONDARY', 'PROVISIONAL', 'CONFLICTING', 'USER_INPUT'] as const;
export type RuleInputStatus = (typeof RULE_INPUT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Rules register
// ---------------------------------------------------------------------------

export const DOMAIN_LABELS: Record<string, string> = {
  GOSI: 'التأمينات الاجتماعية',
  LABOR_LAW: 'نظام العمل',
  EXPAT_FEES: 'رسوم الوافدين',
  HRDF: 'دعم هدف',
  NITAQAT: 'نطاقات',
};
export const DOMAIN_ORDER = ['GOSI', 'LABOR_LAW', 'EXPAT_FEES', 'HRDF', 'NITAQAT'] as const;

export function domainLabel(domain: string | null | undefined): string {
  return (domain && DOMAIN_LABELS[domain]) || domain || 'أخرى';
}

export const UNIT_LABELS: Record<string, string> = {
  SAR: 'ريال',
  SAR_MONTH: 'ريال شهرياً',
  SAR_YEAR: 'ريال سنوياً',
  PERCENT: '%',
  DAYS: 'يوم',
  DAYS_YEAR: 'يوم سنوياً',
  MONTHS: 'شهر',
  WEEKS: 'أسبوع',
  HOURS: 'ساعة',
  WORKERS: 'عامل',
  FLAG: '',
  COUNT_YEAR: 'مرة سنوياً',
};

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

/** "45,000 ريال شهرياً", "12.75%", "مفعّل" — Latin digits. */
export function formatRuleValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (unit === 'FLAG') return value ? 'مفعّل' : 'غير مفعّل';
  if (unit === 'PERCENT') return `${NUMBER_FORMAT.format(value)}%`;
  const u = unit ? (UNIT_LABELS[unit] ?? unit) : '';
  return u ? `${NUMBER_FORMAT.format(value)} ${u}` : NUMBER_FORMAT.format(value);
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export type FixTarget = 'EMPLOYEE' | 'ASSUMPTIONS' | 'COMPANY' | 'RULES' | 'NONE';

/** Where a data-quality flag is fixed (employee file, the assumptions page, the company settings «إعدادات الكلفة», the rules register). */
export const FLAG_FIX: Record<FlagCode, FixTarget> = {
  MISSING_GOSI_REGIME: 'EMPLOYEE',
  MISSING_LEGAL_COMPANY: 'EMPLOYEE',
  MISSING_MEDICAL_CLASS: 'EMPLOYEE',
  MISSING_NATIONALITY: 'EMPLOYEE',
  HOUSING_INFERRED_FROM_NAME: 'EMPLOYEE',
  HOUSING_TYPE_CONFLICT: 'EMPLOYEE',
  NATIONALITY_AMBIGUOUS: 'EMPLOYEE',
  DEPENDENTS_UNKNOWN: 'EMPLOYEE',
  CONTRACT_END_ASSUMED_EXIT: 'EMPLOYEE',
  MISSING_MEDICAL_PREMIUM: 'COMPANY',
  MISSING_ASSUMPTION: 'ASSUMPTIONS',
  SMALL_EST_EXEMPTION_ASSUMED: 'ASSUMPTIONS',
  SMALL_EST_EXTENSION_UNCERTAIN: 'RULES',
  PROVISIONAL_RULE: 'RULES',
  CONFLICTING_RULE: 'RULES',
  MISSING_RULE: 'RULES',
  GCC_PENSION_NOT_MODELLED: 'NONE',
  EXITS_DURING_HORIZON: 'NONE',
  HRDF_CONDITIONAL: 'NONE',
  HRDF_WINDOW_WAGE_UNKNOWN: 'EMPLOYEE',
  COUNSEL_PENDING: 'NONE',
};

export const FLAG_TITLES: Record<FlagCode, string> = {
  MISSING_GOSI_REGIME: 'نظام التأمينات غير محدد',
  MISSING_LEGAL_COMPANY: 'بلا شركة قانونية',
  MISSING_MEDICAL_CLASS: 'فئة التأمين الطبي غير محددة',
  MISSING_MEDICAL_PREMIUM: 'قسط التأمين الطبي غير مدخل',
  MISSING_ASSUMPTION: 'افتراض غير مدخل',
  HOUSING_INFERRED_FROM_NAME: 'بدل السكن عُرف من اسمه',
  HOUSING_TYPE_CONFLICT: 'نوع البدل يتعارض مع علامة التأمينات أو اسمه',
  NATIONALITY_AMBIGUOUS: 'الجنسية المسجلة غير واضحة',
  PROVISIONAL_RULE: 'قاعدة مؤقتة مستخدمة',
  CONFLICTING_RULE: 'قاعدة متعارضة المصادر',
  MISSING_RULE: 'قاعدة غير متوفرة',
  GCC_PENSION_NOT_MODELLED: 'معاش مواطني الخليج غير محسوب',
  MISSING_NATIONALITY: 'الجنسية غير محددة',
  CONTRACT_END_ASSUMED_EXIT: 'نهاية عقد محدد المدة داخل الفترة',
  EXITS_DURING_HORIZON: 'خروج خلال فترة التوقع',
  SMALL_EST_EXEMPTION_ASSUMED: 'إعفاء المنشأة الصغيرة مفترض',
  SMALL_EST_EXTENSION_UNCERTAIN: 'انتهاء تمديد إعفاء المنشآت الصغيرة غير مؤكد',
  HRDF_CONDITIONAL: 'دعم هدف مشروط',
  HRDF_WINDOW_WAGE_UNKNOWN: 'أجر فترة التقديم لدعم هدف غير معروف',
  COUNSEL_PENDING: 'بانتظار تأكيد المستشار',
  DEPENDENTS_UNKNOWN: 'عدد المرافقين غير معروف',
};

export const SEVERITY_LABELS: Record<'ERROR' | 'WARNING' | 'INFO', string> = { ERROR: 'خطأ', WARNING: 'تنبيه', INFO: 'معلومة' };

// ---------------------------------------------------------------------------
// People and fees
// ---------------------------------------------------------------------------

export const NATIONALITY_LABELS: Record<string, string> = { SAUDI: 'سعودي', GCC: 'خليجي', EXPAT: 'وافد' };

export const LEVY_TIER_LABELS: Record<string, string> = {
  EXEMPT: 'معفى (منشأة صغيرة)',
  WITHIN: '700 (ضمن عدد السعوديين)',
  ABOVE: '800 (زائد عن عدد السعوديين)',
  INDUSTRIAL_ZERO: 'معفى (صناعي مرخّص)',
};

// ---------------------------------------------------------------------------
// "لماذا؟" — the rules behind one line of one month
// ---------------------------------------------------------------------------

/**
 * Evidence of one cost line in one month: the explanation's rules whose key is in line.ruleKeys; when a
 * rule has several versions in the explanation, the version in force in that month (latest effectiveFrom
 * on or before the month's last day) is kept. 'ASSUMPTION:*' and 'COMPANY:*' (company settings «إعدادات الكلفة»)
 * keys come from `assumptionEvidence` (the API merges both).
 * Keys with no evidence are returned as a MISSING placeholder so nothing silently disappears.
 */
export function evidenceForLine(
  line: { ruleKeys: ReadonlyArray<string> },
  month: string,
  explanation: Pick<LineExplanation, 'rules'> | null | undefined,
  assumptionEvidence: Readonly<Record<string, RuleEvidence>> = {},
): RuleEvidence[] {
  const [y, m] = month.split('-').map(Number);
  const monthEnd = Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) : '9999-12-31';
  const out: RuleEvidence[] = [];
  const seen = new Set<string>();
  for (const key of line.ruleKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key.startsWith('ASSUMPTION:') || key.startsWith('COMPANY:')) {
      out.push(assumptionEvidence[key] ?? { key, label: key.slice(key.indexOf(':') + 1), value: null, unit: null, status: 'MISSING', sourceUrl: null, sourceQuote: null, effectiveFrom: null });
      continue;
    }
    const versions = (explanation?.rules ?? []).filter((r) => r.key === key);
    if (!versions.length) {
      out.push({ key, label: key, value: null, unit: null, status: 'MISSING', sourceUrl: null, sourceQuote: null, effectiveFrom: null });
      continue;
    }
    let pick: RuleEvidence | null = null;
    for (const v of versions) {
      if (v.effectiveFrom && v.effectiveFrom > monthEnd) continue;
      if (!pick || (v.effectiveFrom ?? '') > (pick.effectiveFrom ?? '')) pick = v;
    }
    // A version starting later in the month may be applied to the whole month (engine convention).
    out.push(pick ?? versions.reduce((a, b) => ((a.effectiveFrom ?? '') <= (b.effectiveFrom ?? '') ? a : b)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  // Neutralise spreadsheet formulas (=, +, -, @ at the start of a text cell).
  const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV text with a UTF-8 BOM (Excel opens Arabic correctly) and CRLF line ends. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Composition bar colours (static Tailwind classes)
// ---------------------------------------------------------------------------

export const LINE_COLORS: Record<CostLineKey, string> = {
  BASIC: 'bg-indigo-500',
  ALLOWANCES: 'bg-sky-500',
  ONE_OFF_BONUS: 'bg-cyan-500',
  OVERTIME: 'bg-violet-500',
  GOSI_EMPLOYER: 'bg-emerald-500',
  EOSB_ACCRUAL: 'bg-teal-600',
  LEAVE_ACCRUAL: 'bg-slate-400',
  EXPAT_LEVY: 'bg-orange-500',
  WORK_PERMIT: 'bg-amber-500',
  IQAMA: 'bg-yellow-500',
  DEPENDENTS_FEE: 'bg-lime-600',
  EXIT_REENTRY: 'bg-fuchsia-500',
  ANNUAL_TICKET: 'bg-pink-500',
  MEDICAL: 'bg-rose-500',
  MEDICAL_DEPENDENTS: 'bg-red-400',
  HRDF_SUBSIDY: 'bg-green-600',
};

/** Shown on every page (SPEC principle 6). */
export const QIWA_NOTE = 'المرجع الرسمي لنطاقات المنشأة والمقابل المالي منصة قوى (qiwa.sa).';
