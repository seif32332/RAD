// Document types (SPEC §4.2): each type carries its code, data contract, defaults and roles.
// Pure: the contract builders take an already loaded employee record (see load.ts), so the rules
// are unit tested without a database.
import { z } from 'zod';
import { ROLE_GROUPS } from '@/lib/constants';
import { sumAmounts, toAmountString } from './core';

export type DocumentLanguage = 'ar' | 'ar-en';

// ---------------------------------------------------------------------------
// Loaded records (the only fields a document may ever print)
// ---------------------------------------------------------------------------

export interface EmployeeRecord {
  id: string;
  employeeId: string; // الرقم الوظيفي
  firstNameArabic: string;
  lastNameArabic: string;
  firstNameEnglish: string | null;
  lastNameEnglish: string | null;
  nationality: string;
  iqamaOrIdNumber: string;
  idType: string | null;
  passportNumber: string | null;
  jobTitle: string | null;
  jobTitleEnglish: string | null;
  joinDate: Date;
  basicSalary: number;
  isTerminated: boolean;
  terminationDate: Date | null;
  legalCompanyId: string | null;
  allowances: ReadonlyArray<{ name: string; amount: number; isMonthly: boolean; allowanceType: string | null }>;
}

export interface CompanyRecord {
  id: string;
  nameArabic: string;
  nameEnglish: string | null;
  commercialRegNum: string;
  unifiedNumber: string | null;
}

// ---------------------------------------------------------------------------
// Contract pieces
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.string().regex(/^\d+\.\d{2}$/);

const employeeContract = z.object({
  fullNameAr: z.string().min(1),
  fullNameEn: z.string().min(1).nullable(),
  employeeNumber: z.string().min(1),
  nationalityAr: z.string().min(1),
  nationalityEn: z.string().min(1).nullable(),
  idKind: z.enum(['IQAMA', 'NATIONAL_ID']),
  idNumber: z.string().min(1),
  passportNumber: z.string().min(1).nullable(),
  jobTitleAr: z.string().min(1),
  jobTitleEn: z.string().min(1).nullable(),
  joinDate: isoDate,
});
const companyContract = z.object({
  legalNameAr: z.string().min(1),
  legalNameEn: z.string().min(1).nullable(),
  crNumber: z.string().min(1),
  unifiedNumber: z.string().min(1).nullable(),
});
const salaryContract = z.object({
  rows: z.array(z.object({ key: z.string(), labelAr: z.string(), labelEn: z.string(), amount })).min(1),
  total: amount,
});
const serviceContract = z.object({ startDate: isoDate, endDate: isoDate.nullable(), inService: z.boolean() });

export const paramsSchema = z.object({
  language: z.enum(['ar', 'ar-en']).default('ar'),
  addresseeAr: z.string().trim().max(120).optional(),
  addresseeEn: z.string().trim().max(120).optional(),
});
export type DocumentParams = z.infer<typeof paramsSchema>;

export interface ContractError {
  code: string;
  message: string; // Arabic, shown to HR / the employee
}

export class ContractValidationError extends Error {
  constructor(readonly errors: ContractError[]) {
    super(errors.map((e) => e.message).join(' — '));
  }
}

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

const clean = (s: string | null | undefined) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length ? v : null;
};
const isoDay = (d: Date) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * English nationality for bilingual letters. Radeef stores nationality as Arabic free text
 * (Nationality.label); unknown values return null and a bilingual letter then needs HR to fix the
 * record (a document never guesses).
 */
const NATIONALITY_EN: Record<string, string> = {
  'سعودي': 'Saudi', 'سعودية': 'Saudi', 'السعودية': 'Saudi', 'مصري': 'Egyptian', 'مصرية': 'Egyptian', 'مصر': 'Egyptian',
  'أردني': 'Jordanian', 'أردنية': 'Jordanian', 'الأردن': 'Jordanian', 'سوري': 'Syrian', 'سورية': 'Syrian', 'سوريا': 'Syrian',
  'لبناني': 'Lebanese', 'لبنان': 'Lebanese', 'فلسطيني': 'Palestinian', 'فلسطين': 'Palestinian', 'يمني': 'Yemeni', 'اليمن': 'Yemeni',
  'سوداني': 'Sudanese', 'السودان': 'Sudanese', 'عراقي': 'Iraqi', 'العراق': 'Iraqi', 'مغربي': 'Moroccan', 'المغرب': 'Moroccan',
  'تونسي': 'Tunisian', 'تونس': 'Tunisian', 'جزائري': 'Algerian', 'الجزائر': 'Algerian', 'ليبي': 'Libyan', 'ليبيا': 'Libyan',
  'إماراتي': 'Emirati', 'الإمارات': 'Emirati', 'كويتي': 'Kuwaiti', 'الكويت': 'Kuwaiti', 'قطري': 'Qatari', 'قطر': 'Qatari',
  'بحريني': 'Bahraini', 'البحرين': 'Bahraini', 'عماني': 'Omani', 'عمان': 'Omani', 'هندي': 'Indian', 'الهند': 'Indian',
  'باكستاني': 'Pakistani', 'باكستان': 'Pakistani', 'بنغلاديشي': 'Bangladeshi', 'بنجلاديشي': 'Bangladeshi', 'بنغلاديش': 'Bangladeshi',
  'فلبيني': 'Filipino', 'الفلبين': 'Filipino', 'نيبالي': 'Nepalese', 'نيبال': 'Nepalese', 'سريلانكي': 'Sri Lankan', 'سريلانكا': 'Sri Lankan',
  'إندونيسي': 'Indonesian', 'إندونيسيا': 'Indonesian', 'إثيوبي': 'Ethiopian', 'إثيوبيا': 'Ethiopian', 'كيني': 'Kenyan', 'كينيا': 'Kenyan',
  'أوغندي': 'Ugandan', 'أوغندا': 'Ugandan', 'تركي': 'Turkish', 'تركيا': 'Turkish', 'أفغاني': 'Afghan', 'أفغانستان': 'Afghan',
  'بريطاني': 'British', 'بريطانيا': 'British', 'أمريكي': 'American', 'الولايات المتحدة': 'American', 'كندي': 'Canadian', 'كندا': 'Canadian',
  'فرنسي': 'French', 'فرنسا': 'French', 'ألماني': 'German', 'ألمانيا': 'German', 'نيجيري': 'Nigerian', 'نيجيريا': 'Nigerian',
  'تشادي': 'Chadian', 'تشاد': 'Chadian', 'صومالي': 'Somali', 'الصومال': 'Somali', 'إريتري': 'Eritrean', 'إريتريا': 'Eritrean',
  'ميانماري': 'Myanmar', 'بورمي': 'Myanmar', 'فيتنامي': 'Vietnamese', 'صيني': 'Chinese', 'الصين': 'Chinese',
};
export function nationalityEnglish(ar: string): string | null {
  const key = ar.replace(/\s+/g, ' ').trim().replace(/^ال(?=[^ ]*ي$)/, '');
  return NATIONALITY_EN[ar.trim()] ?? NATIONALITY_EN[key] ?? null;
}

const ALLOWANCE_LABELS: Record<string, { ar: string; en: string }> = {
  HOUSING: { ar: 'بدل السكن', en: 'Housing Allowance' },
  TRANSPORT: { ar: 'بدل النقل', en: 'Transportation Allowance' },
  FOOD: { ar: 'بدل الطعام', en: 'Food Allowance' },
  OTHER: { ar: 'بدلات أخرى', en: 'Other Allowances' },
};

function allowanceKind(a: { name: string; allowanceType: string | null }): keyof typeof ALLOWANCE_LABELS {
  const t = (a.allowanceType ?? '').toUpperCase();
  if (t in ALLOWANCE_LABELS) return t as keyof typeof ALLOWANCE_LABELS;
  if (/سكن|housing/i.test(a.name)) return 'HOUSING';
  if (/نقل|مواصلات|transport/i.test(a.name)) return 'TRANSPORT';
  if (/طعام|أكل|اعاشة|إعاشة|food/i.test(a.name)) return 'FOOD';
  return 'OTHER';
}

export function buildEmployee(e: EmployeeRecord, language: DocumentLanguage) {
  const errors: ContractError[] = [];
  const fullNameAr = clean(`${e.firstNameArabic} ${e.lastNameArabic}`);
  const fullNameEn = clean(`${e.firstNameEnglish ?? ''} ${e.lastNameEnglish ?? ''}`);
  const jobTitleAr = clean(e.jobTitle);
  const jobTitleEn = clean(e.jobTitleEnglish);
  const nationalityAr = clean(e.nationality);
  const nationalityEn = nationalityAr ? nationalityEnglish(nationalityAr) : null;
  if (!fullNameAr) errors.push({ code: 'MISSING_NAME', message: 'اسم الموظف بالعربية غير مكتمل' });
  if (!jobTitleAr) errors.push({ code: 'MISSING_JOB_TITLE', message: 'المسمى الوظيفي غير مسجل في ملف الموظف' });
  if (!nationalityAr) errors.push({ code: 'MISSING_NATIONALITY', message: 'الجنسية غير مسجلة في ملف الموظف' });
  if (language === 'ar-en') {
    if (!fullNameEn) errors.push({ code: 'MISSING_NAME_EN', message: 'الاسم بالإنجليزية غير مسجل في ملف الموظف (مطلوب للخطاب ثنائي اللغة)' });
    if (!jobTitleEn) errors.push({ code: 'MISSING_JOB_TITLE_EN', message: 'المسمى الوظيفي بالإنجليزية غير مسجل في ملف الموظف (مطلوب للخطاب ثنائي اللغة)' });
    if (nationalityAr && !nationalityEn) errors.push({ code: 'UNKNOWN_NATIONALITY_EN', message: `لا تتوفر ترجمة إنجليزية للجنسية «${nationalityAr}»؛ صحّح الجنسية في ملف الموظف` });
  }
  return {
    errors,
    value: {
      fullNameAr: fullNameAr ?? '',
      fullNameEn,
      employeeNumber: e.employeeId,
      nationalityAr: nationalityAr ?? '',
      nationalityEn,
      idKind: (e.idType === 'NATIONAL_ID' || /^1\d{9}$/.test(e.iqamaOrIdNumber) ? 'NATIONAL_ID' : 'IQAMA') as 'IQAMA' | 'NATIONAL_ID',
      idNumber: e.iqamaOrIdNumber,
      passportNumber: clean(e.passportNumber),
      jobTitleAr: jobTitleAr ?? '',
      jobTitleEn,
      joinDate: isoDay(e.joinDate),
    },
  };
}

export function buildCompany(c: CompanyRecord, language: DocumentLanguage) {
  const errors: ContractError[] = [];
  const legalNameEn = clean(c.nameEnglish);
  if (language === 'ar-en' && !legalNameEn) errors.push({ code: 'MISSING_COMPANY_NAME_EN', message: 'الاسم الإنجليزي للشركة النظامية غير مسجل' });
  return {
    errors,
    value: { legalNameAr: c.nameArabic.trim(), legalNameEn, crNumber: c.commercialRegNum.trim(), unifiedNumber: clean(c.unifiedNumber) },
  };
}

/** Monthly salary lines: basic + recurring allowances grouped by kind (one-off bonuses excluded). */
export function buildSalary(e: EmployeeRecord) {
  const errors: ContractError[] = [];
  const rows = [{ key: 'BASIC', labelAr: 'الراتب الأساسي', labelEn: 'Basic Salary', amount: toAmountString(e.basicSalary) }];
  const byKind = new Map<string, number>();
  for (const a of e.allowances) {
    if (!a.isMonthly || !(a.amount > 0)) continue;
    const k = allowanceKind(a);
    byKind.set(k, Math.round(((byKind.get(k) ?? 0) + a.amount) * 100) / 100);
  }
  for (const k of ['HOUSING', 'TRANSPORT', 'FOOD', 'OTHER'] as const) {
    const v = byKind.get(k);
    if (v) rows.push({ key: k, labelAr: ALLOWANCE_LABELS[k].ar, labelEn: ALLOWANCE_LABELS[k].en, amount: toAmountString(v) });
  }
  if (!(e.basicSalary > 0)) errors.push({ code: 'NO_SALARY', message: 'الراتب الأساسي غير مسجل للموظف' });
  return { errors, value: { rows, total: sumAmounts(rows.map((r) => r.amount)) } };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface TypeDefaults {
  selfService: boolean;
  /** Human approval before issuance when no valid pre-authorization covers the signatory (DOC-04). */
  requiresApproval: boolean;
  validityDays: number | null;
}

export interface DocumentTypeDefinition {
  key: string;
  code: string; // DOC-02, fixed forever once used
  contractVersion: number;
  labelAr: string;
  labelEn: string;
  template: string; // src/lib/documents/templates/<template>.typ
  templateVersion: number;
  /** Who may issue / approve / read this type besides the employee himself. */
  staffRoles: readonly string[];
  defaults: TypeDefaults;
  /** Only employees in service (not terminated) may receive it. */
  requiresActiveEmployee: boolean;
  contract: z.ZodTypeAny;
  build(input: { employee: EmployeeRecord; company: CompanyRecord; params: DocumentParams }): { errors: ContractError[]; data: unknown };
}

const baseBuild = (employee: EmployeeRecord, company: CompanyRecord, params: DocumentParams) => {
  const emp = buildEmployee(employee, params.language);
  const co = buildCompany(company, params.language);
  return { errors: [...emp.errors, ...co.errors], employee: emp.value, company: co.value };
};

export const SALARY_CERTIFICATE: DocumentTypeDefinition = {
  key: 'SALARY_CERTIFICATE',
  code: 'SAL',
  contractVersion: 1,
  labelAr: 'خطاب تعريف بالراتب',
  labelEn: 'Salary Certificate',
  template: 'salary-certificate',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.PAYROLL,
  defaults: { selfService: true, requiresApproval: false, validityDays: 90 },
  requiresActiveEmployee: true,
  contract: z.object({ employee: employeeContract, company: companyContract, salary: salaryContract }),
  build({ employee, company, params }) {
    const b = baseBuild(employee, company, params);
    const salary = buildSalary(employee);
    return { errors: [...b.errors, ...salary.errors], data: { employee: b.employee, company: b.company, salary: salary.value } };
  },
};

export const EMPLOYMENT_CERTIFICATE: DocumentTypeDefinition = {
  key: 'EMPLOYMENT_CERTIFICATE',
  code: 'EMP',
  contractVersion: 1,
  labelAr: 'خطاب تعريف',
  labelEn: 'Employment Certificate',
  template: 'employment-certificate',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  defaults: { selfService: true, requiresApproval: false, validityDays: 90 },
  requiresActiveEmployee: true,
  contract: z.object({ employee: employeeContract, company: companyContract }),
  build({ employee, company, params }) {
    const b = baseBuild(employee, company, params);
    return { errors: b.errors, data: { employee: b.employee, company: b.company } };
  },
};

export const EXPERIENCE_CERTIFICATE: DocumentTypeDefinition = {
  key: 'EXPERIENCE_CERTIFICATE',
  code: 'EXP',
  contractVersion: 1,
  labelAr: 'شهادة خبرة',
  labelEn: 'Experience Certificate',
  template: 'experience-certificate',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  // Owner decision 2026-09-26 (SPEC §15.2): like salary / employment letters, issued at once only
  // under a valid pre-authorization, otherwise it waits for approval. It does not expire.
  defaults: { selfService: true, requiresApproval: false, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({ employee: employeeContract, company: companyContract, service: serviceContract }),
  build({ employee, company, params }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    if (employee.isTerminated && !employee.terminationDate) {
      errors.push({ code: 'MISSING_END_DATE', message: 'تاريخ انتهاء الخدمة غير مسجل للموظف' });
    }
    const service = {
      startDate: isoDay(employee.joinDate),
      endDate: employee.terminationDate ? isoDay(employee.terminationDate) : null,
      inService: !employee.isTerminated,
    };
    return { errors, data: { employee: b.employee, company: b.company, service } };
  },
};

export const DOCUMENT_TYPES: Readonly<Record<string, DocumentTypeDefinition>> = Object.freeze({
  [SALARY_CERTIFICATE.key]: SALARY_CERTIFICATE,
  [EMPLOYMENT_CERTIFICATE.key]: EMPLOYMENT_CERTIFICATE,
  [EXPERIENCE_CERTIFICATE.key]: EXPERIENCE_CERTIFICATE,
});

export function getDocumentType(key: string): DocumentTypeDefinition | null {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, key) ? DOCUMENT_TYPES[key] : null;
}

/** Contract data for a request; throws ContractValidationError listing everything to fix. */
export function buildContractData(def: DocumentTypeDefinition, input: { employee: EmployeeRecord; company: CompanyRecord; params: DocumentParams }) {
  const { errors, data } = def.build(input);
  if (def.requiresActiveEmployee && input.employee.isTerminated) {
    errors.unshift({ code: 'EMPLOYEE_TERMINATED', message: 'لا يصدر هذا الخطاب لموظف منتهية خدمته' });
  }
  if (errors.length) throw new ContractValidationError(errors);
  const parsed = def.contract.safeParse(data);
  if (!parsed.success) {
    throw new ContractValidationError(parsed.error.issues.map((i) => ({ code: 'CONTRACT', message: `بيانات غير صالحة: ${i.path.join('.')}` })));
  }
  return parsed.data as Record<string, unknown>;
}
