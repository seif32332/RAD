// Contract addendum (AMD, SPEC §15 item 35): what the builder turns into rows and terms to apply,
// what it refuses, the policy lock, the notices, and the job's copy of the allowance rule.
// Pure: no database, no render service.
import { describe, expect, it } from 'vitest';
import {
  addendumParamsSchema, buildContractData, CONTRACT_ADDENDUM, ContractValidationError, paramsSchema,
  type AddendumFacts, type CompanyRecord, type EmployeeRecord,
} from '@/lib/documents/types';
import { effectivePolicy } from '@/lib/documents/policy';
import { buildRenderModel } from '@/lib/documents/render-model';
import { noticeText } from '@/lib/documents/notify';

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: null, jobTitle: 'مهندس مدني', jobTitleEnglish: 'Civil Engineer',
  joinDate: new Date('2019-03-09T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1',
  allowances: [
    { name: 'بدل سكن', amount: 2375, isMonthly: true, allowanceType: 'HOUSING' },
    { name: 'بدل مواصلات', amount: 950, isMonthly: true, allowanceType: null },
  ],
};
const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي', nameEnglish: 'ACME Co.', commercialRegNum: '1010123456', unifiedNumber: null };
const facts: AddendumFacts = {
  branch: { id: 'b1', nameAr: 'فرع الرياض' },
  contractEndDate: new Date('2026-12-31T21:00:00Z'), // 2027-01-01 in Riyadh
  newBranch: { id: 'b2', nameAr: 'فرع جدة' },
};

type Addendum = { addendum: { effectiveDate: string; rows: Array<{ key: string; fromAr: string; toAr: string; money: boolean }>; reasonAr: string | null; apply: Record<string, string | null> } };
const build = (addendum: Record<string, unknown>, f: AddendumFacts | undefined = facts, e: EmployeeRecord = employee) =>
  buildContractData(CONTRACT_ADDENDUM, { employee: e, company, params: paramsSchema.parse({ language: 'ar', addendum }), addendum: f }) as Addendum;
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContractValidationError) return e.errors.map((x) => x.code);
    throw e;
  }
  return [];
};

describe('contract addendum (AMD)', () => {
  it('lists only the terms that change, from the file to the new value, and the terms acceptance applies', () => {
    const d = build({
      effectiveDate: '2026-10-01', newBasicSalary: 10500, newHousingAllowance: 2625, newTransportAllowance: 950,
      newJobTitleAr: 'مهندس مدني أول', newJobTitleEn: 'Senior Civil Engineer', newBranchId: 'b2', newContractEndDate: '2028-09-30', reasonAr: 'بناء على نتيجة التقييم السنوي',
    });
    expect(d.addendum.rows.map((r) => [r.key, r.fromAr, r.toAr])).toEqual([
      ['BASIC', '9500.00', '10500.00'],
      ['HOUSING', '2375.00', '2625.00'],
      // transport unchanged (950 = 950, classified from the name): not listed, not applied
      ['JOB_TITLE', 'مهندس مدني', 'مهندس مدني أول'],
      ['BRANCH', 'فرع الرياض', 'فرع جدة'],
      ['CONTRACT_END', '2027-01-01', '2028-09-30'],
    ]);
    expect(d.addendum.apply).toEqual({
      basicSalary: '10500.00', housingAllowance: '2625.00', transportAllowance: null, jobTitleAr: 'مهندس مدني أول', jobTitleEn: 'Senior Civil Engineer',
      branchId: 'b2', contractEndDate: '2028-09-30',
    });
    expect(d.addendum.reasonAr).toBe('بناء على نتيجة التقييم السنوي');
  });

  it('adds an allowance the file does not have yet (from 0), and a first contract end', () => {
    const d = build({ effectiveDate: '2026-10-01', newTransportAllowance: 500, newContractEndDate: '2027-09-30' }, { ...facts, contractEndDate: null }, { ...employee, allowances: [] });
    expect(d.addendum.rows.map((r) => [r.key, r.fromAr, r.toAr])).toEqual([['TRANSPORT', '0.00', '500.00'], ['CONTRACT_END', 'غير محدد المدة', '2027-09-30']]);
  });

  it('refuses: nothing given, nothing different, two housing rows, an unknown branch, a contract end not after the effective date', () => {
    expect(addendumParamsSchema.safeParse({ effectiveDate: '2026-10-01' }).success).toBe(false);
    expect(codes(() => build({ effectiveDate: '2026-10-01', newBasicSalary: 9500 }))).toEqual(['NO_CHANGE']);
    const twoHousing = { ...employee, allowances: [...employee.allowances, { name: 'سكن إضافي', amount: 500, isMonthly: true, allowanceType: null }] };
    expect(codes(() => build({ effectiveDate: '2026-10-01', newHousingAllowance: 3000 }, facts, twoHousing))).toContain('MULTIPLE_HOUSING');
    expect(codes(() => build({ effectiveDate: '2026-10-01', newBranchId: 'x' }, { ...facts, newBranch: null }))).toContain('UNKNOWN_BRANCH');
    expect(codes(() => build({ effectiveDate: '2026-10-01', newContractEndDate: '2026-10-01' }))).toContain('CONTRACT_END_BEFORE_EFFECTIVE');
    expect(codes(() => build({ effectiveDate: '2026-10-01', newBasicSalary: 10000 }, facts, { ...employee, isTerminated: true, terminationDate: new Date() }))).not.toEqual([]);
  });

  it('is locked: second-person approval, never from the portal; the employee answers it (CONSENT)', () => {
    expect(effectivePolicy(CONTRACT_ADDENDUM, { selfService: true, requiresApproval: false } as never)).toMatchObject({ requiresApproval: true, selfService: false });
    expect(CONTRACT_ADDENDUM.acknowledgement).toBe('CONSENT');
    expect(CONTRACT_ADDENDUM.executesOnConsent).toBe(true);
    expect(CONTRACT_ADDENDUM.executesChange).toBeFalsy(); // issuance alone changes nothing
  });

  it('render model: amounts as one LTR run, the contract end as an Arabic date', () => {
    const d = build({ effectiveDate: '2026-10-01', newBasicSalary: 10500, newContractEndDate: '2028-09-30' });
    const m = buildRenderModel(d as never, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
      typeLabelAr: 'ملحق عقد عمل', typeLabelEn: 'x', number: 'ACM-AMD-2026-000001', issuedDate: '2026-09-27', validUntilDate: null, verifyUrl: 'https://x/v/y',
      language: 'ar', addresseeAr: null, addresseeEn: null, addressedToEmployee: true, signature: null, hasLogo: false,
    }) as unknown as { addendum: { rows: Array<{ ltr: boolean; fromText: string; toText: string }> } };
    expect(m.addendum.rows[0]).toMatchObject({ ltr: true, fromText: '9,500.00', toText: '10,500.00' });
    expect(m.addendum.rows[1].ltr).toBe(false);
    expect(m.addendum.rows[1].toText).toMatch(/2028/);
    expect(m.addendum.rows[1].toText.endsWith(' م')).toBe(true);
  });

  it('notices: the employee is told the answer deadline; HR is told the answer, without personal data', () => {
    const issued = noticeText({ kind: 'ISSUED', number: 'ACM-AMD-2026-000001', typeLabel: 'ملحق عقد عمل', acknowledge: true, consentBy: '1 أكتوبر 2026' });
    expect(issued.body).toContain('الموافقة عليه أو رفضه قبل 1 أكتوبر 2026');
    const yes = noticeText({ kind: 'CONSENT_ANSWERED', number: 'ACM-AMD-2026-000001', typeLabel: 'ملحق عقد عمل', accepted: true });
    const no = noticeText({ kind: 'CONSENT_ANSWERED', number: 'ACM-AMD-2026-000001', typeLabel: 'ملحق عقد عمل', accepted: false });
    expect(yes.body).toContain('وافق الموظف');
    expect(no.body).toContain('لا يتغير شيء');
    for (const t of [issued, yes, no]) expect(`${t.subject} ${t.body}`).not.toMatch(/محمد|9500|10500/);
  });
});
