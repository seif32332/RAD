"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Save, AlertCircle, Zap, GitBranch, Paperclip } from 'lucide-react';
import SearchableSelect from '@/components/SearchableSelect';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';

export interface UtilityFormValues {
  meterNumber: string;
  accountNumber: string;
  meterPhotoUrl: string;
  branchId: string;
  legalCompanyId: string;
  actualCompanyId: string;
}

export const EMPTY_UTILITY_FORM: UtilityFormValues = {
  meterNumber: '',
  accountNumber: '',
  meterPhotoUrl: '',
  branchId: '',
  legalCompanyId: '',
  actualCompanyId: '',
};

export function meterToForm(meter: Record<string, unknown>): UtilityFormValues {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    meterNumber: str(meter.meterNumber),
    accountNumber: str(meter.accountNumber),
    meterPhotoUrl: str(meter.meterPhotoUrl),
    branchId: str(meter.branchId),
    legalCompanyId: str(meter.legalCompanyId),
    actualCompanyId: str(meter.actualCompanyId),
  };
}

interface Company { id: string; nameArabic: string }
interface Branch { id: string; nameArabic: string; branchCode?: string | null; city?: string | null }

async function fetchList<T>(url: string): Promise<T[]> {
  const res = await fetch(url);
  if (res.status === 401) { window.location.href = '/login'; return []; }
  if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل البيانات'));
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

interface UtilityFormProps {
  mode: 'create' | 'edit';
  initialValues: UtilityFormValues;
  submitUrl: string;
  submitMethod: 'POST' | 'PUT';
}

export default function UtilityForm({ mode, initialValues, submitUrl, submitMethod }: UtilityFormProps) {
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState<UtilityFormValues>(initialValues);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [comps, brs] = await Promise.allSettled([
        fetchList<Company>('/api/companies'),
        fetchList<Branch>('/api/branches'),
      ]);
      if (cancelled) return;
      if (comps.status === 'fulfilled') setCompanies(comps.value);
      if (brs.status === 'fulfilled') setBranches(brs.value);
      if (comps.status === 'rejected' || brs.status === 'rejected') {
        toast.error('تعذر تحميل قائمة الشركات أو الفروع. حدّث الصفحة للمحاولة مرة أخرى.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleChange = (e: { target: { name: string; value: string } }) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (!formData.meterNumber.trim()) { setErrorMsg('الرجاء تعبئة رقم العداد'); return; }
    setIsLoading(true);
    setErrorMsg(null);

    // Auto-generate meterCode (meter number / account number) on creation.
    const submissionData = mode === 'create'
      ? { ...formData, meterCode: `${formData.meterNumber || '0000'}/${formData.accountNumber || '0000'}` }
      : formData;

    try {
      const res = await fetch(submitUrl, {
        method: submitMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submissionData),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'حدث خطأ أثناء حفظ العداد');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      toast.success(mode === 'create' ? 'تم إضافة العداد بنجاح' : 'تم تحديث العداد بنجاح');
      router.push('/services/utilities');
    } catch {
      setErrorMsg('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div>
          <Link href="/services/utilities" className="inline-flex items-center gap-2 text-slate-400 hover:text-amber-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-amber-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لعدادات الكهرباء والمياه
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-amber-100 text-amber-600 p-3 rounded-2xl"><Zap size={26} /></span>
            {mode === 'create' ? 'إضافة عداد جديد' : 'تعديل العداد'}
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">إدارة عدادات الكهرباء والمياه وتحديد مالكها القانوني والمستفيد الفعلي.</p>
        </div>

        {errorMsg && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px]">{errorMsg}</p>
          </div>
        )}

        <form id="meter-form" onSubmit={handleSubmit} className="space-y-8">

          {/* ── 1. بيانات العداد ── */}
          <Section title="بيانات العداد" icon={<Zap size={16} className="text-amber-600" />} badge="مطلوب">
            {mode === 'create' && (
              <div className="bg-amber-50 border border-amber-100 rounded-[1.25rem] p-4 mb-6 flex items-start gap-3">
                <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[12px] font-bold text-amber-700">سيتم توليد كود العداد تلقائياً بدمج (رقم العداد / رقم السداد).</p>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field name="meterNumber" value={formData.meterNumber} onChange={handleChange} label="رقم العداد" required />
              <Field name="accountNumber" value={formData.accountNumber} onChange={handleChange} label="رقم السداد / الحساب" />
            </div>
          </Section>

          {/* ── 2. التوزيع والمستفيد ── */}
          <Section title="موقع العداد (الفرع والشركة)" icon={<GitBranch size={16} className="text-emerald-600" />} badge="تحديد">
            <div className="grid grid-cols-1 gap-6">
              <SearchableSelect name="branchId" value={formData.branchId} onChange={handleChange} label="الفرع القائم به العداد (المدينة/الحي)" accentColor="amber"
                options={branches.map(b => ({ label: `${b.nameArabic}${b.branchCode ? ' - #' + b.branchCode : b.city ? ' - ' + b.city : ' - بدون كود'}`, value: b.id }))} />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100 mt-2">
                <SearchableSelect name="legalCompanyId" value={formData.legalCompanyId} onChange={handleChange} label="مالك العداد القانوني" accentColor="amber"
                  options={companies.map(c => ({ label: `👑 ${c.nameArabic}`, value: c.id }))} />
                <SearchableSelect name="actualCompanyId" value={formData.actualCompanyId} onChange={handleChange} label="المستفيد الفعلي من العداد" accentColor="amber"
                  options={companies.map(c => ({ label: `⚡ ${c.nameArabic}`, value: c.id }))} />
              </div>
            </div>
          </Section>

          {/* ── 3. المرفقات ── */}
          <Section title="المرفقات" icon={<Paperclip size={16} className="text-slate-500" />} badge="اختياري">
            <div className="grid grid-cols-1 gap-6">
              <FileUploadField name="meterPhotoUrl" value={formData.meterPhotoUrl} onChange={handleChange} label="صورة العداد" accept=".jpg,.jpeg,.png,.webp" />
            </div>
          </Section>

        </form>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/services/utilities" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء
        </Link>
        <button type="submit" form="meter-form" disabled={isLoading}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-amber-600 disabled:opacity-50 transition-all shadow-lg flex items-center gap-2">
          {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isLoading ? 'جاري الحفظ...' : mode === 'create' ? 'حفظ العداد' : 'حفظ التعديلات'}
        </button>
      </div>
    </>
  );
}

// -- Components --
function Section({ title, badge, icon, children }: { title: string; badge: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-visible">
      <div className="px-8 py-5 border-b border-slate-100 flex items-center gap-3">
        <span className="w-9 h-9 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center">{icon}</span>
        <h2 className="font-extrabold text-[15px] text-slate-800">{title}</h2>
        <span className="mr-auto text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 px-2.5 py-1 rounded-lg">{badge}</span>
      </div>
      <div className="p-8">{children}</div>
    </div>
  );
}

interface FieldProps {
  name: keyof UtilityFormValues;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  required?: boolean;
  placeholder?: string;
}

function Field({ name, value, onChange, label, required = false, placeholder }: FieldProps) {
  const id = `meter-${name}`;
  return (
    <div className="flex flex-col gap-2 group">
      <label htmlFor={id} className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-amber-600 transition-colors">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input id={id} type="text" name={name} value={value} onChange={onChange} required={required} placeholder={placeholder}
        className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-amber-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-amber-100 transition-all" />
    </div>
  );
}
