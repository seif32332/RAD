// GET /api/workforce/plans/compare?ids=a,b[,c]&live=1 — 2–3 plan versions side by side (comparePlanProjections):
// totals 12 / 24 / 36 before and after HRDF, what each plan adds to the current workforce, head count at the
// start and the end, the positions and raises, and Nitaqat at the end of every plan year. The first plan is
// the reference. APPROVED plans use the projection frozen at approval unless live=1.
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { z } from 'zod';
import { comparePlanProjections } from '@/lib/workforce/planning';
import { auditViewOnce, limitOrThrow } from '../../_lib/server';
import { compareQuerySchema } from '../_lib/schemas';
import { loadPlansOr404, projectionFor } from '../_lib/server';

export const dynamic = 'force-dynamic';

const querySchema = compareQuerySchema.extend({ live: z.preprocess((v) => v === '1' || v === 'true', z.boolean()) });

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, querySchema);
    limitOrThrow(user, 'plan-compare', 10, 60_000);
    const rows = await loadPlansOr404(q.ids);
    // One at a time: each projection runs the true cost engine over the whole scope.
    const list = [];
    for (const row of rows) {
      const { projection, frozen } = await projectionFor(row, q.live);
      list.push({ plan: { id: row.id, name: row.name, status: row.status }, projection, frozen: !!frozen });
    }
    await auditViewOnce(user, 'WorkforcePlanCompare', { ids: q.ids }, getClientIp(req));
    return NextResponse.json({ columns: comparePlanProjections(list) });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:compare:GET');
  }
}
