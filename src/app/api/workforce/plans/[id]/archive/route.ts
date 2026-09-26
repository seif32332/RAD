// POST /api/workforce/plans/[id]/archive {note?} — DRAFT / REJECTED (editing roles) or APPROVED (OWNER roles) ->
// ARCHIVED. A SUBMITTED plan is decided first.
import { transitionHandler } from '../../_lib/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return transitionHandler(req, (await ctx.params).id, 'ARCHIVE');
}
