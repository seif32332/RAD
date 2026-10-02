// outbox-dispatch: sends queued NotificationOutbox emails (DEC-009; cross-company by definition,
// DOMAIN_BOUNDARIES §5.4.2). DRY RUN unless OUTBOX_SEND=true AND SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM
// are set. State machine: PENDING -> SENDING (lease) -> SENT | FAILED | UNKNOWN.
//  - A lease that expires, or a send that times out, becomes UNKNOWN and is never retried automatically
//    (it may have been delivered). Only definite failures (FAILED) are retried, up to OUTBOX_MAX_ATTEMPTS.
//  - Master plan P0-07: unsent rows older than OUTBOX_TTL_HOURS (default 72) become EXPIRED and are
//    never sent, so the first live run cannot mail a backlog of stale messages.
//  - `shouldSend` (injected by the composition root) re-checks a recipient right before sending; a
//    message refused there is FAILED with no attempts left.
import { claimOutboxBatch, type ClaimedOutboxRow } from '../sql/jobs';
import type { RootClient } from '../tx';
import type { JobDefinition, JobEnv, JobSummary } from './runner';

export const OUTBOX_DISPATCH_JOB = 'outbox-dispatch';

export interface OutboxSendConfig {
  live: boolean;
  reason: string | null;
  batch: number;
  leaseSeconds: number;
  maxAttempts: number;
  ttlHours: number;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function outboxSendConfig(env: JobEnv = process.env): OutboxSendConfig {
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].filter((k) => !env[k]);
  const enabled = env.OUTBOX_SEND === 'true';
  return {
    live: enabled && missing.length === 0,
    reason: !enabled ? 'OUTBOX_SEND is not "true"' : missing.length ? `SMTP not configured (${missing.join(', ')})` : null,
    batch: clampInt(env.OUTBOX_BATCH, 20, 1, 200),
    leaseSeconds: clampInt(env.OUTBOX_LEASE_SECONDS, 300, 60, 3600),
    maxAttempts: clampInt(env.OUTBOX_MAX_ATTEMPTS, 3, 1, 10),
    ttlHours: clampInt(env.OUTBOX_TTL_HOURS, 72, 1, 24 * 30),
  };
}

/** Rows created before this instant are EXPIRED instead of sent (OUTBOX_TTL_HOURS). */
export function outboxExpiryCutoff(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() - ttlHours * 60 * 60 * 1000);
}

/** Unsent rows (PENDING, or FAILED with attempts left) older than the cutoff. */
export function outboxExpirableWhere(cutoff: Date, maxAttempts: number) {
  return {
    channel: 'EMAIL',
    createdAt: { lt: cutoff },
    OR: [{ status: 'PENDING' }, { status: 'FAILED', attempts: { lt: maxAttempts } }],
  };
}

type SendError = { code?: unknown; message?: unknown; command?: unknown; responseCode?: unknown } | null | undefined;

/**
 * Outcome of a failed SMTP attempt: 'UNKNOWN' when the message may have been delivered (timeouts,
 * connection dropped after the transaction started) — never retried automatically; 'FAILED' when it
 * certainly was not (connection refused, DNS, auth, an SMTP rejection) — retried up to the limit.
 */
export function classifySendError(err: unknown): 'UNKNOWN' | 'FAILED' {
  const e = err as SendError;
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || '');
  const command = String((e && e.command) || '');
  if (code === 'ETIMEDOUT' || /time(d)?[ -]?out/i.test(msg)) return 'UNKNOWN';
  if ((code === 'ECONNRESET' || code === 'EPIPE' || code === 'ESOCKET') && /DATA|MESSAGE/i.test(command)) return 'UNKNOWN';
  if (e && Number.isInteger(e.responseCode)) return 'FAILED';
  if (['ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'EAUTH', 'EENVELOPE', 'ECONNECTION', 'ETLS'].includes(code)) return 'FAILED';
  return 'UNKNOWN';
}

export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface OutboxDispatchOptions {
  dryRun?: boolean;
  now?: Date;
  env?: JobEnv;
  /** Re-check before sending; false = do not send (FAILED, no attempts left). */
  shouldSend?: (db: RootClient, message: ClaimedOutboxRow) => Promise<boolean>;
  /** Tests: a transport instead of nodemailer. */
  transport?: MailTransport;
}

async function smtpTransport(env: JobEnv): Promise<MailTransport> {
  const nodemailer = (await import('nodemailer')).default;
  const port = parseInt(env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
}

export async function dispatchOutbox(db: RootClient, opts: OutboxDispatchOptions = {}): Promise<JobSummary> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const cfg = outboxSendConfig(env);
  if (opts.dryRun) Object.assign(cfg, { live: false, reason: '--dry-run' });
  const counts = Object.fromEntries(
    (await db.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } })).map((g) => [g.status, g._count._all]),
  ) as Record<string, number>;
  const expiredLeases = await db.notificationOutbox.count({ where: { status: 'SENDING', leaseUntil: { lt: now } } });
  const retryable = await db.notificationOutbox.count({ where: { status: 'FAILED', attempts: { lt: cfg.maxAttempts } } });
  const expirableWhere = outboxExpirableWhere(outboxExpiryCutoff(now, cfg.ttlHours), cfg.maxAttempts);
  if (!cfg.live) {
    // DRY RUN: no row is changed (not even expired leases).
    const wouldExpire = await db.notificationOutbox.count({ where: expirableWhere });
    return {
      mode: 'dry-run',
      reason: cfg.reason,
      byStatus: counts,
      ttlHours: cfg.ttlHours,
      wouldExpire,
      wouldSend: Math.min(cfg.batch, Math.max(0, (counts.PENDING || 0) + retryable - wouldExpire)),
      expiredLeasesToMarkUnknown: expiredLeases,
    };
  }

  // 0. Too old to be useful: EXPIRED, never sent.
  const expired = await db.notificationOutbox.updateMany({
    where: expirableWhere,
    data: { status: 'EXPIRED', leaseUntil: null, lastError: `older than OUTBOX_TTL_HOURS=${cfg.ttlHours}: not sent` },
  });

  // 1. SENDING rows whose lease ran out: outcome unknown (the process died mid-send). Never resent.
  const lost = await db.notificationOutbox.updateMany({
    where: { status: 'SENDING', leaseUntil: { lt: now } },
    data: { status: 'UNKNOWN', leaseUntil: null, lastError: 'lease expired during send: delivery unknown, not retried automatically' },
  });

  // 2. Claim a batch atomically (two dispatchers never take the same row).
  const claimed = await claimOutboxBatch(db, { leaseUntil: new Date(now.getTime() + cfg.leaseSeconds * 1000), maxAttempts: cfg.maxAttempts, batch: cfg.batch });
  const result = { mode: 'live', expired: expired.count, lostLeasesMarkedUnknown: lost.count, claimed: claimed.length, sent: 0, failed: 0, unknown: 0, skipped: 0 };
  if (!claimed.length) return result;

  const transport = opts.transport ?? (await smtpTransport(env));
  for (const msg of claimed) {
    if (opts.shouldSend && !(await opts.shouldSend(db, msg))) {
      await db.notificationOutbox.updateMany({
        where: { id: msg.id, status: 'SENDING' },
        data: { status: 'FAILED', attempts: cfg.maxAttempts, leaseUntil: null, lastError: 'recipient no longer active' },
      });
      result.skipped += 1;
      continue;
    }
    try {
      await transport.sendMail({ from: String(env.SMTP_FROM), to: msg.recipient, subject: msg.subject || 'رديف', text: msg.body });
      await db.notificationOutbox.updateMany({
        where: { id: msg.id, status: 'SENDING' },
        data: { status: 'SENT', sentAt: new Date(), leaseUntil: null, lastError: null },
      });
      result.sent += 1;
    } catch (err) {
      const status = classifySendError(err);
      await db.notificationOutbox.updateMany({
        where: { id: msg.id, status: 'SENDING' },
        data: { status, leaseUntil: null, lastError: String((err as Error)?.message || err).slice(0, 500) },
      });
      result[status === 'UNKNOWN' ? 'unknown' : 'failed'] += 1;
    }
  }
  return result;
}

/** The outbox-dispatch job (cross-company: the outbox has no company). */
export function createOutboxDispatchJob<S>(opts: Pick<OutboxDispatchOptions, 'shouldSend' | 'transport'> = {}): JobDefinition<S> {
  return {
    name: OUTBOX_DISPATCH_JOB,
    description: 'Sends queued emails (dry run unless OUTBOX_SEND=true and SMTP is configured); expires stale ones',
    crossCompany: true,
    run: (ctx) => dispatchOutbox(ctx.db, { dryRun: ctx.dryRun, now: ctx.now, env: ctx.env, ...opts }),
  };
}
