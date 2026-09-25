"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ChevronRight, Save, AlertCircle, GitBranch, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import {
  BranchFormFields,
  EMPTY_BRANCH_FORM,
  branchToForm,
  buildBranchPayload,
  buildSchedulesPayload,
  type BranchFormData,
  type BranchResponse,
  type NamedOption,
  type RentContractDraft,
  type ScheduleDraft,
} from '../../_components/BranchForm';

export default function EditBranchPage() {
  const router = useRouter();
  const { branchId } = useParams<{ branchId: string }>();

  const [companies, setCompanies] = useState<NamedOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState<BranchFormData>(EMPTY_BRANCH_FORM);
  const [schedules, setSchedules] = useState<ScheduleDraft[]>([]);
  const [rentContracts, setRentContracts] = useState<RentContractDraft[]>([]);

  const load = useCallback(async () => {
    setIsFetching(true);
    setLoadError(null);
    try {
      const [cRes, bRes] = await Promise.all([fetch('/api/companies'), fetch(`/api/branches/${encodeURIComponent(branchId)}`, { cache: 'no-store' })]);
      if (bRes.status === 401) {
        router.replace('/login');
        return;
      }
      if (!bRes.ok) {
        setLoadError(bRes.status === 404 ? 'الفرع غير موجود' : await readApiError(bRes, 'تعذر تحميل بيانات الفرع'));
        return;
      }
      if (cRes.ok) {
        const c: unknown = await cRes.json();
        setCompanies(Array.isArray(c) ? (c as NamedOption[]) : []);
      }
      const mapped = branchToForm((await bRes.json()) as BranchResponse);
      setFormData(mapped.formData);
      setRentContracts(mapped.rentContracts);
      setSchedules(mapped.schedules);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsFetching(false);
    }
  }, [branchId, router]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/branches/${encodeURIComponent(branchId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBranchPayload(formData, rentContracts)),
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

      // Replace the branch schedules atomically (no data loss if one schedule is invalid).
      const sRes = await fetch('/api/work-schedules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSchedulesPayload(branchId, schedules)),
      });
      if (!sRes.ok) {
        const msg = `تم حفظ بيانات الفرع لكن تعذر حفظ جداول العمل: ${await readApiError(sRes)}`;
        setErrorMsg(msg);
        toast.warning(msg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      toast.success('تم تحديث بيانات الفرع');
      router.push('/branches');
      router.refresh();
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isFetching) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96">
          <div className="w-12 h-12 rounded-full border-4 border-violet-100 border-t-violet-600 animate-spin" aria-label="جاري التحميل" />
        </div>
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <AlertCircle size={48} className="text-red-400" />
          <h2 className="text-xl font-bold text-slate-800">{loadError}</h2>
          <div className="flex items-center gap-3 mt-4">
            <button type="button" onClick={load} className="inline-flex items-center gap-2 px-6 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-bold text-sm transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
            <Link href="/branches" className="px-6 py-2 bg-slate-100 text-slate-600 rounded-xl font-bold text-sm">العودة للفروع</Link>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 mb-32 space-y-8">
        <div>
          <Link href="/branches" className="inline-flex items-center gap-2 text-slate-400 hover:text-violet-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-violet-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لقائمة الفروع
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-amber-100 text-amber-600 p-3 rounded-2xl"><GitBranch size={26} /></span>
            تعديل بيانات الفرع
          </h1>
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

      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/branches" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء
        </Link>
        <button type="submit" form="branch-form" disabled={isSubmitting} aria-busy={isSubmitting}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-amber-600 rounded-[1.25rem] hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-0.5 shadow-lg flex items-center gap-2">
          {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isSubmitting ? 'جاري الحفظ...' : 'تحديث بيانات الفرع'}
        </button>
      </div>
    </DashboardLayout>
  );
}
