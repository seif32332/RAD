import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { getSessionUser, getClientIp } from '@/lib/auth';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Ends the session. Sessions are stateless JWTs, so logout also bumps User.sessionVersion:
 * every token issued before this moment (this browser and any copied/stolen cookie, and the
 * user's other devices) stops working immediately.
 */
export async function POST(req: Request) {
  const user = await getSessionUser().catch(() => null);
  if (user) {
    try {
      await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
    } catch (err) {
      console.error('[auth:logout] failed to revoke sessions:', err);
    }
    await logAudit({ userId: user.id, action: 'LOGOUT', entityType: 'User', entityId: user.id, ipAddress: getClientIp(req) });
  }

  const response = NextResponse.json({ message: 'تم تسجيل الخروج' });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  response.cookies.delete('userId');
  response.cookies.delete('isLoggedIn');
  return response;
}
