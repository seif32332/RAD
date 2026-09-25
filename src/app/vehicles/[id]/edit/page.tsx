"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  ChevronRight, Save, AlertCircle, Truck, Building2, User, Paperclip, Calendar, RefreshCw
} from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { toDateInputValue } from '@/lib/dates';

interface CompanyOption { id: string; nameArabic?: string | null }
interface DriverOption {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  legalCompanyId?: string | null;
  branch?: { nameArabic?: string | null } | null;
}

type FieldChange = { target: { name: string; value: string } };

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

/** Loads a list endpoint; returns [] and an error message instead of throwing. */
async function loadList<T>(url: string, failMessage: string): Promise<{ rows: T[]; error: string | null }> {
  try {
    const res = await fetch(url);
    if (res.status === 401) {
      redirectToLogin();
      return { rows: [], error: null };
    }
    if (!res.ok) return { rows: [], error: await readApiError(res, failMessage) };
    const d = await res.json();
    return { rows: Array.isArray(d) ? (d as T[]) : [], error: null };
  } catch {
    return { rows: [], error: failMessage };
  }
}

export default function EditVehiclePage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [employees, setEmployees] = useState<DriverOption[]>([]);
  const [listsError, setListsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoadingVehicle, setIsLoadingVehicle] = useState(true);
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    category: '', brand: '', modelYear: '', color: '',
    sequenceNumber: '', plateNumber: '',
    legalCompanyId: '', actualCompanyId: '',
    licenseExpDate: '', insuranceExpDate: '', inspectionExpDate: '',
    operatingCardExpDate: '', operatingCardUrl: '',
    driverId: '', driverCardNumber: '', driverCardExpDate: '',
    drivingAuthorizationUrl: '', vehiclePhotosUrl: '', registrationFormUrl: '', otherAttachmentsUrl: '',
  });

  // Lookup lists (companies, drivers). setState only runs in promise callbacks.
  const loadLookups = useCallback(() => Promise.all([
    loadList<CompanyOption>('/api/companies', 'تعذر تحميل قائمة الشركات'),
    loadList<DriverOption>('/api/employees?fields=basic', 'تعذر تحميل قائمة الموظفين'),
  ]).then(([c, e]) => {
    setCompanies(c.rows);
    setEmployees(e.rows);
    setListsError(c.error || e.error);
  }), []);

  const loadVehicle = useCallback(() => {
    if (!id) return Promise.resolve();
    return fetch(`/api/vehicles/${id}`)
      .then(async (res) => {
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          setVehicleError(await readApiError(res, res.status === 404 ? 'المركبة غير موجودة' : 'تعذر تحميل بيانات المركبة'));
          return;
        }
        const json = await res.json();
        const vehicle = json?.data ?? json;
        if (vehicle && typeof vehicle === 'object') {
          setFormData({
            category: vehicle.category || '',
            brand: vehicle.brand || '',
            modelYear: vehicle.modelYear != null ? String(vehicle.modelYear) : '',
            color: vehicle.color || '',
            sequenceNumber: vehicle.sequenceNumber || '',
            plateNumber: vehicle.plateNumber || '',
            legalCompanyId: vehicle.legalCompanyId || '',
            actualCompanyId: vehicle.actualCompanyId || '',
            licenseExpDate: toDateInputValue(vehicle.licenseExpDate),
            insuranceExpDate: toDateInputValue(vehicle.insuranceExpDate),
            inspectionExpDate: toDateInputValue(vehicle.inspectionExpDate),
            operatingCardExpDate: toDateInputValue(vehicle.operatingCardExpDate),
            operatingCardUrl: vehicle.operatingCardUrl || '',
            driverId: vehicle.driverId || '',
            driverCardNumber: vehicle.driverCardNumber || '',
            driverCardExpDate: toDateInputValue(vehicle.driverCardExpDate),
            drivingAuthorizationUrl: vehicle.drivingAuthorizationUrl || '',
            vehiclePhotosUrl: vehicle.vehiclePhotosUrl || '',
            registrationFormUrl: vehicle.registrationFormUrl || '',
            otherAttachmentsUrl: vehicle.otherAttachmentsUrl || '',
          });
          setVehicleError(null);
        }
      })
      .catch(() => setVehicleError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.'))
      .finally(() => setIsLoadingVehicle(false));
  }, [id]);

  useEffect(() => {
    void loadLookups();
    void loadVehicle();
  }, [loadLookups, loadVehicle]);

  const handleChange = (e: FieldChange) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || isLoadingVehicle || vehicleError) return;
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/vehicles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const msg = await readApiError(res, 'فشل التحديث');
        setErrorMsg(msg);
        toast.error(msg);
        setIsLoading(false);
        return;
      }
      toast.success('تم تحديث بيانات المركبة');
      router.push('/vehicles');
    } catch {
      const msg = 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.';
      setErrorMsg(msg);
      toast.error(msg);
      setIsLoading(false);
    }
  };

  const selectedDriver = employees.find(e => e.id === formData.driverId);

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div>
          <Link href="/vehicles" className="inline-flex items-center gap-2 text-slate-400 hover:text-indigo-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-indigo-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لقائمة المركبات
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-indigo-100 text-indigo-600 p-3 rounded-2xl"><Truck size={26} /></span>
            تعديل المركبة
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">قم بتعديل بيانات المركبة وتحديث التراخيص والوثائق المرفقة.</p>
        </div>

        {vehicleError && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-extrabold text-red-800 text-[14px] flex items-center gap-3"><AlertCircle className="text-red-500 shrink-0" size={22} /> {vehicleError}</p>
            <button type="button" onClick={() => { setIsLoadingVehicle(true); void loadVehicle(); }} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-700 font-black text-[12px] rounded-xl hover:bg-red-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {isLoadingVehicle && !vehicleError && (
          <div className="py-6 text-center text-slate-400 font-bold animate-pulse">جاري تحميل بيانات المركبة...</div>
        )}

        {listsError && (
          <div role="alert" className="bg-amber-50 border-2 border-amber-200 rounded-[1.5rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-extrabold text-amber-800 text-[14px] flex items-center gap-3"><AlertCircle className="text-amber-500 shrink-0" size={22} /> {listsError}</p>
            <button type="button" onClick={() => { void loadLookups(); }} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-amber-200 text-amber-800 font-black text-[12px] rounded-xl hover:bg-amber-100 transition">
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

        <form id="vehicle-form" onSubmit={handleSubmit} className="space-y-8">

          {/* ── 1. بيانات المركبة ── */}
          <Section title="بيانات المركبة الأساسية" icon={<Truck size={16} className="text-indigo-600" />} badge="مطلوب">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <SearchableSelect name="category" value={formData.category} onChange={handleChange} label="الفئة" required accentColor="indigo"
                options={[
                  { label: 'خصوصي', value: 'خصوصي' },
                  { label: 'نقل خاص', value: 'نقل خاص' },
                  { label: 'نقل عام', value: 'نقل عام' },
                ]} />
              <Field name="brand" value={formData.brand} onChange={handleChange} label="النوع (الماركة)" required placeholder="كيا / هونداي / تويوتا..." />
              <Field name="modelYear" value={formData.modelYear} onChange={handleChange} label="الموديل (السنة)" placeholder="2024" />
              <Field name="color" value={formData.color} onChange={handleChange} label="اللون" placeholder="أبيض / أسود..." />
              <Field name="sequenceNumber" value={formData.sequenceNumber} onChange={handleChange} label="الرقم التسلسلي (VIN)" placeholder="32646665" />
              <Field name="plateNumber" value={formData.plateNumber} onChange={handleChange} label="رقم اللوحة" required placeholder="ب س ر 2050" />
            </div>
          </Section>

          {/* ── 2. المالك والمستفيد ── */}
          <Section title="المالك القانوني والمستفيد الفعلي" icon={<Building2 size={16} className="text-emerald-600" />} badge="شركات">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <SearchableSelect name="legalCompanyId" value={formData.legalCompanyId} onChange={handleChange} label="المالك القانوني (يسحب من الشركات)" accentColor="indigo"
                options={companies.map(c => ({ label: c.nameArabic || '—', value: c.id }))} />
              <SearchableSelect name="actualCompanyId" value={formData.actualCompanyId} onChange={handleChange} label="المستفيد الفعلي (يسحب من الشركات)" accentColor="indigo"
                options={companies.map(c => ({ label: c.nameArabic || '—', value: c.id }))} />
            </div>
          </Section>

          {/* ── 3. التواريخ والتراخيص ── */}
          <Section title="التراخيص والتأمين والفحص" icon={<Calendar size={16} className="text-amber-500" />} badge="تنبيه انتهاء">
            <div className="bg-amber-50 border border-amber-100 rounded-[1.25rem] p-4 mb-6 flex items-start gap-3">
              <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[12px] font-bold text-amber-700">سيتم تنبيهك تلقائياً قبل 30 يوم من انتهاء أي من هذه التواريخ.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <Field name="licenseExpDate" value={formData.licenseExpDate} onChange={handleChange} label="تاريخ انتهاء رخصة السير" type="date" />
              <Field name="insuranceExpDate" value={formData.insuranceExpDate} onChange={handleChange} label="تاريخ انتهاء التأمين" type="date" />
              <Field name="inspectionExpDate" value={formData.inspectionExpDate} onChange={handleChange} label="تاريخ انتهاء الفحص الدوري" type="date" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6 pt-6 border-t border-slate-100">
              <Field name="operatingCardExpDate" value={formData.operatingCardExpDate} onChange={handleChange} label="تاريخ انتهاء كرت التشغيل (إن وجد)" type="date" />
              <FileUploadField name="operatingCardUrl" value={formData.operatingCardUrl} onChange={handleChange} label="مرفق كرت التشغيل" accept=".pdf,.jpg,.jpeg,.png" />
            </div>
          </Section>

          {/* ── 4. بيانات السائق ── */}
          <Section title="السائق المسؤول" icon={<User size={16} className="text-blue-600" />} badge="ربط بالموظفين">
            <div className="grid grid-cols-1 gap-6">
              <SearchableSelect name="driverId" value={formData.driverId} onChange={handleChange} label="اسم السائق (يسحب بالرقم الوظيفي)" accentColor="blue"
                options={employees.map(e => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''}`, value: e.id }))} />

              {selectedDriver && (
                <div className="bg-blue-50 border border-blue-100 rounded-[1.25rem] p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-[11px] font-bold text-blue-500 mb-1">الرقم الوظيفي</p>
                    <p className="font-black text-blue-900">{selectedDriver.employeeId}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-blue-500 mb-1">الشركة</p>
                    <p className="font-bold text-blue-800">{companies.find((c) => c.id === selectedDriver.legalCompanyId)?.nameArabic || 'غير محدد'}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-blue-500 mb-1">الفرع</p>
                    <p className="font-bold text-blue-800">{selectedDriver.branch?.nameArabic || 'غير محدد'}</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                <Field name="driverCardNumber" value={formData.driverCardNumber} onChange={handleChange} label="رقم بطاقة السائق" />
                <Field name="driverCardExpDate" value={formData.driverCardExpDate} onChange={handleChange} label="تاريخ انتهاء بطاقة السائق (تنبيه)" type="date" />
              </div>
            </div>
          </Section>

          {/* ── 5. المرفقات ── */}
          <Section title="المرفقات" icon={<Paperclip size={16} className="text-slate-500" />} badge="مستندات">
            <div className="bg-blue-50 border border-blue-100 rounded-[1.25rem] p-5 mb-8 flex items-start gap-4 shadow-sm">
              <div className="bg-white p-2 text-blue-500 rounded-xl shadow-sm border border-blue-100/50">
                <AlertCircle size={20} className="shrink-0" />
              </div>
              <div>
                <p className="text-[14px] font-black text-blue-900 mb-1">إرفاق المستندات</p>
                <p className="text-[12px] font-bold text-blue-700/80 leading-relaxed">
                  أرفق أحدث الوثائق لتظهر دائماً في سجلات المركبة.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8 p-6 bg-slate-50/50 rounded-3xl border border-slate-100/60">
              <FileUploadField name="drivingAuthorizationUrl" value={formData.drivingAuthorizationUrl} onChange={handleChange} label="📋 تفويض القيادة" accept=".pdf,.jpg,.jpeg,.png" />
              <FileUploadField name="vehiclePhotosUrl" value={formData.vehiclePhotosUrl} onChange={handleChange} label="📸 صور المركبة" accept=".jpg,.jpeg,.png,.webp" />
              <FileUploadField name="registrationFormUrl" value={formData.registrationFormUrl} onChange={handleChange} label="📄 الاستمارة" accept=".pdf,.jpg,.jpeg,.png" />
              <FileUploadField name="otherAttachmentsUrl" value={formData.otherAttachmentsUrl} onChange={handleChange} label="📎 مرفقات أخرى" />
            </div>
          </Section>

        </form>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/vehicles" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء التعديل
        </Link>
        <button type="submit" form="vehicle-form" disabled={isLoading || isLoadingVehicle || !!vehicleError}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-indigo-600 rounded-[1.25rem] hover:bg-slate-900 disabled:opacity-50 transition-all shadow-lg flex items-center gap-2">
          {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isLoading ? 'جاري الحفظ...' : 'حفظ التغييرات'}
        </button>
      </div>
    </DashboardLayout>
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

function Field({ name, value, onChange, label, type = 'text', required = false, placeholder }: {
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const inputId = `vehicle-field-${name}`;
  return (
    <div className="flex flex-col gap-2 group">
      <label htmlFor={inputId} className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-indigo-600 transition-colors">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input id={inputId} type={type} name={name} value={value} onChange={onChange} required={required} placeholder={placeholder}
        {...(type === "date" ? { dir: "ltr", lang: "en" } : {})}
        className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-indigo-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-100 transition-all" />
    </div>
  );
}
