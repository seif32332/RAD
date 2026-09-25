import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zDate, zId, zOptInt, zOptText } from '@/lib/validation';
import { dateKey } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import { ATTENDANCE_SOURCE, ATTENDANCE_STATUS, buildPunches, computeLateEarly, normalizeTimeOfDay } from '@/lib/attendance';
import { assertCanManageEmployee, resolveEmployeeSchedule } from '@/lib/hr-workflows';
import { deleteBiometricImage } from '@/lib/biometric-storage';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

const employeeSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  biometricId: true,
  branchId: true,
  workSchedule: true,
  attendanceGeoExempt: true,
  attendanceFaceExempt: true,
  attendanceExemptReason: true,
  faceProfile: { select: { createdAt: true, model: true } },
  branch: { select: { nameArabic: true } },
  department: { select: { nameArabic: true } },
} as const;

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.HR);
    const [attendances, employees, schedules] = await Promise.all([
      prisma.attendance.findMany({
        include: { employee: { select: employeeSelect } },
        orderBy: { date: 'desc' },
        take: 500, // Limit history for performance
      }),
      prisma.employee.findMany({ select: employeeSelect, orderBy: { firstNameArabic: 'asc' } }),
      prisma.workSchedule.findMany({ include: { branch: { select: { id: true, nameArabic: true } } } }),
    ]);
    return NextResponse.json({ attendances, employees, schedules });
  } catch (err) {
    return handleApiError(err, 'attendance-hub:GET');
  }
}

const timeSchema = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z
    .string()
    .trim()
    .refine((s) => normalizeTimeOfDay(s) !== null, 'وقت غير صالح (HH:MM)')
    .transform((s) => normalizeTimeOfDay(s) as string)
    .optional(),
);

const bodySchema = z.discriminatedUnion('actionType', [
  z.object({
    actionType: z.literal('UPDATE_BIOMETRIC'),
    payload: z.object({ id: zId, biometricId: zOptText(50) }),
  }),
  z.object({
    actionType: z.literal('ADD_ATTENDANCE'),
    payload: z.object({
      employeeId: zId,
      date: zDate,
      checkIn: timeSchema,
      checkOut: timeSchema,
      /** Manual values, used only when the employee has no work schedule. */
      lateMinutes: zOptInt,
      earlyLeaveMin: zOptInt,
      overtimeMin: zOptInt,
    }),
  }),
  z.object({
    // Self clock-in exemptions. Field staff: no location check (face still required).
    // Face exemption (e.g. face covering): owner decision only (location still required). Never both.
    actionType: z.literal('SET_ATTENDANCE_EXEMPTIONS'),
    payload: z.object({ employeeId: zId, geoExempt: zBool, faceExempt: zBool, reason: zOptText(500) }),
  }),
  z.object({
    // Deletes the employee's reference face so they can enroll again (new phone camera, wrong capture...).
    actionType: z.literal('RESET_FACE'),
    payload: z.object({ employeeId: zId, reason: zOptText(500) }),
  }),
]);

const scopeSelect = { id: true, directManagerId: true, branchId: true, departmentId: true } as const;

const nonNegative = (n: number | undefined) => Math.max(0, n ?? 0);

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, bodySchema);
    const ipAddress = getClientIp(req);

    if (body.actionType === 'UPDATE_BIOMETRIC') {
      const { id, biometricId } = body.payload;
      let updated;
      try {
        updated = await prisma.employee.update({
          where: { id },
          data: { biometricId: biometricId ?? null },
          select: { id: true, employeeId: true, biometricId: true },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw conflict('رقم البصمة مستخدم لموظف آخر');
        }
        throw err;
      }
      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Employee',
        entityId: id,
        details: { event: 'BIOMETRIC_UPDATED', biometricId: updated.biometricId },
        ipAddress,
      });
      return NextResponse.json({ message: 'تم تحديث رقم البصمة للموظف', data: updated });
    }

    if (body.actionType === 'SET_ATTENDANCE_EXEMPTIONS') {
      const { employeeId, geoExempt, faceExempt } = body.payload;
      const reason = body.payload.reason?.trim() || null;
      const before = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { ...scopeSelect, attendanceGeoExempt: true, attendanceFaceExempt: true, attendanceExemptReason: true },
      });
      if (!before) throw notFound('الموظف غير موجود');
      // HR cannot exempt themselves (the owner group can).
      await assertCanManageEmployee(prisma, user, before);
      if (geoExempt && faceExempt) throw badRequest('لا يمكن استثناء الموظف من الموقع ومن التحقق من الوجه معاً');
      if ((geoExempt || faceExempt) && (!reason || reason.length < 3)) throw badRequest('يرجى كتابة سبب الاستثناء');
      if (faceExempt && !before.attendanceFaceExempt && !roleIn(user.role, ROLE_GROUPS.OWNER)) {
        throw forbidden('الاستثناء من التحقق من الوجه يعتمده مالك المنشأة فقط');
      }
      const updated = await prisma.employee.update({
        where: { id: employeeId },
        data: { attendanceGeoExempt: geoExempt, attendanceFaceExempt: faceExempt, attendanceExemptReason: geoExempt || faceExempt ? reason : null },
        select: { id: true, attendanceGeoExempt: true, attendanceFaceExempt: true, attendanceExemptReason: true },
      });
      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Employee',
        entityId: employeeId,
        details: {
          event: 'ATTENDANCE_EXEMPTIONS',
          before: { geoExempt: before.attendanceGeoExempt, faceExempt: before.attendanceFaceExempt },
          after: { geoExempt, faceExempt },
          reason,
        },
        ipAddress,
      });
      return NextResponse.json({ message: 'تم تحديث استثناءات الحضور', data: updated });
    }

    if (body.actionType === 'RESET_FACE') {
      const { employeeId } = body.payload;
      const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { ...scopeSelect, faceProfile: { select: { id: true, photoStoredName: true } } } });
      if (!emp) throw notFound('الموظف غير موجود');
      await assertCanManageEmployee(prisma, user, emp);
      if (!emp.faceProfile) throw conflict('لا توجد صورة وجه مسجلة لهذا الموظف');
      await prisma.faceProfile.delete({ where: { id: emp.faceProfile.id } });
      await deleteBiometricImage(emp.faceProfile.photoStoredName);
      await logAudit({
        userId: user.id,
        action: 'DELETE',
        entityType: 'FaceProfile',
        entityId: emp.faceProfile.id,
        details: { employeeId, event: 'FACE_RESET_BY_HR', reason: body.payload.reason?.trim() || null },
        ipAddress,
      });
      return NextResponse.json({ message: 'تم حذف صورة الوجه المسجلة، ويمكن للموظف التسجيل من جديد' });
    }

    // ADD_ATTENDANCE: manual attendance entry. Times are Riyadh wall-clock times.
    // A time left empty keeps the stored punch (e.g. HR adds only the check-out of a day that
    // already has a self check-in), instead of wiping it.
    const p = body.payload;
    const day = dateKey(p.date);
    if (!day) throw badRequest('تاريخ غير صالح');
    if (!p.checkIn && !p.checkOut) throw badRequest('يرجى إدخال وقت الحضور أو الانصراف');
    const date = new Date(`${day}T00:00:00.000Z`);
    const [{ schedule }, existing] = await Promise.all([
      resolveEmployeeSchedule(prisma, p.employeeId),
      prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: p.employeeId, date } },
        select: { checkIn: true, checkOut: true, checkInSource: true, checkOutSource: true },
      }),
    ]);

    const typed = buildPunches(day, p.checkIn, p.checkOut);
    const checkIn = typed.checkIn ?? existing?.checkIn ?? null;
    let checkOut = typed.checkOut ?? existing?.checkOut ?? null;
    // A check-out typed alone that is not after the kept check-in belongs to the next day (overnight).
    if (!p.checkIn && p.checkOut && checkIn && checkOut && checkOut.getTime() <= checkIn.getTime()) {
      checkOut = new Date(checkOut.getTime() + DAY_MS);
    }
    const calc = computeLateEarly({ schedule, dayKey: day, checkIn, checkOut });
    const minutes = calc.hasSchedule
      ? { lateMinutes: calc.lateMinutes, earlyLeaveMin: calc.earlyLeaveMin, overtimeMin: calc.overtimeMin }
      : { lateMinutes: nonNegative(p.lateMinutes), earlyLeaveMin: nonNegative(p.earlyLeaveMin), overtimeMin: nonNegative(p.overtimeMin) };
    const values = {
      checkIn,
      checkOut,
      checkInSource: p.checkIn ? ATTENDANCE_SOURCE.MANUAL : (existing?.checkInSource ?? null),
      checkOutSource: p.checkOut ? ATTENDANCE_SOURCE.MANUAL : (existing?.checkOutSource ?? null),
      status: ATTENDANCE_STATUS.PRESENT,
      ...minutes,
      earlyMinutes: minutes.earlyLeaveMin,
    };

    const saved = await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: p.employeeId, date } },
      create: { employeeId: p.employeeId, date, ...values },
      update: values,
    });
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Attendance',
      entityId: saved.id,
      details: { employeeId: p.employeeId, date: day, checkIn: p.checkIn ?? null, checkOut: p.checkOut ?? null, ...minutes },
      ipAddress,
    });
    return NextResponse.json({ message: 'تم حفظ الدوام يدوياً', data: saved });
  } catch (err) {
    return handleApiError(err, 'attendance-hub:POST');
  }
}
