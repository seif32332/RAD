// Consumer registry and the re-runnable dispatcher (P1-FND-EVT; LIFECYCLE_MODEL §2.1, §2.2 items 4 and 6).
//
// Guarantees:
//  - A consumer's effect runs in its own transaction, never in the producer's.
//  - At most once per (consumer, event): the effect and its EventConsumption(DONE) row commit together,
//    under a per-pair lock, so running the dispatcher twice or concurrently never repeats an effect.
//    A consumer that talks to the outside world does it through an outbox with a natural key
//    (e.g. NotificationOutbox.idempotencyKey), not by calling out from inside its transaction.
//  - A failing consumer is recorded (FAILED, attempts, lastError, nextAttemptAt with backoff), retried
//    on a later run, and DEAD after maxAttempts. It never blocks the other consumers of the event or
//    other events. INV-EVT-01 surfaces what stays unconsumed.
//  - A consumer that cannot apply its effect records a named outcome (e.g. RETRO_ROUTED, ADR-0002 #14)
//    after routing the effect to its named alternative path; the event is not left hanging.
import { claimDueEvents, lockConsumption } from './sql/outbox';
import type { DomainEventRecord } from './events';
import type { RootClient, TxClient } from './tx';

export const CONSUMER_NAME_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9-]*)+$/;
export const OUTCOME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const DEFAULT_OUTCOME = 'APPLIED';

export interface ConsumerContext {
  /** The consumer's own transaction: its writes commit together with its EventConsumption row. */
  tx: TxClient;
  /** 1 on the first try. */
  attempt: number;
  /** Operation key for a call into another module's public API: `${consumer}:${event.idempotencyKey}`. */
  operationKey: string;
}

export interface ConsumerResult {
  /** Named outcome, UPPER_SNAKE (APPLIED, RETRO_ROUTED, NOT_APPLICABLE…). */
  outcome: string;
}

export interface EventConsumer {
  /** `<module>.<name>`, stable forever (it is the key of EventConsumption). */
  name: string;
  eventTypes: readonly string[];
  handle(event: DomainEventRecord, ctx: ConsumerContext): Promise<ConsumerResult | void>;
  /** Attempts before the consumption is DEAD (default 10). */
  maxAttempts?: number;
  /** Transaction timeout for one handle() call (default 15 s). */
  timeoutMs?: number;
}

export class ConsumerRegistry {
  private readonly byName = new Map<string, EventConsumer>();

  register(consumer: EventConsumer): void {
    if (!CONSUMER_NAME_PATTERN.test(consumer.name)) throw new Error(`Invalid consumer name "${consumer.name}": expected <module>.<name>`);
    if (!consumer.eventTypes.length) throw new Error(`Consumer "${consumer.name}" subscribes to no event type`);
    if (typeof consumer.handle !== 'function') throw new Error(`Consumer "${consumer.name}" has no handle()`);
    if (this.byName.has(consumer.name)) throw new Error(`Consumer "${consumer.name}" is already registered`);
    this.byName.set(consumer.name, consumer);
  }

  forType(type: string): EventConsumer[] {
    return [...this.byName.values()].filter((c) => c.eventTypes.includes(type));
  }

  types(): string[] {
    return [...new Set([...this.byName.values()].flatMap((c) => c.eventTypes))].sort();
  }

  list(): EventConsumer[] {
    return [...this.byName.values()];
  }
}

/** The process-wide registry. Modules register their consumers from their consumers.ts. */
export const consumerRegistry = new ConsumerRegistry();

export function registerConsumer(consumer: EventConsumer): void {
  consumerRegistry.register(consumer);
}

/** Retry delay after the n-th failed attempt: 30 s, 60 s, 120 s … capped at 1 h. */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(30_000 * 2 ** (n - 1), 3_600_000);
}

export interface RunConsumersOptions {
  batch?: number;
  /**
   * Run for these companies only (a SystemContext run per company). Omitted or null: the explicit
   * cross-company outbox run of DOMAIN_BOUNDARIES §5.4.2, which also takes events without a company.
   */
  companyIds?: readonly string[] | null;
  client?: RootClient;
  registry?: ConsumerRegistry;
  now?: Date;
  /** Lease on a claimed event (default 5 min); an expired lease lets another run pick it up. */
  leaseMs?: number;
}

export interface RunConsumersResult {
  claimed: number;
  applied: number;
  failed: number;
  dead: number;
  skipped: number;
  dispatched: number;
}

type ConsumeResult = 'applied' | 'skipped' | 'failed' | 'dead';

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 2000);
}

async function consumeOne(client: RootClient, consumer: EventConsumer, event: DomainEventRecord, now: Date): Promise<ConsumeResult> {
  const where = { consumer_eventId: { consumer: consumer.name, eventId: event.id } };
  try {
    return await client.$transaction(
      async (tx) => {
        await lockConsumption(tx, consumer.name, event.id);
        const row = await tx.eventConsumption.findUnique({ where, select: { status: true, attempts: true, nextAttemptAt: true } });
        if (row && (row.status === 'DONE' || row.status === 'DEAD')) return 'skipped';
        if (row?.nextAttemptAt && row.nextAttemptAt > now) return 'skipped';
        const attempt = (row?.attempts ?? 0) + 1;
        const result = await consumer.handle(event, { tx, attempt, operationKey: `${consumer.name}:${event.idempotencyKey}` });
        const outcome = result?.outcome ?? DEFAULT_OUTCOME;
        if (!OUTCOME_PATTERN.test(outcome)) throw new Error(`Consumer "${consumer.name}" returned an invalid outcome "${outcome}"`);
        const done = { status: 'DONE', outcome, attempts: attempt, processedAt: new Date(), lastError: null, nextAttemptAt: null };
        await tx.eventConsumption.upsert({ where, create: { consumer: consumer.name, eventId: event.id, ...done }, update: done });
        return 'applied';
      },
      { timeout: consumer.timeoutMs ?? 15_000, maxWait: 5_000 },
    );
  } catch (err) {
    // The consumer's transaction rolled back (its writes are gone). Record the failure separately.
    return client.$transaction(async (tx) => {
      await lockConsumption(tx, consumer.name, event.id);
      const row = await tx.eventConsumption.findUnique({ where, select: { status: true, attempts: true } });
      if (row?.status === 'DONE') return 'skipped';
      const attempts = (row?.attempts ?? 0) + 1;
      const dead = attempts >= (consumer.maxAttempts ?? 10);
      const failure = {
        status: dead ? 'DEAD' : 'FAILED',
        attempts,
        lastError: errorText(err),
        nextAttemptAt: dead ? null : new Date(now.getTime() + retryDelayMs(attempts)),
      };
      await tx.eventConsumption.upsert({ where, create: { consumer: consumer.name, eventId: event.id, ...failure }, update: failure });
      return dead ? 'dead' : 'failed';
    });
  }
}

/**
 * Claims due events and runs every registered consumer of each event at most once. Safe to run again,
 * or concurrently: what is done stays done, what failed is retried when due. Events whose type has no
 * registered consumer are not claimed (they stay PENDING for INV-EVT-01 to report).
 */
export async function runConsumers(options: RunConsumersOptions = {}): Promise<RunConsumersResult> {
  const client = options.client ?? (await import('@/lib/prisma')).prisma;
  const registry = options.registry ?? consumerRegistry;
  const now = options.now ?? new Date();
  const batch = Math.max(1, Math.min(options.batch ?? 50, 1000));
  const result: RunConsumersResult = { claimed: 0, applied: 0, failed: 0, dead: 0, skipped: 0, dispatched: 0 };
  const types = registry.types();
  if (!types.length) return result;

  const events = await claimDueEvents(client, options.companyIds ?? null, { types, now, leaseUntil: new Date(now.getTime() + (options.leaseMs ?? 300_000)), batch });
  result.claimed = events.length;

  for (const event of events) {
    const consumers = registry.forType(event.type);
    for (const consumer of consumers) {
      result[await consumeOne(client, consumer, event, now)] += 1;
    }
    const rows = await client.eventConsumption.findMany({
      where: { eventId: event.id, consumer: { in: consumers.map((c) => c.name) } },
      select: { status: true, nextAttemptAt: true },
    });
    const settled = consumers.length === rows.filter((r) => r.status === 'DONE' || r.status === 'DEAD').length;
    if (settled) {
      await client.domainEvent.updateMany({
        where: { id: event.id, status: 'PENDING' },
        data: { status: 'DISPATCHED', dispatchedAt: new Date(), leaseUntil: null, nextAttemptAt: null },
      });
      result.dispatched += 1;
    } else {
      const retryAt = rows
        .filter((r) => r.status === 'FAILED' && r.nextAttemptAt)
        .map((r) => r.nextAttemptAt!.getTime())
        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
      await client.domainEvent.updateMany({
        where: { id: event.id, status: 'PENDING' },
        data: { leaseUntil: null, nextAttemptAt: Number.isFinite(retryAt) ? new Date(retryAt) : null },
      });
    }
  }
  return result;
}
