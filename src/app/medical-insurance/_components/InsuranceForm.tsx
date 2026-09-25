"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, Save, Calendar, DollarSign, ShieldPlus, ArrowRight, RefreshCw, AlertTriangle } from 'lucide-react';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { toDateInputValue } from '@/lib/dates';
import { isStoredFileUrl } from './stored-file';

export interface InsuranceFormValues {
  companyId: string;
  insuranceIssuer: string;
  policyNumber: string;
  policyCost: string;
  expiryDate: string;
  medicalNetwork: string;
  coverageType: string;
  insuranceClass: string;
  benefitsUrl: string;
  coverageUrl: string;
}

export const EMPTY_INSURANCE_FORM: InsuranceFormValues = {
  companyId: '',
  insuranceIssuer: '',
  policyNumber: '',
  policyCost: '',
  expiryDate: '',
  medicalNetwork: '',
  coverageType: '',
  insuranceClass: '',
  benefitsUrl: '',
  coverageUrl: '',
};

/** Maps an API record to form values. */
export function insuranceToForm(data: Record<string, unknown>): InsuranceFormValues {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    companyId: str(data.companyId),
    insuranceIssuer: str(data.insuranceIssuer),
    policyNumber: str(data.policyNumber),
    policyCost: typeof data.policyCost === 'number' ? String(data.policyCost) : str(data.policyCost),
    expiryDate: toDateInputValue(str(data.expiryDate) || null),
    medicalNetwork: str(data.medicalNetwork),
    coverageType: str(data.coverageType),
    insuranceClass: str(data.insuranceClass),
    benefitsUrl: str(data.benefitsUrl),
    coverageUrl: str(data.coverageUrl),
  };
}

const FILE_FIELDS = ['benefitsUrl', 'coverageUrl'] as const;
type FileField = (typeof FILE_FIELDS)[number];

/** A legacy value: a bare file name saved by the old page (never uploaded, cannot be opened). */
const isMissingFile = (v: string) => !!v && !isStoredFileUrl(v);

/**
 * Request body. Legacy bare file names are left out, so the server keeps the old value until
 * the user re-uploads the file (the API rejects bare names).
 */
function buildPayload(values: InsuranceFormValues): Partial<InsuranceFormValues> {
  const payload: Partial<InsuranceFormValues> = { ...values };
  for (const f of FILE_FIELDS) {
    if (isMissingFile(values[f])) delete payload[f];
  }
  return payload;
}

interface Company { id: string; nameArabic: string }

interface InsuranceFormProps {
  mode: 'create' | 'edit';
  initialValues: InsuranceFormValues;
  /** POST /api/medical-insurance (create) or PUT /api/medical-insurance/:id (edit). */
  submitUrl: string;
  submitMethod: 'POST' | 'PUT';
}

const INPUT = 'w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none transition-all placeholder:text-slate-400';
const SELECT = 'w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none transition-all appearance-none';

export default function InsuranceForm({ mode, initialValues, submitUrl, submitMethod }: InsuranceFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [formData, setFormData] = useState<InsuranceFormValues>(initialValues);

  const loadCompanies = async () => {
    setCompaniesError(null);
    try {
      const res = await fetch('/api/companies');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { setCompaniesError(await readApiError(res, 'تعذر تحميل قائمة المنشآت')); return; }
      const data: unknown = await res.json();
      setCompanies(Array.isArray(data) ? (data as Company[]) : []);
    } catch {
      setCompaniesError('تعذر الاتصال بالخادم');
    }
  };

  useEffect(() => { loadCompanies(); }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!(Number(formData.policyCost) >= 0) || formData.policyCost === '') { toast.error('يرجى إدخال تكلفة صحيحة للوثيقة'); return; }
    setIsSubmitting(true);

    try {
      const res = await fetch(submitUrl, {
        method: submitMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(formData)),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        toast.error(await readApiError(res, mode === 'create' ? 'حدث خطأ أثناء حفظ الوثيقة' : 'حدث خطأ أثناء تعديل الوثيقة'));
        return;
      }
      toast.success(mode === 'create' ? 'تم حفظ وثيقة التأمين' : 'تم تحديث وثيقة التأمين');
      router.push('/medical-insurance');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-[800px] mx-auto min-h-screen">

      <Link href="/medical-insurance" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition font-bold text-[14px] mb-8">
         <ArrowRight size={18} /> العودة لقائمة التأمين الطبي
      </Link>

      <div className="mb-14">
        <h1 className="text-4xl font-black text-slate-800 tracking-tight flex items-center gap-3">
           <ShieldPlus className="text-blue-600" size={38} />
           {mode === 'create' ? 'وثيقة تأمين طبي جديدة' : 'تعديل وثيقة تأمين طبي'}
        </h1>
        <p className="text-slate-500 font-bold mt-2">
          {mode === 'create' ? 'قم بإدخال بيانات وثيقة التأمين الصحي الخاص بالمنشأة والموظفين.' : 'قم بتحديث بيانات وثيقة التأمين الصحي الخاص بالمنشأة والموظفين.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-12 bg-white p-10 rounded-[2.5rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100">

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
           <div className="col-span-1 md:col-span-2">
              <label htmlFor="ins-company" className="text-[13px] font-extrabold text-slate-700 block mb-2">بيانات المنشأة التابعة للوثيقة *</label>
              <div className="relative">
                 <select
                   id="ins-company"
                   name="companyId"
                   value={formData.companyId}
                   onChange={handleChange}
                   required
                   className="w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all appearance-none">
                    <option value="" disabled>-- اختيار المنشأة --</option>
                    {companies.map(c => (
                       <option key={c.id} value={c.id}>{c.nameArabic}</option>
                    ))}
                 </select>
                 <Building2 className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={20}/>
              </div>
              {companiesError && (
                <p className="mt-2 text-[12px] font-bold text-rose-600 flex items-center gap-2">
                  {companiesError}
                  <button type="button" onClick={loadCompanies} className="inline-flex items-center gap-1 text-rose-700 underline"><RefreshCw size={12}/> إعادة المحاولة</button>
                </p>
              )}
           </div>

           <div>
              <label htmlFor="ins-issuer" className="text-[13px] font-extrabold text-slate-700 block mb-2">اسم شركة التأمين *</label>
              <input id="ins-issuer" type="text" name="insuranceIssuer" value={formData.insuranceIssuer} onChange={handleChange} required placeholder="مثال: بوبا، التعاونية..." className={INPUT} />
           </div>

           <div>
              <label htmlFor="ins-policy" className="text-[13px] font-extrabold text-slate-700 block mb-2">رقم الوثيقة *</label>
              <input id="ins-policy" type="text" name="policyNumber" value={formData.policyNumber} onChange={handleChange} required placeholder="رقم بوليصة التأمين" className={INPUT} />
           </div>

           <div>
              <label htmlFor="ins-cost" className="text-[13px] font-extrabold text-slate-700 block mb-2">تكلفة الوثيقة *</label>
              <div className="relative">
                 <input id="ins-cost" type="number" min="0" step="0.01" name="policyCost" value={formData.policyCost} onChange={handleChange} required placeholder="مبلغ التكلفة سنوياً" className={INPUT} />
                 <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={20}/>
              </div>
           </div>

           <div>
              <label htmlFor="ins-expiry" className="text-[13px] font-extrabold text-slate-700 mb-2 flex justify-between">
                <span>تاريخ انتهاء الوثيقة *</span>
                <span className="text-[10px] text-amber-500 bg-amber-50 px-2 py-0.5 rounded-full">تنبيه آلي قبل شهر</span>
              </label>
              <div className="relative">
                 <input id="ins-expiry" type="date" name="expiryDate" value={formData.expiryDate} onChange={handleChange} required dir="ltr"
                   className="w-full bg-slate-50 border-2 focus:border-amber-400 focus:bg-amber-50 rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none transition-all border-amber-200" />
                 <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 text-amber-500 pointer-events-none" size={20}/>
              </div>
           </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-8 border-t border-slate-100">
           <div>
              <label htmlFor="ins-network" className="text-[13px] font-extrabold text-slate-700 block mb-2">الشبكة الطبية</label>
              <input id="ins-network" type="text" name="medicalNetwork" value={formData.medicalNetwork} onChange={handleChange} placeholder="مثال: VIP، A، B، C" className={INPUT} />
           </div>
           <div>
              <label htmlFor="ins-coverage-type" className="text-[13px] font-extrabold text-slate-700 block mb-2">نوع التغطية</label>
              <select id="ins-coverage-type" name="coverageType" value={formData.coverageType} onChange={handleChange} className={SELECT}>
                <option value="">-- اختيار --</option>
                <option value="فردي">فردي</option>
                <option value="عائلي">عائلي</option>
                <option value="فردي + عائلي">فردي + عائلي</option>
              </select>
           </div>
           <div>
              <label htmlFor="ins-class" className="text-[13px] font-extrabold text-slate-700 block mb-2">فئة التأمين</label>
              <select id="ins-class" name="insuranceClass" value={formData.insuranceClass} onChange={handleChange} className={SELECT}>
                <option value="">-- اختيار --</option>
                <option value="Gold">Gold</option>
                <option value="Silver">Silver</option>
                <option value="Bronze">Bronze</option>
                <option value="VIP">VIP</option>
              </select>
           </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-8 border-t border-slate-100">
           {([
             ['benefitsUrl', 'المنافع (مرفق اختياري)'],
             ['coverageUrl', 'التغطية (مرفق اختياري)'],
           ] as [FileField, string][]).map(([field, label]) => {
             const value = formData[field];
             const missing = isMissingFile(value);
             return (
               <div key={field} className="flex flex-col gap-2">
                 <FileUploadField
                   name={field}
                   // A legacy bare name is not a link: show the empty upload zone instead.
                   value={missing ? '' : value}
                   onChange={(e) => setFormData(prev => ({ ...prev, [field]: e.target.value }))}
                   accept=".pdf,.png,.jpg,.jpeg"
                   label={label}
                 />
                 {missing && (
                   <p role="alert" className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-center gap-2">
                     <AlertTriangle size={14} className="shrink-0" />
                     <span>الملف غير موجود ({value})، يرجى إعادة رفعه</span>
                   </p>
                 )}
               </div>
             );
           })}
        </div>

        <div className="pt-6">
          <button disabled={isSubmitting} type="submit"
             className="w-full bg-emerald-500 hover:bg-emerald-600 text-white rounded-[1.25rem] py-5 font-black text-[15px] flex items-center justify-center gap-3 transition-all hover:-translate-y-1 hover:shadow-[0_10px_30px_rgba(16,185,129,0.3)] disabled:opacity-50">
             {isSubmitting ? (
               <span className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin"/>
             ) : (
               <>{mode === 'create' ? 'حفظ وتوثيق العقد' : 'تحديث وتوثيق الوثيقة'} <Save size={20} /></>
             )}
          </button>
        </div>

      </form>

    </div>
  );
}
