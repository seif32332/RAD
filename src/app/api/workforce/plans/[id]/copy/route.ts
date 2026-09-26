// POST /api/workforce/plans/[id]/copy {name?} — a new DRAFT version of the plan (same header, positions and raises;
// basedOnId = the source). Any status can be copied; the approved plan itself stays read-only.
import { copyHandler } from '../../_lib/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return copyHandler(req, (await ctx.params).id);
}
