// The transaction of an identity transition (BL-PAY-005): SERIALIZABLE, because the identity rules read
// other rows (the attestation chain, the open link, the pending request) that a concurrent change could
// move. A serialization failure (P2034) or a unique violation (P2002: the same operation key claimed by a
// concurrent call, or a partial unique index of 9zk) aborts the transaction; it is retried, and the retry
// either replays the recorded result (same operation key) or meets the state the other call left (409).
// Never a 500, never a partial write.
import { Prisma } from '@prisma/client';
import { conflict } from '@/lib/http';
import type { RootClient, TxClient } from '@/modules/platform';

const RETRIES = 8;

function retryable(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2034' || err.code === 'P2002');
}

export async function runIdentityTransaction<T>(prisma: RootClient, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => fn(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000, maxWait: 10_000 });
    } catch (err) {
      if (!retryable(err)) throw err;
      if (attempt >= RETRIES) throw conflict('تم تعديل البيانات من مستخدم آخر في نفس اللحظة، يرجى المحاولة مرة أخرى');
      // Jittered back-off: concurrent serializable transactions on User rows retry apart, not in lock step.
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 80)));
    }
  }
}
