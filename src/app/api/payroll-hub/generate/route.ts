import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zId, zMonth, zYear } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { generatePayrollMonth, type GeneratePayrollResult } from '@/lib/payroll';
import { applyDueChangeOrders } from '@/lib/documents/change-orders';
import { ALL_COMPANIES, authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';
import { moneyActorOf } from '@/modules/platform';

export const dynamic = 'force-dynamic';

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

const GenerateSchema = z.object({
  month: zMonth,
  year: zYear,
  /** Month already approved: only create drafts for employees without a payroll that month. */
  supplementary: zBool.optional(),
  /** One company (ARC-PAY-A7). Without it: every company of the user's scope, each on its own. */
  companyId: z.preprocess(emptyToUndefined, zId.optional()),
});

/**
 * POST /api/payroll-hub/generate  { month, year, supplementary?, companyId? }
 * (Re)generates the DRAFT payroll of a month, company by company (ARC-PAY-A7: a payroll month belongs
 * to one legal company). payroll.generate is a SYSTEM operation triggered by the user (money.gateway);
 * a company whose month is already approved / paid is skipped with its reason (409 when every one is).
 * P1-SCOPE: generation runs on the scoped client, inside the user's companies only.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const { month, year, supplementary, companyId } = await parseBody(req, GenerateSchema);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'payroll.run', companyId ? { companyId } : undefined);
    const db = scopedPrisma(ctx) as unknown as PrismaClient;

    const companies = companyId
      ? [companyId]
      : (await db.company.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((c) => c.id);
    if (companyId && ctx.companies !== ALL_COMPANIES && !ctx.companies.includes(companyId)) throw notFound('الشركة غير موجودة');

    // Promotion / salary decisions due by today are applied first, so the payroll reads them.
    await applyDueChangeOrders();
    const idem = req.headers.get('idempotency-key')?.trim();
    const results: Array<{ companyId: string; result: GeneratePayrollResult }> = [];
    const refused: Array<{ companyId: string; message: string }> = [];
    for (const id of companies) {
      try {
        const result = await generatePayrollMonth(db, {
          companyId: id,
          year,
          month,
          supplementary: supplementary === true,
          actor: moneyActorOf(user),
          ...(idem ? { operationKey: `payroll.generate:k:${user.id}:${id}:${idem.slice(0, 100)}` } : {}),
        });
        results.push({ companyId: id, result });
      } catch (err) {
        // One company's approved month never blocks the others (each company is its own payroll).
        if (!companyId && err instanceof HttpError && err.status === 409) refused.push({ companyId: id, message: err.message });
        else throw err;
      }
    }
    if (!results.length && refused.length) throw new HttpError(409, refused[0].message, { refused });

    const rows = results.flatMap((r) => r.result.rows);
    const sum = (f: (r: GeneratePayrollResult) => number) => results.reduce((s, r) => s + f(r.result), 0);
    const replacedDrafts = sum((r) => r.replacedDrafts);
    const needsReview = sum((r) => r.needsReview);

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'PAYROLL',
      entityId: `${year}-${month}`,
      details: `تم توليد مسير رواتب مبدئي لشهر ${month}/${year} لعدد ${rows.length} موظف في ${results.filter((r) => r.result.payrollMonthId).length} شركة (استبدال ${replacedDrafts} مسودة سابقة، ${needsReview} سطر يحتاج مراجعة).`,
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({
      message: rows.length
        ? `تم توليد مسير الرواتب بنجاح لعدد ${rows.length} موظف${needsReview ? ` (${needsReview} سطر يحتاج مراجعة)` : ''}`
        : 'لا يوجد موظفون مستحقون للراتب في هذا الشهر',
      data: rows,
      count: rows.length,
      replacedDrafts,
      skipped: sum((r) => r.skippedFinalized),
      skippedOtherCompany: sum((r) => r.skippedOtherCompany),
      // Lines flagged for review are generated anyway: one employee never blocks the run.
      needsReview,
      provisionalGosi: sum((r) => r.provisionalGosi),
      companies: results.map((r) => ({ companyId: r.companyId, count: r.result.rows.length, payrollMonthId: r.result.payrollMonthId, status: r.result.monthStatus, replayed: r.result.replayed })),
      ...(refused.length ? { refused } : {}),
    });
  } catch (err) {
    return handleApiError(err, 'payroll-hub/generate:POST');
  }
}
