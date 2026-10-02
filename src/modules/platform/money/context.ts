// The gateway context (BR-PAY-018): AsyncLocalStorage.run() ONLY (enterWith is refused by the
// conformance test money-gateway-static.test.ts), frozen, set by runMoneyOperation for the duration of
// the owning module's writer and read by the Prisma extension on every write. Not exported from the
// platform index: nothing but the gateway opens a context.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Columns } from './writes';

export interface MoneyContext {
  /** Registered operation name, e.g. `payroll.month.approve`. */
  readonly operation: string;
  /** The operation key of the call (LIFECYCLE_MODEL §2.2). */
  readonly operationKey: string;
  /** Tables (and columns) the operation may write. */
  readonly allow: ReadonlyMap<string, Columns>;
  /** The acting user (null for a SYSTEM operation run by a job). */
  readonly actorUserId: string | null;
}

const store = new AsyncLocalStorage<MoneyContext>();

export function currentMoneyContext(): MoneyContext | null {
  return store.getStore() ?? null;
}

/**
 * Runs `fn` inside `ctx`. The result is awaited INSIDE the context: Prisma queries are lazy (they run
 * when awaited), so a query returned un-awaited would run outside it and be refused (fail closed).
 */
export async function runInMoneyContext<T>(ctx: MoneyContext, fn: () => Promise<T>): Promise<T> {
  const frozen: MoneyContext = Object.freeze({ ...ctx, allow: new Map(ctx.allow) });
  return store.run(frozen, async () => await fn());
}

/** Whether the context allows writing `columns` of `model`. */
export function contextAllows(ctx: MoneyContext | null, model: string, columns: Columns): boolean {
  if (!ctx) return false;
  const allowed = ctx.allow.get(model);
  if (allowed === undefined) return false;
  if (allowed === '*') return true;
  if (columns === '*') return false;
  return columns.every((c) => allowed.includes(c));
}
