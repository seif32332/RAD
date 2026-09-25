"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, ExternalLink, Image as ImageIcon, RefreshCw, ScanFace, ShieldOff, UserCog } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { confirmDialog, readApiError, toast } from '@/components/ui/feedback';
import { formatDate, formatDateTime } from '@/lib/dates';
import { mapsLink } from '@/lib/geo';
import { PUNCH_REASON_LABELS, type PunchReason } from '@/lib/self-attendance';

export interface SelfAttendanceEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  branch?: { nameArabic?: string | null } | null;
  attendanceGeoExempt?: boolean;
  attendanceFaceExempt?: boolean;
  attendanceExemptReason?: string | null;
  faceProfile?: { createdAt: string; model: string } | null;
}

interface Punch {
  id: string;
  workDate: string;
  type: 'IN' | 'OUT';
  result: 'ACCEPTED' | 'FLAGGED' | 'REJECTED';
  reasons: string[];
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  distanceM: number | null;
  locationName: string | null;
  radiusM: number | null;
  faceScore: number | null;
  livenessScore: number | null;
  hasSelfie: boolean;
  selfiePurgedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  employee: { employeeId: string; firstNameArabic: string; lastNameArabic: string; branch: { nameArabic: string } | null };
}

type ResultFilter = '' | 'ACCEPTED' | 'FLAGGED' | 'REJECTED' | 'PENDING';

const RESULT_BADGE: Record<Punch['result'], { label: string; cls: string }> = {
  ACCEPTED: { label: 'مقبولة', cls: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  FLAGGED: { label: 'مقبولة للمراجعة', cls: 'bg-amber-50 text-amber-800 border-amber-100' },
  REJECTED: { label: 'مرفوضة', cls: 'bg-rose-50 text-rose-700 border-rose-100' },
};

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const reasonLabel = (r: string) => PUNCH_REASON_LABELS[r as PunchReason] ?? r;

/**
 * HR view of the portal self clock-in: every attempt (with evidence for rejected / flagged ones),
 * the review of flagged punches, and per-employee face enrollment / exemptions.
 */
export default function SelfAttendancePanel({ employees, onChanged }: { employees: SelfAttendanceEmployee[]; onChanged: () => void }) {
  const [punches, setPunches] = useState<Punch[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingReview, setPendingReview] = useState(0);
  const [filter, setFilter] = useState<ResultFilter>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ emp: SelfAttendanceEmployee; geo: boolean; face: boolean; reason: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const query = useCallback(
    (skip: number) => {
      const q = new URLSearchParams({ take: '50', skip: String(skip) });
      if (filter === 'PENDING') q.set('review', 'pending');
      else if (filter) q.set('result', filter);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      return `/api/attendance-punches?${q.toString()}`;
    },
    [filter, from, to],
  );

  const loadPunches = useCallback(
    async (append = false, skip = 0) => {
      setLoading(true);
      try {
        const res = await fetch(query(skip), { cache: 'no-store' });
        if (!res.ok) {
          toast.error(await readApiError(res, 'تعذر تحميل سجل الحركات'));
          return;
        }
        const data = (await res.json()) as { punches: Punch[]; total: number; pendingReview: number };
        setPunches((prev) => (append ? [...prev, ...data.punches] : data.punches));
        setTotal(data.total);
        setPendingReview(data.pendingReview);
      } catch {
        toast.error('تعذر الاتصال بالخادم');
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void loadPunches();
  }, [loadPunches]);

  const markReviewed = async (p: Punch) => {
    try {
      const res = await fetch(`/api/attendance-punches/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'MARK_REVIEWED' }),
      });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حفظ المراجعة'));
        return;
      }
      toast.success('تمت مراجعة الحركة');
      void loadPunches();
      onChanged();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const hubAction = async (actionType: string, payload: Record<string, unknown>, okMessage: string) => {
    const res = await fetch('/api/attendance-hub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType, payload }) });
    if (!res.ok) {
      toast.error(await readApiError(res, 'تعذر تنفيذ العملية'));
      return false;
    }
    toast.success(okMessage);
    onChanged();
    return true;
  };

  const resetFace = async (emp: SelfAttendanceEmployee) => {
    const ok = await confirmDialog(`حذف صورة الوجه المسجلة للموظف ${emp.firstNameArabic ?? ''} ${emp.lastNameArabic ?? ''}؟ سيحتاج إلى تسجيل وجهه من جديد من البوابة.`, {
      danger: true,
      confirmText: 'حذف الصورة',
    });
    if (!ok) return;
    try {
      await hubAction('RESET_FACE', { employeeId: emp.id }, 'تم حذف صورة الوجه المسجلة');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const saveExemptions = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editing || saving) return;
    setSaving(true);
    try {
      const done = await hubAction(
        'SET_ATTENDANCE_EXEMPTIONS',
        { employeeId: editing.emp.id, geoExempt: editing.geo, faceExempt: editing.face, reason: editing.reason },
        'تم تحديث استثناءات الحضور',
      );
      if (done) setEditing(null);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSaving(false);
    }
  };

  const shownEmployees = useMemo(() => {
    const s = search.trim();
    if (!s) return employees;
    return employees.filter((e) => `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} ${e.employeeId ?? ''}`.includes(s));
  }, [employees, search]);
  const enrolledCount = employees.filter((e) => e.faceProfile).length;

  return (
    <div className="space-y-8">
      {/* Punch log */}
      <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
        <div className="bg-slate-50 p-6 border-b border-slate-100 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h3 className="font-black text-slate-800 text-[16px]">محاولات الحضور والانصراف من البوابة</h3>
              <p className="text-slate-500 font-bold text-[12px] mt-1">
                كل محاولة تُسجَّل بوقت الخادم. صور الحركات المرفوضة والمشبوهة فقط تُحفظ، ثم تُحذف تلقائياً بعد مدة الاحتفاظ.
              </p>
            </div>
            {pendingReview > 0 && (
              <button type="button" onClick={() => setFilter('PENDING')} className="text-[12px] font-black bg-amber-100 text-amber-800 px-3 py-1.5 rounded-full">
                {pendingReview} حركة بانتظار المراجعة
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <select aria-label="النتيجة" value={filter} onChange={(e) => setFilter(e.target.value as ResultFilter)} className="px-4 py-2.5 rounded-xl border border-slate-200 font-bold text-[13px] bg-white">
              <option value="">كل النتائج</option>
              <option value="REJECTED">المرفوضة</option>
              <option value="FLAGGED">المعلَّمة للمراجعة</option>
              <option value="PENDING">بانتظار المراجعة</option>
              <option value="ACCEPTED">المقبولة</option>
            </select>
            <label className="text-[12px] font-bold text-slate-500 flex items-center gap-2">من
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-3 py-2 rounded-xl border border-slate-200 font-bold text-[13px]" />
            </label>
            <label className="text-[12px] font-bold text-slate-500 flex items-center gap-2">إلى
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-3 py-2 rounded-xl border border-slate-200 font-bold text-[13px]" />
            </label>
            <button type="button" onClick={() => void loadPunches()} className="inline-flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-xl font-black text-[13px]">
              <RefreshCw size={14} aria-hidden="true" /> تحديث
            </button>
            <span className="text-[11px] font-bold text-slate-400">{total} حركة</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-white border-b border-slate-100">
                <th className="p-4 text-[12px] font-black text-slate-500">الموظف</th>
                <th className="p-4 text-[12px] font-black text-slate-500">الوقت</th>
                <th className="p-4 text-[12px] font-black text-slate-500">النتيجة</th>
                <th className="p-4 text-[12px] font-black text-slate-500">الموقع</th>
                <th className="p-4 text-[12px] font-black text-slate-500">الوجه</th>
                <th className="p-4 text-[12px] font-black text-slate-500">الأسباب</th>
                <th className="p-4 text-[12px] font-black text-slate-500">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {punches.map((p) => {
                const badge = RESULT_BADGE[p.result];
                return (
                  <tr key={p.id} className="hover:bg-slate-50 align-top">
                    <td className="p-4">
                      <p className="font-bold text-[13px] text-slate-800">{p.employee.firstNameArabic} {p.employee.lastNameArabic}</p>
                      <p className="text-slate-400 text-[11px] font-bold">#{p.employee.employeeId} · {p.employee.branch?.nameArabic || '—'}</p>
                    </td>
                    <td className="p-4 text-[12px] font-bold text-slate-700">
                      <p>{p.type === 'IN' ? 'حضور' : 'انصراف'}</p>
                      <p className="text-slate-500">{formatDateTime(p.createdAt)}</p>
                      <p className="text-slate-400">يوم العمل: {formatDate(p.workDate)}</p>
                    </td>
                    <td className="p-4">
                      <span className={`text-[11px] font-black border px-2 py-1 rounded-full ${badge.cls}`}>{badge.label}</span>
                      {p.result === 'FLAGGED' && p.reviewedAt && <p className="text-[11px] font-bold text-emerald-600 mt-1">تمت المراجعة</p>}
                    </td>
                    <td className="p-4 text-[12px] font-bold text-slate-600">
                      {p.distanceM !== null ? (
                        <p>{Math.round(p.distanceM)} م من «{p.locationName}» (نطاق {p.radiusM} م)</p>
                      ) : (
                        <p>—</p>
                      )}
                      {p.accuracyM !== null && <p className="text-slate-400">دقة ±{Math.round(p.accuracyM)} م</p>}
                      {p.latitude !== null && p.longitude !== null && (
                        <a href={mapsLink({ latitude: p.latitude, longitude: p.longitude })} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                          <ExternalLink size={12} aria-hidden="true" /> الخريطة
                        </a>
                      )}
                    </td>
                    <td className="p-4 text-[12px] font-bold text-slate-600">
                      <p>تطابق {pct(p.faceScore)}</p>
                      <p className="text-slate-400">التقاط مباشر {pct(p.livenessScore)}</p>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-1">
                        {p.reasons.length === 0 ? <span className="text-[11px] text-slate-400 font-bold">—</span> : p.reasons.map((r) => (
                          <span key={r} className="text-[11px] font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">{reasonLabel(r)}</span>
                        ))}
                      </div>
                    </td>
                    <td className="p-4 space-y-2">
                      {p.hasSelfie && (
                        <a href={`/api/attendance-punches/${encodeURIComponent(p.id)}/photo`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-1 rounded-lg">
                          <ImageIcon size={12} aria-hidden="true" /> الصورة
                        </a>
                      )}
                      {!p.hasSelfie && p.selfiePurgedAt && <p className="text-[11px] font-bold text-slate-400">حُذفت الصورة</p>}
                      {p.result === 'FLAGGED' && !p.reviewedAt && (
                        <button type="button" onClick={() => markReviewed(p)} className="inline-flex items-center gap-1 text-[12px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded-lg">
                          <CheckCircle size={12} aria-hidden="true" /> تمت المراجعة
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {punches.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-slate-400 font-bold">{loading ? 'جاري التحميل...' : 'لا توجد حركات مطابقة.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {punches.length < total && (
          <div className="p-4 border-t border-slate-100 text-center">
            <button type="button" disabled={loading} onClick={() => void loadPunches(true, punches.length)} className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-6 py-2.5 rounded-xl font-bold text-[13px] disabled:opacity-50">
              تحميل المزيد
            </button>
          </div>
        )}
      </div>

      {/* Enrollment and exemptions */}
      <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
        <div className="bg-slate-50 p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h3 className="font-black text-slate-800 text-[16px]">صور الوجه المسجلة والاستثناءات</h3>
            <p className="text-slate-500 font-bold text-[12px] mt-1">
              يسجّل الموظف صورة وجهه بنفسه من البوابة ({enrolledCount} / {employees.length}). راجع الصور المرجعية دورياً، وأعد التسجيل عند أي شك.
            </p>
          </div>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الرقم" className="px-4 py-2.5 rounded-xl border border-slate-200 font-bold text-[13px] w-full md:w-64" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-white border-b border-slate-100">
                <th className="p-4 text-[12px] font-black text-slate-500">الموظف / الفرع</th>
                <th className="p-4 text-[12px] font-black text-slate-500">صورة الوجه</th>
                <th className="p-4 text-[12px] font-black text-slate-500">الاستثناءات</th>
                <th className="p-4 text-[12px] font-black text-slate-500">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shownEmployees.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="p-4">
                    <p className="font-bold text-[13px] text-slate-800">{e.firstNameArabic} {e.lastNameArabic}</p>
                    <p className="text-slate-400 text-[11px] font-bold">#{e.employeeId} · {e.branch?.nameArabic || '—'}</p>
                  </td>
                  <td className="p-4 text-[12px] font-bold">
                    {e.faceProfile ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-emerald-700">مسجلة منذ {formatDate(e.faceProfile.createdAt)}</span>
                        <a href={`/api/face-profiles/${encodeURIComponent(e.id)}/photo`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-lg">
                          <ImageIcon size={12} aria-hidden="true" /> عرض
                        </a>
                      </div>
                    ) : (
                      <span className="text-slate-400">غير مسجلة</span>
                    )}
                  </td>
                  <td className="p-4 text-[12px] font-bold text-slate-600">
                    {!e.attendanceGeoExempt && !e.attendanceFaceExempt ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <div className="space-y-1">
                        {e.attendanceGeoExempt && <span className="inline-block bg-sky-50 text-sky-700 border border-sky-100 px-2 py-0.5 rounded-full">مستثنى من الموقع</span>}
                        {e.attendanceFaceExempt && <span className="inline-block bg-violet-50 text-violet-700 border border-violet-100 px-2 py-0.5 rounded-full">مستثنى من الوجه</span>}
                        {e.attendanceExemptReason && <p className="text-slate-400">{e.attendanceExemptReason}</p>}
                      </div>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing({ emp: e, geo: !!e.attendanceGeoExempt, face: !!e.attendanceFaceExempt, reason: e.attendanceExemptReason ?? '' })}
                        className="inline-flex items-center gap-1 text-[12px] font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-1 rounded-lg"
                      >
                        <UserCog size={12} aria-hidden="true" /> الاستثناءات
                      </button>
                      {e.faceProfile && (
                        <button type="button" onClick={() => resetFace(e)} className="inline-flex items-center gap-1 text-[12px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-1 rounded-lg">
                          <ShieldOff size={12} aria-hidden="true" /> إعادة التسجيل
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {shownEmployees.length === 0 && (
                <tr><td colSpan={4} className="p-10 text-center text-slate-400 font-bold">لا يوجد موظفون مطابقون.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => !saving && setEditing(null)}
        busy={saving}
        tone="slate"
        icon={<ScanFace size={22} />}
        title="استثناءات الحضور من البوابة"
        description={editing ? `${editing.emp.firstNameArabic ?? ''} ${editing.emp.lastNameArabic ?? ''}` : undefined}
      >
        {editing && (
          <form onSubmit={saveExemptions} className="p-6 md:p-8 space-y-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={editing.geo} onChange={(ev) => setEditing({ ...editing, geo: ev.target.checked, face: ev.target.checked ? false : editing.face })} className="mt-1 w-5 h-5 accent-slate-800" />
              <span className="text-[13px] font-bold text-slate-700">
                <span className="font-black text-slate-900">مستثنى من شرط الموقع</span> — للموظفين الميدانيين (سائق، مندوب). يبقى التحقق من الوجه مطلوباً.
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={editing.face} onChange={(ev) => setEditing({ ...editing, face: ev.target.checked, geo: ev.target.checked ? false : editing.geo })} className="mt-1 w-5 h-5 accent-slate-800" />
              <span className="text-[13px] font-bold text-slate-700">
                <span className="font-black text-slate-900">مستثنى من التحقق من الوجه</span> — مثلاً لتغطية الوجه. يبقى شرط الموقع مطلوباً. يعتمده مالك المنشأة فقط.
              </span>
            </label>
            <div>
              <label htmlFor="exempt-reason" className="text-[13px] font-extrabold text-slate-700 block mb-2">سبب الاستثناء</label>
              <textarea id="exempt-reason" rows={3} value={editing.reason} maxLength={500} onChange={(ev) => setEditing({ ...editing, reason: ev.target.value })} className="w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-slate-400 rounded-2xl px-4 py-3 font-bold text-slate-800 focus:outline-none resize-none" />
              <p className="text-[11px] font-bold text-slate-400 mt-1">لا يمكن الجمع بين الاستثناءين، ولا يمكنك تعديل استثناءاتك أنت.</p>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={saving} className="flex-1 bg-slate-900 hover:bg-black text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
                {saving ? 'جاري الحفظ...' : 'حفظ'}
              </button>
              <button type="button" onClick={() => setEditing(null)} disabled={saving} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">
                إلغاء
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
