// Payment proof of a settlement (client-safe): how, under which reference and on which day finance
// paid it. Entered when finance confirms the payment (PUT /api/settlements, PUT /api/payments/<id>)
// and printed on the settlement statement, whose discharge refers to exactly this payment.
import { z } from 'zod';

export const SETTLEMENT_PAYMENT_METHODS = {
  BANK_TRANSFER: { ar: 'تحويل بنكي', en: 'Bank transfer', referenceAr: 'رقم التحويل' },
  CASH_VOUCHER: { ar: 'سند صرف نقدي', en: 'Cash payment voucher', referenceAr: 'رقم سند الصرف' },
  CHEQUE: { ar: 'شيك', en: 'Cheque', referenceAr: 'رقم الشيك' },
} as const;
export type SettlementPaymentMethod = keyof typeof SETTLEMENT_PAYMENT_METHODS;

/** Letters, digits and simple separators only: the reference is printed on an official document. */
export const PAYMENT_REFERENCE_RE = /^[A-Za-z0-9ء-غف-ي٠-٩ ./#-]{2,60}$/;

const riyadhToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export const settlementPaymentProofSchema = z.object({
  paymentMethod: z.enum(['BANK_TRANSFER', 'CASH_VOUCHER', 'CHEQUE'], { message: 'اختر طريقة الصرف' }),
  paymentReference: z
    .string()
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .pipe(z.string().regex(PAYMENT_REFERENCE_RE, 'رقم التحويل أو السند: من 2 إلى 60 حرفاً ورقماً')),
  paidAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ الصرف غير صالح')
    .refine((d) => d <= riyadhToday(), 'تاريخ الصرف لا يكون في المستقبل')
    .refine((d) => d >= '2000-01-01', 'تاريخ الصرف غير صالح'),
});
export type SettlementPaymentProof = z.infer<typeof settlementPaymentProofSchema>;

/** Stored as the Riyadh calendar day (midnight Riyadh = 21:00 UTC of the previous day). */
export function paidAtDate(day: string): Date {
  return new Date(`${day}T00:00:00+03:00`);
}
