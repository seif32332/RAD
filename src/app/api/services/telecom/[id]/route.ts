import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { employeeBriefSelect, ensureRefsExist, telecomUpdateSchema } from '../../_lib';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const sim = await prisma.telecomSim.findUnique({
      where: { id },
      include: {
        employee: { select: employeeBriefSelect },
        company: { select: { id: true, nameArabic: true } },
        branch: { select: { id: true, nameArabic: true } },
      },
    });
    if (!sim) throw notFound('الشريحة غير موجودة');
    return NextResponse.json({ message: 'تمت العملية بنجاح', data: sim });
  } catch (err) {
    return handleApiError(err, 'services/telecom/[id]:GET');
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const body = await parseBody(req, telecomUpdateSchema);

    const sim = await prisma.$transaction(async (tx) => {
      const existing = await tx.telecomSim.findUnique({ where: { id }, select: { id: true, employeeId: true } });
      if (!existing) throw notFound('الشريحة غير موجودة');

      const [, duplicate] = await Promise.all([
        ensureRefsExist(tx, {
          companyIds: [body.companyId],
          branchIds: [body.branchId],
          employeeIds: [body.employeeId],
        }),
        body.simNumber
          ? tx.telecomSim.findFirst({ where: { simNumber: body.simNumber, id: { not: id } }, select: { id: true } })
          : null,
      ]);
      if (duplicate) throw conflict('رقم الشريحة مسجل مسبقاً');
      // Re-assigning the SIM: the new holder must be an active employee (same rule as creation).
      if (body.employeeId && body.employeeId !== existing.employeeId) {
        await ensureRefsExist(tx, { employeeIds: [body.employeeId] }, { activeOnly: true });
      }

      const data = definedOnly(body);
      const updated = await tx.telecomSim.update({ where: { id }, data });
      await logAudit(
        {
          userId: user.id,
          action: 'UPDATE',
          entityType: 'TelecomSim',
          entityId: id,
          details: {
            fields: Object.keys(data),
            ...(data.employeeId !== undefined && data.employeeId !== existing.employeeId
              ? { employeeFrom: existing.employeeId, employeeTo: data.employeeId }
              : {}),
          },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return updated;
    });

    return NextResponse.json({ message: 'تم تحديث الشريحة بنجاح', sim });
  } catch (err) {
    return handleApiError(err, 'services/telecom/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;

    await prisma.$transaction(async (tx) => {
      const sim = await tx.telecomSim.findUnique({
        where: { id },
        select: { simNumber: true, provider: true, employeeId: true },
      });
      if (!sim) throw notFound('الشريحة غير موجودة');
      await tx.telecomSim.delete({ where: { id } });
      await logAudit(
        { userId: user.id, action: 'DELETE', entityType: 'TelecomSim', entityId: id, details: sim, ipAddress: getClientIp(req) },
        tx,
      );
    });

    return NextResponse.json({ message: 'تم حذف الشريحة بنجاح' });
  } catch (err) {
    return handleApiError(err, 'services/telecom/[id]:DELETE');
  }
}
