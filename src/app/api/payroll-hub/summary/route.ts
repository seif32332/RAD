import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseQuery } from '@/lib/http';
import { zMonth, zYear } from '@/lib/validation';
import { sumMoney } from '@/lib/money';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';
import { currentPayrollMonth, defaultPayrollMonth, payrollMonths, payrollMonthSummary } from '@/lib/payroll';

export const dynamic = 'force-dynamic';

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

const QuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, zMonth.optional()),
  year: z.preprocess(emptyToUndefined, zYear.optional()),
});

/**
 * GET /api/payroll-hub/summary?month&year
 * Server totals of one payroll month from the STORED rows (DEC-002 / DEC-010): counts per status,
 * lines needing review, every deduction column, the employer GOSI cost (not deducted) and the
 * provisional GOSI rates in force. Without month/year (council DOM-009): the current Riyadh month
 * when it has lines, else the closest EARLIER month with lines, else the current month (empty
 * summary). A month stored in the future (next month's draft, a mistyped year) is never the
 * default; it stays selectable from `months`, which lists every month with payrolls (newest first).
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const q = parseQuery(req, QuerySchema);
    // P1-SCOPE: months and totals of the user's companies only (scoped client).
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'payroll.read');
    const db = scopedPrisma(ctx) as unknown as Prisma.TransactionClient;
    if ((q.month === undefined) !== (q.year === undefined)) throw badRequest('يرجى تحديد الشهر والسنة معاً');

    const groups = await payrollMonths(db);
    const months: Array<{
      year: number;
      month: number;
      count: number;
      netSalary: number;
      byStatus: Record<string, number>;
      netByStatus: Record<string, number>;
    }> = [];
    for (const g of groups) {
      let m = months.find((x) => x.year === g.year && x.month === g.month);
      if (!m) {
        m = { year: g.year, month: g.month, count: 0, netSalary: 0, byStatus: {}, netByStatus: {} };
        months.push(m);
      }
      m.count += g.count;
      m.netSalary = sumMoney([m.netSalary, g.netSalary]);
      m.byStatus[g.status] = (m.byStatus[g.status] ?? 0) + g.count;
      m.netByStatus[g.status] = sumMoney([m.netByStatus[g.status] ?? 0, g.netSalary]);
    }

    let month = q.month;
    let year = q.year;
    if (month === undefined || year === undefined) {
      if (!months.length) return NextResponse.json({ summary: null, months });
      const current = currentPayrollMonth();
      const pick = defaultPayrollMonth(months, current) ?? current;
      ({ month, year } = pick);
    }

    const summary = await payrollMonthSummary(db, year, month);
    return NextResponse.json({ summary, months });
  } catch (err) {
    return handleApiError(err, 'payroll-hub/summary:GET');
  }
}
