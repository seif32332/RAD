import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zDate, zId, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { CORRECTION_STATUS, CORRECTION_TYPES, GENERAL_REQUEST_PREFIX, assertCanManageEmployee, managedEmployeesWhere } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

/** Roles that review corrections of other employees (HR + managers). */
const CORRECTION_REVIEWERS = ROLE_GROUPS.MANAGERS;

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    let where: Prisma.AttendanceCorrectionWhereInput;
    if (roleIn(user.role, CORRECTION_REVIEWERS)) {
      // HR sees everything; branch/department managers see their scope.
      const scope = await managedEmployeesWhere(prisma, user);
      // Self-service requests ('[طلب: ...]', incl. data updates that may contain an IBAN) go to HR
      // only: a branch/department manager's view never receives them.
      where = scope ? { employee: scope, NOT: { reason: { startsWith: GENERAL_REQUEST_PREFIX } } } : {};
    } else {
      where = { employeeId: await requireEmployeeId(user) };
    }
    const records = await prisma.attendanceCorrection.findMany({
      where,
      include: {
        employee: {
          select: {
            firstNameArabic: true,
            lastNameArabic: true,
            employeeId: true,
            branch: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(records);
  } catch (err) {
    return handleApiError(err, 'attendance-corrections:GET');
  }
}

const createSchema = z.object({
  employeeId: zId.optional(),
  date: zDate,
  reason: zText(2000),
  attachmentUrl: zOptText(2000),
  correctionType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(CORRECTION_TYPES).optional()),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const body = await parseBody(req, createSchema);

    // Reviewers (HR / managers) may file a correction for an employee; others only for themselves.
    let employeeId: string;
    if (roleIn(user.role, CORRECTION_REVIEWERS) && body.employeeId) {
      employeeId = body.employeeId;
    } else {
      employeeId = await requireEmployeeId(user);
      if (body.employeeId && body.employeeId !== employeeId) throw forbidden('لا يمكنك تقديم طلب لموظف آخر');
    }

    const [employee, duplicate] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, directManagerId: true, branchId: true, departmentId: true },
      }),
      prisma.attendanceCorrection.findFirst({
        where: { employeeId, date: body.date, reason: body.reason, status: CORRECTION_STATUS.PENDING },
        select: { id: true },
      }),
    ]);
    if (!employee) throw notFound('الموظف غير موجود');
    // A manager filing for someone else must manage that employee.
    if (employeeId !== user.employeeId && !roleIn(user.role, ROLE_GROUPS.HR)) {
      await assertCanManageEmployee(prisma, user, employee);
    }
    if (duplicate) throw conflict('يوجد طلب مطابق قيد الانتظار حالياً.');

    const correction = await prisma.attendanceCorrection.create({
      data: {
        employeeId,
        date: body.date,
        reason: body.reason,
        attachmentUrl: body.attachmentUrl ?? null,
        ...(body.correctionType ? { correctionType: body.correctionType } : {}),
        status: CORRECTION_STATUS.PENDING,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'AttendanceCorrection',
      entityId: correction.id,
      details: { employeeId, correctionType: correction.correctionType },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم رفع طلب تصحيح الحضور بنجاح', correction }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'attendance-corrections:POST');
  }
}
