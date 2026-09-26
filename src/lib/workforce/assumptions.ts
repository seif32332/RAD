// Company assumptions (values no authority publishes: recruitment cost, fee policies...). PURE.
//
// Stored in WorkforceAssumption (companyId '' = all companies; a company row overrides the global row).
// Defaults are "not entered" (null) unless a neutral default exists. A numeric assumption may carry
// sensitivity bounds in valueJson: {"low": n, "base": n, "high": n}; the engine runs one scenario.
//
// NOT assumptions any more (owner decision): the overtime hourly basis, the medical premiums per class /
// per dependent and the iqama fee are «إعدادات الكلفة» of the company (Company.overtimeHourlyBasis /
// medicalPremiumsJson / iqamaFeeYear, see company-settings.ts), set once and used by payroll and the
// engine. WorkforceAssumption rows left over for those keys (REMOVED_ASSUMPTION_KEYS) are ignored by the
// engine and refused by PUT /api/workforce/assumptions. Company settings are single values: the low /
// high scenarios only move the assumptions below.
import type { AssumptionRow, Scenario } from '@/lib/workforce/types';
import { normalizeMedicalClass } from '@/lib/workforce/reasons';

export type AssumptionKind = 'number' | 'boolean' | 'enum';

export interface AssumptionDef {
  key: string;
  kind: AssumptionKind;
  label: string;
  unit: string | null;
  /** Default when nothing is entered (null = "not entered"). */
  defaultValue: number | boolean | string | null;
  /** Allowed values for 'enum'. */
  options?: ReadonlyArray<string>;
  note?: string;
}

export const ASSUMPTION_DEFS = {
  DEPENDENTS_FEE_PAID_BY_DEFAULT: {
    key: 'DEPENDENTS_FEE_PAID_BY_DEFAULT',
    kind: 'enum',
    label: 'من يدفع رسوم المرافقين افتراضياً',
    unit: null,
    defaultValue: 'EMPLOYEE',
    options: ['COMPANY', 'EMPLOYEE'],
  },
  ANNUAL_TICKET_COST: { key: 'ANNUAL_TICKET_COST', kind: 'number', label: 'كلفة تذكرة السفر السنوية للوافد', unit: 'SAR_YEAR', defaultValue: null },
  EXIT_REENTRY_VISAS_PER_YEAR: { key: 'EXIT_REENTRY_VISAS_PER_YEAR', kind: 'number', label: 'عدد تأشيرات الخروج والعودة سنوياً لكل وافد', unit: 'COUNT_YEAR', defaultValue: 0 },
  RECRUITMENT_COST_SAUDI: { key: 'RECRUITMENT_COST_SAUDI', kind: 'number', label: 'كلفة توظيف سعودي (لمرة واحدة)', unit: 'SAR', defaultValue: null },
  RECRUITMENT_COST_EXPAT: { key: 'RECRUITMENT_COST_EXPAT', kind: 'number', label: 'كلفة استقدام وافد (لمرة واحدة)', unit: 'SAR', defaultValue: null },
  VACANCY_MONTHS: { key: 'VACANCY_MONTHS', kind: 'number', label: 'مدة شغور الوظيفة حتى التعيين (أشهر)', unit: 'MONTHS', defaultValue: null },
  ANNUAL_RAISE_PCT: {
    key: 'ANNUAL_RAISE_PCT',
    kind: 'number',
    label: 'نسبة الزيادة السنوية على الأساسي',
    unit: 'PERCENT',
    defaultValue: 0,
    note: 'تُطبَّق في يناير من كل سنة بعد الشهر الأول للتوقع، مركّبة، على الأساسي فقط',
  },
  COMPANY_IS_SME: { key: 'COMPANY_IS_SME', kind: 'boolean', label: 'المنشأة صغيرة أو متوسطة (دعم هدف)', unit: null, defaultValue: null },
  OWNER_FULL_TIME: {
    key: 'OWNER_FULL_TIME',
    kind: 'boolean',
    label: 'المالك متفرغ وغير مسجّل في التأمينات لدى غيره (إعفاء المنشأة الصغيرة)',
    unit: null,
    defaultValue: null,
  },
  INCLUDE_HRDF: { key: 'INCLUDE_HRDF', kind: 'boolean', label: 'احتساب دعم هدف (سطر سالب مشروط)', unit: null, defaultValue: true },
} as const satisfies Record<string, AssumptionDef>;

export type AssumptionKey = keyof typeof ASSUMPTION_DEFS;

/**
 * Former assumption keys now owned by the company settings («إعدادات الكلفة»): old rows are ignored and the
 * assumptions API refuses them with this Arabic message.
 */
export const REMOVED_ASSUMPTION_KEYS: Readonly<Record<string, string>> = {
  OVERTIME_HOURLY_BASIS: 'طريقة حساب أجر العمل الإضافي',
  MEDICAL_PREMIUM_BY_CLASS: 'أقساط التأمين الطبي لكل فئة',
  MEDICAL_PREMIUM_DEFAULT: 'قسط التأمين الطبي الافتراضي',
  DEPENDENT_MEDICAL_PREMIUM: 'قسط التأمين الطبي لكل مرافق',
};

export function removedAssumptionMessage(key: string): string {
  const what = REMOVED_ASSUMPTION_KEYS[key] ?? key;
  return `«${what}» لم يعد افتراضاً: يُضبط مرة واحدة في إعدادات الشركة (الشركات ← تعديل ← إعدادات الكلفة)`;
}

export interface ResolvedAssumption<T = unknown> {
  key: AssumptionKey;
  /** Value for the chosen scenario (null = not entered). */
  value: T | null;
  origin: 'COMPANY' | 'GLOBAL' | 'DEFAULT';
  /** True when a row exists (company or global). */
  entered: boolean;
  /** {low, base, high} when the row carries sensitivity bounds. */
  range: { low: number; base: number; high: number } | null;
  note: string | null;
}

function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isRange(v: unknown): v is { low?: unknown; base?: unknown; high?: unknown } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ('base' in (v as object) || 'low' in (v as object) || 'high' in (v as object));
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Picks the scenario value of a number or {low, base, high} (missing bound -> base). */
export function scenarioNumber(v: unknown, scenario: Scenario): number | null {
  if (isRange(v)) {
    const base = num(v.base);
    const pick = num(v[scenario]);
    return pick ?? base ?? num(v.low) ?? num(v.high);
  }
  return num(v);
}

function rangeOf(v: unknown): { low: number; base: number; high: number } | null {
  if (!isRange(v)) return null;
  const base = num(v.base) ?? num(v.low) ?? num(v.high);
  if (base === null) return null;
  return { low: num(v.low) ?? base, base, high: num(v.high) ?? base };
}

function parseBool(row: AssumptionRow): boolean | null {
  const j = parseJson(row.valueJson);
  if (typeof j === 'boolean') return j;
  if (typeof j === 'string') {
    const s = j.trim().toLowerCase();
    if (['true', 'yes', '1', 'نعم'].includes(s)) return true;
    if (['false', 'no', '0', 'لا'].includes(s)) return false;
  }
  if (typeof row.value === 'number') return row.value !== 0;
  return null;
}

function parseEnum(row: AssumptionRow, options: ReadonlyArray<string>): string | null {
  const j = parseJson(row.valueJson);
  const s = typeof j === 'string' ? j.trim().toUpperCase() : null;
  return s && options.includes(s) ? s : null;
}

/** Row for (key, company) with the company row overriding the global ('') row. */
function pickRow(rows: ReadonlyArray<AssumptionRow>, key: string, companyId: string | null | undefined): { row: AssumptionRow; origin: 'COMPANY' | 'GLOBAL' } | null {
  let global: AssumptionRow | null = null;
  for (const r of rows) {
    if (r.key !== key) continue;
    if (companyId && r.companyId === companyId) return { row: r, origin: 'COMPANY' };
    if (!r.companyId) global = r;
  }
  return global ? { row: global, origin: 'GLOBAL' } : null;
}

export function resolveAssumption<K extends AssumptionKey>(
  rows: ReadonlyArray<AssumptionRow>,
  key: K,
  companyId: string | null | undefined,
  scenario: Scenario = 'base',
): ResolvedAssumption {
  const def: AssumptionDef = ASSUMPTION_DEFS[key];
  const picked = pickRow(rows, key, companyId);
  const dflt: ResolvedAssumption = { key, value: def.defaultValue, origin: 'DEFAULT', entered: false, range: null, note: null };
  if (!picked) return dflt;
  const { row, origin } = picked;
  const note = row.note ?? null;
  switch (def.kind) {
    case 'number': {
      const j = parseJson(row.valueJson);
      const v = j !== undefined && isRange(j) ? scenarioNumber(j, scenario) : scenarioNumber(row.value, scenario) ?? scenarioNumber(j, scenario);
      if (v === null) return dflt;
      return { key, value: v, origin, entered: true, range: j !== undefined ? rangeOf(j) : null, note };
    }
    case 'boolean': {
      const v = parseBool(row);
      return v === null ? dflt : { key, value: v, origin, entered: true, range: null, note };
    }
    case 'enum': {
      const v = parseEnum(row, def.options ?? []);
      return v === null ? dflt : { key, value: v, origin, entered: true, range: null, note };
    }
  }
  return dflt;
}

/** Medical class key as stored ('vip' -> 'VIP', 'a +' -> 'A+'); unknown classes -> the trimmed upper-case text. */
export function normalizeClassKey(s: string): string {
  return normalizeMedicalClass(s) ?? s.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Typed bag of every assumption for one company (company rows override global rows). */
export interface CompanyAssumptions {
  companyId: string;
  dependentsFeePaidByDefault: ResolvedAssumption<'COMPANY' | 'EMPLOYEE'>;
  annualTicketCost: ResolvedAssumption<number>;
  exitReentryVisasPerYear: ResolvedAssumption<number>;
  recruitmentCostSaudi: ResolvedAssumption<number>;
  recruitmentCostExpat: ResolvedAssumption<number>;
  vacancyMonths: ResolvedAssumption<number>;
  annualRaisePct: ResolvedAssumption<number>;
  companyIsSme: ResolvedAssumption<boolean>;
  ownerFullTime: ResolvedAssumption<boolean>;
  includeHrdf: ResolvedAssumption<boolean>;
}

export function resolveCompanyAssumptions(rows: ReadonlyArray<AssumptionRow>, companyId: string | null | undefined, scenario: Scenario = 'base'): CompanyAssumptions {
  const r = <T>(k: AssumptionKey) => resolveAssumption(rows, k, companyId, scenario) as ResolvedAssumption<T>;
  return {
    companyId: companyId ?? '',
    dependentsFeePaidByDefault: r('DEPENDENTS_FEE_PAID_BY_DEFAULT'),
    annualTicketCost: r('ANNUAL_TICKET_COST'),
    exitReentryVisasPerYear: r('EXIT_REENTRY_VISAS_PER_YEAR'),
    recruitmentCostSaudi: r('RECRUITMENT_COST_SAUDI'),
    recruitmentCostExpat: r('RECRUITMENT_COST_EXPAT'),
    vacancyMonths: r('VACANCY_MONTHS'),
    annualRaisePct: r('ANNUAL_RAISE_PCT'),
    companyIsSme: r('COMPANY_IS_SME'),
    ownerFullTime: r('OWNER_FULL_TIME'),
    includeHrdf: r('INCLUDE_HRDF'),
  };
}

/** Pseudo rule key used in CostLine.ruleKeys for an assumption. */
export function assumptionRuleKey(key: AssumptionKey): string {
  return `ASSUMPTION:${key}`;
}
