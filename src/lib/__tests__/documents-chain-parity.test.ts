// scripts/lib/document-chain.mjs (used by scripts/jobs.mjs, which cannot import TypeScript) must
// hash exactly like the application: a divergence would make the integrity job report a broken
// chain after every retention purge.
import { describe, expect, it } from 'vitest';
import { canonicalJson as tsCanonical } from '@/lib/documents/core';
import { eventHash as tsEventHash, GENESIS_HASH as TS_GENESIS } from '@/lib/documents/events';
import * as js from '../../../scripts/lib/document-chain.mjs';

const samples: unknown[] = [
  null, true, false, 0, -7, 9007199254740991, '', 'نص عربي', 'quote " and \\ backslash', '\u0000\u001f ',
  [], [1, 'a', null, [true]], {}, { b: 1, a: 2 }, { z: { y: { x: ['م', { k: 'v' }] } }, u: undefined, a: [undefined, 1] },
  { typeKey: 'SALARY_CERTIFICATE', data: { salary: { rows: [{ amount: '9500.00' }], total: '13500.50' } } },
];

describe('document chain: JS job helpers match the application', () => {
  it('canonicalJson is byte-identical', () => {
    for (const s of samples) expect(js.canonicalJson(s)).toBe(tsCanonical(s));
    expect(() => js.canonicalJson(1.5)).toThrow(/safe integers/);
  });

  it('eventHash is identical, from the same genesis', () => {
    expect(js.GENESIS_HASH).toBe(TS_GENESIS);
    const at = new Date('2026-09-26T09:00:00.123Z');
    for (const e of [
      { type: 'ISSUED', requestId: 'r1', documentId: 'd1', actorId: 'u1', ip: '10.0.0.1', metaJson: '{"number":"ACM-SAL-2026-000001"}', at },
      { type: 'PURGED', requestId: 'r1', documentId: 'd1', actorId: null, ip: null, metaJson: null, at },
    ]) {
      expect(js.eventHash('ab'.repeat(32), e)).toBe(tsEventHash('ab'.repeat(32), e));
    }
  });

  it('retention years: owner decision 10 by default, bounded', () => {
    expect(js.parseRetentionYears(undefined)).toBe(10);
    expect(js.parseRetentionYears('7')).toBe(7);
    expect(js.parseRetentionYears('0')).toBe(10);
    expect(js.parseRetentionYears('abc')).toBe(10);
    expect(js.isStoredDocumentName('2026/123e4567-e89b-12d3-a456-426614174000.pdf')).toBe(true);
    expect(js.isStoredDocumentName('../etc/passwd')).toBe(false);
  });
});
