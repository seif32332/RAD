// /api/workforce/plans/[id] — one plan. WORKFORCE roles.
// GET ?live=1: header, positions, raises, the projection (projectPlan; for an APPROVED plan the projection
//     frozen at approval unless live=1), the viewer's permissions (maker-checker) and display names.
// PATCH {name?, companyId?, fromMonth?, months?, attritionPct?, notes?}: DRAFT / REJECTED only.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { zId } from '@/lib/validation';
import { planMonthKey } from '@/lib/workforce/planning';
import { auditViewOnce, limitOrThrow } from '../../_lib/server';
import { assertCompanyVisible, assertTenantWide, planScopeWhere, workforceScope } from '../../_lib/scope';
import { detailQuerySchema, planUpdateSchema } from '../_lib/schemas';
import {
  PLAN_ENTITY,
  assertAllowed,
  authorsOf,
  companyNameMap,
  loadPlanOr404,
  lockEditable,
  monthDate,
  permissionsFor,
  planHeader,
  planHistories,
  projectionFor,
  publicProjection,
  submitterOf,
  userNames,
} from '../_lib/server';
import { displayNames, serializePositions, serializeRaises } from '../_lib/views';

export const dynamic = 'force-dynamic';

async function planId(ctx: { params: Promise<{ id: string }> }): Promise<string> {
  const p = zId.safeParse((await ctx.params).id);
  if (!p.success) throw notFound('الخطة غير موجودة');
  return p.data;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const id = await planId(ctx);
    const q = parseQuery(req, detailQuerySchema);
    limitOrThrow(user, 'plan-calc', 30, 60_000);
    // P1-SCOPE: a plan outside the caller's companies is "not found".
    const wf = await workforceScope(user);
    const row = await loadPlanOr404(id, wf);
    const [{ projection, frozen }, submittedById, authorIds, histories, names, companies, parent] = await Promise.all([
      projectionFor(row, q.live),
      row.submittedAt ? submitterOf(id) : Promise.resolve(null),
      row.status === 'SUBMITTED' ? authorsOf(id) : Promise.resolve(null),
      planHistories([id]),
      displayNames(row, wf),
      companyNameMap(wf),
      row.basedOnId ? prisma.headcountPlan.findFirst({ where: { id: row.basedOnId, AND: [planScopeWhere(wf)] }, select: { id: true, name: true, status: true } }) : Promise.resolve(null),
    ]);
    const history = histories.get(id) ?? null;
    const users = await userNames([row.createdById, row.decidedById, submittedById, history?.archivedById]);
    await auditViewOnce(user, 'WorkforcePlan', { planId: id, live: q.live }, getClientIp(req));
    return NextResponse.json({
      plan: { ...planHeader(row, users, companies, history), submittedById, submittedByName: submittedById ? (users.get(submittedById) ?? null) : null, basedOn: parent },
      positions: serializePositions(row),
      raises: serializeRaises(row),
      projection: publicProjection(projection),
      frozen,
      permissions: permissionsFor(row, user, submittedById, authorIds),
      names,
      role: user.role,
    });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:[id]:GET');
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const id = await planId(ctx);
    const wf = await workforceScope(user, 'workforce.plan.manage');
    const row = await loadPlanOr404(id, wf);
    assertAllowed('EDIT', row, user);
    const body = await parseBody(req, planUpdateSchema);
    if (body.companyId !== undefined && (body.companyId ?? null) !== row.companyId) {
      if (row.positions.length || row.raises.length) throw conflict('لا يتغير نطاق الخطة بعد إضافة البنود: انسخ الخطة أو احذف البنود أولاً');
      if (body.companyId) assertCompanyVisible(wf, body.companyId);
      else assertTenantWide(wf, 'خطة كل الشركات خارج نطاق صلاحياتك: اختر شركة من شركاتك');
      if (body.companyId && !(await prisma.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw notFound('الشركة غير موجودة');
    }
    const data = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.companyId !== undefined ? { companyId: body.companyId ?? null } : {}),
      ...(body.fromMonth !== undefined ? { fromMonth: monthDate(body.fromMonth) } : {}),
      ...(body.months !== undefined ? { months: body.months } : {}),
      ...(body.attritionPct !== undefined ? { attritionPct: body.attritionPct ?? null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
    };
    const before = { name: row.name, companyId: row.companyId, fromMonth: planMonthKey(row.fromMonth), months: row.months, attritionPct: row.attritionPct, notes: row.notes };
    await prisma.$transaction(async (tx) => {
      await lockEditable(tx, id);
      await tx.headcountPlan.update({ where: { id }, data });
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: PLAN_ENTITY, entityId: id, details: { before, after: { ...body } }, ipAddress: getClientIp(req) }, tx);
    });
    return NextResponse.json({ id, updated: Object.keys(data) });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:[id]:PATCH');
  }
}
