// Renewal bookkeeping shared by the manual renewals queue (src/app/api/renewals/action/route.ts)
// and the Muqeem renewals of this folder, so both leave the same trail. Server-only.
import 'server-only';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Serializes every renewal action on one document (released at commit / rollback). */
export async function lockRenewalDocument(tx: Tx, entityId: string, documentType: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`renewal:${entityId}:${documentType}`}))`;
}

/**
 * A renewal was confirmed (new expiry written): close the PAID fee requests of the document and
 * drop its PENDING_PAYMENT markers, so it leaves the renewals queue.
 */
export async function closeRenewalPaymentMarkers(tx: Tx, entityId: string, documentType: string): Promise<void> {
  await tx.paymentRequest.updateMany({
    where: { entityId, documentType, status: 'PAID' },
    data: { status: 'COMPLETED' },
  });
  await tx.renewalArchive.deleteMany({
    where: { entityId, documentType, action: 'PENDING_PAYMENT' },
  });
}

/** Operations of the Muqeem feature that change each renewable employee document. */
export const MUQEEM_OPERATIONS_BY_DOCUMENT: Readonly<Record<string, readonly string[]>> = {
  IQAMA: ['IQAMA_RENEW'],
  PASSPORT: ['PASSPORT_RENEW', 'PASSPORT_EXTEND'],
};

/**
 * Muqeem transaction for this employee document whose outcome is not known (PENDING / UNKNOWN).
 * While one exists, the document must not be changed by another path: the pending Muqeem call
 * may have been executed, and changing the date would also change the next idempotency key.
 */
export async function findUnresolvedMuqeemTransaction(
  tx: Tx,
  employeeId: string,
  operations: readonly string[],
): Promise<{ id: string; operation: string; status: string; createdAt: Date } | null> {
  if (!operations.length) return null;
  return tx.muqeemTransaction.findFirst({
    where: { employeeId, operation: { in: [...operations] }, status: { in: ['PENDING', 'UNKNOWN'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, operation: true, status: true, createdAt: true },
  });
}

export const UNRESOLVED_MUQEEM_MESSAGE =
  'توجد عملية سابقة على منصة مقيم لهذا الموظف لم تُحسم نتيجتها (قد تكون قيد التنفيذ الآن أو انقطع الاتصال أثناءها). ' +
  'لا تُعِد المحاولة: تحقق من تقرير الخدمات التفاعلية في مقيم، ثم سوِّ العملية (نُفذت / لم تُنفذ) من بطاقة «مقيم» في ملف الموظف.';
