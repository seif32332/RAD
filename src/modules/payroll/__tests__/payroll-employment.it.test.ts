// BL-LCY-012 on a real PostgreSQL: payroll reads employmentEnd / payrollEligible from lifecycle, so an
// employee in NOTICE (released) is prorated in the exit month and has no line after it, exactly like a
// TERMINATED one. Real transitions (lifecycle.runEmploymentTransition), the payroll.employment consumer
// (BL-PAY-025) and the generator: NOTICE mid-month, its end (T2), TERMINATED mid-month, the cancel of an
// exit (T1c), a D1 moving the last day into the next month, a rehire in the same month (with and
// without the old end-of-service settlement: period scoping), its void (V1), and a rejected settlement.
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('payroll ↔ lifecycle interface on PostgreSQL (BL-LCY-012)', { timeout: 240_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const payroll = await import('@/modules/payroll');
  const lcy = await import('@/modules/lifecycle');
  const lib = await import('@/lib/payroll');
  const platform = await import('@/modules/platform');
  const { moneyFixture } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const Y = 2071 + (parseInt(tag.slice(0, 4), 16) % 20); // own company anyway; a varied year
  let co = '';
  const actors = {} as Record<'hr' | 'hr2', { id: string; role: string; employeeId: string | null }>;
  let n = 0;

  async function employee(over: Record<string, unknown> = {}) {
    n += 1;
    return prisma.employee.create({
      data: {
        employeeId: `PLC-${tag}-${n}`, firstNameArabic: 'موظف', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `PLC${tag}${n}`,
        iqamaOrIdExp: new Date('2090-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 6200, legalCompanyId: co, actualCompanyId: co, ...over,
      },
    });
  }

  beforeAll(async () => {
    co = (await prisma.company.create({ data: { nameArabic: `واجهة المسير ${tag}`, commercialRegNum: `PLC${tag}`, commercialRegExp: new Date('2090-01-01') } })).id;
    for (const k of ['hr', 'hr2'] as const) {
      const u = await prisma.user.create({ data: { email: `plc-${k}-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } });
      actors[k] = { id: u.id, role: 'HR_MANAGER', employeeId: null };
    }
  });

  const ymd = (m: number, day: number) => `${Y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const at = (m: number, day: number) => new Date(`${ymd(m, day)}T09:00:00Z`);
  type Input = Parameters<typeof lcy.runEmploymentTransition>[1];
  const move = (employeeId: string, over: Partial<Input>) =>
    lcy.runEmploymentTransition(prisma, {
      employeeId,
      command: 'EXIT',
      source: { type: 'TEST', id: employeeId },
      actor: { type: 'USER', id: actors.hr.id },
      operationKey: `it:plc:${randomUUID()}`,
      companyIds: [co],
      exitReason: 'RESIGNATION',
      ...over,
    });
  const generate = (month: number) => lib.generatePayrollMonth(prisma, { companyId: co, year: Y, month, actor: actors.hr, operationKey: `it:plc:gen:${randomUUID()}` });
  const consume = async () => {
    const registry = new platform.ConsumerRegistry();
    registry.register(payroll.createPayrollEmploymentConsumer());
    await platform.runConsumers({ registry, companyIds: [co] });
  };
  const line = (employeeId: string, month: number) => prisma.payroll.findFirst({ where: { employeeId, year: Y, month } });
  /** Basic of a line prorated to `days` of the month (calendar days, payroll-core). */
  const prorated = (days: number, month: number) => Math.round((6200 * days * 100) / new Date(Date.UTC(Y, month, 0)).getUTCDate()) / 100;

  it('NOTICE mid-month (future last day): prorated in the exit month, no line the month after; its end (T2) changes nothing', async () => {
    const e = await employee();
    await generate(3);
    await generate(4);
    expect((await line(e.id, 3))?.basicSalary).toBe(6200);
    expect((await line(e.id, 4))?.basicSalary).toBe(6200);

    const r = await move(e.id, { date: ymd(3, 20), now: at(3, 5) });
    expect([r.transition, r.toState]).toEqual(['NOTICE', 'NOTICE']); // the default gate: NOTICE is released
    const row = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect([row.employmentState, row.isTerminated]).toEqual(['NOTICE', false]);
    // The April draft does not reflect the exit yet: the employment gate holds that month.
    await expect(
      payroll.runPayrollTransaction(prisma, (tx) => payroll.approvePayrollMonth(tx, { actor: actors.hr2, companyId: co, year: Y, month: 4, operationKey: `it:plc:${randomUUID()}` })),
    ).rejects.toMatchObject({ status: 409, details: { code: 'EMPLOYMENT_CHANGE_PENDING' } });
    await consume();
    expect((await line(e.id, 3))?.basicSalary).toBeCloseTo(prorated(20, 3), 2);
    expect(await line(e.id, 4)).toBeNull();
    // A full regeneration of either month gives the same answer (one condition: payrollEligible).
    await generate(3);
    await generate(4);
    expect((await line(e.id, 3))?.basicSalary).toBeCloseTo(prorated(20, 3), 2);
    expect(await line(e.id, 4)).toBeNull();

    // T2 at the end of the notice: TERMINATED with the same date, the numbers do not move.
    const done = await lcy.completeDueNotices(prisma, co, { now: at(3, 21) });
    expect(done).toMatchObject({ due: 1, terminated: 1, failed: 0 });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).employmentState).toBe('TERMINATED');
    await consume();
    await generate(3);
    await generate(4);
    expect((await line(e.id, 3))?.basicSalary).toBeCloseTo(prorated(20, 3), 2);
    expect(await line(e.id, 4)).toBeNull();
  });

  it('TERMINATED mid-month (past last day): unchanged behaviour, prorated then nothing', async () => {
    const e = await employee();
    const r = await move(e.id, { date: ymd(5, 15), now: at(5, 20) });
    expect([r.transition, r.toState]).toEqual(['TERMINATE', 'TERMINATED']);
    await generate(5);
    await generate(6);
    expect((await line(e.id, 5))?.basicSalary).toBeCloseTo(prorated(15, 5), 2);
    expect(await line(e.id, 6)).toBeNull();
  });

  it('cancel of an exit (T1c): the exit month and the next are paid in full again', async () => {
    const e = await employee();
    await generate(7);
    await generate(8);
    await move(e.id, { date: ymd(7, 20), now: at(7, 5) });
    await consume();
    expect((await line(e.id, 7))?.basicSalary).toBeCloseTo(prorated(20, 7), 2);
    expect(await line(e.id, 8)).toBeNull();
    await move(e.id, { command: 'CANCEL_EXIT', approvedById: actors.hr2.id, now: at(7, 10) });
    await consume();
    expect((await line(e.id, 7))?.basicSalary).toBe(6200);
    expect((await line(e.id, 8))?.basicSalary).toBe(6200);
  });

  it('D1 moving the last day into the next month regenerates from the OLD day\'s month (affectsFrom)', async () => {
    const e = await employee();
    await generate(9);
    await generate(10);
    await move(e.id, { date: ymd(9, 20), now: at(9, 5) });
    await consume();
    expect((await line(e.id, 9))?.basicSalary).toBeCloseTo(prorated(20, 9), 2);
    expect(await line(e.id, 10)).toBeNull();
    const r = await move(e.id, { command: 'AMEND', date: ymd(10, 10), approvedById: actors.hr2.id, now: at(9, 6) });
    expect(r.toState).toBe('NOTICE');
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: e.id, type: 'employment.exitAmended' }, orderBy: { recordedAt: 'desc' } });
    expect(ev.effectiveDate?.toISOString().slice(0, 10)).toBe(ymd(9, 20));
    await consume();
    expect((await line(e.id, 9))?.basicSalary).toBe(6200);
    expect((await line(e.id, 10))?.basicSalary).toBeCloseTo(prorated(10, 10), 2);
  });

  it('rehire in the same month: the gap is not paid; the old end-of-service settlement covers only its own days (period scoping); V1 of the rehire restores the exit', async () => {
    const plain = await employee();
    const settled = await employee();
    for (const e of [plain, settled]) await move(e.id, { date: ymd(11, 10), now: at(11, 12) });
    // The old period's settlement, paid: it paid November 1-10.
    await moneyFixture((tx) =>
      tx.settlement.create({ data: { employeeId: settled.id, type: 'END_OF_SERVICE', status: 'PAID', lastWorkingDate: new Date(`${ymd(11, 10)}T00:00:00Z`), salaryBasis: 'total' } }),
    );
    await generate(11);
    expect((await line(plain.id, 11))?.basicSalary).toBeCloseTo(prorated(10, 11), 2);
    expect(await line(settled.id, 11)).toBeNull(); // the settlement of the current period pays November
    await generate(12);

    for (const e of [plain, settled]) await move(e.id, { command: 'REHIRE', date: ymd(11, 21), approvedById: actors.hr2.id, now: at(11, 21) });
    await consume();
    expect((await line(plain.id, 11))?.basicSalary).toBeCloseTo(prorated(20, 11), 2); // 1-10 and 21-30
    expect((await line(settled.id, 11))?.basicSalary).toBeCloseTo(prorated(10, 11), 2); // 21-30 only
    expect((await line(plain.id, 12))?.basicSalary).toBe(6200);
    expect((await line(settled.id, 12))?.basicSalary).toBe(6200);

    // V1: the rehire was an error. Back to TERMINATED on the 10th; affectsFrom = the voided period's start.
    const v = await move(plain.id, { command: 'VOID', approvedById: actors.hr2.id, now: at(11, 25) });
    expect([v.toState, v.terminationDate]).toEqual(['TERMINATED', ymd(11, 10)]);
    await consume();
    expect((await line(plain.id, 11))?.basicSalary).toBeCloseTo(prorated(10, 11), 2);
    expect(await line(plain.id, 12)).toBeNull();
  });

  it('a REJECTED end-of-service settlement never stops the payroll (void statuses, site 1)', async () => {
    const e = await employee();
    await moneyFixture((tx) =>
      tx.settlement.create({ data: { employeeId: e.id, type: 'END_OF_SERVICE', status: 'REJECTED', lastWorkingDate: new Date(`${ymd(2, 10)}T00:00:00Z`), salaryBasis: 'total' } }),
    );
    await generate(2);
    expect((await line(e.id, 2))?.basicSalary).toBe(6200);
  });
});
