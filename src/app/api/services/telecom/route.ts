import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { ensureRefsExist, telecomCreateSchema, wantsHeldByTerminated } from '../_lib';

export const dynamic = 'force-dynamic';

/** Lists SIMs. `?heldByTerminated=1` keeps only SIMs still held by employees whose service has ended. */
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const heldByTerminated = wantsHeldByTerminated(req.url);
    const sims = await prisma.telecomSim.findMany({
      where: heldByTerminated ? { employee: { isTerminated: true } } : undefined,
      include: {
        company: { select: { nameArabic: true } },
        branch: { select: { nameArabic: true } },
        employee: {
          select: {
            firstNameArabic: true,
            lastNameArabic: true,
            employeeId: true,
            isTerminated: true,
            department: { select: { nameArabic: true } },
            branch: { select: { nameArabic: true } },
            legalCompany: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(sims);
  } catch (err) {
    return handleApiError(err, 'services/telecom:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const body = await parseBody(req, telecomCreateSchema);

    const sim = await prisma.$transaction(async (tx) => {
      const [, duplicate] = await Promise.all([
        ensureRefsExist(tx, {
          companyIds: [body.companyId],
          branchIds: [body.branchId],
          employeeIds: [body.employeeId],
        }, { activeOnly: true }),
        tx.telecomSim.findFirst({ where: { simNumber: body.simNumber }, select: { id: true } }),
      ]);
      if (duplicate) throw conflict('رقم الشريحة مسجل مسبقاً');

      const created = await tx.telecomSim.create({
        data: {
          simNumber: body.simNumber,
          accountNumber: body.accountNumber ?? null,
          provider: body.provider ?? null,
          plan: body.plan ?? null,
          serviceType: body.serviceType ?? null,
          companyId: body.companyId ?? null,
          branchId: body.branchId ?? null,
          employeeId: body.employeeId ?? null,
        },
      });
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'TelecomSim',
          entityId: created.id,
          details: { simNumber: created.simNumber, employeeId: created.employeeId },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    return NextResponse.json({ message: 'تم إضافة الشريحة بنجاح', sim }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'services/telecom:POST');
  }
}
