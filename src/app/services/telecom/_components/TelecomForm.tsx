"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Save, AlertCircle, Smartphone, User, Plus, X, Edit3 } from 'lucide-react';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, readApiError } from '@/components/ui/feedback';

export interface TelecomFormValues {
  simNumber: string;
  accountNumber: string;
  provider: string;
  plan: string;
  serviceType: string;
  employeeId: string;
  companyId: string;
  branchId: string;
}

export const EMPTY_TELECOM_FORM: TelecomFormValues = {
  simNumber: '',
  accountNumber: '',
  provider: '',
  plan: '',
  serviceType: '',
  employeeId: '',
  companyId: '',
  branchId: '',
};

export function simToForm(sim: Record<string, unknown>): TelecomFormValues {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    simNumber: str(sim.simNumber),
    accountNumber: str(sim.accountNumber),
    provider: str(sim.provider),
    plan: str(sim.plan),
    serviceType: str(sim.serviceType),
    employeeId: str(sim.employeeId),
    companyId: str(sim.companyId),
    branchId: str(sim.branchId),
  };
}

interface EmployeeOption {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic: string;
  legalCompanyId?: string | null;
  actualCompanyId?: string | null;
  branchId?: string | null;
}
interface NamedEntity { id: string; nameArabic: string }

/** Built-in telecom providers; custom ones are derived from existing SIM records (stored on each record). */
const DEFAULT_PROVIDERS = ['STC', 'Mobily', 'Zain'];

async function fetchList<T>(url: string): Promise<T[]> {
  const res = await fetch(url);
  if (res.status === 401) { window.location.href = '/login'; return []; }
  if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل البيانات'));
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

interface TelecomFormProps {
  mode: 'create' | 'edit';
  initialValues: TelecomFormValues;
  submitUrl: string;
  submitMethod: 'POST' | 'PUT';
}

export default function TelecomForm({ mode, initialValues, submitUrl, submitMethod }: TelecomFormProps) {
  const router = useRouter();

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [companies, setCompanies] = useState<NamedEntity[]>([]);
  const [branches, setBranches] = useState<NamedEntity[]>([]);
  const [recordProviders, setRecordProviders] = useState<string[]>([]);
  // Providers typed in this session (saved on the record when the form is submitted).
  const [sessionProviders, setSessionProviders] = useState<string[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState<TelecomFormValues>(initialValues);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled([
        fetchList<EmployeeOption>('/api/employees?fields=basic'),
        fetchList<NamedEntity>('/api/companies'),
        fetchList<NamedEntity>('/api/branches'),
        fetchList<{ provider?: string | null }>('/api/services/telecom'),
      ]);
      if (cancelled) return;
      const [emps, comps, brs, sims] = results;
      if (emps.status === 'fulfilled') setEmployees(emps.value);
      if (comps.status === 'fulfilled') setCompanies(comps.value);
      if (brs.status === 'fulfilled') setBranches(brs.value);
      if (sims.status === 'fulfilled') {
        const names = sims.value.map((s) => (s.provider || '').trim()).filter(Boolean);
        setRecordProviders(Array.from(new Set(names)));
      }
      if (results.some((r) => r.status === 'rejected')) {
        toast.error('تعذر تحميل بعض القوائم (الموظفين/الشركات/الفروع). حدّث الصفحة للمحاولة مرة أخرى.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleChange = (e: { target: { name: string; value: string } }) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const newData = { ...prev, [name]: value };
      // Auto-fill company & branch when employee is selected
      if (name === 'employeeId' && value) {
        const emp = employees.find((em) => em.id === value);
        if (emp) {
          newData.companyId = emp.legalCompanyId || emp.actualCompanyId || '';
          newData.branchId = emp.branchId || '';
        }
      }
      return newData;
    });
  };

  // Telecom providers
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderName, setNewProviderName] = useState('');

  const allProviders = useMemo(() => {
    const list = [...DEFAULT_PROVIDERS];
    for (const p of [...recordProviders, ...sessionProviders, initialValues.provider]) {
      const name = (p || '').trim();
      if (name && !list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name);
    }
    return list;
  }, [recordProviders, sessionProviders, initialValues.provider]);

  const addProvider = () => {
    const name = newProviderName.trim();
    if (!name) return;
    const existing = allProviders.find((p) => p.toLowerCase() === name.toLowerCase());
    if (!existing) setSessionProviders((prev) => [...prev, name]);
    setFormData((prev) => ({ ...prev, provider: existing || name }));
    setNewProviderName('');
    setShowAddProvider(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (!formData.serviceType) { setErrorMsg('يرجى اختيار نوع الخدمة'); return; }
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch(submitUrl, {
        method: submitMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ الشريحة');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      toast.success(mode === 'create' ? 'تم إضافة الشريحة بنجاح' : 'تم تحديث الشريحة بنجاح');
      router.push('/services/telecom');
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
          <Link href="/services/telecom" className="inline-flex items-center gap-2 text-slate-400 hover:text-blue-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-blue-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لشرائح الجوال والانترنت
          </Link>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-blue-100 text-blue-600 p-3 rounded-2xl">{mode === 'create' ? <Smartphone size={26} /> : <Edit3 size={26} />}</span>
            {mode === 'create' ? 'إضافة شريحة جديدة' : 'تعديل تخصيص الشريحة'}
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">
            {mode === 'create' ? 'إدارة شرائح الجوال والانترنت وتخصيصها للموظفين والشركات' : 'إدارة بيانات الشريحة وتخصيص مستخدميها.'}
          </p>
        </div>

        {errorMsg && (
          <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px]">{errorMsg}</p>
          </div>
        )}

        <form id="telecom-form" onSubmit={handleSubmit} className="space-y-8">

          {/* ── 1. بيانات الشريحة ── */}
          <Section title="بيانات الشريحة الأساسية" icon={<Smartphone size={16} className="text-blue-600" />} badge={mode === 'create' ? 'مطلوب' : 'تعديل'}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field name="simNumber" value={formData.simNumber} onChange={handleChange} label="رقم الشريحة / رقم الخدمة" required placeholder="05XXXXXXXX" />
              <Field name="accountNumber" value={formData.accountNumber} onChange={handleChange} label="رقم السداد" placeholder="123456789" />
              <div className="flex flex-col gap-2">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <SearchableSelect name="provider" value={formData.provider} onChange={handleChange} label="مزود الخدمة" accentColor="blue"
                      options={allProviders.map(p => ({ label: p, value: p }))} />
                  </div>
                  <button type="button" aria-label="إضافة مزود خدمة جديد" title="إضافة مزود خدمة جديد" onClick={() => setShowAddProvider(!showAddProvider)}
                    className="mb-0.5 w-12 h-12 flex items-center justify-center rounded-xl bg-blue-50 border-2 border-blue-200 text-blue-600 hover:bg-blue-100 transition shrink-0">
                    <Plus size={20} />
                  </button>
                </div>
                {showAddProvider && (
                  <div className="flex items-center gap-2 mt-1 p-3 bg-blue-50 rounded-xl border border-blue-100">
                    <input type="text" aria-label="اسم المزود الجديد" value={newProviderName} onChange={(e) => setNewProviderName(e.target.value)}
                      placeholder="اسم المزود الجديد..." onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addProvider(); } }}
                      className="flex-1 px-4 py-2.5 bg-white border-2 border-blue-200 rounded-xl text-[13px] font-bold focus:outline-none focus:border-blue-400" />
                    <button type="button" onClick={addProvider}
                      className="px-4 py-2.5 bg-blue-600 text-white text-[12px] font-bold rounded-xl hover:bg-blue-700 transition">اعتماد</button>
                    <button type="button" aria-label="إلغاء" onClick={() => { setShowAddProvider(false); setNewProviderName(''); }}
                      className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition">
                      <X size={16} />
                    </button>
                  </div>
                )}
              </div>
              <Field name="plan" value={formData.plan} onChange={handleChange} label="الباقة المعتمدة" placeholder="مثال: باقة أعمال 150" />

              <div className="md:col-span-2">
                <SearchableSelect name="serviceType" value={formData.serviceType} onChange={handleChange} label="نوع الخدمة" required accentColor="blue"
                  options={[
                    { label: 'جوال (اتصال وبيانات)', value: 'جوال' },
                    { label: 'هاتف أرضي', value: 'ارضي' },
                    { label: 'شريحة بيانات (نت)', value: 'نت' },
                    { label: 'ألياف بصرية (Fiber)', value: 'الياف' },
                  ]} />
              </div>
            </div>
          </Section>

          {/* ── 2. التخصيص والمستخدم ── */}
          <Section title="تخصيص الشريحة (المستخدم)" icon={<User size={16} className="text-emerald-600" />} badge={mode === 'create' ? 'تحديد' : 'المستفيد'}>
            {mode === 'create' && (
              <div className="bg-blue-50 border border-blue-100 rounded-[1.25rem] p-4 mb-6 flex items-start gap-3">
                <AlertCircle size={16} className="text-blue-500 shrink-0 mt-0.5" />
                <p className="text-[12px] font-bold text-blue-700">يمكنك ربط الشريحة بموظف محدد لسحب اسمه ورقمه الوظيفي تلقائياً، أو ربطها بالشركة والفرع مباشرة.</p>
              </div>
            )}
            <div className="grid grid-cols-1 gap-6">
              <SearchableSelect name="employeeId" value={formData.employeeId} onChange={handleChange} label="اسم المستخدم للشريحة (الموظف)" accentColor="blue"
                options={employees.map(e => ({ label: `${e.firstNameArabic} ${e.lastNameArabic} - #${e.employeeId}`, value: e.id }))} />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                <SearchableSelect name="companyId" value={formData.companyId} onChange={handleChange} label="الشركة التابعة لها" accentColor="blue"
                  options={companies.map(c => ({ label: c.nameArabic, value: c.id }))} />
                <SearchableSelect name="branchId" value={formData.branchId} onChange={handleChange} label="الفرع المخصص للاستخدام" accentColor="blue"
                  options={branches.map(b => ({ label: b.nameArabic, value: b.id }))} />
              </div>
            </div>
          </Section>

        </form>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 md:py-5 md:px-12 flex justify-between items-center z-50">
        <Link href="/services/telecom" className="px-8 py-3.5 text-[13px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-[1.25rem] hover:bg-slate-100 transition-all">
          إلغاء
        </Link>
        <button type="submit" form="telecom-form" disabled={isLoading}
          className="px-10 py-3.5 text-[13px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-blue-600 disabled:opacity-50 transition-all shadow-lg flex items-center gap-2">
          {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
          {isLoading ? 'جاري الحفظ...' : mode === 'create' ? 'حفظ الشريحة' : 'حفظ التعديلات'}
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
  name: keyof TelecomFormValues;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}

function Field({ name, value, onChange, label, type = 'text', required = false, placeholder }: FieldProps) {
  const id = `telecom-${name}`;
  return (
    <div className="flex flex-col gap-2 group">
      <label htmlFor={id} className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-blue-600 transition-colors">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input id={id} type={type} name={name} value={value} onChange={onChange} required={required} placeholder={placeholder}
        className="px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-blue-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all" />
    </div>
  );
}
