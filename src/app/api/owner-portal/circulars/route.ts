import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const CIRCULAR_STATUSES = ['PUBLISHED', 'DRAFT'] as const;

export async function GET() {
  try {
    // Published circulars are visible to every employee; drafts only to the owner.
    const user = await requireUser(ROLE_GROUPS.ALL);
    const isOwner = hasRole(user, ROLE_GROUPS.OWNER);
    const circulars = await prisma.circular.findMany({
      where: isOwner ? undefined : { status: 'PUBLISHED' },
      orderBy: { datePublished: 'desc' },
    });
    return NextResponse.json(circulars);
  } catch (err) {
    return handleApiError(err, 'owner-portal/circulars:GET');
  }
}

const createSchema = z.object({
  title: zText(300),
  content: zText(20_000),
  issuedBy: zOptText(200),
  status: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(CIRCULAR_STATUSES).optional()),
  attachmentUrl: zOptText(2000),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.OWNER);
    const body = await parseBody(req, createSchema);

    const created = await prisma.circular.create({
      data: {
        title: body.title,
        content: body.content,
        issuedBy: body.issuedBy || user.name,
        status: body.status ?? 'PUBLISHED',
        attachmentUrl: body.attachmentUrl ?? null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Circular',
      entityId: created.id,
      details: { title: created.title, status: created.status },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم إصدار التعميم بنجاح', data: created }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'owner-portal/circulars:POST');
  }
}
