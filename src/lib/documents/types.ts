// Document types (SPEC §4.2): each type carries its code, data contract, defaults and roles.
// Pure: the contract builders take an already loaded employee record (see load.ts), so the rules
// are unit tested without a database.
import { z } from 'zod';
import { ROLE_GROUPS } from '@/lib/constants';
import { sumAmounts, toAmountString } from './core';
import { SETTLEMENT_PAYMENT_METHODS } from '@/lib/settlement-payment';
import { validateSaudiIban } from '@/lib/iban';

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

/**
 * Characters free text written by HR may contain. Every one of them is in the IBM Plex Sans
 * Arabic cmap (documents-text test), so an approved text can never be refused by the renderer's
 * glyph check afterwards (an emoji would otherwise block the job only after approval).
 */
export const DOCUMENT_TEXT_RE = /^[\n\u0020-\u007E\u00AB\u00BB\u060C\u061B\u061F\u0621-\u063A\u0640-\u0652\u0660-\u066C\u0670\u067E\u0686\u0698\u06A4\u06A9\u06AF\u06CC\u2013\u2014\u2018\u2019\u201C\u201D\u2026]*$/;
const TEXT_ERROR = 'يحتوي النص على رموز غير مدعومة في المستندات الرسمية (مثل الرموز التعبيرية أو الحروف غير العربية واللاتينية)';

/** One line: inner whitespace collapsed. */
const lineText = (min: number, max: number) =>
  z.string().transform((v) => v.replace(/\s+/g, ' ').trim()).pipe(z.string().min(min).max(max).regex(DOCUMENT_TEXT_RE, TEXT_ERROR));
/** Paragraphs: CRLF normalized, spaces collapsed per line, at most one empty line between paragraphs. */
const blockText = (min: number, max: number) =>
  z.string()
    .transform((v) => v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim())
    .pipe(z.string().min(min).max(max).regex(DOCUMENT_TEXT_RE, TEXT_ERROR));

export const warningParamsSchema = z.object({
  subjectAr: lineText(3, 120),
  bodyAr: blockText(20, 3000),
  incidentDate: isoDate.optional(),
});

/** ADMIN_CIRCULAR: an administrative decision or a circular of the legal company to a group of employees. */
export const circularParamsSchema = z.object({
  /** The issuing legal company (a company document: HR chooses, within its scope). */
  legalCompanyId: z.string().trim().min(1).max(64),
  kind: z.enum(['DECISION', 'CIRCULAR']),
  subjectAr: lineText(3, 150),
  bodyAr: blockText(10, 4000),
  effectiveDate: isoDate.optional(),
  /** Each recipient acknowledges having read it (default on). */
  acknowledge: z.boolean().default(true),
  audience: z.object({
    scope: z.enum(['COMPANY', 'BRANCHES', 'DEPARTMENTS', 'EMPLOYEES']),
    /** Branch / department / employee ids (empty for COMPANY). */
    ids: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
  }),
});

export const TERMINATION_NOTICE_REASONS = ['NOTICE', 'NON_RENEWAL', 'PROBATION', 'ARTICLE_80'] as const;

export const terminationNoticeParamsSchema = z.object({
  reason: z.enum(TERMINATION_NOTICE_REASONS),
  lastWorkingDate: isoDate,
  /** Notice period in days (NOTICE / NON_RENEWAL); ignored for ARTICLE_80. */
  noticeDays: z.number().int().min(0).max(365).optional(),
  /** ARTICLE_80 only: the concluded investigation the decision rests on. */
  investigationId: z.string().trim().min(1).max(64).optional(),
  /** Optional clarification written by HR (printed as is, approved with the rest). */
  detailsAr: blockText(5, 1500).optional(),
});

export const promotionParamsSchema = z.object({
  newJobTitleAr: lineText(2, 120).optional(),
  newJobTitleEn: lineText(2, 120).optional(),
  /** New monthly basic salary (SAR, 2 decimals). */
  newBasicSalary: z.number().positive().max(10_000_000).refine((v) => Math.round(v * 100) === v * 100, 'الراتب بخانتين عشريتين على الأكثر').optional(),
  effectiveDate: isoDate,
  reasonAr: lineText(3, 200).optional(),
}).refine((p) => p.newJobTitleAr || p.newBasicSalary, 'حدد المسمى الجديد أو الراتب الأساسي الجديد');

const money = z.number().min(0).max(10_000_000).refine((v) => Math.round(v * 100) === v * 100, 'المبالغ بخانتين عشريتين على الأكثر');

/** CONTRACT_ADDENDUM: the terms it changes (only those given), from the effective date. */
export const addendumParamsSchema = z.object({
  effectiveDate: isoDate,
  newBasicSalary: money.refine((v) => v > 0, 'الراتب الأساسي يجب أن يكون أكبر من صفر').optional(),
  newHousingAllowance: money.optional(),
  newTransportAllowance: money.optional(),
  newJobTitleAr: lineText(2, 120).optional(),
  newJobTitleEn: lineText(2, 120).optional(),
  newBranchId: z.string().trim().min(1).max(64).optional(),
  newContractEndDate: isoDate.optional(),
  reasonAr: lineText(3, 200).optional(),
}).refine(
  (p) => p.newBasicSalary !== undefined || p.newHousingAllowance !== undefined || p.newTransportAllowance !== undefined || p.newJobTitleAr || p.newBranchId || p.newContractEndDate,
  'حدد بنداً واحداً على الأقل يتغير',
);

export const offerParamsSchema = z.object({
  /** The legal company making the offer (a candidate has no file yet: HR chooses, within its scope). */
  legalCompanyId: z.string().trim().min(1).max(64),
  jobTitleAr: lineText(2, 120),
  jobTitleEn: lineText(2, 120).optional(),
  basicSalary: money.refine((v) => v > 0, 'الراتب الأساسي مطلوب'),
  housingAllowance: money.optional(),
  transportAllowance: money.optional(),
  otherAllowances: money.optional(),
  startDate: isoDate,
  probationDays: z.number().int().min(0).max(180),
  annualLeaveDays: z.number().int().min(21).max(60),
  notesAr: lineText(3, 300).optional(),
});

export const NOC_PURPOSES = ['SERVICE_TRANSFER', 'STUDY', 'TRAVEL', 'LICENSE'] as const;

export const nocParamsSchema = z.object({
  purpose: z.enum(NOC_PURPOSES),
  /** The new employer / institution / destination / licence, as the employee wrote it. */
  targetAr: lineText(2, 120),
  /** Optional short detail (e.g. travel dates, programme). */
  detailsAr: lineText(2, 200).optional(),
});

export const paramsSchema = z.object({
  language: z.enum(['ar', 'ar-en']).default('ar'),
  addresseeAr: z.string().trim().max(120).optional(),
  addresseeEn: z.string().trim().max(120).optional(),
  /** WARNING_LETTER only: the text HR wrote; part of the snapshot, so the approval covers it word for word. */
  warning: warningParamsSchema.optional(),
  /** SETTLEMENT_STATEMENT only: the settlement it states (an employee may have several). */
  settlementId: z.string().trim().min(1).max(64).optional(),
  /** PAYSLIP only: the payroll row (one employee, one month). */
  payrollId: z.string().trim().min(1).max(64).optional(),
  /** EXIT_ACCEPTANCE only: the approved resignation / termination request. */
  terminationRequestId: z.string().trim().min(1).max(64).optional(),
  /** TERMINATION_NOTICE only: the company's decision. */
  terminationNotice: terminationNoticeParamsSchema.optional(),
  /** NO_OBJECTION only: purpose and destination. */
  noc: nocParamsSchema.optional(),
  /** PROMOTION_DECISION only: the change it orders. */
  promotion: promotionParamsSchema.optional(),
  /** ADMIN_CIRCULAR only: the decision / circular and its audience. */
  circular: circularParamsSchema.optional(),
  /** CONTRACT_ADDENDUM only: the terms it changes. */
  addendum: addendumParamsSchema.optional(),
  /** WORK_COMMENCEMENT(_LETTER) only: on joining, or back from a leave (that leave, or the latest confirmed return). */
  commencement: z.object({ kind: z.enum(['JOIN', 'RETURN']), leaveId: z.string().trim().min(1).max(64).optional() }).optional(),
  /** JOB_OFFER only: the offer's terms. */
  offer: offerParamsSchema.optional(),
  /** LEAVE_APPROVAL only: the approved leave. */
  leaveId: z.string().trim().min(1).max(64).optional(),
  /** EVALUATION_REPORT only: the closed evaluation. */
  evaluationId: z.string().trim().min(1).max(64).optional(),
  /** INVESTIGATION_MINUTES only: the concluded investigation. */
  investigationId: z.string().trim().min(1).max(64).optional(),
});

/**
 * Database free text printed by an automatic document (no one to refuse it to): characters the
 * fonts cannot draw are dropped instead of blocking the render; line breaks and paragraphs kept.
 */
export function printable(s: string | null | undefined): string | null {
  if (!s) return null;
  const kept = Array.from(s.replace(/\r\n?/g, '\n')).filter((ch) => DOCUMENT_TEXT_RE.test(ch)).join('');
  const t = kept.split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length ? t : null;
}
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

/**
 * What stands between a leaver and a clearance letter (loaded by facts.ts): the obligations the
 * settlement screen lists, open loans, and the end-of-service settlement itself.
 */
export interface ExitFacts {
  outstanding: ReadonlyArray<{ kind: 'ASSET' | 'SIM' | 'VEHICLE' | 'LOAN'; label: string }>;
  /** Latest end-of-service settlement that was not rejected. */
  settlement: { id: string; status: string; lastWorkingDate: Date | null } | null;
}

/** A settlement as the statement needs it (loaded by facts.ts, amounts as stored). */
export interface SettlementFacts {
  settlement: {
    id: string;
    employeeId: string;
    type: 'END_OF_SERVICE' | 'LEAVE_SETTLEMENT';
    terminationReason: string | null;
    status: string;
    lastWorkingDate: Date | null;
    yearsOfService: number | null;
    workingDaysSalary: number | null;
    endOfServiceAmount: number | null;
    leaveCompensation: number | null;
    overtimeAmount: number | null;
    additionalEntitlements: number | null;
    loansDeduction: number | null;
    additionalDeductions: number | null;
    totalSettlement: number | null;
    paymentMethod: string | null;
    paymentReference: string | null;
    paidAt: Date | null;
  } | null;
  /**
   * Payment receipt: recorded = the settlement points to an uploaded file (the payments screen
   * requires one; the settlements screen records only the reference); sha256 = that file's hash
   * (null when not recorded or missing on disk).
   */
  receipt: { sha256: string | null; recorded: boolean };
}

/** A payroll row as the payslip needs it (loaded by facts.ts, amounts as stored). */
export interface PayrollFacts {
  payroll: {
    id: string;
    employeeId: string;
    month: number;
    year: number;
    status: string;
    paidAt: Date | null;
    basicSalary: number;
    totalAllowances: number;
    bonusAmount: number;
    housingAllowance: number | null;
    transportAllowance: number | null;
    otherAllowances: number | null;
    overtimeCost: number;
    gosiEmployee: number;
    loansDeduction: number;
    violationsDeduction: number;
    leaveDeduction: number;
    otherDeductions: number;
    totalDeductions: number;
    netSalary: number;
  } | null;
}

/** An employee's resignation / termination request as the acceptance letter needs it. */
export interface TerminationFacts {
  request: {
    id: string;
    employeeId: string;
    terminationType: string;
    status: string;
    createdAt: Date;
    hrApprovedAt: Date | null;
    lastWorkingDate: Date | null;
  } | null;
}

/** The employee's salary account (from his file; IBAN decrypted). */
export interface BankFacts {
  bankName: string | null;
  iban: string | null;
}

/** A closed evaluation as its report needs it (template structure + scores + texts). */
export interface EvaluationFacts {
  evaluation: {
    id: string; employeeId: string; status: string; totalScore: number | null; finalRating: string | null;
    recommendation: string | null; recommendationReason: string | null; strengths: string | null; improvements: string | null; finalNotes: string | null;
    employeeAcknowledgedAt: Date | null; employeeComment: string | null;
    cycle: { title: string; startDate: Date; endDate: Date };
    sections: { title: string; weight: number; items: { title: string; score: number; note: string | null }[] }[];
  } | null;
}

/** An approved leave as its letter needs it. */
/** Who a circular reaches: its recipients (active employees of the legal company) and the named groups. */
export interface CircularFacts {
  recipients: Array<{ id: string; employeeNumber: string; nameAr: string }>;
  /** Names of the branches / departments chosen (in the order given); unknown ids are left out. */
  groups: string[];
  /** Ids given that are not branches / departments / employees of this company. */
  unknownIds: string[];
}

/** The leave a return-to-work commencement is about (null when none is confirmed). */
export interface CommencementFacts {
  leave: { id: string; employeeId: string; leaveType: string; startDate: Date; endDate: Date; isReturned: boolean; actualReturnDate: Date | null } | null;
}

/** What a contract addendum changes from: the file's work location and contract end, and the new branch. */
export interface AddendumFacts {
  branch: { id: string; nameAr: string } | null;
  contractEndDate: Date | null;
  /** The branch named in the parameters (null when not found). */
  newBranch: { id: string; nameAr: string } | null;
}

export interface LeaveFacts {
  leave: { id: string; employeeId: string; leaveType: string; status: string; startDate: Date; endDate: Date; totalDays: number; isOutsideKSA: boolean } | null;
}

/** A job applicant (JobApplication): the subject of a job offer, before any employee file exists. */
export interface CandidateRecord {
  id: string;
  candidateName: string;
  candidateEmail: string | null;
  status: string;
}

/** An investigation: the basis of an Article 80 notice, and the content of its minutes. */
export interface InvestigationFacts {
  investigation: {
    id: string; employeeId: string; subject: string; status: string; updatedAt: Date;
    description?: string | null; category?: string | null; findings?: string | null; recommendation?: string | null; finalDecision?: string | null;
    penaltyAmount?: number | null; penaltyDays?: number | null; investigatorName?: string | null; investigatorRole?: string | null; createdAt?: Date;
  } | null;
}

const OUTSTANDING_LABEL: Record<ExitFacts['outstanding'][number]['kind'], string> = {
  ASSET: 'عهدة لم تُسترجع',
  SIM: 'شريحة اتصال مسجلة باسمه',
  VEHICLE: 'مركبة مسندة إليه',
  LOAN: 'سلفة غير مسددة',
};

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
  /** Languages the template supports (a free Arabic text has no English version). */
  languages: readonly DocumentLanguage[];
  /**
   * Always approved by a second person: company settings cannot switch approval off or open the
   * type to the portal, a pre-authorization does not replace the approval, and whoever created
   * the request may not approve it (maker-checker).
   */
  approvalLocked?: boolean;
  /** What the subject does once it is issued (DocumentAcknowledgement):
   * RECEIPT = confirms receipt (warning); RELEASE = accepts the discharge or disputes it (statement);
   * OFFER = the candidate accepts or declines through the offer link;
   * CONSENT = the employee accepts or declines in the portal (contract addendum).
   */
  acknowledgement?: 'RECEIPT' | 'RELEASE' | 'OFFER' | 'CONSENT';
  /** Addressed to the employee himself instead of "to whom it may concern". */
  addressedToEmployee?: boolean;
  /** Extra facts the builder needs (loaded by facts.ts). */
  facts?: 'EXIT' | 'SETTLEMENT' | 'PAYROLL' | 'TERMINATION' | 'INVESTIGATION' | 'BANK' | 'LEAVE' | 'EVALUATION' | 'ADDENDUM' | 'COMMENCEMENT';
  /**
   * Always approved by a human (a financial commitment): settings cannot switch approval off and a
   * pre-authorization does not replace it; unlike approvalLocked it may be requested from the portal.
   */
  approvalMandatory?: boolean;
  /** Issuing it orders a change of the employee file (EmployeeChangeOrder, change-orders.ts). */
  executesChange?: boolean;
  /** The employee's acceptance (CONSENT) orders the change of the file, not the issuance. */
  executesOnConsent?: boolean;
  /**
   * CANDIDATE: the document belongs to a job applicant, not an employee (buildCandidate is used,
   * the legal company comes from the parameters, delivery is a private link).
   */
  subject?: 'CANDIDATE' | 'COMPANY';
  buildCandidate?(input: { candidate: CandidateRecord; company: CompanyRecord; params: DocumentParams }): { errors: ContractError[]; data: unknown };
  /** COMPANY: a document of the legal company itself to a group of employees (circular). */
  buildCompanyDoc?(input: { company: CompanyRecord; params: DocumentParams; circular: CircularFacts }): { errors: ContractError[]; data: unknown };
  /** Printed title when it depends on the content (a decision or a circular); default labelAr / labelEn. */
  titleOf?(data: unknown): { ar: string; en: string };
  /**
   * AUTO: issued by the system from data a human already approved (the payroll): no approval, no
   * signatory, never requested from the portal, no "one open request" rule (one per source instead).
   */
  issuance?: 'AUTO';
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
  build(input: BuildInput): { errors: ContractError[]; data: unknown };
}

export interface BuildInput {
  employee: EmployeeRecord;
  company: CompanyRecord;
  params: DocumentParams;
  facts?: ExitFacts;
  settlement?: SettlementFacts;
  payroll?: PayrollFacts;
  termination?: TerminationFacts;
  investigation?: InvestigationFacts;
  bank?: BankFacts;
  leave?: LeaveFacts;
  evaluation?: EvaluationFacts;
  addendum?: AddendumFacts;
  commencement?: CommencementFacts;
}

const baseBuild = (employee: EmployeeRecord, company: CompanyRecord, params: DocumentParams) => {
  const emp = buildEmployee(employee, params.language);
  const co = buildCompany(company, params.language);
  return { errors: [...emp.errors, ...co.errors], employee: emp.value, company: co.value };
};

export const SALARY_CERTIFICATE: DocumentTypeDefinition = {
  key: 'SALARY_CERTIFICATE',
  languages: ['ar', 'ar-en'],
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
  languages: ['ar', 'ar-en'],
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
  languages: ['ar', 'ar-en'],
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

/**
 * Written warning (owner decisions 2026-09-26): a free text written by HR, approved word for word
 * by a second person, delivered in the portal with an acknowledgement of receipt. Arabic only.
 */
export const WARNING_LETTER: DocumentTypeDefinition = {
  key: 'WARNING_LETTER',
  languages: ['ar'],
  code: 'WRN',
  contractVersion: 1,
  labelAr: 'إنذار كتابي',
  labelEn: 'Written Warning',
  template: 'warning-letter',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  approvalLocked: true,
  acknowledgement: 'RECEIPT',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    warning: z.object({ subjectAr: z.string().min(1), bodyAr: z.string().min(1), incidentDate: isoDate.nullable() }),
  }),
  build({ employee, company, params }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    if (!params.warning) errors.push({ code: 'MISSING_WARNING_TEXT', message: 'اكتب موضوع الإنذار ونصه' });
    const warning = params.warning
      ? { subjectAr: params.warning.subjectAr, bodyAr: params.warning.bodyAr, incidentDate: params.warning.incidentDate ?? null }
      : null;
    return { errors, data: { employee: b.employee, company: b.company, warning } };
  },
};

/**
 * Clearance (owner decision 2026-09-26: strict). Issued only to a leaver whose custody items,
 * SIMs, vehicles and loans are all settled and whose end-of-service settlement is PAID; otherwise
 * the errors list exactly what is still open.
 */
export const CLEARANCE_CERTIFICATE: DocumentTypeDefinition = {
  key: 'CLEARANCE_CERTIFICATE',
  languages: ['ar', 'ar-en'],
  code: 'CLR',
  contractVersion: 1,
  labelAr: 'إخلاء طرف',
  labelEn: 'Clearance Certificate',
  template: 'clearance-certificate',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'EXIT',
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    service: serviceContract,
    clearance: z.object({ lastWorkingDate: isoDate }),
  }),
  build({ employee, company, params, facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    if (!employee.isTerminated || !employee.terminationDate) {
      errors.push({ code: 'NOT_TERMINATED', message: 'إخلاء الطرف يصدر بعد إنهاء خدمة الموظف وتسجيل تاريخ انتهائها' });
    }
    const settlement = facts?.settlement ?? null;
    if (!settlement) errors.push({ code: 'NO_SETTLEMENT', message: 'لا توجد تصفية نهاية خدمة للموظف' });
    else if (settlement.status !== 'PAID') errors.push({ code: 'SETTLEMENT_NOT_PAID', message: 'تصفية نهاية الخدمة لم تُصرف بعد' });
    for (const o of facts?.outstanding ?? []) {
      errors.push({ code: `OUTSTANDING_${o.kind}`, message: `${OUTSTANDING_LABEL[o.kind]}: ${o.label}` });
    }
    const end = employee.terminationDate ? isoDay(employee.terminationDate) : null;
    const last = settlement?.lastWorkingDate ? isoDay(settlement.lastWorkingDate) : end;
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        service: { startDate: isoDay(employee.joinDate), endDate: end, inService: false },
        clearance: { lastWorkingDate: last },
      },
    };
  },
};

const TERMINATION_REASON: Record<string, { ar: string; en: string }> = {
  COMPANY_TERMINATION: { ar: 'إنهاء من قبل الشركة', en: 'Termination by the company' },
  RESIGNATION: { ar: 'استقالة', en: 'Resignation' },
  PROBATION: { ar: 'إنهاء خلال فترة التجربة', en: 'Termination during probation' },
  ARTICLE_80: { ar: 'فصل بموجب المادة 80', en: 'Dismissal under Article 80' },
  ARTICLE_81: { ar: 'ترك العمل بموجب المادة 81', en: 'Leaving under Article 81' },
  ARTICLE_87: { ar: 'حالات المادة 87', en: 'Article 87 cases' },
  CONTRACT_EXPIRY: { ar: 'انتهاء العقد محدد المدة', en: 'Expiry of the fixed-term contract' },
};

const moneyRow = z.object({ key: z.string(), labelAr: z.string(), labelEn: z.string(), amount });

/**
 * Final / leave settlement statement with discharge (owner decisions 2026-09-26): issued after the
 * settlement is PAID, itemized from the stored settlement (checked against its total to the
 * halala), with the payment proof finance recorded and the receipt file's fingerprint. The
 * employee then accepts the discharge or disputes it in the portal (DocumentAcknowledgement).
 */
export const SETTLEMENT_STATEMENT: DocumentTypeDefinition = {
  key: 'SETTLEMENT_STATEMENT',
  languages: ['ar', 'ar-en'],
  code: 'STL',
  contractVersion: 1,
  labelAr: 'بيان تسوية ومخالصة',
  labelEn: 'Settlement Statement and Release',
  template: 'settlement-statement',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'SETTLEMENT',
  acknowledgement: 'RELEASE',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    settlement: z.object({
      id: z.string().min(1),
      kind: z.enum(['END_OF_SERVICE', 'LEAVE_SETTLEMENT']),
      reasonAr: z.string().nullable(),
      reasonEn: z.string().nullable(),
      lastWorkingDate: isoDate.nullable(),
      yearsOfService: z.string().nullable(),
      entitlements: z.array(moneyRow).min(1),
      deductions: z.array(moneyRow),
      totalEntitlements: amount,
      totalDeductions: amount,
      net: amount,
      payment: z.object({
        method: z.enum(['BANK_TRANSFER', 'CASH_VOUCHER', 'CHEQUE']),
        reference: z.string().min(1),
        paidDate: isoDate,
        amount,
        receiptSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      }),
    }),
  }),
  build({ employee, company, params, settlement: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const s = facts?.settlement ?? null;
    if (!params.settlementId) errors.push({ code: 'MISSING_SETTLEMENT', message: 'اختر التسوية التي يصدر لها البيان' });
    if (!s || s.employeeId !== employee.id) {
      if (params.settlementId) errors.push({ code: 'SETTLEMENT_NOT_FOUND', message: 'التسوية غير موجودة لهذا الموظف' });
      return { errors, data: null };
    }
    if (s.status !== 'PAID') errors.push({ code: 'SETTLEMENT_NOT_PAID', message: 'التسوية لم تُصرف بعد؛ يصدر البيان بعد تأكيد الصرف' });
    const method = s.paymentMethod && s.paymentMethod in SETTLEMENT_PAYMENT_METHODS ? (s.paymentMethod as keyof typeof SETTLEMENT_PAYMENT_METHODS) : null;
    if (s.status === 'PAID' && (!method || !s.paymentReference || !s.paidAt)) {
      errors.push({ code: 'NO_PAYMENT_PROOF', message: 'بيانات إثبات الصرف (الطريقة والرقم والتاريخ) غير مسجلة لهذه التسوية؛ تُسجلها المالية عند تأكيد الصرف' });
    }
    if (facts!.receipt.recorded && !facts!.receipt.sha256) errors.push({ code: 'RECEIPT_FILE_MISSING', message: 'ملف إيصال الصرف غير موجود على الخادم' });

    const money = (v: number | null | undefined) => Math.round((v ?? 0) * 100) / 100;
    const overtime = money(s.overtimeAmount);
    const loans = money(s.loansDeduction);
    const ent = [
      { key: 'WORKING_DAYS', labelAr: 'راتب أيام العمل في الشهر الأخير', labelEn: 'Salary for days worked in the last month', v: money(s.workingDaysSalary) },
      { key: 'END_OF_SERVICE', labelAr: 'مكافأة نهاية الخدمة', labelEn: 'End-of-service award', v: s.type === 'END_OF_SERVICE' ? money(s.endOfServiceAmount) : 0 },
      { key: 'LEAVE', labelAr: 'بدل الإجازة', labelEn: 'Leave compensation', v: money(s.leaveCompensation) },
      { key: 'OVERTIME', labelAr: 'العمل الإضافي', labelEn: 'Overtime', v: overtime },
      { key: 'OTHER_ENTITLEMENTS', labelAr: 'مستحقات أخرى', labelEn: 'Other entitlements', v: Math.round((money(s.additionalEntitlements) - overtime) * 100) / 100 },
    ];
    const ded = [
      { key: 'LOANS', labelAr: 'السلف', labelEn: 'Loans', v: loans },
      { key: 'OTHER_DEDUCTIONS', labelAr: 'خصومات أخرى', labelEn: 'Other deductions', v: Math.round((money(s.additionalDeductions) - loans) * 100) / 100 },
    ];
    // Amounts are never re-derived: the rows are the stored components, and they must add up to
    // the stored total exactly; anything else is refused rather than printed.
    if ([...ent, ...ded].some((r) => r.v < 0)) errors.push({ code: 'SETTLEMENT_INCONSISTENT', message: 'بنود التسوية المخزنة غير متسقة؛ راجع التسوية' });
    const rows = (list: typeof ent) => list.filter((r) => r.v > 0).map((r) => ({ key: r.key, labelAr: r.labelAr, labelEn: r.labelEn, amount: toAmountString(r.v) }));
    const entitlements = rows(ent);
    const deductions = rows(ded);
    const totalEntitlements = sumAmounts(entitlements.map((r) => r.amount));
    const totalDeductions = deductions.length ? sumAmounts(deductions.map((r) => r.amount)) : '0.00';
    const netCents = Math.round(Number(totalEntitlements) * 100) - Math.round(Number(totalDeductions) * 100);
    if (netCents !== Math.round(money(s.totalSettlement) * 100)) {
      errors.push({ code: 'SETTLEMENT_INCONSISTENT', message: 'مجموع بنود التسوية لا يطابق صافيها المخزن؛ راجع التسوية' });
    }
    if (netCents < 0) errors.push({ code: 'NEGATIVE_NET', message: 'صافي التسوية مستحق على الموظف؛ لا يصدر بيان مخالصة' });
    if (!entitlements.length) errors.push({ code: 'SETTLEMENT_EMPTY', message: 'لا توجد مستحقات في التسوية' });
    const net = (Math.max(0, netCents) / 100).toFixed(2);
    const reason = s.terminationReason ? TERMINATION_REASON[s.terminationReason] ?? null : null;
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        settlement: {
          id: s.id,
          kind: s.type,
          reasonAr: reason?.ar ?? null,
          reasonEn: reason?.en ?? null,
          lastWorkingDate: s.lastWorkingDate ? isoDay(s.lastWorkingDate) : null,
          yearsOfService: s.yearsOfService !== null ? s.yearsOfService.toFixed(2) : null,
          entitlements,
          deductions,
          totalEntitlements,
          totalDeductions,
          net,
          payment: {
            method: method ?? 'BANK_TRANSFER',
            reference: s.paymentReference ?? '',
            paidDate: s.paidAt ? isoDay(s.paidAt) : '',
            amount: net,
            receiptSha256: facts!.receipt.sha256,
          },
        },
      },
    };
  },
};

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Payslip (owner decisions 2026-09-26): issued automatically for every employee once the month's
 * payroll is PAID, unsigned ("issued automatically from an approved payroll"), numbered with a QR.
 * Lines are the stored payroll columns; the payroll's own equations must hold to the halala.
 */
export const PAYSLIP: DocumentTypeDefinition = {
  key: 'PAYSLIP',
  languages: ['ar', 'ar-en'],
  code: 'PAY',
  contractVersion: 1,
  labelAr: 'قسيمة راتب',
  labelEn: 'Payslip',
  template: 'payslip',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.PAYROLL,
  facts: 'PAYROLL',
  issuance: 'AUTO',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: false, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    payroll: z.object({
      id: z.string().min(1),
      year: z.number().int(),
      month: z.number().int().min(1).max(12),
      periodAr: z.string().min(1),
      periodEn: z.string().min(1),
      paidDate: isoDate.nullable(),
      earnings: z.array(moneyRow).min(1),
      deductions: z.array(moneyRow),
      gross: amount,
      totalDeductions: amount,
      net: amount,
    }),
  }),
  build({ employee, company, params, payroll: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const p = facts?.payroll ?? null;
    if (!p || p.employeeId !== employee.id) {
      errors.push({ code: 'PAYROLL_NOT_FOUND', message: 'سطر المسير غير موجود لهذا الموظف' });
      return { errors, data: null };
    }
    if (p.status !== 'PAID') errors.push({ code: 'PAYROLL_NOT_PAID', message: 'مسير هذا الشهر لم يُصرف بعد' });
    const c = (v: number) => Math.round((v ?? 0) * 100);
    // Allowances by line (housing / transport / other) when the row carries the split and it adds
    // up to the stored recurring total; older rows print one line.
    const recurring = c(p.totalAllowances) - c(p.bonusAmount);
    const split = p.housingAllowance !== null && p.transportAllowance !== null && p.otherAllowances !== null
      && c(p.housingAllowance) + c(p.transportAllowance) + c(p.otherAllowances) === recurring
      ? [
          { key: 'HOUSING', labelAr: 'بدل السكن', labelEn: 'Housing allowance', v: c(p.housingAllowance) },
          { key: 'TRANSPORT', labelAr: 'بدل النقل', labelEn: 'Transportation allowance', v: c(p.transportAllowance) },
          { key: 'OTHER_ALLOWANCES', labelAr: 'بدلات أخرى', labelEn: 'Other allowances', v: c(p.otherAllowances) },
        ]
      : [{ key: 'ALLOWANCES', labelAr: 'البدلات', labelEn: 'Allowances', v: recurring }];
    const earn = [
      { key: 'BASIC', labelAr: 'الراتب الأساسي', labelEn: 'Basic salary', v: c(p.basicSalary) },
      ...split,
      { key: 'BONUS', labelAr: 'المكافآت', labelEn: 'Bonuses', v: c(p.bonusAmount) },
      { key: 'OVERTIME', labelAr: 'العمل الإضافي', labelEn: 'Overtime', v: c(p.overtimeCost) },
    ];
    const ded = [
      { key: 'GOSI', labelAr: 'حصة الموظف في التأمينات الاجتماعية', labelEn: 'GOSI (employee share)', v: c(p.gosiEmployee) },
      { key: 'LOANS', labelAr: 'أقساط السلف', labelEn: 'Loan installments', v: c(p.loansDeduction) },
      { key: 'VIOLATIONS', labelAr: 'جزاءات', labelEn: 'Penalties', v: c(p.violationsDeduction) },
      { key: 'LEAVE', labelAr: 'خصم إجازات', labelEn: 'Leave deduction', v: c(p.leaveDeduction) },
      { key: 'OTHER', labelAr: 'خصومات أخرى', labelEn: 'Other deductions', v: c(p.otherDeductions) },
    ];
    const gross = earn.reduce((s, r) => s + r.v, 0);
    const dedTotal = ded.reduce((s, r) => s + r.v, 0);
    // The payroll's own invariants (src/lib/payroll-core.ts): never print a slip that does not add up.
    if ([...earn, ...ded].some((r) => r.v < 0) || dedTotal !== c(p.totalDeductions) || Math.max(0, gross - dedTotal) !== c(p.netSalary)) {
      errors.push({ code: 'PAYROLL_INCONSISTENT', message: 'مبالغ سطر المسير المخزنة غير متسقة؛ راجع المسير' });
    }
    const rows = (list: typeof earn) => list.filter((r) => r.v > 0).map((r) => ({ key: r.key, labelAr: r.labelAr, labelEn: r.labelEn, amount: (r.v / 100).toFixed(2) }));
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        payroll: {
          id: p.id,
          year: p.year,
          month: p.month,
          periodAr: `${MONTHS_AR[p.month - 1]} ${p.year}`,
          periodEn: `${MONTHS_EN[p.month - 1]} ${p.year}`,
          paidDate: p.paidAt ? isoDay(p.paidAt) : null,
          earnings: rows(earn),
          deductions: rows(ded),
          gross: (gross / 100).toFixed(2),
          totalDeductions: (dedTotal / 100).toFixed(2),
          net: (c(p.netSalary) / 100).toFixed(2),
        },
      },
    };
  },
};

/**
 * Acceptance of the employee's own request to end the contract (owner decisions 2026-09-26):
 * resignation, mutual agreement or non-renewal, once HR approved it with the last working day.
 * Suggested by the system on approval (waits for approval like every suggestion).
 */
export const EXIT_ACCEPTANCE: DocumentTypeDefinition = {
  key: 'EXIT_ACCEPTANCE',
  languages: ['ar', 'ar-en'],
  code: 'RSG',
  contractVersion: 1,
  labelAr: 'خطاب الموافقة على إنهاء الخدمة',
  labelEn: 'Acceptance of Contract Termination',
  template: 'exit-acceptance',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'TERMINATION',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    exit: z.object({
      kind: z.enum(['RESIGNATION', 'MUTUAL_AGREEMENT', 'END_OF_CONTRACT']),
      requestDate: isoDate,
      lastWorkingDate: isoDate,
    }),
  }),
  build({ employee, company, params, termination: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const r = facts?.request ?? null;
    if (!r || r.employeeId !== employee.id) {
      errors.push({ code: 'TERMINATION_REQUEST_NOT_FOUND', message: 'طلب إنهاء الخدمة غير موجود لهذا الموظف' });
      return { errors, data: null };
    }
    if (r.status !== 'APPROVED') errors.push({ code: 'TERMINATION_NOT_APPROVED', message: 'طلب إنهاء الخدمة لم يُعتمد بعد' });
    if (!r.lastWorkingDate) errors.push({ code: 'NO_LAST_WORKING_DATE', message: 'آخر يوم عمل غير مسجل في الطلب؛ يُحدد عند اعتماده' });
    const kinds = ['RESIGNATION', 'MUTUAL_AGREEMENT', 'END_OF_CONTRACT'];
    if (!kinds.includes(r.terminationType)) errors.push({ code: 'TERMINATION_TYPE', message: 'نوع طلب إنهاء الخدمة غير معروف' });
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        exit: { kind: r.terminationType, requestDate: isoDay(r.createdAt), lastWorkingDate: r.lastWorkingDate ? isoDay(r.lastWorkingDate) : '' },
      },
    };
  },
};

/**
 * Termination notice from the company (owner decisions 2026-09-26): structured reason, notice
 * period and last working day, optional clarification; approved by a second person (locked),
 * hidden from the employee until issued, then acknowledged in the portal. Article 80 must rest on
 * a concluded investigation of the same employee. The letter does not terminate the employee in
 * the system (the existing termination flow does).
 */
export const TERMINATION_NOTICE: DocumentTypeDefinition = {
  key: 'TERMINATION_NOTICE',
  languages: ['ar'],
  code: 'TRM',
  contractVersion: 1,
  labelAr: 'إشعار إنهاء عقد العمل',
  labelEn: 'Termination Notice',
  template: 'termination-notice',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'INVESTIGATION',
  approvalLocked: true,
  acknowledgement: 'RECEIPT',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    notice: z.object({
      reason: z.enum(TERMINATION_NOTICE_REASONS),
      lastWorkingDate: isoDate,
      noticeDays: z.number().int().nullable(),
      detailsAr: z.string().nullable(),
      investigation: z.object({ subjectAr: z.string().min(1), closedDate: isoDate }).nullable(),
    }),
  }),
  build({ employee, company, params, investigation: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const n = params.terminationNotice;
    if (!n) {
      errors.push({ code: 'MISSING_NOTICE', message: 'حدد سبب الإنهاء وآخر يوم عمل' });
      return { errors, data: null };
    }
    let investigation: { subjectAr: string; closedDate: string } | null = null;
    if (n.reason === 'ARTICLE_80') {
      const inv = facts?.investigation ?? null;
      if (!inv || inv.employeeId !== employee.id) {
        errors.push({ code: 'INVESTIGATION_REQUIRED', message: 'الإنهاء وفق المادة 80 يستند إلى تحقيق منتهٍ مع الموظف نفسه؛ اختر التحقيق' });
      } else if (inv.status !== 'COMPLETED_GUILTY' && inv.status !== 'CLOSED') {
        errors.push({ code: 'INVESTIGATION_NOT_CONCLUDED', message: 'التحقيق المختار لم ينته بقرار إدانة' });
      } else if (!DOCUMENT_TEXT_RE.test(inv.subject)) {
        // Database text is printed too: refused now, not by the renderer after approval.
        errors.push({ code: 'INVESTIGATION_SUBJECT_TEXT', message: 'موضوع التحقيق يحتوي رموزاً لا تُطبع في المستندات الرسمية؛ عدّله في ملف التحقيق' });
      } else {
        investigation = { subjectAr: inv.subject.replace(/\s+/g, ' ').trim(), closedDate: isoDay(inv.updatedAt) };
      }
    } else if ((n.reason === 'NOTICE' || n.reason === 'NON_RENEWAL') && !(n.noticeDays && n.noticeDays > 0)) {
      errors.push({ code: 'NOTICE_DAYS_REQUIRED', message: 'حدد مدة الإشعار بالأيام' });
    }
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        notice: {
          reason: n.reason,
          lastWorkingDate: n.lastWorkingDate,
          noticeDays: n.reason === 'ARTICLE_80' ? null : n.noticeDays ?? null,
          detailsAr: n.detailsAr ?? null,
          investigation,
        },
      },
    };
  },
};

/**
 * Salary transfer letter to the employee's bank (owner decisions 2026-09-26): the company commits
 * to transfer the salary and the end-of-service dues to that account and not to move them without
 * the bank's release letter. Requested from the portal, always approved by a human. Bank and IBAN
 * come from the employee file (valid Saudi IBAN required).
 */
export const SALARY_TRANSFER: DocumentTypeDefinition = {
  key: 'SALARY_TRANSFER',
  languages: ['ar', 'ar-en'],
  code: 'STF',
  contractVersion: 1,
  labelAr: 'خطاب تحويل راتب',
  labelEn: 'Salary Transfer Letter',
  template: 'salary-transfer',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.PAYROLL,
  facts: 'BANK',
  approvalMandatory: true,
  defaults: { selfService: true, requiresApproval: true, validityDays: 90 },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    salary: salaryContract,
    bank: z.object({ name: z.string().min(1), iban: z.string().regex(/^SA\d{22}$/) }),
  }),
  build({ employee, company, params, bank }) {
    const b = baseBuild(employee, company, params);
    const salary = buildSalary(employee);
    const errors = [...b.errors, ...salary.errors];
    const name = clean(bank?.bankName);
    const iban = validateSaudiIban(bank?.iban ?? '');
    if (!name) errors.push({ code: 'MISSING_BANK', message: 'اسم البنك غير مسجل في ملف الموظف' });
    else if (!DOCUMENT_TEXT_RE.test(name)) errors.push({ code: 'BANK_NAME_TEXT', message: 'اسم البنك في ملف الموظف يحتوي رموزاً لا تُطبع' });
    if (!iban.valid) errors.push({ code: 'INVALID_IBAN', message: `آيبان الموظف: ${iban.message}` });
    return { errors, data: { employee: b.employee, company: b.company, salary: salary.value, bank: { name: name ?? '', iban: iban.normalized } } };
  },
};

/**
 * No-objection letter (owner decisions 2026-09-26): for a listed purpose (transfer of services,
 * study, travel, licence) and a destination the employee writes; requested from the portal and
 * always approved by HR (approvalMandatory: the text the employee wrote is approved word for word).
 */
export const NO_OBJECTION: DocumentTypeDefinition = {
  key: 'NO_OBJECTION',
  languages: ['ar', 'ar-en'],
  code: 'NOC',
  contractVersion: 1,
  labelAr: 'خطاب عدم ممانعة',
  labelEn: 'No Objection Letter',
  template: 'no-objection',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  approvalMandatory: true,
  defaults: { selfService: true, requiresApproval: true, validityDays: 30 },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    noc: z.object({ purpose: z.enum(NOC_PURPOSES), targetAr: z.string().min(1), detailsAr: z.string().nullable() }),
  }),
  build({ employee, company, params }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    if (!params.noc) errors.push({ code: 'MISSING_NOC', message: 'حدد الغرض والجهة' });
    const noc = params.noc ? { purpose: params.noc.purpose, targetAr: params.noc.targetAr, detailsAr: params.noc.detailsAr ?? null } : null;
    return { errors, data: { employee: b.employee, company: b.company, noc } };
  },
};

/**
 * Promotion / salary change decision (owner decision 2026-09-26): HR writes the new title and/or
 * basic salary and the effective date; a second person approves the exact change (locked); issuing
 * it creates an order that applies the change to the employee file on that date (change-orders.ts).
 * The snapshot carries the current values too, so an edit of the file before approval invalidates it.
 */
export const PROMOTION_DECISION: DocumentTypeDefinition = {
  key: 'PROMOTION_DECISION',
  languages: ['ar'],
  code: 'PRM',
  contractVersion: 1,
  labelAr: 'قرار ترقية أو تعديل راتب',
  labelEn: 'Promotion / Salary Change Decision',
  template: 'promotion-decision',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  approvalLocked: true,
  executesChange: true,
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    change: z.object({
      effectiveDate: isoDate,
      fromJobTitleAr: z.string().min(1),
      toJobTitleAr: z.string().nullable(),
      toJobTitleEn: z.string().nullable(),
      fromBasicSalary: amount,
      toBasicSalary: amount.nullable(),
      reasonAr: z.string().nullable(),
    }),
  }),
  build({ employee, company, params }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const p = params.promotion;
    if (!p) {
      errors.push({ code: 'MISSING_CHANGE', message: 'حدد المسمى الجديد أو الراتب الأساسي الجديد وتاريخ السريان' });
      return { errors, data: null };
    }
    const fromTitle = clean(employee.jobTitle) ?? '';
    const toTitle = p.newJobTitleAr && p.newJobTitleAr !== fromTitle ? p.newJobTitleAr : null;
    const fromSalary = toAmountString(employee.basicSalary);
    const toSalary = p.newBasicSalary !== undefined && toAmountString(p.newBasicSalary) !== fromSalary ? toAmountString(p.newBasicSalary) : null;
    if (!toTitle && !toSalary) errors.push({ code: 'NO_CHANGE', message: 'القيم الجديدة مطابقة لملف الموظف الحالي' });
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        change: {
          effectiveDate: p.effectiveDate,
          fromJobTitleAr: fromTitle,
          toJobTitleAr: toTitle,
          toJobTitleEn: toTitle ? p.newJobTitleEn ?? null : null,
          fromBasicSalary: fromSalary,
          toBasicSalary: toSalary,
          reasonAr: p.reasonAr ?? null,
        },
      },
    };
  },
};

/**
 * Contract addendum (owner decision 2026-09-27, SPEC §15 item 35): the terms HR changes (basic
 * salary, housing / transport allowance, job title, work location, contract end), approved by a
 * second person, then accepted or declined by the employee in the portal until the effective date.
 * Acceptance orders the change (EmployeeChangeOrder), applied on the effective date; a decline or
 * no answer changes nothing.
 */
export const CONTRACT_ADDENDUM: DocumentTypeDefinition = {
  key: 'CONTRACT_ADDENDUM',
  languages: ['ar'],
  code: 'AMD',
  contractVersion: 1,
  labelAr: 'ملحق عقد عمل',
  labelEn: 'Employment Contract Addendum',
  template: 'contract-addendum',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  approvalLocked: true,
  executesOnConsent: true,
  acknowledgement: 'CONSENT',
  addressedToEmployee: true,
  facts: 'ADDENDUM',
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    addendum: z.object({
      effectiveDate: isoDate,
      rows: z.array(z.object({ key: z.string(), labelAr: z.string(), fromAr: z.string(), toAr: z.string(), money: z.boolean() })).min(1),
      reasonAr: z.string().nullable(),
      /** What acceptance applies (null = unchanged). */
      apply: z.object({
        basicSalary: amount.nullable(),
        housingAllowance: amount.nullable(),
        transportAllowance: amount.nullable(),
        jobTitleAr: z.string().nullable(),
        jobTitleEn: z.string().nullable(),
        branchId: z.string().nullable(),
        contractEndDate: isoDate.nullable(),
      }),
    }),
  }),
  build({ employee, company, params, addendum: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const p = params.addendum;
    if (!p || !facts) {
      errors.push({ code: 'MISSING_CHANGE', message: 'حدد البنود التي تتغير وتاريخ السريان' });
      return { errors, data: null };
    }
    const rows: Array<{ key: string; labelAr: string; fromAr: string; toAr: string; money: boolean }> = [];
    const apply = {
      basicSalary: null as string | null, housingAllowance: null as string | null, transportAllowance: null as string | null,
      jobTitleAr: null as string | null, jobTitleEn: null as string | null, branchId: null as string | null, contractEndDate: null as string | null,
    };

    if (p.newBasicSalary !== undefined) {
      const from = toAmountString(employee.basicSalary);
      const to = toAmountString(p.newBasicSalary);
      if (to !== from) {
        rows.push({ key: 'BASIC', labelAr: 'الراتب الأساسي الشهري', fromAr: from, toAr: to, money: true });
        apply.basicSalary = to;
      }
    }
    const allowances = [
      { kind: 'HOUSING', value: p.newHousingAllowance, labelAr: 'بدل السكن', field: 'housingAllowance' },
      { kind: 'TRANSPORT', value: p.newTransportAllowance, labelAr: 'بدل النقل', field: 'transportAllowance' },
    ] as const;
    for (const a of allowances) {
      if (a.value === undefined) continue;
      const current = employee.allowances.filter((x) => x.isMonthly && allowanceKind(x) === a.kind);
      // One row per kind in the file, so acceptance knows which allowance it changes.
      if (current.length > 1) {
        errors.push({ code: `MULTIPLE_${a.kind}`, message: `في ملف الموظف أكثر من ${a.labelAr}؛ وحّدها في بند واحد أولاً` });
        continue;
      }
      const from = toAmountString(current[0]?.amount ?? 0);
      const to = toAmountString(a.value);
      if (to !== from) {
        rows.push({ key: a.kind, labelAr: `${a.labelAr} الشهري`, fromAr: from, toAr: to, money: true });
        apply[a.field] = to;
      }
    }
    if (p.newJobTitleAr) {
      const from = clean(employee.jobTitle) ?? '';
      if (p.newJobTitleAr !== from) {
        rows.push({ key: 'JOB_TITLE', labelAr: 'المسمى الوظيفي', fromAr: from || '-', toAr: p.newJobTitleAr, money: false });
        apply.jobTitleAr = p.newJobTitleAr;
        apply.jobTitleEn = p.newJobTitleEn ?? null;
      }
    }
    if (p.newBranchId) {
      if (!facts.newBranch) errors.push({ code: 'UNKNOWN_BRANCH', message: 'الفرع المحدد غير موجود' });
      else if (facts.newBranch.id !== facts.branch?.id) {
        rows.push({ key: 'BRANCH', labelAr: 'مكان العمل', fromAr: facts.branch?.nameAr ?? '-', toAr: facts.newBranch.nameAr, money: false });
        apply.branchId = facts.newBranch.id;
      }
    }
    if (p.newContractEndDate) {
      const from = facts.contractEndDate ? new Date(facts.contractEndDate.getTime() + 3 * 3600e3).toISOString().slice(0, 10) : null;
      if (p.newContractEndDate <= p.effectiveDate) {
        errors.push({ code: 'CONTRACT_END_BEFORE_EFFECTIVE', message: 'تاريخ انتهاء العقد الجديد يجب أن يكون بعد تاريخ السريان' });
      } else if (p.newContractEndDate !== from) {
        rows.push({ key: 'CONTRACT_END', labelAr: 'تاريخ انتهاء العقد', fromAr: from ?? 'غير محدد المدة', toAr: p.newContractEndDate, money: false });
        apply.contractEndDate = p.newContractEndDate;
      }
    }
    if (!rows.length && !errors.length) errors.push({ code: 'NO_CHANGE', message: 'القيم الجديدة مطابقة لملف الموظف الحالي' });
    return {
      errors,
      data: { employee: b.employee, company: b.company, addendum: { effectiveDate: p.effectiveDate, rows, reasonAr: p.reasonAr ?? null, apply } },
    };
  },
};

/**
 * Job offer to a candidate (owner decision 2026-09-26): terms written by HR, approved by a second
 * person, delivered through a private link where the candidate downloads it and accepts or
 * declines. Valid 14 days by default (the offer's deadline).
 */
export const JOB_OFFER: DocumentTypeDefinition = {
  key: 'JOB_OFFER',
  languages: ['ar', 'ar-en'],
  code: 'OFR',
  contractVersion: 1,
  labelAr: 'عرض وظيفي',
  labelEn: 'Job Offer',
  template: 'job-offer',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  subject: 'CANDIDATE',
  approvalLocked: true,
  acknowledgement: 'OFFER',
  defaults: { selfService: false, requiresApproval: true, validityDays: 14 },
  requiresActiveEmployee: false,
  contract: z.object({
    candidate: z.object({ nameAr: z.string().min(1) }),
    company: companyContract,
    offer: z.object({
      jobTitleAr: z.string().min(1),
      jobTitleEn: z.string().nullable(),
      salary: salaryContract,
      startDate: isoDate,
      probationDays: z.number().int(),
      annualLeaveDays: z.number().int(),
      notesAr: z.string().nullable(),
    }),
  }),
  build() {
    return { errors: [{ code: 'SUBJECT', message: 'العرض الوظيفي يصدر لمرشح لا لموظف' }], data: null };
  },
  buildCandidate({ candidate, company, params }) {
    const co = buildCompany(company, params.language);
    const errors = [...co.errors];
    const o = params.offer;
    const name = clean(candidate.candidateName);
    if (!name) errors.push({ code: 'MISSING_NAME', message: 'اسم المرشح غير مسجل' });
    else if (!DOCUMENT_TEXT_RE.test(name)) errors.push({ code: 'NAME_TEXT', message: 'اسم المرشح يحتوي رموزاً لا تُطبع' });
    if (candidate.status === 'REJECTED' || candidate.status === 'HIRED') errors.push({ code: 'CANDIDATE_CLOSED', message: 'طلب التوظيف مغلق (مرفوض أو تم التوظيف)' });
    if (!o) {
      errors.push({ code: 'MISSING_OFFER', message: 'أكمل شروط العرض' });
      return { errors, data: null };
    }
    if (params.language === 'ar-en' && !o.jobTitleEn) errors.push({ code: 'MISSING_JOB_TITLE_EN', message: 'المسمى بالإنجليزية مطلوب للعرض ثنائي اللغة' });
    const rows = [{ key: 'BASIC', labelAr: 'الراتب الأساسي', labelEn: 'Basic Salary', amount: toAmountString(o.basicSalary) }];
    for (const [key, v] of [['HOUSING', o.housingAllowance], ['TRANSPORT', o.transportAllowance], ['OTHER', o.otherAllowances]] as const) {
      if (v && v > 0) rows.push({ key, labelAr: ALLOWANCE_LABELS[key].ar, labelEn: ALLOWANCE_LABELS[key].en, amount: toAmountString(v) });
    }
    return {
      errors,
      data: {
        candidate: { nameAr: name ?? '' },
        company: co.value,
        offer: {
          jobTitleAr: o.jobTitleAr, jobTitleEn: o.jobTitleEn ?? null, salary: { rows, total: sumAmounts(rows.map((r) => r.amount)) },
          startDate: o.startDate, probationDays: o.probationDays, annualLeaveDays: o.annualLeaveDays, notesAr: o.notesAr ?? null,
        },
      },
    };
  },
};

const LEAVE_TYPES: Record<string, { ar: string; en: string }> = {
  ANNUAL: { ar: 'إجازة سنوية', en: 'Annual leave' },
  DEDUCTED: { ar: 'إجازة مستقطعة من الرصيد', en: 'Leave deducted from balance' },
  EMERGENCY: { ar: 'إجازة اضطرارية', en: 'Emergency leave' },
  UNPAID: { ar: 'إجازة بدون أجر', en: 'Unpaid leave' },
  PATERNITY: { ar: 'إجازة مولود', en: 'Paternity leave' },
  BEREAVEMENT: { ar: 'إجازة وفاة قريب', en: 'Bereavement leave' },
  MARRIAGE: { ar: 'إجازة زواج', en: 'Marriage leave' },
  HAJJ: { ar: 'إجازة حج', en: 'Hajj leave' },
};
/** Leave types with a letter: SICK and MATERNITY are health data and never go into a third-party letter. */
export const LEAVE_LETTER_TYPES: readonly string[] = Object.keys(LEAVE_TYPES);

/**
 * Leave approval letter (owner decision 2026-09-26): issued automatically once a leave is approved
 * (the approval is the leave's own, unsigned like the payslip), for embassies and other parties.
 * Follows the leave: changed dates reissue it, a cancelled leave revokes it (leave-letters in service.ts).
 */
export const LEAVE_APPROVAL: DocumentTypeDefinition = {
  key: 'LEAVE_APPROVAL',
  languages: ['ar', 'ar-en'],
  code: 'LVE',
  contractVersion: 1,
  labelAr: 'خطاب الموافقة على إجازة',
  labelEn: 'Leave Approval Letter',
  template: 'leave-approval',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'LEAVE',
  issuance: 'AUTO',
  defaults: { selfService: false, requiresApproval: false, validityDays: null },
  requiresActiveEmployee: true,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    leave: z.object({
      id: z.string().min(1), typeAr: z.string().min(1), typeEn: z.string().min(1),
      startDate: isoDate, endDate: isoDate, returnDate: isoDate, totalDays: z.number().int().positive(), outsideKsa: z.boolean(),
    }),
  }),
  build({ employee, company, params, leave: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const l = facts?.leave ?? null;
    if (!l || l.employeeId !== employee.id) {
      errors.push({ code: 'LEAVE_NOT_FOUND', message: 'الإجازة غير موجودة لهذا الموظف' });
      return { errors, data: null };
    }
    if (l.status !== 'APPROVED' && l.status !== 'COMPLETED') errors.push({ code: 'LEAVE_NOT_APPROVED', message: 'الإجازة غير معتمدة' });
    const kind = LEAVE_TYPES[l.leaveType];
    if (!kind) errors.push({ code: 'LEAVE_TYPE_NO_LETTER', message: 'لا يصدر خطاب لهذا النوع من الإجازات (بيانات صحية)' });
    const end = isoDay(l.endDate);
    const ret = new Date(`${end}T00:00:00+03:00`);
    ret.setUTCDate(ret.getUTCDate() + 1);
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        leave: {
          id: l.id, typeAr: kind?.ar ?? '', typeEn: kind?.en ?? '',
          startDate: isoDay(l.startDate), endDate: end, returnDate: isoDay(ret), totalDays: l.totalDays, outsideKsa: l.isOutsideKSA,
        },
      },
    };
  },
};

/**
 * Work commencement (owner decisions 2026-09-27, SPEC §15 item 36): the employee started work on a
 * date, either on joining (the file's join date) or back from a leave (the confirmed actual return,
 * with the delay against the scheduled return when there is one). Two types share the builder and
 * the template: an automatic, unsigned notice issued when HR confirms the commencement, and a
 * signed letter the employee or HR requests, approved like any signed letter.
 */
function buildCommencement({ employee, company, params, commencement: facts }: BuildInput, requested: boolean) {
  const b = baseBuild(employee, company, params);
  const errors = [...b.errors];
  const kind = params.commencement?.kind ?? 'JOIN';
  if (kind === 'JOIN') {
    return { errors, data: { employee: b.employee, company: b.company, commencement: { kind, requested, date: isoDay(employee.joinDate), leave: null } } };
  }
  const l = facts?.leave ?? null;
  if (!l || l.employeeId !== employee.id) {
    errors.push({ code: 'LEAVE_NOT_FOUND', message: 'لا توجد إجازة مؤكدة العودة لهذا الموظف' });
    return { errors, data: null };
  }
  if (!l.isReturned || !l.actualReturnDate) {
    errors.push({ code: 'RETURN_NOT_CONFIRMED', message: 'لم تؤكد الموارد البشرية مباشرة الموظف بعد هذه الإجازة' });
    return { errors, data: null };
  }
  const end = isoDay(l.endDate);
  const scheduled = new Date(`${end}T00:00:00+03:00`);
  scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  const actual = isoDay(l.actualReturnDate);
  const lateDays = Math.max(0, Math.round((Date.parse(`${actual}T00:00:00Z`) - Date.parse(`${isoDay(scheduled)}T00:00:00Z`)) / 86_400_000));
  return {
    errors,
    data: {
      employee: b.employee,
      company: b.company,
      commencement: {
        kind,
        requested,
        date: actual,
        // Health leaves (sick, maternity) are not named in a letter.
        leave: { id: l.id, typeAr: LEAVE_TYPES[l.leaveType]?.ar ?? null, startDate: isoDay(l.startDate), endDate: end, scheduledReturn: isoDay(scheduled), lateDays },
      },
    },
  };
}

const commencementContract = z.object({
  employee: employeeContract,
  company: companyContract,
  commencement: z.object({
    kind: z.enum(['JOIN', 'RETURN']),
    /** Signed letter asked for (printed "upon his request"), or the automatic notice. */
    requested: z.boolean(),
    date: isoDate,
    leave: z.object({
      id: z.string().min(1), typeAr: z.string().nullable(), startDate: isoDate, endDate: isoDate, scheduledReturn: isoDate, lateDays: z.number().int().min(0),
    }).nullable(),
  }),
});

/** Automatic notice (AUTO: no approval, no signature), one per confirmed commencement (sourceRef). */
export const WORK_COMMENCEMENT: DocumentTypeDefinition = {
  key: 'WORK_COMMENCEMENT',
  languages: ['ar'],
  code: 'CMN',
  contractVersion: 1,
  labelAr: 'إشعار مباشرة عمل',
  labelEn: 'Work Commencement Notice',
  template: 'work-commencement',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'COMMENCEMENT',
  issuance: 'AUTO',
  defaults: { selfService: false, requiresApproval: false, validityDays: null },
  requiresActiveEmployee: true,
  contract: commencementContract,
  build: (input) => buildCommencement(input, false),
};

/** Signed letter on request (portal or HR), e.g. for a government body. */
export const WORK_COMMENCEMENT_LETTER: DocumentTypeDefinition = {
  key: 'WORK_COMMENCEMENT_LETTER',
  languages: ['ar'],
  code: 'CML',
  contractVersion: 1,
  labelAr: 'خطاب مباشرة عمل',
  labelEn: 'Work Commencement Letter',
  template: 'work-commencement',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'COMMENCEMENT',
  defaults: { selfService: true, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: true,
  contract: commencementContract,
  build: (input) => buildCommencement(input, true),
};

/**
 * Administrative decision / circular (2026-09-27, SPEC §15 item 37): a document of the legal company
 * to a group of employees (whole company, branches, departments or named employees), issued by HR
 * and, by default, approved by a second person (the company may change it in the type settings).
 * The recipients are resolved into the snapshot, so the approval covers exactly who gets it; each
 * recipient finds it in the portal and, when asked, acknowledges having read it.
 */
const CIRCULAR_MAX_LISTED = 50;
export const ADMIN_CIRCULAR: DocumentTypeDefinition = {
  key: 'ADMIN_CIRCULAR',
  languages: ['ar'],
  code: 'CIR',
  contractVersion: 1,
  labelAr: 'قرار إداري / تعميم',
  labelEn: 'Administrative Decision / Circular',
  template: 'admin-circular',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  subject: 'COMPANY',
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    company: companyContract,
    circular: z.object({
      kind: z.enum(['DECISION', 'CIRCULAR']),
      subjectAr: z.string().min(3),
      bodyAr: z.string().min(10),
      effectiveDate: isoDate.nullable(),
      acknowledge: z.boolean(),
      scope: z.enum(['COMPANY', 'BRANCHES', 'DEPARTMENTS', 'EMPLOYEES']),
      /** "To:" line: the whole staff, the groups by name, or "the employees listed below". */
      addresseeAr: z.string().min(3),
      recipientIds: z.array(z.string().min(1)).min(1),
      /** Named employees are listed in the document (EMPLOYEES scope only). */
      listed: z.array(z.object({ employeeNumber: z.string(), nameAr: z.string() })).nullable(),
    }),
  }),
  titleOf(data) {
    return (data as { circular?: { kind?: string } }).circular?.kind === 'DECISION'
      ? { ar: 'قرار إداري', en: 'Administrative Decision' }
      : { ar: 'تعميم إداري', en: 'Administrative Circular' };
  },
  buildCompanyDoc({ company, params, circular: facts }) {
    const co = buildCompany(company, params.language);
    const errors = [...co.errors];
    const c = params.circular;
    if (!c) {
      errors.push({ code: 'MISSING_CIRCULAR', message: 'اكتب موضوع القرار أو التعميم ونصه وحدد المستلمين' });
      return { errors, data: null };
    }
    const scope = c.audience.scope;
    if (scope !== 'COMPANY' && !c.audience.ids.length) errors.push({ code: 'NO_AUDIENCE', message: 'اختر الفروع أو الإدارات أو الموظفين المستلمين' });
    if (facts.unknownIds.length) errors.push({ code: 'UNKNOWN_AUDIENCE', message: 'بعض المستلمين المختارين غير موجودين في هذه الشركة أو انتهت خدمتهم' });
    if (!facts.recipients.length) errors.push({ code: 'NO_RECIPIENTS', message: 'لا يوجد موظفون على رأس العمل ضمن المستلمين المختارين' });
    if (scope === 'EMPLOYEES' && facts.recipients.length > CIRCULAR_MAX_LISTED) {
      errors.push({ code: 'TOO_MANY_LISTED', message: `اختر فروعاً أو إدارات بدلاً من أكثر من ${CIRCULAR_MAX_LISTED} موظفاً بالاسم` });
    }
    const addresseeAr = scope === 'COMPANY'
      ? `جميع منسوبي ${co.value.legalNameAr}`
      : scope === 'BRANCHES'
        ? `منسوبي ${facts.groups.join('، ')}`
        : scope === 'DEPARTMENTS'
          ? `منسوبي ${facts.groups.join('، ')}`
          : 'الموظفون المذكورون أدناه';
    return {
      errors,
      data: {
        company: co.value,
        circular: {
          kind: c.kind, subjectAr: c.subjectAr, bodyAr: c.bodyAr, effectiveDate: c.effectiveDate ?? null, acknowledge: c.acknowledge,
          scope, addresseeAr,
          recipientIds: facts.recipients.map((r) => r.id).sort(),
          listed: scope === 'EMPLOYEES' ? facts.recipients.map((r) => ({ employeeNumber: r.employeeNumber, nameAr: r.nameAr })) : null,
        },
      },
    };
  },
  build() {
    return { errors: [{ code: 'SUBJECT', message: 'هذا المستند يصدر من الشركة لمجموعة من الموظفين' }], data: null };
  },
};

const RECOMMENDATIONS: Record<string, string> = {
  NO_ACTION: 'لا إجراء', BONUS: 'مكافأة', PROMOTION: 'ترقية', RAISE: 'زيادة في الراتب', TRAINING: 'تدريب', WARNING: 'إنذار',
  NOTICE: 'لفت نظر', EXTEND_MONITORING: 'تمديد المتابعة', NO_RENEWAL: 'عدم تجديد العقد', TERMINATION: 'إنهاء الخدمة', OTHER: 'أخرى',
};

/**
 * Evaluation report (owner decision 2026-09-26): issued automatically when the evaluation closes
 * (approved, then acknowledged by the employee, whose date and comment it prints). Arabic, unsigned
 * like other automatic documents; texts from the evaluation are printed via printable().
 */
export const EVALUATION_REPORT: DocumentTypeDefinition = {
  key: 'EVALUATION_REPORT',
  languages: ['ar'],
  code: 'EVL',
  contractVersion: 1,
  labelAr: 'تقرير تقييم الأداء',
  labelEn: 'Performance Evaluation Report',
  template: 'evaluation-report',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'EVALUATION',
  issuance: 'AUTO',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: false, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    evaluation: z.object({
      cycleTitle: z.string().min(1), periodStart: isoDate, periodEnd: isoDate,
      sections: z.array(z.object({ title: z.string(), weight: z.string(), items: z.array(z.object({ title: z.string(), score: z.number().int(), note: z.string().nullable() })) })).min(1),
      totalScore: z.string().nullable(), finalRating: z.string().nullable(), recommendationAr: z.string().nullable(), recommendationReason: z.string().nullable(),
      strengths: z.string().nullable(), improvements: z.string().nullable(), finalNotes: z.string().nullable(),
      acknowledgedDate: isoDate.nullable(), employeeComment: z.string().nullable(),
    }),
  }),
  build({ employee, company, params, evaluation: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const ev = facts?.evaluation ?? null;
    if (!ev || ev.employeeId !== employee.id) {
      errors.push({ code: 'EVALUATION_NOT_FOUND', message: 'التقييم غير موجود لهذا الموظف' });
      return { errors, data: null };
    }
    if (ev.status !== 'CLOSED') errors.push({ code: 'EVALUATION_NOT_CLOSED', message: 'التقييم لم يكتمل بعد' });
    const sections = ev.sections
      .map((s) => ({ title: printable(s.title) ?? '', weight: String(Math.round(s.weight * 100) / 100), items: s.items.map((i) => ({ title: printable(i.title) ?? '', score: i.score, note: printable(i.note) })) }))
      .filter((s) => s.items.length);
    if (!sections.length) errors.push({ code: 'EVALUATION_EMPTY', message: 'لا توجد درجات في التقييم' });
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        evaluation: {
          cycleTitle: printable(ev.cycle.title) ?? 'تقييم الأداء', periodStart: isoDay(ev.cycle.startDate), periodEnd: isoDay(ev.cycle.endDate),
          sections,
          totalScore: ev.totalScore !== null ? (Math.round(ev.totalScore * 10) / 10).toFixed(1) : null,
          finalRating: printable(ev.finalRating), recommendationAr: ev.recommendation ? RECOMMENDATIONS[ev.recommendation] ?? null : null,
          recommendationReason: printable(ev.recommendationReason), strengths: printable(ev.strengths), improvements: printable(ev.improvements), finalNotes: printable(ev.finalNotes),
          acknowledgedDate: ev.employeeAcknowledgedAt ? isoDay(ev.employeeAcknowledgedAt) : null, employeeComment: printable(ev.employeeComment),
        },
      },
    };
  },
};

const INVESTIGATION_OUTCOME: Record<string, string> = { COMPLETED_GUILTY: 'ثبتت المخالفة', COMPLETED_INNOCENT: 'لم تثبت المخالفة', CLOSED: 'أغلق التحقيق' };
const INVESTIGATION_CATEGORY: Record<string, string> = { ATTENDANCE: 'الحضور والانصراف', BEHAVIORAL: 'سلوكية', SERIOUS: 'جسيمة', PERFORMANCE: 'الأداء' };

/**
 * Investigation minutes (owner decisions 2026-09-26): suggested when an investigation concludes,
 * approved by a second person (locked; hidden from the employee until issued), then acknowledged
 * by the employee in the portal. Texts come from the investigation file (printable()).
 */
export const INVESTIGATION_MINUTES: DocumentTypeDefinition = {
  key: 'INVESTIGATION_MINUTES',
  languages: ['ar'],
  code: 'INV',
  contractVersion: 1,
  labelAr: 'محضر تحقيق',
  labelEn: 'Investigation Minutes',
  template: 'investigation-minutes',
  templateVersion: 1,
  staffRoles: ROLE_GROUPS.HR,
  facts: 'INVESTIGATION',
  approvalLocked: true,
  acknowledgement: 'RECEIPT',
  addressedToEmployee: true,
  defaults: { selfService: false, requiresApproval: true, validityDays: null },
  requiresActiveEmployee: false,
  contract: z.object({
    employee: employeeContract,
    company: companyContract,
    minutes: z.object({
      subjectAr: z.string().min(1), categoryAr: z.string().nullable(), openedDate: isoDate, closedDate: isoDate, outcomeAr: z.string().min(1),
      description: z.string().nullable(), findings: z.string().nullable(), recommendation: z.string().nullable(), finalDecision: z.string().nullable(),
      penaltyAmount: amount.nullable(), penaltyDays: z.number().int().nullable(), investigator: z.string().nullable(),
    }),
  }),
  build({ employee, company, params, investigation: facts }) {
    const b = baseBuild(employee, company, params);
    const errors = [...b.errors];
    const i = facts?.investigation ?? null;
    if (!i || i.employeeId !== employee.id) {
      errors.push({ code: 'INVESTIGATION_NOT_FOUND', message: 'التحقيق غير موجود لهذا الموظف' });
      return { errors, data: null };
    }
    const outcome = INVESTIGATION_OUTCOME[i.status];
    if (!outcome) errors.push({ code: 'INVESTIGATION_NOT_CONCLUDED', message: 'التحقيق لم ينته بعد' });
    const investigator = [printable(i.investigatorName), printable(i.investigatorRole)].filter(Boolean).join(' - ') || null;
    return {
      errors,
      data: {
        employee: b.employee,
        company: b.company,
        minutes: {
          subjectAr: printable(i.subject) ?? 'تحقيق', categoryAr: i.category ? INVESTIGATION_CATEGORY[i.category] ?? null : null,
          openedDate: isoDay(i.createdAt ?? i.updatedAt), closedDate: isoDay(i.updatedAt), outcomeAr: outcome ?? '',
          description: printable(i.description), findings: printable(i.findings), recommendation: printable(i.recommendation), finalDecision: printable(i.finalDecision),
          penaltyAmount: i.penaltyAmount && i.penaltyAmount > 0 ? toAmountString(i.penaltyAmount) : null,
          penaltyDays: i.penaltyDays && i.penaltyDays > 0 ? i.penaltyDays : null,
          investigator,
        },
      },
    };
  },
};

export const DOCUMENT_TYPES: Readonly<Record<string, DocumentTypeDefinition>> = Object.freeze({
  [SALARY_CERTIFICATE.key]: SALARY_CERTIFICATE,
  [EMPLOYMENT_CERTIFICATE.key]: EMPLOYMENT_CERTIFICATE,
  [EXPERIENCE_CERTIFICATE.key]: EXPERIENCE_CERTIFICATE,
  [WARNING_LETTER.key]: WARNING_LETTER,
  [CLEARANCE_CERTIFICATE.key]: CLEARANCE_CERTIFICATE,
  [SETTLEMENT_STATEMENT.key]: SETTLEMENT_STATEMENT,
  [PAYSLIP.key]: PAYSLIP,
  [EXIT_ACCEPTANCE.key]: EXIT_ACCEPTANCE,
  [TERMINATION_NOTICE.key]: TERMINATION_NOTICE,
  [SALARY_TRANSFER.key]: SALARY_TRANSFER,
  [NO_OBJECTION.key]: NO_OBJECTION,
  [PROMOTION_DECISION.key]: PROMOTION_DECISION,
  [JOB_OFFER.key]: JOB_OFFER,
  [LEAVE_APPROVAL.key]: LEAVE_APPROVAL,
  [EVALUATION_REPORT.key]: EVALUATION_REPORT,
  [INVESTIGATION_MINUTES.key]: INVESTIGATION_MINUTES,
  [CONTRACT_ADDENDUM.key]: CONTRACT_ADDENDUM,
  [WORK_COMMENCEMENT.key]: WORK_COMMENCEMENT,
  [WORK_COMMENCEMENT_LETTER.key]: WORK_COMMENCEMENT_LETTER,
  [ADMIN_CIRCULAR.key]: ADMIN_CIRCULAR,
});

export function getDocumentType(key: string): DocumentTypeDefinition | null {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, key) ? DOCUMENT_TYPES[key] : null;
}

/** Contract data for a request; throws ContractValidationError listing everything to fix. */
/** Contract data of a candidate document (JOB_OFFER); throws ContractValidationError like buildContractData. */
export function buildCandidateContractData(def: DocumentTypeDefinition, input: { candidate: CandidateRecord; company: CompanyRecord; params: DocumentParams }) {
  if (def.subject !== 'CANDIDATE' || !def.buildCandidate) throw new ContractValidationError([{ code: 'SUBJECT', message: 'هذا المستند يصدر لموظف' }]);
  const { errors, data } = def.buildCandidate(input);
  if (!def.languages.includes(input.params.language)) errors.unshift({ code: 'LANGUAGE_NOT_SUPPORTED', message: `${def.labelAr} يصدر بالعربية فقط` });
  if (errors.length) throw new ContractValidationError(errors);
  const parsed = def.contract.safeParse(data);
  if (!parsed.success) {
    throw new ContractValidationError(parsed.error.issues.map((i) => ({ code: 'CONTRACT', message: `بيانات غير صالحة: ${i.path.join('.')}` })));
  }
  return parsed.data as Record<string, unknown>;
}

export function buildCompanyContractData(def: DocumentTypeDefinition, input: { company: CompanyRecord; params: DocumentParams; circular: CircularFacts }) {
  if (def.subject !== 'COMPANY' || !def.buildCompanyDoc) throw new ContractValidationError([{ code: 'SUBJECT', message: 'هذا المستند يصدر لموظف' }]);
  const { errors, data } = def.buildCompanyDoc(input);
  if (!def.languages.includes(input.params.language)) errors.unshift({ code: 'LANGUAGE_NOT_SUPPORTED', message: `${def.labelAr} يصدر بالعربية فقط` });
  if (errors.length) throw new ContractValidationError(errors);
  const parsed = def.contract.safeParse(data);
  if (!parsed.success) {
    throw new ContractValidationError(parsed.error.issues.map((i) => ({ code: 'CONTRACT', message: `بيانات غير صالحة: ${i.path.join('.')}` })));
  }
  return parsed.data as Record<string, unknown>;
}

export function buildContractData(def: DocumentTypeDefinition, input: BuildInput) {
  if (def.subject === 'COMPANY') throw new ContractValidationError([{ code: 'SUBJECT', message: 'هذا المستند يصدر من الشركة لمجموعة من الموظفين' }]);
  if (def.subject === 'CANDIDATE') throw new ContractValidationError([{ code: 'SUBJECT', message: 'هذا المستند يصدر لمرشح' }]);
  const { errors, data } = def.build(input);
  if (!def.languages.includes(input.params.language)) {
    errors.unshift({ code: 'LANGUAGE_NOT_SUPPORTED', message: `${def.labelAr} يصدر بالعربية فقط` });
  }
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
