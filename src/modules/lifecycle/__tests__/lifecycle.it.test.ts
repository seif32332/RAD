// lifecycle.transitionEmploymentState against a real PostgreSQL with every migration applied
// (9y_employment_state). Opt-in: LCY_IT=1 with DATABASE_URL pointing at a THROWAWAY database (rows
// are not cleaned up; the facts are append-only anyway).
//
// Every transition (HIRE, T1, T1c, T2, T3, T3n, T4, D1, V1) is called twice with the same operation
// key, one after the other and concurrently, and must leave one fact, one event set and one
// projection (ARCH-014, ARC-LCY-A5).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.LCY_IT === '1';

describe.skipIf(!RUN)('lifecycle transitions on PostgreSQL (P1-LCY)', { timeout: 120_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const lcy = await import('@/modules/lifecycle');
  const { runEmploymentTransition, transitionEmploymentState, completeDueNotices, openMissingStates, employmentAt, stateHistory, migrationReviews } = lcy;

  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const users = { hr1: '', hr2: '' };
  let co = '';
  let otherCo = '';

  const now = new Date('2026-10-10T09:00:00Z'); // Riyadh 2026-10-10
  const ref = new Date('2026-10-01T00:00:00Z');

  beforeAll(async () => {
    const t = tag();
    co = (await prisma.company.create({ data: { nameArabic: `LCY ${t}`, commercialRegNum: `LCY-${t}`, commercialRegExp: new Date('2030-01-01') } })).id;
    otherCo = (await prisma.company.create({ data: { nameArabic: `LCY-B ${t}`, commercialRegNum: `LCYB-${t}`, commercialRegExp: new Date('2030-01-01') } })).id;
    for (const k of ['hr1', 'hr2'] as const) {
      users[k] = (await prisma.user.create({ data: { email: `${k}-${t}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
    }
  });

  async function employee(over: Record<string, unknown> = {}) {
    const t = tag();
    return prisma.employee.create({
      data: {
        employeeId: `LCY-${t}`, firstNameArabic: 'موظف', lastNameArabic: t, nationality: 'SA', iqamaOrIdNumber: `LCY${t}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'),
        basicSalary: 5000, legalCompanyId: co, ...over,
      },
    });
  }

  type Input = Parameters<typeof runEmploymentTransition>[1];
  const input = (employeeId: string, over: Partial<Input>): Input => ({
    employeeId,
    command: 'EXIT',
    source: { type: 'TEST', id: employeeId },
    actor: { type: 'USER', id: users.hr1 },
    operationKey: `it:${randomUUID()}`,
    companyIds: [co],
    now,
    noticeReleased: true,
    ...over,
  });
  const run = (i: Input) => runEmploymentTransition(prisma, i);

  const facts = (employeeId: string) => prisma.employmentStateChange.findMany({ where: { employeeId }, orderBy: { seq: 'asc' } });
  const events = (employeeId: string, type?: string) => prisma.domainEvent.count({ where: { aggregateType: 'Employee', aggregateId: employeeId, ...(type ? { type } : {}) } });
  const emp = (id: string) => prisma.employee.findUniqueOrThrow({ where: { id } });
  const periods = (employeeId: string) => prisma.employmentPeriod.findMany({ where: { employeeId }, orderBy: { validFrom: 'asc' } });
  const key = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  /** Sequential double call with one key, then a concurrent pair with another key on a twin state. */
  async function twice(i: Input) {
    const a = await run(i);
    const b = await run(i);
    expect(b.replayed).toBe(true);
    expect({ ...b, replayed: false }).toEqual({ ...a, replayed: false });
    return a;
  }
  async function concurrently(i: Input) {
    const [a, b] = await Promise.all([run(i), run(i)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.stateChangeId).toBe(b.stateChangeId);
    return a.replayed ? b : a;
  }

  it('the opening (LCY-J1): the first transition of an employee without a fact opens its state and period first', async () => {
    const e = await employee();
    const r = await run(input(e.id, { date: '2026-10-05', exitReason: 'RESIGNATION' }));
    expect(r.opened).toBe(true);
    const f = await facts(e.id);
    expect(f.map((x) => x.transition)).toEqual(['LEGACY_OPENING', 'TERMINATE']);
    expect(f[0]).toMatchObject({ toState: 'ACTIVE', fromState: null, sourceType: 'LEGACY_OPENING', companyId: co });
    expect(f[1].employmentLineageId).toBe(f[0].employmentLineageId);
    expect(await events(e.id, 'employment.terminated')).toBe(1);
  });

  it('openMissingStates maps the legacy projections (lcy-to-be.md §17) and is idempotent', async () => {
    const active = await employee();
    const activeWithDate = await employee({ terminationDate: new Date('2025-01-31') });
    const noDate = await employee({ isTerminated: true, employmentStatus: 'EXCLUDED' });
    const future = await employee({ isTerminated: true, employmentStatus: 'EXCLUDED', terminationDate: new Date('2099-01-31') });
    const past = await employee({ isTerminated: true, employmentStatus: 'EXCLUDED', terminationDate: new Date('2025-06-30'), exitReason: 'RESIGNATION' });
    await openMissingStates(prisma, co);
    const second = await openMissingStates(prisma, co);
    expect(second).toMatchObject({ missing: 0 });
    const opening = async (id: string) => (await facts(id))[0];
    expect(await opening(active.id)).toMatchObject({ toState: 'ACTIVE', terminationDate: null });
    const awd = await opening(activeWithDate.id);
    expect(awd).toMatchObject({ toState: 'ACTIVE', terminationDate: null });
    // The review codes are EmploymentMigrationReview rows (9zd); legacy keeps only the values found.
    const codes = async (id: string) => (await migrationReviews(prisma, id)).map((r) => r.code).sort();
    expect(await codes(activeWithDate.id)).toContain('ACTIVE_WITH_TERMINATION_DATE');
    expect(awd.legacy).not.toHaveProperty('review');
    expect((awd.legacy as { terminationDate: string }).terminationDate).toBe('2025-01-31');
    const [awdReview] = await migrationReviews(prisma, activeWithDate.id);
    expect(awdReview).toMatchObject({ stateChangeId: awd.id, details: { terminationDate: '2025-01-31', isTerminated: false }, resolvedAt: null });
    expect((await emp(activeWithDate.id)).terminationDate).toBeNull();
    expect(await codes(noDate.id)).toEqual(['NO_EMPLOYMENT_PERIOD', 'TERMINATED_WITHOUT_DATE']);
    expect(await opening(future.id)).toMatchObject({ toState: 'TERMINATED' });
    expect(await codes(future.id)).toContain('NOTICE_CANDIDATE');
    expect(await codes(active.id)).toEqual([]);
    expect(await opening(past.id)).toMatchObject({ toState: 'TERMINATED', exitReason: 'RESIGNATION' });
    expect(key((await periods(past.id))[0].validTo)).toBe('2025-07-01');
    for (const x of [active, activeWithDate, noDate, future, past]) expect((await emp(x.id)).employmentState).toBe((await opening(x.id)).toState);
    expect(await events(past.id)).toBe(0); // a data migration emits no event (ARC-LCY-A2)
  });

  it('T3 transitionEmploymentState double call, sequential and concurrent, with one key: one fact, one event, projection and period (idempotent)', async () => {
    const e = await employee();
    const i = input(e.id, { date: '2026-10-05', exitReason: 'EMPLOYER_TERMINATION', exitVoluntary: false });
    const r = await twice(i);
    expect(r).toMatchObject({ changed: true, transition: 'TERMINATE', toState: 'TERMINATED', terminationDate: '2026-10-05' });
    const e2 = await employee();
    await concurrently(input(e2.id, { date: '2026-10-05', operationKey: `it:${randomUUID()}` }));
    for (const id of [e.id, e2.id]) {
      expect((await facts(id)).filter((f) => f.transition === 'TERMINATE')).toHaveLength(1);
      expect(await events(id, 'employment.terminated')).toBe(1);
      const x = await emp(id);
      expect([x.employmentState, x.isTerminated, key(x.terminationDate), x.employmentStatus]).toEqual(['TERMINATED', true, '2026-10-05', 'EXCLUDED']);
      expect(key((await periods(id))[0].validTo)).toBe('2026-10-06');
    }
  });

  it('T3 repeat with another key: same date is nothing, another date is refused (EX-LCY-002)', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-10-05' }));
    const again = await run(input(e.id, { date: '2026-10-05' }));
    expect(again).toMatchObject({ changed: false, noChangeReason: 'SAME_STATE_SAME_DATE' });
    await expect(run(input(e.id, { date: '2026-10-01' }))).rejects.toMatchObject({ status: 409 });
    expect((await facts(e.id)).filter((f) => f.transition === 'TERMINATE')).toHaveLength(1);
  });

  it('T3 of an employee with a login: the login ends in the same transaction (documents-only window)', async () => {
    const u = await prisma.user.create({ data: { email: `emp-${tag()}@example.test`, passwordHash: 'x', role: 'EMPLOYEE' } });
    const e = await employee({ userId: u.id });
    const r = await run(input(e.id, { date: '2026-10-05', access: { documentsAccess: false } }));
    expect(r.access).toMatchObject({ hasUser: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).isActive).toBe(false);
  });

  it('T1 NOTICE through runEmploymentTransition, double call (sequential and concurrent): the date is set, the employee stays in service', async () => {
    const e = await employee();
    const r = await twice(input(e.id, { date: '2026-10-31', exitReason: 'RESIGNATION', exitVoluntary: true }));
    expect(r).toMatchObject({ transition: 'NOTICE', toState: 'NOTICE' });
    const e2 = await employee();
    await concurrently(input(e2.id, { date: '2026-10-31' }));
    for (const id of [e.id, e2.id]) {
      const x = await emp(id);
      expect([x.employmentState, x.isTerminated, key(x.terminationDate)]).toEqual(['NOTICE', false, '2026-10-31']);
      expect(await events(id, 'employment.noticeStarted')).toBe(1);
      expect(key((await periods(id))[0].validTo)).toBe('2026-11-01');
    }
  });

  it('T1c CANCEL_EXIT double call needs a second person, reopens the period and clears the exit', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-10-31', exitReason: 'RESIGNATION' }));
    await expect(run(input(e.id, { command: 'CANCEL_EXIT' }))).rejects.toMatchObject({ status: 409, details: { code: 'TWO_PERSON_REQUIRED' } });
    await expect(run(input(e.id, { command: 'CANCEL_EXIT', approvedById: users.hr1 }))).rejects.toMatchObject({ status: 403 });
    const r = await twice(input(e.id, { command: 'CANCEL_EXIT', approvedById: users.hr2, reason: 'سحب الاستقالة' }));
    expect(r).toMatchObject({ transition: 'CANCEL_EXIT', toState: 'ACTIVE', approvedById: users.hr2, singleOperator: false, terminationDate: null, exitReason: null });
    const x = await emp(e.id);
    expect([x.employmentState, x.terminationDate]).toEqual(['ACTIVE', null]);
    expect((await periods(e.id))[0].validTo).toBeNull();
    const e2 = await employee();
    await run(input(e2.id, { date: '2026-10-31' }));
    await concurrently(input(e2.id, { command: 'CANCEL_EXIT', approvedById: users.hr2 }));
    expect(await events(e2.id, 'employment.exitCancelled')).toBe(1);
  });

  it('T2 NOTICE_END: the job ends due notices once (double run), and the transition is idempotent concurrently', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-10-12' }));
    const before = await completeDueNotices(prisma, co, { now });
    expect(before).toMatchObject({ terminated: 0 });
    const later = new Date('2026-10-13T09:00:00Z');
    const first = await completeDueNotices(prisma, co, { now: later });
    expect(first.terminated).toBeGreaterThanOrEqual(1);
    const second = await completeDueNotices(prisma, co, { now: later });
    expect(second).toMatchObject({ due: 0, terminated: 0 });
    const x = await emp(e.id);
    expect([x.employmentState, x.isTerminated, key(x.terminationDate)]).toEqual(['TERMINATED', true, '2026-10-12']);
    const f = (await facts(e.id)).filter((c) => c.transition === 'NOTICE_END');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ actorId: null, sourceType: 'SYSTEM' });
    const e2 = await employee();
    await run(input(e2.id, { date: '2026-10-12' }));
    await concurrently(input(e2.id, { command: 'NOTICE_END', actor: { type: 'SYSTEM', id: 'employment-notice-end' }, now: later }));
    expect(await events(e2.id, 'employment.terminated')).toBe(1);
  });

  it('T3n TERMINATE_IN_NOTICE double call: absconding during the notice replaces the reason and advances the date', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-10-31', exitReason: 'RESIGNATION' }));
    const r = await twice(input(e.id, { date: '2026-10-08', fromNotice: 'TERMINATE_IN_NOTICE', exitReason: 'ABSCONDING', approvedById: users.hr2 }));
    expect(r).toMatchObject({ transition: 'TERMINATE_IN_NOTICE', toState: 'TERMINATED', exitReason: 'ABSCONDING', terminationDate: '2026-10-08' });
    expect(key((await periods(e.id))[0].validTo)).toBe('2026-10-09');
    const e2 = await employee();
    await run(input(e2.id, { date: '2026-10-31' }));
    await concurrently(input(e2.id, { command: 'TERMINATE_IN_NOTICE', date: '2026-10-08', approvedById: users.hr2 }));
  });

  it('T4 REHIRE double call: a new lineage and period after the old end; refused in NOTICE', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-09-30' }));
    const r = await twice(input(e.id, { command: 'REHIRE', date: '2026-10-05', approvedById: users.hr2 }));
    expect(r).toMatchObject({ transition: 'REHIRE', toState: 'ACTIVE', terminationDate: null });
    const ps = await periods(e.id);
    expect(ps.map((p) => [key(p.validFrom), key(p.validTo)])).toEqual([['2024-01-01', '2026-10-01'], ['2026-10-05', null]]);
    expect(ps[0].lineageId).not.toBe(ps[1].lineageId);
    expect(r.employmentLineageId).toBe(ps[1].lineageId);
    const x = await emp(e.id);
    expect([x.employmentState, x.isTerminated, x.terminationDate]).toEqual(['ACTIVE', false, null]);
    const e2 = await employee();
    await run(input(e2.id, { date: '2026-09-30' }));
    await concurrently(input(e2.id, { command: 'REHIRE', date: '2026-10-05', approvedById: users.hr2 }));
    const e3 = await employee();
    await run(input(e3.id, { date: '2026-10-31' }));
    await expect(run(input(e3.id, { command: 'REHIRE', date: '2026-12-01', approvedById: users.hr2 }))).rejects.toMatchObject({ status: 409, details: { code: 'IN_NOTICE' } });
  });

  it('D1 AMEND double call: a new fact superseding the last one; as recorded before, the old end stays readable (ADR-0002 #4)', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-10-05', exitReason: 'RESIGNATION' }));
    const t = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const r = await twice(input(e.id, { command: 'AMEND', date: '2026-10-03', amendsReason: true, exitReason: 'ARTICLE_80', exitVoluntary: false, approvedById: users.hr2 }));
    expect(r).toMatchObject({ transition: 'AMEND', toState: 'TERMINATED', terminationDate: '2026-10-03', exitReason: 'ARTICLE_80' });
    const hist = await stateHistory(prisma, e.id);
    const amend = hist[hist.length - 1];
    expect(amend.supersedesId).toBe(hist[hist.length - 2].id);
    expect(hist[hist.length - 2].supersededById).toBe(amend.id);
    expect(key((await periods(e.id))[0].validTo)).toBe('2026-10-04');
    expect(await employmentAt(prisma, e.id, '2026-10-04', { asRecordedAt: t })).not.toBeNull();
    expect(await employmentAt(prisma, e.id, '2026-10-04')).toBeNull();
    // Postponed after the end (DEC-PO-043): back to NOTICE, the period reopens in place.
    const back = await run(input(e.id, { command: 'AMEND', date: '2026-10-20', approvedById: users.hr2 }));
    expect(back).toMatchObject({ fromState: 'TERMINATED', toState: 'NOTICE', loginReenableRequired: true });
    expect((await emp(e.id)).isTerminated).toBe(false);
    const e2 = await employee();
    await run(input(e2.id, { date: '2026-10-05' }));
    await concurrently(input(e2.id, { command: 'AMEND', date: '2026-10-02', approvedById: users.hr2 }));
    expect(await events(e2.id, 'employment.lastWorkingDayChanged')).toBe(1);
  });

  it('V1 VOID double call: a rehire in error returns to the previous end; the period is superseded (VOID)', async () => {
    const e = await employee();
    await run(input(e.id, { date: '2026-09-30', exitReason: 'RESIGNATION' }));
    const rehire = await run(input(e.id, { command: 'REHIRE', date: '2026-10-05', approvedById: users.hr2 }));
    const r = await twice(input(e.id, { command: 'VOID', approvedById: users.hr2 }));
    expect(r).toMatchObject({ transition: 'VOID', toState: 'TERMINATED', terminationDate: '2026-09-30', exitReason: 'RESIGNATION' });
    const voided = await prisma.employmentPeriod.findUniqueOrThrow({ where: { id: rehire.periodId as string } });
    expect(voided.supersedeReason).toBe('VOID');
    const x = await emp(e.id);
    expect([x.employmentState, key(x.terminationDate)]).toEqual(['TERMINATED', '2026-09-30']);
    const e2 = await employee();
    await run(input(e2.id, { date: '2026-09-30' }));
    await run(input(e2.id, { command: 'REHIRE', date: '2026-10-05', approvedById: users.hr2 }));
    await concurrently(input(e2.id, { command: 'VOID', approvedById: users.hr2 }));
    expect(await events(e2.id, 'employment.voided')).toBe(1);
  });

  it('HIRE double call: a new employee without a fact gets its period and ACTIVE state; a second hire is refused', async () => {
    const e = await employee({ joinDate: new Date('2026-10-01') });
    const r = await twice(input(e.id, { command: 'HIRE', date: '2026-10-01', source: { type: 'ONBOARDING', id: e.id } }));
    expect(r).toMatchObject({ transition: 'HIRE', fromState: null, toState: 'ACTIVE' });
    expect((await emp(e.id)).employmentState).toBe('ACTIVE');
    expect(await events(e.id, 'employment.hired')).toBe(1);
    await expect(run(input(e.id, { command: 'HIRE', date: '2026-10-01' }))).rejects.toMatchObject({ status: 409 });
    const e2 = await employee({ joinDate: new Date('2026-10-01') });
    await concurrently(input(e2.id, { command: 'HIRE', date: '2026-10-01' }));
  });

  it('company scope: an employee of another company is refused (403) before anything is read; unknown is 404', async () => {
    const e = await employee({ legalCompanyId: otherCo });
    await expect(run(input(e.id, { date: '2026-10-05' }))).rejects.toMatchObject({ status: 403 });
    expect(await facts(e.id)).toHaveLength(0);
    await expect(run(input(randomUUID(), { date: '2026-10-05' }))).rejects.toMatchObject({ status: 404 });
    await expect(prisma.$transaction((tx) => transitionEmploymentState(tx, input(e.id, { date: '2026-10-05', companyIds: 'ALL' })))).resolves.toMatchObject({ changed: true });
  });

  it('only T2 is a system act; the root client is refused', async () => {
    const e = await employee();
    await expect(run(input(e.id, { date: '2026-10-05', actor: { type: 'SYSTEM', id: 'x' } }))).rejects.toMatchObject({ status: 400 });
    await expect(transitionEmploymentState(prisma as never, input(e.id, { date: '2026-10-05' }))).rejects.toThrow(/transaction/);
  });

  it('EmploymentStateChange is append-only (trigger)', async () => {
    const e = await employee();
    const r = await run(input(e.id, { date: '2026-10-05' }));
    await expect(prisma.employmentStateChange.update({ where: { id: r.stateChangeId as string }, data: { reason: 'x' } })).rejects.toThrow(/append-only/);
    await expect(prisma.employmentStateChange.delete({ where: { id: r.stateChangeId as string } })).rejects.toThrow(/append-only/);
  });

  it('the opening lifecycle_open_state called twice (double call, then concurrently) writes each review item once', async () => {
    const a = await employee({ terminationDate: new Date('2025-01-31'), exitReason: 'RESIGNATION' });
    const open = (id: string) => prisma.$transaction((tx) => tx.$queryRaw<{ outcome: string; review: string[] | null }[]>`SELECT "outcome", "review" FROM "lifecycle_open_state"(${id}, 'test')`);
    const [first] = await open(a.id);
    const [second] = await open(a.id);
    expect(first).toMatchObject({ outcome: 'OPENED' });
    expect(second).toMatchObject({ outcome: 'ALREADY_OPENED' });
    expect((await migrationReviews(prisma, a.id)).map((r) => r.code).sort()).toEqual(['ACTIVE_WITH_TERMINATION_DATE', 'EXIT_REASON_WHILE_ACTIVE']);
    const b = await employee({ terminationDate: new Date('2025-01-31') });
    const both = await Promise.allSettled([open(b.id), open(b.id)]);
    expect(both.filter((x) => x.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(await migrationReviews(prisma, b.id)).toHaveLength(1);
    expect(await prisma.employmentStateChange.count({ where: { employeeId: b.id } })).toBe(1);
  });

  it('EmploymentMigrationReview: never deleted, only the resolution changes, once (trigger)', async () => {
    const e = await employee({ terminationDate: new Date('2025-01-31') });
    await openMissingStates(prisma, co);
    const [r] = await migrationReviews(prisma, e.id, { open: true });
    await expect(prisma.employmentMigrationReview.delete({ where: { id: r.id } })).rejects.toThrow(/never deleted/);
    await expect(prisma.employmentMigrationReview.update({ where: { id: r.id }, data: { code: 'OTHER' } })).rejects.toThrow(/only the resolution/);
    await expect(prisma.employmentMigrationReview.update({ where: { id: r.id }, data: { resolvedAt: new Date() } })).rejects.toThrow(/resolved_check/);
    await prisma.employmentMigrationReview.update({ where: { id: r.id }, data: { resolvedAt: new Date(), resolvedById: users.hr1, resolution: 'تاريخ قديم' } });
    await expect(prisma.employmentMigrationReview.update({ where: { id: r.id }, data: { resolution: 'x' } })).rejects.toThrow(/already resolved/);
    expect(await migrationReviews(prisma, e.id, { open: true })).toHaveLength(0);
    expect(await migrationReviews(prisma, e.id)).toHaveLength(1);
  });

  it('data migration 9zd: legacy.review codes of openings recorded before it become review rows; run twice, nothing is added (idempotent)', async () => {
    const { readFileSync } = await import('fs');
    const sql = readFileSync('prisma/migrations/9zd_lcy_tables/migration.sql', 'utf8');
    const move = /-- Data move 2[\s\S]*?(INSERT INTO "EmploymentMigrationReview"[\s\S]*?DO NOTHING;)/.exec(sql)?.[1];
    expect(move).toBeTruthy();
    // An opening as 9y recorded it (review codes inside legacy), written before 9zd.
    const e = await employee();
    const legacy = { isTerminated: false, terminationDate: '2025-01-31', employmentStatus: 'ACTIVE', exitReason: null, exitVoluntary: null, review: ['ACTIVE_WITH_TERMINATION_DATE', 'EXIT_REASON_WHILE_ACTIVE'], by: 'migration:9y_employment_state' };
    const opening = await prisma.employmentStateChange.create({
      data: {
        employeeId: e.id, transition: 'LEGACY_OPENING', toState: 'ACTIVE', effectiveDate: new Date('2024-01-01'), sourceType: 'LEGACY_OPENING', sourceId: e.id,
        companyId: co, operationKey: `lifecycle:opening:${e.id}`, legacy,
      },
    });
    await prisma.$executeRawUnsafe(move as string);
    await prisma.$executeRawUnsafe(move as string);
    const rows = await migrationReviews(prisma, e.id);
    expect(rows.map((r) => r.code).sort()).toEqual(['ACTIVE_WITH_TERMINATION_DATE', 'EXIT_REASON_WHILE_ACTIVE']);
    for (const r of rows) {
      expect(r).toMatchObject({ stateChangeId: opening.id, details: { terminationDate: '2025-01-31', by: 'migration:9y_employment_state' }, resolvedAt: null });
      expect(r.details).not.toHaveProperty('review');
    }
  });

  it('the reference date ref is only used to keep the fixture dates meaningful', () => {
    expect(ref < now).toBe(true);
  });
});
