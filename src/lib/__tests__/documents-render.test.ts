// Templates x languages through the real radeef-render service (Typst 0.15.1).
// Opt-in: set RENDER_SERVICE_URL + RENDER_SERVICE_TOKEN (e.g. the container from
// services/render/README.md). Skipped otherwise, so the default unit run needs no service.
// RENDER_IT_OUT=<dir> also writes the PDFs for visual review.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { hashVerifyToken, newVerifyToken, sha256Hex } from '@/lib/documents/core';
import { qrSvg, verifyUrl } from '@/lib/documents/qr';
import { buildRenderModel } from '@/lib/documents/render-model';
import { renderServiceConfig, typstServiceRenderer } from '@/lib/documents/renderer';
import { bundleHash, loadTemplate } from '@/lib/documents/templates';
import { createSealCertificate } from '@/lib/documents/seal/cert';
import { sealPdf } from '@/lib/documents/seal/pades';
import { hasOpenssl, opensslVerify } from './seal-fixtures';
import {
  buildCandidateContractData, buildContractData, CLEARANCE_CERTIFICATE, CONTRACT_ADDENDUM, type AddendumFacts, EMPLOYMENT_CERTIFICATE, EXPERIENCE_CERTIFICATE, EVALUATION_REPORT, EXIT_ACCEPTANCE, INVESTIGATION_MINUTES, JOB_OFFER, LEAVE_APPROVAL, NO_OBJECTION, paramsSchema, PAYSLIP, PROMOTION_DECISION, SALARY_CERTIFICATE, SALARY_TRANSFER, SETTLEMENT_STATEMENT, TERMINATION_NOTICE, WARNING_LETTER,
  type CompanyRecord, type DocumentLanguage, type DocumentTypeDefinition, type EmployeeRecord, type ExitFacts, type PayrollFacts, type BankFacts, type EvaluationFacts, type InvestigationFacts, type LeaveFacts, type SettlementFacts, type TerminationFacts,
} from '@/lib/documents/types';

const config = renderServiceConfig();
const fixtures = path.join(process.cwd(), 'services', 'render', 'test', 'fixtures', 'F2-ar-en');
const asset = (name: string) => readFileSync(path.join(fixtures, name));
// Every rendered template is also sealed (as the pipeline does) and the seal checked with OpenSSL.
const sealCert = createSealCertificate({ nameAr: 'شركة أكمي للمقاولات العامة المحدودة', nameEn: 'ACME General Contracting Co. Ltd.', commercialRegNum: '1010123456' });

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Abdullah Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: 'N1234567', jobTitle: 'مهندس مدني أول', jobTitleEnglish: 'Senior Civil Engineer',
  joinDate: new Date('2019-03-09T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1',
  allowances: [
    { name: 'بدل سكن', amount: 2375, isMonthly: true, allowanceType: 'HOUSING' },
    { name: 'بدل نقل', amount: 950, isMonthly: true, allowanceType: 'TRANSPORT' },
  ],
};
const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي للمقاولات العامة المحدودة', nameEnglish: 'ACME General Contracting Co. Ltd.', commercialRegNum: '1010123456', unifiedNumber: '7001234567' };

async function render(
  def: DocumentTypeDefinition,
  language: DocumentLanguage,
  opts: { terminated?: boolean; signature?: boolean; logo?: boolean; params?: Record<string, unknown>; facts?: ExitFacts; settlement?: SettlementFacts; payroll?: PayrollFacts; termination?: TerminationFacts; investigation?: InvestigationFacts; bank?: BankFacts; leave?: LeaveFacts; evaluation?: EvaluationFacts; addendum?: AddendumFacts } = {},
) {
  const emp = opts.terminated ? { ...employee, isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') } : employee;
  const data = buildContractData(def, { employee: emp, company, params: paramsSchema.parse({ language, ...opts.params }), facts: opts.facts, settlement: opts.settlement, payroll: opts.payroll, termination: opts.termination, investigation: opts.investigation, bank: opts.bank, leave: opts.leave, evaluation: opts.evaluation, addendum: opts.addendum }) as never;
  const token = newVerifyToken();
  const url = verifyUrl('https://acme.radeef.sa', token);
  const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: 'الرياض، حي العليا', addressEn: null, phone: '+966 11 234 5678', email: null, logoSha256: null }, {
    typeLabelAr: def.labelAr, typeLabelEn: def.labelEn, number: `ACM-${def.code}-2026-000001`, issuedDate: '2026-09-26',
    validUntilDate: def.defaults.validityDays ? '2026-12-25' : null, verifyUrl: url, language, addresseeAr: null, addresseeEn: null,
    addressedToEmployee: !!def.addressedToEmployee,
    signature: opts.signature === false ? null : { nameAr: 'سارة خالد العتيبي', nameEn: 'Sarah Alotaibi', titleAr: 'مديرة الموارد البشرية', titleEn: 'HR Director', printImage: true, printStamp: true },
    hasLogo: opts.logo !== false,
  });
  const bundle = await loadTemplate(def, language);
  const assets: Record<string, Buffer> = { 'qr.svg': await qrSvg(url) };
  if (opts.logo !== false) assets['logo.png'] = asset('logo.png');
  if (opts.signature !== false) {
    assets['signature.png'] = asset('signature.png');
    assets['stamp.png'] = asset('stamp.png');
  }
  const out = await typstServiceRenderer().render({
    templateRef: bundle.templateRef, template: bundle.files, data: model, assets, creationTimestamp: 1790413200, pdfStandard: 'a-2b',
  });
  const sealed = sealPdf(out.pdf, { certDer: sealCert.certDer, privateKeyPem: sealCert.privateKeyPem, signingTime: new Date(1790413200 * 1000), name: company.nameArabic, reason: `مستند رسمي رقم ACM-${def.code}-2026-000001` });
  if (hasOpenssl) expect(opensslVerify(sealed, sealCert.certDer)).toBe(true);
  if (process.env.RENDER_IT_OUT) {
    mkdirSync(process.env.RENDER_IT_OUT, { recursive: true });
    writeFileSync(path.join(process.env.RENDER_IT_OUT, `${def.code}-${language}${opts.settlement?.settlement?.type === 'LEAVE_SETTLEMENT' ? '-leave' : ''}${opts.terminated ? '-ended' : ''}${opts.signature === false ? '-nosig' : ''}.pdf`), sealed);
  }
  return { out, token, sealed };
}

describe.skipIf(!config)('templates through radeef-render', () => {
  for (const def of [SALARY_CERTIFICATE, EMPLOYMENT_CERTIFICATE, EXPERIENCE_CERTIFICATE]) {
    for (const language of ['ar', 'ar-en'] as const) {
      it(`${def.key} / ${language}`, async () => {
        const { out, token } = await render(def, language);
        expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(out.pdfSha256).toBe(sha256Hex(out.pdf));
        expect(out.rendererVersion).toBe('0.15.1');
        expect(hashVerifyToken(token)).toHaveLength(64);
      });
    }
  }

  it('experience certificate after the end of service, no signatory, no logo', async () => {
    const { out } = await render(EXPERIENCE_CERTIFICATE, 'ar-en', { terminated: true, signature: false, logo: false });
    expect(out.pdf.length).toBeGreaterThan(1000);
  });

  it('written warning: HR text with paragraphs, Latin words and digits, addressed to the employee', async () => {
    const warning = {
      subjectAr: 'التأخر المتكرر عن الدوام (August 2026)',
      bodyAr: 'تكرر تأخرك عن بداية الدوام الرسمي 7 مرات خلال شهر أغسطس، آخرها يوم 2026-08-20.\nوقد سبق تنبيهك شفهياً.\n\nنأمل الالتزام بمواعيد العمل «وفق لائحة تنظيم العمل»، وفي حال التكرار تُتخذ الإجراءات النظامية.',
      incidentDate: '2026-08-20',
    };
    const { out } = await render(WARNING_LETTER, 'ar', { params: { warning } });
    expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  for (const language of ['ar', 'ar-en'] as const) {
    it(`clearance / ${language}`, async () => {
      const facts: ExitFacts = { outstanding: [], settlement: { id: 's1', status: 'PAID', lastWorkingDate: new Date('2026-08-30T21:00:00Z') } };
      const { out } = await render(CLEARANCE_CERTIFICATE, language, { terminated: true, facts });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const [language, kind] of [['ar', 'END_OF_SERVICE'], ['ar-en', 'END_OF_SERVICE'], ['ar-en', 'LEAVE_SETTLEMENT']] as const) {
    it(`settlement statement / ${kind} / ${language}`, async () => {
      const eos = kind === 'END_OF_SERVICE';
      const settlement: SettlementFacts = {
        settlement: {
          id: 's1', employeeId: 'e1', type: kind, terminationReason: eos ? 'RESIGNATION' : null, status: 'PAID', lastWorkingDate: eos ? new Date('2026-08-30T21:00:00Z') : null,
          yearsOfService: eos ? 7.4789 : null, workingDaysSalary: eos ? 1200 : 0, endOfServiceAmount: eos ? 30000 : 0, leaveCompensation: 4500.5, overtimeAmount: eos ? 800 : 0,
          additionalEntitlements: eos ? 1100 : 0, loansDeduction: 2000, additionalDeductions: 2500, totalSettlement: eos ? 34300.5 : 2000.5,
          paymentMethod: eos ? 'BANK_TRANSFER' : 'CASH_VOUCHER', paymentReference: eos ? 'TRX-88213' : 'SV-17', paidAt: new Date('2026-09-01T21:00:00Z'),
        },
        receipt: { sha256: eos ? 'ab12'.repeat(16) : null, recorded: eos },
      };
      const { out } = await render(SETTLEMENT_STATEMENT, language, { terminated: eos, params: { settlementId: 's1' }, settlement });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const language of ['ar', 'ar-en'] as const) {
    it(`payslip / ${language} (unsigned)`, async () => {
      const payroll: PayrollFacts = { payroll: {
        id: 'p1', employeeId: 'e1', month: 9, year: 2026, status: 'PAID', paidAt: new Date('2026-09-27T09:00:00Z'), basicSalary: 9500, totalAllowances: 3825, bonusAmount: 500, housingAllowance: 2375, transportAllowance: 950, otherAllowances: 0,
        overtimeCost: 412.5, gosiEmployee: 1068.75, loansDeduction: 1000, violationsDeduction: 150, leaveDeduction: 0, otherDeductions: 0, totalDeductions: 2218.75, netSalary: 11518.75,
      } };
      const { out } = await render(PAYSLIP, language, { params: { payrollId: 'p1' }, payroll, signature: false });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const [language, kind] of [['ar', 'RESIGNATION'], ['ar-en', 'MUTUAL_AGREEMENT'], ['ar-en', 'END_OF_CONTRACT']] as const) {
    it(`exit acceptance / ${kind} / ${language}`, async () => {
      const termination: TerminationFacts = {
        request: { id: 't1', employeeId: 'e1', terminationType: kind, status: 'APPROVED', createdAt: new Date('2026-09-01T08:00:00Z'), hrApprovedAt: new Date('2026-09-03T08:00:00Z'), lastWorkingDate: new Date('2026-09-30T21:00:00Z') },
      };
      const { out } = await render(EXIT_ACCEPTANCE, language, { params: { terminationRequestId: 't1' }, termination });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const reason of ['NOTICE', 'NON_RENEWAL', 'PROBATION', 'ARTICLE_80'] as const) {
    it(`termination notice / ${reason}`, async () => {
      const investigation: InvestigationFacts = { investigation: { id: 'i1', employeeId: 'e1', subject: 'الغياب المتصل عن العمل (Absence)', status: 'COMPLETED_GUILTY', updatedAt: new Date('2026-09-10T08:00:00Z') } };
      const terminationNotice = {
        reason, lastWorkingDate: '2026-11-30', noticeDays: reason === 'PROBATION' ? undefined : 60, investigationId: reason === 'ARTICLE_80' ? 'i1' : undefined,
        detailsAr: reason === 'NOTICE' ? 'يأتي هذا القرار في إطار إعادة هيكلة الإدارة.\nمع تقديرنا لجهودكم.' : undefined,
      };
      const { out } = await render(TERMINATION_NOTICE, 'ar', { params: { terminationNotice }, investigation });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const language of ['ar', 'ar-en'] as const) {
    it('salary transfer / ' + language, async () => {
      const { out } = await render(SALARY_TRANSFER, language, { bank: { bankName: 'مصرف الراجحي', iban: 'SA0380000000608010167519' } });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const [language, purpose] of [['ar', 'SERVICE_TRANSFER'], ['ar-en', 'TRAVEL'], ['ar-en', 'STUDY'], ['ar', 'LICENSE']] as const) {
    it('no objection / ' + purpose + ' / ' + language, async () => {
      const noc = { purpose, targetAr: purpose === 'TRAVEL' ? 'المملكة المتحدة (UK)' : 'شركة الأفق للتقنية', detailsAr: purpose === 'TRAVEL' ? 'من 1 إلى 20 ديسمبر 2026' : undefined };
      const { out } = await render(NO_OBJECTION, language, { params: { noc } });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  it('promotion decision (title + salary)', async () => {
    const { out } = await render(PROMOTION_DECISION, 'ar', { params: { promotion: { newJobTitleAr: 'مهندس مدني رئيسي', newBasicSalary: 11500, effectiveDate: '2026-10-01', reasonAr: 'تقديرا لأدائه المتميز' } } });
    expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('contract addendum (every kind of term)', async () => {
    const { out } = await render(CONTRACT_ADDENDUM, 'ar', {
      params: { addendum: { effectiveDate: '2026-10-01', newBasicSalary: 10500, newHousingAllowance: 2625, newTransportAllowance: 1200, newJobTitleAr: 'مهندس مدني رئيسي', newBranchId: 'b2', newContractEndDate: '2028-09-30', reasonAr: 'بناء على إعادة تنظيم الإدارة' } },
      addendum: { branch: { id: 'b1', nameAr: 'فرع الرياض' }, contractEndDate: null, newBranch: { id: 'b2', nameAr: 'فرع جدة' } },
    });
    expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  // The English column of pair() is evaluated even in an Arabic-only letter: English fields that are
  // legitimately empty in Arabic letters must not break any template.
  const noEnglish: EmployeeRecord = { ...employee, firstNameEnglish: null, lastNameEnglish: null, jobTitleEnglish: null, nationality: 'جنسية غير معروفة' };
  const noEnglishCompany: CompanyRecord = { ...company, nameEnglish: null };
  for (const def of [SALARY_CERTIFICATE, EMPLOYMENT_CERTIFICATE, EXPERIENCE_CERTIFICATE, SALARY_TRANSFER, NO_OBJECTION, PAYSLIP, CLEARANCE_CERTIFICATE, EXIT_ACCEPTANCE]) {
    it(`Arabic letter without any English data: ${def.key}`, async () => {
      const params = paramsSchema.parse({
        language: 'ar',
        noc: { purpose: 'TRAVEL', targetAr: 'دبي' },
        payrollId: 'p1',
        terminationRequestId: 't1',
      });
      const leaver = { ...noEnglish, isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') };
      const data = buildContractData(def, {
        employee: def.requiresActiveEmployee ? noEnglish : leaver, company: noEnglishCompany, params,
        bank: { bankName: 'مصرف الراجحي', iban: 'SA0380000000608010167519' },
        facts: { outstanding: [], settlement: { id: 's1', status: 'PAID', lastWorkingDate: null } },
        payroll: { payroll: { id: 'p1', employeeId: 'e1', month: 9, year: 2026, status: 'PAID', paidAt: null, basicSalary: 9500, totalAllowances: 0, bonusAmount: 0, housingAllowance: null, transportAllowance: null, otherAllowances: null, overtimeCost: 0, gosiEmployee: 0, loansDeduction: 0, violationsDeduction: 0, leaveDeduction: 0, otherDeductions: 0, totalDeductions: 0, netSalary: 9500 } },
        termination: { request: { id: 't1', employeeId: 'e1', terminationType: 'RESIGNATION', status: 'APPROVED', createdAt: new Date('2026-09-01T08:00:00Z'), hrApprovedAt: null, lastWorkingDate: new Date('2026-09-30T21:00:00Z') } },
      }) as never;
      const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
        typeLabelAr: def.labelAr, typeLabelEn: def.labelEn, number: `ACM-${def.code}-2026-000009`, issuedDate: '2026-09-26', validUntilDate: null,
        verifyUrl: verifyUrl('https://acme.radeef.sa', 'K7Q2M9XJ4TRW8PZC3VN6HD5BLA'), language: 'ar', addresseeAr: null, addresseeEn: null,
        addressedToEmployee: !!def.addressedToEmployee, signature: null, hasLogo: false,
      });
      const bundle = await loadTemplate(def, 'ar');
      const out = await typstServiceRenderer().render({
        templateRef: bundle.templateRef, template: bundle.files, data: model, assets: { 'qr.svg': await qrSvg('https://acme.radeef.sa/v/K7Q2M9XJ4TRW8PZC3VN6HD5BLA') }, creationTimestamp: 1790413200, pdfStandard: 'a-2b',
      });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const language of ['ar', 'ar-en'] as const) {
    it(`job offer / ${language}`, async () => {
      const params = paramsSchema.parse({
        language,
        offer: { legalCompanyId: 'c1', jobTitleAr: 'محاسبة أولى', jobTitleEn: 'Senior Accountant', basicSalary: 8000, housingAllowance: 2000, transportAllowance: 800, startDate: '2026-11-01', probationDays: 90, annualLeaveDays: 21, notesAr: 'تأمين طبي للموظف والعائلة' },
      });
      const data = buildCandidateContractData(JOB_OFFER, { candidate: { id: 'a1', candidateName: 'سارة أحمد', candidateEmail: null, status: 'INTERVIEW' }, company, params }) as never;
      const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
        typeLabelAr: JOB_OFFER.labelAr, typeLabelEn: JOB_OFFER.labelEn, number: 'ACM-OFR-2026-000001', issuedDate: '2026-09-26', validUntilDate: '2026-10-10',
        verifyUrl: verifyUrl('https://acme.radeef.sa', 'K7Q2M9XJ4TRW8PZC3VN6HD5BLA'), language, addresseeAr: null, addresseeEn: null, signature: null, hasLogo: true,
      });
      const bundle = await loadTemplate(JOB_OFFER, language);
      const out = await typstServiceRenderer().render({
        templateRef: bundle.templateRef, template: bundle.files, data: model,
        assets: { 'qr.svg': await qrSvg('https://acme.radeef.sa/v/K7Q2M9XJ4TRW8PZC3VN6HD5BLA'), 'logo.png': asset('logo.png') }, creationTimestamp: 1790413200, pdfStandard: 'a-2b',
      });
      if (process.env.RENDER_IT_OUT) writeFileSync(path.join(process.env.RENDER_IT_OUT, `OFR-${language}.pdf`), out.pdf);
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  for (const language of ['ar', 'ar-en'] as const) {
    it('leave approval / ' + language, async () => {
      const leave: LeaveFacts = { leave: { id: 'l1', employeeId: 'e1', leaveType: 'ANNUAL', status: 'APPROVED', startDate: new Date('2026-12-01T21:00:00Z'), endDate: new Date('2026-12-20T21:00:00Z'), totalDays: 20, isOutsideKSA: true } };
      const { out } = await render(LEAVE_APPROVAL, language, { params: { leaveId: 'l1' }, leave, signature: false });
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  it('investigation minutes', async () => {
    const investigation: InvestigationFacts = { investigation: {
      id: 'i1', employeeId: 'e1', subject: 'الغياب المتصل عن العمل', status: 'COMPLETED_GUILTY', updatedAt: new Date('2026-09-10T08:00:00Z'), createdAt: new Date('2026-09-01T08:00:00Z'),
      description: 'تغيب الموظف خمسة أيام متصلة دون عذر مقبول.', category: 'ATTENDANCE', findings: 'ثبت الغياب بسجل الحضور، ولم يقدم الموظف عذرا.', recommendation: 'خصم يومين من الأجر', finalDecision: 'اعتماد التوصية',
      penaltyAmount: 633.33, penaltyDays: 2, investigatorName: 'خالد العمري', investigatorRole: 'مدير الشؤون القانونية',
    } };
    const { out } = await render(INVESTIGATION_MINUTES, 'ar', { params: { investigationId: 'i1' }, investigation });
    expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('evaluation report', async () => {
    const evaluation: EvaluationFacts = { evaluation: {
      id: 'v1', employeeId: 'e1', status: 'CLOSED', totalScore: 86.4, finalRating: 'ممتاز', recommendation: 'PROMOTION', recommendationReason: 'أداء ثابت وتميز في قيادة الفريق',
      strengths: 'الالتزام بالمواعيد\nالدقة في التقارير', improvements: 'مهارات العرض', finalNotes: null, employeeAcknowledgedAt: new Date('2026-09-20T08:00:00Z'), employeeComment: 'أشكر الإدارة',
      cycle: { title: 'تقييم النصف الأول 2026', startDate: new Date('2025-12-31T21:00:00Z'), endDate: new Date('2026-06-29T21:00:00Z') },
      sections: [
        { title: 'الأداء الوظيفي', weight: 60, items: [{ title: 'إنجاز المهام', score: 5, note: 'ممتاز' }, { title: 'جودة العمل', score: 4, note: null }] },
        { title: 'السلوك', weight: 40, items: [{ title: 'التعاون', score: 4, note: null }] },
      ],
    } };
    const { out } = await render(EVALUATION_REPORT, 'ar', { params: { evaluationId: 'v1' }, evaluation, signature: false });
    expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  for (const language of ['ar', 'ar-en'] as const) {
    it(`company opening / closing paragraphs around the fixed body / ${language}`, async () => {
      const base = buildContractData(EMPLOYMENT_CERTIFICATE, { employee, company, params: paramsSchema.parse({ language }) }) as Record<string, unknown>;
      const data = { ...base, texts: { openingAr: 'تحية طيبة وبعد،', openingEn: 'Greetings,', closingAr: 'للاستفسار يرجى التواصل مع إدارة الموارد البشرية.\nهاتف 920000000', closingEn: 'For enquiries please contact Human Resources.' } } as never;
      const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
        typeLabelAr: EMPLOYMENT_CERTIFICATE.labelAr, typeLabelEn: EMPLOYMENT_CERTIFICATE.labelEn, number: 'ACM-EMP-2026-000009', issuedDate: '2026-09-26', validUntilDate: '2026-12-25',
        verifyUrl: verifyUrl('https://acme.radeef.sa', 'K7Q2M9XJ4TRW8PZC3VN6HD5BLA'), language, addresseeAr: null, addresseeEn: null, signature: null, hasLogo: false,
      });
      expect(model.texts?.closingAr).toEqual([['للاستفسار يرجى التواصل مع إدارة الموارد البشرية.', 'هاتف 920000000']]);
      const bundle = await loadTemplate(EMPLOYMENT_CERTIFICATE, language);
      const out = await typstServiceRenderer().render({
        templateRef: bundle.templateRef, template: bundle.files, data: model, assets: { 'qr.svg': await qrSvg('https://acme.radeef.sa/v/K7Q2M9XJ4TRW8PZC3VN6HD5BLA') }, creationTimestamp: 1790413200, pdfStandard: 'a-2b',
      });
      if (process.env.RENDER_IT_OUT) writeFileSync(path.join(process.env.RENDER_IT_OUT, `TXT-${language}.pdf`), out.pdf);
      expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  }

  it('same inputs give the same bytes (determinism)', async () => {
    const bundle = await loadTemplate(SALARY_CERTIFICATE, 'ar');
    expect(bundle.sha256).toBe(bundleHash(bundle.files));
    const url = verifyUrl('https://acme.radeef.sa', 'K7Q2M9XJ4TRW8PZC3VN6HD5BLA');
    const data = buildContractData(SALARY_CERTIFICATE, { employee, company, params: { language: 'ar' } }) as never;
    const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'arab', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
      typeLabelAr: 'خطاب تعريف بالراتب', typeLabelEn: 'Salary Certificate', number: 'ACM-SAL-2026-000184', issuedDate: '2026-09-26',
      validUntilDate: '2026-12-25', verifyUrl: url, language: 'ar', addresseeAr: 'بنك الرياض', addresseeEn: null, signature: null, hasLogo: false,
    });
    const input = { templateRef: bundle.templateRef, template: bundle.files, data: model, assets: { 'qr.svg': await qrSvg(url) }, creationTimestamp: 1790413200, pdfStandard: 'a-2b' as const };
    const a = await typstServiceRenderer().render(input);
    const b = await typstServiceRenderer().render(input);
    expect(a.pdfSha256).toBe(b.pdfSha256);
  });
});
