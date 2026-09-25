import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, notFound, conflict, definedOnly } from '@/lib/http';
import { zText, zOptText, zOptDate, zDate, zOptMoney } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { deletionBlockers, isUniqueViolationOn } from '@/lib/employee';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: { select: { legalEmployees: true, actualEmployees: true, branches: true, administrations: true } },
      },
    });
    if (!company) throw notFound('الشركة غير موجودة');
    return NextResponse.json(company);
  } catch (err) {
    return handleApiError(err, 'companies/[id]:GET');
  }
}

/** '' / null -> undefined (leave unchanged) for required columns. */
const keepIfEmpty = <S extends z.ZodTypeAny>(s: S) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

const updateCompanySchema = z.object({
  nameArabic: keepIfEmpty(zText(200)),
  nameEnglish: zOptText(200),
  unifiedNumber: zOptText(50),
  commercialRegNum: keepIfEmpty(zText(50)),
  commercialRegUrl: zOptText(2000),
  commercialRegDate: zOptDate,
  commercialRegExp: keepIfEmpty(zDate),
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
});

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;
    const b = await parseBody(req, updateCompanySchema);

    const data = definedOnly({
      ...b,
      commercialRegCost: b.commercialRegCost !== undefined ? roundMoney(b.commercialRegCost) : undefined,
      trademarkCost: b.trademarkCost !== undefined ? roundMoney(b.trademarkCost) : undefined,
    });

    let updated;
    try {
      updated = await prisma.company.update({ where: { id }, data });
    } catch (err) {
      if (isUniqueViolationOn(err, 'commercialRegNum')) throw conflict('رقم السجل التجاري مسجل مسبقاً لشركة أخرى');
      throw err;
    }

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Company',
      entityId: id,
      details: { fields: Object.keys(data) },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم تحديث الشركة بنجاح', company: updated });
  } catch (err) {
    return handleApiError(err, 'companies/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;

    const company = await prisma.company.findUnique({
      where: { id },
      select: {
        id: true,
        nameArabic: true,
        _count: {
          select: {
            legalEmployees: true,
            actualEmployees: true,
            administrations: true,
            branches: true,
            legalVehicles: true,
            actualVehicles: true,
            telecomSims: true,
            legalMeters: true,
            actualMeters: true,
            medicalInsurances: true,
            violations: true,
            documents: true,
          },
        },
      },
    });
    if (!company) throw notFound('الشركة غير موجودة');

    const c = company._count;
    const blocked = deletionBlockers('الشركة', [
      ['موظف (الشركة القانونية)', c.legalEmployees],
      ['موظف (الشركة الفعلية)', c.actualEmployees],
      ['إدارة', c.administrations],
      ['فرع', c.branches],
      ['مركبة', c.legalVehicles + c.actualVehicles],
      ['شريحة اتصال', c.telecomSims],
      ['عداد كهرباء/مياه', c.legalMeters + c.actualMeters],
      ['وثيقة تأمين طبي', c.medicalInsurances],
      ['مخالفة التزام', c.violations],
      ['مستند', c.documents],
    ]);
    if (blocked) throw conflict(blocked, { counts: c });

    await prisma.company.delete({ where: { id } });

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'Company',
      entityId: id,
      details: { nameArabic: company.nameArabic },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حذف الشركة بنجاح' });
  } catch (err) {
    return handleApiError(err, 'companies/[id]:DELETE');
  }
}
