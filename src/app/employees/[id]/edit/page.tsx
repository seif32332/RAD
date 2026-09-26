"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw, Save } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { daysBetween, riyadhDateKey, toDateInputValue } from '@/lib/dates';
import { SAUDI_BANKS } from '@/lib/banks';
import {
  EMPTY_EMPLOYEE_FORM,
  EmployeeFormFields,
  EmployeeFormSaveBar,
  EmployeeFormSideNav,
  FormAlert,
  buildEmployeePayload,
  defaultCountsTowardGosi,
  toastSaveWarnings,
  normalizeGenderValue,
  normalizeNationalityValue,
  useActiveSegment,
  useBranchSchedules,
  useEmployeeFormReferences,
  type AllowanceDraft,
  type EmployeeFormData,
} from '../../_components/EmployeeForm';
import DataReviewBanner from '../../_components/DataReviewBanner';

const FORM_ID = 'employee-edit-form';

interface EmployeeDetail {
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  firstNameEnglish?: string | null;
  lastNameEnglish?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  maritalStatus?: string | null;
  gender?: string | null;
  iqamaOrIdNumber?: string | null;
  iqamaOrIdExp?: string | null;
  passportNumber?: string | null;
  passportExp?: string | null;
  healthCertificateNum?: string | null;
  healthCertificateExp?: string | null;
  joinDate?: string | null;
  leaveAccrualStartDate?: string | null;
  contractType?: string | null;
  contractEndDate?: string | null;
  probationEndDate?: string | null;
  noticePeriodDays?: number | null;
  mobileNumber?: string | null;
  email?: string | null;
  ibanNumber?: string | null;
  bankName?: string | null;
  salaryPaymentMethod?: string | null;
  legalCompanyId?: string | null;
  actualCompanyId?: string | null;
  administrationId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  jobTitle?: string | null;
  directManagerId?: string | null;
  workSchedule?: string | null;
  accommodationType?: string | null;
  basicSalary?: number | null;
  gosiDeduction?: number | null;
  iqamaCopyUrl?: string | null;
  passportCopyUrl?: string | null;
  healthCertificateUrl?: string | null;
  workContractUrl?: string | null;
  allowances?: { id?: string; name: string; amount: number; isMonthly?: boolean | null; countsTowardGosi?: boolean | null; allowanceType?: string | null }[];
  gosiRegime?: string | null;
  gosiRegistrationSource?: string | null;
  gosiNumber?: string | null;
  idType?: string | null;
  dataReviewNote?: string | null;
  occupationName?: string | null;
  occupationCode?: string | null;
  dependentsCount?: number | null;
  dependentsFeePaidBy?: string | null;
  medicalInsuranceClass?: string | null;
  isDisabled?: boolean | null;
  muawamaCertExpiry?: string | null;
  isStudent?: boolean | null;
  partTimeWeeklyHours?: number | null;
  qiwaContractDocumented?: boolean | null;
  qiwaContractDocumentedAt?: string | null;
}

function toFormData(emp: EmployeeDetail): EmployeeFormData {
  const matchedBank = SAUDI_BANKS.find((bank) => bank.value === emp.bankName);
  return {
    fullNameArabic: [emp.firstNameArabic, emp.lastNameArabic].filter(Boolean).join(' ').trim(),
    fullNameEnglish: [emp.firstNameEnglish, emp.lastNameEnglish].filter(Boolean).join(' ').trim(),
    nationality: normalizeNationalityValue(emp.nationality),
    dateOfBirth: toDateInputValue(emp.dateOfBirth),
    maritalStatus: emp.maritalStatus || '',
    gender: normalizeGenderValue(emp.gender),
    iqamaOrIdNumber: emp.iqamaOrIdNumber || '',
    iqamaOrIdExp: toDateInputValue(emp.iqamaOrIdExp),
    passportNumber: emp.passportNumber || '',
    passportExp: toDateInputValue(emp.passportExp),
    healthCertificateNum: emp.healthCertificateNum || '',
    healthCertificateExp: toDateInputValue(emp.healthCertificateExp),
    joinDate: toDateInputValue(emp.joinDate),
    leaveAccrualStartDate: toDateInputValue(emp.leaveAccrualStartDate),
    contractType: emp.contractType || 'FULL_TIME',
    contractEndDate: toDateInputValue(emp.contractEndDate),
    probationDays: emp.probationEndDate && emp.joinDate ? String(daysBetween(emp.joinDate, emp.probationEndDate)) : EMPTY_EMPLOYEE_FORM.probationDays,
    noticePeriodDays: emp.noticePeriodDays != null ? String(emp.noticePeriodDays) : '30',
    mobileNumber: emp.mobileNumber || '',
    email: emp.email || '',
    ibanNumber: emp.ibanNumber || '',
    bankName: emp.bankName || '',
    bankCode: matchedBank?.code || '',
    salaryPaymentMethod: emp.salaryPaymentMethod || 'BANK_TRANSFER',
    legalCompanyId: emp.legalCompanyId || '',
    actualCompanyId: emp.actualCompanyId || '',
    administrationId: emp.administrationId || '',
    branchId: emp.branchId || '',
    departmentId: emp.departmentId || '',
    jobTitle: emp.jobTitle || '',
    directManagerId: emp.directManagerId || '',
    workSchedule: emp.workSchedule || '',
    accommodationType: emp.accommodationType || '',
    basicSalary: emp.basicSalary != null ? String(emp.basicSalary) : '',
    gosiDeduction: emp.gosiDeduction != null ? String(emp.gosiDeduction) : '0',
    idDocUrl: emp.iqamaCopyUrl || '',
    passportDocUrl: emp.passportCopyUrl || '',
    healthCertDocUrl: emp.healthCertificateUrl || '',
    contractDocUrl: emp.workContractUrl || '',
    gosiRegime: emp.gosiRegime || 'UNKNOWN',
    gosiRegistrationSource: emp.gosiRegistrationSource || '',
    gosiNumber: emp.gosiNumber || '',
    idType: emp.idType || '',
    occupationName: emp.occupationName || '',
    occupationCode: emp.occupationCode || '',
    dependentsCount: emp.dependentsCount != null ? String(emp.dependentsCount) : '',
    dependentsFeePaidBy: emp.dependentsFeePaidBy || '',
    medicalInsuranceClass: emp.medicalInsuranceClass || '',
    isDisabled: emp.isDisabled === true,
    muawamaCertExpiry: toDateInputValue(emp.muawamaCertExpiry),
    isStudent: emp.isStudent === true,
    partTimeWeeklyHours: emp.partTimeWeeklyHours != null ? String(emp.partTimeWeeklyHours) : '',
    qiwaContractDocumented: emp.qiwaContractDocumented === true,
    // Riyadh calendar day of the stored timestamp (auto-set to "now" by the server).
    qiwaContractDocumentedAt: emp.qiwaContractDocumentedAt ? (riyadhDateKey(emp.qiwaContractDocumentedAt) ?? '') : '',
  };
}

export default function EditEmployeePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState<EmployeeFormData>(EMPTY_EMPLOYEE_FORM);
  const [allowances, setAllowances] = useState<AllowanceDraft[]>([]);
  const [isGosiEnabled, setIsGosiEnabled] = useState(false);
  const [dataReviewNote, setDataReviewNote] = useState<string | null>(null);

  const activeSegment = useActiveSegment(!isFetching && !loadError);
  const { refs, refsError, reloadRefs, ensureNationality } = useEmployeeFormReferences();
  const { branchSchedules, loadBranchSchedules } = useBranchSchedules();

  const loadEmployee = useCallback(async () => {
    setIsFetching(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'حدث خطأ أثناء تحميل بيانات الموظف.'));
        return;
      }
      const emp = (await res.json()) as EmployeeDetail;
      const data = toFormData(emp);
      setFormData(data);
      setDataReviewNote(emp.dataReviewNote ?? null);
      ensureNationality(data.nationality);
      setIsGosiEnabled((emp.gosiDeduction ?? 0) > 0);
      // One-off bonuses (isMonthly=false) are managed by payroll, not by this form.
      setAllowances(
        (emp.allowances ?? [])
          .filter((a) => a.isMonthly !== false)
          .map((a) => ({
            id: a.id || crypto.randomUUID(),
            name: a.name,
            amount: String(a.amount ?? ''),
            countsTowardGosi: typeof a.countsTowardGosi === 'boolean' ? a.countsTowardGosi : defaultCountsTowardGosi(a.name),
            allowanceType: a.allowanceType || '',
          })),
      );
      if (emp.branchId) loadBranchSchedules(emp.branchId);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsFetching(false);
    }
  }, [id, router, ensureNationality, loadBranchSchedules]);

  useEffect(() => {
    loadEmployee();
  }, [loadEmployee]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEmployeePayload(formData, allowances, isGosiEnabled)),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ التعديلات');
        setErrorMsg(msg);
        toast.error(msg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      toast.success('تم حفظ التعديلات بنجاح!');
      const saved = (await res.json().catch(() => null)) as { employee?: { dataReviewNote?: string | null } } | null;
      toastSaveWarnings(saved);
      if (saved?.employee?.dataReviewNote) toast.warning('لا تزال هناك بيانات ناقصة في ملف الموظف يجب استكمالها');
      router.push(`/employees/${id}`);
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isFetching || loadError) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-full min-h-screen">
          {isFetching ? (
            <div className="w-12 h-12 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" aria-label="جاري التحميل" />
          ) : (
            <div className="text-center bg-white rounded-[2rem] p-10 border border-rose-100 shadow-sm max-w-md">
              <AlertTriangle size={40} className="text-rose-500 mx-auto mb-4" />
              <p className="text-slate-800 font-black text-[15px] mb-2">تعذر تحميل بيانات الموظف</p>
              <p className="text-slate-500 font-bold text-[13px] mb-6">{loadError}</p>
              <div className="flex items-center justify-center gap-3">
                <button type="button" onClick={loadEmployee} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[13px] transition-colors">
                  <RefreshCw size={16} /> إعادة المحاولة
                </button>
                <Link href="/employees" className="px-5 py-2.5 rounded-xl font-bold text-[13px] text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors">
                  قائمة الموظفين
                </Link>
              </div>
            </div>
          )}
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="flex bg-slate-50/50 min-h-screen">

        {/* RIGHT SIDE: Navigation Mapping Menu */}
        <EmployeeFormSideNav
          activeSegment={activeSegment}
          backHref={`/employees/${id}`}
          backLabel="العودة لملف الموظف"
          title={<>تعديل بيانات<br />الموظف الحالي</>}
        />

        {/* LEFT SIDE: Form Application */}
        <div className="flex-1 max-w-[1000px] px-6 lg:px-14 py-12 pb-32">

          <div className="mb-14">
            <span className="text-[11px] font-black uppercase text-slate-400 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm mb-4 inline-block">تعديل ملف نشط</span>
            <h1 className="text-4xl font-black text-slate-900 flex items-center gap-3">
              تحديث سجل كادر بشري
            </h1>
            <p className="font-semibold text-slate-500 mt-3 text-[15px] leading-relaxed max-w-xl">
              قم بالمرور على الأقسام وتعديل الصلاحيات أو البيانات المطلوبة. سيتم الحفظ مباشرة في قاعدة البيانات.
            </p>
          </div>

          {dataReviewNote && (
            <div className="mb-8">
              <DataReviewBanner note={dataReviewNote} employeeId={id} canClear onCleared={() => setDataReviewNote(null)} />
              <p className="text-[12px] font-bold text-slate-500 mt-2">عند حفظ الحقول المذكورة بقيم صحيحة يُزال التنبيه تلقائياً.</p>
            </div>
          )}
          {refsError && <FormAlert message={`تعذر تحميل القوائم المرجعية: ${refsError}`} onRetry={reloadRefs} />}
          {errorMsg && <FormAlert message={errorMsg} />}

          <form id={FORM_ID} onSubmit={handleSubmit}>
            <EmployeeFormFields
              formData={formData}
              setFormData={setFormData}
              allowances={allowances}
              setAllowances={setAllowances}
              isGosiEnabled={isGosiEnabled}
              setIsGosiEnabled={setIsGosiEnabled}
              refs={refs}
              ensureNationality={ensureNationality}
              branchSchedules={branchSchedules}
              loadBranchSchedules={loadBranchSchedules}
              currentEmployeeId={id}
            />
          </form>
        </div>

        {/* Global Save Action Bar */}
        <EmployeeFormSaveBar cancelHref={`/employees/${id}`} formId={FORM_ID} isSubmitting={isSubmitting}>
          <>حفظ وتحديث التغييرات <Save size={18} /></>
        </EmployeeFormSaveBar>

      </div>
    </DashboardLayout>
  );
}
