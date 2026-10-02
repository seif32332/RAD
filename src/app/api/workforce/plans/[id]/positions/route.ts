// POST /api/workforce/plans/[id]/positions — add a planned position (NEW_HIRE / BACKFILL / EXIT) to a DRAFT or
// REJECTED plan. Scenario data only: the plan table is written, never the employee file or payroll.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { zId } from '@/lib/validation';
import { limitOrThrow } from '../../../_lib/server';
import { positionCreateSchema } from '../../_lib/schemas';
import { MAX_POSITIONS, assertAllowed, loadPlanOr404, lockEditable, positionColumns, validatePosition } from '../../_lib/server';
import { workforceScope } from '../../../_lib/scope';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const idp = zId.safeParse((await ctx.params).id);
    if (!idp.success) throw notFound('الخطة غير موجودة');
    // Status first: an approved / submitted plan answers 409 whatever the body.
    // P1-SCOPE: the plan and everything the position names must be in the caller's companies (404).
    const wf = await workforceScope(user, 'workforce.plan.manage');
    const row = await loadPlanOr404(idp.data, wf);
    assertAllowed('EDIT', row, user);
    const body = await parseBody(req, positionCreateSchema);
    if (row.positions.length >= MAX_POSITIONS) throw conflict(`الحد الأعلى ${MAX_POSITIONS} بند في الخطة`);
    await validatePosition(row, body, null, wf);
    const created = await prisma.$transaction(async (tx) => {
      await lockEditable(tx, row.id);
      const p = await tx.plannedPosition.create({ data: { planId: row.id, ...positionColumns(body) }, select: { id: true } });
      await logAudit({ userId: user.id, action: 'CREATE', entityType: 'PlannedPosition', entityId: p.id, details: { planId: row.id, ...body }, ipAddress: getClientIp(req) }, tx);
      return p;
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:positions:POST');
  }
}
