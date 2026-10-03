// runIdentityTransaction under contention (BL-PAY-021 review): a plain user creation must not answer 409 because
// other identity transactions run at the same time. Measured before the change on PostgreSQL 16: 20 concurrent
// creations in one process → 1 × 409; 4 processes × 40 → 30–34 × 409 per process. Now: one identity transaction
// at a time per process (FIFO, before BEGIN) + exponential back-off with full jitter within a time budget.
// The database half is opt-in: SCOPE_IT=1 with DATABASE_URL on a THROWAWAY database.
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { retryDelayMs } from '@/modules/iam/run';

describe('identity transaction retry policy', () => {
  it('exponential back-off with full jitter, capped at one second', () => {
    expect(retryDelayMs(1, () => 0.999)).toBe(49);
    expect(retryDelayMs(3, () => 0.999)).toBe(199);
    expect(retryDelayMs(9, () => 0.999)).toBe(999);
    expect(retryDelayMs(50, () => 0.999)).toBe(999);
    expect(retryDelayMs(5, () => 0)).toBe(0);
  });
});

describe.skipIf(process.env.SCOPE_IT !== '1')('identity transactions under contention (PostgreSQL)', { timeout: 120_000 }, () => {
  it('60 concurrent user creations by one admin all succeed (no 409); a repeated key replays (idempotent)', async () => {
    const { prisma } = await import('@/lib/prisma');
    const iam = await import('@/modules/iam');
    const admin = await prisma.user.create({ data: { email: `contention-${randomUUID()}@example.test`, passwordHash: 'x', role: 'SUPER_ADMIN' } });
    const create = (i: number, key = `it:contention:${randomUUID()}`) =>
      iam.runIdentityTransaction(prisma, (tx) =>
        iam.createUser(tx, { actor: { id: admin.id, employeeId: null }, email: `c${i}-${randomUUID()}@example.test`, passwordHash: 'x', role: 'EMPLOYEE', operationKey: key }),
      );
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => create(i)));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const key = `it:contention:${randomUUID()}`;
    const [a, b] = await Promise.all([create(1000, key), create(1000, key)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.userId).toBe(b.userId);
  });
});
