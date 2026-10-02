// Transaction-client helpers for the platform primitives.
import type { Prisma, PrismaClient } from '@prisma/client';

/** A client bound to an open interactive transaction (the `tx` of `prisma.$transaction(async (tx) => …)`). */
export type TxClient = Prisma.TransactionClient;

/** The root client (owns the connection pool and can open transactions). */
export type RootClient = PrismaClient;

export class NotInTransactionError extends Error {
  constructor(what: string) {
    super(`${what} must be called with a transaction client (the tx of prisma.$transaction), not the root client`);
    this.name = 'NotInTransactionError';
  }
}

/**
 * Refuses the root client. The transition, its facts, its audit row and its event commit together or
 * not at all (LIFECYCLE_MODEL §2.1), so these writes are only accepted inside a transaction.
 * `PrismaClient` is structurally assignable to `TransactionClient`, hence the runtime check: only the
 * root client has `$transaction`.
 */
export function assertTransactionClient(client: unknown, what: string): asserts client is TxClient {
  if (!client || typeof client !== 'object') throw new NotInTransactionError(what);
  if (typeof (client as { $transaction?: unknown }).$transaction === 'function') throw new NotInTransactionError(what);
}

/** Prisma's unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

/** JSON round-trip: what a Json column stores and returns (Dates become ISO strings, undefined becomes null). */
export function toJson(value: unknown): Prisma.JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.JsonValue;
}
