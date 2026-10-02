import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import type { Prisma } from '@prisma/client';
import { definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { ensureRefsExist, logisticsScope, utilityUpdateSchema } from '../../_lib';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const { db } = await logisticsScope(user, 'logistics.read');
    const meter = await db.utilityMeter.findUnique({
      where: { id },
      include: {
        legalCompany: { select: { id: true, nameArabic: true } },
        actualCompany: { select: { id: true, nameArabic: true } },
        branch: { select: { id: true, nameArabic: true } },
      },
    });
    if (!meter) throw notFound('العداد غير موجود');
    return NextResponse.json(meter);
  } catch (err) {
    return handleApiError(err, 'services/utilities/[id]:GET');
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const body = await parseBody(req, utilityUpdateSchema);
    const { db } = await logisticsScope(user, 'logistics.manage');

    // Scoped transaction (P1-SCOPE): another company's meter is "not found".
    const meter = await db.$transaction(async (scopedTx) => {
      const tx = scopedTx as unknown as Prisma.TransactionClient;
      const existing = await tx.utilityMeter.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw notFound('العداد غير موجود');
      await ensureRefsExist(tx, {
        branchIds: [body.branchId],
        companyIds: [body.legalCompanyId, body.actualCompanyId],
      });

      const data = definedOnly(body);
      const updated = await tx.utilityMeter.update({ where: { id }, data });
      await logAudit(
        {
          userId: user.id,
          action: 'UPDATE',
          entityType: 'UtilityMeter',
          entityId: id,
          details: { fields: Object.keys(data) },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return updated;
    });

    return NextResponse.json({ message: 'تم التحديث بنجاح', meter });
  } catch (err) {
    return handleApiError(err, 'services/utilities/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const { db } = await logisticsScope(user, 'logistics.manage');

    await db.$transaction(async (scopedTx) => {
      const tx = scopedTx as unknown as Prisma.TransactionClient;
      const meter = await tx.utilityMeter.findUnique({
        where: { id },
        select: { meterCode: true, meterNumber: true, accountNumber: true },
      });
      if (!meter) throw notFound('العداد غير موجود');
      await tx.utilityMeter.delete({ where: { id } });
      await logAudit(
        { userId: user.id, action: 'DELETE', entityType: 'UtilityMeter', entityId: id, details: meter, ipAddress: getClientIp(req) },
        tx,
      );
    });

    return NextResponse.json({ message: 'تم الحذف بنجاح' });
  } catch (err) {
    return handleApiError(err, 'services/utilities/[id]:DELETE');
  }
}
