// POST /api/workforce/hire-scenario {companyId, candidates[1..4], months?, startMonth?} — «سيناريوهات التوظيف».
// Saudi / expat / overtime / outsourcing side by side over 12 / 24 / 36 months: true cost (net of HRDF),
// levy tier impact on the other expats, Nitaqat before / after, localization effect, overtime capacity.
// Hypothetical only: no Employee / SalaryChange row is written. WORKFORCE roles.
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { hireScenarioSchema } from '../_lib/saudization-schemas';
import { runHireScenario } from '../_lib/saudization';
import { auditViewOnce, limitOrThrow } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const p = await parseBody(req, hireScenarioSchema);
    limitOrThrow(user, 'hire', 20, 60_000);
    const out = await runHireScenario(p);
    await auditViewOnce(user, 'WorkforceHireScenario', { companyId: p.companyId, candidates: p.candidates.map((c) => c.kind), months: p.months }, getClientIp(req));
    return NextResponse.json(out);
  } catch (err) {
    return handleApiError(err, 'workforce:hire-scenario:POST');
  }
}
