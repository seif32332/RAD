// WP-3 (council 2): employee data-quality gates for create and import.
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TYPE_LABELS,
  GENDER_REQUIRED_MESSAGE,
  MIN_GREGORIAN_YEAR,
  employeeDateIssues,
  hijriLikeDateError,
  matchAllByName,
  orgPlacementErrors,
  parseContractTypeLabel,
  recordCountLabel,
  resolveOrgUnit,
  zRequiredGender,
} from '@/lib/employee';
import { NON_SAUDI_CONTRACT_END_WARNING, employeeDataWarnings, sharedIbanWarning } from '@/lib/employee-shared';
import { ibanCheckDigits } from '@/lib/iban';

const bban = '80000000000000004321'; // synthetic
const VALID_IBAN = `SA${ibanCheckDigits('SA', bban)}${bban}`;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
// 2026-09-25 10:00 Riyadh
const NOW = new Date('2026-09-25T07:00:00.000Z');

describe('zRequiredGender', () => {
  it('accepts MALE / FEMALE and the Arabic labels', () => {
    expect(zRequiredGender.parse('MALE')).toBe('MALE');
    expect(zRequiredGender.parse('أنثى')).toBe('FEMALE');
    expect(zRequiredGender.parse(' ذكر ')).toBe('MALE');
  });
  it('rejects a blank or missing value with the Arabic "required" message (no MALE default)', () => {
    for (const v of [undefined, null, '', '   ']) {
      const r = zRequiredGender.safeParse(v);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe(GENDER_REQUIRED_MESSAGE);
    }
  });
  it('rejects an unknown value with an Arabic message', () => {
    const r = zRequiredGender.safeParse('X');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/الجنس/);
  });
});

describe('matchAllByName / resolveOrgUnit', () => {
  const companies = [
    { id: 'c1', nameArabic: 'شركة مكررة', nameEnglish: null, cr: '1010000001' },
    { id: 'c2', nameArabic: 'شركة مكررة', nameEnglish: 'Dup Co', cr: '1010000002' },
    { id: 'c3', nameArabic: 'شركة مكررة ', nameEnglish: null, cr: '1010000003' },
    { id: 'c4', nameArabic: 'شركة الرياض للتجارة', nameEnglish: 'Riyadh Trading', cr: '1010000004' },
  ];
  const keys = (c: (typeof companies)[number]) => [c.id, c.cr];

  it('returns every exact (trimmed) match', () => {
    expect(matchAllByName(companies, 'شركة مكررة').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(matchAllByName(companies, 'Riyadh Trading').map((c) => c.id)).toEqual(['c4']);
    expect(matchAllByName(companies, 'الرياض')).toEqual([]); // containment is not exact
    expect(matchAllByName(companies, '  ')).toEqual([]);
  });
  it('extra keys (CR number / id) count as exact matches', () => {
    expect(matchAllByName(companies, '1010000002', keys).map((c) => c.id)).toEqual(['c2']);
    expect(matchAllByName(companies, 'c3', keys).map((c) => c.id)).toEqual(['c3']);
  });
  it('several exact matches are ambiguous unless the preferred (current) id is one of them', () => {
    expect(resolveOrgUnit(companies, 'شركة مكررة')).toEqual({ kind: 'ambiguous', count: 3 });
    const kept = resolveOrgUnit(companies, 'شركة مكررة', { preferId: 'c2' });
    expect(kept.kind === 'exact' && kept.item.id).toBe('c2');
    expect(resolveOrgUnit(companies, 'شركة مكررة', { preferId: 'c4' }).kind).toBe('ambiguous');
  });
  it('a unique name, a CR number, a containment match and no match', () => {
    const one = resolveOrgUnit(companies, 'شركة الرياض للتجارة');
    expect(one.kind === 'exact' && one.item.id).toBe('c4');
    const byCr = resolveOrgUnit(companies, '1010000003', { extraKeys: keys });
    expect(byCr.kind === 'exact' && byCr.item.id).toBe('c3');
    const approx = resolveOrgUnit(companies, 'الرياض للتجارة');
    expect(approx.kind === 'approx' && approx.item.id).toBe('c4');
    expect(resolveOrgUnit(companies, 'غير موجودة')).toEqual({ kind: 'none' });
    expect(resolveOrgUnit(companies, '')).toEqual({ kind: 'none' });
  });
  it('recordCountLabel follows Arabic number agreement', () => {
    expect(recordCountLabel(2)).toBe('سجلين');
    expect(recordCountLabel(3)).toBe('3 سجلات');
    expect(recordCountLabel(11)).toBe('11 سجلاً');
  });
});

describe('hijriLikeDateError', () => {
  it('flags a year below 1900 with the Hijri hint and the typed text', () => {
    const msg = hijriLikeDateError('تاريخ الميلاد', d('1448-05-10'), '1448/05/10');
    expect(msg).toBe('تاريخ الميلاد «1448/05/10» يبدو هجرياً، حوّله إلى ميلادي');
    expect(hijriLikeDateError('تاريخ المباشرة', d('1899-12-31'))).toContain('1899-12-31');
  });
  it('accepts Gregorian dates from 1900 and blanks', () => {
    expect(MIN_GREGORIAN_YEAR).toBe(1900);
    expect(hijriLikeDateError('x', d('1900-01-01'))).toBeNull();
    expect(hijriLikeDateError('x', d('2026-05-10'))).toBeNull();
    expect(hijriLikeDateError('x', null)).toBeNull();
  });
});

describe('employeeDateIssues', () => {
  it('a birth date tomorrow is an error; today is not in the future', () => {
    expect(employeeDateIssues({ dateOfBirth: d('2026-09-26') }, NOW).errors).toEqual(['تاريخ الميلاد في المستقبل — تحقق من التاريخ']);
    expect(employeeDateIssues({ dateOfBirth: d('2026-09-25') }, NOW).errors).toEqual([]);
  });
  it('uses the Riyadh day: 22:30 UTC on the 25th is already the 26th in Riyadh', () => {
    const late = new Date('2026-09-25T22:30:00.000Z');
    expect(employeeDateIssues({ dateOfBirth: d('2026-09-26') }, late).errors).toEqual([]);
  });
  it('a contract end before the join date is an error (same day is allowed)', () => {
    expect(employeeDateIssues({ joinDate: d('2025-01-10'), contractEndDate: d('2025-01-09') }, NOW).errors).toEqual([
      'تاريخ انتهاء العقد يسبق تاريخ مباشرة العمل',
    ]);
    expect(employeeDateIssues({ joinDate: d('2025-01-10'), contractEndDate: d('2025-01-10') }, NOW).errors).toEqual([]);
  });
  it('a join date more than a year ahead is only a warning', () => {
    const far = employeeDateIssues({ joinDate: d('2300-01-01') }, NOW);
    expect(far.errors).toEqual([]);
    expect(far.warnings).toHaveLength(1);
    expect(far.warnings[0]).toContain('بعد أكثر من سنة');
    expect(employeeDateIssues({ joinDate: d('2027-09-25') }, NOW).warnings).toEqual([]);
    expect(employeeDateIssues({ joinDate: d('2027-09-26') }, NOW).warnings).toHaveLength(1);
  });
  it('an employee younger than 15 at the join date is a warning', () => {
    const young = employeeDateIssues({ dateOfBirth: d('2015-01-01'), joinDate: d('2026-01-01') }, NOW);
    expect(young.errors).toEqual([]);
    expect(young.warnings[0]).toContain('المادة 162');
    expect(employeeDateIssues({ dateOfBirth: d('1990-01-01'), joinDate: d('2026-01-01') }, NOW).warnings).toEqual([]);
  });
});

describe('orgPlacementErrors', () => {
  const branch = { id: 'b1', companyId: 'c1' };
  it('department of another branch', () => {
    expect(orgPlacementErrors({ branch, department: { id: 'd1', branchId: 'b2' } })).toEqual(['القسم المختار لا يتبع الفرع المختار']);
    expect(orgPlacementErrors({ branch, department: { id: 'd1', branchId: 'b1' } })).toEqual([]);
  });
  it('the branch is checked against the actual company when set, else the legal one', () => {
    expect(orgPlacementErrors({ legalCompanyId: 'c1', branch })).toEqual([]);
    expect(orgPlacementErrors({ legalCompanyId: 'c2', branch })[0]).toContain('الشركة القانونية');
    // Sponsored by c2, working in a c1 branch: valid when the actual company is c1.
    expect(orgPlacementErrors({ legalCompanyId: 'c2', actualCompanyId: 'c1', branch })).toEqual([]);
    expect(orgPlacementErrors({ legalCompanyId: 'c1', actualCompanyId: 'c3', branch })[0]).toContain('الشركة الفعلية');
  });
  it('nothing chosen -> nothing checked', () => {
    expect(orgPlacementErrors({})).toEqual([]);
    expect(orgPlacementErrors({ department: { id: 'd1', branchId: 'b9' } })).toEqual([]);
    expect(orgPlacementErrors({ branch })).toEqual([]);
  });
});

describe('employeeDataWarnings (WP-3 additions)', () => {
  it('non-Saudi without a contract end date -> art. 37 warning, only when the key is given', () => {
    const w = employeeDataWarnings({ nationality: 'مصري', contractEndDate: null });
    expect(w).toEqual([{ field: 'contractEndDate', message: NON_SAUDI_CONTRACT_END_WARNING }]);
    expect(NON_SAUDI_CONTRACT_END_WARNING).toContain('المادة 37');
    expect(employeeDataWarnings({ nationality: 'مصري' })).toEqual([]);
    expect(employeeDataWarnings({ nationality: 'مصري', contractEndDate: '2027-01-01' })).toEqual([]);
    expect(employeeDataWarnings({ nationality: 'سعودي', contractEndDate: '' })).toEqual([]);
    expect(employeeDataWarnings({ nationality: 'SAUDI', contractEndDate: null })).toEqual([]);
    expect(employeeDataWarnings({ contractEndDate: null })).toEqual([]);
  });
  it('an IBAN used by other employees -> warning listing them', () => {
    const w = employeeDataWarnings({ ibanNumber: VALID_IBAN, ibanSharedWith: ['EMP-0002', 'EMP-0003'] });
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('ibanNumber');
    expect(w[0].message).toContain('EMP-0002، EMP-0003');
    expect(employeeDataWarnings({ ibanNumber: VALID_IBAN, ibanSharedWith: [] })).toEqual([]);
    expect(employeeDataWarnings({ ibanNumber: '', ibanSharedWith: ['EMP-0002'] })).toEqual([]);
  });
  it('a malformed IBAN keeps a single IBAN warning', () => {
    const w = employeeDataWarnings({ ibanNumber: 'SA00123', ibanSharedWith: ['EMP-0002'] });
    expect(w.filter((x) => x.field === 'ibanNumber')).toHaveLength(1);
    expect(w[0].message).not.toContain('EMP-0002');
  });
  it('sharedIbanWarning lists 3 codes then the remaining count, without duplicates', () => {
    expect(sharedIbanWarning([])).toBeNull();
    expect(sharedIbanWarning(null)).toBeNull();
    const msg = sharedIbanWarning(['A', 'B', 'B', 'C', 'D', 'E']);
    expect(msg).toContain('A، B، C و2 آخرين');
  });
});

describe('contract type labels', () => {
  it('FREELANCE is "عمل حر/مستقل" and both old and new labels import as FREELANCE', () => {
    expect(CONTRACT_TYPE_LABELS.FREELANCE).toBe('عمل حر/مستقل');
    expect(parseContractTypeLabel(CONTRACT_TYPE_LABELS.FREELANCE)).toBe('FREELANCE');
    expect(parseContractTypeLabel('عمل عن بعد')).toBe('FREELANCE');
    expect(parseContractTypeLabel(CONTRACT_TYPE_LABELS.FULL_TIME)).toBe('FULL_TIME');
  });
});
