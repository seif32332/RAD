"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronRight, Save, AlertCircle, CalendarDays, User, Calculator, Info, CheckCircle, RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate, inclusiveDays } from '@/lib/dates';
import { formatMoney, roundMoney, sumMoney } from '@/lib/money';
import {
  BEREAVEMENT_RELATIONS,
  BEREAVEMENT_RELATION_LABELS,
  EVENT_DATED_LEAVE_TYPES,
  isSaudiNationality,
  isStatutoryLeaveType,
  LEAVE_ISSUE_MESSAGES,
  LEAVE_TYPE_LABELS,
  MAX_LEAVE_DAYS,
  type BereavementRelation,
  type LeaveRequestIssue,
  type LeaveTypeCode,
  type SickLeaveTiers,
} from '@/lib/leave';

const LEAVE_TYPE_ICONS: Record<LeaveTypeCode, string> = {
  ANNUAL: '🏖️', DEDUCTED: '✂️', EMERGENCY: '🚨', SICK: '🏥', UNPAID: '📋',
  MATERNITY: '🤱', PATERNITY: '👶', BEREAVEMENT: '🕊️', MARRIAGE: '💍', HAJJ: '🕋',
};
const LEAVE_TYPE_ORDER: LeaveTypeCode[] = ['ANNUAL', 'DEDUCTED', 'EMERGENCY', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY', 'MARRIAGE', 'BEREAVEMENT', 'HAJJ'];
const EVENT_DATE_LABELS: Record<string, string> = { PATERNITY: 'تاريخ الولادة', MARRIAGE: 'تاريخ الزواج', BEREAVEMENT: 'تاريخ الوفاة' };

interface LeaveEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  nationality?: string | null;
  joinDate?: string | null;
  leaveAccrualStartDate?: string | null;
  basicSalary?: number | null;
  isTerminated?: boolean | null;
  allowances?: { id?: string; amount?: number | null; isMonthly?: boolean | null }[];
  legalCompany?: { nameArabic?: string | null } | null;
}

interface BalanceResponse { available?: number | null }

/** GET /api/leaves/preview: the server's own calculation (same code as POST /api/leaves). */
interface LeavePreview {
  totalDays: number;
  balance: { available: number };
  dailyRate: number;
  paidDays: number;
  unpaidDays: number;
  totalDeduction: number;
  sickTiers: SickLeaveTiers | null;
  issue: LeaveRequestIssue;
  issueMessage: string | null;
  needsVisa: boolean;
  exitReentryVisaCost: number;
  /** Statutory leave types: paid-day entitlement (null for other types). */
  entitlementDays?: number | null;
  consumesAnnualBalance?: boolean;
  statutory?: { serviceYears?: number; priorHajjLeaves?: number; provisional?: boolean } | null;
}

interface CreatedLeave { paidDays?: number | null; unpaidDays?: number | null; totalDeduction?: number | null; totalDays?: number | null }

interface FormState {
  employeeId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  notes: string;
  isOutsideKSA: boolean;
  acceptUnpaidExtraDays: boolean;
  /** PATERNITY / MARRIAGE / BEREAVEMENT: date of the event (optional). */
  eventDate: string;
  bereavementRelation: BereavementRelation;
}

const INITIAL_FORM: FormState = {
  employeeId: '',
  leaveType: 'ANNUAL',
  startDate: '',
  endDate: '',
  notes: '',
  isOutsideKSA: false,
  acceptUnpaidExtraDays: false,
  eventDate: '',
  bereavementRelation: 'FIRST_DEGREE',
};

export default function NewLeavePage() {
  const router = useRouter();
  const [employees, setEmployees] = useState<LeaveEmployee[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormState>(INITIAL_FORM);

  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState(false);

  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadEmployees = useCallback(async () => {
    setIsLoadingEmployees(true);
    setEmployeesError(null);
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        setEmployeesError(await readApiError(res, 'تعذر جلب قائمة الموظفين'));
        return;
      }
      const d: unknown = await res.json();
      setEmployees(Array.isArray(d) ? (d as LeaveEmployee[]).filter((e) => !e.isTerminated) : []);
    } catch {
      setEmployeesError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoadingEmployees(false);
    }
  }, []);

  useEffect(() => {
    void loadEmployees();
    // Prefill from /leaves/new?employeeId=... (entitlement schedule link).
    const pre = new URLSearchParams(window.location.search).get('employeeId');
    if (pre) setFormData((f) => ({ ...f, employeeId: pre }));
  }, [loadEmployees]);

  // Balance as of the leave start date, from the single server-side formula.
  useEffect(() => {
    if (!formData.employeeId) {
      setBalance(null);
      setBalanceError(false);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ employeeId: formData.employeeId });
    if (formData.startDate) params.set('asOf', formData.startDate);
    setBalanceLoading(true);
    setBalanceError(false);
    fetch(`/api/leaves/balance?${params.toString()}`, { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          window.location.assign('/login');
          return;
        }
        if (!res.ok) {
          setBalance(null);
          setBalanceError(true);
          return;
        }
        const data = (await res.json()) as BalanceResponse;
        if (cancelled) return;
        const available = typeof data.available === 'number' ? data.available : null;
        setBalance(available);
        setBalanceError(available === null);
      })
      .catch(() => {
        if (!cancelled) {
          setBalance(null);
          setBalanceError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formData.employeeId, formData.startDate]);

  // Server-side calculation of the request (debounced). The form only displays these numbers.
  useEffect(() => {
    const { employeeId, leaveType, startDate, endDate, acceptUnpaidExtraDays, isOutsideKSA, eventDate, bereavementRelation } = formData;
    if (!employeeId || !startDate || !endDate || endDate < startDate) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      employeeId,
      leaveType,
      startDate,
      endDate,
      acceptUnpaidExtraDays: String(acceptUnpaidExtraDays),
      isOutsideKSA: String(isOutsideKSA),
    });
    if (EVENT_DATED_LEAVE_TYPES.includes(leaveType) && eventDate) params.set('eventDate', eventDate);
    if (leaveType === 'BEREAVEMENT') params.set('bereavementRelation', bereavementRelation);
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/leaves/preview?${params.toString()}`, { cache: 'no-store' })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 401) {
            window.location.assign('/login');
            return;
          }
          if (!res.ok) {
            const msg = await readApiError(res, 'تعذر احتساب الإجازة');
            if (cancelled) return;
            setPreview(null);
            setPreviewError(msg);
            return;
          }
          const data = (await res.json()) as LeavePreview;
          if (cancelled) return;
          setPreview(data);
          setPreviewError(null);
        })
        .catch(() => {
          if (!cancelled) {
            setPreview(null);
            setPreviewError('تعذر الاتصال بالخادم');
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [formData]);

  const handleChange = (e: { target: { name: string; value: string; type?: string; checked?: boolean } }) => {
    const { name, value, type, checked } = e.target;
    setFormData((f) => ({ ...f, [name]: type === 'checkbox' ? !!checked : value }));
  };

  const selectedEmployee = employees.find((e) => e.id === formData.employeeId);
  const isSaudi = isSaudiNationality(selectedEmployee?.nationality);
  const monthlySalary = selectedEmployee
    ? sumMoney([selectedEmployee.basicSalary ?? 0, ...(selectedEmployee.allowances || []).filter((a) => a.isMonthly !== false).map((a) => a.amount ?? 0)])
    : 0;

  // --- Numbers computed by the server (GET /api/leaves/preview); the form never computes them itself ---
  const calculations = useMemo(() => {
    if (!selectedEmployee || !preview) return null;
    return {
      totalDays: preview.totalDays,
      availableBalance: preview.balance.available,
      dailyRate: preview.dailyRate,
      paidDays: preview.paidDays,
      unpaidDays: preview.unpaidDays,
      totalDeduction: preview.totalDeduction,
      sickTiers: preview.sickTiers,
      issue: preview.issue,
      needsVisa: preview.needsVisa,
      exitReentryVisaCost: preview.exitReentryVisaCost,
      issueMessage: preview.issueMessage,
      entitlementDays: preview.entitlementDays ?? null,
    };
  }, [selectedEmployee, preview]);
  const requestedDays =
    formData.startDate && formData.endDate && formData.endDate >= formData.startDate ? inclusiveDays(formData.startDate, formData.endDate) : null;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;
    setErrorMsg(null);

    if (!formData.employeeId) {
      setErrorMsg('يرجى اختيار الموظف');
      return;
    }
    if (formData.endDate < formData.startDate) {
      setErrorMsg('تاريخ نهاية الإجازة يجب أن يكون بعد تاريخ البداية أو مساوياً له');
      return;
    }
    if (requestedDays !== null && requestedDays > MAX_LEAVE_DAYS) {
      setErrorMsg(`مدة الإجازة لا يمكن أن تتجاوز ${MAX_LEAVE_DAYS} يوماً`);
      return;
    }
    if (calculations?.issue) {
      setErrorMsg(calculations.issueMessage || LEAVE_ISSUE_MESSAGES[calculations.issue]);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/leaves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: formData.employeeId,
          leaveType: formData.leaveType,
          startDate: formData.startDate,
          endDate: formData.endDate,
          notes: formData.notes,
          isOutsideKSA: formData.isOutsideKSA,
          acceptUnpaidExtraDays: formData.acceptUnpaidExtraDays,
          ...(EVENT_DATED_LEAVE_TYPES.includes(formData.leaveType) && formData.eventDate ? { eventDate: formData.eventDate } : {}),
          ...(formData.leaveType === 'BEREAVEMENT' ? { bereavementRelation: formData.bereavementRelation } : {}),
        }),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تسجيل طلب الإجازة');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      const data = (await res.json().catch(() => null)) as { leave?: CreatedLeave } | null;
      const saved = data?.leave;
      toast.success(
        saved
          ? `تم تسجيل طلب الإجازة بنجاح: ${saved.totalDays ?? 0} يوم (مدفوعة ${saved.paidDays ?? 0}، بدون أجر ${saved.unpaidDays ?? 0})${(saved.totalDeduction ?? 0) > 0 ? `، خصم ${formatMoney(saved.totalDeduction)} ر.س` : ''}`
          : 'تم تسجيل طلب الإجازة بنجاح',
      );
      router.push('/leaves');
    } catch {
      setErrorMsg('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const sickBeyond = formData.leaveType === 'SICK' && (calculations?.sickTiers?.beyond ?? 0) > 0;
  const isStatutory = isStatutoryLeaveType(formData.leaveType);
  const statutoryIssue = isStatutory && calculations?.issue && calculations.issue !== 'STATUTORY_EXTENSION_NOT_ACCEPTED' ? calculations.issue : null;
  const maternityExtension = formData.leaveType === 'MATERNITY' && !!calculations && calculations.unpaidDays > 0;
  const accrualDate = selectedEmployee?.leaveAccrualStartDate || selectedEmployee?.joinDate;

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        <div>
          <Link href="/leaves" className="inline-flex items-center gap-2 text-slate-400 hover:text-teal-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-teal-200 transition"><ChevronRight size={16} /></span>
            العودة لسجل الإجازات
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-teal-100 text-teal-600 p-3 rounded-2xl"><CalendarDays size={26} /></span>
            طلب إجازة جديد
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">يتم الاحتساب تلقائياً حسب رصيد الموظف وسياسات الشركة، ويعيد الخادم التحقق عند الحفظ.</p>
        </div>

        {employeesError && (
          <div className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px] flex-1">{employeesError}</p>
            <button type="button" onClick={() => void loadEmployees()} className="flex items-center gap-2 bg-white border border-red-200 text-red-700 px-4 py-2 rounded-xl font-bold text-[12px] hover:bg-red-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {errorMsg && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px]">{errorMsg}</p>
          </div>
        )}

        <form id="leave-form" onSubmit={handleSubmit} className="space-y-8">

          {/* 1. الموظف والنوع */}
          <Section title="بيانات الموظف ونوع الإجازة" icon={<User size={16} className="text-blue-600" />} badge="مطلوب">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <SearchableSelect name="employeeId" value={formData.employeeId} onChange={handleChange} label="الموظف (بالرقم الوظيفي)" required accentColor="teal"
                disabled={isLoadingEmployees}
                placeholder={isLoadingEmployees ? 'جاري تحميل الموظفين...' : undefined}
                options={employees.map((e) => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''}`, value: e.id }))} />
              <SearchableSelect name="leaveType" value={formData.leaveType} onChange={handleChange} label="نوع الإجازة" required accentColor="teal"
                options={LEAVE_TYPE_ORDER.map((t) => ({ label: `${LEAVE_TYPE_ICONS[t]} ${LEAVE_TYPE_LABELS[t]}`, value: t }))} />
            </div>

            {selectedEmployee && (
              <div className="bg-blue-50 border border-blue-100 rounded-[1.5rem] p-6 mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                <InfoBox label="الجنسية" value={selectedEmployee.nationality || '-'} highlight={isSaudi} />
                <InfoBox label="تاريخ احتساب الإجازة" value={accrualDate ? formatDate(accrualDate) : '-'} />
                <InfoBox label="الراتب الإجمالي" value={`${formatMoney(monthlySalary)} ر.س`} />
                <InfoBox label="الشركة" value={selectedEmployee.legalCompany?.nameArabic || '-'} />
              </div>
            )}
          </Section>

          {/* 2. تواريخ الإجازة */}
          <Section title="تفاصيل الإجازة" icon={<CalendarDays size={16} className="text-teal-500" />} badge="تواريخ">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field name="startDate" value={formData.startDate} onChange={handleChange} label="تاريخ بداية الإجازة" type="date" required />
              <Field name="endDate" value={formData.endDate} onChange={handleChange} label="تاريخ نهاية الإجازة" type="date" required min={formData.startDate || undefined} />
            </div>

            {isStatutory && (
              <div className="mt-6 space-y-4">
                {EVENT_DATED_LEAVE_TYPES.includes(formData.leaveType) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Field name="eventDate" value={formData.eventDate} onChange={handleChange} label={`${EVENT_DATE_LABELS[formData.leaveType] ?? 'تاريخ الواقعة'} (اختياري - للتحقق من المدة النظامية)`} type="date" />
                    {formData.leaveType === 'BEREAVEMENT' && (
                      <div className="flex flex-col gap-2">
                        <label htmlFor="bereavement-relation" className="text-[12px] font-extrabold text-slate-700">صلة القرابة بالمتوفى</label>
                        <select id="bereavement-relation" name="bereavementRelation" value={formData.bereavementRelation} onChange={handleChange}
                          className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-teal-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-100 transition-all appearance-none cursor-pointer">
                          {BEREAVEMENT_RELATIONS.map((r) => <option key={r} value={r}>{BEREAVEMENT_RELATION_LABELS[r]}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}
                <div className="bg-sky-50 border border-sky-200 rounded-2xl p-4 flex items-start gap-3">
                  <Info className="text-sky-600 shrink-0 mt-0.5" size={18} />
                  <div className="text-[12px] font-bold text-sky-900 leading-relaxed space-y-1">
                    <p>
                      إجازة {LEAVE_TYPE_LABELS[formData.leaveType as LeaveTypeCode]}: إجازة نظامية بأجر كامل
                      {calculations?.entitlementDays != null ? ` (${calculations.entitlementDays} يوماً مستحقة)` : ''}، ولا تُخصم من رصيد الإجازة السنوية.
                    </p>
                    <p className="text-[11px] text-sky-700">المدد قيم افتراضية بانتظار تأكيد المستشار، ويمكن تعديلها من الإعدادات.</p>
                    {formData.leaveType === 'HAJJ' && (
                      <p className="text-[11px] text-sky-700">تُمنح مرة واحدة طوال الخدمة بعد مدة الخدمة المطلوبة. تحقق أن الموظف لم يسبق له أداء الحج.</p>
                    )}
                  </div>
                </div>
                {statutoryIssue && (
                  <div role="alert" className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
                    <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
                    <p className="text-[12px] font-bold text-red-700">{calculations?.issueMessage || LEAVE_ISSUE_MESSAGES[statutoryIssue]}</p>
                  </div>
                )}
                {maternityExtension && calculations && (
                  <label className="flex items-start gap-4 cursor-pointer p-5 bg-white rounded-2xl border-2 border-orange-200 shadow-sm hover:border-orange-400 transition">
                    <input type="checkbox" name="acceptUnpaidExtraDays" checked={formData.acceptUnpaidExtraDays} onChange={handleChange} className="mt-1 w-5 h-5 text-orange-600 rounded-md focus:ring-orange-500 border-gray-300 shrink-0" />
                    <span className="font-bold text-slate-700 text-[13px] leading-relaxed">
                      الموافقة على تمديد إجازة الوضع <span className="font-black text-orange-700">{calculations.unpaidDays} يوماً بدون أجر</span> بعد {calculations.paidDays} يوماً مدفوعة.
                    </span>
                  </label>
                )}
              </div>
            )}

            {/* inside/outside country */}
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <label htmlFor="leave-location" className="text-[12px] font-extrabold text-slate-700">مكان قضاء الإجازة</label>
                <select id="leave-location" value={formData.isOutsideKSA ? 'outside' : 'inside'} onChange={(e) => setFormData({ ...formData, isOutsideKSA: e.target.value === 'outside' })}
                  className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-teal-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-100 transition-all appearance-none cursor-pointer">
                  <option value="inside">🏠 داخل الدولة</option>
                  <option value="outside">✈️ خارج الدولة</option>
                </select>
              </div>
              <div className="flex flex-col gap-2 justify-end">
                <span className="text-[12px] font-extrabold text-slate-700">مدة الإجازة</span>
                <div className="px-5 py-4 bg-teal-50 border-2 border-teal-200 rounded-[1.25rem] font-black text-teal-700 text-center text-lg shadow-inner">
                  {calculations ? `${calculations.totalDays} يوم` : requestedDays !== null ? `${requestedDays} يوم` : '—'}
                </div>
                {selectedEmployee && (
                  <div className="text-center mt-1 bg-white border border-teal-100 py-1.5 px-3 rounded-lg shadow-sm">
                    <p className="text-[11px] font-bold text-slate-500">رصيد الإجازات المستحق{formData.startDate ? ' (في تاريخ البداية)' : ''}</p>
                    {balanceLoading ? (
                      <p className="text-[13px] font-black text-slate-400">جاري الحساب...</p>
                    ) : balanceError ? (
                      <p className="text-[12px] font-black text-rose-500">تعذر حساب الرصيد</p>
                    ) : (
                      <p className="text-[13px] font-black text-teal-600">
                        {balance ?? 0} يوم <span className="text-[10px] text-teal-400">({formatMoney(roundMoney((balance ?? 0) * (monthlySalary / 30)))} ر.س)</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {calculations && calculations.unpaidDays > 0 && formData.leaveType === 'ANNUAL' && (
              <div className="bg-orange-50/80 border-2 border-orange-200 rounded-[1.5rem] p-6 mt-6">
                <h4 className="font-black text-orange-900 text-[15px] mb-2 shadow-sm inline-block px-3 py-1 bg-white rounded-lg border border-orange-100">رصيد الإجازة لا يكفي!</h4>
                <p className="text-orange-900 text-[13px] font-bold mb-4 leading-relaxed">
                  طلب الموظف <span className="font-black text-orange-600">{calculations.totalDays} يوم</span> ورصيده <span className="font-black text-emerald-600">{calculations.availableBalance} يوم</span> فقط. هناك <span className="text-red-700 bg-red-100 px-2 py-0.5 rounded-md font-black">{calculations.unpaidDays} يوم</span> زيادة. هل ترغب في تحويل الأيام الزائدة لتكون إجازة بدون مرتب للتمكن من اعتماد الطلب؟
                </p>
                <label className="flex items-start gap-4 cursor-pointer p-5 bg-white rounded-2xl border-2 border-orange-200 shadow-sm hover:border-orange-400 transition relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-1.5 h-full bg-orange-400"></div>
                  <input type="checkbox" name="acceptUnpaidExtraDays" checked={formData.acceptUnpaidExtraDays} onChange={handleChange} className="mt-1 w-5 h-5 text-orange-600 rounded-md focus:ring-orange-500 border-gray-300 shrink-0" />
                  <div className="flex flex-col gap-1.5">
                    <span className="font-black text-slate-800 text-[14px]">إقرار تفويض وتعهد بالخصم</span>
                    <span className="font-bold text-slate-600 text-[13px] leading-relaxed">
                      أقر أنا الموظف ({selectedEmployee?.firstNameArabic} {selectedEmployee?.lastNameArabic}) بالموافقة على استقطاع تكلفة الأيام الزائدة عن رصيدي المستحق في طلب الإجازة والتي تقدرها الشركة. دون أدنى مسؤولية على الشركة.
                    </span>
                  </div>
                </label>
              </div>
            )}

            {previewLoading && (
              <p className="text-[12px] font-bold text-slate-400 mt-4">جاري احتساب الطلب على الخادم...</p>
            )}
            {previewError && !previewLoading && (
              <div role="alert" className="bg-red-50 border border-red-200 rounded-2xl p-4 mt-6 flex items-start gap-3">
                <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
                <p className="text-[12px] font-bold text-red-700">{previewError}</p>
              </div>
            )}

            {calculations?.issue === 'UNPAID_WITH_BALANCE' && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mt-6 flex items-start gap-3">
                <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
                <p className="text-[12px] font-bold text-red-700">{LEAVE_ISSUE_MESSAGES.UNPAID_WITH_BALANCE}</p>
              </div>
            )}

          </Section>

          {/* 3. ملاحظات */}
          <Section title="ملاحظات" icon={<Info size={16} className="text-slate-400" />} badge="اختياري">
            <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} placeholder="أي ملاحظات على الطلب..." aria-label="ملاحظات"
              className="w-full px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-teal-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-100 transition-all resize-none" />
          </Section>

          {/* ملخص الحسابات */}
          {calculations && selectedEmployee && (
            <div className="bg-slate-900 rounded-[2.5rem] p-8 md:p-10 shadow-2xl overflow-hidden relative">
              <Calculator className="absolute -left-10 -top-10 text-white/5" size={200} />
              <h3 className="text-white font-black text-xl mb-8 relative z-10 flex items-center gap-3">
                <span className="bg-white/10 p-2 rounded-xl border border-white/10"><CalendarDays size={20} className="text-teal-400" /></span>
                ملخص طلب الإجازة
              </h3>
              <div className="relative z-10 space-y-4">
                <CalcRow label="رصيد الإجازة المتاح الفعلي" sublabel="يخصم منه أي إجازات سابقة" amount={`${calculations.availableBalance} يوم`} color="text-teal-400" />
                <CalcRow label="أيام الإجازة المطلوبة (الرحلة)" amount={`${calculations.totalDays} يوم`} color="text-white" />

                <div className="border-t border-white/10 pt-4 mt-4 space-y-4">
                  <CalcRow label="أيام مستحقة (مدفوعة الأجر)" sublabel={isStatutory ? 'حسب المدة النظامية - لا تُخصم من الرصيد السنوي' : 'بناءً على الرصيد'} amount={`${calculations.paidDays} يوم`} color="text-emerald-400" />
                </div>

                {formData.leaveType === 'UNPAID' && (
                  <div className="bg-amber-500/10 rounded-2xl p-4 mt-4 border border-amber-500/20">
                    <p className="text-amber-400 font-bold text-[13px] text-center">إجازة غير مدفوعة - سيتم الخصم في مسير الرواتب</p>
                  </div>
                )}

                {formData.leaveType === 'DEDUCTED' && (
                  <div className="bg-emerald-500/10 rounded-2xl p-4 mt-4 border border-emerald-500/20">
                    <p className="text-emerald-400 font-bold text-[13px] text-center">الإجازة مستقطعة من الرصيد - <span className="text-white">سيتم خصم الأيام من الرصيد وتنزل بمقدارها في مسير الرواتب كالمعتاد دون سلفيات</span></p>
                  </div>
                )}

                {formData.leaveType === 'SICK' && calculations.sickTiers && (
                  <>
                    <div className="bg-violet-500/10 rounded-2xl p-4 mt-4 border border-violet-500/20">
                      <p className="text-violet-400 font-bold text-[14px] text-center mb-4">
                        تفاصيل وتوزيع الإجازة المرضية (النظام السعودي)
                      </p>
                      <div className="space-y-3">
                        <CalcRow label="إجمالي الأيام مسبقاً خلال آخر سنة" sublabel="سِجل إجازاته السابقة" amount={`${calculations.sickTiers.past} يوم`} color="text-violet-300" />
                        {calculations.sickTiers.full > 0 && <CalcRow label="أيام بأجر كامل (أول 30 يوم)" sublabel="من اليوم المطلوب" amount={`${calculations.sickTiers.full} يوم`} color="text-emerald-400" />}
                        {calculations.sickTiers.partial > 0 && <CalcRow label="أيام بـ 75% من الأجر (31 لـ 90)" sublabel="خصم 25%" amount={`${calculations.sickTiers.partial} يوم`} color="text-amber-400" />}
                        {calculations.sickTiers.unpaid > 0 && <CalcRow label="أيام بدون أجر (91 لـ 120)" sublabel="مخصومة 100%" amount={`${calculations.sickTiers.unpaid} يوم`} color="text-rose-400" />}
                      </div>
                    </div>
                    {calculations.sickTiers.beyond > 0 && (
                      <div className="bg-red-500/20 border border-red-500/30 rounded-2xl p-4 mt-4">
                        <p className="text-red-400 font-black text-[14px] text-center mb-1">⚠️ تجاوز الحد الأقصى</p>
                        <p className="text-red-200 font-bold text-[12px] text-center leading-relaxed">
                          {LEAVE_ISSUE_MESSAGES.SICK_LIMIT_EXCEEDED} لا يمكن تسجيل إجازة مرضية إضافية، وقد يصل الموقف لـ &quot;إنهاء العقد&quot;.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {calculations.totalDeduction > 0 && (
                  <div className="border-t border-white/10 pt-4 mt-4 space-y-4">
                    <CalcRow label="الخصم المتوقع في مسير الرواتب" sublabel={`على أساس الأجر اليومي ${formatMoney(calculations.dailyRate)} ر.س (الراتب الأساسي / 30)`} amount={`- ${formatMoney(calculations.totalDeduction)} ر.س`} color="text-rose-400 font-black" />
                  </div>
                )}

                {formData.leaveType === 'ANNUAL' && (
                  <div className="bg-orange-500/10 rounded-2xl p-5 mt-6 border border-orange-500/20 text-center">
                    <p className="text-orange-400 font-bold text-[14px] mb-2">ملاحظة هامة بشأن صرف المستحقات 💡</p>
                    <p className="text-orange-200 text-[12px] leading-relaxed">
                      هذه الشاشة مخصصة فقط لاحتساب أيام الإجازة واعتمادها برصيد الموظف.
                      <br /><br />
                      لإصدار مستحقات الإجازة مالياً (رواتب أيام العمل وبدل الإجازة)، يرجى رفع هذا الطلب أولاً ليتم اعتماده، ثم التوجه لشاشة <strong className="text-white">تصفية المستحقات</strong> لعمل مخالصة الإجازة النظامية.
                    </p>
                  </div>
                )}

                {calculations.unpaidDays > 0 && formData.leaveType !== 'SICK' && (
                  <div className="border-t border-white/10 pt-4 mt-4 space-y-4">
                    <CalcRow label={formData.leaveType === 'UNPAID' ? 'أيام غير مدفوعة الأجر' : formData.leaveType === 'MATERNITY' ? 'أيام تمديد إجازة الوضع (بدون أجر)' : 'أيام التجاوز (بدون رصيد)'} amount={`${calculations.unpaidDays} ${formData.leaveType === 'UNPAID' ? 'يوم' : 'يوم إضافي'}`} color="text-orange-400" />
                    <div className="bg-slate-800/50 border border-slate-700/50 p-4 rounded-xl flex items-start gap-3 mt-4">
                      <div className="mt-1 text-emerald-400"><CheckCircle size={20} /></div>
                      <div>
                        <p className="font-bold text-white text-[13px] mb-1">إقرار وتفويض بالخصم</p>
                        <p className="text-slate-400 text-[11px] leading-relaxed">
                          أقرّ وأوافق على منح الشركة الحق في خصم تكلفة أيام الإجازة الزائدة المطلوبة عن رصيدي المستحق، وذلك وفق ما تراه الشركة مناسبًا، دون أدنى مسؤولية على الشركة.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {calculations.needsVisa && (
                  <CalcRow label="إجازة خارج المملكة - تأشيرة خروج وعودة" sublabel="تُفتح معاملة التأشيرة وطلب السداد عند اعتماد الموارد البشرية" amount={`${formatMoney(calculations.exitReentryVisaCost)} ر.س ✈️`} color="text-slate-300" />
                )}
              </div>
            </div>
          )}
        </form>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/leaves" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">إلغاء</Link>
        <button type="submit" form="leave-form" disabled={isSubmitting || sickBeyond || balanceLoading || previewLoading}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg flex items-center gap-2">
          {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isSubmitting ? 'جاري الحفظ...' : 'تسجيل طلب الإجازة'}
        </button>
      </div>
    </DashboardLayout>
  );
}

function CalcRow({ label, sublabel, amount, color }: { label: string; sublabel?: string; amount: string; color: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/5">
      <div><p className="text-white font-bold text-[14px]">{label}</p>{sublabel && <p className="text-white/40 text-[11px] font-semibold">{sublabel}</p>}</div>
      <span className={`font-black text-lg ${color}`}>{amount}</span>
    </div>
  );
}

function InfoBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (<div><p className="text-[10px] font-bold text-blue-500 mb-1">{label}</p><p className={`font-black text-[14px] ${highlight ? 'text-emerald-700' : 'text-blue-900'}`}>{value}</p></div>);
}

function Section({ title, badge, icon, children }: { title: string; badge: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-visible">
      <div className="px-8 py-5 border-b border-slate-100 flex items-center gap-3">
        <span className="w-9 h-9 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center">{icon}</span>
        <h2 className="font-extrabold text-[15px] text-slate-800">{title}</h2>
        <span className="mr-auto text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 px-2.5 py-1 rounded-lg">{badge}</span>
      </div>
      <div className="p-8">{children}</div>
    </div>
  );
}

function Field({ name, value, onChange, label, type = 'text', required = false, placeholder, min }: {
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
}) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-2 group">
      <label htmlFor={id} className="text-[12px] font-extrabold text-slate-700">{label} {required && <span className="text-red-500">*</span>}</label>
      <input id={id} type={type} name={name} value={value} onChange={onChange} required={required} placeholder={placeholder} min={min}
        {...(type === 'date' ? { dir: 'ltr', lang: 'en' } : {})}
        className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-teal-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-100 transition-all" />
    </div>
  );
}

