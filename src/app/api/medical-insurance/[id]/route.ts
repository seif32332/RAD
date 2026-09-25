import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { zDate, zId, zMoney, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { zOptFileUrl } from '@/app/api/medical-insurance/file-url';

export const dynamic = 'force-dynamic';

/** Medical insurance is managed by HR and government relations (GOV includes HR_MANAGER). */
const INSURANCE_ROLES = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV])];

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

/** Partial update: blank required fields are ignored (never wiped); blank optional fields are cleared. */
const updateSchema = z.object({
  companyId: z.preprocess(blankToUndefined, zId.optional()),
  insuranceIssuer: z.preprocess(blankToUndefined, zText(300).optional()),
  policyNumber: z.preprocess(blankToUndefined, zText(100).optional()),
  policyCost: z.preprocess(blankToUndefined, zMoney.optional()),
  expiryDate: z.preprocess(blankToUndefined, zDate.optional()),
  medicalNetwork: zOptText(100),
  coverageType: zOptText(100),
  insuranceClass: zOptText(100),
  benefitsUrl: zOptFileUrl,
  coverageUrl: zOptFileUrl,
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    await requireUser(INSURANCE_ROLES);
    const { id } = await params;
    const item = await prisma.medicalInsurance.findUnique({
      where: { id },
      include: {
        company: { select: { nameArabic: true } },
      },
    });

    if (!item) throw notFound('الوثيقة غير موجودة');

    return NextResponse.json(item);
  } catch (err) {
    return handleApiError(err, 'medical-insurance/[id]:GET');
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const user = await requireUser(INSURANCE_ROLES);
    const { id } = await params;
    const body = await parseBody(req, updateSchema);

    const update = definedOnly({
      ...body,
      policyCost: body.policyCost !== undefined ? roundMoney(body.policyCost) : undefined,
    });

    if (update.companyId) {
      const company = await prisma.company.findUnique({ where: { id: update.companyId }, select: { id: true } });
      if (!company) throw notFound('الشركة غير موجودة');
    }

    const upd = await prisma.medicalInsurance.update({
      where: { id },
      data: update,
    });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'MedicalInsurance',
      entityId: id,
      details: { fields: Object.keys(update) },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(upd);
  } catch (err) {
    return handleApiError(err, 'medical-insurance/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const user = await requireUser(INSURANCE_ROLES);
    const { id } = await params;
    const del = await prisma.medicalInsurance.delete({
      where: { id },
    });

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'MedicalInsurance',
      entityId: id,
      details: { companyId: del.companyId, policyNumber: del.policyNumber },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(del);
  } catch (err) {
    return handleApiError(err, 'medical-insurance/[id]:DELETE');
  }
}
