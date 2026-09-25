// Muqeem link fields of a company (moiNumber + muqeemPlatformId), shared by the company routes.
// Not a route (no route.ts): Next does not serve this file.
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthUser } from '@/lib/auth';
import { badRequest, forbidden } from '@/lib/http';

/** Only roles that may read the government-platforms vault AND manage companies can (re)link credentials. */
const MUQEEM_LINK_ROLES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN'];

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const toLatinDigits = (s: string) =>
  s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));

/**
 * MOI (الجوازات / 700) establishment number: digits only ('' / null -> null, spaces and dashes removed).
 * The "10 digits starting with 7" rule is only a WARNING (see moiNumberWarnings).
 */
export const zMoiNumber = z
  .preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const s = toLatinDigits(String(v)).replace(/[\s-]/g, '');
      return s === '' ? null : s;
    },
    z.string().regex(/^\d{1,20}$/, 'رقم المنشأة في الجوازات (مقيم) يجب أن يتكون من أرقام فقط').nullable(),
  )
  .optional();

/** GovPlatform id holding the Muqeem user credentials ('' / null -> null = unlink). */
export const zMuqeemPlatformId = z
  .preprocess((v) => (v === '' ? null : v), z.string().trim().min(1).max(100).nullable())
  .optional();

/**
 * Non-blocking warnings for the Muqeem link.
 * ASSUMPTION (not confirmed by Elm): a company's MOI number used with Muqeem is the "700 number",
 * 10 digits starting with 7. The official spec's moiNumber pattern is ^(1|2|7)[0-9]{9}$ (it also
 * admits individual sponsors), so other values are accepted with a warning only.
 */
export function moiNumberWarnings(moiNumber: string | null | undefined, muqeemPlatformId: string | null | undefined): string[] {
  const warnings: string[] = [];
  if (moiNumber && !/^7\d{9}$/.test(moiNumber)) {
    warnings.push('تنبيه: رقم المنشأة في الجوازات يتكون عادةً من 10 أرقام ويبدأ بالرقم 7. تحقق من الرقم قبل استخدام خدمات مقيم.');
  }
  if (moiNumber && !muqeemPlatformId) warnings.push('تنبيه: لم يتم اختيار حساب مقيم، لن تعمل خدمات مقيم لهذه الشركة.');
  if (!moiNumber && muqeemPlatformId) warnings.push('تنبيه: لم يتم إدخال رقم المنشأة في الجوازات، لن تعمل خدمات مقيم لهذه الشركة.');
  return warnings;
}

/**
 * Validates a requested change of muqeemPlatformId: the GovPlatform must exist and only
 * MUQEEM_LINK_ROLES may change the link. `current` is the stored value (undefined on create).
 */
export async function assertMuqeemPlatformChange(
  user: AuthUser,
  next: string | null | undefined,
  current: string | null | undefined,
): Promise<void> {
  if (next === undefined) return;
  if ((next ?? null) === (current ?? null)) return; // unchanged (the edit form always sends it)
  if (!MUQEEM_LINK_ROLES.includes(user.role)) {
    throw forbidden('ربط الشركة بحساب مقيم متاح لمدير النظام وصاحب العمل فقط');
  }
  if (next === null) return;
  const platform = await prisma.govPlatform.findUnique({ where: { id: next }, select: { id: true } });
  if (!platform) throw badRequest('حساب مقيم المختار غير موجود في خزنة المنصات الحكومية');
}
