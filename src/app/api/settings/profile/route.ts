import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { HttpError, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zEmail, zPassword } from '@/lib/validation';
import { rateLimit, resetRateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { SESSION_COOKIE, sessionCookieOptions, signSession } from '@/lib/session';
import { assertPasswordLength, friendlyValidationError, loadSecurityPolicy } from '../security';

export const dynamic = 'force-dynamic';

const BCRYPT_COST = 12;
const MAX_PASSWORD_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

const accountSelect = { id: true, email: true, role: true, isActive: true, createdAt: true, updatedAt: true } as const;

const ChangeSchema = z.discriminatedUnion('actionType', [
  z.object({
    actionType: z.literal('CHANGE_EMAIL'),
    newEmail: zEmail,
    currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة').max(200),
  }),
  z.object({
    actionType: z.literal('CHANGE_PASSWORD'),
    currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة').max(200),
    newPassword: zPassword,
    confirmPassword: z.string().max(200),
  }),
]);

/**
 * GET: the logged-in user's own account ({ admin } kept for the settings page).
 * No user is ever created here: the initial admin comes from the seed/CLI script.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: accountSelect });
    if (!account) throw notFound('الحساب غير موجود');
    return NextResponse.json({ admin: account });
  } catch (err) {
    return handleApiError(err, 'settings-profile:GET');
  }
}

/** POST { actionType: 'CHANGE_EMAIL' | 'CHANGE_PASSWORD', currentPassword, ... } for the logged-in user. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const ip = getClientIp(req);
    const body = await parseBody(req, ChangeSchema);

    const attemptKey = `pw-verify:${user.id}`;
    const limit = rateLimit(attemptKey, MAX_PASSWORD_ATTEMPTS, ATTEMPT_WINDOW_MS);
    if (!limit.ok) {
      throw new HttpError(429, `محاولات كثيرة. حاول مرة أخرى بعد ${Math.ceil(limit.retryAfterSeconds / 60)} دقيقة`);
    }

    const current = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, passwordHash: true } });
    if (!current) throw notFound('الحساب غير موجود');

    const valid = await bcrypt.compare(body.currentPassword, current.passwordHash);
    if (!valid) {
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'User', entityId: user.id, details: { failed: 'wrong current password', actionType: body.actionType }, ipAddress: ip });
      throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة');
    }
    resetRateLimit(attemptKey);

    if (body.actionType === 'CHANGE_EMAIL') {
      const existing = await prisma.user.findFirst({
        where: { email: { equals: body.newEmail, mode: 'insensitive' }, NOT: { id: user.id } },
        select: { id: true },
      });
      if (existing) throw conflict('هذا البريد الإلكتروني مستخدم من قبل حساب آخر');

      await prisma.user.update({ where: { id: user.id }, data: { email: body.newEmail } });
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'User', entityId: user.id, details: { field: 'email', from: user.email, to: body.newEmail }, ipAddress: ip });
      return NextResponse.json({ message: 'تم تحديث البريد الإلكتروني بنجاح ✅' });
    }

    // CHANGE_PASSWORD
    if (body.newPassword !== body.confirmPassword) {
      throw new HttpError(400, 'كلمة المرور الجديدة وتأكيدها غير متطابقتين');
    }
    if (body.newPassword === body.currentPassword) {
      throw new HttpError(400, 'كلمة المرور الجديدة يجب أن تختلف عن الحالية');
    }
    await assertPasswordLength(body.newPassword);
    const passwordHash = await bcrypt.hash(body.newPassword, BCRYPT_COST);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'User', entityId: user.id, details: { field: 'password' }, ipAddress: ip });

    // Other sessions of this user carry the old credential version and stop working (see
    // sessionMatchesCredentials); this browser gets a fresh session so the user stays logged in.
    const { sessionTimeoutMinutes } = await loadSecurityPolicy();
    const maxAge = sessionTimeoutMinutes * 60;
    const token = await signSession({ sub: user.id, role: user.role, passwordHash, sessionVersion: user.sessionVersion }, maxAge);
    const response = NextResponse.json({ message: 'تم تغيير كلمة المرور بنجاح ✅ تم تسجيل الخروج من الأجهزة الأخرى.' });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
    return response;
  } catch (err) {
    return handleApiError(friendlyValidationError(err), 'settings-profile:POST');
  }
}
