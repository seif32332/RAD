// Shared rules for the user-management endpoints (settings/users and settings/users/[id]).
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ALL_ROLES, type AppRole } from '@/lib/constants';
import { conflict, forbidden, notFound, type HttpError } from '@/lib/http';
import { zPassword } from '@/lib/validation';

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

/** 409 when another user already has this email (case-insensitive). */
export async function assertEmailAvailable(tx: Prisma.TransactionClient, email: string, excludeUserId?: string) {
  const existing = await tx.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}) },
    select: { id: true },
  });
  if (existing) throw conflict('هذا البريد الإلكتروني مسجل لحساب آخر مسبقاً');
}

/** Links `employeeId` to `userId` (unlinking any employee currently linked to that user). */
export async function linkEmployee(tx: Prisma.TransactionClient, userId: string, employeeId: string) {
  const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, userId: true } });
  if (!employee) throw notFound('الموظف المحدد غير موجود');
  if (employee.userId && employee.userId !== userId) throw conflict('هذا الموظف مرتبط بحساب مستخدم آخر');
  if (employee.userId === userId) return;
  await tx.employee.updateMany({ where: { userId }, data: { userId: null } });
  await tx.employee.update({ where: { id: employeeId }, data: { userId } });
}

/** Serializable-transaction write conflicts (P2034) become a retryable 409 instead of a 500. */
export function mapTxConflict(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return conflict('تم تعديل البيانات من مستخدم آخر في نفس اللحظة، يرجى المحاولة مرة أخرى');
  }
  return err;
}
