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

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const department = await prisma.department.findUnique({ where: { id }, include: { branch: true } });
    if (!department) throw notFound('القسم غير موجود');
    return NextResponse.json(department);
  } catch (err) {
    return handleApiError(err, 'departments/[id]:GET');
  }
}

const updateSchema = z.object({
  nameArabic: z.preprocess((v) => (v === '' || v === null ? undefined : v), zText(200).optional()),
  nameEnglish: zOptText(200),
  branchId: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(100).optional()),
});

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const { id } = await params;
    const b = await parseBody(req, updateSchema);

    if (b.branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: b.branchId }, select: { id: true } });
      if (!branch) throw badRequest('الفرع المحدد غير موجود');
    }

    const data = definedOnly(b);
    const updated = await prisma.department.update({ where: { id }, data });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Department',
      entityId: id,
      details: { fields: Object.keys(data) },
      ipAddress: getClientIp(req),
    });

    // Response shape kept: the department object itself.
    return NextResponse.json(updated);
  } catch (err) {
    return handleApiError(err, 'departments/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const { id } = await params;

    const department = await prisma.department.findUnique({
      where: { id },
      select: { id: true, nameArabic: true, _count: { select: { employees: true, jobRequests: true } } },
    });
    if (!department) throw notFound('القسم غير موجود');

    const blocked = deletionBlockers(
      'القسم',
      [
        ['موظف', department._count.employees],
        ['طلب احتياج وظيفي', department._count.jobRequests],
      ],
      false,
    );
    if (blocked) throw conflict(blocked, { counts: department._count });

    await prisma.department.delete({ where: { id } });

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'Department',
      entityId: id,
      details: { nameArabic: department.nameArabic },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم الحذف بنجاح' });
  } catch (err) {
    return handleApiError(err, 'departments/[id]:DELETE');
  }
}
