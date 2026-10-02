import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { decryptField } from '@/lib/crypto';
import { forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { resolveSelfContext } from '@/lib/employee-scope';
import {
  cancelFinancialChange,
  confirmLegacyFinancialChange,
  FINANCIAL_CHANGE_SELECT,
  financialChangeView,
  runCompensationTransaction,
} from '@/modules/compensation';
import { authz, resolveActor, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/**
 * GET /api/portal/financial-changes — the employee's own financial change requests (SelfContext). A
 * migrated legacy IBAN request (LEGACY_UNVERIFIED, req-to-be §17 C11) shows the FULL IBAN and the bank
 * to its own employee only, so he can confirm it knowingly; every other request shows the masked IBAN.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const self = await resolveSelfContext(prisma, await resolveActor(prisma, user));
    authz.assert(self, 'portal.self.read');
    const db = scopedPrisma(self) as unknown as PrismaClient;
    const rows = await db.employeeFinancialChange.findMany({
      where: { employeeId: self.employeeId },
      orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
      take: 50,
      select: { ...FINANCIAL_CHANGE_SELECT, ibanEncrypted: true },
    });
    const changes = rows.map(({ ibanEncrypted, ...r }) => ({
      ...financialChangeView(r),
      ibanToConfirm: r.status === 'LEGACY_UNVERIFIED' ? safeDecrypt(ibanEncrypted) : null,
    }));
    return NextResponse.json({ changes });
  } catch (err) {
    return handleApiError(err, 'portal/financial-changes:GET');
  }
}

function safeDecrypt(v: string | null): string | null {
  if (!v) return null;
  try {
    return decryptField(v);
  } catch {
    return null;
  }
}

const actionSchema = z.object({
  id: zId,
  action: z.enum(['CONFIRM', 'CANCEL']),
  note: zOptText(500),
});

/**
 * POST /api/portal/financial-changes { id, action } — CONFIRM: the employee confirms his migrated IBAN
 * request, which becomes his own PENDING request for a second person; CANCEL: he withdraws his own
 * request not applied yet. Only the session employee's rows (another one's is "not found").
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const self = await resolveSelfContext(prisma, await resolveActor(prisma, user));
    authz.assert(self, 'portal.self.request');
    const b = await parseBody(req, actionSchema);
    const db = scopedPrisma(self) as unknown as PrismaClient;
    const row = await db.employeeFinancialChange.findFirst({ where: { id: b.id, employeeId: self.employeeId }, select: { id: true, requestedById: true, status: true } });
    if (!row) throw notFound('الطلب غير موجود');
    const actor = { id: user.id, role: user.role, employeeId: self.employeeId };
    const key = `portal.financialChange.${b.action.toLowerCase()}:${b.id}:${user.id}`;
    if (b.action === 'CONFIRM') {
      const r = await runCompensationTransaction(prisma, (tx) => confirmLegacyFinancialChange(tx, { actor, changeId: b.id, operationKey: key, ipAddress: getClientIp(req) }));
      return NextResponse.json({ message: 'تم تأكيد طلب تغيير الآيبان، وهو الآن بانتظار اعتماد شخص ثانٍ', change: r.change });
    }
    if (row.status !== 'LEGACY_UNVERIFIED' && row.requestedById !== user.id) throw forbidden('لا يمكنك إلغاء طلب لم تقدّمه');
    const r = await runCompensationTransaction(prisma, (tx) => cancelFinancialChange(tx, { actor, changeId: b.id, reason: b.note ?? 'سحبه الموظف', operationKey: key, ipAddress: getClientIp(req) }));
    return NextResponse.json({ message: 'تم سحب الطلب', change: r.change });
  } catch (err) {
    return handleApiError(err, 'portal/financial-changes:POST');
  }
}
