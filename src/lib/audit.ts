// Audit logging. Never throws: an audit failure must not break the business action.
import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export type AuditAction =
  | 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGIN_FAILED' | 'LOGOUT' | 'APPROVE' | 'REJECT' | 'VIEW' | 'EXPORT' | 'IMPORT'
  /** Closing a case file (e.g. an investigation after its verdict): distinct from an approval. */
  | 'CLOSE';

export interface AuditEntry {
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  details?: unknown;
  ipAddress?: string | null;
}

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

export async function logAudit(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
  try {
    const client = tx ?? prisma;
    let details: string | null = null;
    if (entry.details !== undefined) {
      details = typeof entry.details === 'string' ? entry.details : JSON.stringify(redact(entry.details));
      if (details.length > 10_000) details = details.slice(0, 10_000);
    }
    await client.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        details,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  } catch (err) {
    console.error('[audit] failed to write audit log:', err);
  }
}
