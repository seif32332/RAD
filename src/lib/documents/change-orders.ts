// Execution orders of promotion / salary-increase decisions (owner decision 2026-09-26: the approved
// decision letter carries out the change). An order is created when the decision is issued and is
// applied to the employee file exactly once, on its effective date: at issuance when already due,
// otherwise by applyDueChangeOrders (nightly job, the documents list, and before payroll generation,
// so a due raise is never missed by a payroll run). Revoking the decision before then cancels it.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
import { allowanceLine } from '@/lib/payroll-core';
import { scopeWhere, type ScopeContext, type SystemContext } from '@/modules/iam';
import type { JobDefinition } from '@/modules/platform';
import { applyChangeOrderPay } from '@/modules/compensation';

type Tx = Prisma.TransactionClient;

/** End of the given Riyadh calendar day (orders dated today are due today). */
function riyadhEndOfToday(now = new Date()): Date {
  const day = new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
  return new Date(`${day}T23:59:59.999+03:00`);
}

/** Applies one order if still pending (atomic guard: never twice, never after cancellation). */
export async function applyChangeOrder(tx: Tx, orderId: string, actorId: string | null): Promise<boolean> {
  const moved = await tx.employeeChangeOrder.updateMany({
    where: { id: orderId, appliedAt: null, cancelledAt: null },
    data: { appliedAt: new Date() },
  });
  if (moved.count !== 1) return false;
  const o = await tx.employeeChangeOrder.findUniqueOrThrow({ where: { id: orderId } });
  const before = await tx.employee.findUniqueOrThrow({ where: { id: o.employeeId }, select: { basicSalary: true, jobTitle: true, jobTitleEnglish: true, branchId: true, contractEndDate: true, departmentId: true, directManagerId: true } });
  const data: Prisma.EmployeeUncheckedUpdateInput = {};
  if (o.jobTitle !== null) data.jobTitle = o.jobTitle;
  if (o.jobTitleEnglish !== null) data.jobTitleEnglish = o.jobTitleEnglish;
  if (o.branchId !== null) data.branchId = o.branchId;
  if (o.contractEndDate !== null) data.contractEndDate = o.contractEndDate;
  if (o.departmentId !== null) data.departmentId = o.departmentId;
  if (o.directManagerId !== null) data.directManagerId = o.directManagerId;
  if (Object.keys(data).length) await tx.employee.update({ where: { id: o.employeeId }, data });
  // The pay part (basic salary, housing / transport, the SalaryChange row) is written by compensation
  // behind money.gateway (P1-PAY-A, BL-PAY-003 note: a named SYSTEM operation, no parallel salary path).
  const rows: Array<{ kind: 'HOUSING' | 'TRANSPORT'; rowId: string | null; amount: number }> = [];
  for (const [kind, amount] of [['HOUSING', o.housingAllowance], ['TRANSPORT', o.transportAllowance]] as const) {
    if (amount !== null) rows.push({ kind, rowId: await monthlyAllowanceRowId(tx, o.employeeId, kind), amount });
  }
  const { allowances } = await applyChangeOrderPay(tx, {
    employeeId: o.employeeId,
    orderId: o.id,
    documentId: o.documentId,
    effectiveDate: o.effectiveDate,
    basicSalary: o.basicSalary,
    allowances: rows,
    triggeredById: actorId,
  });
  if (o.basicSalary !== null) data.basicSalary = o.basicSalary; // for the audit entry below
  await logAudit(
    {
      userId: actorId,
      action: 'UPDATE',
      entityType: 'Employee',
      entityId: o.employeeId,
      details: { source: 'EmployeeChangeOrder', orderId: o.id, documentId: o.documentId, before, after: data, allowances },
    },
    tx,
  );
  return true;
}

/**
 * The employee's one monthly housing / transport allowance row (same classification as the payslip,
 * payroll-core allowanceLine), or null when there is none (compensation adds it). More than one row of
 * the kind is refused (the addendum builder already refuses it at approval).
 */
async function monthlyAllowanceRowId(tx: Tx, employeeId: string, kind: 'HOUSING' | 'TRANSPORT'): Promise<string | null> {
  const rows = (await tx.allowance.findMany({ where: { employeeId, isMonthly: true }, select: { id: true, name: true, allowanceType: true, amount: true } }))
    .filter((a) => allowanceLine(a) === kind);
  if (rows.length > 1) throw new Error(`more than one monthly ${kind} allowance in the employee file`);
  return rows[0]?.id ?? null;
}

/**
 * Pending orders whose effective date has come (at most 500, oldest first). With a context: only the
 * orders whose decision letter was issued by one of its companies (IssuedDocument.legalCompanyId).
 */
export async function dueChangeOrderIds(now = new Date(), ctx?: ScopeContext): Promise<string[]> {
  const due = await prisma.employeeChangeOrder.findMany({
    where: { appliedAt: null, cancelledAt: null, effectiveDate: { lte: riyadhEndOfToday(now) } },
    orderBy: { effectiveDate: 'asc' },
    select: { id: true, documentId: true },
  });
  let ids = due;
  const company = ctx ? scopeWhere(ctx, 'IssuedDocument') : null;
  if (company && due.length) {
    const docs = await prisma.issuedDocument.findMany({ where: { AND: [{ id: { in: due.map((o) => o.documentId) } }, company] }, select: { id: true } });
    const inScope = new Set(docs.map((d) => d.id));
    ids = due.filter((o) => inScope.has(o.documentId));
  }
  return ids.slice(0, 500).map((o) => o.id);
}

/** Applies the given orders, each in its own transaction (applyChangeOrder: never twice). */
export async function applyChangeOrders(ids: readonly string[]): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      if (await prisma.$transaction((tx) => applyChangeOrder(tx, id, null))) applied++;
    } catch (err) {
      // One order that cannot apply (the file changed since) does not block the others; it stays pending.
      failed++;
      console.error('[documents] change order not applied', id, err instanceof Error ? err.message : err);
    }
  }
  return { applied, failed };
}

/** Applies every pending order whose effective date has come. Returns how many were applied. */
export async function applyDueChangeOrders(now = new Date()): Promise<number> {
  return (await applyChangeOrders(await dueChangeOrderIds(now))).applied;
}

/**
 * Job apply-employee-changes (P1-FND-JOBS): company by company, the due orders are applied by the
 * same applyChangeOrder as issuance, the documents list and payroll generation.
 */
export const applyEmployeeChangesJob: JobDefinition<SystemContext> = {
  name: 'apply-employee-changes',
  description: 'Applies promotion / salary decisions whose effective date has come, company by company',
  crossCompany: false,
  async run(ctx) {
    const byCompany = await ctx.forEachCompany(async (scope) => {
      const ids = await dueChangeOrderIds(ctx.now, scope);
      if (ctx.dryRun) return { due: ids.length, applied: 0, failed: 0 };
      return { due: ids.length, ...(await applyChangeOrders(ids)) };
    });
    const rows = Object.values(byCompany);
    const sum = (k: 'due' | 'applied' | 'failed') => rows.reduce((s, r) => s + r[k], 0);
    return { companies: rows.length, due: sum('due'), applied: sum('applied'), failed: sum('failed'), ...(ctx.dryRun ? { dryRun: true } : {}), byCompany };
  },
};

/** Called in the issuance transaction of a decision: creates its order, applied now when due. */
export async function createChangeOrder(
  tx: Tx,
  input: {
    documentId: string; employeeId: string; effectiveDate: string; basicSalary: number | null; jobTitle: string | null; jobTitleEnglish: string | null;
    housingAllowance?: number | null; transportAllowance?: number | null; branchId?: string | null; contractEndDate?: string | null;
    departmentId?: string | null; directManagerId?: string | null;
  },
  actorId: string | null,
): Promise<void> {
  const effective = new Date(`${input.effectiveDate}T00:00:00+03:00`);
  const o = await tx.employeeChangeOrder.create({
    data: {
      employeeId: input.employeeId, documentId: input.documentId, effectiveDate: effective,
      basicSalary: input.basicSalary, jobTitle: input.jobTitle, jobTitleEnglish: input.jobTitleEnglish,
      housingAllowance: input.housingAllowance ?? null, transportAllowance: input.transportAllowance ?? null, branchId: input.branchId ?? null,
      contractEndDate: input.contractEndDate ? new Date(`${input.contractEndDate}T00:00:00+03:00`) : null,
      departmentId: input.departmentId ?? null, directManagerId: input.directManagerId ?? null,
    },
  });
  if (effective <= riyadhEndOfToday()) await applyChangeOrder(tx, o.id, actorId);
}

/**
 * Revoking / superseding a decision: a pending order is cancelled. An order already applied cannot
 * be undone by revoking the letter (the employee file changed): the caller refuses the revocation.
 */
export async function cancelChangeOrder(tx: Tx, documentId: string): Promise<'CANCELLED' | 'APPLIED' | 'NONE'> {
  const o = await tx.employeeChangeOrder.findUnique({ where: { documentId }, select: { appliedAt: true, cancelledAt: true } });
  if (!o) return 'NONE';
  if (o.appliedAt) return 'APPLIED';
  if (!o.cancelledAt) await tx.employeeChangeOrder.updateMany({ where: { documentId, appliedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
  return 'CANCELLED';
}
