// Effects on DRAFT payroll lines, shared by generation, loans, deductions and the settlement approval.
// A draft line reserves what it pays (bonuses → compensation, overtime → time, deductions, loan
// installments); releasing a draft frees them. Only DRAFT lines are ever changed or deleted (an approved
// line is a fact, DOMAIN_MODEL §1.1). All of this runs inside the calling payroll operation's gateway
// context, except dropEmployeeDraftsFrom which is its own SYSTEM operation (called by the settlement).
// Idempotent by nature: guarded updateMany / deleteMany where status = DRAFT; a repeat finds nothing.
import { unlinkBonusesFromPayrolls } from '@/modules/compensation';
import { roundMoney } from '@/lib/money';
import { PAYROLL_STATUS } from '@/lib/constants';
import { parsePayrollMonthKey, payrollMonthKey } from '@/lib/payroll-core';
import { assertTransactionClient, runMoneyOperation, type TxClient } from '@/modules/platform';
import { unlinkOvertimeFromPayrolls } from '@/modules/time';
import { PAYROLL_DRAFTS_DROP } from '../operations';

type RefundKind = 'loan' | 'violation';

/**
 * A DRAFT line's net after one of its deductions (a released installment or violation) went away; the
 * matching breakdown column goes down too, so totalDeductions stays the sum of the stored columns.
 */
async function refundDraftLine(tx: TxClient, payrollId: string, amount: number, kind: RefundKind): Promise<void> {
  if (!(amount > 0)) return;
  const p = await tx.payroll.findUnique({
    where: { id: payrollId },
    select: { status: true, basicSalary: true, totalAllowances: true, overtimeCost: true, totalDeductions: true, loansDeduction: true, violationsDeduction: true },
  });
  if (!p || p.status !== PAYROLL_STATUS.DRAFT) return;
  const totalDeductions = Math.max(0, roundMoney(p.totalDeductions - amount));
  const netSalary = Math.max(0, roundMoney(p.basicSalary + p.totalAllowances + p.overtimeCost - totalDeductions));
  await tx.payroll.updateMany({
    where: { id: payrollId, status: PAYROLL_STATUS.DRAFT },
    data: {
      totalDeductions,
      netSalary,
      ...(kind === 'loan' ? { loansDeduction: Math.max(0, roundMoney(p.loansDeduction - amount)) } : {}),
      ...(kind === 'violation' ? { violationsDeduction: Math.max(0, roundMoney(p.violationsDeduction - amount)) } : {}),
    },
  });
}

/** A loan left the payroll (forgiven, settled): its installments leave the DRAFT lines, which are refunded. */
export async function releaseLoanInstallmentsFromDrafts(tx: TxClient, loanId: string): Promise<{ released: number }> {
  assertTransactionClient(tx, 'releaseLoanInstallmentsFromDrafts');
  const rows = await tx.loanInstallment.findMany({
    where: { loanId, OR: [{ payrollId: null }, { payroll: { status: PAYROLL_STATUS.DRAFT } }] },
    select: { id: true, payrollId: true, amount: true },
  });
  for (const r of rows) if (r.payrollId) await refundDraftLine(tx, r.payrollId, r.amount, 'loan');
  if (!rows.length) return { released: 0 };
  const res = await tx.loanInstallment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return { released: res.count };
}

/**
 * A violation stopped being payable (waived, rejected, referred, objected): the DRAFT line of its month
 * that reserved it is refunded and the reservation cleared. No-op once linked to an approved line.
 */
export async function releaseDeductionReservation(
  tx: TxClient,
  d: { id: string; employeeId: string; amount: number; payrollMonth: string | null; isLinkedToPayroll: boolean },
): Promise<{ released: boolean }> {
  assertTransactionClient(tx, 'releaseDeductionReservation');
  if (d.isLinkedToPayroll || !d.payrollMonth) return { released: false };
  const ym = parsePayrollMonthKey(d.payrollMonth);
  if (ym) {
    const draft = await tx.payroll.findFirst({ where: { employeeId: d.employeeId, month: ym.month, year: ym.year, status: PAYROLL_STATUS.DRAFT }, select: { id: true } });
    if (draft) await refundDraftLine(tx, draft.id, d.amount, 'violation');
  }
  const res = await tx.deduction.updateMany({ where: { id: d.id, isLinkedToPayroll: false, payrollMonth: { not: null } }, data: { payrollMonth: null } });
  return { released: res.count > 0 };
}

/**
 * Deletes DRAFT lines and frees everything they reserved: bonuses (compensation), overtime (time), the
 * month's deductions and the loan installments. Returns how many lines were deleted.
 */
export async function releaseDraftLines(tx: TxClient, payrollIds: readonly string[], operationKey: string): Promise<{ deleted: number }> {
  assertTransactionClient(tx, 'releaseDraftLines');
  if (!payrollIds.length) return { deleted: 0 };
  const drafts = await tx.payroll.findMany({ where: { id: { in: [...payrollIds] }, status: PAYROLL_STATUS.DRAFT }, select: { id: true, employeeId: true, month: true, year: true } });
  if (!drafts.length) return { deleted: 0 };
  const ids = drafts.map((d) => d.id);
  await unlinkBonusesFromPayrolls(tx, { payrollIds: ids, operationKey });
  await unlinkOvertimeFromPayrolls(tx, { payrollIds: ids, operationKey });
  const byMonth = new Map<string, string[]>();
  for (const d of drafts) {
    const key = payrollMonthKey(d.year, d.month);
    byMonth.set(key, [...(byMonth.get(key) ?? []), d.employeeId]);
  }
  for (const [key, employeeIds] of byMonth) {
    await tx.deduction.updateMany({ where: { employeeId: { in: employeeIds }, payrollMonth: key, isLinkedToPayroll: false }, data: { payrollMonth: null } });
  }
  await tx.loanInstallment.deleteMany({ where: { payrollId: { in: ids } } });
  const res = await tx.payroll.deleteMany({ where: { id: { in: ids }, status: PAYROLL_STATUS.DRAFT } });
  return { deleted: res.count };
}

/**
 * The settlement approval drops the employee's DRAFT lines from the settlement's last month on, in
 * every company (the settlement pays that month; later drafts must not exist). SYSTEM operation.
 */
export async function dropEmployeeDraftsFrom(
  tx: TxClient,
  input: { employeeId: string; year: number; month: number; operationKey: string },
): Promise<{ dropped: number; payrollIds: string[] }> {
  assertTransactionClient(tx, 'dropEmployeeDraftsFrom');
  return runMoneyOperation(tx, PAYROLL_DRAFTS_DROP, { actor: null, input: { employeeId: input.employeeId }, operationKey: `${input.operationKey}:payroll.drafts.drop` }, async (t) => {
    const drafts = await t.payroll.findMany({
      where: { employeeId: input.employeeId, status: PAYROLL_STATUS.DRAFT, OR: [{ year: { gt: input.year } }, { year: input.year, month: { gte: input.month } }] },
      select: { id: true },
    });
    const payrollIds = drafts.map((d) => d.id);
    const { deleted } = await releaseDraftLines(t, payrollIds, input.operationKey);
    return { dropped: deleted, payrollIds };
  });
}
