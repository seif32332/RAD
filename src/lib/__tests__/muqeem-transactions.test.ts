import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory Prisma double (only what transactions.ts / audit.ts use)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; idempotencyKey: string; status: string; createdAt: Date };

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  files: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  seq: 0,
  /** When set, the next create() throws P2002 after inserting this row (simulates a lost race). */
  raceRow: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/prisma', () => {
  const find = (where: { id?: string; idempotencyKey?: string }) =>
    db.rows.find((r) => (where.id !== undefined ? r.id === where.id : r.idempotencyKey === where.idempotencyKey)) ?? null;
  const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  return {
    prisma: {
      muqeemTransaction: {
        findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
          const r = find(where);
          return r ? { ...r } : null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (db.raceRow) {
            db.rows.push(db.raceRow);
            db.raceRow = null;
            throw p2002();
          }
          if (db.rows.some((r) => r.idempotencyKey === data.idempotencyKey)) throw p2002();
          const row = { id: `tx${++db.seq}`, createdAt: new Date(), ...data };
          db.rows.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = find(where);
          if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
          Object.assign(r, data);
          return { ...r };
        },
        updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
          const r = find({ id: where.id });
          if (!r || (where.status !== undefined && r.status !== where.status)) return { count: 0 };
          Object.assign(r, data);
          return { count: 1 };
        },
      },
      uploadedFile: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          db.files.push(data);
          return data;
        },
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          db.audits.push(data);
          return data;
        },
      },
    },
  };
});

const saveUpload = vi.hoisted(() => vi.fn(async () => ({ storedName: 'abc.pdf', url: '/api/files/abc.pdf' })));
vi.mock('@/lib/storage', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/storage')>()), saveUpload }));

const fakeClient = vi.hoisted(() => ({ mutationsSent: 0 }));
const createMuqeemClient = vi.hoisted(() => vi.fn(async () => fakeClient));
vi.mock('@/lib/muqeem/client', () => ({ createMuqeemClient }));

import type { AuthUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { MuqeemError } from '@/lib/muqeem/errors';
import type { MuqeemClient } from '@/lib/muqeem/client';
import { muqeemIdempotencyKey, reconcileTransaction, runMuqeemTransaction, STALE_PENDING_MS, summarizeForStorage, type RunMuqeemTransactionInput } from '@/lib/muqeem/transactions';

const user: AuthUser = { id: 'u1', email: 'gov@test', role: 'GOV_RELATIONS', name: 'Gov', avatarUrl: null, employeeId: null, sessionVersion: 0 };
const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1').toString('base64');

interface IssueResult {
  visaNumber: string;
  ervisaPDF?: string;
  token?: string;
}

function input(overrides: Partial<RunMuqeemTransactionInput<IssueResult>> = {}): RunMuqeemTransactionInput<IssueResult> {
  return {
    operation: 'EXIT_REENTRY_ISSUE',
    idempotencyKey: 'EXIT_REENTRY_ISSUE:visa:v1',
    companyId: 'c1',
    employeeId: 'e1',
    entity: { type: 'VISA', id: 'v1' },
    user,
    ipAddress: '10.0.0.1',
    requestSummary: { iqamaLast4: '0001', visaType: 1, visaDuration: 30 },
    execute: vi.fn(async () => ({ visaNumber: '7001234567', ervisaPDF: PDF_B64 })),
    extractRef: (r) => r.visaNumber,
    extractPdf: (r) => r.ervisaPDF ?? null,
    ...overrides,
  };
}

function seed(row: Partial<Row>): Row {
  const full = {
    id: `seed${++db.seq}`,
    idempotencyKey: 'EXIT_REENTRY_ISSUE:visa:v1',
    operation: 'EXIT_REENTRY_ISSUE',
    companyId: 'c1',
    status: 'PENDING',
    createdAt: new Date(),
    externalRef: null,
    errorMessage: null,
    responseSummary: null,
    ...row,
  } as Row;
  db.rows.push(full);
  return full;
}

beforeEach(() => {
  db.rows.length = 0;
  db.files.length = 0;
  db.audits.length = 0;
  db.raceRow = null;
  fakeClient.mutationsSent = 0;
  createMuqeemClient.mockClear();
  createMuqeemClient.mockImplementation(async () => fakeClient);
  saveUpload.mockClear();
});

describe('runMuqeemTransaction: success', () => {
  it('records PENDING then SUCCEEDED with the reference, the saved PDF and an audit entry', async () => {
    const i = input();
    const res = await runMuqeemTransaction(i);
    expect(res.alreadyDone).toBe(false);
    expect(res.result).toEqual({ visaNumber: '7001234567', ervisaPDF: PDF_B64 });
    expect(i.execute).toHaveBeenCalledWith(fakeClient as unknown as MuqeemClient);

    expect(db.rows).toHaveLength(1);
    const row = db.rows[0];
    expect(row).toMatchObject({
      status: 'SUCCEEDED',
      operation: 'EXIT_REENTRY_ISSUE',
      companyId: 'c1',
      employeeId: 'e1',
      entityType: 'VISA',
      entityId: 'v1',
      externalRef: '7001234567',
      httpStatus: 200,
      documentUrl: '/api/files/abc.pdf',
      requestedById: 'u1',
    });
    expect(row.completedAt).toBeInstanceOf(Date);
    // The base64 PDF is not copied into the summary.
    expect(String(row.responseSummary)).not.toContain(PDF_B64);
    expect(String(row.responseSummary)).toContain('7001234567');

    expect(saveUpload).toHaveBeenCalledTimes(1);
    expect(db.files[0]).toMatchObject({ storedName: 'abc.pdf', category: 'IDENTITY', employeeId: 'e1', uploadedById: 'u1', isPublic: false });

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: 'UPDATE', entityType: 'MuqeemTransaction', userId: 'u1' });
    expect(JSON.parse(String(db.audits[0].details))).toMatchObject({ muqeemOperation: 'EXIT_REENTRY_ISSUE', status: 'SUCCEEDED' });
  });

  it('never stores secrets from the request or the response', async () => {
    await runMuqeemTransaction(
      input({
        requestSummary: { iqamaLast4: '0001', password: 'hunter2', nested: { id_token: 'eyJabc.def.ghi', token: 'tok' } },
        execute: async () => ({ visaNumber: '1', token: 'secret-token-value' }),
        extractPdf: undefined,
      }),
    );
    const row = db.rows[0];
    expect(String(row.requestSummary)).not.toContain('hunter2');
    expect(String(row.requestSummary)).not.toContain('eyJabc');
    expect(String(row.responseSummary)).not.toContain('secret-token-value');
  });

  it('an invalid PDF does not turn an executed operation into a failure', async () => {
    const res = await runMuqeemTransaction(input({ execute: async () => ({ visaNumber: '9', ervisaPDF: Buffer.from('not a pdf').toString('base64') }) }));
    expect(res.transaction.status).toBe('SUCCEEDED');
    expect(res.transaction.documentUrl).toBeNull();
    expect(String(res.transaction.responseSummary)).toContain('pdfError');
  });
});

describe('runMuqeemTransaction: idempotency', () => {
  it('SUCCEEDED key -> alreadyDone without calling Muqeem', async () => {
    await runMuqeemTransaction(input());
    const again = input();
    const res = await runMuqeemTransaction(again);
    expect(res.alreadyDone).toBe(true);
    expect(res.result).toBeNull();
    expect(res.transaction.status).toBe('SUCCEEDED');
    expect(again.execute).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
  });

  it.each(['PENDING', 'UNKNOWN'])('%s key -> 409 asking for reconciliation, Muqeem not called', async (status) => {
    // (A PENDING row older than a minute: no longer "the same click in flight".)
    seed({ status, createdAt: new Date(Date.now() - 5 * 60_000) });
    const i = input();
    const err = await runMuqeemTransaction(i).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toContain('تقرير الخدمات التفاعلية');
    expect(i.execute).not.toHaveBeenCalled();
    expect(createMuqeemClient).not.toHaveBeenCalled();
  });

  it('fresh PENDING key (double click in flight) -> 409 "in progress now", inProgress: true, Muqeem not called', async () => {
    seed({ status: 'PENDING', createdAt: new Date(Date.now() - 5_000) });
    const i = input();
    const err = (await runMuqeemTransaction(i).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('الطلب نفسه قيد التنفيذ الآن على منصة مقيم؛ انتظر لحظات ثم حدّث الصفحة ولا تُعِد الإرسال');
    expect(err.details).toMatchObject({ inProgress: true, status: 'PENDING' });
    expect(i.execute).not.toHaveBeenCalled();
    // UNKNOWN rows never get the in-flight message, however young.
    db.rows.length = 0;
    seed({ status: 'UNKNOWN', createdAt: new Date() });
    const unknown = (await runMuqeemTransaction(input()).catch((e: unknown) => e)) as HttpError;
    expect(unknown.message).toContain('تقرير الخدمات التفاعلية');
    expect((unknown.details as Record<string, unknown>).inProgress).toBeUndefined();
  });

  it('FAILED key retried with other parameters (base-state key) -> the row stores the NEW request summary', async () => {
    seed({ status: 'FAILED', errorMessage: 'REJECTED: x', requestSummary: JSON.stringify({ iqamaDuration: '12' }) });
    const res = await runMuqeemTransaction(input({ requestSummary: { iqamaLast4: '0001', iqamaDuration: '6' } }));
    expect(res.alreadyDone).toBe(false);
    expect(JSON.parse(String(res.transaction.requestSummary))).toEqual({ iqamaLast4: '0001', iqamaDuration: '6' });
  });

  it('FAILED key -> the same row is reused and retried', async () => {
    const failed = seed({ status: 'FAILED', errorMessage: 'REJECTED: x' });
    const res = await runMuqeemTransaction(input());
    expect(res.alreadyDone).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(res.transaction.id).toBe(failed.id);
    expect(res.transaction.status).toBe('SUCCEEDED');
    expect(res.transaction.errorMessage).toBeNull();
  });

  it('a key reused for another operation or company -> 409', async () => {
    seed({ status: 'SUCCEEDED', operation: 'IQAMA_RENEW' });
    await expect(runMuqeemTransaction(input())).rejects.toMatchObject({ status: 409 });
    db.rows.length = 0;
    seed({ status: 'SUCCEEDED', companyId: 'other' });
    await expect(runMuqeemTransaction(input())).rejects.toMatchObject({ status: 409 });
  });

  it('lost insert race against an in-flight request -> 409, Muqeem not called', async () => {
    db.raceRow = { id: 'race', idempotencyKey: 'EXIT_REENTRY_ISSUE:visa:v1', operation: 'EXIT_REENTRY_ISSUE', companyId: 'c1', status: 'PENDING', createdAt: new Date() };
    const i = input();
    await expect(runMuqeemTransaction(i)).rejects.toMatchObject({ status: 409 });
    expect(i.execute).not.toHaveBeenCalled();
  });

  it('NOT_LINKED / NOT_CONFIGURED: nothing is recorded', async () => {
    createMuqeemClient.mockImplementationOnce(async () => {
      throw new MuqeemError('NOT_LINKED');
    });
    await expect(runMuqeemTransaction(input())).rejects.toMatchObject({ kind: 'NOT_LINKED' });
    expect(db.rows).toHaveLength(0);
  });

  it('builds stable keys', () => {
    expect(muqeemIdempotencyKey('IQAMA_RENEW', 'employee', 'e1', 2026)).toBe('IQAMA_RENEW:employee:e1:2026');
    expect(() => muqeemIdempotencyKey('IQAMA_RENEW', '')).toThrow(HttpError);
  });
});

describe('runMuqeemTransaction: failures', () => {
  it('REJECTED -> FAILED with Muqeem message, error rethrown, retry allowed afterwards', async () => {
    const rejected = new MuqeemError('REJECTED', { upstreamStatus: 422, upstreamMessage: 'الإقامة غير مؤهلة للخدمة' });
    await expect(runMuqeemTransaction(input({ execute: async () => Promise.reject(rejected) }))).rejects.toBe(rejected);
    expect(db.rows[0]).toMatchObject({ status: 'FAILED', httpStatus: 422 });
    expect(String(db.rows[0].errorMessage)).toContain('الإقامة غير مؤهلة للخدمة');
    expect(JSON.parse(String(db.audits[0].details))).toMatchObject({ muqeemOperation: 'EXIT_REENTRY_ISSUE', status: 'FAILED', errorKind: 'REJECTED' });

    const retry = await runMuqeemTransaction(input());
    expect(retry.transaction.status).toBe('SUCCEEDED');
  });

  it('UNKNOWN_OUTCOME -> UNKNOWN, and the next identical request is blocked', async () => {
    const unknown = new MuqeemError('UNKNOWN_OUTCOME', { detail: 'timeout' });
    await expect(runMuqeemTransaction(input({ execute: async () => Promise.reject(unknown) }))).rejects.toBe(unknown);
    expect(db.rows[0].status).toBe('UNKNOWN');
    const next = input();
    await expect(runMuqeemTransaction(next)).rejects.toMatchObject({ status: 409 });
    expect(next.execute).not.toHaveBeenCalled();
  });

  it('non-Muqeem error: FAILED when nothing was sent, UNKNOWN when a mutation left', async () => {
    await expect(runMuqeemTransaction(input({ execute: async () => Promise.reject(new Error('bug')) }))).rejects.toThrow('bug');
    expect(db.rows[0].status).toBe('FAILED');

    db.rows.length = 0;
    await expect(
      runMuqeemTransaction(
        input({
          execute: async () => {
            fakeClient.mutationsSent = 1;
            throw new Error('bug after the call');
          },
        }),
      ),
    ).rejects.toThrow('bug after the call');
    expect(db.rows[0].status).toBe('UNKNOWN');
  });
});

describe('reconcileTransaction', () => {
  it('UNKNOWN -> SUCCEEDED with the reference found on Muqeem (audited)', async () => {
    const row = seed({ status: 'UNKNOWN' });
    const res = await reconcileTransaction(row.id, { status: 'SUCCEEDED', externalRef: '7009999999', note: 'موجودة في تقرير الخدمات التفاعلية' }, user, '10.0.0.2');
    expect(res.status).toBe('SUCCEEDED');
    expect(res.externalRef).toBe('7009999999');
    expect(String(res.responseSummary)).toContain('reconciliation');
    const details = JSON.parse(String(db.audits[0].details));
    expect(details).toMatchObject({ muqeemOperation: 'EXIT_REENTRY_ISSUE', status: 'SUCCEEDED', reconciled: true, previousStatus: 'UNKNOWN' });
    // A replay is now answered from the row.
    const replay = await runMuqeemTransaction(input());
    expect(replay.alreadyDone).toBe(true);
  });

  it('SUCCEEDED clears the old UNKNOWN_OUTCOME message and keeps the operator details', async () => {
    const row = seed({ status: 'UNKNOWN', errorMessage: 'UNKNOWN_OUTCOME: timeout' });
    const res = await reconcileTransaction(row.id, { status: 'SUCCEEDED', note: 'في التقرير', details: { newIqamaExpiryDate: '2027-10-01' } }, user);
    expect(res.errorMessage).toBeNull();
    expect(JSON.parse(String(res.responseSummary)).reconciliation).toMatchObject({ note: 'في التقرير', details: { newIqamaExpiryDate: '2027-10-01' } });
  });

  it('UNKNOWN -> FAILED allows a new attempt', async () => {
    const row = seed({ status: 'UNKNOWN', errorMessage: 'UNKNOWN_OUTCOME: timeout' });
    await reconcileTransaction(row.id, { status: 'FAILED', note: 'غير موجودة في مقيم' }, user);
    expect(db.rows[0].status).toBe('FAILED');
    expect(db.rows[0].errorMessage).toBe('RECONCILED_FAILED: غير موجودة في مقيم');
    const retry = await runMuqeemTransaction(input());
    expect(retry.transaction.status).toBe('SUCCEEDED');
  });

  it('refuses settled rows, fresh PENDING rows and non-GOV roles; accepts stale PENDING rows', async () => {
    const done = seed({ status: 'SUCCEEDED', idempotencyKey: 'k1' });
    await expect(reconcileTransaction(done.id, { status: 'FAILED' }, user)).rejects.toMatchObject({ status: 409 });
    const fresh = seed({ status: 'PENDING', idempotencyKey: 'k2' });
    await expect(reconcileTransaction(fresh.id, { status: 'FAILED' }, user)).rejects.toMatchObject({ status: 409 });
    const unknown = seed({ status: 'UNKNOWN', idempotencyKey: 'k3' });
    await expect(reconcileTransaction(unknown.id, { status: 'FAILED' }, { ...user, role: 'EMPLOYEE' })).rejects.toMatchObject({ status: 403 });
    const stale = seed({ status: 'PENDING', idempotencyKey: 'k4', createdAt: new Date(Date.now() - STALE_PENDING_MS - 1000) });
    await expect(reconcileTransaction(stale.id, { status: 'FAILED' }, user)).resolves.toMatchObject({ status: 'FAILED' });
    await expect(reconcileTransaction('missing', { status: 'FAILED' }, user)).rejects.toMatchObject({ status: 404 });
  });
});

describe('summarizeForStorage: passport numbers are masked', () => {
  it('keeps only the last 4 of any passport number field, at any depth', () => {
    const json = summarizeForStorage({ passportNumber: 'M8727173', nested: { newPassportNumber: 'N70628289', passport_no: 'AB12' }, newPassportNumberLast4: '8289' });
    const v = JSON.parse(String(json));
    expect(v.passportNumber).toBe('…7173');
    expect(v.nested.newPassportNumber).toBe('…8289');
    expect(v.nested.passport_no).toBe('AB12');
    expect(v.newPassportNumberLast4).toBe('8289');
    expect(String(json)).not.toContain('M8727173');
  });
});
