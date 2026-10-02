// P1-FND-EFF against a real PostgreSQL with all migrations applied (9u_effective_periods).
// Opt-in: EFF_IT=1 with DATABASE_URL pointing at a THROWAWAY database. Every test builds its own
// company and employees (random tag); rows are not cleaned up (period, audit and event tables refuse
// DELETE by design).
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { allowanceLine } from '@/lib/payroll-core';
import { moneyFixture } from '@/test/money-fixtures';

const RUN = process.env.EFF_IT === '1';

describe.skipIf(!RUN)('effective periods on PostgreSQL', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const platform = await import('@/modules/platform');
  const { callAllowanceLine } = await import('../sql/effective');
  const {
    openPeriod, supersedePeriod, closePeriod, activeAt, lineageOf, periodsOf, effectiveContext, openLegacyPeriod, backfillLegacyOpenings,
    PeriodOverlapError, EffectiveScopeError,
  } = platform;

  const SYS = { type: 'SYSTEM' as const, id: 'effective-it' };
  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const src = (t: string) => ({ type: 'IT_DECISION', id: t });

  async function company(t: string) {
    return prisma.company.create({ data: { nameArabic: `شركة ${t}`, commercialRegNum: `IT-${t}`, commercialRegExp: new Date('2030-01-01') } });
  }
  async function employee(t: string, data: Record<string, unknown> = {}) {
    return prisma.employee.create({
      data: {
        employeeId: `IT-${t}`,
        firstNameArabic: 'موظف',
        lastNameArabic: t,
        nationality: 'SA',
        iqamaOrIdNumber: `IT${t}`,
        iqamaOrIdExp: new Date('2030-01-01'),
        dateOfBirth: new Date('1990-01-01'),
        gender: 'M',
        joinDate: new Date('2024-01-01'),
        basicSalary: 5000,
        ...data,
      },
    });
  }
  const tx = <T>(fn: (t: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) => prisma.$transaction(fn);
  const comp = (basicSalary: number) => ({ basicSalary, allowances: [{ name: 'بدل سكن', line: 'HOUSING' as const, amount: 1000, countsTowardGosi: true }] });

  it('the database refuses two overlapping active periods (EXCLUDE, INV-EFF-01), not only the application', async () => {
    const t = tag();
    const e = await employee(t);
    const row = (validFrom: string, validTo: string | null) => ({
      id: randomUUID(), employeeId: e.id, validFrom: new Date(`${validFrom}T00:00:00Z`), validTo: validTo ? new Date(`${validTo}T00:00:00Z`) : null,
      lineageId: randomUUID(), sourceType: 'IT_DECISION', sourceId: t,
    });
    const first = await prisma.employmentPeriod.create({ data: row('2024-01-01', '2024-07-01') });
    await prisma.employmentPeriod.create({ data: row('2024-07-01', null) }); // adjacent: [a,b) and [b,…) do not overlap
    await expect(prisma.employmentPeriod.create({ data: row('2024-06-30', '2024-07-02') })).rejects.toThrow(/exclusion constraint|no_overlap/);
    await expect(prisma.employmentPeriod.create({ data: row('2030-01-01', null) })).rejects.toThrow(/exclusion constraint|no_overlap/);
    // A superseded row no longer counts (the WHERE of the constraint): its days can be taken again.
    await prisma.employmentPeriod.update({ where: { id: first.id }, data: { supersededAt: new Date(), supersedeReason: 'VOID' } });
    await prisma.employmentPeriod.create({ data: row('2024-02-01', '2024-03-01') });
    // A row cannot arrive already superseded, and a supersede mark is set once.
    await expect(prisma.employmentPeriod.create({ data: { ...row('2020-01-01', '2020-02-01'), supersededAt: new Date(), supersedeReason: 'VOID' } })).rejects.toThrow(/already superseded/);
    await expect(prisma.employmentPeriod.update({ where: { id: first.id }, data: { supersedeReason: 'CORRECTION' } })).rejects.toThrow(/append-only/);
  });

  it('the application refuses the overlap too, with a named error, and the transaction commits nothing', async () => {
    const t = tag();
    const e = await employee(t);
    await tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:a`, actor: SYS }));
    await expect(
      tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2025-01-01', source: src(t), attrs: comp(6000) }, { key: `${t}:b`, actor: SYS })),
    ).rejects.toThrow(PeriodOverlapError);
    expect(await prisma.compensationPeriod.count({ where: { employeeId: e.id } })).toBe(1);
    expect(await prisma.operationLog.count({ where: { operationKey: { startsWith: `${t}:b` } } })).toBe(0);
  });

  it('rows are append-only: no rewrite, no delete (trigger)', async () => {
    const t = tag();
    const e = await employee(t);
    const { period } = await tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:o`, actor: SYS }));
    await expect(prisma.compensationPeriod.update({ where: { id: period.id }, data: { basicSalary: 9999 } })).rejects.toThrow(/append-only/);
    await expect(prisma.compensationPeriod.update({ where: { id: period.id }, data: { validTo: new Date('2025-01-01') } })).rejects.toThrow(/append-only/);
    await expect(prisma.compensationPeriod.delete({ where: { id: period.id } })).rejects.toThrow(/never deleted/);
  });

  it('supersede keeps the lineage: the successor inherits lineageId and points at the row it replaces', async () => {
    const t = tag();
    const e = await employee(t);
    const opened = await tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:o`, actor: SYS }));
    const r = await tx((t1) =>
      supersedePeriod(t1, 'COMPENSATION', opened.period.id, { reason: 'CORRECTION', source: { type: 'IT_CORRECTION', id: t }, successor: { attrs: { basicSalary: 5500 } } }, { key: `${t}:s`, actor: SYS }),
    );
    expect(r.successor?.lineageId).toBe(opened.period.lineageId);
    expect(r.successor?.supersedesId).toBe(opened.period.id);
    expect(r.superseded.supersedeReason).toBe('CORRECTION');
    expect(r.successor?.attrs.basicSalary).toBe(5500);
    expect(r.successor?.attrs.allowances).toEqual(opened.period.attrs.allowances); // copied, not lost
    const chain = await lineageOf(prisma, 'COMPENSATION', opened.period.lineageId);
    expect(chain.map((p) => p.id)).toEqual([opened.period.id, r.successor?.id]);
    expect((await activeAt(prisma, 'COMPENSATION', e.id, '2024-06-01'))?.id).toBe(r.successor?.id);
    // The replaced row cannot be superseded twice.
    await expect(
      tx((t1) => supersedePeriod(t1, 'COMPENSATION', opened.period.id, { reason: 'VOID', source: src(t) }, { key: `${t}:s2`, actor: SYS })),
    ).rejects.toThrow(/already superseded/);
  });

  it('void = supersede without a successor (ADR-0002 #3): the row stays, nothing is active', async () => {
    const t = tag();
    const e = await employee(t);
    const opened = await tx((t1) => openPeriod(t1, 'EMPLOYMENT', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: {} as never }, { key: `${t}:o`, actor: SYS }));
    const r = await tx((t1) => supersedePeriod(t1, 'EMPLOYMENT', opened.period.id, { reason: 'VOID', source: src(t) }, { key: `${t}:v`, actor: SYS }));
    expect(r.successor).toBeNull();
    expect(r.superseded.supersedeReason).toBe('VOID');
    expect(await activeAt(prisma, 'EMPLOYMENT', e.id, '2024-06-01')).toBeNull();
    const all = await periodsOf(prisma, 'EMPLOYMENT', e.id, { includeSuperseded: true });
    expect(all).toHaveLength(1);
    expect(await prisma.domainEvent.count({ where: { type: 'employment.periodSuperseded', aggregateId: opened.period.lineageId } })).toBe(1);
    // After a void, a new period may take the same days.
    await tx((t1) => openPeriod(t1, 'EMPLOYMENT', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: {} as never }, { key: `${t}:o2`, actor: SYS }));
  });

  it('an as-recorded read returns the old view (DOMAIN_MODEL §1.3 rule 4)', async () => {
    const t = tag();
    const c = await company(t);
    const e = await employee(t, { legalCompanyId: c.id });
    const beforeAnything = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await tx((t1) => openPeriod(t1, 'ASSIGNMENT', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: { legalCompanyId: c.id } }, { key: `${t}:a`, actor: SYS }));
    const opened = await tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:o`, actor: SYS }));
    await new Promise((r) => setTimeout(r, 20));
    const asOfApproval = new Date(); // e.g. when the August payroll was approved
    await new Promise((r) => setTimeout(r, 20));
    await tx((t1) =>
      supersedePeriod(t1, 'COMPENSATION', opened.period.id, { reason: 'CORRECTION', source: { type: 'IT_RETRO', id: t }, successor: { attrs: { basicSalary: 7000 } } }, { key: `${t}:s`, actor: SYS }),
    );
    const now = await effectiveContext(prisma, e.id, '2024-08-15', { companyIds: [c.id] });
    const then = await effectiveContext(prisma, e.id, '2024-08-15', { companyIds: [c.id], asRecordedAt: asOfApproval });
    expect(now.compensation?.basicSalary).toBe(7000);
    expect(then.compensation?.basicSalary).toBe(5000);
    expect(then.compensation?.periodId).toBe(opened.period.id);
    expect(then.compensation?.lineageId).toBe(now.compensation?.lineageId);
    expect(await activeAt(prisma, 'COMPENSATION', e.id, '2024-08-15', { asRecordedAt: beforeAnything })).toBeNull();
  });

  it('closePeriod: in place for EMPLOYMENT (ADR-0001 #9), a shortened successor for the other kinds', async () => {
    const t = tag();
    const e = await employee(t);
    const emp = await tx((t1) => openPeriod(t1, 'EMPLOYMENT', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: {} as never }, { key: `${t}:e`, actor: SYS }));
    const closed = await tx((t1) => closePeriod(t1, 'EMPLOYMENT', emp.period.id, { validTo: '2025-07-01', source: src(t) }, { key: `${t}:ec`, actor: SYS }));
    expect(closed.period.id).toBe(emp.period.id);
    expect(closed.period.validTo).toBe('2025-07-01');
    expect(closed.superseded).toBeNull();
    // Reopen (DEC-PO-043): the end goes back to NULL in place.
    const reopened = await tx((t1) => closePeriod(t1, 'EMPLOYMENT', emp.period.id, { validTo: null, source: src(t) }, { key: `${t}:er`, actor: SYS }));
    expect(reopened.period.validTo).toBeNull();

    const cp = await tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:c`, actor: SYS }));
    const cc = await tx((t1) => closePeriod(t1, 'COMPENSATION', cp.period.id, { validTo: '2025-01-01', source: src(t) }, { key: `${t}:cc`, actor: SYS }));
    expect(cc.superseded?.id).toBe(cp.period.id);
    expect(cc.superseded?.supersedeReason).toBe('CLOSE');
    expect(cc.period.lineageId).toBe(cp.period.lineageId);
    expect(cc.period.validTo).toBe('2025-01-01');
    expect(await activeAt(prisma, 'COMPENSATION', e.id, '2025-01-01')).toBeNull();
    await expect(tx((t1) => closePeriod(t1, 'COMPENSATION', cc.period.id, { validTo: null, source: src(t) }, { key: `${t}:cr`, actor: SYS }))).rejects.toThrow(/reopened by a new decision/);
  });

  it('double call of openPeriod with the same operation key: one period, one event, one audit row (idempotent)', async () => {
    const t = tag();
    const e = await employee(t);
    const call = () => tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:same`, actor: SYS }));
    const first = await call();
    const second = await call();
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.period).toEqual(first.period);
    expect(await prisma.compensationPeriod.count({ where: { employeeId: e.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'compensation.periodOpened', aggregateId: first.period.lineageId } })).toBe(1);
    expect(await prisma.auditRecord.count({ where: { operationKey: `${t}:same`, entityId: first.period.id } })).toBe(1);
  });

  it('effectiveContext is company-aware: the legal company of the assignment on that day decides', async () => {
    const t = tag();
    const [c1, c2] = [await company(`${t}a`), await company(`${t}b`)];
    const e = await employee(t);
    await tx(async (t1) => {
      await openPeriod(t1, 'EMPLOYMENT', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: {} as never }, { key: `${t}:e`, actor: SYS });
      await openPeriod(t1, 'ASSIGNMENT', { employeeId: e.id, validFrom: '2024-01-01', validTo: '2025-01-01', source: src(t), attrs: { legalCompanyId: c1.id } }, { key: `${t}:a1`, actor: SYS });
      await openPeriod(t1, 'ASSIGNMENT', { employeeId: e.id, validFrom: '2025-01-01', source: src(t), attrs: { legalCompanyId: c2.id } }, { key: `${t}:a2`, actor: SYS });
      await openPeriod(t1, 'COMPENSATION', { employeeId: e.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:c`, actor: SYS });
    });
    const inC1 = await effectiveContext(prisma, e.id, '2024-06-01', { companyIds: [c1.id] });
    expect(inC1).toMatchObject({ inService: true, assignment: { legalCompanyId: c1.id }, compensation: { basicSalary: 5000, housing: 1000, gosiBase: 6000 } });
    await expect(effectiveContext(prisma, e.id, '2025-06-01', { companyIds: [c1.id] })).rejects.toThrow(EffectiveScopeError);
    expect((await effectiveContext(prisma, e.id, '2025-06-01', { companyIds: [c2.id] })).assignment?.legalCompanyId).toBe(c2.id);
    expect((await effectiveContext(prisma, e.id, '2025-06-01', { companyIds: null })).assignment?.legalCompanyId).toBe(c2.id);
    // No assignment on the day: a scoped caller cannot decide, so it is refused (fail closed).
    await expect(effectiveContext(prisma, e.id, '2023-06-01', { companyIds: [c1.id] })).rejects.toThrow(EffectiveScopeError);
  });

  it('the legacy backfill is complete and idempotent: one opening per employee and kind where data exists, skips reported with reasons', async () => {
    const t = tag();
    const c = await company(t);
    const other = await company(`${t}x`);
    const branch = await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${t}` } });
    const dept = await prisma.department.create({ data: { branchId: branch.id, nameArabic: `قسم ${t}` } });
    const boss = await employee(`${t}m`, { legalCompanyId: c.id, actualCompanyId: c.id, branchId: branch.id, departmentId: dept.id, basicSalary: 9000 });
    const active = await employee(`${t}a`, { legalCompanyId: c.id, actualCompanyId: c.id, branchId: branch.id, departmentId: dept.id, directManagerId: boss.id, joinDate: new Date('2022-03-15') });
    await moneyFixture((tx) => tx.allowance.createMany({
      data: [
        { employeeId: active.id, name: 'بدل سكن', amount: 1250, isMonthly: true, countsTowardGosi: true, allowanceType: 'HOUSING' },
        { employeeId: active.id, name: 'بدل مواصلات', amount: 500, isMonthly: true, countsTowardGosi: false },
        { employeeId: active.id, name: 'مكافأة', amount: 2000, isMonthly: false },
      ],
    }));
    const left = await employee(`${t}l`, { legalCompanyId: c.id, joinDate: new Date('2023-01-01'), isTerminated: true, terminationDate: new Date('2025-06-30') });
    const noDate = await employee(`${t}n`, { legalCompanyId: c.id, isTerminated: true, terminationDate: null });
    const noLegal = await employee(`${t}q`, { actualCompanyId: c.id, basicSalary: 0 });
    const inverted = await employee(`${t}i`, { legalCompanyId: c.id, joinDate: new Date('2024-05-01'), isTerminated: true, terminationDate: new Date('2024-04-01') });
    const elsewhere = await employee(`${t}o`, { legalCompanyId: other.id });

    const first = await tx((t1) => backfillLegacyOpenings(t1, [c.id], 'effective-it'));
    const pick = (kind: string, outcome: string, reason: string | null = null) => first.find((r) => r.kind === kind && r.outcome === outcome && r.reason === reason);
    expect(pick('EMPLOYMENT', 'OPENED')?.employees).toBe(4); // boss, active, left, noLegal
    expect(pick('COMPENSATION', 'OPENED')?.employees).toBe(3); // noLegal has no basic salary
    expect(pick('ASSIGNMENT', 'OPENED')?.employees).toBe(3); // noLegal has no legal company
    expect(pick('EMPLOYMENT', 'SKIPPED', 'TERMINATED_WITHOUT_DATE')?.employeeIds).toEqual([noDate.id]);
    expect(pick('EMPLOYMENT', 'SKIPPED', 'TERMINATION_BEFORE_JOIN')?.employeeIds).toEqual([inverted.id]);
    expect(pick('COMPENSATION', 'SKIPPED', 'NO_BASIC_SALARY')?.employeeIds).toEqual([noLegal.id]);
    expect(pick('ASSIGNMENT', 'SKIPPED', 'NO_LEGAL_COMPANY')?.employeeIds).toEqual([noLegal.id]);
    expect(await prisma.employmentPeriod.count({ where: { employeeId: elsewhere.id } })).toBe(0); // other company not in scope

    // Complete: every opened employee has exactly one LEGACY_OPENING per kind, with today's data.
    const ctx = await effectiveContext(prisma, active.id, '2026-01-01', { companyIds: [c.id] });
    expect(ctx.employment).toMatchObject({ validFrom: '2022-03-15', validTo: null, source: { type: 'LEGACY_OPENING', id: active.id } });
    expect(ctx.assignment).toMatchObject({ legalCompanyId: c.id, actualCompanyId: c.id, branchId: branch.id, departmentId: dept.id, managerId: boss.id });
    expect(ctx.compensation).toMatchObject({ basicSalary: 5000, housing: 1250, transport: 500, otherAllowances: 0, gosiBase: 6250 });
    expect(ctx.compensation?.allowances).toHaveLength(2); // the one-off bonus is not a fixed allowance
    const leftCtx = await effectiveContext(prisma, left.id, '2025-06-30', { companyIds: [c.id] });
    expect(leftCtx.employment?.validTo).toBe('2025-07-01'); // last working day + 1
    expect(leftCtx.compensation?.validTo).toBe('2025-07-01');
    expect((await effectiveContext(prisma, left.id, '2025-07-01', { companyIds: null })).inService).toBe(false);

    // Idempotent: the second run opens nothing. Counted over this test's employees only: other IT files
    // running in parallel on the same database open legacy periods of their own.
    const mine = { sourceType: 'LEGACY_OPENING', employeeId: { in: [boss.id, active.id, left.id, noLegal.id, noDate.id, inverted.id, elsewhere.id] } };
    const counts = async () => Promise.all([
      prisma.employmentPeriod.count({ where: mine }),
      prisma.compensationPeriod.count({ where: mine }),
      prisma.assignmentPeriod.count({ where: mine }),
    ]);
    const before = await counts();
    const second = await tx((t1) => backfillLegacyOpenings(t1, [c.id], 'effective-it'));
    expect(await counts()).toEqual(before);
    expect(second.filter((r) => r.outcome === 'OPENED')).toEqual([]);
    expect(second.find((r) => r.kind === 'EMPLOYMENT' && r.outcome === 'ALREADY_OPENED')?.employees).toBe(4);
  });

  it('openLegacyPeriod (the TypeScript door to the same SQL writer) opens once and never under existing periods', async () => {
    const t = tag();
    const c = await company(t);
    const e = await employee(t, { legalCompanyId: c.id });
    const f = await employee(`${t}f`, { legalCompanyId: c.id });
    const a = await tx((t1) => openLegacyPeriod(t1, 'ASSIGNMENT', { employeeId: e.id, validFrom: '2024-01-01', attrs: { legalCompanyId: c.id } }, SYS));
    const b = await tx((t1) => openLegacyPeriod(t1, 'ASSIGNMENT', { employeeId: e.id, validFrom: '2024-01-01', attrs: { legalCompanyId: c.id } }, SYS));
    expect(a.outcome).toBe('OPENED');
    expect(b).toEqual({ periodId: a.periodId, outcome: 'ALREADY_OPENED' });
    expect(await prisma.auditRecord.count({ where: { entityId: a.periodId, action: 'assignment.period.legacyOpen' } })).toBe(1);
    await tx((t1) => openPeriod(t1, 'COMPENSATION', { employeeId: f.id, validFrom: '2024-01-01', source: src(t), attrs: comp(5000) }, { key: `${t}:c`, actor: SYS }));
    const skipped = await tx((t1) => openLegacyPeriod(t1, 'COMPENSATION', { employeeId: f.id, validFrom: '2024-01-01', attrs: comp(4000) }, SYS));
    expect(skipped).toEqual({ periodId: null, outcome: 'SKIPPED_HAS_PERIODS' });
    // Concurrent openings of the same employee and kind: still one row (advisory lock + unique index).
    const g = await employee(`${t}g`, { legalCompanyId: c.id });
    const both = await Promise.allSettled([1, 2].map(() => tx((t1) => openLegacyPeriod(t1, 'EMPLOYMENT', { employeeId: g.id, validFrom: '2024-01-01', attrs: {} as never }, SYS))));
    expect(both.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.employmentPeriod.count({ where: { employeeId: g.id } })).toBe(1);
  });

  it('the SQL allowance classification of the legacy opening matches allowanceLine() of payroll-core', async () => {
    const cases: [string | null, string | null][] = [
      ['HOUSING', 'x'], ['housing', 'بدل نقل'], ['TRANSPORT', null], ['transport', 'سكن'], ['FOOD', 'بدل سكن'], ['OTHER', 'transport'],
      [null, 'بدل سكن'], [null, 'Housing allowance'], [null, 'بدل مواصلات'], [null, 'بدل نقل'], [null, 'TRANSPORTATION'], [null, 'بدل جوال'],
      [null, null], ['', 'بدل سكن'], [' ', 'بدل سكن'],
    ];
    for (const [type, name] of cases) {
      expect(await callAllowanceLine(prisma, type, name), `${type} / ${name}`).toBe(allowanceLine({ allowanceType: type, name }));
    }
  });
});
