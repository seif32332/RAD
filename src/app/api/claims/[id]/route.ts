import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, definedOnly, handleApiError, notFound, parseBody, badRequest } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { roundMoney } from '@/lib/money';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { claimUpdateSchema, faultSharesValid } from '../_lib';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const claim = await prisma.accidentClaim.findUnique({
      where: { id },
      include: { vehicle: true },
    });
    if (!claim) throw notFound('المطالبة غير موجودة');
    return NextResponse.json({ message: 'تمت العملية بنجاح', data: claim });
  } catch (err) {
    return handleApiError(err, 'claims/[id]:GET');
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const body = await parseBody(req, claimUpdateSchema);

    const claim = await prisma.$transaction(async (tx) => {
      const existing = await tx.accidentClaim.findUnique({
        where: { id },
        select: { id: true, status: true, vehicleId: true, claimAmount: true, updatedAt: true, faultPercentageAgainst: true, faultPercentageFor: true },
      });
      if (!existing) throw notFound('المطالبة غير موجودة');
      // A partial edit is checked against the stored other share, not only the fields sent.
      const against = body.faultPercentageAgainst !== undefined ? body.faultPercentageAgainst : existing.faultPercentageAgainst;
      const forUs = body.faultPercentageFor !== undefined ? body.faultPercentageFor : existing.faultPercentageFor;
      if (!faultSharesValid(against, forUs)) throw badRequest('مجموع نسبتي الخطأ (علينا ولنا) يجب ألا يتجاوز 100%');

      if (body.vehicleId && body.vehicleId !== existing.vehicleId) {
        await ensureRefsExist(tx, { vehicleIds: [body.vehicleId] });
      }

      const data = definedOnly({
        ...body,
        claimAmount:
          body.claimAmount === undefined ? undefined : body.claimAmount === null ? null : roundMoney(body.claimAmount),
      });

      // Optimistic concurrency: the update only applies if nobody changed the claim since we
      // read it, so two concurrent status changes can't both be applied.
      const res = await tx.accidentClaim.updateMany({
        where: { id, updatedAt: existing.updatedAt },
        data,
      });
      if (res.count === 0) throw conflict('تم تعديل المطالبة من مستخدم آخر، يرجى تحديث الصفحة والمحاولة مجدداً');

      const statusChanged = body.status !== undefined && body.status !== existing.status;
      await logAudit(
        {
          userId: user.id,
          action: 'UPDATE',
          entityType: 'AccidentClaim',
          entityId: id,
          details: {
            fields: Object.keys(data),
            ...(statusChanged ? { statusFrom: existing.status, statusTo: body.status } : {}),
            ...(data.claimAmount !== undefined && data.claimAmount !== existing.claimAmount
              ? { claimAmountFrom: existing.claimAmount, claimAmountTo: data.claimAmount }
              : {}),
          },
          ipAddress: getClientIp(req),
        },
        tx,
      );

      return tx.accidentClaim.findUniqueOrThrow({ where: { id } });
    });

    return NextResponse.json({ message: 'تم تحديث المطالبة بنجاح', claim });
  } catch (err) {
    return handleApiError(err, 'claims/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;

    await prisma.$transaction(async (tx) => {
      const claim = await tx.accidentClaim.findUnique({ where: { id } });
      if (!claim) throw notFound('المطالبة غير موجودة');
      await tx.accidentClaim.delete({ where: { id } });
      // Full snapshot: claims are financial records, keep what was deleted in the audit trail.
      await logAudit(
        { userId: user.id, action: 'DELETE', entityType: 'AccidentClaim', entityId: id, details: claim, ipAddress: getClientIp(req) },
        tx,
      );
    });

    return NextResponse.json({ message: 'تم حذف المطالبة بنجاح' });
  } catch (err) {
    return handleApiError(err, 'claims/[id]:DELETE');
  }
}
