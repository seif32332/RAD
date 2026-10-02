// Shared pieces of the financial-change routes (P1-PAY-B, BR-PAY-009): the scoped loading of a request
// and the decision / cancellation through compensation (behind money.gateway). The scope is checked on
// the caller's scoped client (another company's request is "not found"); the transition runs on the root
// client because it locks the employee row with raw SQL (ADR-0002 #2), which a scoped client refuses.
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthUser } from '@/lib/auth';
import { notFound } from '@/lib/http';
import {
  cancelFinancialChange,
  decideFinancialChange,
  FINANCIAL_CHANGE_SELECT,
  financialChangeView,
  runCompensationTransaction,
  type FinancialChangeView,
} from '@/modules/compensation';
import { authz, scopedPrisma, type ScopeContext } from '@/modules/iam';
import { assertNoFinalizedPayrollFrom } from '@/modules/payroll';
import { moneyActorOf } from '@/modules/platform';

export type FinancialChangeAction = 'APPROVE' | 'REJECT' | 'CANCEL';

/** A request of the context's companies (404 otherwise), with the employee's name for the screens. */
export async function loadScopedChange(ctx: ScopeContext, id: string) {
  const db = scopedPrisma(ctx) as unknown as PrismaClient;
  const row = await db.employeeFinancialChange.findUnique({ where: { id }, select: FINANCIAL_CHANGE_SELECT });
  if (!row) throw notFound('طلب التغيير المالي غير موجود');
  return row;
}

/** Employee code and name of each request (one query), read through the caller's scoped client. */
export async function withEmployees(ctx: ScopeContext, rows: FinancialChangeView[]) {
  const db = scopedPrisma(ctx) as unknown as PrismaClient;
  const ids = [...new Set(rows.map((r) => r.employeeId))];
  const emps = ids.length
    ? await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true } })
    : [];
  const byId = new Map(emps.map((e) => [e.id, e]));
  return rows.map((r) => {
    const e = byId.get(r.employeeId);
    return { ...r, employee: e ? { id: e.id, code: e.employeeId, name: `${e.firstNameArabic} ${e.lastNameArabic}`.trim() } : null };
  });
}

/**
 * Approves, rejects or cancels one request of the context (the operation key: the caller's
 * Idempotency-Key, else one per request, user and action, so a double click replays).
 */
export async function actOnChange(
  user: AuthUser,
  ctx: ScopeContext,
  id: string,
  action: FinancialChangeAction,
  opts: { note?: string | null; idempotencyKey?: string | null; ipAddress?: string | null },
): Promise<{ change: FinancialChangeView; applied?: boolean; selfAct?: boolean; replayed: boolean }> {
  const row = await loadScopedChange(ctx, id);
  authz.assert(ctx, action === 'CANCEL' ? 'compensation.change.cancel' : 'compensation.change.decide', { companyId: row.companyId, employeeId: row.employeeId });
  const key = `financialChange.${action.toLowerCase()}:${id}:${user.id}${opts.idempotencyKey ? `:k:${opts.idempotencyKey.slice(0, 100)}` : ''}`;
  const actor = moneyActorOf(user);
  if (action === 'CANCEL') {
    const r = await runCompensationTransaction(prisma, (tx) => cancelFinancialChange(tx, { actor, changeId: id, reason: opts.note ?? null, operationKey: key, ipAddress: opts.ipAddress ?? null }));
    return { change: r.change, replayed: r.replayed };
  }
  const r = await runCompensationTransaction(prisma, (tx) =>
    decideFinancialChange(tx, {
      actor,
      changeId: id,
      decision: action,
      note: opts.note ?? null,
      operationKey: key,
      ipAddress: opts.ipAddress ?? null,
      assertEffectiveDateOpen: assertNoFinalizedPayrollFrom,
    }),
  );
  return { change: r.change, applied: r.applied, selfAct: r.selfAct, replayed: r.replayed };
}

export { financialChangeView };
