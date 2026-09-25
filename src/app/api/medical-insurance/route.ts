import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zDate, zId, zMoney, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { zOptFileUrl } from '@/app/api/medical-insurance/file-url';

export const dynamic = 'force-dynamic';

/** Medical insurance is managed by HR and government relations (GOV includes HR_MANAGER). */
const INSURANCE_ROLES = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV])];

const querySchema = z.object({
  companyId: z.preprocess((v) => (v === '' ? undefined : v), zId.optional()),
});

const createSchema = z.object({
  companyId: zId,
  insuranceIssuer: zText(300),
  policyNumber: zText(100),
  policyCost: zMoney,
  expiryDate: zDate,
  medicalNetwork: zOptText(100),
  coverageType: zOptText(100),
  insuranceClass: zOptText(100),
  benefitsUrl: zOptFileUrl,
  coverageUrl: zOptFileUrl,
});

export async function GET(req: Request) {
  try {
    await requireUser(INSURANCE_ROLES);
    const { companyId } = parseQuery(req, querySchema);

    const items = await prisma.medicalInsurance.findMany({
      where: companyId ? { companyId } : {},
      include: {
        company: { select: { nameArabic: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(items);
  } catch (err) {
    return handleApiError(err, 'medical-insurance:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(INSURANCE_ROLES);
    const body = await parseBody(req, createSchema);

    const company = await prisma.company.findUnique({ where: { id: body.companyId }, select: { id: true } });
    if (!company) throw notFound('الشركة غير موجودة');

    const item = await prisma.medicalInsurance.create({
      data: {
        companyId: body.companyId,
        insuranceIssuer: body.insuranceIssuer,
        policyNumber: body.policyNumber,
        policyCost: roundMoney(body.policyCost),
        expiryDate: body.expiryDate,
        medicalNetwork: body.medicalNetwork ?? null,
        coverageType: body.coverageType ?? null,
        insuranceClass: body.insuranceClass ?? null,
        benefitsUrl: body.benefitsUrl ?? null,
        coverageUrl: body.coverageUrl ?? null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'MedicalInsurance',
      entityId: item.id,
      details: { companyId: item.companyId, policyNumber: item.policyNumber, expiryDate: item.expiryDate },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'medical-insurance:POST');
  }
}
