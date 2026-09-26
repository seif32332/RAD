// POST /api/workforce/plans/[id]/approve {note?} — SUBMITTED -> APPROVED by an OWNER role (SUPER_ADMIN, COMPANY_ADMIN)
// other than the submitter and the creator (maker-checker). Freezes the projection as a WORKFORCE_PLAN
// snapshot (recomputed on the server): the approved reference of plan vs actual. Approved plans are read-only.
import { transitionHandler } from '../../_lib/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return transitionHandler(req, (await ctx.params).id, 'APPROVE');
}
