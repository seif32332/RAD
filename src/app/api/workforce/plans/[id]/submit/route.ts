// POST /api/workforce/plans/[id]/submit {note?} — DRAFT / REJECTED -> SUBMITTED (HR_MANAGER, FINANCE_MANAGER, COMPANY_ADMIN,
// SUPER_ADMIN). The audit row written in the same transaction records who submitted (maker-checker).
import { transitionHandler } from '../../_lib/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return transitionHandler(req, (await ctx.params).id, 'SUBMIT');
}
