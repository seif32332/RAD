// BR-LCY-012 person rules (lifecycle/policy.ts) against a fake transaction client: the eligible second
// person, ENFORCED vs the single-operator path, the requester's own file, the last eligible approver.
import { describe, expect, it } from 'vitest';
import { decideTwoPerson, eligibleSecondPersons, removesLastEligible, TwoPersonRequiredError } from '@/modules/lifecycle';

type U = { id: string; role: string };
type E = { id: string; userId: string | null; isTerminated: boolean; employmentState: 'ACTIVE' | 'NOTICE' | 'TERMINATED' | null };

function fakeTx(users: U[], employees: E[]) {
  return {
    user: { findMany: async ({ where }: { where: { role: { in: string[] } } }) => users.filter((u) => where.role.in.includes(u.role)) },
    employee: { findMany: async ({ where }: { where: { userId: { in: string[] } } }) => employees.filter((e) => e.userId && where.userId.in.includes(e.userId)) },
  } as never;
}

describe('eligible second person (DEC-PO-037)', () => {
  const users: U[] = [
    { id: 'hr1', role: 'HR_MANAGER' },
    { id: 'hr2', role: 'HR_MANAGER' },
    { id: 'legal', role: 'LEGAL_ADMIN' },
    { id: 'hrNotice', role: 'HR_MANAGER' },
    { id: 'fin', role: 'FINANCE_MANAGER' },
  ];
  const employees: E[] = [
    { id: 'e-hr1', userId: 'hr1', isTerminated: false, employmentState: 'ACTIVE' },
    { id: 'e-hr2', userId: 'hr2', isTerminated: false, employmentState: 'ACTIVE' },
    { id: 'e-notice', userId: 'hrNotice', isTerminated: false, employmentState: 'NOTICE' },
  ];
  it('TERMINATE_ROLES only, not the requester, not the subject, not an employee in NOTICE / TERMINATED', async () => {
    expect(await eligibleSecondPersons(fakeTx(users, employees), { userIds: ['hr1'] })).toEqual(['hr2', 'legal']);
    expect(await eligibleSecondPersons(fakeTx(users, employees), { userIds: ['hr1'], employeeId: 'e-hr2' })).toEqual(['legal']);
  });

  it('decideTwoPerson ENFORCED: an approver is needed, is not the requester, and must be eligible', async () => {
    const tx = fakeTx(users, employees);
    await expect(decideTwoPerson(tx, { requesterId: 'hr1', subjectEmployeeId: 'x' })).rejects.toBeInstanceOf(TwoPersonRequiredError);
    await expect(decideTwoPerson(tx, { requesterId: 'hr1', approvedById: 'hr1', subjectEmployeeId: 'x' })).rejects.toThrow(/شخص ثانٍ/);
    await expect(decideTwoPerson(tx, { requesterId: 'hr1', approvedById: 'fin', subjectEmployeeId: 'x' })).rejects.toThrow(/مؤهلاً/);
    await expect(decideTwoPerson(tx, { requesterId: 'hr1', approvedById: 'hrNotice', subjectEmployeeId: 'x' })).rejects.toThrow(/مؤهلاً/);
    expect(await decideTwoPerson(tx, { requesterId: 'hr1', approvedById: 'hr2', subjectEmployeeId: 'x' })).toEqual({ approvedById: 'hr2', singleOperator: false });
  });

  it('the requester never acts on his own file while a second person exists (EX-LCY-011)', async () => {
    await expect(decideTwoPerson(fakeTx(users, employees), { requesterId: 'hr1', approvedById: 'hr2', subjectEmployeeId: 'e-hr1' })).rejects.toThrow(/ملفك/);
  });

  it('no eligible second person: the act is done alone and marked single operator (DEC-PO-035)', async () => {
    const tx = fakeTx([{ id: 'hr1', role: 'HR_MANAGER' }], [{ id: 'e-hr1', userId: 'hr1', isTerminated: false, employmentState: 'ACTIVE' }]);
    expect(await decideTwoPerson(tx, { requesterId: 'hr1', subjectEmployeeId: 'e-hr1' })).toEqual({ approvedById: null, singleOperator: true });
  });

  it('a requester outside TERMINATE_ROLES is refused', async () => {
    await expect(decideTwoPerson(fakeTx(users, employees), { requesterId: 'fin', approvedById: 'hr2', subjectEmployeeId: 'x' })).rejects.toThrow(/الموارد البشرية/);
  });

  it('removesLastEligible: exiting an eligible account that leaves fewer than two (CG-LCY-003)', async () => {
    const two = fakeTx([{ id: 'hr1', role: 'HR_MANAGER' }, { id: 'hr2', role: 'HR_MANAGER' }], []);
    expect(await removesLastEligible(two, { employeeId: 'e', userId: 'hr2' })).toBe(true);
    expect(await removesLastEligible(fakeTx(users, employees), { employeeId: 'e-hr2', userId: 'hr2' })).toBe(false);
    expect(await removesLastEligible(two, { employeeId: 'e', userId: null })).toBe(false);
  });
});
