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
import { IDENTITY_TABLES, MONEY_TABLES, defineMoneyOperation, runMoneyOperation, type TxClient } from '@/modules/platform';

// BL-PAY-005: the identity tables and columns (User control / credential columns, Employee.userId) too.
const writes: Record<string, '*'> = Object.fromEntries([...MONEY_TABLES, ...IDENTITY_TABLES, 'Employee', 'OvertimeRequest', 'User'].map((t) => [t, '*']));

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

/**
 * An employee WITH PAY as a fixture (P1-PAY-B: money.gateway refuses the pay columns on an employee
 * CREATE outside compensation). The row is created inside the fixture operation, then given the legacy
 * openings a migrated employee has (9u / 9zg, through the single writer effective_open_legacy_period):
 * a CompensationPeriod (basic salary + the recurring allowances created with it) from the join date,
 * and a BankIdentityPeriod (IBAN or cash). payrollReady defaults to true, like an existing employee.
 * So payroll reads the fixture's pay from the facts, as it does for a real tenant.
 */
export async function employeeFixture<T extends Record<string, unknown>>(data: T, opts: { openings?: boolean } = {}) {
  const { openLegacyPeriod } = await import('@/modules/platform');
  const { ibanFingerprint, ibanLast4 } = await import('@/modules/compensation');
  const { normalizeIban } = await import('@/lib/iban');
  return moneyFixture(async (tx) => {
    const emp = await tx.employee.create({ data: { payrollReady: true, ...(data as Record<string, unknown>) } as never });
    if (opts.openings === false) return emp; // a test of the period primitive opens its own periods
    const actor = { type: 'SYSTEM' as const, id: 'test.employeeFixture' };
    const from = emp.joinDate.toISOString().slice(0, 10);
    const to = emp.isTerminated && emp.terminationDate ? new Date(emp.terminationDate.getTime() + 86_400_000).toISOString().slice(0, 10) : null;
    if (emp.basicSalary > 0 && (!to || to > from)) {
      const recurring = await tx.allowance.findMany({ where: { employeeId: emp.id, isMonthly: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const { allowanceLineOf } = await import('@/modules/compensation');
      await openLegacyPeriod(
        tx,
        'COMPENSATION',
        {
          employeeId: emp.id,
          validFrom: from,
          validTo: to,
          attrs: {
            basicSalary: Math.round(emp.basicSalary * 100) / 100,
            allowances: recurring.map((a) => ({ allowanceId: a.id, name: a.name, allowanceType: a.allowanceType, line: allowanceLineOf(a.allowanceType, a.name), amount: Math.round(a.amount * 100) / 100, countsTowardGosi: a.countsTowardGosi })),
          },
        },
        actor,
      );
    }
    const iban = normalizeIban(emp.ibanNumber ?? '');
    if (emp.salaryPaymentMethod === 'CASH') {
      await openLegacyPeriod(tx, 'BANK_IDENTITY', { employeeId: emp.id, validFrom: from, attrs: { paymentMethod: 'CASH', bankName: emp.bankName } }, actor);
    } else if (iban) {
      await openLegacyPeriod(
        tx,
        'BANK_IDENTITY',
        { employeeId: emp.id, validFrom: from, attrs: { paymentMethod: emp.salaryPaymentMethod, bankName: emp.bankName, ibanEncrypted: iban, ibanFingerprint: ibanFingerprint(iban), ibanLast4: ibanLast4(iban) } },
        actor,
      );
    }
    return emp;
  });
}

/**
 * A login linked to an employee file as a fixture (BL-PAY-005: Employee.userId is the projection of a
 * UserEmployeeLink and an identity column money.gateway guards): the access link and its LEGACY_LINKED row.
 */
export async function linkFixture(userId: string, employeeId: string): Promise<void> {
  await moneyFixture(async (tx) => {
    await tx.employee.update({ where: { id: employeeId }, data: { userId } });
    await tx.userEmployeeLink.create({ data: { userId, employeeId, status: 'LEGACY_LINKED', legacy: true } });
  });
}

/** Identity columns of a user as a fixture (e.g. the TENANT_ROOT that only Radeef's vendor panel marks, BL-PAY-017). */
export async function identityFixture(userId: string, data: Record<string, unknown>): Promise<void> {
  await moneyFixture((tx) => tx.user.update({ where: { id: userId }, data: data as never }));
}

/**
 * TENANT_ROOT as a fixture (DEC-PO-016: one per database; only Radeef's vendor panel marks it, BL-PAY-017).
 * Test files run in parallel on one database: a file HOLDS the root mark for the tests that need it (waiting
 * while another file holds it) and releases it in a finally block.
 */
export async function holdTenantRoot(userId: string, timeoutMs = 240_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await identityFixture(userId, { tenantRoot: true, rootSuspendedAt: null });
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function releaseTenantRoot(userId: string): Promise<void> {
  await identityFixture(userId, { tenantRoot: false, rootSuspendedAt: null });
}

/**
 * UserCompanyScope rows as a fixture (BL-PAY-021: the scope decides where a counted approver counts, so it is an
 * identity table only iam.setUserCompanyScope writes in the application; tests write their fixtures here).
 */
export const scopeFixture = {
  create: (args: Parameters<TxClient['userCompanyScope']['create']>[0]) => moneyFixture((tx) => tx.userCompanyScope.create(args)),
  createMany: (args: Parameters<TxClient['userCompanyScope']['createMany']>[0]) => moneyFixture((tx) => tx.userCompanyScope.createMany(args)),
};
