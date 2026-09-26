// Phase 2 document types (SPEC §14): written warning and clearance, their policy lock, the
// free-text rules and the render model. Pure: no database, no render service.
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import {
  buildCandidateContractData, buildContractData, CLEARANCE_CERTIFICATE, ContractValidationError, DOCUMENT_TEXT_RE, EVALUATION_REPORT, EXIT_ACCEPTANCE, INVESTIGATION_MINUTES, JOB_OFFER, LEAVE_APPROVAL, NO_OBJECTION, paramsSchema, printable, PAYSLIP, PROMOTION_DECISION, SALARY_TRANSFER, SETTLEMENT_STATEMENT, SALARY_CERTIFICATE, TERMINATION_NOTICE, WARNING_LETTER,
  type CompanyRecord, type EmployeeRecord, type ExitFacts, type InvestigationFacts, type SettlementFacts, type TerminationFacts,
} from '@/lib/documents/types';
import { effectivePolicy, needsApproval } from '@/lib/documents/policy';
import { buildRenderModel } from '@/lib/documents/render-model';
import { noticeText } from '@/lib/documents/notify';
import { paidAtDate, settlementPaymentProofSchema } from '@/lib/settlement-payment';
import { allowanceLine, splitRecurringAllowances } from '@/lib/payroll-core';

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: null, jobTitle: 'مهندس مدني', jobTitleEnglish: 'Civil Engineer',
  joinDate: new Date('2019-03-09T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1',
  allowances: [],
};
const leaver: EmployeeRecord = { ...employee, isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') };
const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي', nameEnglish: 'ACME Co.', commercialRegNum: '1010123456', unifiedNumber: null };

const warning = { subjectAr: 'التأخر المتكرر عن الدوام', bodyAr: 'تكرر تأخرك عن بداية الدوام الرسمي خلال شهر أغسطس.\n\nنأمل الالتزام بمواعيد العمل.', incidentDate: '2026-08-20' };
const params = (p: unknown) => paramsSchema.parse(p);
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContractValidationError) return e.errors.map((x) => x.code);
    throw e;
  }
  return [];
};

describe('written warning (WRN)', () => {
  it('builds from the text HR wrote; the text is part of the contract (the approval covers it)', () => {
    const data = buildContractData(WARNING_LETTER, { employee, company, params: params({ language: 'ar', warning }) }) as { warning: typeof warning };
    expect(data.warning).toEqual(warning);
  });

  it('requires the text, is Arabic only and is refused for a terminated employee', () => {
    expect(codes(() => buildContractData(WARNING_LETTER, { employee, company, params: params({ language: 'ar' }) }))).toContain('MISSING_WARNING_TEXT');
    expect(codes(() => buildContractData(WARNING_LETTER, { employee, company, params: params({ language: 'ar-en', warning }) }))).toContain('LANGUAGE_NOT_SUPPORTED');
    expect(codes(() => buildContractData(WARNING_LETTER, { employee: leaver, company, params: params({ language: 'ar', warning }) }))).toContain('EMPLOYEE_TERMINATED');
  });

  it('free text: normalized, bounded, and only characters the fonts can print (no emoji)', () => {
    const p = params({ warning: { subjectAr: '  تأخر   متكرر ', bodyAr: 'السطر الأول   هنا\r\nالسطر الثاني\r\n\r\n\r\n\r\nفقرة ثانية طويلة بما يكفي' } });
    expect(p.warning!.subjectAr).toBe('تأخر متكرر');
    expect(p.warning!.bodyAr).toBe('السطر الأول هنا\nالسطر الثاني\n\nفقرة ثانية طويلة بما يكفي');
    expect(paramsSchema.safeParse({ warning: { ...warning, bodyAr: 'نص قصير' } }).success).toBe(false);
    expect(paramsSchema.safeParse({ warning: { ...warning, bodyAr: `${warning.bodyAr} 😀` } }).success).toBe(false);
    expect(paramsSchema.safeParse({ warning: { ...warning, subjectAr: 'موضوع‮معكوس' } }).success).toBe(false); // bidi override
    expect(paramsSchema.safeParse({ warning: { ...warning, bodyAr: 'ب'.repeat(3001) } }).success).toBe(false);
    // Stored params are parsed again on every step: normalization must be idempotent.
    expect(params(JSON.parse(JSON.stringify(p))).warning).toEqual(p.warning);
  });

  it('policy is locked: always approved, never from the portal, whatever the company setting', () => {
    const open = { enabled: true, selfService: true, requiresApproval: false, validityDays: null, signatoryId: 's1' };
    const policy = effectivePolicy(WARNING_LETTER, open);
    expect(policy.requiresApproval).toBe(true);
    expect(policy.selfService).toBe(false);
    // A pre-authorized signature does not replace the approval.
    expect(needsApproval(policy, { printImage: true, basis: 'PRE_AUTHORIZED', approvalId: null, authorizationId: 'a1' }, [], 'h')).toBe(true);
  });

  it('render model: addressed to the employee, paragraphs and lines kept, diacritics removed', () => {
    const data = buildContractData(WARNING_LETTER, { employee, company, params: params({ language: 'ar', warning: { ...warning, bodyAr: 'السطر الأول مُشكّل\nالسطر الثاني\n\nالفقرة الثانية' } }) });
    const model = buildRenderModel(data as never, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
      typeLabelAr: WARNING_LETTER.labelAr, typeLabelEn: WARNING_LETTER.labelEn, number: 'ACM-WRN-2026-000001', issuedDate: '2026-09-26', validUntilDate: null,
      verifyUrl: 'https://x.test/v/K7Q2M9XJ4TRW8PZC3VN6HD5BLA', language: 'ar', addresseeAr: 'يتجاهلها', addresseeEn: null, addressedToEmployee: true, signature: null, hasLogo: false,
    });
    expect(model.addressee.ar).toBe('محمد عبدالله الأحمد (الرقم الوظيفي E-00412)');
    expect(model.warning!.paragraphs).toEqual([['السطر الأول مشكل', 'السطر الثاني'], ['الفقرة الثانية']]);
    expect(model.warning!.incidentDateAr).not.toBeNull();
  });

  it('the issue notice asks for the acknowledgement, still without personal data', () => {
    const t = noticeText({ kind: 'ISSUED', number: 'ACM-WRN-2026-000001', typeLabel: WARNING_LETTER.labelAr, acknowledge: true });
    expect(t.body).toContain('الإقرار باستلامه');
    expect(t.body).not.toContain('محمد');
  });
});

describe('clearance (CLR): strict conditions', () => {
  const paid: ExitFacts = { outstanding: [], settlement: { id: 's1', status: 'PAID', lastWorkingDate: new Date('2026-08-30T21:00:00Z') } };

  it('issued for a leaver with everything settled; last working day from the settlement', () => {
    const data = buildContractData(CLEARANCE_CERTIFICATE, { employee: leaver, company, params: params({ language: 'ar-en' }), facts: paid }) as {
      service: { endDate: string; inService: boolean }; clearance: { lastWorkingDate: string };
    };
    expect(data.service).toMatchObject({ endDate: '2026-09-01', inService: false });
    expect(data.clearance.lastWorkingDate).toBe('2026-08-31');
  });

  it('lists every open item instead of issuing', () => {
    const facts: ExitFacts = {
      settlement: { id: 's1', status: 'OWNER_APPROVED', lastWorkingDate: null },
      outstanding: [
        { kind: 'ASSET', label: 'لابتوب - Dell' }, { kind: 'SIM', label: '0550000000' },
        { kind: 'VEHICLE', label: 'أ ب ج 1234' }, { kind: 'LOAN', label: 'المتبقي 1500.00 ر.س' },
      ],
    };
    expect(codes(() => buildContractData(CLEARANCE_CERTIFICATE, { employee: leaver, company, params: params({}), facts }))).toEqual([
      'SETTLEMENT_NOT_PAID', 'OUTSTANDING_ASSET', 'OUTSTANDING_SIM', 'OUTSTANDING_VEHICLE', 'OUTSTANDING_LOAN',
    ]);
    expect(codes(() => buildContractData(CLEARANCE_CERTIFICATE, { employee, company, params: params({}), facts: { outstanding: [], settlement: null } }))).toEqual([
      'NOT_TERMINATED', 'NO_SETTLEMENT',
    ]);
  });

  it('defaults: HR only, needs approval, no expiry', () => {
    const policy = effectivePolicy(CLEARANCE_CERTIFICATE, null);
    expect(policy).toMatchObject({ selfService: false, requiresApproval: true, validityDays: null });
  });
});

describe('free text characters vs the font bundle', () => {
  const font = path.join(process.cwd(), 'poc', 'document-renderer', 'fonts', 'IBMPlexSansArabic-Regular.ttf');
  // The render service's own cmap reader (loaded by path: services/render is not part of the app's type program).
  const fontsModule = path.join(process.cwd(), 'services', 'render', 'src', 'fonts.mjs');
  it.skipIf(!existsSync(font))('every character DOCUMENT_TEXT_RE accepts has a glyph (harakat are stripped before rendering)', async () => {
    const { cmapCodepoints } = (await import(/* @vite-ignore */ pathToFileURL(fontsModule).href)) as { cmapCodepoints: (b: Buffer) => Set<number> };
    const cmap = cmapCodepoints(readFileSync(font));
    const missing: string[] = [];
    for (let cp = 0x20; cp <= 0x2100; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!DOCUMENT_TEXT_RE.test(ch)) continue;
      if (cp >= 0x064b && cp <= 0x0652) continue; // tashkeel: removed by stripArabicMarks
      if (!cmap.has(cp)) missing.push(cp.toString(16));
    }
    expect(missing).toEqual([]);
  });
});

describe('settlement statement (STL): itemized, exact, tied to the payment proof', () => {
  const base: NonNullable<SettlementFacts['settlement']> = {
    id: 's1', employeeId: 'e1', type: 'END_OF_SERVICE', terminationReason: 'RESIGNATION', status: 'PAID', lastWorkingDate: new Date('2026-08-30T21:00:00Z'),
    yearsOfService: 7.4789, workingDaysSalary: 1200, endOfServiceAmount: 30000, leaveCompensation: 4500.5, overtimeAmount: 800, additionalEntitlements: 1100,
    loansDeduction: 2000, additionalDeductions: 2500, totalSettlement: 34300.5, paymentMethod: 'BANK_TRANSFER', paymentReference: 'TRX-1', paidAt: new Date('2026-09-01T21:00:00Z'),
  };
  const facts = (over: Partial<typeof base> = {}, receipt = { sha256: 'a'.repeat(64) as string | null, recorded: true }): SettlementFacts => ({ settlement: { ...base, ...over }, receipt });
  const build = (f: SettlementFacts, p: Record<string, unknown> = {}) =>
    buildContractData(SETTLEMENT_STATEMENT, { employee: leaver, company, params: params({ language: 'ar', settlementId: 's1', ...p }), settlement: f }) as { settlement: Record<string, unknown> };

  it('rows are the stored components; zero rows omitted; totals exact; payment proof carried', () => {
    const s = build(facts()).settlement as { entitlements: { key: string }[]; deductions: { key: string }[]; net: string; totalEntitlements: string; yearsOfService: string; reasonAr: string; payment: unknown };
    expect(s.entitlements.map((r) => r.key)).toEqual(['WORKING_DAYS', 'END_OF_SERVICE', 'LEAVE', 'OVERTIME', 'OTHER_ENTITLEMENTS']);
    expect([s.totalEntitlements, s.net, s.yearsOfService, s.reasonAr]).toEqual(['36800.50', '34300.50', '7.48', 'استقالة']);
    expect(s.payment).toEqual({ method: 'BANK_TRANSFER', reference: 'TRX-1', paidDate: '2026-09-02', amount: '34300.50', receiptSha256: 'a'.repeat(64) });
    const leave = build(facts({ type: 'LEAVE_SETTLEMENT', endOfServiceAmount: 999, totalSettlement: 4300.5 })).settlement as { entitlements: { key: string }[] };
    expect(leave.entitlements.map((r) => r.key)).not.toContain('END_OF_SERVICE'); // never printed on a leave settlement
    // No receipt file (settlements screen records only the reference): no fingerprint, still valid.
    expect((build(facts({}, { sha256: null, recorded: false })).settlement as { payment: { receiptSha256: null } }).payment.receiptSha256).toBeNull();
  });

  it('refuses instead of printing: unpaid, no proof, missing receipt file, inconsistent, negative net, wrong employee', () => {
    const c = (f: SettlementFacts, p?: Record<string, unknown>) => codes(() => build(f, p));
    expect(c(facts({ status: 'OWNER_APPROVED' }))).toContain('SETTLEMENT_NOT_PAID');
    expect(c(facts({ paymentReference: null }))).toContain('NO_PAYMENT_PROOF');
    expect(c(facts({}, { sha256: null, recorded: true }))).toContain('RECEIPT_FILE_MISSING');
    expect(c(facts({ totalSettlement: 34300.49 }))).toContain('SETTLEMENT_INCONSISTENT');
    expect(c(facts({ additionalEntitlements: 100 }))).toContain('SETTLEMENT_INCONSISTENT'); // other entitlements would be negative
    expect(c(facts({ additionalDeductions: 40000, totalSettlement: -3199.5 }))).toContain('NEGATIVE_NET');
    expect(c(facts({ employeeId: 'other' }))).toContain('SETTLEMENT_NOT_FOUND');
    expect(codes(() => buildContractData(SETTLEMENT_STATEMENT, { employee: leaver, company, params: params({ language: 'ar' }), settlement: { settlement: null, receipt: { sha256: null, recorded: false } } }))).toContain('MISSING_SETTLEMENT');
  });

  it('payment proof rules (finance input)', () => {
    const ok = { paymentMethod: 'CASH_VOUCHER', paymentReference: '  SV / 17 ', paidAt: '2026-09-02' };
    expect(settlementPaymentProofSchema.parse(ok).paymentReference).toBe('SV / 17');
    expect(settlementPaymentProofSchema.safeParse({ ...ok, paymentMethod: 'CRYPTO' }).success).toBe(false);
    expect(settlementPaymentProofSchema.safeParse({ ...ok, paymentReference: 'x' }).success).toBe(false);
    expect(settlementPaymentProofSchema.safeParse({ ...ok, paymentReference: 'رقم 😀' }).success).toBe(false);
    expect(settlementPaymentProofSchema.safeParse({ ...ok, paidAt: '2999-01-01' }).success).toBe(false);
    expect(paidAtDate('2026-09-02').toISOString()).toBe('2026-09-01T21:00:00.000Z');
  });

  it('dispute notice carries no reason or personal data', () => {
    const t = noticeText({ kind: 'DISPUTED', number: 'ACM-STL-2026-000001', typeLabel: SETTLEMENT_STATEMENT.labelAr });
    expect(t.body).toContain('اعترض الموظف');
    expect(t.body).not.toMatch(/محمد|34300/);
  });
});

describe('payslip (PAY): automatic, unsigned, exactly the stored payroll', () => {
  const row = {
    id: 'p1', employeeId: 'e1', month: 9, year: 2026, status: 'PAID', paidAt: new Date('2026-09-27T09:00:00Z'),
    basicSalary: 9500, totalAllowances: 3825, bonusAmount: 500, housingAllowance: null, transportAllowance: null, otherAllowances: null, overtimeCost: 412.5, gosiEmployee: 1068.75, loansDeduction: 1000,
    violationsDeduction: 0, leaveDeduction: 0, otherDeductions: 0, totalDeductions: 2068.75, netSalary: 11668.75,
  };
  const build = (over: Partial<typeof row> = {}) =>
    buildContractData(PAYSLIP, { employee, company, params: params({ language: 'ar', payrollId: 'p1' }), payroll: { payroll: { ...row, ...over } } }) as {
      payroll: { earnings: { key: string; amount: string }[]; deductions: { key: string }[]; gross: string; net: string; periodAr: string; paidDate: string };
    };

  it('lines are the payroll columns (allowances without bonuses), zero lines omitted, equations hold', () => {
    const p = build().payroll;
    expect(p.earnings.map((r) => [r.key, r.amount])).toEqual([['BASIC', '9500.00'], ['ALLOWANCES', '3325.00'], ['BONUS', '500.00'], ['OVERTIME', '412.50']]);
    expect(p.deductions.map((r) => r.key)).toEqual(['GOSI', 'LOANS']);
    expect([p.gross, p.net, p.periodAr, p.paidDate]).toEqual(['13737.50', '11668.75', 'سبتمبر 2026', '2026-09-27']);
  });

  it('refuses a row that is not paid or does not add up; deductions over gross print net 0 like the payroll', () => {
    expect(codes(() => build({ status: 'APPROVED' }))).toContain('PAYROLL_NOT_PAID');
    expect(codes(() => build({ netSalary: 11668.74 }))).toContain('PAYROLL_INCONSISTENT');
    expect(codes(() => build({ totalDeductions: 2000 }))).toContain('PAYROLL_INCONSISTENT');
    expect(codes(() => build({ employeeId: 'other' }))).toContain('PAYROLL_NOT_FOUND');
    expect(build({ leaveDeduction: 20000, totalDeductions: 22068.75, netSalary: 0 }).payroll.net).toBe('0.00');
  });

  it('policy: never approval, never portal, no signatory, whatever the settings', () => {
    const policy = effectivePolicy(PAYSLIP, { enabled: true, selfService: true, requiresApproval: true, validityDays: 30, signatoryId: 's1' });
    expect(policy).toMatchObject({ selfService: false, requiresApproval: false, signatoryId: null });
  });
});

describe('exit acceptance (RSG): answers an approved request, with the last working day set at approval', () => {
  const req: NonNullable<TerminationFacts['request']> = { id: 't1', employeeId: 'e1', terminationType: 'RESIGNATION', status: 'APPROVED', createdAt: new Date('2026-09-01T08:00:00Z'), hrApprovedAt: new Date('2026-09-03T08:00:00Z'), lastWorkingDate: new Date('2026-09-30T21:00:00Z') };
  const build = (over: Partial<typeof req> = {}) =>
    buildContractData(EXIT_ACCEPTANCE, { employee, company, params: params({ language: 'ar', terminationRequestId: 't1' }), termination: { request: { ...req, ...over } } }) as { exit: unknown };

  it('carries the kind, the request day and the last working day', () => {
    expect(build().exit).toEqual({ kind: 'RESIGNATION', requestDate: '2026-09-01', lastWorkingDate: '2026-10-01' });
    expect((build({ terminationType: 'MUTUAL_AGREEMENT' }).exit as { kind: string }).kind).toBe('MUTUAL_AGREEMENT');
  });

  it('refuses a pending request, a missing last day, another employee', () => {
    expect(codes(() => build({ status: 'PENDING' }))).toContain('TERMINATION_NOT_APPROVED');
    expect(codes(() => build({ lastWorkingDate: null }))).toContain('NO_LAST_WORKING_DATE');
    expect(codes(() => build({ employeeId: 'x' }))).toContain('TERMINATION_REQUEST_NOT_FOUND');
  });
});

describe('payslip allowances by line (owner request: basic, housing, transport, other)', () => {
  it('payroll splits recurring allowances by type (name when no type); the three add up to the rounded total', () => {
    const allowances = [
      { name: 'بدل سكن', amount: 2375, isMonthly: true, allowanceType: null },
      { name: 'x', amount: 950, isMonthly: true, allowanceType: 'TRANSPORT' },
      { name: 'بدل طعام', amount: 300, isMonthly: true, allowanceType: 'FOOD' },
      { name: 'مكافأة', amount: 999, isMonthly: false, allowanceType: null },
    ];
    expect(splitRecurringAllowances(allowances, 1, 3625)).toEqual({ housing: 2375, transport: 950, other: 300 });
    // Partial month: each line scaled, "other" absorbs rounding so the sum is exactly the total.
    const factor = 17 / 30;
    const total = Math.round(3625 * factor * 100) / 100;
    const s = splitRecurringAllowances(allowances, factor, total);
    expect(Math.round((s.housing + s.transport + s.other) * 100)).toBe(Math.round(total * 100));
    // No other allowance and a rounding cent: never negative.
    const t = splitRecurringAllowances([{ name: 'سكن', amount: 1000.01, isMonthly: true }, { name: 'نقل', amount: 1000.01, isMonthly: true }], 0.5, 1000.01);
    expect(t.other).toBe(0);
    expect(Math.round((t.housing + t.transport) * 100)).toBe(100001);
    expect(allowanceLine({ name: 'Housing', allowanceType: null })).toBe('HOUSING');
    expect(allowanceLine({ name: 'بدل سكن', allowanceType: 'OTHER' })).toBe('OTHER'); // the explicit type wins
  });

  const row = {
    id: 'p1', employeeId: 'e1', month: 9, year: 2026, status: 'PAID', paidAt: new Date('2026-09-27T09:00:00Z'), basicSalary: 9500, totalAllowances: 3825, bonusAmount: 500,
    housingAllowance: 2375 as number | null, transportAllowance: 950 as number | null, otherAllowances: 0 as number | null,
    overtimeCost: 0, gosiEmployee: 1068.75, loansDeduction: 0, violationsDeduction: 0, leaveDeduction: 0, otherDeductions: 0, totalDeductions: 1068.75, netSalary: 12256.25,
  };
  const earnings = (over: Partial<typeof row> = {}) =>
    (buildContractData(PAYSLIP, { employee, company, params: params({ payrollId: 'p1' }), payroll: { payroll: { ...row, ...over } } }) as { payroll: { earnings: { key: string; amount: string }[] } }).payroll.earnings;

  it('payslip itemizes housing / transport / other when the row carries the split', () => {
    expect(earnings().map((r) => [r.key, r.amount])).toEqual([['BASIC', '9500.00'], ['HOUSING', '2375.00'], ['TRANSPORT', '950.00'], ['BONUS', '500.00']]);
  });

  it('older rows (no split) or a split that does not add up: one allowances line', () => {
    expect(earnings({ housingAllowance: null, transportAllowance: null, otherAllowances: null }).map((r) => r.key)).toEqual(['BASIC', 'ALLOWANCES', 'BONUS']);
    expect(earnings({ otherAllowances: 1 }).map((r) => r.key)).toEqual(['BASIC', 'ALLOWANCES', 'BONUS']);
  });
});

describe('termination notice (TRM): structured, locked approval, Article 80 rests on an investigation', () => {
  const inv = { id: 'i1', employeeId: 'e1', subject: 'غياب متصل', status: 'COMPLETED_GUILTY', updatedAt: new Date('2026-09-10T08:00:00Z') };
  const build = (notice: Record<string, unknown>, investigation: InvestigationFacts = { investigation: null }) =>
    buildContractData(TERMINATION_NOTICE, { employee, company, params: params({ language: 'ar', terminationNotice: notice }), investigation }) as { notice: Record<string, unknown> };

  it('notice / non-renewal need notice days; probation does not', () => {
    expect(build({ reason: 'NOTICE', lastWorkingDate: '2026-11-30', noticeDays: 60 }).notice).toMatchObject({ reason: 'NOTICE', noticeDays: 60, investigation: null });
    expect(codes(() => build({ reason: 'NON_RENEWAL', lastWorkingDate: '2026-11-30' }))).toContain('NOTICE_DAYS_REQUIRED');
    expect(build({ reason: 'PROBATION', lastWorkingDate: '2026-10-05' }).notice.noticeDays).toBeNull();
  });

  it('Article 80: a concluded investigation of the same employee; no notice days printed', () => {
    expect(codes(() => build({ reason: 'ARTICLE_80', lastWorkingDate: '2026-09-30' }))).toContain('INVESTIGATION_REQUIRED');
    expect(codes(() => build({ reason: 'ARTICLE_80', lastWorkingDate: '2026-09-30', investigationId: 'i1' }, { investigation: { ...inv, status: 'IN_PROGRESS' } }))).toContain('INVESTIGATION_NOT_CONCLUDED');
    expect(codes(() => build({ reason: 'ARTICLE_80', lastWorkingDate: '2026-09-30', investigationId: 'i1' }, { investigation: { ...inv, employeeId: 'x' } }))).toContain('INVESTIGATION_REQUIRED');
    const n = build({ reason: 'ARTICLE_80', lastWorkingDate: '2026-09-30', noticeDays: 30, investigationId: 'i1' }, { investigation: inv }).notice;
    expect(n).toMatchObject({ noticeDays: null, investigation: { subjectAr: 'غياب متصل', closedDate: '2026-09-10' } });
  });

  it('locked like the warning; Arabic only; free clarification text follows the font rules', () => {
    expect(effectivePolicy(TERMINATION_NOTICE, { enabled: true, selfService: true, requiresApproval: false, validityDays: null, signatoryId: null })).toMatchObject({ requiresApproval: true, selfService: false });
    expect(codes(() => buildContractData(TERMINATION_NOTICE, { employee, company, params: params({ language: 'ar-en', terminationNotice: { reason: 'PROBATION', lastWorkingDate: '2026-10-05' } }) }))).toContain('LANGUAGE_NOT_SUPPORTED');
    expect(paramsSchema.safeParse({ terminationNotice: { reason: 'PROBATION', lastWorkingDate: '2026-10-05', detailsAr: 'نص 😀 طويل' } }).success).toBe(false);
  });
});

describe('termination notice: database text is checked before approval, not after', () => {
  it('an investigation subject the fonts cannot print is refused at creation', () => {
    const inv = { id: 'i1', employeeId: 'e1', subject: 'غياب 😀', status: 'CLOSED', updatedAt: new Date('2026-09-10T08:00:00Z') };
    expect(codes(() => buildContractData(TERMINATION_NOTICE, { employee, company, params: params({ terminationNotice: { reason: 'ARTICLE_80', lastWorkingDate: '2026-09-30', investigationId: 'i1' } }), investigation: { investigation: inv } }))).toContain('INVESTIGATION_SUBJECT_TEXT');
  });
});

describe('salary transfer letter (STF): bank from the file, always approved, portal allowed', () => {
  const bank = { bankName: 'مصرف الراجحي', iban: 'SA0380000000608010167519' };
  const build = (b = bank) => buildContractData(SALARY_TRANSFER, { employee, company, params: params({ language: 'ar' }), bank: b }) as { bank: unknown; salary: { total: string } };

  it('carries the bank and a valid Saudi IBAN with the salary', () => {
    expect(build().bank).toEqual({ name: 'مصرف الراجحي', iban: 'SA0380000000608010167519' });
  });

  it('refuses a missing bank, an invalid IBAN, an unprintable bank name', () => {
    expect(codes(() => build({ ...bank, bankName: null } as never))).toContain('MISSING_BANK');
    expect(codes(() => build({ ...bank, iban: 'SA0380000000608010167518' }))).toContain('INVALID_IBAN');
    expect(codes(() => build({ ...bank, iban: null } as never))).toContain('INVALID_IBAN');
    expect(codes(() => build({ ...bank, bankName: 'بنك 😀' }))).toContain('BANK_NAME_TEXT');
  });

  it('approval cannot be switched off and a pre-authorization does not replace it; the portal stays open', () => {
    const policy = effectivePolicy(SALARY_TRANSFER, { enabled: true, selfService: null, requiresApproval: false, validityDays: null, signatoryId: 's1' });
    expect(policy).toMatchObject({ requiresApproval: true, selfService: true });
    expect(needsApproval(policy, { printImage: true, basis: 'PRE_AUTHORIZED', approvalId: null, authorizationId: 'a1' }, [], 'h')).toBe(true);
  });
});

describe('no-objection letter (NOC): listed purpose, the employee writes the destination, always approved', () => {
  it('builds with the purpose and destination; requires them; text follows the font rules', () => {
    const data = buildContractData(NO_OBJECTION, { employee, company, params: params({ language: 'ar-en', noc: { purpose: 'TRAVEL', targetAr: 'المملكة المتحدة (UK)', detailsAr: 'من 1 إلى 20 ديسمبر 2026' } }) }) as { noc: unknown };
    expect(data.noc).toEqual({ purpose: 'TRAVEL', targetAr: 'المملكة المتحدة (UK)', detailsAr: 'من 1 إلى 20 ديسمبر 2026' });
    expect(codes(() => buildContractData(NO_OBJECTION, { employee, company, params: params({}) }))).toContain('MISSING_NOC');
    expect(paramsSchema.safeParse({ noc: { purpose: 'TRAVEL', targetAr: 'دبي 🏝️' } }).success).toBe(false);
    expect(paramsSchema.safeParse({ noc: { purpose: 'MARRIAGE', targetAr: 'x y' } }).success).toBe(false);
  });

  it('portal allowed, approval mandatory, 30 days', () => {
    expect(effectivePolicy(NO_OBJECTION, { enabled: true, selfService: null, requiresApproval: false, validityDays: null, signatoryId: null })).toMatchObject({ selfService: true, requiresApproval: true, validityDays: 30 });
  });
});

describe('promotion / salary decision (PRM): the approved change is carried out on the file', () => {
  const build = (promotion: Record<string, unknown>) =>
    buildContractData(PROMOTION_DECISION, { employee, company, params: params({ language: 'ar', promotion }) }) as { change: Record<string, unknown> };

  it('carries the current and the new values; unchanged values are not repeated', () => {
    expect(build({ newJobTitleAr: 'مهندس أول', newBasicSalary: 11000, effectiveDate: '2026-10-01', reasonAr: 'تقديرا لأدائه' }).change).toEqual({
      effectiveDate: '2026-10-01', fromJobTitleAr: 'مهندس مدني', toJobTitleAr: 'مهندس أول', toJobTitleEn: null,
      fromBasicSalary: '9500.00', toBasicSalary: '11000.00', reasonAr: 'تقديرا لأدائه',
    });
    expect(build({ newBasicSalary: 11000, effectiveDate: '2026-10-01' }).change).toMatchObject({ toJobTitleAr: null, toBasicSalary: '11000.00' });
  });

  it('refuses nothing to change, a salary with more than 2 decimals; locked approval', () => {
    expect(codes(() => build({ newBasicSalary: 9500, effectiveDate: '2026-10-01' }))).toContain('NO_CHANGE');
    expect(paramsSchema.safeParse({ promotion: { effectiveDate: '2026-10-01' } }).success).toBe(false);
    expect(paramsSchema.safeParse({ promotion: { newBasicSalary: 1000.005, effectiveDate: '2026-10-01' } }).success).toBe(false);
    expect(effectivePolicy(PROMOTION_DECISION, null)).toMatchObject({ requiresApproval: true, selfService: false });
  });
});

describe('job offer (OFR): a document for a candidate, not an employee', () => {
  const candidate = { id: 'a1', candidateName: 'سارة أحمد', candidateEmail: 'sara@example.test', status: 'INTERVIEW' };
  const offer = { legalCompanyId: 'c1', jobTitleAr: 'محاسبة', basicSalary: 8000, housingAllowance: 2000, startDate: '2026-11-01', probationDays: 90, annualLeaveDays: 21 };
  const build = (o: Record<string, unknown> = offer, c = candidate, language = 'ar') =>
    buildCandidateContractData(JOB_OFFER, { candidate: c, company, params: params({ language, offer: o }) }) as { candidate: unknown; offer: { salary: { rows: { key: string }[]; total: string } } };

  it('builds from the application and the terms HR wrote', () => {
    const d = build();
    expect(d.candidate).toEqual({ nameAr: 'سارة أحمد' });
    expect(d.offer.salary.rows.map((r) => r.key)).toEqual(['BASIC', 'HOUSING']);
    expect(d.offer.salary.total).toBe('10000.00');
  });

  it('refuses a closed application, a bilingual offer without English title, the employee path', () => {
    expect(codes(() => build(offer, { ...candidate, status: 'HIRED' }))).toContain('CANDIDATE_CLOSED');
    expect(codes(() => build(offer, candidate, 'ar-en'))).toContain('MISSING_JOB_TITLE_EN');
    expect(codes(() => buildContractData(JOB_OFFER, { employee, company, params: params({ offer }) }))).toContain('SUBJECT');
    expect(codes(() => buildCandidateContractData(SALARY_CERTIFICATE, { candidate, company, params: params({}) }))).toContain('SUBJECT');
  });

  it('locked approval, never from the portal, 14 days', () => {
    expect(effectivePolicy(JOB_OFFER, null)).toMatchObject({ requiresApproval: true, selfService: false, validityDays: 14 });
  });
});

describe('leave approval letter (LVE): automatic, no health leave types', () => {
  const leave = { id: 'l1', employeeId: 'e1', leaveType: 'ANNUAL', status: 'APPROVED', startDate: new Date('2026-12-01T21:00:00Z'), endDate: new Date('2026-12-20T21:00:00Z'), totalDays: 20, isOutsideKSA: true };
  const build = (over: Partial<typeof leave> = {}) =>
    buildContractData(LEAVE_APPROVAL, { employee, company, params: params({ language: 'ar', leaveId: 'l1' }), leave: { leave: { ...leave, ...over } } }) as { leave: Record<string, unknown> };

  it('dates, days and the return day (the day after the end)', () => {
    expect(build().leave).toMatchObject({ typeAr: 'إجازة سنوية', startDate: '2026-12-02', endDate: '2026-12-21', returnDate: '2026-12-22', totalDays: 20, outsideKsa: true });
  });

  it('refuses health leave types, unapproved leaves, another employee; automatic like the payslip', () => {
    expect(codes(() => build({ leaveType: 'SICK' }))).toContain('LEAVE_TYPE_NO_LETTER');
    expect(codes(() => build({ leaveType: 'MATERNITY' }))).toContain('LEAVE_TYPE_NO_LETTER');
    expect(codes(() => build({ status: 'PENDING' }))).toContain('LEAVE_NOT_APPROVED');
    expect(codes(() => build({ employeeId: 'x' }))).toContain('LEAVE_NOT_FOUND');
    expect(effectivePolicy(LEAVE_APPROVAL, null)).toMatchObject({ requiresApproval: false, selfService: false, signatoryId: null });
  });
});

describe('evaluation report (EVL): automatic on close; database text made printable', () => {
  const ev = {
    id: 'v1', employeeId: 'e1', status: 'CLOSED', totalScore: 86.456, finalRating: 'ممتاز ⭐', recommendation: 'PROMOTION', recommendationReason: 'أداء ثابت',
    strengths: 'الالتزام 👍\r\nالدقة', improvements: null, finalNotes: 'استمر', employeeAcknowledgedAt: new Date('2026-09-20T08:00:00Z'), employeeComment: 'شكرا',
    cycle: { title: 'تقييم 2026', startDate: new Date('2025-12-31T21:00:00Z'), endDate: new Date('2026-06-29T21:00:00Z') },
    sections: [{ title: 'الأداء', weight: 60, items: [{ title: 'إنجاز المهام', score: 5, note: null }] }],
  };
  const build = (over: Partial<typeof ev> = {}) =>
    buildContractData(EVALUATION_REPORT, { employee, company, params: params({ language: 'ar', evaluationId: 'v1' }), evaluation: { evaluation: { ...ev, ...over } } }) as { evaluation: Record<string, unknown> };

  it('unprintable characters are dropped, not refused; score rounded; recommendation labelled', () => {
    const v = build().evaluation;
    expect(v).toMatchObject({ finalRating: 'ممتاز', strengths: 'الالتزام\nالدقة', totalScore: '86.5', recommendationAr: 'ترقية', acknowledgedDate: '2026-09-20', periodStart: '2026-01-01' });
    expect(printable('😀')).toBeNull();
  });

  it('only closed evaluations with scores; automatic', () => {
    expect(codes(() => build({ status: 'PENDING_EMPLOYEE_ACK' }))).toContain('EVALUATION_NOT_CLOSED');
    expect(codes(() => build({ sections: [] }))).toContain('EVALUATION_EMPTY');
    expect(effectivePolicy(EVALUATION_REPORT, null)).toMatchObject({ requiresApproval: false, signatoryId: null });
  });
});

describe('investigation minutes (INV): concluded investigations, locked approval, texts printable', () => {
  const inv = {
    id: 'i1', employeeId: 'e1', subject: 'غياب متصل 🚫', status: 'COMPLETED_GUILTY', updatedAt: new Date('2026-09-10T08:00:00Z'), createdAt: new Date('2026-09-01T08:00:00Z'),
    description: 'غاب 5 أيام', category: 'ATTENDANCE', findings: 'ثبت الغياب', recommendation: 'خصم', finalDecision: 'خصم يومين', penaltyAmount: 633.33, penaltyDays: 2, investigatorName: 'خالد', investigatorRole: 'مدير الشؤون القانونية',
  };
  const build = (over: Partial<typeof inv> = {}) =>
    buildContractData(INVESTIGATION_MINUTES, { employee, company, params: params({ language: 'ar', investigationId: 'i1' }), investigation: { investigation: { ...inv, ...over } } }) as { minutes: Record<string, unknown> };

  it('content from the file; unprintable characters dropped; penalty shown when set', () => {
    expect(build().minutes).toMatchObject({ subjectAr: 'غياب متصل', categoryAr: 'الحضور والانصراف', outcomeAr: 'ثبتت المخالفة', penaltyAmount: '633.33', penaltyDays: 2, investigator: 'خالد - مدير الشؤون القانونية', openedDate: '2026-09-01' });
    expect(build({ status: 'COMPLETED_INNOCENT', penaltyAmount: 0, penaltyDays: 0 }).minutes).toMatchObject({ outcomeAr: 'لم تثبت المخالفة', penaltyAmount: null, penaltyDays: null });
  });

  it('refused while open; locked approval', () => {
    expect(codes(() => build({ status: 'IN_PROGRESS' }))).toContain('INVESTIGATION_NOT_CONCLUDED');
    expect(effectivePolicy(INVESTIGATION_MINUTES, { enabled: true, selfService: true, requiresApproval: false, validityDays: null, signatoryId: null })).toMatchObject({ requiresApproval: true, selfService: false });
  });
});
