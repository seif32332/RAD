// Transactional outbox (P1-FND-EVT; LIFECYCLE_MODEL §2.1, §2.4; ARCH-010).
// emitEvent writes a DomainEvent in the caller's transaction: the transition, its facts, its audit row
// and its event commit together or not at all. Consumers run later, from the dispatcher, never inside
// the producer transaction.
import type { Prisma } from '@prisma/client';
import { assertTransactionClient, toJson, type TxClient } from './tx';

/** `<domain>.<entity>.<pastTenseVerb>` (e.g. `leave.request.approved`), or `<domain>.<pastTenseVerb>` (e.g. `employment.hired`). */
export const EVENT_TYPE_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

export interface EmitEventInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  /** Unique across all events (ARCH-010). Derive it from the operation, e.g. `${operationKey}:leave.request.approved`. */
  idempotencyKey: string;
  /** Minimal payload: ids and values only, no surplus personal data (LIFECYCLE_MODEL §2.4). */
  payload: Record<string, unknown>;
  companyId?: string | null;
  actorId?: string | null;
  occurredAt?: Date;
  /** Business effective date (date only), when the transition has one. */
  effectiveDate?: Date | null;
}

export interface DomainEventRecord {
  id: string;
  seq: bigint;
  type: string;
  aggregateType: string;
  aggregateId: string;
  companyId: string | null;
  actorId: string | null;
  payload: Prisma.JsonValue;
  idempotencyKey: string;
  occurredAt: Date;
  effectiveDate: Date | null;
  recordedAt: Date;
}

export class EventKeyConflictError extends Error {
  constructor(key: string) {
    super(`DomainEvent idempotencyKey "${key}" already exists for a different event (type or aggregate differs)`);
    this.name = 'EventKeyConflictError';
  }
}

export function validateEventInput(input: EmitEventInput): void {
  if (!EVENT_TYPE_PATTERN.test(input.type)) {
    throw new Error(`Invalid event type "${input.type}": expected <domain>.<entity>.<pastTenseVerb>`);
  }
  if (!input.aggregateType?.trim()) throw new Error('emitEvent: aggregateType is required');
  if (!input.aggregateId?.trim()) throw new Error('emitEvent: aggregateId is required');
  if (!input.idempotencyKey?.trim()) throw new Error('emitEvent: idempotencyKey is required (ARCH-010)');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('emitEvent: payload must be an object');
  }
}

const EVENT_SELECT = {
  id: true, seq: true, type: true, aggregateType: true, aggregateId: true, companyId: true, actorId: true,
  payload: true, idempotencyKey: true, occurredAt: true, effectiveDate: true, recordedAt: true,
} as const;

/**
 * Records a domain event in the caller's transaction. Idempotent on `idempotencyKey`: emitting the same
 * key again returns the existing event (`created: false`) instead of a second row; the same key for a
 * different type or aggregate is refused.
 */
export async function emitEvent(
  tx: TxClient,
  input: EmitEventInput,
): Promise<{ event: DomainEventRecord; created: boolean }> {
  assertTransactionClient(tx, 'emitEvent');
  validateEventInput(input);
  // ON CONFLICT DO NOTHING: a duplicate key does not abort the caller's transaction.
  const { count } = await tx.domainEvent.createMany({
    data: [
      {
        type: input.type,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        idempotencyKey: input.idempotencyKey,
        payload: toJson(input.payload) as Prisma.InputJsonObject,
        companyId: input.companyId ?? null,
        actorId: input.actorId ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        effectiveDate: input.effectiveDate ?? null,
      },
    ],
    skipDuplicates: true,
  });
  const event = await tx.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey }, select: EVENT_SELECT });
  if (count === 0 && (event.type !== input.type || event.aggregateType !== input.aggregateType || event.aggregateId !== input.aggregateId)) {
    throw new EventKeyConflictError(input.idempotencyKey);
  }
  return { event, created: count === 1 };
}
