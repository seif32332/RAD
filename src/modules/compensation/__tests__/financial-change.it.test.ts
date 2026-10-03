// P1-PAY-B on a real PostgreSQL (BL-PAY-004; pay-to-be.md BR-PAY-009 as amended by ARC-PAY-A2/A3/A4):
// EmployeeFinancialChange is a REQUEST, applying it opens the facts (CompensationPeriod /
// BankIdentityPeriod) and only compensation's projector writes the Employee pay columns.
//
//   - every exported transition of transitions/apply.ts and transitions/financial-change.ts is called twice
//     with one key, sequentially and concurrently (ARCH-014): one request / period / audit / event;
//   - segregation: the requester never decides, the employee never decides his own change, a legacy
//     filer never decides; SINGLE_OPERATOR goes through as a recorded self-act (BR-PAY-020);
//   - effective dates: a future change waits (PENDING_EFFECT) until its day (job), a back-dated one is
//     refused inside an approved payroll month; a bank identity never starts before the day it is applied;
//   - IBAN controls: a replacement IBAN comes from the employee's portal only; stored encrypted with its
//     fingerprint and last 4; the SQL normalization / fingerprint of 9zg equal the TypeScript ones;
//   - money.gateway refuses an employee CREATE with a pay column, and any direct pay write;
//   - INV-SAL-01 (projection = facts; LEGACY_READY explained); payroll reads the periods (mid-month change).
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { withControlsMode } from '@/test/controls-mode';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('financial change requests and the compensation facts on PostgreSQL (P1-PAY-B)', { timeout: 240_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const comp = await import('@/modules/compensation');
  const { assertNoFinalizedPayrollFrom } = await import('@/modules/payroll');
  const { moneyFixture, payrollLineFixture, employeeFixture } = await import('@/test/money-fixtures');
  const { decryptField } = await import('@/lib/crypto');
  const { todayKey } = await import('@/lib/dates');
  const { ibanCheckDigits } = await import('@/lib/iban');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const today = todayKey();
  let companyId = '';
  const user = async (key: string, role: string) => (await prisma.user.create({ data: { email: `fc-${key}-${tag}@example.test`, passwordHash: 'x', role: role as never } })).id;
  const actors = {} as Record<'hr' | 'payroll' | 'fin' | 'selfHr', { id: string; role: string; employeeId: string | null }>;
  let n = 0;
  const iban = (seed: number) => {
    const bban = `80${String(seed).padStart(18, '0')}`;
    return `SA${ibanCheckDigits('SA', bban)}${bban}`;
  };
  const employee = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return employeeFixture({
      employeeId: `FC-${tag}-${n}`, firstNameArabic: 'م', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `FC${tag}${n}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
      basicSalary: 5000, legalCompanyId: companyId, ...over,
    });
  };
  /** A new hire as the routes create him now: no pay columns at all. */
  const newHire = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return prisma.employee.create({
      data: {
        employeeId: `FC-${tag}-${n}`, firstNameArabic: 'م', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `FC${tag}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        legalCompanyId: companyId, ...over,
      },
    });
  };

  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { nameArabic: `تغيير مالي ${tag}`, commercialRegNum: `FC${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    actors.hr = { id: await user('hr', 'HR_MANAGER'), role: 'HR_MANAGER', employeeId: null };
    actors.payroll = { id: await user('payroll', 'PAYROLL_ADMIN'), role: 'PAYROLL_ADMIN', employeeId: null };
    actors.fin = { id: await user('fin', 'FINANCE_MANAGER'), role: 'FINANCE_MANAGER', employeeId: null };
    const selfUser = await user('self', 'HR_MANAGER');
    const selfEmp = await employee({ userId: selfUser });
    actors.selfHr = { id: selfUser, role: 'HR_MANAGER', employeeId: selfEmp.id };
  });

  const tx = <T,>(fn: (t: import('@/modules/platform').TxClient) => Promise<T>) => comp.runCompensationTransaction(prisma, fn);
  const key = (what: string) => `it:fc:${what}:${randomUUID()}`;
  const pay = (basicSalary: number, allowances: Array<{ name: string; amount: number }> = []) => ({
    basicSalary,
    allowances: allowances.map((a) => ({ ...a, countsTowardGosi: /سكن/.test(a.name), allowanceType: null })),
  });
  const request = (employeeId: string, over: Partial<import('@/modules/compensation').RequestFinancialChangeInput> = {}) =>
    tx((t) => comp.requestFinancialChange(t, { actor: actors.hr, employeeId, source: 'EDIT', compensation: pay(6000), operationKey: key('req'), ...over }));
  const decide = (changeId: string, actor: (typeof actors)['hr'], decision: 'APPROVE' | 'REJECT' = 'APPROVE', over: Partial<import('@/modules/compensation').DecideFinancialChangeInput> = {}) =>
    tx((t) => comp.decideFinancialChange(t, { actor, changeId, decision, operationKey: key('decide'), assertEffectiveDateOpen: assertNoFinalizedPayrollFrom, ...over }));
  const periods = (employeeId: string) => prisma.compensationPeriod.findMany({ where: { employeeId, supersededAt: null }, orderBy: { validFrom: 'asc' } });

  it('requestFinancialChange double call (sequential and concurrent): one PENDING request, one audit, one event; nothing in force; the same values are "unchanged"', async () => {
    const e = (await employee()).id;
    const k = key('req');
    const input = { actor: actors.hr, employeeId: e, source: 'EDIT' as const, effectiveDate: today, compensation: pay(6000, [{ name: 'بدل سكن', amount: 1500 }]), operationKey: k };
    const a = await tx((t) => comp.requestFinancialChange(t, input));
    const b = await tx((t) => comp.requestFinancialChange(t, input));
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect(b.changes.map((c) => c.id)).toEqual(a.changes.map((c) => c.id));
    expect(a.changes).toHaveLength(1);
    expect(a.changes[0]).toMatchObject({ field: 'COMPENSATION', status: 'PENDING', requestedById: actors.hr.id, effectiveDate: today });
    expect(await prisma.auditRecord.count({ where: { operationKey: k, action: 'compensation.financialChange.request' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'compensation.financialChange.requested', aggregateId: a.changes[0].id } })).toBe(1);
    // Nothing is in force: the projection and the facts are the legacy ones.
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e } })).basicSalary).toBe(5000);
    expect((await periods(e)).map((p) => Number(p.basicSalary))).toEqual([5000]);
    // Concurrent double call with a fresh key on another employee: one request.
    const e2 = (await employee()).id;
    const k2 = key('req');
    const both = await Promise.all([0, 1].map(() => tx((t) => comp.requestFinancialChange(t, { ...input, employeeId: e2, operationKey: k2 }))));
    expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await prisma.employeeFinancialChange.count({ where: { employeeId: e2 } })).toBe(1);
    // A second request for the same field while one is PENDING: 409; the values in force: "unchanged".
    await expect(request(e, { compensation: pay(7000) })).rejects.toMatchObject({ status: 409, details: { code: 'FINANCIAL_CHANGE_PENDING' } });
    // The values in force asked again: nothing to decide (even while another request waits).
    expect((await request(e2, { compensation: pay(5000), source: 'FORM' })).unchanged).toEqual(['COMPENSATION']);
    const e3 = (await employee()).id;
    const unchanged = await request(e3, { compensation: pay(5000) });
    expect([unchanged.changes.length, unchanged.unchanged]).toEqual([0, ['COMPENSATION']]);
  });

  it('the PORTAL takes no pay change and files an IBAN for the session employee only', async () => {
    const e = await employee();
    const other = await employee();
    const me = { id: actors.hr.id, role: 'EMPLOYEE', employeeId: e.id };
    await expect(tx((t) => comp.requestFinancialChange(t, { actor: me, employeeId: e.id, source: 'PORTAL', compensation: pay(9000), operationKey: key('p') }))).rejects.toMatchObject({ status: 403 });
    await expect(
      tx((t) => comp.requestFinancialChange(t, { actor: me, employeeId: other.id, source: 'PORTAL', bank: { iban: iban(1), bankName: 'x', paymentMethod: 'BANK_TRANSFER' }, operationKey: key('p') })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('decideFinancialChange: the requester and the employee never decide (403, recorded); the second person approves; double call (sequential and concurrent) applies once', async () => {
    const e = await employee({ userId: await user(`e${randomUUID().slice(0, 6)}`, 'HR_MANAGER') });
    const asEmployee = { id: e.userId as string, role: 'HR_MANAGER', employeeId: e.id };
    const { changes } = await request(e.id, { compensation: pay(6500, [{ name: 'بدل سكن', amount: 1625 }, { name: 'بدل نقل', amount: 650 }]) });
    const id = changes[0].id;
    const blockKey = key('blocked');
    await expect(decide(id, actors.hr, 'APPROVE', { operationKey: blockKey })).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['SAME_PERSON_TWICE'] } });
    expect(await prisma.domainEvent.count({ where: { type: 'money.guard.blocked', idempotencyKey: `money.guard.blocked:${blockKey}` } })).toBe(1);
    await expect(decide(id, asEmployee)).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED' } });
    await expect(decide(id, asEmployee, 'REJECT')).rejects.toMatchObject({ status: 403 });
    expect((await prisma.employeeFinancialChange.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');

    const k = key('decide');
    const [a, b] = await Promise.all([0, 1].map(() => decide(id, actors.payroll, 'APPROVE', { operationKey: k })));
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.change).toMatchObject({ status: 'APPLIED', decidedById: actors.payroll.id, decisionSelfAct: false });
    expect(a.applied).toBe(true);
    expect((await decide(id, actors.payroll, 'APPROVE', { operationKey: k })).replayed).toBe(true);
    await expect(decide(id, actors.fin)).rejects.toMatchObject({ status: 409, details: { code: 'FINANCIAL_CHANGE_NOT_PENDING' } });
    // The fact: the legacy period is closed at today (a shortened successor of its lineage, sourced by the
    // change; the legacy row stays, superseded), the new one runs from today; the projection follows.
    const ps = await periods(e.id);
    expect(ps.map((p) => [p.sourceType, p.sourceId, Number(p.basicSalary), p.validTo ? p.validTo.toISOString().slice(0, 10) : null])).toEqual([
      ['FINANCIAL_CHANGE', id, 5000, today],
      ['FINANCIAL_CHANGE', id, 6500, null],
    ]);
    expect(await prisma.compensationPeriod.count({ where: { employeeId: e.id, sourceType: 'LEGACY_OPENING', supersedeReason: 'CLOSE' } })).toBe(1);
    const row = await prisma.employee.findUniqueOrThrow({ where: { id: e.id }, include: { allowances: { where: { isMonthly: true } } } });
    expect(row.basicSalary).toBe(6500);
    expect(row.allowances.map((x) => [x.name, x.amount]).sort()).toEqual([['بدل سكن', 1625], ['بدل نقل', 650]]);
    const items = ps[1].allowances as Array<{ allowanceId: string }>;
    expect(row.allowances.map((x) => x.id).sort()).toEqual(items.map((x) => x.allowanceId).sort()); // projection rows = period items
    // The period events payroll consumes (one close of the legacy period, one opening), once despite the double call.
    expect(await prisma.domainEvent.count({ where: { type: 'compensation.periodOpened', aggregateType: 'CompensationPeriod', payload: { path: ['employeeId'], equals: e.id } } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'compensation.periodClosed', payload: { path: ['employeeId'], equals: e.id } } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'compensation.financialChange.decided', aggregateId: id } })).toBe(1);
  });

  it('REJECT: the second person rejects; nothing changes; SINGLE_OPERATOR: the sole operator decides his own request, recorded as a self-act', async () => {
    const e = (await employee()).id;
    const r1 = await request(e, { compensation: pay(7000) });
    const rejected = await decide(r1.changes[0].id, actors.payroll, 'REJECT', { note: 'خارج سلم الرواتب' });
    expect(rejected.change).toMatchObject({ status: 'REJECTED', decisionNote: 'خارج سلم الرواتب' });
    expect((await periods(e)).length).toBe(1);
    const r2 = await request(e, { compensation: pay(7100) });
    const k = key('single');
    const single = await withControlsMode('SINGLE_OPERATOR', () => decide(r2.changes[0].id, actors.hr, 'APPROVE', { operationKey: k }));
    expect([single.selfAct, single.change.status, single.change.decisionSelfAct]).toEqual([true, 'APPLIED', true]);
    expect(await prisma.auditRecord.count({ where: { operationKey: k, action: 'SELF_ACT_SINGLE_OPERATOR' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'money.guard.selfAct', idempotencyKey: `money.guard.selfAct:${k}` } })).toBe(1);
  });

  it('a future change waits as PENDING_EFFECT until its day (applyFinancialChange refuses before; the job applies it once, double call)', async () => {
    const e = (await employee()).id;
    const r = await request(e, { effectiveDate: '2099-03-01', compensation: pay(9000) });
    const d = await decide(r.changes[0].id, actors.payroll);
    expect([d.change.status, d.applied]).toEqual(['PENDING_EFFECT', false]);
    expect((await periods(e)).length).toBe(1);
    await expect(tx((t) => comp.applyFinancialChange(t, { changeId: r.changes[0].id, operationKey: key('early') }))).rejects.toMatchObject({ status: 409, details: { code: 'FINANCIAL_CHANGE_NOT_DUE' } });
    const before = await comp.applyDueFinancialChanges(prisma, [companyId], { now: new Date('2099-02-28T12:00:00Z') });
    expect(before.due).toBe(0);
    const runs = await Promise.all([0, 1].map(() => comp.applyDueFinancialChanges(prisma, [companyId], { now: new Date('2099-03-01T06:00:00Z') })));
    expect(runs.reduce((s, x) => s + x.applied, 0)).toBeGreaterThanOrEqual(1);
    expect(runs.reduce((s, x) => s + x.failed, 0)).toBe(0);
    const ps = await periods(e);
    expect(ps.map((p) => [Number(p.basicSalary), p.validFrom.toISOString().slice(0, 10)])).toEqual([[5000, '2024-01-01'], [9000, '2099-03-01']]);
    // The projection shows the pay in force TODAY (still the legacy one).
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e } })).basicSalary).toBe(5000);
    const k = comp.dueApplyKey(r.changes[0].id);
    const again = await tx((t) => comp.applyFinancialChange(t, { changeId: r.changes[0].id, operationKey: k, today: '2099-03-01' }));
    expect(again.replayed).toBe(true);
  });

  it('a back-dated pay change cannot reach into an approved payroll month (409 PAYROLL_MONTH_FINALIZED)', async () => {
    const e = (await employee()).id;
    await moneyFixture((t) => payrollLineFixture(t, { employeeId: e, year: 2025, month: 6, basicSalary: 5000, netSalary: 5000, status: 'APPROVED' }));
    const r = await request(e, { effectiveDate: '2025-06-15', compensation: pay(5600) });
    await expect(decide(r.changes[0].id, actors.payroll)).rejects.toMatchObject({ status: 409, details: { code: 'PAYROLL_MONTH_FINALIZED' } });
    expect((await prisma.employeeFinancialChange.findUniqueOrThrow({ where: { id: r.changes[0].id } })).status).toBe('PENDING');
  });

  it('applyDecision double call: a back-dated period ends where the next one starts; the same day is replaced (CORRECTION, same lineage)', async () => {
    const e = (await employee()).id;
    const src = { type: 'TEST', id: tag };
    await tx((t) => comp.applyDecision(t, { employeeId: e, effectiveDate: '2025-05-01', attrs: { basicSalary: 6000, allowances: [] }, source: src, triggeredById: actors.payroll.id, operationKey: key('a1') }));
    const k = key('a2');
    const input = { employeeId: e, effectiveDate: '2025-02-01', attrs: { basicSalary: 5500, allowances: [] }, source: src, triggeredById: actors.payroll.id, operationKey: k };
    const [x, y] = await Promise.all([0, 1].map(() => tx((t) => comp.applyDecision(t, input))));
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect((await periods(e)).map((p) => [Number(p.basicSalary), p.validFrom.toISOString().slice(0, 10), p.validTo?.toISOString().slice(0, 10) ?? null])).toEqual([
      [5000, '2024-01-01', '2025-02-01'],
      [5500, '2025-02-01', '2025-05-01'],
      [6000, '2025-05-01', null],
    ]);
    const same = await tx((t) => comp.applyDecision(t, { ...input, attrs: { basicSalary: 5550, allowances: [] }, operationKey: key('a3') }));
    expect(same.period.supersedesId).toBe(x.period.id);
    expect(same.period.lineageId).toBe(x.period.lineageId);
    expect((await periods(e)).map((p) => Number(p.basicSalary))).toEqual([5000, 5550, 6000]);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e } })).basicSalary).toBe(6000);
  });

  it('IBAN: the first one comes with the hiring; a replacement is the employee\'s own portal request; stored encrypted with fingerprint and last 4; applyBankIdentity double call, never back-dated', async () => {
    const hire = await newHire();
    expect([hire.basicSalary, hire.payrollReady]).toEqual([0, false]);
    const first = await tx((t) =>
      comp.requestFinancialChange(t, { actor: actors.hr, employeeId: hire.id, source: 'FORM', effectiveDate: '2024-01-01', compensation: pay(4000), bank: { iban: iban(11), bankName: 'بنك أ', paymentMethod: 'BANK_TRANSFER' }, operationKey: key('form') }),
    );
    expect(first.changes.map((c) => c.field).sort()).toEqual(['BANK_IDENTITY', 'COMPENSATION']);
    const bankReq = first.changes.find((c) => c.field === 'BANK_IDENTITY')!;
    expect(bankReq.bank).toEqual({ paymentMethod: 'BANK_TRANSFER', bankName: 'بنك أ', ibanMasked: `SA${'*'.repeat(18)}${iban(11).slice(-4)}` });
    const stored = await prisma.employeeFinancialChange.findUniqueOrThrow({ where: { id: bankReq.id } });
    expect(stored.ibanEncrypted?.startsWith('enc:')).toBe(true);
    expect(decryptField(stored.ibanEncrypted)).toBe(iban(11));
    expect(stored.ibanFingerprint).toBe(comp.ibanFingerprint(iban(11)));
    for (const c of first.changes) await decide(c.id, actors.payroll);
    let row = await prisma.employee.findUniqueOrThrow({ where: { id: hire.id } });
    expect([row.basicSalary, row.ibanNumber, row.bankName, row.payrollReady]).toEqual([4000, iban(11), 'بنك أ', true]);
    const bank = await prisma.bankIdentityPeriod.findFirstOrThrow({ where: { employeeId: hire.id, supersededAt: null } });
    expect([bank.validFrom.toISOString().slice(0, 10), bank.ibanLast4, bank.sourceType]).toEqual([today, iban(11).slice(-4), 'FINANCIAL_CHANGE']);

    // HR cannot replace the IBAN on file (EDIT / IMPORT): the employee's portal only (BR-PAY-009).
    await expect(request(hire.id, { compensation: null, bank: { iban: iban(12), bankName: 'بنك ب', paymentMethod: 'BANK_TRANSFER' } })).rejects.toMatchObject({ status: 403, details: { code: 'IBAN_SELF_SERVICE_ONLY' } });
    // The bank name alone is a request HR may file (the IBAN does not move).
    const nameOnly = await request(hire.id, { compensation: null, bank: { iban: iban(11), bankName: 'بنك أ (فرع)', paymentMethod: 'BANK_TRANSFER' } });
    expect(nameOnly.changes).toHaveLength(1);
    await tx((t) => comp.cancelFinancialChange(t, { actor: actors.hr, changeId: nameOnly.changes[0].id, operationKey: key('c') }));
    const me = { id: actors.fin.id, role: 'EMPLOYEE', employeeId: hire.id };
    const portal = await tx((t) => comp.requestFinancialChange(t, { actor: me, employeeId: hire.id, source: 'PORTAL', bank: { iban: iban(12), bankName: 'بنك ب', paymentMethod: 'BANK_TRANSFER' }, operationKey: key('portal') }));
    await decide(portal.changes[0].id, actors.payroll);
    row = await prisma.employee.findUniqueOrThrow({ where: { id: hire.id } });
    expect(row.ibanNumber).toBe(iban(12));
    // Same day twice: the second identity of the day replaces the first (CORRECTION), one in force.
    expect(await prisma.bankIdentityPeriod.count({ where: { employeeId: hire.id, supersededAt: null } })).toBe(1);

    // applyBankIdentity double call (sequential and concurrent), and no back-dating.
    const k = key('bank');
    const attrs = { paymentMethod: 'CASH' as const, bankName: null };
    const runs = await Promise.all([0, 1].map(() => tx((t) => comp.applyBankIdentity(t, { employeeId: hire.id, attrs, source: { type: 'TEST', id: tag }, triggeredById: actors.payroll.id, operationKey: k }))));
    expect(runs.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: hire.id } })).salaryPaymentMethod).toBe('CASH');
    await expect(tx((t) => comp.applyBankIdentity(t, { employeeId: hire.id, attrs, source: { type: 'TEST', id: tag }, triggeredById: null, operationKey: key('back'), today: '2020-01-01' }))).rejects.toMatchObject({ status: 409 });
  });

  it('cancelFinancialChange double call: withdrawn once; a cancelled request is never decided', async () => {
    const e = (await employee()).id;
    const r = await request(e, { compensation: pay(6100) });
    const k = key('cancel');
    const both = await Promise.all([0, 1].map(() => tx((t) => comp.cancelFinancialChange(t, { actor: actors.hr, changeId: r.changes[0].id, reason: 'خطأ إدخال', operationKey: k }))));
    expect(both.map((x) => x.replayed).sort()).toEqual([false, true]);
    expect(both[0].change.status).toBe('CANCELLED');
    await expect(decide(r.changes[0].id, actors.payroll)).rejects.toMatchObject({ status: 409 });
    await expect(tx((t) => comp.cancelFinancialChange(t, { actor: actors.hr, changeId: r.changes[0].id, operationKey: key('cancel2') }))).rejects.toMatchObject({ status: 409 });
  });

  it('confirmLegacyFinancialChange double call: the employee confirms his migrated IBAN request; its original filer never decides it', async () => {
    const empUser = await user(`le${randomUUID().slice(0, 6)}`, 'EMPLOYEE');
    const e = await employee({ userId: empUser, ibanNumber: iban(21), bankName: 'قديم' });
    const legacy = await moneyFixture((t) =>
      t.employeeFinancialChange.create({
        data: {
          employeeId: e.id, companyId, field: 'BANK_IDENTITY', source: 'PORTAL', status: 'LEGACY_UNVERIFIED', effectiveDate: new Date(`${today}T00:00:00Z`),
          ibanEncrypted: iban(22), ibanFingerprint: comp.ibanFingerprint(iban(22)), ibanLast4: iban(22).slice(-4), bankName: 'جديد', paymentMethod: 'BANK_TRANSFER',
          legacyFiledByUserIds: [actors.payroll.id], operationKey: `legacy-iban:${randomUUID()}`,
        },
      }),
    );
    const me = { id: empUser, role: 'EMPLOYEE', employeeId: e.id };
    await expect(tx((t) => comp.confirmLegacyFinancialChange(t, { actor: actors.hr, changeId: legacy.id, operationKey: key('x') }))).rejects.toMatchObject({ status: 403 });
    const k = key('confirm');
    const both = await Promise.all([0, 1].map(() => tx((t) => comp.confirmLegacyFinancialChange(t, { actor: me, changeId: legacy.id, operationKey: k }))));
    expect(both.map((x) => x.replayed).sort()).toEqual([false, true]);
    expect(both[0].change).toMatchObject({ status: 'PENDING', requestedById: empUser });
    await expect(decide(legacy.id, actors.payroll)).rejects.toMatchObject({ status: 403, details: { reasons: ['SAME_PERSON_TWICE'] } });
    const ok = await decide(legacy.id, actors.fin);
    expect(ok.change.status).toBe('APPLIED');
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).ibanNumber).toBe(iban(22));
  });

  it('cancelFinancialChangesAfterExit double call: the pay changes after the last working day are cancelled, the bank ones stay', async () => {
    const e = (await employee()).id;
    const r = await request(e, { effectiveDate: '2099-05-01', compensation: pay(8000) });
    const run = () => tx((t) => comp.cancelFinancialChangesAfterExit(t, { employeeId: e, lastWorkingDay: '2099-04-30', operationKey: key('exit') }));
    expect([(await run()).cancelled, (await run()).cancelled]).toEqual([1, 0]);
    expect((await prisma.employeeFinancialChange.findUniqueOrThrow({ where: { id: r.changes[0].id } })).cancelReason).toBe('EMPLOYMENT_ENDED');
  });

  it('money.gateway: an employee CREATE or UPDATE with a pay column is refused outside compensation; without pay it passes', async () => {
    for (const data of [{ basicSalary: 1 }, { ibanNumber: iban(31) }, { bankName: 'x' }, { salaryPaymentMethod: 'CASH' as const }, { gosiDeduction: 1 }, { payrollReady: true }]) {
      await expect(newHire(data)).rejects.toMatchObject({ details: { code: 'MONEY_GATEWAY_DIRECT_WRITE' } });
    }
    const ok = await newHire();
    await expect(prisma.employee.update({ where: { id: ok.id }, data: { basicSalary: 2 } })).rejects.toMatchObject({ details: { code: 'MONEY_GATEWAY_DIRECT_WRITE' } });
    await expect(prisma.employee.update({ where: { id: ok.id }, data: { payrollReady: true } })).rejects.toMatchObject({ details: { code: 'MONEY_GATEWAY_DIRECT_WRITE' } });
    await expect(prisma.compensationPeriod.findMany({ where: { employeeId: ok.id } })).resolves.toEqual([]);
    await expect(prisma.employeeFinancialChange.create({ data: { employeeId: ok.id, field: 'COMPENSATION', source: 'EDIT', effectiveDate: new Date(), compensation: {}, requestedById: actors.hr.id, operationKey: key('direct') } })).rejects.toMatchObject({ details: { code: 'MONEY_GATEWAY_DIRECT_WRITE' } });
  });

  it('the database refuses a decider who is the requester (CHECK) and a second PENDING request per field (partial unique)', async () => {
    const e = (await employee()).id;
    const r = await request(e, { compensation: pay(6200) });
    await expect(moneyFixture((t) => t.employeeFinancialChange.update({ where: { id: r.changes[0].id }, data: { status: 'REJECTED', decidedById: actors.hr.id, decidedAt: new Date() } }))).rejects.toThrow(/second_person_check/);
    await expect(
      moneyFixture((t) => t.employeeFinancialChange.create({ data: { employeeId: e, field: 'COMPENSATION', source: 'EDIT', effectiveDate: new Date(), compensation: {}, requestedById: actors.hr.id, operationKey: key('dup') } })),
    ).rejects.toThrow(/one_pending|Unique constraint/);
  });

  it('the SQL normalization and fingerprint of 9zg equal the TypeScript ones; the legacy BANK_IDENTITY opening is written once', async () => {
    const { normalizeIban } = await import('@/lib/iban');
    for (const raw of [iban(41), ` sa${iban(41).slice(2, 6)} ${iban(41).slice(6)}`, `${iban(42).slice(0, 10)}-${iban(42).slice(10)}`, '‏' + iban(43)]) {
      const [row] = await prisma.$queryRaw<Array<{ n: string; f: string | null }>>`SELECT "compensation_normalize_iban"(${raw}) AS "n", "compensation_iban_fingerprint"(${raw}) AS "f"`;
      expect(row.n).toBe(normalizeIban(raw));
      expect(row.f).toBe(comp.ibanFingerprint(raw));
    }
    const { openLegacyPeriod } = await import('@/modules/platform');
    const hire = await newHire();
    const attrs = { paymentMethod: 'BANK_TRANSFER' as const, ibanEncrypted: iban(44), ibanFingerprint: comp.ibanFingerprint(iban(44)), ibanLast4: iban(44).slice(-4), bankName: null };
    const once = await moneyFixture((t) => openLegacyPeriod(t, 'BANK_IDENTITY', { employeeId: hire.id, validFrom: '2024-01-01', attrs }, { type: 'SYSTEM', id: 'it' }));
    const twice = await moneyFixture((t) => openLegacyPeriod(t, 'BANK_IDENTITY', { employeeId: hire.id, validFrom: '2024-01-01', attrs }, { type: 'SYSTEM', id: 'it' }));
    expect([once.outcome, twice.outcome, twice.periodId]).toEqual(['OPENED', 'ALREADY_OPENED', once.periodId]);
  });

  it('the job opens the legacy facts of a row written outside the application (seed / restore) once; a new hire without pay is never opened', async () => {
    const seeded = await moneyFixture((t) =>
      t.employee.create({ data: { employeeId: `FC-${tag}-S`, firstNameArabic: 'م', lastNameArabic: 'S', nationality: 'SA', iqamaOrIdNumber: `FC${tag}S`, iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2025-01-01'), legalCompanyId: companyId, basicSalary: 3300, ibanNumber: iban(51), bankName: 'بنك', payrollReady: true } }),
    );
    const hire = await newHire();
    const first = await comp.openMissingCompensation(prisma, companyId);
    expect(first.missing).toBeGreaterThanOrEqual(1);
    expect(first.opened.filter((r) => r.outcome === 'OPENED').reduce((s, r) => s + r.employees, 0)).toBeGreaterThanOrEqual(2);
    expect((await periods(seeded.id)).map((p) => [Number(p.basicSalary), p.sourceType])).toEqual([[3300, 'LEGACY_OPENING']]);
    expect((await prisma.bankIdentityPeriod.findFirstOrThrow({ where: { employeeId: seeded.id } })).ibanFingerprint).toBe(comp.ibanFingerprint(iban(51)));
    expect(await prisma.compensationPeriod.count({ where: { employeeId: hire.id } })).toBe(0);
    expect((await comp.openMissingCompensation(prisma, companyId)).missing).toBe(0);
  });

  it('INV-SAL-01: a projection that differs from the facts is a finding; a ready legacy employee without pay facts is EXPECTED (LEGACY_READY)', async () => {
    const drift = (await employee()).id;
    await moneyFixture((t) => t.employee.update({ where: { id: drift }, data: { basicSalary: 4999 } }));
    const legacy = (await moneyFixture((t) => t.employee.create({ data: { employeeId: `FC-${tag}-L`, firstNameArabic: 'م', lastNameArabic: 'L', nationality: 'SA', iqamaOrIdNumber: `FC${tag}L`, iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'), legalCompanyId: companyId, payrollReady: true } }))).id;
    const [projection, legacyReady] = await comp.payProjectionResults(prisma);
    expect(projection.entities!.find((x) => x.id === drift)?.tag).toBe('BASIC');
    const l = legacyReady.entities!.filter((x) => x.employeeId === legacy);
    expect(l.map((x) => x.tag).sort()).toEqual(['NO_BANK_IDENTITY', 'NO_COMPENSATION_PERIOD']);
    expect(l.every((x) => x.explained?.category === 'LEGACY_READY')).toBe(true);
    // A fixture employee whose facts match is not a finding.
    const clean = (await employee()).id;
    expect(projection.entities!.some((x) => x.id === clean)).toBe(false);
  });

  it('BR-PAY-009: no money act (loan, penalty, overtime) for an employee whose pay is not applied; ready once salary and bank identity are applied', async () => {
    const payroll = await import('@/modules/payroll');
    const time = await import('@/modules/time');
    const hire = await newHire();
    const loan = () => payroll.runPayrollTransaction(prisma, (t) => payroll.createLoan(t, { actor: actors.hr, employeeId: hire.id, amount: 1000, monthlyInstallment: 100, reason: 'x', operationKey: key('loan') }));
    await expect(loan()).rejects.toMatchObject({ status: 409, details: { code: 'EMPLOYEE_NOT_PAYROLL_READY' } });
    await expect(
      payroll.runPayrollTransaction(prisma, (t) => time.assignOvertime(t, { actor: actors.hr, employeeId: hire.id, date: new Date('2026-09-01'), type: 'NORMAL', hours: 2, amount: 50, reason: null, operationKey: key('ot') })),
    ).rejects.toMatchObject({ status: 409 });
    const filed = await tx((t) =>
      comp.requestFinancialChange(t, { actor: actors.hr, employeeId: hire.id, source: 'FORM', effectiveDate: '2024-01-01', compensation: pay(4100), bank: { iban: null, bankName: null, paymentMethod: 'CASH' }, operationKey: key('ready') }),
    );
    await decide(filed.changes.find((c) => c.field === 'COMPENSATION')!.id, actors.payroll);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: hire.id } })).payrollReady).toBe(false); // the bank identity is still pending
    await decide(filed.changes.find((c) => c.field === 'BANK_IDENTITY')!.id, actors.payroll);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: hire.id } })).payrollReady).toBe(true);
    expect((await loan()).status).toBe('PENDING');
  });

  it('payroll.compensation: a pay change regenerates the open month\'s draft; the month gate holds until the period events are consumed', async () => {
    const lib = await import('@/lib/payroll');
    const payroll = await import('@/modules/payroll');
    const platform = await import('@/modules/platform');
    const e = (await employee({ basicSalary: 3100 })).id;
    const [Y, M] = [2033, 5];
    await lib.generatePayrollMonth(prisma, { companyId, year: Y, month: M, actor: actors.hr, operationKey: key('gen') });
    const lineOf = () => prisma.payroll.findFirstOrThrow({ where: { employeeId: e, year: Y, month: M } });
    expect((await lineOf()).basicSalary).toBe(3100);
    await tx((t) => comp.applyDecision(t, { employeeId: e, effectiveDate: '2033-05-16', attrs: { basicSalary: 6200, allowances: [] }, source: { type: 'TEST', id: tag }, triggeredById: actors.payroll.id, companyId, operationKey: key('mid') }));
    await expect(tx((t) => payroll.assertEmploymentGate(t, { year: Y, month: M, employeeIds: [e] }))).rejects.toMatchObject({ status: 409, details: { code: 'EMPLOYMENT_CHANGE_PENDING', employeeIds: [e] } });
    const registry = new platform.ConsumerRegistry();
    registry.register(payroll.PAYROLL_COMPENSATION_CONSUMER_DEF);
    await platform.runConsumers({ registry, companyIds: [companyId] });
    // 15 days at 3100 + 16 days at 6200 (May 2033, calendar-day basis).
    expect((await lineOf()).basicSalary).toBe(4700);
    await expect(tx((t) => payroll.assertEmploymentGate(t, { year: Y, month: M, employeeIds: [e] }))).resolves.toBeUndefined();
    // A second run consumes nothing again.
    await platform.runConsumers({ registry, companyIds: [companyId] });
    expect((await lineOf()).basicSalary).toBe(4700);
  });

  it('payroll reads the CompensationPeriods: a mid-month change is prorated per segment (ARCH-011)', async () => {
    const { computeGenerationPlan } = await import('@/lib/payroll');
    const e = (await employee({ basicSalary: 3000 })).id;
    await tx((t) => comp.applyDecision(t, { employeeId: e, effectiveDate: '2030-04-16', attrs: { basicSalary: 6000, allowances: [] }, source: { type: 'TEST', id: tag }, triggeredById: actors.payroll.id, operationKey: key('mid') }));
    const { plan } = await computeGenerationPlan(prisma, { companyId, year: 2030, month: 4, employeeIds: [e] });
    const line = plan.rows.find((r) => r.employeeId === e)!;
    // April 2030: 15 days at 3000 + 15 days at 6000, calendar-day basis.
    expect(line.basicSalary).toBe(4500);
    // A hire whose pay is not decided yet has no compensation: no line.
    const hire = await newHire();
    const none = await computeGenerationPlan(prisma, { companyId, year: 2030, month: 4, employeeIds: [hire.id] });
    expect(none.plan.rows).toEqual([]);
  });
});
