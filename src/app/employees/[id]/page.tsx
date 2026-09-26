"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronRight, Pencil, Ban, Phone, Mail, Building2, Briefcase, Calendar, CreditCard,
  ShieldCheck, FileText, CheckCircle2, AlertCircle, UserCheck, ShieldAlert, Clock, Upload, ExternalLink, RefreshCw, Calculator,
  Landmark, X, Scale, Gauge
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError, confirmDialog } from '@/components/ui/feedback';
import { formatDate as formatDateLong, formatDateTime, todayKey, dateKey } from '@/lib/dates';
import {
  PASSPORT_NUMBER_RE,
  RECONCILE_GUIDANCE,
  classifyMuqeemApiError,
  firstUnresolved,
  ltr,
  validatePassportExtend,
  validatePassportRenew,
  type MuqeemEmployeeStatus,
  type MuqeemTxView,
  type MuqeemUiError,
} from '@/app/api/employees/[id]/muqeem/logic';
import { formatMoney, sumMoney } from '@/lib/money';
import { LOAN_DEDUCTIBLE_STATUSES, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { GOSI_REGIME_LABELS, isSaudiNationalityValue, parseGosiRegime } from '@/lib/employee-shared';
import { ID_TYPE_LABELS, parseIdType } from '@/lib/identity';
import { useRole } from '@/context/RoleContext';
import {
  DEPENDENTS_FEE_PAYER_LABELS,
  EXIT_REASONS,
  EXIT_REASON_LABELS,
  defaultExitVoluntary,
  type DependentsFeePayer,
  type ExitReason,
} from '@/app/api/employees/_workforce-fields';
import DataReviewBanner from '../_components/DataReviewBanner';

type DocKey = 'workContractUrl' | 'iqamaCopyUrl' | 'healthCertificateUrl' | 'passportCopyUrl';

interface NamedRef { id: string; nameArabic: string }

interface EmployeeProfile {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic?: string | null;
  firstNameEnglish?: string | null;
  lastNameEnglish?: string | null;
  jobTitle?: string | null;
  nationality?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  maritalStatus?: string | null;
  mobileNumber?: string | null;
  email?: string | null;
  bankName?: string | null;
  ibanNumber?: string | null;
  iqamaOrIdNumber?: string | null;
  iqamaOrIdExp?: string | null;
  passportNumber?: string | null;
  passportExp?: string | null;
  healthCertificateNum?: string | null;
  healthCertificateExp?: string | null;
  joinDate?: string | null;
  contractType?: string | null;
  contractEndDate?: string | null;
  basicSalary?: number | null;
  isTerminated?: boolean;
  legalCompany?: NamedRef | null;
  actualCompany?: NamedRef | null;
  administration?: NamedRef | null;
  branch?: NamedRef | null;
  department?: NamedRef | null;
  directManager?: { firstNameArabic: string; lastNameArabic?: string | null } | null;
  allowances?: { id: string; amount: number | null; isMonthly?: boolean | null }[];
  loans?: { id: string; status: string; remainingAmount?: number | null; isForgiven?: boolean | null }[];
  assets?: { id: string; returnDate?: string | null }[];
  workContractUrl?: string | null;
  iqamaCopyUrl?: string | null;
  healthCertificateUrl?: string | null;
  passportCopyUrl?: string | null;
  /** Incomplete data HR must complete (onboarding placeholders...). */
  dataReviewNote?: string | null;
  gosiRegime?: string | null;
  gosiRegistrationSource?: string | null;
  gosiNumber?: string | null;
  idType?: string | null;
  // Workforce decision engine data (absent for roles with a reduced view).
  occupationName?: string | null;
  occupationCode?: string | null;
  dependentsCount?: number | null;
  dependentsFeePaidBy?: string | null;
  medicalInsuranceClass?: string | null;
  isDisabled?: boolean;
  muawamaCertExpiry?: string | null;
  isStudent?: boolean;
  partTimeWeeklyHours?: number | null;
  qiwaContractDocumented?: boolean;
  qiwaContractDocumentedAt?: string | null;
  exitReason?: string | null;
  exitVoluntary?: boolean | null;
}

/** Roles that see the "محرك القرارات" card (true cost / exit cost pages). */
const DECISION_ENGINE_ROLES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER', 'HR_MANAGER'];

const exitReasonLabel = (v: string | null | undefined) => (v && (EXIT_REASONS as readonly string[]).includes(v) ? EXIT_REASON_LABELS[v as ExitReason] : v || '—');
const yesNo = (v: boolean | null | undefined) => (v === true ? 'نعم' : v === false ? 'لا' : 'غير محدد');

const DOCS: { key: DocKey; label: string; icon: string }[] = [
  { key: 'workContractUrl', label: 'عقد العمل', icon: '📄' },
  { key: 'iqamaCopyUrl', label: 'صورة الإقامة / الهوية', icon: '🏠' },
  { key: 'healthCertificateUrl', label: 'الشهادة الصحية', icon: '🏥' },
  { key: 'passportCopyUrl', label: 'صورة الجواز', icon: '✈️' },
];

const CONTRACT_LABELS: Record<string, string> = { FULL_TIME: 'دوام كامل', PART_TIME: 'دوام جزئي', FREELANCE: 'عمل عن بعد' };

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { role } = useRole();
  // HR actions (edit, terminate, settlement, uploads) are HR-only on the server too.
  const isHr = roleIn(role, ROLE_GROUPS.HR);
  // Direct termination (secondary path): HR and the legal department; only SUPER_ADMIN / LEGAL_ADMIN
  // may override the maternity / sick leave protection (server rule, DOM-004).
  const canTerminateDirectly = isHr || role === 'LEGAL_ADMIN';
  const canOverrideProtectedLeave = role === 'SUPER_ADMIN' || role === 'LEGAL_ADMIN';
  // Muqeem actions (real government transactions): GOV operators only, enforced by the API too.
  const isGov = roleIn(role, ROLE_GROUPS.GOV);
  const canSeeDecisionEngine = !!role && DECISION_ENGINE_ROLES.includes(role);
  const [emp, setEmp] = useState<EmployeeProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showTerminateModal, setShowTerminateModal] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [terminateReason, setTerminateReason] = useState('');
  const [protectedLeaveMsg, setProtectedLeaveMsg] = useState<string | null>(null);
  const [overrideProtectedLeave, setOverrideProtectedLeave] = useState(false);
  const [exitReason, setExitReason] = useState<ExitReason | ''>('');
  /** 'yes' / 'no' / '' (not set); pre-filled from the reason. */
  const [exitVoluntary, setExitVoluntary] = useState<'yes' | 'no' | ''>('');
  const [uploadingField, setUploadingField] = useState<DocKey | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (res.status === 404) {
        setEmp(null);
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل ملف الموظف'));
        return;
      }
      setEmp((await res.json()) as EmployeeProfile);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  /** Re-reads the profile without the full-page spinner (after a Muqeem update). */
  const refreshEmp = useCallback(async () => {
    try {
      const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.ok) setEmp((await res.json()) as EmployeeProfile);
    } catch {
      // keep the current data; the Muqeem card shows its own result
    }
  }, [id]);

  const soonKey = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    return todayKey(d);
  }, []);

  const closeTerminateModal = () => {
    setShowTerminateModal(false);
    setTerminateReason('');
    setProtectedLeaveMsg(null);
    setOverrideProtectedLeave(false);
    setExitReason('');
    setExitVoluntary('');
  };

  const chooseExitReason = (value: string) => {
    const reason = (EXIT_REASONS as readonly string[]).includes(value) ? (value as ExitReason) : '';
    setExitReason(reason);
    const def = reason ? defaultExitVoluntary(reason) : null;
    setExitVoluntary(def === true ? 'yes' : def === false ? 'no' : '');
  };

  const handleTerminate = async () => {
    if (isTerminating) return;
    if (terminateReason.trim().length < 3) {
      toast.warning('اكتب سبب إنهاء الخدمات، فهو يُحفظ في سجل التدقيق');
      return;
    }
    if (!exitReason) {
      toast.warning('اختر تصنيف سبب الخروج');
      return;
    }
    setIsTerminating(true);
    try {
      const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'terminate',
          reason: terminateReason.trim(),
          exitReason,
          exitVoluntary: exitVoluntary === 'yes' ? true : exitVoluntary === 'no' ? false : null,
          ...(overrideProtectedLeave ? { overrideProtectedLeave: true } : {}),
        }),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر إنهاء خدمات الموظف');
        const data = (await res.json().catch(() => null)) as { details?: { code?: string } } | null;
        if (res.status === 409 && data?.details?.code === 'PROTECTED_LEAVE') setProtectedLeaveMsg(msg);
        toast.error(msg);
        return;
      }
      toast.success('تم إنهاء خدمات الموظف');
      closeTerminateModal();
      router.push('/employees');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsTerminating(false);
    }
  };

  const handleUpload = async (key: DocKey, input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || uploadingField) return;
    setUploadingField(key);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('field', key);
      fd.append('employeeId', id);
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!uploadRes.ok) {
        toast.error(await readApiError(uploadRes, 'فشل رفع الملف'));
        return;
      }
      const uploadData = (await uploadRes.json()) as { url?: string; fileUrl?: string };
      const fileUrl = uploadData.url || uploadData.fileUrl;
      if (!fileUrl) {
        toast.error('فشل رفع الملف');
        return;
      }
      const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: fileUrl }),
      });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حفظ المرفق'));
        return;
      }
      setEmp((prev) => (prev ? { ...prev, [key]: fileUrl } : prev));
      toast.success('تم رفع المرفق بنجاح');
    } catch {
      toast.error('فشل رفع الملف');
    } finally {
      setUploadingField(null);
    }
  };

  const isExpiringSoon = (d: string | null | undefined) => {
    const k = dateKey(d);
    return k !== null && k <= soonKey;
  };

  const formatDate = (d: string | null | undefined) => (d ? formatDateLong(d) : 'غير متوفر');
  /** Fields the API omits for this role (identity data for finance, most fields for managers). */
  const shown = (v: string | null | undefined, fmt: (x: string | null | undefined) => string = (x) => x || '—') =>
    v === undefined && !isHr ? 'غير متاح لصلاحيتك' : fmt(v);

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-full">
          <div className="w-16 h-16 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" aria-label="جاري التحميل" />
        </div>
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-full gap-4 py-20">
          <AlertCircle size={48} className="text-red-400" />
          <p className="font-bold text-slate-600">{loadError}</p>
          <div className="flex items-center gap-4">
            <button type="button" onClick={load} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[13px] transition-colors">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
            <Link href="/employees" className="text-blue-600 font-bold underline">العودة لقائمة الموظفين</Link>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (!emp) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <AlertCircle size={48} className="text-red-400" />
          <p className="font-bold text-slate-600">لم يتم العثور على الموظف</p>
          <Link href="/employees" className="text-blue-600 font-bold underline">العودة لقائمة الموظفين</Link>
        </div>
      </DashboardLayout>
    );
  }

  const unreturnedAssets = emp.assets?.filter((a) => !a.returnDate) || [];
  const unpaidLoans =
    emp.loans?.filter((l) => (LOAN_DEDUCTIBLE_STATUSES as readonly string[]).includes(l.status) && (l.remainingAmount ?? 0) > 0 && !l.isForgiven) || [];
  // Only recurring allowances belong to the salary; one-off bonuses are paid by payroll.
  const totalSalary = sumMoney([emp.basicSalary ?? 0, ...(emp.allowances ?? []).filter((a) => a.isMonthly !== false).map((a) => a.amount ?? 0)]);
  const fullName = `${emp.firstNameArabic} ${emp.lastNameArabic || ''}`.trim();
  const settlementHref = `/settlements/new?employeeId=${encodeURIComponent(emp.id)}&type=END_OF_SERVICE`;

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto p-6 pb-24 space-y-8">

        {/* Breadcrumb */}
        <div className="flex items-center gap-3 text-sm font-bold text-slate-400">
          <Link href="/employees" className="hover:text-blue-600 transition-colors flex items-center gap-1">
            <ChevronRight size={16} />
            إدارة الموظفين
          </Link>
          <span>/</span>
          <span className="text-slate-700">{fullName}</span>
        </div>

        <DataReviewBanner
          note={emp.dataReviewNote}
          employeeId={emp.id}
          canClear={isHr}
          editHref={isHr && !emp.isTerminated ? `/employees/${emp.id}/edit` : undefined}
          onCleared={() => setEmp((prev) => (prev ? { ...prev, dataReviewNote: null } : prev))}
        />

        {/* Hero Card */}
        <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_40px_rgba(0,0,0,0.04)] overflow-hidden">
          <div className="h-28 bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-700 relative">
            <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 20% 50%, white 1px, transparent 1px)', backgroundSize: '30px 30px' }} />
          </div>
          <div className="px-8 pb-8">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 -mt-10 mb-8">
              <div className="flex items-end gap-5">
                <div className="w-24 h-24 rounded-[1.5rem] bg-gradient-to-br from-blue-100 to-indigo-100 border-4 border-white shadow-xl flex items-center justify-center text-blue-700 font-black text-4xl shrink-0">
                  {emp.firstNameArabic.charAt(0)}
                </div>
                <div className="pb-2">
                  <div className={`inline-flex items-center gap-1.5 text-[11px] font-black px-2.5 py-1 rounded-lg mb-2
                    ${emp.isTerminated ? 'bg-red-50 text-red-600 border border-red-100' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'}`}>
                    {emp.isTerminated ? <ShieldAlert size={12} /> : <UserCheck size={12} />}
                    {emp.isTerminated ? 'منتهي الخدمات' : 'على رأس العمل'}
                  </div>
                  <h1 className="text-2xl font-black text-slate-900">{fullName}</h1>
                  <p className="text-slate-500 font-bold text-[14px] mt-0.5">{emp.jobTitle || 'موظف'} • {emp.legalCompany?.nameArabic || 'بدون شركة'}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 pb-2">
                {isHr && !emp.isTerminated && (
                  <>
                    <Link
                      href={`/employees/${emp.id}/edit`}
                      className="flex items-center gap-2 px-5 py-2.5 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 text-slate-700 rounded-xl font-bold text-[13px] transition-all border border-transparent hover:border-blue-100"
                    >
                      <Pencil size={15} />
                      تعديل البيانات
                    </Link>
                    <Link
                      href={settlementHref}
                      title="يفتح معالج تصفية نهاية الخدمة؛ تنتهي الخدمة عند اعتماد صاحب العمل للتصفية"
                      className="flex items-center gap-2 px-5 py-2.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-[13px] transition-all border border-red-100"
                    >
                      <Ban size={15} />
                      إنهاء الخدمات
                    </Link>
                  </>
                )}
                {canTerminateDirectly && !emp.isTerminated && (
                  <button
                    type="button"
                    onClick={() => setShowTerminateModal(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-slate-500 hover:text-red-600 rounded-xl font-bold text-[12px] underline underline-offset-4 transition-colors"
                  >
                    إنهاء مباشر بدون تصفية
                  </button>
                )}
                {isHr && emp.isTerminated && (
                  <Link
                    href={settlementHref}
                    className="flex items-center gap-2 px-5 py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-xl font-bold text-[13px] transition-all border border-amber-100"
                  >
                    <Calculator size={15} />
                    تصفية نهاية الخدمة
                  </Link>
                )}
              </div>
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'الرقم الوظيفي', value: emp.employeeId, icon: <Briefcase size={18} className="text-blue-500" /> },
                { label: 'تاريخ المباشرة', value: formatDate(emp.joinDate), icon: <Calendar size={18} className="text-indigo-500" /> },
                { label: 'الراتب الإجمالي', value: emp.basicSalary === undefined && !isHr ? 'غير متاح لصلاحيتك' : `${formatMoney(totalSalary)} ريال`, icon: <CreditCard size={18} className="text-emerald-500" /> },
                { label: 'نوع العقد', value: shown(emp.contractType, (c) => CONTRACT_LABELS[c || ''] || '—'), icon: <FileText size={18} className="text-amber-500" /> },
              ].map((stat) => (
                <div key={stat.label} className="bg-slate-50 rounded-[1.25rem] p-4 border border-slate-100">
                  <div className="flex items-center gap-2 mb-2">
                    {stat.icon}
                    <p className="text-[11px] font-black uppercase text-slate-400">{stat.label}</p>
                  </div>
                  <p className="font-extrabold text-slate-800 text-[15px]">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Personal Details */}
          <InfoCard title="البيانات الشخصية" icon={<CheckCircle2 size={18} className="text-emerald-500" />}>
            <InfoRow label="الاسم بالعربية" value={fullName} />
            <InfoRow label="الاسم بالإنجليزية" value={[emp.firstNameEnglish, emp.lastNameEnglish].filter(Boolean).join(' ') || '—'} />
            <InfoRow label="الجنسية" value={isSaudiNationalityValue(emp.nationality) ? 'مواطن سعودي' : (emp.nationality || '—')} />
            <InfoRow label="الجنس" value={emp.gender === 'FEMALE' ? 'أنثى' : emp.gender === 'MALE' ? 'ذكر' : (emp.gender || '—')} />
            <InfoRow label="تاريخ الميلاد" value={shown(emp.dateOfBirth, formatDate)} />
            <InfoRow label="الحالة الاجتماعية" value={emp.maritalStatus || '—'} />
          </InfoCard>

          {/* Contact */}
          <InfoCard title="بيانات التواصل" icon={<Phone size={18} className="text-blue-500" />}>
            <InfoRow label="الجوال" value={emp.mobileNumber || '—'} icon={<Phone size={14} className="text-slate-400" />} />
            <InfoRow label="البريد الإلكتروني" value={emp.email || '—'} icon={<Mail size={14} className="text-slate-400" />} />
            <InfoRow label="البنك" value={emp.bankName || '—'} icon={<CreditCard size={14} className="text-slate-400" />} />
            <InfoRow label="رقم الآيبان" value={emp.ibanNumber ? `SA...${emp.ibanNumber.slice(-4)}` : '—'} />
          </InfoCard>

          {/* Documents */}
          <InfoCard title="الوثائق الرسمية" icon={<ShieldCheck size={18} className="text-violet-500" />}>
            <InfoRow label="نوع الهوية" value={(() => { const t = parseIdType(emp.idType ?? ''); return t ? ID_TYPE_LABELS[t] : '—'; })()} />
            <InfoRow label="رقم الهوية / الإقامة" value={shown(emp.iqamaOrIdNumber)} />
            <InfoRow label="تاريخ الانتهاء" value={formatDate(emp.iqamaOrIdExp)} danger={isExpiringSoon(emp.iqamaOrIdExp)} />
            <InfoRow label="رقم الجواز" value={shown(emp.passportNumber)} />
            <InfoRow label="انتهاء الجواز" value={formatDate(emp.passportExp)} danger={isExpiringSoon(emp.passportExp)} />
            <InfoRow label="رقم الشهادة الصحية" value={emp.healthCertificateNum || '—'} />
            <InfoRow label="انتهاء الشهادة الصحية" value={formatDate(emp.healthCertificateExp)} danger={isExpiringSoon(emp.healthCertificateExp)} />
          </InfoCard>

          {/* Company/Job */}
          <InfoCard title="الصفة الوظيفية" icon={<Building2 size={18} className="text-amber-500" />}>
            <InfoRow label="الشركة القانونية" value={emp.legalCompany?.nameArabic || '—'} />
            <InfoRow label="الشركة الفعلية" value={emp.actualCompany?.nameArabic || '—'} />
            <InfoRow label="الإدارة" value={emp.administration?.nameArabic || '—'} />
            <InfoRow label="الفرع" value={emp.branch?.nameArabic || '—'} />
            <InfoRow label="القسم" value={emp.department?.nameArabic || '—'} />
            <InfoRow label="المدير المباشر" value={emp.directManager ? `${emp.directManager.firstNameArabic} ${emp.directManager.lastNameArabic || ''}`.trim() : '—'} />
            <InfoRow label="تاريخ انتهاء العقد" value={formatDate(emp.contractEndDate)} danger={isExpiringSoon(emp.contractEndDate)} />
            <InfoRow label="نظام التأمينات" value={GOSI_REGIME_LABELS[parseGosiRegime(emp.gosiRegime ?? '') ?? 'UNKNOWN']} danger={(parseGosiRegime(emp.gosiRegime ?? '') ?? 'UNKNOWN') === 'UNKNOWN' && isSaudiNationalityValue(emp.nationality)} />
            {emp.gosiRegistrationSource && <InfoRow label="مصدر تأكيد التأمينات" value={emp.gosiRegistrationSource} />}
            <InfoRow label="رقم الاشتراك في التأمينات" value={emp.gosiNumber || '—'} />
          </InfoCard>

          {/* Workforce decision engine data (roles with a reduced view do not receive these fields) */}
          {emp.qiwaContractDocumented !== undefined && (
            <InfoCard title="بيانات الكلفة والسعودة" icon={<Scale size={18} className="text-amber-500" />}>
              <InfoRow label="المهنة" value={[emp.occupationName, emp.occupationCode ? `(${emp.occupationCode})` : null].filter(Boolean).join(' ') || '—'} />
              <InfoRow label="عدد المرافقين" value={emp.dependentsCount != null ? String(emp.dependentsCount) : '—'} />
              <InfoRow
                label="رسوم المرافقين على"
                value={emp.dependentsFeePaidBy && emp.dependentsFeePaidBy in DEPENDENTS_FEE_PAYER_LABELS ? DEPENDENTS_FEE_PAYER_LABELS[emp.dependentsFeePaidBy as DependentsFeePayer] : '—'}
              />
              <InfoRow label="فئة التأمين الطبي" value={emp.medicalInsuranceClass || '—'} />
              <InfoRow
                label="ذو إعاقة"
                value={emp.isDisabled === undefined ? 'غير متاح لصلاحيتك' : emp.isDisabled ? `نعم${emp.muawamaCertExpiry ? ` — مواءمة حتى ${formatDate(emp.muawamaCertExpiry)}` : ' — بلا شهادة مواءمة'}` : 'لا'}
                danger={!!emp.isDisabled && (!emp.muawamaCertExpiry || isExpiringSoon(emp.muawamaCertExpiry))}
              />
              <InfoRow label="طالب" value={emp.isStudent ? 'نعم' : 'لا'} />
              {emp.contractType === 'PART_TIME' && (
                <InfoRow label="ساعات الدوام الجزئي أسبوعياً" value={emp.partTimeWeeklyHours != null ? String(emp.partTimeWeeklyHours) : '—'} danger={emp.partTimeWeeklyHours == null} />
              )}
              <InfoRow
                label="العقد موثّق في قوى"
                value={emp.qiwaContractDocumented ? `نعم${emp.qiwaContractDocumentedAt ? ` — ${formatDate(emp.qiwaContractDocumentedAt)}` : ''}` : 'لا'}
                danger={!emp.qiwaContractDocumented && !emp.isTerminated}
              />
              {emp.isTerminated && (
                <>
                  <InfoRow label="سبب الخروج" value={exitReasonLabel(emp.exitReason)} />
                  <InfoRow label="خروج طوعي" value={yesNo(emp.exitVoluntary)} />
                </>
              )}
            </InfoCard>
          )}

          {canSeeDecisionEngine && (
            <InfoCard title="محرك القرارات" icon={<Gauge size={18} className="text-indigo-500" />}>
              <div className="flex flex-col gap-3 py-2">
                <Link
                  href={`/workforce/true-cost?employeeId=${encodeURIComponent(emp.id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-extrabold text-[13px] transition-colors"
                >
                  الكلفة الحقيقية لهذا الموظف <Calculator size={16} />
                </Link>
                <Link
                  href={`/workforce/exit-cost?employeeId=${encodeURIComponent(emp.id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-extrabold text-[13px] transition-colors"
                >
                  كلفة الإنهاء <Ban size={16} />
                </Link>
              </div>
            </InfoCard>
          )}

        </div>

        {/* Muqeem (government residents platform): GOV operators, non-Saudi employees only */}
        {isGov && !isSaudiNationalityValue(emp.nationality) && (
          <MuqeemCard employeeId={emp.id} onEmployeeChanged={refreshEmp} />
        )}

        {/* Employee Documents */}
        <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center"><FileText size={18} className="text-blue-500" /></span>
            <h2 className="font-extrabold text-[15px] text-slate-800">مرفقات ووثائق الموظف</h2>
          </div>
          <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {DOCS.map((doc) => {
              const url = emp[doc.key];
              const isUploading = uploadingField === doc.key;
              return (
                <div key={doc.key} className="border border-slate-100 rounded-2xl p-4 flex items-center justify-between gap-3 hover:bg-slate-50 transition">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl" aria-hidden="true">{doc.icon}</span>
                    <div>
                      <p className="font-extrabold text-[13px] text-slate-800">{doc.label}</p>
                      <p className="text-[11px] font-bold text-slate-400">{isUploading ? 'جاري الرفع...' : url ? 'تم الرفع' : url === undefined && !isHr ? 'غير متاح لصلاحيتك' : 'غير مرفق'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {url && (
                      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`عرض ${doc.label}`} className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center transition" title="عرض المرفق">
                        <ExternalLink size={15} />
                      </a>
                    )}
                    {isHr && (
                    <label
                      className={`w-9 h-9 rounded-xl flex items-center justify-center transition focus-within:ring-2 focus-within:ring-emerald-300 ${uploadingField ? 'cursor-not-allowed' : 'cursor-pointer'} ${isUploading ? 'bg-emerald-100 text-emerald-600 animate-pulse' : 'bg-slate-100 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600'}`}
                      title="رفع / تحديث"
                    >
                      <Upload size={15} />
                      <span className="sr-only">رفع أو تحديث {doc.label}</span>
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf,.png,.jpg,.jpeg"
                        disabled={!!uploadingField}
                        onChange={(e) => handleUpload(doc.key, e.currentTarget)}
                      />
                    </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Terminate Confirm Modal */}
        {showTerminateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="terminate-title">
            <div className="bg-white rounded-[2rem] p-6 sm:p-8 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-200">
              <div className="w-16 h-16 bg-red-50 rounded-[1.25rem] flex items-center justify-center mx-auto mb-6">
                <Ban size={28} className="text-red-500" />
              </div>
              <h3 id="terminate-title" className="text-xl font-black text-slate-900 text-center mb-2">إنهاء مباشر بدون تصفية</h3>
              <p className="text-slate-500 text-center font-semibold text-[14px] mb-4 leading-relaxed">
                سيُسجَّل تاريخ اليوم تاريخاً لإنهاء خدمات <strong className="text-slate-800">{fullName}</strong> دون إنشاء تصفية لمستحقاته.
              </p>
              <p className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-[12px] font-bold leading-relaxed mb-5">
                الطريق المعتاد هو{' '}
                <Link href={settlementHref} className="underline font-black">معالج تصفية نهاية الخدمة</Link>
                {' '}لأن المادة 88 توجب تسوية المستحقات خلال أسبوع من انتهاء العلاقة (وأسبوعين إذا أنهى العامل العقد). ويمكن إنشاء التصفية لاحقاً حتى بعد الإنهاء المباشر.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div>
                  <label htmlFor="terminate-exit-reason" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">
                    تصنيف سبب الخروج <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="terminate-exit-reason"
                    value={exitReason}
                    onChange={(e) => chooseExitReason(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border-2 border-transparent focus:border-red-300 focus:bg-white rounded-xl font-bold text-slate-800 text-[13px] focus:outline-none"
                  >
                    <option value="">— اختر —</option>
                    {EXIT_REASONS.map((r) => <option key={r} value={r}>{EXIT_REASON_LABELS[r]}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="terminate-exit-voluntary" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">هل الخروج طوعي؟</label>
                  <select
                    id="terminate-exit-voluntary"
                    value={exitVoluntary}
                    onChange={(e) => setExitVoluntary(e.target.value === 'yes' ? 'yes' : e.target.value === 'no' ? 'no' : '')}
                    className="w-full px-3 py-2.5 bg-slate-50 border-2 border-transparent focus:border-red-300 focus:bg-white rounded-xl font-bold text-slate-800 text-[13px] focus:outline-none"
                  >
                    <option value="">غير محدد</option>
                    <option value="yes">نعم، بقرار الموظف</option>
                    <option value="no">لا</option>
                  </select>
                </div>
              </div>
              <label htmlFor="terminate-reason" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">
                سبب الإنهاء (نص) <span className="text-red-500">*</span>
              </label>
              <textarea
                id="terminate-reason"
                value={terminateReason}
                onChange={(e) => setTerminateReason(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="اكتب سبب الإنهاء كما سيُحفظ في سجل التدقيق"
                className="w-full mb-5 px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-red-300 focus:bg-white rounded-xl font-bold text-slate-800 text-[13px] focus:outline-none resize-none"
              />
              {protectedLeaveMsg && (
                <div role="alert" className="bg-red-50 border border-red-200 rounded-xl p-3 mb-5 text-right">
                  <p className="text-[12px] font-bold text-red-700 leading-relaxed">{protectedLeaveMsg}</p>
                  {canOverrideProtectedLeave && (
                    <label className="mt-3 flex items-start gap-2 cursor-pointer text-[12px] font-black text-red-800">
                      <input
                        type="checkbox"
                        checked={overrideProtectedLeave}
                        onChange={(e) => setOverrideProtectedLeave(e.target.checked)}
                        className="mt-0.5 w-4 h-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                      />
                      أؤكد تجاوز حماية الإجازة على مسؤوليتي، ويُسجَّل السبب المكتوب أعلاه في سجل التدقيق.
                    </label>
                  )}
                </div>
              )}

              {(unreturnedAssets.length > 0 || unpaidLoans.length > 0) && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6 text-right">
                  <h4 className="font-extrabold text-red-800 flex items-center gap-2 mb-3">
                    <ShieldAlert size={18} /> لا يمكن إتمام عملية الإنهاء:
                  </h4>
                  <ul className="text-[13px] font-bold text-red-700 space-y-2 list-disc list-inside">
                    {unreturnedAssets.length > 0 && (
                      <li>الموظف لديه ({unreturnedAssets.length}) عُهدة غير مسلمة.</li>
                    )}
                    {unpaidLoans.length > 0 && (
                      <li>الموظف لديه ({unpaidLoans.length}) سلفة غير مسددة بالكامل.</li>
                    )}
                  </ul>
                  <p className="text-[11px] text-red-600 mt-4 leading-relaxed font-semibold">
                    يجب تصفية السلف من خلال (مسير الرواتب - التصفية النهائية) وإخلاء طرفه من (إدارة العهد) قبل الموافقة على إنهاء الخدمات.
                  </p>
                  <Link href={settlementHref} className="mt-3 inline-flex items-center gap-1 text-[12px] font-black text-red-700 underline">
                    <Calculator size={13} /> فتح التصفية النهائية لهذا الموظف
                  </Link>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeTerminateModal}
                  disabled={isTerminating}
                  className="flex-1 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all disabled:opacity-50"
                >
                  إلغاء
                </button>
                {unreturnedAssets.length > 0 || unpaidLoans.length > 0 ? (
                  <button
                    type="button"
                    onClick={closeTerminateModal}
                    className="flex-1 py-3.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl transition-all"
                  >
                    حسناً، فهمت
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleTerminate}
                    disabled={isTerminating || terminateReason.trim().length < 3 || !exitReason || (!!protectedLeaveMsg && !overrideProtectedLeave)}
                    className="flex-1 py-3.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isTerminating ? <Clock size={16} className="animate-spin" /> : <Ban size={16} />}
                    {isTerminating ? 'جاري التنفيذ...' : 'تأكيد الإنهاء'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// Muqeem card: recent Muqeem transactions of the employee, passport updates, reconciliation
// ---------------------------------------------------------------------------

const TX_STATUS_STYLE: Record<string, string> = {
  SUCCEEDED: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  FAILED: 'bg-slate-100 text-slate-600 border-slate-200',
  PENDING: 'bg-amber-50 text-amber-700 border-amber-100',
  UNKNOWN: 'bg-red-50 text-red-700 border-red-200',
};

type PassportMode = 'RENEW_PASSPORT' | 'EXTEND_PASSPORT';

const inputCls = 'w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-indigo-300 focus:bg-white rounded-xl font-bold text-slate-800 text-[13px] focus:outline-none';

async function postMuqeem(employeeId: string, payload: Record<string, unknown>): Promise<{ ok: true; data: { message?: string; applied?: boolean; alreadyDone?: boolean; differentRequest?: boolean } } | { ok: false; error: MuqeemUiError }> {
  try {
    const res = await fetch(`/api/employees/${encodeURIComponent(employeeId)}/muqeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, confirmed: true }),
    });
    if (res.status === 401) {
      window.location.href = '/login';
      return { ok: false, error: { kind: 'OTHER', message: 'انتهت الجلسة', transactionId: null, mustReconcile: false } };
    }
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: classifyMuqeemApiError(res.status, data, 'تعذر تنفيذ العملية على منصة مقيم') };
    return { ok: true, data: (data ?? {}) as { message?: string; applied?: boolean; alreadyDone?: boolean; differentRequest?: boolean } };
  } catch {
    // The request may have reached the server: never invite a blind retry.
    return {
      ok: false,
      error: {
        kind: 'UNKNOWN_OUTCOME',
        message: 'انقطع الاتصال بالخادم أثناء تنفيذ الطلب، ولا يمكن التأكد من نتيجته. أعد تحميل الصفحة وراجع سجل عمليات مقيم أدناه قبل أي محاولة جديدة.',
        transactionId: null,
        mustReconcile: true,
      },
    };
  }
}

function MuqeemCard({ employeeId, onEmployeeChanged }: { employeeId: string; onEmployeeChanged: () => void }) {
  const [status, setStatus] = useState<MuqeemEmployeeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [passportMode, setPassportMode] = useState<PassportMode | null>(null);
  const [reconcileTx, setReconcileTx] = useState<MuqeemTxView | null>(null);
  const [lastError, setLastError] = useState<MuqeemUiError | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    fetch(`/api/employees/${encodeURIComponent(employeeId)}/muqeem`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const msg = await readApiError(res, 'تعذر تحميل بيانات مقيم');
          if (active) setLoadError(msg);
          return;
        }
        const data = (await res.json()) as MuqeemEmployeeStatus;
        if (!active) return;
        setLoadError(null);
        setStatus(data);
      })
      .catch(() => {
        if (active) setLoadError('تعذر الاتصال بالخادم');
      });
    return () => {
      active = false;
    };
  }, [employeeId, reloadKey]);

  const afterChange = (err: MuqeemUiError | null) => {
    setLastError(err);
    load();
    if (!err) onEmployeeChanged();
  };

  const passportBlocker = status ? firstUnresolved(status.transactions, ['PASSPORT_RENEW', 'PASSPORT_EXTEND']) : null;
  const canAct = !!status?.eligibility.eligible && !passportBlocker;

  // Saudi nationals are not residents: no card (some roles do not receive the nationality in the
  // profile, so the server's eligibility decides).
  if (status?.eligibility.reason === 'SAUDI' && status.transactions.length === 0) return null;

  return (
    <div id="muqeem" className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-hidden scroll-mt-24">
      <div className="px-6 py-5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center"><Landmark size={18} className="text-indigo-600" /></span>
          <div>
            <h2 className="font-extrabold text-[15px] text-slate-800">مقيم</h2>
            <p className="text-[11px] font-bold text-slate-400">عمليات المقيم على منصة مقيم (الجوازات) بحساب الشركة القانونية</p>
          </div>
        </div>
        {status && (
          <span className={`text-[11px] font-black px-2.5 py-1 rounded-lg border ${status.company?.linked ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
            {status.company ? `${status.company.name}: ${status.company.linked ? 'مربوطة بمقيم' : 'غير مربوطة بمقيم'}` : 'بدون شركة قانونية'}
          </span>
        )}
      </div>

      <div className="p-6 space-y-5">
        {!status && !loadError && <p className="text-[13px] font-bold text-slate-400">جاري تحميل بيانات مقيم...</p>}
        {loadError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-[13px] font-bold flex items-center justify-between gap-3">
            <span>{loadError}</span>
            <button type="button" onClick={load} className="underline shrink-0">إعادة المحاولة</button>
          </div>
        )}

        {status && (
          <>
            {!status.eligibility.eligible && (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-2xl text-[13px] font-bold leading-relaxed flex items-start gap-2">
                <AlertCircle size={16} className="shrink-0 mt-0.5" /> {status.eligibility.message}
              </div>
            )}

            {lastError && (
              <div role="alert" className={`px-4 py-3 rounded-2xl text-[13px] font-bold leading-relaxed space-y-1 border ${lastError.mustReconcile ? 'bg-red-50 border-red-300 text-red-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
                <div className="flex items-start justify-between gap-2">
                  <p>{lastError.message}</p>
                  <button type="button" aria-label="إخفاء" onClick={() => setLastError(null)} className="shrink-0 text-red-400 hover:text-red-700"><X size={14} /></button>
                </div>
                {lastError.mustReconcile && <p>{RECONCILE_GUIDANCE}</p>}
              </div>
            )}

            {passportBlocker && (
              <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-2xl text-[12px] font-bold leading-relaxed">
                تحديثات الجواز موقوفة: عملية «{passportBlocker.operationLabel}» حالتها «{passportBlocker.statusLabel}». {RECONCILE_GUIDANCE}
              </div>
            )}

            {status.eligibility.eligible && (
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={!canAct} onClick={() => setPassportMode('RENEW_PASSPORT')}
                  className="flex items-center gap-2 px-4 py-2.5 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 rounded-xl font-black text-[13px] border border-indigo-100 transition disabled:opacity-50 disabled:pointer-events-none">
                  <RefreshCw size={14} /> تحديث بيانات الجواز
                </button>
                <button type="button" disabled={!canAct} onClick={() => setPassportMode('EXTEND_PASSPORT')}
                  className="flex items-center gap-2 px-4 py-2.5 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 rounded-xl font-black text-[13px] border border-indigo-100 transition disabled:opacity-50 disabled:pointer-events-none">
                  <Calendar size={14} /> تمديد صلاحية الجواز
                </button>
                <Link href={`/renewals?employeeId=${encodeURIComponent(employeeId)}`}
                  className="flex items-center gap-2 px-4 py-2.5 text-slate-600 hover:text-indigo-700 rounded-xl font-bold text-[12px] underline underline-offset-4">
                  تجديد الإقامة عبر مقيم من شاشة التجديدات
                </Link>
              </div>
            )}

            <div>
              <h3 className="text-[12px] font-black text-slate-500 mb-2">آخر عمليات مقيم لهذا الموظف</h3>
              {status.transactions.length === 0 ? (
                <p className="text-[13px] font-bold text-slate-400">لا توجد عمليات مقيم مسجلة لهذا الموظف.</p>
              ) : (
                <ul className="divide-y divide-slate-100 border border-slate-100 rounded-2xl overflow-hidden">
                  {status.transactions.map((t) => (
                    <li key={t.id} className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <p className="font-extrabold text-[13px] text-slate-800">{t.operationLabel}</p>
                        <p className="text-[11px] font-bold text-slate-400">
                          {formatDateTime(t.createdAt)}{t.requestedBy ? ` • ${t.requestedBy}` : ''}{t.externalRef ? ` • المرجع ${t.externalRef}` : ''}{t.reconciled ? ' • سُوّيت يدوياً بعد التحقق من مقيم' : ''}
                        </p>
                        {t.errorMessage && <p className="text-[12px] font-bold text-slate-600 break-words">{t.errorMessage}</p>}
                        {t.status === 'UNKNOWN' && <p className="text-[12px] font-bold text-red-700">{RECONCILE_GUIDANCE}</p>}
                        {t.documentUrl && (
                          <a href={t.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-black text-blue-600 underline">
                            <ExternalLink size={12} /> المستند
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[11px] font-black px-2.5 py-1 rounded-lg border ${TX_STATUS_STYLE[t.status] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>{t.statusLabel}</span>
                        {t.canReconcile && (
                          <button type="button" onClick={() => setReconcileTx(t)}
                            className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-black text-[12px] transition">
                            تسوية
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {!status.canReconcile && status.transactions.some((t) => t.unresolved) && (
                <p className="mt-2 text-[11px] font-bold text-slate-500">تسوية العمليات غير المحسومة متاحة لمدير النظام وصاحب العمل وموظف العلاقات الحكومية.</p>
              )}
            </div>
          </>
        )}
      </div>

      {passportMode && status && (
        <PassportMuqeemModal
          mode={passportMode}
          status={status}
          onClose={() => setPassportMode(null)}
          onFinished={(err) => {
            setPassportMode(null);
            afterChange(err);
          }}
        />
      )}
      {reconcileTx && status && (
        <ReconcileMuqeemModal
          tx={reconcileTx}
          status={status}
          onClose={() => setReconcileTx(null)}
          onFinished={(err) => {
            setReconcileTx(null);
            afterChange(err);
          }}
        />
      )}
    </div>
  );
}

function PassportMuqeemModal({ mode, status, onClose, onFinished }: {
  mode: PassportMode;
  status: MuqeemEmployeeStatus;
  onClose: () => void;
  /** null = done (success); an error = show it on the card (after a real attempt). */
  onFinished: (err: MuqeemUiError | null) => void;
}) {
  const e = status.employee;
  const [newNumber, setNewNumber] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [location, setLocation] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<MuqeemUiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const renew = mode === 'RENEW_PASSPORT';

  const submit = async () => {
    if (inFlight.current) return;
    const today = todayKey();
    const v = renew
      ? validatePassportRenew(
          { currentPassportNumber: e.passportNumber, newPassportNumber: newNumber.trim().toUpperCase(), newPassportIssueDate: issueDate, newPassportExpiryDate: expiryDate, newPassportIssueLocation: location },
          today,
        )
      : validatePassportExtend({ currentPassportNumber: e.passportNumber, currentPassportExp: e.passportExp, newPassportExpiryDate: expiryDate }, today);
    setErrors(v);
    if (v.length) return;

    const who = `«${e.name}» (رقم الإقامة ${ltr(e.iqamaNumber)})`;
    const message = renew
      ? `سيتم تحديث بيانات جواز ${who} في منصة مقيم: استبدال الجواز رقم ${ltr(e.passportNumber ?? '')} بالجواز الجديد رقم ${ltr(newNumber.trim().toUpperCase())} الصادر من ${location.trim()} بتاريخ ${formatDateLong(issueDate)} وينتهي في ${formatDateLong(expiryDate)}.`
      : `سيتم تمديد صلاحية جواز ${who} رقم ${ltr(e.passportNumber ?? '')} في منصة مقيم ليصبح تاريخ انتهائه ${formatDateLong(expiryDate)}.`;
    const ok = await confirmDialog(
      `${message}\n\nهذا تحديث فعلي لبيانات المقيم لدى الجوازات بحساب «${status.company?.name ?? ''}»، وقد تترتب عليه رسوم تُحتسب على حساب المنشأة، ولا يمكن التراجع عنه من هذا النظام. تأكد من مطابقة البيانات للجواز.\n\nهل تريد المتابعة؟`,
      { title: renew ? 'تأكيد تحديث بيانات الجواز في مقيم' : 'تأكيد تمديد صلاحية الجواز في مقيم', confirmText: 'نعم، نفّذ في مقيم', cancelText: 'إلغاء', danger: true },
    );
    if (!ok || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setServerError(null);
    const r = await postMuqeem(
      e.id,
      renew
        ? { action: 'RENEW_PASSPORT', expectedPassportNumber: e.passportNumber ?? '', expectedPassportExp: e.passportExp, newPassportNumber: newNumber.trim().toUpperCase(), newPassportIssueDate: issueDate, newPassportExpiryDate: expiryDate, newPassportIssueLocation: location.trim() }
        : { action: 'EXTEND_PASSPORT', expectedPassportNumber: e.passportNumber ?? '', expectedPassportExp: e.passportExp, newPassportExpiryDate: expiryDate },
    );
    inFlight.current = false;
    setSubmitting(false);
    if (r.ok) {
      if (r.data.applied === false || r.data.differentRequest) toast.warning(r.data.message || 'تم التنفيذ في مقيم؛ راجع بيانات الجواز يدوياً');
      else toast.success(r.data.message || 'تم التنفيذ في مقيم');
      onFinished(null);
      return;
    }
    // Validation / rejection: keep the form open to correct; undetermined outcome: close and show it.
    if (r.error.mustReconcile) onFinished(r.error);
    else setServerError(r.error);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="passport-muqeem-title">
      <div className="bg-white rounded-[2rem] p-6 sm:p-8 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200">
        <h3 id="passport-muqeem-title" className="text-xl font-black text-slate-900 mb-1">{renew ? 'تحديث بيانات الجواز (جواز جديد)' : 'تمديد صلاحية الجواز'}</h3>
        <p className="text-[12px] font-bold text-slate-500 mb-5">
          الجواز الحالي: <span dir="ltr">{e.passportNumber || '—'}</span> • ينتهي: {e.passportExp ? formatDateLong(e.passportExp) : 'غير مسجل'}
        </p>
        <div className="space-y-4">
          {renew && (
            <>
              <div>
                <label htmlFor="mq-new-passport" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">رقم الجواز الجديد <span className="text-red-500">*</span></label>
                <input id="mq-new-passport" dir="ltr" value={newNumber} onChange={(ev) => setNewNumber(ev.target.value)} maxLength={15} className={inputCls} placeholder="A12345678" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="mq-issue-date" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">تاريخ الإصدار <span className="text-red-500">*</span></label>
                  <input id="mq-issue-date" type="date" dir="ltr" value={issueDate} max={todayKey()} onChange={(ev) => setIssueDate(ev.target.value)} className={inputCls} />
                </div>
                <div>
                  <label htmlFor="mq-expiry-date" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">تاريخ الانتهاء <span className="text-red-500">*</span></label>
                  <input id="mq-expiry-date" type="date" dir="ltr" value={expiryDate} onChange={(ev) => setExpiryDate(ev.target.value)} className={inputCls} />
                </div>
              </div>
              <div>
                <label htmlFor="mq-issue-location" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">مكان الإصدار <span className="text-red-500">*</span></label>
                <input id="mq-issue-location" value={location} onChange={(ev) => setLocation(ev.target.value)} maxLength={100} className={inputCls} placeholder="مثال: القاهرة" />
              </div>
            </>
          )}
          {!renew && (
            <div>
              <label htmlFor="mq-extend-date" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">تاريخ الانتهاء الجديد <span className="text-red-500">*</span></label>
              <input id="mq-extend-date" type="date" dir="ltr" value={expiryDate} onChange={(ev) => setExpiryDate(ev.target.value)} className={inputCls} />
            </div>
          )}

          {errors.length > 0 && (
            <ul role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-[12px] font-bold space-y-1 list-disc list-inside">
              {errors.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          {serverError && (
            <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-[12px] font-bold leading-relaxed">{serverError.message}</div>
          )}
          <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-[12px] font-bold leading-relaxed">
            يُرسل هذا الطلب إلى منصة مقيم ويغيّر بيانات المقيم لدى الجوازات فعلياً. بعد النجاح تُحدَّث بيانات الجواز في ملف الموظف ويُسجَّل التحديث في أرشيف التجديدات.
          </p>
        </div>
        <div className="flex gap-3 mt-6">
          <button type="button" onClick={onClose} disabled={submitting} className="flex-1 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition disabled:opacity-50">إلغاء</button>
          <button type="button" onClick={submit} disabled={submitting} className="flex-[2] py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl transition disabled:opacity-50 flex items-center justify-center gap-2">
            {submitting ? <><Clock size={16} className="animate-spin" /> جاري التنفيذ في مقيم...</> : <><Landmark size={16} /> تنفيذ في مقيم</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReconcileMuqeemModal({ tx, status, onClose, onFinished }: {
  tx: MuqeemTxView;
  status: MuqeemEmployeeStatus;
  onClose: () => void;
  onFinished: (err: MuqeemUiError | null) => void;
}) {
  const [outcome, setOutcome] = useState<'SUCCEEDED' | 'FAILED' | ''>('');
  const [newIqamaExp, setNewIqamaExp] = useState('');
  const [newPassport, setNewPassport] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const isIqama = tx.operation === 'IQAMA_RENEW';
  const isNewPassport = tx.operation === 'PASSPORT_RENEW';

  const submit = async () => {
    if (inFlight.current) return;
    if (!outcome) return setError('اختر نتيجة العملية كما تحققت منها في مقيم.');
    if (outcome === 'SUCCEEDED' && isIqama && !newIqamaExp) return setError('أدخل تاريخ انتهاء الإقامة الجديد كما يظهر في مقيم.');
    const passportIn = newPassport.trim().toUpperCase();
    if (outcome === 'SUCCEEDED' && isNewPassport) {
      if (!PASSPORT_NUMBER_RE.test(passportIn)) return setError('أدخل رقم الجواز الجديد كما هو مسجل في مقيم (حروف إنجليزية وأرقام حتى 15 خانة).');
      if (tx.newPassportLast4 && !passportIn.endsWith(tx.newPassportLast4)) return setError(`رقم الجواز المُدخل لا يطابق الطلب الأصلي (آخر 4 خانات فيه ${ltr(tx.newPassportLast4)}).`);
    }
    if (note.trim().length < 3) return setError('اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم.');
    setError(null);
    const ok = await confirmDialog(
      outcome === 'SUCCEEDED'
        ? `ستُسجَّل عملية «${tx.operationLabel}» على أنها نُفذت في مقيم${isIqama ? ` وسيُحدَّث تاريخ انتهاء الإقامة إلى ${formatDateLong(newIqamaExp)}` : ' وستُحدَّث بيانات الجواز وفق الطلب الأصلي'}.\n\nلا يُرسل أي طلب إلى مقيم. تأكد أنك تحققت من ذلك في تقرير الخدمات التفاعلية أو بوابة مقيم.`
        : `ستُسجَّل عملية «${tx.operationLabel}» على أنها لم تُنفذ في مقيم، وسيصبح بالإمكان إعادة الطلب (مع احتمال دفع الرسوم عند التنفيذ).\n\nلا يُرسل أي طلب إلى مقيم. تأكد أنها غير موجودة في تقرير الخدمات التفاعلية.`,
      { title: 'تأكيد تسوية عملية مقيم', confirmText: 'تأكيد التسوية', cancelText: 'إلغاء', danger: outcome === 'FAILED' },
    );
    if (!ok || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    const r = await postMuqeem(status.employee.id, {
      action: 'RECONCILE',
      transactionId: tx.id,
      outcome,
      externalRef: externalRef.trim() || null,
      newIqamaExpiryDate: outcome === 'SUCCEEDED' && isIqama ? newIqamaExp : null,
      newPassportNumber: outcome === 'SUCCEEDED' && isNewPassport ? passportIn : null,
      note: note.trim(),
    });
    inFlight.current = false;
    setSubmitting(false);
    if (r.ok) {
      toast.success(r.data.message || 'تمت التسوية');
      onFinished(null);
    } else {
      setError(r.error.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="reconcile-muqeem-title">
      <div className="bg-white rounded-[2rem] p-6 sm:p-8 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200">
        <h3 id="reconcile-muqeem-title" className="text-xl font-black text-slate-900 mb-1">تسوية عملية مقيم</h3>
        <p className="text-[12px] font-bold text-slate-500 mb-4">{tx.operationLabel} • {formatDateTime(tx.createdAt)} • {tx.statusLabel}</p>
        <p className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-[12px] font-bold text-slate-600 leading-relaxed mb-4">
          تحقق أولاً في بوابة مقيم أو تقرير الخدمات التفاعلية هل نُفذت هذه العملية، ثم سجّل النتيجة هنا. التسوية لا ترسل أي طلب إلى مقيم.
        </p>
        <fieldset className="space-y-2 mb-4">
          <legend className="text-[12px] font-extrabold text-slate-700 mb-1.5">النتيجة في مقيم <span className="text-red-500">*</span></legend>
          <label className="flex items-center gap-2 text-[13px] font-bold text-slate-700 cursor-pointer">
            <input type="radio" name="mq-outcome" checked={outcome === 'SUCCEEDED'} onChange={() => setOutcome('SUCCEEDED')} /> نُفذت العملية في مقيم
          </label>
          <label className="flex items-center gap-2 text-[13px] font-bold text-slate-700 cursor-pointer">
            <input type="radio" name="mq-outcome" checked={outcome === 'FAILED'} onChange={() => setOutcome('FAILED')} /> لم تُنفذ العملية في مقيم
          </label>
        </fieldset>
        {outcome === 'SUCCEEDED' && isIqama && (
          <div className="mb-4">
            <label htmlFor="mq-rec-iqama-exp" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">تاريخ انتهاء الإقامة الجديد (من مقيم) <span className="text-red-500">*</span></label>
            <input id="mq-rec-iqama-exp" type="date" dir="ltr" value={newIqamaExp} onChange={(ev) => setNewIqamaExp(ev.target.value)} className={inputCls} />
          </div>
        )}
        {outcome === 'SUCCEEDED' && isNewPassport && (
          <div className="mb-4">
            <label htmlFor="mq-rec-passport" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">
              رقم الجواز الجديد (كما في مقيم){tx.newPassportLast4 ? <> — ينتهي بـ <span dir="ltr">{tx.newPassportLast4}</span></> : null} <span className="text-red-500">*</span>
            </label>
            <input id="mq-rec-passport" dir="ltr" value={newPassport} onChange={(ev) => setNewPassport(ev.target.value)} maxLength={15} className={inputCls} placeholder="A12345678" />
            <p className="mt-1 text-[11px] font-bold text-slate-500">لا يُحفظ رقم الجواز كاملاً في سجل عمليات مقيم، لذا أعد إدخاله لتحديث ملف الموظف.</p>
          </div>
        )}
        {outcome === 'SUCCEEDED' && (
          <div className="mb-4">
            <label htmlFor="mq-rec-ref" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">المرجع في مقيم <span className="text-slate-400 font-bold">(اختياري)</span></label>
            <input id="mq-rec-ref" dir="ltr" value={externalRef} onChange={(ev) => setExternalRef(ev.target.value)} maxLength={100} className={inputCls} />
          </div>
        )}
        <div className="mb-4">
          <label htmlFor="mq-rec-note" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">كيف تحققت من النتيجة؟ <span className="text-red-500">*</span></label>
          <textarea id="mq-rec-note" rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} className={`${inputCls} resize-none`} placeholder="مثال: ظهرت العملية في تقرير الخدمات التفاعلية بتاريخ ..." />
        </div>
        {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-[12px] font-bold mb-4">{error}</div>}
        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={submitting} className="flex-1 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition disabled:opacity-50">إلغاء</button>
          <button type="button" onClick={submit} disabled={submitting} className="flex-[2] py-3.5 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl transition disabled:opacity-50">
            {submitting ? 'جاري الحفظ...' : 'حفظ التسوية'}
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-3">
        <span className="w-9 h-9 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center">{icon}</span>
        <h2 className="font-extrabold text-[15px] text-slate-800">{title}</h2>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, icon, danger }: { label: string; value: string; icon?: React.ReactNode; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50 last:border-0">
      <span className="text-[12px] font-extrabold text-slate-400 uppercase shrink-0">{label}</span>
      <span className={`font-bold text-[13px] flex items-center gap-1.5 text-left ${danger ? 'text-red-500' : 'text-slate-700'}`}>
        {icon}
        {value}
        {danger && <AlertCircle size={13} className="text-red-400" aria-label="قارب على الانتهاء" />}
      </span>
    </div>
  );
}
