// GET /api/workforce/true-cost — «الكلفة الحقيقية».
//   ?companyId&branchId&departmentId (scope) &q&sort&flagged&take&skip (employee page) &months&scenario
//   &employeeId (detail: month-by-month lines + "لماذا؟" evidence of that employee only).
// The payload is bounded: summaries for one page of employees (take <= 200) and group totals; per-month
// lines only for a single employee. The levy tiers still use the whole legal company (see load.ts).
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { trueCostQuerySchema } from '../_lib/schemas';
import { auditViewOnce, employeeDetail, limitOrThrow, runTrueCost, trueCostTotals } from '../_lib/server';
import { pageSummaries, summarizeEmployee } from '../_lib/views';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, trueCostQuerySchema);
    limitOrThrow(user, 'heavy', 30, 60_000);
    const run = await runTrueCost(q);
    const page = pageSummaries(run.tc.employees.map(summarizeEmployee), { q: q.q, sort: q.sort, take: q.take, skip: q.skip, flagged: q.flagged });
    const detail = q.employeeId ? employeeDetail(run, q.employeeId, user.role) : null;
    await auditViewOnce(
      user,
      q.employeeId ? 'WorkforceTrueCostEmployee' : 'WorkforceTrueCost',
      { companyId: q.companyId ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, employeeId: q.employeeId ?? null, scenario: q.scenario },
      getClientIp(req),
    );
    return NextResponse.json({
      engineVersion: run.tc.engineVersion,
      disclaimer: ESTIMATE_DISCLAIMER,
      startMonth: run.startMonth,
      months: run.tc.monthKeys.length,
      horizon: q.months,
      scenario: q.scenario,
      scope: run.scope,
      ...trueCostTotals(run.tc),
      employees: page.items,
      total: page.total,
      take: q.take,
      skip: q.skip,
      detail,
    });
  } catch (err) {
    return handleApiError(err, 'workforce:true-cost:GET');
  }
}
