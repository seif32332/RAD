import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseBody } from '@/lib/http';
import { zDate, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { recordCompanyId } from '@/lib/record-company';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  agencyNumber: zText(100),
  principalName: zText(200),
  principalId: zText(50),
  agentName: zText(200),
  agentId: zText(50),
  startDate: zDate,
  endDate: zDate,
  attachmentUrl: zOptText(2000),
  /** The company party to the agency (P1-SCOPE); defaults to the user's only company. */
  companyId: zOptText(100),
});

/** Agencies of the user's companies (P1-SCOPE: CertifiedAgency.companyId, scoped client). */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.read');
    const agencies = await scopedPrisma(ctx).certifiedAgency.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(agencies);
  } catch (err) {
    return handleApiError(err, 'legal/agencies:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.manage');
    const data = await parseBody(req, createSchema);
    if (data.endDate < data.startDate) throw badRequest('تاريخ انتهاء الوكالة يجب أن يكون بعد تاريخ بدايتها');
    const companyId = await recordCompanyId(prisma, ctx, data.companyId);

    const newAgency = await scopedPrisma(ctx).certifiedAgency.create({
      data: {
        agencyNumber: data.agencyNumber,
        principalName: data.principalName,
        principalId: data.principalId,
        agentName: data.agentName,
        agentId: data.agentId,
        startDate: data.startDate,
        endDate: data.endDate,
        attachmentUrl: data.attachmentUrl ?? null,
        status: 'ACTIVE',
        companyId,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'CertifiedAgency',
      entityId: newAgency.id,
      details: { agencyNumber: newAgency.agencyNumber, endDate: newAgency.endDate, companyId },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حفظ الوكالة واعتمادها بنجاح', data: newAgency });
  } catch (err) {
    return handleApiError(err, 'legal/agencies:POST');
  }
}
