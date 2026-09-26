// Employee data used by the workforce decision engine (محرك القرارات, docs/workforce-engine/SPEC.md §4):
// occupation, dependents, Nitaqat flags, Qiwa contract documentation, medical insurance class, structured
// exit reason, and the allowance type. Shared by POST /api/employees, PUT / PATCH /api/employees/[id]
// and the employee form. Not a route (no route.ts): Next does not serve this file.
//
// Pure and client-safe: zod + '@/lib/dates' only (no Prisma, no server imports).
import { z } from 'zod';
import { dateKey, parseDateOnly, todayKey } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Fixed lists and Arabic labels
// ---------------------------------------------------------------------------

/** Structured exit reasons (Employee.exitReason). */
export const EXIT_REASONS = [
  'RESIGNATION',
  'EMPLOYER_TERMINATION',
  'CONTRACT_END',
  'MUTUAL_AGREEMENT',
  'ARTICLE_80',
  'PROBATION',
  'RETIREMENT',
  'DEATH',
  'ABSCONDING',
  'OTHER',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  RESIGNATION: 'استقالة',
  EMPLOYER_TERMINATION: 'إنهاء من صاحب العمل',
  CONTRACT_END: 'انتهاء مدة العقد',
  MUTUAL_AGREEMENT: 'اتفاق الطرفين',
  ARTICLE_80: 'فصل وفق المادة 80',
  PROBATION: 'إنهاء خلال فترة التجربة',
  RETIREMENT: 'تقاعد',
  DEATH: 'وفاة',
  ABSCONDING: 'انقطاع عن العمل (تغيّب)',
  OTHER: 'سبب آخر',
};

/**
 * Default of Employee.exitVoluntary for a reason when the caller does not say: only the unambiguous
 * reasons get a value (the employee chose to leave / the employer or a fact ended the contract).
 * Contract end, mutual agreement, probation and "other" stay null: the user must say.
 */
export function defaultExitVoluntary(reason: ExitReason | null | undefined): boolean | null {
  switch (reason) {
    case 'RESIGNATION':
    case 'RETIREMENT':
    case 'ABSCONDING':
      return true;
    case 'EMPLOYER_TERMINATION':
    case 'ARTICLE_80':
    case 'DEATH':
      return false;
    default:
      return null;
  }
}

/** Who pays the dependents' fees (Employee.dependentsFeePaidBy). */
export const DEPENDENTS_FEE_PAYERS = ['COMPANY', 'EMPLOYEE'] as const;
export type DependentsFeePayer = (typeof DEPENDENTS_FEE_PAYERS)[number];
export const DEPENDENTS_FEE_PAYER_LABELS: Record<DependentsFeePayer, string> = { COMPANY: 'الشركة', EMPLOYEE: 'الموظف' };

/** Medical insurance classes (Employee.medicalInsuranceClass). Premiums per class are user inputs (SPEC §6.3). */
export const MEDICAL_INSURANCE_CLASSES = ['VIP', 'A+', 'A', 'B', 'C'] as const;
export type MedicalInsuranceClass = (typeof MEDICAL_INSURANCE_CLASSES)[number];

/** Allowance.allowanceType (null = inferred from the allowance name, as before). */
export const ALLOWANCE_TYPES = ['HOUSING', 'TRANSPORT', 'FOOD', 'OTHER'] as const;
export type AllowanceType = (typeof ALLOWANCE_TYPES)[number];
export const ALLOWANCE_TYPE_LABELS: Record<AllowanceType, string> = { HOUSING: 'سكن', TRANSPORT: 'نقل', FOOD: 'طعام', OTHER: 'أخرى' };
export const ALLOWANCE_TYPE_UNSET_LABEL = 'غير محدد';

/** Allowance type suggested by an allowance name ('' when the name says nothing clear). */
export function allowanceTypeFromName(name: string | null | undefined): AllowanceType | '' {
  const s = (name ?? '').trim();
  if (/سكن|housing/i.test(s)) return 'HOUSING';
  if (/نقل|مواصلات|transport/i.test(s)) return 'TRANSPORT';
  if (/طعام|إعاشة|اعاشة|وجبات|food|meal/i.test(s)) return 'FOOD';
  return '';
}

export const DEPENDENTS_MAX = 30;
export const PART_TIME_HOURS_MIN = 1;
export const PART_TIME_HOURS_MAX = 48;

// ---------------------------------------------------------------------------
// zod building blocks (partial-safe: undefined = not sent / leave unchanged, '' / null = clear)
// ---------------------------------------------------------------------------

const blankToNull = (v: unknown) => (v === '' || v === null ? null : v);
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const latinDigits = (s: string) => s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));

/** '' / null -> undefined (left unchanged): the stored flag is never null. */
const zOptBoolean = (label: string) =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v === '' || v === null ? undefined : v),
    z.boolean({ invalid_type_error: `${label}: قيمة غير صالحة (نعم / لا)` }).optional(),
  );

const zOptNullableBoolean = (label: string) =>
  z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : blankToNull(v)), z.boolean({ invalid_type_error: `${label}: قيمة غير صالحة (نعم / لا)` }).nullable())
    .optional();

const zOptNullableEnum = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.preprocess(blankToNull, z.enum(values, { errorMap: () => ({ message }) }).nullable()).optional();

const zOptNullableDate = (label: string) =>
  z
    .preprocess((v) => (v === '' || v === null ? null : (parseDateOnly(v) ?? v)), z.date({ invalid_type_error: `${label}: تاريخ غير صالح` }).nullable())
    .optional();

const zOptNullableText = (max: number, label: string) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') || null : blankToNull(v)),
      z.string({ invalid_type_error: `${label}: نص غير صالح` }).max(max, `${label}: الحد الأقصى ${max} حرفاً`).nullable(),
    )
    .optional();

const toNumberish = (v: unknown) => {
  if (v === '' || v === null) return null;
  if (typeof v === 'string') {
    const n = Number(latinDigits(v).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : v;
  }
  return v;
};

/** Saudi unified occupation classification code: digits (Arabic digits accepted), optional dots / dashes. */
export const zOccupationCode = z
  .preprocess(
    (v) => (typeof v === 'string' || typeof v === 'number' ? latinDigits(String(v)).replace(/\s+/g, '') || null : blankToNull(v)),
    z
      .string({ invalid_type_error: 'رمز المهنة غير صالح' })
      .regex(/^[0-9][0-9.-]{0,19}$/, 'رمز المهنة يجب أن يتكون من أرقام فقط (التصنيف السعودي الموحد للمهن)')
      .nullable(),
  )
  .optional();

export const zDependentsCount = z
  .preprocess(
    toNumberish,
    z
      .number({ invalid_type_error: 'عدد المرافقين يجب أن يكون رقماً' })
      .int('عدد المرافقين يجب أن يكون عدداً صحيحاً')
      .min(0, 'عدد المرافقين لا يمكن أن يكون سالباً')
      .max(DEPENDENTS_MAX, `عدد المرافقين لا يتجاوز ${DEPENDENTS_MAX}`)
      .nullable(),
  )
  .optional();

export const zPartTimeWeeklyHours = z
  .preprocess(
    toNumberish,
    z
      .number({ invalid_type_error: 'ساعات الدوام الجزئي يجب أن تكون رقماً' })
      .min(PART_TIME_HOURS_MIN, `ساعات الدوام الجزئي الأسبوعية بين ${PART_TIME_HOURS_MIN} و${PART_TIME_HOURS_MAX} ساعة`)
      .max(PART_TIME_HOURS_MAX, `ساعات الدوام الجزئي الأسبوعية بين ${PART_TIME_HOURS_MIN} و${PART_TIME_HOURS_MAX} ساعة`)
      .nullable(),
  )
  .optional();

export const zExitReason = zOptNullableEnum(EXIT_REASONS, 'سبب الخروج غير صالح: اختر من القائمة');
export const zExitVoluntary = zOptNullableBoolean('هل الخروج طوعي');
export const zAllowanceType = zOptNullableEnum(ALLOWANCE_TYPES, 'نوع البدل غير صالح: اختر سكن أو نقل أو طعام أو أخرى');

/** Workforce-engine fields accepted by POST /api/employees and PUT /api/employees/[id]. */
export const employeeWorkforceFieldsSchema = z.object({
  occupationCode: zOccupationCode,
  occupationName: zOptNullableText(200, 'المهنة'),
  dependentsCount: zDependentsCount,
  dependentsFeePaidBy: zOptNullableEnum(DEPENDENTS_FEE_PAYERS, 'من يدفع رسوم المرافقين: اختر الشركة أو الموظف'),
  isDisabled: zOptBoolean('ذو إعاقة'),
  muawamaCertExpiry: zOptNullableDate('تاريخ انتهاء شهادة مواءمة'),
  isStudent: zOptBoolean('طالب'),
  partTimeWeeklyHours: zPartTimeWeeklyHours,
  qiwaContractDocumented: zOptBoolean('العقد موثّق في قوى'),
  qiwaContractDocumentedAt: zOptNullableDate('تاريخ توثيق العقد في قوى'),
  medicalInsuranceClass: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.trim().toUpperCase() || null : blankToNull(v)),
      z.enum(MEDICAL_INSURANCE_CLASSES, { errorMap: () => ({ message: `فئة التأمين الطبي غير صالحة: اختر ${MEDICAL_INSURANCE_CLASSES.join(' أو ')}` }) }).nullable(),
    )
    .optional(),
});

/** Structured exit fields (PUT for a terminated employee, and PATCH action=terminate). */
export const employeeExitFieldsSchema = z.object({
  exitReason: zExitReason,
  exitVoluntary: zExitVoluntary,
});

export type WorkforceFieldsInput = z.infer<typeof employeeWorkforceFieldsSchema> & Partial<z.infer<typeof employeeExitFieldsSchema>>;

/** Stored values the cross-field rules depend on (null on create). */
export interface WorkforceFieldsCurrent {
  contractType: string;
  isTerminated: boolean;
  isDisabled: boolean;
  muawamaCertExpiry: Date | null;
  partTimeWeeklyHours: number | null;
  qiwaContractDocumented: boolean;
  qiwaContractDocumentedAt: Date | null;
  exitReason: string | null;
  exitVoluntary: boolean | null;
}

export interface WorkforceFieldsData {
  occupationCode?: string | null;
  occupationName?: string | null;
  dependentsCount?: number | null;
  dependentsFeePaidBy?: string | null;
  isDisabled?: boolean;
  muawamaCertExpiry?: Date | null;
  isStudent?: boolean;
  partTimeWeeklyHours?: number | null;
  qiwaContractDocumented?: boolean;
  qiwaContractDocumentedAt?: Date | null;
  medicalInsuranceClass?: string | null;
  exitReason?: string | null;
  exitVoluntary?: boolean | null;
}

/**
 * Cross-field rules of the workforce fields. Returns the values to write (only keys that change or
 * were sent; undefined keys are left untouched) and the Arabic errors that must reject the request.
 *
 * - partTimeWeeklyHours only for a PART_TIME contract; cleared when the contract stops being part-time.
 * - muawamaCertExpiry only for a disabled employee; cleared when isDisabled is switched off.
 * - qiwaContractDocumentedAt: set to `now` when qiwaContractDocumented flips to true without a date;
 *   kept while documented; cleared when it is switched off; never in the future.
 * - exitReason / exitVoluntary only for a terminated employee; exitVoluntary defaults from the reason.
 *
 * `contractType` is the contract type after this request; `current` is null on create.
 */
export function resolveWorkforceFields(
  input: WorkforceFieldsInput,
  current: WorkforceFieldsCurrent | null,
  contractType: string,
  now: Date = new Date(),
): { data: WorkforceFieldsData; errors: string[] } {
  const errors: string[] = [];
  const data: WorkforceFieldsData = {};
  const copy = <K extends keyof WorkforceFieldsData>(k: K, v: WorkforceFieldsData[K] | undefined) => {
    if (v !== undefined) data[k] = v;
  };
  copy('occupationCode', input.occupationCode);
  copy('occupationName', input.occupationName);
  copy('dependentsCount', input.dependentsCount);
  copy('dependentsFeePaidBy', input.dependentsFeePaidBy);
  copy('isStudent', input.isStudent);
  copy('medicalInsuranceClass', input.medicalInsuranceClass);

  // Part-time weekly hours.
  const partTime = contractType === 'PART_TIME';
  if (input.partTimeWeeklyHours !== undefined && input.partTimeWeeklyHours !== null && !partTime) {
    errors.push('ساعات الدوام الجزئي تُسجَّل فقط لعقد «دوام جزئي»');
  } else if (input.partTimeWeeklyHours !== undefined) {
    data.partTimeWeeklyHours = input.partTimeWeeklyHours;
  } else if (!partTime && current?.partTimeWeeklyHours != null) {
    data.partTimeWeeklyHours = null; // the contract is no longer part-time
  }

  // Disability + Muawama certificate.
  const disabled = input.isDisabled ?? current?.isDisabled ?? false;
  copy('isDisabled', input.isDisabled);
  if (input.muawamaCertExpiry !== undefined && input.muawamaCertExpiry !== null && !disabled) {
    errors.push('تاريخ انتهاء شهادة مواءمة يُسجَّل فقط للموظف ذي الإعاقة');
  } else if (input.muawamaCertExpiry !== undefined) {
    data.muawamaCertExpiry = input.muawamaCertExpiry;
  } else if (!disabled && current?.muawamaCertExpiry) {
    data.muawamaCertExpiry = null;
  }

  // Qiwa contract documentation.
  const wasDocumented = current?.qiwaContractDocumented ?? false;
  const documented = input.qiwaContractDocumented ?? wasDocumented;
  copy('qiwaContractDocumented', input.qiwaContractDocumented);
  const at = input.qiwaContractDocumentedAt;
  if (at && (dateKey(at) ?? '') > todayKey(now)) {
    errors.push('تاريخ توثيق العقد في قوى لا يمكن أن يكون في المستقبل');
  }
  if (documented) {
    if (at) data.qiwaContractDocumentedAt = at;
    else if (!wasDocumented || !current?.qiwaContractDocumentedAt) data.qiwaContractDocumentedAt = now;
    // documented before and no new date: the stored date is kept
  } else {
    if (at) errors.push('تاريخ توثيق العقد في قوى يتطلب تفعيل «العقد موثّق في قوى»');
    else if (current?.qiwaContractDocumentedAt || at === null) data.qiwaContractDocumentedAt = null;
  }

  // Structured exit.
  if (input.exitReason !== undefined || input.exitVoluntary !== undefined) {
    const reason = input.exitReason !== undefined ? input.exitReason : ((current?.exitReason as ExitReason | null) ?? null);
    if (reason !== null && !(current?.isTerminated ?? false)) {
      errors.push('سبب الخروج يُسجَّل فقط لموظف منتهية خدماته');
    } else if (reason === null && input.exitVoluntary !== undefined && input.exitVoluntary !== null) {
      errors.push('حدد سبب الخروج قبل تحديد هل الخروج طوعي');
    } else {
      copy('exitReason', input.exitReason);
      if (input.exitVoluntary !== undefined) data.exitVoluntary = input.exitVoluntary;
      else if (input.exitReason !== undefined && input.exitReason !== current?.exitReason) data.exitVoluntary = defaultExitVoluntary(reason);
    }
  }

  return { data, errors };
}

// ---------------------------------------------------------------------------
// Field-level visibility
// ---------------------------------------------------------------------------

/**
 * Health / disability data: same visibility as the identity data (PAYROLL_HIDDEN_FIELDS in
 * src/lib/employee.ts): HR only. Finance / payroll get the rest of the workforce fields (occupation,
 * dependents, medical insurance class... are cost inputs, like the salary). Team / basic levels use
 * EMPLOYEE_BASIC_SELECT, which has none of these fields.
 */
export const WORKFORCE_PAYROLL_HIDDEN_FIELDS = ['isDisabled', 'muawamaCertExpiry'] as const;

/** Copy of an employee row without WORKFORCE_PAYROLL_HIDDEN_FIELDS. */
export function redactWorkforceForPayroll<T extends object>(row: T): Omit<T, (typeof WORKFORCE_PAYROLL_HIDDEN_FIELDS)[number]> {
  const out = { ...row } as Record<string, unknown>;
  for (const f of WORKFORCE_PAYROLL_HIDDEN_FIELDS) delete out[f];
  return out as Omit<T, (typeof WORKFORCE_PAYROLL_HIDDEN_FIELDS)[number]>;
}
