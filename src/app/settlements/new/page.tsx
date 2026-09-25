"use client";

import React, { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ChevronRight, Save, AlertCircle, Receipt, User, Calendar, Plane, Calculator, Plus, Minus, CheckCircle, RefreshCw
} from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, readApiError } from '@/components/ui/feedback';
import { DEFAULT_EXIT_REENTRY_VISA_FEE, LOAN_DEDUCTIBLE_STATUSES } from '@/lib/constants';
import { formatDate } from '@/lib/dates';
import { formatMoney, sumMoney } from '@/lib/money';
import {
  computeSettlement,
  DEFAULT_EXCESS_DAY_COST,
  COUNSEL_PENDING_NOTE,
  isCounselPendingReason,
  TERMINATION_REASON_LABELS,
  TERMINATION_REASONS,
  type SettlementBreakdown,
  type SettlementTypeValue,
  type TerminationReasonValue,
} from '@/lib/settlement';
import { overtimeAmount } from '@/lib/payroll-core';

interface EmpLeave {
  id?: string;
  leaveType?: string | null;
  status?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  createdAt?: string | null;
  totalDays?: number | null;
  paidDays?: number | null;
  isOutsideKSA?: boolean | null;
  flightTicketAmount?: number | null;
  flightTicketOption?: string | null;
}

interface EmpAllowance { id?: string; amount?: number | null; isMonthly?: boolean | null }
interface EmpLoan { id?: string; status?: string | null; remainingAmount?: number | null; isForgiven?: boolean | null }
interface EmpOvertime { id?: string; date?: string | null; type?: string | null; amount?: number | null; hours?: number | null }

interface SettlementEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  basicSalary?: number | null;
  nationality?: string | null;
  joinDate?: string | null;
  leaveAccrualStartDate?: string | null;
  iqamaOrIdExp?: string | null;
  legalCompany?: { nameArabic?: string | null } | null;
  leaves?: EmpLeave[] | null;
  allowances?: EmpAllowance[] | null;
  loans?: EmpLoan[] | null;
  overtimeRequests?: EmpOvertime[] | null;
}

interface CustomItem { id: string; amount: string; reason: string }

/** Server-computed settlement returned by POST /api/settlements (authoritative amounts). */
interface ServerCalculation {
  workingDaysInMonth?: number;
  workingDaysSalary?: number;
  yearsOfService?: number;
  endOfServiceAmount?: number;
  leaveDaysToPay?: number;
  leaveCompensation?: number;
  additionalEntitlements?: number;
  overtime?: number;
  flightTicketAllowance?: number;
  loansDeduction?: number;
  excessDeduction?: number;
  totalDeductions?: number;
  totalSettlement?: number;
}

interface SavedResult {
  calculation: ServerCalculation;
  estimate: number;
  nextUrl: string;
}

type FieldChange = { target: { name: string; value: string } };

const DAY_MS = 24 * 60 * 60 * 1000;

let itemSeq = 0;
const newItem = (): CustomItem => ({ id: `item-${++itemSeq}`, amount: '', reason: '' });

/** Article 80 paragraphs (short labels; the statute text is the reference). */
const ARTICLE_80_CLAUSES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1', label: 'الاعتداء على صاحب العمل أو المدير المسؤول أو أحد الرؤساء أثناء العمل أو بسببه' },
  { value: '2', label: 'الإخلال بالالتزامات الجوهرية أو عدم إطاعة الأوامر المشروعة أو تعليمات السلامة رغم الإنذار الكتابي' },
  { value: '3', label: 'سوء السلوك أو ارتكاب عمل مخل بالشرف أو الأمانة' },
  { value: '4', label: 'فعل أو تقصير متعمد لإلحاق خسارة مادية بصاحب العمل (مع إبلاغ الجهات المختصة خلال 24 ساعة)' },
  { value: '5', label: 'اللجوء إلى التزوير للحصول على العمل' },
  { value: '6', label: 'العامل معيّن تحت الاختبار' },
  { value: '7', label: 'التغيب دون سبب مشروع (بعد الإنذار الكتابي المشروط)' },
  { value: '8', label: 'استغلال المركز الوظيفي للحصول على مكاسب شخصية' },
  { value: '9', label: 'إفشاء الأسرار الصناعية أو التجارية الخاصة بالعمل' },
];

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

/** Day of month of a 'YYYY-MM-DD' input value (time-zone independent). */
function dayOfMonth(v: string): number {
  const d = Number(v.slice(8, 10));
  return Number.isFinite(d) ? d : 0;
}
function monthOfValue(v: string): number {
  const m = Number(v.slice(5, 7));
  return Number.isFinite(m) ? m : 0;
}
/** 'YYYY-MM-DD' from a stored date-only value (UTC midnight). */
function toKey(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
/** UTC-midnight Date of a 'YYYY-MM-DD' value (or a stored date). */
function utcDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const recurringAllowances = (e: SettlementEmployee) =>
  sumMoney((e.allowances || []).filter((a) => a.isMonthly !== false).map((a) => a.amount || 0));

type SettlementForm = {
  employeeId: string;
  type: string;
  terminationReason: string;
  salaryBasis: string;
  lastWorkingDate: string;
  workingDaysInMonth: string;
  additionalNotes: string;
  requestFinalExitVisa: boolean;
  requestedLeaveDays: string;
  leaveOutsideKsa: boolean;
  visaFeeAmount: string;
  leaveStartDate: string;
  leaveEndDate: string;
  excessDaysSponsorshipCost: string;
  flightTicketOption: string;
  flightTicketAmount: string;
  ticketProvideType: string;
  ticketTripType: string;
  flightFrom: string;
  flightTo: string;
  flightDateFrom: string;
  flightDateTo: string;
  allowAssetsRetention: boolean;
  iqamaWarningAction: string;
  waiveExcessCost: boolean;
  /** Article 80 paragraph ('1'..'9'), required by the server with terminationReason ARTICLE_80. */
  article80Clause: string;
};

const INITIAL_FORM: SettlementForm = {
  employeeId: '',
  type: 'LEAVE_SETTLEMENT',
  terminationReason: '',
  salaryBasis: 'total', // Default to total salary (basic + allowances)
  lastWorkingDate: '',
  workingDaysInMonth: '',
  additionalNotes: '',
  requestFinalExitVisa: false,
  requestedLeaveDays: '',
  leaveOutsideKsa: false,
  visaFeeAmount: String(DEFAULT_EXIT_REENTRY_VISA_FEE),
  leaveStartDate: '',
  leaveEndDate: '',
  excessDaysSponsorshipCost: '30',
  flightTicketOption: '',
  flightTicketAmount: '',
  ticketProvideType: '',
  ticketTripType: 'ROUND_TRIP',
  flightFrom: '',
  flightTo: '',
  flightDateFrom: '',
  flightDateTo: '',
  allowAssetsRetention: false,
  iqamaWarningAction: 'OVERRIDE',
  waiveExcessCost: false,
  article80Clause: '',
};

/** Pre-fills the leave details from the employee's latest approved leave (LEAVE_SETTLEMENT only). */
function withLatestLeave(prev: SettlementForm, employees: SettlementEmployee[]): SettlementForm {
  if (prev.type !== 'LEAVE_SETTLEMENT' || !prev.employeeId) return prev;
  const selected = employees.find(e => e.id === prev.employeeId);
  if (!selected || !Array.isArray(selected.leaves) || selected.leaves.length === 0) return prev;
  const approvedLeaves = selected.leaves
    .filter((l) => l.status === 'APPROVED')
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  if (approvedLeaves.length === 0) return prev;
  const latestLeave = approvedLeaves[0];
  const newStartDate = toKey(latestLeave.startDate);
  const newEndDate = toKey(latestLeave.endDate);
  const newDays = latestLeave.totalDays ? String(latestLeave.totalDays) : '';
  const outsideKsa = latestLeave.isOutsideKSA === true;
  if (prev.leaveStartDate === newStartDate && prev.leaveEndDate === newEndDate && prev.requestedLeaveDays === newDays) return prev;
  return {
    ...prev,
    leaveStartDate: newStartDate,
    leaveEndDate: newEndDate,
    requestedLeaveDays: newDays,
    leaveOutsideKsa: outsideKsa,
    requestFinalExitVisa: outsideKsa,
    flightTicketAmount: latestLeave.flightTicketAmount ? String(latestLeave.flightTicketAmount) : prev.flightTicketAmount,
    flightTicketOption: latestLeave.flightTicketOption || prev.flightTicketOption,
  };
}

/** Settlement types of the Prisma SettlementType enum (the server rejects anything else). */
function normalizeType(v: string | null | undefined): SettlementTypeValue {
  return v === 'END_OF_SERVICE' ? 'END_OF_SERVICE' : 'LEAVE_SETTLEMENT';
}

/** Numeric input value ('' -> undefined, so the server applies its default). */
function numOrUndefined(v: string): number | undefined {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Request body of POST /api/settlements (also sent with preview: true for the live preview).
 * Only HR inputs are sent: the server computes every amount (balance, loans, overtime...).
 */
function buildSettlementBody(form: SettlementForm, manualEntitlements: number, manualDeductions: number) {
  return {
    employeeId: form.employeeId,
    type: normalizeType(form.type),
    terminationReason: form.type === 'END_OF_SERVICE' ? form.terminationReason : '',
    article80Clause: form.type === 'END_OF_SERVICE' && form.terminationReason === 'ARTICLE_80' ? form.article80Clause : '',
    salaryBasis: form.salaryBasis,
    lastWorkingDate: form.lastWorkingDate,
    leaveStartDate: form.type === 'LEAVE_SETTLEMENT' ? form.leaveStartDate : '',
    leaveEndDate: form.type === 'LEAVE_SETTLEMENT' ? form.leaveEndDate : '',
    requestedLeaveDays: form.type === 'LEAVE_SETTLEMENT' ? form.requestedLeaveDays : '',
    excessDaysSponsorshipCost: form.excessDaysSponsorshipCost,
    waiveExcessCost: form.waiveExcessCost,
    flightTicketOption: form.flightTicketOption,
    flightTicketAmount: form.flightTicketOption === 'amount' ? form.flightTicketAmount : '',
    leaveOutsideKsa: form.type === 'LEAVE_SETTLEMENT' && form.leaveOutsideKsa,
    requestFinalExitVisa: form.requestFinalExitVisa,
    flightFrom: form.flightFrom,
    flightTo: form.flightTo,
    flightDateFrom: form.flightDateFrom,
    flightDateTo: form.flightDateTo,
    manualEntitlements,
    manualDeductions,
  };
}

/**
 * Instant local estimate with THE server formulas (src/lib/settlement.ts). The page does not
 * know what payroll already paid or holds in drafts, so loans / overtime are approximations
 * here; the server preview (same function, full data) replaces it as soon as it arrives.
 */
function localEstimate(
  selected: SettlementEmployee,
  form: SettlementForm,
  manualEntitlements: number,
  manualDeductions: number,
  now: Date,
): { breakdown: SettlementBreakdown; overtimeCount: number } {
  const type = normalizeType(form.type);
  const lastWorkingDate = utcDate(form.lastWorkingDate);
  const lastMonthKey = (form.lastWorkingDate || '').slice(0, 7);
  const overtimes =
    type === 'END_OF_SERVICE' && lastMonthKey
      ? (selected.overtimeRequests || []).filter((ot) => {
          const key = toKey(ot.date);
          return !!key && key.slice(0, 7) >= lastMonthKey && key <= form.lastWorkingDate;
        })
      : [];
  const overtime = sumMoney(
    overtimes.map((ot) =>
      overtimeAmount(
        { date: utcDate(ot.date) ?? now, type: ot.type ?? null, hours: ot.hours ?? null, amount: ot.amount ?? null },
        { basicSalary: selected.basicSalary ?? 0 },
      ),
    ),
  );
  const outstandingLoans = sumMoney(
    (selected.loans || [])
      .filter((l) => LOAN_DEDUCTIBLE_STATUSES.includes(l.status || '') && (l.remainingAmount || 0) > 0 && !l.isForgiven)
      .map((l) => l.remainingAmount || 0),
  );
  const breakdown = computeSettlement({
    type,
    terminationReason: type === 'END_OF_SERVICE' && (TERMINATION_REASONS as readonly string[]).includes(form.terminationReason)
      ? (form.terminationReason as TerminationReasonValue)
      : null,
    salaryBasis: form.salaryBasis === 'basic' ? 'basic' : 'total',
    employee: {
      basicSalary: selected.basicSalary ?? 0,
      allowances: (selected.allowances || []).map((a) => ({ amount: a.amount ?? 0, isMonthly: a.isMonthly !== false })),
      joinDate: utcDate(selected.joinDate),
      nationality: selected.nationality ?? null,
      leaveAccrualStartDate: utcDate(selected.leaveAccrualStartDate),
    },
    lastWorkingDate,
    asOf: utcDate(toKey(now.toISOString())) ?? now,
    leaves: (selected.leaves || []).map((l) => ({
      leaveType: l.leaveType ?? '',
      status: l.status ?? '',
      startDate: utcDate(l.startDate),
      endDate: utcDate(l.endDate),
      createdAt: l.createdAt ? new Date(l.createdAt) : null,
      totalDays: l.totalDays ?? null,
      paidDays: l.paidDays ?? null,
    })),
    leaveStartDate: type === 'LEAVE_SETTLEMENT' ? utcDate(form.leaveStartDate) : null,
    leaveEndDate: type === 'LEAVE_SETTLEMENT' ? utcDate(form.leaveEndDate) : null,
    requestedLeaveDays: type === 'LEAVE_SETTLEMENT' ? (numOrUndefined(form.requestedLeaveDays) ?? null) : null,
    lastMonthAlreadyPaid: false,
    excessDayCost: numOrUndefined(form.excessDaysSponsorshipCost) ?? null,
    waiveExcessCost: form.waiveExcessCost,
    flightTicketOption: form.flightTicketOption || null,
    flightTicketAmount: numOrUndefined(form.flightTicketAmount) ?? null,
    outstandingLoans,
    overtime,
    manualEntitlements,
    manualDeductions,
    leaveOutsideKsa: type === 'LEAVE_SETTLEMENT' && form.leaveOutsideKsa,
  });
  return { breakdown, overtimeCount: overtimes.length };
}

export default function NewSettlementPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-slate-400 font-bold animate-pulse">جاري التحميل...</div>}>
      <SettlementContent />
    </Suspense>
  );
}

function SettlementContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [employees, setEmployees] = useState<SettlementEmployee[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [activeAssets, setActiveAssets] = useState<unknown[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedResult, setSavedResult] = useState<SavedResult | null>(null);
  const [now] = useState(() => new Date());

  const [customEntitlements, setCustomEntitlements] = useState<CustomItem[]>([]);
  const [customDeductions, setCustomDeductions] = useState<CustomItem[]>([]);

  // Initial values can come from URL query params (e.g. from an approved leave request).
  const [formData, setFormData] = useState<SettlementForm>(() => {
    const empId = searchParams.get('employeeId');
    if (!empId) return INITIAL_FORM;
    const lwd = searchParams.get('lwd');
    const outside = searchParams.get('outside');
    const settlementType = searchParams.get('type');
    const workingDays = lwd && /^\d{4}-\d{2}-\d{2}/.test(lwd) ? String(dayOfMonth(lwd)) : INITIAL_FORM.workingDaysInMonth;
    return {
      ...INITIAL_FORM,
      employeeId: empId,
      leaveStartDate: searchParams.get('ls') || INITIAL_FORM.leaveStartDate,
      leaveEndDate: searchParams.get('le') || INITIAL_FORM.leaveEndDate,
      requestedLeaveDays: searchParams.get('rd') || INITIAL_FORM.requestedLeaveDays,
      leaveOutsideKsa: outside === '1',
      lastWorkingDate: lwd || INITIAL_FORM.lastWorkingDate,
      workingDaysInMonth: workingDays,
      type: normalizeType(settlementType || INITIAL_FORM.type),
      requestFinalExitVisa: outside === '1',
    };
  });

  const fetchEmployees = useCallback(async () => {
    setEmployeesError(null);
    try {
      const res = await fetch('/api/employees');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setEmployeesError(await readApiError(res, 'تعذر تحميل قائمة الموظفين'));
        return;
      }
      const d = await res.json();
      if (Array.isArray(d)) {
        const list = d as SettlementEmployee[];
        setEmployees(list);
        setFormData(prev => withLatestLeave(prev, list));
      }
    } catch {
      setEmployeesError('تعذر الاتصال بالخادم لتحميل قائمة الموظفين');
    }
  }, []);

  useEffect(() => {
    fetchEmployees();
  }, [fetchEmployees]);

  // Custody (assets) still held by the selected employee block the settlement.
  useEffect(() => {
    if (!formData.employeeId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets?employeeId=${encodeURIComponent(formData.employeeId)}&active=true`);
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          if (!cancelled) toast.error(await readApiError(res, 'تعذر التحقق من العُهد المسجلة على الموظف'));
          return;
        }
        const d = await res.json();
        if (!cancelled) setActiveAssets(Array.isArray(d) ? d : []);
      } catch {
        if (!cancelled) toast.error('تعذر التحقق من العُهد المسجلة على الموظف');
      }
    })();
    return () => { cancelled = true; };
  }, [formData.employeeId]);

  const handleChange = (e: FieldChange) => {
    const { name } = e.target;
    let val = e.target.value;
    if (typeof val === 'string') {
      const arabicNumbers = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
      for (let i = 0; i < 10; i++) {
        val = val.split(arabicNumbers[i]).join(i.toString());
      }
      // Replace arabic decimal comma with english dot if needed
      val = val.replace('٫', '.');
    }
    let newData: SettlementForm = { ...formData, [name]: val };

    // Auto-calculate working days when lastWorkingDate changes
    if (name === 'lastWorkingDate' && val) {
      // حساب جميع الأيام بدون استثناء (لأن الراتب الشهري يشمل أيام الإجازة الأسبوعية)
      newData.workingDaysInMonth = String(dayOfMonth(val));
    }

    // Auto-calculate requested leave days when start or end date changes
    if (name === 'leaveStartDate' || name === 'leaveEndDate') {
      const start = utcDate(name === 'leaveStartDate' ? val : formData.leaveStartDate);
      const end = utcDate(name === 'leaveEndDate' ? val : formData.leaveEndDate);
      if (start && end && end >= start) {
        newData.requestedLeaveDays = String(Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
      }
    }

    if (name === 'employeeId') {
      setActiveAssets([]);
      setErrorMsg(null);
    }
    if (name === 'employeeId' || name === 'type') {
      // A custody exception approved for one settlement type never carries over to another one.
      newData.allowAssetsRetention = false;
      newData = withLatestLeave(newData, employees);
    }
    if (name === 'terminationReason' && val !== 'ARTICLE_80') newData.article80Clause = '';

    setFormData(newData);
  };

  const selectedEmployee = useMemo(() => employees.find(e => e.id === formData.employeeId), [employees, formData.employeeId]);

  const isIqamaExpiringDuringLeave = useMemo(() => {
    if (formData.type === 'LEAVE_SETTLEMENT' && formData.leaveEndDate && selectedEmployee && selectedEmployee.iqamaOrIdExp) {
      const leaveEnd = utcDate(formData.leaveEndDate);
      const iqamaExp = utcDate(selectedEmployee.iqamaOrIdExp);
      return !!leaveEnd && !!iqamaExp && leaveEnd > iqamaExp;
    }
    return false;
  }, [formData.type, formData.leaveEndDate, selectedEmployee]);

  const manualEntitlements = useMemo(() => sumMoney(customEntitlements.map((item) => parseFloat(item.amount) || 0)), [customEntitlements]);
  const manualDeductions = useMemo(() => sumMoney(customDeductions.map((item) => parseFloat(item.amount) || 0)), [customDeductions]);

  // --- Settlement preview ---
  // 1) instant local estimate with the server formulas (src/lib/settlement.ts);
  // 2) the server preview (POST /api/settlements { preview: true }) replaces it once it arrives,
  //    so the figures shown are exactly what will be saved.
  const local = useMemo(
    () => (selectedEmployee ? localEstimate(selectedEmployee, formData, manualEntitlements, manualDeductions, now) : null),
    [selectedEmployee, formData, manualEntitlements, manualDeductions, now],
  );
  const previewBody = useMemo(
    () => buildSettlementBody(formData, manualEntitlements, manualDeductions),
    [formData, manualEntitlements, manualDeductions],
  );
  const previewKey = JSON.stringify(previewBody);
  const [serverPreview, setServerPreview] = useState<{ key: string; calc: SettlementBreakdown; warnings: string[]; blockers: string[] } | null>(null);

  useEffect(() => {
    const body = JSON.parse(previewKey) as ReturnType<typeof buildSettlementBody>;
    if (!body.employeeId || !body.lastWorkingDate) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/settlements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, preview: true }),
        });
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) return; // keep the local estimate; errors are reported on save
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.calculation) {
          setServerPreview({
            key: previewKey,
            calc: data.calculation as SettlementBreakdown,
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
            blockers: Array.isArray(data.blockers) ? data.blockers : [],
          });
        }
      } catch {
        // offline: the local estimate stays on screen
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewKey]);

  const isServerPreview = !!serverPreview && serverPreview.key === previewKey;
  const previewWarnings = isServerPreview ? serverPreview.warnings : [];
  const previewBlockers = isServerPreview ? serverPreview.blockers : [];
  // The end-of-service award and the net amount depend on the reason: hidden until it is chosen.
  const reasonMissing = formData.type === 'END_OF_SERVICE' && !formData.terminationReason;

  const calculations = useMemo(() => {
    const b = isServerPreview ? serverPreview.calc : local?.breakdown;
    if (!b) return null;
    const excessDayCost = formData.waiveExcessCost ? 0 : (numOrUndefined(formData.excessDaysSponsorshipCost) ?? DEFAULT_EXCESS_DAY_COST);
    return {
      dailySalary: b.dailySalary,
      salaryUsed: b.salaryUsed,
      excessDayCost,
      workingDaysInMonth: b.workingDaysInMonth,
      workingDaysSalary: b.workingDaysSalary,
      yearsOfService: b.yearsOfService,
      endOfServiceAmount: b.endOfServiceAmount,
      accruedLeaveDays: b.accruedLeaveDays,
      unusedDays: b.unusedLeaveDays,
      leaveDaysToPay: b.leaveDaysToPay,
      requestedDays: b.requestedDays,
      leaveCompensation: b.leaveCompensation,
      excessDays: b.excessDays,
      excessDeduction: b.excessDeduction,
      negativeAccruedBalance: Math.max(0, -b.accruedLeaveDays),
      overtimeCount: local?.overtimeCount ?? 0,
      loansDeduction: b.loansDeduction,
      visaFeeAmount: b.visaFeeAmount,
      flightTicketAllowance: b.flightTicketAllowance,
      overtimeAndBonuses: b.overtime,
      additional: b.manualEntitlements,
      manualDeductions: b.manualDeductions,
      totalDeductions: b.totalDeductions,
      totalSettlement: b.totalSettlement,
    };
  }, [isServerPreview, serverPreview, local, formData.waiveExcessCost, formData.excessDaysSponsorshipCost]);

  const updateItem = (setter: React.Dispatch<React.SetStateAction<CustomItem[]>>, id: string, patch: Partial<CustomItem>) =>
    setter(items => items.map(it => it.id === id ? { ...it, ...patch } : it));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    setIsLoading(true);
    setErrorMsg(null);

    try {
      // تكوين تفاصيل إضافية للملاحظات
      let breakdownText = "";
      if (calculations) {
        if (calculations.flightTicketAllowance > 0) breakdownText += `- تعويض تذكرة طيران: ${calculations.flightTicketAllowance} ر.س\n`;
        if (formData.flightTicketOption === 'company_provided' && formData.ticketProvideType === 'COMPANY_BOOKING') {
          breakdownText += `- طلب حجز تذكرة: ${formData.ticketTripType === 'ONE_WAY' ? 'ذهاب فقط' : 'ذهاب وعودة'} (من: ${formData.flightFrom || 'غير محدد'} إلى: ${formData.flightTo || 'غير محدد'})، تاريخ الذهاب: ${formData.flightDateFrom || 'غير محدد'} ${formData.ticketTripType === 'ROUND_TRIP' ? 'تاريخ العودة: ' + (formData.flightDateTo || 'غير محدد') : ''}\n`;
        }
        if (calculations.visaFeeAmount > 0) breakdownText += `- رسوم تأشيرة خروج وعودة: طلب بقيمة ${calculations.visaFeeAmount} ر.س (تتحملها الشركة)\n`;
        if (formData.waiveExcessCost && calculations.excessDays > 0) breakdownText += `- إعفاء من خصم رصيد الإجازات السالب (${calculations.excessDays.toFixed(2)} يوم).\n`;
        const ents = customEntitlements.filter(c => c.amount);
        if (ents.length > 0) {
          breakdownText += `- مستحقات إضافية يدوية:\n`;
          ents.forEach(c => { breakdownText += `  * ${c.amount} ر.س (${c.reason || 'بدون تفاصيل'})\n`; });
        }
        const deds = customDeductions.filter(c => c.amount);
        if (deds.length > 0) {
          breakdownText += `- خصومات إضافية يدوية:\n`;
          deds.forEach(c => { breakdownText += `  * ${c.amount} ر.س (${c.reason || 'بدون تفاصيل'})\n`; });
        }
      }

      const finalNotes = formData.additionalNotes
        ? `${formData.additionalNotes}\n\nتفاصيل إضافية مجمعة آلياً:\n${breakdownText}`
        : breakdownText ? `تفاصيل إضافية مجمعة آلياً:\n${breakdownText}` : "";

      // The server recomputes every amount (end of service, leave, loans, overtime...);
      // only the HR-entered parts are sent (same body as the live preview).
      const payload = {
        ...buildSettlementBody(formData, manualEntitlements, manualDeductions),
        needsEarlyRenewal: isIqamaExpiringDuringLeave && formData.iqamaWarningAction === 'RENEW_EARLY',
        additionalNotes: finalNotes,
      };

      const res = await fetch('/api/settlements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ التصفية');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json().catch(() => null);
      const calculation: ServerCalculation = data?.calculation ?? data?.settlement ?? {};
      const nextUrl = isIqamaExpiringDuringLeave && formData.iqamaWarningAction === 'RENEW_EARLY'
        ? `/renewals?employeeId=${encodeURIComponent(formData.employeeId)}&earlyMode=true`
        : '/settlements';
      toast.success(typeof data?.message === 'string' ? data.message : 'تم إنشاء التصفية بنجاح');
      setSavedResult({ calculation, estimate: calculations?.totalSettlement ?? 0, nextUrl });
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        <div>
          <Link href="/settlements" className="inline-flex items-center gap-2 text-slate-400 hover:text-orange-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-orange-200 transition"><ChevronRight size={16} /></span>
            العودة لسجل التصفيات
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-orange-100 text-orange-600 p-3 rounded-2xl"><Receipt size={26} /></span>
            إجراء تصفية مستحقات
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">أداة مساعدة، والقرار النظامي مسؤولية المنشأة. المبالغ المعروضة تقديرية، ويعيد النظام احتسابها عند الحفظ.</p>
        </div>

        {employeesError && (
          <div role="alert" className="bg-amber-50 border-2 border-amber-200 rounded-[1.5rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-extrabold text-amber-800 text-[14px] flex items-center gap-3"><AlertCircle className="text-amber-500 shrink-0" size={22} /> {employeesError}</p>
            <button type="button" onClick={fetchEmployees} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-amber-200 text-amber-800 font-black text-[12px] rounded-xl hover:bg-amber-100 transition">
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

        <form id="settlement-form" onSubmit={handleSubmit} className="space-y-8">

          {/* 1. اختيار الموظف ونوع التصفية */}
          <Section title="اختيار الموظف ونوع التصفية" icon={<User size={16} className="text-blue-600" />} badge="مطلوب">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <SearchableSelect name="employeeId" value={formData.employeeId} onChange={handleChange} label="الموظف (بالرقم الوظيفي)" required accentColor="orange"
                options={employees.map(e => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''}`, value: e.id }))} />
              <SearchableSelect name="type" value={formData.type} onChange={handleChange} label="نوع التصفية" required accentColor="orange"
                options={[
                  { label: '🏖️ تصفية بغرض الإجازة', value: 'LEAVE_SETTLEMENT' },
                  { label: '🔚 تصفية بغرض إنتهاء الخدمة', value: 'END_OF_SERVICE' },
                ]} />
            </div>

            {selectedEmployee && (
              <div className={`bg-blue-50 border border-blue-100 rounded-[1.5rem] p-6 mt-6 grid grid-cols-2 ${formData.type === 'END_OF_SERVICE' ? 'md:grid-cols-6' : 'md:grid-cols-5'} gap-4 transition-all`}>
                <InfoBox label="الرقم الوظيفي" value={`#${selectedEmployee.employeeId}`} />
                <InfoBox label="الراتب الإجمالي" value={`${formatMoney((selectedEmployee.basicSalary || 0) + recurringAllowances(selectedEmployee))} ر.س`} />
                <InfoBox label="الجنسية" value={selectedEmployee.nationality || '-'} />
                {formData.type === 'END_OF_SERVICE' && (
                  <InfoBox label="تاريخ المباشرة" value={selectedEmployee.joinDate ? formatDate(selectedEmployee.joinDate) : '-'} />
                )}
                <InfoBox label="تاريخ احتساب الإجازة" value={selectedEmployee.leaveAccrualStartDate ? formatDate(selectedEmployee.leaveAccrualStartDate) : (selectedEmployee.joinDate ? formatDate(selectedEmployee.joinDate) : '-')} />
                <InfoBox label="الشركة" value={selectedEmployee.legalCompany?.nameArabic || '-'} />
              </div>
            )}

            {selectedEmployee && (
              <div className={`mt-6 p-5 ${calculations?.loansDeduction ? 'bg-red-50/50 border-red-300' : 'bg-emerald-50 border-emerald-200'} border-2 rounded-2xl flex items-center justify-between shadow-sm animate-in fade-in slide-in-from-top-4`}>
                 <div>
                   <p className={`text-[15px] font-black ${calculations?.loansDeduction ? 'text-red-800' : 'text-emerald-800'} mb-1`}>مديونيات السلف القائمة (نظام آلي)</p>
                   <p className={`text-[12px] font-bold ${calculations?.loansDeduction ? 'text-red-600' : 'text-emerald-600'}`}>
                     {calculations?.loansDeduction ? 'هناك سلف مسجلة على الموظف! سيتم سحب هذا المبلغ وإضافته للخصومات تلقائياً من إجمالي التصفية دون تفويض.' : 'لا يوجد سلف أو التزامات مالية غير مسددة على الموظف.'}
                   </p>
                 </div>
                 <div className={`px-5 py-3 bg-white rounded-xl shadow-sm border ${calculations?.loansDeduction ? 'border-red-200' : 'border-emerald-200'} flex shrink-0`}>
                   <span className={`font-black ${calculations?.loansDeduction ? 'text-red-600' : 'text-emerald-600'} font-mono text-[18px]`}>{formatMoney(calculations?.loansDeduction || 0)} <span className="text-[12px] font-sans">ر.س</span></span>
                 </div>
              </div>
            )}

            {activeAssets.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-[1.5rem] p-6 mt-6 flex flex-col gap-4 animate-in fade-in slide-in-from-top-4 duration-500">
                <div className="flex items-start gap-4">
                  <div className="bg-red-100 p-3 rounded-full shrink-0"><AlertCircle className="text-red-600" size={24} /></div>
                  <div>
                    <h4 className="font-black text-red-900 text-[15px] mb-1">تنبيه أمني يمنع التصفية: عُهَد لم يتم استردادها!</h4>
                    <p className="text-red-700 font-bold text-[13px] leading-relaxed">
                      لا يمكن إخلاء طرف الموظف أو اجراء تصفية له! الموظف بحوزته ({activeAssets.length}) عهدة نشطة حالياً. يرجى إخلاء العهد اولاً من قسم &quot;العهد&quot; لفتح إمكانية التصفية.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link href={`/assets`} target="_blank" className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-xl text-[12px] font-black shadow-sm transition">
                        الانتقال إلى إدارة العُهد لإخلاء الطرف
                      </Link>
                    </div>
                  </div>
                </div>
                {formData.type !== 'END_OF_SERVICE' ? (
                  <label className="flex items-center gap-3 cursor-pointer p-3.5 bg-white rounded-xl border border-red-200 mt-2 hover:border-red-400 transition w-full md:w-max">
                     <input type="checkbox" name="allowAssetsRetention" checked={formData.allowAssetsRetention} onChange={(e) => setFormData({...formData, allowAssetsRetention: e.target.checked})} className="w-5 h-5 text-red-600 rounded-md focus:ring-red-500 border-gray-300" />
                     <span className="font-black text-red-800 text-[13px]">استثناء والمتابعة: الموافقة على الاحتفاظ بالعهدة لدى الموظف</span>
                  </label>
                ) : (
                  <div className="p-3.5 bg-white/50 rounded-xl border border-red-200 mt-2 w-full md:w-max">
                     <span className="font-black text-red-800 text-[13px]">إخلاء الطرف إجباري: لا يمكن تجاوز أمانات أو عُهد الموظف في نهاية الخدمة.</span>
                  </div>
                )}
              </div>
            )}

            {selectedEmployee && formData.type === 'END_OF_SERVICE' && (
              <div className="mt-6 pt-6 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-6">
                <SearchableSelect name="terminationReason" value={formData.terminationReason} onChange={handleChange} label="سبب إنهاء العقد" required accentColor="orange"
                  options={[
                    { label: 'إنهاء من قبل الشركة أو بالاتفاق', value: 'COMPANY_TERMINATION' },
                    { label: 'الاستقالة', value: 'RESIGNATION' },
                    { label: 'انهاء خلال فترة التجربة', value: 'PROBATION' },
                    { label: 'فصل على المادة 80 من نظام العمل', value: 'ARTICLE_80' },
                    { label: `${TERMINATION_REASON_LABELS.ARTICLE_81} — ${COUNSEL_PENDING_NOTE}`, value: 'ARTICLE_81' },
                    { label: `${TERMINATION_REASON_LABELS.ARTICLE_87} — ${COUNSEL_PENDING_NOTE}`, value: 'ARTICLE_87' },
                    { label: `${TERMINATION_REASON_LABELS.CONTRACT_EXPIRY} — ${COUNSEL_PENDING_NOTE}`, value: 'CONTRACT_EXPIRY' },
                  ]} />
                {isCounselPendingReason(formData.terminationReason) && (
                  <div role="note" className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-4 text-[12px] font-bold leading-relaxed">
                    <span className="bg-amber-200 text-amber-900 px-2 py-0.5 rounded-md text-[11px] font-black shrink-0">{COUNSEL_PENDING_NOTE}</span>
                    <span>تُحتسب مكافأة نهاية الخدمة لهذا السبب كاملة مثل الإنهاء من قبل صاحب العمل. هذا الاحتساب مؤقت إلى أن يؤكده المستشار القانوني، فراجعه قبل الاعتماد.</span>
                  </div>
                )}
                {formData.terminationReason === 'ARTICLE_80' && (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="article80Clause" className="text-[12px] font-extrabold text-slate-700">
                      فقرة المادة 80 التي يستند إليها الفصل <span className="text-red-500">*</span>
                    </label>
                    <select
                      id="article80Clause"
                      name="article80Clause"
                      value={formData.article80Clause}
                      onChange={handleChange}
                      required
                      className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-orange-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[13px] focus:outline-none focus:ring-4 focus:ring-orange-100 transition-all"
                    >
                      <option value="">اختر الفقرة</option>
                      {ARTICLE_80_CLAUSES.map((c) => (
                        <option key={c.value} value={c.value}>{`${c.value}. ${c.label}`}</option>
                      ))}
                    </select>
                    <p className="text-[11px] font-bold text-slate-500 leading-relaxed">
                      يُشترط أيضاً تحقيق مسجل للموظف ثبتت فيه الإدانة. تُحفظ الفقرة في ملاحظات التصفية وسجل التدقيق.
                    </p>
                  </div>
                )}
              </div>
            )}

            {selectedEmployee && previewBlockers.length > 0 && (
              <div role="alert" className="mt-6 bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 space-y-2">
                <p className="font-black text-red-900 text-[14px] flex items-center gap-2"><AlertCircle size={18} className="text-red-600 shrink-0" /> لا يمكن حفظ التصفية بهذا السبب</p>
                {previewBlockers.map((b) => <p key={b} className="text-[13px] font-bold text-red-700 leading-relaxed">{b}</p>)}
              </div>
            )}

            {selectedEmployee && previewWarnings.length > 0 && (
              <div role="status" className="mt-6 bg-amber-50 border border-amber-200 rounded-[1.5rem] p-5">
                <p className="font-black text-amber-900 text-[14px] mb-2 flex items-center gap-2"><AlertCircle size={18} className="text-amber-600 shrink-0" /> تنبيهات من سجل الموظف (لا تمنع الحفظ)</p>
                <ul className="list-disc pr-5 space-y-1.5 text-[12px] font-bold text-amber-800 leading-relaxed">
                  {previewWarnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              </div>
            )}

            {formData.type === 'END_OF_SERVICE' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">

                {selectedEmployee && selectedEmployee.nationality !== 'SAUDI' && selectedEmployee.nationality !== 'سعودي' && selectedEmployee.nationality !== 'السعودية' && (
                  <div className="md:col-span-2 mt-2 flex items-center justify-between bg-orange-50/50 border border-orange-100 p-5 rounded-2xl group focus-within:ring-4 focus-within:ring-orange-100 transition-all">
                     <div>
                        <h4 className="font-black text-orange-900 text-[14px]">طلب إصدار تأشيرة (خروج نهائي) للمقيم</h4>
                        <p className="text-orange-600 font-bold text-[12px] mt-1 leading-relaxed">إذا كان الموظف الأجنبي سيغادر المملكة نهائياً، قم بتفعيل هذا الخيار ليتم رفع الطلب كـ (خروج نهائي) في سجل التأشيرات تلقائياً.</p>
                     </div>
                     <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input type="checkbox" name="requestFinalExitVisa" checked={formData.requestFinalExitVisa} onChange={(e) => setFormData({...formData, requestFinalExitVisa: e.target.checked})} className="sr-only peer" />
                        <div className="w-14 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-orange-500"></div>
                     </label>
                  </div>
                )}
              </div>
            )}


          </Section>

          {/* 2. تفاصيل الاحتساب */}
          <Section title="تفاصيل الاحتساب" icon={<Calendar size={16} className="text-amber-500" />} badge="حاسبة">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Field name="lastWorkingDate" value={formData.lastWorkingDate} onChange={handleChange} label="آخر يوم عمل" type="date" required />

              <div className="flex flex-col gap-2 group">
                <label className="text-[12px] font-extrabold text-slate-700">عدد أيام العمل خلال الشهر <span className="text-[10px] text-emerald-500 font-bold">(تلقائي)</span></label>
                <input type="number" name="workingDaysInMonth" value={calculations ? calculations.workingDaysInMonth : formData.workingDaysInMonth} readOnly
                  className="px-5 py-4 bg-emerald-50/50 border-2 border-emerald-200/50 rounded-[1.25rem] font-bold text-emerald-800 text-[14px] focus:outline-none cursor-default" />
                {formData.lastWorkingDate && (
                  <p className="text-[10px] font-bold text-slate-400">
                    {calculations && calculations.workingDaysInMonth === 0
                      ? 'رواتب هذا الشهر صُرفت في مسير رواتب معتمد، فلا تُحتسب أيام العمل مرة أخرى'
                      : `من 1/${monthOfValue(formData.lastWorkingDate)} إلى ${dayOfMonth(formData.lastWorkingDate)}/${monthOfValue(formData.lastWorkingDate)} (متصلة شاملة أيام الراحة الأسبوعية)`}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2 group">
                <label className="text-[12px] font-extrabold text-slate-700">الرصيد المستحق <span className="text-[10px] text-blue-500 font-bold">(تقديري)</span></label>
                <input type="text" value={calculations ? calculations.accruedLeaveDays.toFixed(2) : ''} readOnly
                  className="px-5 py-4 bg-blue-50/50 border-2 border-blue-200/50 rounded-[1.25rem] font-bold text-blue-800 text-[14px] focus:outline-none cursor-default text-right" />
              </div>

              {formData.type === 'LEAVE_SETTLEMENT' && (
                <>
                  <Field name="leaveStartDate" value={formData.leaveStartDate} onChange={handleChange} label="تاريخ بداية الإجازة" type="date" />
                  <Field name="leaveEndDate" value={formData.leaveEndDate} onChange={handleChange} label="تاريخ نهاية الإجازة" type="date" />
                </>
              )}

              {formData.type === 'LEAVE_SETTLEMENT' && selectedEmployee && isIqamaExpiringDuringLeave && (
                <div className="md:col-span-3 mt-2 p-5 bg-red-50/50 border border-red-200 rounded-2xl animate-in fade-in slide-in-from-top-2">
                  <div className="flex items-start gap-4">
                    <div className="bg-red-100 p-3 rounded-full shrink-0"><AlertCircle className="text-red-600" size={24} /></div>
                    <div className="flex-1">
                      <h4 className="font-black text-red-900 text-[15px] mb-1">تنبيه: الإقامة ستنتهي خلال فترة الإجازة!</h4>
                      <p className="text-red-700 font-bold text-[13px] leading-relaxed">
                        تاريخ انتهاء الإقامة ({formatDate(selectedEmployee.iqamaOrIdExp)}) يسبق تاريخ عودة الموظف من الإجازة. يرجى اتخاذ قرار:
                      </p>

                      <div className="mt-4 flex flex-col sm:flex-row gap-3">
                        <label className={`flex-1 flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${formData.iqamaWarningAction === 'OVERRIDE' ? 'border-red-500 bg-red-50' : 'border-slate-200 bg-white hover:border-red-200'}`}>
                          <input type="radio" name="iqamaWarningAction" value="OVERRIDE" checked={formData.iqamaWarningAction === 'OVERRIDE'} onChange={handleChange} className="w-5 h-5 text-red-600 focus:ring-red-500" />
                          <span className="font-black text-[13px] text-red-900">تجاوز وإكمال التصفية</span>
                        </label>

                        <label className={`flex-1 flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${formData.iqamaWarningAction === 'RENEW_EARLY' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white hover:border-emerald-200'}`}>
                          <input type="radio" name="iqamaWarningAction" value="RENEW_EARLY" checked={formData.iqamaWarningAction === 'RENEW_EARLY'} onChange={handleChange} className="w-5 h-5 text-emerald-600 focus:ring-emerald-500" />
                          <span className="font-black text-[13px] text-emerald-900">حفظ التصفية والانتقال للتجديد المبكر</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {formData.type === 'LEAVE_SETTLEMENT' && selectedEmployee && (
                <div className="md:col-span-3 mt-2 p-5 bg-indigo-50/50 border-2 border-indigo-200/50 rounded-2xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-black text-indigo-900 text-[14px] flex items-center gap-2">🌍 وجهة الإجازة (داخل أو خارج المملكة)</h4>
                      <p className="text-indigo-600 font-bold text-[12px] mt-1 leading-relaxed">
                        إذا كانت إجازة الموظف المقيم خارج المملكة، سيتم إنشاء طلب تأشيرة (خروج وعودة) تلقائياً في سجل التأشيرات وإحالتها لإدارة المدفوعات (تتحملها الشركة).
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0 mr-4">
                      <input type="checkbox" checked={formData.leaveOutsideKsa} onChange={(e) => setFormData({...formData, leaveOutsideKsa: e.target.checked})} className="sr-only peer" />
                      <div className="w-14 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-indigo-500"></div>
                      <span className={`mr-3 text-[12px] font-black ${formData.leaveOutsideKsa ? 'text-indigo-700' : 'text-slate-400'}`}>{formData.leaveOutsideKsa ? 'خارج المملكة ✈️' : 'داخل المملكة 🇸🇦'}</span>
                    </label>
                  </div>
                  {formData.leaveOutsideKsa && (
                    <div className="mt-4 p-4 bg-white border border-indigo-200 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="flex items-center gap-3">
                        <div className="bg-indigo-100 p-2.5 rounded-xl">
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-600"><path d="M2 12h20"/><path d="M5 12c0-4.4 3-8 7-8s7 3.6 7 8-3 8-7 8-7-3.6-7-8z"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                        </div>
                        <div>
                          <p className="text-[13px] font-black text-indigo-900">رسوم تأشيرة خروج وعودة</p>
                          <p className="text-[11px] font-bold text-indigo-600">سيتم إحالتها تلقائياً لسجل التأشيرات بحالة (بانتظار الدفع) على حساب الشركة.</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="flex flex-col items-center gap-1">
                          <label className="text-[10px] font-black text-indigo-800">مدة الإجازة (أيام)</label>
                          <div className="w-24 px-3 py-2.5 bg-indigo-50 border-2 border-indigo-200 text-center rounded-xl font-black text-indigo-900 text-[15px]">{calculations?.requestedDays || 0}</div>
                        </div>
                        <div className="bg-red-50 px-4 py-2 border border-red-200 rounded-xl flex flex-col items-center">
                          <p className="text-[10px] font-bold text-slate-400">الرسوم المحسوبة</p>
                          <p className="font-black text-red-600 text-[15px]">{calculations?.visaFeeAmount || 0} ر.س</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {formData.type === 'LEAVE_SETTLEMENT' && (
                <div className="flex flex-col gap-2 group">
                  <label className="text-[12px] font-extrabold text-slate-700">مدة الإجازة المطلوبة (أيام) <span className="text-[10px] text-blue-500 font-bold">(آلي)</span></label>
                  <input type="text" value={formData.requestedLeaveDays} readOnly placeholder="مثال: 30"
                    className="px-5 py-4 bg-blue-50/50 border-2 border-blue-200/50 rounded-[1.25rem] font-bold text-blue-800 text-[14px] focus:outline-none cursor-default text-right" />
                </div>
              )}
            </div>
          </Section>

          {/* 3. إضافات/خصومات */}
          <Section title="مستحقات وخصومات إضافية" icon={<Plus size={16} className="text-emerald-500" />} badge="اختياري">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              <div className="md:col-span-2 mb-2 p-5 bg-blue-50/50 border border-blue-100 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4">
                 <div>
                   <p className="text-[12px] font-extrabold text-blue-800 mb-1">مكافآت وأيام عمل إضافي معلقة (أوفرتايم) <span className="text-[10px] text-emerald-500">(تلقائي)</span></p>
                   <p className="text-[10px] font-bold text-blue-600">
                     {formData.type === 'END_OF_SERVICE'
                       ? 'تكليفات العمل الإضافي المعتمدة التي لن يصرفها مسير الرواتب (شهر آخر يوم عمل، أو المعتمدة بعد إقفال مسير شهرها).'
                       : 'لا يُحتسب العمل الإضافي في تصفية الإجازة: يصرفه مسير الرواتب الشهري.'}
                     <br/>الحساب: الساعات × (الراتب الأساسي ÷ 240) × 1.5 (× 2 في عطلة نهاية الأسبوع)، أو المبلغ المقطوع مباشرة.
                   </p>
                 </div>
                 <div className="flex items-center gap-2 shrink-0">
                   <div className="w-32 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-center font-black text-emerald-800">
                     {formatMoney(calculations?.overtimeAndBonuses || 0)}
                   </div>
                   <span className="text-[12px] font-bold text-blue-700">ر.س</span>
                 </div>
              </div>


              {calculations && calculations.excessDays > 0 && (
                <div className="md:col-span-2 mb-2 p-5 bg-orange-50/50 border border-orange-200 rounded-2xl flex flex-col gap-4">
                   <div className="flex items-center justify-between">
                     <div>
                       <p className="text-[14px] font-black text-orange-900 mb-1">يوجد أيام غير مدفوعة الأجر (بدون أجر)!</p>
                       <p className="text-[12px] font-bold text-orange-800">
                         طلب الموظف إجازة بمدة <span className="font-black">{calculations.requestedDays} يوم</span> ورصيده المستحق <span className="font-black">{calculations.unusedDays.toFixed(2)} يوم</span> فقط. وبناءً عليه سيتم تعويضه عن المدة المؤهلة فقط، واعتبار <span className="text-red-600 font-black">{calculations.excessDays.toFixed(2)} يوم</span> إجازة (بدون أجر). لا تدخل في التصفية.
                       </p>
                     </div>
                   </div>
                    <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex items-center gap-3">
                        <label className="text-[12px] font-black text-orange-800">تكلفة اليوم الواحد (ر.س):</label>
                        <input type="number" name="excessDaysSponsorshipCost" value={formData.excessDaysSponsorshipCost} onChange={handleChange}
                          className="w-28 px-3 py-2 bg-white border-2 border-orange-300 rounded-xl font-black text-orange-900 text-[14px] text-center focus:outline-none focus:border-orange-500" />
                      </div>

                      <label className={`flex items-center gap-2 cursor-pointer p-2.5 border rounded-xl transition-all ${formData.waiveExcessCost ? 'bg-emerald-50 border-emerald-300' : 'bg-white/50 border-orange-200 hover:bg-white'}`}>
                        <input type="checkbox" name="waiveExcessCost" checked={formData.waiveExcessCost} onChange={(e) => setFormData({...formData, waiveExcessCost: e.target.checked})} className="w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500 border-gray-300" />
                        <span className={`font-black text-[12px] ${formData.waiveExcessCost ? 'text-emerald-700' : 'text-orange-800'}`}>إعفاء من خصم التكلفة</span>
                      </label>
                    </div>
                </div>
              )}

              <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 border border-slate-100 p-5 rounded-2xl">
                {/* Entitlements List */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-[13px] font-extrabold text-emerald-700">مستحقات إضافية (ر.س)</label>
                    <button type="button" onClick={() => setCustomEntitlements([...customEntitlements, newItem()])} className="text-[11px] font-bold bg-emerald-100 text-emerald-700 px-3 py-1 rounded-lg flex items-center gap-1 hover:bg-emerald-200 transition">
                      <Plus size={12} /> إضافة بند
                    </button>
                  </div>
                  {customEntitlements.length === 0 && <p className="text-[12px] text-slate-400 font-semibold mb-2">لا يوجد مبالغ إضافية</p>}
                  {customEntitlements.map((ent) => (
                    <div key={ent.id} className="flex items-center gap-2 mb-2 animate-in fade-in">
                      <input type="number" min="0" step="0.01" aria-label="مبلغ المستحق الإضافي" placeholder="المبلغ" value={ent.amount} onChange={(e) => updateItem(setCustomEntitlements, ent.id, { amount: e.target.value })} className="w-1/3 px-3 py-2 border border-slate-200 rounded-xl text-[12px] font-bold focus:outline-none focus:border-emerald-400" />
                      <input type="text" placeholder="السبب (مثال: بدل تذاكر متأخرة)" value={ent.reason} onChange={(e) => updateItem(setCustomEntitlements, ent.id, { reason: e.target.value })} className="w-2/3 px-3 py-2 border border-slate-200 rounded-xl text-[12px] font-bold focus:outline-none focus:border-emerald-400" />
                      <button type="button" aria-label="حذف البند" onClick={() => setCustomEntitlements(customEntitlements.filter((it) => it.id !== ent.id))} className="text-rose-500 hover:text-rose-700"><Minus size={18} /></button>
                    </div>
                  ))}
                </div>
                {/* Deductions List */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-[13px] font-extrabold text-rose-700">خصومات إضافية (ر.س)</label>
                    <button type="button" onClick={() => setCustomDeductions([...customDeductions, newItem()])} className="text-[11px] font-bold bg-rose-100 text-rose-700 px-3 py-1 rounded-lg flex items-center gap-1 hover:bg-rose-200 transition">
                      <Plus size={12} /> إضافة بند
                    </button>
                  </div>
                  {customDeductions.length === 0 && <p className="text-[12px] text-slate-400 font-semibold mb-2">لا يوجد خصومات إضافية</p>}
                  {customDeductions.map((ded) => (
                    <div key={ded.id} className="flex items-center gap-2 mb-2 animate-in fade-in">
                      <input type="number" min="0" step="0.01" aria-label="مبلغ الخصم الإضافي" placeholder="المبلغ" value={ded.amount} onChange={(e) => updateItem(setCustomDeductions, ded.id, { amount: e.target.value })} className="w-1/3 px-3 py-2 border border-slate-200 rounded-xl text-[12px] font-bold focus:outline-none focus:border-rose-400" />
                      <input type="text" placeholder="السبب (مثال: غرامة إدارية)" value={ded.reason} onChange={(e) => updateItem(setCustomDeductions, ded.id, { reason: e.target.value })} className="w-2/3 px-3 py-2 border border-slate-200 rounded-xl text-[12px] font-bold focus:outline-none focus:border-rose-400" />
                      <button type="button" aria-label="حذف البند" onClick={() => setCustomDeductions(customDeductions.filter((it) => it.id !== ded.id))} className="text-rose-500 hover:text-rose-700"><Minus size={18} /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6 bg-indigo-50/50 border border-indigo-100 p-5 rounded-2xl">
                <SearchableSelect name="flightTicketOption" value={formData.flightTicketOption} onChange={handleChange} label="بند تذكرة الطيران" accentColor="indigo"
                  options={[
                    { label: '✈️ مؤمّنة من الشركة (بدون تعويض)', value: 'company_provided' },
                    { label: '💵 تعويض نقدي (إضافة مبلغ للمستحقات)', value: 'amount' },
                  ]} />
                {formData.flightTicketOption === 'amount' && (
                  <Field name="flightTicketAmount" value={formData.flightTicketAmount} onChange={handleChange} label="مبلغ التذكرة (ر.س)" type="number" placeholder="مثال: 1500" />
                )}
                {formData.flightTicketOption === 'company_provided' && (
                  <>
                    <hr className="md:col-span-2 border-indigo-200/50 my-1" />
                    <SearchableSelect name="ticketProvideType" value={formData.ticketProvideType} onChange={handleChange} label="نوع الحجز" accentColor="indigo"
                      options={[
                        { label: '🏢 حجز من قبل الشركة', value: 'COMPANY_BOOKING' },
                        { label: '🌐 حجز خارجي (من قبل الموظف)', value: 'EXTERNAL' },
                      ]} />

                    {formData.ticketProvideType === 'COMPANY_BOOKING' && (
                      <div className="md:col-span-2 bg-white/60 p-5 rounded-2xl border border-indigo-100 flex flex-col gap-5 mt-2">
                        <SearchableSelect name="ticketTripType" value={formData.ticketTripType} onChange={handleChange} label="مسار الرحلة" accentColor="indigo"
                          options={[
                            { label: '➡️ ذهاب فقط', value: 'ONE_WAY' },
                            { label: '🔁 ذهاب وعودة', value: 'ROUND_TRIP' },
                          ]} />

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <Field name="flightFrom" value={formData.flightFrom || ''} onChange={handleChange} label="جهة المغادرة (من)" placeholder="مثال: الرياض" />
                          <Field name="flightTo" value={formData.flightTo || ''} onChange={handleChange} label="جهة الوصول (إلى)" placeholder="مثال: القاهرة" />

                          <Field name="flightDateFrom" value={formData.flightDateFrom || ''} onChange={handleChange} label="تاريخ الذهاب" type="date" />
                          {formData.ticketTripType === 'ROUND_TRIP' && (
                            <Field name="flightDateTo" value={formData.flightDateTo || ''} onChange={handleChange} label="تاريخ العودة" type="date" />
                          )}
                        </div>
                        <p className="text-[11px] font-bold text-indigo-600 mt-1">سيتم إرفاق تفاصيل الرحلة ضمن الطلب لتحويله لإدارة التأشيرات والتذاكر.</p>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="md:col-span-2">
                <div className="flex flex-col gap-2 group">
                  <label className="text-[12px] font-extrabold text-slate-700">ملاحظات</label>
                  <textarea name="additionalNotes" value={formData.additionalNotes} onChange={handleChange} rows={3} placeholder="أي ملاحظات إضافية..."
                    className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-orange-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-orange-100 transition-all resize-none" />
                </div>
              </div>
            </div>
          </Section>

          {/* 4. ملخص الحسابات */}
          {calculations && selectedEmployee && (
            <div className="bg-slate-900 rounded-[2.5rem] p-8 md:p-10 shadow-2xl overflow-hidden relative">
              <Calculator className="absolute -left-10 -top-10 text-white/5" size={200} />

              <h3 className="text-white font-black text-xl mb-8 relative z-10 flex items-center gap-3">
                <span className="bg-white/10 p-2 rounded-xl border border-white/10"><Receipt size={20} className="text-orange-400" /></span>
                {isServerPreview ? 'ملخص التصفية (محسوب من النظام)' : 'ملخص تقديري للتصفية (معاينة)'}
              </h3>
              <p className={`relative z-10 -mt-5 mb-8 text-[12px] font-bold bg-white/5 border border-white/10 rounded-xl px-4 py-3 ${isServerPreview ? 'text-emerald-300/90' : 'text-amber-300/90'}`}>
                {isServerPreview
                  ? 'هذه المبالغ محسوبة من سجل الموظف بنفس طريقة الحفظ (الرصيد، السلف، العمل الإضافي غير المصروف...). يعيد النظام التحقق منها عند الحفظ.'
                  : 'تقدير أولي بنفس معادلات النظام؛ جاري جلب الأرقام الدقيقة من سجل الموظف (السلف المحجوزة في المسيرات، العمل الإضافي غير المصروف...).'}
              </p>
              {previewWarnings.length + previewBlockers.length > 0 && (
                <p className="relative z-10 -mt-4 mb-6 text-[12px] font-bold text-amber-200 bg-amber-500/10 border border-amber-400/30 rounded-xl px-4 py-3">
                  توجد تنبيهات على هذه التصفية ({previewWarnings.length + previewBlockers.length})، راجعها في قسم «اختيار الموظف ونوع التصفية».
                </p>
              )}

              <div className="relative z-10 space-y-4">
                {/* Working days */}
                <CalcRow label="عدد ايام العمل للشهر الجاري" sublabel={`${calculations.workingDaysInMonth} يوم × ${calculations.dailySalary.toFixed(2)} ر.س`} amount={calculations.workingDaysSalary} color="text-white" />

                {/* End of service */}
                {formData.type === 'END_OF_SERVICE' && reasonMissing && (
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <p className="text-white font-bold text-[14px]">مكافأة نهاية الخدمة</p>
                    <span className="text-amber-300 font-bold text-[12px]">تُعرض بعد اختيار سبب إنهاء العقد</span>
                  </div>
                )}
                {formData.type === 'END_OF_SERVICE' && !reasonMissing && (
                  <CalcRow
                    label="مكافأة نهاية الخدمة"
                    sublabel={`${calculations.yearsOfService.toFixed(1)} سنة خدمة${formData.terminationReason === 'RESIGNATION' && calculations.yearsOfService < 2 ? ' (لا يستحق - استقالة قبل سنتين)' : isCounselPendingReason(formData.terminationReason) ? ` (${COUNSEL_PENDING_NOTE})` : formData.terminationReason === 'PROBATION' || formData.terminationReason === 'ARTICLE_80' ? ' (لا يستحق)' : ''}`}
                    amount={calculations.endOfServiceAmount}
                    color={calculations.endOfServiceAmount > 0 ? "text-emerald-400" : "text-red-400"}
                  />
                )}


                {/* Leave */}
                <CalcRow label="بدل الإجازة السنوية" sublabel={`${Math.max(0, calculations.leaveDaysToPay).toFixed(2)} يوم مؤهل × ${calculations.dailySalary.toFixed(2)} ر.س`} amount={calculations.leaveCompensation} color="text-blue-400" />

                {/* Additional */}
                {calculations.additional > 0 && (
                  <CalcRow label="مستحقات إضافية" sublabel="" amount={calculations.additional} color="text-emerald-400" icon={<Plus size={14} />} />
                )}

                {calculations.flightTicketAllowance > 0 && (
                  <CalcRow label="بدل تذكرة طيران" sublabel="مستحقات إضافية مقطوعة" amount={calculations.flightTicketAllowance} color="text-indigo-400" icon={<Plane size={14} />} />
                )}

                {calculations.overtimeAndBonuses > 0 && (
                  <CalcRow label="مكافآت وتكليفات معلقة" sublabel="تقدير من تكليفات العمل الإضافي المعتمدة" amount={calculations.overtimeAndBonuses} color="text-emerald-400" icon={<Plus size={14} />} />
                )}

                {/* Deductions breakdown */}
                {calculations.excessDeduction > 0 && (
                  <CalcRow label={calculations.excessDays > 0 ? `خصم تكلفة أيام الإجازة الزائدة (${calculations.excessDays} يوم)` : "استرداد تجاوز رصيد سابق للإجازات"} sublabel={calculations.excessDays > 0 ? `${calculations.excessDays} يوم زائد × ${calculations.excessDayCost.toFixed(2)} ر.س/يوم` : `${(calculations.negativeAccruedBalance).toFixed(2)} يوم سالب × ${calculations.excessDayCost.toFixed(2)} ر.س/يوم`} amount={-calculations.excessDeduction} color="text-red-400" icon={<Minus size={14} />} />
                )}
                {calculations.visaFeeAmount > 0 && (
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <div className="flex items-center gap-3">
                      <span className="text-slate-400"><Plane size={14} /></span>
                      <div>
                        <p className="text-slate-300 font-bold text-[14px]">رسوم تأشيرة الخروج والعودة (للعلم)</p>
                        <p className="text-slate-500 text-[11px] font-semibold">لا تخصم من الموظف وتتحملها الشركة (يُحال الطلب لسجل التأشيرات)</p>
                      </div>
                    </div>
                    <span className="font-black text-lg text-slate-400">{formatMoney(calculations.visaFeeAmount || 0)} <span className="text-[10px] opacity-60">ر.س</span></span>
                  </div>
                )}
                {calculations.loansDeduction > 0 && (
                  <CalcRow label="سداد السلف (تلقائي)" sublabel="إجمالي المديونيات غير المسددة" amount={-calculations.loansDeduction} color="text-red-400" icon={<Minus size={14} />} />
                )}
                {calculations.manualDeductions > 0 && (
                  <CalcRow label="خصومات إضافية (يدوية)" sublabel="" amount={-calculations.manualDeductions} color="text-red-400" icon={<Minus size={14} />} />
                )}

                {/* Divider */}
                <div className="border-t border-white/10 pt-6 mt-6 flex flex-col md:flex-row items-center justify-between gap-4">
                  <div>
                    <p className="text-white/50 font-bold text-[13px] uppercase tracking-widest">صافي التصفية التقديري</p>
                    <p className="text-white/30 text-[11px] font-semibold mt-1">يُعتمد المبلغ الذي يحتسبه النظام عند الحفظ</p>
                  </div>
                  {reasonMissing ? (
                    <div className="bg-white/10 px-6 py-5 rounded-3xl border border-white/20 text-amber-200 font-bold text-[13px] text-center">
                      اختر سبب إنهاء العقد لعرض الصافي
                    </div>
                  ) : (
                    <div className="bg-white/10 px-10 py-6 rounded-3xl border border-white/20 backdrop-blur-md">
                      <span className="text-4xl md:text-5xl font-black text-white">{formatMoney(calculations.totalSettlement)}</span>
                      <span className="text-orange-400 font-extrabold text-sm mr-2">ر.س</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </form>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/settlements" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">إلغاء</Link>
        <button type="submit" form="settlement-form" disabled={isLoading || !!savedResult || previewBlockers.length > 0 || (activeAssets.length > 0 && !formData.allowAssetsRetention)}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg flex items-center gap-2">
          {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {activeAssets.length > 0 && !formData.allowAssetsRetention ? 'مغلق لوجود عهد' : previewBlockers.length > 0 ? 'راجع سبب الإنهاء' : isLoading ? 'جاري الحفظ...' : 'حفظ التصفية'}
        </button>
      </div>

      {/* Server result after saving (authoritative amounts) */}
      {savedResult && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="settlement-saved-title">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden border border-slate-100">
            <div className="px-8 py-6 border-b border-slate-100 bg-emerald-50/60 flex items-center gap-3">
              <CheckCircle className="text-emerald-600 shrink-0" size={26} />
              <div>
                <h3 id="settlement-saved-title" className="text-lg font-black text-slate-800">تم حفظ التصفية بانتظار تعميد صاحب العمل</h3>
                <p className="text-[12px] font-bold text-slate-500 mt-1">المبالغ أدناه هي المبالغ الرسمية التي احتسبها النظام.</p>
              </div>
            </div>
            <div className="p-8 space-y-3 text-[13px]">
              <ResultRow label="رواتب أيام العمل" value={savedResult.calculation.workingDaysSalary} />
              {(savedResult.calculation.endOfServiceAmount ?? 0) > 0 && <ResultRow label="مكافأة نهاية الخدمة" value={savedResult.calculation.endOfServiceAmount} />}
              <ResultRow label="بدل الإجازة السنوية" value={savedResult.calculation.leaveCompensation} />
              {(savedResult.calculation.additionalEntitlements ?? 0) > 0 && <ResultRow label="مستحقات إضافية (يدوية + تذكرة + عمل إضافي)" value={savedResult.calculation.additionalEntitlements} />}
              {(savedResult.calculation.totalDeductions ?? 0) > 0 && <ResultRow label="إجمالي الخصومات" value={-(savedResult.calculation.totalDeductions ?? 0)} negative />}
              <div className="flex items-center justify-between bg-slate-900 text-white rounded-2xl px-5 py-4 mt-4">
                <span className="font-black">صافي التصفية المعتمد</span>
                <span className="font-black text-xl text-orange-300">{formatMoney(savedResult.calculation.totalSettlement)} ر.س</span>
              </div>
              {typeof savedResult.calculation.totalSettlement === 'number' && Math.abs(savedResult.calculation.totalSettlement - savedResult.estimate) >= 0.01 && (
                <p className="text-[12px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                  يختلف المبلغ الرسمي عن التقدير المعروض سابقاً ({formatMoney(savedResult.estimate)} ر.س) بسبب إعادة الاحتساب من سجل الموظف على الخادم.
                </p>
              )}
            </div>
            <div className="px-8 pb-8">
              <button type="button" onClick={() => router.push(savedResult.nextUrl)} className="w-full bg-slate-900 hover:bg-orange-600 text-white font-black text-[13px] px-8 py-3.5 rounded-xl transition">
                {savedResult.nextUrl === '/settlements' ? 'الانتقال لسجل التصفيات' : 'متابعة التجديد المبكر للإقامة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

function ResultRow({ label, value, negative = false }: { label: string; value: number | undefined; negative?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
      <span className="font-bold text-slate-600">{label}</span>
      <span className={`font-black ${negative ? 'text-rose-600' : 'text-slate-800'}`}>{formatMoney(value ?? 0)} ر.س</span>
    </div>
  );
}

function CalcRow({ label, sublabel, amount, color, icon }: { label: string; sublabel?: string; amount: number; color: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/5">
      <div className="flex items-center gap-3">
        {icon && <span className={color}>{icon}</span>}
        <div>
          <p className="text-white font-bold text-[14px]">{label}</p>
          {sublabel && <p className="text-white/40 text-[11px] font-semibold">{sublabel}</p>}
        </div>
      </div>
      <span className={`font-black text-lg ${color}`}>{formatMoney(amount || 0)} <span className="text-[10px] opacity-60">ر.س</span></span>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: React.ReactNode }) {
  return (<div><p className="text-[10px] font-bold text-blue-500 mb-1 uppercase tracking-wider">{label}</p><p className="font-black text-blue-900 text-[14px]">{value}</p></div>);
}

function Section({ title, badge, icon, children }: { title: string; badge: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-visible">
      <div className="px-8 py-5 border-b border-slate-100 flex items-center gap-3">
        <span className="w-9 h-9 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center">{icon}</span>
        <h2 className="font-extrabold text-[15px] text-slate-800">{title}</h2>
        <span className="mr-auto text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 px-2.5 py-1 rounded-lg">{badge}</span>
      </div>
      <div className="p-8">{children}</div>
    </div>
  );
}

function Field({ name, value, onChange, label, type = 'text', required = false, placeholder }: {
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-2 group">
      <label className="text-[12px] font-extrabold text-slate-700">{label} {required && <span className="text-red-500">*</span>}</label>
      <input type={type === 'number' ? 'text' : type}
        inputMode={type === 'number' ? 'decimal' : undefined}
        name={name} value={value} onChange={onChange} required={required} placeholder={placeholder}
        {...(type === "date" ? { dir: "ltr", lang: "en" } : {})}
        {...(type === "number" ? { dir: "ltr", style: { textAlign: 'right' } } : {})}
        className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-orange-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-orange-100 transition-all text-right" />
    </div>
  );
}
