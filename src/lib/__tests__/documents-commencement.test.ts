// Work commencement (CMN automatic notice, CML signed letter; SPEC §15 item 36): joining and
// return from leave, the delay against the scheduled return, health leaves not named, and the
// policy of each type. Pure: no database, no render service.
import { describe, expect, it } from 'vitest';
import {
  buildContractData, ContractValidationError, paramsSchema, WORK_COMMENCEMENT, WORK_COMMENCEMENT_LETTER,
  type CommencementFacts, type CompanyRecord, type EmployeeRecord,
} from '@/lib/documents/types';
import { effectivePolicy } from '@/lib/documents/policy';
import { arabicDays } from '@/lib/documents/render-model';

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: null, jobTitle: 'مهندس مدني', jobTitleEnglish: 'Civil Engineer',
  joinDate: new Date('2026-09-13T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1', allowances: [],
};
const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي', nameEnglish: 'ACME Co.', commercialRegNum: '1010123456', unifiedNumber: null };
// Riyadh dates: leave 1-10 September, scheduled return 11 September.
const leave = (over: Partial<NonNullable<CommencementFacts['leave']>> = {}): CommencementFacts => ({
  leave: {
    id: 'l1', employeeId: 'e1', leaveType: 'ANNUAL', startDate: new Date('2026-08-31T21:00:00Z'), endDate: new Date('2026-09-09T21:00:00Z'),
    isReturned: true, actualReturnDate: new Date('2026-09-10T21:00:00Z'), ...over,
  },
});

type Data = { commencement: { kind: string; requested: boolean; date: string; leave: { typeAr: string | null; scheduledReturn: string; lateDays: number } | null } };
const build = (def = WORK_COMMENCEMENT, commencement: Record<string, unknown> = { kind: 'JOIN' }, facts?: CommencementFacts) =>
  buildContractData(def, { employee, company, params: paramsSchema.parse({ language: 'ar', commencement }), commencement: facts }) as Data;
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContractValidationError) return e.errors.map((x) => x.code);
    throw e;
  }
  return [];
};

describe('work commencement (CMN / CML)', () => {
  it('joining: the join date of the file (Riyadh day)', () => {
    expect(build().commencement).toEqual({ kind: 'JOIN', requested: false, date: '2026-09-14', leave: null });
    expect(build(WORK_COMMENCEMENT_LETTER).commencement.requested).toBe(true);
  });

  it('return on time: the actual return, the leave named, no delay', () => {
    const c = build(WORK_COMMENCEMENT, { kind: 'RETURN', leaveId: 'l1' }, leave()).commencement;
    expect(c).toMatchObject({ kind: 'RETURN', date: '2026-09-11', leave: { typeAr: 'إجازة سنوية', scheduledReturn: '2026-09-11', lateDays: 0 } });
  });

  it('late return: the delay in days against the scheduled return; early return is not negative', () => {
    expect(build(WORK_COMMENCEMENT, { kind: 'RETURN' }, leave({ actualReturnDate: new Date('2026-09-13T21:00:00Z') })).commencement.leave?.lateDays).toBe(3);
    expect(build(WORK_COMMENCEMENT, { kind: 'RETURN' }, leave({ actualReturnDate: new Date('2026-09-07T21:00:00Z') })).commencement.leave?.lateDays).toBe(0);
  });

  it('the delay reads with the counted noun in agreement', () => {
    expect([1, 2, 3, 10, 11, 25, 103, 111].map((d) => arabicDays(d, 'latn'))).toEqual([
      { number: null, unit: 'يوما واحدا' }, { number: null, unit: 'يومين' }, { number: '3', unit: 'أيام' }, { number: '10', unit: 'أيام' },
      { number: '11', unit: 'يوما' }, { number: '25', unit: 'يوما' }, { number: '103', unit: 'أيام' }, { number: '111', unit: 'يوما' },
    ]);
  });

  it('health leaves (sick, maternity) are not named', () => {
    expect(build(WORK_COMMENCEMENT, { kind: 'RETURN' }, leave({ leaveType: 'SICK' })).commencement.leave?.typeAr).toBeNull();
  });

  it('refuses a return that is not confirmed, missing, or someone else\'s', () => {
    expect(codes(() => build(WORK_COMMENCEMENT, { kind: 'RETURN' }, leave({ isReturned: false })))).toContain('RETURN_NOT_CONFIRMED');
    expect(codes(() => build(WORK_COMMENCEMENT, { kind: 'RETURN' }, { leave: null }))).toContain('LEAVE_NOT_FOUND');
    expect(codes(() => build(WORK_COMMENCEMENT, { kind: 'RETURN' }, leave({ employeeId: 'other' })))).toContain('LEAVE_NOT_FOUND');
  });

  it('policy: the notice is automatic (no approval, never from the portal); the letter is requested and approved', () => {
    expect(WORK_COMMENCEMENT.issuance).toBe('AUTO');
    expect(effectivePolicy(WORK_COMMENCEMENT, null)).toMatchObject({ selfService: false, requiresApproval: false });
    expect(WORK_COMMENCEMENT_LETTER.issuance).toBeUndefined();
    expect(effectivePolicy(WORK_COMMENCEMENT_LETTER, null)).toMatchObject({ selfService: true, requiresApproval: true });
    expect(WORK_COMMENCEMENT.code).not.toBe(WORK_COMMENCEMENT_LETTER.code);
  });
});
