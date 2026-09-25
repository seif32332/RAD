"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  ChevronRight, Save, AlertCircle, ShieldAlert, Truck, Paperclip, Percent, Building2, RefreshCw
} from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';

interface ClaimVehicle {
  id: string;
  plateNumber?: string | null;
  brand?: string | null;
  modelYear?: string | number | null;
  vehicleCode?: string | null;
  color?: string | null;
  category?: string | null;
  isArchived?: boolean | null;
  legalCompany?: { nameArabic?: string | null } | null;
  actualCompany?: { nameArabic?: string | null } | null;
  driver?: { firstNameArabic?: string | null; lastNameArabic?: string | null; branch?: { nameArabic?: string | null } | null } | null;
}

type FieldChange = { target: { name: string; value: string } };

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

export default function EditClaimPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [vehicles, setVehicles] = useState<ClaimVehicle[]>([]);
  const [vehiclesError, setVehiclesError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingClaim, setIsLoadingClaim] = useState(true);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    vehicleId: '',
    faultPercentageAgainst: '',
    faultPercentageFor: '',
    claimAmount: '',
    insuranceCompany: '',
    status: 'PENDING_SUBMISSION',
    najmReportUrl: '',
    estimatesUrl: '',
    accidentPhotosUrl: '',
    ibanUrl: '',
    otherAttachmentsUrl: '',
  });

  // setState only runs inside promise callbacks (never synchronously in the effect).
  const fetchVehicles = useCallback(() => fetch('/api/vehicles')
    .then(async (res) => {
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setVehiclesError(await readApiError(res, 'تعذر تحميل قائمة المركبات'));
        return;
      }
      const d = await res.json();
      if (Array.isArray(d)) setVehicles(d);
      setVehiclesError(null);
    })
    .catch(() => setVehiclesError('تعذر الاتصال بالخادم لتحميل المركبات')), []);

  const fetchClaim = useCallback(async () => {
    if (!id) return;
    setClaimError(null);
    setIsLoadingClaim(true);
    try {
      const res = await fetch(`/api/claims/${id}`);
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setClaimError(await readApiError(res, res.status === 404 ? 'المطالبة غير موجودة' : 'تعذر تحميل بيانات المطالبة'));
        return;
      }
      const json = await res.json();
      const c = json?.data ?? json;
      if (c && typeof c === 'object') {
            setFormData({
              vehicleId: c.vehicleId || '',
              faultPercentageAgainst: c.faultPercentageAgainst?.toString() || '',
              faultPercentageFor: c.faultPercentageFor?.toString() || '',
              claimAmount: c.claimAmount?.toString() || '',
              insuranceCompany: c.insuranceCompany || '',
              status: c.status || 'PENDING_SUBMISSION',
              najmReportUrl: c.najmReportUrl || '',
              estimatesUrl: c.estimatesUrl || '',
              accidentPhotosUrl: c.accidentPhotosUrl || '',
              ibanUrl: c.ibanUrl || '',
              otherAttachmentsUrl: c.otherAttachmentsUrl || '',
            });
      }
    } catch {
      setClaimError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoadingClaim(false);
    }
  }, [id]);

  useEffect(() => {
    fetchVehicles();
    fetchClaim();
  }, [fetchVehicles, fetchClaim]);

  const handleChange = (e: FieldChange) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || isLoadingClaim || claimError) return;
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/claims/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ التعديلات');
        setErrorMsg(msg);
        toast.error(msg);
        setIsLoading(false);
        return;
      }
      toast.success('تم تحديث المطالبة بنجاح');
      router.push('/claims');
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
      setIsLoading(false);
    }
  };

  const selectedVehicle = vehicles.find(v => v.id === formData.vehicleId);

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div>
          <Link href="/claims" className="inline-flex items-center gap-2 text-slate-400 hover:text-red-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-red-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لقائمة المطالبات
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-red-100 text-red-600 p-3 rounded-2xl"><ShieldAlert size={26} /></span>
            تعديل بيانات المطالبة
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">قم بتحديث بيانات ومبالغ المطالبة وإرفاق المستندات الجديدة.</p>
        </div>

        {claimError && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-extrabold text-red-800 text-[14px] flex items-center gap-3"><AlertCircle className="text-red-500 shrink-0" size={22} /> {claimError}</p>
            <button type="button" onClick={fetchClaim} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-700 font-black text-[12px] rounded-xl hover:bg-red-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {isLoadingClaim && !claimError && (
          <div className="py-6 text-center text-slate-400 font-bold animate-pulse">جاري تحميل بيانات المطالبة...</div>
        )}

        {vehiclesError && (
          <div role="alert" className="bg-amber-50 border-2 border-amber-200 rounded-[1.5rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-extrabold text-amber-800 text-[14px] flex items-center gap-3"><AlertCircle className="text-amber-500 shrink-0" size={22} /> {vehiclesError}</p>
            <button type="button" onClick={fetchVehicles} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-amber-200 text-amber-800 font-black text-[12px] rounded-xl hover:bg-amber-100 transition">
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

        <form id="claim-form" onSubmit={handleSubmit} className="space-y-8">

          {/* ── 1. اختيار المركبة ── */}
          <Section title="المركبة المتضررة" icon={<Truck size={16} className="text-indigo-600" />} badge="مطلوب">
            <div className="grid grid-cols-1 gap-6">
              <SearchableSelect name="vehicleId" value={formData.vehicleId} onChange={handleChange} label="اختيار السيارة (برقم اللوحة)" required accentColor="red"
                options={vehicles.filter(v => !v.isArchived || v.id === formData.vehicleId).map(v => ({ label: `${v.plateNumber ?? ''} — ${v.brand ?? ''} ${v.modelYear ?? ''} (${v.vehicleCode ?? ''})${v.isArchived ? ' — مؤرشفة' : ''}`, value: v.id }))} />

              {selectedVehicle && (
                <div className="bg-indigo-50 border border-indigo-100 rounded-[1.5rem] p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
                  <InfoBox label="رقم اللوحة" value={selectedVehicle.plateNumber || '-'} />
                  <InfoBox label="المالك القانوني" value={selectedVehicle.legalCompany?.nameArabic || 'غير محدد'} />
                  <InfoBox label="المستفيد الفعلي" value={selectedVehicle.actualCompany?.nameArabic || 'غير محدد'} />
                  <InfoBox label="السائق" value={selectedVehicle.driver ? `${selectedVehicle.driver.firstNameArabic ?? ''} ${selectedVehicle.driver.lastNameArabic ?? ''}` : 'غير مخصص'} />
                  <InfoBox label="الفرع" value={selectedVehicle.driver?.branch?.nameArabic || '-'} />
                  <InfoBox label="كود المركبة" value={selectedVehicle.vehicleCode || '-'} />
                  <InfoBox label="اللون" value={selectedVehicle.color || '-'} />
                  <InfoBox label="الفئة" value={selectedVehicle.category || '-'} />
                </div>
              )}
            </div>
          </Section>

          {/* ── 2. تفاصيل المطالبة ── */}
          <Section title="تفاصيل المطالبة والنسب" icon={<Percent size={16} className="text-amber-500" />} badge="مالي">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field name="faultPercentageAgainst" value={formData.faultPercentageAgainst} onChange={handleChange} label="نسبة الخطأ على الشركة (%)" type="number" placeholder="مثال: 75" />
              <Field name="faultPercentageFor" value={formData.faultPercentageFor} onChange={handleChange} label="نسبة الخطأ لصالح الشركة (%)" type="number" placeholder="مثال: 25" />
              <Field name="claimAmount" value={formData.claimAmount} onChange={handleChange} label="مبلغ المطالبة (ر.س)" type="number" placeholder="5000" />
              <Field name="insuranceCompany" value={formData.insuranceCompany} onChange={handleChange} label="شركة التأمين المسؤولة" placeholder="تكافل الراجحي / بوبا / التعاونية..." />
            </div>
          </Section>

          {/* ── 3. حالة المطالبة ── */}
          <Section title="حالة المطالبة" icon={<Building2 size={16} className="text-blue-500" />} badge="تتبع">
            <div className="grid grid-cols-1 gap-6">
              <SearchableSelect name="status" value={formData.status} onChange={handleChange} label="الحالة الحالية للمطالبة" required accentColor="red"
                options={[
                  { label: '⏳ بانتظار تقديم المطالبة', value: 'PENDING_SUBMISSION' },
                  { label: '📋 تم تقديم المطالبة', value: 'SUBMITTED' },
                  { label: '✅ تم استلام المطالبة (والمبلغ)', value: 'TRANSFERRED' },
                ]} />
            </div>
          </Section>

          {/* ── 4. المرفقات ── */}
          <Section title="مرفقات المطالبة" icon={<Paperclip size={16} className="text-slate-500" />} badge="مستندات">
            <div className="bg-blue-50 border border-blue-100 rounded-[1.25rem] p-5 mb-8 flex items-start gap-4 shadow-sm">
              <div className="bg-white p-2 text-blue-500 rounded-xl shadow-sm border border-blue-100/50">
                <AlertCircle size={20} className="shrink-0" />
              </div>
              <div>
                <p className="text-[14px] font-black text-blue-900 mb-1">إرفاق المستندات</p>
                <p className="text-[12px] font-bold text-blue-700/80 leading-relaxed">
                  تحديث الوثائق الخاصة بتقديرات الحادث وصور السيارة.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8 p-6 bg-slate-50/50 rounded-3xl border border-slate-100/60">
              <FileUploadField name="najmReportUrl" value={formData.najmReportUrl} onChange={handleChange} label="📋 تقرير نجم" accept=".pdf,.jpg,.jpeg,.png" />
              <FileUploadField name="estimatesUrl" value={formData.estimatesUrl} onChange={handleChange} label="💰 التقديرات" accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx" />
              <FileUploadField name="accidentPhotosUrl" value={formData.accidentPhotosUrl} onChange={handleChange} label="📸 صور السيارة المتضررة" accept=".jpg,.jpeg,.png,.webp" />
              <FileUploadField name="ibanUrl" value={formData.ibanUrl} onChange={handleChange} label="🏦 الآيبان" accept=".pdf,.jpg,.jpeg,.png" />
              <div className="md:col-span-2">
                <FileUploadField name="otherAttachmentsUrl" value={formData.otherAttachmentsUrl} onChange={handleChange} label="📎 مرفقات أخرى" />
              </div>
            </div>
          </Section>

        </form>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/claims" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء التعديل
        </Link>
        <button type="submit" form="claim-form" disabled={isLoading || isLoadingClaim || !!claimError}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-slate-700 disabled:opacity-50 transition-all shadow-lg flex items-center gap-2">
          {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isLoading ? 'جاري الحفظ...' : 'حفظ بيانات المطالبة'}
        </button>
      </div>
    </DashboardLayout>
  );
}

// -- Components --
function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-indigo-500 mb-1 uppercase tracking-wider">{label}</p>
      <p className="font-black text-indigo-900 text-[14px]">{value}</p>
    </div>
  );
}

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

function Field({ name, value, onChange, label, type = 'text', required = false, placeholder }: {
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const inputId = `claim-field-${name}`;
  return (
    <div className="flex flex-col gap-2 group">
      <label htmlFor={inputId} className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-red-600 transition-colors">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input id={inputId} type={type} {...(type === 'number' ? { min: 0, step: 'any' } : {})} name={name} value={value} onChange={onChange} required={required} placeholder={placeholder}
        className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-red-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-red-100 transition-all" />
    </div>
  );
}
