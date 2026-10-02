// Operation keys and the transaction convention (P1-FND-EVT; LIFECYCLE_MODEL §2.1, §2.2).
//
//   runTransition(prisma, { key, operation, actorId }, async (tx) => {
//     …guarded state change (updateMany where status = FROM and version = V)…
//     …facts of the owning module…
//     await audit(tx, { … before, after … });
//     await emitEvent(tx, { … idempotencyKey: `${key}:<event type>` … });
//     return { id };
//   });
//
// One transaction: operation-key claim + transition + facts + audit + events. Side effects (mail,
// documents, integrations) are never run here; they are consumers of the events (dispatcher.ts).
import type { Prisma } from '@prisma/client';
import { assertTransactionClient, isUniqueViolation, toJson, type RootClient, type TxClient } from './tx';

export interface OperationSpec {
  /** HTTP Idempotency-Key, or derived from (user, entity, transition, entity version). */
  key: string;
  /** Operation name, e.g. `leave.request.approve`. */
  operation: string;
  actorId?: string | null;
  companyId?: string | null;
  /** Hash of the request body: the same key with a different fingerprint is refused. */
  fingerprint?: string | null;
}

export interface OperationOutcome<T> {
  /** JSON round-tripped (Dates become ISO strings, undefined becomes null), identical on first run and replay. */
  result: T;
  replayed: boolean;
  operationId: string;
}

export interface IdempotentOptions<T> {
  /** Short reference to the produced entity; defaults to `result.id` when it is a string. */
  ref?: (result: T) => string | null | undefined;
}

export class OperationKeyConflictError extends Error {
  constructor(key: string) {
    super(`Operation key "${key}" was already used for a different request (operation or fingerprint differs)`);
    this.name = 'OperationKeyConflictError';
  }
}

type OperationRow = {
  id: string;
  operation: string;
  fingerprint: string | null;
  result: Prisma.JsonValue;
  completedAt: Date | null;
};

function validateSpec(spec: OperationSpec) {
  if (!spec?.key?.trim()) throw new Error('operation key is required');
  if (!spec.operation?.trim()) throw new Error('operation name is required');
}

function replayOf<T>(spec: OperationSpec, row: OperationRow): OperationOutcome<T> {
  if (row.operation !== spec.operation || (spec.fingerprint != null && row.fingerprint != null && row.fingerprint !== spec.fingerprint)) {
    throw new OperationKeyConflictError(spec.key);
  }
  if (!row.completedAt) throw new Error(`Operation "${spec.key}" is recorded but not completed`);
  return { result: row.result as T, replayed: true, operationId: row.id };
}

function defaultRef(result: unknown): string | null {
  if (result && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'string') return (result as { id: string }).id;
  return null;
}

const ROW_SELECT = { id: true, operation: true, fingerprint: true, result: true, completedAt: true } as const;

/**
 * Runs `fn` once per operation key inside the caller's transaction. A repeated key returns the recorded
 * result without running `fn`. The key is claimed (INSERT) before `fn` runs, so a concurrent call with
 * the same key waits on the unique index and then fails with P2002, which aborts ITS transaction:
 * the caller retries (or uses runTransition, which does that and returns the recorded result).
 */
export async function idempotent<T>(
  tx: TxClient,
  spec: OperationSpec,
  fn: (tx: TxClient) => Promise<T>,
  options: IdempotentOptions<T> = {},
): Promise<OperationOutcome<T>> {
  assertTransactionClient(tx, 'idempotent');
  validateSpec(spec);
  const existing = await tx.operationLog.findUnique({ where: { operationKey: spec.key }, select: ROW_SELECT });
  if (existing) return replayOf<T>(spec, existing);

  const row = await tx.operationLog.create({
    data: {
      operationKey: spec.key,
      operation: spec.operation,
      actorId: spec.actorId ?? null,
      companyId: spec.companyId ?? null,
      fingerprint: spec.fingerprint ?? null,
    },
    select: { id: true },
  });
  const raw = await fn(tx);
  const stored = toJson(raw);
  await tx.operationLog.update({
    where: { id: row.id },
    data: {
      result: stored === null ? undefined : (stored as Prisma.InputJsonValue),
      resultRef: (options.ref ? options.ref(raw) : defaultRef(raw)) ?? null,
      completedAt: new Date(),
    },
  });
  return { result: stored as T, replayed: false, operationId: row.id };
}

export interface RunTransitionOptions<T> extends IdempotentOptions<T> {
  timeoutMs?: number;
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * The transaction convention: operation-key check + `fn` (transition, facts, audit, events) in ONE
 * transaction. Calling it twice with the same key, one after the other or concurrently, runs `fn` once;
 * every call gets the same result (`replayed` tells which one ran it).
 */
export async function runTransition<T>(
  prisma: RootClient,
  spec: OperationSpec,
  fn: (tx: TxClient) => Promise<T>,
  options: RunTransitionOptions<T> = {},
): Promise<OperationOutcome<T>> {
  validateSpec(spec);
  try {
    return await prisma.$transaction((tx) => idempotent(tx, spec, fn, options), {
      timeout: options.timeoutMs ?? 15_000,
      maxWait: options.maxWaitMs ?? 5_000,
      isolationLevel: options.isolationLevel,
    });
  } catch (err) {
    // A concurrent call with the same key committed first: return its recorded result. Any other unique
    // violation (from fn itself) has no committed operation row for this key and is rethrown.
    if (isUniqueViolation(err)) {
      const row = await prisma.operationLog.findUnique({ where: { operationKey: spec.key }, select: ROW_SELECT });
      if (row?.completedAt) return replayOf<T>(spec, row);
    }
    throw err;
  }
}
