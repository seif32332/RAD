import { describe, expect, it, vi } from 'vitest';
import { dispatchOutbox as outboxDispatch, outboxExpirableWhere, outboxExpiryCutoff, outboxSendConfig } from '@/modules/platform';
import type { PrismaClient } from '@prisma/client';

// Master plan P0-07: before outbound email is switched on, stale queued messages must not all go out
// on the first live run. Unsent rows older than OUTBOX_TTL_HOURS become EXPIRED and are never sent.

const NOW = new Date('2026-09-28T09:00:00Z');
const LIVE: NodeJS.ProcessEnv = { NODE_ENV: 'test', OUTBOX_SEND: 'true', SMTP_HOST: 'smtp.invalid', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@example.com' };

function fakePrisma() {
  const calls: string[] = [];
  const prisma = {
    notificationOutbox: {
      groupBy: vi.fn(async () => [{ status: 'PENDING', _count: { _all: 5 } }]),
      count: vi.fn(async () => 2),
      updateMany: vi.fn(async (args: { data: { status: string } }) => {
        calls.push(`updateMany:${args.data.status}`);
        return { count: args.data.status === 'EXPIRED' ? 3 : 0 };
      }),
    },
    $queryRaw: vi.fn(async () => {
      calls.push('claim');
      return [];
    }),
    user: { findUnique: vi.fn() },
  };
  return { prisma, calls };
}

describe('outbox TTL (P0-07)', () => {
  it('defaults to 72 hours and is clamped to 1..720', () => {
    expect(outboxSendConfig({}).ttlHours).toBe(72);
    expect(outboxSendConfig({ OUTBOX_TTL_HOURS: '0' }).ttlHours).toBe(1);
    expect(outboxSendConfig({ OUTBOX_TTL_HOURS: '100000' }).ttlHours).toBe(720);
    expect(outboxSendConfig({ OUTBOX_TTL_HOURS: 'x' }).ttlHours).toBe(72);
  });

  it('cutoff is now minus the TTL', () => {
    expect(outboxExpiryCutoff(NOW, 72).toISOString()).toBe('2026-09-25T09:00:00.000Z');
  });

  it('only unsent email rows older than the cutoff expire (never SENT, SENDING or UNKNOWN)', () => {
    const cutoff = outboxExpiryCutoff(NOW, 72);
    expect(outboxExpirableWhere(cutoff, 3)).toEqual({
      channel: 'EMAIL',
      createdAt: { lt: cutoff },
      OR: [{ status: 'PENDING' }, { status: 'FAILED', attempts: { lt: 3 } }],
    });
  });

  it('dry run reports what would expire and changes nothing', async () => {
    const { prisma, calls } = fakePrisma();
    const r = await outboxDispatch(prisma as unknown as PrismaClient, { dryRun: true, now: NOW, env: LIVE });
    expect(r).toMatchObject({ mode: 'dry-run', ttlHours: 72, wouldExpire: 2 });
    expect(calls).toEqual([]);
  });

  it('live run expires stale rows before claiming a batch', async () => {
    const { prisma, calls } = fakePrisma();
    const r = await outboxDispatch(prisma as unknown as PrismaClient, { now: NOW, env: LIVE });
    expect(r).toMatchObject({ mode: 'live', expired: 3, claimed: 0, sent: 0 });
    expect(calls[0]).toBe('updateMany:EXPIRED');
    expect(calls.indexOf('claim')).toBeGreaterThan(0);
  });

  it('running it twice expires nothing more (the second run finds no stale unsent rows)', async () => {
    const { prisma } = fakePrisma();
    await outboxDispatch(prisma as unknown as PrismaClient, { now: NOW, env: LIVE });
    prisma.notificationOutbox.updateMany.mockImplementation(async () => ({ count: 0 }));
    const second = await outboxDispatch(prisma as unknown as PrismaClient, { now: NOW, env: LIVE });
    expect(second).toMatchObject({ expired: 0 });
  });
});
