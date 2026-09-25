import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery, badRequest } from '@/lib/http';
import { zText, zOptText, zId } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

const listQuery = z.object({ companyId: z.string().trim().max(100).optional() });

// GET - all administrations (optionally ?companyId=)
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { companyId } = parseQuery(req, listQuery);

    const administrations = await prisma.administration.findMany({
      where: companyId ? { companyId } : undefined,
      include: {
        company: { select: { nameArabic: true } },
        _count: { select: { branches: true, employees: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(administrations);
  } catch (err) {
    return handleApiError(err, 'administrations:GET');
  }
}

const createSchema = z.object({
  companyId: zId,
  nameArabic: zText(200),
  nameEnglish: zOptText(200),
});

// POST - create administration
export async function POST(req: Request) {
  try {
    const user = await requireUser(WRITERS);
    const b = await parseBody(req, createSchema);

    const company = await prisma.company.findUnique({ where: { id: b.companyId }, select: { id: true } });
    if (!company) throw badRequest('الشركة المحددة غير موجودة');

    const administration = await prisma.administration.create({
      data: { companyId: b.companyId, nameArabic: b.nameArabic, nameEnglish: b.nameEnglish ?? null },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Administration',
      entityId: administration.id,
      details: { nameArabic: administration.nameArabic, companyId: administration.companyId },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم إنشاء الإدارة بنجاح', administration }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'administrations:POST');
  }
}
