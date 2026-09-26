// Request schemas of the phase-2 workforce API (Saudization planner, hire scenarios, Nitaqat register,
// localization decisions). PURE (zod, Arabic messages); shared by the routes and the saved-calculation
// recompute (POST /api/workforce/calculations re-validates stored params with them).
import { z } from 'zod';
import { zDate, zId } from '@/lib/validation';
import { CANDIDATE_KINDS } from '@/lib/workforce/hiring';
import { CURVE_BANDS, NITAQAT_BANDS, NITAQAT_ROW_STATUSES } from '@/lib/workforce/nitaqat';
import { HORIZONS, type Horizon } from './shared';

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const toNumber = (v: unknown) => (v === '' || v === null || v === undefined ? undefined : typeof v === 'string' ? Number(v.replace(/[٬,]/g, '')) : v);
const optBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v === '' || v === null ? undefined : v), z.boolean({ invalid_type_error: 'قيمة نعم/لا غير صالحة' }).optional());

const zYearDate = (label: string) =>
  z.preprocess(blankToUndefined, zDate.optional()).superRefine((d, ctx) => {
    if (!d) return;
    const y = d.getUTCFullYear();
    if (!(y >= 2020 && y <= 2040)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} خارج المدى (2020–2040)` });
  });

const zMoneyOpt = (label: string, max = 1_000_000) =>
  z.preprocess(toNumber, z.number({ invalid_type_error: `${label}: أدخل رقماً` }).finite(`${label}: أدخل رقماً`).min(0, `${label}: لا يقبل قيمة سالبة`).max(max, `${label}: أكبر من المسموح`).optional());

export const saudizationQuerySchema = z.object({
  companyId: z.preprocess(blankToUndefined, zId.optional()),
  date: zYearDate('التاريخ'),
  summary: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
});
export type SaudizationQuery = z.infer<typeof saudizationQuerySchema>;

export const solveSchema = z
  .object({
    companyId: zId,
    targetBand: z.enum(NITAQAT_BANDS, { errorMap: () => ({ message: 'النطاق المستهدف غير صالح' }) }).refine((b) => b !== 'RED', 'اختر نطاقاً أخضر أو بلاتينياً'),
    byDate: zYearDate('تاريخ الوصول'),
    options: z
      .object({
        documentFirst: optBool,
        raiseHalfWeight: optBool,
        replaceExpats: optBool,
        hireBasic: zMoneyOpt('أجر التعيين الأساسي', 200_000),
        hireHousing: zMoneyOpt('بدل السكن للتعيين', 100_000),
        hireGender: z.preprocess(blankToUndefined, z.enum(['MALE', 'FEMALE'], { errorMap: () => ({ message: 'الجنس غير صالح' }) }).optional()),
        hireCity: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
      })
      .strict()
      .default({}),
  })
  .strict();
export type SolveParams = z.infer<typeof solveSchema>;

/** Saved «مخطط السعودة» calculation: the estimate of one company on a date, plus the solver when a target is given. */
export const saudizationSnapshotSchema = z
  .object({
    companyId: zId,
    date: zYearDate('التاريخ'),
    targetBand: z.preprocess(blankToUndefined, z.enum(NITAQAT_BANDS, { errorMap: () => ({ message: 'النطاق المستهدف غير صالح' }) }).refine((b) => b !== 'RED', 'اختر نطاقاً أخضر أو بلاتينياً').optional()),
    byDate: zYearDate('تاريخ الوصول'),
    options: solveSchema.shape.options,
  })
  .strict();

export const hireCandidateSchema = z
  .object({
    kind: z.enum(CANDIDATE_KINDS, { errorMap: () => ({ message: 'نوع المرشح غير صالح' }) }),
    label: z.preprocess(blankToUndefined, z.string().trim().max(80).optional()),
    basicSalary: zMoneyOpt('الراتب الأساسي', 200_000),
    housingAllowance: zMoneyOpt('بدل السكن', 100_000),
    otherAllowances: zMoneyOpt('البدلات الأخرى', 100_000),
    gender: z.preprocess(blankToUndefined, z.enum(['MALE', 'FEMALE'], { errorMap: () => ({ message: 'الجنس غير صالح' }) }).optional()),
    isDisabled: optBool,
    isStudent: optBool,
    partTime: optBool,
    city: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
    occupationName: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
    occupationCode: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,10}$/, 'رمز المهنة أرقام فقط').optional()),
    medicalClass: z.preprocess(blankToUndefined, z.string().trim().max(10).optional()),
    nationality: z.preprocess(blankToUndefined, z.string().trim().max(60).optional()),
    dependentsCount: z.preprocess(toNumber, z.number({ invalid_type_error: 'عدد المرافقين غير صالح' }).int('عدد المرافقين غير صالح').min(0).max(20).optional()),
    dependentsFeePaidBy: z.preprocess(blankToUndefined, z.enum(['COMPANY', 'EMPLOYEE'], { errorMap: () => ({ message: 'من يدفع رسوم المرافقين: قيمة غير صالحة' }) }).optional()),
    overtimeHoursPerMonth: z.preprocess(toNumber, z.number({ invalid_type_error: 'ساعات العمل الإضافي غير صالحة' }).finite().min(0).max(300, 'ساعات العمل الإضافي الشهرية لا تتجاوز 300').optional()),
    overtimeEmployeeId: z.preprocess(blankToUndefined, zId.optional()),
    monthlyQuote: zMoneyOpt('عرض الإسناد الشهري', 5_000_000),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.kind === 'SAUDI' || c.kind === 'EXPAT') && !(c.basicSalary && c.basicSalary > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['basicSalary'], message: 'أدخل الراتب الأساسي للمرشح' });
    if (c.kind === 'OVERTIME' && !(c.overtimeHoursPerMonth && c.overtimeHoursPerMonth > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['overtimeHoursPerMonth'], message: 'أدخل ساعات العمل الإضافي الشهرية' });
    if (c.kind === 'OVERTIME' && !c.overtimeEmployeeId && !(c.basicSalary && c.basicSalary > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['basicSalary'], message: 'اختر موظفاً أو أدخل الراتب الأساسي لحساب أجر الساعة' });
    if (c.kind === 'OUTSOURCING' && !(c.monthlyQuote && c.monthlyQuote > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['monthlyQuote'], message: 'أدخل عرض سعر الإسناد الشهري (لا أرقام مخترعة)' });
  });

export const hireScenarioSchema = z
  .object({
    companyId: zId,
    startMonth: z.preprocess(blankToUndefined, z.string().regex(/^(20[2-3]\d|2040)-(0[1-9]|1[0-2])$/, 'شهر البداية بصيغة YYYY-MM').optional()),
    months: z.preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : typeof v === 'string' ? Number(v) : v),
      z
        .number()
        .refine((n): n is Horizon => (HORIZONS as ReadonlyArray<number>).includes(n), 'الأفق 12 أو 24 أو 36 شهراً')
        .default(36),
    ),
    candidates: z.array(hireCandidateSchema).min(1, 'أضف مرشحاً واحداً على الأقل').max(4, 'أربعة بدائل كحد أقصى'),
  })
  .strict();
export type HireScenarioParams = z.infer<typeof hireScenarioSchema>;

// ---------------------------------------------------------------------------
// Register rows (SUPER_ADMIN; history immutable: a correction is a NEW row)
// ---------------------------------------------------------------------------

const zUrl = z.preprocess(blankToUndefined, z.string().trim().max(2000).url('رابط المصدر غير صالح').refine((u) => /^https?:\/\//i.test(u), 'رابط المصدر يجب أن يبدأ بـ http أو https').optional());
const zOptLong = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const zPage = z.preprocess(toNumber, z.number({ invalid_type_error: 'رقم الصفحة غير صالح' }).int('رقم الصفحة غير صالح').min(1).max(2000).optional());

export const newActivitySchema = z
  .object({
    type: z.literal('ACTIVITY'),
    key: z.preprocess(blankToUndefined, z.string().trim().regex(/^[\p{L}\p{N}-]{2,120}$/u, 'المفتاح: حروف وأرقام وشرطة فقط').optional()),
    nameAr: z.string({ required_error: 'اسم النشاط مطلوب' }).trim().min(2, 'اسم النشاط مطلوب').max(300),
    code: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,10}$/, 'رمز النشاط أرقام فقط').optional()),
    sizeSegment: zOptLong(100),
    status: z.enum(NITAQAT_ROW_STATUSES, { errorMap: () => ({ message: 'حالة الدليل غير صالحة' }) }),
    sourceUrl: zUrl,
    page: zPage,
    notes: zOptLong(5000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.status !== 'USER_INPUT' && !b.sourceUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: 'رابط المصدر مطلوب إلا إذا كانت الحالة «إدخال المنشأة»' });
  });

export const newCurveSchema = z
  .object({
    type: z.literal('CURVE'),
    activityKey: z.string().trim().min(1, 'اختر النشاط').max(160),
    band: z.enum(CURVE_BANDS, { errorMap: () => ({ message: 'النطاق غير صالح' }) }),
    year: z.preprocess(toNumber, z.number().int().min(2026, 'السنة من 2026').max(2040)),
    m: z.preprocess(toNumber, z.number({ invalid_type_error: 'm يجب أن يكون رقماً' }).finite().min(-50).max(50)),
    c: z.preprocess(toNumber, z.number({ invalid_type_error: 'c يجب أن يكون رقماً' }).finite().min(-100).max(100)),
    status: z.enum(NITAQAT_ROW_STATUSES, { errorMap: () => ({ message: 'حالة الدليل غير صالحة' }) }),
    sourceUrl: zUrl,
    page: zPage,
    note: zOptLong(5000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.status !== 'USER_INPUT' && !b.sourceUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: 'رابط المصدر مطلوب إلا إذا كانت الحالة «إدخال المنشأة»' });
  });

export const nitaqatPostSchema = z.discriminatedUnion('type', [newActivitySchema.innerType(), newCurveSchema.innerType()], { errorMap: () => ({ message: 'نوع السجل: ACTIVITY أو CURVE' }) }).superRefine((b, ctx) => {
  if (b.status !== 'USER_INPUT' && !b.sourceUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: 'رابط المصدر مطلوب إلا إذا كانت الحالة «إدخال المنشأة»' });
});

export const DECISION_INPUT_STATUSES = ['VERIFIED_PRIMARY', 'PARTIAL', 'PROVISIONAL', 'USER_INPUT'] as const;

const zPhase = z
  .object({
    pct: z.preprocess(toNumber, z.number({ invalid_type_error: 'النسبة رقم' }).min(0).max(100, 'النسبة لا تتجاوز 100')),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ السريان بصيغة YYYY-MM-DD'),
    minWorkers: z.preprocess(toNumber, z.number().int().min(1).max(100000).optional()),
    maxWorkers: z.preprocess(toNumber, z.number().int().min(1).max(100000).optional()),
    activity: zOptLong(300),
    activityCodes: z.array(z.string().trim().max(60)).max(50).optional(),
    appliesTo: zOptLong(500),
  })
  .strict();

const zOccupation = z.union([
  z.string().trim().min(1).max(200),
  z
    .object({ code: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,10}$/, 'رمز المهنة أرقام فقط').optional()), nameAr: zOptLong(200), nameEn: zOptLong(200) })
    .strict()
    .refine((o) => !!(o.code || o.nameAr || o.nameEn), 'المهنة: اسم أو رمز'),
]);

export const newDecisionSchema = z
  .object({
    groupNameAr: z.string({ required_error: 'اسم مجموعة المهن مطلوب' }).trim().min(2, 'اسم مجموعة المهن مطلوب').max(200),
    occupations: z.array(zOccupation).min(1, 'أضف مهنة واحدة على الأقل').max(500),
    phases: z.array(zPhase).min(1, 'أضف مرحلة واحدة على الأقل').max(20),
    minEstablishmentSize: z.preprocess(toNumber, z.number().int().min(1).max(100000).optional()),
    minWage: zMoneyOpt('الحد الأدنى للأجر', 200_000),
    scope: zOptLong(2000),
    decisionNo: zOptLong(60),
    decisionDate: z.preprocess(blankToUndefined, zDate.optional()),
    status: z.enum(DECISION_INPUT_STATUSES, { errorMap: () => ({ message: 'حالة الدليل غير صالحة' }) }),
    sourceUrl: zUrl,
    page: zPage,
    notes: zOptLong(10000),
    /** Row this one corrects (history kept: the old row stays, the newest row of a group applies). */
    correctsId: z.preprocess(blankToUndefined, zId.optional()),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.status !== 'USER_INPUT' && !b.sourceUrl && !b.notes) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: 'أدخل رابط المصدر أو ملاحظة بالمصدر إلا إذا كانت الحالة «إدخال المنشأة»' });
    if (b.correctsId && !b.notes) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notes'], message: 'التصحيح يحتاج ملاحظة توضح ما صُحّح' });
    b.phases.forEach((p, i) => {
      if (p.minWorkers && p.maxWorkers && p.maxWorkers < p.minWorkers) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phases', i, 'maxWorkers'], message: 'الحد الأعلى للعاملين أقل من الأدنى' });
    });
  });
export type NewDecisionParams = z.infer<typeof newDecisionSchema>;
