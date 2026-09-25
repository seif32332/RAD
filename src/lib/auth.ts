// Server-only authentication / authorization helpers for route handlers.
//
// Usage in a route handler:
//   export async function GET(req: Request) {
//     try {
//       const user = await requireUser(ROLE_GROUPS.HR);
//       ...
//     } catch (err) {
//       return handleApiError(err, 'employees:GET');
//     }
//   }
import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { SESSION_COOKIE, verifySession, sessionMatchesCredentials } from '@/lib/session';
import { forbidden, unauthorized } from '@/lib/http';
import { ROLE_GROUPS, type AppRole } from '@/lib/constants';

export interface AuthUser {
  id: string;
  email: string;
  role: AppRole;
  name: string;
  avatarUrl: string | null;
  /** Employee.id linked to this user, if any (for self-service endpoints). */
  employeeId: string | null;
  /** Current User.sessionVersion (needed when re-issuing a session cookie). */
  sessionVersion: number;
}

/** Reads and verifies the session cookie, then loads the (active) user. Cached per request. */
export const getSessionUser = cache(async (): Promise<AuthUser | null> => {
  const store = await cookies();
  const session = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.sub },
    select: {
      id: true,
      email: true,
      role: true,
      name: true,
      avatarUrl: true,
      isActive: true,
      passwordHash: true,
      sessionVersion: true,
      employeeProfile: { select: { id: true, firstNameArabic: true, lastNameArabic: true } },
    },
  });
  if (!user || !user.isActive) return null;
  // Revocation: logout bumps sessionVersion; a password change changes the credential version.
  if ((session.sv ?? 0) !== user.sessionVersion) return null;
  if (!(await sessionMatchesCredentials(session, user.passwordHash))) return null;

  const employeeName = user.employeeProfile
    ? `${user.employeeProfile.firstNameArabic ?? ''} ${user.employeeProfile.lastNameArabic ?? ''}`.trim()
    : '';

  return {
    id: user.id,
    email: user.email,
    role: user.role as AppRole,
    name: user.name || employeeName || user.email.split('@')[0],
    avatarUrl: user.avatarUrl ?? null,
    employeeId: user.employeeProfile?.id ?? null,
    sessionVersion: user.sessionVersion,
  };
});

/**
 * Throws 401 if not logged in, 403 if the user's role is not in `roles`.
 * With no argument, any authenticated user passes.
 */
export async function requireUser(roles: readonly string[] = ROLE_GROUPS.ALL): Promise<AuthUser> {
  const user = await getSessionUser();
  if (!user) throw unauthorized();
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

/** For self-service endpoints: the logged-in user's Employee.id, or 403 if not linked to an employee. */
export async function requireEmployeeId(user?: AuthUser): Promise<string> {
  const u = user ?? (await requireUser());
  if (!u.employeeId) throw forbidden('حسابك غير مرتبط بملف موظف');
  return u.employeeId;
}

export function hasRole(user: Pick<AuthUser, 'role'> | null | undefined, roles: readonly string[]): boolean {
  return !!user && roles.includes(user.role);
}

/** Client IP for audit logging / rate limiting (behind Nginx). */
export function getClientIp(req: Request): string {
  // Nginx overwrites X-Real-IP with $remote_addr, so the client cannot spoof it.
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  // Otherwise use the RIGHT-most X-Forwarded-For hop: the one appended by our own proxy.
  // (The left-most entries are supplied by the client and must not be trusted.)
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return 'unknown';
}
