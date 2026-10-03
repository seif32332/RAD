// managerAt (the approval engine's ManagerChainPort, WFE-002): the manager of the assignment in force on a day,
// against a fake period reader (no database).
import { describe, expect, it } from 'vitest';
import { managerAt } from '@/modules/org';

type Row = Record<string, unknown>;
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function fakeDb(rows: Row[]) {
  const calls: { where: unknown }[] = [];
  const db = {
    assignmentPeriod: {
      findMany: async (args: { where: unknown }) => {
        calls.push(args);
        return rows;
      },
    },
  };
  return { db: db as never, calls };
}

function period(over: Row = {}): Row {
  return {
    id: 'p1',
    employeeId: 'e1',
    validFrom: at('2024-01-01'),
    validTo: null,
    lineageId: 'l1',
    supersedesId: null,
    supersededAt: null,
    supersedeReason: null,
    sourceType: 'TEST',
    sourceId: 't',
    recordedAt: new Date('2024-01-01T00:00:00Z'),
    createdById: null,
    legalCompanyId: 'c1',
    managerId: 'mgr-1',
    ...over,
  };
}

describe('managerAt', () => {
  it('is the managerId of the assignment in force', async () => {
    const { db } = fakeDb([period()]);
    expect(await managerAt(db, 'e1', '2026-10-01')).toBe('mgr-1');
  });

  it('accepts a Date at UTC midnight as well as a day string', async () => {
    const { db } = fakeDb([period()]);
    expect(await managerAt(db, 'e1', at('2026-10-01'))).toBe('mgr-1');
  });

  it('is null when no assignment is in force that day', async () => {
    const { db } = fakeDb([]);
    expect(await managerAt(db, 'e1', '2020-01-01')).toBeNull();
  });

  it('is null when the assignment has no manager (null or an empty id)', async () => {
    expect(await managerAt(fakeDb([period({ managerId: null })]).db, 'e1', '2026-10-01')).toBeNull();
    expect(await managerAt(fakeDb([period({ managerId: '' })]).db, 'e1', '2026-10-01')).toBeNull();
  });

  it('reads the assignment of that employee on that day, superseded rows excluded', async () => {
    const { db, calls } = fakeDb([period()]);
    await managerAt(db, 'employee-9', '2026-10-01');
    expect(calls).toHaveLength(1);
    const json = JSON.stringify(calls[0].where);
    expect(json).toContain('employee-9');
    expect(json).toContain('2026-10-01');
    expect(json).toContain('"supersededAt":null');
  });

  it('refuses a malformed day before reading', async () => {
    const { db, calls } = fakeDb([period()]);
    await expect(managerAt(db, 'e1', '01/10/2026')).rejects.toThrow(/YYYY-MM-DD/);
    expect(calls).toHaveLength(0);
  });
});
