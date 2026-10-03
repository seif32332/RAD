import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp } from '@/lib/auth';
import { handleApiError, jsonError, parseBody } from '@/lib/http';
import { zPassword } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { CODE_MAX_ATTEMPTS, completeCredentialSetup, credentialTokenId, inspectCredentialToken, runIdentityTransaction } from '@/modules/iam';
import { assertPasswordLength, friendlyValidationError } from '@/app/api/settings/security';

export const dynamic = 'force-dynamic';

// PUBLIC (no session: the one-time link is the credential). BL-PAY-005; DEC-PO-027 (the holder chooses his
// password), RT-PAY-1102 / 1201 (a first attestation needs the link AND the code the attester handed over).
//
//   POST { action: 'inspect', token }                       -> { valid, purpose, codeRequired }
//   POST { action: 'complete', token, code?, password, confirmPassword }
//
// The token travels in the body (the page reads it from the URL fragment, never sent to a server). Every
// invalid, used, revoked or expired link gets the same answer; a wrong code counts an attempt and the link
// is revoked after CODE_MAX_ATTEMPTS. Rate limited per address and per link. Nothing here logs the token,
// the code or the password.

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), token: z.string().max(200) }),
  z.object({
    action: z.literal('complete'),
    token: z.string().max(200),
    code: z.string().max(20).optional(),
    password: zPassword,
    confirmPassword: z.string().max(200),
  }),
]);

const INVALID = 'الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب من مسؤول النظام رابطاً جديداً.';

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const perIp = rateLimit(`credential-setup-ip:${ip}`, 30, 15 * 60_000);
    if (!perIp.ok) {
      return NextResponse.json(
        { message: `محاولات كثيرة. حاول مرة أخرى بعد ${Math.ceil(perIp.retryAfterSeconds / 60)} دقيقة`, error: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(perIp.retryAfterSeconds) } },
      );
    }
    const body = await parseBody(req, Body);
    const tokenId = credentialTokenId(body.token);
    if (!tokenId) return jsonError(400, INVALID, { error: 'INVALID_LINK' });
    if (!rateLimit(`credential-setup:${tokenId}`, 15, 15 * 60_000).ok) return jsonError(429, 'محاولات كثيرة على هذا الرابط', { error: 'RATE_LIMITED' });

    if (body.action === 'inspect') {
      const r = await inspectCredentialToken(prisma, body.token);
      if (!r.valid) return jsonError(400, INVALID, { error: 'INVALID_LINK' });
      return NextResponse.json({ valid: true, purpose: r.purpose, codeRequired: r.codeRequired, expiresAt: r.expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (body.password !== body.confirmPassword) return jsonError(400, 'كلمة المرور وتأكيدها غير متطابقتين');
    await assertPasswordLength(body.password);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const r = await runIdentityTransaction(prisma, (tx) => completeCredentialSetup(tx, { token: body.token, code: body.code ?? null, passwordHash, ipAddress: ip }));
    if (!r.ok) {
      if (r.reason === 'BAD_CODE') {
        return jsonError(403, r.attemptsLeft ? `الرمز غير صحيح. المحاولات المتبقية: ${r.attemptsLeft}` : `الرمز غير صحيح، وأُلغي الرابط بعد ${CODE_MAX_ATTEMPTS} محاولات. اطلب إقراراً جديداً.`, {
          error: 'BAD_CODE',
          attemptsLeft: r.attemptsLeft ?? 0,
        });
      }
      if (r.reason === 'ATTESTER_INELIGIBLE') return jsonError(409, 'لم يعد المُقرّ مؤهلاً لإتمام هذا الإقرار؛ اطلب إقراراً جديداً', { error: 'ATTESTER_INELIGIBLE' });
      return jsonError(r.reason === 'INVALID' ? 400 : 410, INVALID, { error: r.reason === 'INVALID' ? 'INVALID_LINK' : 'LINK_USED_OR_EXPIRED' });
    }
    return NextResponse.json({
      message: r.attested ? 'تم اختيار كلمة المرور وإتمام إقرار هويتك. سجّل الدخول الآن.' : 'تم اختيار كلمة المرور الجديدة. سجّل الدخول الآن.',
      attested: r.attested,
    });
  } catch (err) {
    return handleApiError(friendlyValidationError(err), 'auth:credential-setup');
  }
}
