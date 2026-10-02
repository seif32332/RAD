// BL-PAY-024 (the extended gateway spike, RT-PAY-508) and BL-PAY-002 (x-security-money-gateway): on a
// REAL PostgreSQL, every write shape of BR-PAY-018 is intercepted by the extension of the one client
// (src/lib/prisma.ts), outside a gateway operation it is refused, inside one it passes, and the
// AsyncLocalStorage context holds inside interactive and batch transactions without leaking.
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.env.PAY_IT !== '1')('money.gateway extension on Postgres (BL-PAY-024 spike, BL-PAY-002)', async () => {
  if (process.env.PAY_IT !== '1') return;
  const { prisma } = await import('@/lib/prisma');
  const { Prisma } = await import('@prisma/client');
  const platform = await import('@/modules/platform');
  const { defineMoneyOperation, runMoneyOperation, MoneyGatewayViolationError, currentMoneyContext } = platform;
  const iam = await import('@/modules/iam');

  const tag = randomUUID().slice(0, 8);
  const OP = defineMoneyOperation<Record<string, never>>({
    name: `test.spike${tag.replace(/[^a-z]/g, 'x')}.write`,
    owner: 'test',
    act: 'GENERATE',
    source: 'SYSTEM',
    writes: { Loan: '*', LoanInstallment: '*', Allowance: '*', Payroll: '*', Employee: ['basicSalary'], OvertimeRequest: ['paidInPayrollId'] },
  });
  const LOAN_ONLY = defineMoneyOperation<Record<string, never>>({
    name: `test.spike${tag.replace(/[^a-z]/g, 'x')}.loanOnly`,
    owner: 'test',
    act: 'GENERATE',
    source: 'SYSTEM',
    writes: { Loan: ['remainingAmount'] },
  });
  const inOp = <T>(fn: (tx: import('@/modules/platform').TxClient) => Promise<T>, op = OP) =>
    prisma.$transaction((tx) => runMoneyOperation(tx, op, { actor: null, input: {}, operationKey: `spike:${randomUUID()}` }, (t) => fn(t)));

  const company = await prisma.company.create({ data: { nameArabic: `شركة المال ${tag}`, commercialRegNum: `MG${tag}`, commercialRegExp: new Date('2030-01-01') } });
  let n = 0;
  const employee = (over: Record<string, unknown> = {}) =>
    prisma.employee.create({
      data: {
        employeeId: `MG-${tag}-${++n}`, firstNameArabic: 'موظف', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `MG${tag}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 5000, legalCompanyId: company.id, actualCompanyId: company.id, ...over,
      },
    });
  const e = await employee();
  const loanData = () => ({ employeeId: e.id, amount: 1000, monthlyInstallment: 100, remainingAmount: 1000, status: 'PENDING' });
  const refused = async (p: Promise<unknown>, model: string) => {
    const err = await p.then(() => null, (x: unknown) => x);
    expect(err, `expected a refusal on ${model}`).toBeInstanceOf(MoneyGatewayViolationError);
    expect((err as InstanceType<typeof MoneyGatewayViolationError>).model).toBe(model);
  };

  it('refuses every direct model write shape on a money table (create, createMany, createManyAndReturn, update, updateMany, upsert, delete, deleteMany)', async () => {
    const loan = await inOp((tx) => tx.loan.create({ data: loanData() }));
    await refused(prisma.loan.create({ data: loanData() }), 'Loan');
    await refused(prisma.loan.createMany({ data: [loanData()] }), 'Loan');
    await refused(prisma.loan.createManyAndReturn({ data: [loanData()] }), 'Loan');
    await refused(prisma.loan.update({ where: { id: loan.id }, data: { remainingAmount: 1 } }), 'Loan');
    await refused(prisma.loan.updateMany({ where: { id: loan.id }, data: { remainingAmount: 1 } }), 'Loan');
    await refused(prisma.loan.upsert({ where: { id: loan.id }, create: loanData(), update: { remainingAmount: 1 } }), 'Loan');
    await refused(prisma.loan.delete({ where: { id: loan.id } }), 'Loan');
    await refused(prisma.loan.deleteMany({ where: { id: loan.id } }), 'Loan');
    const still = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(still.remainingAmount).toBe(1000);
  });

  it('walks nested writes from any model over the relations (DMMF), including connect from the one side', async () => {
    await refused(
      prisma.employee.create({
        data: {
          employeeId: `MG-${tag}-n${++n}`, firstNameArabic: 'م', lastNameArabic: 'ن', nationality: 'SA', iqamaOrIdNumber: `MGN${tag}${n}`,
          iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'), basicSalary: 1,
          allowances: { create: [{ name: 'سكن', amount: 100 }] },
        },
      }),
      'Allowance',
    );
    await refused(prisma.employee.update({ where: { id: e.id }, data: { loans: { create: { amount: 5, monthlyInstallment: 5, remainingAmount: 5 } } } }), 'Loan');
    await refused(prisma.employee.update({ where: { id: e.id }, data: { loans: { deleteMany: {} } } }), 'Loan');
    const loan = await inOp((tx) => tx.loan.create({ data: loanData() }));
    await refused(prisma.employee.update({ where: { id: e.id }, data: { loans: { connect: { id: loan.id } } } }), 'Loan');
  });

  it('refuses raw SQL that modifies a money table (executeRaw, executeRawUnsafe, queryRaw, queryRawUnsafe) and lets reads and row locks through', async () => {
    await refused(prisma.$executeRawUnsafe(`UPDATE "Loan" SET "remainingAmount" = 0 WHERE "employeeId" = $1`, e.id), 'Loan');
    await refused(prisma.$executeRaw`DELETE FROM "Payroll" WHERE "employeeId" = ${e.id}`, 'Payroll');
    await refused(prisma.$queryRaw(Prisma.sql`WITH x AS (UPDATE "Allowance" SET amount = 0 WHERE id = 'none' RETURNING id) SELECT count(*) FROM x`), 'Allowance');
    await refused(prisma.$queryRawUnsafe(`INSERT INTO "LoanInstallment" (id, "loanId", month, year, amount) VALUES ('x', 'y', 1, 2026, 1) RETURNING id`), 'LoanInstallment');
    await refused(prisma.$executeRawUnsafe(`UPDATE "Employee" SET "basicSalary" = 1 WHERE id = $1`, e.id), 'Employee');
    const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Loan" WHERE "employeeId" = ${e.id}`;
    expect(rows[0].n).toBeGreaterThan(0);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Loan" WHERE "employeeId" = ${e.id} FOR UPDATE`;
    });
    // Inside an operation that allows the table, the same raw write passes.
    const n2 = await inOp((tx) => tx.$executeRawUnsafe(`UPDATE "Loan" SET "remainingAmount" = "remainingAmount" WHERE "employeeId" = $1`, e.id));
    expect(n2).toBeGreaterThan(0);
  });

  it('protects the Employee money columns on update (not the other columns, not the create until P1-PAY-B) and refuses deleting an employee', async () => {
    await refused(prisma.employee.update({ where: { id: e.id }, data: { basicSalary: 9999 } }), 'Employee');
    await refused(prisma.employee.updateMany({ where: { id: e.id }, data: { ibanNumber: 'SA00' } }), 'Employee');
    await refused(prisma.employee.upsert({ where: { id: e.id }, create: {} as never, update: { gosiDeduction: 1 } }), 'Employee');
    await prisma.employee.update({ where: { id: e.id }, data: { jobTitle: 'محاسب' } });
    const other = await employee({ basicSalary: 7000 });
    expect(other.basicSalary).toBe(7000);
    await refused(prisma.employee.delete({ where: { id: other.id } }), 'Employee');
    await inOp((tx) => tx.employee.update({ where: { id: e.id }, data: { basicSalary: 5100 } }));
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).basicSalary).toBe(5100);
  });

  it('protects the overtime reservation links (paidInPayrollId / paidInSettlementId)', async () => {
    const ot = await prisma.overtimeRequest.create({ data: { employeeId: e.id, date: new Date('2026-09-01'), hours: 2, status: 'APPROVED' } });
    await refused(prisma.overtimeRequest.update({ where: { id: ot.id }, data: { paidInSettlementId: null } }), 'OvertimeRequest');
    await prisma.overtimeRequest.update({ where: { id: ot.id }, data: { reason: 'تشغيل' } });
  });

  it('checks columns: an operation that lists columns refuses the others of the same table', async () => {
    const loan = await inOp((tx) => tx.loan.create({ data: loanData() }));
    await inOp((tx) => tx.loan.update({ where: { id: loan.id }, data: { remainingAmount: 900 } }), LOAN_ONLY);
    const err = await inOp((tx) => tx.loan.update({ where: { id: loan.id }, data: { status: 'REJECTED' } }), LOAN_ONLY).then(() => null, (x: unknown) => x);
    expect(err).toBeInstanceOf(MoneyGatewayViolationError);
    expect((err as { details: { gatewayOperation: string } }).details.gatewayOperation).toBe(LOAN_ONLY.name);
  });

  it('keeps the context inside interactive and batch transactions, and does not leak it after the operation', async () => {
    // Batch transaction built INSIDE the operation: its queries run in the context.
    const [a, b] = await prisma.$transaction(async (tx) =>
      runMoneyOperation(tx, OP, { actor: null, input: {}, operationKey: `spike:${randomUUID()}` }, async () =>
        Promise.all([tx.loan.create({ data: loanData() }), tx.loan.create({ data: loanData() })]),
      ),
    );
    expect(a.id).not.toBe(b.id);
    // A lazy query created in the operation but awaited after it runs outside: refused.
    let lazy: Promise<unknown> | null = null;
    await prisma.$transaction(async (tx) => {
      await runMoneyOperation(tx, OP, { actor: null, input: {}, operationKey: `spike:${randomUUID()}` }, async () => {
        expect(currentMoneyContext()?.operation).toBe(OP.name);
        lazy = prisma.loan.create({ data: loanData() });
      });
      expect(currentMoneyContext()).toBeNull();
    });
    await refused(lazy!, 'Loan');
    // The root-client batch $transaction([...]) outside any operation is refused.
    await refused(prisma.$transaction([prisma.loan.create({ data: loanData() })]), 'Loan');
  });

  it('isolates concurrent operations (one context per async chain)', async () => {
    const results = await Promise.allSettled([
      inOp((tx) => tx.loan.create({ data: loanData() })),
      prisma.$transaction(async (tx) => {
        await new Promise((r) => setTimeout(r, 20));
        return tx.loan.create({ data: loanData() });
      }),
      inOp((tx) => tx.allowance.create({ data: { employeeId: e.id, name: 'x', amount: 1 } })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(MoneyGatewayViolationError);
  });

  it('the scoped client of iam inherits the extension (it extends the one client)', async () => {
    const actor = iam.actorFromSession({ id: randomUUID(), role: 'HR_MANAGER', employeeId: null }, [company.id]);
    const db = iam.scopedPrisma(iam.scopedContext(actor));
    await refused(db.loan.create({ data: loanData() }), 'Loan');
  });
});
