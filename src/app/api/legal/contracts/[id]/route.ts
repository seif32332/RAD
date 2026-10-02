import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { zDate, zOptDate, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

const CONTRACT_STATUSES = ['ACTIVE', 'EXPIRED', 'TERMINATED'] as const;

/** Partial update: blank required fields are ignored (never wiped). */
const patchSchema = z.object({
  title: z.preprocess(blankToUndefined, zText(300).optional()),
  firstParty: z.preprocess(blankToUndefined, zText(300).optional()),
  secondParty: z.preprocess(blankToUndefined, zText(300).optional()),
  startDate: z.preprocess(blankToUndefined, zDate.optional()),
  endDate: zOptDate,
  notes: zOptText(5000),
  contractAttachment: zOptText(2000),
  otherAttachment: zOptText(2000),
  status: z.preprocess(blankToUndefined, z.enum(CONTRACT_STATUSES).optional()),
});

// P1-SCOPE: every read and write goes through the scoped client, so a contract of a company outside
// the user's scope is "not found" (404), like a missing one.
type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.manage');
    const db = scopedPrisma(ctx);
    const { id } = await params;
    const data = await parseBody(req, patchSchema);

    const existing = await db.legalContract.findUnique({
      where: { id },
      select: { id: true, startDate: true, endDate: true },
    });
    if (!existing) throw notFound('العقد غير موجود');

    const update = definedOnly(data);
    const start = update.startDate ?? existing.startDate;
    const end = update.endDate !== undefined ? update.endDate : existing.endDate;
    if (end && end < start) throw badRequest('تاريخ نهاية العقد يجب أن يكون بعد تاريخ بدايته');

    await db.legalContract.update({ where: { id }, data: update });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'LegalContract',
      entityId: id,
      details: { fields: Object.keys(update) },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم تحديث العقد بنجاح.' });
  } catch (err) {
    return handleApiError(err, 'legal/contracts/[id]:PATCH');
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.manage');
    const db = scopedPrisma(ctx);
    const { id } = await params;

    // find + deleteMany (instead of delete) so a missing/already-deleted row is a clean 404
    // without a Prisma error log line.
    const deleted = await db.legalContract.findUnique({ where: { id }, select: { id: true, title: true, secondParty: true } });
    if (!deleted) throw notFound('العقد غير موجود');
    const res = await db.legalContract.deleteMany({ where: { id } });
    if (res.count === 0) throw notFound('العقد غير موجود');

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'LegalContract',
      entityId: id,
      details: { title: deleted.title, secondParty: deleted.secondParty },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حذف العقد بنجاح.' });
  } catch (err) {
    return handleApiError(err, 'legal/contracts/[id]:DELETE');
  }
}
