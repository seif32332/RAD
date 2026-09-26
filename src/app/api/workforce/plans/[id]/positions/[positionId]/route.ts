// PATCH / DELETE /api/workforce/plans/[id]/positions/[positionId] — edit or remove a planned position of a
// DRAFT or REJECTED plan (the merged row is re-validated; every change is audited with before / after).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { zId } from '@/lib/validation';
import { limitOrThrow } from '../../../../_lib/server';
import { positionIssues, positionUpdateSchema } from '../../../_lib/schemas';
import { assertAllowed, loadPlanOr404, lockEditable, positionColumns, positionData, validatePosition, type PositionData } from '../../../_lib/server';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; positionId: string }> };

async function target(ctx: Ctx) {
  const p = await ctx.params;
  const id = zId.safeParse(p.id);
  const pid = zId.safeParse(p.positionId);
  if (!id.success || !pid.success) throw notFound('البند غير موجود');
  const row = await loadPlanOr404(id.data);
  const pos = row.positions.find((x) => x.id === pid.data);
  if (!pos) throw notFound('البند غير موجود');
  return { row, pos };
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const { row, pos } = await target(ctx);
    assertAllowed('EDIT', row, user);
    const body = await parseBody(req, positionUpdateSchema);
    const before = positionData(pos);
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const merged = { ...before, ...changes } as PositionData;
    const issues = positionIssues(merged as Parameters<typeof positionIssues>[0]);
    if (issues.length) throw badRequest(issues.map((i) => i.message).join(' — '), issues);
    await validatePosition(row, merged, pos.id);
    await prisma.$transaction(async (tx) => {
      await lockEditable(tx, row.id);
      await tx.plannedPosition.update({ where: { id: pos.id }, data: positionColumns(merged) });
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'PlannedPosition', entityId: pos.id, details: { planId: row.id, before, after: merged }, ipAddress: getClientIp(req) }, tx);
    });
    return NextResponse.json({ id: pos.id });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:positions:PATCH');
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const { row, pos } = await target(ctx);
    assertAllowed('EDIT', row, user);
    await prisma.$transaction(async (tx) => {
      await lockEditable(tx, row.id);
      await tx.plannedPosition.delete({ where: { id: pos.id } });
      await logAudit({ userId: user.id, action: 'DELETE', entityType: 'PlannedPosition', entityId: pos.id, details: { planId: row.id, before: positionData(pos) }, ipAddress: getClientIp(req) }, tx);
    });
    return NextResponse.json({ id: pos.id, deleted: true });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:positions:DELETE');
  }
}
