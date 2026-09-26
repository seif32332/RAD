// Company cost settings («إعدادات الكلفة» in the company form): values set ONCE per company and used by
// payroll and by the decision engine (single source of truth). PURE, client-safe.
//
// - Company.overtimeHourlyBasis: 'BASIC' | 'TOTAL_PLUS_HALF_BASIC' (formula in src/lib/payroll-core.ts
//   overtimeHourlyRate; payroll and the engine use the same function).
// - Company.medicalPremiumsJson: {"VIP":n,"A+":n,"A":n,"B":n,"C":n,"DEPENDENT":n}, annual SAR per class
//   (MEDICAL_INSURANCE_CLASSES) and per dependent. A missing key = not entered.
// - Company.iqamaFeeYear: annual iqama fee in SAR; null = the rule register value IQAMA_FEE_YEAR.
//
// Company settings are single values (no low / base / high): the engine's scenarios only move the
// remaining WorkforceAssumption values. The employee's settings company is legalCompanyId ?? actualCompanyId
// (payroll-core payrollCompanyId), the same for payroll and the engine.
import { normalizeOvertimeBasis, OVERTIME_HOURLY_BASES, type OvertimeHourlyBasis } from '@/lib/payroll-core';
import { MEDICAL_INSURANCE_CLASSES, normalizeMedicalClass } from '@/lib/workforce/reasons';

export { OVERTIME_HOURLY_BASES, normalizeOvertimeBasis, type OvertimeHourlyBasis };

/** Keys of Company.medicalPremiumsJson: the insurance classes + DEPENDENT (per dependent). */
export const MEDICAL_PREMIUM_KEYS = [...MEDICAL_INSURANCE_CLASSES, 'DEPENDENT'] as const;
export type MedicalPremiumKey = (typeof MEDICAL_PREMIUM_KEYS)[number];
export type MedicalPremiums = Partial<Record<MedicalPremiumKey, number>>;

/** Highest accepted annual amount (medical premium or iqama fee), SAR. */
export const COMPANY_COST_MAX = 500_000;

export const MEDICAL_PREMIUM_LABELS: Record<MedicalPremiumKey, string> = {
  VIP: 'VIP',
  'A+': 'A+',
  A: 'A',
  B: 'B',
  C: 'C',
  DEPENDENT: 'لكل مرافق',
};

export const OVERTIME_BASIS_LABELS: Record<OvertimeHourlyBasis, string> = {
  BASIC: 'أجر الساعة من الأساسي × معامل العمل الإضافي (طريقة رديف الحالية)',
  TOTAL_PLUS_HALF_BASIC: 'أجر الساعة من الأجر الكلي + 50% من أجر ساعة الأساسي (القراءة الحرفية للمادة 107)',
};

/** Short labels (tables, «لماذا؟»). */
export const OVERTIME_BASIS_SHORT: Record<OvertimeHourlyBasis, string> = {
  BASIC: 'من الأساسي',
  TOTAL_PLUS_HALF_BASIC: 'الأجر الكلي + 50% من الأساسي',
};

/** Pseudo rule keys cited in CostLine.ruleKeys / ExitLine.ruleKeys for company settings. */
export const COMPANY_SETTING_KEYS = {
  OVERTIME_HOURLY_BASIS: 'COMPANY:OVERTIME_HOURLY_BASIS',
  MEDICAL_PREMIUMS: 'COMPANY:MEDICAL_PREMIUMS',
  IQAMA_FEE_YEAR: 'COMPANY:IQAMA_FEE_YEAR',
} as const;
export const COMPANY_SETTING_PREFIX = 'COMPANY:';

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Key as stored ('vip' -> 'VIP', 'dependent' -> 'DEPENDENT'); null when not a MEDICAL_PREMIUM_KEYS value. */
export function normalizePremiumKey(k: string): MedicalPremiumKey | null {
  const cls = normalizeMedicalClass(k);
  if (cls) return cls;
  return k.trim().toUpperCase() === 'DEPENDENT' ? 'DEPENDENT' : null;
}

/**
 * Company.medicalPremiumsJson -> {key: SAR/year}. Invalid JSON, unknown keys, negative / non-numeric
 * values are dropped (the API never stores them). null / '' -> {}.
 */
export function parseMedicalPremiums(raw: string | null | undefined): MedicalPremiums {
  if (!raw) return {};
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: MedicalPremiums = {};
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out;
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    const key = normalizePremiumKey(k);
    const n = num(v);
    if (key && n !== null && n >= 0 && n <= COMPANY_COST_MAX) out[key] = n;
  }
  return out;
}

/** Canonical JSON (MEDICAL_PREMIUM_KEYS order) or null when nothing is entered. */
export function serializeMedicalPremiums(p: MedicalPremiums): string | null {
  const out: Record<string, number> = {};
  for (const k of MEDICAL_PREMIUM_KEYS) if (typeof p[k] === 'number') out[k] = p[k] as number;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Validation result of the company form / API payload (Arabic messages). */
export type MedicalPremiumsCheck = { ok: true; value: MedicalPremiums } | { ok: false; message: string };

/**
 * Validates a premiums object from the form / API: keys exactly MEDICAL_PREMIUM_KEYS (VIP, A+, A, B, C,
 * DEPENDENT), values numbers >= 0 (Arabic / Latin digits as text accepted), '' / null = not entered.
 */
export function validateMedicalPremiums(raw: unknown): MedicalPremiumsCheck {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: {} };
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, message: 'أقساط التأمين الطبي: صيغة غير صالحة' };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, message: 'أقساط التأمين الطبي: يجب إدخال قسط لكل فئة' };
  const out: MedicalPremiums = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = normalizePremiumKey(k);
    if (!key) {
      unknown.push(k);
      continue;
    }
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) continue;
    const n = num(typeof v === 'string' ? toLatinDigits(v) : v);
    const label = key === 'DEPENDENT' ? 'لكل مرافق' : `الفئة ${key}`;
    if (n === null) return { ok: false, message: `أقساط التأمين الطبي (${label}): أدخل رقماً` };
    if (n < 0) return { ok: false, message: `أقساط التأمين الطبي (${label}): لا يقبل قيمة سالبة` };
    if (n > COMPANY_COST_MAX) return { ok: false, message: `أقساط التأمين الطبي (${label}): الحد الأعلى ${COMPANY_COST_MAX.toLocaleString('en-US')} ريال سنوياً` };
    out[key] = Math.round(n * 100) / 100;
  }
  if (unknown.length) return { ok: false, message: `أقساط التأمين الطبي: فئات غير مقبولة (${unknown.join('، ')})؛ الفئات المقبولة: ${MEDICAL_PREMIUM_KEYS.join('، ')}` };
  return { ok: true, value: out };
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
function toLatinDigits(s: string): string {
  return s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10)).replace(/[٬,]/g, '').replace('٫', '.');
}

/** The cost settings of one company as the engine reads them. */
export interface CompanyCostSettings {
  overtimeHourlyBasis: OvertimeHourlyBasis;
  medicalPremiums: MedicalPremiums;
  /** null = use the rule register (IQAMA_FEE_YEAR). */
  iqamaFeeYear: number | null;
}

/** Company row (Prisma columns) -> CompanyCostSettings. */
export function companyCostSettings(c: { overtimeHourlyBasis?: string | null; medicalPremiumsJson?: string | null; iqamaFeeYear?: number | null } | null | undefined): CompanyCostSettings {
  const fee = c?.iqamaFeeYear;
  return {
    overtimeHourlyBasis: normalizeOvertimeBasis(c?.overtimeHourlyBasis),
    medicalPremiums: parseMedicalPremiums(c?.medicalPremiumsJson ?? null),
    iqamaFeeYear: typeof fee === 'number' && Number.isFinite(fee) && fee >= 0 ? fee : null,
  };
}

/** Company settings page of a company (link target of «تعديل من إعدادات الشركة» and data-quality fixes). */
export function companySettingsHref(companyId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/edit#company-cost-settings`;
}
