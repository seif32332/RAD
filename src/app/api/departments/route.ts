import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery, badRequest } from '@/lib/http';
import { zText, zOptText, zId } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const listQuery = z.object({ branchId: z.string().trim().max(100).optional() });

// GET - the departments of the user's companies (optionally ?branchId=). P1-SCOPE: a department of
// another company is never listed (its branch's company is the scope key).
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { branchId } = parseQuery(req, listQuery);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'org.read');

    const departments = await scopedPrisma(ctx).department.findMany({
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
    const ctx = scopedContext(await resolveActor(prisma, user));
    const db = scopedPrisma(ctx);

    // P1-SCOPE: a branch of another company is "not found" (and the scoped create refuses it too).
    const branch = await db.branch.findUnique({ where: { id: b.branchId }, select: { id: true, companyId: true } });
    if (!branch) throw badRequest('الفرع المحدد غير موجود');
    authz.assert(ctx, 'org.manage', { companyId: branch.companyId });

    const department = await db.department.create({
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
