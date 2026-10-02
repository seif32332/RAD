// The recurring allowances of a compensation (pure, client-safe). One classification rule for every
// writer of a CompensationPeriod: the payslip line of an allowance is its type, else its name. It is the
// rule of allowanceLine() in src/lib/payroll-core.ts and of the SQL function effective_allowance_line of
// 9u (parity tested in __tests__/financial-change.test.ts); compensation keeps its own copy because it
// sits below payroll (DOMAIN_BOUNDARIES §5.3) and stores the line on the period at write time.
import { roundMoney, sumMoney } from '@/lib/money';
import type { CompensationAllowance } from '@/modules/platform';

export type AllowanceLine = CompensationAllowance['line'];

export function allowanceLineOf(allowanceType: string | null | undefined, name: string | null | undefined): AllowanceLine {
  const t = (allowanceType ?? '').toUpperCase();
  if (t === 'HOUSING' || t === 'TRANSPORT') return t;
  if (t) return 'OTHER';
  if (/سكن|housing/i.test(name ?? '')) return 'HOUSING';
  if (/نقل|مواصلات|transport/i.test(name ?? '')) return 'TRANSPORT';
  return 'OTHER';
}

/** A recurring allowance as a form or an import gives it. */
export interface RequestedAllowance {
  name: string;
  amount: number;
  countsTowardGosi: boolean;
  allowanceType: string | null;
}

/** The period items of requested allowances (amounts rounded to the halala; empty names and zero amounts dropped). */
export function toPeriodAllowances(rows: readonly RequestedAllowance[]): CompensationAllowance[] {
  return rows
    .filter((a) => a.name?.trim() && roundMoney(a.amount) > 0)
    .map((a) => ({
      name: a.name.trim(),
      line: allowanceLineOf(a.allowanceType, a.name),
      allowanceType: a.allowanceType ?? null,
      amount: roundMoney(a.amount),
      countsTowardGosi: !!a.countsTowardGosi,
    }));
}

const itemKey = (a: Pick<CompensationAllowance, 'name' | 'amount' | 'countsTowardGosi' | 'allowanceType'>) =>
  JSON.stringify([a.name.trim(), roundMoney(a.amount), !!a.countsTowardGosi, a.allowanceType ?? null]);

/** Same basic salary and the same allowances (ids and order ignored). */
export function sameCompensation(
  a: { basicSalary: number; allowances: readonly CompensationAllowance[] },
  b: { basicSalary: number; allowances: readonly CompensationAllowance[] },
): boolean {
  if (roundMoney(a.basicSalary) !== roundMoney(b.basicSalary)) return false;
  return a.allowances.map(itemKey).sort().join('|') === b.allowances.map(itemKey).sort().join('|');
}

/** Monthly total (basic + allowances) of a compensation, for display. */
export function monthlyTotal(c: { basicSalary: number; allowances: readonly { amount: number }[] }): number {
  return sumMoney([c.basicSalary, ...c.allowances.map((a) => a.amount)]);
}
