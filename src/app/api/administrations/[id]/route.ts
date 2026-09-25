import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, notFound, conflict, badRequest, definedOnly } from '@/lib/http';
import { zText, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { deletionBlockers } from '@/lib/employee';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const admin = await prisma.administration.findUnique({
      where: { id },
      include: {
        company: true,
        _count: { select: { branches: true, employees: true } },
      },
    });
    if (!admin) throw notFound('الإدارة غير موجودة');
    return NextResponse.json(admin);
  } catch (err) {
    return handleApiError(err, 'administrations/[id]:GET');
  }
}

const updateSchema = z.object({
  nameArabic: z.preprocess((v) => (v === '' || v === null ? undefined : v), zText(200).optional()),
  nameEnglish: zOptText(200),
  companyId: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(100).optional()),
});

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;
    const b = await parseBody(req, updateSchema);

    if (b.companyId) {
      const company = await prisma.company.findUnique({ where: { id: b.companyId }, select: { id: true } });
      if (!company) throw badRequest('الشركة المحددة غير موجودة');
    }

    const data = definedOnly(b);
    const admin = await prisma.administration.update({ where: { id }, data });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Administration',
      entityId: id,
      details: { fields: Object.keys(data) },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم التحديث', admin });
  } catch (err) {
    return handleApiError(err, 'administrations/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;

    const admin = await prisma.administration.findUnique({
      where: { id },
      select: { id: true, nameArabic: true, _count: { select: { branches: true, employees: true } } },
    });
    if (!admin) throw notFound('الإدارة غير موجودة');

    const blocked = deletionBlockers('الإدارة', [
      ['فرع', admin._count.branches],
      ['موظف', admin._count.employees],
    ]);
    if (blocked) throw conflict(blocked, { counts: admin._count });

    await prisma.administration.delete({ where: { id } });

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'Administration',
      entityId: id,
      details: { nameArabic: admin.nameArabic },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم الحذف' });
  } catch (err) {
    return handleApiError(err, 'administrations/[id]:DELETE');
  }
}
