"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Plus, Search, Clock, CheckCircle2, XCircle, Plane, MoreVertical, UserMinus, CalendarPlus, X, LogIn, UserCheck, Pencil, AlertCircle, RefreshCw, Ban, type LucideIcon } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { useRole } from '@/context/RoleContext';
import { daysBetween, daysUntil, formatDate, formatDateShort, inclusiveDays, toDateInputValue, today, todayKey } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { LEAVE_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { BEREAVEMENT_RELATION_LABELS, LEAVE_TYPES, LEAVE_TYPE_LABELS, parseStatutoryNoteMarkers, stripStatutoryNoteMarkers, type LeaveTypeCode } from '@/lib/leave';

interface LeaveEmployee {
  id?: string;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  employeeId?: string | null;
  isTerminated?: boolean | null;
  directManagerId?: string | null;
}

interface LeaveRow {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  status: string;
  notes?: string | null;
  isManagerApproved?: boolean;
  isHrApproved?: boolean;
  unpaidDays?: number | null;
  totalDeduction?: number | null;
  isOutsideKSA?: boolean;
  isReturned?: boolean;
  actualReturnDate?: string | null;
  employee?: LeaveEmployee | null;
}

interface EntitlementEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  joinDate?: string | null;
  leaveAccrualStartDate?: string | null;
  isTerminated?: boolean | null;
}

type LeaveAction = 'RETURN' | 'ABSCOND' | 'CONFIRM_RETURN' | 'APPROVE_MANAGER' | 'APPROVE_HR' | 'REJECT' | 'REJECT_RETURN' | 'CANCEL';

interface StatusDisplay { label: string; color: string; icon: LucideIcon }

const statusMap: Record<string, StatusDisplay> = {
  [LEAVE_STATUS.PENDING]: { label: 'بانتظار الموافقة', color: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock },
  [LEAVE_STATUS.APPROVED]: { label: 'مُعتمدة', color: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
  [LEAVE_STATUS.REJECTED]: { label: 'مرفوضة', color: 'bg-red-50 text-red-700 border-red-200', icon: XCircle },
  [LEAVE_STATUS.CANCELLED]: { label: 'ملغاة', color: 'bg-slate-100 text-slate-600 border-slate-200', icon: Ban },
  [LEAVE_STATUS.COMPLETED]: { label: 'مكتملة (باشر العمل)', color: 'bg-teal-50 text-teal-700 border-teal-200', icon: UserCheck },
};

const getStatusDisplay = (lv: LeaveRow): StatusDisplay => {
  if (lv.status === LEAVE_STATUS.PENDING) {
    if (!lv.isManagerApproved) return { label: 'بانتظار (المدير)', color: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock };
    if (!lv.isHrApproved) return { label: 'بانتظار (موارد بشرية)', color: 'bg-orange-50 text-orange-700 border-orange-200', icon: Clock };
    return statusMap[LEAVE_STATUS.PENDING];
  }
  return statusMap[lv.status] || statusMap[LEAVE_STATUS.PENDING];
};

const TYPE_COLORS: Record<LeaveTypeCode, string> = {
  ANNUAL: 'bg-blue-50 text-blue-700 border-blue-200',
  DEDUCTED: 'bg-teal-50 text-teal-700 border-teal-200',
  SICK: 'bg-violet-50 text-violet-700 border-violet-200',
  EMERGENCY: 'bg-orange-50 text-orange-700 border-orange-200',
  UNPAID: 'bg-slate-100 text-slate-600 border-slate-200',
  MATERNITY: 'bg-pink-50 text-pink-700 border-pink-200',
  PATERNITY: 'bg-sky-50 text-sky-700 border-sky-200',
  BEREAVEMENT: 'bg-stone-100 text-stone-700 border-stone-300',
  MARRIAGE: 'bg-rose-50 text-rose-700 border-rose-200',
  HAJJ: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

/** Label + badge colour of every leave type (labels from the single map in src/lib/leave.ts). */
const typeMap: Record<string, { label: string; color: string }> = Object.fromEntries(
  LEAVE_TYPES.map((t) => [t, { label: LEAVE_TYPE_LABELS[t], color: TYPE_COLORS[t] }]),
);

const CONFIRM_MESSAGES: Record<LeaveAction, string> = {
  RETURN: 'هل أنت متأكد من إثبات عودة الموظف لرأس العمل؟ سيتم تحديث تاريخ احتساب الإجازات وراتبه.',
  ABSCOND: 'هل أنت متأكد من تغيير حالة الموظف لـ (خرج ولم يعد)؟ سيتم أرشفته فوراً.',
  CONFIRM_RETURN: 'هل أنت متأكد من تأكيد مباشرة العمل وإعادة الموظف لـ (على رأس العمل)؟',
  APPROVE_MANAGER: 'هل أنت متأكد من موافقتك كمدير مباشر على هذا الطلب؟',
  APPROVE_HR: 'هل أنت متأكد من اعتماد الموارد البشرية لطلب الإجازة نهائياً؟',
  REJECT: 'هل أنت متأكد من رفض طلب الإجازة بالكامل؟',
  REJECT_RETURN: 'هل أنت متأكد من رفض إشعار المباشرة؟ سيبقى الموظف في إجازته حتى يتم تسجيل عودة صحيحة.',
  CANCEL: 'هل أنت متأكد من إلغاء هذه الإجازة؟ سيتم إعادة الموظف لرأس العمل وتحديث رصيده.',
};

const DANGER_ACTIONS: readonly LeaveAction[] = ['ABSCOND', 'REJECT', 'REJECT_RETURN', 'CANCEL'];

const SUCCESS_FALLBACK: Record<LeaveAction, string> = {
  RETURN: 'تم إثبات العودة بنجاح.',
  ABSCOND: 'تم تحديث حالة الموظف.',
  CONFIRM_RETURN: 'تم تأكيد العودة للموظف وتغيير حالته إلى على رأس العمل بنجاح.',
  APPROVE_MANAGER: 'تمت موافقة المدير بنجاح. الطلب الآن بانتظار الموارد البشرية.',
  APPROVE_HR: 'تم اعتماد الإجازة نهائياً.',
  REJECT: 'تم رفض الإجازة.',
  REJECT_RETURN: 'تم رفض إشعار المباشرة.',
  CANCEL: 'تم إلغاء الإجازة بنجاح وإعادة الموظف لرأس العمل.',
};

const EMPTY_EXTEND = { isOpen: false, leaveId: '', newEndDate: '', file: '', reason: '', isSubmitting: false };
const EMPTY_EDIT = { isOpen: false, leaveId: '', startDate: '', endDate: '', unpaidDays: 0, isSubmitting: false };
const EMPTY_RETURN = { isOpen: false, leaveId: '', returnDate: '', isSubmitting: false };

function fullName(e: { firstNameArabic?: string | null; lastNameArabic?: string | null } | null | undefined): string {
  return `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim();
}

function redirectToLogin() {
  window.location.assign('/login');
}

async function readMessage(res: Response): Promise<string | null> {
  try {
    const data: unknown = await res.clone().json();
    if (data && typeof data === 'object' && 'message' in data && typeof (data as { message: unknown }).message === 'string') {
      return (data as { message: string }).message;
    }
  } catch {
    // no JSON body
  }
  return null;
}

export default function LeavesPage() {
  const { role, user } = useRole();
  // Mirrors the server rules in src/lib/hr-workflows.ts (the server still enforces them).
  const isHr = roleIn(role, ROLE_GROUPS.HR);
  const isManager = roleIn(role, ROLE_GROUPS.MANAGERS);
  const isOwner = roleIn(role, ROLE_GROUPS.OWNER);
  const isOwnLeave = (lv: LeaveRow) => !!user?.employeeId && user.employeeId === lv.employeeId && !isOwner;
  const canManagerApprove = (lv: LeaveRow) => isManager && !isOwnLeave(lv) && lv.status === LEAVE_STATUS.PENDING && !lv.isManagerApproved;
  const canHrApprove = (lv: LeaveRow) =>
    isHr && !isOwnLeave(lv) && lv.status === LEAVE_STATUS.PENDING && !lv.isHrApproved && (!!lv.isManagerApproved || !lv.employee?.directManagerId || isOwner);
  const canReject = (lv: LeaveRow) => isManager && !isOwnLeave(lv) && lv.status === LEAVE_STATUS.PENDING;
  const canCancelPending = (lv: LeaveRow) => lv.status === LEAVE_STATUS.PENDING && (isHr || (!!user?.employeeId && user.employeeId === lv.employeeId));
  const [leaves, setLeaves] = useState<LeaveRow[]>([]);
  const [employees, setEmployees] = useState<EntitlementEmployee[]>([]);
  const [employeesLoaded, setEmployeesLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(false);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'entitlement' | 'active' | 'returns'>('list');
  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterType, setFilterType] = useState('ALL');
  const [busyLeaveId, setBusyLeaveId] = useState<string | null>(null);

  // Modals state
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);
  const [extendModal, setExtendModal] = useState(EMPTY_EXTEND);
  const [editModal, setEditModal] = useState(EMPTY_EDIT);
  const [directReturnModal, setDirectReturnModal] = useState(EMPTY_RETURN);
  const [detailsModal, setDetailsModal] = useState<LeaveRow | null>(null);

  const fetchLeaves = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch('/api/leaves', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر جلب الإجازات');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      const data: unknown = await res.json();
      setLeaves(Array.isArray(data) ? (data as LeaveRow[]) : []);
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, []);

  const fetchEmployees = useCallback(async () => {
    setIsLoadingEmployees(true);
    setEmployeesError(null);
    try {
      const res = await fetch('/api/employees?fields=basic', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setEmployeesError(await readApiError(res, 'تعذر جلب الموظفين'));
        return;
      }
      const data: unknown = await res.json();
      setEmployees(Array.isArray(data) ? (data as EntitlementEmployee[]) : []);
      setEmployeesLoaded(true);
    } catch {
      setEmployeesError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoadingEmployees(false);
    }
  }, []);

  useEffect(() => {
    void fetchLeaves();
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('.action-menu-container')) return;
      setActionMenuOpen(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [fetchLeaves]);

  useEffect(() => {
    if (viewMode === 'entitlement' && !employeesLoaded && !isLoadingEmployees && !employeesError) {
      void fetchEmployees();
    }
  }, [viewMode, employeesLoaded, isLoadingEmployees, employeesError, fetchEmployees]);

  const postAction = async (id: string, body: Record<string, unknown>): Promise<{ ok: boolean; message: string | null }> => {
    const res = await fetch(`/api/leaves/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      redirectToLogin();
      return { ok: false, message: null };
    }
    if (!res.ok) {
      toast.error(await readApiError(res, 'حدث خطأ أثناء تنفيذ الإجراء'));
      return { ok: false, message: null };
    }
    return { ok: true, message: await readMessage(res) };
  };

  const handleAction = async (id: string, action: LeaveAction) => {
    setActionMenuOpen(null);
    if (busyLeaveId) return;
    const body: Record<string, unknown> = { action };
    if (action === 'REJECT') {
      const reason = await promptDialog(CONFIRM_MESSAGES.REJECT, {
        title: 'رفض طلب الإجازة',
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
    } else if (action === 'ABSCOND') {
      const reason = await promptDialog('سجّل سبب اعتبار الموظف منقطعاً عن العمل (خرج ولم يعد) وما تم من تواصل معه.', {
        title: 'خرج ولم يعد',
        placeholder: 'السبب والتفاصيل (مطلوب)',
        confirmText: 'متابعة',
        danger: true,
      });
      if (reason === null) return;
      if (reason.trim().length < 3) {
        toast.error('يجب كتابة سبب واضح قبل المتابعة');
        return;
      }
      const acknowledged = await confirmDialog(
        'هل وُجّه للموظف إنذار كتابي مسجّل بالانقطاع قبل هذا الإجراء؟ لا يُنفَّذ الإجراء دون إنذار كتابي موثّق.',
        { title: 'تأكيد الإنذار الكتابي', confirmText: 'نعم، وُجّه إنذار كتابي', danger: true },
      );
      if (!acknowledged) return;
      body.reason = reason.trim();
      body.acknowledgeWarningIssued = true;
    } else if (!(await confirmDialog(CONFIRM_MESSAGES[action], { danger: DANGER_ACTIONS.includes(action) }))) {
      return;
    }

    setBusyLeaveId(id);
    try {
      const result = await postAction(id, body);
      if (result.ok) {
        toast.success(result.message || SUCCESS_FALLBACK[action]);
        await fetchLeaves({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyLeaveId(null);
    }
  };

  const handleExtend = async () => {
    if (extendModal.isSubmitting) return;
    if (!extendModal.newEndDate || !extendModal.file) {
      toast.warning('يرجى إدخال تاريخ الانتهاء الجديد وإرفاق المستند.');
      return;
    }
    setExtendModal((p) => ({ ...p, isSubmitting: true }));
    try {
      const result = await postAction(extendModal.leaveId, {
        action: 'EXTEND',
        newEndDate: extendModal.newEndDate,
        extensionFileUrl: extendModal.file,
        extensionReason: extendModal.reason,
      });
      if (result.ok) {
        toast.success(result.message || 'تم تمديد الإجازة بنجاح');
        setExtendModal(EMPTY_EXTEND);
        await fetchLeaves({ silent: true });
        return;
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
    setExtendModal((p) => ({ ...p, isSubmitting: false }));
  };

  const handleEdit = async () => {
    if (editModal.isSubmitting) return;
    if (!editModal.startDate || !editModal.endDate) {
      toast.warning('يرجى إدخال تاريخ البداية والنهاية');
      return;
    }
    if (editModal.endDate < editModal.startDate) {
      toast.warning('تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية');
      return;
    }
    setEditModal((p) => ({ ...p, isSubmitting: true }));
    try {
      const result = await postAction(editModal.leaveId, {
        action: 'EDIT',
        newStartDate: editModal.startDate,
        newEndDate: editModal.endDate,
        totalDays: inclusiveDays(editModal.startDate, editModal.endDate),
        unpaidDays: Math.max(0, Math.floor(Number(editModal.unpaidDays) || 0)),
      });
      if (result.ok) {
        toast.success(result.message || 'تم تعديل الإجازة بنجاح');
        setEditModal(EMPTY_EDIT);
        await fetchLeaves({ silent: true });
        return;
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
    setEditModal((p) => ({ ...p, isSubmitting: false }));
  };

  const handleDirectReturn = async () => {
    if (directReturnModal.isSubmitting) return;
    if (!directReturnModal.leaveId || !directReturnModal.returnDate) return;
    setDirectReturnModal((p) => ({ ...p, isSubmitting: true }));
    try {
      const result = await postAction(directReturnModal.leaveId, { action: 'RETURN', returnDate: directReturnModal.returnDate });
      if (result.ok) {
        toast.success('تم إثبات العودة بنجاح. يمكنك الآن تأكيد المباشرة للموظف.');
        setDirectReturnModal(EMPTY_RETURN);
        await fetchLeaves({ silent: true });
        return;
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
    setDirectReturnModal((p) => ({ ...p, isSubmitting: false }));
  };

  const filteredLeaves = useMemo(
    () =>
      leaves.filter((lv) => {
        const nameMatch = fullName(lv.employee).includes(searchText);
        if (viewMode === 'active') {
          return nameMatch && lv.status === LEAVE_STATUS.APPROVED && !lv.isReturned && !lv.employee?.isTerminated;
        }
        const statusMatch = filterStatus === 'ALL' || lv.status === filterStatus;
        const typeMatch = filterType === 'ALL' || lv.leaveType === filterType;
        return nameMatch && statusMatch && typeMatch;
      }),
    [leaves, searchText, viewMode, filterStatus, filterType],
  );

  const entitledEmployees = useMemo(() => {
    const oneYearAgo = new Date(today().getTime());
    oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
    return employees.filter((emp) => {
      if (!fullName(emp).includes(searchText) || emp.isTerminated) return false;
      const startKey = toDateInputValue(emp.leaveAccrualStartDate || emp.joinDate);
      if (!startKey) return false;
      return startKey <= toDateInputValue(oneYearAgo);
    });
  }, [employees, searchText]);

  const serviceYears = (d: string | null | undefined): string => {
    if (!d) return '—';
    const days = daysBetween(d, today());
    return Number.isNaN(days) ? '—' : (days / 365.25).toFixed(1);
  };

  const pendingReturns = leaves.filter((lv) => lv.status === LEAVE_STATUS.APPROVED && lv.actualReturnDate && !lv.isReturned);
  const returnCandidates = leaves.filter((lv) => lv.status === LEAVE_STATUS.APPROVED && !lv.isReturned && !lv.actualReturnDate && !isOwnLeave(lv));

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6 pb-32">

        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <CalendarDays className="text-teal-600" />
              إدارة الإجازات
            </h1>
            <p className="text-slate-500 text-sm mt-1">طلبات الإجازة، جدول الإجازات، وإدارة الإجازات القائمة</p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <div className="bg-white border border-slate-200 rounded-xl flex overflow-hidden shadow-sm">
              <button type="button" onClick={() => setViewMode('active')} className={`px-4 py-2 text-[12px] font-black transition ${viewMode === 'active' ? 'bg-amber-500 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>الإجازات القائمة</button>
              <button type="button" onClick={() => setViewMode('list')} className={`px-4 py-2 text-[12px] font-bold transition ${viewMode === 'list' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-50 border-r border-slate-100'}`}>طلبات الموظفين</button>
              <button type="button" onClick={() => setViewMode('returns')} className={`px-4 py-2 text-[12px] font-bold transition relative ${viewMode === 'returns' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-50 border-r border-slate-100'}`}>
                المباشرة بعد العودة من الإجازة
                {pendingReturns.length > 0 && <span className="absolute -top-1 -right-1 w-3 h-3 bg-rose-500 border-2 border-white rounded-full animate-pulse"></span>}
              </button>
              {isHr && <button type="button" onClick={() => setViewMode('entitlement')} className={`px-4 py-2 text-[12px] font-bold transition ${viewMode === 'entitlement' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-50 border-r border-slate-100'}`}>جدول استحقاق الإجازة السنوية</button>}
            </div>
            {isHr && <Link href="/leaves/new" className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-teal-500/30 font-medium">
              <Plus size={20} />
              طلب إجازة جديد
            </Link>}
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-wrap gap-4 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="ابحث باسم الموظف" placeholder="ابحث باسم الموظف..." className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-teal-100 text-sm font-semibold outline-none transition-all" />
          </div>
          {viewMode === 'list' && (
            <>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="تصفية حسب الحالة" className="bg-slate-50 border border-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-xl focus:outline-none focus:border-teal-400 text-[13px] appearance-none cursor-pointer min-w-[160px]">
                <option value="ALL">كل الحالات</option>
                <option value={LEAVE_STATUS.PENDING}>بانتظار الموافقة</option>
                <option value={LEAVE_STATUS.APPROVED}>مُعتمدة</option>
                <option value={LEAVE_STATUS.COMPLETED}>مكتملة (باشر العمل)</option>
                <option value={LEAVE_STATUS.REJECTED}>مرفوضة</option>
                <option value={LEAVE_STATUS.CANCELLED}>ملغاة</option>
              </select>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} aria-label="تصفية حسب النوع" className="bg-slate-50 border border-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-xl focus:outline-none focus:border-teal-400 text-[13px] appearance-none cursor-pointer min-w-[160px]">
                <option value="ALL">كل الأنواع</option>
                {LEAVE_TYPES.map((t) => <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>)}
              </select>
            </>
          )}
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-20 gap-4">
            <div className="w-8 h-8 rounded-full border-4 border-teal-100 border-t-teal-600 animate-spin" />
            <p className="text-slate-500 font-bold">جاري جلب الإجازات...</p>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4">
            <AlertCircle size={48} className="text-rose-300" />
            <p className="text-slate-600 font-bold">{loadError}</p>
            <button type="button" onClick={() => void fetchLeaves()} className="flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-xl font-bold text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : viewMode === 'returns' ? (
          <div className="space-y-6">
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 shadow-sm overflow-hidden mb-6">
              <h3 className="text-xl font-black text-amber-800 flex items-center gap-3">
                <span className="bg-amber-200 text-amber-900 p-2 rounded-xl"><Clock size={20} className="animate-pulse" /></span>
                طلبات المباشرة بعد العودة (بانتظار التأكيد)
              </h3>
              <p className="text-amber-700 font-bold text-[13px] mt-2 mb-4">
                قام المشرف المباشر بتسجيل عودة هؤلاء الموظفين من إجازاتهم، يلزم تأكيد الموارد البشرية لتنعكس حالتهم في النظام كـ (على رأس العمل).
              </p>
              {isManager && <button type="button" onClick={() => setDirectReturnModal({ ...EMPTY_RETURN, isOpen: true, returnDate: todayKey() })} className="bg-amber-600 hover:bg-amber-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-md shadow-amber-500/20 font-bold text-[13px] w-max">
                <LogIn size={18} />
                تسجيل عودة موظف يدوياً (مسؤول)
              </button>}
            </div>

            {pendingReturns.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center">
                <CheckCircle2 size={64} className="text-emerald-200 mb-6" />
                <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد طلبات مباشرة معلقة</h2>
                <p className="text-slate-500 font-medium">كل شيء مكتمل.</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {pendingReturns.filter((lv) => fullName(lv.employee).includes(searchText)).map((lv) => (
                  <div key={lv.id} className="bg-white rounded-[2rem] p-6 border border-amber-100 shadow-sm flex flex-col justify-between hover:shadow-md transition">
                    <div>
                      <div className="w-14 h-14 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center mb-4">
                        <UserCheck size={28} />
                      </div>
                      <h4 className="font-bold text-slate-800 text-lg">{fullName(lv.employee)}</h4>
                      <div className="bg-slate-50 px-3 py-2 rounded-lg mt-3">
                        <p className="text-[12px] font-bold text-slate-500">تاريخ العودة المسجل من المشرف:</p>
                        <p className="text-[14px] text-amber-600 font-extrabold mt-1">{formatDate(lv.actualReturnDate)}</p>
                      </div>
                    </div>
                    {isHr && <div className="mt-6 flex flex-col gap-2">
                      <button type="button" disabled={busyLeaveId === lv.id} onClick={() => void handleAction(lv.id, 'CONFIRM_RETURN')} className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-black text-[13px] px-4 py-3 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 disabled:opacity-50">
                        <CheckCircle2 size={16} />
                        {busyLeaveId === lv.id ? 'جاري التأكيد...' : 'تأكيد ومباشرة الموظف'}
                      </button>
                      <button type="button" disabled={busyLeaveId === lv.id} onClick={() => void handleAction(lv.id, 'REJECT_RETURN')} className="w-full bg-white border border-rose-200 hover:bg-rose-50 text-rose-600 font-bold text-[12px] px-4 py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
                        <XCircle size={14} />
                        رفض إشعار المباشرة
                      </button>
                    </div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : viewMode === 'entitlement' ? (
          /* ENTITLEMENT SCHEDULE VIEW */
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            {isLoadingEmployees ? (
              <div className="flex flex-col items-center justify-center p-20 gap-4">
                <div className="w-8 h-8 rounded-full border-4 border-teal-100 border-t-teal-600 animate-spin" />
                <p className="text-slate-500 font-bold">جاري حساب الاستحقاق...</p>
              </div>
            ) : employeesError ? (
              <div className="p-16 text-center flex flex-col items-center justify-center gap-4">
                <AlertCircle size={48} className="text-rose-300" />
                <p className="text-slate-600 font-bold">{employeesError}</p>
                <button type="button" onClick={() => void fetchEmployees()} className="flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-xl font-bold text-[13px] transition">
                  <RefreshCw size={16} /> إعادة المحاولة
                </button>
              </div>
            ) : entitledEmployees.length === 0 ? (
              <div className="bg-white rounded-2xl p-20 text-center flex flex-col items-center justify-center">
                <CalendarDays size={64} className="text-slate-200 mb-6" />
                <h2 className="text-xl font-bold text-slate-700 mb-2">لا يوجد مستحقين</h2>
                <p className="text-slate-500 font-medium">لا يوجد موظفين أكملوا سنة للوقت الحالي.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="px-4 py-3.5 text-[11px] font-black text-slate-500 uppercase tracking-wider">الموظف</th>
                      <th className="px-4 py-3.5 text-[11px] font-black text-slate-500 uppercase tracking-wider">الرقم الوظيفي</th>
                      <th className="px-4 py-3.5 text-[11px] font-black text-slate-500 uppercase tracking-wider">تاريخ المباشرة</th>
                      <th className="px-4 py-3.5 text-[11px] font-black text-slate-500 uppercase tracking-wider">مدة الخدمة (سنوات)</th>
                      <th className="px-4 py-3.5 text-[11px] font-black text-slate-500 uppercase tracking-wider">الإجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entitledEmployees.map((emp) => (
                      <tr key={emp.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition">
                        <td className="px-4 py-4 font-bold text-slate-800 text-[13px]">{fullName(emp)}</td>
                        <td className="px-4 py-4 text-[12px] font-bold text-slate-500">#{emp.employeeId}</td>
                        <td className="px-4 py-4 text-[12px] font-bold text-slate-600">{formatDateShort(emp.leaveAccrualStartDate || emp.joinDate)}</td>
                        <td className="px-4 py-4"><span className="text-[12px] font-black bg-teal-50 text-teal-700 px-3 py-1 rounded-lg border border-teal-100">{serviceYears(emp.leaveAccrualStartDate || emp.joinDate)} سنة</span></td>
                        <td className="px-4 py-4">
                          <Link href={`/leaves/new?employeeId=${emp.id}`} className="text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-600 hover:text-white transition px-4 py-2 rounded-xl">
                            إصدار طلب
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : filteredLeaves.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <CalendarDays size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد سجلات مطابقة</h2>
            <p className="text-slate-500 font-medium">{viewMode === 'active' ? 'لا يوجد موظفين في إجازة حالياً' : 'لم يتم العثور على طلبات إجازة'}</p>
          </div>
        ) : (
          /* LIST OR ACTIVE VIEW */
          <div className="space-y-4">
            {filteredLeaves.map((lv) => {
              const st = getStatusDisplay(lv);
              const tp = typeMap[lv.leaveType] || typeMap.ANNUAL;
              const StatusIcon = st.icon;
              const remainingDays = daysUntil(lv.endDate) ?? 0;
              const isBusy = busyLeaveId === lv.id;

              return (
                <div key={lv.id} className={`bg-white rounded-[1.5rem] shadow-sm border border-slate-100 p-6 hover:border-teal-200 transition relative ${actionMenuOpen === lv.id ? 'z-30' : ''} ${isBusy ? 'opacity-60' : ''}`}>
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className={`w-14 h-14 rounded-xl flex items-center justify-center shrink-0 shadow-inner ${viewMode === 'active' ? 'bg-amber-50 text-amber-500' : 'bg-teal-50 text-teal-600'}`}>
                        {lv.leaveType === 'EMERGENCY' || lv.isOutsideKSA ? <Plane size={28} /> : <CalendarDays size={28} />}
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-800 text-lg">
                          {fullName(lv.employee)}
                          <span className="text-[11px] font-bold text-slate-400 mr-2">#{lv.employee?.employeeId}</span>
                        </h3>
                        <div className="flex flex-wrap gap-2 mt-1.5">
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-lg border ${tp.color}`}>{tp.label}</span>
                          <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">
                            {formatDateShort(lv.startDate)} ← {formatDateShort(lv.endDate)}
                          </span>
                          <span className="text-[10px] font-black bg-teal-50 text-teal-700 px-2 py-0.5 rounded-lg border border-teal-100">{lv.totalDays} يوم</span>
                          {viewMode === 'active' && (
                            remainingDays > 0 ? (
                              <span className="text-[10px] font-black bg-rose-50 text-rose-600 px-2 py-0.5 rounded-lg border border-rose-100 animate-pulse">متبقي {remainingDays} يوم</span>
                            ) : remainingDays === 0 ? (
                              <span className="text-[10px] font-black bg-amber-100 text-amber-700 px-2 py-0.5 rounded-lg border border-amber-200">تنتهي اليوم</span>
                            ) : (
                              <span className="text-[10px] font-black bg-red-100 text-red-700 px-2 py-0.5 rounded-lg border border-red-200">الإجازة منتهية ({Math.abs(remainingDays)} أيام متأخرة)</span>
                            )
                          )}
                          {lv.isOutsideKSA && <span className="text-[10px] font-bold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-lg border border-indigo-100">خارج المملكة ✈️</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 md:gap-5">
                      {(lv.unpaidDays ?? 0) > 0 && (
                        <div className="text-center"><p className="text-[10px] font-bold text-red-400">أيام غير مدفوعة</p><p className="font-black text-red-600">{lv.unpaidDays} يوم</p></div>
                      )}
                      {(lv.totalDeduction ?? 0) > 0 && (
                        <div className="text-center"><p className="text-[10px] font-bold text-amber-400">الخصم</p><p className="font-black text-amber-600">{formatMoney(lv.totalDeduction)} ر.س</p></div>
                      )}

                      {viewMode !== 'active' && (
                        <div className="flex gap-2 items-center flex-wrap">
                          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-black border ${st.color}`}>
                            <StatusIcon size={14} />{st.label}
                          </div>

                          {/* موافقات وطلبات الإجازة */}
                          {viewMode === 'list' && (
                            <div className="flex gap-2 mr-2">
                              <button type="button" onClick={() => setDetailsModal(lv)} className="text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-xl transition shadow-sm border border-slate-200">
                                عرض التفاصيل
                              </button>

                              {canManagerApprove(lv) && (
                                <button type="button" disabled={isBusy} onClick={() => void handleAction(lv.id, 'APPROVE_MANAGER')} className="text-[11px] font-bold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-xl transition shadow-sm disabled:opacity-50">
                                  موافقة المدير
                                </button>
                              )}
                              {canHrApprove(lv) && (
                                <button type="button" disabled={isBusy} onClick={() => void handleAction(lv.id, 'APPROVE_HR')} className="text-[11px] font-bold bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-xl transition shadow-sm disabled:opacity-50">
                                  اعتماد الموارد البشرية
                                </button>
                              )}
                              {canReject(lv) && (
                                <button type="button" disabled={isBusy} aria-label="رفض الطلب" title="رفض الطلب" onClick={() => void handleAction(lv.id, 'REJECT')} className="text-[11px] font-bold bg-slate-100/50 text-red-500 hover:bg-red-50 hover:text-red-600 px-3 py-1.5 border border-transparent hover:border-red-200 rounded-xl transition disabled:opacity-50">
                                  <X size={14} />
                                </button>
                              )}
                              {canCancelPending(lv) && (
                                <button type="button" disabled={isBusy} onClick={() => void handleAction(lv.id, 'CANCEL')} className="text-[11px] font-bold bg-slate-100/50 text-orange-600 hover:bg-orange-50 px-3 py-1.5 border border-transparent hover:border-orange-200 rounded-xl transition disabled:opacity-50">
                                  إلغاء الطلب
                                </button>
                              )}
                            </div>
                          )}

                          {/* زر الانتقال لتصفية المستحقات بعد الاعتماد */}
                          {viewMode === 'list' && isHr && lv.status === LEAVE_STATUS.APPROVED && (
                            <Link href={`/settlements/new?employeeId=${lv.employeeId}`} className="text-[11px] font-black bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-600 hover:text-white hover:border-blue-600 px-4 py-1.5 rounded-xl transition flex items-center gap-1.5 mr-2">
                              💰 الانتقال لتصفية المستحقات
                            </Link>
                          )}
                        </div>
                      )}

                      {/* ACTIONS FOR ACTIVE MODE ONLY */}
                      {viewMode === 'active' && isManager && !isOwnLeave(lv) && (
                        <div className="relative z-20 action-menu-container">
                          <button
                            type="button"
                            disabled={isBusy}
                            aria-haspopup="menu"
                            aria-expanded={actionMenuOpen === lv.id}
                            onClick={(e) => { e.stopPropagation(); setActionMenuOpen(actionMenuOpen === lv.id ? null : lv.id); }}
                            className={`p-2.5 rounded-xl transition border text-amber-600 font-bold flex items-center gap-2 hover:bg-amber-100 disabled:opacity-50 ${actionMenuOpen === lv.id ? 'bg-amber-100 border-amber-300' : 'bg-amber-50 border-amber-200'}`}>
                            إجراءات الموظف المجاز
                            <MoreVertical size={16} />
                          </button>

                          {actionMenuOpen === lv.id && (
                            <div role="menu" className="absolute left-0 top-full mt-2 w-56 bg-white rounded-2xl shadow-[0_12px_40px_-10px_rgba(0,0,0,0.15)] ring-1 ring-slate-100 z-50 overflow-hidden py-2">
                              <div className="px-4 py-2 text-[10px] font-black text-slate-400 tracking-wider">حدد الإجراء</div>

                              {lv.actualReturnDate ? (
                                <div className="px-4 py-2.5 text-[12px] font-bold text-slate-400 flex items-center gap-2">
                                  <Clock size={16} /> تم إثبات العودة ({formatDateShort(lv.actualReturnDate)}) بانتظار تأكيد المباشرة
                                </div>
                              ) : (
                                <button type="button" role="menuitem" onClick={() => void handleAction(lv.id, 'RETURN')} className="w-full text-right px-4 py-2.5 text-[13px] font-bold hover:bg-emerald-50 transition-colors flex items-center gap-2 text-emerald-700">
                                  <LogIn size={16} /> إثبات عودة لرأس العمل
                                </button>
                              )}

                              {isHr && <>
                              <button type="button" role="menuitem" onClick={() => { setActionMenuOpen(null); setExtendModal({ ...EMPTY_EXTEND, isOpen: true, leaveId: lv.id }); }} className="w-full text-right px-4 py-2.5 text-[13px] font-bold hover:bg-indigo-50 transition-colors flex items-center gap-2 text-indigo-600">
                                <CalendarPlus size={16} /> تمديد الإجازة وإرفاق طلب
                              </button>

                              <button type="button" role="menuitem" onClick={() => { setActionMenuOpen(null); setEditModal({ isOpen: true, leaveId: lv.id, startDate: toDateInputValue(lv.startDate), endDate: toDateInputValue(lv.endDate), unpaidDays: lv.unpaidDays ?? 0, isSubmitting: false }); }} className="w-full text-right px-4 py-2.5 text-[13px] font-bold hover:bg-blue-50 transition-colors flex items-center gap-2 text-blue-600">
                                <Pencil size={16} /> تعديل تواريخ الإجازة
                              </button>

                              <div className="h-[1px] bg-slate-100 my-1"></div>

                              <button type="button" role="menuitem" onClick={() => void handleAction(lv.id, 'ABSCOND')} className="w-full text-right px-4 py-2.5 text-[13px] font-black hover:bg-red-50 transition-colors flex items-center gap-2 text-red-600">
                                <UserMinus size={16} /> خرج ولم يعد (تحويل للأرشيف)
                              </button>

                              <div className="h-[1px] bg-slate-100 my-1"></div>

                              <button type="button" role="menuitem" onClick={() => void handleAction(lv.id, 'CANCEL')} className="w-full text-right px-4 py-2.5 text-[13px] font-black hover:bg-orange-50 transition-colors flex items-center gap-2 text-orange-600">
                                <X size={16} /> إلغاء الإجازة
                              </button>
                              </>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* EXTEND LEAVE MODAL */}
      {extendModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-label="تمديد الإجازة" className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden relative">
            <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-lg font-black text-slate-800">تمديد الإجازة وتحديث التأشيرة</h2>
              <button type="button" aria-label="إغلاق" onClick={() => setExtendModal(EMPTY_EXTEND)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-[12px] font-bold text-slate-500 mb-1">تاريخ الانتهاء الجديد</label>
                <input type="date" value={extendModal.newEndDate} onChange={(e) => setExtendModal({ ...extendModal, newEndDate: e.target.value })} className="w-full px-4 py-2.5 border-2 border-slate-200 rounded-xl focus:border-indigo-500 outline-none text-slate-800 font-bold" />
              </div>
              <div>
                <label className="block text-[12px] font-bold text-slate-500 mb-1">سبب التمديد (اختياري)</label>
                <textarea rows={2} value={extendModal.reason} onChange={(e) => setExtendModal({ ...extendModal, reason: e.target.value })} className="w-full px-4 py-2.5 border-2 border-slate-200 rounded-xl focus:border-indigo-500 outline-none text-slate-800 font-bold resize-none" placeholder="اكتب مبررات التمديد..."></textarea>
              </div>
              <div>
                <FileUploadField name="extendFile" value={extendModal.file} onChange={(e) => setExtendModal((p) => ({ ...p, file: e.target.value }))} label="مرفق التمديد (التأشيرة أو طلب النظام - مطلوب)" />
              </div>

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => setExtendModal(EMPTY_EXTEND)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition" disabled={extendModal.isSubmitting}>إلغاء</button>
                <button type="button" onClick={() => void handleExtend()} disabled={!extendModal.file || !extendModal.newEndDate || extendModal.isSubmitting} className="flex-[2] py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl transition disabled:opacity-50 flex justify-center items-center">
                  {extendModal.isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'حفظ ونشر التمديد'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EDIT LEAVE MODAL */}
      {editModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-label="تعديل تواريخ الإجازة" className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden relative">
            <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-lg font-black text-slate-800">تعديل تواريخ الإجازة</h2>
              <button type="button" aria-label="إغلاق" onClick={() => setEditModal(EMPTY_EDIT)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-bold text-slate-500 mb-1">تاريخ البداية</label>
                  <input type="date" value={editModal.startDate} onChange={(e) => setEditModal({ ...editModal, startDate: e.target.value })} className="w-full px-4 py-2.5 border-2 border-slate-200 rounded-xl focus:border-blue-500 outline-none text-slate-800 font-bold" />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-slate-500 mb-1">تاريخ الانتهاء</label>
                  <input type="date" min={editModal.startDate || undefined} value={editModal.endDate} onChange={(e) => setEditModal({ ...editModal, endDate: e.target.value })} className="w-full px-4 py-2.5 border-2 border-slate-200 rounded-xl focus:border-blue-500 outline-none text-slate-800 font-bold" />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-slate-500 mb-1">إجمالي الأيام (محسوب تلقائياً)</label>
                  <input type="number" readOnly value={editModal.startDate && editModal.endDate && editModal.endDate >= editModal.startDate ? inclusiveDays(editModal.startDate, editModal.endDate) : 0} className="w-full px-4 py-2.5 border-2 border-slate-100 bg-slate-50 rounded-xl outline-none text-slate-500 font-bold" />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-slate-500 mb-1">أيام غير مدفوعة</label>
                  <input type="number" min={0} value={editModal.unpaidDays} onChange={(e) => setEditModal({ ...editModal, unpaidDays: Number(e.target.value) })} className="w-full px-4 py-2.5 border-2 border-slate-200 rounded-xl focus:border-blue-500 outline-none text-slate-800 font-bold" />
                </div>
              </div>
              <p className="text-[11px] font-bold text-slate-400">يعيد النظام احتساب الأيام المدفوعة وغير المدفوعة من الرصيد؛ لا يمكن أن تقل الأيام غير المدفوعة عن الأيام غير المغطاة بالرصيد.</p>

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => setEditModal(EMPTY_EDIT)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition" disabled={editModal.isSubmitting}>إلغاء</button>
                <button type="button" onClick={() => void handleEdit()} disabled={!editModal.startDate || !editModal.endDate || editModal.isSubmitting} className="flex-[2] py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl transition disabled:opacity-50 flex justify-center items-center">
                  {editModal.isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'حفظ التعديلات'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DETAILS MODAL */}
      {detailsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-label="تفاصيل الطلب" className="bg-white rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden relative">
            <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-lg font-black text-slate-800 flex items-center gap-2">
                <CalendarDays size={20} className="text-teal-600" />
                تفاصيل الطلب
              </h2>
              <button type="button" aria-label="إغلاق" onClick={() => setDetailsModal(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="bg-slate-50 p-4 rounded-2xl flex flex-col gap-2">
                <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                  <span className="text-[12px] font-bold text-slate-500">الموظف</span>
                  <span className="font-extrabold text-slate-800 text-[13px]">{fullName(detailsModal.employee)}</span>
                </div>
                <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                  <span className="text-[12px] font-bold text-slate-500">من تاريخ</span>
                  <span className="font-extrabold pr-2 text-slate-800 text-[13px]">{formatDate(detailsModal.startDate)}</span>
                </div>
                <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                  <span className="text-[12px] font-bold text-slate-500">إلى تاريخ</span>
                  <span className="font-extrabold pr-2 text-slate-800 text-[13px]">{formatDate(detailsModal.endDate)}</span>
                </div>
                <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                  <span className="text-[12px] font-bold text-slate-500">إجمالي الأيام</span>
                  <span className="font-extrabold text-teal-600 text-[13px]">{detailsModal.totalDays} يوم</span>
                </div>
                {(detailsModal.unpaidDays ?? 0) > 0 && (
                  <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                    <span className="text-[12px] font-bold text-slate-500">التجاوز (بدون أجر)</span>
                    <span className="font-extrabold text-red-500 text-[13px]">{detailsModal.unpaidDays} يوم</span>
                  </div>
                )}
                {(detailsModal.totalDeduction ?? 0) > 0 && (
                  <div className="flex justify-between items-center pb-2 border-b border-slate-200/60">
                    <span className="text-[12px] font-bold text-slate-500">إقرار خصم رسوم الزيادة</span>
                    <span className="font-black text-rose-500 text-[13px]">{formatMoney(detailsModal.totalDeduction)} ر.س</span>
                  </div>
                )}
                {(() => {
                  const m = parseStatutoryNoteMarkers(detailsModal.notes);
                  return (
                    <>
                      {m.eventDate && (
                        <div className="flex justify-between items-center pb-2 border-b border-slate-200/60">
                          <span className="text-[12px] font-bold text-slate-500">تاريخ الواقعة</span>
                          <span className="font-extrabold text-slate-800 text-[13px]">{formatDate(m.eventDate)}</span>
                        </div>
                      )}
                      {detailsModal.leaveType === 'BEREAVEMENT' && m.bereavementRelation && (
                        <div className="flex justify-between items-center pb-2 border-b border-slate-200/60">
                          <span className="text-[12px] font-bold text-slate-500">صلة القرابة</span>
                          <span className="font-extrabold text-slate-800 text-[13px]">{BEREAVEMENT_RELATION_LABELS[m.bereavementRelation]}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                {detailsModal.isOutsideKSA && (
                  <div className="flex justify-between items-center pb-2 border-b border-slate-200/60">
                    <span className="text-[12px] font-bold text-slate-500">مكان الإجازة</span>
                    <span className="font-black text-indigo-500 text-[13px]">خارج المملكة ✈️ (طلب تأشيرة)</span>
                  </div>
                )}
                <div className="flex flex-col gap-1 pt-2">
                  <span className="text-[12px] font-bold text-slate-500">ملاحظات الطلب</span>
                  <span className="font-bold text-slate-700 text-[13px] whitespace-pre-line">{stripStatutoryNoteMarkers(detailsModal.notes) || 'لا توجد ملاحظات'}</span>
                </div>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setDetailsModal(null)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition">إغلاق</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DIRECT RETURN MODAL (ADMIN) */}
      {directReturnModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-label="تسجيل مباشرة موظف" className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden relative">
            <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-lg font-black text-slate-800 flex items-center gap-2"><LogIn size={18} className="text-amber-600" /> تسجيل مباشرة موظف (مسؤول)</h2>
              <button type="button" aria-label="إغلاق" onClick={() => setDirectReturnModal(EMPTY_RETURN)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-[12px] font-bold text-slate-500 mb-1">الموظف المجاز</label>
                <select value={directReturnModal.leaveId} onChange={(e) => setDirectReturnModal({ ...directReturnModal, leaveId: e.target.value })} className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:border-amber-500 outline-none text-slate-800 font-bold bg-white">
                  <option value="">-- اختر الموظف --</option>
                  {returnCandidates.map((lv) => (
                    <option key={lv.id} value={lv.id}>{fullName(lv.employee)} ({lv.employee?.employeeId})</option>
                  ))}
                </select>
                {returnCandidates.length === 0 && (
                  <p className="text-xs text-red-500 mt-2 font-bold">لا يوجد موظفين في إجازة حالياً (غير مسجلين كعائدين).</p>
                )}
              </div>
              <div>
                <label className="block text-[12px] font-bold text-slate-500 mb-1">تاريخ المباشرة الفعلي</label>
                <input type="date" value={directReturnModal.returnDate} onChange={(e) => setDirectReturnModal({ ...directReturnModal, returnDate: e.target.value })} className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:border-amber-500 outline-none text-slate-800 font-bold" />
              </div>

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => setDirectReturnModal(EMPTY_RETURN)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition" disabled={directReturnModal.isSubmitting}>إلغاء</button>
                <button type="button" onClick={() => void handleDirectReturn()} disabled={!directReturnModal.leaveId || !directReturnModal.returnDate || directReturnModal.isSubmitting} className="flex-[2] py-3 bg-amber-500 hover:bg-amber-600 text-white font-black rounded-xl transition disabled:opacity-50 flex justify-center items-center">
                  {directReturnModal.isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'تسجيل المباشرة'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
