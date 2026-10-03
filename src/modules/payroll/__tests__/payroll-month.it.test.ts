// payroll's month transitions on a real PostgreSQL (P1-PAY-A: BL-PAY-003 / 006 / 008 / 025).
// Every export of transitions/month.ts and transitions/drafts.ts is called twice (sequentially and
// concurrently) with one key and yields one set of facts and events (ARCH-014); the segregation rules
// (own line reserved, approver never pays, SINGLE_OPERATOR self-act), the approve / pay races, the L4
// gate, the employment gate and the payroll.employment consumer (BL-PAY-025 month level).
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('payroll month on PostgreSQL (P1-PAY-A)', { timeout: 240_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const payroll = await import('@/modules/payroll');
  const lib = await import('@/lib/payroll');
  const platform = await import('@/modules/platform');
  const { moneyFixture } = await import('@/test/money-fixtures');
  const { commitPayrollGeneration, approvePayrollMonth, markPayrollMonthPaid, setEmployeeGosiDeduction, runPayrollTransaction } = payroll;

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  // Each test works in its own year (at most a few months each), far from real data.
  let year = 2070; // the companies are this run's own: months only need to be unique per company
  let monthSeq = 0;
  const nextMonth = () => ++monthSeq;
  beforeEach(() => {
    year += 1;
    monthSeq = 0;
  });
  const co = { A: '', B: '' };
  type Actor = { id: string; role: string; employeeId: string | null };
  const actors = {} as Record<'hr' | 'hr2' | 'fin' | 'fin2', Actor>;
  const emp: Record<string, string> = {};
  let n = 0;

  async function employee(company: 'A' | 'B', over: Record<string, unknown> = {}) {
    n += 1;
    return employeeFixture({
        employeeId: `PAY-${tag}-${n}`, firstNameArabic: 'موظف', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `PAY${tag}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 6000, legalCompanyId: co[company], actualCompanyId: co[company], ...over,
      });
  }

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      co[k] = (await prisma.company.create({ data: { nameArabic: `رواتب ${k} ${tag}`, commercialRegNum: `PY${k}${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    }
    for (const [k, role, linked] of [['hr', 'HR_MANAGER', true], ['hr2', 'HR_MANAGER', true], ['fin', 'FINANCE_MANAGER', false], ['fin2', 'PAYROLL_ADMIN', false]] as const) {
      const u = await prisma.user.create({ data: { email: `pay-${k}-${tag}@example.test`, passwordHash: 'x', role } });
      let employeeId: string | null = null;
      if (linked) {
        const e = await employee('A', { userId: u.id });
        employeeId = e.id;
        emp[k] = e.id;
      }
      actors[k] = { id: u.id, role, employeeId };
    }
    emp.e1 = (await employee('A')).id;
    emp.e2 = (await employee('A')).id;
    emp.b1 = (await employee('B')).id;
  });

  const monthRow = (companyId: string, month: number) => prisma.payrollMonth.findUnique({ where: { companyId_year_month: { companyId, year, month } } });
  const lines = (companyId: string, month: number) => prisma.payroll.findMany({ where: { companyId, year, month }, orderBy: { employeeId: 'asc' } });
  const events = (type: string, aggregateId: string) => prisma.domainEvent.count({ where: { type, aggregateId } });
  const generate = async (month: number, companyId = co.A) => lib.generatePayrollMonth(prisma, { companyId, year, month, actor: actors.hr });
  const approve = (month: number, who: keyof typeof actors, key = `it:approve:${randomUUID()}`, mode?: 'ENFORCED' | 'SINGLE_OPERATOR') =>
    runPayrollTransaction(prisma, (tx) => approvePayrollMonth(tx, { actor: actors[who], companyId: co.A, year, month, operationKey: key, mode }));
  const pay = (month: number, who: keyof typeof actors, key = `it:pay:${randomUUID()}`) =>
    runPayrollTransaction(prisma, (tx) => markPayrollMonthPaid(tx, { actor: actors[who], companyId: co.A, year, month, operationKey: key }));
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e?.status ?? 500);

  it('commitPayrollGeneration double call (sequential, then concurrent) with one key: one set of lines, one event; a stale plan is a 409', async () => {
    const m = nextMonth();
    const { plan } = await lib.computeGenerationPlan(prisma, { companyId: co.A, year, month: m });
    expect(plan.rows.length).toBe(4); // hr, hr2, e1, e2 of company A; never B's
    const key = `it:gen:${randomUUID()}`;
    const a = await runPayrollTransaction(prisma, (tx) => commitPayrollGeneration(tx, { plan, actor: actors.hr, operationKey: key }));
    const b = await runPayrollTransaction(prisma, (tx) => commitPayrollGeneration(tx, { plan, actor: actors.hr, operationKey: key }));
    expect(b.replayed).toBe(true);
    expect({ ...b, replayed: false }).toEqual({ ...a, replayed: false });
    const rows = await lines(co.A, m);
    expect(rows.map((r) => [r.companyId, r.payrollMonthId, r.generatedById, r.status])).toEqual(rows.map(() => [co.A, a.payrollMonthId, actors.hr.id, 'DRAFT']));
    expect(await events('payroll.month.calculated', a.payrollMonthId)).toBe(1);
    expect((await monthRow(co.A, m))?.status).toBe('CALCULATED');
    // The plan computed before this commit is stale now (version moved): refused, nothing duplicated.
    expect(await status(runPayrollTransaction(prisma, (tx) => commitPayrollGeneration(tx, { plan, actor: actors.hr, operationKey: `it:gen:${randomUUID()}` })))).toBe(409);

    const m2 = nextMonth();
    const { plan: p2 } = await lib.computeGenerationPlan(prisma, { companyId: co.A, year, month: m2 });
    const k2 = `it:gen:${randomUUID()}`;
    const [x, y] = await Promise.all([0, 1].map(() => runPayrollTransaction(prisma, (tx) => commitPayrollGeneration(tx, { plan: p2, actor: actors.hr, operationKey: k2 }))));
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect((await lines(co.A, m2)).length).toBe(4);
    expect(await events('payroll.month.calculated', x.payrollMonthId)).toBe(1);
  });

  it('approvePayrollMonth: the approver\'s own line stays DRAFT for someone else; the month is APPROVED when every line is; double call replays', async () => {
    const m = nextMonth();
    await generate(m);
    const key = `it:approve:${randomUUID()}`;
    const first = await approve(m, 'hr', key);
    expect(first).toMatchObject({ count: 3, reservedEmployeeIds: [emp.hr], monthStatus: 'CALCULATED', replayed: false });
    const again = await approve(m, 'hr', key);
    expect(again.replayed).toBe(true);
    expect({ ...again, replayed: false }).toEqual(first);
    const month = await monthRow(co.A, m);
    expect(await events('payroll.line.approved', month!.id)).toBe(1);
    expect((await lines(co.A, m)).find((l) => l.employeeId === emp.hr)?.status).toBe('DRAFT');
    // Paying a month that is not fully approved is refused.
    expect(await status(pay(m, 'fin'))).toBe(409);
    // The same approver alone cannot approve his own line (money.guard.blocked is recorded).
    const blockedKey = `it:approve:${randomUUID()}`;
    await expect(approve(m, 'hr', blockedKey)).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['SELF_BENEFICIARY'] } });
    expect(await prisma.domainEvent.count({ where: { type: 'money.guard.blocked', idempotencyKey: `money.guard.blocked:${blockedKey}` } })).toBe(1);
    // A second person approves it: the month is APPROVED, by him.
    const second = await approve(m, 'hr2');
    expect(second).toMatchObject({ count: 1, reservedEmployeeIds: [], monthStatus: 'APPROVED' });
    const after = await monthRow(co.A, m);
    expect([after?.status, after?.approvedById]).toEqual(['APPROVED', actors.hr2.id]);
    expect(await events('payroll.month.approved', after!.id)).toBe(1);
    expect((await lines(co.A, m)).every((l) => l.status === 'APPROVED' && l.approvedById)).toBe(true);
  });

  it('markPayrollMonthPaid: an approver of the month never pays it (BR-PAY-002); another pays once (double call replays); approve and pay are separate acts', async () => {
    const m = nextMonth();
    await generate(m);
    await approve(m, 'hr');
    await approve(m, 'fin'); // approves hr's reserved line: fin is now an approver too
    await expect(pay(m, 'hr')).rejects.toMatchObject({ status: 403, details: { reasons: ['PAYER_IS_APPROVER'] } });
    await expect(pay(m, 'fin')).rejects.toMatchObject({ status: 403 });
    const key = `it:pay:${randomUUID()}`;
    const a = await pay(m, 'fin2', key);
    const b = await pay(m, 'fin2', key);
    expect(a).toEqual({ count: 4, replayed: false });
    expect(b).toEqual({ count: 4, replayed: true });
    const month = await monthRow(co.A, m);
    expect([month?.status, month?.paidById]).toEqual(['PAID', actors.fin2.id]);
    expect(await events('payroll.month.paid', month!.id)).toBe(1);
    expect((await lines(co.A, m)).every((l) => l.status === 'PAID' && l.paidById === actors.fin2.id)).toBe(true);
    expect(await status(pay(m, 'fin2'))).toBe(409); // a new call (new key) finds nothing to pay
  });

  it('races: two approvers of one month, two payers of one month — one wins, the other gets 409, nothing twice', async () => {
    const m = nextMonth();
    await generate(m);
    const r = await Promise.allSettled([approve(m, 'hr2'), approve(m, 'fin')]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const x of r) if (x.status === 'rejected') expect((x.reason as { status: number }).status).toBe(409);
    // Whatever the order, finish the approval, then race two payers who approved nothing.
    if ((await monthRow(co.A, m))?.status !== 'APPROVED') await approve(m, 'hr');
    expect((await monthRow(co.A, m))?.status).toBe('APPROVED');
    const payers = await Promise.allSettled([pay(m, 'fin2'), pay(m, 'fin2')]);
    expect(payers.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect((payers.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
    expect(await events('payroll.month.paid', (await monthRow(co.A, m))!.id)).toBe(1);
  });

  it('SINGLE_OPERATOR (DEC-PO-018): the sole operator approves his own line too, recorded as SELF_ACT_SINGLE_OPERATOR', async () => {
    const m = nextMonth();
    await generate(m);
    const key = `it:approve:${randomUUID()}`;
    const r = await approve(m, 'hr', key, 'SINGLE_OPERATOR');
    expect(r).toMatchObject({ count: 4, reservedEmployeeIds: [], monthStatus: 'APPROVED' });
    expect(await prisma.auditRecord.count({ where: { operationKey: key, action: 'SELF_ACT_SINGLE_OPERATOR' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'money.guard.selfAct', idempotencyKey: `money.guard.selfAct:${key}` } })).toBe(1);
  });

  it('the L4 gate: a blocking discrepancy of the company and month stops the approval; another month is not affected', async () => {
    const m = nextMonth();
    await generate(m);
    const period = `${year}-${String(m).padStart(2, '0')}`;
    await prisma.discrepancy.create({
      data: {
        fingerprint: `it-${randomUUID()}`, ruleId: 'INV-PAY-01', checkId: 'it', domain: 'payroll', companyId: co.A, entityType: 'Payroll', entityId: 'x',
        period, severity: 'BLOCKING', blocking: true, blocks: ['payroll.approve', 'payroll.pay'],
      },
    });
    await expect(approve(m, 'hr2')).rejects.toMatchObject({ status: 409, details: { code: 'BLOCKING_DISCREPANCIES' } });
    const other = nextMonth();
    await generate(other);
    await expect(approve(other, 'hr2')).resolves.toMatchObject({ count: 3 });
  });

  it('the employment gate (BL-PAY-025): a pending employment.* event of an employee holds the month; the payroll.employment consumer regenerates his draft and releases it', async () => {
    const m = nextMonth();
    await generate(m);
    const before = (await lines(co.A, m)).find((l) => l.employeeId === emp.e2)!;
    // The employee left mid-month: the event lifecycle emits (payload as EmploymentEventPayload).
    await prisma.employee.update({ where: { id: emp.e2 }, data: { isTerminated: true, terminationDate: new Date(Date.UTC(year, m - 1, 10)) } });
    const eventKey = `it:employment:${randomUUID()}`;
    const effective = `${year}-${String(m).padStart(2, '0')}-10`;
    await prisma.$transaction((tx) =>
      platform.emitEvent(tx, {
        type: 'employment.terminated', aggregateType: 'Employee', aggregateId: emp.e2, idempotencyKey: eventKey, companyId: co.A,
        payload: { employeeId: emp.e2, effectiveDate: effective, toState: 'TERMINATED', terminationDate: effective }, effectiveDate: new Date(`${effective}T00:00:00Z`),
      }),
    );
    await expect(approve(m, 'hr2')).rejects.toMatchObject({ status: 409, details: { code: 'EMPLOYMENT_CHANGE_PENDING', employeeIds: [emp.e2] } });
    const registry = new platform.ConsumerRegistry();
    registry.register(payroll.createPayrollEmploymentConsumer());
    const run1 = await platform.runConsumers({ registry, companyIds: [co.A] });
    expect(run1.applied).toBeGreaterThanOrEqual(1);
    const event = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: eventKey } });
    const consumption = await prisma.eventConsumption.findUniqueOrThrow({ where: { consumer_eventId: { consumer: payroll.PAYROLL_EMPLOYMENT_CONSUMER, eventId: event.id } } });
    expect([consumption.status, consumption.outcome]).toEqual(['DONE', 'REGENERATED']);
    const after = (await lines(co.A, m)).find((l) => l.employeeId === emp.e2)!;
    expect(after.id).not.toBe(before.id); // regenerated (prorated to the last day)
    expect(after.basicSalary).toBeLessThan(before.basicSalary);
    // Re-running the dispatcher changes nothing (at most once per consumer and event).
    await platform.runConsumers({ registry, companyIds: [co.A] });
    expect((await lines(co.A, m)).find((l) => l.employeeId === emp.e2)?.id).toBe(after.id);
    await expect(approve(m, 'hr2')).resolves.toMatchObject({ count: 3 });
    // Restore for the next tests.
    await prisma.employee.update({ where: { id: emp.e2 }, data: { isTerminated: false, terminationDate: null } });
  });

  it('payroll.employment on an APPROVED line is HELD and on a PAID line RETRO_ROUTED: INV-PAY-04 reports the line and month (the HR task until BL-PAY-008b)', async () => {
    const approvedMonth = nextMonth();
    await generate(approvedMonth);
    await approve(approvedMonth, 'hr');
    await approve(approvedMonth, 'hr2');
    const paidMonth = nextMonth();
    await generate(paidMonth);
    await approve(paidMonth, 'hr');
    await approve(paidMonth, 'hr2');
    await pay(paidMonth, 'fin2');
    const registry = new platform.ConsumerRegistry();
    registry.register(payroll.createPayrollEmploymentConsumer());
    const emitFor = async (employeeId: string, month: number) => {
      const key = `it:employment:${randomUUID()}`;
      const d = `${year}-${String(month).padStart(2, '0')}-15`;
      await prisma.$transaction((tx) =>
        platform.emitEvent(tx, { type: 'employment.lastWorkingDayChanged', aggregateType: 'Employee', aggregateId: employeeId, idempotencyKey: key, companyId: co.A, payload: { employeeId, effectiveDate: d }, effectiveDate: new Date(`${d}T00:00:00Z`) }),
      );
      await platform.runConsumers({ registry, companyIds: [co.A] });
      const ev = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: key } });
      return prisma.eventConsumption.findUniqueOrThrow({ where: { consumer_eventId: { consumer: payroll.PAYROLL_EMPLOYMENT_CONSUMER, eventId: ev.id } } });
    };
    // e1 has lines in both months from approvedMonth on: the approved one holds it.
    expect((await emitFor(emp.e1, approvedMonth)).outcome).toBe('HELD');
    const heldLine = (await lines(co.A, approvedMonth)).find((l) => l.employeeId === emp.e1)!;
    expect(heldLine.status).toBe('APPROVED'); // an approved number never changes
    expect((await emitFor(emp.hr, paidMonth)).outcome).toBe('RETRO_ROUTED');
    const [result] = await payroll.employmentChangeResults(prisma);
    const ids = (result.entities ?? []).map((e) => e.id);
    expect(ids).toContain(heldLine.id);
    expect(ids).toContain((await lines(co.A, paidMonth)).find((l) => l.employeeId === emp.hr)!.id);
    const f = (result.entities ?? []).find((e) => e.id === heldLine.id)!;
    expect(f).toMatchObject({ companyId: co.A, employeeId: emp.e1, period: `${year}-${String(approvedMonth).padStart(2, '0')}` });
  });

  it('one-off bonuses pay only when APPROVED (BL-PAY-027, RT-WFE-701): generation skips the others; a line holding a bonus withdrawn since is refused (409, regenerate), then pays after the regeneration', async () => {
    const m = nextMonth();
    const bonus = (status: string, amount: number) =>
      moneyFixture((t) => t.allowance.create({ data: { employeeId: emp.e1, name: `مكافأة ${status} ${amount}`, amount, isMonthly: false, payrollMonth: m, payrollYear: year, status } }));
    const kept = await bonus('APPROVED', 50);
    const withdrawn = await bonus('APPROVED', 100);
    const pending = await bonus('PENDING', 200);
    const rejected = await bonus('REJECTED', 300);
    await generate(m);
    const line = (await lines(co.A, m)).find((l) => l.employeeId === emp.e1)!;
    const of = (id: string) => prisma.allowance.findUniqueOrThrow({ where: { id } });
    expect([(await of(kept.id)).paidInPayrollId, (await of(withdrawn.id)).paidInPayrollId]).toEqual([line.id, line.id]);
    expect([(await of(pending.id)).paidInPayrollId, (await of(rejected.id)).paidInPayrollId]).toEqual([null, null]);
    // Withdrawn after the generation: approving the line that still holds it is refused, nothing moves.
    await moneyFixture((t) => t.allowance.update({ where: { id: withdrawn.id }, data: { status: 'REJECTED' } }));
    await expect(approve(m, 'hr', undefined, 'SINGLE_OPERATOR')).rejects.toMatchObject({ status: 409, details: { code: 'BONUS_NOT_APPROVED' } });
    expect((await lines(co.A, m)).every((l) => l.status === 'DRAFT')).toBe(true);
    expect((await of(kept.id)).isPaid).toBe(false);
    // Regenerated: the withdrawn bonus is released; the approval pays the approved one only.
    await generate(m);
    expect((await of(withdrawn.id)).paidInPayrollId).toBeNull();
    await approve(m, 'hr', undefined, 'SINGLE_OPERATOR');
    expect([(await of(kept.id)).isPaid, (await of(withdrawn.id)).isPaid, (await of(pending.id)).isPaid, (await of(rejected.id)).isPaid]).toEqual([true, false, false, false]);
  });

  it('setEmployeeGosiDeduction double call (sequential and concurrent): one audit, one event; never on one\'s own file', async () => {
    const key = `it:gosi:${randomUUID()}`;
    const input = { actor: actors.hr, employeeId: emp.e1, gosiDeduction: 123.456, operationKey: key };
    const a = await runPayrollTransaction(prisma, (tx) => setEmployeeGosiDeduction(tx, input));
    const b = await runPayrollTransaction(prisma, (tx) => setEmployeeGosiDeduction(tx, input));
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.e1 } })).gosiDeduction).toBe(123.46);
    const k2 = `it:gosi:${randomUUID()}`;
    const both = await Promise.all([0, 1].map(() => runPayrollTransaction(prisma, (tx) => setEmployeeGosiDeduction(tx, { ...input, gosiDeduction: 50, operationKey: k2 }))));
    expect(both.map((x) => x.replayed).sort()).toEqual([false, true]);
    expect(await prisma.domainEvent.count({ where: { idempotencyKey: { in: [`${key}:payroll.gosiDeduction.changed`, `${k2}:payroll.gosiDeduction.changed`] } } })).toBe(2);
    await expect(runPayrollTransaction(prisma, (tx) => setEmployeeGosiDeduction(tx, { ...input, employeeId: emp.hr, operationKey: `it:gosi:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  describe('draft effects (transitions/drafts.ts), run inside a payroll operation', () => {
    it('releaseDraftLines double call: the lines and their reservations go once; releaseDeductionReservation and releaseLoanInstallmentsFromDrafts double calls refund once', async () => {
      const m = nextMonth();
      const e = (await employee('A')).id;
      const loan = await moneyFixture((tx) => tx.loan.create({ data: { employeeId: e, amount: 1000, monthlyInstallment: 100, remainingAmount: 1000, status: 'FINANCE_APPROVED' } }));
      const d = await moneyFixture((tx) => tx.deduction.create({ data: { employeeId: e, date: new Date(Date.UTC(year, m - 1, 2)), amount: 40, reason: 'x', status: 'DEDUCTED', approvedAt: new Date() } }));
      await generate(m);
      const line = (await lines(co.A, m)).find((l) => l.employeeId === e)!;
      expect([line.loansDeduction, line.violationsDeduction]).toEqual([100, 40]);
      const dRow = await prisma.deduction.findUniqueOrThrow({ where: { id: d.id } });
      expect(dRow.payrollMonth).toBe(`${year}-${String(m).padStart(2, '0')}`);
      // releaseDeductionReservation twice: refunded once.
      const r1 = await moneyFixture((tx) => payroll.releaseDeductionReservation(tx, dRow));
      const r2 = await moneyFixture(async (tx) => payroll.releaseDeductionReservation(tx, await tx.deduction.findUniqueOrThrow({ where: { id: d.id } })));
      expect([r1.released, r2.released]).toEqual([true, false]);
      expect((await prisma.payroll.findUniqueOrThrow({ where: { id: line.id } })).violationsDeduction).toBe(0);
      // releaseLoanInstallmentsFromDrafts twice (concurrently): the installment goes once.
      const both = await Promise.all([0, 1].map(() => moneyFixture((tx) => payroll.releaseLoanInstallmentsFromDrafts(tx, loan.id)).catch(() => ({ released: -1 }))));
      expect(both.map((x) => x.released).filter((x) => x === 1).length).toBeLessThanOrEqual(1);
      expect(await prisma.loanInstallment.count({ where: { loanId: loan.id } })).toBe(0);
      expect((await prisma.payroll.findUniqueOrThrow({ where: { id: line.id } })).loansDeduction).toBe(0);
      // releaseDraftLines twice: deleted once.
      const x = await moneyFixture((tx) => payroll.releaseDraftLines(tx, [line.id], `it:${randomUUID()}`));
      const y = await moneyFixture((tx) => payroll.releaseDraftLines(tx, [line.id], `it:${randomUUID()}`));
      expect([x.deleted, y.deleted]).toEqual([1, 0]);
    });

    it('dropEmployeeDraftsFrom double call (sequential and concurrent): the employee\'s drafts from the month on go once, in every company', async () => {
      const m = nextMonth();
      await generate(m);
      const m2 = nextMonth();
      await generate(m2);
      const key = `it:drop:${randomUUID()}`;
      const run = () => prisma.$transaction((tx) => payroll.dropEmployeeDraftsFrom(tx, { employeeId: emp.e1, year, month: m, operationKey: key }));
      const a = await run();
      const b = await run();
      expect(a.dropped).toBe(2);
      expect(b.dropped).toBe(0);
      const m3 = nextMonth();
      await generate(m3);
      const c = await Promise.allSettled([0, 1].map(() => prisma.$transaction((tx) => payroll.dropEmployeeDraftsFrom(tx, { employeeId: emp.e1, year, month: m3, operationKey: `it:drop:${randomUUID()}` }))));
      const dropped = c.filter((x) => x.status === 'fulfilled').map((x) => (x as PromiseFulfilledResult<{ dropped: number }>).value.dropped);
      expect(dropped.reduce((s, v) => s + v, 0)).toBe(1);
      expect(await prisma.payroll.count({ where: { employeeId: emp.e1, year, month: { in: [m, m2, m3] } } })).toBe(0);
    });
  });
});
