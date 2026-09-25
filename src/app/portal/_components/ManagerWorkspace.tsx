"use client";

// Shared workspace for the line-manager screens (/manager-portal and /dept-manager).
// Both pages used to be two copies of the same 560-line file; they now render this component.

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Briefcase, UserPlus, Clock, AlertTriangle, UserCheck, CheckCircle, History, ClipboardCheck, ChevronLeft,
  ArrowRightLeft, Building2, CalendarDays, MonitorSmartphone, AlertCircle, RefreshCw, type LucideIcon,
} from 'lucide-react';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate, formatDateShort, todayKey } from '@/lib/dates';
import { SAUDI_BANKS } from '@/lib/banks';
import { useRole } from '@/context/RoleContext';
import { redirectToLogin } from './redirect-to-login';

interface WorkspaceEmployee { id: string; firstNameArabic?: string | null; lastNameArabic?: string | null; jobTitle?: string | null }
interface OpenLeave { id: string; endDate: string; employee?: { firstNameArabic?: string | null; lastNameArabic?: string | null } | null }
interface HistoryItem { id: string; type: string; employee?: string | null; details?: string | null; date: string; status: string }
interface CycleEvaluation { id: string; status: string }
interface EvalCycle { id: string; title: string; status: string; template?: { name?: string | null } | null; evaluations?: CycleEvaluation[] }
interface BranchOption { id: string; nameArabic: string }
interface DepartmentOption { id: string; nameArabic: string }

type Tab = 'OVERTIME' | 'WORK_TASK' | 'PENALTY' | 'JOB' | 'ONBOARDING' | 'RETURN' | 'ASSET' | 'EVALUATION';
const TABS: readonly Tab[] = ['OVERTIME', 'WORK_TASK', 'PENALTY', 'JOB', 'ONBOARDING', 'RETURN', 'ASSET', 'EVALUATION'];

interface TabDef { id: Tab; label: string; icon: LucideIcon; active: string; idle: string }

// Static class strings (Tailwind cannot see dynamically built class names).
const TAB_DEFS: readonly TabDef[] = [
  { id: 'OVERTIME', label: 'تكليف عمل إضافي', icon: Clock, active: 'bg-indigo-600 text-white shadow-lg scale-105', idle: 'hover:bg-indigo-50 hover:border-indigo-200' },
  { id: 'WORK_TASK', label: 'مهمة عمل خارجية', icon: Briefcase, active: 'bg-fuchsia-600 text-white shadow-lg scale-105', idle: 'hover:bg-fuchsia-50 hover:border-fuchsia-200' },
  { id: 'PENALTY', label: 'إسناد مخالفة للموظف', icon: AlertTriangle, active: 'bg-rose-600 text-white shadow-lg scale-105', idle: 'hover:bg-rose-50 hover:border-rose-200' },
  { id: 'JOB', label: 'طلب احتياج وظيفي', icon: UserPlus, active: 'bg-emerald-600 text-white shadow-lg scale-105', idle: 'hover:bg-emerald-50 hover:border-emerald-200' },
  { id: 'ONBOARDING', label: 'مباشرة عمل جديدة', icon: UserPlus, active: 'bg-sky-600 text-white shadow-lg scale-105', idle: 'hover:bg-sky-50 hover:border-sky-200' },
  { id: 'RETURN', label: 'مباشرة عمل بعد الإجازة', icon: UserCheck, active: 'bg-amber-600 text-white shadow-lg scale-105', idle: 'hover:bg-amber-50 hover:border-amber-200' },
  { id: 'ASSET', label: 'طلب عهدة لموظف', icon: MonitorSmartphone, active: 'bg-cyan-600 text-white shadow-lg scale-105', idle: 'hover:bg-cyan-50 hover:border-cyan-200' },
  { id: 'EVALUATION', label: 'تقييم الموظفين', icon: ClipboardCheck, active: 'bg-violet-600 text-white shadow-lg scale-105', idle: 'hover:bg-violet-50 hover:border-violet-200' },
];

const THEMES = {
  blue: { border: 'border-blue-200', title: 'text-blue-900', iconBox: 'bg-blue-100 text-blue-700', subtitle: 'text-blue-700', grid: 'md:grid-cols-4', historyIcon: 'text-indigo-600', dot: 'bg-indigo-500' },
  teal: { border: 'border-teal-200', title: 'text-teal-900', iconBox: 'bg-teal-100 text-teal-700', subtitle: 'text-teal-700', grid: 'md:grid-cols-6', historyIcon: 'text-teal-600', dot: 'bg-teal-500' },
} as const;

const INPUT = 'w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px]';
const SMALL_INPUT = 'w-full p-3 bg-white border border-slate-200 rounded-lg font-bold text-[13px]';

/** Stored value for Saudi nationality (same as DEFAULT_NATIONALITY in src/lib/employee.ts). */
const DEFAULT_NATIONALITY = 'سعودي';
/** Shown until /api/nationalities answers. */
const FALLBACK_NATIONALITIES = [DEFAULT_NATIONALITY];

const INITIAL_ONBOARDING = {
  requesterId: '', fullNameArabic: '', lastNameArabic: '', firstNameEnglish: '', lastNameEnglish: '', nationality: DEFAULT_NATIONALITY, dateOfBirth: '', gender: 'MALE', maritalStatus: '',
  iqamaOrIdNumber: '', iqamaOrIdExp: '', passportNumber: '', passportExp: '',
  mobileNumber: '', email: '',
  branchId: '', administrationId: '', departmentId: '', directManagerId: '', jobTitle: '', joinDate: '', contractType: 'FULL_TIME',
  bankName: '', ibanNumber: '', basicSalary: '',
  iqamaCopyUrl: '', passportCopyUrl: '', ibanCertificateUrl: '', resumeUrl: '', workContractUrl: '', healthCertificateUrl: '',
};
type OnboardingForm = typeof INITIAL_ONBOARDING;

function empName(e: { firstNameArabic?: string | null; lastNameArabic?: string | null } | null | undefined): string {
  return `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim();
}

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 401) {
      redirectToLogin();
      return { ok: false, error: 'انتهت الجلسة' };
    }
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: 'تعذر الاتصال بالخادم' };
  }
}

interface ManagerWorkspaceProps {
  title: string;
  subtitle?: string;
  variant?: 'blue' | 'teal';
  /** Which action tabs to show (default: all). */
  tabs?: readonly Tab[];
  showTransfersLink?: boolean;
  showLeaveLink?: boolean;
  backLink?: { href: string; label: string };
  historyTitle?: string;
}

export default function ManagerWorkspace({
  title,
  subtitle,
  variant = 'blue',
  tabs = TABS,
  showTransfersLink = false,
  showLeaveLink = true,
  backLink,
  historyTitle = 'سجل المعاملات والطلبات السابقة',
}: ManagerWorkspaceProps) {
  const { user } = useRole();
  const myEmployeeId = user?.employeeId ?? '';

  const [activeTab, setActiveTab] = useState<Tab>('OVERTIME');
  const [employees, setEmployees] = useState<WorkspaceEmployee[]>([]);
  const [leaves, setLeaves] = useState<OpenLeave[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [pendingEvals, setPendingEvals] = useState<EvalCycle[]>([]);
  const [evalsError, setEvalsError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState<Tab | null>(null);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [nationalities, setNationalities] = useState<string[]>(FALLBACK_NATIONALITIES);

  // Forms
  const [overtimeForm, setOvertimeForm] = useState({ employeeId: '', date: '', hours: '', reason: '' });
  const [workTaskForm, setWorkTaskForm] = useState({ employeeId: '', destination: '', details: '', startDate: '', endDate: '' });
  const [penaltyForm, setPenaltyForm] = useState({ employeeId: '', amount: '', reason: '' });
  const [jobForm, setJobForm] = useState({ requesterId: '', jobTitle: '', jobType: 'FULL_TIME', nationality: 'غير محدد', description: '' });
  const [assetRequestForm, setAssetRequestForm] = useState({ employeeId: '', assetType: 'LAPTOP', description: '' });
  const [returnForm, setReturnForm] = useState({ leaveId: '', actualReturnDate: '' });
  const [onboardingForm, setOnboardingForm] = useState<OnboardingForm>(INITIAL_ONBOARDING);

  const fetchHistory = useCallback(async () => {
    const r = await getJson<unknown>('/api/manager-portal?action=get_history');
    if (r.ok) {
      setHistory(Array.isArray(r.data) ? (r.data as HistoryItem[]) : []);
      setHistoryError(null);
    } else {
      setHistoryError(r.error);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    const [emps, lvs] = await Promise.all([
      getJson<unknown>('/api/manager-portal?action=get_employees'),
      getJson<unknown>('/api/manager-portal?action=get_leaves'),
    ]);
    if (!emps.ok || !lvs.ok) {
      setLoadError(!emps.ok ? emps.error : !lvs.ok ? lvs.error : null);
    }
    if (emps.ok && Array.isArray(emps.data)) {
      const list = emps.data as WorkspaceEmployee[];
      setEmployees(list);
      const first = list[0]?.id ?? '';
      setOvertimeForm((f) => ({ ...f, employeeId: f.employeeId || first }));
      setWorkTaskForm((f) => ({ ...f, employeeId: f.employeeId || first }));
      setPenaltyForm((f) => ({ ...f, employeeId: f.employeeId || first }));
      setAssetRequestForm((f) => ({ ...f, employeeId: f.employeeId || first }));
    }
    if (lvs.ok && Array.isArray(lvs.data)) {
      const list = lvs.data as OpenLeave[];
      setLeaves(list);
      setReturnForm((f) => ({ ...f, leaveId: f.leaveId || list[0]?.id || '' }));
    }
    setIsLoading(false);

    void fetchHistory();

    const cycles = await getJson<unknown>('/api/evaluations?view=cycles');
    if (cycles.ok && Array.isArray(cycles.data)) {
      setPendingEvals((cycles.data as EvalCycle[]).filter((c) => c.status === 'OPEN' || c.status === 'IN_PROGRESS'));
      setEvalsError(null);
    } else if (!cycles.ok) {
      setEvalsError(cycles.error);
    }
  }, [fetchHistory]);

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab && (TABS as readonly string[]).includes(tab)) setActiveTab(tab as Tab);
    void fetchAll();
    void getJson<unknown>('/api/branches').then((r) => {
      if (r.ok && Array.isArray(r.data)) setBranches(r.data as BranchOption[]);
    });
    void getJson<unknown>('/api/nationalities').then((r) => {
      if (!r.ok || !Array.isArray(r.data)) return;
      const labels = (r.data as Array<{ label?: unknown }>)
        .map((n) => (typeof n.label === 'string' ? n.label.trim() : ''))
        .filter(Boolean);
      // Saudi first, then the rest as returned (oldest first).
      setNationalities([DEFAULT_NATIONALITY, ...labels.filter((l) => l !== DEFAULT_NATIONALITY)]);
    });
  }, [fetchAll]);

  // The signed-in manager is the default requester / direct manager.
  useEffect(() => {
    if (!myEmployeeId) return;
    setJobForm((f) => ({ ...f, requesterId: f.requesterId || myEmployeeId }));
    setOnboardingForm((f) => ({ ...f, requesterId: f.requesterId || myEmployeeId, directManagerId: f.directManagerId || myEmployeeId }));
  }, [myEmployeeId]);

  // Departments of the selected onboarding branch.
  useEffect(() => {
    if (!onboardingForm.branchId) {
      setDepartments([]);
      return;
    }
    let cancelled = false;
    void getJson<unknown>(`/api/departments?branchId=${encodeURIComponent(onboardingForm.branchId)}`).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data)) setDepartments(r.data as DepartmentOption[]);
    });
    return () => {
      cancelled = true;
    };
  }, [onboardingForm.branchId]);

  const handleAction = async (tab: Tab, actionType: string, payload: Record<string, unknown>, resetForm: () => void) => {
    if (submitting) return;
    setSubmitting(tab);
    try {
      const res = await fetch('/api/manager-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType, ...payload }),
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تنفيذ الطلب'));
        return;
      }
      const data = (await res.json()) as { message?: string };
      toast.success(data.message || 'تم رفع الطلب بنجاح');
      resetForm();
      if (actionType === 'RETURN_FROM_LEAVE') {
        const remaining = leaves.filter((l) => l.id !== payload.leaveId);
        setLeaves(remaining);
        setReturnForm({ leaveId: remaining[0]?.id ?? '', actualReturnDate: '' });
      }
      void fetchHistory();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(null);
    }
  };

  const employeeOptions = (withTitle = true) =>
    employees.map((emp) => (
      <option key={emp.id} value={emp.id}>{empName(emp)}{withTitle && emp.jobTitle ? ` - ${emp.jobTitle}` : ''}</option>
    ));

  const noEmployees = employees.length === 0;

  const setOnb = <K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) => setOnboardingForm((f) => ({ ...f, [key]: value }));

  const theme = THEMES[variant];
  const visibleTabs = TAB_DEFS.filter((t) => tabs.includes(t.id));
  const HeaderIcon = variant === 'teal' ? Building2 : Briefcase;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
      <div className={`flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b ${theme.border}`}>
        <div>
          <h1 className={`text-3xl font-black tracking-tight flex items-center gap-3 ${theme.title}`}>
            <span className={`p-3 rounded-2xl ${theme.iconBox}`}><HeaderIcon size={26} /></span>
            {title}
          </h1>
          <p className={`font-bold mt-3 text-[14px] leading-relaxed max-w-2xl ${theme.subtitle}`}>
            {subtitle ?? 'إدارة مرؤوسيك بفعالية: تكليف أعمال إضافية، إيقاع جزاءات، طلب كوادر جديدة، وتسجيل إشعارات بمباشرة الموظفين بعد الإجازة؛ كافة الإجراءات ستُرفع للموارد البشرية للموافقة النهائية وتوثيقها.'}
          </p>
        </div>
        {showTransfersLink && (
          <Link href="/transfers" className="px-6 py-3.5 bg-white border-2 border-teal-200 hover:border-teal-500 hover:bg-teal-50 hover:text-teal-700 text-slate-700 rounded-2xl font-black text-[13px] flex justify-center items-center gap-2 transition shadow-sm whitespace-nowrap">
            <ArrowRightLeft size={18} className="text-teal-500" />
            النقل الداخلي بين الفروع
          </Link>
        )}
        {backLink && (
          <div className="flex items-center gap-4">
            <Link href={backLink.href} className="px-6 py-3 bg-white border border-slate-200 rounded-xl font-bold text-slate-600 hover:bg-slate-50 transition">{backLink.label}</Link>
          </div>
        )}
      </div>

      {loadError && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3">
          <AlertCircle className="text-rose-500 shrink-0" size={20} />
          <p className="font-bold text-rose-800 text-[13px] flex-1">تعذر تحميل بيانات الموظفين أو الإجازات: {loadError}</p>
          <button type="button" onClick={() => void fetchAll()} className="flex items-center gap-1 bg-white border border-rose-200 text-rose-700 px-3 py-2 rounded-xl font-bold text-[12px] hover:bg-rose-100">
            <RefreshCw size={14} /> إعادة المحاولة
          </button>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-4 ${theme.grid}`}>
        {showLeaveLink && (
        <Link href="/leaves/new" className="p-4 rounded-[1rem] flex flex-col items-center justify-center gap-3 transition-all bg-white border text-slate-500 hover:bg-teal-50 border-slate-200 hover:border-teal-200">
          <CalendarDays size={28} className="text-teal-600" />
          <span className="font-extrabold text-[13px] text-center">تقديم طلب إجازة لموظف</span>
        </Link>
        )}
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActiveTab(t.id)}
              className={`p-4 rounded-[1rem] flex flex-col items-center justify-center gap-3 transition-all ${isActive ? t.active : `bg-white border text-slate-500 border-slate-200 ${t.idle}`}`}
            >
              <Icon size={28} />
              <span className="font-extrabold text-[13px] text-center">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="bg-white border border-slate-200 shadow-xl rounded-[2rem] p-8 md:p-12 relative overflow-hidden">
        {isLoading && activeTab !== 'EVALUATION' ? (
          <div className="py-16 text-center text-slate-400 font-bold animate-pulse">جاري تحميل البيانات...</div>
        ) : (
          <>
            {/* OVERTIME */}
            {activeTab === 'OVERTIME' && (
              <form onSubmit={(e) => { e.preventDefault(); void handleAction('OVERTIME', 'ASSIGN_OVERTIME', overtimeForm, () => setOvertimeForm((f) => ({ ...f, hours: '', reason: '' }))); }} className="space-y-6">
                <h3 className="text-xl font-black text-indigo-900 border-b border-indigo-100 pb-4 mb-6 flex items-center gap-2"><Clock size={22} className="text-indigo-500" /> نموذج تكليف بالعمل الإضافي (للاعتماد)</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Field label="الموظف المراد تكليفه">
                    <select required value={overtimeForm.employeeId} onChange={(e) => setOvertimeForm({ ...overtimeForm, employeeId: e.target.value })} className={INPUT}>
                      {employeeOptions()}
                    </select>
                  </Field>
                  <Field label="تاريخ التكليف الفعلي">
                    <input type="date" required value={overtimeForm.date} onChange={(e) => setOvertimeForm({ ...overtimeForm, date: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="عدد إجمالي الساعات المطلوبة (تقديرياً)">
                    <input type="number" step="0.5" min="0.5" max="24" required value={overtimeForm.hours} onChange={(e) => setOvertimeForm({ ...overtimeForm, hours: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="الداعي والسبب لهذا التكليف">
                    <input type="text" placeholder="مثال: إنجاز أعمال نهاية الشهر" required value={overtimeForm.reason} onChange={(e) => setOvertimeForm({ ...overtimeForm, reason: e.target.value })} className={INPUT} />
                  </Field>
                </div>
                <SubmitButton busy={submitting === 'OVERTIME'} disabled={submitting !== null || noEmployees} className="bg-indigo-700 hover:bg-indigo-800">رفع الطلب لاعتماد الموارد البشرية</SubmitButton>
              </form>
            )}

            {/* WORK TASK */}
            {activeTab === 'WORK_TASK' && (
              <form onSubmit={(e) => {
                e.preventDefault();
                if (workTaskForm.endDate < workTaskForm.startDate) { toast.warning('تاريخ النهاية يجب أن يكون بعد تاريخ البداية'); return; }
                void handleAction('WORK_TASK', 'ASSIGN_WORK_TASK', workTaskForm, () => setWorkTaskForm((f) => ({ ...f, destination: '', details: '', startDate: '', endDate: '' })));
              }} className="space-y-6 animate-in fade-in">
                <h3 className="text-xl font-black text-fuchsia-900 border-b border-fuchsia-100 pb-4 mb-6 flex items-center gap-2"><Briefcase size={22} className="text-fuchsia-500" /> نموذج تكليف مهمة عمل خارجية والانتداب</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Field label="الموظف المراد تكليفه" wide>
                    <select required value={workTaskForm.employeeId} onChange={(e) => setWorkTaskForm({ ...workTaskForm, employeeId: e.target.value })} className={INPUT}>
                      {employeeOptions()}
                    </select>
                  </Field>
                  <Field label="الجهة المرسل إليها">
                    <input type="text" placeholder="مثال: ورشة العميل الفلاني، جهة حكومية..." required value={workTaskForm.destination} onChange={(e) => setWorkTaskForm({ ...workTaskForm, destination: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="التفاصيل / المهام المطلوب إنجازها">
                    <input type="text" placeholder="اكتب التفاصيل..." required value={workTaskForm.details} onChange={(e) => setWorkTaskForm({ ...workTaskForm, details: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="المدة من (تاريخ البداية)">
                    <input type="date" required value={workTaskForm.startDate} onChange={(e) => setWorkTaskForm({ ...workTaskForm, startDate: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="المدة إلى (تاريخ النهاية)">
                    <input type="date" required min={workTaskForm.startDate || undefined} value={workTaskForm.endDate} onChange={(e) => setWorkTaskForm({ ...workTaskForm, endDate: e.target.value })} className={INPUT} />
                  </Field>
                </div>
                <SubmitButton busy={submitting === 'WORK_TASK'} disabled={submitting !== null || noEmployees} className="bg-fuchsia-600 hover:bg-fuchsia-700">إرسال للموظف والموارد البشرية للاعتماد</SubmitButton>
              </form>
            )}

            {/* PENALTY */}
            {activeTab === 'PENALTY' && (
              <form onSubmit={(e) => { e.preventDefault(); void handleAction('PENALTY', 'ASSIGN_PENALTY', penaltyForm, () => setPenaltyForm((f) => ({ ...f, amount: '', reason: '' }))); }} className="space-y-6">
                <h3 className="text-xl font-black text-rose-900 border-b border-rose-100 pb-4 mb-6 flex items-center gap-2"><AlertTriangle size={22} className="text-rose-500" /> إثبات مخالفة وجزاء إداري (للاعتماد)</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Field label="الموظف المُقصر" wide>
                    <select required value={penaltyForm.employeeId} onChange={(e) => setPenaltyForm({ ...penaltyForm, employeeId: e.target.value })} className={INPUT}>
                      {employeeOptions(false)}
                    </select>
                  </Field>
                  <Field label="المقدار المقترح خصمه (بالريال)">
                    <input type="number" min="1" step="0.01" required value={penaltyForm.amount} onChange={(e) => setPenaltyForm({ ...penaltyForm, amount: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="سبب المخالفة وفق لائحة العمل الداخلي">
                    <input type="text" placeholder="تأخير غير مبرر، إهمال في أداء مهام" required value={penaltyForm.reason} onChange={(e) => setPenaltyForm({ ...penaltyForm, reason: e.target.value })} className={INPUT} />
                  </Field>
                </div>
                <SubmitButton busy={submitting === 'PENALTY'} disabled={submitting !== null || noEmployees} className="bg-rose-600 hover:bg-rose-700">إرسال لفرض الخصم</SubmitButton>
              </form>
            )}

            {/* JOB REQUEST */}
            {activeTab === 'JOB' && (
              <form onSubmit={(e) => { e.preventDefault(); void handleAction('JOB', 'REQUEST_HIRING', jobForm, () => setJobForm((f) => ({ ...f, jobTitle: '', description: '' }))); }} className="space-y-6">
                <h3 className="text-xl font-black text-emerald-900 border-b border-emerald-100 pb-4 mb-6 flex items-center gap-2"><UserPlus size={22} className="text-emerald-500" /> عرض احتياج إحلال أو توظيف كوادر جديدة</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* The requester is the signed-in manager (server session); only an account without an
                      employee file (e.g. the system admin) picks the manager the request is raised for. */}
                  {!myEmployeeId && (
                    <Field label="رافع الطلب (المدير المسؤول)" wide>
                      <select required value={jobForm.requesterId} onChange={(e) => setJobForm({ ...jobForm, requesterId: e.target.value })} className={INPUT}>
                        <option value="">— اختر —</option>
                        {employeeOptions()}
                      </select>
                    </Field>
                  )}
                  <Field label="المسمى الوظيفي المطلوب">
                    <input type="text" placeholder="مثال: محاسب أو مبرمج" required value={jobForm.jobTitle} onChange={(e) => setJobForm({ ...jobForm, jobTitle: e.target.value })} className={INPUT} />
                  </Field>
                  <Field label="الجنسية المفضلة للشاغر أو المطلوبة">
                    <select required value={jobForm.nationality} onChange={(e) => setJobForm({ ...jobForm, nationality: e.target.value })} className={INPUT}>
                      <option value="غير محدد">غير محدد</option>
                      <option value="سعودي">سعودي</option>
                      <option value="أجنبي">أجنبي</option>
                    </select>
                  </Field>
                  <Field label="وصف المهام والدور المرتقب للموظف الجديد (الوصف الوظيفي المقترح)" wide>
                    <textarea rows={4} required value={jobForm.description} onChange={(e) => setJobForm({ ...jobForm, description: e.target.value })} className={INPUT}></textarea>
                  </Field>
                </div>
                <SubmitButton busy={submitting === 'JOB'} disabled={submitting !== null || (!myEmployeeId && !jobForm.requesterId)} className="bg-emerald-600 hover:bg-emerald-700">تأكيد احتياج وعرض على الموارد البشرية للصلاحية</SubmitButton>
              </form>
            )}

            {/* RETURN FROM LEAVE */}
            {activeTab === 'RETURN' && (
              <form onSubmit={(e) => { e.preventDefault(); void handleAction('RETURN', 'RETURN_FROM_LEAVE', returnForm, () => setReturnForm((f) => ({ ...f, actualReturnDate: '' }))); }} className="space-y-6">
                <h3 className="text-xl font-black text-amber-900 border-b border-amber-100 pb-4 mb-6 flex items-center gap-2"><UserCheck size={22} className="text-amber-500" /> إشعار عودة موظف لمباشرة العمل فورًا بعد انقضاء إجازته</h3>
                {leaves.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 font-bold bg-amber-50 rounded-2xl border border-amber-100">
                    لا يوجد حالياً موظفون بإجازات جارية أو لم يتم إثبات مباشرتهم بعد الإجازة.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Field label="الموظف العائد من الإجازة">
                        <select required value={returnForm.leaveId} onChange={(e) => setReturnForm({ ...returnForm, leaveId: e.target.value })} className={INPUT}>
                          {leaves.map((l) => <option key={l.id} value={l.id}>{empName(l.employee)} - إجازة حتى {formatDateShort(l.endDate)}</option>)}
                        </select>
                      </Field>
                      <Field label="تاريخ المباشرة الفعلي">
                        <input type="date" required max={todayKey()} value={returnForm.actualReturnDate} onChange={(e) => setReturnForm({ ...returnForm, actualReturnDate: e.target.value })} className={INPUT} />
                      </Field>
                    </div>
                    <SubmitButton busy={submitting === 'RETURN'} disabled={submitting !== null || !returnForm.leaveId} className="bg-amber-600 hover:bg-amber-700">إثبات مباشرة وتحديث رصيده ووضعه في القوى العاملة</SubmitButton>
                  </>
                )}
              </form>
            )}

            {/* ASSET REQUEST */}
            {activeTab === 'ASSET' && (
              <form onSubmit={(e) => { e.preventDefault(); void handleAction('ASSET', 'REQUEST_ASSET', assetRequestForm, () => setAssetRequestForm((f) => ({ ...f, description: '' }))); }} className="space-y-6">
                <h3 className="text-xl font-black text-cyan-900 border-b border-cyan-100 pb-4 mb-6 flex items-center gap-2"><MonitorSmartphone size={22} className="text-cyan-500" /> طلب توفير عهدة لموظف</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Field label="الموظف المستفيد">
                    <select required value={assetRequestForm.employeeId} onChange={(e) => setAssetRequestForm({ ...assetRequestForm, employeeId: e.target.value })} className={INPUT}>
                      {employeeOptions()}
                    </select>
                  </Field>
                  <Field label="نوع العهدة">
                    <select required value={assetRequestForm.assetType} onChange={(e) => setAssetRequestForm({ ...assetRequestForm, assetType: e.target.value })} className={INPUT}>
                      <option value="LAPTOP">جهاز حاسب</option>
                      <option value="MOBILE">جوال</option>
                      <option value="SIM">شريحة اتصال</option>
                      <option value="OTHER">عهدة أخرى</option>
                    </select>
                  </Field>
                  <Field label="تفاصيل ومبرر الطلب" wide>
                    <textarea rows={3} required value={assetRequestForm.description} onChange={(e) => setAssetRequestForm({ ...assetRequestForm, description: e.target.value })} className={INPUT}></textarea>
                  </Field>
                </div>
                <SubmitButton busy={submitting === 'ASSET'} disabled={submitting !== null || noEmployees} className="bg-cyan-600 hover:bg-cyan-700">رفع طلب العهدة للموارد البشرية</SubmitButton>
              </form>
            )}

            {/* ONBOARDING */}
            {activeTab === 'ONBOARDING' && (
              <form onSubmit={(e) => { e.preventDefault(); void handleAction('ONBOARDING', 'SUBMIT_ONBOARDING', onboardingForm, () => setOnboardingForm({ ...INITIAL_ONBOARDING, requesterId: myEmployeeId, directManagerId: myEmployeeId })); }} className="space-y-8">
                <h3 className="text-xl font-black text-sky-900 border-b border-sky-100 pb-4 flex items-center gap-2"><UserPlus size={22} className="text-sky-500" /> نموذج مباشرة عمل متكامل (Onboarding)</h3>

                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                  <h4 className="font-extrabold text-slate-800 text-[14px] flex items-center gap-2">1. البيانات الشخصية</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <SmallField label="الاسم الأول (عربي) *"><input type="text" required value={onboardingForm.fullNameArabic} onChange={(e) => setOnb('fullNameArabic', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="اسم العائلة (عربي) *"><input type="text" required value={onboardingForm.lastNameArabic} onChange={(e) => setOnb('lastNameArabic', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="الاسم الأول (انجليزي)"><input type="text" dir="ltr" value={onboardingForm.firstNameEnglish} onChange={(e) => setOnb('firstNameEnglish', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="اسم العائلة (انجليزي)"><input type="text" dir="ltr" value={onboardingForm.lastNameEnglish} onChange={(e) => setOnb('lastNameEnglish', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="الجنسية">
                      <select value={onboardingForm.nationality} onChange={(e) => setOnb('nationality', e.target.value)} className={SMALL_INPUT}>
                        {nationalities.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </SmallField>
                    <SmallField label="الجنس">
                      <select value={onboardingForm.gender} onChange={(e) => setOnb('gender', e.target.value)} className={SMALL_INPUT}>
                        <option value="MALE">ذكر</option>
                        <option value="FEMALE">أنثى</option>
                      </select>
                    </SmallField>
                    <SmallField label="الحالة الاجتماعية">
                      <select value={onboardingForm.maritalStatus} onChange={(e) => setOnb('maritalStatus', e.target.value)} className={SMALL_INPUT}>
                        <option value="">غير محدد</option>
                        <option value="SINGLE">أعزب</option>
                        <option value="MARRIED">متزوج</option>
                      </select>
                    </SmallField>
                    <SmallField label="تاريخ الميلاد"><input type="date" max={todayKey()} value={onboardingForm.dateOfBirth} onChange={(e) => setOnb('dateOfBirth', e.target.value)} className={SMALL_INPUT} /></SmallField>
                  </div>
                </div>

                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                  <h4 className="font-extrabold text-slate-800 text-[14px] flex items-center gap-2">2. الهوية والجواز وبيانات التواصل</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <SmallField label="رقم الهوية / الإقامة *"><input type="text" dir="ltr" required value={onboardingForm.iqamaOrIdNumber} onChange={(e) => setOnb('iqamaOrIdNumber', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="تاريخ انتهاء الهوية"><input type="date" value={onboardingForm.iqamaOrIdExp} onChange={(e) => setOnb('iqamaOrIdExp', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="رقم الجواز (للمقيمين)"><input type="text" dir="ltr" value={onboardingForm.passportNumber} onChange={(e) => setOnb('passportNumber', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="تاريخ انتهاء الجواز"><input type="date" value={onboardingForm.passportExp} onChange={(e) => setOnb('passportExp', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="رقم الجوال *" wide><input type="tel" dir="ltr" required value={onboardingForm.mobileNumber} onChange={(e) => setOnb('mobileNumber', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="البريد الإلكتروني" wide><input type="email" dir="ltr" value={onboardingForm.email} onChange={(e) => setOnb('email', e.target.value)} className={SMALL_INPUT} /></SmallField>
                  </div>
                </div>

                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                  <h4 className="font-extrabold text-slate-800 text-[14px] flex items-center gap-2">3. الوظيفة والراتب</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <SmallField label="المسمى الوظيفي *" wide><input type="text" required value={onboardingForm.jobTitle} onChange={(e) => setOnb('jobTitle', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="تاريخ المباشرة"><input type="date" value={onboardingForm.joinDate} onChange={(e) => setOnb('joinDate', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="نوع العقد">
                      <select value={onboardingForm.contractType} onChange={(e) => setOnb('contractType', e.target.value)} className={SMALL_INPUT}>
                        <option value="FULL_TIME">دوام كامل</option>
                        <option value="PART_TIME">دوام جزئي</option>
                        <option value="FREELANCE">عمل حر</option>
                      </select>
                    </SmallField>
                    <SmallField label="الفرع">
                      <select value={onboardingForm.branchId} onChange={(e) => setOnboardingForm((f) => ({ ...f, branchId: e.target.value, departmentId: '' }))} className={SMALL_INPUT}>
                        <option value="">— اختر الفرع —</option>
                        {branches.map((b) => <option key={b.id} value={b.id}>{b.nameArabic}</option>)}
                      </select>
                    </SmallField>
                    <SmallField label="القسم">
                      <select value={onboardingForm.departmentId} disabled={!onboardingForm.branchId} onChange={(e) => setOnb('departmentId', e.target.value)} className={SMALL_INPUT}>
                        <option value="">{onboardingForm.branchId ? '— اختر القسم —' : 'اختر الفرع أولاً'}</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.nameArabic}</option>)}
                      </select>
                    </SmallField>
                    <SmallField label="البنك">
                      <select value={onboardingForm.bankName} onChange={(e) => setOnb('bankName', e.target.value)} className={SMALL_INPUT}>
                        <option value="">— اختر البنك —</option>
                        {SAUDI_BANKS.map((b) => <option key={b.code} value={b.value}>{b.label} ({b.code})</option>)}
                      </select>
                    </SmallField>
                    <SmallField label="الآيبان"><input type="text" dir="ltr" placeholder="SA..." value={onboardingForm.ibanNumber} onChange={(e) => setOnb('ibanNumber', e.target.value.toUpperCase().replace(/\s+/g, ''))} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="الراتب الأساسي *" wide><input type="number" min="0" step="0.01" required value={onboardingForm.basicSalary} onChange={(e) => setOnb('basicSalary', e.target.value)} className={SMALL_INPUT} /></SmallField>
                    <SmallField label="المشرف المباشر" wide>
                      <select value={onboardingForm.directManagerId} onChange={(e) => setOnb('directManagerId', e.target.value)} className={SMALL_INPUT}>
                        <option value="">— غير محدد —</option>
                        {employeeOptions()}
                      </select>
                    </SmallField>
                  </div>
                </div>

                <div className="bg-sky-50 p-6 rounded-2xl border border-sky-100 space-y-4">
                  <h4 className="font-extrabold text-sky-900 text-[14px] flex items-center gap-2">4. المرفقات والثبوتيات</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FileUploadField name="iqamaCopyUrl" label="صورة الإقامة أو الهوية" value={onboardingForm.iqamaCopyUrl} onChange={(e) => setOnb('iqamaCopyUrl', e.target.value)} />
                    <FileUploadField name="passportCopyUrl" label="صورة الجواز" value={onboardingForm.passportCopyUrl} onChange={(e) => setOnb('passportCopyUrl', e.target.value)} />
                    <FileUploadField name="ibanCertificateUrl" label="شهادة الآيبان" value={onboardingForm.ibanCertificateUrl} onChange={(e) => setOnb('ibanCertificateUrl', e.target.value)} />
                    <FileUploadField name="resumeUrl" label="السيرة الذاتية" value={onboardingForm.resumeUrl} onChange={(e) => setOnb('resumeUrl', e.target.value)} />
                  </div>
                </div>

                <SubmitButton busy={submitting === 'ONBOARDING'} disabled={submitting !== null} className="bg-sky-600 hover:bg-sky-700">رفع طلب المباشرة الشامل للموارد البشرية</SubmitButton>
              </form>
            )}
          </>
        )}

        {/* EVALUATION */}
        {activeTab === 'EVALUATION' && (
          <div className="space-y-6">
            <h3 className="text-xl font-black text-violet-900 border-b border-violet-100 pb-4 mb-6 flex items-center gap-2"><ClipboardCheck size={22} className="text-violet-500" /> تقييمات الموظفين المعلقة</h3>
            {evalsError ? (
              <div className="p-8 text-center text-rose-600 font-bold bg-rose-50 rounded-2xl border border-rose-100">تعذر تحميل دورات التقييم: {evalsError}</div>
            ) : pendingEvals.length === 0 ? (
              <div className="p-8 text-center text-slate-500 font-bold bg-violet-50 rounded-2xl border border-violet-100">
                لا توجد دورات تقييم مفتوحة حالياً.
              </div>
            ) : (
              <div className="space-y-4">
                {pendingEvals.map((cycle) => {
                  const evals = cycle.evaluations || [];
                  const completed = evals.filter((e) => e.status === 'CLOSED').length;
                  const pending = evals.filter((e) => e.status === 'PENDING_MANAGER' || e.status === 'RETURNED' || e.status === 'DRAFT').length;
                  return (
                    <Link key={cycle.id} href={`/evaluations/${cycle.id}`}
                      className="block bg-violet-50 rounded-2xl p-5 border border-violet-200 hover:bg-violet-100 hover:border-violet-300 transition-all group">
                      <div className="flex justify-between items-center">
                        <div>
                          <h4 className="font-black text-[15px] text-violet-800 group-hover:text-violet-900">{cycle.title}</h4>
                          <p className="text-[12px] font-bold text-violet-500 mt-1">{cycle.template?.name}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          {pending > 0 && (
                            <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-lg text-[11px] font-black">{pending} بانتظار التعبئة</span>
                          )}
                          <span className="bg-violet-200 text-violet-700 px-3 py-1 rounded-lg text-[11px] font-black">{completed}/{evals.length} مكتمل</span>
                          <ChevronLeft size={18} className="text-violet-400 group-hover:text-violet-600" />
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* History Section */}
      <div className="bg-white border border-slate-200 shadow-xl rounded-[2rem] p-8 md:p-12">
        <h2 className="text-2xl font-black text-slate-800 mb-6 flex items-center gap-3">
          <History size={26} className={theme.historyIcon} /> {historyTitle}
        </h2>
        {historyError ? (
          <div className="text-center p-8 bg-rose-50 rounded-2xl border border-rose-100 text-rose-600 font-bold flex flex-col items-center gap-3">
            <span>تعذر تحميل السجل: {historyError}</span>
            <button type="button" onClick={() => void fetchHistory()} className="flex items-center gap-1 bg-white border border-rose-200 text-rose-700 px-3 py-2 rounded-xl font-bold text-[12px] hover:bg-rose-100">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        ) : history.length === 0 ? (
          <div className="text-center p-8 bg-slate-50 rounded-2xl border border-slate-100 text-slate-500 font-bold">
            لا توجد معاملات سابقة مسجلة.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead>
                <tr className="bg-slate-100 text-slate-600 font-extrabold text-[13px]">
                  <th className="p-4 rounded-r-xl">نوع المعاملة</th>
                  <th className="p-4">الموظف المعني</th>
                  <th className="p-4">التفاصيل</th>
                  <th className="p-4">تاريخ الطلب</th>
                  <th className="p-4 rounded-l-xl">الحالة</th>
                </tr>
              </thead>
              <tbody className="text-[14px]">
                {history.map((item) => (
                  <tr key={item.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                    <td className="p-4 font-bold text-slate-800">
                      <span className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${theme.dot}`}></span>{item.type}</span>
                    </td>
                    <td className="p-4 text-slate-800 font-bold">{item.employee}</td>
                    <td className="p-4 text-slate-500 whitespace-nowrap">{item.details}</td>
                    <td className="p-4 text-slate-500">{formatDate(item.date)}</td>
                    <td className="p-4">
                      {item.status === 'APPROVED' ? <span className="text-emerald-700 bg-emerald-100 px-3 py-1 rounded-full text-xs font-bold">مُعتمد</span> :
                        item.status === 'REJECTED' ? <span className="text-rose-700 bg-rose-100 px-3 py-1 rounded-full text-xs font-bold">مرفوض</span> :
                          <span className="text-amber-700 bg-amber-100 px-3 py-1 rounded-full text-xs font-bold">قيد المراجعة</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${wide ? 'col-span-1 md:col-span-2' : ''}`}>
      <span className="text-[12px] font-extrabold text-slate-700 block mb-2">{label}</span>
      {children}
    </label>
  );
}

function SmallField({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${wide ? 'lg:col-span-2' : ''}`}>
      <span className="text-[11px] font-extrabold text-slate-600 block mb-2">{label}</span>
      {children}
    </label>
  );
}

function SubmitButton({ busy, disabled, className, children }: { busy: boolean; disabled: boolean; className: string; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={disabled} className={`mt-8 px-10 py-4 text-white font-black rounded-xl w-full flex justify-center items-center gap-2 shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed ${className}`}>
      {busy ? 'جاري الإرسال...' : children} {!busy && <CheckCircle size={18} />}
    </button>
  );
}
