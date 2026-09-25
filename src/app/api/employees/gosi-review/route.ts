import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery, badRequest } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { isSaudiNationalityValue } from '@/lib/employee';

export const dynamic = 'force-dynamic';

/**
 * DEC-003: the GOSI regime (OLD / NEW) is confirmed by HR / payroll from a source document
 * (subscription certificate, the establishment's GOSI list...) and is never derived from a date.
 *
 * GET  /api/employees/gosi-review
 *        ?scope=unknown (default) -> active Saudi employees whose gosiRegime is UNKNOWN
 *        ?scope=auto              -> active Saudi employees set to OLD by the automatic migration
 *                                    (source mentions "ترحيل آلي"): to be re-confirmed from a document
 * POST /api/employees/gosi-review  { items: [{ employeeId, regime: 'OLD'|'NEW', source }] }
 *        Confirms one or many employees (bulk = several items). The source is required.
 * Access: PAYROLL group (HR + finance / payroll admins).
 */

/** Marker written by the migration that pre-filled OLD from the hire date (see prisma migration backfill). */
const AUTO_MIGRATION_MARKER = 'ترحيل آلي';

const querySchema = z.object({ scope: z.enum(['unknown', 'auto']).optional() });

export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.PAYROLL);
    const { scope = 'unknown' } = parseQuery(req, querySchema);

    const rows = await prisma.employee.findMany({
      where: {
        isTerminated: false,
        ...(scope === 'auto'
          ? { gosiRegime: 'OLD', gosiRegistrationSource: { contains: AUTO_MIGRATION_MARKER } }
          : { gosiRegime: 'UNKNOWN' }),
      },
      select: {
        id: true,
        employeeId: true,
        firstNameArabic: true,
        lastNameArabic: true,
        nationality: true,
        joinDate: true,
        gosiRegime: true,
        gosiRegistrationSource: true,
        gosiNumber: true,
        basicSalary: true,
        legalCompany: { select: { id: true, nameArabic: true } },
        branch: { select: { id: true, nameArabic: true } },
      },
      orderBy: [{ joinDate: 'desc' }, { employeeId: 'asc' }],
    });
    // Nationality has legacy spellings ('SAUDI', 'السعودية'...): filter with the shared normalizer.
    const saudis = rows.filter((r) => isSaudiNationalityValue(r.nationality));
    return NextResponse.json({ scope, count: saudis.length, employees: saudis });
  } catch (err) {
    return handleApiError(err, 'employees/gosi-review:GET');
  }
}

const confirmSchema = z.object({
  items: z
    .array(
      z.object({
        employeeId: z.string().trim().min(1).max(100),
        regime: z.enum(['OLD', 'NEW'], { errorMap: () => ({ message: 'اختر النظام: قديم (OLD) أو جديد (NEW)' }) }),
        source: z.string().trim().min(1, 'مصدر التأكيد مطلوب (شهادة اشتراك أو قائمة GOSI للمنشأة)').max(300),
        gosiNumber: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(50).optional()),
      }),
    )
    .min(1, 'لم يتم اختيار أي موظف')
    .max(500, 'الحد الأقصى 500 موظف في المرة الواحدة'),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const { items } = await parseBody(req, confirmSchema);
    const ids = [...new Set(items.map((i) => i.employeeId))];
    if (ids.length !== items.length) throw badRequest('الموظف مكرر في الطلب');

    const found = await prisma.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true, employeeId: true, gosiRegime: true, gosiRegistrationSource: true, nationality: true, isTerminated: true },
    });
    const byId = new Map(found.map((e) => [e.id, e]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw badRequest(`موظفون غير موجودين: ${missing.length}`);

    const ip = getClientIp(req);
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const before = byId.get(item.employeeId);
        if (!before) continue; // unreachable: missing ids were rejected above
        await tx.employee.update({
          where: { id: item.employeeId },
          data: {
            gosiRegime: item.regime,
            gosiRegistrationSource: item.source,
            ...(item.gosiNumber !== undefined ? { gosiNumber: item.gosiNumber } : {}),
          },
        });
        await logAudit(
          {
            userId: user.id,
            action: 'UPDATE',
            entityType: 'Employee',
            entityId: item.employeeId,
            details: {
              action: 'gosi_regime_confirm',
              employeeCode: before.employeeId,
              from: before.gosiRegime,
              to: item.regime,
              fromSource: before.gosiRegistrationSource,
              source: item.source,
              bulk: items.length > 1,
            },
            ipAddress: ip,
          },
          tx,
        );
      }
    });

    return NextResponse.json({ message: `تم تأكيد نظام التأمينات لـ ${items.length} موظف`, updated: items.length });
  } catch (err) {
    return handleApiError(err, 'employees/gosi-review:POST');
  }
}
