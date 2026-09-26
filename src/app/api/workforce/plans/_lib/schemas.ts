// Request schemas of «خطة القوى العاملة» (zod, Arabic messages). PURE. Months are 'YYYY-MM' and are stored
// as the first day of the month (UTC).
import { z } from 'zod';
import { zId } from '@/lib/validation';
import { MEDICAL_INSURANCE_CLASSES } from '@/lib/workforce/reasons';
import { PLAN_EXIT_REASONS, PLAN_MONTHS, PLAN_NATIONALITY_CLASSES, PLAN_STATUSES, POSITION_KINDS, RAISE_SCOPES } from '@/lib/workforce/planning';

const blank = (v: unknown) => (v === '' || v === null ? undefined : v);
/** '' / null -> null (explicitly cleared), undefined -> undefined (not sent). */
const blankToNull = (v: unknown) => (v === '' ? null : v);

export const zPlanMonth = z
  .string({ required_error: 'الشهر مطلوب', invalid_type_error: 'الشهر يجب أن يكون بصيغة YYYY-MM' })
  .trim()
  .regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/, 'الشهر يجب أن يكون بصيغة YYYY-MM');

const zOptId = z.preprocess(blankToNull, zId.nullable().optional());
const zText = (max: number, msg: string) => z.preprocess(blankToNull, z.string().trim().max(max, msg).nullable().optional());

const zNumber = (min: number, max: number, msg: string) =>
  z.preprocess(
    (v) => (v === '' || v === null ? null : typeof v === 'string' ? Number(v) : v),
    z.number({ invalid_type_error: msg }).finite(msg).min(min, msg).max(max, msg).nullable().optional(),
  );

const zPlanMonths = z.preprocess(
  (v) => (typeof v === 'string' && v !== '' ? Number(v) : v),
  z
    .number({ required_error: 'مدة الخطة مطلوبة', invalid_type_error: 'مدة الخطة 12 أو 24 أو 36 شهراً' })
    .refine((n) => (PLAN_MONTHS as ReadonlyArray<number>).includes(n), 'مدة الخطة 12 أو 24 أو 36 شهراً'),
);

export const planCreateSchema = z
  .object({
    name: z.string({ required_error: 'اسم الخطة مطلوب' }).trim().min(2, 'اسم الخطة قصير').max(120, 'اسم الخطة طويل'),
    companyId: zOptId,
    fromMonth: zPlanMonth,
    months: zPlanMonths,
    attritionPct: zNumber(0, 100, 'نسبة الدوران بين 0 و100'),
    notes: zText(5000, 'الملاحظات طويلة'),
  })
  .strict();

export const planUpdateSchema = z
  .object({
    name: z.string().trim().min(2, 'اسم الخطة قصير').max(120, 'اسم الخطة طويل').optional(),
    companyId: zOptId,
    fromMonth: zPlanMonth.optional(),
    months: zPlanMonths.optional(),
    /** null = the organisation's actual turnover. */
    attritionPct: zNumber(0, 100, 'نسبة الدوران بين 0 و100'),
    notes: zText(5000, 'الملاحظات طويلة'),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'لا توجد تغييرات للحفظ');

export const planListSchema = z.object({
  status: z.preprocess(blank, z.enum(PLAN_STATUSES, { errorMap: () => ({ message: 'حالة الخطة غير صالحة' }) }).optional()),
  companyId: z.preprocess(blank, zId.optional()),
  summary: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
  take: z.preprocess((v) => (v === undefined || v === '' ? 50 : Number(v)), z.number().int().min(1, 'عدد النتائج غير صالح').max(200, 'الحد الأعلى 200')),
  skip: z.preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0, 'بداية الصفحة غير صالحة')),
});

const positionFields = {
  kind: z.enum(POSITION_KINDS, { errorMap: () => ({ message: 'نوع البند غير صالح' }) }),
  title: z.string({ required_error: 'المسمى مطلوب' }).trim().min(2, 'المسمى قصير').max(120, 'المسمى طويل'),
  companyId: zOptId,
  branchId: zOptId,
  departmentId: zOptId,
  nationalityClass: z.preprocess(blankToNull, z.enum(PLAN_NATIONALITY_CLASSES, { errorMap: () => ({ message: 'الجنسية سعودي أو وافد أو خليجي' }) }).nullable().optional()),
  gosiRegime: z.preprocess(blankToNull, z.enum(['NEW', 'OLD'], { errorMap: () => ({ message: 'نظام التأمينات NEW أو OLD' }) }).nullable().optional()),
  gender: z.preprocess(blankToNull, z.enum(['MALE', 'FEMALE'], { errorMap: () => ({ message: 'الجنس غير صالح' }) }).nullable().optional()),
  occupationName: zText(120, 'المهنة طويلة'),
  basicSalary: zNumber(0, 1_000_000, 'الراتب الأساسي بين 0 و1,000,000'),
  housingAllowance: zNumber(0, 1_000_000, 'بدل السكن بين 0 و1,000,000'),
  otherAllowances: zNumber(0, 1_000_000, 'البدلات بين 0 و1,000,000'),
  dependentsCount: zNumber(0, 20, 'عدد المرافقين بين 0 و20'),
  medicalClass: z.preprocess(blankToNull, z.enum(MEDICAL_INSURANCE_CLASSES, { errorMap: () => ({ message: 'فئة التأمين الطبي غير صالحة' }) }).nullable().optional()),
  startMonth: z.preprocess(blankToNull, zPlanMonth.nullable().optional()),
  exitEmployeeId: zOptId,
  exitMonth: z.preprocess(blankToNull, zPlanMonth.nullable().optional()),
  exitReason: z.preprocess(blankToNull, z.enum(PLAN_EXIT_REASONS as [string, ...string[]], { errorMap: () => ({ message: 'سبب الخروج غير صالح (اتفاق الطرفين وسبب آخر يحتاجان أساس تسوية: اختر السبب الأقرب)' }) }).nullable().optional()),
  notes: zText(2000, 'الملاحظات طويلة'),
};

type PositionBody = { [K in keyof typeof positionFields]?: z.infer<(typeof positionFields)[K]> };

/** Kind-specific required fields (shared by create and by the merged row of an update). */
export function positionIssues(b: PositionBody): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  if (b.kind === 'EXIT') {
    if (!b.exitEmployeeId) out.push({ path: 'exitEmployeeId', message: 'اختر الموظف المغادر' });
    if (!b.exitMonth) out.push({ path: 'exitMonth', message: 'شهر الخروج مطلوب' });
    if (!b.exitReason) out.push({ path: 'exitReason', message: 'سبب الخروج مطلوب' });
  } else {
    if (!b.nationalityClass) out.push({ path: 'nationalityClass', message: 'الجنسية مطلوبة' });
    if (!(typeof b.basicSalary === 'number' && b.basicSalary > 0)) out.push({ path: 'basicSalary', message: 'الراتب الأساسي مطلوب وأكبر من صفر' });
    if (b.kind === 'NEW_HIRE' && !b.startMonth) out.push({ path: 'startMonth', message: 'شهر البداية مطلوب' });
    if (b.kind === 'BACKFILL' && !b.exitEmployeeId) out.push({ path: 'exitEmployeeId', message: 'اختر الموظف الذي يُستبدل' });
  }
  return out;
}

export const positionCreateSchema = z
  .object(positionFields)
  .strict()
  .superRefine((b, ctx) => {
    for (const i of positionIssues(b)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i.path], message: i.message });
  });

export const positionUpdateSchema = z
  .object(Object.fromEntries(Object.entries(positionFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof positionFields]: z.ZodOptional<(typeof positionFields)[K]> })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'لا توجد تغييرات للحفظ');

const raiseFields = {
  scope: z.enum(RAISE_SCOPES, { errorMap: () => ({ message: 'نطاق الزيادة غير صالح' }) }),
  scopeId: zOptId,
  pct: zNumber(-50, 100, 'نسبة الزيادة بين −50 و100'),
  amount: zNumber(-100_000, 100_000, 'مبلغ الزيادة بين −100,000 و100,000'),
  effectiveMonth: zPlanMonth,
  notes: zText(2000, 'الملاحظات طويلة'),
};

type RaiseBody = { [K in keyof typeof raiseFields]?: z.infer<(typeof raiseFields)[K]> };

export function raiseIssues(b: RaiseBody): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const hasPct = typeof b.pct === 'number';
  const hasAmount = typeof b.amount === 'number';
  if (hasPct === hasAmount) out.push({ path: 'pct', message: 'أدخل نسبة أو مبلغاً (أحدهما فقط)' });
  if ((hasPct && b.pct === 0) || (hasAmount && b.amount === 0)) out.push({ path: hasPct ? 'pct' : 'amount', message: 'الزيادة لا تكون صفراً' });
  if (b.scope && b.scope !== 'ALL' && !b.scopeId) out.push({ path: 'scopeId', message: 'اختر الشركة أو الإدارة أو الموظف' });
  return out;
}

export const raiseCreateSchema = z
  .object(raiseFields)
  .strict()
  .superRefine((b, ctx) => {
    for (const i of raiseIssues(b)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i.path], message: i.message });
  });

export const raiseUpdateSchema = z
  .object(Object.fromEntries(Object.entries(raiseFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof raiseFields]: z.ZodOptional<(typeof raiseFields)[K]> })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'لا توجد تغييرات للحفظ');

export const transitionSchema = z
  .object({
    note: z.preprocess(blank, z.string().trim().max(2000, 'الملاحظة طويلة').optional()),
  })
  .strict();

export const copySchema = z
  .object({
    name: z.preprocess(blank, z.string().trim().min(2, 'اسم الخطة قصير').max(120, 'اسم الخطة طويل').optional()),
  })
  .strict();

export const detailQuerySchema = z.object({
  live: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
});

/** A real calendar day 'YYYY-MM-DD' (2026-02-31 is refused, never rolled over to March). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export const actualQuerySchema = z.object({
  asOf: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'التاريخ بصيغة YYYY-MM-DD')
      .refine(isCalendarDate, 'التاريخ غير موجود في التقويم (مثل 31 فبراير)')
      .optional(),
  ),
  live: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
});

export const compareQuerySchema = z.object({
  ids: z
    .string({ required_error: 'اختر خطتين أو ثلاثاً للمقارنة' })
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .refine((a) => a.length >= 2 && a.length <= 3, 'اختر خطتين أو ثلاثاً للمقارنة')
    .refine((a) => a.every((x) => x.length <= 100), 'معرّف غير صالح'),
});

export const planSnapshotParamsSchema = z.object({ planId: zId }).strict();

export type PlanCreate = z.infer<typeof planCreateSchema>;
export type PlanUpdate = z.infer<typeof planUpdateSchema>;
export type PositionCreate = z.infer<typeof positionCreateSchema>;
export type PositionUpdate = z.infer<typeof positionUpdateSchema>;
export type RaiseCreate = z.infer<typeof raiseCreateSchema>;
export type RaiseUpdate = z.infer<typeof raiseUpdateSchema>;
