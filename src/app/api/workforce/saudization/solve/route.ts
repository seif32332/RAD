// POST /api/workforce/saudization/solve {companyId, targetBand, byDate?, options?} — «الوصول إلى نطاق».
// Minimum number of weight-1 Saudi hires (after zero-cost Qiwa documentation and 3,000–3,999 -> 4,000
// raises), ranked actions with their monthly cost from the true cost engine; optional expat replacement
// alternative. Read-only (nothing is written). WORKFORCE roles; restricted view outside the HR group.
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { solveSchema } from '../../_lib/saudization-schemas';
import { runSolve } from '../../_lib/saudization';
import { auditViewOnce, limitOrThrow } from '../../_lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const p = await parseBody(req, solveSchema);
    limitOrThrow(user, 'solve', 20, 60_000);
    const out = await runSolve(p, user.role);
    await auditViewOnce(user, 'WorkforceSaudizationSolve', { companyId: p.companyId, targetBand: p.targetBand, byDate: out.result.byDate }, getClientIp(req));
    return NextResponse.json(out);
  } catch (err) {
    return handleApiError(err, 'workforce:saudization:solve:POST');
  }
}
