// GET /api/workforce/overview?months=12|24|36&scenario=low|base|high — «لوحة القرار».
// The engine always projects 36 months from the current month; `months` selects the window of the
// composition, the group tables and the upcoming changes. Response = computeOverview() shaped by views.ts.
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { overviewQuerySchema } from '../_lib/schemas';
import { auditViewOnce, limitOrThrow, runOverview } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, overviewQuerySchema);
    limitOrThrow(user, 'heavy', 30, 60_000);
    const { response } = await runOverview(q);
    await auditViewOnce(user, 'WorkforceOverview', { months: q.months, scenario: q.scenario }, getClientIp(req));
    return NextResponse.json(response);
  } catch (err) {
    return handleApiError(err, 'workforce:overview:GET');
  }
}
