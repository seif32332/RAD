// State changes of a plan (submit / approve / reject / archive) and copy. Each change re-checks the status
// inside the transaction, writes the audit row in the same transaction (the SUBMIT row is how the
// maker-checker knows who submitted; every CREATE / UPDATE / DELETE row of the plan, its positions and raises
// names an author who may not decide it), and APPROVE freezes the projection as a WORKFORCE_PLAN snapshot
// (recomputed on the server) that plan-vs-actual uses as the approved reference.
import 'server-only';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { PLAN_STATUS_LABELS, type PlanStatus } from '@/lib/workforce/planning';
import { limitOrThrow } from '../../_lib/server';
import { copySchema, transitionSchema } from './schemas';
import { PLAN_ENTITY, assertAllowed, authorsOf, computePlan, loadPlanOr404, planSnapshotRecord, submitterOf } from './server';

type Transition = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ARCHIVE';

const AUDIT_ACTION: Record<Transition, 'UPDATE' | 'APPROVE' | 'REJECT'> = { SUBMIT: 'UPDATE', APPROVE: 'APPROVE', REJECT: 'REJECT', ARCHIVE: 'UPDATE' };

export async function transitionHandler(req: Request, rawId: string, action: Transition) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const pid = zId.safeParse(rawId);
    if (!pid.success) throw notFound('الخطة غير موجودة');
    const id = pid.data;
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const body = await parseBody(req, transitionSchema);
    const row = await loadPlanOr404(id);
    const deciding = row.status === 'SUBMITTED' && (action === 'APPROVE' || action === 'REJECT');
    const [submittedById, authorIds] = row.status === 'SUBMITTED' ? await Promise.all([submitterOf(id), deciding ? authorsOf(id) : Promise.resolve(null)]) : [null, null];
    // Maker-checker: the submitter, the creator and every author of the content are refused (403).
    const next: PlanStatus = assertAllowed(action, row, user, submittedById, authorIds);
    if (action === 'REJECT' && !body.note) throw badRequest('اكتب سبب الرفض ليعرف المُعِدّ ما يعدّله');

    // APPROVE: the projection is computed before the transaction (the plan cannot change while SUBMITTED).
    const record = action === 'APPROVE' ? planSnapshotRecord(row, await computePlan(row), 'APPROVAL') : null;
    const now = new Date();
    const data =
      action === 'SUBMIT'
        ? { status: next, submittedAt: now, decidedById: null, decidedAt: null, decisionNote: null }
        : action === 'ARCHIVE'
          ? { status: next }
          : { status: next, decidedById: user.id, decidedAt: now, decisionNote: body.note ?? null };
    let snapshotId: string | null = null;
    await prisma.$transaction(async (tx) => {
      const r = await tx.headcountPlan.updateMany({ where: { id, status: row.status }, data });
      if (r.count !== 1) throw conflict('تغيّرت حالة الخطة أثناء الطلب: أعد التحميل');
      if (record) snapshotId = (await tx.workforceCalculation.create({ data: { ...record, createdById: user.id }, select: { id: true } })).id;
      // Written directly (not logAudit, which swallows errors): the SUBMIT row is the maker-checker's record.
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: AUDIT_ACTION[action],
          entityType: PLAN_ENTITY,
          entityId: id,
          details: JSON.stringify({ transition: action, from: row.status, to: next, note: body.note ?? null, snapshotId, name: row.name }),
          ipAddress: getClientIp(req),
        },
      });
    });
    return NextResponse.json({ id, status: next, statusLabel: PLAN_STATUS_LABELS[next], snapshotId });
  } catch (err) {
    return handleApiError(err, `workforce:plans:${action.toLowerCase()}`);
  }
}

/** POST /api/workforce/plans/[id]/copy — a new DRAFT with the same header, positions and raises (basedOnId). */
export async function copyHandler(req: Request, rawId: string) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const pid = zId.safeParse(rawId);
    if (!pid.success) throw notFound('الخطة غير موجودة');
    const id = pid.data;
    limitOrThrow(user, 'plan-write', 60, 60_000);
    const body = await parseBody(req, copySchema);
    const row = await loadPlanOr404(id);
    assertAllowed('COPY', row, user);
    const created = await prisma.$transaction(async (tx) => {
      const plan = await tx.headcountPlan.create({
        data: {
          name: body.name ?? `${row.name} (نسخة)`.slice(0, 120),
          companyId: row.companyId,
          fromMonth: row.fromMonth,
          months: row.months,
          attritionPct: row.attritionPct,
          notes: row.notes,
          status: 'DRAFT',
          basedOnId: row.id,
          createdById: user.id,
          positions: {
            create: row.positions.map(({ id: _id, planId: _planId, createdAt: _c, ...p }) => p),
          },
          raises: { create: row.raises.map(({ id: _id, planId: _planId, createdAt: _c, ...r }) => r) },
        },
        select: { id: true, name: true },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'CREATE',
          entityType: PLAN_ENTITY,
          entityId: plan.id,
          details: JSON.stringify({ copiedFrom: row.id, copiedFromStatus: row.status, name: plan.name, positions: row.positions.length, raises: row.raises.length }),
          ipAddress: getClientIp(req),
        },
      });
      return plan;
    });
    return NextResponse.json({ id: created.id, name: created.name, status: 'DRAFT', basedOnId: row.id }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:copy');
  }
}
