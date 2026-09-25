"use client";

// Shared fields for the "new branch" and "edit branch" forms (private folder: not routed).

import React, { useEffect, useState } from 'react';
import { GitBranch, MapPin, FileText, ShieldCheck, Trash2, Camera, Building2, Paperclip, Clock, Plus, AlertCircle } from 'lucide-react';
import SearchableSelect, { type SelectChangeEvent } from '@/components/SearchableSelect';
import FileUploadField from '@/components/FileUploadField';
import { toDateInputValue } from '@/lib/dates';
import { transliterateArabicToEnglish } from '@/lib/transliterate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchFormData {
  companyId: string;
  administrationId: string;
  nameArabic: string;
  nameEnglish: string;
  city: string;
  district: string;
  street: string;
  branchCode: string;
  munLicenseNum: string;
  munLicenseStart: string;
  munLicenseExp: string;
  munLicenseUrl: string;
  /** Municipal licence renewal cost (SAR); '' = not entered. */
  munLicenseCost: string;
  civilDefenseNum: string;
  civilDefenseStart: string;
  civilDefenseExp: string;
  civilDefenseUrl: string;
  /** Civil defence licence renewal cost (SAR); '' = not entered. */
  civilDefenseCost: string;
  rentContractNum: string;
  rentContractStart: string;
  rentContractExp: string;
  rentOwnerName: string;
  rentOwnerPhone: string;
  rentContractUrl: string;
  rentContractType: string;
  rentContractAmount: string;
  rentPaymentType: string;
  rentPaymentCount: string;
  wasteContractNum: string;
  wasteContractStart: string;
  wasteContractExp: string;
  wasteCompanyName: string;
  wasteCompanyPhone: string;
  wasteContractUrl: string;
  safetyContractNum: string;
  safetyContractStart: string;
  safetyContractExp: string;
  safetyCompanyName: string;
  safetyCompanyPhone: string;
  safetyContractUrl: string;
  cameraContractNum: string;
  cameraContractStart: string;
  cameraContractExp: string;
  cameraCompanyName: string;
  cameraCompanyPhone: string;
  cameraContractUrl: string;
  buildingLicenseUrl: string;
  blueprintsUrl: string;
  engineeringHandoverUrl: string;
  installationCompleteUrl: string;
  externalPhotosUrls: string;
  locationUrl: string;
}

export const EMPTY_BRANCH_FORM: BranchFormData = {
  companyId: '', administrationId: '', nameArabic: '', nameEnglish: '',
  city: '', district: '', street: '', branchCode: '',
  munLicenseNum: '', munLicenseStart: '', munLicenseExp: '', munLicenseUrl: '', munLicenseCost: '',
  civilDefenseNum: '', civilDefenseStart: '', civilDefenseExp: '', civilDefenseUrl: '', civilDefenseCost: '',
  rentContractNum: '', rentContractStart: '', rentContractExp: '',
  rentOwnerName: '', rentOwnerPhone: '', rentContractUrl: '', rentContractType: '',
  rentContractAmount: '', rentPaymentType: 'ANNUAL', rentPaymentCount: '',
  wasteContractNum: '', wasteContractStart: '', wasteContractExp: '',
  wasteCompanyName: '', wasteCompanyPhone: '', wasteContractUrl: '',
  safetyContractNum: '', safetyContractStart: '', safetyContractExp: '',
  safetyCompanyName: '', safetyCompanyPhone: '', safetyContractUrl: '',
  cameraContractNum: '', cameraContractStart: '', cameraContractExp: '',
  cameraCompanyName: '', cameraCompanyPhone: '', cameraContractUrl: '',
  buildingLicenseUrl: '', blueprintsUrl: '', engineeringHandoverUrl: '',
  installationCompleteUrl: '', externalPhotosUrls: '', locationUrl: '',
};

const DATE_FIELDS: (keyof BranchFormData)[] = [
  'munLicenseStart', 'munLicenseExp', 'civilDefenseStart', 'civilDefenseExp', 'rentContractStart', 'rentContractExp',
  'wasteContractStart', 'wasteContractExp', 'safetyContractStart', 'safetyContractExp', 'cameraContractStart', 'cameraContractExp',
];

export type ShiftType = 'ONE_SHIFT' | 'TWO_SHIFTS' | 'FLEXIBLE';

export interface ScheduleDraft {
  id: string;
  name: string;
  shiftType: ShiftType;
  startTime: string;
  endTime: string;
  startTime2: string;
  endTime2: string;
  workDays: string;
  flexibleHours: string;
  isExemptFromAttendance: boolean;
}

export interface RentContractDraft {
  id: string;
  url: string;
  num: string;
  start: string;
  exp: string;
  amount: string;
}

export interface NamedOption {
  id: string;
  nameArabic: string;
}

/** Shape of GET /api/branches/[id] that the edit form reads. */
export type BranchResponse = Partial<Record<keyof BranchFormData, string | number | null>> & {
  workSchedules?: {
    id: string;
    name: string;
    shiftType?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    startTime2?: string | null;
    endTime2?: string | null;
    workDays?: string | null;
    flexibleHours?: number | null;
    isExemptFromAttendance?: boolean | null;
  }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newScheduleDraft(): ScheduleDraft {
  return { id: crypto.randomUUID(), name: '', shiftType: 'ONE_SHIFT', startTime: '', endTime: '', startTime2: '', endTime2: '', workDays: '', flexibleHours: '', isExemptFromAttendance: false };
}

/** Builds the branch POST/PUT body (same shape the API has always accepted). */
export function buildBranchPayload(formData: BranchFormData, additionalRentContracts: RentContractDraft[]) {
  // Additional rent contracts are stored in rentContractUrl as "url|num|start|exp|amount", comma separated.
  const rentContractUrl = [
    formData.rentContractUrl,
    ...additionalRentContracts.map((c) => `${c.url || ''}|${c.num || ''}|${c.start || ''}|${c.exp || ''}|${c.amount || ''}`),
  ]
    .filter(Boolean)
    .join(',');
  return { ...formData, rentContractUrl };
}

/** Body for PUT /api/work-schedules (atomic replace of the branch schedules). */
export function buildSchedulesPayload(branchId: string, schedules: ScheduleDraft[]) {
  return {
    branchId,
    schedules: schedules
      .filter((s) => s.name.trim())
      .map((s) => ({
        name: s.name.trim(),
        shiftType: s.shiftType,
        startTime: s.shiftType === 'FLEXIBLE' ? null : s.startTime || null,
        endTime: s.shiftType === 'FLEXIBLE' ? null : s.endTime || null,
        startTime2: s.shiftType === 'TWO_SHIFTS' ? s.startTime2 || null : null,
        endTime2: s.shiftType === 'TWO_SHIFTS' ? s.endTime2 || null : null,
        workDays: s.workDays || null,
        flexibleHours: s.shiftType === 'FLEXIBLE' ? (s.flexibleHours === '' ? 0 : Number(s.flexibleHours)) : null,
        isExemptFromAttendance: s.isExemptFromAttendance,
      })),
  };
}

/** Maps GET /api/branches/[id] to the form state. */
export function branchToForm(b: BranchResponse): { formData: BranchFormData; rentContracts: RentContractDraft[]; schedules: ScheduleDraft[] } {
  const formData = { ...EMPTY_BRANCH_FORM };
  (Object.keys(EMPTY_BRANCH_FORM) as (keyof BranchFormData)[]).forEach((key) => {
    const v = b[key];
    if (v === null || v === undefined) return;
    formData[key] = DATE_FIELDS.includes(key) ? toDateInputValue(String(v)) : String(v);
  });
  if (!formData.rentPaymentType) formData.rentPaymentType = 'ANNUAL';

  let rentContracts: RentContractDraft[] = [];
  const urls = String(b.rentContractUrl ?? '').split(',').filter(Boolean);
  formData.rentContractUrl = urls[0] && !urls[0].includes('|') ? urls[0] : '';
  const extra = formData.rentContractUrl ? urls.slice(1) : urls;
  rentContracts = extra.map((item) => {
    if (item.includes('|')) {
      const [url = '', num = '', start = '', exp = '', amount = ''] = item.split('|');
      return { id: crypto.randomUUID(), url, num, start, exp, amount };
    }
    return { id: crypto.randomUUID(), url: item, num: '', start: '', exp: '', amount: '' };
  });

  const schedules: ScheduleDraft[] = (b.workSchedules ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    shiftType: s.shiftType === 'TWO_SHIFTS' || s.shiftType === 'FLEXIBLE' ? s.shiftType : 'ONE_SHIFT',
    startTime: s.startTime || '',
    endTime: s.endTime || '',
    startTime2: s.startTime2 || '',
    endTime2: s.endTime2 || '',
    workDays: s.workDays || '',
    flexibleHours: s.flexibleHours != null ? String(s.flexibleHours) : '',
    isExemptFromAttendance: !!s.isExemptFromAttendance,
  }));

  return { formData, rentContracts, schedules };
}

const WEEK_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const SHIFT_OPTIONS: { value: ShiftType; label: string }[] = [
  { value: 'ONE_SHIFT', label: 'فترة واحدة' },
  { value: 'TWO_SHIFTS', label: 'فترتين' },
  { value: 'FLEXIBLE', label: 'دوام مرن' },
];

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

interface BranchFormFieldsProps {
  formData: BranchFormData;
  setFormData: React.Dispatch<React.SetStateAction<BranchFormData>>;
  companies: NamedOption[];
  rentContracts: RentContractDraft[];
  setRentContracts: React.Dispatch<React.SetStateAction<RentContractDraft[]>>;
  schedules: ScheduleDraft[];
  setSchedules: React.Dispatch<React.SetStateAction<ScheduleDraft[]>>;
}

type ChangeEvent = SelectChangeEvent | React.ChangeEvent<HTMLInputElement>;

export function BranchFormFields({ formData, setFormData, companies, rentContracts, setRentContracts, schedules, setSchedules }: BranchFormFieldsProps) {
  const [adminCache, setAdminCache] = useState<{ companyId: string; list: NamedOption[] }>({ companyId: '', list: [] });
  const companyId = formData.companyId;
  const administrations = companyId && adminCache.companyId === companyId ? adminCache.list : [];

  // Administrations of the selected company.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    fetch(`/api/administrations?companyId=${encodeURIComponent(companyId)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as unknown) : []))
      .then((d) => {
        if (!cancelled) setAdminCache({ companyId, list: Array.isArray(d) ? (d as NamedOption[]) : [] });
      })
      .catch(() => {
        if (!cancelled) setAdminCache({ companyId, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const handleChange = (e: ChangeEvent) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      if (name === 'nameArabic') return { ...prev, nameArabic: value, nameEnglish: transliterateArabicToEnglish(value) };
      // A different company invalidates the selected administration.
      if (name === 'companyId') return { ...prev, companyId: value, administrationId: value === prev.companyId ? prev.administrationId : '' };
      return { ...prev, [name]: value };
    });
  };

  const updateSchedule = <K extends keyof ScheduleDraft>(id: string, field: K, value: ScheduleDraft[K]) =>
    setSchedules((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  const updateRent = (id: string, field: keyof Omit<RentContractDraft, 'id'>, value: string) =>
    setRentContracts((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: value } : a)));

  return (
    <>
      {/* ── 1. البيانات الأساسية ── */}
      <Section title="البيانات الأساسية" icon={<GitBranch size={16} className="text-violet-600" />} badge="مطلوب">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="md:col-span-1">
            <SearchableSelect name="companyId" value={formData.companyId} onChange={handleChange}
              label="الشركة التابع لها" required accentColor="violet"
              options={companies.map((c) => ({ label: c.nameArabic, value: c.id }))} />
          </div>
          <div className="md:col-span-1">
            <SearchableSelect name="administrationId" value={formData.administrationId} onChange={handleChange}
              label="الإدارة التابع لها" accentColor="violet"
              options={administrations.map((a) => ({ label: a.nameArabic, value: a.id }))} />
          </div>
          <Field name="nameArabic" value={formData.nameArabic} onChange={handleChange} label="اسم الفرع بالعربية" required />
          <Field name="nameEnglish" value={formData.nameEnglish} onChange={handleChange} label="اسم الفرع بالإنجليزية" />
        </div>
      </Section>

      {/* ── 2. العنوان ── */}
      <Section title="العنوان" icon={<MapPin size={16} className="text-blue-500" />} badge="الموقع الجغرافي">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Field name="city" value={formData.city} onChange={handleChange} label="المدينة" />
          <Field name="district" value={formData.district} onChange={handleChange} label="الحي" />
          <Field name="street" value={formData.street} onChange={handleChange} label="الشارع" />
          <Field name="branchCode" value={formData.branchCode} onChange={handleChange} label="كود الفرع" placeholder="BR-001" />
          <div className="lg:col-span-4">
            <Field name="locationUrl" value={formData.locationUrl} onChange={handleChange} label="(رابط الموقع) جوجل ماب" placeholder="https://maps.google.com/..." type="url" />
          </div>
        </div>
      </Section>

      {/* ── 3. رخصة البلدية ── */}
      <Section title="رخصة البلدية (الرخصة التجارية)" icon={<FileText size={16} className="text-amber-500" />} badge="تنبيه انتهاء">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Field name="munLicenseNum" value={formData.munLicenseNum} onChange={handleChange} label="رقم الرخصة" />
          <Field name="munLicenseStart" value={formData.munLicenseStart} onChange={handleChange} label="تاريخ البداية" type="date" />
          <Field name="munLicenseExp" value={formData.munLicenseExp} onChange={handleChange} label="تاريخ الانتهاء" type="date" />
          <Field name="munLicenseCost" value={formData.munLicenseCost} onChange={handleChange} label="تكلفة تجديد الرخصة (ر.س)" type="number" min={0} step="0.01" placeholder="0.00" />
          <div className="md:col-span-2 lg:col-span-4">
            <FileUploadField name="munLicenseUrl" value={formData.munLicenseUrl} onChange={handleChange} label="مرفق رخصة البلدية" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
      </Section>

      {/* ── 4. رخصة الدفاع المدني ── */}
      <Section title="رخصة الدفاع المدني" icon={<ShieldCheck size={16} className="text-red-500" />} badge="تنبيه انتهاء">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Field name="civilDefenseNum" value={formData.civilDefenseNum} onChange={handleChange} label="رقم الرخصة" />
          <Field name="civilDefenseStart" value={formData.civilDefenseStart} onChange={handleChange} label="تاريخ البداية" type="date" />
          <Field name="civilDefenseExp" value={formData.civilDefenseExp} onChange={handleChange} label="تاريخ الانتهاء" type="date" />
          <Field name="civilDefenseCost" value={formData.civilDefenseCost} onChange={handleChange} label="تكلفة تجديد الرخصة (ر.س)" type="number" min={0} step="0.01" placeholder="0.00" />
          <div className="md:col-span-2 lg:col-span-4">
            <FileUploadField name="civilDefenseUrl" value={formData.civilDefenseUrl} onChange={handleChange} label="مرفق رخصة الدفاع المدني" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
      </Section>

      {/* ── 5. عقد الإيجار ── */}
      <Section title="عقود الإيجار المرتبطة بالفرع" icon={<Building2 size={16} className="text-emerald-500" />} badge="تنبيه انتهاء">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Field name="rentContractNum" value={formData.rentContractNum} onChange={handleChange} label="رقم العقد" />
          <Field name="rentContractStart" value={formData.rentContractStart} onChange={handleChange} label="تاريخ البداية" type="date" />
          <Field name="rentContractExp" value={formData.rentContractExp} onChange={handleChange} label="تاريخ الانتهاء" type="date" />
          <Field name="rentOwnerName" value={formData.rentOwnerName} onChange={handleChange} label="اسم المؤجر" />
          <Field name="rentOwnerPhone" value={formData.rentOwnerPhone} onChange={handleChange} label="رقم التواصل" type="tel" />
          <SearchableSelect name="rentContractType" value={formData.rentContractType} onChange={handleChange} label="تصنيف العقد" accentColor="blue" options={[
            { label: 'إيجار الفرع', value: 'BRANCH_RENT' },
            { label: 'سكن العمال', value: 'WORKERS_HOUSING' },
            { label: 'مستودع', value: 'WAREHOUSE' },
            { label: 'سكن خاص', value: 'PRIVATE_HOUSING' },
          ]} />

          <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-slate-100">
            <Field name="rentContractAmount" value={formData.rentContractAmount} onChange={handleChange} label="قيمة العقد (المبلغ الاجمالي)" type="number" placeholder="مثال: 1000000" min={0} step="0.01" />

            <SearchableSelect name="rentPaymentType" value={formData.rentPaymentType} onChange={handleChange} label="نوع السداد" accentColor="emerald" options={[
              { label: 'سنوي (دفعة واحدة)', value: 'ANNUAL' },
              { label: 'نصف سنوي (دفعتين)', value: 'SEMI_ANNUAL' },
              { label: 'ربع سنوي (4 دفعات)', value: 'QUARTERLY' },
              { label: 'شهري (12 دفعة)', value: 'MONTHLY' },
            ]} />

            <Field name="rentPaymentCount" value={formData.rentPaymentCount} onChange={handleChange} label="عدد الدفعات المتوقعة" type="number" placeholder="سيتم تقسيم المبالغ عليها" min={0} step="1" />
          </div>

          <div className="lg:col-span-3 pt-2">
            <FileUploadField name="rentContractUrl" value={formData.rentContractUrl} onChange={handleChange} label="مرفق عقد الإيجار الأساسي" accept=".pdf,.jpg,.jpeg,.png" />

            {rentContracts.length > 0 && (
              <div className="mt-4 space-y-4">
                {rentContracts.map((att) => (
                  <div key={att.id} className="relative bg-slate-50 border border-slate-200 rounded-[1rem] p-4">
                    <button type="button" aria-label="حذف عقد الإيجار الإضافي" onClick={() => setRentContracts((prev) => prev.filter((a) => a.id !== att.id))}
                      className="absolute top-2 left-2 w-8 h-8 flex items-center justify-center bg-white rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 shadow-sm border border-slate-200 transition-all z-10">
                      <Trash2 size={16} />
                    </button>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                      <Field name={`num_${att.id}`} value={att.num} onChange={(e) => updateRent(att.id, 'num', e.target.value)} label="رقم العقد" />
                      <Field name={`start_${att.id}`} value={att.start} onChange={(e) => updateRent(att.id, 'start', e.target.value)} label="تاريخ البداية" type="date" />
                      <Field name={`exp_${att.id}`} value={att.exp} onChange={(e) => updateRent(att.id, 'exp', e.target.value)} label="تاريخ الانتهاء" type="date" />
                      <Field name={`amount_${att.id}`} value={att.amount} onChange={(e) => updateRent(att.id, 'amount', e.target.value)} label="القيمة الإجمالية" type="number" min={0} step="0.01" />
                    </div>

                    <FileUploadField name={`rentContract_${att.id}`} value={att.url} onChange={(e) => updateRent(att.id, 'url', e.target.value)} label="مرفق عقد الإيجار الإضافي" accept=".pdf,.jpg,.jpeg,.png" />
                  </div>
                ))}
              </div>
            )}

            <button type="button"
              onClick={() => setRentContracts((prev) => [...prev, { id: crypto.randomUUID(), url: '', num: '', start: '', exp: '', amount: '' }])}
              className="mt-4 w-full py-4 border-2 border-dashed border-emerald-200 text-emerald-600 font-extrabold text-[13px] rounded-2xl hover:bg-emerald-50 transition flex items-center justify-center gap-2">
              <Plus size={18} /> إضافة مرفق عقد إيجار آخر
            </button>
          </div>
        </div>
      </Section>

      {/* ── 6. عقد النفايات ── */}
      <Section title="عقد النفايات" icon={<Trash2 size={16} className="text-slate-500" />} badge="تنبيه انتهاء">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Field name="wasteContractNum" value={formData.wasteContractNum} onChange={handleChange} label="رقم العقد" />
          <Field name="wasteContractStart" value={formData.wasteContractStart} onChange={handleChange} label="تاريخ البداية" type="date" />
          <Field name="wasteContractExp" value={formData.wasteContractExp} onChange={handleChange} label="تاريخ الانتهاء" type="date" />
          <Field name="wasteCompanyName" value={formData.wasteCompanyName} onChange={handleChange} label="اسم شركة النفايات" />
          <Field name="wasteCompanyPhone" value={formData.wasteCompanyPhone} onChange={handleChange} label="رقم التواصل" type="tel" />
          <FileUploadField name="wasteContractUrl" value={formData.wasteContractUrl} onChange={handleChange} label="مرفق عقد النفايات" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" />
        </div>
      </Section>

      {/* ── 7. عقد صيانة السلامة ── */}
      <Section title="عقد صيانة السلامة" icon={<ShieldCheck size={16} className="text-orange-500" />} badge="تنبيه انتهاء">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Field name="safetyContractNum" value={formData.safetyContractNum} onChange={handleChange} label="رقم العقد" />
          <Field name="safetyContractStart" value={formData.safetyContractStart} onChange={handleChange} label="تاريخ البداية" type="date" />
          <Field name="safetyContractExp" value={formData.safetyContractExp} onChange={handleChange} label="تاريخ الانتهاء" type="date" />
          <Field name="safetyCompanyName" value={formData.safetyCompanyName} onChange={handleChange} label="اسم شركة السلامة" />
          <Field name="safetyCompanyPhone" value={formData.safetyCompanyPhone} onChange={handleChange} label="رقم التواصل" type="tel" />
          <div className="lg:col-span-3">
            <FileUploadField name="safetyContractUrl" value={formData.safetyContractUrl} onChange={handleChange} label="مرفق عقد صيانة السلامة" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
      </Section>

      {/* ── 8. عقد صيانة الكاميرات ── */}
      <Section title="عقد صيانة الكاميرات" icon={<Camera size={16} className="text-indigo-500" />} badge="تنبيه انتهاء">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Field name="cameraContractNum" value={formData.cameraContractNum} onChange={handleChange} label="رقم العقد" />
          <Field name="cameraContractStart" value={formData.cameraContractStart} onChange={handleChange} label="تاريخ البداية" type="date" />
          <Field name="cameraContractExp" value={formData.cameraContractExp} onChange={handleChange} label="تاريخ الانتهاء" type="date" />
          <Field name="cameraCompanyName" value={formData.cameraCompanyName} onChange={handleChange} label="اسم الشركة" />
          <Field name="cameraCompanyPhone" value={formData.cameraCompanyPhone} onChange={handleChange} label="رقم التواصل" type="tel" />
          <div className="lg:col-span-3">
            <FileUploadField name="cameraContractUrl" value={formData.cameraContractUrl} onChange={handleChange} label="مرفق عقد صيانة الكاميرات" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
      </Section>

      {/* ── 9. المرفقات ── */}
      <Section title="مرفقات أخرى هامة" icon={<Paperclip size={16} className="text-slate-500" />} badge="">
        <div className="bg-blue-50 border border-blue-100 rounded-[1.25rem] p-5 mb-8 flex items-start gap-4 shadow-sm">
          <div className="bg-white p-2 text-blue-500 rounded-xl shadow-sm border border-blue-100/50">
            <AlertCircle size={20} className="shrink-0" />
          </div>
          <div>
            <p className="text-[14px] font-black text-blue-900 mb-1">إرفاق المستندات</p>
            <p className="text-[12px] font-bold text-blue-700/80 leading-relaxed">
              اختر الملفات من جهازك أو اسحبها وأفلتها في المنطقة المخصصة.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8 p-6 bg-slate-50/50 rounded-3xl border border-slate-100/60">
          <FileUploadField name="buildingLicenseUrl" value={formData.buildingLicenseUrl} onChange={handleChange} label="📄 رخصة البناء" accept=".pdf,.jpg,.jpeg,.png" />
          <FileUploadField name="blueprintsUrl" value={formData.blueprintsUrl} onChange={handleChange} label="📐 المخططات" accept=".pdf,.jpg,.jpeg,.png,.dwg" />
          <FileUploadField name="engineeringHandoverUrl" value={formData.engineeringHandoverUrl} onChange={handleChange} label="🏗️ شهادة الاستلام من المكتب الهندسي" accept=".pdf,.jpg,.jpeg,.png" />
          <FileUploadField name="installationCompleteUrl" value={formData.installationCompleteUrl} onChange={handleChange} label="✅ شهادة انهاء التركيبات" accept=".pdf,.jpg,.jpeg,.png" />
          <div className="md:col-span-2 mt-4 pt-6 border-t border-slate-200/60">
            <FileUploadField name="externalPhotosUrls" value={formData.externalPhotosUrls} onChange={handleChange} label="📸 صور المحل من الخارج" accept=".jpg,.jpeg,.png,.webp" />
          </div>
        </div>
      </Section>

      {/* ── 10. جداول العمل ── */}
      <Section title="جداول العمل / الشفتات" icon={<Clock size={16} className="text-teal-500" />} badge="نظام الدوام">
        <div className="bg-teal-50 border border-teal-100 rounded-[1.25rem] p-5 mb-8 flex items-start gap-4 shadow-sm">
          <div className="bg-white p-2 text-teal-500 rounded-xl shadow-sm border border-teal-100/50">
            <Clock size={20} className="shrink-0" />
          </div>
          <div>
            <p className="text-[14px] font-black text-teal-900 mb-1">تحديد جداول العمل</p>
            <p className="text-[12px] font-bold text-teal-700/80 leading-relaxed">
              أضف جداول العمل المتاحة لهذا الفرع. سيتم عرضها عند إضافة موظف مرتبط بهذا الفرع.
            </p>
          </div>
        </div>

        <div className="space-y-4 mb-6">
          {schedules.map((schedule) => (
            <div key={schedule.id} className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-black text-teal-700 bg-teal-50 px-3 py-1 rounded-lg">جدول عمل</span>
                <button type="button" aria-label="حذف جدول العمل" onClick={() => setSchedules((prev) => prev.filter((s) => s.id !== schedule.id))}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500 transition">
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <p className="text-[12px] font-extrabold text-slate-700 mb-3 block">نظام الدوام</p>
                  <div role="radiogroup" aria-label="نظام الدوام" className="flex bg-slate-200/50 p-1.5 rounded-xl gap-1 w-full max-w-md mb-5 border border-slate-200/60 shadow-inner">
                    {SHIFT_OPTIONS.map((opt) => (
                      <button key={opt.value} type="button" role="radio" aria-checked={schedule.shiftType === opt.value}
                        onClick={() => updateSchedule(schedule.id, 'shiftType', opt.value)}
                        className={`flex-1 py-2.5 rounded-lg text-[13px] font-bold transition-all ${schedule.shiftType === opt.value ? 'bg-white text-teal-600 shadow-sm border border-slate-200/50' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2 mb-4">
                    <input
                      type="checkbox"
                      id={`exempt-${schedule.id}`}
                      checked={schedule.isExemptFromAttendance}
                      onChange={(e) => updateSchedule(schedule.id, 'isExemptFromAttendance', e.target.checked)}
                      className="w-4 h-4 text-teal-600 rounded focus:ring-teal-500 cursor-pointer"
                    />
                    <label htmlFor={`exempt-${schedule.id}`} className="text-[13px] font-bold text-slate-700 cursor-pointer select-none">
                      إعفاء الموظفين في هذا الجدول من البصمة / التحضير التلقائي
                    </label>
                  </div>

                  <Field name={`name_${schedule.id}`} value={schedule.name} onChange={(e) => updateSchedule(schedule.id, 'name', e.target.value)}
                    label="اسم جدول العمل" placeholder="مثال: دوام نهاري منتظم" required />
                </div>

                {schedule.shiftType === 'FLEXIBLE' ? (
                  <div className="md:col-span-2">
                    <Field name={`flex_${schedule.id}`} value={schedule.flexibleHours} onChange={(e) => updateSchedule(schedule.id, 'flexibleHours', e.target.value)}
                      label="عدد ساعات العمل المرنة" type="number" placeholder="مثال: 8" min={0} step="0.5" />
                  </div>
                ) : (
                  <>
                    <div className="md:col-span-2 font-black text-teal-700/60 text-[11px] uppercase tracking-widest mb-[-10px] mt-2">
                      {schedule.shiftType === 'TWO_SHIFTS' ? 'الفترة الأولى' : 'أوقات الدوام'}
                    </div>

                    <Field name={`start_${schedule.id}`} value={schedule.startTime} onChange={(e) => updateSchedule(schedule.id, 'startTime', e.target.value)}
                      label="وقت بداية الدوام" type="time" />
                    <Field name={`end_${schedule.id}`} value={schedule.endTime} onChange={(e) => updateSchedule(schedule.id, 'endTime', e.target.value)}
                      label="وقت نهاية الدوام" type="time" />

                    {schedule.shiftType === 'TWO_SHIFTS' && (
                      <>
                        <div className="md:col-span-2 font-black text-teal-700/60 text-[11px] uppercase tracking-widest mb-[-10px] mt-4 border-t border-slate-200/60 pt-6">الفترة الثانية</div>
                        <Field name={`start2_${schedule.id}`} value={schedule.startTime2} onChange={(e) => updateSchedule(schedule.id, 'startTime2', e.target.value)} label="وقت بداية الفترة الثانية" type="time" />
                        <Field name={`end2_${schedule.id}`} value={schedule.endTime2} onChange={(e) => updateSchedule(schedule.id, 'endTime2', e.target.value)} label="وقت نهاية الفترة الثانية" type="time" />
                      </>
                    )}
                  </>
                )}
                <div className="md:col-span-2">
                  <p className="text-[12px] font-extrabold text-slate-700 mb-3 block">أيام العمل <span className="text-[10px] text-slate-400 font-bold">(اضغط لتحديد/إلغاء)</span></p>
                  <div className="flex flex-wrap gap-2">
                    {WEEK_DAYS.map((day) => {
                      const current = schedule.workDays.split(',').map((d) => d.trim()).filter(Boolean);
                      const selected = current.includes(day);
                      return (
                        <button key={day} type="button" aria-pressed={selected}
                          onClick={() => {
                            const updated = selected ? current.filter((d) => d !== day) : [...current, day];
                            updateSchedule(schedule.id, 'workDays', updated.join(', '));
                          }}
                          className={`px-4 py-2.5 rounded-xl text-[13px] font-bold border-2 transition-all ${
                            selected
                              ? 'bg-teal-500 text-white border-teal-500 shadow-md'
                              : 'bg-white text-slate-500 border-slate-200 hover:border-teal-300 hover:text-teal-600'
                          }`}
                        >{day}</button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button type="button" onClick={() => setSchedules((prev) => [...prev, newScheduleDraft()])}
          className="w-full py-4 border-2 border-dashed border-teal-200 text-teal-600 font-bold text-[13px] rounded-2xl hover:bg-teal-50 hover:border-teal-300 transition flex items-center justify-center gap-2">
          <Plus size={18} /> إضافة جدول عمل
        </button>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small UI components
// ---------------------------------------------------------------------------

function Section({ title, badge, icon, children }: { title: string; badge: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-visible">
      <div className="px-8 py-5 border-b border-slate-100 flex items-center gap-3">
        <span className="w-9 h-9 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center">{icon}</span>
        <h2 className="font-extrabold text-[15px] text-slate-800">{title}</h2>
        {badge && <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 px-2.5 py-1 rounded-lg">{badge}</span>}
      </div>
      <div className="p-8">{children}</div>
    </section>
  );
}

interface FieldProps {
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: number;
  step?: string;
}

function Field({ name, value, onChange, label, type = 'text', required = false, placeholder, min, step }: FieldProps) {
  const id = `branch-field-${name}`;
  return (
    <div className="flex flex-col gap-2 group">
      <label htmlFor={id} className="text-[12px] font-extrabold text-slate-700 group-focus-within:text-violet-600 transition-colors">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input id={id} type={type} name={name} value={value} onChange={onChange} required={required} placeholder={placeholder} min={min} step={step}
        {...(type === 'date' || type === 'time' || type === 'url' ? { dir: 'ltr' } : {})}
        className={`px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-violet-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-violet-100 transition-all hover:bg-slate-100 ${type === 'date' || type === 'time' ? 'text-right' : ''}`} />
    </div>
  );
}
