// POST /api/workforce/plans/[id]/reject {note} — SUBMITTED -> REJECTED by an OWNER role other than the submitter and
// the creator; the reason is required. A rejected plan can be edited and submitted again.
import { transitionHandler } from '../../_lib/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return transitionHandler(req, (await ctx.params).id, 'REJECT');
}
