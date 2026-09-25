"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Wallet, CalendarDays, PiggyBank, FileText, CheckCircle, AlertTriangle, ShieldAlert, AlertCircle,
  Clock, CalendarClock, DownloadCloud, Receipt, Activity, X, Plane, UserPlus, Send, Ban,
  Fingerprint, History, ClipboardCheck, Star, RefreshCw, Printer, ChevronLeft, LayoutGrid, Home,
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Modal from '@/components/ui/Modal';
import { redirectToLogin } from './_components/redirect-to-login';
import FileUploadField from '@/components/FileUploadField';
import Link from 'next/link';
import { toast, readApiError, confirmDialog } from '@/components/ui/feedback';
import { formatDate, formatDateShort, inclusiveDays, todayKey } from '@/lib/dates';
import { formatMoney, sumMoney } from '@/lib/money';
import { LOAN_DEDUCTIBLE_STATUSES, PAYROLL_STATUS } from '@/lib/constants';
import {
  BALANCE_LEAVE_TYPES,
  BEREAVEMENT_RELATIONS,
  BEREAVEMENT_RELATION_LABELS,
  EVENT_DATED_LEAVE_TYPES,
  LEAVE_NOTE_MARKERS,
  LEAVE_TYPES,
  LEAVE_TYPE_LABELS,
} from '@/lib/leave';
import { ibanWarning, normalizeIban } from '@/lib/iban';
import { SAUDI_BANKS } from '@/lib/banks';
import { useRole } from '@/context/RoleContext';
import CircularsSection from './_components/CircularsSection';
import UnlinkedAccountCard from './_components/UnlinkedAccountCard';
import PortalTabBar, { type PortalTab } from './_components/PortalTabBar';
import ClockCard, { type PunchRejection } from './_components/ClockCard';
import { cancellableLeaveId, formatLeaveDays, isUnlinkedAccount, leavePreviewQuery, parseLeavePreview, type LeavePreview } from './_lib';

// ---------------------------------------------------------------------------
// Types (shape of GET /api/portal and related endpoints)
// ---------------------------------------------------------------------------

interface PortalAllowance { id: string; name?: string | null; amount?: number | null; isMonthly?: boolean | null }
interface PortalPayroll {
  id: string; month: number; year: number; status?: string | null;
  basicSalary?: number | null; totalAllowances?: number | null; totalDeductions?: number | null;
  overtimeCost?: number | null; netSalary: number | null;
}
interface PortalLoan { id: string; status?: string | null; remainingAmount?: number | null }
interface PortalHistory {
  id: string; type: string; details?: string | null; status: string; date: string; attachment?: string | null;
  /** Own leaves only: id + whether the employee may still cancel it (PENDING). */
  leaveId?: string | null; canCancel?: boolean | null;
  /** Where the request stands (MANAGER / HR / APPROVED / REJECTED ...) with its Arabic label, and the reviewers' notes. */
  stage?: string | null; stageLabel?: string | null;
  managerComment?: string | null; hrComment?: string | null; rejectionReason?: string | null;
}
interface PortalAttendance {
  id: string; date: string; checkIn?: string | null; checkOut?: string | null; status: string;
  lateMinutes?: number | null; earlyMinutes?: number | null;
}
interface MedicalInsurance {
  id?: string; insuranceIssuer?: string | null; policyNumber?: string | null; expiryDate?: string | null;
  medicalNetwork?: string | null; coverageType?: string | null; insuranceClass?: string | null;
  policyCost?: number | null; coverageUrl?: string | null; benefitsUrl?: string | null;
}
interface PortalCompany { nameArabic?: string | null; medicalInsurances?: MedicalInsurance[] }
interface PortalEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  jobTitle?: string | null;
  nationality?: string | null;
  basicSalary?: number | null;
  branch?: { nameArabic?: string | null } | null;
  actualCompany?: PortalCompany | null;
  legalCompany?: PortalCompany | null;
  allowances?: PortalAllowance[];
  payrolls?: PortalPayroll[];
  loans?: PortalLoan[];
  history?: PortalHistory[];
  attendances?: PortalAttendance[];
  /** Optional: provided by newer versions of /api/portal. */
  leaveBalance?: { available?: number | null; pending?: number | null } | null;
}
interface PendingEvaluation {
  id: string; updatedAt: string; totalScore?: number | null; finalRating?: string | null;
  strengths?: string | null; improvements?: string | null; finalNotes?: string | null;
  cycle?: { title?: string | null } | null;
}
interface LeaveBalanceResponse { available?: number | null; pending?: number | null }

type SubmitKey = 'termination' | 'correction' | 'leave' | 'loan' | 'general';

const EMPTY_LEAVE = { leaveType: 'ANNUAL', startDate: '', endDate: '', notes: '', eventDate: '', bereavementRelation: 'FIRST_DEGREE' };
const EMPTY_LOAN = { amount: '', monthlyInstallment: '', reason: '' };
const EMPTY_GENERAL = { requestType: 'VISIT_CERT', details: '', email: '', mobile: '', iban: '', bankName: '', ibanCertificateUrl: '', assetType: 'LAPTOP' };

/** Event label per event-dated leave type (the date the statutory window counts from). */
const LEAVE_EVENT_LABELS: Record<string, string> = {
  PATERNITY: 'تاريخ الولادة',
  BEREAVEMENT: 'تاريخ الوفاة',
  MARRIAGE: 'تاريخ عقد الزواج',
};

const CORRECTION_TYPE_OPTIONS = [
  { value: 'ABSENT', label: 'نسيان بصمة أو غياب مسجّل' },
  { value: 'LATE', label: 'تأخير في الحضور' },
  { value: 'EARLY_LEAVE', label: 'خروج مبكر' },
  { value: 'GENERAL', label: 'أخرى' },
] as const;

const MOBILE_PATTERN = /^05\d{8}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Serializes the structured data-update form into tagged lines. HR approval (src/lib/hr-workflows.ts
 * parseDataUpdateRequest) applies ONLY the tagged mobile / email lines; the IBAN is changed by HR
 * by hand after checking the certificate. Notes stay on one untagged line so they are never applied.
 */
function buildDataUpdateReason(d: typeof EMPTY_GENERAL): string {
  const lines = ['[طلب: تحديث بيانات]'];
  if (d.mobile.trim()) lines.push(`الجوال: ${d.mobile.trim()}`);
  if (d.email.trim()) lines.push(`البريد: ${d.email.trim()}`);
  if (d.iban.trim()) {
    lines.push(`الآيبان: ${normalizeIban(d.iban)}`);
    if (d.bankName) lines.push(`اسم البنك: ${d.bankName}`);
    if (d.ibanCertificateUrl) lines.push(`شهادة الآيبان: ${d.ibanCertificateUrl}`);
  }
  const notes = d.details.replace(/\s+/g, ' ').trim();
  if (notes) lines.push(`ملاحظات الموظف: ${notes}`);
  return lines.join('\n');
}

const GENERAL_TYPE_LABELS: Record<string, string> = {
  VISIT_CERT: 'تصديق زيارة',
  DATA_UPDATE: 'تحديث بيانات',
  SALARY_CERT: 'شهادة راتب',
  EXPERIENCE_LETTER: 'شهادة خبرة',
  EMPLOYMENT_LETTER: 'خطاب تعريف بالراتب',
  MEDICAL_INSURANCE: 'التأمين الطبي',
  ASSET: 'طلب عهدة',
  OTHER: 'طلب آخر',
};

/** Asset types an employee may request for themselves (same values as /asset-request). */
const ASSET_TYPE_OPTIONS = [
  { value: 'LAPTOP', label: 'جهاز حاسب آلي (لابتوب)' },
  { value: 'MOBILE', label: 'جهاز هاتف (جوال)' },
  { value: 'SIM', label: 'شريحة اتصال / بيانات' },
  { value: 'OTHER', label: 'عهدة أخرى' },
] as const;

/** Entries of the "طلبات أخرى" section (MEDICAL_VIEW opens the insurance card, the rest the request form). */
const OTHER_REQUESTS: ReadonlyArray<{ type: string; label: string; hint: string }> = [
  { type: 'SALARY_CERT', label: 'شهادة راتب', hint: 'لجهة حكومية أو بنك' },
  { type: 'EMPLOYMENT_LETTER', label: 'خطاب تعريف بالراتب', hint: 'موجّه إلى جهة تحددها' },
  { type: 'EXPERIENCE_LETTER', label: 'شهادة خبرة', hint: 'بمدة خدمتك ومسماك الوظيفي' },
  { type: 'VISIT_CERT', label: 'تصديق زيارة', hint: 'اسم الجهة والغرض والتاريخ' },
  { type: 'DATA_UPDATE', label: 'تحديث بياناتي', hint: 'الجوال، البريد، الحساب البنكي' },
  { type: 'ASSET', label: 'طلب عهدة', hint: 'جهاز، جوال، شريحة' },
  { type: 'MEDICAL_VIEW', label: 'التأمين الطبي', hint: 'عرض الوثيقة، إضافة تابع، ترقية' },
  { type: 'OTHER', label: 'طلب آخر', hint: 'أي طلب لا يندرج تحت ما سبق' },
];

/** Sections reachable from the bottom tab bar on phones. */
const PORTAL_TABS: readonly PortalTab[] = [
  { id: 'portal-home', label: 'الرئيسية', icon: Home },
  { id: 'portal-requests', label: 'طلباتي', icon: History },
  { id: 'portal-payslips', label: 'الرواتب', icon: Receipt },
  { id: 'portal-attendance', label: 'الحضور', icon: Fingerprint },
  { id: 'portal-more', label: 'المزيد', icon: LayoutGrid },
];

const OUTSIDE = `${LEAVE_NOTE_MARKERS.OUTSIDE} `;
const ACCEPT = `${LEAVE_NOTE_MARKERS.ACCEPT_EXCESS} `;


function formatTime(d: string | null | undefined): string {
  if (!d) return '--:--';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function ratingClass(rating: string | null | undefined): string {
  if (rating === 'ممتاز') return 'bg-emerald-50 text-emerald-600';
  if (rating === 'جيد جداً') return 'bg-blue-50 text-blue-600';
  if (rating === 'جيد') return 'bg-amber-50 text-amber-600';
  return 'bg-red-50 text-red-600';
}

function scoreClass(score: number): string {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 60) return 'text-amber-600';
  return 'text-red-600';
}

export default function EmployeePortalPage() {
  const [employee, setEmployee] = useState<PortalEmployee | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Current annual leave balance (today). null = unknown (request failed / not loaded).
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  // Paid days of pending balance leaves (not yet subtracted from `currentBalance`).
  const [currentPending, setCurrentPending] = useState<number | null>(null);

  // Termination Request Modal State
  const [isTerminationModalOpen, setIsTerminationModalOpen] = useState(false);
  const [terminationType, setTerminationType] = useState('END_OF_CONTRACT');
  const [exitRoute, setExitRoute] = useState('FINAL_EXIT'); // FINAL_EXIT | TRANSFER
  const [terminationReason, setTerminationReason] = useState('');

  // Fingerprint Correction Modal State
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [correctionDate, setCorrectionDate] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionAttachmentUrl, setCorrectionAttachmentUrl] = useState('');
  const [correctionType, setCorrectionType] = useState<string>('ABSENT');
  // Rejected self punch the correction is about (its server time is used when HR approves).
  const [correctionPunchId, setCorrectionPunchId] = useState<string | null>(null);

  // Leave & Loan Modal States
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [leaveData, setLeaveData] = useState(EMPTY_LEAVE);
  // Balance as of the selected start date (the same value the server validates against).
  const [leaveBalance, setLeaveBalance] = useState<number | null>(null);
  const [leavePending, setLeavePending] = useState<number | null>(null);
  const [leaveBalanceLoading, setLeaveBalanceLoading] = useState(false);
  const [leaveBalanceError, setLeaveBalanceError] = useState(false);

  const [isLoanModalOpen, setIsLoanModalOpen] = useState(false);
  const [loanData, setLoanData] = useState(EMPTY_LOAN);

  // One submitting flag per form (modals no longer share a single flag).
  const [submitting, setSubmitting] = useState<SubmitKey | null>(null);

  // General Request Modal State
  const [isGeneralModalOpen, setIsGeneralModalOpen] = useState(false);
  const [generalData, setGeneralData] = useState(EMPTY_GENERAL);

  // Medical Insurance Modal
  const [isMedicalModalOpen, setIsMedicalModalOpen] = useState(false);

  // Payslip details modal
  const [selectedPayslip, setSelectedPayslip] = useState<PortalPayroll | null>(null);

  // Evaluation Acknowledgment State
  const [pendingEvals, setPendingEvals] = useState<PendingEvaluation[]>([]);
  const [evalComments, setEvalComments] = useState<Record<string, string>>({});
  const [ackSubmittingId, setAckSubmittingId] = useState<string | null>(null);

  const loadPortal = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
      setNotFound(false);
    }
    try {
      const res = await fetch('/api/portal', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        setEmployee(null);
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل بيانات البوابة');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      const data = (await res.json()) as PortalEmployee;
      setEmployee(data);
      if (typeof data.leaveBalance?.available === 'number') setCurrentBalance(data.leaveBalance.available);
      if (typeof data.leaveBalance?.pending === 'number') setCurrentPending(data.leaveBalance.pending);
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, []);

  const loadCurrentBalance = useCallback(async () => {
    try {
      const res = await fetch('/api/leaves/balance', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) return;
      const data = (await res.json()) as LeaveBalanceResponse;
      if (typeof data.available === 'number') setCurrentBalance(data.available);
      if (typeof data.pending === 'number') setCurrentPending(data.pending);
    } catch {
      // Balance is informational on the dashboard; the card shows "—" when unknown.
    }
  }, []);

  const loadPendingEvals = useCallback(async () => {
    try {
      const res = await fetch('/api/evaluations?view=employee-pending', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) return;
      const d: unknown = await res.json();
      if (Array.isArray(d)) setPendingEvals(d as PendingEvaluation[]);
    } catch {
      // Pending evaluations are optional on the dashboard.
    }
  }, []);

  // Accounts known to have no employee file (admins, finance...) get the "not linked" card
  // directly; /api/portal would only answer 404 for them.
  const { user: me, loading: meLoading } = useRole();
  const unlinked = isUnlinkedAccount(me, meLoading);

  useEffect(() => {
    if (meLoading) return;
    if (unlinked) {
      setEmployee(null);
      setNotFound(true);
      setIsLoading(false);
      return;
    }
    void loadPortal();
  }, [loadPortal, meLoading, unlinked]);

  useEffect(() => {
    if (!employee?.id) return;
    void loadPendingEvals();
    void loadCurrentBalance();
  }, [employee?.id, loadPendingEvals, loadCurrentBalance]);

  // Balance as of the leave start date (server uses the same date when validating the request).
  useEffect(() => {
    if (!isLeaveModalOpen) return;
    let cancelled = false;
    const asOf = leaveData.startDate;
    setLeaveBalanceLoading(true);
    setLeaveBalanceError(false);
    fetch(`/api/leaves/balance${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`, { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          setLeaveBalance(null);
          setLeavePending(null);
          setLeaveBalanceError(true);
          return;
        }
        const data = (await res.json()) as LeaveBalanceResponse;
        if (cancelled) return;
        setLeaveBalance(typeof data.available === 'number' ? data.available : null);
        setLeavePending(typeof data.pending === 'number' ? data.pending : null);
        setLeaveBalanceError(typeof data.available !== 'number');
      })
      .catch(() => {
        if (!cancelled) {
          setLeaveBalance(null);
          setLeavePending(null);
          setLeaveBalanceError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLeaveBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLeaveModalOpen, leaveData.startDate]);

  // Server-side calculation of the request (same evaluateLeave() as POST /api/leaves):
  // paid / unpaid days, salary deduction, visa fee and the blocking issue, if any.
  const basePreviewQuery = isLeaveModalOpen
    ? leavePreviewQuery({
        leaveType: leaveData.leaveType,
        startDate: leaveData.startDate,
        endDate: leaveData.endDate,
        acceptUnpaidExtraDays: leaveData.notes.includes(LEAVE_NOTE_MARKERS.ACCEPT_EXCESS),
        isOutsideKSA: leaveData.notes.includes(LEAVE_NOTE_MARKERS.OUTSIDE),
      })
    : null;
  // Statutory leaves: the event date (birth / death / marriage) and the bereavement relation
  // change the entitlement, so the preview gets them too.
  const leaveEventExtra = new URLSearchParams();
  if (EVENT_DATED_LEAVE_TYPES.includes(leaveData.leaveType) && leaveData.eventDate) leaveEventExtra.set('eventDate', leaveData.eventDate);
  if (leaveData.leaveType === 'BEREAVEMENT') leaveEventExtra.set('bereavementRelation', leaveData.bereavementRelation);
  const leaveEventQuery = leaveEventExtra.toString();
  const previewQuery = basePreviewQuery && leaveEventQuery ? `${basePreviewQuery}&${leaveEventQuery}` : basePreviewQuery;
  const [leavePreview, setLeavePreview] = useState<{ query: string; data: LeavePreview | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!previewQuery) return;
    let cancelled = false;
    // Debounced: typing a date fires several changes.
    const timer = setTimeout(() => {
      fetch(`/api/leaves/preview?${previewQuery}`, { cache: 'no-store' })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 401) return redirectToLogin();
          if (!res.ok) {
            const error = await readApiError(res, 'تعذر احتساب الإجازة');
            if (!cancelled) setLeavePreview({ query: previewQuery, data: null, error });
            return;
          }
          const data = parseLeavePreview(await res.json());
          if (!cancelled) setLeavePreview({ query: previewQuery, data, error: data ? null : 'تعذر احتساب الإجازة' });
        })
        .catch(() => {
          if (!cancelled) setLeavePreview({ query: previewQuery, data: null, error: 'تعذر الاتصال بالخادم' });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewQuery]);
  // Only a result for the current inputs counts (stale answers are ignored).
  const currentPreview = previewQuery && leavePreview?.query === previewQuery ? leavePreview : null;
  const previewLoading = !!previewQuery && !currentPreview;

  const [cancellingLeaveId, setCancellingLeaveId] = useState<string | null>(null);
  const handleCancelLeave = async (leaveId: string) => {
    if (cancellingLeaveId) return;
    const ok = await confirmDialog('هل تريد إلغاء طلب الإجازة؟ لا يمكن التراجع عن الإلغاء.', {
      title: 'إلغاء طلب الإجازة',
      confirmText: 'نعم، إلغاء الطلب',
      cancelText: 'تراجع',
      danger: true,
    });
    if (!ok) return;
    setCancellingLeaveId(leaveId);
    try {
      const res = await fetch(`/api/leaves/${encodeURIComponent(leaveId)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CANCEL' }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر إلغاء الطلب'));
      } else {
        toast.success('تم إلغاء طلب الإجازة');
      }
      // Refresh in both cases: a failure is usually a request already processed by HR.
      void loadPortal({ silent: true });
      void loadCurrentBalance();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setCancellingLeaveId(null);
    }
  };

  const handleAcknowledge = async (evalId: string) => {
    if (ackSubmittingId) return;
    setAckSubmittingId(evalId);
    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'EMPLOYEE_ACKNOWLEDGE', evaluationId: evalId, comment: evalComments[evalId] || '' }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تسجيل الإقرار'));
        return;
      }
      toast.success('تم تسجيل إقرارك بالاطلاع بنجاح');
      setPendingEvals((prev) => prev.filter((e) => e.id !== evalId));
      setEvalComments((prev) => {
        const next = { ...prev };
        delete next[evalId];
        return next;
      });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setAckSubmittingId(null);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-[80vh]">
          <div className="animate-pulse flex flex-col items-center gap-4 text-slate-400">
            <div className="w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="font-bold">جاري تحميل مساحتك الشخصية...</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-[80vh] gap-4 text-center px-4">
          <AlertCircle size={40} className="text-rose-400" />
          <p className="text-slate-600 font-bold">{loadError}</p>
          <button
            type="button"
            onClick={() => void loadPortal()}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-xl font-black text-[13px] transition"
          >
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      </DashboardLayout>
    );
  }

  if (!employee || notFound) {
    return (
      <DashboardLayout>
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-10 md:py-16 space-y-10">
          <UnlinkedAccountCard />
          <CircularsSection compact />
        </div>
      </DashboardLayout>
    );
  }

  // Summaries
  const monthlyAllowances = (employee.allowances || []).filter((a) => a.isMonthly !== false);
  const totalMonthlySalary = sumMoney([employee.basicSalary ?? 0, ...monthlyAllowances.map((a) => a.amount ?? 0)]);
  const totalLoans = sumMoney(
    (employee.loans || [])
      .filter((l) => (l.remainingAmount ?? 0) > 0 && LOAN_DEDUCTIBLE_STATUSES.includes(l.status ?? ''))
      .map((l) => l.remainingAmount ?? 0),
  );
  const issuedPayrolls = (employee.payrolls || []).filter((p) => p.status !== PAYROLL_STATUS.DRAFT);
  const lastPayroll = issuedPayrolls.find((p) => p.status === PAYROLL_STATUS.PAID) ?? issuedPayrolls[0];
  // One display rule for the balance everywhere in the portal (see formatLeaveDays).
  const balanceLabel = formatLeaveDays(currentBalance);
  // Pending leaves are not subtracted from the available balance yet: both are shown.
  const pendingLabel = formatLeaveDays(currentPending ?? 0);
  const insurance = employee.actualCompany?.medicalInsurances?.[0] || employee.legalCompany?.medicalInsurances?.[0] || null;
  const fullName = `${employee.firstNameArabic ?? ''} ${employee.lastNameArabic ?? ''}`.trim();

  const openGeneralRequest = (requestType: string) => {
    setGeneralData({ ...EMPTY_GENERAL, requestType });
    setIsGeneralModalOpen(true);
  };

  const handleTerminationSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting('termination');
    try {
      const res = await fetch('/api/portal/termination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: employee.id,
          terminationType,
          reasonDetails: `[الإجراء المطلوب: ${exitRoute === 'FINAL_EXIT' ? 'خروج نهائي' : 'نقل كفالة / خدمات'}]\n${terminationReason}`,
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
        return;
      }
      toast.success('تم رفع الطلب بنجاح. سيتم مراجعته من قبل الإدارة.');
      setIsTerminationModalOpen(false);
      setTerminationReason('');
      void loadPortal({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(null);
    }
  };

  const handleCorrectionSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting('correction');
    try {
      const res = await fetch('/api/portal/correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: employee.id,
          date: correctionDate,
          reason: correctionReason,
          correctionType,
          attachmentUrl: correctionAttachmentUrl,
          punchId: correctionPunchId ?? undefined,
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
        return;
      }
      toast.success('تم رفع طلب تصحيح البصمة، وهو الآن بانتظار مديرك.');
      setIsCorrectionModalOpen(false);
      setCorrectionDate('');
      setCorrectionReason('');
      setCorrectionAttachmentUrl('');
      setCorrectionType('ABSENT');
      setCorrectionPunchId(null);
      void loadPortal({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(null);
    }
  };

  /** Opens the correction form for a clock-in / clock-out rejected by the self-attendance check. */
  const openCorrectionForPunch = (r: PunchRejection) => {
    setCorrectionDate(r.workDate);
    setCorrectionType('ABSENT');
    setCorrectionReason(`تعذر تسجيل ${r.action === 'OUT' ? 'الانصراف' : 'الحضور'} من البوابة: ${r.message}\n`);
    setCorrectionAttachmentUrl('');
    setCorrectionPunchId(r.punchId);
    setIsCorrectionModalOpen(true);
  };

  const openCorrection = () => {
    setCorrectionPunchId(null);
    setIsCorrectionModalOpen(true);
  };

  const handleLeaveSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    if (leaveData.startDate && leaveData.endDate && leaveData.endDate < leaveData.startDate) {
      toast.error('تاريخ النهاية يجب أن يكون بعد تاريخ البداية');
      return;
    }
    setSubmitting('leave');
    try {
      const notes = leaveData.notes || '';
      const res = await fetch('/api/leaves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: employee.id,
          leaveType: leaveData.leaveType,
          startDate: leaveData.startDate,
          endDate: leaveData.endDate,
          notes,
          isOutsideKSA: notes.includes(LEAVE_NOTE_MARKERS.OUTSIDE),
          acceptUnpaidExtraDays: notes.includes(LEAVE_NOTE_MARKERS.ACCEPT_EXCESS),
          ...(EVENT_DATED_LEAVE_TYPES.includes(leaveData.leaveType) && leaveData.eventDate ? { eventDate: leaveData.eventDate } : {}),
          ...(leaveData.leaveType === 'BEREAVEMENT' ? { bereavementRelation: leaveData.bereavementRelation } : {}),
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
        return;
      }
      toast.success('تم رفع طلب الإجازة بنجاح، بانتظار موافقة الإدارة.');
      setIsLeaveModalOpen(false);
      setLeaveData(EMPTY_LEAVE);
      void loadPortal({ silent: true });
      void loadCurrentBalance();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(null);
    }
  };

  const handleLoanSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    const amount = Number(loanData.amount);
    const installment = Number(loanData.monthlyInstallment);
    if (!(amount > 0) || !(installment > 0)) {
      toast.error('يرجى إدخال مبلغ وقسط صحيحين أكبر من صفر');
      return;
    }
    if (installment > amount) {
      toast.error('القسط الشهري لا يمكن أن يتجاوز مبلغ السلفة');
      return;
    }
    setSubmitting('loan');
    try {
      const res = await fetch('/api/payroll-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'CREATE_LOAN',
          payload: {
            employeeId: employee.id,
            policy: 'OPEN',
            amount: loanData.amount,
            monthlyInstallment: loanData.monthlyInstallment,
            reason: loanData.reason,
          },
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
        return;
      }
      toast.success('تم رفع طلب السلفة بنجاح، بانتظار اعتمادات الإدارة.');
      setIsLoanModalOpen(false);
      setLoanData(EMPTY_LOAN);
      void loadPortal({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(null);
    }
  };

  const handleGeneralSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting('general');
    try {
      // Asset (custody) requests go to the asset-request workflow (HR -> owner -> purchasing),
      // always for the logged-in employee (the server takes the requester from the session).
      if (generalData.requestType === 'ASSET') {
        const res = await fetch('/api/manager-portal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actionType: 'REQUEST_ASSET',
            employeeId: employee.id,
            assetType: generalData.assetType,
            description: generalData.details,
          }),
        });
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
          return;
        }
        toast.success('تم رفع طلب العهدة للموارد البشرية.');
        setIsGeneralModalOpen(false);
        setGeneralData(EMPTY_GENERAL);
        void loadPortal({ silent: true });
        return;
      }

      let finalReason: string;
      let attachmentUrl = '';
      if (generalData.requestType === 'DATA_UPDATE') {
        const mobile = generalData.mobile.trim();
        const email = generalData.email.trim();
        const iban = normalizeIban(generalData.iban);
        if (!mobile && !email && !iban) {
          toast.error('أدخل حقلاً واحداً على الأقل لتحديثه');
          return;
        }
        if (mobile && !MOBILE_PATTERN.test(mobile)) {
          toast.error('رقم الجوال يجب أن يبدأ بـ 05 ويتكون من 10 أرقام');
          return;
        }
        if (email && !EMAIL_PATTERN.test(email)) {
          toast.error('البريد الإلكتروني غير صالح');
          return;
        }
        if (iban && !generalData.ibanCertificateUrl) {
          toast.error('أرفق شهادة الآيبان الصادرة من البنك');
          return;
        }
        finalReason = buildDataUpdateReason(generalData);
        attachmentUrl = iban ? generalData.ibanCertificateUrl : '';
      } else {
        finalReason = `[طلب: ${GENERAL_TYPE_LABELS[generalData.requestType] || generalData.requestType}] ${generalData.details}`;
      }

      const res = await fetch('/api/portal/correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: employee.id,
          date: todayKey(),
          reason: finalReason,
          correctionType: 'GENERAL',
          attachmentUrl,
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
        return;
      }
      toast.success('تم رفع الطلب إلى الموارد البشرية، وتتابع حالته في «طلباتي».');
      setIsGeneralModalOpen(false);
      setGeneralData(EMPTY_GENERAL);
      void loadPortal({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(null);
    }
  };

  const printPayslip = (p: PortalPayroll) => {
    const win = window.open('', '_blank', 'width=720,height=900');
    if (!win) {
      toast.error('تعذر فتح نافذة الطباعة. يرجى السماح بالنوافذ المنبثقة.');
      return;
    }
    const row = (label: string, value: string) =>
      `<tr><td>${escapeHtml(label)}</td><td class="v">${escapeHtml(value)}</td></tr>`;
    win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>قسيمة راتب ${p.month}/${p.year}</title>
<style>body{font-family:Tahoma,Arial,sans-serif;padding:32px;color:#0f172a}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#475569}
table{width:100%;border-collapse:collapse;margin-top:16px}td{border:1px solid #e2e8f0;padding:10px;font-size:14px}td.v{text-align:left;font-weight:bold}
tr.total td{background:#ecfdf5;font-size:16px}</style></head><body>
<h1>قسيمة راتب شهر ${p.month}/${p.year}</h1>
<p>${escapeHtml(fullName)} — الرقم الوظيفي: ${escapeHtml(String(employee.employeeId ?? ''))}</p>
<table>
${row('الراتب الأساسي', `${formatMoney(p.basicSalary)} ر.س`)}
${row('إجمالي البدلات', `${formatMoney(p.totalAllowances)} ر.س`)}
${row('العمل الإضافي', `${formatMoney(p.overtimeCost)} ر.س`)}
${row('إجمالي الاستقطاعات', `${formatMoney(p.totalDeductions)} ر.س`)}
<tr class="total"><td>صافي الراتب</td><td class="v">${escapeHtml(formatMoney(p.netSalary))} ر.س</td></tr>
</table>
<script>window.onload=function(){window.print();}</script>
</body></html>`);
    win.document.close();
  };

  // Leave modal derived values
  const leaveTotalDays =
    leaveData.startDate && leaveData.endDate && leaveData.endDate >= leaveData.startDate
      ? inclusiveDays(leaveData.startDate, leaveData.endDate)
      : 0;
  const availableBalance = leaveBalance ?? 0;
  const balanceKnown = leaveBalance !== null;
  // Statutory / sick / unpaid leaves do not consume the annual balance (src/lib/leave.ts).
  const usesBalance = BALANCE_LEAVE_TYPES.includes(leaveData.leaveType);
  const excessDays = usesBalance && balanceKnown && leaveTotalDays > availableBalance ? Math.ceil(leaveTotalDays - Math.floor(availableBalance)) : 0;
  const hasExcessAck = leaveData.notes.includes(LEAVE_NOTE_MARKERS.ACCEPT_EXCESS);
  const isOutside = leaveData.notes.includes(LEAVE_NOTE_MARKERS.OUTSIDE);
  const unpaidBlocked = leaveData.leaveType === 'UNPAID' && balanceKnown && availableBalance >= 1;
  const excessBlocked = excessDays > 0 && leaveData.leaveType === 'ANNUAL' && !hasExcessAck;
  const preview = currentPreview?.data ?? null;
  // The server reports insufficient balance also for types the local check does not cover.
  const showExcessAck = (excessDays > 0 && leaveData.leaveType === 'ANNUAL') || preview?.issue === 'EXCESS_NOT_ACCEPTED';
  const previewBlocked = !!preview?.issue;

  // Contract termination is a formal request: an explicit confirmation comes before the form.
  const requestTermination = async () => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ok = await confirmDialog(
      'طلب إنهاء العقد أو الاستقالة طلب رسمي يُرسل إلى الإدارة، وقد يترتب عليه إنهاء خدمتك وبدء إجراءات التصفية.\nهل تريد المتابعة إلى نموذج الطلب؟',
      { title: 'إنهاء العقد أو الاستقالة', confirmText: 'متابعة إلى النموذج', cancelText: 'تراجع', danger: true },
    );
    // Give focus back to the trigger so the form's dialog returns it there when closed.
    trigger?.focus();
    if (ok) setIsTerminationModalOpen(true);
  };

  const firstName = (employee.firstNameArabic || '').trim() || fullName;
  const fieldClass = 'w-full bg-slate-50 border-2 border-slate-100 focus:bg-white rounded-2xl px-4 py-3 font-bold text-slate-800 transition-all focus:outline-none placeholder:font-semibold placeholder:text-slate-400';
  const labelClass = 'text-[13px] font-extrabold text-slate-700 block mb-2';

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto pt-2 pb-28 md:py-10 space-y-6 md:space-y-10 max-sm:[&_input]:text-base max-sm:[&_select]:text-base max-sm:[&_textarea]:text-base">

        {/* Short greeting */}
        <section id="portal-home" aria-label="الترحيب" className="flex items-center gap-3 md:gap-4 scroll-mt-4 focus:outline-none">
          <div aria-hidden="true" className="w-12 h-12 md:w-14 md:h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white flex items-center justify-center text-xl md:text-2xl font-black shrink-0 shadow-lg shadow-emerald-900/10">
            {(employee.firstNameArabic || '؟').charAt(0)}
          </div>
          <div className="min-w-0">
            {/* The shell header already greets the user on md+ screens (it is hidden on phones). */}
            <h1 className="text-xl md:text-3xl font-black text-slate-900 truncate">
              <span className="md:hidden">مرحباً، {firstName}</span>
              <span className="hidden md:inline">بوابة الموظف: {fullName}</span>
            </h1>
            <p className="text-[12px] md:text-[13px] font-bold text-slate-500 truncate">
              <span dir="ltr">#{employee.employeeId}</span> · {employee.jobTitle || 'بدون مسمى وظيفي'} · {employee.branch?.nameArabic || 'الفرع الرئيسي'}
            </p>
          </div>
        </section>

        {/* Self clock-in / clock-out (hidden unless enabled for this tenant) */}
        <ClockCard onPunched={() => void loadPortal({ silent: true })} onRequestCorrection={openCorrectionForPunch} />

        {/* Actions first */}
        <section aria-labelledby="portal-actions-title">
          <h2 id="portal-actions-title" className="text-[13px] font-black text-slate-500 mb-3">ماذا تريد أن تفعل؟</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-5">
            <ActionTile tone="blue" icon={<CalendarClock size={26} />} title="طلب إجازة" subtitle={`متاح ${balanceLabel} · قيد الاعتماد ${pendingLabel}`} onClick={() => setIsLeaveModalOpen(true)} />
            <ActionTile tone="amber" icon={<Fingerprint size={26} />} title="تصحيح بصمة" subtitle="تعديل حضور أو انصراف" onClick={openCorrection} />
            <ActionTile tone="emerald" icon={<PiggyBank size={26} />} title="طلب سلفة" subtitle="يمر بمسار موافقات" onClick={() => setIsLoanModalOpen(true)} />
            <ActionTile tone="indigo" icon={<FileText size={26} />} title="شهادة أو خطاب" subtitle="راتب، تعريف، خبرة" onClick={() => openGeneralRequest('SALARY_CERT')} />
          </div>
        </section>

        {/* Pending Evaluations */}
        {pendingEvals.length > 0 && (
          <section aria-labelledby="portal-evals-title" className="bg-gradient-to-l from-violet-50 to-indigo-50 rounded-[2rem] p-5 md:p-6 border-2 border-violet-200 shadow-lg">
            <h2 id="portal-evals-title" className="text-lg md:text-xl font-black text-violet-800 flex items-center gap-2 mb-4">
              <ClipboardCheck size={22} className="text-violet-600" aria-hidden="true" /> تقييمات بانتظار اطلاعك
            </h2>
            <div className="space-y-4">
              {pendingEvals.map((ev) => {
                const score = ev.totalScore ?? 0;
                const isAcking = ackSubmittingId === ev.id;
                return (
                  <div key={ev.id} className="bg-white rounded-2xl p-5 border border-violet-100 shadow-sm">
                    <div className="flex justify-between items-start gap-3 mb-4">
                      <div>
                        <p className="font-black text-violet-700 text-[14px]">{ev.cycle?.title}</p>
                        <p className="text-[11px] font-bold text-slate-400 mt-1">التاريخ: {formatDate(ev.updatedAt)}</p>
                      </div>
                      <div className="text-center">
                        <p className={`text-2xl font-black ${scoreClass(score)}`}>{score.toFixed(1)}%</p>
                        <p className={`text-[12px] font-black px-2 py-0.5 rounded-md ${ratingClass(ev.finalRating)}`}>{ev.finalRating}</p>
                      </div>
                    </div>

                    {ev.strengths && (
                      <div className="bg-emerald-50 rounded-xl p-3 mb-2 border border-emerald-100">
                        <p className="text-[11px] font-black text-emerald-500 mb-1"><Star size={12} className="inline" aria-hidden="true" /> نقاط القوة</p>
                        <p className="text-[12px] font-bold text-emerald-700">{ev.strengths}</p>
                      </div>
                    )}
                    {ev.improvements && (
                      <div className="bg-amber-50 rounded-xl p-3 mb-2 border border-amber-100">
                        <p className="text-[11px] font-black text-amber-500 mb-1">نقاط التحسين</p>
                        <p className="text-[12px] font-bold text-amber-700">{ev.improvements}</p>
                      </div>
                    )}
                    {ev.finalNotes && (
                      <div className="bg-slate-50 rounded-xl p-3 mb-3 border border-slate-100">
                        <p className="text-[11px] font-black text-slate-400 mb-1">ملاحظات المدير</p>
                        <p className="text-[12px] font-bold text-slate-700">{ev.finalNotes}</p>
                      </div>
                    )}

                    <textarea
                      value={evalComments[ev.id] ?? ''}
                      onChange={(e) => setEvalComments((prev) => ({ ...prev, [ev.id]: e.target.value }))}
                      aria-label="تعليق على التقييم"
                      className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition resize-none h-16 mb-3"
                      placeholder="تعليق اختياري..."
                    />

                    <button
                      type="button"
                      onClick={() => void handleAcknowledge(ev.id)}
                      disabled={ackSubmittingId !== null}
                      className="w-full bg-violet-600 hover:bg-violet-700 text-white py-3 rounded-xl font-black text-[13px] flex items-center justify-center gap-2 transition shadow-lg shadow-violet-200 disabled:opacity-50"
                    >
                      <CheckCircle size={16} aria-hidden="true" /> {isAcking ? 'جاري التسجيل...' : 'اطلعت على التقييم'}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Summary */}
        <section aria-labelledby="portal-summary-title">
          <h2 id="portal-summary-title" className="text-[13px] font-black text-slate-500 mb-3">ملخصك</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-5">
            <StatCard icon={<CalendarDays size={20} />} tone="amber" label="رصيد الإجازات السنوية" value={balanceLabel} unit="يوم متاح" note={`${pendingLabel} يوم قيد الاعتماد`} />
            <StatCard icon={<Receipt size={20} />} tone="emerald" label="آخر راتب صادر" value={lastPayroll ? formatMoney(lastPayroll.netSalary ?? 0) : '—'} unit={lastPayroll ? 'ر.س' : ''} note={lastPayroll ? `${lastPayroll.month}/${lastPayroll.year}` : 'لا توجد رواتب صادرة بعد'} />
            <StatCard icon={<PiggyBank size={20} />} tone="rose" label="المتبقي من السلف" value={formatMoney(totalLoans)} unit="ر.س" />
            <div className="bg-white rounded-3xl p-4 md:p-5 border border-slate-200 shadow-sm col-span-2 lg:col-span-1">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0" aria-hidden="true"><Wallet size={20} /></span>
                <div className="min-w-0">
                  <p className="text-[11px] font-black text-slate-500">إجمالي الراتب الشهري</p>
                  <p className="text-lg md:text-xl font-black text-slate-800">{formatMoney(totalMonthlySalary)} <span className="text-[11px] text-slate-500 font-bold">ر.س</span></p>
                </div>
              </div>
              <details className="mt-2 group">
                <summary className="cursor-pointer text-[12px] font-bold text-indigo-600 select-none">تفاصيل الراتب</summary>
                <div className="space-y-1.5 border-t border-slate-100 pt-2 mt-2">
                  <div className="flex justify-between text-[12px]">
                    <span className="font-bold text-slate-500">الراتب الأساسي</span>
                    <span className="font-black text-slate-700">{formatMoney(employee.basicSalary)} ر.س</span>
                  </div>
                  {monthlyAllowances.map((a) => (
                    <div key={a.id} className="flex justify-between text-[12px]">
                      <span className="font-bold text-emerald-600">{a.name || 'بدل'}</span>
                      <span className="font-black text-emerald-700">+{formatMoney(a.amount)} ر.س</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* Detail Sections */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 md:gap-8">
          {/* Requests History */}
          <section id="portal-requests" aria-labelledby="portal-requests-title" className="scroll-mt-4 focus:outline-none">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 id="portal-requests-title" className="text-lg md:text-xl font-extrabold text-slate-800 flex items-center gap-2">
                <History className="text-slate-400" size={20} aria-hidden="true" /> طلباتي
              </h2>
              <Link href="/portal/archive" className="text-[12px] font-bold text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full hover:bg-blue-100">عرض الكل</Link>
            </div>
            <div className="bg-white border border-slate-200 rounded-[2rem] p-2 max-h-[410px] overflow-y-auto">
              {employee.history && employee.history.length > 0 ? (
                <ul className="divide-y divide-slate-100">
                  {employee.history.map((h) => (
                    <li key={h.id} className="p-4 flex items-center justify-between gap-3 hover:bg-slate-50 rounded-2xl transition">
                      <div className="min-w-0">
                        <p className="font-bold text-[14px] text-slate-800 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-slate-400 shrink-0" aria-hidden="true"></span> {h.type}
                        </p>
                        <p className="font-bold text-[12px] text-slate-400 max-w-[200px] truncate" title={h.details ?? ''}>
                          {h.details}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1">تاريخ الطلب: {formatDateShort(h.date)}</p>
                        {h.rejectionReason ? (
                          <p className="text-[12px] font-bold text-rose-700 mt-1 whitespace-pre-line break-words">سبب الرفض: {h.rejectionReason}</p>
                        ) : (
                          <>
                            {h.managerComment && <p className="text-[12px] font-bold text-slate-600 mt-1 break-words">ملاحظة المدير: {h.managerComment}</p>}
                            {h.hrComment && <p className="text-[12px] font-bold text-slate-600 mt-1 break-words">ملاحظة الموارد البشرية: {h.hrComment}</p>}
                          </>
                        )}
                      </div>
                      <div className="shrink-0">
                        {h.attachment && (
                          <a href={h.attachment} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-blue-600 bg-blue-50 hover:underline flex items-center gap-1 px-3 py-1.5 rounded-lg border border-blue-100 mb-2 justify-center">
                            <DownloadCloud size={14} aria-hidden="true" /> عرض المرفق
                          </a>
                        )}
                        {h.status === 'APPROVED' || h.status === 'COMPLETED' ? (
                          <span className="bg-emerald-50 text-emerald-600 text-[11px] font-black px-3 py-1.5 rounded-lg border border-emerald-100 flex items-center gap-1 justify-center"><CheckCircle size={14} aria-hidden="true" /> معتمدة</span>
                        ) : h.status === 'REJECTED' ? (
                          <span className="bg-rose-50 text-rose-600 text-[11px] font-black px-3 py-1.5 rounded-lg border border-rose-100 flex items-center gap-1 justify-center"><ShieldAlert size={14} aria-hidden="true" /> مرفوضة</span>
                        ) : h.status === 'CANCELLED' ? (
                          <span className="bg-slate-100 text-slate-500 text-[11px] font-black px-3 py-1.5 rounded-lg border border-slate-200 flex items-center gap-1 justify-center"><X size={14} aria-hidden="true" /> ملغاة</span>
                        ) : (
                          <span className="bg-amber-50 text-amber-700 text-[11px] font-black px-3 py-1.5 rounded-lg border border-amber-100 flex items-center gap-1 justify-center"><Clock size={14} aria-hidden="true" /> {h.stageLabel || 'قيد المراجعة'}</span>
                        )}
                        {(() => {
                          const leaveId = cancellableLeaveId(h);
                          if (!leaveId) return null;
                          return (
                            <button
                              type="button"
                              onClick={() => void handleCancelLeave(leaveId)}
                              disabled={cancellingLeaveId !== null}
                              className="mt-2 w-full text-[11px] font-black text-rose-600 bg-white hover:bg-rose-50 px-3 py-1.5 rounded-lg border border-rose-200 flex items-center gap-1 justify-center transition disabled:opacity-50"
                            >
                              <Ban size={13} aria-hidden="true" /> {cancellingLeaveId === leaveId ? 'جاري الإلغاء...' : 'إلغاء الطلب'}
                            </button>
                          );
                        })()}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-center py-10 font-bold text-slate-400 text-[13px]">لم تقدّم أي طلبات بعد.</div>
              )}
            </div>
          </section>

          {/* Payslips History */}
          <section id="portal-payslips" aria-labelledby="portal-payslips-title" className="scroll-mt-4 focus:outline-none">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 id="portal-payslips-title" className="text-lg md:text-xl font-extrabold text-slate-800 flex items-center gap-2">
                <FileText className="text-slate-400" size={20} aria-hidden="true" /> قسائم الرواتب
              </h2>
            </div>
            <div className="bg-white border border-slate-200 rounded-[2rem] p-2 max-h-[410px] overflow-y-auto">
              {issuedPayrolls.length > 0 ? (
                <ul className="divide-y divide-slate-100">
                  {issuedPayrolls.map((p) => (
                    <li key={p.id} className="p-4 flex items-center justify-between gap-3 hover:bg-slate-50 rounded-2xl transition group">
                      <div className="flex flex-col">
                        <p className="font-bold text-[14px] text-slate-800">راتب شهر {p.month}/{p.year}</p>
                        <p className="font-black text-[13px] text-emerald-600">{formatMoney(p.netSalary)} ر.س</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedPayslip(p)}
                        aria-label={`عرض قسيمة راتب ${p.month}/${p.year}`}
                        className="w-11 h-11 rounded-full bg-slate-50 text-slate-500 hover:text-blue-600 hover:bg-blue-50 flex items-center justify-center transition border border-slate-200"
                      >
                        <DownloadCloud size={18} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-center py-10 font-bold text-slate-400 text-[13px]">لا توجد قسائم رواتب صادرة بعد.</div>
              )}
            </div>
          </section>

          {/* Fingerprints & Attendance */}
          <section id="portal-attendance" aria-labelledby="portal-attendance-title" className="scroll-mt-4 focus:outline-none">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 id="portal-attendance-title" className="text-lg md:text-xl font-extrabold text-slate-800 flex items-center gap-2">
                <Fingerprint className="text-slate-400" size={20} aria-hidden="true" /> سجل الحضور
              </h2>
              <button type="button" onClick={openCorrection} className="text-[12px] font-bold text-amber-700 bg-amber-50 border border-amber-100 px-3 py-1.5 rounded-full hover:bg-amber-100 transition">تصحيح بصمة</button>
            </div>
            <div className="bg-white border border-slate-200 rounded-[2rem] p-2 max-h-[410px] overflow-y-auto">
              {employee.attendances && employee.attendances.length > 0 ? (
                <ul className="divide-y divide-slate-100">
                  {employee.attendances.map((a) => (
                    <li key={a.id} className="p-4 flex items-center justify-between gap-3 hover:bg-slate-50 rounded-2xl transition">
                      <div>
                        <p className="font-bold text-[14px] text-slate-800 flex items-center gap-2">
                          {formatDate(a.date, { weekday: 'long', day: 'numeric', month: 'short', year: undefined })}
                        </p>
                        <p className="font-bold text-[12px] text-slate-500 mt-1">
                          {formatTime(a.checkIn)} - {formatTime(a.checkOut)}
                        </p>
                      </div>
                      <div className="text-left">
                        {a.status === 'PRESENT' && ((a.lateMinutes ?? 0) > 0 ? (
                          <span className="bg-orange-50 text-orange-600 text-[11px] font-black px-2 py-1 rounded-md border border-orange-100">تأخير {a.lateMinutes}د</span>
                        ) : (a.earlyMinutes ?? 0) > 0 ? (
                          <span className="bg-amber-50 text-amber-600 text-[11px] font-black px-2 py-1 rounded-md border border-amber-100">انصراف مبكر</span>
                        ) : (
                          <span className="bg-emerald-50 text-emerald-600 text-[11px] font-black px-2 py-1 rounded-md border border-emerald-100">مكتمل</span>
                        ))}
                        {a.status === 'ABSENT' && <span className="bg-red-50 text-red-600 text-[11px] font-black px-2 py-1 rounded-md border border-red-100">غياب</span>}
                        {a.status === 'LEAVE' && <span className="bg-blue-50 text-blue-600 text-[11px] font-black px-2 py-1 rounded-md border border-blue-100">إجازة</span>}
                        {a.status === 'HOLIDAY' && <span className="bg-slate-100 text-slate-500 text-[11px] font-black px-2 py-1 rounded-md border border-slate-200">عطلة</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-center py-10 flex flex-col items-center justify-center">
                  <Fingerprint size={40} className="text-slate-200 mb-3" aria-hidden="true" />
                  <p className="font-bold text-slate-400 text-[13px]">لم يُسجَّل حضور لك هذا الشهر بعد.</p>
                </div>
              )}
            </div>
          </section>

          {/* Circulars & Admin Decisions */}
          <CircularsSection />
        </div>

        {/* Other requests: certificates, data updates, custody, insurance, and contract termination last */}
        <section id="portal-more" aria-labelledby="portal-more-title" className="scroll-mt-4 focus:outline-none">
          <h2 id="portal-more-title" className="text-lg md:text-xl font-extrabold text-slate-800 flex items-center gap-2 mb-4">
            <LayoutGrid className="text-slate-400" size={20} aria-hidden="true" /> طلبات أخرى
          </h2>
          <ul className="bg-white border border-slate-200 rounded-[2rem] divide-y divide-slate-100 overflow-hidden">
            {OTHER_REQUESTS.map((r) => (
              <li key={r.type}>
                <button
                  type="button"
                  onClick={() => (r.type === 'MEDICAL_VIEW' ? setIsMedicalModalOpen(true) : openGeneralRequest(r.type))}
                  className="w-full min-h-[56px] px-5 py-3 flex items-center justify-between gap-3 text-right hover:bg-slate-50 focus:outline-none focus-visible:bg-indigo-50 transition"
                >
                  <span className="min-w-0">
                    <span className="block font-black text-[14px] text-slate-800">{r.label}</span>
                    <span className="block text-[12px] font-bold text-slate-500">{r.hint}</span>
                  </span>
                  <ChevronLeft size={18} className="text-slate-300 shrink-0" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 border border-rose-100 bg-rose-50/40 rounded-2xl p-4 md:p-5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-black text-[14px] text-rose-900 flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> إنهاء العقد أو الاستقالة</p>
              <p className="text-[12px] font-bold text-rose-700/80 mt-1">طلب رسمي يُرفع للإدارة ويبدأ إجراءات إنهاء الخدمة والتصفية. ستُطلب منك الموافقة قبل فتح النموذج.</p>
            </div>
            <button
              type="button"
              onClick={() => void requestTermination()}
              className="shrink-0 bg-white border border-rose-200 text-rose-700 hover:bg-rose-600 hover:text-white px-4 py-2.5 rounded-xl font-black text-[13px] transition"
            >
              طلب إنهاء العقد
            </button>
          </div>
        </section>
      </div>

      <PortalTabBar tabs={PORTAL_TABS} />

      {/* Payslip Modal */}
      <Modal
        open={!!selectedPayslip}
        onClose={() => setSelectedPayslip(null)}
        tone="emerald"
        size="sm"
        icon={<Receipt size={22} />}
        title={selectedPayslip ? `قسيمة راتب شهر ${selectedPayslip.month}/${selectedPayslip.year}` : 'قسيمة الراتب'}
        description={fullName}
      >
        {selectedPayslip && (
          <div className="p-6 space-y-3">
            {[
              { label: 'الراتب الأساسي', value: selectedPayslip.basicSalary, cls: 'text-slate-800' },
              { label: 'إجمالي البدلات', value: selectedPayslip.totalAllowances, cls: 'text-emerald-700' },
              { label: 'العمل الإضافي', value: selectedPayslip.overtimeCost, cls: 'text-emerald-700' },
              { label: 'إجمالي الاستقطاعات', value: selectedPayslip.totalDeductions, cls: 'text-rose-600' },
            ].map((r) => (
              <div key={r.label} className="flex justify-between text-[14px] border-b border-slate-100 pb-2">
                <span className="font-bold text-slate-500">{r.label}</span>
                <span className={`font-black ${r.cls}`}>{formatMoney(r.value)} ر.س</span>
              </div>
            ))}
            <div className="flex justify-between text-[16px] bg-emerald-50 rounded-xl p-3 border border-emerald-100">
              <span className="font-black text-emerald-800">صافي الراتب</span>
              <span className="font-black text-emerald-700">{formatMoney(selectedPayslip.netSalary)} ر.س</span>
            </div>
            <div className="flex gap-3 pt-3">
              <button type="button" onClick={() => printPayslip(selectedPayslip)} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-2xl font-black transition text-[13px] flex items-center justify-center gap-2">
                <Printer size={16} aria-hidden="true" /> طباعة / حفظ PDF
              </button>
              <button type="button" onClick={() => setSelectedPayslip(null)} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3 rounded-2xl font-bold transition">إغلاق</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Termination Modal (opened only after the confirmation above) */}
      <Modal
        open={isTerminationModalOpen}
        onClose={() => setIsTerminationModalOpen(false)}
        busy={submitting === 'termination'}
        tone="rose"
        icon={<AlertTriangle size={22} />}
        title="طلب إنهاء عقد أو استقالة"
        description="سيتم إرسال الطلب للإدارة للمراجعة"
      >
        <form onSubmit={handleTerminationSubmit} className="p-6 md:p-8 space-y-6">
          <div>
            <label htmlFor="portal-termination-type" className={labelClass}>سبب إنهاء العقد / نوع الانتهاء</label>
            <select
              id="portal-termination-type"
              value={terminationType}
              onChange={(e) => setTerminationType(e.target.value)}
              className={`${fieldClass} focus:border-rose-400 appearance-none`}>
              <option value="END_OF_CONTRACT">انتهاء العقد بانتهاء المدة / عدم التجديد</option>
              <option value="RESIGNATION">الاستقالة</option>
              <option value="MUTUAL_AGREEMENT">إنهاء باتفاق الطرفين</option>
            </select>
          </div>

          <fieldset>
            <legend className={labelClass}>ما هو الإجراء المطلوب بعد إنهاء العقد؟</legend>
            <div className="flex gap-3">
              <label className={`flex-1 flex flex-col items-center justify-center gap-2 p-4 border-2 rounded-2xl cursor-pointer transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-rose-400 ${exitRoute === 'FINAL_EXIT' ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-slate-100 hover:border-rose-200 text-slate-500'}`}>
                <input type="radio" name="portal-exit-route" value="FINAL_EXIT" checked={exitRoute === 'FINAL_EXIT'} onChange={(e) => setExitRoute(e.target.value)} className="sr-only" />
                <Plane size={24} aria-hidden="true" className={exitRoute === 'FINAL_EXIT' ? 'text-rose-500' : 'text-slate-400'} />
                <span className="font-extrabold text-[13px]">خروج نهائي</span>
              </label>
              <label className={`flex-1 flex flex-col items-center justify-center gap-2 p-4 border-2 rounded-2xl cursor-pointer transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-rose-400 ${exitRoute === 'TRANSFER' ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-slate-100 hover:border-rose-200 text-slate-500'}`}>
                <input type="radio" name="portal-exit-route" value="TRANSFER" checked={exitRoute === 'TRANSFER'} onChange={(e) => setExitRoute(e.target.value)} className="sr-only" />
                <UserPlus size={24} aria-hidden="true" className={exitRoute === 'TRANSFER' ? 'text-rose-500' : 'text-slate-400'} />
                <span className="font-extrabold text-[13px]">نقل كفالة / خدمات</span>
              </label>
            </div>
          </fieldset>

          <div>
            <label htmlFor="portal-termination-reason" className={labelClass}>أسباب الطلب</label>
            <textarea
              id="portal-termination-reason"
              rows={4}
              value={terminationReason}
              onChange={(e) => setTerminationReason(e.target.value)}
              placeholder="يرجى توضيح أي ملاحظات أو أسباب تدفعك لتقديم هذا الطلب..."
              className={`${fieldClass} focus:border-rose-400 resize-none`}></textarea>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting === 'termination'} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
              {submitting === 'termination' ? 'جاري الإرسال...' : 'تأكيد وإرسال الطلب'}
            </button>
            <button type="button" onClick={() => setIsTerminationModalOpen(false)} disabled={submitting === 'termination'} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </form>
      </Modal>

      {/* Fingerprint Correction Modal */}
      <Modal
        open={isCorrectionModalOpen}
        onClose={() => setIsCorrectionModalOpen(false)}
        busy={submitting === 'correction'}
        tone="amber"
        icon={<Fingerprint size={22} />}
        title="طلب تصحيح بصمة / حضور وانصراف"
        description="يُرسل الطلب إلى مديرك المباشر ثم إلى الموارد البشرية"
      >
        <form onSubmit={handleCorrectionSubmit} className="p-6 md:p-8 space-y-6">
          {correctionPunchId && (
            <p className="bg-amber-50 border border-amber-100 text-amber-900 rounded-2xl p-3 text-[12px] font-bold leading-relaxed">
              الطلب مرتبط بمحاولة التسجيل المرفوضة، وعند الاعتماد يُستخدم وقت المحاولة الفعلي.
            </p>
          )}
          <div>
            <label htmlFor="portal-correction-type" className={labelClass}>نوع التصحيح</label>
            <select
              id="portal-correction-type"
              value={correctionType}
              onChange={(e) => setCorrectionType(e.target.value)}
              className={`${fieldClass} focus:border-amber-400 appearance-none`}>
              {CORRECTION_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="portal-correction-date" className={labelClass}>التاريخ المراد تصحيحه</label>
            <input
              id="portal-correction-date"
              type="date"
              required
              max={todayKey()}
              value={correctionDate}
              onChange={(e) => setCorrectionDate(e.target.value)}
              className={`${fieldClass} focus:border-amber-400`} />
          </div>

          <div>
            <label htmlFor="portal-correction-reason" className={labelClass}>المبررات والأسباب لتصحيح البصمة</label>
            <textarea
              id="portal-correction-reason"
              rows={4}
              required
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
              placeholder="مثال: نسيت تسجيل الخروج بسبب مهمة عمل مفاجئة..."
              className={`${fieldClass} focus:border-amber-400 resize-none`}></textarea>
          </div>

          <div className="pt-2 border-t border-slate-100">
            <FileUploadField name="attachment" value={correctionAttachmentUrl} onChange={(e) => setCorrectionAttachmentUrl(e.target.value)} label="إرفاق عذر أو إثبات (اختياري)" />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting === 'correction'} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
              {submitting === 'correction' ? 'جاري الإرسال...' : 'تأكيد وإرسال الطلب'}
            </button>
            <button type="button" onClick={() => setIsCorrectionModalOpen(false)} disabled={submitting === 'correction'} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </form>
      </Modal>

      {/* Leave Modal (first dialog migrated to the accessible <Modal>) */}
      <Modal
        open={isLeaveModalOpen}
        onClose={() => setIsLeaveModalOpen(false)}
        busy={submitting === 'leave'}
        tone="blue"
        icon={<CalendarClock size={22} />}
        title="تقديم طلب إجازة"
        description="سيتم إرسال الطلب لمديرك لاعتماده"
        headerExtra={
          <div className="bg-blue-50 px-6 py-3 flex items-center justify-between gap-3 border-b border-blue-100" aria-live="polite">
            <div>
              <p className="text-[11px] font-black text-blue-500">
                رصيدك السنوي{leaveData.startDate ? ' في تاريخ البداية' : ''}
              </p>
              <p className="text-2xl font-black text-blue-800">
                {leaveBalanceLoading ? '...' : formatLeaveDays(leaveBalance)} <span className="text-[12px] font-bold text-blue-600">يوم متاح</span>
                {!leaveBalanceLoading && leaveBalance !== null && (
                  <span className="text-[12px] font-bold text-blue-600">
                    {' '}·{' '}<span className="font-black text-blue-800">{formatLeaveDays(leavePending ?? 0)}</span> يوم قيد الاعتماد
                  </span>
                )}
              </p>
              {!usesBalance && (
                <p className="text-[11px] font-bold text-blue-700 mt-1">إجازة {LEAVE_TYPE_LABELS[leaveData.leaveType as keyof typeof LEAVE_TYPE_LABELS] ?? ''} لا تُخصم من رصيدك السنوي.</p>
              )}
              {leaveBalanceError && !leaveBalanceLoading && (
                <p className="text-[11px] font-bold text-rose-600 mt-1">تعذر حساب الرصيد، سيتم التحقق منه عند الإرسال.</p>
              )}
            </div>
            {leaveTotalDays > 0 && (
              <div className="text-left">
                <p className="text-[11px] font-black text-blue-500">مدة الإجازة</p>
                <p className={`text-2xl font-black ${excessDays > 0 ? 'text-orange-600' : 'text-emerald-600'}`}>{leaveTotalDays} <span className="text-[12px] font-bold text-slate-500">يوم</span></p>
              </div>
            )}
          </div>
        }
      >
        <form onSubmit={handleLeaveSubmit} className="p-6 space-y-5">
          <div>
            <label htmlFor="portal-leave-type" className={labelClass}>نوع الإجازة</label>
            <select
              id="portal-leave-type"
              value={leaveData.leaveType}
              onChange={(e) => setLeaveData({ ...leaveData, leaveType: e.target.value })}
              className={`${fieldClass} focus:border-blue-400 appearance-none`}>
              {LEAVE_TYPES.map((t) => (
                <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          {EVENT_DATED_LEAVE_TYPES.includes(leaveData.leaveType) && (
            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
              <div>
                <label htmlFor="portal-leave-event" className={labelClass}>{LEAVE_EVENT_LABELS[leaveData.leaveType] ?? 'تاريخ الواقعة'}</label>
                <input id="portal-leave-event" type="date" max={todayKey()} value={leaveData.eventDate} onChange={(e) => setLeaveData({ ...leaveData, eventDate: e.target.value })} dir="ltr" lang="en"
                  className={`${fieldClass} focus:border-blue-400`} />
              </div>
              {leaveData.leaveType === 'BEREAVEMENT' && (
                <div>
                  <label htmlFor="portal-leave-relation" className={labelClass}>صلة القرابة بالمتوفى</label>
                  <select id="portal-leave-relation" value={leaveData.bereavementRelation} onChange={(e) => setLeaveData({ ...leaveData, bereavementRelation: e.target.value })}
                    className={`${fieldClass} focus:border-blue-400 appearance-none`}>
                    {BEREAVEMENT_RELATIONS.map((r) => (
                      <option key={r} value={r}>{BEREAVEMENT_RELATION_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <div>
              <label htmlFor="portal-leave-start" className={labelClass}>تاريخ البداية</label>
              <input id="portal-leave-start" type="date" required value={leaveData.startDate} onChange={(e) => setLeaveData({ ...leaveData, startDate: e.target.value })} dir="ltr" lang="en"
                className={`${fieldClass} focus:border-blue-400`} />
            </div>
            <div>
              <label htmlFor="portal-leave-end" className={labelClass}>تاريخ النهاية</label>
              <input id="portal-leave-end" type="date" required min={leaveData.startDate || undefined} value={leaveData.endDate} onChange={(e) => setLeaveData({ ...leaveData, endDate: e.target.value })} dir="ltr" lang="en"
                className={`${fieldClass} focus:border-blue-400`} />
            </div>
          </div>

          {/* Inside/Outside country */}
          <div>
            <label htmlFor="portal-leave-place" className={labelClass}>مكان قضاء الإجازة</label>
            <select id="portal-leave-place" value={isOutside ? 'outside' : 'inside'}
              onChange={(e) => {
                const stripped = leaveData.notes.replace(OUTSIDE, '');
                setLeaveData({ ...leaveData, notes: e.target.value === 'outside' ? OUTSIDE + stripped : stripped });
              }}
              className={`${fieldClass} focus:border-blue-400 appearance-none`}>
              <option value="inside">داخل المملكة</option>
              <option value="outside">خارج المملكة</option>
            </select>
          </div>

          {/* Server calculation (GET /api/leaves/preview) */}
          {previewQuery && (
            <div aria-live="polite" className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
              <p className="text-[12px] font-black text-slate-500 mb-3">احتساب الإجازة حسب النظام</p>
              {previewLoading ? (
                <p className="text-[12px] font-bold text-slate-500">جاري الاحتساب...</p>
              ) : currentPreview?.error || !preview ? (
                <p className="text-[12px] font-bold text-rose-600">{currentPreview?.error || 'تعذر احتساب الإجازة'}، سيتم التحقق من الطلب عند الإرسال.</p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-white rounded-xl border border-slate-100 p-2">
                      <p className="text-[11px] font-black text-slate-500">أيام مدفوعة</p>
                      <p className="text-lg font-black text-emerald-600">{preview.paidDays}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-100 p-2">
                      <p className="text-[11px] font-black text-slate-500">أيام بدون أجر</p>
                      <p className={`text-lg font-black ${preview.unpaidDays > 0 ? 'text-orange-600' : 'text-slate-700'}`}>{preview.unpaidDays}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-100 p-2">
                      <p className="text-[11px] font-black text-slate-500">الخصم من الراتب</p>
                      <p className={`text-lg font-black ${preview.totalDeduction > 0 ? 'text-red-600' : 'text-slate-700'}`}>{formatMoney(preview.totalDeduction)} <span className="text-[10px] font-bold">ر.س</span></p>
                    </div>
                  </div>
                  {preview.needsVisa && (
                    <p className="text-[12px] font-bold text-blue-700 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2">
                      تتطلب الإجازة خارج المملكة تأشيرة خروج وعودة{preview.exitReentryVisaCost > 0 ? ` (الرسوم: ${formatMoney(preview.exitReentryVisaCost)} ر.س)` : ''}.
                    </p>
                  )}
                  {preview.issueMessage && (
                    <p className="text-[12px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 flex items-start gap-2">
                      <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> {preview.issueMessage}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Excess Days Warning + Acknowledgment */}
          {showExcessAck && (
            <div className="bg-orange-50 border-2 border-orange-200 rounded-2xl p-5">
              <h3 className="font-black text-orange-900 text-[14px] mb-2 flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> رصيدك لا يكفي</h3>
              <p className="text-orange-800 text-[12px] font-bold leading-relaxed mb-4">
                {excessDays > 0 ? (
                  <>طلبت <span className="font-black">{leaveTotalDays} يوم</span> ورصيدك <span className="font-black text-emerald-700">{formatLeaveDays(availableBalance)} يوم</span>. هناك <span className="font-black text-red-600 bg-red-100 px-1.5 py-0.5 rounded">{excessDays} يوم</span> زيادة عن المستحق.</>
                ) : (
                  <>عدد الأيام المطلوبة يتجاوز رصيدك المتاح.</>
                )}
              </p>
              <label className="flex items-start gap-3 cursor-pointer p-4 bg-white rounded-xl border-2 border-orange-200 hover:border-orange-400 transition">
                <input type="checkbox" name="acceptUnpaidExtraDays" checked={hasExcessAck}
                  onChange={(e) => {
                    const stripped = leaveData.notes.replace(ACCEPT, '');
                    setLeaveData({ ...leaveData, notes: e.target.checked ? ACCEPT + stripped : stripped });
                  }}
                  className="mt-1 w-5 h-5 text-orange-600 rounded-md focus:ring-orange-500 border-gray-300 shrink-0" />
                <span>
                  <span className="block font-black text-slate-800 text-[13px]">إقرار وتفويض بالخصم</span>
                  <span className="block text-[12px] font-bold text-slate-500 mt-1 leading-relaxed">
                    أقر أنا الموظف ({fullName}) بالموافقة على استقطاع تكلفة الأيام الزائدة عن رصيدي المستحق دون أدنى مسؤولية على الشركة.
                  </span>
                </span>
              </label>
            </div>
          )}

          {/* Unpaid leave validation */}
          {unpaidBlocked && !preview?.issueMessage && (
            <div role="alert" className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
              <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} aria-hidden="true" />
              <p className="text-[12px] font-bold text-red-700">لا يمكن طلب إجازة بدون أجر ولا يزال لديك رصيد إجازات متاح ({formatLeaveDays(availableBalance)} يوم). يرجى استخدام الرصيد أولاً.</p>
            </div>
          )}

          {/* Notes */}
          <div>
            <label htmlFor="portal-leave-notes" className={labelClass}>ملاحظات</label>
            <textarea
              id="portal-leave-notes"
              rows={2}
              value={leaveData.notes.replace(OUTSIDE, '').replace(ACCEPT, '')}
              onChange={(e) => {
                const prefix = (isOutside ? OUTSIDE : '') + (hasExcessAck ? ACCEPT : '');
                setLeaveData({ ...leaveData, notes: prefix + e.target.value });
              }}
              placeholder="ملاحظات إضافية..."
              className={`${fieldClass} focus:border-blue-400 resize-none text-[13px]`}></textarea>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting === 'leave' || leaveBalanceLoading || previewLoading || unpaidBlocked || excessBlocked || previewBlocked}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50 text-[14px]">
              {submitting === 'leave' ? 'جاري الإرسال...' : 'تأكيد الطلب'}
            </button>
            <button type="button" onClick={() => setIsLeaveModalOpen(false)} disabled={submitting === 'leave'} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">إلغاء</button>
          </div>
        </form>
      </Modal>

      {/* Loan Modal */}
      <Modal
        open={isLoanModalOpen}
        onClose={() => setIsLoanModalOpen(false)}
        busy={submitting === 'loan'}
        tone="emerald"
        icon={<PiggyBank size={22} />}
        title="طلب سلفة"
        description="يخضع لعدة اعتمادات حسب سياسة الشركة"
      >
        <form onSubmit={handleLoanSubmit} className="p-6 md:p-8 space-y-6">
          <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <div>
              <label htmlFor="portal-loan-amount" className={labelClass}>المبلغ المطلوب (ر.س)</label>
              <input id="portal-loan-amount" type="number" inputMode="decimal" required min={1} step="0.01" value={loanData.amount} onChange={(e) => setLoanData({ ...loanData, amount: e.target.value })}
                className={`${fieldClass} focus:border-emerald-400`} />
            </div>
            <div>
              <label htmlFor="portal-loan-installment" className={labelClass}>القسط المقترح (ر.س)</label>
              <input id="portal-loan-installment" type="number" inputMode="decimal" required min={1} step="0.01" value={loanData.monthlyInstallment} onChange={(e) => setLoanData({ ...loanData, monthlyInstallment: e.target.value })}
                className={`${fieldClass} focus:border-emerald-400`} />
            </div>
          </div>

          <div>
            <label htmlFor="portal-loan-reason" className={labelClass}>تفاصيل ومبررات الطلب</label>
            <textarea
              id="portal-loan-reason"
              rows={4}
              required
              value={loanData.reason}
              onChange={(e) => setLoanData({ ...loanData, reason: e.target.value })}
              placeholder="يرجى كتابة أسباب طلب السلفة..."
              className={`${fieldClass} focus:border-emerald-400 resize-none`}></textarea>
          </div>

          <p className="text-[12px] font-bold text-amber-800 bg-amber-50 p-3 rounded-xl border border-amber-100 text-center">سيتم جدولة القسط ضمن مسير الرواتب القادم في حال الاعتماد.</p>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting === 'loan'} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
              {submitting === 'loan' ? 'جاري الإرسال...' : 'تأكيد وإرسال الطلب'}
            </button>
            <button type="button" onClick={() => setIsLoanModalOpen(false)} disabled={submitting === 'loan'} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">إلغاء</button>
          </div>
        </form>
      </Modal>

      {/* Medical Insurance Modal */}
      <Modal
        open={isMedicalModalOpen}
        onClose={() => setIsMedicalModalOpen(false)}
        tone="cyan"
        size="lg"
        icon={<Activity size={22} />}
        title="بيانات التأمين الطبي"
        description="وثيقة التأمين والشبكة الطبية الخاصة بك"
      >
        <div className="p-6 md:p-8">
          {insurance ? (
            <div className="space-y-6">
              <dl className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-3">
                {[
                  { label: 'شركة التأمين', value: insurance.insuranceIssuer },
                  { label: 'رقم الوثيقة', value: insurance.policyNumber },
                  { label: 'تاريخ الانتهاء', value: insurance.expiryDate ? formatDate(insurance.expiryDate) : null },
                  { label: 'الشبكة الطبية', value: insurance.medicalNetwork },
                  { label: 'نوع التغطية', value: insurance.coverageType },
                  { label: 'فئة التأمين', value: insurance.insuranceClass },
                  { label: 'تكلفة الوثيقة', value: insurance.policyCost ? `${formatMoney(insurance.policyCost)} ر.س` : null },
                ].map((row) => (
                  <div key={row.label} className="bg-slate-50 border border-slate-100 rounded-2xl p-4">
                    <dt className="text-[12px] font-black text-slate-500 mb-1">{row.label}</dt>
                    <dd className="font-bold text-[14px] text-slate-800">{row.value || 'غير محدد'}</dd>
                  </div>
                ))}
              </dl>

              {(insurance.coverageUrl || insurance.benefitsUrl) && (
                <div className="flex flex-wrap gap-3">
                  {insurance.coverageUrl && (
                    <a href={insurance.coverageUrl} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-[180px] bg-cyan-700 hover:bg-cyan-800 text-white py-3.5 rounded-2xl font-black transition text-[13px] flex items-center justify-center gap-2">
                      <DownloadCloud size={18} aria-hidden="true" /> ملف التغطية والشبكة الطبية
                    </a>
                  )}
                  {insurance.benefitsUrl && (
                    <a href={insurance.benefitsUrl} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-[180px] bg-white border-2 border-cyan-200 text-cyan-800 hover:bg-cyan-50 py-3.5 rounded-2xl font-black transition text-[13px] flex items-center justify-center gap-2">
                      <FileText size={18} aria-hidden="true" /> جدول المنافع
                    </a>
                  )}
                </div>
              )}

              <div className="text-center">
                <button type="button" onClick={() => { setIsMedicalModalOpen(false); openGeneralRequest('MEDICAL_INSURANCE'); }} className="text-blue-700 hover:underline text-[13px] font-bold">
                  طلب إضافة تابع أو ترقية الفئة
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-6">
              <Activity size={48} className="mx-auto text-slate-200 mb-4" aria-hidden="true" />
              <h3 className="text-lg font-black text-slate-700 mb-2">لا توجد بيانات تأمين مسجلة</h3>
              <p className="text-[13px] font-bold text-slate-500 mb-6">لم تُسجَّل وثيقة تأمين طبي لشركتك بعد، أو أنك غير مسجل في الوثيقة الحالية.</p>
              <button type="button" onClick={() => { setIsMedicalModalOpen(false); openGeneralRequest('MEDICAL_INSURANCE'); }} className="bg-cyan-700 hover:bg-cyan-800 text-white px-6 py-3 rounded-xl font-bold transition text-[13px]">
                طلب إصدار تأمين طبي
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* General Requests Modal */}
      <Modal
        open={isGeneralModalOpen}
        onClose={() => setIsGeneralModalOpen(false)}
        busy={submitting === 'general'}
        tone="indigo"
        icon={<Send size={22} />}
        title="طلبات أخرى"
        description="سيتم إرسال الطلب للموارد البشرية للمعالجة"
      >
        <form onSubmit={handleGeneralSubmit} className="p-6 md:p-8 space-y-6">
          <div>
            <label htmlFor="portal-general-type" className={labelClass}>نوع الطلب</label>
            <select
              id="portal-general-type"
              value={generalData.requestType}
              onChange={(e) => setGeneralData({ ...generalData, requestType: e.target.value })}
              className={`${fieldClass} focus:border-indigo-400 appearance-none`}>
              {Object.entries(GENERAL_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {generalData.requestType === 'ASSET' && (
            <div>
              <label htmlFor="portal-asset-type" className={labelClass}>نوع العهدة المطلوبة</label>
              <select
                id="portal-asset-type"
                value={generalData.assetType}
                onChange={(e) => setGeneralData({ ...generalData, assetType: e.target.value })}
                className={`${fieldClass} focus:border-indigo-400 appearance-none`}>
                {ASSET_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}

          {generalData.requestType === 'DATA_UPDATE' && (
            <div className="space-y-4 bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100/50">
              <div>
                <label htmlFor="portal-update-mobile" className={labelClass}>رقم الجوال الجديد</label>
                <input id="portal-update-mobile" type="tel" dir="ltr" autoComplete="tel" value={generalData.mobile} onChange={(e) => setGeneralData({ ...generalData, mobile: e.target.value })} placeholder="مثال: 0500000000" className={`${fieldClass} focus:border-indigo-400`} />
              </div>
              <div>
                <label htmlFor="portal-update-email" className={labelClass}>البريد الإلكتروني الجديد</label>
                <input id="portal-update-email" type="email" dir="ltr" autoComplete="email" value={generalData.email} onChange={(e) => setGeneralData({ ...generalData, email: e.target.value })} placeholder="مثال: employee@company.com" className={`${fieldClass} focus:border-indigo-400`} />
              </div>
              <div>
                <label htmlFor="portal-update-bank" className={labelClass}>اسم البنك</label>
                <select id="portal-update-bank" value={generalData.bankName} onChange={(e) => setGeneralData({ ...generalData, bankName: e.target.value })} className={`${fieldClass} focus:border-indigo-400 appearance-none`}>
                  <option value="">-- اختر البنك --</option>
                  {SAUDI_BANKS.map((b) => (
                    <option key={b.code} value={b.value}>{b.label} ({b.code})</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="portal-update-iban" className={labelClass}>الآيبان الجديد (IBAN)</label>
                <input id="portal-update-iban" type="text" dir="ltr" value={generalData.iban} onChange={(e) => setGeneralData({ ...generalData, iban: e.target.value.toUpperCase().replace(/\s+/g, '') })} placeholder="مثال: SA0000000000000000000000" aria-describedby="portal-update-iban-hint" className={`${fieldClass} focus:border-indigo-400`} />
                {ibanWarning(generalData.iban) && (
                  <p className="text-[12px] font-bold text-amber-700 mt-1">{ibanWarning(generalData.iban)}</p>
                )}
              </div>
              {generalData.iban.trim() && (
                <FileUploadField
                  name="ibanCertificate"
                  employeeId={employee.id}
                  required
                  value={generalData.ibanCertificateUrl}
                  onChange={(e) => setGeneralData({ ...generalData, ibanCertificateUrl: e.target.value })}
                  label="شهادة الآيبان من البنك"
                />
              )}
              <p id="portal-update-iban-hint" className="text-[12px] font-bold text-slate-600 leading-relaxed">
                يُحدَّث الجوال والبريد في ملفك بعد اعتماد الموارد البشرية. أما الآيبان فتعدّله الموارد البشرية يدوياً بعد التحقق من شهادة الآيبان.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="portal-general-details" className={labelClass}>{generalData.requestType === 'DATA_UPDATE' ? 'ملاحظات إضافية (اختياري)' : 'تفاصيل الطلب'}</label>
            <textarea
              id="portal-general-details"
              rows={4}
              required={generalData.requestType !== 'DATA_UPDATE'}
              value={generalData.details}
              onChange={(e) => setGeneralData({ ...generalData, details: e.target.value })}
              placeholder={
                generalData.requestType === 'VISIT_CERT'
                  ? 'اكتب اسم الجهة والغرض من الزيارة...'
                  : generalData.requestType === 'DATA_UPDATE'
                    ? 'أضف أي ملاحظات أو تفاصيل أخرى حول التحديث...'
                    : generalData.requestType === 'ASSET'
                      ? 'اكتب مواصفات العهدة المطلوبة ومبرر الطلب...'
                      : 'اكتب تفاصيل طلبك بالكامل...'
              }
              className={`${fieldClass} focus:border-indigo-400 resize-none`}></textarea>
          </div>

          {generalData.requestType === 'VISIT_CERT' && (
            <p className="text-[12px] font-bold text-indigo-800 leading-relaxed bg-indigo-50 border border-indigo-100 p-4 rounded-2xl">يرجى كتابة: اسم الجهة المطلوب التصديق لها، الغرض من الزيارة، والتاريخ المطلوب.</p>
          )}


          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting === 'general'} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
              {submitting === 'general' ? 'جاري الإرسال...' : 'إرسال الطلب'}
            </button>
            <button type="button" onClick={() => setIsGeneralModalOpen(false)} disabled={submitting === 'general'} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">إلغاء</button>
          </div>
        </form>
      </Modal>

    </DashboardLayout>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Presentational pieces
 * ---------------------------------------------------------------------------------------------- */

type Tone = 'blue' | 'amber' | 'emerald' | 'indigo' | 'rose';

/** Static class lists (Tailwind cannot see dynamically built class names). */
const ACTION_TONE: Record<Tone, { box: string; icon: string; title: string; sub: string }> = {
  blue: { box: 'bg-blue-50/60 border-blue-100 hover:bg-blue-50 focus-visible:ring-blue-400', icon: 'bg-blue-500 shadow-blue-500/30', title: 'text-blue-900', sub: 'text-blue-800/80' },
  amber: { box: 'bg-amber-50/60 border-amber-100 hover:bg-amber-50 focus-visible:ring-amber-400', icon: 'bg-amber-500 shadow-amber-500/30', title: 'text-amber-900', sub: 'text-amber-800/80' },
  emerald: { box: 'bg-emerald-50/60 border-emerald-100 hover:bg-emerald-50 focus-visible:ring-emerald-400', icon: 'bg-emerald-500 shadow-emerald-500/30', title: 'text-emerald-900', sub: 'text-emerald-800/80' },
  indigo: { box: 'bg-indigo-50/60 border-indigo-100 hover:bg-indigo-50 focus-visible:ring-indigo-400', icon: 'bg-indigo-500 shadow-indigo-500/30', title: 'text-indigo-900', sub: 'text-indigo-800/80' },
  rose: { box: 'bg-rose-50/60 border-rose-100 hover:bg-rose-50 focus-visible:ring-rose-400', icon: 'bg-rose-500 shadow-rose-500/30', title: 'text-rose-900', sub: 'text-rose-800/80' },
};

const STAT_TONE: Record<Tone, string> = {
  blue: 'bg-blue-50 text-blue-600',
  amber: 'bg-amber-50 text-amber-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  indigo: 'bg-indigo-50 text-indigo-600',
  rose: 'bg-rose-50 text-rose-600',
};

function ActionTile({ tone, icon, title, subtitle, onClick }: { tone: Tone; icon: React.ReactNode; title: string; subtitle: string; onClick: () => void }) {
  const t = ACTION_TONE[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full h-full rounded-3xl p-4 md:p-6 flex flex-col items-center justify-center text-center border transition cursor-pointer group focus:outline-none focus-visible:ring-2 ${t.box}`}
    >
      <span className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl flex items-center justify-center text-white shadow-lg group-hover:scale-105 transition transform mb-3 shrink-0 ${t.icon}`} aria-hidden="true">
        {icon}
      </span>
      <span className={`block font-extrabold text-[15px] md:text-lg ${t.title}`}>{title}</span>
      <span className={`block font-bold text-[12px] mt-0.5 ${t.sub}`}>{subtitle}</span>
    </button>
  );
}

function StatCard({ icon, tone, label, value, unit, note }: { icon: React.ReactNode; tone: Tone; label: string; value: string; unit: string; note?: string }) {
  return (
    <div className="bg-white rounded-3xl p-4 md:p-5 border border-slate-200 shadow-sm flex flex-col items-start sm:flex-row sm:items-center gap-2 sm:gap-3">
      <span className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${STAT_TONE[tone]}`} aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] font-black text-slate-500">{label}</p>
        <p className="text-lg md:text-xl font-black text-slate-800 whitespace-nowrap">
          {value} {unit && <span className="text-[11px] text-slate-500 font-bold">{unit}</span>}
        </p>
        {note && <p className="text-[11px] font-bold text-slate-400">{note}</p>}
      </div>
    </div>
  );
}
