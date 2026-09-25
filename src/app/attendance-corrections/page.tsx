"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { Clock, CheckCircle2, XCircle, SearchX, Upload, Plus, AlertCircle, RefreshCw, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { ATTENDANCE_CORRECTION_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';

interface Correction {
  id: string;
  employeeId?: string;
  date: string;
  reason: string;
  status: string;
  correctionType?: string | null;
  managerComment?: string | null;
  hrComment?: string | null;
  attachmentUrl?: string | null;
  isManagerApproved?: boolean;
  isHrApproved?: boolean;
  employee?: { firstNameArabic?: string | null; lastNameArabic?: string | null; employeeId?: string | null } | null;
}

type CorrectionAction = 'APPROVE_MANAGER' | 'APPROVE_HR' | 'REJECT';
type Filter = 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED';

interface StatusDisplay { label: string; color: string; icon: LucideIcon }

const statusMap: Record<string, StatusDisplay> = {
  [ATTENDANCE_CORRECTION_STATUS.PENDING]: { label: 'تحت الإجراء', color: 'bg-amber-50 text-amber-600 border-amber-200', icon: Clock },
  [ATTENDANCE_CORRECTION_STATUS.APPROVED]: { label: 'مُعتمد ومعدل', color: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: CheckCircle2 },
  [ATTENDANCE_CORRECTION_STATUS.REJECTED]: { label: 'مرفوض', color: 'bg-red-50 text-red-600 border-red-200', icon: XCircle },
};

const CORRECTION_TYPE_LABELS: Record<string, string> = {
  LATE: 'تأخير',
  EARLY_LEAVE: 'خروج مبكر',
  ABSENT: 'غياب / نسيان بصمة',
  GENERAL: 'عام',
};

/** General requests (letters, data update) are encoded as "[طلب: ...]" and go straight to HR (src/lib/hr-workflows.ts isHrDirectRequest). */
const isHrDirect = (c: Pick<Correction, 'reason'>) => (c.reason ?? '').trimStart().startsWith('[طلب:');

const getDisplayStatus = (item: Correction): StatusDisplay => {
  if (item.status === ATTENDANCE_CORRECTION_STATUS.PENDING) {
    if (isHrDirect(item)) return { label: 'بانتظار (الموارد البشرية)', color: 'bg-orange-50 text-orange-700 border-orange-200', icon: Clock };
    if (!item.isManagerApproved) return { label: 'بانتظار (المدير)', color: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock };
    if (!item.isHrApproved) return { label: 'بانتظار (الموارد البشرية)', color: 'bg-orange-50 text-orange-700 border-orange-200', icon: Clock };
    return { label: 'بانتظار الموافقة', color: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock };
  }
  return statusMap[item.status] || statusMap.PENDING;
};

const CONFIRM_MESSAGES: Record<CorrectionAction, string> = {
  APPROVE_MANAGER: 'هل أنت متأكد من موافقتك كمدير للإدارة على هذا التصحيح؟',
  APPROVE_HR: 'هل أنت متأكد من اعتمادك للتصحيح كموارد بشرية؟ سيتم إدراج الموظف في البصمة فوراً.',
  REJECT: 'هل أنت متأكد من رفضك للمبرر المرفق؟',
};

const APPROVE_GENERAL_MESSAGE = 'هل تريد اعتماد هذا الطلب؟';

const SUCCESS_FALLBACK: Record<CorrectionAction, string> = {
  APPROVE_MANAGER: 'تم التأييد وتحويل الطلب للموارد البشرية.',
  APPROVE_HR: 'تم اعتماد وتسجيل الحضور آلياً بنجاح.',
  REJECT: 'تم رفض الطلب.',
};

export default function AttendanceCorrectionsPage() {
  const { role, user } = useRole();
  // Mirrors src/lib/hr-workflows.ts (the server still enforces it): HR gives the final approval,
  // managers the first one; nobody acts on their own request.
  const isHr = roleIn(role, ROLE_GROUPS.HR);
  const isManager = roleIn(role, ROLE_GROUPS.MANAGERS);
  const isOwn = (c: Correction) => !!user?.employeeId && user.employeeId === c.employeeId && !roleIn(role, ROLE_GROUPS.OWNER);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchData = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch('/api/attendance-corrections', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر جلب الطلبات');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      const data: unknown = await res.json();
      setCorrections(Array.isArray(data) ? (data as Correction[]) : []);
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleAction = async (c: Correction, action: CorrectionAction) => {
    const id = c.id;
    if (busyId) return;
    const body: Record<string, unknown> = { action };
    if (action === 'REJECT') {
      const reason = await promptDialog(CONFIRM_MESSAGES.REJECT, {
        title: 'رفض الطلب',
        placeholder: 'سبب الرفض (مطلوب، يظهر للموظف)',
        confirmText: 'رفض الطلب',
        danger: true,
      });
      if (reason === null) return;
      if (reason.trim().length < 3) {
        toast.error('يجب كتابة سبب الرفض');
        return;
      }
      body.reason = reason.trim();
    } else if (!(await confirmDialog(action === 'APPROVE_HR' && isHrDirect(c) ? APPROVE_GENERAL_MESSAGE : CONFIRM_MESSAGES[action]))) {
      return;
    }

    setBusyId(id);
    try {
      const res = await fetch(`/api/attendance-corrections/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء معالجة الطلب'));
        return;
      }
      let message: string | null = null;
      try {
        const data = (await res.json()) as { message?: unknown };
        if (typeof data.message === 'string') message = data.message;
      } catch {
        // empty body
      }
      toast.success(message || SUCCESS_FALLBACK[action]);
      await fetchData({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  // Manager view: general requests (letters, data update incl. IBAN) belong to HR only, so a
  // non-HR manager sees fingerprint corrections plus their own requests.
  const visible = isHr ? corrections : corrections.filter((c) => !isHrDirect(c) || isOwn(c));
  const filteredData = visible.filter((c) => filter === 'ALL' || c.status === filter);

  return (
    <DashboardLayout>
      <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6 pb-20 min-h-screen">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-black text-slate-800 flex items-center gap-3">
              <Clock className="text-blue-600" size={32} /> التصحيحات والطلبات العامة
            </h1>
            <p className="text-slate-500 font-bold mt-2">تصحيح الحضور، الإجازات المرضية، تحديثات البيانات، الخطابات، والطلبات الإدارية.</p>
          </div>
          <Link href="/attendance-corrections/new" className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-3 rounded-xl flex items-center gap-2 transition-all font-bold shadow-lg shadow-blue-500/30 w-full md:w-auto justify-center">
            <Plus size={20} /> مسار تصحيح جديد
          </Link>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl flex flex-wrap gap-2 p-3 shadow-sm">
          <button type="button" onClick={() => setFilter('ALL')} className={`px-5 py-2.5 text-[13px] font-black rounded-xl transition-all ${filter === 'ALL' ? 'bg-slate-800 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}>الكل</button>
          <button type="button" onClick={() => setFilter('PENDING')} className={`px-5 py-2.5 text-[13px] font-bold rounded-xl transition-all ${filter === 'PENDING' ? 'bg-amber-500 text-white shadow-md shadow-amber-500/30' : 'text-slate-500 hover:bg-slate-100'}`}>معلقة للدراسة</button>
          <button type="button" onClick={() => setFilter('APPROVED')} className={`px-5 py-2.5 text-[13px] font-bold rounded-xl transition-all ${filter === 'APPROVED' ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/30' : 'text-slate-500 hover:bg-slate-100'}`}>مُكتملة</button>
          <button type="button" onClick={() => setFilter('REJECTED')} className={`px-5 py-2.5 text-[13px] font-bold rounded-xl transition-all ${filter === 'REJECTED' ? 'bg-red-500 text-white shadow-md shadow-red-500/30' : 'text-slate-500 hover:bg-slate-100'}`}>مرفوضة</button>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-40 gap-4">
            <div className="w-10 h-10 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin" />
            <p className="text-slate-500 font-bold">جاري المزامنة...</p>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-[2rem] border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4">
            <AlertCircle size={40} className="text-rose-400" />
            <p className="text-slate-600 font-bold">{loadError}</p>
            <button type="button" onClick={() => void fetchData()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-bold text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : filteredData.length === 0 ? (
          <div className="bg-white rounded-[2rem] border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center">
            <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6">
              <SearchX size={32} className="text-slate-400" />
            </div>
            <h2 className="text-xl font-black text-slate-800 mb-2">لا توجد سجلات</h2>
            <p className="text-slate-500 font-medium">لم يتم رفع أي طلبات تصحيح حسب الفلتر الحالي.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
            {filteredData.map((c) => {
              const st = getDisplayStatus(c);
              const StatusIcon = st.icon;
              const isBusy = busyId === c.id;

              return (
                <div key={c.id} className={`bg-white rounded-[1.5rem] border border-slate-100 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] hover:shadow-[0_10px_40px_rgba(0,0,0,0.06)] hover:border-blue-100 transition-all flex flex-col justify-between min-h-[300px] ${isBusy ? 'opacity-60' : ''}`}>
                  <div>
                    <div className="flex justify-between items-start mb-4">
                      <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black border ${st.color}`}>
                        <StatusIcon size={14} />{st.label}
                      </div>
                      {c.attachmentUrl && (
                        <a href={c.attachmentUrl} target="_blank" rel="noopener noreferrer" aria-label="عرض المرفق" className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white flex items-center justify-center transition" title="عرض المرفق">
                          <Upload size={14} />
                        </a>
                      )}
                    </div>

                    <h3 className="text-lg font-black text-slate-800">{c.employee?.firstNameArabic} {c.employee?.lastNameArabic}</h3>
                    <p className="text-[11px] font-bold text-slate-400 mb-5">#{c.employee?.employeeId}</p>

                    <div className="bg-slate-50 rounded-xl p-4 mb-4 border border-slate-100">
                      <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest mb-1">المراد تصحيحه ليوم</p>
                      <p className="text-[15px] font-black text-blue-700">{formatDateShort(c.date)}</p>
                    </div>

                    <div className="bg-slate-50/50 rounded-xl p-4 font-semibold text-[13px] text-slate-700 leading-relaxed max-h-32 overflow-y-auto whitespace-pre-line">
                      <span className="text-[11px] text-slate-400 block mb-1 font-bold">
                        المبرر الإداري أو الطبي{c.correctionType && CORRECTION_TYPE_LABELS[c.correctionType] ? ` (${CORRECTION_TYPE_LABELS[c.correctionType]})` : ''}:
                      </span>
                      {c.reason}
                    </div>
                    {(c.managerComment || c.hrComment) && (
                      <div className="mt-3 text-[12px] font-bold text-slate-500 space-y-1 whitespace-pre-line">
                        {c.managerComment && <p>ملاحظة المدير: {c.managerComment}</p>}
                        {c.hrComment && <p>ملاحظة الموارد البشرية: {c.hrComment}</p>}
                      </div>
                    )}
                  </div>

                  {c.status === ATTENDANCE_CORRECTION_STATUS.PENDING && isManager && !isOwn(c) && (
                    <div className="mt-6 border-t border-slate-100 pt-5 flex gap-2">
                      {!isHr && !c.isManagerApproved && !isHrDirect(c) && (
                        <button type="button" disabled={busyId !== null} onClick={() => void handleAction(c, 'APPROVE_MANAGER')} className="text-[11px] font-black bg-amber-500 hover:bg-amber-600 text-white py-3 flex-1 rounded-xl transition disabled:opacity-50">تأييد المدير</button>
                      )}
                      {isHr && !c.isHrApproved && (
                        <button type="button" disabled={busyId !== null} onClick={() => void handleAction(c, 'APPROVE_HR')} className="text-[11px] font-black bg-emerald-500 hover:bg-emerald-600 text-white py-3 flex-1 rounded-xl transition disabled:opacity-50">اعتماد الموارد</button>
                      )}
                      <button type="button" disabled={busyId !== null} aria-label="رفض الطلب" title="رفض الطلب" onClick={() => void handleAction(c, 'REJECT')} className="w-12 h-[38px] mt-0.5 rounded-xl border-2 border-slate-100 bg-white text-slate-400 hover:border-red-500 hover:text-red-500 flex items-center justify-center transition disabled:opacity-50">
                        <XCircle size={18} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
