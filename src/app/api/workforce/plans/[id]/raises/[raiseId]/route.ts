// PATCH / DELETE /api/workforce/plans/[id]/raises/[raiseId] — edit or remove a planned raise of a DRAFT or
// REJECTED plan (merged row re-validated; audited with before / after).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { zId } from '@/lib/validation';
import { planMonthKey } from '@/lib/workforce/planning';
import { limitOrThrow } from '../../../../_lib/server';
import { raiseIssues, raiseUpdateSchema } from '../../../_lib/schemas';
import { assertAllowed, loadPlanOr404, lockEditable, monthDate, validateRaise, type RaiseData } from '../../../_lib/server';
import { workforceScope, type WfScope } from '../../../../_lib/scope';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; raiseId: string }> };

async function target(ctx: Ctx, wf: WfScope) {
  const p = await ctx.params;
  const id = zId.safeParse(p.id);
  const rid = zId.safeParse(p.raiseId);
  if (!id.success || !rid.success) throw notFound('الزيادة غير موجودة');
  const row = await loadPlanOr404(id.data, wf);
  const raise = row.raises.find((x) => x.id === rid.data);
  if (!raise) throw notFound('الزيادة غير موجودة');
  return { row, raise };
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    // P1-SCOPE: the plan and the raise's company / department / employee must be in the caller's companies (404).
    const wf = await workforceScope(user, 'workforce.plan.manage');
    const { row, raise } = await target(ctx, wf);
    assertAllowed('EDIT', row, user);
    const body = await parseBody(req, raiseUpdateSchema);
    const before: RaiseData & { notes: string | null } = { scope: raise.scope, scopeId: raise.scopeId, pct: raise.pct, amount: raise.amount, effectiveMonth: planMonthKey(raise.effectiveMonth)!, notes: raise.notes };
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const merged = { ...before, ...changes } as RaiseData & { notes: string | null };
    // Sending one of pct / amount replaces the other.
    if (body.pct !== undefined && body.pct !== null && body.amount === undefined) merged.amount = null;
    if (body.amount !== undefined && body.amount !== null && body.pct === undefined) merged.pct = null;
    if (merged.scope === 'ALL') merged.scopeId = null;
    const issues = raiseIssues(merged as Parameters<typeof raiseIssues>[0]);
    if (issues.length) throw badRequest(issues.map((i) => i.message).join(' — '), issues);
    await validateRaise(row, merged, wf);
    await prisma.$transaction(async (tx) => {
      await lockEditable(tx, row.id);
      await tx.planRaise.update({
        where: { id: raise.id },
        data: { scope: merged.scope, scopeId: merged.scopeId ?? null, pct: merged.pct ?? null, amount: merged.amount ?? null, effectiveMonth: monthDate(merged.effectiveMonth), notes: merged.notes ?? null },
      });
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'PlanRaise', entityId: raise.id, details: { planId: row.id, before, after: merged }, ipAddress: getClientIp(req) }, tx);
    });
    return NextResponse.json({ id: raise.id });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:raises:PATCH');
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const wf = await workforceScope(user, 'workforce.plan.manage');
    const { row, raise } = await target(ctx, wf);
    assertAllowed('EDIT', row, user);
    await prisma.$transaction(async (tx) => {
      await lockEditable(tx, row.id);
      await tx.planRaise.delete({ where: { id: raise.id } });
      await logAudit({ userId: user.id, action: 'DELETE', entityType: 'PlanRaise', entityId: raise.id, details: { planId: row.id, before: { scope: raise.scope, scopeId: raise.scopeId, pct: raise.pct, amount: raise.amount, effectiveMonth: planMonthKey(raise.effectiveMonth) } }, ipAddress: getClientIp(req) }, tx);
    });
    return NextResponse.json({ id: raise.id, deleted: true });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:raises:DELETE');
  }
}
