"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import {
  EMPTY_EMPLOYEE_FORM,
  EmployeeFormFields,
  EmployeeFormSaveBar,
  EmployeeFormSideNav,
  FormAlert,
  buildEmployeePayload,
  toastSaveWarnings,
  useActiveSegment,
  useBranchSchedules,
  useEmployeeFormReferences,
  type AllowanceDraft,
  type EmployeeFormData,
} from '../_components/EmployeeForm';

const FORM_ID = 'employee-form';

export default function NewEmployeePage() {
  const router = useRouter();
  const activeSegment = useActiveSegment();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState<EmployeeFormData>(EMPTY_EMPLOYEE_FORM);
  const [allowances, setAllowances] = useState<AllowanceDraft[]>([]);
  const [isGosiEnabled, setIsGosiEnabled] = useState(false);

  const { refs, refsError, reloadRefs, ensureNationality } = useEmployeeFormReferences();
  const { branchSchedules, loadBranchSchedules } = useBranchSchedules();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEmployeePayload(formData, allowances, isGosiEnabled)),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ الموظف');
        setErrorMsg(msg);
        toast.error(msg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      toast.success('تم إضافة الموظف بنجاح');
      toastSaveWarnings(await res.json().catch(() => null));
      router.push('/employees');
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="flex bg-slate-50/50 min-h-screen">

        {/* RIGHT SIDE: Navigation Mapping Menu */}
        <EmployeeFormSideNav
          activeSegment={activeSegment}
          backHref="/employees"
          backLabel="العودة لأرشيف الموظفين"
          title={<>استمارة<br />التعريف بالموظف</>}
        />

        {/* LEFT SIDE: Form Application */}
        <div className="flex-1 max-w-[1000px] px-6 lg:px-14 py-12 pb-32">

          <div className="mb-14">
            <span className="text-[11px] font-black uppercase text-slate-400 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm mb-4 inline-block">نموذج الإدخال الموحد</span>
            <h1 className="text-4xl font-black text-slate-900 flex items-center gap-3">
              تسجيل موظف جديد
            </h1>
            <p className="font-semibold text-slate-500 mt-3 text-[15px] leading-relaxed max-w-xl">
              يتم إنشاء الرقم الوظيفي <span className="text-blue-600 font-bold">تلقائياً</span>. تاريخ العودة والزيادات سيتم جدولته آلياً بمجرد الحفظ.
            </p>
          </div>

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
            />
          </form>
        </div>

        {/* Global Save Action Bar */}
        <EmployeeFormSaveBar cancelHref="/employees" formId={FORM_ID} isSubmitting={isSubmitting}>
          <>حفظ الموظف <UserPlus size={18} /></>
        </EmployeeFormSaveBar>

      </div>
    </DashboardLayout>
  );
}
