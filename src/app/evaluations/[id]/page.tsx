"use client";

import React, { useCallback, useEffect, useState, use } from 'react';
import Link from 'next/link';
import {
  ChevronRight, CheckCircle2, Star, AlertCircle, Save, Send, Undo2, Loader2, Printer, RefreshCw, CalendarClock,
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import Modal from '@/components/ui/Modal';
import { formatDate } from '@/lib/dates';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { computeTotalScore, EVAL_EDITABLE_STATUSES, EVAL_STATUS, SCORE_MAX, SCORE_MIN, type EvalStatus } from '@/app/api/evaluations/scoring';

interface TemplateItem { id: string; title: string; description?: string | null; isRequired?: boolean }
interface TemplateSection { id: string; title: string; weight: number; items: TemplateItem[] }
interface ItemScore { itemId: string; score: number; note?: string | null }
interface EvalEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  jobTitle?: string | null;
  department?: { nameArabic?: string | null } | null;
  branch?: { nameArabic?: string | null } | null;
}
interface Evaluation {
  id: string;
  employeeId: string;
  status: string;
  totalScore?: number | null;
  finalRating?: string | null;
  strengths?: string | null;
  improvements?: string | null;
  finalNotes?: string | null;
  recommendation?: string | null;
  recommendationReason?: string | null;
  itemScores?: ItemScore[];
  employee?: EvalEmployee | null;
}
interface Cycle {
  id: string;
  title: string;
  status: string;
  startDate: string;
  endDate: string;
  template?: { name?: string | null; sections?: TemplateSection[] } | null;
  evaluations?: Evaluation[];
}
interface AttendanceRow {
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status: string;
  lateMinutes: number;
  earlyLeaveMin: number;
}
interface AttendanceRecord {
  from: string;
  to: string;
  rows: AttendanceRow[];
  truncated: boolean;
}

type ViewMode = 'list' | 'form' | 'review' | 'readonly';

const evalStatusMap: Record<string, { label: string; color: string }> = {
  DRAFT: { label: 'مسودة', color: 'bg-slate-100 text-slate-600' },
  PENDING_MANAGER: { label: 'بانتظار تعبئة المدير', color: 'bg-amber-50 text-amber-700' },
  PENDING_APPROVAL: { label: 'بانتظار الاعتماد', color: 'bg-blue-50 text-blue-700' },
  RETURNED: { label: 'معاد للتعديل', color: 'bg-orange-50 text-orange-700' },
  PENDING_EMPLOYEE_ACK: { label: 'بانتظار اطلاع الموظف', color: 'bg-purple-50 text-purple-700' },
  CLOSED: { label: 'مغلق', color: 'bg-emerald-50 text-emerald-700' },
  CANCELLED: { label: 'ملغى', color: 'bg-red-50 text-red-600' },
};

const ratingColors: Record<string, string> = {
  'ممتاز': 'text-emerald-600 bg-emerald-50',
  'جيد جداً': 'text-blue-600 bg-blue-50',
  'جيد': 'text-amber-600 bg-amber-50',
  'مقبول': 'text-orange-600 bg-orange-50',
  'ضعيف': 'text-red-600 bg-red-50',
};

const recommendationLabels: Record<string, string> = {
  NO_ACTION: 'لا يوجد إجراء',
  BONUS: 'مكافأة',
  PROMOTION: 'ترقية',
  RAISE: 'زيادة راتب',
  TRAINING: 'خطة تدريب',
  WARNING: 'لفت نظر',
  NOTICE: 'إنذار',
  EXTEND_MONITORING: 'تمديد متابعة',
  NO_RENEWAL: 'عدم تجديد',
  TERMINATION: 'إنهاء خدمة',
  OTHER: 'أخرى',
};

const scoreLabels = ['', 'ضعيف جداً', 'ضعيف', 'جيد', 'جيد جداً', 'ممتاز'];
const SCORE_VALUES = Array.from({ length: SCORE_MAX - SCORE_MIN + 1 }, (_, i) => SCORE_MIN + i);

function scoreTextClass(score: number): string {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 60) return 'text-amber-600';
  return 'text-red-600';
}

const attendanceStatusLabels: Record<string, string> = { PRESENT: 'حاضر', ABSENT: 'غائب' };

function formatClock(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
}

export default function CycleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: cycleId } = use(params);
  const { role } = useRole();
  // Approving/returning evaluations and closing the cycle are HR-only on the server.
  const isHr = roleIn(role, ROLE_GROUPS.HR);

  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedEval, setSelectedEval] = useState<Evaluation | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // Form state
  const [scores, setScores] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [finalNotes, setFinalNotes] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [recommendationReason, setRecommendationReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [approvalComment, setApprovalComment] = useState('');
  // Read-only attendance record of the evaluated employee (DOM-007: no generated scores).
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [attendance, setAttendance] = useState<AttendanceRecord | null>(null);
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);

  const loadCycle = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
      setNotFound(false);
    }
    try {
      const res = await fetch(`/api/evaluations?view=cycle-detail&cycleId=${encodeURIComponent(cycleId)}`, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (res.status === 404) {
        setCycle(null);
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل دورة التقييم');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      setCycle((await res.json()) as Cycle | null);
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, [cycleId]);

  useEffect(() => {
    void loadCycle();
  }, [loadCycle]);

  const backToList = () => {
    setViewMode('list');
    setSelectedEval(null);
    setAttendance(null);
    setAttendanceOpen(false);
    setApprovalComment('');
  };

  const openEvalForm = (ev: Evaluation) => {
    setSelectedEval(ev);
    const existingScores: Record<string, number> = {};
    const existingNotes: Record<string, string> = {};
    ev.itemScores?.forEach((is) => {
      existingScores[is.itemId] = is.score;
      if (is.note) existingNotes[is.itemId] = is.note;
    });
    setScores(existingScores);
    setNotes(existingNotes);
    setStrengths(ev.strengths || '');
    setImprovements(ev.improvements || '');
    setFinalNotes(ev.finalNotes || '');
    setRecommendation(ev.recommendation || '');
    setRecommendationReason(ev.recommendationReason || '');
    setAttendance(null);
    setAttendanceOpen(false);

    const editable = cycle?.status !== 'CLOSED' && (EVAL_EDITABLE_STATUSES as readonly string[]).includes(ev.status as EvalStatus);
    if (ev.status === EVAL_STATUS.PENDING_APPROVAL && cycle?.status !== 'CLOSED' && isHr) setViewMode('review');
    else if (editable) setViewMode('form');
    else setViewMode('readonly');
  };

  const postAction = async (body: Record<string, unknown>): Promise<{ message?: string; totalScore?: number; finalRating?: string } | null> => {
    const res = await fetch('/api/evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.assign('/login');
      return null;
    }
    if (!res.ok) {
      toast.error(await readApiError(res, 'تعذر تنفيذ العملية'));
      return null;
    }
    return (await res.json()) as { message?: string; totalScore?: number; finalRating?: string };
  };

  const handleSave = async (submit: boolean) => {
    if (!selectedEval || isSaving) return;
    if (submit) {
      const sections = cycle?.template?.sections || [];
      const missing = sections.flatMap((s) => s.items).filter((i) => i.isRequired !== false && !scores[i.id]).length;
      if (missing > 0) {
        toast.warning(`يرجى تقييم جميع العناصر الإلزامية قبل الإرسال (${missing} عنصر بدون تقييم)`);
        return;
      }
      if (!finalNotes.trim()) {
        toast.warning('الملاحظات الختامية إلزامية عند إرسال التقييم للاعتماد');
        return;
      }
      if (!recommendation) {
        toast.warning('يرجى اختيار التوصية الإدارية');
        return;
      }
      if (!recommendationReason.trim()) {
        toast.warning('يرجى كتابة سبب التوصية');
        return;
      }
    }

    setIsSaving(true);
    try {
      const scoreData = Object.entries(scores).map(([itemId, score]) => ({ itemId, score, note: notes[itemId] || '' }));
      const data = await postAction({
        action: 'SAVE_SCORES',
        evaluationId: selectedEval.id,
        scores: scoreData,
        strengths,
        improvements,
        finalNotes,
        recommendation,
        recommendationReason,
        submitForApproval: submit,
      });
      if (data) {
        const scorePart = typeof data.totalScore === 'number' ? ` | النتيجة: ${data.totalScore.toFixed(1)}% - ${data.finalRating ?? ''}` : '';
        toast.success(`${data.message || 'تم الحفظ'}${scorePart}`);
        backToList();
        await loadCycle({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSaving(false);
    }
  };

  const handleApproval = async (action: 'APPROVE_EVALUATION' | 'RETURN_EVALUATION') => {
    if (!selectedEval || isSaving) return;
    if (action === 'RETURN_EVALUATION' && !approvalComment.trim()) {
      toast.warning('يرجى كتابة سبب الإعادة');
      return;
    }
    setIsSaving(true);
    try {
      const data = await postAction({ action, evaluationId: selectedEval.id, comment: approvalComment });
      if (data) {
        toast.success(data.message || (action === 'APPROVE_EVALUATION' ? 'تم اعتماد التقييم بنجاح' : 'تمت إعادة التقييم للمدير'));
        backToList();
        await loadCycle({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCloseCycle = async () => {
    if (isClosing) return;
    if (!(await confirmDialog('هل أنت متأكد من إغلاق دورة التقييم؟ لن يمكن التعديل بعد الإغلاق.', { danger: true }))) return;
    setIsClosing(true);
    try {
      const data = await postAction({ action: 'CLOSE_CYCLE', cycleId });
      if (data) {
        toast.success(data.message || 'تم إغلاق دورة التقييم');
        await loadCycle({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsClosing(false);
    }
  };

  const openAttendanceRecord = async () => {
    if (!selectedEval) return;
    setAttendanceOpen(true);
    if (attendance || attendanceLoading) return;
    setAttendanceLoading(true);
    setAttendanceError(null);
    try {
      const res = await fetch(`/api/evaluations?view=attendance-record&evalId=${encodeURIComponent(selectedEval.id)}`, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        setAttendanceError(await readApiError(res, 'تعذر تحميل سجل الحضور'));
        return;
      }
      setAttendance((await res.json()) as AttendanceRecord);
    } catch {
      setAttendanceError('تعذر الاتصال بالخادم');
    } finally {
      setAttendanceLoading(false);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-[60vh] text-slate-400 font-bold animate-pulse">
          <Loader2 size={24} className="animate-spin ml-2" /> جاري تحميل دورة التقييم...
        </div>
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4 text-center px-4">
          <AlertCircle size={36} className="text-rose-400" />
          <p className="text-slate-600 font-bold">{loadError}</p>
          <button type="button" onClick={() => void loadCycle()} className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-5 py-2.5 rounded-xl font-black text-[13px] transition">
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      </DashboardLayout>
    );
  }

  if (!cycle || notFound) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4 text-red-500 font-bold">
          <span className="flex items-center"><AlertCircle size={24} className="ml-2" /> لم يتم العثور على دورة التقييم</span>
          <Link href="/evaluations" className="text-violet-600 hover:underline text-[13px]">العودة لإدارة التقييم</Link>
        </div>
      </DashboardLayout>
    );
  }

  const sections = cycle.template?.sections || [];

  // ========== EVALUATION FORM VIEW ==========
  if (viewMode !== 'list' && selectedEval) {
    const liveScore = computeTotalScore(sections, Object.entries(scores).map(([itemId, score]) => ({ itemId, score })));
    const isReadOnly = viewMode !== 'form';
    const emp = selectedEval.employee;

    return (
      <DashboardLayout>
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-6">

          {/* Back */}
          <button type="button" onClick={backToList} className="text-slate-500 hover:text-violet-600 font-bold text-[13px] flex items-center gap-1 transition">
            <ChevronRight size={16} /> العودة لقائمة الموظفين
          </button>

          {/* Employee Info */}
          <div className="bg-gradient-to-l from-violet-600 to-indigo-800 rounded-[2rem] p-6 text-white relative overflow-hidden">
            <div className="absolute top-0 right-0 w-full h-full bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
            <div className="relative z-10 flex flex-col md:flex-row md:items-center gap-6">
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center text-3xl font-black">{emp?.firstNameArabic?.charAt(0)}</div>
              <div className="flex-1">
                <h2 className="text-2xl font-black">{emp?.firstNameArabic} {emp?.lastNameArabic}</h2>
                <p className="text-violet-200 font-bold text-[13px] mt-1">
                  {emp?.employeeId} • {emp?.jobTitle || 'غير محدد'} • {emp?.department?.nameArabic || ''} • {emp?.branch?.nameArabic || ''}
                </p>
                {viewMode === 'readonly' && (
                  <p className="mt-2 inline-block bg-white/15 rounded-lg px-3 py-1 text-[11px] font-black">
                    {evalStatusMap[selectedEval.status]?.label || selectedEval.status} — للعرض فقط
                  </p>
                )}
              </div>
              <div className="text-center bg-white/10 backdrop-blur-md rounded-2xl p-4 min-w-[120px]">
                <p className="text-[11px] font-black text-violet-200 mb-1">{isReadOnly ? 'النتيجة' : 'النتيجة الحية'}</p>
                <p className="text-3xl font-black">{liveScore.toFixed(1)}%</p>
              </div>
            </div>
          </div>

          {/* Attendance record (read-only reference; the evaluator sets every score) */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-2xl px-5 py-3 border border-slate-100 shadow-sm">
            <p className="text-[12px] font-bold text-slate-500">الدرجات يضعها المقيّم وحده. يمكنك الرجوع إلى سجل الحضور في فترة الدورة للاطلاع فقط.</p>
            <button
              type="button"
              onClick={() => void openAttendanceRecord()}
              className="text-violet-700 hover:text-violet-900 hover:underline font-black text-[13px] flex items-center gap-1.5 shrink-0">
              <CalendarClock size={16} /> سجل حضور الموظف
            </button>
          </div>
          <Modal
            open={attendanceOpen}
            onClose={() => setAttendanceOpen(false)}
            title="سجل حضور الموظف"
            description={attendance ? `من ${formatDate(attendance.from)} إلى ${formatDate(attendance.to)} — للاطلاع فقط` : 'فترة دورة التقييم — للاطلاع فقط'}
            icon={<CalendarClock size={22} />}
            tone="slate"
            size="xl">
            <div className="p-6">
            {attendanceLoading ? (
              <p className="py-10 text-center text-slate-400 font-bold">جاري تحميل سجل الحضور...</p>
            ) : attendanceError ? (
              <p className="py-10 text-center text-rose-600 font-bold">{attendanceError}</p>
            ) : attendance && attendance.rows.length === 0 ? (
              <p className="py-10 text-center text-slate-500 font-bold">لا توجد سجلات حضور لهذا الموظف في فترة الدورة.</p>
            ) : attendance ? (
              <div className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-[13px]">
                    <thead className="text-slate-500 font-black border-b border-slate-100">
                      <tr>
                        <th className="py-2 px-2">التاريخ</th>
                        <th className="py-2 px-2">الحالة</th>
                        <th className="py-2 px-2">الدخول</th>
                        <th className="py-2 px-2">الخروج</th>
                        <th className="py-2 px-2">دقائق التأخير</th>
                        <th className="py-2 px-2">دقائق الخروج المبكر</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 font-bold text-slate-700">
                      {attendance.rows.map((r) => (
                        <tr key={r.date}>
                          <td className="py-2 px-2 whitespace-nowrap">{formatDate(r.date)}</td>
                          <td className="py-2 px-2">{attendanceStatusLabels[r.status] ?? r.status}</td>
                          <td className="py-2 px-2" dir="ltr">{formatClock(r.checkIn)}</td>
                          <td className="py-2 px-2" dir="ltr">{formatClock(r.checkOut)}</td>
                          <td className="py-2 px-2">{r.lateMinutes}</td>
                          <td className="py-2 px-2">{r.earlyLeaveMin}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {attendance.truncated && (
                  <p className="text-[12px] font-bold text-slate-500">يعرض الجدول أحدث {attendance.rows.length} يوماً فقط من فترة الدورة.</p>
                )}
                <p className="text-[12px] font-bold text-slate-500">سجل الحضور يُدخل يدوياً وقد يكون ناقصاً. أيام الإجازات النظامية المعتمدة لا تُحتسب على الموظف في التقييم.</p>
              </div>
            ) : null}
            </div>
          </Modal>

          {/* Sections & Items */}
          {sections.map((section, si) => (
            <div key={section.id} className="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm overflow-hidden">
              <div className="bg-slate-50 px-6 py-4 border-b border-slate-100 flex justify-between items-center">
                <h3 className="font-black text-slate-800 text-[15px]">{si + 1}. {section.title}</h3>
                <span className="text-[12px] font-black bg-violet-100 text-violet-600 px-3 py-1 rounded-lg">الوزن: {section.weight}%</span>
              </div>
              <div className="p-6 space-y-5">
                {section.items.map((item) => {
                  const current = scores[item.id];
                  return (
                    <div key={item.id} className="border-b border-slate-50 pb-4 last:border-0 last:pb-0">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                        <div className="flex-1">
                          <p className="font-bold text-slate-700 text-[14px]">
                            {item.title}{item.isRequired !== false && !isReadOnly && <span className="text-red-400 mr-1">*</span>}
                          </p>
                          {item.description && <p className="text-[11px] text-slate-400 font-bold mt-1">{item.description}</p>}
                        </div>
                        <div className="flex gap-1.5" role="radiogroup" aria-label={item.title}>
                          {SCORE_VALUES.map((score) => (
                            <button
                              key={score}
                              type="button"
                              role="radio"
                              aria-checked={current === score}
                              disabled={isReadOnly}
                              onClick={() => setScores((p) => ({ ...p, [item.id]: score }))}
                              className={`w-10 h-10 rounded-xl text-[13px] font-black transition-all border-2 ${
                                current === score
                                  ? score >= 4 ? 'bg-emerald-500 text-white border-emerald-500 shadow-lg shadow-emerald-200'
                                    : score === 3 ? 'bg-amber-500 text-white border-amber-500 shadow-lg shadow-amber-200'
                                      : 'bg-red-500 text-white border-red-500 shadow-lg shadow-red-200'
                                  : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-violet-300'
                              } ${isReadOnly ? 'cursor-default' : 'cursor-pointer'}`}
                              title={scoreLabels[score]}
                            >
                              {score}
                            </button>
                          ))}
                        </div>
                      </div>
                      {current ? (
                        <p className={`text-[11px] font-black mt-2 ${current >= 4 ? 'text-emerald-500' : current === 3 ? 'text-amber-500' : 'text-red-500'}`}>
                          التقييم: {scoreLabels[current]}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Notes & Recommendations */}
          <div className="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-6 space-y-5">
            <h3 className="font-black text-slate-800 text-[15px] flex items-center gap-2"><Star size={18} className="text-amber-500" /> الملاحظات والتوصيات</h3>

            <div>
              <label htmlFor="ev-strengths" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نقاط القوة</label>
              <textarea id="ev-strengths" value={strengths} onChange={(e) => setStrengths(e.target.value)} readOnly={isReadOnly} maxLength={5000}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition resize-none h-24" placeholder="أهم الجوانب الإيجابية..." />
            </div>
            <div>
              <label htmlFor="ev-improvements" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نقاط التحسين</label>
              <textarea id="ev-improvements" value={improvements} onChange={(e) => setImprovements(e.target.value)} readOnly={isReadOnly} maxLength={5000}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition resize-none h-24" placeholder="الجوانب التي تحتاج تطوير..." />
            </div>
            <div>
              <label htmlFor="ev-final" className="text-[12px] font-extrabold text-slate-700 mb-2 block">ملاحظات ختامية <span className="text-red-500">*</span></label>
              <textarea id="ev-final" value={finalNotes} onChange={(e) => setFinalNotes(e.target.value)} readOnly={isReadOnly} maxLength={5000}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition resize-none h-24" placeholder="ملاحظات عامة وتوجيهات..." />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="ev-rec" className="text-[12px] font-extrabold text-slate-700 mb-2 block">التوصية الإدارية <span className="text-red-500">*</span></label>
                <select id="ev-rec" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} disabled={isReadOnly}
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition appearance-none">
                  <option value="">— اختر التوصية —</option>
                  {Object.entries(recommendationLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ev-rec-reason" className="text-[12px] font-extrabold text-slate-700 mb-2 block">سبب التوصية <span className="text-red-500">*</span></label>
                <input id="ev-rec-reason" type="text" value={recommendationReason} onChange={(e) => setRecommendationReason(e.target.value)} readOnly={isReadOnly} maxLength={2000}
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition" placeholder="شرح سبب التوصية..." />
              </div>
            </div>
          </div>

          {/* Actions */}
          {viewMode === 'form' && (
            <div className="flex gap-3">
              <button type="button" onClick={() => void handleSave(false)} disabled={isSaving}
                className="flex-1 bg-slate-100 text-slate-700 hover:bg-slate-200 py-4 rounded-xl font-black text-[14px] flex items-center justify-center gap-2 transition disabled:opacity-50">
                <Save size={18} /> {isSaving ? 'جاري الحفظ...' : 'حفظ كمسودة'}
              </button>
              <button type="button" onClick={() => void handleSave(true)} disabled={isSaving}
                className="flex-1 bg-violet-600 hover:bg-violet-700 text-white py-4 rounded-xl font-black text-[14px] flex items-center justify-center gap-2 transition shadow-lg shadow-violet-200 disabled:opacity-50">
                <Send size={18} /> {isSaving ? 'جاري الإرسال...' : 'إرسال للاعتماد'}
              </button>
            </div>
          )}

          {viewMode === 'readonly' && (selectedEval.totalScore ?? 0) > 0 && (
            <div className="flex justify-end">
              <Link href={`/evaluations/print/${selectedEval.id}`} target="_blank" className="bg-slate-100 hover:bg-violet-100 text-slate-600 hover:text-violet-700 px-5 py-3 rounded-xl font-black text-[13px] flex items-center gap-2 transition">
                <Printer size={16} /> طباعة التقييم
              </Link>
            </div>
          )}

          {viewMode === 'review' && (
            <div className="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-6 space-y-4">
              <h3 className="font-black text-slate-800 text-[15px] flex items-center gap-2"><CheckCircle2 size={18} className="text-emerald-500" /> إجراء الاعتماد</h3>
              <div className="bg-indigo-50 rounded-xl p-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-black text-indigo-400">النتيجة النهائية</p>
                  <p className="text-2xl font-black text-indigo-700">{(selectedEval.totalScore ?? 0).toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-[11px] font-black text-indigo-400">التصنيف</p>
                  <p className={`text-lg font-black px-3 py-1 rounded-lg inline-block ${ratingColors[selectedEval.finalRating ?? ''] || ''}`}>{selectedEval.finalRating}</p>
                </div>
              </div>
              <textarea value={approvalComment} onChange={(e) => setApprovalComment(e.target.value)} aria-label="تعليق الموارد البشرية" maxLength={5000}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition resize-none h-20" placeholder="تعليق الموارد البشرية (اختياري للاعتماد، إلزامي للإعادة)..." />
              <div className="flex gap-3">
                <button type="button" onClick={() => void handleApproval('RETURN_EVALUATION')} disabled={isSaving}
                  className="bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-600 hover:text-white py-3 px-6 rounded-xl font-black text-[13px] flex items-center gap-2 transition disabled:opacity-50">
                  <Undo2 size={16} /> إعادة للتعديل
                </button>
                <button type="button" onClick={() => void handleApproval('APPROVE_EVALUATION')} disabled={isSaving}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-xl font-black text-[14px] flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-200 disabled:opacity-50">
                  <CheckCircle2 size={18} /> {isSaving ? 'جاري التنفيذ...' : 'اعتماد التقييم'}
                </button>
              </div>
            </div>
          )}
        </div>
      </DashboardLayout>
    );
  }

  // ========== EMPLOYEES LIST VIEW ==========
  const evaluations = cycle.evaluations || [];
  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-8">

        {/* Breadcrumb */}
        <nav aria-label="مسار التنقل" className="flex items-center gap-2 text-[13px] font-bold text-slate-400">
          <Link href="/evaluations" className="hover:text-violet-600 transition">إدارة التقييم</Link>
          <ChevronRight size={14} />
          <span className="text-slate-700">{cycle.title}</span>
        </nav>

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900">{cycle.title}</h1>
            <p className="text-slate-500 font-bold text-[13px] mt-1">
              {cycle.template?.name} • {formatDate(cycle.startDate)} — {formatDate(cycle.endDate)}
            </p>
          </div>
          {cycle.status !== 'CLOSED' ? (isHr && (
            <button type="button" onClick={() => void handleCloseCycle()} disabled={isClosing} className="bg-slate-200 hover:bg-red-100 hover:text-red-700 text-slate-600 px-5 py-2.5 rounded-xl font-black text-[13px] transition disabled:opacity-50">
              {isClosing ? 'جاري الإغلاق...' : 'إغلاق الدورة'}
            </button>
          )) : (
            <span className="bg-slate-100 text-slate-500 px-4 py-2 rounded-xl font-black text-[12px]">الدورة مغلقة</span>
          )}
        </div>

        {/* Employees Grid */}
        {evaluations.length === 0 ? (
          <div className="bg-white rounded-[2rem] border border-dashed border-slate-300 p-16 text-center text-slate-500 font-bold">
            لا توجد تقييمات ضمن صلاحياتك في هذه الدورة.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {evaluations.map((ev) => {
              const st = evalStatusMap[ev.status] || evalStatusMap.DRAFT;
              const emp = ev.employee;
              const total = ev.totalScore ?? 0;
              return (
                <div key={ev.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`فتح تقييم ${emp?.firstNameArabic ?? ''} ${emp?.lastNameArabic ?? ''}`}
                  onClick={() => openEvalForm(ev)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEvalForm(ev); } }}
                  className="bg-white rounded-2xl p-5 border-2 border-slate-100 shadow-sm hover:shadow-md hover:border-violet-200 focus:outline-none focus:ring-2 focus:ring-violet-300 transition-all cursor-pointer group">

                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 bg-violet-50 rounded-full flex items-center justify-center text-violet-600 font-black text-lg">
                        {emp?.firstNameArabic?.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-extrabold text-[14px] text-slate-800 group-hover:text-violet-700 transition">{emp?.firstNameArabic} {emp?.lastNameArabic}</h3>
                        <p className="text-[11px] font-bold text-slate-400">{emp?.jobTitle || ''} • {emp?.department?.nameArabic || ''}</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black ${st.color}`}>{st.label}</span>
                    <div className="flex items-center gap-2">
                      {total > 0 ? (
                        <>
                          <span className={`font-black text-[13px] ${scoreTextClass(total)}`}>
                            {total.toFixed(1)}%
                          </span>
                          {ev.finalRating && (
                            <span className={`text-[10px] font-black px-2 py-0.5 rounded-md ${ratingColors[ev.finalRating] || ''}`}>{ev.finalRating}</span>
                          )}
                          <Link href={`/evaluations/print/${ev.id}`} target="_blank" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} aria-label="طباعة التقييم"
                            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-violet-100 text-slate-400 hover:text-violet-600 flex items-center justify-center transition">
                            <Printer size={13} />
                          </Link>
                        </>
                      ) : (
                        <span className="text-[11px] font-bold text-slate-300">لم يُقيّم بعد</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
