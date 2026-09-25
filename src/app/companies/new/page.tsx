"use client";

import React, { useState } from 'react';
import { Building2, Save, ChevronRight, AlertCircle, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { CompanyFormFields, EMPTY_COMPANY_FORM, type CompanyFormData } from '../_components/CompanyForm';

export default function NewCompanyPage() {
  const router = useRouter();
  const [formData, setFormData] = useState<CompanyFormData>(EMPTY_COMPANY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'حدث خطأ غير معروف');
        setErrorMsg(msg);
        toast.error(msg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      toast.success('تم إنشاء الشركة بنجاح');
      router.push('/companies');
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
      <div className="absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-blue-50/50 to-transparent pointer-events-none" />

      <div className="max-w-[1240px] mx-auto px-4 sm:px-8 py-8 md:py-12 relative z-10 w-full mb-32">

        {/* Header Area */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-16">
          <div className="space-y-4">
            <Link href="/companies" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition-colors w-max font-bold text-[13px] group">
              <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-blue-200 group-hover:shadow-blue-100 transition-all">
                <ChevronRight size={16} className="-mr-0.5" />
              </span>
              العودة لإدارة الشركات
            </Link>

            <h1 className="text-4xl md:text-[2.75rem] font-black text-slate-900 leading-tight">
              تسجيل كيان قانوني <span className="text-blue-600">جديد</span>
            </h1>
            <p className="text-[15px] font-semibold text-slate-500 max-w-xl leading-relaxed">
              ستضاف هذه الشركة ككيان مستقل داخل مجموعة رديف، مما يسمح لك بربط الموظفين وتعيين فروع وأقسام خاصة بها.
            </p>
          </div>
        </header>

        <div className="flex flex-col lg:flex-row gap-12 lg:gap-20 items-start">

          <div className="flex-1 w-full max-w-3xl space-y-24">

            <form id="company-form" onSubmit={handleSubmit}>

              {/* Error Alert */}
              {errorMsg && (
                <div role="alert" className="mb-10 bg-red-50 border border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                   <AlertCircle className="text-red-500 shrink-0" size={24} />
                   <p className="text-[14px] font-extrabold text-red-800">{errorMsg}</p>
                </div>
              )}

              <CompanyFormFields mode="new" formData={formData} setFormData={setFormData} />
            </form>

          </div>

          {/* Quick Info (Left side because RTL) */}
          <div className="hidden lg:block w-72 shrink-0 sticky top-[100px]">
             <div className="bg-gradient-to-br from-blue-50 to-indigo-50/30 rounded-[2rem] p-7 border border-blue-100/50 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10">
                   <ShieldCheck size={100} />
                </div>
                <div className="relative z-10">
                  <h3 className="font-extrabold text-[14px] text-blue-900 mb-3 flex items-center gap-2">
                     <Building2 size={18} className="text-blue-600" /> كيان مؤسسي مركزي
                  </h3>
                  <p className="text-[12px] font-bold text-blue-800/80 leading-relaxed mb-6">
                    تسجيلك لشركة جديدة يقوم ببناء هيكل قواعد بيانات مستقل لموظفي وفروع ومستندات هذا الكيان بداخل النظام الموحد.
                  </p>

                  <div className="space-y-3 pt-5 border-t border-blue-100/50">
                     <FeatureItem text="فصل محاسبي دقيق" />
                     <FeatureItem text="تنبيهات وثائق مستقلة" />
                     <FeatureItem text="مجموعات أذونات مخصصة" />
                  </div>
                </div>
             </div>
          </div>

        </div>
      </div>

      {/* Floating Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 md:bg-white/80 md:backdrop-blur-xl border-t border-slate-200/60 p-4 md:py-5 md:px-12 flex justify-end items-center z-50">
         <div className="flex items-center gap-4 w-full md:w-auto">
            <Link href="/companies" className="flex-1 md:flex-none px-8 py-4 text-[13.5px] font-black text-slate-600 bg-slate-50 border border-slate-200/80 rounded-[1.25rem] hover:bg-slate-100 hover:text-slate-900 transition-all shadow-sm text-center">
              إلغاء التغييرات
            </Link>
            <button
              form="company-form"
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="flex-1 md:flex-none px-10 py-4 text-[13.5px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-blue-600 disabled:bg-slate-400 disabled:cursor-not-allowed transition-all duration-300 shadow-[0_8px_25px_rgba(0,0,0,0.15)] hover:shadow-[0_10px_35px_rgba(37,99,235,0.3)] flex justify-center items-center gap-2"
            >
              {isSubmitting ? (
                <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Save size={18} />
                  اعتماد وإنشاء الشركة
                </>
              )}
            </button>
         </div>
      </div>
    </DashboardLayout>
  );
}

function FeatureItem({ text }: { text: string }) {
   return (
      <div className="flex items-center gap-2">
         <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
         <span className="text-[11px] font-extrabold text-blue-900 uppercase">{text}</span>
      </div>
   );
}
