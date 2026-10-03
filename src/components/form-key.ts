'use client';
// One operation key per opened form (BL-PAY-027, LIFECYCLE_MODEL §2.2): the money creations of
// /api/payroll-hub (overtime assignment, deduction, loan, bonus) require an Idempotency-Key, so a double
// click or a retry of the same form replays instead of creating the row twice. The key is generated
// when the form opens and renewed after a successful save (the next entry is a new operation); a
// failed save keeps it (nothing was recorded under it, the retry is the same operation).
import { useCallback, useState } from 'react';

/** A random UUID v4, also outside a secure context (crypto.randomUUID needs HTTPS or localhost). */
export function newOperationKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** [key, renew]: the Idempotency-Key of the opened form, and the renewal to call after a successful save. */
export function useFormKey(): [string, () => void] {
  const [key, setKey] = useState(newOperationKey);
  const renew = useCallback(() => setKey(newOperationKey()), []);
  return [key, renew];
}
