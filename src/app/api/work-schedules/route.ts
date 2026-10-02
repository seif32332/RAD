// Work patterns of a branch (WorkSchedule = the WorkPattern of the calendar module, P1-CAL).
//   GET     ?branchId            the active patterns of the caller's companies (one branch when given)
//   POST    { branchId, … }      creates one pattern
//   PUT     { branchId, schedules }  makes the branch's patterns equal to the list: kept patterns keep
//                                their id (employees point to them), removed ones are archived
//   DELETE  ?id | ?branchId      archives one pattern, or all of a branch
// Writes go through the calendar transitions (audit + event, idempotent on Idempotency-Key).
// Scope: the branch's company must be in the caller's companies (403 otherwise).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zBool, zId, zOptText, zText } from '@/lib/validation';
import { SHIFT_TYPES, normalizeTimeOfDay } from '@/lib/attendance';
import { authz, resolveActor, scopedContext, scopedPrisma, type Actor } from '@/modules/iam';
import { archiveWorkPattern, replaceBranchPatterns, saveWorkPattern, type WorkPatternFields } from '@/modules/calendar';
import { calendarHttpError, companiesOf, operationOf } from '../calendar/_shared';

export const dynamic = 'force-dynamic';

const branchSelect = { select: { id: true, nameArabic: true } } as const;

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { branchId } = parseQuery(req, z.object({ branchId: zId.optional() }));
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'calendar.read');
    const schedules = await scopedPrisma(ctx).workSchedule.findMany({
      where: { archivedAt: null, ...(branchId ? { branchId } : {}) },
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
    /** An existing pattern of the branch (PUT keeps it); a new draft id is ignored. */
    id: z.string().trim().max(64).optional().nullable(),
    name: zText(200),
    shiftType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(SHIFT_TYPES).default('ONE_SHIFT')),
    startTime: zOptTime,
    endTime: zOptTime,
    startTime2: zOptTime,
    endTime2: zOptTime,
    workDays: zOptText(200),
    /** Structured working days (0 = Sunday … 6 = Saturday); default: read from workDays. */
    workWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().nullable(),
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

function fieldsOf(s: ScheduleFields): WorkPatternFields & { id?: string | null } {
  return {
    id: s.id ?? null,
    name: s.name,
    shiftType: s.shiftType,
    startTime: s.startTime ?? null,
    endTime: s.endTime ?? null,
    startTime2: s.startTime2 ?? null,
    endTime2: s.endTime2 ?? null,
    workDays: s.workDays ?? null,
    workWeekdays: s.workWeekdays ?? null,
    flexibleHours: s.flexibleHours ?? null,
    isExemptFromAttendance: s.isExemptFromAttendance ?? false,
  };
}

/** The branch and its company, and the HR context of that company (403 outside the caller's scope). */
async function branchContext(actor: Actor, branchId: string) {
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, companyId: true } });
  if (!branch) throw notFound('الفرع غير موجود');
  const ctx = scopedContext(actor, [branch.companyId]);
  authz.assert(ctx, 'calendar.manage', { companyId: branch.companyId });
  return { branch, companyIds: companiesOf(ctx) };
}

const createSchema = scheduleFields.and(z.object({ branchId: zId }));

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, createSchema);
    const { branch, companyIds } = await branchContext(await resolveActor(prisma, user), body.branchId);
    const out = await saveWorkPattern(prisma, { branchId: branch.id, companyId: branch.companyId, pattern: fieldsOf({ ...body, id: null }), companyIds }, operationOf(req, user.id)).catch((e) => {
      throw calendarHttpError(e);
    });
    return NextResponse.json({ message: 'Work schedule created', schedule: out.result.pattern }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'work-schedules:POST');
  }
}

const replaceSchema = z.object({
  branchId: zId,
  schedules: z.array(scheduleFields).max(50),
});

export async function PUT(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, replaceSchema);
    const { branch, companyIds } = await branchContext(await resolveActor(prisma, user), body.branchId);
    const out = await replaceBranchPatterns(
      prisma,
      { branchId: branch.id, companyId: branch.companyId, patterns: body.schedules.map(fieldsOf), companyIds },
      operationOf(req, user.id),
    ).catch((e) => {
      throw calendarHttpError(e);
    });
    const schedules = [...out.result.patterns].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return NextResponse.json({ message: 'تم حفظ جداول العمل بنجاح', schedules, archived: out.result.archived });
  } catch (err) {
    return handleApiError(err, 'work-schedules:PUT');
  }
}

const deleteQuery = z.object({ id: zId.optional(), branchId: zId.optional() });

export async function DELETE(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const q = parseQuery(req, deleteQuery);
    if (!q.id && !q.branchId) throw badRequest('يجب تحديد جدول العمل أو الفرع');
    const actor = await resolveActor(prisma, user);

    if (q.id) {
      const row = await prisma.workSchedule.findUnique({ where: { id: q.id }, select: { id: true, branchId: true } });
      if (!row || (q.branchId && row.branchId !== q.branchId)) throw notFound('جدول العمل غير موجود');
      const { companyIds } = await branchContext(actor, row.branchId);
      await archiveWorkPattern(prisma, { id: row.id, branchId: row.branchId, companyIds }, operationOf(req, user.id)).catch((e) => {
        throw calendarHttpError(e);
      });
      return NextResponse.json({ message: 'تم حذف جدول العمل بنجاح', count: 1 });
    }

    const { branch, companyIds } = await branchContext(actor, q.branchId as string);
    const out = await replaceBranchPatterns(prisma, { branchId: branch.id, companyId: branch.companyId, patterns: [], companyIds }, operationOf(req, user.id)).catch((e) => {
      throw calendarHttpError(e);
    });
    return NextResponse.json({ message: 'تم حذف جداول العمل بنجاح', count: out.result.archived.length });
  } catch (err) {
    return handleApiError(err, 'work-schedules:DELETE');
  }
}
