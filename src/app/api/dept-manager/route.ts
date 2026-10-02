// Department manager dashboard API.
//   GET                   -> { departments } the user may manage
//   GET ?departmentId=... -> { department, corrections, stats }
//   POST { action: APPROVE_LEAVE|REJECT_LEAVE, leaveId } | { action: APPROVE_CORRECTION|REJECT_CORRECTION, correctionId }
//        (REJECT_* require a non-empty reason; general requests "[طلب: ...]" are HR-only and never listed)
//
// Scope: HR/ADMIN see every department. A DEPT_MANAGER sees only their own department and a
// BRANCH_MANAGER the departments of their branch (resolved from the session user's Employee
// record). Approvals are the MANAGER stage of the shared workflows, which re-check that the
// employee is within the manager's scope.
//
// P1-SCOPE: HR works in its ScopedContext (its companies), the two manager roles in their TeamContext
// (inside their own legal company). Every read goes through the scoped client; a leave / correction
// of an employee outside the context is "not found" before the workflow runs.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireUser, type AuthUser } from '@/lib/auth';
import { LEAVE_STATUS, ROLE_GROUPS } from '@/lib/constants';
import { forbidden, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zId, zOptText, zText } from '@/lib/validation';
import { today } from '@/lib/dates';
import { ATTENDANCE_STATUS } from '@/lib/attendance';
import { onLeaveEmployeeIds } from '@/lib/leave-server';
import {
  CORRECTION_STATUS,
  GENERAL_REQUEST_PREFIX,
  approveAttendanceCorrection,
  approveLeave,
  rejectAttendanceCorrection,
  rejectLeave,
} from '@/lib/hr-workflows';
import { resolveTeamContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/** Department filter for the user: null = all departments (HR/ADMIN). */
async function managedDepartmentsWhere(user: AuthUser): Promise<Prisma.DepartmentWhereInput | null> {
  if (hasRole(user, ROLE_GROUPS.HR)) return null;
  if (!user.employeeId) return { id: '__none__' };
  const me = await prisma.employee.findUnique({ where: { id: user.employeeId }, select: { departmentId: true, branchId: true } });
  if (user.role === 'DEPT_MANAGER' && me?.departmentId) return { id: me.departmentId };
  if (user.role === 'BRANCH_MANAGER' && me?.branchId) return { branchId: me.branchId };
  return { id: '__none__' };
}

const querySchema = z.object({ departmentId: zId.optional() });

/** HR: its companies; the other managers: their team (P1-SCOPE). */
async function contextOf(user: AuthUser) {
  const actor = await resolveActor(prisma, user);
  const ctx = hasRole(user, ROLE_GROUPS.HR) ? scopedContext(actor) : await resolveTeamContext(prisma, actor);
  return { actor, ctx, db: scopedPrisma(ctx) };
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const { departmentId } = parseQuery(req, querySchema);
    const { actor, ctx, db } = await contextOf(user);
    authz.assert(ctx, 'deptManager.read');
    const scope = await managedDepartmentsWhere(user);

    if (!departmentId) {
      const departments = await db.department.findMany({
        where: scope ?? {},
        select: {
          id: true,
          nameArabic: true,
          nameEnglish: true,
          branchId: true,
          branch: { select: { nameArabic: true } },
          _count: { select: { employees: true } },
        },
        orderBy: { nameArabic: 'asc' },
      });
      return NextResponse.json({ departments });
    }

    const department = await db.department.findFirst({
      // AND (not a spread): the DEPT_MANAGER scope is itself `{ id }` and would overwrite the requested id.
      where: scope ? { AND: [{ id: departmentId }, scope] } : { id: departmentId },
      select: {
        id: true,
        nameArabic: true,
        nameEnglish: true,
        branchId: true,
        branch: { select: { nameArabic: true } },
        // Only the employees of the context (a department may hold an employee of another company).
        employees: {
          where: scopeWhere(ctx, 'Employee') ?? undefined,
          select: {
            id: true,
            employeeId: true,
            firstNameArabic: true,
            lastNameArabic: true,
            jobTitle: true,
            employmentStatus: true,
            isTerminated: true,
            joinDate: true,
            directManagerId: true,
            leaves: {
              where: { status: LEAVE_STATUS.PENDING },
              select: {
                id: true,
                leaveType: true,
                startDate: true,
                endDate: true,
                totalDays: true,
                status: true,
                isManagerApproved: true,
                notes: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
            },
            attendances: {
              select: { id: true, date: true, checkIn: true, checkOut: true, status: true, lateMinutes: true, earlyLeaveMin: true },
              orderBy: { date: 'desc' },
              take: 30,
            },
          },
          orderBy: { firstNameArabic: 'asc' },
        },
      },
    });

    if (!department) {
      // Distinguish "does not exist" (or another company's) from "not yours".
      const exists = await scopedPrisma(scopedContext(actor)).department.findUnique({ where: { id: departmentId }, select: { id: true } });
      if (!exists) throw notFound('القسم غير موجود');
      throw forbidden('هذا القسم ليس ضمن نطاق إدارتك');
    }

    const empIds = department.employees.map((e) => e.id);
    // "On leave" is read from approved Leave rows covering today (BR-LCY-008), never from a stored
    // status (EV-3902): active = in service and not on leave today.
    const todayDate = today();
    const inServiceIds = department.employees.filter((e) => !e.isTerminated && e.employmentStatus !== 'EXCLUDED').map((e) => e.id);
    const onLeaveIds = await onLeaveEmployeeIds(prisma, inServiceIds, todayDate);
    const activeIds = inServiceIds.filter((id) => !onLeaveIds.has(id));
    const [corrections, todayAttendance] = await Promise.all([
      db.attendanceCorrection.findMany({
        // Fingerprint corrections only: general requests (letters, data update incl. IBAN) go
        // straight to HR and must not be shown to the manager (DOM-006).
        where: { employeeId: { in: empIds }, status: CORRECTION_STATUS.PENDING, NOT: { reason: { startsWith: GENERAL_REQUEST_PREFIX } } },
        select: {
          id: true,
          employeeId: true,
          date: true,
          reason: true,
          correctionType: true,
          status: true,
          isManagerApproved: true,
          attachmentUrl: true,
          createdAt: true,
          employee: { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.attendance.findMany({
        where: { employeeId: { in: activeIds }, date: todayDate },
        select: { status: true, lateMinutes: true },
      }),
    ]);

    const stats = {
      totalEmployees: department.employees.length,
      activeEmployees: activeIds.length,
      onLeave: onLeaveIds.size,
      excluded: department.employees.filter((e) => e.employmentStatus === 'EXCLUDED' || e.isTerminated).length,
      pendingLeaves: department.employees.reduce((sum, e) => sum + e.leaves.length, 0),
      presentToday: todayAttendance.filter((a) => a.status === ATTENDANCE_STATUS.PRESENT).length,
      absentToday: todayAttendance.filter((a) => a.status === ATTENDANCE_STATUS.ABSENT).length,
      lateToday: todayAttendance.filter((a) => a.status === ATTENDANCE_STATUS.PRESENT && a.lateMinutes > 0).length,
    };

    return NextResponse.json({ department, corrections, stats });
  } catch (err) {
    return handleApiError(err, 'dept-manager:GET');
  }
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('APPROVE_LEAVE'), leaveId: zId, reason: zOptText(1000) }),
  // A rejection always carries its reason: the employee sees it in the portal.
  z.object({ action: z.literal('REJECT_LEAVE'), leaveId: zId, reason: zText(1000) }),
  z.object({ action: z.literal('APPROVE_CORRECTION'), correctionId: zId, reason: zOptText(1000) }),
  z.object({ action: z.literal('REJECT_CORRECTION'), correctionId: zId, reason: zText(1000) }),
]);

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const body = await parseBody(req, actionSchema);
    const opts = { ipAddress: getClientIp(req) };
    const { ctx, db } = await contextOf(user);
    // The request must belong to an employee of the context (404 otherwise); the workflow then
    // re-checks the manager rules (own request, team, stage).
    const placement = { select: { id: true, legalCompanyId: true, directManagerId: true, branchId: true, departmentId: true } } as const;
    const target =
      'leaveId' in body
        ? await db.leave.findUnique({ where: { id: body.leaveId }, select: { employee: placement } })
        : await db.attendanceCorrection.findUnique({ where: { id: body.correctionId }, select: { employee: placement } });
    if (!target) throw notFound('leaveId' in body ? 'الإجازة غير موجودة' : 'طلب التصحيح غير موجود');
    const e = target.employee;
    authz.assert(
      ctx,
      'deptManager.request.decide',
      { companyId: e.legalCompanyId, employeeId: e.id, directManagerId: e.directManagerId, branchId: e.branchId, departmentId: e.departmentId },
      'لا يمكنك اعتماد أو رفض طلب يخصك',
    );

    const message = await prisma.$transaction(async (tx) => {
      switch (body.action) {
        case 'APPROVE_LEAVE':
          await approveLeave(tx, body.leaveId, 'MANAGER', user, opts);
          return 'تم اعتماد الإجازة من المدير وإحالتها للموارد البشرية';
        case 'REJECT_LEAVE':
          await rejectLeave(tx, body.leaveId, user, body.reason, opts);
          return 'تم رفض الإجازة';
        case 'APPROVE_CORRECTION': {
          const res = await approveAttendanceCorrection(tx, body.correctionId, user, { ...opts, stage: 'MANAGER', comment: body.reason });
          return res.message || 'تم اعتماد التصحيح';
        }
        case 'REJECT_CORRECTION':
          await rejectAttendanceCorrection(tx, body.correctionId, user, body.reason, opts);
          return 'تم رفض التصحيح';
      }
    });

    return NextResponse.json({ message });
  } catch (err) {
    return handleApiError(err, 'dept-manager:POST');
  }
}
