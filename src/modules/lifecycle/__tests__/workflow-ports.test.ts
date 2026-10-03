// The lifecycle side of the approval engine's ports (WFE-002): BeneficiaryStatePort (registerLifecycleWorkflowPorts,
// employmentStateRows), against a fake client (no database).
import { afterEach, describe, expect, it } from 'vitest';
import { employmentStateRows, registerLifecycleWorkflowPorts } from '@/modules/lifecycle';
import { hasWorkflowPort, registerWorkflowPort } from '@/modules/workflow';
import { requirePort } from '@/modules/workflow/ports';
import { resetWorkflowRegistries } from '@/modules/workflow/testing';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type State = 'ACTIVE' | 'NOTICE' | 'TERMINATED' | null;
type Row = { id: string; userId: string | null; legalCompanyId: string | null; employmentState: State; isTerminated: boolean; terminationDate: Date | null };
const row = (over: Partial<Row> = {}): Row => ({ id: 'e1', userId: 'u1', legalCompanyId: 'c1', employmentState: 'ACTIVE', isTerminated: false, terminationDate: null, ...over });

function fakeTx(rows: Row[]) {
  const calls: { where: Record<string, { in: string[] }> }[] = [];
  const tx = {
    employee: {
      findMany: async (args: { where: Record<string, { in: string[] }> }) => {
        calls.push(args);
        const w = args.where;
        return rows.filter((r) => (w.id ? w.id.in.includes(r.id) : r.userId !== null && w.userId.in.includes(r.userId)));
      },
    },
  };
  return { tx: tx as never, calls };
}

afterEach(() => resetWorkflowRegistries());

describe('employmentStateRows (BR-LCY-010 / BR-LCY-013 readings)', () => {
  it('an ACTIVE employee has no last working day, even with a stale termination date', () => {
    const [r] = employmentStateRows([row({ terminationDate: d('2025-01-01') }) as never]);
    expect(r).toEqual({ employeeId: 'e1', userId: 'u1', companyId: 'c1', employmentState: 'ACTIVE', lastWorkingDay: null });
  });

  it('a NOTICE employee has his last working day; a TERMINATED one too', () => {
    const rows = employmentStateRows([
      row({ id: 'n', employmentState: 'NOTICE', terminationDate: d('2026-12-31') }) as never,
      row({ id: 't', employmentState: 'TERMINATED', isTerminated: true, terminationDate: d('2025-06-30') }) as never,
    ]);
    expect(rows.map((r) => [r.employeeId, r.employmentState, r.lastWorkingDay?.toISOString().slice(0, 10)])).toEqual([
      ['n', 'NOTICE', '2026-12-31'],
      ['t', 'TERMINATED', '2025-06-30'],
    ]);
  });

  it('an empty projection reads from isTerminated (BR-LCY-013): terminated without a date has no last working day', () => {
    const [a, b] = employmentStateRows([row({ id: 'a', employmentState: null }) as never, row({ id: 'b', employmentState: null, isTerminated: true }) as never]);
    expect(a.employmentState).toBe('ACTIVE');
    expect(b).toMatchObject({ employmentState: 'TERMINATED', lastWorkingDay: null });
  });

  it('keeps a missing login and a missing company as null', () => {
    const [r] = employmentStateRows([row({ userId: null, legalCompanyId: null }) as never]);
    expect(r).toMatchObject({ userId: null, companyId: null });
  });
});

describe('registerLifecycleWorkflowPorts (BeneficiaryStatePort)', () => {
  it('registers BeneficiaryState once and a second call is a no-op', () => {
    expect(hasWorkflowPort('BeneficiaryState')).toBe(false);
    registerLifecycleWorkflowPorts();
    expect(hasWorkflowPort('BeneficiaryState')).toBe(true);
    const first = requirePort('BeneficiaryState');
    expect(() => registerLifecycleWorkflowPorts()).not.toThrow();
    expect(requirePort('BeneficiaryState')).toBe(first);
  });

  it('never replaces a port that is already registered', () => {
    const own = { employees: async () => [], employeesOfUsers: async () => [] };
    registerWorkflowPort('BeneficiaryState', own);
    registerLifecycleWorkflowPorts();
    expect(requirePort('BeneficiaryState').employees).toBe(own.employees);
  });

  it('employees(): the state rows of the ids asked; unknown ids are absent', async () => {
    registerLifecycleWorkflowPorts();
    const { tx, calls } = fakeTx([row({ id: 'e1' }), row({ id: 'e2', userId: 'u2', employmentState: 'NOTICE', terminationDate: d('2026-11-30') })]);
    const out = await requirePort('BeneficiaryState').employees(tx, ['e2', 'e1', 'nope'], new Date());
    expect(out.map((r) => [r.employeeId, r.employmentState])).toEqual([
      ['e1', 'ACTIVE'],
      ['e2', 'NOTICE'],
    ]);
    expect(calls[0].where.id.in).toEqual(['e2', 'e1', 'nope']);
  });

  it('employeesOfUsers(): the employee linked to each login, with his state; a login without an employee is absent', async () => {
    registerLifecycleWorkflowPorts();
    const { tx } = fakeTx([row({ id: 'e1', userId: 'u1' }), row({ id: 'e9', userId: 'u9', employmentState: 'TERMINATED', isTerminated: true, terminationDate: d('2025-01-31') })]);
    const out = await requirePort('BeneficiaryState').employeesOfUsers(tx, ['u9', 'u1', 'no-employee'], new Date());
    expect(out.map((r) => [r.userId, r.employeeId, r.employmentState])).toEqual([
      ['u1', 'e1', 'ACTIVE'],
      ['u9', 'e9', 'TERMINATED'],
    ]);
  });

  it('no ids and no logins: an empty answer without a query', async () => {
    registerLifecycleWorkflowPorts();
    const { tx, calls } = fakeTx([row()]);
    expect(await requirePort('BeneficiaryState').employees(tx, [], new Date())).toEqual([]);
    expect(await requirePort('BeneficiaryState').employeesOfUsers(tx, [], new Date())).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
