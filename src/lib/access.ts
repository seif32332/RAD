// Employee account access tied to employment status.
//
// When an employee is terminated (employee PATCH terminate, settlement approval, absconding...),
// their linked login must stop working. SystemSetting `terminated_access_days` (default 0) lets
// the owner keep read access for N days (e.g. to download the last payslip). After that (or at once)
// the account keeps access to the employee's official documents ONLY for
// `terminated_documents_access_days` (default 30, owner decision 2026-09-26: download the exit
// letters, accept or dispute the settlement release); every other page and API treats it as logged
// out (src/lib/auth.ts). The background job deactivate-terminated (below, run by scripts/jobs.mjs)
// deactivates the account at the end.
import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { logAudit } from '@/lib/audit';
import { ALL_ROLES, type AppRole } from '@/lib/constants';
import { daysUntil } from '@/lib/dates';
import { isOutboxEmailAddress, type JobDefinition, type JobSummary } from '@/modules/platform';
import type { SystemContext } from '@/modules/iam';

export const TERMINATED_ACCESS_SETTING = 'terminated_access_days';
export const TERMINATED_DOCUMENTS_SETTING = 'terminated_documents_access_days';

/** Documents-only window in days (invalid -> 30, 0 = none, at most 90). Also read by the deactivate-terminated job below. */
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

// ---------------------------------------------------------------------------------------------------
// Job deactivate-terminated (P1-FND-JOBS): the same rule as deactivateEmployeeUser, applied later to
// the logins whose grace or documents-only window has ended. Cross-company (iam CROSS_COMPANY_JOBS):
// logins are tenant-wide and removing access must reach every terminated employee, including one
// whose file has no company.
// ---------------------------------------------------------------------------------------------------

export const DEACTIVATE_TERMINATED_JOB = 'deactivate-terminated';

/**
 * Has the post-termination full access ended? grace 0 = at once (whatever the date); otherwise once
 * `graceDays` whole Riyadh days have passed since the termination date (terminated on day D with a
 * grace of 3 days = ended from day D+3). No usable date = ended (fail closed).
 */
export function accessExpired(terminatedOn: Date | string | null | undefined, graceDays: number, now: Date = new Date()): boolean {
  if (!graceDays) return true;
  const left = daysUntil(terminatedOn, now);
  if (left === null) return true;
  return -left >= graceDays;
}

export type TerminatedLoginAction = { action: 'KEEP' } | { action: 'DOCUMENTS'; until: Date } | { action: 'DEACTIVATE' };

/**
 * What happens to an active login of a terminated employee:
 *  - KEEP: still in its full-access grace, or in its documents-only window;
 *  - DOCUMENTS: grace over -> documents-only for `documentsDays` from now (the window starts when full
 *    access ends, like deactivateEmployeeUser: a backdated termination never shortens it);
 *  - DEACTIVATE: nothing left.
 */
export function terminatedLoginAction(
  user: { documentsOnlyUntil: Date | string | null },
  terminatedOn: Date | string | null | undefined,
  graceDays: number,
  documentsDays: number,
  now: Date = new Date(),
): TerminatedLoginAction {
  if (user.documentsOnlyUntil) return new Date(user.documentsOnlyUntil) > now ? { action: 'KEEP' } : { action: 'DEACTIVATE' };
  if (!accessExpired(terminatedOn, graceDays, now)) return { action: 'KEEP' };
  if (documentsDays > 0) return { action: 'DOCUMENTS', until: new Date(now.getTime() + documentsDays * 86400e3) };
  return { action: 'DEACTIVATE' };
}

export async function deactivateTerminatedLogins(db: PrismaClient, opts: { dryRun?: boolean; now?: Date } = {}): Promise<JobSummary> {
  const now = opts.now ?? new Date();
  const graceDays = await terminatedAccessDays(db);
  const documentsDays = await terminatedDocumentsDays(db);
  const candidates = await db.employee.findMany({
    where: { isTerminated: true, userId: { not: null }, user: { is: { isActive: true } } },
    select: { id: true, userId: true, terminationDate: true, updatedAt: true, user: { select: { documentsOnlyUntil: true } } },
  });
  const plan = candidates.map((e) => ({
    e,
    step: terminatedLoginAction({ documentsOnlyUntil: e.user?.documentsOnlyUntil ?? null }, e.terminationDate ?? e.updatedAt, graceDays, documentsDays, now),
  }));
  const due = plan.filter((p) => p.step.action === 'DEACTIVATE');
  const toDocuments = plan.filter((p) => p.step.action === 'DOCUMENTS');
  const summary = {
    graceDays,
    documentsDays,
    activeLoginsOfTerminated: candidates.length,
    due: due.length,
    toDocumentsOnly: toDocuments.length,
    deactivated: 0,
    documentsOnly: 0,
    stillInGrace: candidates.length - due.length - toDocuments.length,
  };
  if (opts.dryRun) return { ...summary, dryRun: true };
  // Full access over, documents window not: documents-only until the window ends (sessions revoked).
  for (const { e, step } of toDocuments) {
    if (step.action !== 'DOCUMENTS' || !e.userId) continue;
    const userId = e.userId;
    summary.documentsOnly += await db.$transaction(async (tx) => {
      const res = await tx.user.updateMany({
        where: { id: userId, isActive: true, documentsOnlyUntil: null },
        data: { documentsOnlyUntil: step.until, sessionVersion: { increment: 1 } },
      });
      if (res.count > 0) {
        const details = { field: 'documentsOnlyUntil', to: step.until.toISOString(), reason: 'terminated_access_expired', employeeId: e.id, graceDays, documentsDays, job: DEACTIVATE_TERMINATED_JOB };
        await logAudit({ userId: null, action: 'UPDATE', entityType: 'User', entityId: userId, details }, tx);
      }
      return res.count;
    });
  }
  for (const { e } of due) {
    if (!e.userId) continue;
    const userId = e.userId;
    summary.deactivated += await db.$transaction(async (tx) => {
      const res = await tx.user.updateMany({
        where: { id: userId, isActive: true },
        data: { isActive: false, documentsOnlyUntil: null, sessionVersion: { increment: 1 } },
      });
      if (res.count > 0) {
        const details = { field: 'isActive', to: false, reason: 'terminated_access_expired', employeeId: e.id, graceDays, job: DEACTIVATE_TERMINATED_JOB };
        await logAudit({ userId: null, action: 'UPDATE', entityType: 'User', entityId: userId, details }, tx);
      }
      return res.count;
    });
  }
  return summary;
}

export const deactivateTerminatedJob: JobDefinition<SystemContext> = {
  name: DEACTIVATE_TERMINATED_JOB,
  description: 'Ends the logins of terminated employees after the grace and documents-only windows',
  crossCompany: true,
  run: (ctx) => deactivateTerminatedLogins(ctx.db, { dryRun: ctx.dryRun, now: ctx.now }),
};

// ---------------------------------------------------------------------------------------------------
// Recipients of the administrative alert emails (expiry digest, documents integrity).
// ---------------------------------------------------------------------------------------------------

export const ALERT_RECIPIENT_ROLES_SETTING = 'expiry_digest_roles';
const DEFAULT_ALERT_RECIPIENT_ROLES: AppRole[] = ['SUPER_ADMIN', 'COMPANY_ADMIN'];

/** SystemSetting expiry_digest_roles (comma list); default owners / admins; never EMPLOYEE (org-wide counts). */
export function parseDigestRoles(value: string | null | undefined): AppRole[] {
  const known = new Set<string>(ALL_ROLES);
  const roles = String(value ?? '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter((r) => known.has(r) && r !== 'EMPLOYEE') as AppRole[];
  return roles.length ? [...new Set(roles)] : DEFAULT_ALERT_RECIPIENT_ROLES;
}

export interface AlertRecipient {
  id: string;
  email: string;
  role: AppRole;
  employeeId: string | null;
}

/** Active users with an alert role and a valid address, excluding anyone linked to a terminated employee. */
export async function alertRecipients(db: PrismaClient | Prisma.TransactionClient): Promise<{ roles: AppRole[]; users: AlertRecipient[] }> {
  const setting = await db.systemSetting.findUnique({ where: { key: ALERT_RECIPIENT_ROLES_SETTING }, select: { value: true } });
  const roles = parseDigestRoles(setting?.value);
  const users = await db.user.findMany({
    where: { isActive: true, role: { in: roles }, OR: [{ employeeProfile: { is: null } }, { employeeProfile: { is: { isTerminated: false } } }] },
    select: { id: true, email: true, role: true, employeeProfile: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    roles,
    users: users
      .filter((u) => isOutboxEmailAddress(u.email))
      .map((u) => ({ id: u.id, email: u.email, role: u.role as AppRole, employeeId: u.employeeProfile?.id ?? null })),
  };
}

/**
 * outbox-dispatch re-check right before sending: a digest queued for a user who has since been
 * deactivated or terminated is not sent. Other messages are sent as queued.
 */
export async function outboxRecipientStillActive(db: PrismaClient, message: { idempotencyKey: string }): Promise<boolean> {
  const m = /^expiry-digest:([^:]+):/.exec(message.idempotencyKey);
  if (!m) return true;
  const user = await db.user.findUnique({ where: { id: m[1] }, select: { isActive: true, employeeProfile: { select: { isTerminated: true } } } });
  return !!user && user.isActive && !user.employeeProfile?.isTerminated;
}
