// POST /api/workforce/plans/[id]/raises — add a planned raise (pct of the basic, or a fixed amount) for a
// scope (ALL / COMPANY / DEPARTMENT / EMPLOYEE) from a month. Plan table only: no SalaryChange is written.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { zId } from '@/lib/validation';
import { limitOrThrow } from '../../../_lib/server';
import { raiseCreateSchema } from '../../_lib/schemas';
import { MAX_RAISES, assertAllowed, loadPlanOr404, lockEditable, monthDate, validateRaise } from '../../_lib/server';
import { workforceScope } from '../../../_lib/scope';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const idp = zId.safeParse((await ctx.params).id);
    if (!idp.success) throw notFound('الخطة غير موجودة');
    // Status first: an approved / submitted plan answers 409 whatever the body.
    // P1-SCOPE: the plan and the raise's company / department / employee must be in the caller's companies (404).
    const wf = await workforceScope(user, 'workforce.plan.manage');
    const row = await loadPlanOr404(idp.data, wf);
    assertAllowed('EDIT', row, user);
    const body = await parseBody(req, raiseCreateSchema);
    if (row.raises.length >= MAX_RAISES) throw conflict(`الحد الأعلى ${MAX_RAISES} زيادة في الخطة`);
    await validateRaise(row, body, wf);
    const created = await prisma.$transaction(async (tx) => {
      await lockEditable(tx, row.id);
      const r = await tx.planRaise.create({
        data: { planId: row.id, scope: body.scope, scopeId: body.scope === 'ALL' ? null : (body.scopeId ?? null), pct: body.pct ?? null, amount: body.amount ?? null, effectiveMonth: monthDate(body.effectiveMonth), notes: body.notes ?? null },
        select: { id: true },
      });
      await logAudit({ userId: user.id, action: 'CREATE', entityType: 'PlanRaise', entityId: r.id, details: { planId: row.id, ...body }, ipAddress: getClientIp(req) }, tx);
      return r;
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:raises:POST');
  }
}
