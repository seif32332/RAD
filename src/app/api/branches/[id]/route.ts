import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, notFound, conflict, badRequest, definedOnly } from '@/lib/http';
import { zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { branchFieldsSchema, deletionBlockers } from '@/lib/employee';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

/** P1-SCOPE: the user's company context; a branch of another company is "not found" (404). */
async function orgScope(user: Awaited<ReturnType<typeof requireUser>>, action: 'org.read' | 'org.manage') {
  const ctx = scopedContext(await resolveActor(prisma, user));
  authz.assert(ctx, action);
  return { ctx, db: scopedPrisma(ctx) };
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const { ctx, db } = await orgScope(user, 'org.read');
    const branch = await db.branch.findUnique({
      where: { id },
      include: {
        company: { select: { nameArabic: true } },
        administration: { select: { id: true, nameArabic: true } },
        departments: true,
        workSchedules: true,
        // Only the employees of the user's companies (an employee registered on another company
        // may work in this branch).
        employees: {
          where: scopeWhere(ctx, 'Employee') ?? undefined,
          select: { id: true, firstNameArabic: true, lastNameArabic: true, jobTitle: true },
        },
      },
    });
    if (!branch) throw notFound('الفرع غير موجود');
    return NextResponse.json(branch);
  } catch (err) {
    return handleApiError(err, 'branches/[id]:GET');
  }
}

const updateSchema = branchFieldsSchema.extend({
  companyId: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(100).optional()),
  nameArabic: z.preprocess((v) => (v === '' || v === null ? undefined : v), zText(200).optional()),
});

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;
    const b = await parseBody(req, updateSchema);
    const { ctx, db } = await orgScope(user, 'org.manage');

    const current = await db.branch.findUnique({ where: { id }, select: { id: true, companyId: true, administrationId: true } });
    if (!current) throw notFound('الفرع غير موجود');

    const companyId = b.companyId ?? current.companyId;
    if (b.companyId && b.companyId !== current.companyId) {
      // Moving a branch to another company: that company must be one of the user's (403).
      authz.assert(ctx, 'org.manage', { companyId: b.companyId });
      const company = await db.company.findUnique({ where: { id: b.companyId }, select: { id: true } });
      if (!company) throw badRequest('الشركة المحددة غير موجودة');
    }
    if (b.administrationId) {
      const admin = await db.administration.findUnique({ where: { id: b.administrationId }, select: { companyId: true } });
      if (!admin || admin.companyId !== companyId) throw badRequest('الإدارة المحددة غير موجودة أو لا تتبع الشركة المختارة');
    }

    const data = definedOnly({
      ...b,
      rentContractAmount: typeof b.rentContractAmount === 'number' ? roundMoney(b.rentContractAmount) : b.rentContractAmount,
      munLicenseCost: b.munLicenseCost !== undefined ? roundMoney(b.munLicenseCost) : undefined,
      civilDefenseCost: b.civilDefenseCost !== undefined ? roundMoney(b.civilDefenseCost) : undefined,
    });

    const branch = await db.branch.update({ where: { id }, data });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Branch',
      entityId: id,
      details: { fields: Object.keys(data) },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم التحديث بنجاح', branch });
  } catch (err) {
    return handleApiError(err, 'branches/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;
    const { db } = await orgScope(user, 'org.manage');

    const branch = await db.branch.findUnique({
      where: { id },
      select: {
        id: true,
        nameArabic: true,
        _count: { select: { employees: true, departments: true, telecomSims: true, utilityMeters: true, violations: true } },
      },
    });
    if (!branch) throw notFound('الفرع غير موجود');

    const c = branch._count;
    const blocked = deletionBlockers(
      'الفرع',
      [
        ['موظف', c.employees],
        ['قسم', c.departments],
        ['شريحة اتصال', c.telecomSims],
        ['عداد كهرباء/مياه', c.utilityMeters],
        ['مخالفة التزام', c.violations],
      ],
      false,
    );
    if (blocked) throw conflict(blocked, { counts: c });

    // Work schedules belong to the branch and are removed with it (onDelete: Cascade).
    await db.branch.delete({ where: { id } });

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'Branch',
      entityId: id,
      details: { nameArabic: branch.nameArabic },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حذف الفرع بنجاح' });
  } catch (err) {
    return handleApiError(err, 'branches/[id]:DELETE');
  }
}
