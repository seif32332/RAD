import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zBool, zId, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { SHIFT_TYPES, normalizeTimeOfDay } from '@/lib/attendance';

export const dynamic = 'force-dynamic';

const branchSelect = { select: { id: true, nameArabic: true } } as const;

export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { branchId } = parseQuery(req, z.object({ branchId: zId.optional() }));
    const schedules = await prisma.workSchedule.findMany({
      where: branchId ? { branchId } : undefined,
      include: { branch: branchSelect },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(schedules);
  } catch (err) {
    return handleApiError(err, 'work-schedules:GET');
  }
}

/** Optional "HH:MM" time: ''/null -> null, normalized to zero-padded 24h. */
const zOptTime = z
  .preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z
      .string()
      .trim()
      .nullable()
      .refine((s) => s === null || normalizeTimeOfDay(s) !== null, 'وقت غير صالح (HH:MM)')
      .transform((s) => (s === null ? null : normalizeTimeOfDay(s))),
  )
  .optional();

const scheduleFields = z
  .object({
    name: zText(200),
    shiftType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(SHIFT_TYPES).default('ONE_SHIFT')),
    startTime: zOptTime,
    endTime: zOptTime,
    startTime2: zOptTime,
    endTime2: zOptTime,
    workDays: zOptText(200),
    flexibleHours: z.preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : typeof v === 'string' ? Number(v) : v),
      z.number().min(0).max(24).nullable(),
    ).optional(),
    isExemptFromAttendance: zBool.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.shiftType === 'FLEXIBLE' || s.isExemptFromAttendance) return;
    if ((s.startTime && !s.endTime) || (!s.startTime && s.endTime)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'يجب تحديد وقت البداية والنهاية معاً' });
    }
    if (s.shiftType === 'TWO_SHIFTS' && ((s.startTime2 && !s.endTime2) || (!s.startTime2 && s.endTime2))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime2'], message: 'يجب تحديد وقت بداية ونهاية الفترة الثانية معاً' });
    }
  });

type ScheduleFields = z.infer<typeof scheduleFields>;

function scheduleData(s: ScheduleFields) {
  const flexible = s.shiftType === 'FLEXIBLE';
  const twoShifts = s.shiftType === 'TWO_SHIFTS';
  return {
    name: s.name,
    shiftType: s.shiftType,
    startTime: flexible ? null : (s.startTime ?? null),
    endTime: flexible ? null : (s.endTime ?? null),
    startTime2: twoShifts ? (s.startTime2 ?? null) : null,
    endTime2: twoShifts ? (s.endTime2 ?? null) : null,
    workDays: s.workDays ?? null,
    flexibleHours: flexible ? (s.flexibleHours ?? 0) : null,
    isExemptFromAttendance: s.isExemptFromAttendance ?? false,
  };
}

async function assertBranchExists(branchId: string) {
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true } });
  if (!branch) throw notFound('الفرع غير موجود');
}

const createSchema = scheduleFields.and(z.object({ branchId: zId }));

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, createSchema);
    await assertBranchExists(body.branchId);
    const schedule = await prisma.workSchedule.create({ data: { branchId: body.branchId, ...scheduleData(body) } });
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'WorkSchedule',
      entityId: schedule.id,
      details: { branchId: body.branchId, name: schedule.name },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'Work schedule created', schedule }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'work-schedules:POST');
  }
}

const replaceSchema = z.object({
  branchId: zId,
  schedules: z.array(scheduleFields).max(50),
});

/**
 * PUT { branchId, schedules: [...] }: atomically replaces all schedules of a branch
 * (use this instead of DELETE ?branchId + N x POST from the branch edit page).
 */
export async function PUT(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, replaceSchema);
    await assertBranchExists(body.branchId);
    const schedules = await prisma.$transaction(async (tx) => {
      await tx.workSchedule.deleteMany({ where: { branchId: body.branchId } });
      if (body.schedules.length) {
        await tx.workSchedule.createMany({ data: body.schedules.map((s) => ({ branchId: body.branchId, ...scheduleData(s) })) });
      }
      return tx.workSchedule.findMany({ where: { branchId: body.branchId }, orderBy: { createdAt: 'desc' } });
    });
    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'WorkSchedule',
      entityId: body.branchId,
      details: { event: 'BRANCH_SCHEDULES_REPLACED', count: schedules.length, names: schedules.map((s) => s.name) },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تم حفظ جداول العمل بنجاح', schedules });
  } catch (err) {
    return handleApiError(err, 'work-schedules:PUT');
  }
}

const deleteQuery = z.object({ id: zId.optional(), branchId: zId.optional() });

/**
 * DELETE ?id=<scheduleId>          deletes one schedule.
 * DELETE ?branchId=<id>[&id=<id>]  deletes the schedules of that branch (only `id` when given).
 */
export async function DELETE(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const q = parseQuery(req, deleteQuery);
    if (!q.id && !q.branchId) throw badRequest('يجب تحديد جدول العمل أو الفرع');

    if (q.id) {
      const schedule = await prisma.workSchedule.findUnique({ where: { id: q.id }, select: { id: true, branchId: true, name: true } });
      if (!schedule || (q.branchId && schedule.branchId !== q.branchId)) throw notFound('جدول العمل غير موجود');
      await prisma.workSchedule.delete({ where: { id: q.id } });
      await logAudit({
        userId: user.id,
        action: 'DELETE',
        entityType: 'WorkSchedule',
        entityId: q.id,
        details: { branchId: schedule.branchId, name: schedule.name },
        ipAddress: getClientIp(req),
      });
      return NextResponse.json({ message: 'تم حذف جدول العمل بنجاح', count: 1 });
    }

    const branchId = q.branchId as string;
    await assertBranchExists(branchId);
    const result = await prisma.workSchedule.deleteMany({ where: { branchId } });
    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'WorkSchedule',
      entityId: branchId,
      details: { event: 'BRANCH_SCHEDULES_DELETED', count: result.count },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تم حذف جداول العمل بنجاح', count: result.count });
  } catch (err) {
    return handleApiError(err, 'work-schedules:DELETE');
  }
}
