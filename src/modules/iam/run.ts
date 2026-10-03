// The transaction of an identity transition (BL-PAY-005): SERIALIZABLE, because the identity rules read
// other rows (the attestation chain, the open link, the pending request) that a concurrent change could
// move. A serialization failure (P2034) or a unique violation (P2002: the same operation key claimed by a
// concurrent call, or a partial unique index of 9zk) aborts the transaction; it is retried, and the retry
// either replays the recorded result (same operation key) or meets the state the other call left (409).
// Never a 500, never a partial write.
//
// BL-PAY-021: after the transaction commits, the controls mode is checked and a change is recorded
// (recordControlsMode, its own short transaction: the identity facts it counts are what the committed
// transaction may have moved). An observation: its failure never fails the committed operation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { conflict } from '@/lib/http';
import type { RootClient, TxClient } from '@/modules/platform';
import { recordControlsModeQuietly } from './controls';

// Contention (BL-PAY-021 review: under load a plain user creation could exhaust a short linear retry budget and
// answer 409). Two measures, neither of which weakens the isolation:
//  1. One identity transaction at a time PER PROCESS (a FIFO queue, taken before BEGIN, so the snapshot is fresh):
//     identity transactions of one server process no longer abort each other (they read the User relation and
//     the same index pages they insert into, which SERIALIZABLE reports as conflicts). They are short and rare.
//  2. Conflicts with other processes (the jobs, the vendor CLI, another app instance) are retried with
//     exponential back-off and full jitter, within a time budget, instead of a few fixed short waits.
const MAX_ATTEMPTS = 12;
const BUDGET_MS = 15_000;
const BASE_DELAY_MS = 25;
const MAX_DELAY_MS = 1_000;

let queue: Promise<unknown> = Promise.resolve();
/** Set while an identity task runs: re-entering runIdentityTransaction from inside one would wait on itself. */
const insideIdentityTask = new AsyncLocalStorage<true>();

/** Thrown when runIdentityTransaction is called from inside a running identity task (it would deadlock the queue). */
export class IdentityTransactionReentryError extends Error {
  constructor() {
    super('runIdentityTransaction re-entered from inside an identity transaction (it would wait on itself): call the transition with the tx you have');
    this.name = 'IdentityTransactionReentryError';
  }
}

/** Runs `task` after every identity transaction queued before it in this process (FIFO; a failure does not block the queue). */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function retryable(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2034' || err.code === 'P2002');
}

/** Exported for the test of the retry policy: the wait before attempt `attempt + 1` (full jitter, capped). */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 10));
  return Math.floor(random() * cap);
}

export async function runIdentityTransaction<T>(prisma: RootClient, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  if (insideIdentityTask.getStore()) throw new IdentityTransactionReentryError();
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await serialized(() =>
        insideIdentityTask.run(true, () =>
          prisma.$transaction((tx) => fn(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000, maxWait: 10_000 }),
        ),
      );
      await recordControlsModeQuietly(prisma, 'iam.identityTransaction');
      return result;
    } catch (err) {
      if (!retryable(err)) throw err;
      if (attempt >= MAX_ATTEMPTS || Date.now() - started > BUDGET_MS) throw conflict('تم تعديل البيانات من مستخدم آخر في نفس اللحظة، يرجى المحاولة مرة أخرى');
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
}
