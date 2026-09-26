// Workforce decision engine fields of a company (nitaqatActivityKey — the NitaqatActivity of the register —,
// the old free-text nitaqatActivity kept read-only, isIndustrialLicensed) and its «إعدادات
// الكلفة» (overtimeHourlyBasis, medicalPremiumsJson, iqamaFeeYear: set once, used by payroll and the engine), shared by the
// company routes. Same pattern as ./_muqeem.ts: only SUPER_ADMIN / COMPANY_ADMIN may change them.
// Not a route (no route.ts): Next does not serve this file.
import { z } from 'zod';
import type { AuthUser } from '@/lib/auth';
import { badRequest, forbidden } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { OVERTIME_HOURLY_BASES, normalizeOvertimeBasis } from '@/lib/payroll-core';
import { COMPANY_COST_MAX, parseMedicalPremiums, serializeMedicalPremiums, validateMedicalPremiums } from '@/lib/workforce/company-settings';

/** Roles that may set the Nitaqat activity and the industrial licence (they drive levy / Nitaqat results). */
export const COMPANY_WORKFORCE_ROLES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN'];

/** Nitaqat activity line (free text for now, e.g. the activity name in the HRSD Nitaqat guide annex). '' / null -> null. */
export const zNitaqatActivity = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') || null : v === '' ? null : v),
    z.string({ invalid_type_error: 'نشاط المنشأة في نطاقات: نص غير صالح' }).max(300, 'نشاط المنشأة في نطاقات: الحد الأقصى 300 حرف').nullable(),
  )
  .optional();

/**
 * NitaqatActivity.key chosen in the company form (the curve used by «مخطط السعودة»). '' / null -> null
 * (cleared); undefined -> left unchanged (the edit page does not always send it).
 */
export const zNitaqatActivityKey = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.trim() || null : v),
    z.string({ invalid_type_error: 'نشاط نطاقات: قيمة غير صالحة' }).max(160, 'نشاط نطاقات: مفتاح غير صالح').nullable(),
  )
  .optional();

/** 400 when a non-null activity key is not in the Nitaqat register. */
export async function assertNitaqatActivityExists(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const row = await prisma.nitaqatActivity.findUnique({ where: { key }, select: { key: true } });
  if (!row) throw badRequest('نشاط نطاقات غير موجود في السجل: اختره من القائمة');
}

/** Licensed industrial establishment ('true' / 'false' accepted; '' / null -> left unchanged). */
export const zIsIndustrialLicensed = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v === '' || v === null ? undefined : v),
  z.boolean({ invalid_type_error: 'منشأة صناعية مرخّصة: قيمة غير صالحة (نعم / لا)' }).optional(),
);

export interface CompanyWorkforceValues {
  nitaqatActivity: string | null;
  nitaqatActivityKey?: string | null;
  isIndustrialLicensed: boolean;
}

/**
 * Throws 403 when a user outside COMPANY_WORKFORCE_ROLES changes one of the fields. Sending the stored
 * value again is not a change (the edit form always sends them). `current` is null on create, where
 * the defaults (null / false) are the "unchanged" values.
 */
export function assertCompanyWorkforceChange(
  user: Pick<AuthUser, 'role'>,
  next: { nitaqatActivity?: string | null; nitaqatActivityKey?: string | null; isIndustrialLicensed?: boolean },
  current: CompanyWorkforceValues | null,
): void {
  if (COMPANY_WORKFORCE_ROLES.includes(user.role)) return;
  const base: CompanyWorkforceValues = current ?? { nitaqatActivity: null, nitaqatActivityKey: null, isIndustrialLicensed: false };
  const activityChanged = next.nitaqatActivity !== undefined && (next.nitaqatActivity ?? null) !== (base.nitaqatActivity ?? null);
  const keyChanged = next.nitaqatActivityKey !== undefined && (next.nitaqatActivityKey ?? null) !== (base.nitaqatActivityKey ?? null);
  const licenceChanged = next.isIndustrialLicensed !== undefined && next.isIndustrialLicensed !== base.isIndustrialLicensed;
  if (activityChanged || keyChanged || licenceChanged) {
    throw forbidden('تعديل نشاط المنشأة في نطاقات والترخيص الصناعي متاح لمدير النظام وصاحب العمل فقط');
  }
}

// ---------------------------------------------------------------------------
// «إعدادات الكلفة»: overtime basis, medical premiums per class, iqama fee (same restriction)
// ---------------------------------------------------------------------------

const toLatinDigits = (s: string) => s.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10)).replace(/[٬,]/g, '').replace('٫', '.');

/** «طريقة حساب أجر العمل الإضافي»: BASIC | TOTAL_PLUS_HALF_BASIC ('' / null -> left unchanged). */
export const zOvertimeHourlyBasis = z.preprocess(
  (v) => (v === '' || v === null ? undefined : typeof v === 'string' ? v.trim().toUpperCase() : v),
  z
    .enum(OVERTIME_HOURLY_BASES, { errorMap: () => ({ message: 'طريقة حساب أجر العمل الإضافي: اختر «من الأساسي» أو «الأجر الكلي + 50% من الأساسي»' }) })
    .optional(),
);

/** «رسوم الإقامة السنوية» (SAR, >= 0); '' / null -> null = use the rule register value (IQAMA_FEE_YEAR). */
export const zIqamaFeeYear = z
  .preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v === 'string') {
        const s = toLatinDigits(v.trim());
        return s === '' ? null : Number(s);
      }
      return v;
    },
    z
      .number({ invalid_type_error: 'رسوم الإقامة السنوية: أدخل رقماً' })
      .finite('رسوم الإقامة السنوية: أدخل رقماً')
      .min(0, 'رسوم الإقامة السنوية: لا تقبل قيمة سالبة')
      .max(COMPANY_COST_MAX, `رسوم الإقامة السنوية: الحد الأعلى ${COMPANY_COST_MAX.toLocaleString('en-US')} ريال`)
      .nullable(),
  )
  .optional();

/**
 * «أقساط التأمين الطبي السنوية»: {"VIP": n, "A+": n, "A": n, "B": n, "C": n, "DEPENDENT": n} (object or JSON
 * text; blank values = not entered). Output: canonical JSON text, null when nothing is entered.
 */
export const zMedicalPremiums = z
  .unknown()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const r = validateMedicalPremiums(v);
    if (!r.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.message });
      return z.NEVER;
    }
    return serializeMedicalPremiums(r.value);
  })
  .optional();

export interface CompanyCostValues {
  overtimeHourlyBasis: string;
  medicalPremiumsJson: string | null;
  iqamaFeeYear: number | null;
}

/** Stored JSON compared by value (key order / formatting ignored). */
function samePremiums(a: string | null | undefined, b: string | null | undefined): boolean {
  return serializeMedicalPremiums(parseMedicalPremiums(a ?? null)) === serializeMedicalPremiums(parseMedicalPremiums(b ?? null));
}

/** Fields of `next` that change the stored cost settings (create: compared with the defaults). */
export function companyCostChanges(
  next: { overtimeHourlyBasis?: string; medicalPremiumsJson?: string | null; iqamaFeeYear?: number | null },
  current: CompanyCostValues | null,
): Array<keyof CompanyCostValues> {
  const base: CompanyCostValues = current ?? { overtimeHourlyBasis: 'BASIC', medicalPremiumsJson: null, iqamaFeeYear: null };
  const out: Array<keyof CompanyCostValues> = [];
  if (next.overtimeHourlyBasis !== undefined && normalizeOvertimeBasis(next.overtimeHourlyBasis) !== normalizeOvertimeBasis(base.overtimeHourlyBasis)) out.push('overtimeHourlyBasis');
  if (next.medicalPremiumsJson !== undefined && !samePremiums(next.medicalPremiumsJson, base.medicalPremiumsJson)) out.push('medicalPremiumsJson');
  if (next.iqamaFeeYear !== undefined && (next.iqamaFeeYear ?? null) !== (base.iqamaFeeYear ?? null)) out.push('iqamaFeeYear');
  return out;
}

/**
 * Throws 403 when a user outside COMPANY_WORKFORCE_ROLES changes a cost setting (they drive payroll overtime
 * and the decision engine). Re-sending the stored values is not a change (the edit form always sends them).
 * Returns the changed fields (for the audit).
 */
export function assertCompanyCostChange(
  user: Pick<AuthUser, 'role'>,
  next: { overtimeHourlyBasis?: string; medicalPremiumsJson?: string | null; iqamaFeeYear?: number | null },
  current: CompanyCostValues | null,
): Array<keyof CompanyCostValues> {
  const changed = companyCostChanges(next, current);
  if (changed.length && !COMPANY_WORKFORCE_ROLES.includes(user.role)) {
    throw forbidden('تعديل إعدادات الكلفة (العمل الإضافي، أقساط التأمين الطبي، رسوم الإقامة) متاح لمدير النظام وصاحب العمل فقط');
  }
  return changed;
}
