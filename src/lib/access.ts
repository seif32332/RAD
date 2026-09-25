// Employee account access tied to employment status.
//
// When an employee is terminated (employee PATCH terminate, settlement approval, absconding...),
// their linked login must stop working. SystemSetting `terminated_access_days` (default 0) lets
// the owner keep read access for N days (e.g. to download the last payslip); a background job
// (scripts/jobs.mjs) deactivates those accounts once the grace period is over.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { logAudit } from '@/lib/audit';

export const TERMINATED_ACCESS_SETTING = 'terminated_access_days';

/** Grace period in days from SystemSetting (invalid / missing -> 0 = immediate). */
export async function terminatedAccessDays(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.systemSetting.findUnique({ where: { key: TERMINATED_ACCESS_SETTING }, select: { value: true } });
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 90) : 0;
}

export interface DeactivateResult {
  /** A login account is linked to the employee. */
  hasUser: boolean;
  /** The account was deactivated now (false when a grace period applies or it was already inactive). */
  deactivated: boolean;
  /** Days of remaining access when a grace period applies. */
  graceDays: number;
}

/**
 * Deactivates the login linked to `employeeId` (and revokes its sessions) unless a grace
 * period is configured. Call inside the same transaction that terminates the employee.
 */
export async function deactivateEmployeeUser(
  tx: Prisma.TransactionClient,
  employeeId: string,
  opts: { reason: string; actorId?: string | null; ipAddress?: string | null },
): Promise<DeactivateResult> {
  const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
  if (!employee?.userId) return { hasUser: false, deactivated: false, graceDays: 0 };

  const graceDays = await terminatedAccessDays(tx);
  if (graceDays > 0) return { hasUser: true, deactivated: false, graceDays };

  const res = await tx.user.updateMany({
    where: { id: employee.userId, isActive: true },
    data: { isActive: false, sessionVersion: { increment: 1 } },
  });
  if (res.count > 0) {
    await logAudit(
      {
        userId: opts.actorId ?? null,
        action: 'UPDATE',
        entityType: 'User',
        entityId: employee.userId,
        details: { field: 'isActive', to: false, reason: opts.reason, employeeId },
        ipAddress: opts.ipAddress ?? null,
      },
      tx,
    );
  }
  return { hasUser: true, deactivated: res.count > 0, graceDays: 0 };
}
