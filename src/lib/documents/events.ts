// DocumentEvent: append-only log with a hash chain (SPEC §12). Each event's hash covers the
// previous hash and its own canonical content, so deleting or editing a row in the middle (which
// the database trigger already refuses) would also break every later hash.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { redact } from '@/lib/audit';
import { canonicalJson, sha256Hex } from './core';

export type DocumentEventType =
  | 'REQUEST_CREATED' | 'SNAPSHOT_CREATED' | 'APPROVAL_REQUESTED' | 'APPROVED' | 'REJECTED' | 'APPROVAL_INVALIDATED'
  | 'CANCELLED' | 'NUMBER_RESERVED' | 'RENDER_FAILED' | 'ISSUED' | 'DOWNLOADED' | 'REVOKED' | 'SUPERSEDED' | 'VERIFIED' | 'PURGED'
  | 'ASSET_UPLOADED' | 'SIGNATORY_CHANGED' | 'AUTHORIZATION_GRANTED' | 'AUTHORIZATION_ACCEPTED' | 'AUTHORIZATION_REVOKED'
  | 'POLICY_CHANGED' | 'BRAND_CHANGED';

export const GENESIS_HASH = '0'.repeat(64);
/** Serializes writers of the chain (pg_advisory_xact_lock key). */
const CHAIN_LOCK = 7_314_001;

export interface EventInput {
  type: DocumentEventType;
  requestId?: string | null;
  documentId?: string | null;
  actorId?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

/** The hashed content of an event (also used by the chain verifier). */
export function eventHash(prevHash: string, e: { type: string; requestId: string | null; documentId: string | null; actorId: string | null; ip: string | null; metaJson: string | null; at: Date }): string {
  return sha256Hex(prevHash + canonicalJson({
    type: e.type, requestId: e.requestId, documentId: e.documentId, actorId: e.actorId, ip: e.ip, meta: e.metaJson, at: e.at.toISOString(),
  }));
}

/** IPv4 /24 or IPv6 /48: enough to investigate abuse, not a precise location (verification page). */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, '.0');
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
  return null;
}

/** Appends one event inside the caller's transaction. */
export async function appendEvent(tx: Prisma.TransactionClient, input: EventInput): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`;
  const last = await tx.documentEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const row = {
    type: input.type,
    requestId: input.requestId ?? null,
    documentId: input.documentId ?? null,
    actorId: input.actorId ?? null,
    ip: input.ip ?? null,
    metaJson: input.meta ? canonicalJson(redact(input.meta) as never) : null,
    at: new Date(),
  };
  await tx.documentEvent.create({ data: { ...row, prevHash, hash: eventHash(prevHash, row) } });
}

/** Walks the chain; returns the first broken sequence number, or null when intact. */
export async function verifyEventChain(db: Prisma.TransactionClient, batch = 1000): Promise<{ checked: number; brokenAtSeq: bigint | null }> {
  let prev = GENESIS_HASH;
  let after: bigint | null = null;
  let checked = 0;
  for (;;) {
    const rows: Awaited<ReturnType<typeof db.documentEvent.findMany>> = await db.documentEvent.findMany({
      where: after === null ? {} : { seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: batch,
    });
    if (!rows.length) return { checked, brokenAtSeq: null };
    for (const r of rows) {
      if (r.prevHash !== prev || eventHash(prev, r) !== r.hash) return { checked, brokenAtSeq: r.seq };
      prev = r.hash;
      after = r.seq;
      checked++;
    }
  }
}
