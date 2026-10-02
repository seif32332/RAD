// domain-events: the scheduled run of the DomainEvent dispatcher (runConsumers, P1-FND-EVT;
// LIFECYCLE_MODEL §2.2). Cross-company by definition (DOMAIN_BOUNDARIES §5.4.2 "the outbox"): it
// also takes events without a company; every consumer applies its own scope to its effect.
// Consumers are registered by importing each module's consumers.ts in the composition root
// (src/jobs/registry.ts) before the job runs.
import { consumerRegistry, runConsumers, type ConsumerRegistry, type RunConsumersResult } from '../dispatcher';
import type { JobDefinition, JobSummary } from './runner';

export const DOMAIN_EVENTS_JOB = 'domain-events';

export interface DomainEventsJobOptions {
  registry?: ConsumerRegistry;
  /** Events claimed per round (default 50). */
  batch?: number;
  /** Rounds per run while full batches keep coming (default 20): a backlog drains over a few runs. */
  maxRounds?: number;
}

export function createDomainEventsJob<S>(opts: DomainEventsJobOptions = {}): JobDefinition<S> {
  const batch = Math.max(1, Math.min(opts.batch ?? 50, 1000));
  const maxRounds = Math.max(1, opts.maxRounds ?? 20);
  return {
    name: DOMAIN_EVENTS_JOB,
    description: 'Runs the registered DomainEvent consumers on due events (at most once per consumer and event)',
    crossCompany: true,
    async run(ctx): Promise<JobSummary> {
      const registry = opts.registry ?? consumerRegistry;
      const types = registry.types();
      const pendingWithoutConsumer = await ctx.db.domainEvent.count({ where: { status: 'PENDING', type: { notIn: types } } });
      const base = { consumers: registry.list().length, types: types.length, pendingWithoutConsumer };
      if (ctx.dryRun) {
        const due = types.length
          ? await ctx.db.domainEvent.count({
              where: { status: 'PENDING', type: { in: types }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: ctx.now } }] },
            })
          : 0;
        return { ...base, dryRun: true, due };
      }
      const total: RunConsumersResult = { claimed: 0, applied: 0, failed: 0, dead: 0, skipped: 0, dispatched: 0 };
      let rounds = 0;
      while (rounds < maxRounds) {
        rounds += 1;
        const r = await runConsumers({ client: ctx.db, registry, now: ctx.now, batch, companyIds: null });
        for (const k of Object.keys(total) as (keyof RunConsumersResult)[]) total[k] += r[k];
        if (r.claimed < batch) break;
      }
      return { ...base, rounds, ...total };
    },
  };
}
