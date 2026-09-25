import { NextResponse } from 'next/server';
import { ClaimStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { roundMoney } from '@/lib/money';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { claimCreateSchema, claimVehicleInclude } from './_lib';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const claims = await prisma.accidentClaim.findMany({
      include: claimVehicleInclude,
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(claims);
  } catch (err) {
    return handleApiError(err, 'claims:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const body = await parseBody(req, claimCreateSchema);

    const claim = await prisma.$transaction(async (tx) => {
      await ensureRefsExist(tx, { vehicleIds: [body.vehicleId] });
      const created = await tx.accidentClaim.create({
        data: {
          vehicleId: body.vehicleId,
          faultPercentageAgainst: body.faultPercentageAgainst ?? null,
          faultPercentageFor: body.faultPercentageFor ?? null,
          claimAmount: body.claimAmount != null ? roundMoney(body.claimAmount) : null,
          insuranceCompany: body.insuranceCompany ?? null,
          status: body.status ?? ClaimStatus.PENDING_SUBMISSION,
          najmReportUrl: body.najmReportUrl ?? null,
          estimatesUrl: body.estimatesUrl ?? null,
          accidentPhotosUrl: body.accidentPhotosUrl ?? null,
          ibanUrl: body.ibanUrl ?? null,
          otherAttachmentsUrl: body.otherAttachmentsUrl ?? null,
        },
      });
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'AccidentClaim',
          entityId: created.id,
          details: { vehicleId: created.vehicleId, status: created.status, claimAmount: created.claimAmount },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    return NextResponse.json({ message: 'تم إنشاء المطالبة بنجاح', claim }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'claims:POST');
  }
}
