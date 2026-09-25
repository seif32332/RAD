import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseBody } from '@/lib/http';
import { zDate, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

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
});

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.LEGAL);
    const agencies = await prisma.certifiedAgency.findMany({
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
    const data = await parseBody(req, createSchema);
    if (data.endDate < data.startDate) throw badRequest('تاريخ انتهاء الوكالة يجب أن يكون بعد تاريخ بدايتها');

    const newAgency = await prisma.certifiedAgency.create({
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
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'CertifiedAgency',
      entityId: newAgency.id,
      details: { agencyNumber: newAgency.agencyNumber, endDate: newAgency.endDate },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حفظ الوكالة واعتمادها بنجاح', data: newAgency });
  } catch (err) {
    return handleApiError(err, 'legal/agencies:POST');
  }
}
