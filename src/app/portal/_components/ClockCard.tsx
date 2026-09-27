"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Clock, LogIn, LogOut, MapPin, RotateCcw, ScanFace, ShieldCheck } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { confirmDialog, readApiError, toast } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { FACE_CONSENT_VERSION } from '@/lib/self-attendance';
import { PositionTracker, type DevicePosition, type PositionState } from '@/lib/position-tracker';
import { redirectToLogin } from './redirect-to-login';
import FaceCameraModal from './FaceCameraModal';

/** After the capture, how long to keep waiting for a position precise enough for the server. */
const POSITION_WAIT_MS = 15_000;
/** Upload + face analysis. Abandoning is safe: the server refuses a duplicate punch (409). */
const REQUEST_TIMEOUT_MS = 30_000;
/** The card re-reads its state while visible: a tab left open overnight must not show yesterday. */
const REFRESH_MS = 5 * 60_000;

type PunchAction = 'IN' | 'OUT';

/** Shape of GET /api/portal/attendance. */
interface SelfAttendanceStatus {
  enabled: boolean;
  nextAction: PunchAction | 'DONE';
  /** After a rejected check-in: the other possible action (retry the check-in / record the check-out). */
  alternativeAction: PunchAction | null;
  workDate: string;
  record: { workDate: string; checkIn: string | null; checkOut: string | null } | null;
  blockers: { code: string; message: string }[];
  geoRequired: boolean;
  faceRequired: boolean;
  faceEnrolled: boolean;
  /** Biometric data is stored: the withdraw link is shown. */
  faceDataStored: boolean;
  /** The enrolled employee accepted the current version of the privacy notice. */
  faceConsentCurrent: boolean;
  faceServiceConfigured: boolean;
  locations: { name: string }[];
  gpsMaxAccuracyM: number;
  selfieRetentionDays: number;
}

export interface PunchRejection {
  message: string;
  punchId: string;
  workDate: string;
  action: 'IN' | 'OUT';
}

function formatTime(d: string | null | undefined): string {
  if (!d) return '--:--';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
}

function positionErrorMessage(err: unknown): string {
  const code = (err as { code?: number } | null)?.code;
  if (code === 1) return 'تم رفض إذن الموقع. اسمح للموقع بمعرفة موقعك: في iPhone من الإعدادات > الخصوصية > خدمات الموقع > Safari، وفي Android من رمز القفل بجانب عنوان الموقع > الأذونات.';
  if (code === 2) return 'تعذر تحديد موقعك. فعّل خدمة الموقع (GPS) ثم أعد المحاولة.';
  if (code === 3) return 'انتهت مهلة تحديد الموقع. انتقل إلى مكان مكشوف ثم أعد المحاولة.';
  return 'المتصفح لا يدعم تحديد الموقع.';
}

function requestSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

function networkErrorMessage(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'انتهت مهلة الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.'
    : 'تعذر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.';
}

/** Live location status under the camera preview, so the employee sees a weak fix before capturing. */
function GeoHint({ state, maxAccuracyM }: { state: PositionState | null; maxAccuracyM: number }) {
  const box = 'flex items-start gap-1.5 rounded-xl px-3 py-2 text-[12px] font-bold leading-relaxed';
  const icon = <MapPin size={14} className="shrink-0 mt-0.5" aria-hidden="true" />;
  if (!state || state.kind === 'locating') return <p className={`${box} bg-slate-50 text-slate-500`}>{icon} جاري تحديد موقعك...</p>;
  if (state.kind === 'error') return <p className={`${box} bg-rose-50 text-rose-700`}>{icon} {positionErrorMessage(state)}</p>;
  const accuracy = Math.round(state.position.accuracy);
  if (accuracy <= maxAccuracyM) return <p className={`${box} bg-emerald-50 text-emerald-700`}>{icon} تم تحديد موقعك · الدقة نحو {accuracy} م</p>;
  return (
    <p className={`${box} bg-amber-50 text-amber-800`}>
      {icon} دقة موقعك الآن نحو {accuracy} م، والمطلوب {maxAccuracyM} م أو أقل. انتظر قليلاً، أو اقترب من نافذة أو مكان مكشوف.
    </p>
  );
}

/**
 * Self clock-in / clock-out card of the employee portal: location (browser GPS) + live selfie
 * checked on the server. Hidden when the feature is off for this tenant. On a rejection the
 * employee can open the existing correction request, linked to the rejected attempt; after a
 * rejected check-in both "retry the check-in" and "record the check-out" are offered.
 */
export default function ClockCard({ onPunched, onRequestCorrection }: { onPunched: () => void; onRequestCorrection: (r: PunchRejection) => void }) {
  const [status, setStatus] = useState<SelfAttendanceStatus | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  // 'enroll' = first registration of the face; 'renew' = the notice changed since the employee accepted it.
  const [consentMode, setConsentMode] = useState<'enroll' | 'renew'>('enroll');
  const [camera, setCamera] = useState<'enroll' | 'punch' | null>(null);
  /** The button the employee pressed (sent as expectedAction). */
  const [action, setAction] = useState<PunchAction>('IN');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  /** Why the last attempt failed, shown inside the open camera dialog (a toast would cover its buttons). */
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [rejection, setRejection] = useState<PunchRejection | null>(null);
  // Short pause after a successful punch so a double tap does not immediately try the opposite punch.
  const [coolingDown, setCoolingDown] = useState(false);
  // The position is followed while the camera is open; every attempt uses the freshest precise reading.
  const [geo, setGeo] = useState<PositionState | null>(null);
  const [tracker] = useState(() => new PositionTracker(setGeo));

  useEffect(() => () => tracker.stop(), [tracker]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/attendance', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) return; // linked-account / other problems are shown by the portal itself
      setStatus((await res.json()) as SelfAttendanceStatus);
    } catch {
      // offline: the card keeps its last state until the next load
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read the state when the employee comes back to the page and periodically while it is visible
  // (a phone keeps the tab open for days: the card must move to the new day by itself).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
      window.clearInterval(timer);
    };
  }, [load]);

  if (!status || !status.enabled) return null;

  const faceUnavailable = status.faceRequired && !status.faceServiceConfigured;
  const blockers = status.blockers.filter((b) => b.code !== 'DISABLED');
  const actionBlocked = blockers.length > 0 || faceUnavailable || status.nextAction === 'DONE';

  /** Starts following the position early, in parallel with the camera. */
  const beginPosition = () => {
    if (status.geoRequired) tracker.start();
  };

  const stopPosition = () => {
    tracker.stop();
    setGeo(null);
  };

  const closeCamera = () => {
    setCamera(null);
    setCameraError(null);
    stopPosition();
  };

  /** Errors go inside the camera dialog while it is open, otherwise to a toast. */
  const report = (message: string) => {
    if (camera) setCameraError(message);
    else toast.error(message);
  };

  /** Best recent reading, waiting a little for one precise enough (the server makes the final check). */
  const readPosition = async (): Promise<DevicePosition | null | undefined> => {
    if (!status.geoRequired) return undefined;
    tracker.start();
    setPhase('جاري تحديد موقعك...');
    try {
      return await tracker.wait(status.gpsMaxAccuracyM, POSITION_WAIT_MS);
    } catch (err) {
      report(positionErrorMessage(err));
      return null;
    } finally {
      setPhase(null);
    }
  };

  const appendPosition = (fd: FormData, pos: DevicePosition | undefined) => {
    if (!pos) return;
    fd.append('latitude', String(pos.latitude));
    fd.append('longitude', String(pos.longitude));
    fd.append('accuracy', String(Math.round(pos.accuracy)));
  };

  const submitEnroll = async (image: Blob): Promise<boolean> => {
    const pos = await readPosition();
    if (pos === null) return false;
    const fd = new FormData();
    fd.append('consent', 'true');
    // The version of the notice text bundled in THIS page (a stale tab gets 409 and must reload).
    fd.append('consentVersion', FACE_CONSENT_VERSION);
    fd.append('selfie', image, 'selfie.jpg');
    appendPosition(fd, pos);
    setPhase('جاري تسجيل صورة الوجه...');
    try {
      const res = await fetch('/api/portal/face', { method: 'POST', body: fd, signal: requestSignal() });
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!res.ok) {
        // Enrolled meanwhile (another tab, or an earlier attempt whose answer was lost): go on with the punch.
        const body = (await res.clone().json().catch(() => null)) as { details?: { code?: string } } | null;
        if (res.status === 409 && body?.details?.code === 'ALREADY_ENROLLED') return true;
        report(await readApiError(res, 'تعذر تسجيل صورة الوجه'));
        void load();
        return false;
      }
      toast.success('تم تسجيل صورة وجهك');
      return true;
    } catch (err) {
      report(networkErrorMessage(err));
      void load();
      return false;
    } finally {
      setPhase(null);
    }
  };

  const submitPunch = async (image: Blob | null, chosen: PunchAction) => {
    const pos = await readPosition();
    if (pos === null) {
      // With the camera open the employee can fix the location (permission, GPS) and confirm again.
      if (!image) stopPosition();
      return;
    }
    const fd = new FormData();
    fd.append('expectedAction', chosen);
    appendPosition(fd, pos);
    if (image) fd.append('selfie', image, 'selfie.jpg');
    setPhase(chosen === 'OUT' ? 'جاري تسجيل الانصراف...' : 'جاري تسجيل الحضور...');
    try {
      const res = await fetch('/api/portal/attendance/punch', { method: 'POST', body: fd, signal: requestSignal() });
      if (res.status === 401) return redirectToLogin();
      const data = (await res.json().catch(() => ({}))) as { message?: string; punchId?: string; workDate?: string; action?: 'IN' | 'OUT' };
      if (res.ok) {
        toast.success(data.message || 'تم التسجيل');
        closeCamera();
        setCoolingDown(true);
        window.setTimeout(() => setCoolingDown(false), 10_000);
        onPunched();
      } else if (res.status === 422 && data.punchId && data.workDate && data.action) {
        closeCamera();
        setRejection({ message: data.message || 'تعذر تسجيل الحركة', punchId: data.punchId, workDate: data.workDate, action: data.action });
      } else if (res.status === 409) {
        closeCamera();
        toast.error(data.message || 'تعذر تسجيل الحركة');
      } else {
        report(data.message || 'تعذر تسجيل الحركة');
      }
    } catch (err) {
      report(networkErrorMessage(err));
    } finally {
      setPhase(null);
      if (!image) stopPosition();
      void load();
    }
  };

  const start = (chosen: PunchAction) => {
    setRejection(null);
    setCameraError(null);
    setAction(chosen);
    if (status.faceRequired && (!status.faceEnrolled || !status.faceConsentCurrent)) {
      setConsentMode(status.faceEnrolled ? 'renew' : 'enroll');
      setConsentChecked(false);
      setConsentOpen(true);
      return;
    }
    beginPosition();
    if (status.faceRequired) setCamera('punch');
    else void submitPunch(null, chosen);
  };

  const continueAfterConsent = async () => {
    if (consentMode === 'renew') {
      if (consentBusy) return;
      setConsentBusy(true);
      try {
        const res = await fetch('/api/portal/face', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consent: true, consentVersion: FACE_CONSENT_VERSION }),
          signal: requestSignal(),
        });
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          // e.g. HR reset the face meanwhile: the refreshed state leads to a new enrollment.
          toast.error(await readApiError(res, 'تعذر تسجيل الموافقة'));
          setConsentOpen(false);
          void load();
          return;
        }
      } catch (err) {
        toast.error(networkErrorMessage(err));
        return;
      } finally {
        setConsentBusy(false);
      }
      setConsentOpen(false);
      void load();
      beginPosition();
      setCamera('punch');
      return;
    }
    setConsentOpen(false);
    beginPosition();
    setCamera('enroll');
  };

  const onCaptured = async (image: Blob) => {
    if (busy) return;
    setBusy(true);
    setCameraError(null);
    try {
      if (camera === 'enroll') {
        // One capture enrolls the face and, right after, records the punch. From then on the dialog
        // is a punch dialog: retrying after a failed punch must not try to enroll again (409).
        if (await submitEnroll(image)) {
          setCamera('punch');
          await submitPunch(image, action);
        }
      } else {
        await submitPunch(image, action);
      }
    } finally {
      setBusy(false);
    }
  };

  const withdrawConsent = async () => {
    const ok = await confirmDialog('سيتم حذف صورة وجهك وقالبها المشفر. لتسجيل الحضور من البوابة بعد ذلك ستحتاج إلى أن تعيد الموارد البشرية فتح تسجيل الوجه لك. هل تريد المتابعة؟', {
      title: 'سحب الموافقة على التحقق من الوجه',
      confirmText: 'حذف بيانات وجهي',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/portal/face', { method: 'DELETE', signal: requestSignal() });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حذف البيانات'));
        return;
      }
      toast.success('تم حذف بيانات وجهك');
      void load();
    } catch (err) {
      toast.error(networkErrorMessage(err));
    }
  };

  const rec = status.record;
  const main = status.nextAction;
  const alternative = status.alternativeAction;
  const afterRejectedIn = alternative !== null;
  const isOut = action === 'OUT';
  const requirement = [status.geoRequired ? 'موقع العمل' : null, status.faceRequired ? 'التحقق من الوجه' : null].filter(Boolean).join(' + ');
  const disabled = actionBlocked || busy || !!phase || coolingDown;
  const mainLabel = main === 'DONE' ? 'اكتمل تسجيل اليوم' : main === 'OUT' ? 'تسجيل انصراف' : afterRejectedIn ? 'إعادة محاولة الحضور' : 'تسجيل حضور';

  return (
    <section aria-labelledby="portal-clock-title" className="bg-white rounded-[2rem] border border-slate-200 shadow-sm p-5 md:p-6">
      <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span aria-hidden="true" className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
            <Clock size={24} />
          </span>
          <div className="min-w-0">
            <h2 id="portal-clock-title" className="font-black text-slate-800 text-[16px]">الحضور والانصراف</h2>
            <p className="text-[12px] font-bold text-slate-500">
              {formatDate(status.workDate)} · حضور <span dir="ltr">{formatTime(rec?.checkIn)}</span> · انصراف <span dir="ltr">{formatTime(rec?.checkOut)}</span>
            </p>
            {requirement && (
              <p className="text-[11px] font-bold text-slate-400 mt-0.5 flex items-center gap-1">
                <MapPin size={12} aria-hidden="true" /> يتطلب: {requirement}
                {status.locations.length > 0 && status.geoRequired && <> · {status.locations.map((l) => l.name).join('، ')}</>}
              </p>
            )}
          </div>
        </div>

        <div className="w-full md:w-auto md:min-w-[220px] flex flex-col gap-2">
          <button
            type="button"
            onClick={() => main !== 'DONE' && start(main)}
            disabled={disabled}
            className={`w-full py-4 px-6 rounded-2xl font-black text-white text-[16px] shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${main === 'OUT' ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-900/10' : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-900/10'}`}
          >
            {main === 'OUT' ? <LogOut size={20} aria-hidden="true" /> : afterRejectedIn ? <RotateCcw size={20} aria-hidden="true" /> : <LogIn size={20} aria-hidden="true" />}
            {phase ?? mainLabel}
          </button>
          {alternative && !actionBlocked && (
            <button
              type="button"
              onClick={() => start(alternative)}
              disabled={disabled}
              className="w-full py-2.5 px-4 rounded-2xl font-bold text-[13px] border-2 border-slate-200 text-slate-700 hover:bg-slate-50 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {alternative === 'OUT' ? <LogOut size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
              {alternative === 'OUT' ? 'تسجيل انصراف (مغادرة)' : 'إعادة محاولة الحضور'}
            </button>
          )}
        </div>
      </div>

      {afterRejectedIn && !actionBlocked && (
        <p role="status" className="mt-4 bg-amber-50 border border-amber-100 text-amber-900 rounded-2xl p-3 text-[12px] font-bold leading-relaxed">
          لم يُقبل تسجيل حضورك اليوم. أعد المحاولة، أو سجّل انصرافك عند المغادرة، ولا تنسَ رفع طلب تصحيح لمحاولة الحضور المرفوضة.
        </p>
      )}

      {(blockers.length > 0 || faceUnavailable) && (
        <div role="status" className="mt-4 bg-amber-50 border border-amber-100 text-amber-900 rounded-2xl p-3 text-[13px] font-bold flex gap-2">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            {blockers.map((b) => <p key={b.code}>{b.message}</p>)}
            {faceUnavailable && <p>التحقق من الوجه غير متاح حالياً على الخادم. إذا احتجت إلى تسجيل حركة فارفع طلب تصحيح.</p>}
          </div>
        </div>
      )}

      {rejection && (
        <div role="alert" className="mt-4 bg-rose-50 border border-rose-100 text-rose-900 rounded-2xl p-3 text-[13px] font-bold flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="flex-1">{rejection.message}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => onRequestCorrection(rejection)} className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-xl font-black text-[12px] transition">
              رفع طلب تصحيح
            </button>
            <button type="button" onClick={() => setRejection(null)} className="bg-white hover:bg-rose-100 text-rose-700 px-4 py-2 rounded-xl font-bold text-[12px] border border-rose-200 transition">
              إغلاق
            </button>
          </div>
        </div>
      )}

      {status.faceDataStored && (
        <p className="mt-3 text-[11px] font-bold text-slate-400 flex items-center gap-1">
          <ShieldCheck size={12} aria-hidden="true" /> صورة وجهك مسجلة ·{' '}
          <button type="button" onClick={withdrawConsent} className="underline hover:text-slate-600">سحب الموافقة وحذف بيانات وجهي</button>
        </p>
      )}

      <Modal
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        busy={consentBusy}
        tone="emerald"
        icon={<ScanFace size={22} />}
        title={consentMode === 'renew' ? 'تحديث إشعار الخصوصية' : 'تسجيل صورة الوجه لأول مرة'}
        description={consentMode === 'renew' ? 'تغيّر نص الإشعار منذ موافقتك السابقة. اقرأه ووافق عليه للمتابعة.' : 'اقرأ الإشعار التالي قبل المتابعة'}
      >
        <div className="p-6 md:p-8 space-y-5">
          {/* Notice text: bump FACE_CONSENT_VERSION (src/lib/self-attendance.ts) whenever it changes. */}
          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-[13px] font-bold text-slate-700 leading-loose space-y-2">
            <p><span className="font-black">الغرض:</span> التأكد من أنك صاحب الحساب وأنك في موقع العمل عند تسجيل الحضور والانصراف فقط.</p>
            <p><span className="font-black">ما نحفظه:</span> قالب رقمي مشفر لوجهك وصورة مرجعية واحدة يطّلع عليها قسم الموارد البشرية عند الحاجة. موقعك يُؤخذ لحظة الضغط على الزر فقط، ولا يتم تتبعك.</p>
            <p><span className="font-black">صور الحركات:</span> لا تُحفظ صور الحركات المقبولة. صور الحركات المرفوضة أو المشبوهة تُحفظ {status.selfieRetentionDays} يوماً للمراجعة ثم تُحذف تلقائياً.</p>
            <p><span className="font-black">المعالجة:</span> تتم على خوادم المنشأة، ولا تُرسل بيانات وجهك إلى أي طرف خارجي.</p>
            <p><span className="font-black">حقوقك:</span> يمكنك سحب موافقتك وحذف بيانات وجهك في أي وقت من هذه البوابة، وتُحذف تلقائياً عند انتهاء خدمتك.</p>
            <p><span className="font-black">للتواصل:</span> لأي طلب أو اعتراض يخص بياناتك (الاطلاع عليها أو تصحيحها أو حذفها) تواصل مع قسم الموارد البشرية في منشأتك.</p>
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} className="mt-1 w-5 h-5 accent-emerald-600" />
            <span className="text-[13px] font-extrabold text-slate-800">قرأت الإشعار وأوافق على معالجة صورة وجهي وموقعي لهذا الغرض.</span>
          </label>
          {consentMode === 'enroll' && (
            <p className="text-[12px] font-bold text-slate-500">سجّل صورتك وأنت في موقع العمل، وستُستخدم نفس الصورة لتسجيل هذه الحركة.</p>
          )}
          <div className="flex gap-3">
            <button type="button" disabled={!consentChecked || consentBusy} onClick={() => void continueAfterConsent()} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
              {consentBusy ? 'جاري الحفظ...' : consentMode === 'renew' ? 'موافق، متابعة' : 'متابعة إلى الكاميرا'}
            </button>
            <button type="button" onClick={() => setConsentOpen(false)} disabled={consentBusy} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </div>
      </Modal>

      <FaceCameraModal
        open={camera !== null}
        onClose={() => {
          if (!busy) closeCamera();
        }}
        onCapture={onCaptured}
        busy={busy}
        title={camera === 'enroll' ? 'التقاط صورة الوجه المرجعية' : isOut ? 'تسجيل الانصراف' : 'تسجيل الحضور'}
        description={phase ?? 'التقط صورة لوجهك مباشرة من الكاميرا الأمامية'}
        confirmLabel={camera === 'enroll' ? 'تسجيل الوجه وتسجيل الحركة' : isOut ? 'تأكيد الانصراف' : 'تأكيد الحضور'}
        error={cameraError}
        hint={status.geoRequired ? <GeoHint state={geo} maxAccuracyM={status.gpsMaxAccuracyM} /> : null}
      />
    </section>
  );
}
