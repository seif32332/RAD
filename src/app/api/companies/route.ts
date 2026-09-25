import { NextResponse } from 'next/server';
import { randomInt } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, conflict } from '@/lib/http';
import { zText, zOptText, zDate, zOptDate, zOptMoney } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { isUniqueViolationOn } from '@/lib/employee';
import { zMoiNumber, zMuqeemPlatformId, moiNumberWarnings, assertMuqeemPlatformChange } from './_muqeem';

export const dynamic = 'force-dynamic';

/** Company admin + HR may manage companies. */
const WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

const createCompanySchema = z.object({
  nameArabic: zText(200),
  nameEnglish: zOptText(200),
  unifiedNumber: zOptText(50),
  commercialRegNum: zOptText(50),
  commercialRegUrl: zOptText(2000),
  commercialRegDate: zOptDate,
  commercialRegExp: zDate,
  commercialRegCost: zOptMoney,
  taxNumber: zOptText(50),
  molEstablishmentNumber: zOptText(50),
  gosiEstablishmentNumber: zOptText(50),
  taxCertificateUrl: zOptText(2000),
  nationalAddress: zOptText(500),
  nationalAddressUrl: zOptText(2000),
  establishmentDeedUrl: zOptText(2000),
  trademarkNumber: zOptText(100),
  trademarkRegDate: zOptDate,
  trademarkExpDate: zOptDate,
  trademarkCertUrl: zOptText(2000),
  trademarkCost: zOptMoney,
  // Muqeem link (see ./_muqeem.ts)
  moiNumber: zMoiNumber,
  muqeemPlatformId: zMuqeemPlatformId,
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(WRITERS);
    const b = await parseBody(req, createCompanySchema);
    await assertMuqeemPlatformChange(user, b.muqeemPlatformId, undefined);

    // commercialRegNum is unique and required by the schema: generate a placeholder when omitted.
    const commercialRegNum = b.commercialRegNum || `CR-${Date.now()}-${randomInt(1000)}`;

    const existing = await prisma.company.findUnique({ where: { commercialRegNum }, select: { id: true } });
    if (existing) throw conflict('رقم السجل التجاري مسجل مسبقاً في النظام');

    let company;
    try {
      company = await prisma.company.create({
        data: {
          nameArabic: b.nameArabic,
          nameEnglish: b.nameEnglish ?? null,
          unifiedNumber: b.unifiedNumber ?? null,
          commercialRegNum,
          commercialRegUrl: b.commercialRegUrl ?? null,
          commercialRegDate: b.commercialRegDate ?? null,
          commercialRegExp: b.commercialRegExp,
          commercialRegCost: b.commercialRegCost !== undefined ? roundMoney(b.commercialRegCost) : undefined,
          taxNumber: b.taxNumber ?? null,
          molEstablishmentNumber: b.molEstablishmentNumber ?? null,
          gosiEstablishmentNumber: b.gosiEstablishmentNumber ?? null,
          taxCertificateUrl: b.taxCertificateUrl ?? null,
          nationalAddress: b.nationalAddress ?? null,
          nationalAddressUrl: b.nationalAddressUrl ?? null,
          establishmentDeedUrl: b.establishmentDeedUrl ?? null,
          trademarkNumber: b.trademarkNumber ?? null,
          trademarkRegDate: b.trademarkRegDate ?? null,
          trademarkExpDate: b.trademarkExpDate ?? null,
          trademarkCertUrl: b.trademarkCertUrl ?? null,
          trademarkCost: b.trademarkCost !== undefined ? roundMoney(b.trademarkCost) : undefined,
          moiNumber: b.moiNumber ?? null,
          muqeemPlatformId: b.muqeemPlatformId ?? null,
        },
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'commercialRegNum')) throw conflict('رقم السجل التجاري مسجل مسبقاً في النظام');
      throw err;
    }

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Company',
      entityId: company.id,
      details: {
        nameArabic: company.nameArabic,
        commercialRegNum: company.commercialRegNum,
        moiNumber: company.moiNumber,
        muqeemLinked: !!company.muqeemPlatformId,
      },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(
      { message: 'تم إضافة الشركة بنجاح', company, warnings: moiNumberWarnings(company.moiNumber, company.muqeemPlatformId) },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err, 'companies:POST');
  }
}

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const companies = await prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { legalEmployees: true, actualEmployees: true, branches: true, administrations: true } },
      },
    });
    return NextResponse.json(companies);
  } catch (err) {
    return handleApiError(err, 'companies:GET');
  }
}
