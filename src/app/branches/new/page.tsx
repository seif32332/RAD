"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Save, AlertCircle, GitBranch } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import {
  BranchFormFields,
  EMPTY_BRANCH_FORM,
  buildBranchPayload,
  buildSchedulesPayload,
  type BranchFormData,
  type NamedOption,
  type RentContractDraft,
  type ScheduleDraft,
} from '../_components/BranchForm';

export default function NewBranchPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<NamedOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState<BranchFormData>(EMPTY_BRANCH_FORM);
  const [schedules, setSchedules] = useState<ScheduleDraft[]>([]);
  const [rentContracts, setRentContracts] = useState<RentContractDraft[]>([]);

  const loadCompanies = useCallback(async () => {
    try {
      const res = await fetch('/api/companies');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setErrorMsg(await readApiError(res, 'تعذر تحميل قائمة الشركات'));
        return;
      }
      const d: unknown = await res.json();
      setCompanies(Array.isArray(d) ? (d as NamedOption[]) : []);
    } catch {
      setErrorMsg('تعذر تحميل قائمة الشركات');
    }
  }, [router]);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBranchPayload(formData, rentContracts)),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ الفرع');
        setErrorMsg(msg);
        toast.error(msg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const data = (await res.json()) as { id?: string; branch?: { id: string } };
      const branchId = data.id ?? data.branch?.id;

      // Save the work schedules of the new branch in one atomic request.
      const schedulesBody = branchId ? buildSchedulesPayload(branchId, schedules) : null;
      if (branchId && schedulesBody && schedulesBody.schedules.length > 0) {
        const sRes = await fetch('/api/work-schedules', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(schedulesBody),
        });
        if (!sRes.ok) {
          toast.warning(`تم حفظ الفرع لكن تعذر حفظ جداول العمل: ${await readApiError(sRes)}`);
          router.push(`/branches/${branchId}/edit`);
          return;
        }
      }

      toast.success('تم إنشاء الفرع بنجاح');
      router.push('/branches');
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 mb-32 space-y-8">

        {/* Header */}
        <div>
          <Link href="/branches" className="inline-flex items-center gap-2 text-slate-400 hover:text-violet-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-violet-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لقائمة الفروع
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-violet-100 text-violet-600 p-3 rounded-2xl"><GitBranch size={26} /></span>
            إضافة فرع جديد
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">أدخل بيانات الفرع وتراخيصه وعقوده</p>
        </div>

        {errorMsg && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px]">{errorMsg}</p>
          </div>
        )}

        <form id="branch-form" onSubmit={handleSubmit} className="space-y-8">
          <BranchFormFields
            formData={formData}
            setFormData={setFormData}
            companies={companies}
            rentContracts={rentContracts}
            setRentContracts={setRentContracts}
            schedules={schedules}
            setSchedules={setSchedules}
          />
        </form>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/branches" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء
        </Link>
        <button type="submit" form="branch-form" disabled={isSubmitting} aria-busy={isSubmitting}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-0.5 shadow-lg flex items-center gap-2">
          {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isSubmitting ? 'جاري الحفظ...' : 'حفظ الفرع'}
        </button>
      </div>
    </DashboardLayout>
  );
}
