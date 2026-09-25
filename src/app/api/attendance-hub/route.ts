import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, parseBody } from '@/lib/http';
import { zDate, zId, zOptInt, zOptText } from '@/lib/validation';
import { dateKey } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import { ATTENDANCE_STATUS, buildPunches, computeLateEarly, normalizeTimeOfDay } from '@/lib/attendance';
import { resolveEmployeeSchedule } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

const employeeSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  biometricId: true,
  branchId: true,
  workSchedule: true,
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
]);

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

    // ADD_ATTENDANCE: manual attendance entry. Times are Riyadh wall-clock times.
    const p = body.payload;
    const day = dateKey(p.date);
    if (!day) throw badRequest('تاريخ غير صالح');
    if (!p.checkIn && !p.checkOut) throw badRequest('يرجى إدخال وقت الحضور أو الانصراف');
    const { schedule } = await resolveEmployeeSchedule(prisma, p.employeeId);

    const punches = buildPunches(day, p.checkIn, p.checkOut);
    const calc = computeLateEarly({ schedule, dayKey: day, checkIn: punches.checkIn, checkOut: punches.checkOut });
    const minutes = calc.hasSchedule
      ? { lateMinutes: calc.lateMinutes, earlyLeaveMin: calc.earlyLeaveMin, overtimeMin: calc.overtimeMin }
      : { lateMinutes: nonNegative(p.lateMinutes), earlyLeaveMin: nonNegative(p.earlyLeaveMin), overtimeMin: nonNegative(p.overtimeMin) };
    const date = new Date(`${day}T00:00:00.000Z`);
    const values = {
      checkIn: punches.checkIn,
      checkOut: punches.checkOut,
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
