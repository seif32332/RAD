// GET /api/workforce/saudization?companyId&date&summary=1 — «مخطط السعودة».
// Per legal company: Nitaqat estimate (weights, caps, Qiwa documentation gate, band, thresholds for
// 2026–2028, margins, consequences, 26-week average), occupation localization compliance and alerts.
// WORKFORCE roles read. Viewers outside the HR group (privacy.ts canSeeDisability) get the restricted
// estimate: no names, one Saudi-side breakdown row (no per-category weights), no documentation weight,
// neutral flags (nitaqat.ts restrictEstimate).
// summary=1: one line per company (the decision dashboard).
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { saudizationQuerySchema } from '../_lib/saudization-schemas';
import { runSaudization } from '../_lib/saudization';
import { auditViewOnce, limitOrThrow } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, saudizationQuerySchema);
    limitOrThrow(user, 'heavy', 30, 60_000);
    const body = await runSaudization(q, user.role);
    if (!q.summary) await auditViewOnce(user, 'WorkforceSaudization', { companyId: q.companyId ?? null, date: body.date }, getClientIp(req));
    return NextResponse.json(body);
  } catch (err) {
    return handleApiError(err, 'workforce:saudization:GET');
  }
}
