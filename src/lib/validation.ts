// Reusable zod building blocks for request validation.
// Forms send empty strings for blank fields, so optional helpers treat '' as undefined/null.
import { z } from 'zod';
import { parseDateOnly } from '@/lib/dates';
import { toNumber } from '@/lib/money';

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

/** Required non-empty trimmed string. */
export const zText = (max = 500) => z.string().trim().min(1, 'حقل مطلوب').max(max);

/** Optional string: '' / null -> null. Use for nullable DB columns. */
export const zOptText = (max = 2000) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(max).nullable()).optional();

export const zId = z.string().trim().min(1).max(100);

/** Required date-only value (accepts 'YYYY-MM-DD', 'DD/MM/YYYY', Date, Excel serial). */
export const zDate = z.preprocess(
  (v) => parseDateOnly(v) ?? v,
  z.date({ invalid_type_error: 'تاريخ غير صالح', required_error: 'التاريخ مطلوب' }),
);

/** Optional date: ''/null -> null. */
export const zOptDate = z
  .preprocess((v) => (v === '' || v === null || v === undefined ? null : (parseDateOnly(v) ?? v)), z.date({ invalid_type_error: 'تاريخ غير صالح' }).nullable())
  .optional();

/** Required finite number (accepts numeric strings). */
export const zNumber = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? toNumber(v, NaN) : v),
  z.number({ invalid_type_error: 'رقم غير صالح' }).finite(),
);

/** Required non-negative money amount. */
export const zMoney = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? toNumber(v, NaN) : v),
  z.number({ invalid_type_error: 'مبلغ غير صالح' }).finite().min(0, 'لا يمكن أن يكون المبلغ سالباً'),
);

/** Optional money: ''/null -> undefined. */
export const zOptMoney = z.preprocess(emptyToUndefined, zMoney.optional());

export const zInt = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number({ invalid_type_error: 'رقم غير صالح' }).int(),
);

export const zOptInt = z.preprocess(emptyToUndefined, zInt.optional());

export const zBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

export const zMonth = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(12));
export const zYear = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(2000).max(2100));

export const zEmail = z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(200);

/** Password policy for new/changed passwords. */
export const zPassword = z
  .string()
  .min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف')
  .max(128)
  .regex(/[A-Za-z]/, 'كلمة المرور يجب أن تحتوي على حرف')
  .regex(/\d/, 'كلمة المرور يجب أن تحتوي على رقم');

/** Pagination query params: ?take=50&skip=0 (take capped at 500). */
export const zPagination = z.object({
  take: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(1).max(500).optional()),
  skip: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(0).optional()),
});
