import { describe, expect, it } from 'vitest';
import {
  buildContractData, ContractValidationError, EXPERIENCE_CERTIFICATE, getDocumentType, nationalityEnglish,
  SALARY_CERTIFICATE, type CompanyRecord, type EmployeeRecord,
} from '@/lib/documents/types';
import {
  authorizationApplies, computeValidUntil, decideSignature, effectivePolicy, needsApproval, validityStatus,
  type AuthorizationRow, type SignatoryRow,
} from '@/lib/documents/policy';
import { buildRenderModel } from '@/lib/documents/render-model';

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Abdullah Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: 'N1234567', jobTitle: 'مهندس مدني أول', jobTitleEnglish: 'Senior Civil Engineer',
  joinDate: new Date('2019-03-09T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1',
  allowances: [
    { name: 'بدل سكن', amount: 2375, isMonthly: true, allowanceType: null },
    { name: 'Transport', amount: 950, isMonthly: true, allowanceType: 'TRANSPORT' },
    { name: 'مكافأة', amount: 5000, isMonthly: false, allowanceType: null },
    { name: 'بدل جوال', amount: 175.5, isMonthly: true, allowanceType: 'OTHER' },
    { name: 'بدل تميز', amount: 500, isMonthly: true, allowanceType: null },
  ],
};
/** Shape of the contract data these tests read. */
type Data = {
  salary: { rows: { key: string; amount: string }[]; total: string };
  employee: { joinDate: string; nationalityEn: string | null; idKind: string };
  service: { startDate: string; endDate: string | null; inService: boolean };
};

const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي', nameEnglish: 'ACME Co.', commercialRegNum: '1010123456', unifiedNumber: '7001234567' };

describe('contract data (SPEC §4.2)', () => {
  it('salary certificate: basic + recurring allowances grouped by kind, one-offs excluded, exact total', () => {
    const data = buildContractData(SALARY_CERTIFICATE, { employee, company, params: { language: 'ar-en' } }) as unknown as Data;
    expect(data.salary.rows.map((r) => [r.key, r.amount])).toEqual([
      ['BASIC', '9500.00'], ['HOUSING', '2375.00'], ['TRANSPORT', '950.00'], ['OTHER', '675.50'],
    ]);
    expect(data.salary.total).toBe('13500.50');
    expect(data.employee.joinDate).toBe('2019-03-10'); // Riyadh calendar day
    expect(data.employee.nationalityEn).toBe('Jordanian');
    expect(data.employee.idKind).toBe('IQAMA');
  });

  it('lists every missing field at once for a bilingual letter (never guesses English)', () => {
    const e = { ...employee, firstNameEnglish: null, lastNameEnglish: null, jobTitleEnglish: null, nationality: 'جزر القمر' };
    try {
      buildContractData(SALARY_CERTIFICATE, { employee: e, company: { ...company, nameEnglish: null }, params: { language: 'ar-en' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      expect((err as ContractValidationError).errors.map((x) => x.code).sort()).toEqual(
        ['MISSING_COMPANY_NAME_EN', 'MISSING_JOB_TITLE_EN', 'MISSING_NAME_EN', 'UNKNOWN_NATIONALITY_EN'],
      );
    }
    // Arabic-only letter needs none of them.
    expect(() => buildContractData(SALARY_CERTIFICATE, { employee: e, company, params: { language: 'ar' } })).not.toThrow();
  });

  it('salary / employment letters are refused for a terminated employee; experience is not', () => {
    const t = { ...employee, isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') };
    expect(() => buildContractData(SALARY_CERTIFICATE, { employee: t, company, params: { language: 'ar' } })).toThrow(/منتهية خدمته/);
    const exp = buildContractData(EXPERIENCE_CERTIFICATE, { employee: t, company, params: { language: 'ar' } }) as unknown as Data;
    expect(exp.service).toEqual({ startDate: '2019-03-10', endDate: '2026-09-01', inService: false });
  });

  it('registry lookups are exact (no prototype keys)', () => {
    expect(getDocumentType('SALARY_CERTIFICATE')?.code).toBe('SAL');
    expect(getDocumentType('toString')).toBeNull();
    expect(getDocumentType('__proto__')).toBeNull();
  });

  it('nationality translation', () => {
    expect(nationalityEnglish('مصري')).toBe('Egyptian');
    expect(nationalityEnglish(' سعودي ')).toBe('Saudi');
    expect(nationalityEnglish('غير معروف')).toBeNull();
  });
});

const signatory: SignatoryRow = { id: 's1', companyId: 'c1', userId: 'u-sig', isActive: true, signatureAssetId: 'a1', stampAssetId: 'a2' };
const now = new Date('2026-09-26T09:00:00Z');
const auth = (over: Partial<AuthorizationRow> = {}): AuthorizationRow => ({
  id: 'auth1', signatoryId: 's1', legalCompanyId: 'c1', typeKey: 'SALARY_CERTIFICATE', scopeJson: null,
  validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null, acceptedAt: new Date('2026-01-02T00:00:00Z'), revokedAt: null, ...over,
});
const base = { signatory, legalCompanyId: 'c1', typeKey: 'SALARY_CERTIFICATE', snapshotSha256: 'h1', approvals: [], authorizations: [], now, totalSalary: '13500.50' };

describe('signature authorization (DOC-04)', () => {
  it('an existing signature image alone never prints', () => {
    expect(decideSignature(base)).toEqual({ printImage: false, reason: 'NOT_AUTHORIZED' });
  });
  it('prints when the signatory himself approved this snapshot', () => {
    const d = decideSignature({ ...base, approvals: [{ id: 'ap1', approverId: 'u-sig', decision: 'APPROVED', snapshotSha256: 'h1', invalidatedAt: null }] });
    expect(d).toMatchObject({ printImage: true, basis: 'SIGNATORY_APPROVED', approvalId: 'ap1' });
  });
  it("another person's approval, a stale or invalidated approval does not print", () => {
    for (const a of [
      { id: 'x', approverId: 'u-hr', decision: 'APPROVED', snapshotSha256: 'h1', invalidatedAt: null },
      { id: 'x', approverId: 'u-sig', decision: 'APPROVED', snapshotSha256: 'OLD', invalidatedAt: null },
      { id: 'x', approverId: 'u-sig', decision: 'APPROVED', snapshotSha256: 'h1', invalidatedAt: now },
      { id: 'x', approverId: 'u-sig', decision: 'REJECTED', snapshotSha256: 'h1', invalidatedAt: null },
    ]) expect(decideSignature({ ...base, approvals: [a] }).printImage).toBe(false);
  });
  it('pre-authorization: explicit, accepted, in time, same type and company, within scope, not revoked', () => {
    expect(decideSignature({ ...base, authorizations: [auth()] })).toMatchObject({ printImage: true, basis: 'PRE_AUTHORIZED', authorizationId: 'auth1' });
    const ctx = { signatory, legalCompanyId: 'c1', typeKey: 'SALARY_CERTIFICATE', now, totalSalary: '13500.50' };
    expect(authorizationApplies(auth({ revokedAt: now }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ acceptedAt: null }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ acceptedAt: null }), { ...ctx, signatory: { ...signatory, userId: null } })).toBe(true);
    expect(authorizationApplies(auth({ typeKey: 'EMPLOYMENT_CERTIFICATE' }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ legalCompanyId: 'c2' }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ validFrom: new Date('2026-10-01T00:00:00Z') }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ validUntil: new Date('2026-09-01T00:00:00Z') }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ scopeJson: '{"maxTotalSalary":"10000.00"}' }), ctx)).toBe(false);
    expect(authorizationApplies(auth({ scopeJson: '{"maxTotalSalary":"20000.00"}' }), ctx)).toBe(true);
    expect(authorizationApplies(auth({ scopeJson: 'not json' }), ctx)).toBe(false);
  });
  it('inactive signatory, other company or no image: never printed', () => {
    expect(decideSignature({ ...base, signatory: { ...signatory, isActive: false }, authorizations: [auth()] }).printImage).toBe(false);
    expect(decideSignature({ ...base, signatory: { ...signatory, companyId: 'c2' }, authorizations: [auth()] }).printImage).toBe(false);
    expect(decideSignature({ ...base, signatory: { ...signatory, signatureAssetId: null }, authorizations: [auth()] }).printImage).toBe(false);
    expect(decideSignature({ ...base, signatory: null }).printImage).toBe(false);
  });
});

describe('approval policy (owner decision SPEC §15.2)', () => {
  const policy = effectivePolicy(SALARY_CERTIFICATE, null);
  it('issued at once only under a valid pre-authorization', () => {
    expect(needsApproval(policy, decideSignature({ ...base, authorizations: [auth()] }), [], 'h1')).toBe(false);
    expect(needsApproval(policy, decideSignature(base), [], 'h1')).toBe(true);
  });
  it('a company policy requiring approval wins until the current snapshot is approved', () => {
    const strict = effectivePolicy(SALARY_CERTIFICATE, { enabled: true, selfService: null, requiresApproval: true, validityDays: null, signatoryId: null });
    const pre = decideSignature({ ...base, authorizations: [auth()] });
    expect(needsApproval(strict, pre, [], 'h1')).toBe(true);
    expect(needsApproval(strict, pre, [{ id: 'a', approverId: 'u', decision: 'APPROVED', snapshotSha256: 'h1', invalidatedAt: null }], 'h1')).toBe(false);
    expect(needsApproval(strict, pre, [{ id: 'a', approverId: 'u', decision: 'APPROVED', snapshotSha256: 'h0', invalidatedAt: null }], 'h1')).toBe(true);
  });
  it('validity defaults: 90 days for salary letters, none for experience', () => {
    expect(policy.validityDays).toBe(90);
    expect(effectivePolicy(EXPERIENCE_CERTIFICATE, null).validityDays).toBeNull();
    expect(effectivePolicy(SALARY_CERTIFICATE, { enabled: true, selfService: null, requiresApproval: null, validityDays: 30, signatoryId: null }).validityDays).toBe(30);
  });
});

describe('validity (EXPIRED computed, never stored — DOC-08)', () => {
  it('valid until the end of the Riyadh day, validityDays after issuance', () => {
    const issued = new Date('2026-09-26T09:00:00Z'); // 12:00 Riyadh
    const until = computeValidUntil(issued, 90)!;
    expect(until.toISOString()).toBe('2026-12-25T20:59:59.000Z'); // 23:59:59 Riyadh on 25 Dec
    expect(computeValidUntil(issued, null)).toBeNull();
    expect(validityStatus({ status: 'ISSUED', validUntil: until }, new Date('2026-12-25T20:00:00Z'))).toBe('VALID');
    expect(validityStatus({ status: 'ISSUED', validUntil: until }, new Date('2026-12-25T21:00:00Z'))).toBe('EXPIRED');
    expect(validityStatus({ status: 'REVOKED', validUntil: null })).toBe('REVOKED');
    expect(validityStatus({ status: 'ISSUED', validUntil: null, purgedAt: new Date() })).toBe('PURGED');
  });
});

describe('render model (ADR DOC-01)', () => {
  it('produces the display strings the template prints; diacritics removed', () => {
    const data = buildContractData(SALARY_CERTIFICATE, { employee: { ...employee, firstNameArabic: 'مُحَمَّد' }, company, params: { language: 'ar' } }) as never;
    const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
      typeLabelAr: 'خطاب تعريف بالراتب', typeLabelEn: 'Salary Certificate', number: 'ACM-SAL-2026-000184', issuedDate: '2026-09-26',
      validUntilDate: '2026-12-25', verifyUrl: 'https://x/v/T', language: 'ar', addresseeAr: null, addresseeEn: null, signature: null, hasLogo: false,
    });
    expect(model.employee.fullNameAr).toBe('محمد عبدالله الأحمد');
    expect(model.doc.issuedHijriAr).toBe('15 ربيع الآخر 1448 هـ');
    expect(model.salary?.totalText).toBe('13,500.50');
    expect(model.addressee.ar).toBe('إلى من يهمه الأمر');
    expect(model.doc.validUntilAr).toBe('25 ديسمبر 2026');
  });
});
