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
import { today } from '@/lib/dates';
import { loadIqamaFeeRule } from '@/lib/workforce/load';
import { zMoiNumber, zMuqeemPlatformId, moiNumberWarnings, assertMuqeemPlatformChange } from '../_muqeem';
import {
  zNitaqatActivity,
  zNitaqatActivityKey,
  assertNitaqatActivityExists,
  zIsIndustrialLicensed,
  assertCompanyWorkforceChange,
  zOvertimeHourlyBasis,
  zMedicalPremiums,
  zIqamaFeeYear,
  assertCompanyCostChange,
} from '../_workforce';

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
        // Name only: never credentials.
        muqeemPlatform: { select: { id: true, platformName: true } },
      },
    });
    if (!company) throw notFound('الشركة غير موجودة');
    // The rule register iqama fee shown next to «رسوم الإقامة السنوية» (blank = this value).
    const iqamaFeeRule = await loadIqamaFeeRule(today());
    return NextResponse.json({ ...company, muqeemLinked: !!company.moiNumber && !!company.muqeemPlatformId, iqamaFeeRule });
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
  // Muqeem link (see ../_muqeem.ts)
  moiNumber: zMoiNumber,
  muqeemPlatformId: zMuqeemPlatformId,
  // Workforce decision engine (see ../_workforce.ts): SUPER_ADMIN / COMPANY_ADMIN only
  nitaqatActivity: zNitaqatActivity,
  nitaqatActivityKey: zNitaqatActivityKey,
  isIndustrialLicensed: zIsIndustrialLicensed,
  // «إعدادات الكلفة» (see ../_workforce.ts): SUPER_ADMIN / COMPANY_ADMIN only
  overtimeHourlyBasis: zOvertimeHourlyBasis,
  medicalPremiums: zMedicalPremiums,
  iqamaFeeYear: zIqamaFeeYear,
});

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(WRITERS);
    const { id } = await params;
    const b = await parseBody(req, updateCompanySchema);

    const current = await prisma.company.findUnique({
      where: { id },
      select: {
        id: true,
        moiNumber: true,
        muqeemPlatformId: true,
        nitaqatActivity: true,
        nitaqatActivityKey: true,
        isIndustrialLicensed: true,
        overtimeHourlyBasis: true,
        medicalPremiumsJson: true,
        iqamaFeeYear: true,
      },
    });
    if (!current) throw notFound('الشركة غير موجودة');
    await assertMuqeemPlatformChange(user, b.muqeemPlatformId, current.muqeemPlatformId);
    assertCompanyWorkforceChange(user, b, current);
    if (b.nitaqatActivityKey !== undefined && (b.nitaqatActivityKey ?? null) !== (current.nitaqatActivityKey ?? null)) await assertNitaqatActivityExists(b.nitaqatActivityKey);
    const { overtimeHourlyBasis, medicalPremiums, iqamaFeeYear, ...fields } = b;
    const costNext = { overtimeHourlyBasis, medicalPremiumsJson: medicalPremiums, iqamaFeeYear };
    // Only changed cost settings are written (the form always re-sends the stored values).
    const costChanged = assertCompanyCostChange(user, costNext, current);
    const costData: { overtimeHourlyBasis?: string; medicalPremiumsJson?: string | null; iqamaFeeYear?: number | null } = {};
    if (costChanged.includes('overtimeHourlyBasis')) costData.overtimeHourlyBasis = overtimeHourlyBasis;
    if (costChanged.includes('medicalPremiumsJson')) costData.medicalPremiumsJson = medicalPremiums ?? null;
    if (costChanged.includes('iqamaFeeYear')) costData.iqamaFeeYear = iqamaFeeYear ?? null;

    const data = definedOnly({
      ...fields,
      ...costData,
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
      details: {
        fields: Object.keys(data),
        ...(b.moiNumber !== undefined && b.moiNumber !== current.moiNumber ? { moiNumber: b.moiNumber } : {}),
        ...(b.muqeemPlatformId !== undefined && b.muqeemPlatformId !== current.muqeemPlatformId ? { muqeemLinkChanged: true } : {}),
        ...(b.nitaqatActivity !== undefined && (b.nitaqatActivity ?? null) !== (current.nitaqatActivity ?? null)
          ? { nitaqatActivity: { before: current.nitaqatActivity, after: b.nitaqatActivity } }
          : {}),
        ...(b.nitaqatActivityKey !== undefined && (b.nitaqatActivityKey ?? null) !== (current.nitaqatActivityKey ?? null)
          ? { nitaqatActivityKey: { before: current.nitaqatActivityKey, after: b.nitaqatActivityKey } }
          : {}),
        ...(b.isIndustrialLicensed !== undefined && b.isIndustrialLicensed !== current.isIndustrialLicensed
          ? { isIndustrialLicensed: { before: current.isIndustrialLicensed, after: b.isIndustrialLicensed } }
          : {}),
        // «إعدادات الكلفة»: before / after of every changed setting.
        ...(costChanged.length
          ? { costSettings: Object.fromEntries(costChanged.map((k) => [k, { before: current[k], after: costData[k] ?? null }])) }
          : {}),
      },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({
      message: 'تم تحديث الشركة بنجاح',
      company: updated,
      warnings: moiNumberWarnings(updated.moiNumber, updated.muqeemPlatformId),
    });
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
