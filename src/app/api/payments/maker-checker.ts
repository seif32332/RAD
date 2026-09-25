// Server side of the payment maker-checker rule (see decideMakerChecker in ./access.ts).
import 'server-only';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '@/lib/auth';
import { forbidden } from '@/lib/http';
import {
  ALLOW_SELF_APPROVAL_SETTING,
  SELF_APPROVAL_AUDIT_ACTION,
  decideMakerChecker,
  parseBooleanSetting,
  type MakerCheckerStep,
} from './access';

/** SystemSetting allow_self_approval (default false). */
export async function isSelfApprovalAllowed(db: Prisma.TransactionClient): Promise<boolean> {
  const row = await db.systemSetting.findUnique({ where: { key: ALLOW_SELF_APPROVAL_SETTING }, select: { value: true } });
  return parseBooleanSetting(row?.value);
}

/**
 * Throws 403 when `user` created the payment request and may not approve / pay it.
 * An allowed self-approval (SUPER_ADMIN, or allow_self_approval='true') writes an AuditLog row with
 * action SELF_APPROVAL_OVERRIDE in the same transaction. Returns the decision basis so the caller
 * can record it (e.g. UNKNOWN_REQUESTER for legacy rows) in its own audit details.
 */
export async function enforceMakerChecker(
  tx: Prisma.TransactionClient,
  step: MakerCheckerStep,
  user: Pick<AuthUser, 'id' | 'role'>,
  payment: { id: string; requestedById: string | null },
  ipAddress: string | null,
): Promise<'DIFFERENT_USER' | 'UNKNOWN_REQUESTER' | 'SUPER_ADMIN_OVERRIDE' | 'SETTING_ALLOW_SELF_APPROVAL'> {
  // Only read the setting when it can matter (same user, not SUPER_ADMIN).
  const needsSetting = !!payment.requestedById && payment.requestedById === user.id && user.role !== 'SUPER_ADMIN';
  const decision = decideMakerChecker({
    step,
    actorId: user.id,
    actorRole: user.role,
    requestedById: payment.requestedById,
    allowSelfApproval: needsSetting ? await isSelfApprovalAllowed(tx) : false,
  });
  if (!decision.ok) throw forbidden(decision.message);
  if (decision.basis === 'SUPER_ADMIN_OVERRIDE' || decision.basis === 'SETTING_ALLOW_SELF_APPROVAL') {
    // Written directly: SELF_APPROVAL_OVERRIDE is not one of the generic AuditAction values.
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: SELF_APPROVAL_AUDIT_ACTION,
        entityType: 'PaymentRequest',
        entityId: payment.id,
        details: JSON.stringify({ step, basis: decision.basis, requestedById: payment.requestedById, role: user.role }),
        ipAddress,
      },
    });
  }
  return decision.basis;
}
