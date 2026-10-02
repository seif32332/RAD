// Audit logging. Never throws: an audit failure must not break the business action.
import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { redact } from '@/modules/platform';

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

// Redaction is shared with the platform audit primitive: one list of sensitive keys.
export { isSensitiveKey, redact } from '@/modules/platform';

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
