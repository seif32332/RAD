// Pure rules of payroll's state machines (no database): the loan approval stages. Shared by the loan
// transitions and the screens / legacy wrappers that show which stage applies (src/lib/finance.ts).
import { LOAN_STATUS } from '@/lib/constants';

export type LoanStage = 'MANAGER' | 'HR' | 'FINANCE' | 'OWNER';

/** From which statuses each stage applies, and what it writes (the stage's person included). */
export function loanStageRule(stage: LoanStage, actorId: string, now: Date) {
  switch (stage) {
    case 'MANAGER':
      return { from: [LOAN_STATUS.PENDING], data: { status: LOAN_STATUS.MANAGER_APPROVED, isManagerApproved: true, managerApprovedAt: now, managerApprovedById: actorId } };
    case 'HR':
      return { from: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED], data: { status: LOAN_STATUS.HR_APPROVED, isHrApproved: true, hrApprovedAt: now, hrApprovedById: actorId } };
    case 'FINANCE':
      return { from: [LOAN_STATUS.FINANCE_TRANSFERRED], data: { status: LOAN_STATUS.FINANCE_APPROVED, isFinanceApproved: true, financeApprovedAt: now, financeReviewedById: actorId } };
    case 'OWNER':
      // Not HR_APPROVED: the loan already went to finance (a second owner approval is a 409).
      return {
        from: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED],
        data: { status: LOAN_STATUS.HR_APPROVED, isManagerApproved: true, managerApprovedAt: now, isHrApproved: true, hrApprovedAt: now, ownerApprovedById: actorId },
      };
  }
}


/** PayrollMonth.status (CHECK PayrollMonth_status_check; LINES_APPROVED / EXPORTED / PAYMENT_EXCEPTION come with BL-PAY-008b / 020). */
export const PAYROLL_MONTH_STATUS = {
  DRAFT: 'DRAFT',
  CALCULATED: 'CALCULATED',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
} as const;
