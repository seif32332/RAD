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
  const before = await tx.employee.findUniqueOrThrow({ where: { id: o.employeeId }, select: { basicSalary: true, jobTitle: true, jobTitleEnglish: true, branchId: true, contractEndDate: true } });
  const data: Prisma.EmployeeUncheckedUpdateInput = {};
  if (o.basicSalary !== null) data.basicSalary = o.basicSalary;
  if (o.jobTitle !== null) data.jobTitle = o.jobTitle;
  if (o.jobTitleEnglish !== null) data.jobTitleEnglish = o.jobTitleEnglish;
  if (o.branchId !== null) data.branchId = o.branchId;
  if (o.contractEndDate !== null) data.contractEndDate = o.contractEndDate;
  if (Object.keys(data).length) await tx.employee.update({ where: { id: o.employeeId }, data });
  const allowances: Record<string, { from: number; to: number }> = {};
  for (const [kind, amount] of [['HOUSING', o.housingAllowance], ['TRANSPORT', o.transportAllowance]] as const) {
    if (amount === null) continue;
    allowances[kind] = { from: await setMonthlyAllowance(tx, o.employeeId, kind, amount), to: amount };
  }
  if (o.basicSalary !== null) {
    await tx.salaryChange.create({
      data: { employeeId: o.employeeId, effectiveDate: o.effectiveDate, basicSalary: o.basicSalary, reason: `قرار ترقية/زيادة (${o.documentId})`, isPlanned: false, createdById: actorId },
    });
  }
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
 * Sets the employee's monthly housing / transport allowance (same classification as the payslip,
 * payroll-core allowanceLine): updates the one row of that kind, or adds it. Returns the old amount.
 * More than one row of the kind is refused (the addendum builder already refuses it at approval).
 */
async function setMonthlyAllowance(tx: Tx, employeeId: string, kind: 'HOUSING' | 'TRANSPORT', amount: number): Promise<number> {
  const rows = (await tx.allowance.findMany({ where: { employeeId, isMonthly: true }, select: { id: true, name: true, allowanceType: true, amount: true } }))
    .filter((a) => allowanceLine(a) === kind);
  if (rows.length > 1) throw new Error(`more than one monthly ${kind} allowance in the employee file`);
  if (rows.length === 1) {
    await tx.allowance.update({ where: { id: rows[0].id }, data: { amount } });
    return rows[0].amount;
  }
  await tx.allowance.create({
    data: { employeeId, name: kind === 'HOUSING' ? 'بدل سكن' : 'بدل نقل', amount, isMonthly: true, allowanceType: kind, countsTowardGosi: kind === 'HOUSING' },
  });
  return 0;
}

/** Applies every pending order whose effective date has come. Returns how many were applied. */
export async function applyDueChangeOrders(now = new Date()): Promise<number> {
  const due = await prisma.employeeChangeOrder.findMany({
    where: { appliedAt: null, cancelledAt: null, effectiveDate: { lte: riyadhEndOfToday(now) } },
    orderBy: { effectiveDate: 'asc' },
    select: { id: true },
    take: 500,
  });
  let applied = 0;
  for (const o of due) {
    try {
      if (await prisma.$transaction((tx) => applyChangeOrder(tx, o.id, null))) applied++;
    } catch (err) {
      // One order that cannot apply (the file changed since) does not block the others; it stays pending.
      console.error('[documents] change order not applied', o.id, err instanceof Error ? err.message : err);
    }
  }
  return applied;
}

/** Called in the issuance transaction of a decision: creates its order, applied now when due. */
export async function createChangeOrder(
  tx: Tx,
  input: {
    documentId: string; employeeId: string; effectiveDate: string; basicSalary: number | null; jobTitle: string | null; jobTitleEnglish: string | null;
    housingAllowance?: number | null; transportAllowance?: number | null; branchId?: string | null; contractEndDate?: string | null;
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
