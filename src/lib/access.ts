// Employee account access tied to employment status.
//
// When an employee is terminated (employee PATCH terminate, settlement approval, absconding...),
// their linked login must stop working. SystemSetting `terminated_access_days` (default 0) lets
// the owner keep read access for N days (e.g. to download the last payslip). After that (or at once)
// the account keeps access to the employee's official documents ONLY for
// `terminated_documents_access_days` (default 30, owner decision 2026-09-26: download the exit
// letters, accept or dispute the settlement release); every other page and API treats it as logged
// out (src/lib/auth.ts). A background job (scripts/jobs.mjs) deactivates the account at the end.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { logAudit } from '@/lib/audit';

export const TERMINATED_ACCESS_SETTING = 'terminated_access_days';
export const TERMINATED_DOCUMENTS_SETTING = 'terminated_documents_access_days';

/** Documents-only window in days (invalid -> 30, 0 = none, at most 90). Same rule as scripts/jobs.mjs. */
export function parseDocumentsDays(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') return 30;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.min(Math.floor(n), 90);
}

export async function terminatedDocumentsDays(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.systemSetting.findUnique({ where: { key: TERMINATED_DOCUMENTS_SETTING }, select: { value: true } });
  return parseDocumentsDays(row?.value);
}

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
  /** End of the documents-only window set now (null = none). */
  documentsOnlyUntil?: Date | null;
}

/**
 * Ends the login linked to `employeeId` (revoking its sessions) unless a grace period is
 * configured: documents-only access for the configured window, or deactivated when there is none
 * or `documentsAccess` is false (absconding). Call inside the transaction that terminates the employee.
 */
export async function deactivateEmployeeUser(
  tx: Prisma.TransactionClient,
  employeeId: string,
  opts: { reason: string; actorId?: string | null; ipAddress?: string | null; documentsAccess?: boolean },
): Promise<DeactivateResult> {
  const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
  if (!employee?.userId) return { hasUser: false, deactivated: false, graceDays: 0 };

  const graceDays = await terminatedAccessDays(tx);
  if (graceDays > 0) return { hasUser: true, deactivated: false, graceDays };

  const documentsDays = opts.documentsAccess === false ? 0 : await terminatedDocumentsDays(tx);
  if (documentsDays > 0) {
    const until = new Date(Date.now() + documentsDays * 86400e3);
    const res = await tx.user.updateMany({
      where: { id: employee.userId, isActive: true, documentsOnlyUntil: null },
      data: { documentsOnlyUntil: until, sessionVersion: { increment: 1 } },
    });
    if (res.count > 0) {
      await logAudit(
        {
          userId: opts.actorId ?? null,
          action: 'UPDATE',
          entityType: 'User',
          entityId: employee.userId,
          details: { field: 'documentsOnlyUntil', to: until.toISOString(), reason: opts.reason, employeeId },
          ipAddress: opts.ipAddress ?? null,
        },
        tx,
      );
    }
    return { hasUser: true, deactivated: false, graceDays: 0, documentsOnlyUntil: until };
  }


  const res = await tx.user.updateMany({
    where: { id: employee.userId, isActive: true },
    data: { isActive: false, documentsOnlyUntil: null, sessionVersion: { increment: 1 } },
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
