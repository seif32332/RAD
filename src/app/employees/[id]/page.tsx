"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronRight, Pencil, Ban, Phone, Mail, Building2, Briefcase, Calendar, CreditCard,
  ShieldCheck, FileText, CheckCircle2, AlertCircle, UserCheck, ShieldAlert, Clock, Upload, ExternalLink, RefreshCw, Calculator
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate as formatDateLong, todayKey, dateKey } from '@/lib/dates';
import { formatMoney, sumMoney } from '@/lib/money';
import { LOAN_DEDUCTIBLE_STATUSES, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { GOSI_REGIME_LABELS, isSaudiNationalityValue, parseGosiRegime } from '@/lib/employee-shared';
import { ID_TYPE_LABELS, parseIdType } from '@/lib/identity';
import { useRole } from '@/context/RoleContext';
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
}

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
  const [emp, setEmp] = useState<EmployeeProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showTerminateModal, setShowTerminateModal] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [terminateReason, setTerminateReason] = useState('');
  const [protectedLeaveMsg, setProtectedLeaveMsg] = useState<string | null>(null);
  const [overrideProtectedLeave, setOverrideProtectedLeave] = useState(false);
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
  };

  const handleTerminate = async () => {
    if (isTerminating) return;
    if (terminateReason.trim().length < 3) {
      toast.warning('اكتب سبب إنهاء الخدمات، فهو يُحفظ في سجل التدقيق');
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

        </div>

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
              <label htmlFor="terminate-reason" className="block text-[12px] font-extrabold text-slate-700 mb-1.5">
                سبب الإنهاء <span className="text-red-500">*</span>
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
                    disabled={isTerminating || terminateReason.trim().length < 3 || (!!protectedLeaveMsg && !overrideProtectedLeave)}
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
