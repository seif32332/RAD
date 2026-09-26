import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { LEAVE_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zDate, zId, zOptDate, zOptInt, zOptText } from '@/lib/validation';
import { dateKey, daysBetween, today } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import { deactivateEmployeeUser } from '@/lib/access';
import { roundMoney } from '@/lib/money';
import { BLOCKING_LEAVE_ISSUES, describeLeaveIssue, parseStatutoryNoteMarkers } from '@/lib/leave';
import {
  approveLeave,
  assertCanManageEmployee,
  assertNoOverlappingLeave,
  cancelLeave,
  confirmLeaveReturn,
  evaluateLeave,
  lockEmployeeForUpdate,
  recordLeaveReturn,
  rejectLeave,
  rejectLeaveReturn,
} from '@/lib/hr-workflows';
import { defaultExitVoluntary, type ExitReason } from '@/app/api/employees/_workforce-fields';

export const dynamic = 'force-dynamic';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('APPROVE_MANAGER') }),
  z.object({ action: z.literal('APPROVE_HR') }),
  // A rejection must say why: the reason is shown to the employee in the portal.
  z.object({
    action: z.literal('REJECT'),
    reason: z.string({ required_error: 'سبب الرفض مطلوب', invalid_type_error: 'سبب الرفض مطلوب' }).trim().min(3, 'سبب الرفض مطلوب').max(1000),
  }),
  z.object({ action: z.literal('RETURN'), returnDate: zOptDate }),
  z.object({ action: z.literal('CONFIRM_RETURN') }),
  z.object({ action: z.literal('REJECT_RETURN') }),
  z.object({ action: z.literal('CANCEL') }),
  z.object({
    action: z.literal('ABSCOND'),
    terminationDate: zOptDate,
    /** Written reason (kept in the audit log). */
    reason: z.string({ required_error: 'سبب تسجيل الانقطاع مطلوب', invalid_type_error: 'سبب تسجيل الانقطاع مطلوب' })
      .trim()
      .min(3, 'سبب تسجيل الانقطاع مطلوب (نص مكتوب)')
      .max(1000),
    /** Explicit confirmation that a written warning was issued to the employee and recorded. */
    acknowledgeWarningIssued: z.literal(true, {
      errorMap: () => ({ message: 'يجب تأكيد توجيه إنذار كتابي للموظف وتوثيقه قبل تسجيل الانقطاع' }),
    }),
  }),
  z.object({
    action: z.literal('EXTEND'),
    newEndDate: zDate,
    extensionFileUrl: zOptText(2000),
    extensionReason: zOptText(1000),
  }),
  z.object({
    action: z.literal('EDIT'),
    newStartDate: zDate,
    newEndDate: zDate,
    /** Ignored: recomputed from the dates. Kept for backward compatibility. */
    totalDays: zOptInt,
    /** Optional HR override; never below the days not covered by the balance. */
    unpaidDays: zOptInt,
  }),
]);

type ActionBody = z.infer<typeof actionSchema>;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const { id: rawId } = await params;
    const id = zId.parse(rawId);
    const body = await parseBody(req, actionSchema);
    const ipAddress = getClientIp(req);
    const opts = { ipAddress };

    switch (body.action) {
      case 'APPROVE_MANAGER':
        await prisma.$transaction((tx) => approveLeave(tx, id, 'MANAGER', user, opts));
        return NextResponse.json({ message: 'تمت موافقة المدير المباشر بنجاح' });

      case 'APPROVE_HR':
        await prisma.$transaction((tx) => approveLeave(tx, id, 'HR', user, opts));
        return NextResponse.json({ message: 'تم اعتماد الاجازة من الموارد البشرية بنجاح' });

      case 'REJECT':
        await prisma.$transaction((tx) => rejectLeave(tx, id, user, body.reason, opts));
        return NextResponse.json({ message: 'تم رفض طلب الإجازة' });

      case 'RETURN':
        await prisma.$transaction((tx) => recordLeaveReturn(tx, id, body.returnDate ?? null, user, opts));
        return NextResponse.json({ message: 'تم إثبات العودة بنجاح، بانتظار تأكيد المباشرة من الموارد البشرية' });

      case 'CONFIRM_RETURN':
        await prisma.$transaction((tx) => confirmLeaveReturn(tx, id, user, opts));
        return NextResponse.json({ message: 'تم تأكيد عودة الموظف لرأس العمل بنجاح' });

      case 'REJECT_RETURN':
        await prisma.$transaction((tx) => rejectLeaveReturn(tx, id, user, opts));
        return NextResponse.json({ message: 'تم رفض إشعار المباشرة' });

      case 'CANCEL':
        await prisma.$transaction((tx) => cancelLeave(tx, id, user, opts));
        return NextResponse.json({ message: 'تم إلغاء الإجازة بنجاح' });

      case 'ABSCOND':
        await abscond(id, body, user, ipAddress);
        return NextResponse.json({ message: 'تم أرشفة الموظف ونقله لقائمة المستبعدين (خرج ولم يعد)' });

      case 'EXTEND':
      case 'EDIT':
        await changeDates(id, body, user, ipAddress);
        return NextResponse.json({ message: body.action === 'EXTEND' ? 'تم تمديد الإجازة بنجاح' : 'تم تعديل تواريخ الإجازة بنجاح' });
    }
  } catch (err) {
    return handleApiError(err, 'leaves/[id]/action:POST');
  }
}

type Actor = Awaited<ReturnType<typeof requireUser>>;

/** Leave types on which "خرج ولم يعد" is never recorded (DOM-004). */
const ABSCOND_PROTECTED_LEAVE_TYPES: readonly string[] = ['MATERNITY', 'SICK'];

/**
 * Why "خرج ولم يعد" cannot be recorded on this leave now (409), or null. It needs a leave that is
 * not maternity / sick and whose end date has passed; the termination date (if given) must fall
 * after the end of the leave.
 */
export function abscondProblem(l: { leaveType: string; endDate: Date }, asOf: Date, terminationDate?: Date | null): string | null {
  if (ABSCOND_PROTECTED_LEAVE_TYPES.includes(l.leaveType)) {
    return `لا يجوز تسجيل «خرج ولم يعد» على ${l.leaveType === 'MATERNITY' ? 'إجازة وضع' : 'إجازة مرضية'}. تعامل مع الحالة بعد انتهاء الإجازة وعودة الموظف أو انقطاعه.`;
  }
  const end = dateKey(l.endDate);
  if (daysBetween(l.endDate, asOf) <= 0) {
    return `لم تنتهِ الإجازة بعد (تنتهي في ${end}). لا يُسجَّل الانقطاع إلا بعد انقضاء تاريخ نهاية الإجازة وعدم عودة الموظف.`;
  }
  if (terminationDate && daysBetween(l.endDate, terminationDate) <= 0) {
    return `تاريخ الاستبعاد يجب أن يكون بعد تاريخ نهاية الإجازة (${end}).`;
  }
  return null;
}

/** "خرج ولم يعد": the employee did not come back from an approved leave. HR only. */
async function abscond(id: string, body: Extract<ActionBody, { action: 'ABSCOND' }>, user: Actor, ipAddress: string) {
  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  await prisma.$transaction(async (tx) => {
    const leave = await tx.leave.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        isReturned: true,
        leaveType: true,
        endDate: true,
        employeeId: true,
        employee: { select: { id: true, directManagerId: true, branchId: true, departmentId: true, isTerminated: true } },
      },
    });
    if (!leave) throw notFound('الإجازة غير موجودة');
    if (leave.status !== LEAVE_STATUS.APPROVED || leave.isReturned) throw conflict('لا يمكن تنفيذ الإجراء إلا على إجازة معتمدة قائمة');
    if (leave.employee.isTerminated) throw conflict('الموظف مستبعد مسبقاً');
    await assertCanManageEmployee(tx, user, leave.employee);
    const problem = abscondProblem(leave, today(), body.terminationDate ?? null);
    if (problem) throw conflict(problem);
    const terminationDate = body.terminationDate ?? today();
    const r = await tx.employee.updateMany({
      where: { id: leave.employeeId, isTerminated: false },
      data: { isTerminated: true, terminationDate, employmentStatus: 'EXCLUDED' },
    });
    if (r.count === 0) throw conflict('الموظف مستبعد مسبقاً');
    // Structured exit (workforce engine): "خرج ولم يعد" = ABSCONDING (انقطاع عن العمل), a voluntary
    // exit by default (defaultExitVoluntary). Recorded only when the file has no exit reason yet, so a
    // reason HR set by hand is never overwritten. The settlement reason (ARTICLE_80 or other) is still
    // chosen by HR in the settlement: ABSCONDING -> ARTICLE_80 is only a reading (EXIT_REASON_TO_TERMINATION).
    const exitReason: ExitReason = 'ABSCONDING';
    const exit = await tx.employee.updateMany({
      where: { id: leave.employeeId, exitReason: null },
      data: { exitReason, exitVoluntary: defaultExitVoluntary(exitReason) },
    });
    await deactivateEmployeeUser(tx, leave.employeeId, { reason: 'ABSCONDED', actorId: user.id, ipAddress });
    await logAudit(
      {
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Employee',
        entityId: leave.employeeId,
        details: {
          event: 'ABSCONDED',
          leaveId: id,
          leaveEndDate: dateKey(leave.endDate),
          terminationDate: dateKey(terminationDate),
          reason: body.reason,
          writtenWarningAcknowledged: true,
          exitReasonRecorded: exit.count > 0 ? exitReason : null,
        },
        ipAddress,
      },
      tx,
    );
  });
}

/** EXTEND / EDIT: new dates, days and deduction are recomputed on the server. HR only. */
async function changeDates(
  id: string,
  body: Extract<ActionBody, { action: 'EXTEND' | 'EDIT' }>,
  user: Actor,
  ipAddress: string,
) {
  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  await prisma.$transaction(async (tx) => {
    const leave = await tx.leave.findUnique({
      where: { id },
      select: {
        id: true,
        employeeId: true,
        leaveType: true,
        status: true,
        isReturned: true,
        startDate: true,
        endDate: true,
        unpaidDays: true,
        totalDeduction: true,
        notes: true,
        employee: { select: { id: true, directManagerId: true, branchId: true, departmentId: true } },
      },
    });
    if (!leave) throw notFound('الإجازة غير موجودة');
    const editable = leave.status === LEAVE_STATUS.PENDING || (leave.status === LEAVE_STATUS.APPROVED && !leave.isReturned);
    if (!editable) throw conflict('لا يمكن تعديل إجازة منتهية أو ملغاة أو مرفوضة');
    await assertCanManageEmployee(tx, user, leave.employee);
    await lockEmployeeForUpdate(tx, leave.employeeId);

    const startDate = body.action === 'EDIT' ? body.newStartDate : leave.startDate;
    const endDate = body.newEndDate;
    if (body.action === 'EXTEND' && daysBetween(leave.endDate, endDate) <= 0) {
      throw badRequest('تاريخ الانتهاء الجديد يجب أن يكون بعد تاريخ نهاية الإجازة الحالي');
    }
    await assertNoOverlappingLeave(tx, leave.employeeId, startDate, endDate, id);

    // Keep an existing HR waiver of the deduction.
    const wasWaived = (leave.unpaidDays ?? 0) > 0 && !(leave.totalDeduction ?? 0);
    // Statutory leaves keep the event date / bereavement relation recorded at creation (notes markers).
    const markers = parseStatutoryNoteMarkers(leave.notes);
    const evaluation = await evaluateLeave(tx, {
      employeeId: leave.employeeId,
      leaveType: leave.leaveType,
      startDate,
      endDate,
      acceptUnpaidExtraDays: true,
      waiveDeduction: wasWaived,
      excludeLeaveId: id,
      eventDate: markers.eventDate ? new Date(markers.eventDate + 'T00:00:00.000Z') : null,
      bereavementRelation: markers.bereavementRelation,
    });
    const { result } = evaluation;
    if (result.issue && BLOCKING_LEAVE_ISSUES.includes(result.issue)) {
      throw badRequest(describeLeaveIssue(result.issue, { leaveType: leave.leaveType, rules: evaluation.statutory?.rules, bereavementRelation: markers.bereavementRelation }), { issue: result.issue });
    }

    let paidDays = result.paidDays;
    let unpaidDays = result.unpaidDays;
    let totalDeduction = result.totalDeduction;
    if (body.action === 'EDIT' && body.unpaidDays !== undefined && leave.leaveType !== 'SICK') {
      const override = Math.min(evaluation.totalDays, Math.max(unpaidDays, body.unpaidDays));
      if (override !== unpaidDays) {
        unpaidDays = override;
        paidDays = evaluation.totalDays - unpaidDays;
        totalDeduction = wasWaived ? 0 : roundMoney(unpaidDays * evaluation.dailyRate);
      }
    }

    const r = await tx.leave.updateMany({
      where: { id, status: leave.status, isReturned: leave.isReturned, startDate: leave.startDate, endDate: leave.endDate },
      data: {
        startDate,
        endDate,
        totalDays: evaluation.totalDays,
        availableBalance: evaluation.balance.available,
        paidDays,
        unpaidDays,
        dailyDeductionRate: evaluation.dailyRate,
        totalDeduction,
        ...(body.action === 'EXTEND'
          ? {
              ...(body.extensionFileUrl !== undefined ? { extensionFileUrl: body.extensionFileUrl } : {}),
              ...(body.extensionReason !== undefined ? { extensionReason: body.extensionReason } : {}),
            }
          : {}),
      },
    });
    if (r.count === 0) throw conflict('تم تعديل الإجازة من مستخدم آخر، يرجى تحديث الصفحة');

    await logAudit(
      {
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Leave',
        entityId: id,
        details: {
          event: body.action,
          from: { startDate: leave.startDate, endDate: leave.endDate },
          to: { startDate, endDate, totalDays: evaluation.totalDays, paidDays, unpaidDays },
        },
        ipAddress,
      },
      tx,
    );
  });
}
