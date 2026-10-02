import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zDate, zId, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { CORRECTION_STATUS, CORRECTION_TYPES, DATA_UPDATE_PREFIX, GENERAL_REQUEST_PREFIX, assertCanManageEmployee, managedEmployeesWhere, parseDataUpdateRequest } from '@/lib/hr-workflows';
import { resolveSelfContext, resolveTeamContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/** Roles that review corrections of other employees (HR + managers). */
const CORRECTION_REVIEWERS = ROLE_GROUPS.MANAGERS;

/**
 * P1-SCOPE context: HR works in its companies (ScopedContext), a branch / department manager in his
 * team inside his own company (TeamContext), everyone else on his own records (SelfContext).
 */
async function correctionContext(user: Awaited<ReturnType<typeof requireUser>>, onBehalf: boolean) {
  const actor = await resolveActor(prisma, user);
  if (onBehalf && roleIn(user.role, ROLE_GROUPS.HR)) return scopedContext(actor);
  if (onBehalf && roleIn(user.role, CORRECTION_REVIEWERS)) return resolveTeamContext(prisma, actor);
  return resolveSelfContext(prisma, actor);
}

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const ctx = await correctionContext(user, roleIn(user.role, CORRECTION_REVIEWERS));
    authz.assert(ctx, 'attendance.correction.read');
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
    const records = await scopedPrisma(ctx).attendanceCorrection.findMany({
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
    // BR-PAY-009 (RT-PAY-301): an IBAN change is the employee's own request from his portal
    // (/api/portal/correction), never a data-update line filed here (for oneself or for someone else).
    if (body.reason.trimStart().startsWith(DATA_UPDATE_PREFIX) && parseDataUpdateRequest(body.reason).ibanRequested) {
      throw forbidden('تغيير الآيبان يقدّمه الموظف بنفسه من بوابته الذاتية (طلب تغيير مالي)');
    }

    // Reviewers (HR / managers) may file a correction for an employee; others only for themselves.
    let employeeId: string;
    if (roleIn(user.role, CORRECTION_REVIEWERS) && body.employeeId) {
      employeeId = body.employeeId;
    } else {
      employeeId = await requireEmployeeId(user);
      if (body.employeeId && body.employeeId !== employeeId) throw forbidden('لا يمكنك تقديم طلب لموظف آخر');
    }

    // The employee must be inside the context (another company's employee is "not found").
    const ctx = await correctionContext(user, employeeId !== user.employeeId);
    authz.assert(ctx, 'attendance.correction.create');
    const db = scopedPrisma(ctx);
    const [employee, duplicate] = await Promise.all([
      db.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, directManagerId: true, branchId: true, departmentId: true },
      }),
      db.attendanceCorrection.findFirst({
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

    const correction = await db.attendanceCorrection.create({
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
