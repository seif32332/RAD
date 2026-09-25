import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery, badRequest, definedOnly } from '@/lib/http';
import { zText, zId } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { branchFieldsSchema } from '@/lib/employee';

export const dynamic = 'force-dynamic';

const WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

const listQuery = z.object({ companyId: z.string().trim().max(100).optional() });

// GET - all branches (optionally ?companyId=)
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { companyId } = parseQuery(req, listQuery);

    const branches = await prisma.branch.findMany({
      where: companyId ? { companyId } : undefined,
      include: {
        company: { select: { nameArabic: true } },
        _count: { select: { employees: true, departments: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(branches);
  } catch (err) {
    return handleApiError(err, 'branches:GET');
  }
}

const createSchema = branchFieldsSchema.extend({
  companyId: zId,
  nameArabic: zText(200),
});

// POST - create branch
export async function POST(req: Request) {
  try {
    const user = await requireUser(WRITERS);
    const b = await parseBody(req, createSchema);

    const [company, administration] = await Promise.all([
      prisma.company.findUnique({ where: { id: b.companyId }, select: { id: true } }),
      b.administrationId
        ? prisma.administration.findUnique({ where: { id: b.administrationId }, select: { id: true, companyId: true } })
        : Promise.resolve(null),
    ]);
    if (!company) throw badRequest('الشركة المحددة غير موجودة');
    if (b.administrationId && (!administration || administration.companyId !== b.companyId)) {
      throw badRequest('الإدارة المحددة غير موجودة أو لا تتبع الشركة المختارة');
    }

    const branch = await prisma.branch.create({
      data: {
        ...definedOnly({
          ...b,
          rentContractAmount: typeof b.rentContractAmount === 'number' ? roundMoney(b.rentContractAmount) : b.rentContractAmount,
          munLicenseCost: b.munLicenseCost !== undefined ? roundMoney(b.munLicenseCost) : undefined,
          civilDefenseCost: b.civilDefenseCost !== undefined ? roundMoney(b.civilDefenseCost) : undefined,
        }),
        companyId: b.companyId,
        nameArabic: b.nameArabic,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Branch',
      entityId: branch.id,
      details: { nameArabic: branch.nameArabic, companyId: branch.companyId },
      ipAddress: getClientIp(req),
    });

    // `id` is read by the new-branch page to attach work schedules.
    return NextResponse.json({ message: 'تم إنشاء الفرع بنجاح', id: branch.id, branch }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'branches:POST');
  }
}
