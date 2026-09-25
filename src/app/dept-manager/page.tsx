"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Users, UserCheck, UserX, Clock, CalendarDays, Fingerprint, CheckCircle2, XCircle, AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import ManagerWorkspace from '@/app/portal/_components/ManagerWorkspace';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { redirectToLogin } from '@/app/portal/_components/redirect-to-login';
import { formatDateShort } from '@/lib/dates';
import { leaveTypeLabel } from '@/lib/leave';

interface DeptOption { id: string; nameArabic: string; branch?: { nameArabic?: string | null } | null; _count?: { employees?: number } }
interface PendingLeave { id: string; leaveType: string; startDate: string; endDate: string; totalDays: number; isManagerApproved?: boolean }
interface DeptEmployee { id: string; employeeId?: string | null; firstNameArabic?: string | null; lastNameArabic?: string | null; jobTitle?: string | null; leaves?: PendingLeave[] }
interface PendingCorrection {
  id: string;
  date: string;
  reason: string;
  correctionType?: string | null;
  isManagerApproved?: boolean;
  attachmentUrl?: string | null;
  employee?: { firstNameArabic?: string | null; lastNameArabic?: string | null; employeeId?: string | null } | null;
}
interface DeptStats {
  totalEmployees: number; activeEmployees: number; onLeave: number; excluded: number;
  pendingLeaves: number; presentToday: number; absentToday: number; lateToday: number;
}
interface DeptDetail {
  department: { id: string; nameArabic: string; branch?: { nameArabic?: string | null } | null; employees: DeptEmployee[] };
  corrections: PendingCorrection[];
  stats: DeptStats;
}

type DeptAction = 'APPROVE_LEAVE' | 'REJECT_LEAVE' | 'APPROVE_CORRECTION' | 'REJECT_CORRECTION';

const CORRECTION_TYPE_LABELS: Record<string, string> = { LATE: 'تأخير', EARLY_LEAVE: 'خروج مبكر', ABSENT: 'غياب أو نسيان بصمة', GENERAL: 'عام' };

const STAT_CARDS: { key: keyof DeptStats; label: string; icon: typeof Users; color: string }[] = [
  { key: 'activeEmployees', label: 'على رأس العمل', icon: Users, color: 'text-blue-600 bg-blue-50' },
  { key: 'presentToday', label: 'حاضرون اليوم', icon: UserCheck, color: 'text-emerald-600 bg-emerald-50' },
  { key: 'absentToday', label: 'غياب اليوم', icon: UserX, color: 'text-rose-600 bg-rose-50' },
  { key: 'lateToday', label: 'متأخرون اليوم', icon: Clock, color: 'text-amber-600 bg-amber-50' },
  { key: 'onLeave', label: 'في إجازة', icon: CalendarDays, color: 'text-violet-600 bg-violet-50' },
  { key: 'pendingLeaves', label: 'إجازات معلقة', icon: CalendarDays, color: 'text-orange-600 bg-orange-50' },
];

const CONFIRM_TEXT: Record<DeptAction, string> = {
  APPROVE_LEAVE: 'اعتماد الإجازة كمدير مباشر وإحالتها للموارد البشرية؟',
  REJECT_LEAVE: 'رفض طلب الإجازة؟',
  APPROVE_CORRECTION: 'اعتماد طلب تصحيح البصمة كمدير مباشر؟',
  REJECT_CORRECTION: 'رفض طلب تصحيح البصمة؟',
};

function DeptOverview() {
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<DeptDetail | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadDepartments = useCallback(async () => {
    setIsLoadingList(true);
    setListError(null);
    try {
      const res = await fetch('/api/dept-manager', { cache: 'no-store' });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        setListError(await readApiError(res, 'تعذر تحميل الأقسام'));
        return;
      }
      const data = (await res.json()) as { departments?: DeptOption[] };
      const list = Array.isArray(data.departments) ? data.departments : [];
      setDepartments(list);
      setSelectedId((cur) => cur || list[0]?.id || '');
    } catch {
      setListError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, opts: { silent?: boolean } = {}) => {
    if (!id) {
      setDetail(null);
      return;
    }
    if (!opts.silent) {
      setIsLoadingDetail(true);
      setDetailError(null);
    }
    try {
      const res = await fetch(`/api/dept-manager?departmentId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل بيانات القسم');
        if (opts.silent) toast.error(msg);
        else setDetailError(msg);
        return;
      }
      setDetail((await res.json()) as DeptDetail);
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setDetailError('تعذر الاتصال بالخادم');
    } finally {
      if (!opts.silent) setIsLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  useEffect(() => {
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const runAction = async (action: DeptAction, id: string) => {
    if (busyId) return;
    const isReject = action === 'REJECT_LEAVE' || action === 'REJECT_CORRECTION';
    let reason: string | undefined;
    if (isReject) {
      // The reason is mandatory (the server answers 400 without it) and the employee sees it in the portal.
      const input = await promptDialog(`${CONFIRM_TEXT[action]}\nاكتب سبب الرفض، وسيظهر للموظف في بوابته.`, {
        title: 'سبب الرفض',
        placeholder: 'سبب الرفض (مطلوب)',
        confirmText: 'رفض الطلب',
        danger: true,
      });
      if (input === null) return;
      if (!input.trim()) {
        toast.error('لم يُرفض الطلب: سبب الرفض مطلوب');
        return;
      }
      reason = input.trim();
    } else if (!(await confirmDialog(CONFIRM_TEXT[action]))) {
      return;
    }
    setBusyId(id);
    try {
      const target = action.endsWith('_LEAVE') ? { leaveId: id } : { correctionId: id };
      const body = { action, ...target, ...(reason ? { reason } : {}) };
      const res = await fetch('/api/dept-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تنفيذ الإجراء'));
        return;
      }
      const data = (await res.json()) as { message?: string };
      toast.success(data.message || 'تم تنفيذ الإجراء');
      await loadDetail(selectedId, { silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoadingList) {
    return <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-8 text-slate-400 font-bold flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> جاري تحميل الأقسام...</div>;
  }
  if (listError) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-8">
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3">
          <AlertCircle className="text-rose-500 shrink-0" size={20} />
          <p className="font-bold text-rose-800 text-[13px] flex-1">تعذر تحميل لوحة القسم: {listError}</p>
          <button type="button" onClick={() => void loadDepartments()} className="flex items-center gap-1 bg-white border border-rose-200 text-rose-700 px-3 py-2 rounded-xl font-bold text-[12px] hover:bg-rose-100">
            <RefreshCw size={14} /> إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }
  if (departments.length === 0) return null;

  const pendingLeaves = (detail?.department.employees || []).flatMap((emp) =>
    (emp.leaves || []).filter((l) => !l.isManagerApproved).map((l) => ({ leave: l, emp })),
  );
  // General requests ("[طلب: ...]") are HR-only; the API already leaves them out.
  const pendingCorrections = (detail?.corrections || []).filter((c) => !c.isManagerApproved && !c.reason.trimStart().startsWith('[طلب:'));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-8 md:pt-12">
      <div className="bg-white border border-slate-200 rounded-[2rem] p-6 md:p-8 shadow-sm space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h2 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <Building2 size={22} className="text-blue-600" /> لوحة القسم
          </h2>
          <select
            aria-label="اختيار القسم"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[13px] md:min-w-[280px]"
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.nameArabic}{d.branch?.nameArabic ? ` — ${d.branch.nameArabic}` : ''} ({d._count?.employees ?? 0})</option>
            ))}
          </select>
        </div>

        {isLoadingDetail ? (
          <div className="py-8 text-center text-slate-400 font-bold animate-pulse">جاري تحميل بيانات القسم...</div>
        ) : detailError ? (
          <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3">
            <AlertCircle className="text-rose-500 shrink-0" size={20} />
            <p className="font-bold text-rose-800 text-[13px] flex-1">{detailError}</p>
            <button type="button" onClick={() => void loadDetail(selectedId)} className="flex items-center gap-1 bg-white border border-rose-200 text-rose-700 px-3 py-2 rounded-xl font-bold text-[12px] hover:bg-rose-100">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        ) : detail ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {STAT_CARDS.map((s) => (
                <div key={s.key} className="bg-slate-50 rounded-2xl p-4 border border-slate-100 flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.color}`}><s.icon size={18} /></div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400">{s.label}</p>
                    <p className="text-xl font-black text-slate-800">{detail.stats[s.key]}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Pending leaves */}
              <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                <h3 className="font-black text-[14px] text-slate-700 mb-3 flex items-center gap-2"><CalendarDays size={16} className="text-orange-500" /> إجازات بانتظار موافقتك ({pendingLeaves.length})</h3>
                {pendingLeaves.length === 0 ? (
                  <p className="text-[12px] font-bold text-slate-400 py-4 text-center">لا توجد طلبات إجازة بانتظار موافقتك.</p>
                ) : (
                  <ul className="space-y-2">
                    {pendingLeaves.map(({ leave, emp }) => (
                      <li key={leave.id} className={`bg-white rounded-xl p-3 border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${busyId === leave.id ? 'opacity-60' : ''}`}>
                        <div className="min-w-0">
                          <p className="font-black text-[13px] text-slate-800">{emp.firstNameArabic} {emp.lastNameArabic}</p>
                          <p className="text-[11px] font-bold text-slate-500">
                            {leaveTypeLabel(leave.leaveType)} • من {formatDateShort(leave.startDate)} إلى {formatDateShort(leave.endDate)} • {leave.totalDays} يوم
                          </p>
                        </div>
                        <DecisionButtons
                          disabled={busyId !== null}
                          onApprove={() => void runAction('APPROVE_LEAVE', leave.id)}
                          onReject={() => void runAction('REJECT_LEAVE', leave.id)}
                          approveLabel="اعتماد الإجازة"
                          rejectLabel="رفض الإجازة"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Pending corrections */}
              <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                <h3 className="font-black text-[14px] text-slate-700 mb-3 flex items-center gap-2"><Fingerprint size={16} className="text-amber-500" /> تصحيحات بصمة بانتظار موافقتك ({pendingCorrections.length})</h3>
                {pendingCorrections.length === 0 ? (
                  <p className="text-[12px] font-bold text-slate-400 py-4 text-center">لا توجد طلبات تصحيح بانتظار موافقتك.</p>
                ) : (
                  <ul className="space-y-2">
                    {pendingCorrections.map((c) => (
                      <li key={c.id} className={`bg-white rounded-xl p-3 border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${busyId === c.id ? 'opacity-60' : ''}`}>
                        <div className="min-w-0">
                          <p className="font-black text-[13px] text-slate-800">
                            {c.employee?.firstNameArabic} {c.employee?.lastNameArabic}{' '}
                            <span className="text-[11px] text-slate-500">• {formatDateShort(c.date)}{c.correctionType && CORRECTION_TYPE_LABELS[c.correctionType] ? ` • ${CORRECTION_TYPE_LABELS[c.correctionType]}` : ''}</span>
                          </p>
                          <p className="text-[11px] font-bold text-slate-500 truncate" title={c.reason}>{c.reason}</p>
                          {c.attachmentUrl && <a href={c.attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-blue-600 hover:underline">عرض المرفق</a>}
                        </div>
                        <DecisionButtons
                          disabled={busyId !== null}
                          onApprove={() => void runAction('APPROVE_CORRECTION', c.id)}
                          onReject={() => void runAction('REJECT_CORRECTION', c.id)}
                          approveLabel="اعتماد التصحيح"
                          rejectLabel="رفض التصحيح"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Labelled approve / reject buttons (44px touch targets, spaced apart so a mis-tap is unlikely). */
function DecisionButtons({ disabled, onApprove, onReject, approveLabel, rejectLabel }: {
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  approveLabel: string;
  rejectLabel: string;
}) {
  return (
    <div className="flex gap-3 shrink-0">
      <button type="button" disabled={disabled} onClick={onApprove} aria-label={approveLabel}
        className="min-h-[44px] px-4 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 font-black text-[13px] flex items-center justify-center gap-1.5 transition disabled:opacity-50 flex-1 sm:flex-none">
        <CheckCircle2 size={16} aria-hidden="true" /> اعتماد
      </button>
      <button type="button" disabled={disabled} onClick={onReject} aria-label={rejectLabel}
        className="min-h-[44px] px-4 rounded-xl bg-white border-2 border-rose-200 text-rose-700 hover:bg-rose-50 font-black text-[13px] flex items-center justify-center gap-1.5 transition disabled:opacity-50 flex-1 sm:flex-none">
        <XCircle size={16} aria-hidden="true" /> رفض
      </button>
    </div>
  );
}

export default function DeptManagerPage() {
  return (
    <DashboardLayout>
      <DeptOverview />
      <ManagerWorkspace title="شاشة مدير الإدارة / القسم" showTransfersLink />
    </DashboardLayout>
  );
}
