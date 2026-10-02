// The bank identity helpers of compensation (BR-PAY-006, BR-PAY-008): ONE normalization for every
// writer (src/lib/iban.ts normalizeIban, the SQL twin compensation_normalize_iban of 9zg), the
// fingerprint (sha256 hex of the normalized IBAN, the SQL twin compensation_iban_fingerprint) and the
// last 4. Server side only (node:crypto).
import { createHash } from 'node:crypto';
import { normalizeIban } from '@/lib/iban';

/** sha256 (hex) of the normalized IBAN; null for a blank value. */
export function ibanFingerprint(iban: string | null | undefined): string | null {
  const n = normalizeIban(iban ?? '');
  return n ? createHash('sha256').update(n, 'utf8').digest('hex') : null;
}

/** The last 4 characters of the normalized IBAN (null for a blank value). */
export function ibanLast4(iban: string | null | undefined): string | null {
  const n = normalizeIban(iban ?? '');
  return n.length >= 4 ? n.slice(-4) : null;
}

/** Masked display of a Saudi IBAN from its last 4 (24 characters: "SA", 18 stars, the last 4). */
export function maskedIban(last4: string | null | undefined): string | null {
  return last4 ? `SA${'*'.repeat(18)}${last4}` : null;
}
