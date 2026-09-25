"use client";

// Shared page body for "new department" and "edit department" (private folder: not routed).

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Save, AlertCircle, Layers, GitBranch, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { transliterateArabicToEnglish } from '@/lib/transliterate';

interface BranchOption {
  id: string;
  nameArabic: string;
  company?: { nameArabic: string } | null;
}

interface DepartmentFormData {
  branchId: string;
  nameArabic: string;
  nameEnglish: string;
}

interface DepartmentResponse {
  branchId?: string | null;
  nameArabic?: string | null;
  nameEnglish?: string | null;
}

const INPUT_CLASS =
  'px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-amber-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-amber-100 transition-all hover:bg-slate-100';

export function DepartmentFormPage({ mode, id }: { mode: 'new' | 'edit'; id?: string }) {
  const router = useRouter();
  const isEdit = mode === 'edit';
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [formData, setFormData] = useState<DepartmentFormData>({ branchId: '', nameArabic: '', nameEnglish: '' });
  /** Last English name produced by the transliteration helper (so manual edits are not overwritten). */
  const [autoEnglish, setAutoEnglish] = useState('');

  const load = useCallback(async () => {
    if (isEdit && !id) return;
    setIsFetching(true);
    setLoadError(null);
    try {
      const [bRes, dRes] = await Promise.all([
        fetch('/api/branches'),
        isEdit && id ? fetch(`/api/departments/${encodeURIComponent(id)}`, { cache: 'no-store' }) : Promise.resolve(null),
      ]);
      if (bRes.status === 401 || dRes?.status === 401) {
        router.replace('/login');
        return;
      }
      if (!bRes.ok) {
        setLoadError(await readApiError(bRes, 'تعذر تحميل قائمة الفروع'));
        return;
      }
      const b: unknown = await bRes.json();
      setBranches(Array.isArray(b) ? (b as BranchOption[]) : []);
      if (dRes) {
        if (!dRes.ok) {
          setLoadError(dRes.status === 404 ? 'القسم غير موجود' : await readApiError(dRes, 'تعذر تحميل بيانات القسم'));
          return;
        }
        const dept = (await dRes.json()) as DepartmentResponse;
        setFormData({ branchId: dept.branchId || '', nameArabic: dept.nameArabic || '', nameEnglish: dept.nameEnglish || '' });
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsFetching(false);
    }
  }, [id, isEdit, router]);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // Local transliteration (no third-party translation service): fills the English name
  // unless the user typed their own.
  const handleArabicNameBlur = () => {
    const ar = formData.nameArabic.trim();
    if (!ar) return;
    if (formData.nameEnglish && formData.nameEnglish !== autoEnglish) return;
    const en = transliterateArabicToEnglish(ar);
    setAutoEnglish(en);
    setFormData((prev) => ({ ...prev, nameEnglish: en }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(isEdit ? `/api/departments/${encodeURIComponent(id ?? '')}` : '/api/departments', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, isEdit ? 'فشل التعديل' : 'تعذر حفظ القسم');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      toast.success(isEdit ? 'تم تحديث القسم' : 'تم إنشاء القسم بنجاح');
      router.push('/departments');
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
      <div className="max-w-2xl mx-auto px-4 sm:px-8 py-8 mb-32 space-y-8">

        <div>
          <Link href="/departments" className="inline-flex items-center gap-2 text-slate-400 hover:text-amber-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-amber-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لقائمة الأقسام
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-amber-100 text-amber-600 p-3 rounded-2xl"><Layers size={26} /></span>
            {isEdit ? 'تعديل بيانات القسم' : 'إضافة قسم جديد'}
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">{isEdit ? 'قم بتعديل بيانات القسم وارتباطاته' : 'قم بإنشاء قسم وظيفي وربطه بالفرع المناسب'}</p>
        </div>

        {loadError && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px] flex-1">{loadError}</p>
            <button type="button" onClick={load} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-red-200 text-red-700 font-black text-[12px] hover:bg-red-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {errorMsg && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px]">{errorMsg}</p>
          </div>
        )}

        <form id="dept-form" onSubmit={handleSubmit} aria-busy={isFetching}>
          <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-hidden">
            <div className="px-8 py-5 border-b border-slate-100 flex items-center gap-3">
              <span className="w-9 h-9 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center">
                <GitBranch size={16} className="text-amber-500" />
              </span>
              <h2 className="font-extrabold text-[15px] text-slate-800">بيانات القسم</h2>
              {isFetching && <span className="w-4 h-4 rounded-full border-2 border-amber-100 border-t-amber-500 animate-spin mr-auto" aria-label="جاري التحميل" />}
            </div>
            <div className="p-8 space-y-8">

              {/* Branch selector */}
              <div className="flex flex-col gap-2 group">
                <label htmlFor="dept-branchId" className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-amber-600 transition-colors">
                  الفرع التابع له <span className="text-red-500">*</span>
                </label>
                <select id="dept-branchId" name="branchId" value={formData.branchId} onChange={handleChange} required disabled={isFetching}
                  className={`${INPUT_CLASS} appearance-none cursor-pointer disabled:opacity-60`}>
                  <option value="">— اختر الفرع —</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.nameArabic}{b.company?.nameArabic ? ` (${b.company.nameArabic})` : ''}</option>
                  ))}
                </select>
              </div>

              {/* Arabic Name */}
              <div className="flex flex-col gap-2 group">
                <label htmlFor="dept-nameArabic" className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-amber-600 transition-colors">
                  اسم القسم بالعربية <span className="text-red-500">*</span>
                </label>
                <input id="dept-nameArabic" type="text" name="nameArabic" value={formData.nameArabic} onChange={handleChange} onBlur={handleArabicNameBlur} required
                  placeholder="مثال: قسم الموارد البشرية" className={INPUT_CLASS} />
              </div>

              {/* English Name */}
              <div className="flex flex-col gap-2 group">
                <label htmlFor="dept-nameEnglish" className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-amber-600 transition-colors">
                  اسم القسم بالإنجليزية (مترجم آلياً)
                </label>
                <input id="dept-nameEnglish" type="text" name="nameEnglish" value={formData.nameEnglish} onChange={handleChange} dir="ltr"
                  placeholder="مثال: Human Resources" className={INPUT_CLASS} />
              </div>

            </div>
          </div>
        </form>
      </div>

      {/* Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/departments" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء
        </Link>
        <button type="submit" form="dept-form" disabled={isSubmitting || isFetching || (isEdit && !!loadError)} aria-busy={isSubmitting}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-0.5 shadow-lg flex items-center gap-2">
          {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isSubmitting ? (isEdit ? 'جاري التحديث...' : 'جاري الحفظ...') : (isEdit ? 'تحديث القسم' : 'حفظ القسم')}
        </button>
      </div>
    </DashboardLayout>
  );
}
