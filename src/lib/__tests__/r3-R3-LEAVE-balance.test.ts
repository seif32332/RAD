import { describe, expect, it } from 'vitest';
import { BALANCE_CONSUMING_STATUSES, computeLeaveBalance, type LeaveBalanceLeave } from '@/lib/leave';
import { LEAVE_STATUS } from '@/lib/constants';

const leave = (status: string, paidDays: number, extra: Partial<LeaveBalanceLeave> = {}): LeaveBalanceLeave => ({
  leaveType: 'ANNUAL',
  status,
  paidDays,
  startDate: '2025-03-01',
  endDate: '2025-03-10',
  createdAt: '2025-02-01',
  ...extra,
});

const base = { joinDate: '2024-01-01', asOf: '2025-12-31' } as const;

describe('R3-LEAVE: COMPLETED consumes the balance like APPROVED', () => {
  it('BALANCE_CONSUMING_STATUSES is exactly APPROVED + COMPLETED', () => {
    expect([...BALANCE_CONSUMING_STATUSES].sort()).toEqual([LEAVE_STATUS.APPROVED, LEAVE_STATUS.COMPLETED].sort());
  });

  it('a COMPLETED leave is taken exactly like the same APPROVED leave', () => {
    const approved = computeLeaveBalance({ ...base, leaves: [leave(LEAVE_STATUS.APPROVED, 7)] });
    const completed = computeLeaveBalance({ ...base, leaves: [leave(LEAVE_STATUS.COMPLETED, 7)] });
    expect(completed.taken).toBe(7);
    expect(completed).toEqual(approved);
  });

  it('APPROVED + COMPLETED add up; PENDING is informational; REJECTED/CANCELLED ignored', () => {
    const b = computeLeaveBalance({
      ...base,
      leaves: [
        leave(LEAVE_STATUS.APPROVED, 3),
        leave(LEAVE_STATUS.COMPLETED, 4, { startDate: '2025-05-01', endDate: '2025-05-04' }),
        leave(LEAVE_STATUS.PENDING, 2, { startDate: '2025-06-01', endDate: '2025-06-02' }),
        leave(LEAVE_STATUS.REJECTED, 5, { startDate: '2025-07-01', endDate: '2025-07-05' }),
        leave(LEAVE_STATUS.CANCELLED, 6, { startDate: '2025-08-01', endDate: '2025-08-06' }),
      ],
    });
    expect(b.taken).toBe(7);
    expect(b.pending).toBe(2);
    expect(b.available).toBe(Math.round((b.accrued - 7) * 100) / 100);
  });

  it('a COMPLETED legacy leave without paidDays falls back to totalDays - unpaidDays', () => {
    const b = computeLeaveBalance({ ...base, leaves: [leave(LEAVE_STATUS.COMPLETED, null as unknown as number, { paidDays: null, totalDays: 10, unpaidDays: 4 })] });
    expect(b.taken).toBe(6);
  });

  it('a COMPLETED leave recorded before a leave settlement (accrual reset) is not taken again', () => {
    const b = computeLeaveBalance({ ...base, leaveAccrualStartDate: '2025-04-01', leaves: [leave(LEAVE_STATUS.COMPLETED, 7)] });
    expect(b.taken).toBe(0);
  });

  it('a COMPLETED non-balance leave (SICK) does not consume the annual balance', () => {
    const b = computeLeaveBalance({ ...base, leaves: [leave(LEAVE_STATUS.COMPLETED, 7, { leaveType: 'SICK' })] });
    expect(b.taken).toBe(0);
  });
});
