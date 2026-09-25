import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zBool, zMonth, zYear } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { generatePayrollMonth } from '@/lib/payroll';

export const dynamic = 'force-dynamic';

const GenerateSchema = z.object({
  month: zMonth,
  year: zYear,
  /** Month already approved: only create drafts for employees without a payroll that month. */
  supplementary: zBool.optional(),
});

/**
 * POST /api/payroll-hub/generate  { month, year, supplementary? }
 * (Re)generates the DRAFT payroll of a month. 409 if the month is already approved/paid.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const { month, year, supplementary } = await parseBody(req, GenerateSchema);

    const result = await generatePayrollMonth(prisma, year, month, { supplementary: supplementary === true });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'PAYROLL',
      entityId: `${year}-${month}`,
      details: `تم توليد مسير رواتب مبدئي لشهر ${month}/${year} لعدد ${result.rows.length} موظف (استبدال ${result.replacedDrafts} مسودة سابقة، ${result.needsReview} سطر يحتاج مراجعة).`,
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({
      message: result.rows.length
        ? `تم توليد مسير الرواتب بنجاح لعدد ${result.rows.length} موظف${result.needsReview ? ` (${result.needsReview} سطر يحتاج مراجعة)` : ''}`
        : 'لا يوجد موظفون مستحقون للراتب في هذا الشهر',
      data: result.rows,
      count: result.rows.length,
      replacedDrafts: result.replacedDrafts,
      skipped: result.skippedFinalized,
      // Lines flagged for review are generated anyway: one employee never blocks the run.
      needsReview: result.needsReview,
      provisionalGosi: result.provisionalGosi,
    });
  } catch (err) {
    return handleApiError(err, 'payroll-hub/generate:POST');
  }
}
