// Document engine helpers for scripts/jobs.mjs (plain JS: releases ship scripts/, not src/).
//
// canonicalJson and eventHash MUST give byte-identical results to src/lib/documents/core.ts and
// src/lib/documents/events.ts: src/lib/__tests__/documents-chain-parity.test.ts compares them on
// many inputs, so any divergence fails the unit tests.
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);
/** Same key as src/lib/documents/events.ts (serializes writers of the chain). */
export const CHAIN_LOCK = 7_314_001;

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

/** Appends one event in the given interactive transaction (same algorithm as appendEvent in TS). */
export async function appendEvent(tx, { type, requestId = null, documentId = null, meta = null }) {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`);
  const last = await tx.documentEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const prevHash = last ? last.hash : GENESIS_HASH;
  const row = { type, requestId, documentId, actorId: null, ip: null, metaJson: meta ? canonicalJson(meta) : null, at: new Date() };
  await tx.documentEvent.create({ data: { ...row, prevHash, hash: eventHash(prevHash, row) } });
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

/** Retention in years from SystemSetting `document_retention_years` (owner decision: 10; bounds 1..50). */
export function parseRetentionYears(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 10;
}
