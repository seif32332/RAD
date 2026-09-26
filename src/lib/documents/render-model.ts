// Render model (ADR DOC-01): snapshot values -> display strings. The template lays out exactly
// these strings; it formats nothing. Deterministic: same snapshot + meta -> same model -> same PDF.
import { stripArabicMarks } from './core';
import { formatAmount, formatGregorian, formatHijri, pageNumbering, type Numerals } from './format';
import type { DocumentLanguage } from './types';

export interface BrandSnapshot {
  primaryColor: string;
  numerals: Numerals;
  addressAr: string | null;
  addressEn: string | null;
  phone: string | null;
  email: string | null;
  logoSha256: string | null;
}

export interface SignatureBlock {
  nameAr: string;
  nameEn: string | null;
  titleAr: string;
  titleEn: string | null;
  printImage: boolean;
  printStamp: boolean;
}

export interface RenderMeta {
  typeLabelAr: string;
  typeLabelEn: string;
  number: string;
  issuedDate: string; // YYYY-MM-DD (Riyadh)
  validUntilDate: string | null;
  verifyUrl: string;
  language: DocumentLanguage;
  addresseeAr: string | null;
  addresseeEn: string | null;
  signature: SignatureBlock | null;
  hasLogo: boolean;
}

type Contract = {
  employee: {
    fullNameAr: string; fullNameEn: string | null; employeeNumber: string; nationalityAr: string; nationalityEn: string | null;
    idKind: 'IQAMA' | 'NATIONAL_ID'; idNumber: string; passportNumber: string | null; jobTitleAr: string; jobTitleEn: string | null; joinDate: string;
  };
  company: { legalNameAr: string; legalNameEn: string | null; crNumber: string; unifiedNumber: string | null };
  salary?: { rows: { key: string; labelAr: string; labelEn: string; amount: string }[]; total: string };
  service?: { startDate: string; endDate: string | null; inService: boolean };
};

const DEFAULT_ADDRESSEE = { ar: 'إلى من يهمه الأمر', en: 'To Whom It May Concern' };

export function buildRenderModel(data: Contract, brand: BrandSnapshot, meta: RenderMeta) {
  const n = brand.numerals;
  const e = data.employee;
  const model = {
    doc: {
      language: meta.language,
      numerals: n,
      number: meta.number,
      titleAr: meta.typeLabelAr,
      titleEn: meta.typeLabelEn,
      verifyUrl: meta.verifyUrl,
      issuedGregorianAr: formatGregorian(meta.issuedDate, 'ar', n),
      issuedHijriAr: formatHijri(meta.issuedDate, 'ar', n),
      issuedGregorianEn: formatGregorian(meta.issuedDate, 'en'),
      issuedHijriEn: formatHijri(meta.issuedDate, 'en'),
      validUntilAr: meta.validUntilDate ? formatGregorian(meta.validUntilDate, 'ar', n) : null,
      validUntilEn: meta.validUntilDate ? formatGregorian(meta.validUntilDate, 'en') : null,
      pageNumbering: pageNumbering(n),
      hasLogo: meta.hasLogo,
    },
    company: {
      legalNameAr: data.company.legalNameAr,
      legalNameEn: data.company.legalNameEn,
      crNumber: data.company.crNumber,
      unifiedNumber: data.company.unifiedNumber,
      addressAr: brand.addressAr,
      addressEn: brand.addressEn,
      phone: brand.phone,
      email: brand.email,
      primaryColor: brand.primaryColor,
    },
    addressee: {
      ar: meta.addresseeAr || DEFAULT_ADDRESSEE.ar,
      en: meta.addresseeEn || DEFAULT_ADDRESSEE.en,
    },
    employee: {
      fullNameAr: e.fullNameAr,
      fullNameEn: e.fullNameEn,
      employeeNumber: e.employeeNumber,
      nationalityAr: e.nationalityAr,
      nationalityEn: e.nationalityEn,
      idLabelAr: e.idKind === 'NATIONAL_ID' ? 'هوية وطنية' : 'إقامة',
      idLabelEn: e.idKind === 'NATIONAL_ID' ? 'National ID' : 'Iqama',
      idNumber: e.idNumber,
      passportNumber: e.passportNumber,
      jobTitleAr: e.jobTitleAr,
      jobTitleEn: e.jobTitleEn,
      joinDateAr: formatGregorian(e.joinDate, 'ar', n),
      joinDateEn: formatGregorian(e.joinDate, 'en'),
    },
    salary: data.salary
      ? {
          currencyAr: 'ريال سعودي',
          currencyEn: 'SAR',
          rows: data.salary.rows.map((r) => ({
            labelAr: r.labelAr,
            labelEn: r.labelEn,
            amountText: formatAmount(r.amount, n),
            amountTextEn: formatAmount(r.amount, 'latn'),
          })),
          totalText: formatAmount(data.salary.total, n),
          totalTextEn: formatAmount(data.salary.total, 'latn'),
        }
      : null,
    service: data.service
      ? {
          startAr: formatGregorian(data.service.startDate, 'ar', n),
          startEn: formatGregorian(data.service.startDate, 'en'),
          endAr: data.service.endDate ? formatGregorian(data.service.endDate, 'ar', n) : null,
          endEn: data.service.endDate ? formatGregorian(data.service.endDate, 'en') : null,
          inService: data.service.inService,
        }
      : null,
    signature: meta.signature,
  };
  // Diacritics are never printed (owner decision 2026-09-26; POC §B2).
  return stripArabicMarks(model);
}

export type RenderModel = ReturnType<typeof buildRenderModel>;
