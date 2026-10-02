// Redaction of secrets and bank details before anything enters an audit trail.
// Canonical copy: src/lib/audit.ts re-exports these for the legacy AuditLog writer.

/** Exact keys (case-insensitive) whose values must never be written into audit details. */
const REDACT_KEYS = new Set(
  [
    'password', 'passwordHash', 'newPassword', 'currentPassword', 'confirmPassword', 'oldPassword',
    'token', 'accessToken', 'refreshToken', 'sessionToken', 'secret', 'twoFactorSecret', 'apiKey',
    // Bank details: an IBAN / account number never enters the audit trail.
    'iban', 'ibanNumber', 'accountNumber',
  ].map((k) => k.toLowerCase()),
);
export const isSensitiveKey = (k: string) => REDACT_KEYS.has(k.toLowerCase());

/** Copy of `value` with every sensitive key's value replaced by '[REDACTED]' (nested up to depth 4). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}
