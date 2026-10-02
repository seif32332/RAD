// Employee transfer decision (TRF, SPEC §15 item 38): rows and change order, the checks (department
// of the branch, manager in service and not himself, another city through an addendum unless the
// company allows it), company options and the default policy. Pure: no database.
import { describe, expect, it } from 'vitest';
import {
  buildContractData, ContractValidationError, paramsSchema, PROMOTION_DECISION, TRANSFER_DECISION, transferParamsSchema,
  type CompanyRecord, type EmployeeRecord, type TransferFacts,
} from '@/lib/documents/types';
import { effectiveOptions, effectivePolicy } from '@/lib/documents/policy';

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: null, jobTitle: 'مهندس مدني', jobTitleEnglish: 'Civil Engineer',
  joinDate: new Date('2019-03-09T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1', allowances: [],
};
const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي', nameEnglish: 'ACME Co.', commercialRegNum: '1010123456', unifiedNumber: null };
const facts = (over: Partial<TransferFacts> = {}): TransferFacts => ({
  branch: { id: 'b1', nameAr: 'فرع العليا', city: 'الرياض' },
  department: { id: 'd1', nameAr: 'المشاريع' },
  manager: { id: 'm1', nameAr: 'خالد السالم' },
  newBranch: { id: 'b2', nameAr: 'فرع الملز', city: 'الرياض' },
  newDepartment: { id: 'd2', nameAr: 'الصيانة', branchId: 'b2' },
  newManager: { id: 'm2', nameAr: 'سعد الحربي', inService: true },
  allowCityChange: false,
  ...over,
});
type Data = { transfer: { rows: Array<{ key: string; fromAr: string; toAr: string }>; apply: Record<string, string | null>; effectiveDate: string } };
const build = (transfer: Record<string, unknown>, f = facts()) =>
  buildContractData(TRANSFER_DECISION, { employee, company, params: paramsSchema.parse({ language: 'ar', transfer }), transfer: f }) as Data;
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContractValidationError) return e.errors.map((x) => x.code);
    throw e;
  }
  return [];
};
const all = { effectiveDate: '2026-10-01', newBranchId: 'b2', newDepartmentId: 'd2', newDirectManagerId: 'm2', reasonAr: 'لحاجة العمل' };

describe('employee transfer decision (TRF)', () => {
  it('lists branch, department and manager from the file to the new ones; the change order sets exactly those', () => {
    const d = build(all);
    expect(d.transfer.rows.map((r) => [r.key, r.fromAr, r.toAr])).toEqual([
      ['BRANCH', 'فرع العليا', 'فرع الملز'], ['DEPARTMENT', 'المشاريع', 'الصيانة'], ['MANAGER', 'خالد السالم', 'سعد الحربي'],
    ]);
    expect(TRANSFER_DECISION.changeOrderOf!(d)).toEqual({ effectiveDate: '2026-10-01', branchId: 'b2', departmentId: 'd2', directManagerId: 'm2' });
  });

  it('a department of the current branch when the branch does not change', () => {
    const d = build({ effectiveDate: '2026-10-01', newDepartmentId: 'd3' }, facts({ newDepartment: { id: 'd3', nameAr: 'المالية', branchId: 'b1' } }));
    expect(d.transfer.apply).toEqual({ branchId: null, departmentId: 'd3', directManagerId: null });
  });

  it('refuses: department of another branch, himself or an ended manager as manager, nothing different, nothing given', () => {
    expect(codes(() => build({ effectiveDate: '2026-10-01', newDepartmentId: 'd2' }))).toContain('DEPARTMENT_BRANCH'); // d2 is in b2, he stays in b1
    expect(codes(() => build({ effectiveDate: '2026-10-01', newDirectManagerId: 'e1' }, facts({ newManager: { id: 'e1', nameAr: 'محمد', inService: true } })))).toContain('SELF_MANAGER');
    expect(codes(() => build({ effectiveDate: '2026-10-01', newDirectManagerId: 'm2' }, facts({ newManager: { id: 'm2', nameAr: 'سعد', inService: false } })))).toContain('MANAGER_NOT_IN_SERVICE');
    expect(codes(() => build({ effectiveDate: '2026-10-01', newBranchId: 'b1' }, facts({ newBranch: { id: 'b1', nameAr: 'فرع العليا', city: 'الرياض' } })))).toEqual(['NO_CHANGE']);
    expect(transferParamsSchema.safeParse({ effectiveDate: '2026-10-01' }).success).toBe(false);
  });

  it('another city: through a contract addendum by default; allowed when the company says so', () => {
    const jeddah = facts({ newBranch: { id: 'b3', nameAr: 'فرع جدة', city: 'جدة' } });
    expect(codes(() => build({ effectiveDate: '2026-10-01', newBranchId: 'b3' }, jeddah))).toEqual(['CITY_CHANGE']);
    expect(build({ effectiveDate: '2026-10-01', newBranchId: 'b3' }, { ...jeddah, allowCityChange: true }).transfer.apply.branchId).toBe('b3');
    // Unknown city on either side: not treated as a change of city.
    expect(build({ effectiveDate: '2026-10-01', newBranchId: 'b3' }, facts({ newBranch: { id: 'b3', nameAr: 'فرع جديد', city: null } })).transfer.apply.branchId).toBe('b3');
  });

  it('company options: default when unset, the stored value otherwise, unknown keys and broken JSON ignored', () => {
    expect(effectiveOptions(TRANSFER_DECISION, null)).toEqual({ allowCityChange: false });
    expect(effectiveOptions(TRANSFER_DECISION, '{"allowCityChange":true,"other":true}')).toEqual({ allowCityChange: true });
    expect(effectiveOptions(TRANSFER_DECISION, 'not json')).toEqual({ allowCityChange: false });
    expect(effectivePolicy(TRANSFER_DECISION, null)).toMatchObject({ requiresApproval: true, selfService: false, options: { allowCityChange: false } });
    expect(TRANSFER_DECISION.approvalLocked).toBeFalsy(); // the company may change the approval
  });

  it('the promotion decision orders its change through the same hook', () => {
    const d = buildContractData(PROMOTION_DECISION, { employee, company, params: paramsSchema.parse({ language: 'ar', promotion: { newBasicSalary: 11000, effectiveDate: '2026-10-01' } }) });
    expect(PROMOTION_DECISION.changeOrderOf!(d)).toEqual({ effectiveDate: '2026-10-01', basicSalary: 11000, jobTitle: null, jobTitleEnglish: null });
  });
});
