// Shared rules for the user-management endpoints (settings/users and settings/users/[id]).
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ALL_ROLES, type AppRole } from '@/lib/constants';
import { conflict, forbidden, notFound, type HttpError } from '@/lib/http';
import { zPassword } from '@/lib/validation';
import { IDENTITY_SELECT, OPEN_LINK_STATUSES, identityView } from '@/modules/iam';

export const BCRYPT_COST = 12;

/** Fields that are safe to return for a user (never passwordHash / twoFactorSecret). */
export const safeUserSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  name: true,
  avatarUrl: true,
  twoFactorEnabled: true,
  createdAt: true,
  updatedAt: true,
  employeeProfile: { select: { id: true, firstNameArabic: true, lastNameArabic: true, employeeId: true } },
} satisfies Prisma.UserSelect;

type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

/**
 * The users with their identity summary (BL-PAY-005: attestation, root, vendor) and their open employee link
 * (PROPOSED waits for a second person; CONFIRMED / LEGACY_LINKED is the access link). Never a hash or token.
 */
export async function withIdentity(users: SafeUser[]) {
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const [identities, links, pending] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: IDENTITY_SELECT }),
    prisma.userEmployeeLink.findMany({
      where: { userId: { in: ids }, status: { in: [...OPEN_LINK_STATUSES] } },
      select: { id: true, userId: true, employeeId: true, status: true, proposedById: true, employee: { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } } },
    }),
    prisma.identityChangeRequest.findMany({ where: { userId: { in: ids }, status: 'PENDING' }, select: { id: true, userId: true, kind: true, nextRole: true, requestedById: true } }),
  ]);
  const idOf = new Map(identities.map((i) => [i.id, i]));
  return users.map((u) => {
    const i = idOf.get(u.id);
    const link = links.find((l) => l.userId === u.id) ?? null;
    return {
      ...u,
      identity: i ? identityView(i) : null,
      employeeLink: link
        ? {
            id: link.id,
            employeeId: link.employeeId,
            status: link.status,
            proposedById: link.proposedById,
            employee: link.employee,
          }
        : null,
      pendingChange: pending.find((p) => p.userId === u.id) ?? null,
    };
  });
}

/** 404 when the employee file does not exist (the link is then proposed by iam). */
export async function assertEmployeeExists(employeeId: string): Promise<void> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
  if (!e) throw notFound('الموظف المحدد غير موجود');
}

export const zRole = z.enum(ALL_ROLES, { errorMap: () => ({ message: 'الدور غير صالح' }) });

/** '' = no change / none, null = unlink, string = Employee.id to link. */
export const zEmployeeLink = z
  .union([z.literal(''), z.null(), z.string().trim().min(1).max(100)])
  .optional();

/** Optional new password: ''/null/undefined = keep the current one. */
export const zOptPassword = z.preprocess((v) => (v === '' || v === null ? undefined : v), zPassword.optional());

export interface ActorInfo {
  id: string;
  role: AppRole | string;
}

export interface TargetInfo {
  id: string;
  role: AppRole | string;
  isActive: boolean;
}

export interface UserChange {
  /** Role after the change (undefined = unchanged). */
  nextRole?: string;
  /** Active flag after the change (undefined = unchanged). */
  nextActive?: boolean;
  isDelete?: boolean;
}

/**
 * Pure authorization rules for changing another user account.
 * Returns the HttpError to throw, or null when the change is allowed.
 * `activeSuperAdmins` is the number of active SUPER_ADMIN users right now.
 */
export function checkUserChange(actor: ActorInfo, target: TargetInfo, change: UserChange, activeSuperAdmins: number): HttpError | null {
  const actorIsSuper = actor.role === 'SUPER_ADMIN';
  const targetIsSuper = target.role === 'SUPER_ADMIN';
  const roleChanges = change.nextRole !== undefined && change.nextRole !== target.role;
  const deactivates = change.nextActive === false && target.isActive;

  if (targetIsSuper && !actorIsSuper) return forbidden('فقط مدير النظام يمكنه تعديل أو حذف حساب مدير نظام');
  if (change.nextRole === 'SUPER_ADMIN' && roleChanges && !actorIsSuper) return forbidden('فقط مدير النظام يمكنه منح صلاحية مدير النظام');

  if (actor.id === target.id) {
    if (change.isDelete) return forbidden('لا يمكنك حذف حسابك الخاص');
    if (roleChanges) return forbidden('لا يمكنك تغيير صلاحية حسابك الخاص');
    if (deactivates) return forbidden('لا يمكنك تعطيل حسابك الخاص');
  }

  const removesActiveSuper = targetIsSuper && target.isActive && (change.isDelete || roleChanges || deactivates);
  if (removesActiveSuper && activeSuperAdmins <= 1) {
    return conflict('لا يمكن إزالة آخر حساب مدير نظام نشط');
  }
  return null;
}

/** Only SUPER_ADMIN may create a SUPER_ADMIN account. */
export function checkCreateRole(actor: ActorInfo, role: string): HttpError | null {
  if (role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') return forbidden('فقط مدير النظام يمكنه منح صلاحية مدير النظام');
  return null;
}

/** Serializable-transaction write conflicts (P2034) become a retryable 409 instead of a 500. */
export function mapTxConflict(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return conflict('تم تعديل البيانات من مستخدم آخر في نفس اللحظة، يرجى المحاولة مرة أخرى');
  }
  return err;
}
