// P1-FND-INV against a real PostgreSQL with all migrations applied (9w_invariants_discrepancies).
// Opt-in: INV_IT=1 with DATABASE_URL pointing at a THROWAWAY database. The test creates its own two
// companies and employees; the checks scan the whole database, so every assertion is restricted to
// those companies. Rows are not cleaned up (audit and events refuse DELETE by design).
//
// Covers: reconcile (open, idempotent double call sequential and concurrent, reopen on recurrence,
// auto-close, InvariantRun), the L4 gate scope, and a double-call (idempotency) test for every
// transition of src/modules/platform/transitions/discrepancy.ts (ARCH-014): explainDiscrepancy,
// approveDiscrepancyExplanation, requestDiscrepancyWaiver, approveDiscrepancyWaiver,
// rejectDiscrepancyAction, resolveDiscrepancy, confirmSingleOperatorAct.
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.INV_IT === '1';

describe.skipIf(!RUN)('invariant engine on PostgreSQL (P1-FND-INV)', { timeout: 120_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const platform = await import('@/modules/platform');
  const {
    reconcile,
    assertNoBlockingDiscrepancies,
    BlockingDiscrepanciesError,
    explainDiscrepancy,
    approveDiscrepancyExplanation,
    requestDiscrepancyWaiver,
    approveDiscrepancyWaiver,
    rejectDiscrepancyAction,
    resolveDiscrepancy,
    confirmSingleOperatorAct,
    fingerprintOf,
  } = platform;

  const tag = randomUUID().slice(0, 8);
  const digits = tag.replace(/\D/g, '').padEnd(4, '7').slice(0, 4);
  let seq = 0;
  const iqama = () => `2${digits}${String(++seq).padStart(5, '0')}`;
  const co = { A: '', B: '' };
  const branch = { A: '', B: '' };
  const emp = { term: '', org: '', clean: '', waive: '' };
  const u1 = { userId: `u1-${tag}`, employeeId: null };
  const u2 = { userId: `u2-${tag}`, employeeId: null };
  const ENFORCED = { operatorMode: 'ENFORCED' as const };

  async function employee(k: 'A' | 'B', over: Record<string, unknown>) {
    return (
      await prisma.employee.create({
        data: {
          employeeId: `INV-${tag}-${++seq}`,
          firstNameArabic: 'موظف',
          lastNameArabic: 'اختبار',
          nationality: 'سعودي',
          iqamaOrIdNumber: iqama(),
          iqamaOrIdExp: new Date('2030-01-01'),
          dateOfBirth: new Date('1990-01-01'),
          gender: 'MALE',
          joinDate: new Date('2020-01-01'),
          basicSalary: 8000,
          legalCompanyId: co[k],
          actualCompanyId: co[k],
          branchId: branch[k],
          ...over,
        },
      })
    ).id;
  }

  const rowOf = async (employeeId: string, checkId: string) =>
    prisma.discrepancy.findUniqueOrThrow({ where: { fingerprint: fingerprintOf({ ruleId: checkId.startsWith('branch') ? 'INV-ORG-01' : 'INV-LCY-01', checkId, entityType: 'Employee', entityId: employeeId, period: null }) } });
  const mineIn = (companyId: string) => prisma.discrepancy.findMany({ where: { companyId, subjectEmployeeId: { in: Object.values(emp) } }, orderBy: { id: 'asc' } });
  const eventsOf = (aggregateId: string, type: string) => prisma.domainEvent.count({ where: { aggregateType: 'Discrepancy', aggregateId, type } });

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      const c = await prisma.company.create({
        data: { nameArabic: `شركة ثوابت ${k} ${tag}`, commercialRegNum: `8${k}${tag}${Date.now()}`.slice(0, 20), commercialRegExp: new Date('2030-01-01') },
      });
      co[k] = c.id;
      branch[k] = (await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${k}` } })).id;
    }
    // INV-LCY-01 terminated-without-date (HIGH, blocks payroll) in A.
    emp.term = await employee('A', { isTerminated: true, employmentStatus: 'EXCLUDED', exitReason: 'RESIGNATION' });
    // INV-ORG-01 branch-not-in-actual-company (BLOCKING) in A: the branch belongs to B.
    emp.org = await employee('A', { branchId: branch.B });
    // A second INV-LCY-01 finding (exit reason on an active employee) for the waiver path.
    emp.waive = await employee('A', { exitReason: 'RESIGNATION' });
    emp.clean = await employee('B', {});
  });

  it('reconcile opens one discrepancy per finding, in the company of the finding, with its InvariantRun rows', async () => {
    const s = await reconcile(prisma, { companyId: co.A, trigger: 'MANUAL' });
    expect(s.failedInvariants).toEqual([]);
    const rows = await mineIn(co.A);
    expect(rows.map((r) => [r.subjectEmployeeId, r.ruleId, r.checkId, r.status, r.severity, r.blocking]).sort()).toEqual(
      [
        [emp.org, 'INV-ORG-01', 'branch-not-in-actual-company', 'OPEN', 'BLOCKING', true],
        [emp.term, 'INV-LCY-01', 'terminated-without-date', 'OPEN', 'HIGH', true],
        [emp.waive, 'INV-LCY-01', 'exit-reason-while-active', 'OPEN', 'HIGH', true],
      ].sort(),
    );
    expect(await mineIn(co.B)).toEqual([]);
    const runs = await prisma.invariantRun.findMany({ where: { runId: s.runId, companyId: co.A } });
    expect(runs.map((r) => r.ruleId).sort()).toEqual(['INV-DOC-01', 'INV-LCY-01', 'INV-ORG-01', 'INV-PAY-01', 'INV-PAY-02']);
    expect(runs.every((r) => r.status === 'SUCCEEDED' && r.trigger === 'MANUAL')).toBe(true);
    const org = await rowOf(emp.org, 'branch-not-in-actual-company');
    expect(await prisma.auditRecord.count({ where: { entityType: 'Discrepancy', entityId: org.id, action: 'platform.discrepancy.opened' } })).toBe(1);
    expect(await eventsOf(org.id, 'platform.discrepancy.opened')).toBe(1);
  });

  it('reconcile is idempotent on a double call (sequential and concurrent): no duplicate, no status change', async () => {
    const before = await mineIn(co.A);
    await reconcile(prisma, { companyId: co.A });
    await Promise.all([reconcile(prisma, { companyId: co.A }), reconcile(prisma, { companyId: co.A })]);
    const after = await mineIn(co.A);
    expect(after.map((r) => [r.id, r.status, r.occurrences, r.version])).toEqual(before.map((r) => [r.id, r.status, r.occurrences, r.version]));
    expect(after.every((r) => r.lastSeenAt >= before[0].lastSeenAt)).toBe(true);
  });

  it('L4 gate: blocks the operation in its scope only', async () => {
    const err = await assertNoBlockingDiscrepancies(prisma, { operation: 'payroll.approve', companyId: co.A }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockingDiscrepanciesError);
    expect(err.status).toBe(409);
    expect(err.blockers.map((b: { subjectEmployeeId: string }) => b.subjectEmployeeId).sort()).toEqual([emp.org, emp.term, emp.waive].sort());
    // Another company, another operation, another employee: not blocked.
    await expect(assertNoBlockingDiscrepancies(prisma, { operation: 'payroll.approve', companyId: co.B })).resolves.toBeUndefined();
    await expect(assertNoBlockingDiscrepancies(prisma, { operation: 'document.issue', companyId: co.A })).resolves.toBeUndefined();
    await expect(assertNoBlockingDiscrepancies(prisma, { operation: 'settlement.pay', companyId: co.A, employeeIds: [emp.clean] })).resolves.toBeUndefined();
    const one = await assertNoBlockingDiscrepancies(prisma, { operation: 'settlement.pay', companyId: co.A, employeeIds: [emp.org] }).catch((e) => e);
    expect(one.blockers.map((b: { subjectEmployeeId: string }) => b.subjectEmployeeId)).toEqual([emp.org]);
    // Inside the caller's transaction too.
    await expect(prisma.$transaction((tx) => assertNoBlockingDiscrepancies(tx, { operation: 'payroll.pay', companyId: co.A }))).rejects.toBeInstanceOf(BlockingDiscrepanciesError);
  });

  it('explainDiscrepancy + approveDiscrepancyExplanation: two people, idempotent on a double call (sequential and concurrent)', async () => {
    const d = await rowOf(emp.org, 'branch-not-in-actual-company');
    const input = { discrepancyId: d.id, expectedVersion: d.version, explanation: 'الفرع مستعار مؤقتاً بقرار إداري موثق', reference: 'DEC-2026-17' };
    const [a, b] = await Promise.all([explainDiscrepancy(prisma, input, u1, ENFORCED), explainDiscrepancy(prisma, input, u1, ENFORCED)]);
    const again = await explainDiscrepancy(prisma, input, u1, ENFORCED);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(a.result);
    expect(a.result).toMatchObject({ status: 'OPEN', pendingAction: 'EXPLANATION' });
    expect(await eventsOf(d.id, 'platform.discrepancy.explanationProposed')).toBe(1);
    expect(await prisma.auditRecord.count({ where: { entityId: d.id, action: 'platform.discrepancy.explain' } })).toBe(1);
    // Still OPEN: still blocks.
    await expect(assertNoBlockingDiscrepancies(prisma, { operation: 'settlement.pay', companyId: co.A, employeeIds: [emp.org] })).rejects.toBeInstanceOf(BlockingDiscrepanciesError);

    const v = a.result.version;
    await expect(approveDiscrepancyExplanation(prisma, { discrepancyId: d.id, expectedVersion: v }, u1)).rejects.toMatchObject({ status: 403 });
    const [x, y] = await Promise.all([
      approveDiscrepancyExplanation(prisma, { discrepancyId: d.id, expectedVersion: v }, u2),
      approveDiscrepancyExplanation(prisma, { discrepancyId: d.id, expectedVersion: v }, u2),
    ]);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect((await approveDiscrepancyExplanation(prisma, { discrepancyId: d.id, expectedVersion: v }, u2)).replayed).toBe(true);
    expect(x.result.status).toBe('EXPLAINED');
    expect(await eventsOf(d.id, 'platform.discrepancy.explained')).toBe(1);
    await expect(assertNoBlockingDiscrepancies(prisma, { operation: 'settlement.pay', companyId: co.A, employeeIds: [emp.org] })).resolves.toBeUndefined();
    // A stale version is refused, not applied twice.
    await expect(explainDiscrepancy(prisma, { ...input, expectedVersion: d.version }, u2, ENFORCED)).rejects.toMatchObject({ status: 409 });
  });

  it('requestDiscrepancyWaiver + rejectDiscrepancyAction + approveDiscrepancyWaiver: idempotent on a double call, owner alert on the waiver', async () => {
    const d = await rowOf(emp.waive, 'exit-reason-while-active');
    const ask = { discrepancyId: d.id, expectedVersion: d.version, reason: 'سبب الخروج سُجل مبكراً لاستقالة مقدمة' };
    const [r1, r2] = await Promise.all([requestDiscrepancyWaiver(prisma, ask, u1, ENFORCED), requestDiscrepancyWaiver(prisma, ask, u1, ENFORCED)]);
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    expect((await requestDiscrepancyWaiver(prisma, ask, u1, ENFORCED)).replayed).toBe(true);
    expect(r1.result.pendingAction).toBe('WAIVER');

    // The second person refuses it (double call replays)...
    const rej = { discrepancyId: d.id, expectedVersion: r1.result.version };
    const [j1, j2] = await Promise.all([rejectDiscrepancyAction(prisma, rej, u2), rejectDiscrepancyAction(prisma, rej, u2)]);
    expect([j1.replayed, j2.replayed].sort()).toEqual([false, true]);
    expect(j1.result).toMatchObject({ status: 'OPEN', pendingAction: null });

    // ...then approves a second request.
    const ask2 = await requestDiscrepancyWaiver(prisma, { ...ask, expectedVersion: j1.result.version }, u1, ENFORCED);
    const ok = { discrepancyId: d.id, expectedVersion: ask2.result.version };
    await expect(approveDiscrepancyWaiver(prisma, ok, u1)).rejects.toMatchObject({ status: 403 });
    const [w1, w2] = await Promise.all([approveDiscrepancyWaiver(prisma, ok, u2), approveDiscrepancyWaiver(prisma, ok, u2)]);
    expect([w1.replayed, w2.replayed].sort()).toEqual([false, true]);
    expect((await approveDiscrepancyWaiver(prisma, ok, u2)).replayed).toBe(true);
    expect(w1.result.status).toBe('WAIVED');
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: d.id, type: 'platform.discrepancy.waived' } });
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ ownerAlert: true, ruleId: 'INV-LCY-01' });
    const stored = await prisma.discrepancy.findUniqueOrThrow({ where: { id: d.id } });
    expect(stored).toMatchObject({ status: 'WAIVED', waivedById: u1.userId, waiverApprovedById: u2.userId });
  });

  it('the beneficiary never classifies his own finding', async () => {
    const d = await rowOf(emp.term, 'terminated-without-date');
    await expect(
      explainDiscrepancy(prisma, { discrepancyId: d.id, expectedVersion: d.version, explanation: 'أنا المعني وأشرح بنفسي هنا', reference: 'SELF' }, { userId: `self-${tag}`, employeeId: emp.term }, ENFORCED),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('resolveDiscrepancy is verified against the data, idempotent on a double call; recurrence reopens it', async () => {
    const d = await rowOf(emp.term, 'terminated-without-date');
    const input = { discrepancyId: d.id, expectedVersion: d.version, resolution: 'أُضيف تاريخ الإنهاء من قرار الإنهاء', resolutionRef: 'TERM-9' };
    // Still wrong: refused.
    await expect(resolveDiscrepancy(prisma, input, u1)).rejects.toMatchObject({ status: 409 });
    await prisma.employee.update({ where: { id: emp.term }, data: { terminationDate: new Date('2026-06-30') } });
    const [a, b] = await Promise.all([resolveDiscrepancy(prisma, input, u1), resolveDiscrepancy(prisma, input, u1)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await resolveDiscrepancy(prisma, input, u1)).replayed).toBe(true);
    expect(a.result.status).toBe('RESOLVED');

    // The fact breaks again: the next reconcile reopens the same row (occurrences 2).
    await prisma.employee.update({ where: { id: emp.term }, data: { terminationDate: null } });
    const s = await reconcile(prisma, { companyId: co.A });
    expect(s.reopened).toBeGreaterThanOrEqual(1);
    const back = await prisma.discrepancy.findUniqueOrThrow({ where: { id: d.id } });
    expect(back).toMatchObject({ status: 'OPEN', occurrences: 2, resolution: null, closedAt: null });
    expect(await prisma.auditRecord.count({ where: { entityId: d.id, action: 'platform.discrepancy.reopened' } })).toBe(1);
  });

  it('a finding that disappears is AUTO_CLOSED (also when it was explained)', async () => {
    await prisma.employee.update({ where: { id: emp.org }, data: { branchId: branch.A } });
    const s = await reconcile(prisma, { companyId: co.A });
    expect(s.autoClosed).toBeGreaterThanOrEqual(1);
    const d = await rowOf(emp.org, 'branch-not-in-actual-company');
    expect(d.status).toBe('AUTO_CLOSED');
    expect(d.closedAt).not.toBeNull();
    expect(await prisma.auditRecord.count({ where: { entityId: d.id, action: 'platform.discrepancy.autoClosed' } })).toBe(1);
  });

  it('confirmSingleOperatorAct: INV-PAY-03 stays blocking until the owner confirms; idempotent on a double call', async () => {
    // INV-PAY-03 is not measured yet: its finding is inserted as reconcile would store it.
    const d = await prisma.discrepancy.create({
      data: {
        fingerprint: `it-${tag}-pay03`, ruleId: 'INV-PAY-03', checkId: 'wps-line-mismatch', domain: 'payroll', companyId: co.A,
        entityType: 'BankExport', entityId: `bx-${tag}`, period: '2026-09', severity: 'BLOCKING', blocking: true, blocks: ['payroll.export', 'payroll.pay'],
      },
    });
    const explained = await explainDiscrepancy(
      prisma,
      { discrepancyId: d.id, expectedVersion: 0, explanation: 'المبلغ عُدّل بقرار المالك قبل الإرسال', reference: 'OWNER-7' },
      u1,
      { operatorMode: 'SINGLE_OPERATOR' },
    );
    expect(explained.result).toMatchObject({ status: 'OPEN', pendingAction: 'EXPLANATION', ownerConfirmation: 'PENDING' });
    await expect(assertNoBlockingDiscrepancies(prisma, { operation: 'payroll.export', companyId: co.A, period: '2026-09' })).rejects.toBeInstanceOf(BlockingDiscrepanciesError);
    const input = { discrepancyId: d.id, expectedVersion: explained.result.version, decision: 'CONFIRMED' as const, channelRef: `owner-mail-${tag}` };
    const [c1, c2] = await Promise.all([confirmSingleOperatorAct(prisma, input), confirmSingleOperatorAct(prisma, input)]);
    expect([c1.replayed, c2.replayed].sort()).toEqual([false, true]);
    expect((await confirmSingleOperatorAct(prisma, input)).replayed).toBe(true);
    expect(c1.result).toMatchObject({ status: 'EXPLAINED', ownerConfirmation: 'CONFIRMED' });
    const stored = await prisma.discrepancy.findUniqueOrThrow({ where: { id: d.id } });
    expect(stored).toMatchObject({ selfActSingleOperator: true, explanationApprovedById: null });
    expect(await eventsOf(d.id, 'platform.discrepancy.ownerConfirmationRequested')).toBe(1);
  });

  it('the database refuses a WAIVED row without two people or the single-operator record (CHECK)', async () => {
    await expect(
      prisma.discrepancy.create({
        data: {
          fingerprint: `it-${tag}-bad`, ruleId: 'INV-PAY-01', checkId: 'x', domain: 'payroll', companyId: co.A, entityType: 'Payroll', entityId: 'p',
          severity: 'BLOCKING', blocking: true, blocks: [], status: 'WAIVED', waiverReason: 'one person only', waivedById: 'u1',
        },
      }),
    ).rejects.toThrow();
  });

  it('the tenant-level pass records findings without a company and never touches company rows', async () => {
    const s = await reconcile(prisma, { companyId: null });
    expect(s.companyId).toBeNull();
    expect(await prisma.invariantRun.count({ where: { runId: s.runId, companyId: null } })).toBe(5);
  });
});
