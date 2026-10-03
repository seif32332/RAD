// Audit primitive (P1-FND-AUDIT): before/after values, written in the operation's own transaction into
// the append-only AuditRecord table (UPDATE/DELETE/TRUNCATE refused by trigger, migration 9t).
// Unlike the legacy logAudit (src/lib/audit.ts), a failure here is NOT swallowed: it aborts the
// transaction, so a sensitive operation never commits without its audit row.
import type { Prisma } from '@prisma/client';
import { redact } from './redact';
import { assertTransactionClient, toJson, type TxClient } from './tx';

export type AuditActor =
  | { type: 'USER'; id: string }
  /** A job or the system itself; `id` names it (e.g. the job name). */
  | { type: 'SYSTEM'; id?: string | null };

export interface AuditInput {
  actor: AuditActor;
  /** Verb, e.g. CREATE, UPDATE, APPROVE, leave.request.approve. */
  action: string;
  entity: { type: string; id?: string | null; companyId?: string | null };
  /** State before the change (null for a creation). Secrets and bank details are redacted. */
  before?: unknown;
  /** State after the change (null for a removal). */
  after?: unknown;
  reason?: string | null;
  /** The operation key of the transition that produced this row, when there is one. */
  operationKey?: string | null;
  ipAddress?: string | null;
}

/** JSON first (Dates become ISO strings), then redact. Absent or null becomes SQL NULL. */
function auditJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const json = redact(toJson(value));
  return json === null ? undefined : (json as Prisma.InputJsonValue);
}

export async function audit(tx: TxClient, input: AuditInput): Promise<{ id: string }> {
  assertTransactionClient(tx, 'audit');
  if (!input.action?.trim()) throw new Error('audit: action is required');
  if (!input.entity?.type?.trim()) throw new Error('audit: entity.type is required');
  if (input.actor?.type !== 'USER' && input.actor?.type !== 'SYSTEM') throw new Error('audit: actor.type must be USER or SYSTEM');
  if (input.actor.type === 'USER' && !input.actor.id?.trim()) throw new Error('audit: a USER actor needs an id');
  return tx.auditRecord.create({
    data: {
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      action: input.action,
      entityType: input.entity.type,
      entityId: input.entity.id ?? null,
      companyId: input.entity.companyId ?? null,
      before: auditJson(input.before),
      after: auditJson(input.after),
      reason: input.reason ?? null,
      operationKey: input.operationKey ?? null,
      ipAddress: input.ipAddress ?? null,
    },
    select: { id: true },
  });
}

/** One row of an entity's audit trail (AuditRecord), for the modules' rules that must look at history. */
export interface AuditTrailRow {
  id: string;
  action: string;
  actorId: string | null;
  occurredAt: Date;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
}

/**
 * The audit trail of one entity, newest first (AuditRecord is platform's table: other modules read it here,
 * ARCH-001). BL-PAY-005 reads who changed an account's email or role before an attestation.
 */
export async function auditTrailOf(
  db: Prisma.TransactionClient,
  q: { entityType: string; entityId: string; actions?: readonly string[]; actorId?: string },
  take = 200,
): Promise<AuditTrailRow[]> {
  return db.auditRecord.findMany({
    where: { entityType: q.entityType, entityId: q.entityId, ...(q.actions ? { action: { in: [...q.actions] } } : {}), ...(q.actorId ? { actorId: q.actorId } : {}) },
    orderBy: { seq: 'desc' },
    take,
    select: { id: true, action: true, actorId: true, occurredAt: true, before: true, after: true },
  });
}

/** One row of the legacy AuditLog (details is the JSON text the legacy logAudit wrote). */
export interface LegacyAuditRow {
  id: string;
  action: string;
  userId: string | null;
  createdAt: Date;
  details: string | null;
}

/** The legacy AuditLog rows of one entity, newest first (append-only, ADR-0003). */
export async function legacyAuditOf(
  db: Prisma.TransactionClient,
  q: { entityType: string; entityId: string; userId?: string },
  take = 200,
): Promise<LegacyAuditRow[]> {
  return db.auditLog.findMany({
    where: { entityType: q.entityType, entityId: q.entityId, ...(q.userId ? { userId: q.userId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: { id: true, action: true, userId: true, createdAt: true, details: true },
  });
}
