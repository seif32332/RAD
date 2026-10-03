// The Prisma extension of money.gateway (BR-PAY-018, BL-PAY-002; ARCH-004 "run-time refusal").
//
// Installed on the ONE client (src/lib/prisma.ts): only the extended client is exported and cached,
// so every scoped client (iam) and every transaction inherits it. On every operation:
//   - a model write that touches a money table, a protected money column, an identity table or column
//     (BL-PAY-005, tables.ts IDENTITY_*), or deletes a guarded table
//     (writes.ts, recursive over nested writes) must run inside a gateway context that allows it;
//   - raw SQL that modifies a protected table must run inside a context that allows it;
//   otherwise it throws MoneyGatewayViolationError (fail closed). Reads pass through untouched.
// The extension is a safety net under the owning module's transition and the gateway's guards
// (DOMAIN_BOUNDARIES §5.4.1 wording for the scope extension applies here too).
import { Prisma } from '@prisma/client';
import { HttpError } from '@/lib/http';
import { contextAllows, currentMoneyContext } from './context';
import { GUARDED_RAW_COLUMNS, GUARDED_TABLES, MONEY_GUARDED_DELETES, guardedColumnSpecs, isGuardedTable } from './tables';
import { RAW_OPERATIONS, WRITE_OPERATIONS, rawSqlText, rawWrites, writesOf, type Touch } from './writes';

/** A direct write outside the gateway (a bug: the caller must go through the owning module's transition). */
export class MoneyGatewayViolationError extends HttpError {
  readonly model: string;
  readonly columns: readonly string[] | '*';
  readonly operation: string;
  constructor(touch: Touch, operation: string, inOperation: string | null) {
    super(403, `كتابة مالية مرفوضة خارج بوابة المال (${touch.model}.${operation})`, {
      code: 'MONEY_GATEWAY_DIRECT_WRITE',
      model: touch.model,
      columns: touch.columns,
      operation,
      gatewayOperation: inOperation,
    });
    this.name = 'MoneyGatewayViolationError';
    this.model = touch.model;
    this.columns = touch.columns;
    this.operation = operation;
  }

  /** For logs and tests: which table / columns, which Prisma operation, which gateway operation. */
  get detail(): string {
    const cols = this.columns === '*' ? '' : ` (${this.columns.join(', ')})`;
    const inside = (this.details as { gatewayOperation?: string | null }).gatewayOperation;
    return `money.gateway: direct ${this.operation} on ${this.model}${cols} outside a gateway operation${inside ? ` (inside "${inside}", which does not allow it)` : ''}`;
  }
}

/** The protected part of a touch: null when it touches nothing protected. */
export function protectedPart(t: Touch): Touch | null {
  if (isGuardedTable(t.model)) return t;
  if (t.kind === 'delete' && MONEY_GUARDED_DELETES.includes(t.model)) return t;
  // Money columns (MONEY_COLUMNS) and the identity columns of BL-PAY-005 (IDENTITY_COLUMNS), each spec
  // with its own create / update reach.
  const specs = guardedColumnSpecs(t.model).filter((spec) => !(spec.on === 'update' && t.kind === 'create'));
  if (!specs.length) return null;
  if (t.columns === '*') return t.kind === 'delete' ? null : { ...t, columns: specs.flatMap((s) => [...s.columns]) };
  const written = t.columns;
  const hit = [...new Set(specs.flatMap((s) => written.filter((c) => s.columns.includes(c))))];
  return hit.length ? { ...t, columns: hit } : null;
}

/** Throws when a write is not allowed by the current gateway context. Exported for the unit tests. */
export function assertWriteAllowed(model: string | undefined, operation: string, args: unknown): void {
  let touches: Touch[];
  if (!model) {
    if (!RAW_OPERATIONS.has(operation)) return;
    touches = rawWrites(rawSqlText(operation, args), GUARDED_TABLES, GUARDED_RAW_COLUMNS);
  } else {
    if (!WRITE_OPERATIONS.has(operation)) return;
    touches = writesOf(model, operation, args);
  }
  if (!touches.length) return;
  const ctx = currentMoneyContext();
  for (const t of touches) {
    const p = protectedPart(t);
    if (p && !contextAllows(ctx, p.model, p.columns)) throw new MoneyGatewayViolationError(p, operation, ctx?.operation ?? null);
  }
}

export const moneyGatewayExtension = Prisma.defineExtension({
  name: 'money-gateway',
  query: {
    async $allOperations({ model, operation, args, query }) {
      assertWriteAllowed(model, operation, args);
      return query(args);
    },
  },
});
