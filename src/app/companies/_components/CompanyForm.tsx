"use client";

// Shared fields for the "new company" and "edit company" forms (private folder: not routed).

import React, { useEffect, useState } from 'react';
import { Building, Link2 } from 'lucide-react';
import FileUploadField from '@/components/FileUploadField';
import { transliterateArabicToEnglish } from '@/lib/transliterate';

export interface CompanyFormData {
  nameArabic: string;
  nameEnglish: string;
  unifiedNumber: string;
  commercialRegNum: string;
  commercialRegUrl: string;
  commercialRegDate: string;
  commercialRegExp: string;
  taxNumber: string;
  molEstablishmentNumber: string;
  gosiEstablishmentNumber: string;
  taxCertificateUrl: string;
  nationalAddress: string;
  nationalAddressUrl: string;
  establishmentDeedUrl: string;
  trademarkNumber: string;
  trademarkRegDate: string;
  trademarkExpDate: string;
  trademarkCertUrl: string;
  /** رقم المنشأة في الجوازات (700) المستخدم في مقيم. */
  moiNumber: string;
  /** GovPlatform.id of the Muqeem account ('' = not linked). */
  muqeemPlatformId: string;
}

export const EMPTY_COMPANY_FORM: CompanyFormData = {
  nameArabic: '',
  nameEnglish: '',
  unifiedNumber: '',
  commercialRegNum: '',
  commercialRegUrl: '',
  commercialRegDate: '',
  commercialRegExp: '',
  taxNumber: '',
  molEstablishmentNumber: '',
  gosiEstablishmentNumber: '',
  taxCertificateUrl: '',
  nationalAddress: '',
  nationalAddressUrl: '',
  establishmentDeedUrl: '',
  trademarkNumber: '',
  trademarkRegDate: '',
  trademarkExpDate: '',
  trademarkCertUrl: '',
  moiNumber: '',
  muqeemPlatformId: '',
};

interface CompanyFormFieldsProps {
  mode: 'new' | 'edit';
  formData: CompanyFormData;
  setFormData: React.Dispatch<React.SetStateAction<CompanyFormData>>;
}

export function CompanyFormFields({ mode, formData, setFormData }: CompanyFormFieldsProps) {
  const set = (field: keyof CompanyFormData) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setFormData((prev) => ({ ...prev, [field]: value }));
  };
  const isNew = mode === 'new';

  return (
    <>
      {/* SEGMENT 1: Basic Info */}
      <div className="relative pb-8 scroll-mt-32">
        <div className="flex items-center gap-4 mb-10">
          <h2 className="text-[1.3rem] font-black text-slate-900">البيانات الأساسية للكيان</h2>
          <span className="text-[11px] font-black text-slate-500 bg-slate-100 px-3 py-1.5 rounded-xl">مطلوب</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
          <PremiumInput
            name="nameArabic"
            label="الاسم القانوني للشركة (بالعربية)"
            placeholder={isNew ? 'مؤسسة التقنية الرائدة' : undefined}
            required
            value={formData.nameArabic}
            onChange={(e) => {
              const arName = e.target.value;
              setFormData((prev) => (isNew ? { ...prev, nameArabic: arName, nameEnglish: transliterateArabicToEnglish(arName) } : { ...prev, nameArabic: arName }));
            }}
            icon={<Building size={18} className="text-slate-400" />}
          />
          <PremiumInput
            name="nameEnglish"
            label={isNew ? 'الاسم بالإنجليزية (مترجم آلياً)' : 'الاسم بالإنجليزية (اختياري)'}
            placeholder={isNew ? 'Leading Tech Inc' : undefined}
            value={formData.nameEnglish}
            onChange={set('nameEnglish')}
          />
        </div>
      </div>

      {/* SEGMENT 2: Legal & Registration */}
      <div className="relative pb-8 pt-8 border-t border-slate-100 scroll-mt-32">
        <div className="flex items-center gap-4 mb-10">
          <h2 className="text-[1.3rem] font-black text-slate-900">التراخيص والتسجيل</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
          <PremiumInput name="unifiedNumber" label="الرقم الموحد" placeholder={isNew ? '700XXXXXXX' : undefined} value={formData.unifiedNumber} onChange={set('unifiedNumber')} />
          <PremiumInput name="commercialRegNum" label="رقم السجل التجاري" placeholder={isNew ? '1010XXXXXX' : undefined} value={formData.commercialRegNum} onChange={set('commercialRegNum')} />
          <PremiumInput name="commercialRegDate" label="تاريخ بداية السجل / النشاط" type="date" value={formData.commercialRegDate} onChange={set('commercialRegDate')} />
          <PremiumInput name="commercialRegExp" label="موعد التأكيد السنوي للسجل التجاري" type="date" required value={formData.commercialRegExp} onChange={set('commercialRegExp')} />

          <div className="md:col-span-2">
            <FileUploadField label="مرفق السجل التجاري" name="commercialRegUrl" value={formData.commercialRegUrl} onChange={set('commercialRegUrl')} accept=".pdf,.jpg,.jpeg,.png" />
          </div>

          <PremiumInput name="taxNumber" label="الرقم الضريبي" placeholder={isNew ? '300XXXXXXXXXXXX' : undefined} value={formData.taxNumber} onChange={set('taxNumber')} />
          <div />
          <PremiumInput name="molEstablishmentNumber" label="رقم المنشأة في وزارة الموارد البشرية" value={formData.molEstablishmentNumber} onChange={set('molEstablishmentNumber')} />
          <PremiumInput name="gosiEstablishmentNumber" label="رقم المنشأة في التأمينات الاجتماعية (GOSI)" value={formData.gosiEstablishmentNumber} onChange={set('gosiEstablishmentNumber')} />
          <div className="md:col-span-2">
            <FileUploadField label="مرفق صورة الشهادة الضريبية" name="taxCertificateUrl" value={formData.taxCertificateUrl} onChange={set('taxCertificateUrl')} accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
      </div>

      {/* SEGMENT 3: National Address */}
      <div className="relative pb-8 pt-8 border-t border-slate-100 scroll-mt-32">
        <div className="flex items-center gap-4 mb-10">
          <h2 className="text-[1.3rem] font-black text-slate-900">العنوان الوطني</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
          <PremiumInput name="nationalAddress" label="العنوان الوطني (الرقم المختصر)" placeholder={isNew ? 'RRDD4433' : undefined} value={formData.nationalAddress} onChange={set('nationalAddress')} />
          <FileUploadField label="مرفق العنوان الوطني" name="nationalAddressUrl" value={formData.nationalAddressUrl} onChange={set('nationalAddressUrl')} accept=".pdf,.jpg,.jpeg,.png" />
        </div>
      </div>

      {/* SEGMENT 4: Legal Docs & Trademark */}
      <div className="relative pb-8 pt-8 border-t border-slate-100 scroll-mt-32">
        <div className="flex items-center gap-4 mb-10">
          <h2 className="text-[1.3rem] font-black text-slate-900">المستندات والعلامة التجارية</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
          <div className="md:col-span-2">
            <FileUploadField label="عقد التأسيس" name="establishmentDeedUrl" value={formData.establishmentDeedUrl} onChange={set('establishmentDeedUrl')} accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" />
          </div>

          <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-10 pt-4 bg-slate-50/50 p-6 rounded-[2rem] border border-slate-100">
            <PremiumInput name="trademarkNumber" label="رقم تسجيل العلامة التجارية" value={formData.trademarkNumber} onChange={set('trademarkNumber')} />
            <PremiumInput name="trademarkRegDate" label="تاريخ بداية التسجيل" type="date" value={formData.trademarkRegDate} onChange={set('trademarkRegDate')} />
            <PremiumInput name="trademarkExpDate" label="تاريخ انتهاء الحماية" type="date" value={formData.trademarkExpDate} onChange={set('trademarkExpDate')} />
            <div className="md:col-span-3 mt-2">
              <FileUploadField label="مرفق شهادة تسجيل العلامة التجارية" name="trademarkCertUrl" value={formData.trademarkCertUrl} onChange={set('trademarkCertUrl')} accept=".pdf,.jpg,.jpeg,.png" />
            </div>
          </div>
        </div>
      </div>

      {/* SEGMENT 5: Muqeem link */}
      <MuqeemLinkSection formData={formData} setFormData={setFormData} />
    </>
  );
}

interface PremiumInputProps {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  icon?: React.ReactNode;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

function PremiumInput({ name, label, type = 'text', placeholder, required = false, icon, value, onChange }: PremiumInputProps) {
  const id = `company-field-${name}`;
  return (
    <div className="flex flex-col gap-2 relative group w-full">
      <label htmlFor={id} className="text-[12px] font-extrabold text-slate-800 transition-colors group-hover:text-blue-600">
        {label} {required && <span className="text-red-500 font-bold">*</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          required={required}
          {...(type === 'date' ? { dir: 'ltr', lang: 'en' } : {})}
          className={`w-full px-5 py-4 pb-[14px] text-[14px] font-black bg-[#F4F4F6] border-2 border-transparent focus:bg-white rounded-[1.25rem] focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 hover:bg-[#EFEFF1] transition-all text-slate-800 placeholder:text-slate-400 placeholder:font-bold appearance-none ${type === 'date' ? 'text-right' : ''}`}
        />
        {icon && <div className="absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none">{icon}</div>}
      </div>
    </div>
  );
}

interface MuqeemPlatformOption {
  id: string;
  platformName: string;
}

/** Loads the Muqeem-like gov-platform accounts (names only) and whether this user may change the link. */
function useMuqeemPlatforms() {
  const [state, setState] = useState<{ loading: boolean; platforms: MuqeemPlatformOption[]; canLink: boolean; error: boolean }>({
    loading: true,
    platforms: [],
    canLink: false,
    error: false,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/integrations/muqeem/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { platforms?: MuqeemPlatformOption[]; canLink?: boolean };
        if (!cancelled) setState({ loading: false, platforms: data.platforms ?? [], canLink: !!data.canLink, error: false });
      } catch {
        if (!cancelled) setState({ loading: false, platforms: [], canLink: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function MuqeemLinkSection({ formData, setFormData }: Pick<CompanyFormFieldsProps, 'formData' | 'setFormData'>) {
  const { loading, platforms, canLink, error } = useMuqeemPlatforms();
  const moi = formData.moiNumber.replace(/s/g, '');
  // ASSUMPTION (warning only, never blocks saving): the Muqeem MOI number is 10 digits starting with 7.
  const moiWarning = moi && !/^7d{9}$/.test(moi) ? 'يتكون رقم المنشأة في الجوازات عادةً من 10 أرقام ويبدأ بالرقم 7' : null;
  const currentMissing = !!formData.muqeemPlatformId && !platforms.some((p) => p.id === formData.muqeemPlatformId);
  const linked = !!moi && !!formData.muqeemPlatformId;

  return (
    <div className="relative pb-8 pt-8 border-t border-slate-100 scroll-mt-32">
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-[1.3rem] font-black text-slate-900">الربط مع مقيم</h2>
        <span className={`text-[11px] font-black px-3 py-1.5 rounded-xl ${linked ? 'text-emerald-700 bg-emerald-50' : 'text-slate-500 bg-slate-100'}`}>
          {linked ? 'مربوطة' : 'غير مربوطة'}
        </span>
      </div>
      <p className="text-[12px] font-bold text-slate-500 mb-8 leading-relaxed">
        لتفعيل خدمات مقيم (تأشيرات الخروج والعودة، تجديد الإقامة...) أدخل رقم المنشأة في الجوازات واختر حساب مقيم المحفوظ في خزنة المنصات الحكومية.
        لا تُعرض بيانات الدخول هنا.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
        <div className="flex flex-col gap-2">
          <PremiumInput
            name="moiNumber"
            label="رقم المنشأة في الجوازات (700)"
            placeholder="7XXXXXXXXX"
            value={formData.moiNumber}
            onChange={(e) => {
              const value = e.target.value;
              setFormData((prev) => ({ ...prev, moiNumber: value }));
            }}
          />
          {moiWarning && (
            <p role="status" className="text-[11px] font-bold text-amber-700">
              تنبيه: {moiWarning}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 w-full">
          <label htmlFor="company-field-muqeemPlatformId" className="text-[12px] font-extrabold text-slate-800 flex items-center gap-2">
            <Link2 size={14} className="text-slate-400" /> حساب مقيم (من خزنة المنصات الحكومية)
          </label>
          <select
            id="company-field-muqeemPlatformId"
            name="muqeemPlatformId"
            value={formData.muqeemPlatformId}
            disabled={loading || !canLink}
            onChange={(e) => {
              const value = e.target.value;
              setFormData((prev) => ({ ...prev, muqeemPlatformId: value }));
            }}
            className="w-full px-5 py-4 text-[14px] font-black bg-[#F4F4F6] border-2 border-transparent focus:bg-white rounded-[1.25rem] focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 transition-all text-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <option value="">{loading ? 'جاري التحميل...' : '— بدون ربط —'}</option>
            {currentMissing && <option value={formData.muqeemPlatformId}>الحساب المرتبط حالياً</option>}
            {platforms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.platformName}
              </option>
            ))}
          </select>
          {!loading && !canLink && !error && (
            <p className="text-[11px] font-bold text-slate-500">تغيير حساب مقيم متاح لمدير النظام وصاحب العمل فقط.</p>
          )}
          {!loading && error && <p className="text-[11px] font-bold text-slate-500">تعذر تحميل حسابات مقيم.</p>}
          {!loading && !error && canLink && platforms.length === 0 && (
            <p className="text-[11px] font-bold text-amber-700">
              لا يوجد حساب باسم &quot;مقيم&quot; في خزنة المنصات الحكومية. أضفه أولاً من صفحة المنصات الحكومية.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
