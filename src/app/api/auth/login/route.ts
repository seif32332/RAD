import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { handleApiError, jsonError, parseBody } from '@/lib/http';
import { SESSION_COOKIE, signSession, sessionCookieOptions } from '@/lib/session';
import { rateLimit, refundRateLimit, resetRateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { loadSecurityPolicy } from '@/app/api/settings/security';

export const dynamic = 'force-dynamic';

const LoginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

const INVALID = 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
const BCRYPT_PREFIX = /^\$2[aby]\$\d{2}\$/;

export async function POST(req: Request) {
  try {
    const { email, password } = await parseBody(req, LoginSchema);
    const normalizedEmail = email.toLowerCase();
    const ip = getClientIp(req);

    const policy = await loadSecurityPolicy();
    // SystemSetting max_login_attempts: failed attempts per ACCOUNT per 15 minutes (independent of IP,
    // so rotating addresses/headers cannot bypass it), plus a coarse per-IP limit.
    const perAccount = rateLimit(`login:${normalizedEmail}`, policy.maxLoginAttempts, 15 * 60_000);
    // Per-IP limit counts FAILED attempts only (successful logins are refunded below), so many
    // users behind one office NAT are never locked out by normal sign-ins.
    const perIp = rateLimit(`login-ip:${ip}`, 50, 15 * 60_000);
    if (!perAccount.ok || !perIp.ok) {
      const retry = Math.max(perAccount.retryAfterSeconds, perIp.retryAfterSeconds);
      return NextResponse.json(
        { message: `محاولات كثيرة لتسجيل الدخول. حاول مرة أخرى بعد ${Math.ceil(retry / 60)} دقيقة`, error: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(retry) } },
      );
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      include: { employeeProfile: { select: { firstNameArabic: true, lastNameArabic: true } } },
    });

    let valid = false;
    let storedHash = user?.passwordHash ?? '';
    if (user) {
      if (BCRYPT_PREFIX.test(user.passwordHash)) {
        valid = await bcrypt.compare(password, user.passwordHash);
      } else if (user.passwordHash.length > 0 && user.passwordHash === password) {
        // Legacy account whose password was stored in plain text: accept once and hash it now.
        valid = true;
        storedHash = await bcrypt.hash(password, 12);
        await prisma.user.update({ where: { id: user.id }, data: { passwordHash: storedHash } });
      }
    } else {
      // Constant-ish time for unknown emails to avoid user enumeration by timing.
      await bcrypt.compare(password, '$2b$12$EcdNeBGBWrlMXlSx1RhBYuQx1ckdUBudDD6kgqGebecGeOUB6szHm');
    }

    if (!user || !valid) {
      await logAudit({ action: 'LOGIN_FAILED', entityType: 'User', entityId: user?.id ?? null, details: { email: normalizedEmail }, ipAddress: ip });
      return jsonError(401, INVALID);
    }

    if (!user.isActive) {
      return jsonError(403, 'الحساب معطل، يرجى مراجعة مدير النظام');
    }

    resetRateLimit(`login:${normalizedEmail}`);
    refundRateLimit(`login-ip:${ip}`);

    const displayName =
      user.name ||
      (user.employeeProfile ? `${user.employeeProfile.firstNameArabic ?? ''} ${user.employeeProfile.lastNameArabic ?? ''}`.trim() : '') ||
      user.email.split('@')[0];

    // SystemSetting session_timeout_minutes: absolute session lifetime (re-login required after it).
    const maxAge = policy.sessionTimeoutMinutes * 60;
    const token = await signSession({ sub: user.id, role: user.role, passwordHash: storedHash, sessionVersion: user.sessionVersion }, maxAge);
    await logAudit({ userId: user.id, action: 'LOGIN', entityType: 'User', entityId: user.id, ipAddress: ip });

    const response = NextResponse.json({
      message: 'تم تسجيل الدخول بنجاح',
      user: { id: user.id, email: user.email, role: user.role, name: displayName, avatarUrl: user.avatarUrl ?? null },
    });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
    // Remove cookies from the old insecure scheme.
    response.cookies.delete('userId');
    response.cookies.delete('isLoggedIn');
    return response;
  } catch (err) {
    return handleApiError(err, 'auth:login');
  }
}
