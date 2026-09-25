"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Save, Network, Building2, AlertCircle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Link from 'next/link';
import { toast, readApiError } from '@/components/ui/feedback';
import { transliterateArabicToEnglish } from '@/lib/transliterate';

interface CompanyOption {
  id: string;
  nameArabic: string;
}

export default function NewAdministrationPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    nameArabic: '',
    nameEnglish: '',
    companyId: '',
  });

  const loadCompanies = useCallback(async () => {
    setCompaniesError(null);
    try {
      const res = await fetch('/api/companies');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setCompaniesError(await readApiError(res, 'تعذر تحميل قائمة الشركات'));
        return;
      }
      const data: unknown = await res.json();
      setCompanies(Array.isArray(data) ? (data as CompanyOption[]) : []);
    } catch {
      setCompaniesError('تعذر تحميل قائمة الشركات');
    }
  }, [router]);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!formData.nameArabic.trim() || !formData.companyId) {
      toast.warning('يرجى تعبئة جميع الحقول الإلزامية');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/administrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ'));
        return;
      }
      toast.success('تم حفظ الإدارة بنجاح');
      router.push('/administrations');
    } catch {
      toast.error('خطأ في الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-8 max-w-4xl mx-auto space-y-8">
        <Link href="/administrations" className="inline-flex items-center gap-2 text-slate-500 hover:text-indigo-600 transition font-bold text-[14px]">
          <ArrowRight size={18} /> العودة لقائمة الإدارات
        </Link>

        <div>
          <h1 className="text-3xl font-black text-slate-800 flex items-center gap-3">
            <span className="bg-indigo-100 text-indigo-600 p-2.5 rounded-2xl"><Network size={28} /></span>
            إضافة إدارة جديدة
          </h1>
          <p className="text-slate-500 font-bold mt-2 mr-14">قم بتسجيل الإدارة وربطها بالشركة المناسبة</p>
        </div>

        {companiesError && (
          <div role="alert" className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-center gap-3">
            <AlertCircle className="text-red-500 shrink-0" size={20} />
            <p className="text-[13px] font-bold text-red-800 flex-1">{companiesError}</p>
            <button type="button" onClick={loadCompanies} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-red-200 text-red-700 font-bold text-[12px] hover:bg-red-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-white p-8 rounded-[2rem] shadow-sm border border-slate-100 space-y-8">

          <div className="space-y-5">
            <h3 className="font-black text-slate-700 text-lg flex items-center gap-2 border-b pb-4">
              <Building2 size={20} className="text-slate-400" /> البيانات الأساسية للإدارة
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="adm-nameArabic" className="block text-sm font-bold text-slate-700 mb-2">اسم الإدارة (بالعربية) <span className="text-red-500">*</span></label>
                <input
                  id="adm-nameArabic"
                  type="text"
                  required
                  value={formData.nameArabic}
                  onChange={(e) => {
                    const arName = e.target.value;
                    setFormData(prev => ({ ...prev, nameArabic: arName, nameEnglish: transliterateArabicToEnglish(arName) }));
                  }}
                  className="w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 transition"
                  placeholder="مثال: الإدارة المالية"
                />
              </div>

              <div>
                <label htmlFor="adm-nameEnglish" className="block text-sm font-bold text-slate-700 mb-2">اسم الإدارة (بالإنجليزية)</label>
                <input
                  id="adm-nameEnglish"
                  type="text"
                  value={formData.nameEnglish}
                  onChange={(e) => setFormData(prev => ({ ...prev, nameEnglish: e.target.value }))}
                  className="w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 transition"
                  placeholder="مثال: Finance Administration"
                  dir="ltr"
                />
              </div>

              <div className="md:col-span-2">
                <label htmlFor="adm-companyId" className="block text-sm font-bold text-slate-700 mb-2">الشركة التابعة لها <span className="text-red-500">*</span></label>
                <select
                  id="adm-companyId"
                  required
                  value={formData.companyId}
                  onChange={(e) => setFormData(prev => ({ ...prev, companyId: e.target.value }))}
                  className="w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 transition"
                >
                  <option value="">-- اختر الشركة --</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>{c.nameArabic}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t flex justify-end gap-4">
            <Link href="/administrations" className="px-6 py-3 text-slate-600 font-bold hover:bg-slate-50 rounded-xl transition">
              إلغاء
            </Link>
            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition disabled:opacity-70 shadow-lg shadow-indigo-500/30"
            >
              {isSubmitting ? 'جاري الحفظ...' : <><Save size={18} /> حفظ الإدارة</>}
            </button>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
