// The people side of the approval engine's ports (WFE-002): employeesForLifecycle, employeesOfUsersForLifecycle and
// registerPeopleWorkflowPorts, against a fake client (no database).
import { afterEach, describe, expect, it } from 'vitest';
import { employeesForLifecycle, employeesOfUsersForLifecycle, registerPeopleWorkflowPorts } from '@/modules/people';
import { hasWorkflowPort, registerWorkflowPort } from '@/modules/workflow';
import { requirePort } from '@/modules/workflow/ports';
import { resetWorkflowRegistries } from '@/modules/workflow/testing';

type Args = { where: Record<string, unknown>; select: Record<string, boolean>; orderBy: unknown };

function fakeDb() {
  const calls: Args[] = [];
  const db = {
    employee: {
      findMany: async (args: Args) => {
        calls.push(args);
        return [{ id: 'e1' }];
      },
    },
  };
  return { db: db as never, calls };
}

afterEach(() => resetWorkflowRegistries());

describe('employeesForLifecycle', () => {
  it('reads the lifecycle columns of the distinct ids, ascending', async () => {
    const { db, calls } = fakeDb();
    expect(await employeesForLifecycle(db, ['b', 'a', 'b'])).toEqual([{ id: 'e1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ id: { in: ['b', 'a'] } });
    expect(calls[0].orderBy).toEqual({ id: 'asc' });
    expect(Object.keys(calls[0].select)).toEqual(expect.arrayContaining(['id', 'userId', 'legalCompanyId', 'isTerminated', 'terminationDate', 'employmentState']));
  });

  it('is empty, without a query, for no ids or only blank / non-string ids', async () => {
    const { db, calls } = fakeDb();
    expect(await employeesForLifecycle(db, [])).toEqual([]);
    expect(await employeesForLifecycle(db, ['', undefined as never, 5 as never])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('employeesOfUsersForLifecycle', () => {
  it('reads the employees linked to the distinct logins, ascending', async () => {
    const { db, calls } = fakeDb();
    expect(await employeesOfUsersForLifecycle(db, ['u2', 'u1', 'u2'])).toEqual([{ id: 'e1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ userId: { in: ['u2', 'u1'] } });
    expect(calls[0].orderBy).toEqual({ id: 'asc' });
    expect(calls[0].select.userId).toBe(true);
  });

  it('is empty, without a query, for no logins or only blank ones', async () => {
    const { db, calls } = fakeDb();
    expect(await employeesOfUsersForLifecycle(db, [])).toEqual([]);
    expect(await employeesOfUsersForLifecycle(db, [''])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('registerPeopleWorkflowPorts', () => {
  it('registers the EmployeeLock port once; a second call is a no-op (a port is never overridden)', () => {
    expect(hasWorkflowPort('EmployeeLock')).toBe(false);
    registerPeopleWorkflowPorts();
    expect(hasWorkflowPort('EmployeeLock')).toBe(true);
    const first = requirePort('EmployeeLock');
    expect(() => registerPeopleWorkflowPorts()).not.toThrow();
    expect(requirePort('EmployeeLock')).toBe(first);
  });

  it('leaves a port that is already registered (the lock-order spy of the IT tests) in place', () => {
    const spy = { lockEmployees: async () => [] };
    registerWorkflowPort('EmployeeLock', spy);
    registerPeopleWorkflowPorts();
    expect(requirePort('EmployeeLock').lockEmployees).toBe(spy.lockEmployees);
  });

  it('the registered port refuses a non-transaction client before any query (the lock needs a transaction)', async () => {
    registerPeopleWorkflowPorts();
    await expect(requirePort('EmployeeLock').lockEmployees({} as never, ['e1'], ['c1'])).rejects.toThrow();
  });
});
