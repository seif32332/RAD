// Running a compensation transition in its own transaction (routes, jobs): a concurrent call with the same
// operation key loses on OperationLog's (or the request's) unique key (P2002) and is run again, which
// replays the winner's result (LIFECYCLE_MODEL §2.2; the pattern of runPayrollTransaction).
import type { RootClient, TxClient } from '@/modules/platform';

/** Any client that opens interactive transactions: the root client or an iam scoped client. */
export type TxRunner = { $transaction: (...args: never[]) => unknown };

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

export async function runCompensationTransaction<T>(client: TxRunner, fn: (tx: TxClient) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const root = client as unknown as RootClient;
  const run = () => root.$transaction((tx) => fn(tx as TxClient), { timeout: opts.timeoutMs ?? 30_000, maxWait: 10_000 });
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) return run();
    throw err;
  }
}
