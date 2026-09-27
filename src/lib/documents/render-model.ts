// Render model (ADR DOC-01): snapshot values -> display strings. The template lays out exactly
// these strings; it formats nothing. Deterministic: same snapshot + meta -> same model -> same PDF.
import { stripArabicMarks } from './core';
import { digits, formatAmount, formatGregorian, formatHijri, pageNumbering, type Numerals } from './format';
import type { DocumentLanguage } from './types';
import { SETTLEMENT_PAYMENT_METHODS, type SettlementPaymentMethod } from '@/lib/settlement-payment';

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
  /** The letter is addressed to the employee himself (warning). */
  addressedToEmployee?: boolean;
  signature: SignatureBlock | null;
  hasLogo: boolean;
}

type Contract = {
  /** Absent on a candidate document (job offer): candidate is set instead. */
  candidate?: { nameAr: string };
  /** Company document (administrative decision / circular): no employee, a group of recipients. */
  circular?: {
    kind: 'DECISION' | 'CIRCULAR'; subjectAr: string; bodyAr: string; effectiveDate: string | null; acknowledge: boolean;
    scope: string; addresseeAr: string; recipientIds: string[]; listed: { employeeNumber: string; nameAr: string }[] | null;
  };
  offer?: {
    jobTitleAr: string; jobTitleEn: string | null; salary: { rows: { key: string; labelAr: string; labelEn: string; amount: string }[]; total: string };
    startDate: string; probationDays: number; annualLeaveDays: number; notesAr: string | null;
  };
  employee?: {
    fullNameAr: string; fullNameEn: string | null; employeeNumber: string; nationalityAr: string; nationalityEn: string | null;
    idKind: 'IQAMA' | 'NATIONAL_ID'; idNumber: string; passportNumber: string | null; jobTitleAr: string; jobTitleEn: string | null; joinDate: string;
  };
  company: { legalNameAr: string; legalNameEn: string | null; crNumber: string; unifiedNumber: string | null };
  salary?: { rows: { key: string; labelAr: string; labelEn: string; amount: string }[]; total: string };
  service?: { startDate: string; endDate: string | null; inService: boolean };
  warning?: { subjectAr: string; bodyAr: string; incidentDate: string | null };
  clearance?: { lastWorkingDate: string };
  bank?: { name: string; iban: string };
  change?: {
    effectiveDate: string; fromJobTitleAr: string; toJobTitleAr: string | null; toJobTitleEn: string | null;
    fromBasicSalary: string; toBasicSalary: string | null; reasonAr: string | null;
  };
  commencement?: {
    kind: 'JOIN' | 'RETURN'; requested: boolean; date: string;
    leave: { id: string; typeAr: string | null; startDate: string; endDate: string; scheduledReturn: string; lateDays: number } | null;
  };
  addendum?: {
    effectiveDate: string; reasonAr: string | null;
    rows: { key: string; labelAr: string; fromAr: string; toAr: string; money: boolean }[];
  };
  /** The company's own opening / closing paragraphs for this type (texts.ts). */
  texts?: { openingAr: string | null; openingEn: string | null; closingAr: string | null; closingEn: string | null };
  minutes?: {
    subjectAr: string; categoryAr: string | null; openedDate: string; closedDate: string; outcomeAr: string;
    description: string | null; findings: string | null; recommendation: string | null; finalDecision: string | null;
    penaltyAmount: string | null; penaltyDays: number | null; investigator: string | null;
  };
  evaluation?: {
    cycleTitle: string; periodStart: string; periodEnd: string;
    sections: { title: string; weight: string; items: { title: string; score: number; note: string | null }[] }[];
    totalScore: string | null; finalRating: string | null; recommendationAr: string | null; recommendationReason: string | null;
    strengths: string | null; improvements: string | null; finalNotes: string | null; acknowledgedDate: string | null; employeeComment: string | null;
  };
  leave?: { typeAr: string; typeEn: string; startDate: string; endDate: string; returnDate: string; totalDays: number; outsideKsa: boolean };
  noc?: { purpose: 'SERVICE_TRANSFER' | 'STUDY' | 'TRAVEL' | 'LICENSE'; targetAr: string; detailsAr: string | null };
  notice?: {
    reason: 'NOTICE' | 'NON_RENEWAL' | 'PROBATION' | 'ARTICLE_80';
    lastWorkingDate: string;
    noticeDays: number | null;
    detailsAr: string | null;
    investigation: { subjectAr: string; closedDate: string } | null;
  };
  exit?: { kind: 'RESIGNATION' | 'MUTUAL_AGREEMENT' | 'END_OF_CONTRACT'; requestDate: string; lastWorkingDate: string };
  payroll?: {
    periodAr: string;
    periodEn: string;
    paidDate: string | null;
    earnings: { labelAr: string; labelEn: string; amount: string }[];
    deductions: { labelAr: string; labelEn: string; amount: string }[];
    gross: string;
    totalDeductions: string;
    net: string;
  };
  settlement?: {
    kind: 'END_OF_SERVICE' | 'LEAVE_SETTLEMENT';
    reasonAr: string | null;
    reasonEn: string | null;
    lastWorkingDate: string | null;
    yearsOfService: string | null;
    entitlements: { labelAr: string; labelEn: string; amount: string }[];
    deductions: { labelAr: string; labelEn: string; amount: string }[];
    totalEntitlements: string;
    totalDeductions: string;
    net: string;
    payment: { method: SettlementPaymentMethod; reference: string; paidDate: string; amount: string; receiptSha256: string | null };
  };
};

const moneyRows = (rows: { labelAr: string; labelEn: string; amount: string }[], n: Numerals) =>
  rows.map((r) => ({ labelAr: r.labelAr, labelEn: r.labelEn, amountText: formatAmount(r.amount, n), amountTextEn: formatAmount(r.amount, 'latn') }));

const DEFAULT_ADDRESSEE = { ar: 'إلى من يهمه الأمر', en: 'To Whom It May Concern' };

/**
 * A count of days in Arabic with the counted noun in agreement: يوما واحدا, يومين, 3-10 أيام,
 * 11 and more يوما. The number (when printed) is its own LTR run in the template.
 */
export function arabicDays(count: number, n: Numerals): { number: string | null; unit: string } {
  if (count === 1) return { number: null, unit: 'يوما واحدا' };
  if (count === 2) return { number: null, unit: 'يومين' };
  return { number: digits(String(count), n), unit: count % 100 >= 3 && count % 100 <= 10 ? 'أيام' : 'يوما' };
}

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
    addressee: data.candidate
      ? { ar: data.candidate.nameAr, en: data.candidate.nameAr }
      : data.circular
      ? { ar: data.circular.addresseeAr, en: data.circular.addresseeAr }
      : data.bank
      ? { ar: `السادة/ ${data.bank.name} المحترمين`, en: data.bank.name }
      : meta.addressedToEmployee && e
      ? { ar: `${e.fullNameAr} (الرقم الوظيفي ${e.employeeNumber})`, en: e.fullNameEn ?? e.fullNameAr }
      : { ar: meta.addresseeAr || DEFAULT_ADDRESSEE.ar, en: meta.addresseeEn || DEFAULT_ADDRESSEE.en },
    employee: e ? {
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
    } : null,
    candidate: data.candidate ?? null,
    offer: data.offer
      ? {
          jobTitleAr: data.offer.jobTitleAr,
          jobTitleEn: data.offer.jobTitleEn ?? data.offer.jobTitleAr, // the English column is evaluated even in Arabic-only letters
          currencyAr: 'ريال سعودي',
          currencyEn: 'SAR',
          rows: data.offer.salary.rows.map((r) => ({ labelAr: r.labelAr, labelEn: r.labelEn, amountText: formatAmount(r.amount, n), amountTextEn: formatAmount(r.amount, 'latn') })),
          totalText: formatAmount(data.offer.salary.total, n),
          totalTextEn: formatAmount(data.offer.salary.total, 'latn'),
          startAr: formatGregorian(data.offer.startDate, 'ar', n),
          startEn: formatGregorian(data.offer.startDate, 'en'),
          probationDays: digits(String(data.offer.probationDays), n),
          probationDaysEn: String(data.offer.probationDays),
          annualLeaveDays: digits(String(data.offer.annualLeaveDays), n),
          annualLeaveDaysEn: String(data.offer.annualLeaveDays),
          notesAr: data.offer.notesAr,
        }
      : null,
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
    warning: data.warning
      ? {
          subjectAr: data.warning.subjectAr,
          // Paragraphs split on empty lines; the lines inside a paragraph keep their breaks.
          paragraphs: data.warning.bodyAr.split(/\n{2,}/).map((p) => p.split('\n')),
          incidentDateAr: data.warning.incidentDate ? formatGregorian(data.warning.incidentDate, 'ar', n) : null,
        }
      : null,
    bank: data.bank ? { name: data.bank.name, iban: data.bank.iban } : null,
    noc: data.noc ?? null,
    texts: data.texts
      ? (() => {
          const paras = (t: string | null) => (t ? t.split(/\n{2,}/).map((p) => p.split('\n')) : null);
          const t = data.texts;
          return { openingAr: paras(t.openingAr), openingEn: paras(t.openingEn), closingAr: paras(t.closingAr), closingEn: paras(t.closingEn) };
        })()
      : null,
    minutes: data.minutes
      ? (() => {
          const m = data.minutes;
          const paras = (t: string | null) => (t ? t.split(/\n{2,}/).map((p) => p.split('\n')) : null);
          return {
            subjectAr: m.subjectAr, categoryAr: m.categoryAr, outcomeAr: m.outcomeAr, investigator: m.investigator,
            openedAr: formatGregorian(m.openedDate, 'ar', n), closedAr: formatGregorian(m.closedDate, 'ar', n),
            description: paras(m.description), findings: paras(m.findings), recommendation: paras(m.recommendation), finalDecision: paras(m.finalDecision),
            penaltyAmountText: m.penaltyAmount ? formatAmount(m.penaltyAmount, n) : null, penaltyDays: m.penaltyDays !== null ? digits(String(m.penaltyDays), n) : null,
          };
        })()
      : null,
    evaluation: data.evaluation
      ? (() => {
          const v = data.evaluation;
          const paras = (t: string | null) => (t ? t.split(/\n{2,}/).map((p) => p.split('\n')) : null);
          return {
            cycleTitle: v.cycleTitle,
            periodAr: `${formatGregorian(v.periodStart, 'ar', n)} - ${formatGregorian(v.periodEnd, 'ar', n)}`,
            sections: v.sections.map((s) => ({ title: s.title, weight: digits(s.weight, n), items: s.items.map((i) => ({ title: i.title, score: digits(String(i.score), n), note: i.note })) })),
            totalScore: v.totalScore ? digits(v.totalScore, n) : null,
            // One LTR run each (score / max), so the order never flips inside Arabic text.
            maxItem: digits('5', n),
            maxTotal: digits('100', n),
            finalRating: v.finalRating, recommendationAr: v.recommendationAr, recommendationReason: v.recommendationReason,
            strengths: paras(v.strengths), improvements: paras(v.improvements), finalNotes: paras(v.finalNotes),
            acknowledgedAr: v.acknowledgedDate ? formatGregorian(v.acknowledgedDate, 'ar', n) : null, employeeComment: paras(v.employeeComment),
          };
        })()
      : null,
    leave: data.leave
      ? {
          typeAr: data.leave.typeAr, typeEn: data.leave.typeEn, outsideKsa: data.leave.outsideKsa,
          daysAr: digits(String(data.leave.totalDays), n), daysEn: String(data.leave.totalDays),
          startAr: formatGregorian(data.leave.startDate, 'ar', n), startEn: formatGregorian(data.leave.startDate, 'en'),
          endAr: formatGregorian(data.leave.endDate, 'ar', n), endEn: formatGregorian(data.leave.endDate, 'en'),
          returnAr: formatGregorian(data.leave.returnDate, 'ar', n), returnEn: formatGregorian(data.leave.returnDate, 'en'),
        }
      : null,
    change: data.change
      ? {
          effectiveAr: formatGregorian(data.change.effectiveDate, 'ar', n),
          fromJobTitleAr: data.change.fromJobTitleAr,
          toJobTitleAr: data.change.toJobTitleAr,
          fromSalaryText: formatAmount(data.change.fromBasicSalary, n),
          toSalaryText: data.change.toBasicSalary ? formatAmount(data.change.toBasicSalary, n) : null,
          reasonAr: data.change.reasonAr,
          currencyAr: 'ريال سعودي',
        }
      : null,
    circular: data.circular
      ? {
          kind: data.circular.kind,
          subjectAr: data.circular.subjectAr,
          // Paragraphs split on empty lines; the lines inside a paragraph keep their breaks (like the warning).
          paragraphs: data.circular.bodyAr.split(/\n{2,}/).map((p) => p.split('\n')),
          effectiveAr: data.circular.effectiveDate ? formatGregorian(data.circular.effectiveDate, 'ar', n) : null,
          acknowledge: data.circular.acknowledge,
          listed: data.circular.listed,
        }
      : null,
    commencement: data.commencement
      ? {
          kind: data.commencement.kind,
          requested: data.commencement.requested,
          dateAr: formatGregorian(data.commencement.date, 'ar', n),
          leave: data.commencement.leave
            ? {
                typeAr: data.commencement.leave.typeAr,
                startAr: formatGregorian(data.commencement.leave.startDate, 'ar', n),
                endAr: formatGregorian(data.commencement.leave.endDate, 'ar', n),
                scheduledAr: formatGregorian(data.commencement.leave.scheduledReturn, 'ar', n),
                late: data.commencement.leave.lateDays ? arabicDays(data.commencement.leave.lateDays, n) : null,
              }
            : null,
        }
      : null,
    addendum: data.addendum
      ? {
          effectiveAr: formatGregorian(data.addendum.effectiveDate, 'ar', n),
          currencyAr: 'ريال سعودي',
          reasonAr: data.addendum.reasonAr,
          // Amounts in one LTR run; the contract end as an Arabic date; titles / branches as text.
          rows: data.addendum.rows.map((r) => {
            const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${formatGregorian(v, 'ar', n)} م` : v);
            return r.money
              ? { labelAr: r.labelAr, money: true, ltr: true, fromText: formatAmount(r.fromAr, n), toText: formatAmount(r.toAr, n) }
              : { labelAr: r.labelAr, money: false, ltr: false, fromText: r.key === 'CONTRACT_END' ? date(r.fromAr) : r.fromAr, toText: r.key === 'CONTRACT_END' ? date(r.toAr) : r.toAr };
          }),
        }
      : null,
    notice: data.notice
      ? {
          reason: data.notice.reason,
          lastAr: formatGregorian(data.notice.lastWorkingDate, 'ar', n),
          noticeDaysText: data.notice.noticeDays !== null ? digits(String(data.notice.noticeDays), n) : null,
          paragraphs: data.notice.detailsAr ? data.notice.detailsAr.split(/\n{2,}/).map((p) => p.split('\n')) : null,
          investigation: data.notice.investigation
            ? { subjectAr: data.notice.investigation.subjectAr, closedAr: formatGregorian(data.notice.investigation.closedDate, 'ar', n) }
            : null,
        }
      : null,
    exit: data.exit
      ? {
          kind: data.exit.kind,
          requestAr: formatGregorian(data.exit.requestDate, 'ar', n),
          requestEn: formatGregorian(data.exit.requestDate, 'en'),
          lastAr: formatGregorian(data.exit.lastWorkingDate, 'ar', n),
          lastEn: formatGregorian(data.exit.lastWorkingDate, 'en'),
        }
      : null,
    payroll: data.payroll
      ? {
          periodAr: data.payroll.periodAr,
          periodEn: data.payroll.periodEn,
          paidAr: data.payroll.paidDate ? formatGregorian(data.payroll.paidDate, 'ar', n) : null,
          paidEn: data.payroll.paidDate ? formatGregorian(data.payroll.paidDate, 'en') : null,
          currencyAr: 'ريال سعودي',
          currencyEn: 'SAR',
          earnings: moneyRows(data.payroll.earnings, n),
          deductions: moneyRows(data.payroll.deductions, n),
          grossText: formatAmount(data.payroll.gross, n),
          grossTextEn: formatAmount(data.payroll.gross, 'latn'),
          totalDeductionsText: formatAmount(data.payroll.totalDeductions, n),
          totalDeductionsTextEn: formatAmount(data.payroll.totalDeductions, 'latn'),
          netText: formatAmount(data.payroll.net, n),
          netTextEn: formatAmount(data.payroll.net, 'latn'),
        }
      : null,
    settlement: data.settlement
      ? (() => {
          const s = data.settlement;
          const m = SETTLEMENT_PAYMENT_METHODS[s.payment.method];
          return {
            isFinal: s.kind === 'END_OF_SERVICE',
            kindAr: s.kind === 'END_OF_SERVICE' ? 'تسوية نهاية الخدمة' : 'تسوية إجازة',
            kindEn: s.kind === 'END_OF_SERVICE' ? 'End-of-service settlement' : 'Leave settlement',
            reasonAr: s.reasonAr,
            reasonEn: s.reasonEn,
            lastWorkingAr: s.lastWorkingDate ? formatGregorian(s.lastWorkingDate, 'ar', n) : null,
            lastWorkingEn: s.lastWorkingDate ? formatGregorian(s.lastWorkingDate, 'en') : null,
            yearsOfService: s.yearsOfService,
            currencyAr: 'ريال سعودي',
            currencyEn: 'SAR',
            entitlements: moneyRows(s.entitlements, n),
            deductions: moneyRows(s.deductions, n),
            totalEntitlementsText: formatAmount(s.totalEntitlements, n),
            totalEntitlementsTextEn: formatAmount(s.totalEntitlements, 'latn'),
            totalDeductionsText: formatAmount(s.totalDeductions, n),
            totalDeductionsTextEn: formatAmount(s.totalDeductions, 'latn'),
            netText: formatAmount(s.net, n),
            netTextEn: formatAmount(s.net, 'latn'),
            payment: {
              methodAr: m.ar,
              methodEn: m.en,
              referenceLabelAr: m.referenceAr,
              reference: s.payment.reference,
              paidAr: formatGregorian(s.payment.paidDate, 'ar', n),
              paidEn: formatGregorian(s.payment.paidDate, 'en'),
              // 16 hex characters are enough to match the receipt; the full hash stays in the snapshot.
              receiptFingerprint: s.payment.receiptSha256 ? s.payment.receiptSha256.slice(0, 16).toUpperCase() : null,
            },
          };
        })()
      : null,
    clearance: data.clearance
      ? { lastWorkingAr: formatGregorian(data.clearance.lastWorkingDate, 'ar', n), lastWorkingEn: formatGregorian(data.clearance.lastWorkingDate, 'en') }
      : null,
    signature: meta.signature,
  };
  // Diacritics are never printed (owner decision 2026-09-26; POC §B2).
  return stripArabicMarks(model);
}

export type RenderModel = ReturnType<typeof buildRenderModel>;
