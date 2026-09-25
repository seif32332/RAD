"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, LogIn, LogOut, MapPin, ScanFace, ShieldCheck } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { confirmDialog, readApiError, toast } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { redirectToLogin } from './redirect-to-login';
import FaceCameraModal from './FaceCameraModal';

/** Shape of GET /api/portal/attendance. */
interface SelfAttendanceStatus {
  enabled: boolean;
  nextAction: 'IN' | 'OUT' | 'DONE';
  workDate: string;
  record: { workDate: string; checkIn: string | null; checkOut: string | null } | null;
  blockers: { code: string; message: string }[];
  geoRequired: boolean;
  faceRequired: boolean;
  faceEnrolled: boolean;
  faceServiceConfigured: boolean;
  locations: { name: string }[];
  gpsMaxAccuracyM: number;
  consentVersion: string;
}

interface Position {
  latitude: number;
  longitude: number;
  accuracy: number;
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

function getPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

function positionErrorMessage(err: unknown): string {
  const code = (err as { code?: number } | null)?.code;
  if (code === 1) return 'تم رفض إذن الموقع. اسمح للموقع بمعرفة موقعك: في iPhone من الإعدادات > الخصوصية > خدمات الموقع > Safari، وفي Android من رمز القفل بجانب عنوان الموقع > الأذونات.';
  if (code === 2) return 'تعذر تحديد موقعك. فعّل خدمة الموقع (GPS) ثم أعد المحاولة.';
  if (code === 3) return 'انتهت مهلة تحديد الموقع. انتقل إلى مكان مكشوف ثم أعد المحاولة.';
  return 'المتصفح لا يدعم تحديد الموقع.';
}

/**
 * Self clock-in / clock-out card of the employee portal: location (browser GPS) + live selfie
 * checked on the server. Hidden when the feature is off for this tenant. On a rejection the
 * employee can open the existing correction request, linked to the rejected attempt.
 */
export default function ClockCard({ onPunched, onRequestCorrection }: { onPunched: () => void; onRequestCorrection: (r: PunchRejection) => void }) {
  const [status, setStatus] = useState<SelfAttendanceStatus | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [camera, setCamera] = useState<'enroll' | 'punch' | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [rejection, setRejection] = useState<PunchRejection | null>(null);
  // Short pause after a successful punch so a double tap does not immediately try the opposite punch.
  const [coolingDown, setCoolingDown] = useState(false);
  const positionRef = useRef<Promise<Position> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/attendance', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) return; // linked-account / other problems are shown by the portal itself
      setStatus((await res.json()) as SelfAttendanceStatus);
    } catch {
      // offline: the card simply stays hidden until the next load
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status || !status.enabled) return null;

  const faceUnavailable = status.faceRequired && !status.faceServiceConfigured;
  const blockers = status.blockers.filter((b) => b.code !== 'DISABLED');
  const actionBlocked = blockers.length > 0 || faceUnavailable || status.nextAction === 'DONE';

  /** Starts GPS early (in parallel with the camera) and remembers the pending promise. */
  const beginPosition = () => {
    if (!status.geoRequired) return;
    const p = getPosition();
    p.catch(() => undefined);
    positionRef.current = p;
  };

  const readPosition = async (): Promise<Position | null | undefined> => {
    if (!status.geoRequired) return undefined;
    setPhase('جاري تحديد موقعك...');
    try {
      return await (positionRef.current ?? getPosition());
    } catch (err) {
      toast.error(positionErrorMessage(err));
      return null;
    } finally {
      setPhase(null);
    }
  };

  const appendPosition = (fd: FormData, pos: Position | undefined) => {
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
    fd.append('consentVersion', status.consentVersion);
    fd.append('selfie', image, 'selfie.jpg');
    appendPosition(fd, pos);
    setPhase('جاري تسجيل صورة الوجه...');
    try {
      const res = await fetch('/api/portal/face', { method: 'POST', body: fd });
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تسجيل صورة الوجه'));
        return false;
      }
      toast.success('تم تسجيل صورة وجهك');
      return true;
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return false;
    } finally {
      setPhase(null);
    }
  };

  const submitPunch = async (image: Blob | null) => {
    const pos = await readPosition();
    if (pos === null) {
      setCamera(null);
      return;
    }
    const fd = new FormData();
    fd.append('expectedAction', status.nextAction);
    appendPosition(fd, pos);
    if (image) fd.append('selfie', image, 'selfie.jpg');
    setPhase(status.nextAction === 'OUT' ? 'جاري تسجيل الانصراف...' : 'جاري تسجيل الحضور...');
    try {
      const res = await fetch('/api/portal/attendance/punch', { method: 'POST', body: fd });
      if (res.status === 401) return redirectToLogin();
      const data = (await res.json().catch(() => ({}))) as { message?: string; punchId?: string; workDate?: string; action?: 'IN' | 'OUT' };
      if (res.ok) {
        toast.success(data.message || 'تم التسجيل');
        setCamera(null);
        setCoolingDown(true);
        window.setTimeout(() => setCoolingDown(false), 10_000);
        onPunched();
      } else if (res.status === 422 && data.punchId && data.workDate && data.action) {
        setCamera(null);
        setRejection({ message: data.message || 'تعذر تسجيل الحركة', punchId: data.punchId, workDate: data.workDate, action: data.action });
      } else {
        toast.error(data.message || 'تعذر تسجيل الحركة');
        if (res.status === 409) setCamera(null);
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setPhase(null);
      positionRef.current = null;
      void load();
    }
  };

  const start = () => {
    setRejection(null);
    if (status.faceRequired && !status.faceEnrolled) {
      setConsentChecked(false);
      setConsentOpen(true);
      return;
    }
    beginPosition();
    if (status.faceRequired) setCamera('punch');
    else void submitPunch(null);
  };

  const continueAfterConsent = () => {
    setConsentOpen(false);
    beginPosition();
    setCamera('enroll');
  };

  const onCaptured = async (image: Blob) => {
    if (busy) return;
    setBusy(true);
    try {
      if (camera === 'enroll') {
        // One capture enrolls the face and, right after, records the punch.
        if (await submitEnroll(image)) await submitPunch(image);
      } else {
        await submitPunch(image);
      }
    } finally {
      setBusy(false);
    }
  };

  const withdrawConsent = async () => {
    const ok = await confirmDialog('سيتم حذف صورة وجهك وقالبها المشفر. لن تتمكن من تسجيل الحضور من البوابة إلا بعد التسجيل من جديد. هل تريد المتابعة؟', {
      title: 'سحب الموافقة على التحقق من الوجه',
      confirmText: 'حذف بيانات وجهي',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/portal/face', { method: 'DELETE' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حذف البيانات'));
        return;
      }
      toast.success('تم حذف بيانات وجهك');
      void load();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const rec = status.record;
  const isOut = status.nextAction === 'OUT';
  const requirement = [status.geoRequired ? 'موقع العمل' : null, status.faceRequired ? 'التحقق من الوجه' : null].filter(Boolean).join(' + ');

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

        <button
          type="button"
          onClick={start}
          disabled={actionBlocked || busy || !!phase || coolingDown}
          className={`w-full md:w-auto md:min-w-[220px] py-4 px-6 rounded-2xl font-black text-white text-[16px] shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${isOut ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-900/10' : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-900/10'}`}
        >
          {isOut ? <LogOut size={20} aria-hidden="true" /> : <LogIn size={20} aria-hidden="true" />}
          {phase ?? (status.nextAction === 'DONE' ? 'اكتمل تسجيل اليوم' : isOut ? 'تسجيل انصراف' : 'تسجيل حضور')}
        </button>
      </div>

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

      {status.faceEnrolled && (
        <p className="mt-3 text-[11px] font-bold text-slate-400 flex items-center gap-1">
          <ShieldCheck size={12} aria-hidden="true" /> صورة وجهك مسجلة ·{' '}
          <button type="button" onClick={withdrawConsent} className="underline hover:text-slate-600">سحب الموافقة وحذف بيانات وجهي</button>
        </p>
      )}

      <Modal
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        tone="emerald"
        icon={<ScanFace size={22} />}
        title="تسجيل صورة الوجه لأول مرة"
        description="اقرأ الإشعار التالي قبل المتابعة"
      >
        <div className="p-6 md:p-8 space-y-5">
          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-[13px] font-bold text-slate-700 leading-loose space-y-2">
            <p><span className="font-black">الغرض:</span> التأكد من أنك صاحب الحساب وأنك في موقع العمل عند تسجيل الحضور والانصراف فقط.</p>
            <p><span className="font-black">ما نحفظه:</span> قالب رقمي مشفر لوجهك وصورة مرجعية واحدة يطّلع عليها قسم الموارد البشرية عند الحاجة. موقعك يُؤخذ لحظة الضغط على الزر فقط، ولا يتم تتبعك.</p>
            <p><span className="font-black">صور الحركات:</span> لا تُحفظ صور الحركات المقبولة. صور الحركات المرفوضة أو المشبوهة تُحفظ مدة محددة للمراجعة ثم تُحذف تلقائياً.</p>
            <p><span className="font-black">المعالجة:</span> تتم على خوادم المنشأة، ولا تُرسل بيانات وجهك إلى أي طرف خارجي.</p>
            <p><span className="font-black">حقوقك:</span> يمكنك سحب موافقتك وحذف بيانات وجهك في أي وقت من هذه البوابة، وتُحذف تلقائياً عند انتهاء خدمتك.</p>
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} className="mt-1 w-5 h-5 accent-emerald-600" />
            <span className="text-[13px] font-extrabold text-slate-800">قرأت الإشعار وأوافق على معالجة صورة وجهي وموقعي لهذا الغرض.</span>
          </label>
          <p className="text-[12px] font-bold text-slate-500">سجّل صورتك وأنت في موقع العمل، وستُستخدم نفس الصورة لتسجيل هذه الحركة.</p>
          <div className="flex gap-3">
            <button type="button" disabled={!consentChecked} onClick={continueAfterConsent} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
              متابعة إلى الكاميرا
            </button>
            <button type="button" onClick={() => setConsentOpen(false)} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition">
              إلغاء
            </button>
          </div>
        </div>
      </Modal>

      <FaceCameraModal
        open={camera !== null}
        onClose={() => {
          if (!busy) setCamera(null);
        }}
        onCapture={onCaptured}
        busy={busy}
        title={camera === 'enroll' ? 'التقاط صورة الوجه المرجعية' : isOut ? 'تسجيل الانصراف' : 'تسجيل الحضور'}
        description={phase ?? 'التقط صورة لوجهك مباشرة من الكاميرا الأمامية'}
        confirmLabel={camera === 'enroll' ? 'تسجيل الوجه وتسجيل الحركة' : isOut ? 'تأكيد الانصراف' : 'تأكيد الحضور'}
      />
    </section>
  );
}
