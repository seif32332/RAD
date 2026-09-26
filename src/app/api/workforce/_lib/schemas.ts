// Request schemas of the workforce API (zod, Arabic messages). PURE; shared by the routes and the
// saved-calculation recompute (POST /api/workforce/calculations re-validates stored params with them).
import { z } from 'zod';
import { zBool, zDate, zId } from '@/lib/validation';
import { TERMINATION_REASONS } from '@/lib/settlement';
import { EMPLOYEE_EXIT_REASONS, EXIT_REASON_TO_TERMINATION, type EmployeeExitReason } from '@/lib/workforce/reasons';
import { ASSUMPTION_DEFS, REMOVED_ASSUMPTION_KEYS, removedAssumptionMessage, type AssumptionKey } from '@/lib/workforce/assumptions';
import { HORIZONS, RULE_INPUT_STATUSES, SCENARIOS, type Horizon } from './shared';

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

export const zScenario = z.preprocess(blankToUndefined, z.enum(SCENARIOS, { errorMap: () => ({ message: 'السيناريو يجب أن يكون low أو base أو high' }) }).default('base'));

export const zHorizon = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : typeof v === 'string' ? Number(v) : v),
  z
    .number({ invalid_type_error: 'الأفق يجب أن يكون 12 أو 24 أو 36 شهراً' })
    .refine((n): n is Horizon => (HORIZONS as ReadonlyArray<number>).includes(n), 'الأفق يجب أن يكون 12 أو 24 أو 36 شهراً')
    .default(36),
);

/** 'YYYY-MM' between 2000 and 2100 (first projected month). */
export const zStartMonth = z.preprocess(
  blankToUndefined,
  z
    .string()
    .regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/, 'شهر البداية يجب أن يكون بصيغة YYYY-MM')
    .optional(),
);

const zOptId = z.preprocess(blankToUndefined, zId.optional());

export const overviewQuerySchema = z.object({
  months: zHorizon,
  scenario: zScenario,
});

export const trueCostParamsSchema = z.object({
  companyId: zOptId,
  branchId: zOptId,
  departmentId: zOptId,
  employeeId: zOptId,
  months: zHorizon,
  scenario: zScenario,
  startMonth: zStartMonth,
});

export const trueCostQuerySchema = trueCostParamsSchema.extend({
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  sort: z.preprocess(blankToUndefined, z.enum(['cost', 'name', 'flags']).default('cost')),
  flagged: z.preprocess((v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' || v === '' || v === undefined ? false : v), z.boolean()),
  take: z.preprocess((v) => (v === undefined || v === '' ? 50 : Number(v)), z.number().int().min(1, 'عدد النتائج غير صالح').max(200, 'الحد الأعلى 200 موظف في الصفحة')),
  skip: z.preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0, 'بداية الصفحة غير صالحة')),
});

const zMoneyInput = z.preprocess(
  (v) => (v === '' || v === null ? undefined : typeof v === 'string' ? Number(v) : v),
  z.number({ invalid_type_error: 'مبلغ غير صالح' }).finite().min(0, 'لا يمكن أن يكون المبلغ سالباً').max(1_000_000, 'المبلغ أكبر من المسموح').optional(),
);

export const exitCostSchema = z
  .object({
    employeeId: zId,
    exitReason: z.enum(EMPLOYEE_EXIT_REASONS, { errorMap: () => ({ message: 'سبب الخروج غير صالح' }) }),
    settlementReason: z.preprocess(blankToUndefined, z.enum(TERMINATION_REASONS, { errorMap: () => ({ message: 'أساس التسوية غير صالح' }) }).optional()),
    lastWorkingDate: zDate,
    noticeServed: zBool,
    replacementIsSaudi: z.preprocess((v) => (v === '' || v === null ? undefined : v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional()),
    scenario: zScenario,
    /** Replacement assumptions for this calculation only (never saved as company assumptions). */
    assumptionsOverride: z
      .object({
        recruitmentCostSaudi: zMoneyInput,
        recruitmentCostExpat: zMoneyInput,
        vacancyMonths: z.preprocess(
          (v) => (v === '' || v === null ? undefined : typeof v === 'string' ? Number(v) : v),
          z.number({ invalid_type_error: 'أشهر الشغور غير صالحة' }).finite().min(0, 'أشهر الشغور غير صالحة').max(36, 'أشهر الشغور لا تتجاوز 36').optional(),
        ),
      })
      .strict()
      .optional(),
  })
  .superRefine((b, ctx) => {
    const mapping = EXIT_REASON_TO_TERMINATION[b.exitReason as EmployeeExitReason];
    if (!mapping.terminationReason && !b.settlementReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settlementReason'], message: 'اختر أساس التسوية لهذا السبب (من بادر بإنهاء العلاقة)' });
    }
    const y = b.lastWorkingDate instanceof Date ? b.lastWorkingDate.getUTCFullYear() : NaN;
    if (!(y >= 2000 && y <= 2100)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lastWorkingDate'], message: 'آخر يوم عمل غير صالح' });
  });

export type ExitCostParams = z.infer<typeof exitCostSchema>;
export type TrueCostParams = z.infer<typeof trueCostParamsSchema>;
export type OverviewParams = z.infer<typeof overviewQuerySchema>;

// ---------------------------------------------------------------------------
// Rules register: a NEW version (history is never edited)
// ---------------------------------------------------------------------------

const zOptLongText = (max: number) => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(max).optional());

export const newRuleVersionSchema = z
  .object({
    key: z
      .string({ required_error: 'مفتاح القاعدة مطلوب' })
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,79}$/, 'مفتاح القاعدة بحروف إنجليزية كبيرة وأرقام وشرطة سفلية فقط (مثل IQAMA_FEE_YEAR)'),
    domain: z.preprocess(blankToUndefined, z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'المجال غير صالح').optional()),
    label: zOptLongText(300),
    value: z.preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : typeof v === 'string' ? Number(v) : v),
      z.number({ invalid_type_error: 'القيمة يجب أن تكون رقماً' }).finite('القيمة يجب أن تكون رقماً').optional(),
    ),
    valueJson: zOptLongText(20000),
    unit: z.preprocess(blankToUndefined, z.string().trim().regex(/^[A-Z][A-Z_]{0,29}$/, 'الوحدة غير صالحة').optional()),
    effectiveFrom: zDate,
    status: z.enum(RULE_INPUT_STATUSES, { errorMap: () => ({ message: 'حالة الدليل غير صالحة' }) }),
    sourceUrl: z.preprocess(blankToUndefined, z.string().trim().max(2000).url('رابط المصدر غير صالح').refine((u) => /^https?:\/\//i.test(u), 'رابط المصدر يجب أن يبدأ بـ http أو https').optional()),
    sourceQuote: zOptLongText(5000),
    notes: zOptLongText(5000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.value === undefined && b.valueJson === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'أدخل القيمة (رقم أو JSON)' });
    if (b.valueJson !== undefined) {
      try {
        JSON.parse(b.valueJson);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['valueJson'], message: 'القيمة المركّبة ليست JSON صالحاً' });
      }
    }
    if (b.status !== 'USER_INPUT' && !b.sourceUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: 'رابط المصدر مطلوب إلا إذا كانت الحالة «إدخال المنشأة»' });
    const y = b.effectiveFrom instanceof Date ? b.effectiveFrom.getUTCFullYear() : NaN;
    if (!(y >= 1990 && y <= 2100)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveFrom'], message: 'تاريخ السريان غير صالح' });
  });

// ---------------------------------------------------------------------------
// Assumptions upsert
// ---------------------------------------------------------------------------

const ASSUMPTION_KEYS = Object.keys(ASSUMPTION_DEFS) as [keyof typeof ASSUMPTION_DEFS, ...(keyof typeof ASSUMPTION_DEFS)[]];

export const assumptionsPutSchema = z
  .object({
    /** '' = every company (global row). */
    companyId: z.preprocess((v) => (v === null || v === undefined ? '' : v), z.string().trim().max(100)),
    items: z
      .array(
        z
          .object({
            // The overtime basis, the medical premiums and the iqama fee are company settings now
            // («إعدادات الكلفة»): their former keys are refused with a message pointing there.
            key: z
              .string({ invalid_type_error: 'افتراض غير معروف', required_error: 'افتراض غير معروف' })
              .superRefine((k, ctx) => {
                if (Object.prototype.hasOwnProperty.call(REMOVED_ASSUMPTION_KEYS, k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: removedAssumptionMessage(k) });
                else if (!(ASSUMPTION_KEYS as ReadonlyArray<string>).includes(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'افتراض غير معروف' });
              })
              .transform((k) => k as AssumptionKey),
            /** null removes the row (falls back to the global row or the default). */
            value: z.unknown(),
            note: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(1000).nullable().optional()),
          })
          .strict(),
      )
      .min(1, 'لا توجد تغييرات للحفظ')
      .max(30),
  })
  .strict()
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    b.items.forEach((it, i) => {
      if (seen.has(it.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', i, 'key'], message: 'افتراض مكرر في الطلب' });
      seen.add(it.key);
    });
  });

// ---------------------------------------------------------------------------
// Saved calculations
// ---------------------------------------------------------------------------

export const CALCULATION_KINDS = ['TRUE_COST', 'EXIT_COST', 'OVERVIEW', 'SAUDIZATION', 'HIRE_SCENARIO'] as const;

export const calculationPostSchema = z
  .object({
    kind: z.enum(CALCULATION_KINDS, { errorMap: () => ({ message: 'نوع الحساب غير صالح' }) }),
    params: z.record(z.unknown()).default({}),
    title: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  })
  .strict();

export const calculationListSchema = z.object({
  kind: z.preprocess(blankToUndefined, z.enum(CALCULATION_KINDS).optional()),
  take: z.preprocess((v) => (v === undefined || v === '' ? 25 : Number(v)), z.number().int().min(1).max(100)),
  skip: z.preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0)),
});
