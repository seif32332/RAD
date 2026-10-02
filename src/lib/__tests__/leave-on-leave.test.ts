// P0-06 = BL-LCY-002 Release A: "on leave" is computed from approved Leave rows (BR-LCY-008,
// DEC-PO-030) and Employee.employmentStatus 'ON_LEAVE' is neither written nor read any more.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOnLeaveFromRows, leaveCoversDay, onLeaveWhere, type LeaveCoverageRow } from '@/lib/leave';
import { isOnLeave, onLeaveEmployeeIds } from '@/lib/leave-server';
import { markSettlementPaid } from '@/lib/finance';
import type { AuthUser } from '@/lib/auth';

const d = (k: string) => new Date(`${k}T00:00:00.000Z`);

// ---------------------------------------------------------------------------
// A tiny evaluator of the Prisma filter subset onLeaveWhere uses (in, lt, gte, null, OR), so the
// query form can be checked against real rows without a database.
// ---------------------------------------------------------------------------
type Row = LeaveCoverageRow & { id: string; employeeId: string };

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
  const c = cond as Record<string, unknown>;
  const v = value instanceof Date ? value.getTime() : typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : value;
  const t = (x: unknown) => (x instanceof Date ? x.getTime() : x);
  if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
  if ('lt' in c && !(v !== null && v !== undefined && (v as number) < (t(c.lt) as number))) return false;
  if ('gte' in c && !(v !== null && v !== undefined && (v as number) >= (t(c.gte) as number))) return false;
  return true;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    return matchField(row[k], cond);
  });
}

/** Read-only fake db over Leave rows; any write call is recorded so a test can assert there was none. */
function fakeDb(rows: Row[]) {
  const writes: string[] = [];
  const leave = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r as never, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r as never, where));
      const seen = new Set<string>();
      return hit.filter((r) => (seen.has(r.employeeId) ? false : (seen.add(r.employeeId), true)));
    },
    update: async () => writes.push('leave.update'),
    updateMany: async () => writes.push('leave.updateMany'),
  };
  const employee = {
    update: async () => writes.push('employee.update'),
    updateMany: async () => writes.push('employee.updateMany'),
  };
  return { db: { leave, employee } as never, writes };
}

const row = (p: Partial<Row> & { startDate: string; endDate: string }): Row => ({
  id: Math.random().toString(36).slice(2),
  employeeId: 'e1',
  status: 'APPROVED',
  actualReturnDate: null,
  ...p,
});

// ---------------------------------------------------------------------------

describe('leaveCoversDay (BR-LCY-008)', () => {
  const l = row({ startDate: '2026-10-05', endDate: '2026-10-10' });

  it('is true on every day of an approved leave, both ends included, and false outside', () => {
    expect(leaveCoversDay(l, '2026-10-04')).toBe(false);
    expect(leaveCoversDay(l, '2026-10-05')).toBe(true);
    expect(leaveCoversDay(l, '2026-10-07')).toBe(true);
    expect(leaveCoversDay(l, '2026-10-10')).toBe(true);
    expect(leaveCoversDay(l, '2026-10-11')).toBe(false);
    expect(leaveCoversDay(l, d('2026-10-07'))).toBe(true);
  });

  it('never counts pending, rejected or cancelled leaves', () => {
    for (const status of ['PENDING', 'REJECTED', 'CANCELLED']) {
      expect(leaveCoversDay({ ...l, status }, '2026-10-07')).toBe(false);
    }
  });

  it('a recorded return ends the leave the day before, even before HR confirms it', () => {
    const returned = { ...l, actualReturnDate: '2026-10-08' };
    expect(leaveCoversDay(returned, '2026-10-07')).toBe(true);
    expect(leaveCoversDay(returned, '2026-10-08')).toBe(false);
    expect(leaveCoversDay(returned, '2026-10-09')).toBe(false);
  });

  it('a COMPLETED (confirmed return) leave still covers its shortened range', () => {
    const completed = { ...l, status: 'COMPLETED', endDate: '2026-10-07', actualReturnDate: '2026-10-08' };
    expect(leaveCoversDay(completed, '2026-10-06')).toBe(true);
    expect(leaveCoversDay(completed, '2026-10-08')).toBe(false);
  });

  it('isOnLeaveFromRows checks any row and handles a missing list', () => {
    expect(isOnLeaveFromRows(undefined, '2026-10-07')).toBe(false);
    expect(isOnLeaveFromRows([{ ...l, status: 'REJECTED' }, l], '2026-10-07')).toBe(true);
  });
});

describe('onLeaveWhere and leaveCoversDay are the same rule', () => {
  const rows: Row[] = [
    row({ startDate: '2026-10-05', endDate: '2026-10-10' }),
    row({ startDate: '2026-10-05', endDate: '2026-10-10', actualReturnDate: '2026-10-07' }),
    row({ startDate: '2026-10-05', endDate: '2026-10-06', status: 'COMPLETED', actualReturnDate: '2026-10-07' }),
    row({ startDate: '2026-10-05', endDate: '2026-10-10', status: 'PENDING' }),
    row({ startDate: '2026-10-05', endDate: '2026-10-10', status: 'CANCELLED' }),
    row({ startDate: '2026-10-08', endDate: '2026-10-08' }),
  ].map((r) => ({ ...r, startDate: d(r.startDate as string), endDate: d(r.endDate as string), actualReturnDate: r.actualReturnDate ? d(r.actualReturnDate as string) : null }));

  it('agrees on every row for every day around the ranges', () => {
    for (let day = 1; day <= 14; day++) {
      const key = `2026-10-${String(day).padStart(2, '0')}`;
      for (const r of rows) {
        expect(matches(r as never, onLeaveWhere(key)), `${key} ${JSON.stringify(r)}`).toBe(leaveCoversDay(r, key));
      }
    }
  });

  it('still counts a date stored with a time of day for its calendar day', () => {
    const r = { ...rows[0], endDate: new Date('2026-10-10T15:00:00.000Z') };
    expect(matches(r as never, onLeaveWhere('2026-10-10'))).toBe(true);
    expect(leaveCoversDay(r, '2026-10-10')).toBe(true);
  });
});

describe('isOnLeave / onLeaveEmployeeIds read Leave rows only', () => {
  const rows = [
    row({ employeeId: 'e1', startDate: '2026-10-05', endDate: '2026-10-10' }),
    row({ employeeId: 'e2', startDate: '2026-10-05', endDate: '2026-10-10', status: 'PENDING' }),
    row({ employeeId: 'e3', startDate: '2026-10-01', endDate: '2026-10-20', actualReturnDate: '2026-10-06' }),
  ].map((r) => ({ ...r, startDate: d(r.startDate as string), endDate: d(r.endDate as string), actualReturnDate: r.actualReturnDate ? d(r.actualReturnDate as string) : null }));

  it('is true only inside the approved date range', async () => {
    const { db } = fakeDb(rows);
    expect(await isOnLeave(db, 'e1', '2026-10-04')).toBe(false);
    expect(await isOnLeave(db, 'e1', '2026-10-05')).toBe(true);
    expect(await isOnLeave(db, 'e1', d('2026-10-10'))).toBe(true);
    expect(await isOnLeave(db, 'e1', '2026-10-11')).toBe(false);
    expect(await isOnLeave(db, 'e2', '2026-10-07')).toBe(false); // pending
    expect(await isOnLeave(db, 'e3', '2026-10-05')).toBe(true);
    expect(await isOnLeave(db, 'e3', '2026-10-06')).toBe(false); // returned early
    expect(await isOnLeave(db, 'nobody', '2026-10-07')).toBe(false);
  });

  it('batch form returns the same answer as the single form', async () => {
    const { db } = fakeDb(rows);
    const ids = ['e1', 'e2', 'e3', 'nobody'];
    for (const key of ['2026-10-04', '2026-10-05', '2026-10-07', '2026-10-11']) {
      const batch = await onLeaveEmployeeIds(db, ids, key);
      for (const id of ids) expect(batch.has(id), `${id} ${key}`).toBe(await isOnLeave(db, id, key));
    }
    expect((await onLeaveEmployeeIds(db, [], '2026-10-07')).size).toBe(0);
  });

  it('reading twice gives the same answer and writes nothing', async () => {
    const { db, writes } = fakeDb(rows);
    const a = await isOnLeave(db, 'e1', '2026-10-07');
    const b = await isOnLeave(db, 'e1', '2026-10-07');
    expect(a).toBe(true);
    expect(b).toBe(a);
    await onLeaveEmployeeIds(db, ['e1', 'e3'], '2026-10-07');
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The writer is gone: paying a leave settlement no longer writes ON_LEAVE (EV-3017).
// ---------------------------------------------------------------------------

function fakeSettlementTx() {
  let status = 'OWNER_APPROVED';
  const calls: string[] = [];
  const settlementRow = () => ({ id: 's1', employeeId: 'e1', type: 'LEAVE_SETTLEMENT', status, approvedById: null, createdById: null, employee: { legalCompanyId: null } });
  const tx = {
    // P1-PAY-A: markSettlementPaid runs behind money.gateway (operator mode read in the transaction).
    systemSetting: { findUnique: async () => null },
    settlement: {
      updateMany: async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        calls.push('settlement.updateMany');
        if (where.status !== status) return { count: 0 };
        status = data.status;
        return { count: 1 };
      },
      findUnique: async () => settlementRow(),
      findUniqueOrThrow: async () => settlementRow(),
    },
    paymentRequest: {
      findMany: async () => [],
      updateMany: async () => (calls.push('paymentRequest.updateMany'), { count: 0 }),
    },
    auditLog: { create: async () => (calls.push('auditLog.create'), {}) },
    employee: {
      update: async (args: unknown) => (calls.push(`employee.update ${JSON.stringify(args)}`), {}),
      updateMany: async (args: unknown) => (calls.push(`employee.updateMany ${JSON.stringify(args)}`), { count: 1 }),
    },
  };
  return { tx: tx as never, calls, status: () => status };
}

const finance: AuthUser = { id: 'u-fin', role: 'FINANCE_MANAGER' } as AuthUser;
const proof = { paymentMethod: 'BANK_TRANSFER', paymentReference: 'TRX-1', paidAt: '2026-10-01' } as never;

describe('markSettlementPaid no longer stores ON_LEAVE', () => {
  it('paying a LEAVE_SETTLEMENT does not touch the employee', async () => {
    const { tx, calls, status } = fakeSettlementTx();
    await markSettlementPaid(tx, 's1', null, finance, {}, proof);
    expect(status()).toBe('PAID');
    expect(calls.filter((c) => c.startsWith('employee.'))).toEqual([]);
    expect(calls.join('\n')).not.toContain('ON_LEAVE');
  });

  it('a second call is refused and still writes nothing on the employee (double call)', async () => {
    const { tx, calls } = fakeSettlementTx();
    await markSettlementPaid(tx, 's1', null, finance, {}, proof);
    await expect(markSettlementPaid(tx, 's1', null, finance, {}, proof)).rejects.toMatchObject({ status: 409 });
    expect(calls.filter((c) => c.startsWith('employee.'))).toEqual([]);
    expect(calls.filter((c) => c === 'auditLog.create')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ratchet: no code writes or reads the stored ON_LEAVE / SUSPENDED employment status any more,
// including leave approval (hr-workflows) and the leave action route.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('ON_LEAVE is not stored nor read as an employment status', () => {
  const files = sourceFiles(SRC);
  const offenders = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length));

  it('no source file writes employmentStatus ON_LEAVE', () => {
    expect(offenders(/employmentStatus\s*:\s*['"]ON_LEAVE['"]/)).toEqual([]);
  });

  it('no source file compares employmentStatus with ON_LEAVE or SUSPENDED (DEC-PO-032)', () => {
    expect(offenders(/employmentStatus\s*(===|!==|==|!=)\s*['"](ON_LEAVE|SUSPENDED)['"]/)).toEqual([]);
    expect(offenders(/['"](ON_LEAVE|SUSPENDED)['"]\s*(===|!==|==|!=)\s*\w*\.?employmentStatus/)).toEqual([]);
  });

  it('leave approval never touches the employee row', () => {
    const hr = readFileSync(join(SRC, 'lib', 'hr-workflows.ts'), 'utf8');
    const start = hr.indexOf('export async function approveLeave');
    expect(start).toBeGreaterThan(-1);
    const next = hr.indexOf('\nexport ', start + 1);
    const body = hr.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(/employee\.(update|updateMany|upsert)\s*\(/);
    expect(body).not.toContain('employmentStatus');
  });
});

describe('9s_on_leave_reset data migration', () => {
  const sql = readFileSync(join(SRC, '..', 'prisma', 'migrations', '9s_on_leave_reset', 'migration.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('only resets rows still holding ON_LEAVE, to ACTIVE (idempotent: a re-run matches nothing)', () => {
    expect(code).toMatch(/UPDATE "Employee"\s+SET "employmentStatus" = 'ACTIVE'/);
    expect(code).toMatch(/WHERE "employmentStatus" = 'ON_LEAVE'/);
    expect(code).not.toMatch(/isTerminated|terminationDate/);
  });

  it('is data only (no DDL) and keeps the old value in AuditLog without duplicates', () => {
    expect(code).not.toMatch(/\b(ALTER|CREATE|DROP|TRUNCATE)\b/i);
    expect(code).toMatch(/INSERT INTO "AuditLog"/);
    expect(code).toMatch(/ON CONFLICT \("id"\) DO NOTHING/);
  });
});
