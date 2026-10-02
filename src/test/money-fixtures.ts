// Test fixtures that write money rows directly (Payroll, Loan, Allowance…), which money.gateway refuses
// outside a registered operation (ARCH-004, BR-PAY-018). A test that needs such rows as FIXTURES (not
// as the behaviour under test) wraps the writes:
//
//   const loan = await moneyFixture((tx) => tx.loan.create({ data: { … } }));
//
// The operation `test.fixture.write` is registered by THIS file only, which application code never
// imports (money-gateway-static.test.ts refuses an import of src/test from src/app, src/lib, src/modules
// and src/jobs). It is a SYSTEM operation: no guard applies, the writes are recorded under its name.
import { randomUUID } from 'crypto';
import { MONEY_TABLES, defineMoneyOperation, runMoneyOperation, type TxClient } from '@/modules/platform';

const writes: Record<string, '*'> = Object.fromEntries([...MONEY_TABLES, 'Employee', 'OvertimeRequest'].map((t) => [t, '*']));

const TEST_FIXTURE = defineMoneyOperation<Record<string, never>>({
  name: 'test.fixture.write',
  owner: 'test',
  act: 'GENERATE',
  source: 'SYSTEM',
  writes,
});

/** Runs `fn` in one transaction inside the test fixture operation (money writes allowed). */
export async function moneyFixture<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const { prisma } = await import('@/lib/prisma');
  return prisma.$transaction(
    (tx) => runMoneyOperation(tx, TEST_FIXTURE, { actor: null, input: {}, operationKey: `test.fixture:${randomUUID()}` }, (t) => fn(t)),
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/**
 * A Payroll line as a fixture, with its company and month (9zf: every line carries both — CHECK
 * Payroll_companyId_required): the company is the employee's legal company unless given, and the
 * PayrollMonth row is created when missing. Call it inside moneyFixture.
 */
export async function payrollLineFixture<T extends { employeeId: string; year: number; month: number; companyId?: string | null }>(
  tx: TxClient,
  data: T & Record<string, unknown>,
) {
  const emp = await tx.employee.findUniqueOrThrow({ where: { id: data.employeeId }, select: { legalCompanyId: true, actualCompanyId: true } });
  const companyId = data.companyId ?? emp.legalCompanyId ?? emp.actualCompanyId;
  if (!companyId) throw new Error('payrollLineFixture: the employee has no company');
  const month = await tx.payrollMonth.upsert({
    where: { companyId_year_month: { companyId, year: data.year, month: data.month } },
    create: { companyId, year: data.year, month: data.month, status: 'CALCULATED' },
    update: {},
  });
  return tx.payroll.create({ data: { ...(data as Record<string, unknown>), companyId, payrollMonthId: month.id } as never });
}
