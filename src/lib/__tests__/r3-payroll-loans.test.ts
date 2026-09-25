import { describe, expect, it } from 'vitest';
import { outstandingLoansForSettlement } from '@/lib/settlement';
import { loanNeedsTeamScope, loanRejectableStatuses, loanStageFromStatuses } from '@/lib/finance';
import { LOAN_STATUS } from '@/lib/constants';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('outstandingLoansForSettlement', () => {
  it('deducts the whole remaining balance when no draft holds an installment', () => {
    expect(outstandingLoansForSettlement([{ remainingAmount: 3000 }], d('2030-12-31'))).toBe(3000);
  });
  it('subtracts installments held by drafts of months BEFORE the last working month', () => {
    const loans = [{ remainingAmount: 3000, installments: [{ year: 2030, month: 11, amount: 1000 }] }];
    expect(outstandingLoansForSettlement(loans, d('2030-12-31'))).toBe(2000);
  });
  it('does not subtract installments of the last month or later (those drafts are dropped at approval)', () => {
    const loans = [
      {
        remainingAmount: 3000,
        installments: [
          { year: 2030, month: 12, amount: 1000 },
          { year: 2031, month: 1, amount: 1000 },
        ],
      },
    ];
    expect(outstandingLoansForSettlement(loans, d('2030-12-15'))).toBe(3000);
  });
  it('sums several loans and never goes negative per loan', () => {
    const loans = [
      { remainingAmount: 500, installments: [{ year: 2030, month: 10, amount: 800 }] },
      { remainingAmount: 1200.5, installments: [{ year: 2030, month: 11, amount: 200.25 }] },
    ];
    expect(outstandingLoansForSettlement(loans, d('2030-12-01'))).toBe(1000.25);
  });
  it('no loans -> 0', () => {
    expect(outstandingLoansForSettlement([], d('2030-12-01'))).toBe(0);
  });
});

describe('loan approval rules (src/lib/finance.ts)', () => {
  it('OWNER stage only applies before HR approval (a second owner approval is a 409)', () => {
    expect([...loanStageFromStatuses('OWNER')].sort()).toEqual([LOAN_STATUS.MANAGER_APPROVED, LOAN_STATUS.PENDING].sort());
    expect(loanStageFromStatuses('OWNER')).not.toContain(LOAN_STATUS.HR_APPROVED);
  });
  it('MANAGER / HR / FINANCE stages', () => {
    expect(loanStageFromStatuses('MANAGER')).toEqual([LOAN_STATUS.PENDING]);
    expect([...loanStageFromStatuses('HR')].sort()).toEqual([LOAN_STATUS.MANAGER_APPROVED, LOAN_STATUS.PENDING].sort());
    expect(loanStageFromStatuses('FINANCE')).toEqual([LOAN_STATUS.FINANCE_TRANSFERRED]);
  });
  it('branch / department managers need the team scope; HR, payroll and owner do not', () => {
    expect(loanNeedsTeamScope('BRANCH_MANAGER')).toBe(true);
    expect(loanNeedsTeamScope('DEPT_MANAGER')).toBe(true);
    for (const role of ['HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN', 'SUPER_ADMIN', 'COMPANY_ADMIN']) {
      expect(loanNeedsTeamScope(role)).toBe(false);
    }
  });
  it('team managers may reject only before HR approval; payroll may reject any pending stage', () => {
    expect(loanRejectableStatuses('BRANCH_MANAGER')).not.toContain(LOAN_STATUS.HR_APPROVED);
    expect(loanRejectableStatuses('BRANCH_MANAGER')).toContain(LOAN_STATUS.PENDING);
    expect(loanRejectableStatuses('HR_MANAGER')).toContain(LOAN_STATUS.HR_APPROVED);
    expect(loanRejectableStatuses('HR_MANAGER')).not.toContain(LOAN_STATUS.FINANCE_TRANSFERRED);
  });
});
