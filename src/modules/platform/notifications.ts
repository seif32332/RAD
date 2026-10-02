// NotificationOutbox writes (platform owns the table, DOMAIN_BOUNDARIES §5.2). Modules queue their
// emails here, in their own transaction or not; `scripts/jobs.mjs outbox-dispatch` sends them later
// (ARCH-017: never mail from inside a transition).
import type { Prisma, PrismaClient } from '@prisma/client';

export interface OutboxEmail {
  /** Natural key: the same message is queued once whatever the retries (unique). */
  idempotencyKey: string;
  recipient: string;
  subject: string;
  body: string;
}

const EMAIL_RE = /^[^\s@"'<>]{1,64}@[^\s@"'<>]{1,253}\.[a-z]{2,63}$/i;

/** A plausible single email address (no display name, no header injection). */
export function isOutboxEmailAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

/** Queues emails; rows whose key is already queued are skipped. Returns how many were added. */
export async function enqueueEmails(db: PrismaClient | Prisma.TransactionClient, emails: readonly OutboxEmail[]): Promise<number> {
  if (!emails.length) return 0;
  const res = await db.notificationOutbox.createMany({
    data: emails.map((e) => ({ idempotencyKey: e.idempotencyKey, channel: 'EMAIL', recipient: e.recipient, subject: e.subject, body: e.body })),
    skipDuplicates: true,
  });
  return res.count;
}
