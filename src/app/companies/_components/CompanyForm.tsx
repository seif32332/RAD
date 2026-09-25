"use client";

// Shared fields for the "new company" and "edit company" forms (private folder: not routed).

import React from 'react';
import { Building } from 'lucide-react';
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
