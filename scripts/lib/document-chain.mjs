// Read-only document-chain helpers for scripts/lib/reconciliation-checks.mjs (plain JS: the
// reconciliation report scripts/reconcile-report.mjs runs with plain node).
//
// The background jobs no longer use this file: since P1-FND-JOBS they run the application's own code
// (src/lib/documents/events.ts, src/lib/documents/jobs.ts). What stays here is read-only (hashing and
// walking the chain), and canonicalJson / eventHash MUST give byte-identical results to
// src/lib/documents/core.ts and src/lib/documents/events.ts: src/lib/__tests__/documents-chain-parity.test.ts
// compares them. Retire this file when the reconciliation rules move behind the documents module.
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`canonicalJson: only safe integers are allowed (got ${value}); use decimal strings`);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

export function eventHash(prevHash, e) {
  return sha256Hex(prevHash + canonicalJson({
    type: e.type, requestId: e.requestId, documentId: e.documentId, actorId: e.actorId, ip: e.ip, meta: e.metaJson, at: e.at.toISOString(),
  }));
}

/** Walks the whole chain; returns { checked, brokenAtSeq } (brokenAtSeq null when intact). */
export async function verifyEventChain(db, batch = 1000) {
  let prev = GENESIS_HASH;
  let after = null;
  let checked = 0;
  for (;;) {
    const rows = await db.documentEvent.findMany({ where: after === null ? {} : { seq: { gt: after } }, orderBy: { seq: 'asc' }, take: batch });
    if (!rows.length) return { checked, brokenAtSeq: null };
    for (const r of rows) {
      if (r.prevHash !== prev || eventHash(prev, r) !== r.hash) return { checked, brokenAtSeq: String(r.seq) };
      prev = r.hash;
      after = r.seq;
      checked += 1;
    }
  }
}

const STORED_DOC_RE = /^\d{4}\/[0-9a-f-]{36}\.pdf$/;
export const isStoredDocumentName = (name) => typeof name === 'string' && STORED_DOC_RE.test(name);
