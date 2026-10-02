// Running a payroll transition in its own transaction (for callers without one: routes, services):
// a concurrent call with the same operation key loses on OperationLog's unique key (P2002) and is run
// again, which replays the winner's result (LIFECYCLE_MODEL §2.2; same pattern as runEmploymentTransition).
import type { RootClient, TxClient } from '@/modules/platform';

/** Any client that opens interactive transactions: the root client or an iam scoped client. */
export type TxRunner = { $transaction: (...args: never[]) => unknown };

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

export async function runPayrollTransaction<T>(
  client: TxRunner,
  fn: (tx: TxClient) => Promise<T>,
  opts: { timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  const root = client as unknown as RootClient;
  const run = () => root.$transaction((tx) => fn(tx as TxClient), { timeout: opts.timeoutMs ?? 60_000, maxWait: opts.maxWaitMs ?? 10_000 });
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) return run();
    throw err;
  }
}
