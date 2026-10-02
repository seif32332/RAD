// /api/workforce/plans — «خطة القوى العاملة» (SPEC §8). WORKFORCE roles.
// GET ?status&companyId&summary&take&skip: the plans, newest first (header only, no projection). summary=1:
//     counts by status and the latest approved plan (the decision board card).
// POST {name, companyId?, fromMonth 'YYYY-MM', months 12|24|36, attritionPct?, notes?}: a new DRAFT.
// A plan is scenario data: only the plan tables are written (never Employee / SalaryChange / Payroll).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { PLAN_STATUSES, PLAN_STATUS_LABELS } from '@/lib/workforce/planning';
import { limitOrThrow } from '../_lib/server';
import { assertCompanyVisible, assertTenantWide, planScopeWhere, workforceScope } from '../_lib/scope';
import { planCreateSchema, planListSchema } from './_lib/schemas';
import { PLAN_ENTITY, assertAllowed, companyNameMap, monthDate, planHeader, planHistories, userNames } from './_lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    // P1-SCOPE: plans of the caller's companies (a plan of every company only for an unrestricted caller).
    const wf = await workforceScope(user);
    const inScope = planScopeWhere(wf);
    const q = parseQuery(req, planListSchema);
    if (q.summary) {
      const [groups, latest] = await Promise.all([
        prisma.headcountPlan.groupBy({ by: ['status'], where: inScope, _count: { _all: true } }),
        prisma.headcountPlan.findFirst({ where: { status: 'APPROVED', AND: [inScope] }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], select: { id: true, name: true, fromMonth: true, months: true, decidedAt: true } }),
      ]);
      const counts = Object.fromEntries(PLAN_STATUSES.map((s) => [s, groups.find((g) => g.status === s)?._count._all ?? 0]));
      return NextResponse.json({
        counts,
        labels: PLAN_STATUS_LABELS,
        latestApproved: latest ? { id: latest.id, name: latest.name, fromMonth: latest.fromMonth.toISOString().slice(0, 7), months: latest.months, decidedAt: latest.decidedAt?.toISOString() ?? null } : null,
      });
    }
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.companyId ? { companyId: q.companyId } : {}), AND: [inScope] };
    const [rows, total, companies] = await Promise.all([
      prisma.headcountPlan.findMany({ where, include: { _count: { select: { positions: true, raises: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.take, skip: q.skip }),
      prisma.headcountPlan.count({ where }),
      companyNameMap(wf),
    ]);
    const histories = await planHistories(rows.map((r) => r.id));
    const names = await userNames(rows.flatMap((r) => [r.createdById, r.decidedById, histories.get(r.id)?.archivedById]));
    const basedOn = rows.map((r) => r.basedOnId).filter((x): x is string => !!x);
    const parents = basedOn.length ? await prisma.headcountPlan.findMany({ where: { id: { in: basedOn }, AND: [inScope] }, select: { id: true, name: true } }) : [];
    const parentName = new Map(parents.map((p) => [p.id, p.name]));
    return NextResponse.json({
      total,
      take: q.take,
      skip: q.skip,
      items: rows.map((r) => ({ ...planHeader(r, names, companies, histories.get(r.id) ?? null), basedOnName: r.basedOnId ? (parentName.get(r.basedOnId) ?? null) : null })),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const body = await parseBody(req, planCreateSchema);
    assertAllowed('COPY', { status: 'DRAFT', createdById: null }, user); // creating = the editing roles
    // P1-SCOPE: a plan of one of the caller's companies (404 outside); a plan of every company needs an unrestricted caller.
    const wf = await workforceScope(user, 'workforce.plan.manage');
    if (body.companyId) assertCompanyVisible(wf, body.companyId);
    else assertTenantWide(wf, 'اختر شركة للخطة: خطة كل الشركات خارج نطاق صلاحياتك');
    if (body.companyId && !(await prisma.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw notFound('الشركة غير موجودة');
    const row = await prisma.headcountPlan.create({
      data: {
        name: body.name,
        companyId: body.companyId ?? null,
        fromMonth: monthDate(body.fromMonth),
        months: body.months,
        attritionPct: body.attritionPct ?? null,
        notes: body.notes ?? null,
        status: 'DRAFT',
        createdById: user.id,
      },
    });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: PLAN_ENTITY, entityId: row.id, details: { name: row.name, companyId: row.companyId, fromMonth: body.fromMonth, months: row.months, attritionPct: row.attritionPct }, ipAddress: getClientIp(req) });
    return NextResponse.json({ id: row.id, status: row.status }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:POST');
  }
}
