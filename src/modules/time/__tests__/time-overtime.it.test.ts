// time's overtime money writers on a real PostgreSQL (P1-PAY-A): every export of transitions.ts called
// twice (sequentially and concurrently, ARCH-014); the decision and the direct assignment never on
// one's own overtime (BR-PAY-001); decidedById / createdById recorded (BR-PAY-006).
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';
import { withControlsMode } from '@/test/controls-mode';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('time overtime money writers on PostgreSQL (P1-PAY-A)', { timeout: 180_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const time = await import('@/modules/time');
  const { runPayrollTransaction } = await import('@/modules/payroll');
  const { moneyFixture, payrollLineFixture } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  let companyId = '';
  const hr = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };
  const self = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };
  let n = 0;
  const employee = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return employeeFixture({
        employeeId: `TM-${tag}-${n}`, firstNameArabic: 'م', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `TM${tag}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 5000, legalCompanyId: companyId, ...over,
      });
  };
  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { nameArabic: `وقت ${tag}`, commercialRegNum: `TM${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    hr.id = (await prisma.user.create({ data: { email: `tm-hr-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
    self.id = (await prisma.user.create({ data: { email: `tm-self-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
    self.employeeId = (await employee({ userId: self.id })).id;
  });
  const tx = <T,>(fn: (t: import('@/modules/platform').TxClient) => Promise<T>) => runPayrollTransaction(prisma, fn);
  // OvertimeRequest.status is a money column (BL-PAY-027): a fixture with a status is written inside the test fixture operation.
  const ot = (employeeId: string, status = 'APPROVED') => moneyFixture((t) => t.overtimeRequest.create({ data: { employeeId, date: new Date('2031-02-02'), hours: 2, status } }));

  it('decideOvertime double call (sequential and concurrent): decided once, decidedById; never one\'s own; another decider gets 409', async () => {
    const e = (await employee()).id;
    const o = await ot(e, 'PENDING');
    const key = `it:ot:${randomUUID()}`;
    const a = await tx((t) => time.decideOvertime(t, { actor: hr, overtimeId: o.id, status: 'APPROVED', operationKey: key }));
    expect(await tx((t) => time.decideOvertime(t, { actor: hr, overtimeId: o.id, status: 'APPROVED', operationKey: key }))).toEqual(a);
    expect([a.status, a.decidedById]).toEqual(['APPROVED', hr.id]);
    const o2 = await ot(e, 'PENDING');
    const k2 = `it:ot:${randomUUID()}`;
    await Promise.all([0, 1].map(() => tx((t) => time.decideOvertime(t, { actor: hr, overtimeId: o2.id, status: 'REJECTED', operationKey: k2 }))));
    expect(await prisma.domainEvent.count({ where: { idempotencyKey: `${k2}:time.overtime.decided` } })).toBe(1);
    await expect(tx((t) => time.decideOvertime(t, { actor: hr, overtimeId: o2.id, status: 'APPROVED', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 409 });
    const mine = await ot(self.employeeId!, 'PENDING');
    await expect(tx((t) => time.decideOvertime(t, { actor: self, overtimeId: mine.id, status: 'APPROVED', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  it('decideOvertime by the beneficiary (BL-PAY-027): ENFORCED 403 and still PENDING; SINGLE_OPERATOR decided as a recorded self-act with decidedById', async () => {
    const mine = await ot(self.employeeId!, 'PENDING');
    const blocked = `it:ot:${randomUUID()}`;
    await expect(tx((t) => time.decideOvertime(t, { actor: self, overtimeId: mine.id, status: 'APPROVED', operationKey: blocked }))).rejects.toMatchObject({
      status: 403,
      details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['SELF_BENEFICIARY'] },
    });
    expect((await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('PENDING');
    expect(await prisma.domainEvent.count({ where: { idempotencyKey: `money.guard.blocked:${blocked}` } })).toBe(1);
    const key = `it:ot:${randomUUID()}`;
    const single = await withControlsMode('SINGLE_OPERATOR', () => tx((t) => time.decideOvertime(t, { actor: self, overtimeId: mine.id, status: 'APPROVED', operationKey: key })));
    expect([single.status, single.decidedById]).toEqual(['APPROVED', self.id]);
    expect(await prisma.auditRecord.count({ where: { operationKey: key, action: 'SELF_ACT_SINGLE_OPERATOR' } })).toBe(1);
  });

  it('assignOvertime double call: one assignment; never to oneself', async () => {
    const e = (await employee()).id;
    const input = { actor: hr, employeeId: e, date: new Date('2031-02-03'), type: 'HOURS', hours: 3, amount: 0, reason: null, operationKey: `it:assign:${randomUUID()}` };
    const a = await tx((t) => time.assignOvertime(t, input));
    expect(await tx((t) => time.assignOvertime(t, input))).toEqual(a);
    await Promise.all([0, 1].map(() => tx((t) => time.assignOvertime(t, { ...input, operationKey: 'same-' + input.operationKey }))));
    expect(await prisma.overtimeRequest.count({ where: { employeeId: e } })).toBe(2);
    expect([a.createdById, a.decidedById]).toEqual([hr.id, hr.id]);
    await expect(tx((t) => time.assignOvertime(t, { ...input, actor: self, employeeId: self.employeeId!, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  it('linkOvertimeToPayroll / unlinkOvertimeFromPayrolls and linkOvertimeToSettlement / unlinkOvertimeFromSettlement double calls act once; a taken row is a 409', async () => {
    const e = (await employee()).id;
    const o = await ot(e);
    const line = await moneyFixture((t) => payrollLineFixture(t, { employeeId: e, year: 2031, month: 2, basicSalary: 1, netSalary: 1, status: 'DRAFT' }));
    const link = () => prisma.$transaction((t) => time.linkOvertimeToPayroll(t, { reservations: [{ payrollId: line.id, overtimeIds: [o.id] }], operationKey: `it:${randomUUID()}` }));
    expect((await link()).linked).toBe(1);
    await expect(link()).rejects.toMatchObject({ status: 409 });
    const unlink = () => prisma.$transaction((t) => time.unlinkOvertimeFromPayrolls(t, { payrollIds: [line.id], operationKey: `it:${randomUUID()}` }));
    expect([(await unlink()).released, (await unlink()).released]).toEqual([1, 0]);
    const settlement = await moneyFixture((t) => t.settlement.create({ data: { employeeId: e, type: 'END_OF_SERVICE', status: 'PENDING_APPROVAL' } }));
    const both = await Promise.allSettled([0, 1].map(() => prisma.$transaction((t) => time.linkOvertimeToSettlement(t, { settlementId: settlement.id, overtimeIds: [o.id], operationKey: `it:${randomUUID()}` }))));
    expect(both.filter((x) => x.status === 'fulfilled').length).toBe(1);
    const rel = () => prisma.$transaction((t) => time.unlinkOvertimeFromSettlement(t, { settlementId: settlement.id, operationKey: `it:${randomUUID()}` }));
    expect([(await rel()).released, (await rel()).released]).toEqual([1, 0]);
  });
});
