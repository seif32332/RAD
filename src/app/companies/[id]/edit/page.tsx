"use client";

import React, { useState, useEffect, useCallback, use } from 'react';
import { Building2, Save, ChevronRight, AlertCircle, ShieldCheck, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { toDateInputValue } from '@/lib/dates';
import { CompanyFormFields, EMPTY_COMPANY_FORM, type CompanyFormData } from '../../_components/CompanyForm';

type CompanyResponse = Partial<Record<keyof CompanyFormData, string | null>>;

export default function EditCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [formData, setFormData] = useState<CompanyFormData>(EMPTY_COMPANY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsFetching(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'فشل في جلب بيانات الشركة'));
        return;
      }
      const data = (await res.json()) as CompanyResponse;
      const text = (k: keyof CompanyFormData) => data[k] || '';
      setFormData({
        nameArabic: text('nameArabic'),
        nameEnglish: text('nameEnglish'),
        unifiedNumber: text('unifiedNumber'),
        commercialRegNum: text('commercialRegNum'),
        commercialRegUrl: text('commercialRegUrl'),
        commercialRegDate: toDateInputValue(data.commercialRegDate),
        commercialRegExp: toDateInputValue(data.commercialRegExp),
        taxNumber: text('taxNumber'),
        molEstablishmentNumber: text('molEstablishmentNumber'),
        gosiEstablishmentNumber: text('gosiEstablishmentNumber'),
        taxCertificateUrl: text('taxCertificateUrl'),
        nationalAddress: text('nationalAddress'),
        nationalAddressUrl: text('nationalAddressUrl'),
        establishmentDeedUrl: text('establishmentDeedUrl'),
        trademarkNumber: text('trademarkNumber'),
        trademarkRegDate: toDateInputValue(data.trademarkRegDate),
        trademarkExpDate: toDateInputValue(data.trademarkExpDate),
        trademarkCertUrl: text('trademarkCertUrl'),
      });
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsFetching(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'حدث خطأ');
        setErrorMsg(msg);
        toast.error(msg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      toast.success('تم تحديث بيانات الشركة بنجاح');
      router.push('/companies');
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
        <div className="flex items-center justify-center h-96 gap-4">
          <div className="w-8 h-8 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" />
          <p className="text-slate-500 font-bold">جاري جلب بيانات الشركة...</p>
        </div>
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <AlertCircle size={48} className="text-rose-300" />
          <p className="text-slate-600 font-bold">{loadError}</p>
          <div className="flex items-center gap-4">
            <button type="button" onClick={load} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
            <Link href="/companies" className="text-blue-600 font-bold text-sm hover:underline">العودة لقائمة الشركات</Link>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-amber-50/50 to-transparent pointer-events-none" />

      <div className="max-w-[1240px] mx-auto px-4 sm:px-8 py-8 md:py-12 relative z-10 w-full mb-32">

        <header className="flex flex-col gap-6 mb-16">
          <div className="space-y-4">
            <Link href="/companies" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition-colors w-max font-bold text-[13px] group">
              <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-blue-200 group-hover:shadow-blue-100 transition-all">
                <ChevronRight size={16} className="-mr-0.5" />
              </span>
              العودة لإدارة الشركات
            </Link>

            <h1 className="text-4xl md:text-[2.75rem] font-black text-slate-900 leading-tight">
              تعديل بيانات <span className="text-amber-600">{formData.nameArabic}</span>
            </h1>
          </div>
        </header>

        <div className="flex flex-col lg:flex-row gap-12 lg:gap-20 items-start">
          <div className="flex-1 w-full max-w-3xl space-y-24">
            <form id="company-form" onSubmit={handleSubmit}>

              {errorMsg && (
                <div role="alert" className="mb-10 bg-red-50 border border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4 shadow-sm">
                   <AlertCircle className="text-red-500 shrink-0" size={24} />
                   <p className="text-[14px] font-extrabold text-red-800">{errorMsg}</p>
                </div>
              )}

              <CompanyFormFields mode="edit" formData={formData} setFormData={setFormData} />
            </form>
          </div>

          <div className="hidden lg:block w-72 shrink-0 sticky top-[100px]">
             <div className="bg-gradient-to-br from-amber-50 to-orange-50/30 rounded-[2rem] p-7 border border-amber-100/50 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10">
                   <ShieldCheck size={100} />
                </div>
                <div className="relative z-10">
                  <h3 className="font-extrabold text-[14px] text-amber-900 mb-3 flex items-center gap-2">
                     <Building2 size={18} className="text-amber-600" /> تعديل بيانات الكيان
                  </h3>
                  <p className="text-[12px] font-bold text-amber-800/80 leading-relaxed">
                    تعديل بيانات هذا الكيان القانوني سينعكس على جميع الموظفين والفروع المرتبطة به.
                  </p>
                </div>
             </div>
          </div>
        </div>
      </div>

      {/* Floating Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 md:bg-white/80 md:backdrop-blur-xl border-t border-slate-200/60 p-4 md:py-5 md:px-12 flex justify-end items-center z-50">
         <div className="flex items-center gap-4 w-full md:w-auto">
            <Link href="/companies" className="flex-1 md:flex-none px-8 py-4 text-[13.5px] font-black text-slate-600 bg-slate-50 border border-slate-200/80 rounded-[1.25rem] hover:bg-slate-100 transition-all shadow-sm text-center">
              إلغاء
            </Link>
            <button form="company-form" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}
              className="flex-1 md:flex-none px-10 py-4 text-[13.5px] font-black text-white bg-amber-600 rounded-[1.25rem] hover:bg-amber-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-all shadow-lg flex justify-center items-center gap-2">
              {isSubmitting ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Save size={18} />
                  حفظ التعديلات
                </>
              )}
            </button>
         </div>
      </div>
    </DashboardLayout>
  );
}
