import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { ensureRefsExist, utilityCreateSchema } from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const meters = await prisma.utilityMeter.findMany({
      include: {
        branch: { select: { nameArabic: true } },
        legalCompany: { select: { nameArabic: true } },
        actualCompany: { select: { nameArabic: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(meters);
  } catch (err) {
    return handleApiError(err, 'services/utilities:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const body = await parseBody(req, utilityCreateSchema);

    const meter = await prisma.$transaction(async (tx) => {
      await ensureRefsExist(tx, {
        branchIds: [body.branchId],
        companyIds: [body.legalCompanyId, body.actualCompanyId],
      });
      const created = await tx.utilityMeter.create({
        data: {
          meterCode: body.meterCode ?? null,
          meterNumber: body.meterNumber,
          accountNumber: body.accountNumber ?? null,
          meterPhotoUrl: body.meterPhotoUrl ?? null,
          branchId: body.branchId ?? null,
          legalCompanyId: body.legalCompanyId ?? null,
          actualCompanyId: body.actualCompanyId ?? null,
        },
      });
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'UtilityMeter',
          entityId: created.id,
          details: { meterNumber: created.meterNumber, accountNumber: created.accountNumber },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    return NextResponse.json({ message: 'تم إضافة العداد بنجاح', meter }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'services/utilities:POST');
  }
}
