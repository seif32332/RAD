import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { LEAVE_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, parseBody, parseQuery } from '@/lib/http';
import { zBool, zDate, zId, zOptDate, zOptMoney, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import {
  BEREAVEMENT_RELATIONS,
  EVENT_DATED_LEAVE_TYPES,
  LEAVE_NOTE_MARKERS,
  LEAVE_TYPES,
  buildStatutoryNoteMarkers,
  describeLeaveIssue,
  isSaudiNationality,
} from '@/lib/leave';
import { dateKey } from '@/lib/dates';
import {
  assertNoOpenLeave,
  assertNoOverlappingLeave,
  evaluateLeave,
  findActiveExitReentryVisa,
  getExitReentryVisaFee,
  lockEmployeeForUpdate,
  managedEmployeesWhere,
} from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

/**
 * Roles that see every employee's leaves (HR + payroll). Branch / department managers see the
 * employees they manage (and themselves) so they can give the manager approval; everyone else
 * sees only their own.
 */
const LEAVE_READ_ALL = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.PAYROLL])];

const listQuery = z.object({
  employeeId: zId.optional(),
  status: z.enum([LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED, LEAVE_STATUS.REJECTED, LEAVE_STATUS.CANCELLED, LEAVE_STATUS.COMPLETED]).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const q = parseQuery(req, listQuery);
    const where: Prisma.LeaveWhereInput = {};
    const readAll = roleIn(user.role, LEAVE_READ_ALL);
    if (readAll) {
      if (q.employeeId) where.employeeId = q.employeeId;
    } else if (roleIn(user.role, ROLE_GROUPS.MANAGERS)) {
      const scope = await managedEmployeesWhere(prisma, user);
      if (scope) where.employee = scope;
      if (q.employeeId) where.employeeId = q.employeeId;
    } else {
      where.employeeId = await requireEmployeeId(user);
    }
    if (q.status) where.status = q.status;

    const leaves = await prisma.leave.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            firstNameArabic: true,
            lastNameArabic: true,
            employeeId: true,
            nationality: true,
            joinDate: true,
            // Salary only for HR / payroll readers.
            basicSalary: readAll,
            leaveAccrualStartDate: true,
            isTerminated: true,
            directManagerId: true,
            legalCompany: { select: { nameArabic: true } },
            branch: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(leaves);
  } catch (err) {
    return handleApiError(err, 'leaves:GET');
  }
}

const leaveTypeSchema = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(LEAVE_TYPES).default('ANNUAL'));

const createSchema = z.object({
  employeeId: zId.optional(),
  leaveType: leaveTypeSchema,
  startDate: zDate,
  endDate: zDate,
  notes: zOptText(2000),
  isOutsideKSA: zBool.optional(),
  acceptUnpaidExtraDays: zBool.optional(),
  waiveDeduction: zBool.optional(),
  flightTicketOption: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(['company_provided', 'amount']).optional()),
  flightTicketAmount: zOptMoney,
  /** PATERNITY / BEREAVEMENT / MARRIAGE: date of the birth / death / marriage (optional; enables the statutory window checks). */
  eventDate: zOptDate,
  /** BEREAVEMENT: FIRST_DEGREE (spouse / ascendant / descendant, default) or SIBLING. */
  bereavementRelation: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(BEREAVEMENT_RELATIONS).optional()),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const body = await parseBody(req, createSchema);
    const isHr = roleIn(user.role, ROLE_GROUPS.HR);

    // Only HR may file a leave for another employee; everyone else files for themselves.
    let employeeId: string;
    if (isHr && body.employeeId) {
      employeeId = body.employeeId;
    } else {
      employeeId = await requireEmployeeId(user);
      if (body.employeeId && body.employeeId !== employeeId) throw forbidden('لا يمكنك تقديم طلب إجازة لموظف آخر');
    }

    const eventDate = EVENT_DATED_LEAVE_TYPES.includes(body.leaveType) ? (body.eventDate ?? null) : null;
    const bereavementRelation = body.leaveType === 'BEREAVEMENT' ? (body.bereavementRelation ?? 'FIRST_DEGREE') : null;
    const markers = buildStatutoryNoteMarkers({ eventDate: dateKey(eventDate), bereavementRelation });
    const notes = [body.notes ?? '', markers].filter(Boolean).join(' ').trim() || null;
    const isOutsideKSA = body.isOutsideKSA === true || !!notes?.includes(LEAVE_NOTE_MARKERS.OUTSIDE);
    const acceptUnpaidExtraDays = body.acceptUnpaidExtraDays === true || !!notes?.includes(LEAVE_NOTE_MARKERS.ACCEPT_EXCESS);
    // Waiving the salary deduction is an HR decision only.
    const waiveDeduction = isHr && body.waiveDeduction === true;
    const flightTicketOption = body.flightTicketOption ?? null;
    const flightTicketAmount = flightTicketOption === 'amount' ? (body.flightTicketAmount ?? null) : null;

    const created = await prisma.$transaction(async (tx) => {
      await lockEmployeeForUpdate(tx, employeeId);
      const evaluation = await evaluateLeave(tx, {
        employeeId,
        leaveType: body.leaveType,
        startDate: body.startDate,
        endDate: body.endDate,
        acceptUnpaidExtraDays,
        waiveDeduction,
        eventDate,
        bereavementRelation,
      });
      if (evaluation.employee.isTerminated) throw conflict('لا يمكن تسجيل إجازة لموظف منتهية خدماته');
      if (evaluation.result.issue) {
        throw badRequest(describeLeaveIssue(evaluation.result.issue, { leaveType: body.leaveType, rules: evaluation.statutory?.rules, bereavementRelation }), {
          issue: evaluation.result.issue,
        });
      }

      await Promise.all([
        assertNoOpenLeave(tx, employeeId),
        assertNoOverlappingLeave(tx, employeeId, body.startDate, body.endDate),
      ]);

      const needsVisa = isOutsideKSA && !isSaudiNationality(evaluation.employee.nationality);
      if (needsVisa) {
        const existingVisa = await findActiveExitReentryVisa(tx, employeeId);
        if (existingVisa) throw conflict('يوجد معاملة تأشيرة خروج وعودة قائمة للموظف. لا يمكن إنشاء معاملة جديدة.');
      }
      const visaFee = needsVisa ? await getExitReentryVisaFee(tx) : 0;

      const { result } = evaluation;
      const leave = await tx.leave.create({
        data: {
          employeeId,
          leaveType: body.leaveType,
          startDate: body.startDate,
          endDate: body.endDate,
          totalDays: evaluation.totalDays,
          status: LEAVE_STATUS.PENDING,
          notes,
          availableBalance: evaluation.balance.available,
          paidDays: result.paidDays,
          unpaidDays: result.unpaidDays,
          dailyDeductionRate: evaluation.dailyRate,
          totalDeduction: result.totalDeduction,
          isOutsideKSA,
          exitReentryVisaCost: visaFee,
          flightTicketOption,
          flightTicketAmount,
          workingDaysBeforeLeave: body.leaveType === 'ANNUAL' ? body.startDate.getUTCDate() : null,
        },
      });
      return { leave, evaluation };
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Leave',
      entityId: created.leave.id,
      details: {
        employeeId,
        leaveType: created.leave.leaveType,
        totalDays: created.leave.totalDays,
        paidDays: created.leave.paidDays,
        unpaidDays: created.leave.unpaidDays,
        ...(created.evaluation.statutory
          ? { entitlementDays: created.evaluation.result.entitlementDays, eventDate: dateKey(eventDate), bereavementRelation }
          : {}),
      },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(
      {
        message: 'تم تسجيل طلب الإجازة بنجاح',
        leave: created.leave,
        balance: created.evaluation.balance,
        sickTiers: created.evaluation.result.sickTiers,
        entitlementDays: created.evaluation.result.entitlementDays ?? null,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err, 'leaves:POST');
  }
}
