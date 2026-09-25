import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const OWNER_REQUEST_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'] as const;

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.OWNER);
    const requests = await prisma.ownerRequest.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(requests);
  } catch (err) {
    return handleApiError(err, 'owner-portal/requests:GET');
  }
}

const createSchema = z.object({
  title: zText(300),
  details: zText(20_000),
  assignedTo: zOptText(300),
  status: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(OWNER_REQUEST_STATUSES).optional()),
  attachmentUrl: zOptText(2000),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.OWNER);
    const body = await parseBody(req, createSchema);

    const created = await prisma.ownerRequest.create({
      data: {
        title: body.title,
        details: body.details,
        assignedTo: body.assignedTo ?? null,
        status: body.status ?? 'PENDING',
        attachmentUrl: body.attachmentUrl ?? null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'OwnerRequest',
      entityId: created.id,
      details: { title: created.title, assignedTo: created.assignedTo },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم إرسال الطلب / التوجيه بنجاح', data: created }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'owner-portal/requests:POST');
  }
}
