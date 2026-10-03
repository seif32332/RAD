// P1-FND-EVT / P1-FND-AUDIT against a real PostgreSQL with all migrations applied (9t_platform_events_audit).
// Opt-in: PLATFORM_IT=1 with DATABASE_URL pointing at a THROWAWAY database. Every test uses its own
// keys and event types (a random tag); rows are not cleaned up (the audit and event tables refuse
// DELETE by design).
//
// The "business state" is a SystemSetting row (a platform table) used as a counter, so the tests need
// no other module.
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { DomainEventRecord, EventConsumer } from '@/modules/platform';

const RUN = process.env.PLATFORM_IT === '1';

describe.skipIf(!RUN)('platform outbox, operation keys and audit on PostgreSQL', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const platform = await import('@/modules/platform');
  const { runTransition, emitEvent, audit, runConsumers, ConsumerRegistry } = platform;

  const newTag = () => `x${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const counterKey = (tag: string) => `it-platform:${tag}:counter`;
  const readCounter = async (tag: string) =>
    Number((await prisma.systemSetting.findUnique({ where: { key: counterKey(tag) } }))?.value ?? 0);

  /** A transition: counter + 1, with its audit row and its event, under one operation key. */
  function increment(tag: string, opKey: string, opts: { failAfterWrites?: boolean; delayMs?: number } = {}) {
    return runTransition(prisma, { key: opKey, operation: 'itest.counter.increment', actorId: null }, async (tx) => {
      const before = Number((await tx.systemSetting.findUnique({ where: { key: counterKey(tag) } }))?.value ?? 0);
      const row = await tx.systemSetting.upsert({
        where: { key: counterKey(tag) },
        create: { key: counterKey(tag), value: String(before + 1) },
        update: { value: String(before + 1) },
      });
      await audit(tx, {
        actor: { type: 'SYSTEM', id: 'platform-it' },
        action: 'itest.counter.increment',
        entity: { type: 'SystemSetting', id: row.id },
        before: { value: before },
        after: { value: before + 1 },
        operationKey: opKey,
      });
      await emitEvent(tx, {
        type: `itest.${tag}.incremented`,
        aggregateType: 'Counter',
        aggregateId: tag,
        idempotencyKey: `${opKey}:incremented`,
        payload: { value: before + 1 },
      });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failAfterWrites) throw new Error('transition failed after its writes');
      return { id: row.id, value: before + 1 };
    });
  }

  const countEvents = (tag: string) => prisma.domainEvent.count({ where: { aggregateType: 'Counter', aggregateId: tag } });
  const countAudits = (opKey: string) => prisma.auditRecord.count({ where: { operationKey: opKey } });

  it('double call, one after the other: one effect, one audit row, one event, same result', async () => {
    const tag = newTag();
    const opKey = `itest:${tag}:1`;
    const first = await increment(tag, opKey);
    const second = await increment(tag, opKey);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await readCounter(tag)).toBe(1);
    expect(await countEvents(tag)).toBe(1);
    expect(await countAudits(opKey)).toBe(1);
    expect(await prisma.operationLog.count({ where: { operationKey: opKey } })).toBe(1);
  });

  it('double call, concurrently: one effect, both callers get the same result', async () => {
    const tag = newTag();
    const opKey = `itest:${tag}:1`;
    const results = await Promise.all([increment(tag, opKey, { delayMs: 300 }), increment(tag, opKey, { delayMs: 300 })]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results[0].result).toEqual(results[1].result);
    expect(await readCounter(tag)).toBe(1);
    expect(await countEvents(tag)).toBe(1);
    expect(await countAudits(opKey)).toBe(1);
  });

  it('a key recorded for one actor is never replayed to another actor (OperationKeyConflictError); the same actor replays', async () => {
    const opKey = `itest:${newTag()}:actor`;
    const run = (actorId: string | null) => runTransition(prisma, { key: opKey, operation: 'itest.actor.op', actorId }, async () => ({ id: 'r', by: actorId }));
    const first = await run('user-a');
    expect(first.replayed).toBe(false);
    expect((await run('user-a')).replayed).toBe(true);
    await expect(run('user-b')).rejects.toBeInstanceOf(platform.OperationKeyConflictError);
    // A caller without an actor (a job) keeps the previous behaviour: replay.
    expect((await run(null)).result).toEqual(first.result);
  });

  it('state, audit, event and operation key commit together or not at all', async () => {
    const tag = newTag();
    const opKey = `itest:${tag}:1`;
    await expect(increment(tag, opKey, { failAfterWrites: true })).rejects.toThrow('transition failed after its writes');
    expect(await readCounter(tag)).toBe(0);
    expect(await countEvents(tag)).toBe(0);
    expect(await countAudits(opKey)).toBe(0);
    expect(await prisma.operationLog.count({ where: { operationKey: opKey } })).toBe(0);
    // The key was not burnt: the same operation succeeds afterwards.
    const ok = await increment(tag, opKey);
    expect(ok.replayed).toBe(false);
    expect(await readCounter(tag)).toBe(1);
    expect(await countEvents(tag)).toBe(1);
  });

  it('emitting the same event key twice in one transaction keeps one row', async () => {
    const tag = newTag();
    const out = await prisma.$transaction(async (tx) => {
      const input = { type: `itest.${tag}.emitted`, aggregateType: 'Counter', aggregateId: tag, idempotencyKey: `${tag}:e`, payload: {} };
      const a = await emitEvent(tx, input);
      const b = await emitEvent(tx, input);
      await expect(emitEvent(tx, { ...input, aggregateId: 'other' })).rejects.toBeInstanceOf(platform.EventKeyConflictError);
      return [a, b];
    });
    expect(out[0].created).toBe(true);
    expect(out[1].created).toBe(false);
    expect(out[1].event.id).toBe(out[0].event.id);
    expect(await countEvents(tag)).toBe(1);
  });

  async function produce(tag: string, n: number) {
    for (let i = 1; i <= n; i++) await increment(tag, `itest:${tag}:${i}`);
  }

  function counting(name: string, types: string[], behaviour: (event: DomainEventRecord, attempt: number) => Promise<void | { outcome: string }> = async () => undefined) {
    const calls: string[] = [];
    const consumer: EventConsumer = {
      name,
      eventTypes: types,
      maxAttempts: 3,
      async handle(event, ctx) {
        calls.push(event.id);
        // The consumer's own write, in its own transaction.
        await ctx.tx.systemSetting.upsert({
          where: { key: `it-platform:${ctx.operationKey}` },
          create: { key: `it-platform:${ctx.operationKey}`, value: '1' },
          update: { value: String(Number.NaN) },
        });
        return behaviour(event, ctx.attempt);
      },
    };
    return { consumer, calls };
  }

  it('each consumer runs once per event, even when the dispatcher runs twice and concurrently', async () => {
    const tag = newTag();
    const type = `itest.${tag}.incremented`;
    await produce(tag, 3);
    const registry = new ConsumerRegistry();
    const a = counting(`itest.${tag}A`, [type]);
    const b = counting(`itest.${tag}B`, [type]);
    registry.register(a.consumer);
    registry.register(b.consumer);

    // Concurrent runs, then sequential runs; ordering per aggregate means the three events of the
    // counter need several runs to drain.
    await Promise.all([runConsumers({ registry, batch: 10 }), runConsumers({ registry, batch: 10 }), runConsumers({ registry, batch: 10 })]);
    for (let i = 0; i < 4; i++) await runConsumers({ registry, batch: 10 });
    await Promise.all([runConsumers({ registry }), runConsumers({ registry })]);

    const events = await prisma.domainEvent.findMany({ where: { type }, orderBy: { seq: 'asc' } });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.status === 'DISPATCHED' && e.dispatchedAt)).toBe(true);
    for (const c of [a, b]) {
      expect(c.calls.sort()).toEqual(events.map((e) => e.id).sort());
    }
    expect(await prisma.eventConsumption.count({ where: { eventId: { in: events.map((e) => e.id) }, status: 'DONE', outcome: 'APPLIED' } })).toBe(6);
  });

  it('delivers the events of one aggregate in recorded order', async () => {
    const tag = newTag();
    const type = `itest.${tag}.incremented`;
    await produce(tag, 3);
    const registry = new ConsumerRegistry();
    const seen: number[] = [];
    registry.register({
      name: `itest.${tag}Order`,
      eventTypes: [type],
      async handle(event) {
        seen.push((event.payload as { value: number }).value);
      },
    });
    await Promise.all([runConsumers({ registry, batch: 10 }), runConsumers({ registry, batch: 10 })]);
    for (let i = 0; i < 3; i++) await runConsumers({ registry, batch: 10 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('a failing consumer is retried when due and does not block the others; DEAD after maxAttempts', async () => {
    const tag = newTag();
    const type = `itest.${tag}.incremented`;
    await produce(tag, 1);
    const registry = new ConsumerRegistry();
    const ok = counting(`itest.${tag}Ok`, [type]);
    const flaky = counting(`itest.${tag}Flaky`, [type], async (_e, attempt) => {
      if (attempt === 1) throw new Error('temporary failure');
    });
    const broken = counting(`itest.${tag}Broken`, [type], async () => {
      throw new Error('always fails');
    });
    [ok, flaky, broken].forEach((c) => registry.register(c.consumer));
    const [event] = await prisma.domainEvent.findMany({ where: { type } });
    const consumption = (name: string) =>
      prisma.eventConsumption.findUniqueOrThrow({ where: { consumer_eventId: { consumer: name, eventId: event.id } } });

    const t0 = new Date();
    const run1 = await runConsumers({ registry, now: t0 });
    expect(run1).toMatchObject({ claimed: 1, applied: 1, failed: 2, dispatched: 0 });
    expect((await consumption(ok.consumer.name)).status).toBe('DONE');
    const f1 = await consumption(flaky.consumer.name);
    expect(f1).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(f1.lastError).toMatch(/temporary failure/);
    // The failed consumer's own write was rolled back with its transaction.
    expect(await prisma.systemSetting.count({ where: { key: `it-platform:${flaky.consumer.name}:${event.idempotencyKey}` } })).toBe(0);

    // Not due yet: nothing is claimed.
    expect((await runConsumers({ registry, now: new Date(t0.getTime() + 1_000) })).claimed).toBe(0);

    const run2 = await runConsumers({ registry, now: new Date(t0.getTime() + 31_000) });
    expect(run2).toMatchObject({ claimed: 1, applied: 1, failed: 1 });
    expect(await consumption(flaky.consumer.name)).toMatchObject({ status: 'DONE', attempts: 2 });

    const run3 = await runConsumers({ registry, now: new Date(t0.getTime() + 200_000) });
    expect(run3).toMatchObject({ claimed: 1, dead: 1, dispatched: 1 });
    expect(await consumption(broken.consumer.name)).toMatchObject({ status: 'DEAD', attempts: 3 });
    expect((await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('DISPATCHED');
    expect(ok.calls).toHaveLength(1);
    expect(flaky.calls).toHaveLength(2);
  });

  it('a run for some companies claims only their events (per-company SystemContext)', async () => {
    const tag = newTag();
    const type = `itest.${tag}.scoped`;
    await prisma.$transaction(async (tx) => {
      for (const co of ['A', 'B']) {
        await emitEvent(tx, { type, aggregateType: 'Counter', aggregateId: `${tag}${co}`, companyId: `${tag}-co${co}`, idempotencyKey: `${tag}:${co}`, payload: {} });
      }
    });
    const registry = new ConsumerRegistry();
    const seen: (string | null)[] = [];
    registry.register({ name: `itest.${tag}Scoped`, eventTypes: [type], async handle(event) { seen.push(event.companyId); } });
    expect((await runConsumers({ registry, companyIds: [`${tag}-coB`] })).claimed).toBe(1);
    expect(seen).toEqual([`${tag}-coB`]);
    expect((await runConsumers({ registry, companyIds: [`${tag}-coB`] })).claimed).toBe(0);
    expect((await runConsumers({ registry })).claimed).toBe(1);
    expect(seen).toEqual([`${tag}-coB`, `${tag}-coA`]);
  });

  it('records a named outcome (RETRO_ROUTED, ADR-0002 #14)', async () => {
    const tag = newTag();
    const type = `itest.${tag}.incremented`;
    await produce(tag, 1);
    const registry = new ConsumerRegistry();
    const routed = counting(`itest.${tag}Routed`, [type], async () => ({ outcome: 'RETRO_ROUTED' }));
    registry.register(routed.consumer);
    await runConsumers({ registry });
    const [event] = await prisma.domainEvent.findMany({ where: { type } });
    expect(await prisma.eventConsumption.findUniqueOrThrow({ where: { consumer_eventId: { consumer: routed.consumer.name, eventId: event.id } } })).toMatchObject({
      status: 'DONE',
      outcome: 'RETRO_ROUTED',
    });
  });

  it('the database refuses to change or delete audit rows, events and DONE consumptions', async () => {
    const tag = newTag();
    const opKey = `itest:${tag}:1`;
    await increment(tag, opKey);
    const row = await prisma.auditRecord.findFirstOrThrow({ where: { operationKey: opKey } });
    await expect(prisma.auditRecord.update({ where: { id: row.id }, data: { reason: 'rewritten' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditRecord.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditRecord.deleteMany({ where: { operationKey: opKey } })).rejects.toThrow(/append-only/);
    expect(await countAudits(opKey)).toBe(1);

    const event = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateType: 'Counter', aggregateId: tag } });
    await expect(prisma.domainEvent.update({ where: { id: event.id }, data: { payload: { value: 999 } } })).rejects.toThrow(/immutable/);
    await expect(prisma.domainEvent.delete({ where: { id: event.id } })).rejects.toThrow(/never deleted/);

    const registry = new ConsumerRegistry();
    const c = counting(`itest.${tag}Final`, [event.type]);
    registry.register(c.consumer);
    await runConsumers({ registry });
    const done = await prisma.eventConsumption.findUniqueOrThrow({ where: { consumer_eventId: { consumer: c.consumer.name, eventId: event.id } } });
    await expect(prisma.eventConsumption.update({ where: { id: done.id }, data: { status: 'FAILED' } })).rejects.toThrow(/final/);
  });
});
