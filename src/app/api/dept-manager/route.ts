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
import {
  CORRECTION_STATUS,
  GENERAL_REQUEST_PREFIX,
  approveAttendanceCorrection,
  approveLeave,
  rejectAttendanceCorrection,
  rejectLeave,
} from '@/lib/hr-workflows';

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

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const { departmentId } = parseQuery(req, querySchema);
    const scope = await managedDepartmentsWhere(user);

    if (!departmentId) {
      const departments = await prisma.department.findMany({
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

    const department = await prisma.department.findFirst({
      // AND (not a spread): the DEPT_MANAGER scope is itself `{ id }` and would overwrite the requested id.
      where: scope ? { AND: [{ id: departmentId }, scope] } : { id: departmentId },
      select: {
        id: true,
        nameArabic: true,
        nameEnglish: true,
        branchId: true,
        branch: { select: { nameArabic: true } },
        employees: {
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
      // Distinguish "does not exist" from "not yours".
      const exists = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
      if (!exists) throw notFound('القسم غير موجود');
      throw forbidden('هذا القسم ليس ضمن نطاق إدارتك');
    }

    const empIds = department.employees.map((e) => e.id);
    const activeIds = department.employees.filter((e) => !e.isTerminated && e.employmentStatus === 'ACTIVE').map((e) => e.id);
    const [corrections, todayAttendance] = await Promise.all([
      prisma.attendanceCorrection.findMany({
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
      prisma.attendance.findMany({
        where: { employeeId: { in: activeIds }, date: today() },
        select: { status: true, lateMinutes: true },
      }),
    ]);

    const stats = {
      totalEmployees: department.employees.length,
      activeEmployees: activeIds.length,
      onLeave: department.employees.filter((e) => e.employmentStatus === 'ON_LEAVE').length,
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
