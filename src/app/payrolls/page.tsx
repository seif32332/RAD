"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Wallet, CheckCircle, XCircle, Clock, FileText, AlertTriangle, Plus, DollarSign, PiggyBank, Download, RefreshCw, Info } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { DEDUCTION_STATUS, PAYROLL_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';
import { formatDate, riyadhDateKey } from '@/lib/dates';
import { formatMoney, roundMoney, sumMoney } from '@/lib/money';
import {
  countPayrollReviewKeys,
  PAYROLL_REVIEW_LABELS,
  payrollReviewKeys,
  reviewNoteText,
  type PayrollReviewFilterKey,
} from '@/lib/payroll-core';

interface NamedRef { nameArabic?: string | null }

interface EmployeeRef {
  id?: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  basicSalary?: number | null;
  nationality?: string | null;
  gosiRegime?: string | null;
  branch?: NamedRef | null;
}

interface Employee extends EmployeeRef {
  id: string;
  isTerminated?: boolean | null;
  employmentStatus?: string | null;
  joinDate?: string | null;
  createdAt?: string | null;
  terminationDate?: string | null;
}

/** One payroll row with its STORED breakdown (written at generation time). */
interface Payroll {
  id: string;
  employeeId: string;
  employee?: EmployeeRef | null;
  month: number;
  year: number;
  basicSalary: number;
  totalAllowances: number;
  overtimeCost: number;
  totalDeductions: number;
  netSalary: number;
  status: string;
  gosiEmployee?: number | null;
  gosiEmployer?: number | null;
  loansDeduction?: number | null;
  violationsDeduction?: number | null;
  leaveDeduction?: number | null;
  otherDeductions?: number | null;
  bonusAmount?: number | null;
  needsReview?: boolean | null;
  reviewNote?: string | null;
  /** null for rows generated before the breakdown columns existed (split unknown). */
  breakdown?: { loanInstallments: number; penalties: number; gosi: number; other: number } | null;
}

interface Overtime {
  id: string;
  employeeId: string;
  employee?: EmployeeRef | null;
  date: string;
  hours?: number | null;
  amount?: number | null;
  reason?: string | null;
  status: string;
}

interface Deduction {
  id: string;
  employeeId: string;
  employee?: EmployeeRef | null;
  date: string;
  amount: number;
  reason: string;
  status: string;
}

interface Loan {
  id: string;
  employeeId: string;
  employee?: EmployeeRef | null;
  amount: number;
  remainingAmount: number;
  monthlyInstallment: number;
  reason?: string | null;
  isForgiven?: boolean | null;
  status: string;
}

interface HubData {
  payrolls: Payroll[];
  overtimes: Overtime[];
  deductions: Deduction[];
  loans: Loan[];
}

/** GET /api/payroll-hub/summary (server totals from the stored rows). */
interface PayrollTotals {
  basicSalary: number;
  recurringAllowances: number;
  bonusAmount: number;
  totalAllowances: number;
  overtimeCost: number;
  gross: number;
  gosiEmployee: number;
  leaveDeduction: number;
  loansDeduction: number;
  violationsDeduction: number;
  otherDeductions: number;
  totalDeductions: number;
  netSalary: number;
  gosiEmployer: number;
  employerCost: number;
}

interface MonthSummary {
  month: number;
  year: number;
  count: number;
  byStatus: Record<string, number>;
  needsReviewCount: number;
  /** Flagged rows per review code (older servers do not send it). */
  reviewCounts?: Partial<Record<PayrollReviewFilterKey, number>>;
  legacyRows: number;
  totals: PayrollTotals;
  provisionalRates: Array<{ regime: string; isSaudi: boolean; effectiveFrom: string; employeeRate: number; employerRate: number }>;
  newRegimeCount: number;
}

interface MonthEntry {
  year: number;
  month: number;
  count: number;
  netSalary: number;
  byStatus: Record<string, number>;
  netByStatus: Record<string, number>;
}

interface Period { month: number; year: number }

const EMPTY_HUB: HubData = { payrolls: [], overtimes: [], deductions: [], loans: [] };
const EMPTY_DEDUCTION = { employeeId: '', date: '', amount: '', reason: '' };
const EMPTY_LOAN = { employeeId: '', amount: '', monthlyInstallment: '', reason: '' };
const EMPTY_OVERTIME = { employeeId: '', date: '', hours: '', amount: '', type: 'HOURS', reason: '' };

const DEDUCTION_STATUS_LABELS: Record<string, string> = {
  [DEDUCTION_STATUS.DEDUCTED]: 'مجدول للخصم بالراتب',
  [DEDUCTION_STATUS.OBJECTION_REJECTED]: 'مجدول للخصم بالراتب',
  COMPLETED: 'تم خصمه',
  [DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL]: 'بانتظار تقدير المبلغ',
  [DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL]: 'بانتظار قرار الإسقاط',
  [DEDUCTION_STATUS.WAIVED]: 'مُسقط',
  [DEDUCTION_STATUS.PENDING_INVESTIGATION]: 'بانتظار التحقيق',
  [DEDUCTION_STATUS.UNDER_INVESTIGATION]: 'قيد التحقيق',
  [DEDUCTION_STATUS.OBJECTION_SUBMITTED]: 'معترض عليه',
  [DEDUCTION_STATUS.REJECTED]: 'مرفوض',
};

const REGIME_LABELS: Record<string, string> = { OLD: 'قديم', NEW: 'جديد', UNKNOWN: 'غير مؤكد' };
const STATUS_LABELS: Record<string, string> = { DRAFT: 'مسودة', APPROVED: 'معتمد', PAID: 'مسدد' };

/** Visible note on the review sheet / export (DEC-002). */
const EXPORT_NOTE = 'كشف للمراجعة الداخلية — ليس ملف حماية الأجور (WPS)';

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const fullName = (e?: EmployeeRef | null) => `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim() || '—';
const toNum = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** One money format for the whole page (src/lib/money.ts). */
const money = (v: unknown) => formatMoney(toNum(v));
/** Review filter: every row, every flagged row, or flagged rows carrying one code. */
type ReviewFilter = 'ALL' | 'REVIEW' | PayrollReviewFilterKey;
/** "label: count" lines of the review codes present in `counts` (largest first). */
function reviewCountLines(counts: Partial<Record<PayrollReviewFilterKey, number>>): string[] {
  return (Object.entries(counts) as Array<[PayrollReviewFilterKey, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `• ${PAYROLL_REVIEW_LABELS[k] ?? k}: ${n}`);
}
const periodKey = (p: Period) => `${p.year}-${p.month}`;

/** Year/month of a stored date-only value (UTC midnight). */
function ymOf(d: string | null | undefined): { y: number; m: number } | null {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1 };
}

/** Current payroll month in the Riyadh calendar (not the browser's time zone). */
function riyadhPeriod(): Period {
  const [y, m] = (riyadhDateKey(new Date()) ?? '').split('-').map(Number);
  return { year: y || new Date().getFullYear(), month: m || new Date().getMonth() + 1 };
}

/** Stored breakdown is complete when its columns add up to totalDeductions. */
const hasBreakdown = (p: Payroll) => !!p.breakdown;

export default function PayrollsPage() {
  const { role } = useRole();
  const canMarkPaid = roleIn(role, ROLE_GROUPS.FINANCE);
  const [activeTab, setActiveTab] = useState('CURRENT'); // CURRENT, HISTORY, SHEET, OVERTIME, DEDUCTIONS
  const [data, setData] = useState<HubData>(EMPTY_HUB);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [period, setPeriod] = useState<Period | null>(null);
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [months, setMonths] = useState<MonthEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payingMonth, setPayingMonth] = useState<string | null>(null);
  const [selectedPayroll, setSelectedPayroll] = useState<Payroll | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('ALL');

  // Form states for deductions/loans
  const [deductionForm, setDeductionForm] = useState(EMPTY_DEDUCTION);
  const [loanForm, setLoanForm] = useState(EMPTY_LOAN);
  const [overtimeForm, setOvertimeForm] = useState(EMPTY_OVERTIME);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Loads the month summary (server totals; picks the latest draft month when no period is set),
   * the payroll rows of that month only, the other hub lists and the employees.
   */
  const fetchHubData = useCallback(async (opts: { silent?: boolean; period?: Period | null } = {}) => {
    if (!opts.silent) setIsLoading(true);
    setLoadError(null);
    try {
      const wanted = opts.period ?? null;
      const summaryUrl = wanted ? `/api/payroll-hub/summary?month=${wanted.month}&year=${wanted.year}` : '/api/payroll-hub/summary';
      const [sumRes, listsRes, empRes] = await Promise.all([
        fetch(summaryUrl),
        fetch('/api/payroll-hub?sections=overtimes,deductions,loans'),
        fetch('/api/employees'),
      ]);
      if (sumRes.status === 401 || listsRes.status === 401 || empRes.status === 401) return redirectToLogin();
      if (!sumRes.ok) {
        setLoadError(await readApiError(sumRes, 'تعذر تحميل ملخص الرواتب'));
        return;
      }
      if (!listsRes.ok) {
        setLoadError(await readApiError(listsRes, 'تعذر تحميل السجلات المالية'));
        return;
      }
      const sumJson = await sumRes.json();
      const nextSummary: MonthSummary | null = sumJson?.summary ?? null;
      const nextPeriod: Period = wanted ?? (nextSummary ? { month: nextSummary.month, year: nextSummary.year } : riyadhPeriod());
      setSummary(nextSummary);
      setMonths(Array.isArray(sumJson?.months) ? sumJson.months : []);
      setPeriod(nextPeriod);

      // Payroll rows of the selected month only (never every payroll ever).
      const payRes = await fetch(`/api/payroll-hub?sections=payrolls&month=${nextPeriod.month}&year=${nextPeriod.year}`);
      if (payRes.status === 401) return redirectToLogin();
      if (!payRes.ok) {
        setLoadError(await readApiError(payRes, 'تعذر تحميل مسير الرواتب'));
        return;
      }
      const payJson = await payRes.json();
      const lists = await listsRes.json();
      setData({
        payrolls: Array.isArray(payJson?.payrolls) ? payJson.payrolls : [],
        overtimes: Array.isArray(lists?.overtimes) ? lists.overtimes : [],
        deductions: Array.isArray(lists?.deductions) ? lists.deductions : [],
        loans: Array.isArray(lists?.loans) ? lists.loans : [],
      });
      if (empRes.ok) {
        const emps = await empRes.json();
        if (Array.isArray(emps)) setEmployees(emps);
      } else {
        toast.error(await readApiError(empRes, 'تعذر تحميل قائمة الموظفين'));
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHubData();
  }, [fetchHubData]);

  const refresh = () => fetchHubData({ silent: true, period });

  const selectPeriod = (p: Period) => {
    fetchHubData({ period: p });
  };

  /** POST to the payroll hub; returns true on success (toasts the server message). */
  const postHub = async (body: Record<string, unknown>, successFallback: string): Promise<boolean> => {
    const res = await fetch('/api/payroll-hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) {
      redirectToLogin();
      return false;
    }
    if (!res.ok) {
      toast.error(await readApiError(res));
      return false;
    }
    const json = await res.json().catch(() => null);
    toast.success(typeof json?.message === 'string' ? json.message : successFallback);
    return true;
  };

  const handleOvertimeAction = async (id: string, status: 'APPROVED' | 'REJECTED') => {
    if (!(await confirmDialog(`هل أنت متأكد من ${status === 'APPROVED' ? 'اعتماد' : 'رفض'} طلب العمل الإضافي؟`, { danger: status === 'REJECTED' }))) return;
    setBusyId(id);
    try {
      if (await postHub({ actionType: 'UPDATE_OVERTIME_STATUS', payload: { id, status } }, 'تم تحديث طلب العمل الإضافي')) {
        await refresh();
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  const handleAddDeduction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (await postHub({ actionType: 'CREATE_DEDUCTION', payload: deductionForm }, 'تم إدراج الخصم بنجاح!')) {
        setDeductionForm(EMPTY_DEDUCTION);
        await refresh();
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const target = period ?? riyadhPeriod();

  const handleGeneratePayroll = async () => {
    if (!(await confirmDialog(`هل أنت متأكد من توليد مسير الرواتب المبدئي (Draft) لشهر ${target.month}/${target.year}؟ سيتم احتساب جميع الخصومات والبدلات آلياً.`))) return;
    setIsGenerating(true);
    try {
      const res = await fetch('/api/payroll-hub/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: target.month, year: target.year })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء المعالجة المالية.'));
        return;
      }
      const json = await res.json().catch(() => null);
      toast.success(typeof json?.message === 'string' ? json.message : 'تم توليد الكشوفات الجارية بنجاح! يمكنك الآن مراجعتها واعتمادها.');
      await fetchHubData({ silent: true, period: target });
    } catch {
      toast.error('حدث خطأ أثناء المعالجة المالية.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddLoan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (await postHub({ actionType: 'CREATE_LOAN', payload: loanForm }, 'تم تسجيل السلفة بنجاح!')) {
        setLoanForm(EMPTY_LOAN);
        await refresh();
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddOvertime = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!overtimeForm.hours && !overtimeForm.amount) {
      toast.warning('أدخل عدد الساعات الإضافية أو مبلغاً مقطوعاً');
      return;
    }
    setIsSubmitting(true);
    try {
      // Hours -> HOURS (paid at the overtime rate); amount only -> LUMP_SUM (the server requires one or the other).
      const payload = overtimeForm.hours
        ? { ...overtimeForm, type: 'HOURS', amount: '' }
        : { ...overtimeForm, type: 'LUMP_SUM', hours: '' };
      if (await postHub({ actionType: 'CREATE_OVERTIME_ASSIGNMENT', payload }, 'تم تسجيل وتكليف العمل الإضافي بنجاح!')) {
        setOvertimeForm(EMPTY_OVERTIME);
        await refresh();
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const pendingOvertimes = data.overtimes.filter((o) => o.status === 'PENDING');
  const pastOvertimes = data.overtimes.filter((o) => o.status !== 'PENDING');

  // Rows of the selected month only (loaded by month from the server).
  const currentPayrolls = data.payrolls.filter((p) => p.status === PAYROLL_STATUS.DRAFT);
  const pastPayrolls = data.payrolls.filter((p) => p.status === PAYROLL_STATUS.PAID || p.status === PAYROLL_STATUS.APPROVED);
  const tabPayrolls = activeTab === 'CURRENT' ? currentPayrolls : activeTab === 'SHEET' ? data.payrolls : pastPayrolls;
  const tabReviewCounts = countPayrollReviewKeys(tabPayrolls);
  const tabReviewTotal = tabPayrolls.filter((p) => p.needsReview).length;
  // A code filter that no row of this tab carries falls back to "all rows".
  const effectiveReviewFilter: ReviewFilter =
    reviewFilter === 'ALL' || reviewFilter === 'REVIEW' || (tabReviewCounts[reviewFilter] ?? 0) > 0 ? reviewFilter : 'ALL';
  const activePayrolls = tabPayrolls.filter((p) => {
    if (effectiveReviewFilter === 'ALL') return true;
    if (!p.needsReview) return false;
    return effectiveReviewFilter === 'REVIEW' || payrollReviewKeys(p).includes(effectiveReviewFilter);
  });
  const draftCount = summary?.byStatus?.[PAYROLL_STATUS.DRAFT] ?? 0;
  const draftReviewCount = currentPayrolls.filter((p) => p.needsReview).length;
  const draftNet = (period && months.find((m) => m.year === period.year && m.month === period.month)?.netByStatus?.[PAYROLL_STATUS.DRAFT]) || 0;

  const handleApprovePayrolls = async () => {
    if (!period) return;
    const reviewLines = reviewCountLines(countPayrollReviewKeys(currentPayrolls));
    const reviewWarning = draftReviewCount > 0
      ? `\n\nتنبيه: ${draftReviewCount} سطر يحتاج مراجعة (السطر الواحد قد يحمل أكثر من سبب):\n${reviewLines.join('\n')}`
      : '';
    if (!(await confirmDialog(`هل أنت متأكد من اعتماد مسير رواتب شهر ${period.month}/${period.year} (${draftCount} موظف)؟ سيتم تسجيله في أرشيف الرواتب كمعتمد.${reviewWarning}`))) return;
    setIsGenerating(true);
    try {
      // DEC-010: the month is always sent explicitly (never inferred from the loaded rows).
      if (await postHub({ actionType: 'APPROVE_DRAFTS', payload: { month: period.month, year: period.year } }, 'تم اعتماد مسير الرواتب بنجاح!')) {
        await refresh();
      }
    } catch {
      toast.error('حدث خطأ أثناء اعتماد الرواتب.');
    } finally {
      setIsGenerating(false);
    }
  };

  /** Months that have APPROVED (not yet paid) payrolls, newest first (server counts / totals). */
  const approvedMonths = months
    .filter((m) => (m.byStatus[PAYROLL_STATUS.APPROVED] ?? 0) > 0)
    .map((m) => ({ month: m.month, year: m.year, count: m.byStatus[PAYROLL_STATUS.APPROVED] ?? 0, total: m.netByStatus?.[PAYROLL_STATUS.APPROVED] ?? 0 }));

  const handleMarkPayrollPaid = async (month: number, year: number) => {
    if (!(await confirmDialog(`تأكيد صرف مسير رواتب شهر ${month}/${year}؟ سيتم تسجيل جميع الرواتب المعتمدة لهذا الشهر كمسددة.`))) return;
    setPayingMonth(`${year}-${month}`);
    try {
      if (await postHub({ actionType: 'MARK_PAYROLL_PAID', payload: { month, year } }, 'تم تسجيل صرف مسير الرواتب')) {
        await refresh();
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setPayingMonth(null);
    }
  };

  /** Downloads the server-built .xlsx (stored values only, never the table on screen). */
  const exportToExcel = async () => {
    if (!period) return;
    setIsExporting(true);
    try {
      const res = await fetch(`/api/payroll-hub/export?month=${period.month}&year=${period.year}`);
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تصدير ملف Excel'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll_review_${period.year}_${String(period.month).padStart(2, '0')}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error('تعذر تصدير ملف Excel');
    } finally {
      setIsExporting(false);
    }
  };

  const isInPeriod = (d: string | null | undefined) => {
    const ym = ymOf(d);
    return !!ym && ym.m === target.month && ym.y === target.year;
  };
  const activeCount = employees.filter(e => !e.isTerminated && e.employmentStatus === 'ACTIVE').length;
  const onLeaveCount = employees.filter(e => e.employmentStatus === 'ON_LEAVE').length;
  const suspendedCount = employees.filter(e => e.employmentStatus === 'EXCLUDED' || e.employmentStatus === 'SUSPENDED').length;
  const addedThisMonthCount = employees.filter(e => isInPeriod(e.joinDate || e.createdAt)).length;
  const terminatedThisMonthCount = employees.filter(e => !!e.isTerminated && isInPeriod(e.terminationDate)).length;

  const employeeOptions = employees.map(e => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''}`, value: e.id }));

  // Month picker: months with payrolls + the current Riyadh month.
  const nowPeriod = riyadhPeriod();
  const monthOptions: Period[] = [...months.map((m) => ({ month: m.month, year: m.year }))];
  if (!monthOptions.some((m) => periodKey(m) === periodKey(nowPeriod))) monthOptions.unshift(nowPeriod);
  if (period && !monthOptions.some((m) => periodKey(m) === periodKey(period))) monthOptions.unshift(period);
  monthOptions.sort((a, b) => b.year - a.year || b.month - a.month);

  const totals = summary?.totals ?? null;
  const showProvisional = !!summary && (summary.provisionalRates.length > 0 && summary.newRegimeCount > 0);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-emerald-100 text-emerald-600 p-3 rounded-2xl"><Wallet size={26} /></span>
              إدارة مسير الرواتب
            </h1>
            <p className="text-slate-500 font-semibold mt-2">التحكم بالشئون المالية، الخصومات، السلف والعمل الإضافي بدقة وموثوقية.</p>
          </div>
          <label className="flex items-center gap-3 bg-white border border-slate-200 rounded-2xl px-4 py-2 shadow-sm">
            <span className="text-[12px] font-black text-slate-500">شهر المسير</span>
            <select
              aria-label="شهر المسير"
              value={period ? periodKey(period) : ''}
              onChange={(e) => {
                const [y, m] = e.target.value.split('-').map(Number);
                if (y && m) selectPeriod({ year: y, month: m });
              }}
              className="bg-transparent font-black text-slate-800 text-[14px] focus:outline-none"
            >
              {monthOptions.map((m) => {
                const entry = months.find((x) => x.year === m.year && x.month === m.month);
                const statuses = entry ? Object.entries(entry.byStatus).map(([k, v]) => `${STATUS_LABELS[k] ?? k} ${v}`).join('، ') : 'لا يوجد مسير';
                return <option key={periodKey(m)} value={periodKey(m)}>{m.month}/{m.year} — {statuses}</option>;
              })}
            </select>
          </label>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CURRENT'} onClick={() => setActiveTab('CURRENT')} label="الرواتب الجارية (المقترحة)" badge={draftReviewCount > 0} />
          <TabButton active={activeTab === 'HISTORY'} onClick={() => setActiveTab('HISTORY')} label="سجل الرواتب السابقة" />
          <TabButton active={activeTab === 'SHEET'} onClick={() => setActiveTab('SHEET')} label="كشف الرواتب الشامل (Sheet)" />
          <TabButton active={activeTab === 'OVERTIME'} onClick={() => setActiveTab('OVERTIME')} label={`العمل الإضافي (${pendingOvertimes.length})`} badge={pendingOvertimes.length > 0} />
          <TabButton active={activeTab === 'DEDUCTIONS'} onClick={() => setActiveTab('DEDUCTIONS')} label="الجزاءات والمخالفات والسلف" />
        </div>

        {/* --- Content Area --- */}
        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب السجلات المالية...</div>
        ) : loadError ? (
          <div role="alert" className="bg-white border border-rose-200 rounded-[2rem] p-12 text-center flex flex-col items-center gap-4">
            <div className="bg-rose-50 p-5 rounded-full text-rose-500"><AlertTriangle size={40} /></div>
            <p className="font-black text-slate-800">{loadError}</p>
            <button type="button" onClick={() => fetchHubData({ period })} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-black text-[13px] rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* GOSI notices (DEC-003): provisional NEW-regime rates, lines needing review */}
            {(activeTab === 'CURRENT' || activeTab === 'SHEET' || activeTab === 'HISTORY') && summary && (showProvisional || summary.needsReviewCount > 0 || summary.legacyRows > 0) && (
              <div className="mb-6 space-y-3">
                {summary.needsReviewCount > 0 && (
                  <div role="status" className="flex items-start gap-3 bg-rose-50 border border-rose-200 text-rose-900 rounded-2xl p-4 text-[13px] font-bold">
                    <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                    <span>
                      {summary.needsReviewCount} سطر في مسير {summary.month}/{summary.year} يحتاج مراجعة. وُلِّدت هذه الأسطر ولم يُوقف المسير، ولم يُغيَّر أي مبلغ فيها؛ راجعها قبل الاعتماد.
                      {summary.reviewCounts && reviewCountLines(summary.reviewCounts).length > 0 && (
                        <span className="block mt-1 font-bold text-rose-800">{reviewCountLines(summary.reviewCounts).map((l) => l.replace('• ', '')).join('، ')}</span>
                      )}
                    </span>
                  </div>
                )}
                {showProvisional && (
                  <div role="note" className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-4 text-[13px] font-bold">
                    <Info size={18} className="shrink-0 mt-0.5" />
                    <span>
                      نسب التأمينات للنظام الجديد مؤقتة (بانتظار تأكيد المستشار):{' '}
                      {summary.provisionalRates.map((r) => `${r.isSaudi ? 'سعودي' : 'غير سعودي'} ${r.employeeRate}% موظف / ${r.employerRate}% صاحب عمل من ${formatDate(r.effectiveFrom)}`).join('؛ ')}
                      {' '}— تنطبق على {summary.newRegimeCount} موظف في هذا الشهر.
                    </span>
                  </div>
                )}
                {summary.legacyRows > 0 && (
                  <div role="note" className="flex items-start gap-3 bg-slate-50 border border-slate-200 text-slate-700 rounded-2xl p-4 text-[13px] font-bold">
                    <Info size={18} className="shrink-0 mt-0.5" />
                    <span>{summary.legacyRows} سطر أُنشئ قبل حفظ تفصيل الخصومات؛ يظهر إجمالي الحسميات فقط دون تقدير لتفاصيلها. أعد توليد المسودة لحفظ التفصيل.</span>
                  </div>
                )}
              </div>
            )}

            {/* Tab: CURRENT & HISTORY */}
            {(activeTab === 'CURRENT' || activeTab === 'HISTORY') && (
              <div className="space-y-6">
                 {/* Action Bar */}
                 {activeTab === 'CURRENT' && (
                    <div className="flex flex-col md:flex-row gap-4 justify-between md:items-center bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
                       <div>
                         <h3 className="text-xl font-black text-slate-800 tracking-tight flex items-center gap-2"><DollarSign size={20} className="text-emerald-500" /> دورة مسير شهر {target.month}/{target.year} (مسودة)</h3>
                         <p className="text-[13px] font-bold text-slate-500 mt-1">
                           {draftCount > 0
                             ? `${draftCount} موظف · صافي ${formatMoney(draftNet)} ر.س${draftReviewCount ? ` · ${draftReviewCount} يحتاج مراجعة` : ''}`
                             : 'يُظهر الاستحقاقات المالية المؤقتة بناءً على البيانات للمراجعة التلقائية المسبقة.'}
                         </p>
                       </div>
                       <div className="flex flex-wrap gap-3">
                         <button
                           type="button" onClick={handleGeneratePayroll} disabled={isGenerating}
                           className={`px-8 py-3.5 hover:bg-emerald-700 text-white font-black text-[14px] rounded-2xl shadow-xl shadow-emerald-600/20 transition-all flex items-center gap-3 disabled:opacity-50 ${isGenerating ? 'bg-emerald-400' : 'bg-emerald-600'}`}>
                            {isGenerating ? <><Clock className="animate-spin" size={18} /> جاري المعالجة الحسابية...</> : `توليد مسير ${target.month}/${target.year} التجريبي`}
                         </button>
                         {currentPayrolls.length > 0 && (
                           <button
                             type="button" onClick={handleApprovePayrolls} disabled={isGenerating}
                             className={`px-8 py-3.5 hover:bg-blue-700 text-white font-black text-[14px] rounded-2xl shadow-xl shadow-blue-600/20 transition-all flex items-center gap-3 disabled:opacity-50 bg-blue-600`}>
                              اعتماد مسير {target.month}/{target.year}
                           </button>
                         )}
                       </div>
                    </div>
                 )}

                 {/* Finance: mark approved months as paid */}
                 {activeTab === 'HISTORY' && approvedMonths.length > 0 && (
                    <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm space-y-4">
                      <div>
                        <h3 className="text-xl font-black text-slate-800 tracking-tight flex items-center gap-2"><CheckCircle size={20} className="text-blue-500" /> مسيرات معتمدة بانتظار الصرف</h3>
                        <p className="text-[13px] font-bold text-slate-500 mt-1">
                          {canMarkPaid ? 'بعد تحويل الرواتب للموظفين، سجّل صرف المسير ليُنقل إلى حالة (مسدد).' : 'يتم تسجيل الصرف من قبل الإدارة المالية.'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {approvedMonths.map((m) => {
                          const key = `${m.year}-${m.month}`;
                          return (
                            <div key={key} className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
                              <div>
                                <div className="font-black text-slate-800 text-[14px]">شهر {m.month}/{m.year}</div>
                                <div className="text-[12px] font-bold text-slate-500">{m.count} موظف · {formatMoney(m.total)} ر.س</div>
                              </div>
                              {canMarkPaid && (
                                <button
                                  type="button"
                                  onClick={() => handleMarkPayrollPaid(m.month, m.year)}
                                  disabled={payingMonth !== null}
                                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[12px] rounded-xl transition disabled:opacity-50"
                                >
                                  {payingMonth === key ? 'جاري التسجيل...' : 'تسجيل الصرف'}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                 )}


                 {tabReviewTotal > 0 && (
                   <div className="flex flex-wrap items-center gap-2 bg-white px-5 py-3 rounded-2xl border border-slate-200 shadow-sm">
                     <label htmlFor="review-filter" className="text-[12px] font-black text-slate-600">عرض الأسطر:</label>
                     <select
                       id="review-filter"
                       value={effectiveReviewFilter}
                       onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}
                       className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[12px] font-bold text-slate-700 focus:outline-none focus:border-rose-300"
                     >
                       <option value="ALL">كل الأسطر ({tabPayrolls.length})</option>
                       <option value="REVIEW">يحتاج مراجعة ({tabReviewTotal})</option>
                       {(Object.entries(tabReviewCounts) as Array<[PayrollReviewFilterKey, number]>).map(([k, n]) => (
                         <option key={k} value={k}>{PAYROLL_REVIEW_LABELS[k] ?? k} ({n})</option>
                       ))}
                     </select>
                     {effectiveReviewFilter !== 'ALL' && (
                       <span className="text-[12px] font-bold text-slate-500">يُعرض {activePayrolls.length} من {tabPayrolls.length}</span>
                     )}
                   </div>
                 )}

                 {/* Results List */}
                 {activePayrolls.length === 0 ? (
                    <div className="bg-white border border-slate-200 rounded-[2rem] p-12 text-center flex flex-col items-center justify-center min-h-[400px]">
                      <div className="bg-slate-50 p-6 rounded-full text-slate-400 mb-6"><FileText size={48} /></div>
                      <h3 className="text-xl font-black text-slate-800 tracking-tight mb-2">
                        {activeTab === 'CURRENT' ? `لا توجد مسودة لمسير ${target.month}/${target.year}` : `لا توجد رواتب معتمدة أو مسددة لشهر ${target.month}/${target.year}`}
                      </h3>
                      <p className="text-slate-500 font-bold max-w-lg mb-8 leading-relaxed">
                        {activeTab === 'CURRENT'
                          ? 'استخدم الزر العلوي لتوليد رواتب الشهر المختار لجميع الموظفين حيث سيقوم النظام بخصم السلف والجزاءات وجمع الإضافيات تلقائياً.'
                          : 'اختر شهراً آخر من قائمة «شهر المسير» أعلى الصفحة لعرض أرشيفه.'}
                      </p>
                    </div>
                 ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                       {activePayrolls.map((payroll) => (
                          <div key={payroll.id} className={`bg-white border p-6 rounded-3xl hover:shadow-xl hover:shadow-emerald-500/10 transition group ${payroll.needsReview ? 'border-rose-300' : 'border-slate-200 hover:border-emerald-300'}`}>
                            <div className="flex justify-between items-start mb-4">
                              <div className="flex items-center gap-3">
                                 <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center font-black text-slate-500 group-hover:scale-110 group-hover:bg-emerald-100 group-hover:text-emerald-600 transition">
                                     {payroll.employee?.firstNameArabic?.charAt(0) ?? '؟'}
                                 </div>
                                 <div>
                                   <div className="font-extrabold text-[15px] text-slate-800">{fullName(payroll.employee)}</div>
                                   <div className="text-[12px] font-bold text-slate-400">القاعدة: {formatMoney(payroll.basicSalary)} ر.س</div>
                                 </div>
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                <div className="bg-slate-100 px-3 py-1 text-slate-600 font-bold text-[11px] rounded-lg">شـ {payroll.month}/{payroll.year}</div>
                                {activeTab === 'HISTORY' && (
                                  payroll.status === PAYROLL_STATUS.PAID
                                    ? <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 font-black text-[10px] rounded-md">مسدد</span>
                                    : <span className="bg-blue-50 text-blue-700 px-2 py-0.5 font-black text-[10px] rounded-md">معتمد - بانتظار الصرف</span>
                                )}
                                {payroll.needsReview && (
                                  <span className="bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 font-black text-[10px] rounded-md">يحتاج مراجعة</span>
                                )}
                              </div>
                            </div>
                            {payroll.reviewNote && (
                              <p className={`text-[11px] font-bold rounded-lg px-2 py-1 mb-2 ${payroll.needsReview ? 'bg-rose-50 text-rose-700' : 'bg-slate-50 text-slate-500'}`}>{reviewNoteText(payroll.reviewNote)}</p>
                            )}

                            <hr className="my-4 border-slate-100" />

                            <div className="flex justify-between items-center bg-slate-50 px-4 py-3 rounded-2xl mb-2">
                               <div className="flex flex-col"><span className="text-[10px] uppercase font-black text-slate-400 mb-0.5">البدلات+الإضافي</span><span className="font-black text-emerald-600 text-[13px]">+{money(roundMoney(toNum(payroll.totalAllowances) + toNum(payroll.overtimeCost)))} ر.س</span></div>
                               <div className="w-px h-8 bg-slate-200 block"></div>
                               <div className="flex flex-col text-left"><span className="text-[10px] uppercase font-black text-slate-400 mb-0.5">إجمالي الحسميات</span><span className="font-black text-rose-600 text-[13px]">- {money(payroll.totalDeductions)} ر.س</span></div>
                            </div>

                            <div className="flex justify-between items-center mt-4">
                                <div>
                                  <div className="text-[11px] font-bold text-slate-500">ميزة الصافي المحوّل للموظف</div>
                                  <div className="font-black text-[20px] text-slate-900 group-hover:text-emerald-600 transition">{money(payroll.netSalary)} <span className="text-[11px] text-slate-400">ر.س</span></div>
                                </div>
                                <button type="button" aria-label="عرض تفاصيل المسير" onClick={() => setSelectedPayroll(payroll)} className="bg-white border border-slate-200 hover:bg-emerald-50 text-slate-600 hover:text-emerald-600 w-10 h-10 rounded-xl flex items-center justify-center group-hover:border-emerald-200 transition">
                                   <FileText size={18} />
                                </button>
                              </div>
                          </div>
                       ))}
                    </div>
                 )}
              </div>
            )}

            {/* Tab: SHEET (stored values of the selected month; totals from the server) */}
            {activeTab === 'SHEET' && (
              <div className="space-y-6 animate-in fade-in zoom-in duration-300">

                {/* Actions & Stats Dashboard */}
                <div className="flex flex-col md:flex-row gap-3 justify-between md:items-center bg-white p-4 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="px-4">
                    <h3 className="text-xl font-black text-slate-800 flex items-center gap-2"><FileText size={20} className="text-emerald-500" /> كشف رواتب شهر {target.month}/{target.year}</h3>
                    <p className="text-[12px] font-black text-amber-700 mt-1">{EXPORT_NOTE}</p>
                  </div>
                  <button type="button" onClick={exportToExcel} disabled={isExporting || !summary || summary.count === 0} className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl flex items-center justify-center gap-2 font-bold text-[13px] shadow-sm transition disabled:opacity-50">
                    <Download size={18} /> {isExporting ? 'جاري التصدير...' : 'تحميل Excel للمراجعة'}
                  </button>
                </div>

                {/* Server totals */}
                {totals && summary && summary.count > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    <StatTile label="عدد الأسطر" value={String(summary.count)} />
                    <StatTile label="إجمالي المستحق" value={formatMoney(totals.gross)} />
                    <StatTile label="إجمالي الحسميات" value={formatMoney(totals.totalDeductions)} tone="rose" />
                    <StatTile label="صافي الرواتب" value={formatMoney(totals.netSalary)} tone="emerald" />
                    <StatTile label="تأمينات صاحب العمل (تكلفة لا تُخصم)" value={formatMoney(totals.gosiEmployer)} tone="amber" />
                    <StatTile label="يحتاج مراجعة" value={String(summary.needsReviewCount)} tone={summary.needsReviewCount ? 'rose' : undefined} />
                  </div>
                )}

                {/* Employee stats (for the selected month) */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                   <StatTile label="على رأس العمل" value={String(activeCount)} />
                   <StatTile label="في إجازة" value={String(onLeaveCount)} tone="amber" />
                   <StatTile label="موقوفين / مستبعدين" value={String(suspendedCount)} tone="rose" />
                   <StatTile label="مضافين خلال الشهر" value={`+${addedThisMonthCount}`} tone="emerald" />
                   <StatTile label="إنهاء خدمة خلال الشهر" value={String(terminatedThisMonthCount)} />
                </div>


                {tabReviewTotal > 0 && (
                  <div className="flex flex-wrap items-center gap-2 bg-white px-5 py-3 rounded-2xl border border-slate-200 shadow-sm">
                    <label htmlFor="review-filter" className="text-[12px] font-black text-slate-600">عرض الأسطر:</label>
                    <select
                      id="review-filter"
                      value={effectiveReviewFilter}
                      onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}
                      className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[12px] font-bold text-slate-700 focus:outline-none focus:border-rose-300"
                    >
                      <option value="ALL">كل الأسطر ({tabPayrolls.length})</option>
                      <option value="REVIEW">يحتاج مراجعة ({tabReviewTotal})</option>
                      {(Object.entries(tabReviewCounts) as Array<[PayrollReviewFilterKey, number]>).map(([k, n]) => (
                        <option key={k} value={k}>{PAYROLL_REVIEW_LABELS[k] ?? k} ({n})</option>
                      ))}
                    </select>
                    {effectiveReviewFilter !== 'ALL' && (
                      <span className="text-[12px] font-bold text-slate-500">يُعرض {activePayrolls.length} من {tabPayrolls.length}</span>
                    )}
                  </div>
                )}

                {/* Table Sheet */}
                <div className="bg-white border border-slate-200 shadow-sm rounded-3xl overflow-x-auto w-full max-w-[100vw]">
                  {activePayrolls.length === 0 ? (
                    <div className="p-12 text-center font-bold text-slate-400">لا يوجد مسير لهذا الشهر (جرّب توليد مسير الرواتب أولاً)</div>
                  ) : (
                    <table className="w-[1900px] text-right border-collapse text-[12px] whitespace-nowrap">
                      <thead>
                        <tr>
                          <th colSpan={6} className="bg-blue-100/50 border border-slate-200 p-3 text-center font-black text-blue-900">بيانات الموظف</th>
                          <th colSpan={5} className="bg-green-100/50 border border-slate-200 p-3 text-center font-black text-green-900">المستحقات</th>
                          <th colSpan={6} className="bg-amber-100 border border-slate-200 p-3 text-center font-black text-amber-900">الحسميات (حصة الموظف)</th>
                          <th colSpan={1} className="bg-teal-50 border border-slate-200 p-3 text-center font-black text-teal-900">الصافي</th>
                          <th colSpan={2} className="bg-slate-100 border border-slate-200 p-3 text-center font-black text-slate-700">تكلفة ومراجعة</th>
                        </tr>
                        <tr className="bg-slate-50 border-b border-slate-300 text-slate-600">
                          <th className="p-2 border border-slate-200">اسم الموظف</th>
                          <th className="p-2 border border-slate-200">الرقم الوظيفي</th>
                          <th className="p-2 border border-slate-200">الجنسية</th>
                          <th className="p-2 border border-slate-200">نظام التأمينات</th>
                          <th className="p-2 border border-slate-200">الفرع</th>
                          <th className="p-2 border border-slate-200">الحالة</th>

                          <th className="p-2 border border-slate-200">الراتب الأساسي</th>
                          <th className="p-2 border border-slate-200">البدلات الشهرية</th>
                          <th className="p-2 border border-slate-200">مكافآت</th>
                          <th className="p-2 border border-slate-200">عمل إضافي</th>
                          <th className="p-2 border border-slate-200 font-extrabold">إجمالي المستحق</th>

                          <th className="p-2 border border-slate-200">التأمينات</th>
                          <th className="p-2 border border-slate-200">الإجازات والغياب</th>
                          <th className="p-2 border border-slate-200">السلف</th>
                          <th className="p-2 border border-slate-200">الجزاءات</th>
                          <th className="p-2 border border-slate-200">أخرى</th>
                          <th className="p-2 border border-slate-200 text-red-600 font-extrabold">الإجمالي للحسميات</th>

                          <th className="p-2 border border-slate-200 bg-emerald-50 text-emerald-800 font-black">صافي المستحق</th>

                          <th className="p-2 border border-slate-200">تأمينات صاحب العمل</th>
                          <th className="p-2 border border-slate-200">المراجعة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white">
                        {activePayrolls.map((payroll) => {
                           const basicSalary = toNum(payroll.basicSalary);
                           const totalAllowances = toNum(payroll.totalAllowances);
                           const bonus = toNum(payroll.bonusAmount);
                           const overtimeCost = toNum(payroll.overtimeCost);
                           const detailed = hasBreakdown(payroll);
                           const cell = (v: unknown) => (detailed ? money(v) : '—');
                           return (
                              <tr key={payroll.id} className={`transition-colors ${payroll.needsReview ? 'bg-rose-50/40 hover:bg-rose-50' : 'hover:bg-slate-50'}`}>
                                <td className="p-2 font-black text-indigo-900 border border-slate-200 min-w-[150px]">{fullName(payroll.employee)}</td>
                                <td className="p-2 font-bold text-slate-700 border border-slate-200">{payroll.employee?.employeeId || '-'}</td>
                                <td className="p-2 font-semibold text-slate-600 border border-slate-200">{payroll.employee?.nationality || '-'}</td>
                                <td className="p-2 font-semibold text-slate-600 border border-slate-200">{REGIME_LABELS[payroll.employee?.gosiRegime ?? ''] ?? '-'}</td>
                                <td className="p-2 font-medium text-slate-600 border border-slate-200">{payroll.employee?.branch?.nameArabic || '-'}</td>
                                <td className="p-2 font-bold text-slate-600 border border-slate-200">{STATUS_LABELS[payroll.status] ?? payroll.status}</td>

                                <td className="p-2 font-black text-slate-800 border border-slate-200 bg-slate-50">{money(basicSalary)}</td>
                                <td className="p-2 border border-slate-200 font-bold text-emerald-600">{money(roundMoney(totalAllowances - bonus))}</td>
                                <td className="p-2 border border-slate-200 font-bold text-emerald-600">{money(bonus)}</td>
                                <td className="p-2 border border-slate-200 font-bold text-emerald-600">{money(overtimeCost)}</td>
                                <td className="p-2 border border-slate-200 font-black text-indigo-900 bg-indigo-100">{money(sumMoney([basicSalary, totalAllowances, overtimeCost]))}</td>

                                <td className="p-2 border border-slate-200 font-semibold text-rose-600">{cell(payroll.gosiEmployee)}</td>
                                <td className="p-2 border border-slate-200 font-semibold text-rose-600">{cell(payroll.leaveDeduction)}</td>
                                <td className="p-2 border border-slate-200 font-semibold text-rose-600">{cell(payroll.loansDeduction)}</td>
                                <td className="p-2 border border-slate-200 font-semibold text-rose-600">{cell(payroll.violationsDeduction)}</td>
                                <td className="p-2 border border-slate-200 font-semibold text-rose-600">{cell(payroll.otherDeductions)}</td>
                                <td className="p-2 border border-slate-200 font-black text-rose-800 bg-rose-50">{money(payroll.totalDeductions)}</td>

                                <td className="p-2 border border-slate-200 font-black text-[14px] text-emerald-800 bg-emerald-100">{money(payroll.netSalary)}</td>

                                <td className="p-2 border border-slate-200 font-semibold text-amber-700">{money(payroll.gosiEmployer)}</td>
                                <td className="p-2 border border-slate-200 text-[11px] font-bold max-w-[260px] whitespace-normal">
                                  {payroll.needsReview && <span className="bg-rose-100 text-rose-700 px-2 py-0.5 rounded-md font-black ml-1">يحتاج مراجعة</span>}
                                  <span className="text-slate-500">{reviewNoteText(payroll.reviewNote) || (detailed ? '' : 'تفصيل غير متوفر (مسير قديم)')}</span>
                                </td>
                              </tr>
                           );
                        })}
                      </tbody>
                      {totals && summary && summary.count === activePayrolls.length && (
                        <tfoot>
                          <tr className="bg-slate-100 font-black text-slate-800">
                            <td className="p-2 border border-slate-200" colSpan={6}>الإجمالي (من الخادم)</td>
                            <td className="p-2 border border-slate-200">{money(totals.basicSalary)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.recurringAllowances)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.bonusAmount)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.overtimeCost)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.gross)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.gosiEmployee)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.leaveDeduction)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.loansDeduction)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.violationsDeduction)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.otherDeductions)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.totalDeductions)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.netSalary)}</td>
                            <td className="p-2 border border-slate-200">{money(totals.gosiEmployer)}</td>
                            <td className="p-2 border border-slate-200">{summary.needsReviewCount}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  )}
                </div>
              </div>
            )}

            {/* Tab: OVERTIME */}
            {activeTab === 'OVERTIME' && (
              <div className="space-y-8">
                {/* Add New Overtime Form */}
                <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm mb-8">
                  <h3 className="font-extrabold text-xl text-indigo-800 mb-6 flex items-center gap-3">
                    <div className="bg-indigo-100 p-2 rounded-xl"><Plus size={20} className="text-indigo-600"/></div>
                    تسجيل تكليف عمل إضافي جديد
                  </h3>
                  <form onSubmit={handleAddOvertime} className="space-y-5">
                    <SearchableSelect name="employeeId" value={overtimeForm.employeeId} onChange={(e) => setOvertimeForm({...overtimeForm, employeeId: e.target.value})} label="الموظف المُكلف" required accentColor="indigo"
                       options={employeeOptions} />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                       <div>
                          <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ التكليف</label>
                          <input type="date" required value={overtimeForm.date} onChange={(e) => setOvertimeForm({...overtimeForm, date: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-right" dir="ltr" />
                       </div>
                       <div>
                          <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">عدد الساعات الإضافية</label>
                          <input type="number" step="0.5" placeholder="مثال: 2.5" value={overtimeForm.hours} onChange={(e) => setOvertimeForm({...overtimeForm, hours: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-right" dir="ltr" />
                       </div>
                       <div>
                          <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">مبلغ مقطوع (ر.س)</label>
                          <input type="number" step="0.01" placeholder="مثال: 500" value={overtimeForm.amount} onChange={(e) => setOvertimeForm({...overtimeForm, amount: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-right" dir="ltr" />
                       </div>
                    </div>
                    <div>
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">سبب التكليف والمهام المنجزة</label>
                       <input type="text" required placeholder="مثال: جرد مستودع نهاية الشهر" value={overtimeForm.reason} onChange={(e) => setOvertimeForm({...overtimeForm, reason: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                    </div>
                    <button type="submit" disabled={isSubmitting} className="w-full pt-4 mt-2 px-6 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[14px] rounded-2xl transition disabled:opacity-50">{isSubmitting ? 'جاري الحفظ...' : 'اعتماد التكليف وتسجيله في مسير الرواتب'}</button>
                  </form>
                </div>

                {/* Pending Requests */}
                <h3 className="font-extrabold text-xl text-slate-800">طلبات تحتاج إلى التدقيق (من المشرفين)</h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {pendingOvertimes.length === 0 ? (
                    <div className="col-span-full py-12 text-center text-slate-500 font-bold bg-white border border-slate-200 rounded-[2rem]">لا يوجد طلبات أوفرتايم معلقة.</div>
                  ) : pendingOvertimes.map((req) => (
                    <div key={req.id} className="bg-white border border-slate-200 rounded-[2rem] p-6 shadow-sm flex flex-col md:flex-row gap-6 justify-between items-center hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-900/5 transition">
                      <div className="flex items-center gap-4">
                        <div className="bg-orange-50 text-orange-600 w-14 h-14 rounded-2xl flex items-center justify-center font-black">
                          <Clock size={24} />
                        </div>
                        <div>
                          <h4 className="font-black text-[15px] text-slate-800 mb-1">{fullName(req.employee)}</h4>
                          <p className="text-slate-500 font-bold text-[12px]">{toNum(req.hours) > 0 ? `${req.hours} ساعة ` : ''}{toNum(req.amount) > 0 ? `(${formatMoney(req.amount)} ر.س) ` : ''}بتاريخ {formatDate(req.date)}</p>
                          {req.reason && <p className="text-slate-600 font-semibold text-[11px] mt-2 bg-slate-50 px-2 py-1 rounded inline-block">السبب: {req.reason}</p>}
                        </div>
                      </div>
                      <div className="flex gap-2 w-full md:w-auto mt-4 md:mt-0">
                        <button type="button" disabled={busyId === req.id} onClick={() => handleOvertimeAction(req.id, 'APPROVED')} className="flex-1 md:flex-none px-5 py-3 bg-emerald-50 text-emerald-700 hover:bg-emerald-500 hover:text-white rounded-xl font-black text-[13px] transition disabled:opacity-50 flex items-center justify-center gap-2">
                          <CheckCircle size={16} /> قبول
                        </button>
                        <button type="button" disabled={busyId === req.id} onClick={() => handleOvertimeAction(req.id, 'REJECTED')} className="flex-1 md:flex-none px-5 py-3 bg-red-50 text-red-700 hover:bg-red-500 hover:text-white rounded-xl font-black text-[13px] transition disabled:opacity-50 flex items-center justify-center gap-2">
                          <XCircle size={16} /> رفض
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* History Requests */}
                {pastOvertimes.length > 0 && (
                  <div className="mt-12">
                     <h3 className="font-extrabold text-xl text-slate-800 mb-6 border-t border-slate-200 pt-8">سجل العمل الإضافي المعتمد / المرفوض</h3>
                     <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                       <table className="w-full text-right border-collapse">
                         <thead>
                           <tr className="bg-slate-50 border-b border-slate-100">
                             <th className="p-4 text-[13px] font-black text-slate-500">الموظف / الفرع</th>
                             <th className="p-4 text-[13px] font-black text-slate-500">التاريخ</th>
                             <th className="p-4 text-[13px] font-black text-slate-500">الساعات / المبلغ</th>
                             <th className="p-4 text-[13px] font-black text-slate-500">القرار / الحالة</th>
                           </tr>
                         </thead>
                         <tbody className="divide-y divide-slate-100">
                           {pastOvertimes.map((req) => (
                             <tr key={req.id} className="hover:bg-slate-50 transition">
                               <td className="p-4 font-bold text-slate-800 text-[14px]">
                                  {fullName(req.employee)}
                                  <span className="block text-[11px] text-slate-400 mt-1">{req.employee?.branch?.nameArabic || '-'}</span>
                               </td>
                               <td className="p-4 font-bold text-slate-600 text-[13px]">{formatDate(req.date)}</td>
                               <td className="p-4 font-black text-indigo-600 text-[14px]">{toNum(req.hours) > 0 ? `+${req.hours} ساعة` : ''} {toNum(req.amount) > 0 ? `+${formatMoney(req.amount)} ر.س` : ''}</td>
                               <td className="p-4">
                                  {req.status === 'APPROVED' ? 
                                    <span className="bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg text-[11px] font-black flex w-fit items-center gap-1.5"><CheckCircle size={14}/> مُعتمد</span> 
                                  : <span className="bg-red-100 text-red-700 px-3 py-1.5 rounded-lg text-[11px] font-black flex w-fit items-center gap-1.5"><XCircle size={14}/> مرفوض</span>}
                               </td>
                             </tr>
                           ))}
                         </tbody>
                       </table>
                     </div>
                  </div>
                )}
              </div>
            )}

            {/* Tab: DEDUCTIONS & LOANS */}
            {activeTab === 'DEDUCTIONS' && (
              <div className="space-y-12">
                {/* Forms split */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* Deduction Form */}
                  <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
                    <h3 className="font-extrabold text-xl text-red-800 mb-6 flex items-center gap-3">
                      <div className="bg-red-100 p-2 rounded-xl"><AlertTriangle size={20} className="text-red-600"/></div>
                      إيقاع جزاء أو خصم تأخير
                    </h3>
                    <form onSubmit={handleAddDeduction} className="space-y-5">
                      <SearchableSelect name="employeeId" value={deductionForm.employeeId} onChange={(e) => setDeductionForm({...deductionForm, employeeId: e.target.value})} label="الموظف المخالف" required accentColor="red"
                         options={employeeOptions} />
                      <div className="grid grid-cols-2 gap-5">
                         <div>
                            <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ المخالفة / التأخير</label>
                            <input type="date" required value={deductionForm.date} onChange={(e) => setDeductionForm({...deductionForm, date: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-red-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-red-50 transition-all text-right" dir="ltr" />
                         </div>
                         <div>
                            <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">مبلغ الخصم (ر.س)</label>
                            <input type="number" step="0.01" required placeholder="0.00" value={deductionForm.amount} onChange={(e) => setDeductionForm({...deductionForm, amount: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-red-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-red-50 transition-all text-right" dir="ltr" />
                         </div>
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">السبب التفصيلي للمخالفة</label>
                         <input type="text" required placeholder="مثال: تأخير غياب، كسر جهاز الشركة..." value={deductionForm.reason} onChange={(e) => setDeductionForm({...deductionForm, reason: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-red-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-red-50 transition-all" />
                      </div>
                      <button type="submit" disabled={isSubmitting} className="w-full pt-4 mt-2 px-6 py-4 bg-red-600 hover:bg-red-700 text-white font-black text-[14px] rounded-2xl transition disabled:opacity-50">{isSubmitting ? 'جاري الحفظ...' : 'تطبيق الخصم فوراً ومخصمته من راتب استحقاق الشهر'}</button>
                    </form>
                  </div>

                  {/* Loan Form */}
                  <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
                    <h3 className="font-extrabold text-xl text-emerald-800 mb-6 flex items-center gap-3">
                      <div className="bg-emerald-100 p-2 rounded-xl"><PiggyBank size={20} className="text-emerald-600"/></div>
                      تسجيل سلفة مالية
                    </h3>
                    <form onSubmit={handleAddLoan} className="space-y-5">
                      <SearchableSelect name="employeeId" value={loanForm.employeeId} onChange={(e) => setLoanForm({...loanForm, employeeId: e.target.value})} label="الموظف المستفيد" required accentColor="emerald"
                         options={employeeOptions} />
                      <div className="grid grid-cols-2 gap-5">
                         <div>
                            <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">إجمالي مبلغ السلفة</label>
                            <input type="number" step="0.01" required placeholder="0.00" value={loanForm.amount} onChange={(e) => setLoanForm({...loanForm, amount: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-emerald-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-50 transition-all text-right" dir="ltr" />
                         </div>
                         <div>
                            <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">القسط الشهري المخصوم</label>
                            <input type="number" step="0.01" required placeholder="0.00" value={loanForm.monthlyInstallment} onChange={(e) => setLoanForm({...loanForm, monthlyInstallment: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-emerald-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-50 transition-all text-right" dir="ltr" />
                         </div>
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">سبب أو إيضاح طلب السلفة (اختياري)</label>
                         <input type="text" placeholder="مثال: مساعدة زواج، ظروف عائلية..." value={loanForm.reason} onChange={(e) => setLoanForm({...loanForm, reason: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-emerald-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-50 transition-all" />
                      </div>
                      <button type="submit" disabled={isSubmitting} className="w-full pt-4 mt-2 px-6 py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[14px] rounded-2xl transition disabled:opacity-50">{isSubmitting ? 'جاري الحفظ...' : 'إيداع وتسجيل مديونية السلفة وجدولتها آلياً'}</button>
                    </form>
                  </div>
                </div>

                {/* Combined Log for Penalties & Loans */}
                <div className="mt-12">
                   <h3 className="font-extrabold text-xl text-slate-800 mb-6 border-t border-slate-200 pt-8">سجل المديونيات، والمخالفات، والسلف</h3>
                   <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                     <table className="w-full text-right border-collapse">
                       <thead>
                         <tr className="bg-slate-50 border-b border-slate-100">
                           <th className="p-4 text-[13px] font-black text-slate-500">الموظف</th>
                           <th className="p-4 text-[13px] font-black text-slate-500">النوع</th>
                           <th className="p-4 text-[13px] font-black text-slate-500">التفاصيل والسبب</th>
                           <th className="p-4 text-[13px] font-black text-slate-500">القيمة الإجمالية</th>
                           <th className="p-4 text-[13px] font-black text-slate-500">حالة الخصم</th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-slate-100">
                         {/* Map Deductions */}
                         {data.deductions.map((d) => (
                           <tr key={`ded-${d.id}`} className="hover:bg-slate-50 transition">
                             <td className="p-4 font-bold text-slate-800 text-[14px]">{fullName(d.employee)}</td>
                             <td className="p-4"><span className="bg-red-50 text-red-600 border border-red-200 px-3 py-1 rounded-lg text-[11px] font-black flex w-fit items-center gap-1.5 shrink-0"><AlertTriangle size={12}/> جزاء تأخير / مخالفة</span></td>
                             <td className="p-4 font-bold text-slate-600 text-[12px] max-w-[200px] truncate">{d.reason} <span className="text-slate-400 block mt-1">بتاريخ: {formatDate(d.date)}</span></td>
                             <td className="p-4 font-black text-red-600 text-[14px]">- {formatMoney(d.amount)} ر.س</td>
                             <td className="p-4 font-bold text-[12px] text-slate-500">{DEDUCTION_STATUS_LABELS[d.status] ?? d.status}</td>
                           </tr>
                         ))}
                         {/* Map Loans */}
                         {data.loans.map((l) => (
                           <tr key={`loan-${l.id}`} className="hover:bg-slate-50 transition">
                             <td className="p-4 font-bold text-slate-800 text-[14px]">{fullName(l.employee)}</td>
                             <td className="p-4"><span className="bg-emerald-50 text-emerald-600 border border-emerald-200 px-3 py-1 rounded-lg text-[11px] font-black flex w-fit items-center gap-1.5 shrink-0"><PiggyBank size={12}/> قرض سلفة</span></td>
                             <td className="p-4 font-bold text-slate-600 text-[12px] max-w-[200px] truncate">{l.reason || 'سلفة شخصية بدون أسباب'} <span className="text-slate-400 block mt-1">قسط شهري: {formatMoney(l.monthlyInstallment)} ر.س</span></td>
                             <td className="p-4 font-black text-slate-800 text-[14px] bg-slate-50 block mt-1 py-1 px-2 rounded-lg text-center w-fit">المتبقي {formatMoney(l.remainingAmount)} / إجمالي {formatMoney(l.amount)} ر.س</td>
                             <td className="p-4 font-bold text-[12px] text-emerald-600">{l.isForgiven ? 'مُسامح' : 'ساري وجاري السداد'}</td>
                           </tr>
                         ))}
                         {(data.deductions.length === 0 && data.loans.length === 0) && (
                           <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">السجل نظيف. ليس هنالك أي خصومات أو سلف مقيّدة مسجلة.</td></tr>
                         )}
                       </tbody>
                     </table>
                   </div>
                </div>

              </div>
            )}

          </div>
        )}
      </div>

      {/* DETAILED PAYROLL MODAL (stored breakdown) */}
      {selectedPayroll && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div role="dialog" aria-modal="true" aria-labelledby="payroll-detail-title" className="bg-white rounded-[2rem] shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto border border-slate-100 animate-in slide-in-from-bottom-8">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h3 id="payroll-detail-title" className="text-xl font-black text-slate-800 flex items-center gap-2">
                تفاصيل مسير راتب الموظف
              </h3>
              <button type="button" aria-label="إغلاق" onClick={() => setSelectedPayroll(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition">
                <XCircle size={20} />
              </button>
            </div>
            <div className="p-8 space-y-6">
              <div className="flex items-center gap-4 bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100">
                <div className="w-14 h-14 bg-white shadow-sm text-emerald-600 rounded-xl flex items-center justify-center font-black text-xl">
                  {selectedPayroll.employee?.firstNameArabic?.charAt(0) ?? '؟'}
                </div>
                <div>
                  <h4 className="font-black text-slate-800 text-[16px]">{fullName(selectedPayroll.employee)}</h4>
                  <p className="text-[12px] font-bold text-slate-500 mt-1">
                    شـ {selectedPayroll.month}/{selectedPayroll.year} | الرقم الوظيفي: #{selectedPayroll.employee?.employeeId ?? '—'}
                  </p>
                </div>
              </div>

              {selectedPayroll.needsReview && (
                <div role="status" className="bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl p-4 text-[12px] font-bold">
                  يحتاج مراجعة: {reviewNoteText(selectedPayroll.reviewNote) || '—'}
                </div>
              )}

              <div className="border border-slate-200 rounded-2xl overflow-hidden">
                <table className="w-full text-right text-[13px]">
                  <tbody className="divide-y divide-slate-100">
                    <tr className="bg-slate-50">
                      <td className="p-4 font-extrabold text-slate-700">الراتب الأساسي</td>
                      <td className="p-4 font-black text-slate-800">{money(selectedPayroll.basicSalary)} ر.س</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-slate-600">البدلات الشهرية</td>
                      <td className="p-4 font-black text-emerald-600">+{money(roundMoney(toNum(selectedPayroll.totalAllowances) - toNum(selectedPayroll.bonusAmount)))} ر.س</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-slate-600">مكافآت لمرة واحدة</td>
                      <td className="p-4 font-black text-emerald-600">+{money(selectedPayroll.bonusAmount)} ر.س</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-slate-600">تكلفة العمل الإضافي (الأوفرتايم)</td>
                      <td className="p-4 font-black text-emerald-600">+{money(selectedPayroll.overtimeCost)} ر.س</td>
                    </tr>
                    {hasBreakdown(selectedPayroll) ? (
                      <>
                        <tr>
                          <td className="p-4 font-bold text-slate-600">التأمينات الاجتماعية (حصة الموظف)</td>
                          <td className="p-4 font-black text-rose-600">-{money(selectedPayroll.gosiEmployee)} ر.س</td>
                        </tr>
                        <tr>
                          <td className="p-4 font-bold text-slate-600">خصم الإجازات والغياب</td>
                          <td className="p-4 font-black text-rose-600">-{money(selectedPayroll.leaveDeduction)} ر.س</td>
                        </tr>
                        <tr>
                          <td className="p-4 font-bold text-slate-600">أقساط السلف</td>
                          <td className="p-4 font-black text-rose-600">-{money(selectedPayroll.loansDeduction)} ر.س</td>
                        </tr>
                        <tr>
                          <td className="p-4 font-bold text-slate-600">الجزاءات والمخالفات</td>
                          <td className="p-4 font-black text-rose-600">-{money(selectedPayroll.violationsDeduction)} ر.س</td>
                        </tr>
                        {toNum(selectedPayroll.otherDeductions) > 0 && (
                          <tr>
                            <td className="p-4 font-bold text-slate-600">خصومات أخرى</td>
                            <td className="p-4 font-black text-rose-600">-{money(selectedPayroll.otherDeductions)} ر.س</td>
                          </tr>
                        )}
                      </>
                    ) : (
                      <tr>
                        <td className="p-4 font-bold text-slate-600">إجمالي الخصومات (التفصيل غير متوفر لمسير قديم)</td>
                        <td className="p-4 font-black text-rose-600">-{money(selectedPayroll.totalDeductions)} ر.س</td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot className="bg-slate-900 border-t border-slate-900">
                    <tr>
                      <td className="p-4 font-black text-white text-[15px]">صافي الراتب المستحق للموظف</td>
                      <td className="p-4 font-black text-emerald-400 text-[18px]">{money(selectedPayroll.netSalary)} ر.س</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="text-[12px] font-bold text-slate-500">
                حصة صاحب العمل في التأمينات: {money(selectedPayroll.gosiEmployer)} ر.س (تكلفة على المنشأة، لا تُخصم من الراتب).
              </p>
              <div className="pt-2">
                <button type="button" onClick={() => setSelectedPayroll(null)} className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-extrabold text-[13px] px-8 py-3.5 rounded-xl transition-all">
                  إغلاق
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </DashboardLayout>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: 'rose' | 'emerald' | 'amber' }) {
  const color = tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-slate-800';
  return (
    <div className="bg-white border border-slate-200 p-4 rounded-3xl flex flex-col items-center justify-center text-center shadow-sm">
      <span className="text-[11px] font-black text-slate-400 mb-1">{label}</span>
      <span className={`text-2xl font-black ${color}`}>{value}</span>
    </div>
  );
}

function TabButton({ active, onClick, label, badge = false }: { active: boolean, onClick: () => void, label: string, badge?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${
        active ? 'bg-slate-900 text-white shadow-md border border-slate-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'
      }`}
    >
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}
