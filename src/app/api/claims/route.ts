import { NextResponse } from 'next/server';
import { ClaimStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { roundMoney } from '@/lib/money';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { claimCreateSchema, claimScopeWhere, claimVehicleInclude } from './_lib';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    // P1-SCOPE: claims of vehicles of the user's companies.
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.read');
    const claims = await prisma.accidentClaim.findMany({
      where: claimScopeWhere(ctx),
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
    // P1-SCOPE: the vehicle must belong to the user's companies (else "not found" as a bad reference).
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.manage');

    const claim = await prisma.$transaction(async (tx) => {
      await ensureRefsExist(tx, { vehicleIds: [body.vehicleId] });
      if (!(await scopedPrisma(ctx).vehicle.findUnique({ where: { id: body.vehicleId }, select: { id: true } }))) {
        throw badRequest('المركبة المحددة غير موجودة');
      }
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
