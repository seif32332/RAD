import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, badRequest, conflict, forbidden, handleApiError, jsonError, parseBody } from '@/lib/http';
import { zNumber } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { isValidLatLng } from '@/lib/geo';
import { FACE_MODEL, analyzeFace, openEmbedding, sealEmbedding } from '@/lib/face';
import { deleteBiometricImage, discardBiometricImage, saveBiometricImage, validateSelfie } from '@/lib/biometric-storage';
import { FACE_CONSENT_VERSION, FACE_PROFILE_WITHDRAWN, PUNCH_REASON_MESSAGES, SELF_ATTENDANCE_BLOCKER_MESSAGES, checkLocation, cosineSimilarity, rejectionMessage } from '@/lib/self-attendance';
import { loadSelfAttendanceContext } from '@/lib/self-attendance-server';
import { lockEmployeeForUpdate } from '@/lib/hr-workflows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Face analyses per employee per hour. Attempts refused earlier (location, consent...) do not count. */
const ENROLL_ANALYSES_PER_HOUR = 10;
/** Enrollment is stricter than a punch: a clear, frontal, large enough face. */
const MIN_DET_SCORE = 0.9;
const MIN_FACE_RATIO = 0.05;

const optionalNumber = z.preprocess((v) => (v === null || v === undefined || v === '' ? undefined : v), zNumber.optional());
const fieldsSchema = z.object({
  consent: z.literal('true', { errorMap: () => ({ message: 'يجب الموافقة على إشعار الخصوصية قبل تسجيل الوجه' }) }),
  consentVersion: z.string().trim().max(40),
  latitude: optionalNumber,
  longitude: optionalNumber,
  accuracy: optionalNumber,
});

/**
 * POST /api/portal/face — the employee enrolls their own reference face (owner decision: no HR
 * approval). Safeguards instead of an approval step:
 * - explicit consent to the versioned privacy notice (PDPL: biometric data is sensitive),
 * - taken at the workplace (inside the branch geofence unless location-exempt),
 * - one clear live face (detector score, face size, liveness),
 * - the face must not match any other employee's template (an attempt is audited),
 * - once enrolled it is locked: changing it needs an HR reset.
 */
export async function POST(req: Request) {
  let photoName: string | null = null;
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const ipAddress = getClientIp(req);

    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, 'حجم البيانات المرسلة كبير. أعد التقاط الصورة.');

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('تعذر قراءة البيانات المرسلة');
    }
    const fields = fieldsSchema.parse({
      consent: form.get('consent'),
      consentVersion: form.get('consentVersion') ?? '',
      latitude: form.get('latitude'),
      longitude: form.get('longitude'),
      accuracy: form.get('accuracy'),
    });
    if (fields.consentVersion !== FACE_CONSENT_VERSION) throw conflict('تم تحديث إشعار الخصوصية. حدّث الصفحة واقرأه ثم وافق من جديد.', { code: 'CONSENT_OUTDATED' });

    const ctx = await loadSelfAttendanceContext(prisma, employeeId);
    for (const b of ctx.blockers) {
      if (b === 'DISABLED' || b === 'TERMINATED' || b === 'NO_LOCATIONS_CONFIGURED') throw forbidden(SELF_ATTENDANCE_BLOCKER_MESSAGES[b]);
      if (b === 'FACE_WITHDRAWN') throw conflict(SELF_ATTENDANCE_BLOCKER_MESSAGES[b], { code: 'REENROLL_NEEDS_HR' });
    }
    if (!ctx.faceRequired) throw badRequest('أنت مستثنى من التحقق من الوجه ولا تحتاج إلى تسجيله.');

    const existing = await prisma.faceProfile.findUnique({ where: { employeeId }, select: { id: true, model: true, photoStoredName: true } });
    if (existing && existing.model === FACE_MODEL) {
      throw conflict('صورة وجهك مسجلة بالفعل. لتغييرها تواصل مع الموارد البشرية.', { code: 'ALREADY_ENROLLED' });
    }

    // Enrollment happens at the workplace.
    const point = isValidLatLng(fields.latitude, fields.longitude) ? { latitude: fields.latitude as number, longitude: fields.longitude as number } : null;
    const accuracyM = fields.accuracy !== undefined && fields.accuracy >= 0 ? fields.accuracy : null;
    const location = checkLocation({ exempt: ctx.employee.attendanceGeoExempt, point, accuracyM, fences: ctx.fences, maxAccuracyM: ctx.settings.gpsMaxAccuracyM });
    const locationProblem = location.reasons.filter((r) => r !== 'GEO_EXEMPT');
    if (locationProblem.length) {
      const nearest = location.nearest ? { distanceM: location.nearest.distanceM, name: location.nearest.fence.name, radiusM: location.nearest.fence.radiusM } : null;
      const message = rejectionMessage(locationProblem, { nearest, accuracyM, maxAccuracyM: ctx.settings.gpsMaxAccuracyM });
      return jsonError(422, `سجّل وجهك من موقع العمل. ${message}`, { code: locationProblem[0] });
    }

    const file = form.get('selfie');
    if (!(file instanceof File)) throw badRequest('صورة الوجه مطلوبة');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const v = validateSelfie(file.name || 'selfie.jpg', bytes);
    if (!v.ok || !v.ext) throw new HttpError(v.ok ? 415 : v.status, v.ok ? 'نوع الصورة غير مدعوم' : v.message);

    // Counted only here, right before the face analysis: an employee retrying because of the
    // location (weak GPS indoors) must not lock themselves out of enrollment.
    const limit = rateLimit(`face-enroll:${employeeId}`, ENROLL_ANALYSES_PER_HOUR, 60 * 60_000);
    if (!limit.ok) return jsonError(429, 'محاولات كثيرة لتسجيل الوجه. حاول بعد قليل.', { retryAfterSeconds: limit.retryAfterSeconds });

    const analysis = await analyzeFace(bytes, file.type || 'image/jpeg');
    if (!analysis) return jsonError(503, PUNCH_REASON_MESSAGES.FACE_SERVICE_UNAVAILABLE, { code: 'FACE_SERVICE_UNAVAILABLE' });
    if (analysis.faces === 0) return jsonError(422, PUNCH_REASON_MESSAGES.NO_FACE, { code: 'NO_FACE' });
    if (analysis.faces > 1) return jsonError(422, PUNCH_REASON_MESSAGES.MULTIPLE_FACES, { code: 'MULTIPLE_FACES' });
    if (!analysis.embedding || (analysis.detScore ?? 0) < MIN_DET_SCORE || (analysis.faceRatio ?? 0) < MIN_FACE_RATIO) {
      return jsonError(422, 'الصورة غير واضحة بما يكفي. قرّب الجوال من وجهك، وانظر مباشرة إلى الكاميرا في مكان مضاء.', { code: 'POOR_QUALITY' });
    }
    if (analysis.liveness === null || analysis.liveness < ctx.settings.livenessAccept) {
      return jsonError(422, PUNCH_REASON_MESSAGES.SPOOF_SUSPECTED, { code: 'SPOOF_SUSPECTED' });
    }

    // The same face must not already belong to someone else. Blocking starts at the ACCEPT level
    // (a lower bar would refuse look-alikes among many employees with no HR override); a match
    // between the reject and accept levels is recorded in the audit entry for HR review.
    const others = await prisma.faceProfile.findMany({ where: { employeeId: { not: employeeId }, model: FACE_MODEL }, select: { employeeId: true, embedding: true } });
    let best: { employeeId: string; similarity: number } | null = null;
    for (const o of others) {
      const template = openEmbedding(o.embedding);
      if (!template) continue;
      const similarity = cosineSimilarity(analysis.embedding, template);
      if (Number.isFinite(similarity) && (!best || similarity > best.similarity)) best = { employeeId: o.employeeId, similarity };
    }
    if (best && best.similarity >= ctx.settings.faceAccept) {
      await logAudit({
        userId: user.id,
        action: 'REJECT',
        entityType: 'FaceProfile',
        entityId: employeeId,
        details: { event: 'DUPLICATE_FACE', matchedEmployeeId: best.employeeId, similarity: Number(best.similarity.toFixed(3)) },
        ipAddress,
      });
      return jsonError(409, 'لا يمكن تسجيل هذا الوجه لأنه مسجل لموظف آخر. تواصل مع الموارد البشرية.', { code: 'DUPLICATE_FACE' });
    }

    photoName = await saveBiometricImage(bytes, v.ext);
    const data = { embedding: sealEmbedding(analysis.embedding), model: FACE_MODEL, photoStoredName: photoName, consentAt: new Date(), consentVersion: FACE_CONSENT_VERSION };
    const { profile, replacedPhoto } = await prisma.$transaction(async (tx) => {
      // Serialized per employee: of two simultaneous enrollments (double tap) only one is stored.
      await lockEmployeeForUpdate(tx, employeeId);
      const current = await tx.faceProfile.findUnique({ where: { employeeId }, select: { model: true, photoStoredName: true } });
      if (current?.model === FACE_MODEL) throw conflict('صورة وجهك مسجلة بالفعل. لتغييرها تواصل مع الموارد البشرية.', { code: 'ALREADY_ENROLLED' });
      if (current?.model === FACE_PROFILE_WITHDRAWN) throw conflict(SELF_ATTENDANCE_BLOCKER_MESSAGES.FACE_WITHDRAWN, { code: 'REENROLL_NEEDS_HR' });
      const saved = await tx.faceProfile.upsert({ where: { employeeId }, create: { employeeId, ...data }, update: data, select: { id: true, createdAt: true } });
      return { profile: saved, replacedPhoto: current?.photoStoredName ?? null };
    });
    photoName = null;
    // A template from an older model was replaced: its reference photo is no longer needed.
    await discardBiometricImage(replacedPhoto);

    const lookAlike = best && best.similarity >= ctx.settings.faceMin ? { employeeId: best.employeeId, similarity: Number(best.similarity.toFixed(3)) } : null;
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'FaceProfile',
      entityId: profile.id,
      details: {
        employeeId,
        model: FACE_MODEL,
        consentVersion: FACE_CONSENT_VERSION,
        replacedOldModel: existing?.model ?? null,
        liveness: Number(analysis.liveness.toFixed(3)),
        ...(lookAlike ? { lookAlike } : {}),
      },
      ipAddress,
    });
    return NextResponse.json({ message: 'تم تسجيل صورة وجهك. يمكنك الآن تسجيل الحضور.' }, { status: 201 });
  } catch (err) {
    if (photoName) await deleteBiometricImage(photoName).catch(() => undefined);
    return handleApiError(err, 'portal/face:POST');
  }
}

const renewSchema = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: 'يجب الموافقة على إشعار الخصوصية' }) }),
  consentVersion: z.string().trim().max(40),
});

/**
 * PATCH /api/portal/face — an enrolled employee accepts a new version of the privacy notice
 * (the face template itself is unchanged).
 */
export async function PATCH(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const body = await parseBody(req, renewSchema);
    if (body.consentVersion !== FACE_CONSENT_VERSION) throw conflict('تم تحديث إشعار الخصوصية. حدّث الصفحة واقرأه ثم وافق من جديد.', { code: 'CONSENT_OUTDATED' });
    const profile = await prisma.faceProfile.findUnique({ where: { employeeId }, select: { id: true, model: true, consentVersion: true } });
    if (!profile || profile.model === FACE_PROFILE_WITHDRAWN) throw conflict('لا توجد صورة وجه مسجلة لك', { code: 'NOT_ENROLLED' });
    await prisma.faceProfile.update({ where: { id: profile.id }, data: { consentAt: new Date(), consentVersion: FACE_CONSENT_VERSION } });
    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'FaceProfile',
      entityId: profile.id,
      details: { employeeId, event: 'CONSENT_RENEWED', from: profile.consentVersion, to: FACE_CONSENT_VERSION },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تم تسجيل موافقتك على الإشعار المحدث' });
  } catch (err) {
    return handleApiError(err, 'portal/face:PATCH');
  }
}

/**
 * DELETE /api/portal/face — the employee withdraws consent: the template and the reference photo
 * are deleted. The row stays as a "withdrawn" marker without any biometric data, so enrolling
 * again goes through HR (RESET_FACE), like any other change of the enrolled face.
 */
export async function DELETE(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const profile = await prisma.faceProfile.findUnique({ where: { employeeId }, select: { id: true, model: true, photoStoredName: true } });
    if (!profile || profile.model === FACE_PROFILE_WITHDRAWN) throw conflict('لا توجد صورة وجه مسجلة لك');
    await prisma.faceProfile.update({
      where: { id: profile.id },
      // consentAt / consentVersion now record the withdrawal.
      data: { embedding: '', model: FACE_PROFILE_WITHDRAWN, photoStoredName: null, consentAt: new Date(), consentVersion: FACE_PROFILE_WITHDRAWN },
    });
    await discardBiometricImage(profile.photoStoredName);
    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'FaceProfile',
      entityId: profile.id,
      details: { employeeId, event: 'CONSENT_WITHDRAWN' },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({
      message: 'تم حذف بيانات وجهك. لتسجيل الحضور من البوابة مرة أخرى تواصل مع الموارد البشرية لإعادة فتح تسجيل الوجه.',
    });
  } catch (err) {
    return handleApiError(err, 'portal/face:DELETE');
  }
}
