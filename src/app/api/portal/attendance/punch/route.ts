import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, badRequest, conflict, forbidden, handleApiError, jsonError } from '@/lib/http';
import { zNumber } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { ATTENDANCE_SOURCE, ATTENDANCE_STATUS, computeLateEarly } from '@/lib/attendance';
import { lockEmployeeForUpdate } from '@/lib/hr-workflows';
import { isValidLatLng } from '@/lib/geo';
import { analyzeFace, openEmbedding, FACE_MODEL } from '@/lib/face';
import { deleteBiometricImage, saveBiometricImage, validateSelfie, type BiometricExt } from '@/lib/biometric-storage';
import {
  PUNCH_REASONS,
  PUNCH_REASON_MESSAGES,
  SELF_ATTENDANCE_BLOCKER_MESSAGES,
  checkFace,
  checkLocation,
  cosineSimilarity,
  decidePunch,
  rejectionMessage,
  resolvePunchPlan,
  tooSoonAfterCheckIn,
  type PunchReason,
} from '@/lib/self-attendance';
import { loadPlanRows, loadSelfAttendanceContext } from '@/lib/self-attendance-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Multipart body: a small camera capture + a few text fields. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PUNCH_WINDOW_MS = 10 * 60 * 1000;
/** Durable (database) cap on punches per employee per 10 minutes, on top of the in-memory limiter. */
const MAX_PUNCHES_PER_WINDOW = 10;

const optionalNumber = z.preprocess((v) => (v === null || v === undefined || v === '' ? undefined : v), zNumber.optional());

const fieldsSchema = z.object({
  /** What the page showed ("تسجيل حضور" / "تسجيل انصراف"): guards against double taps and stale tabs. */
  expectedAction: z.enum(['IN', 'OUT']),
  latitude: optionalNumber,
  longitude: optionalNumber,
  /** Accuracy radius reported by the browser, meters. */
  accuracy: optionalNumber,
});

const round = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(digits)));
const stateChanged = () => conflict('تغيّرت حالة حضورك (ربما سُجّلت الحركة من نافذة أخرى). حدّث الصفحة ثم حاول مرة أخرى.', { code: 'STATE_CHANGED' });

/**
 * POST /api/portal/attendance/punch — self clock-in / clock-out of the logged-in employee.
 *
 * Checks, cheapest first: feature enabled / not terminated / rate limits -> which record
 * (IN / OUT) -> location inside one of the branch's attendance locations (unless exempt) ->
 * face matches the enrolled template and looks like a live capture (unless exempt).
 * Every attempt past the blockers is stored as an AttendancePunch (the evidence); only accepted
 * or flagged punches write Attendance, always with the SERVER time. The selfie is kept only for
 * rejected / flagged punches (UPLOAD_DIR/.biometric, purged after the retention period).
 */
export async function POST(req: Request) {
  let evidenceName: string | null = null;
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const ipAddress = getClientIp(req);
    const userAgent = req.headers.get('user-agent')?.slice(0, 300) ?? null;

    const limit = rateLimit(`punch:emp:${employeeId}`, 6, PUNCH_WINDOW_MS);
    if (!limit.ok) {
      return jsonError(429, 'محاولات كثيرة خلال وقت قصير. انتظر قليلاً ثم حاول مرة أخرى.', { retryAfterSeconds: limit.retryAfterSeconds });
    }
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'حجم البيانات المرسلة كبير. أعد التقاط الصورة.');

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('تعذر قراءة البيانات المرسلة');
    }
    const fields = fieldsSchema.parse({
      expectedAction: form.get('expectedAction'),
      latitude: form.get('latitude'),
      longitude: form.get('longitude'),
      accuracy: form.get('accuracy'),
    });

    const now = new Date();
    const ctx = await loadSelfAttendanceContext(prisma, employeeId, now);
    const { settings, employee, plan } = ctx;

    for (const blocker of ctx.blockers) {
      if (blocker === 'DAY_COMPLETE') throw conflict(SELF_ATTENDANCE_BLOCKER_MESSAGES[blocker], { code: blocker });
      throw forbidden(SELF_ATTENDANCE_BLOCKER_MESSAGES[blocker]);
    }
    if (plan.action === 'DONE' || plan.action !== fields.expectedAction) throw stateChanged();
    if (plan.action === 'OUT' && !plan.repunch && tooSoonAfterCheckIn(plan.checkIn, now)) {
      throw conflict('سجلت حضورك قبل أقل من 5 دقائق. لا يمكن تسجيل الانصراف الآن.', { code: 'TOO_SOON' });
    }
    if (ctx.faceRequired && !ctx.faceEnrolled) {
      throw conflict(PUNCH_REASON_MESSAGES.NOT_ENROLLED, { code: PUNCH_REASONS.NOT_ENROLLED });
    }
    const recent = await prisma.attendancePunch.count({ where: { employeeId, createdAt: { gte: new Date(now.getTime() - PUNCH_WINDOW_MS) } } });
    if (recent >= MAX_PUNCHES_PER_WINDOW) {
      return jsonError(429, 'محاولات كثيرة خلال وقت قصير. انتظر قليلاً ثم حاول مرة أخرى.', { retryAfterSeconds: Math.ceil(PUNCH_WINDOW_MS / 1000) });
    }

    // Selfie: required unless the employee is exempt from the face check.
    let selfie: { bytes: Uint8Array; ext: BiometricExt; mime: string } | null = null;
    const file = form.get('selfie');
    if (ctx.faceRequired) {
      if (!(file instanceof File)) throw badRequest('صورة الوجه مطلوبة');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const v = validateSelfie(file.name || 'selfie.jpg', bytes);
      if (!v.ok || !v.ext) throw new HttpError(v.ok ? 415 : v.status, v.ok ? 'نوع الصورة غير مدعوم' : v.message);
      selfie = { bytes, ext: v.ext, mime: file.type || 'image/jpeg' };
    }

    // 1) Location.
    const point = isValidLatLng(fields.latitude, fields.longitude) ? { latitude: fields.latitude as number, longitude: fields.longitude as number } : null;
    const accuracyM = fields.accuracy !== undefined && fields.accuracy >= 0 ? fields.accuracy : null;
    const location = checkLocation({ exempt: employee.attendanceGeoExempt, point, accuracyM, fences: ctx.fences, maxAccuracyM: settings.gpsMaxAccuracyM });
    const reasons: PunchReason[] = [...location.reasons];

    // 2) Face: only when the location passed (no need to analyse a face that is off-site anyway).
    let similarity: number | null = null;
    let liveness: number | null = null;
    if (!reasons.some((r) => r !== PUNCH_REASONS.GEO_EXEMPT)) {
      if (!ctx.faceRequired) {
        reasons.push(PUNCH_REASONS.FACE_EXEMPT);
      } else if (selfie) {
        const profile = await prisma.faceProfile.findUnique({ where: { employeeId }, select: { embedding: true, model: true } });
        const template = profile?.model === FACE_MODEL ? openEmbedding(profile.embedding) : null;
        const analysis = template ? await analyzeFace(selfie.bytes, selfie.mime) : null;
        similarity = analysis?.embedding && template ? cosineSimilarity(analysis.embedding, template) : null;
        liveness = analysis?.liveness ?? null;
        reasons.push(...checkFace({ exempt: false, enrolled: !!template, analysis, similarity, settings }));
      }
    }
    if (employee.employmentStatus === 'ON_LEAVE') reasons.push(PUNCH_REASONS.ON_LEAVE);
    const result = decidePunch(reasons);

    // Evidence: saved before the transaction, removed again if the transaction fails.
    if (selfie && result !== 'ACCEPTED') evidenceName = await saveBiometricImage(selfie.bytes, selfie.ext);

    const nearest = location.nearest;
    const outcome = await prisma.$transaction(async (tx) => {
      await lockEmployeeForUpdate(tx, employeeId);
      // Re-plan under the row lock: a double tap or a second tab must not punch twice.
      const rows = await loadPlanRows(tx, employeeId, ctx.todayKey);
      const locked = resolvePunchPlan({ now, schedule: ctx.schedule, todayKey: ctx.todayKey, today: rows.today, yesterday: rows.yesterday });
      if (locked.action !== plan.action || locked.dayKey !== plan.dayKey) throw stateChanged();

      const date = new Date(`${plan.dayKey}T00:00:00.000Z`);
      let attendanceId: string | null = null;
      let minutes: { lateMinutes?: number; earlyLeaveMin?: number; overtimeMin?: number } = {};

      if (result !== 'REJECTED') {
        const flag = result === 'FLAGGED' ? { flagged: true } : {};
        if (locked.action === 'IN') {
          const calc = computeLateEarly({ schedule: ctx.schedule, dayKey: plan.dayKey, checkIn: now, checkOut: null });
          const values = { checkIn: now, checkInSource: ATTENDANCE_SOURCE.SELF, status: ATTENDANCE_STATUS.PRESENT, lateMinutes: calc.lateMinutes, ...flag };
          const saved = await tx.attendance.upsert({
            where: { employeeId_date: { employeeId, date } },
            create: { employeeId, date, ...values },
            update: values,
            select: { id: true },
          });
          attendanceId = saved.id;
          minutes = { lateMinutes: calc.lateMinutes };
        } else if (locked.action === 'OUT') {
          const calc = computeLateEarly({ schedule: ctx.schedule, dayKey: plan.dayKey, checkIn: locked.checkIn, checkOut: now });
          const r = await tx.attendance.updateMany({
            where: locked.repunch ? { id: locked.attendanceId } : { id: locked.attendanceId, checkOut: null },
            data: {
              checkOut: now,
              checkOutSource: ATTENDANCE_SOURCE.SELF,
              lateMinutes: calc.lateMinutes,
              earlyLeaveMin: calc.earlyLeaveMin,
              earlyMinutes: calc.earlyLeaveMin,
              overtimeMin: calc.overtimeMin,
              ...flag,
            },
          });
          if (r.count === 0) throw stateChanged();
          attendanceId = locked.attendanceId;
          minutes = { earlyLeaveMin: calc.earlyLeaveMin, overtimeMin: calc.overtimeMin };
        }
      }

      const punch = await tx.attendancePunch.create({
        data: {
          employeeId,
          attendanceId,
          workDate: date,
          type: plan.action === 'OUT' ? 'OUT' : 'IN',
          result,
          reasons,
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
          accuracyM: round(accuracyM, 1),
          distanceM: round(nearest?.distanceM, 1),
          locationId: nearest?.fence.id ?? null,
          locationName: nearest?.fence.name ?? null,
          radiusM: nearest?.fence.radiusM ?? null,
          faceScore: round(similarity, 4),
          livenessScore: round(liveness, 4),
          selfieStoredName: evidenceName,
          ipAddress,
          userAgent,
          createdAt: now,
        },
        select: { id: true },
      });
      return { punchId: punch.id, attendanceId, minutes };
    });
    // Committed: the punch now references the evidence file, so it must survive from here on.
    evidenceName = null;

    await logAudit({
      userId: user.id,
      action: result === 'REJECTED' ? 'REJECT' : 'CREATE',
      entityType: 'AttendancePunch',
      entityId: outcome.punchId,
      details: {
        type: plan.action,
        result,
        reasons,
        workDate: plan.dayKey,
        distanceM: round(nearest?.distanceM),
        accuracyM: round(accuracyM),
        faceScore: round(similarity, 3),
        livenessScore: round(liveness, 3),
      },
      ipAddress,
    });

    const base = { result, action: plan.action, workDate: plan.dayKey, punchId: outcome.punchId, reasons };
    if (result === 'REJECTED') {
      const message = rejectionMessage(reasons, nearest ? { distanceM: nearest.distanceM, name: nearest.fence.name } : null);
      return NextResponse.json({ ...base, message, error: message, canRequestCorrection: true }, { status: 422 });
    }
    const done = plan.action === 'IN' ? 'تم تسجيل الحضور' : 'تم تسجيل الانصراف';
    const flaggedNote = result === 'FLAGGED' ? ` — ${reasons.filter((r) => r === 'FACE_BORDERLINE' || r === 'LIVENESS_BORDERLINE' || r === 'ON_LEAVE').map((r) => PUNCH_REASON_MESSAGES[r]).join(' ')}` : '';
    return NextResponse.json({ ...base, message: `${done}${flaggedNote}`, time: now, ...outcome.minutes }, { status: 201 });
  } catch (err) {
    if (evidenceName) await deleteBiometricImage(evidenceName).catch(() => undefined);
    return handleApiError(err, 'portal/attendance/punch:POST');
  }
}
