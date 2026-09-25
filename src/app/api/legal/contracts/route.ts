import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseBody } from '@/lib/http';
import { zDate, zOptDate, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  title: zText(300),
  firstParty: zText(300),
  secondParty: zText(300),
  startDate: zDate,
  endDate: zOptDate,
  notes: zOptText(5000),
  contractAttachment: zOptText(2000),
  otherAttachment: zOptText(2000),
});

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.LEGAL);
    const contracts = await prisma.legalContract.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(contracts);
  } catch (err) {
    return handleApiError(err, 'legal/contracts:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const data = await parseBody(req, createSchema);
    if (data.endDate && data.endDate < data.startDate) {
      throw badRequest('تاريخ نهاية العقد يجب أن يكون بعد تاريخ بدايته');
    }

    const createdContract = await prisma.legalContract.create({
      data: {
        title: data.title,
        firstParty: data.firstParty,
        secondParty: data.secondParty,
        startDate: data.startDate,
        endDate: data.endDate ?? null,
        notes: data.notes ?? null,
        contractAttachment: data.contractAttachment ?? null,
        otherAttachment: data.otherAttachment ?? null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'LegalContract',
      entityId: createdContract.id,
      details: { title: createdContract.title, secondParty: createdContract.secondParty },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حفظ وتوثيق العقد بالمنصة القانونية', data: createdContract });
  } catch (err) {
    return handleApiError(err, 'legal/contracts:POST');
  }
}
