import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery, badRequest } from '@/lib/http';
import { zText, zOptText, zId } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const listQuery = z.object({ branchId: z.string().trim().max(100).optional() });

// GET - all departments (optionally ?branchId=)
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { branchId } = parseQuery(req, listQuery);

    const departments = await prisma.department.findMany({
      where: branchId ? { branchId } : undefined,
      include: {
        branch: { include: { company: { select: { nameArabic: true } } } },
        _count: { select: { employees: true } },
      },
      orderBy: { nameArabic: 'asc' },
    });

    return NextResponse.json(departments);
  } catch (err) {
    return handleApiError(err, 'departments:GET');
  }
}

const createSchema = z.object({
  branchId: zId,
  nameArabic: zText(200),
  nameEnglish: zOptText(200),
});

// POST - create department
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const b = await parseBody(req, createSchema);

    const branch = await prisma.branch.findUnique({ where: { id: b.branchId }, select: { id: true } });
    if (!branch) throw badRequest('الفرع المحدد غير موجود');

    const department = await prisma.department.create({
      data: { branchId: b.branchId, nameArabic: b.nameArabic, nameEnglish: b.nameEnglish ?? null },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Department',
      entityId: department.id,
      details: { nameArabic: department.nameArabic, branchId: department.branchId },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم إنشاء القسم بنجاح', department }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'departments:POST');
  }
}
