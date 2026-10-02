// Unit tests of the platform primitives without a database (P1-FND-EVT, P1-FND-AUDIT).
// The database guarantees (commit together, once per key, once per consumer, immutability) are proven
// against a real PostgreSQL in platform.it.test.ts.
import { describe, expect, it, vi } from 'vitest';
import {
  ConsumerRegistry,
  NotInTransactionError,
  OperationKeyConflictError,
  audit,
  emitEvent,
  idempotent,
  redact,
  retryDelayMs,
  runConsumers,
  runTransition,
  validateEventInput,
  type EmitEventInput,
  type RootClient,
  type TxClient,
} from '@/modules/platform';

const rootLike = { $transaction: async () => undefined } as unknown as TxClient;

const baseEvent: EmitEventInput = {
  type: 'leave.request.approved',
  aggregateType: 'Leave',
  aggregateId: 'l1',
  idempotencyKey: 'op-1:leave.request.approved',
  payload: { leaveId: 'l1' },
};

describe('event type and input validation (LIFECYCLE_MODEL §2.4, ARCH-010)', () => {
  it('accepts <domain>.<entity>.<verb> and <domain>.<verb>', () => {
    expect(() => validateEventInput(baseEvent)).not.toThrow();
    expect(() => validateEventInput({ ...baseEvent, type: 'employment.hired' })).not.toThrow();
    expect(() => validateEventInput({ ...baseEvent, type: 'payroll.leaveCase.changed' })).not.toThrow();
  });

  it.each(['leave', 'Leave.request.approved', 'leave..approved', 'leave.request.approved.', 'leave request approved', ''])(
    'refuses the type %j',
    (type) => {
      expect(() => validateEventInput({ ...baseEvent, type })).toThrow(/Invalid event type/);
    },
  );

  it('requires an idempotency key, an aggregate and an object payload', () => {
    expect(() => validateEventInput({ ...baseEvent, idempotencyKey: '  ' })).toThrow(/idempotencyKey/);
    expect(() => validateEventInput({ ...baseEvent, aggregateId: '' })).toThrow(/aggregateId/);
    expect(() => validateEventInput({ ...baseEvent, payload: [] as unknown as Record<string, unknown> })).toThrow(/payload/);
  });
});

describe('writes only inside a transaction', () => {
  it('emitEvent, audit and idempotent refuse the root client', async () => {
    await expect(emitEvent(rootLike, baseEvent)).rejects.toBeInstanceOf(NotInTransactionError);
    await expect(audit(rootLike, { actor: { type: 'SYSTEM' }, action: 'X', entity: { type: 'E' } })).rejects.toBeInstanceOf(NotInTransactionError);
    await expect(idempotent(rootLike, { key: 'k', operation: 'o' }, async () => 1)).rejects.toBeInstanceOf(NotInTransactionError);
  });

  it('audit validates its actor', async () => {
    const tx = { auditRecord: { create: vi.fn() } } as unknown as TxClient;
    await expect(audit(tx, { actor: { type: 'USER', id: '' }, action: 'X', entity: { type: 'E' } })).rejects.toThrow(/USER actor/);
    await expect(audit(tx, { actor: { type: 'SYSTEM' }, action: '', entity: { type: 'E' } })).rejects.toThrow(/action/);
  });

  it('audit stores before/after as redacted JSON, and a failed insert fails the call', async () => {
    const create = vi.fn(async () => ({ id: 'a1' }));
    const tx = { auditRecord: { create } } as unknown as TxClient;
    await audit(tx, {
      actor: { type: 'USER', id: 'u1' },
      action: 'UPDATE',
      entity: { type: 'Employee', id: 'e1', companyId: 'c1' },
      before: { ibanNumber: 'SA00', at: new Date('2026-01-01T00:00:00Z') },
      after: null,
    });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.before).toEqual({ ibanNumber: '[REDACTED]', at: '2026-01-01T00:00:00.000Z' });
    expect(data.after).toBeUndefined();
    expect(data.companyId).toBe('c1');

    const failing = { auditRecord: { create: vi.fn(async () => { throw new Error('db down'); }) } } as unknown as TxClient;
    await expect(audit(failing, { actor: { type: 'SYSTEM' }, action: 'X', entity: { type: 'E' } })).rejects.toThrow('db down');
  });
});

describe('operation keys (LIFECYCLE_MODEL §2.2)', () => {
  function fakeTx(existing: Record<string, unknown> | null) {
    const operationLog = {
      findUnique: vi.fn(async () => existing),
      create: vi.fn(async () => ({ id: 'op1' })),
      update: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})),
    };
    return Object.assign({ operationLog } as unknown as TxClient, { mocks: operationLog });
  }

  it('runs fn once and records its JSON result', async () => {
    const tx = fakeTx(null);
    const fn = vi.fn(async () => ({ id: 'x1', at: new Date('2026-02-01T00:00:00Z') }));
    const out = await idempotent(tx, { key: 'k1', operation: 'demo.do' }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ result: { id: 'x1', at: '2026-02-01T00:00:00.000Z' }, replayed: false, operationId: 'op1' });
    expect(tx.mocks.update.mock.calls[0][0].data.resultRef).toBe('x1');
  });

  it('a repeated key returns the recorded result without running fn', async () => {
    const tx = fakeTx({ id: 'op1', operation: 'demo.do', fingerprint: null, result: { id: 'x1' }, completedAt: new Date() });
    const fn = vi.fn();
    const out = await idempotent(tx, { key: 'k1', operation: 'demo.do' }, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(out).toEqual({ result: { id: 'x1' }, replayed: true, operationId: 'op1' });
  });

  it('the same key for another operation or fingerprint is refused', async () => {
    const tx = fakeTx({ id: 'op1', operation: 'demo.do', fingerprint: 'h1', result: null, completedAt: new Date() });
    await expect(idempotent(tx, { key: 'k1', operation: 'demo.other' }, vi.fn())).rejects.toBeInstanceOf(OperationKeyConflictError);
    await expect(idempotent(tx, { key: 'k1', operation: 'demo.do', fingerprint: 'h2' }, vi.fn())).rejects.toBeInstanceOf(OperationKeyConflictError);
  });

  it('runTransition returns the committed result when a concurrent call wins the key (P2002)', async () => {
    const prisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }),
      operationLog: {
        findUnique: vi.fn(async () => ({ id: 'op9', operation: 'demo.do', fingerprint: null, result: { n: 1 }, completedAt: new Date() })),
      },
    } as unknown as RootClient;
    await expect(runTransition(prisma, { key: 'k', operation: 'demo.do' }, vi.fn())).resolves.toEqual({ result: { n: 1 }, replayed: true, operationId: 'op9' });
  });

  it('runTransition rethrows a unique violation that is not about its key', async () => {
    const prisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('Unique constraint failed on other'), { code: 'P2002' });
      }),
      operationLog: { findUnique: vi.fn(async () => null) },
    } as unknown as RootClient;
    await expect(runTransition(prisma, { key: 'k', operation: 'demo.do' }, vi.fn())).rejects.toThrow(/other/);
  });
});

describe('consumer registry and dispatcher', () => {
  const handle = async () => undefined;

  it('registers by unique <module>.<name> and indexes by event type', () => {
    const r = new ConsumerRegistry();
    r.register({ name: 'time.leaveDays', eventTypes: ['leave.request.approved', 'leave.request.cancelled'], handle });
    r.register({ name: 'documents.leaveLetter', eventTypes: ['leave.request.approved'], handle });
    expect(r.forType('leave.request.approved').map((c) => c.name)).toEqual(['time.leaveDays', 'documents.leaveLetter']);
    expect(r.types()).toEqual(['leave.request.approved', 'leave.request.cancelled']);
    expect(() => r.register({ name: 'time.leaveDays', eventTypes: ['x.y'], handle })).toThrow(/already registered/);
    expect(() => r.register({ name: 'NoModule', eventTypes: ['x.y'], handle })).toThrow(/Invalid consumer name/);
    expect(() => r.register({ name: 'time.none', eventTypes: [], handle })).toThrow(/no event type/);
  });

  it('backs off 30 s, 60 s, 120 s … capped at one hour', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000]);
    expect(retryDelayMs(30)).toBe(3_600_000);
  });

  it('claims nothing when no consumer is registered', async () => {
    const client = { $queryRaw: vi.fn() } as unknown as RootClient;
    const out = await runConsumers({ client, registry: new ConsumerRegistry() });
    expect(out.claimed).toBe(0);
    expect((client as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });
});

describe('redaction', () => {
  it('redacts secrets and bank details at any listed key', () => {
    expect(redact({ a: 1, password: 'x', nested: { IBAN: 'SA', ok: true } })).toEqual({ a: 1, password: '[REDACTED]', nested: { IBAN: '[REDACTED]', ok: true } });
  });
});
