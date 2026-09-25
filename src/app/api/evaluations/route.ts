import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireEmployeeId, requireUser, type AuthUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zDate, zId, zInt, zNumber, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import {
  APPROVAL_ACTION,
  CYCLE_STATUS,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_SECTIONS,
  EVAL_EDITABLE_STATUSES,
  EVAL_PERIOD_TYPES,
  EVAL_STATUS,
  RECOMMENDATIONS,
  SCORE_MAX,
  SCORE_MIN,
  TEMPLATE_TARGET_TYPES,
  bucketScores,
  checkScores,
  computeTotalScore,
  ratingForScore,
  weightsAreValid,
} from './scoring';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Access rules
//   HR (SUPER_ADMIN, COMPANY_ADMIN, HR_MANAGER): everything.
//   Other managers (BRANCH_MANAGER, DEPT_MANAGER): read cycles/templates, and read + score only
//     the evaluations of their own reports (EmployeeEvaluation.managerId or Employee.directManagerId).
//   Everyone (incl. EMPLOYEE): read and acknowledge their own evaluations only.
// ---------------------------------------------------------------------------

const templateWithItems = {
  sections: {
    orderBy: { sortOrder: 'asc' },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  },
} satisfies Prisma.EvaluationTemplateInclude;

const nameRef = { select: { id: true, nameArabic: true } } as const;

/** Evaluations the (non-HR) manager is responsible for. Never includes their own evaluation. */
function reportsScope(managerEmployeeId: string): Prisma.EmployeeEvaluationWhereInput {
  return {
    employeeId: { not: managerEmployeeId },
    OR: [{ managerId: managerEmployeeId }, { employee: { directManagerId: managerEmployeeId } }],
  };
}

/** null = unrestricted (HR); otherwise the where-filter limiting evaluations to the manager's reports. */
async function evaluationScope(user: AuthUser): Promise<Prisma.EmployeeEvaluationWhereInput | null> {
  if (hasRole(user, ROLE_GROUPS.HR)) return null;
  // A manager account that is not linked to an employee file has no team: empty lists, not 403.
  if (!user.employeeId) return { id: { in: [] } };
  return reportsScope(await requireEmployeeId(user));
}

function isManagerOf(
  user: AuthUser,
  ev: { employeeId: string; managerId: string | null; employee: { directManagerId: string | null } },
): boolean {
  if (!user.employeeId || ev.employeeId === user.employeeId) return false;
  return ev.managerId === user.employeeId || ev.employee.directManagerId === user.employeeId;
}

// ---------------------------------------------------------------------------
// GET ?view=templates|cycles|cycle-detail|evaluation|employee-pending|dashboard|attendance-record
//   (view=smart-suggest was removed by DOM-007 and answers 410 Gone)
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const view = searchParams.get('view') || 'cycles';

    if (view === 'templates') {
      await requireUser(ROLE_GROUPS.MANAGERS);
      const templates = await prisma.evaluationTemplate.findMany({
        include: templateWithItems,
        orderBy: { createdAt: 'desc' },
      });
      return NextResponse.json(templates);
    }

    if (view === 'cycles') {
      const user = await requireUser(ROLE_GROUPS.MANAGERS);
      const scope = await evaluationScope(user);
      const cycles = await prisma.evaluationCycle.findMany({
        where: scope ? { evaluations: { some: scope } } : undefined,
        include: {
          template: { select: { name: true, targetType: true } },
          evaluations: {
            where: scope ?? undefined,
            select: { id: true, status: true, totalScore: true, finalRating: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      return NextResponse.json(cycles);
    }

    if (view === 'cycle-detail') {
      const user = await requireUser(ROLE_GROUPS.MANAGERS);
      const cycleId = zId.parse(searchParams.get('cycleId') ?? '');
      const scope = await evaluationScope(user);
      const cycle = await prisma.evaluationCycle.findUnique({
        where: { id: cycleId },
        include: {
          template: { include: templateWithItems },
          evaluations: {
            where: scope ?? undefined,
            include: {
              employee: {
                select: {
                  id: true,
                  employeeId: true,
                  firstNameArabic: true,
                  lastNameArabic: true,
                  jobTitle: true,
                  department: nameRef,
                  branch: nameRef,
                  directManager: { select: { firstNameArabic: true, lastNameArabic: true } },
                },
              },
              itemScores: true,
              approvals: { orderBy: { actionDate: 'desc' } },
            },
          },
        },
      });
      // The page treats a null body as "not found".
      if (!cycle) return NextResponse.json(null, { status: 404 });
      return NextResponse.json(cycle);
    }

    if (view === 'evaluation') {
      const user = await requireUser(ROLE_GROUPS.ALL);
      const evalId = zId.parse(searchParams.get('evalId') ?? '');
      const evaluation = await prisma.employeeEvaluation.findUnique({
        where: { id: evalId },
        include: {
          cycle: { include: { template: { include: templateWithItems } } },
          employee: {
            select: {
              id: true,
              employeeId: true,
              firstNameArabic: true,
              lastNameArabic: true,
              jobTitle: true,
              joinDate: true,
              nationality: true,
              directManagerId: true,
              department: nameRef,
              branch: nameRef,
              directManager: { select: { firstNameArabic: true, lastNameArabic: true } },
            },
          },
          itemScores: true,
          approvals: { orderBy: { actionDate: 'desc' } },
        },
      });
      if (!evaluation) return NextResponse.json(null, { status: 404 });
      const allowed =
        hasRole(user, ROLE_GROUPS.HR) ||
        (!!user.employeeId && evaluation.employeeId === user.employeeId) ||
        (hasRole(user, ROLE_GROUPS.MANAGERS) && isManagerOf(user, evaluation));
      if (!allowed) throw forbidden();
      return NextResponse.json(evaluation);
    }

    if (view === 'employee-pending') {
      const user = await requireUser(ROLE_GROUPS.ALL);
      // HR may look up any employee; everyone else only sees their own evaluations.
      const requested = searchParams.get('employeeId');
      const employeeId =
        hasRole(user, ROLE_GROUPS.HR) && requested ? zId.parse(requested) : await requireEmployeeId(user);

      const evals = await prisma.employeeEvaluation.findMany({
        where: { employeeId, status: EVAL_STATUS.PENDING_EMPLOYEE_ACK },
        include: {
          cycle: { select: { title: true, cycleType: true } },
          itemScores: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
      return NextResponse.json(evals);
    }

    if (view === 'dashboard') {
      await requireUser(ROLE_GROUPS.HR);
      const closedWhere: Prisma.EmployeeEvaluationWhereInput = { status: EVAL_STATUS.CLOSED, totalScore: { not: null } };
      const [allEvals, pendingManager, pendingApproval, pendingAck] = await Promise.all([
        prisma.employeeEvaluation.findMany({
          where: closedWhere,
          include: {
            employee: {
              select: {
                firstNameArabic: true,
                lastNameArabic: true,
                employeeId: true,
                jobTitle: true,
                department: nameRef,
                branch: nameRef,
              },
            },
            cycle: { select: { title: true, cycleType: true } },
          },
          orderBy: { totalScore: 'desc' },
        }),
        prisma.employeeEvaluation.count({ where: { status: EVAL_STATUS.PENDING_MANAGER } }),
        prisma.employeeEvaluation.count({ where: { status: EVAL_STATUS.PENDING_APPROVAL } }),
        prisma.employeeEvaluation.count({ where: { status: EVAL_STATUS.PENDING_EMPLOYEE_ACK } }),
      ]);

      const totals = allEvals.map((e) => e.totalScore ?? 0);
      const totalClosed = allEvals.length;
      const avgScore = totalClosed > 0 ? totals.reduce((s, t) => s + t, 0) / totalClosed : 0;
      const buckets = bucketScores(totals);

      const top5 = allEvals.slice(0, 5);
      const bottom5 = [...allEvals].sort((a, b) => (a.totalScore ?? 0) - (b.totalScore ?? 0)).slice(0, 5);

      const deptMap = new Map<string, { total: number; count: number }>();
      for (const e of allEvals) {
        const name = e.employee.department?.nameArabic || 'غير محدد';
        const d = deptMap.get(name) ?? { total: 0, count: 0 };
        d.total += e.totalScore ?? 0;
        d.count++;
        deptMap.set(name, d);
      }
      const deptAverages = [...deptMap.entries()]
        .map(([name, d]) => ({ name, avg: d.total / d.count, count: d.count }))
        .sort((a, b) => b.avg - a.avg);

      return NextResponse.json({
        totalClosed,
        avgScore: avgScore.toFixed(1),
        ...buckets,
        top5,
        bottom5,
        deptAverages,
        pendingManager,
        pendingApproval,
        pendingAck,
      });
    }

    if (view === 'attendance-record') {
      // Read-only raw attendance rows of the evaluated employee within the cycle period (DOM-007).
      // No scores, no leave data, no suggestions: the evaluator reads the record and decides alone.
      const user = await requireUser(ROLE_GROUPS.MANAGERS);
      const evalId = zId.parse(searchParams.get('evalId') ?? '');
      const evaluation = await prisma.employeeEvaluation.findUnique({
        where: { id: evalId },
        select: {
          employeeId: true,
          managerId: true,
          employee: { select: { directManagerId: true } },
          cycle: { select: { startDate: true, endDate: true } },
        },
      });
      if (!evaluation) throw notFound('التقييم غير موجود');
      if (!hasRole(user, ROLE_GROUPS.HR) && !isManagerOf(user, evaluation)) throw forbidden();
      const limit = 200;
      const rows = await prisma.attendance.findMany({
        where: { employeeId: evaluation.employeeId, date: { gte: evaluation.cycle.startDate, lte: evaluation.cycle.endDate } },
        select: { date: true, checkIn: true, checkOut: true, status: true, lateMinutes: true, earlyLeaveMin: true },
        orderBy: { date: 'desc' },
        take: limit + 1,
      });
      return NextResponse.json({
        from: evaluation.cycle.startDate,
        to: evaluation.cycle.endDate,
        rows: rows.slice(0, limit),
        truncated: rows.length > limit,
      });
    }

    if (view === 'smart-suggest') {
      // DOM-007 (WP-5): generated "smart" sub-scores were removed. They penalised statutory leave
      // (including future maternity leave) and tenure. Evaluators read the attendance record instead.
      await requireUser();
      throw new HttpError(410, 'أُلغيت خدمة اقتراح الدرجات. راجع سجل حضور الموظف وضع الدرجات بنفسك.');
    }

    throw badRequest('نوع العرض غير معروف');
  } catch (err) {
    return handleApiError(err, 'evaluations:GET');
  }
}

// ---------------------------------------------------------------------------
// POST { action, ... }
// ---------------------------------------------------------------------------

const createTemplateSchema = z.object({
  name: zText(200),
  description: zOptText(2000),
  targetType: z.enum(TEMPLATE_TARGET_TYPES).default('GENERAL'),
  evalType: z.enum(EVAL_PERIOD_TYPES).default('QUARTERLY'),
  sections: z
    .array(
      z.object({
        title: zText(200),
        weight: zNumber.refine((w) => w > 0 && w <= 100, 'الوزن يجب أن يكون بين 1 و 100'),
        items: z
          .array(
            z.object({
              title: zText(300),
              description: zOptText(1000),
              isRequired: zBool.optional(),
            }),
          )
          .min(1, 'كل محور يجب أن يحتوي على عنصر واحد على الأقل')
          .max(100),
      }),
    )
    .min(1, 'يجب إضافة محور واحد على الأقل')
    .max(30),
});

const createCycleSchema = z.object({
  title: zText(200),
  templateId: zId,
  cycleType: z.enum(EVAL_PERIOD_TYPES).default('QUARTERLY'),
  startDate: zDate,
  endDate: zDate,
  targetEmployeeIds: z.array(zId).max(20_000).optional(),
});

const saveScoresSchema = z.object({
  evaluationId: zId,
  scores: z
    .array(
      z.object({
        itemId: zId,
        score: zInt.refine((s) => s >= SCORE_MIN && s <= SCORE_MAX, `الدرجة يجب أن تكون بين ${SCORE_MIN} و ${SCORE_MAX}`),
        note: zOptText(1000),
      }),
    )
    .max(1000)
    .default([]),
  strengths: zOptText(5000),
  improvements: zOptText(5000),
  finalNotes: zOptText(5000),
  recommendation: z.preprocess((v) => (v === '' ? null : v), z.enum(RECOMMENDATIONS).nullable()).optional(),
  recommendationReason: zOptText(2000),
  submitForApproval: zBool.optional(),
});

const approvalSchema = z.object({
  evaluationId: zId,
  comment: zOptText(5000),
});

const acknowledgeSchema = z.object({
  evaluationId: zId,
  comment: zOptText(5000),
});

const closeCycleSchema = z.object({ cycleId: zId });

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const ip = getClientIp(req);
    const raw = await parseBody(req, z.object({ action: z.string().max(50) }).passthrough());
    const { action } = raw;

    // === إنشاء قالب تقييم جديد مع المحاور والعناصر ===
    if (action === 'CREATE_TEMPLATE') {
      if (!hasRole(user, ROLE_GROUPS.HR)) throw forbidden();
      const body = createTemplateSchema.parse(raw);
      if (!weightsAreValid(body.sections.map((s) => s.weight))) {
        throw badRequest('مجموع أوزان المحاور يجب أن يساوي 100%');
      }
      const template = await prisma.$transaction(async (tx) => {
        const row = await tx.evaluationTemplate.create({
          data: {
            name: body.name,
            description: body.description ?? null,
            targetType: body.targetType,
            evalType: body.evalType,
            sections: {
              create: body.sections.map((sec, si) => ({
                title: sec.title,
                weight: sec.weight,
                sortOrder: si,
                items: {
                  create: sec.items.map((item, ii) => ({
                    title: item.title,
                    description: item.description ?? null,
                    isRequired: item.isRequired !== false,
                    sortOrder: ii,
                  })),
                },
              })),
            },
          },
          include: { sections: { include: { items: true } } },
        });
        await logAudit(
          { userId: user.id, action: 'CREATE', entityType: 'EvaluationTemplate', entityId: row.id, details: { name: row.name }, ipAddress: ip },
          tx,
        );
        return row;
      });
      return NextResponse.json({ message: 'تم إنشاء نموذج التقييم بنجاح', data: template });
    }

    // === إنشاء قالب افتراضي (النموذج العام) ===
    if (action === 'CREATE_DEFAULT_TEMPLATE') {
      if (!hasRole(user, ROLE_GROUPS.HR)) throw forbidden();
      const existing = await prisma.evaluationTemplate.findFirst({ where: { name: DEFAULT_TEMPLATE_NAME } });
      if (existing) return NextResponse.json({ message: 'النموذج الافتراضي موجود مسبقاً', data: existing });

      const template = await prisma.$transaction(async (tx) => {
        const row = await tx.evaluationTemplate.create({
          data: {
            name: DEFAULT_TEMPLATE_NAME,
            description: 'نموذج تقييم شامل يناسب جميع الوظائف الإدارية والتشغيلية',
            targetType: 'GENERAL',
            evalType: 'QUARTERLY',
            sections: {
              create: DEFAULT_TEMPLATE_SECTIONS.map((sec, si) => ({
                title: sec.title,
                weight: sec.weight,
                sortOrder: si,
                items: { create: sec.items.map((title, ii) => ({ title, sortOrder: ii })) },
              })),
            },
          },
          include: { sections: { include: { items: true } } },
        });
        await logAudit(
          { userId: user.id, action: 'CREATE', entityType: 'EvaluationTemplate', entityId: row.id, details: { name: row.name, default: true }, ipAddress: ip },
          tx,
        );
        return row;
      });
      return NextResponse.json({ message: 'تم إنشاء النموذج الافتراضي بنجاح', data: template });
    }

    // === إنشاء دورة تقييم (الدورة + تقييم لكل موظف في معاملة واحدة) ===
    if (action === 'CREATE_CYCLE') {
      if (!hasRole(user, ROLE_GROUPS.HR)) throw forbidden();
      const body = createCycleSchema.parse(raw);
      if (body.endDate < body.startDate) throw badRequest('تاريخ نهاية الدورة يجب أن يكون بعد تاريخ البداية');

      const targetIds = body.targetEmployeeIds?.length ? [...new Set(body.targetEmployeeIds)] : null;
      const [template, employees] = await Promise.all([
        prisma.evaluationTemplate.findUnique({ where: { id: body.templateId }, select: { id: true } }),
        prisma.employee.findMany({
          where: { isTerminated: false, ...(targetIds ? { id: { in: targetIds } } : {}) },
          select: { id: true, directManagerId: true },
        }),
      ]);
      if (!template) throw badRequest('نموذج التقييم المحدد غير موجود');
      if (employees.length === 0) throw badRequest('لا يوجد موظفون على رأس العمل ضمن الدورة المحددة');

      const cycle = await prisma.$transaction(
        async (tx) => {
          const row = await tx.evaluationCycle.create({
            data: {
              title: body.title,
              templateId: body.templateId,
              cycleType: body.cycleType,
              startDate: body.startDate,
              endDate: body.endDate,
              status: CYCLE_STATUS.OPEN,
              createdBy: user.id,
            },
          });
          await tx.employeeEvaluation.createMany({
            data: employees.map((emp) => ({
              cycleId: row.id,
              employeeId: emp.id,
              managerId: emp.directManagerId,
              status: EVAL_STATUS.PENDING_MANAGER,
            })),
          });
          await logAudit(
            {
              userId: user.id,
              action: 'CREATE',
              entityType: 'EvaluationCycle',
              entityId: row.id,
              details: { title: row.title, templateId: row.templateId, employees: employees.length },
              ipAddress: ip,
            },
            tx,
          );
          return row;
        },
        { timeout: 30_000 },
      );

      return NextResponse.json({ message: `تم إنشاء دورة التقييم وإضافة ${employees.length} موظف`, data: cycle });
    }

    // === حفظ درجات التقييم (مسودة أو إرسال) ===
    if (action === 'SAVE_SCORES') {
      if (!hasRole(user, ROLE_GROUPS.MANAGERS)) throw forbidden();
      const body = saveScoresSchema.parse(raw);
      const submit = body.submitForApproval === true;

      const evaluation = await prisma.employeeEvaluation.findUnique({
        where: { id: body.evaluationId },
        select: {
          id: true,
          employeeId: true,
          managerId: true,
          status: true,
          employee: { select: { directManagerId: true } },
          cycle: {
            select: {
              status: true,
              template: {
                select: { sections: { select: { weight: true, items: { select: { id: true, isRequired: true } } } } },
              },
            },
          },
        },
      });
      if (!evaluation) throw notFound('التقييم غير موجود');
      if (!hasRole(user, ROLE_GROUPS.HR) && !isManagerOf(user, evaluation)) {
        throw forbidden('يمكنك تقييم موظفيك المباشرين فقط');
      }
      if (evaluation.cycle.status === CYCLE_STATUS.CLOSED) throw conflict('دورة التقييم مغلقة ولا يمكن التعديل');
      if (!(EVAL_EDITABLE_STATUSES as readonly string[]).includes(evaluation.status)) {
        throw conflict('لا يمكن تعديل التقييم في حالته الحالية');
      }

      const sections = evaluation.cycle.template.sections;
      const check = checkScores(sections, body.scores);
      if (check.unknownItemIds.length || check.duplicateItemIds.length || check.outOfRangeItemIds.length) {
        throw badRequest('بعض الدرجات المرسلة لا تتبع نموذج التقييم', check);
      }
      if (submit) {
        if (check.missingRequiredItemIds.length) {
          throw badRequest(`يرجى تقييم جميع العناصر الإلزامية قبل الإرسال (${check.missingRequiredItemIds.length} عنصر بدون تقييم)`);
        }
        if (!body.finalNotes) throw badRequest('الملاحظات الختامية إلزامية عند إرسال التقييم للاعتماد');
        if (!body.recommendation) throw badRequest('يرجى اختيار التوصية الإدارية');
        if (!body.recommendationReason) throw badRequest('يرجى كتابة سبب التوصية');
      }

      const totalScore = computeTotalScore(sections, body.scores);
      const finalRating = ratingForScore(totalScore);
      const nextStatus = submit ? EVAL_STATUS.PENDING_APPROVAL : EVAL_STATUS.PENDING_MANAGER;

      await prisma.$transaction(async (tx) => {
        // Guard the status atomically so a concurrent approval/submit can't be overwritten.
        const res = await tx.employeeEvaluation.updateMany({
          where: {
            id: evaluation.id,
            status: { in: [...EVAL_EDITABLE_STATUSES] },
            cycle: { status: { not: CYCLE_STATUS.CLOSED } },
          },
          data: {
            totalScore,
            finalRating,
            strengths: body.strengths ?? null,
            improvements: body.improvements ?? null,
            finalNotes: body.finalNotes ?? null,
            recommendation: body.recommendation ?? null,
            recommendationReason: body.recommendationReason ?? null,
            status: nextStatus,
          },
        });
        if (res.count === 0) throw conflict('تم تغيير حالة التقييم من مستخدم آخر، يرجى تحديث الصفحة');

        await tx.evaluationItemScore.deleteMany({ where: { evaluationId: evaluation.id } });
        if (body.scores.length > 0) {
          await tx.evaluationItemScore.createMany({
            data: body.scores.map((s) => ({
              evaluationId: evaluation.id,
              itemId: s.itemId,
              score: s.score,
              note: s.note ?? null,
            })),
          });
        }
        await logAudit(
          {
            userId: user.id,
            action: 'UPDATE',
            entityType: 'EmployeeEvaluation',
            entityId: evaluation.id,
            details: { totalScore, finalRating, status: nextStatus, items: body.scores.length },
            ipAddress: ip,
          },
          tx,
        );
      });

      return NextResponse.json({
        message: submit ? 'تم إرسال التقييم للاعتماد' : 'تم حفظ المسودة',
        totalScore,
        finalRating,
      });
    }

    // === اعتماد أو إعادة التقييم (الموارد البشرية) ===
    if (action === 'APPROVE_EVALUATION' || action === 'RETURN_EVALUATION') {
      if (!hasRole(user, ROLE_GROUPS.HR)) throw forbidden();
      const body = approvalSchema.parse(raw);
      const isApprove = action === 'APPROVE_EVALUATION';
      if (!isApprove && !body.comment) throw badRequest('يرجى كتابة سبب الإعادة');

      await prisma.$transaction(async (tx) => {
        const res = await tx.employeeEvaluation.updateMany({
          where: { id: body.evaluationId, status: EVAL_STATUS.PENDING_APPROVAL },
          data: { status: isApprove ? EVAL_STATUS.PENDING_EMPLOYEE_ACK : EVAL_STATUS.RETURNED },
        });
        if (res.count === 0) {
          const exists = await tx.employeeEvaluation.findUnique({ where: { id: body.evaluationId }, select: { id: true } });
          if (!exists) throw notFound('التقييم غير موجود');
          throw conflict('التقييم ليس بانتظار الاعتماد، يرجى تحديث الصفحة');
        }
        await tx.evaluationApproval.create({
          data: {
            evaluationId: body.evaluationId,
            approverId: user.id,
            approverName: user.name,
            action: isApprove ? APPROVAL_ACTION.APPROVE : APPROVAL_ACTION.RETURN,
            comment: body.comment ?? null,
          },
        });
        await logAudit(
          {
            userId: user.id,
            action: isApprove ? 'APPROVE' : 'REJECT',
            entityType: 'EmployeeEvaluation',
            entityId: body.evaluationId,
            details: { action: isApprove ? APPROVAL_ACTION.APPROVE : APPROVAL_ACTION.RETURN },
            ipAddress: ip,
          },
          tx,
        );
      });

      return NextResponse.json({
        message: isApprove ? 'تم اعتماد التقييم بنجاح' : 'تمت إعادة التقييم للمدير للتعديل',
      });
    }

    // === إقرار الموظف (الموظف نفسه فقط) ===
    if (action === 'EMPLOYEE_ACKNOWLEDGE') {
      const employeeId = await requireEmployeeId(user);
      const body = acknowledgeSchema.parse(raw);

      await prisma.$transaction(async (tx) => {
        const res = await tx.employeeEvaluation.updateMany({
          where: { id: body.evaluationId, employeeId, status: EVAL_STATUS.PENDING_EMPLOYEE_ACK },
          data: {
            employeeAcknowledgedAt: new Date(),
            employeeComment: body.comment ?? null,
            status: EVAL_STATUS.CLOSED,
          },
        });
        if (res.count === 0) {
          const ev = await tx.employeeEvaluation.findUnique({ where: { id: body.evaluationId }, select: { employeeId: true } });
          if (!ev || ev.employeeId !== employeeId) throw notFound('التقييم غير موجود');
          throw conflict('التقييم ليس بانتظار إقرارك');
        }
        await logAudit(
          {
            userId: user.id,
            action: 'UPDATE',
            entityType: 'EmployeeEvaluation',
            entityId: body.evaluationId,
            details: { acknowledged: true, status: EVAL_STATUS.CLOSED },
            ipAddress: ip,
          },
          tx,
        );
      });

      return NextResponse.json({ message: 'تم تسجيل إقرار الموظف وإغلاق التقييم' });
    }

    // === إغلاق دورة تقييم ===
    if (action === 'CLOSE_CYCLE') {
      if (!hasRole(user, ROLE_GROUPS.HR)) throw forbidden();
      const { cycleId } = closeCycleSchema.parse(raw);

      await prisma.$transaction(async (tx) => {
        const res = await tx.evaluationCycle.updateMany({
          where: { id: cycleId, status: { not: CYCLE_STATUS.CLOSED } },
          data: { status: CYCLE_STATUS.CLOSED },
        });
        if (res.count === 0) {
          const exists = await tx.evaluationCycle.findUnique({ where: { id: cycleId }, select: { id: true } });
          if (!exists) throw notFound('دورة التقييم غير موجودة');
          throw conflict('دورة التقييم مغلقة مسبقاً');
        }
        await logAudit(
          { userId: user.id, action: 'UPDATE', entityType: 'EvaluationCycle', entityId: cycleId, details: { status: CYCLE_STATUS.CLOSED }, ipAddress: ip },
          tx,
        );
      });
      return NextResponse.json({ message: 'تم إغلاق دورة التقييم' });
    }

    throw badRequest('إجراء غير معروف');
  } catch (err) {
    return handleApiError(err, 'evaluations:POST');
  }
}
