// P1-LCY routes against a real PostgreSQL (all migrations, 9y_employment_state). Opt-in: LCY_IT=1 with
// DATABASE_URL pointing at a THROWAWAY database (rows are not cleaned up).
//
// Authentication is real: each call carries a session token signed by src/lib/session.ts for a real
// User row, verified by requireUser() against the database. Only the Next.js request plumbing is
// replaced (cookies(), after()).
//
// The writers moved onto lifecycle.transitionEmploymentState: PATCH /api/employees/[id]
// (action=terminate), PUT /api/employees/[id] (exit fields no longer written), POST
// /api/leaves/[id]/action (ABSCOND), and the settlement approval (PUT /api/settlements) through
// finance.approveSettlement. Each: allow, deny, other company, and a double call.
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moneyFixture } from '@/test/money-fixtures';

const RUN = process.env.LCY_IT === '1';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'radeef_session' && state.token ? { name, value: state.token } : undefined),
  }),
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: unknown) => {
    state.scheduled.push(fn);
  },
}));

describe.skipIf(!RUN)('P1-LCY routes: exits through transitionEmploymentState (real auth)', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { signSession } = await import('@/lib/session');
  const employeeRoute = await import('@/app/api/employees/[id]/route');
  const leaveAction = await import('@/app/api/leaves/[id]/action/route');
  const settlementsRoute = await import('@/app/api/settlements/route');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const co = { A: '', B: '' };
  const users: Record<'hrA' | 'hrB' | 'owner' | 'emp' | 'fin', { id: string; role: string }> = {
    hrA: { id: '', role: 'HR_MANAGER' },
    hrB: { id: '', role: 'HR_MANAGER' },
    owner: { id: '', role: 'SUPER_ADMIN' },
    emp: { id: '', role: 'EMPLOYEE' },
    fin: { id: '', role: 'FINANCE_MANAGER' },
  };
  let seq = 0;

  async function as(who: keyof typeof users | null) {
    state.token = who ? await signSession({ sub: users[who].id, role: users[who].role, passwordHash: 'x', sessionVersion: 0 }) : undefined;
  }
  const req = (method: string, url: string, body: unknown) =>
    new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.7' }, body: JSON.stringify(body) });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  async function employee(company: 'A' | 'B', over: Record<string, unknown> = {}) {
    seq += 1;
    return prisma.employee.create({
      data: {
        employeeId: `LR-${tag}-${seq}`, firstNameArabic: 'موظف', lastNameArabic: `${seq}`, nationality: 'SA', iqamaOrIdNumber: `LR${tag}${seq}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 6000, legalCompanyId: co[company], actualCompanyId: co[company], ...over,
      },
    });
  }
  const facts = (employeeId: string) => prisma.employmentStateChange.findMany({ where: { employeeId }, orderBy: { seq: 'asc' } });
  const exits = async (employeeId: string) => (await facts(employeeId)).filter((f) => f.transition !== 'LEGACY_OPENING');
  const day = (offset: number) => {
    const d = new Date(Date.now() + 3 * 3600e3);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      co[k] = (await prisma.company.create({ data: { nameArabic: `LCY ${k} ${tag}`, commercialRegNum: `LR${k}${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    }
    for (const [key, u] of Object.entries(users)) {
      u.id = (await prisma.user.create({ data: { email: `lr-${key}-${tag}@example.test`, passwordHash: 'x', role: u.role as 'HR_MANAGER' } })).id;
    }
    await prisma.userCompanyScope.createMany({ data: [{ userId: users.hrA.id, companyId: co.A }, { userId: users.hrB.id, companyId: co.B }] });
  });
  beforeEach(() => {
    state.token = undefined;
    state.scheduled.length = 0;
  });

  // -------------------------------------------------------------------------------------------
  describe('PATCH /api/employees/[id] action=terminate', () => {
    const terminate = (id: string, body: Record<string, unknown> = {}) =>
      employeeRoute.PATCH(req('PATCH', `/api/employees/${id}`, { action: 'terminate', reason: 'إنهاء خدمات للاختبار', terminationDate: day(-1), exitReason: 'EMPLOYER_TERMINATION', ...body }), params(id));

    it('no session -> 401', async () => {
      const e = await employee('A');
      expect((await terminate(e.id)).status).toBe(401);
    });

    it('allow: HR of company A terminates; one T3 fact, projections, event, exit reason projected', async () => {
      const e = await employee('A');
      await as('hrA');
      const res = await terminate(e.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { employment: { transition: string; state: string } };
      expect(body.employment).toMatchObject({ transition: 'TERMINATE', state: 'TERMINATED' });
      const [f] = await exits(e.id);
      expect(f).toMatchObject({ transition: 'TERMINATE', toState: 'TERMINATED', sourceType: 'EMPLOYEE_FILE', actorId: users.hrA.id, companyId: co.A, exitReason: 'EMPLOYER_TERMINATION' });
      const x = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
      expect([x.employmentState, x.isTerminated, x.employmentStatus, x.exitReason, x.exitVoluntary]).toEqual(['TERMINATED', true, 'EXCLUDED', 'EMPLOYER_TERMINATION', false]);
      expect(await prisma.domainEvent.count({ where: { aggregateId: e.id, type: 'employment.terminated' } })).toBe(1);
    });

    it('double call: the same user replays (200, one fact); another user gets 409; another date 409 (D1)', async () => {
      const e = await employee('A');
      await as('hrA');
      expect((await terminate(e.id)).status).toBe(200);
      expect((await terminate(e.id)).status).toBe(200);
      await as('owner');
      expect((await terminate(e.id)).status).toBe(409);
      expect((await terminate(e.id, { terminationDate: day(-3) })).status).toBe(409);
      expect(await exits(e.id)).toHaveLength(1);
    });

    it('deny: an employee account cannot terminate (403), nothing written', async () => {
      const e = await employee('A');
      await as('emp');
      expect((await terminate(e.id)).status).toBe(403);
      expect(await facts(e.id)).toHaveLength(0);
    });

    it('other company: HR of B cannot terminate an employee of A (403, nothing written)', async () => {
      const e = await employee('A');
      await as('hrB');
      expect((await terminate(e.id)).status).toBe(403);
      expect(await facts(e.id)).toHaveLength(0);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).isTerminated).toBe(false);
    });

    it('a future last day keeps today\'s meaning until NOTICE is released (TERMINATED with that date)', async () => {
      const e = await employee('A');
      await as('hrA');
      expect((await terminate(e.id, { terminationDate: day(20) })).status).toBe(200);
      expect((await exits(e.id))[0]).toMatchObject({ transition: 'TERMINATE', toState: 'TERMINATED' });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('PUT /api/employees/[id]: the exit fields are no longer written here (BL-LCY-003)', () => {
    const put = (id: string, body: Record<string, unknown>) => employeeRoute.PUT(req('PUT', `/api/employees/${id}`, body), params(id));

    it('allow: HR of A edits an employee of A; echoing the stored exit fields is accepted, changing them is 409', async () => {
      const e = await employee('A', { isTerminated: true, employmentStatus: 'EXCLUDED', terminationDate: new Date('2025-06-30'), exitReason: 'RESIGNATION', exitVoluntary: true });
      await as('hrA');
      const ok = await put(e.id, { mobileNumber: '0555555555', exitReason: 'RESIGNATION', exitVoluntary: true });
      expect(ok.status).toBe(200);
      const changed = await put(e.id, { exitReason: 'ARTICLE_80' });
      expect(changed.status).toBe(409);
      expect(((await changed.json()) as { details?: { code?: string } }).details?.code).toBe('EXIT_FIELDS_READ_ONLY');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).exitReason).toBe('RESIGNATION');
    });

    it('deny: finance cannot edit (403)', async () => {
      const e = await employee('A');
      await as('fin');
      expect((await put(e.id, { mobileNumber: '0555555555' })).status).toBe(403);
    });

    it('other company: HR of B cannot edit an employee of A (403, unchanged)', async () => {
      const e = await employee('A', { mobileNumber: '0500000000' });
      await as('hrB');
      expect((await put(e.id, { mobileNumber: '0555555555' })).status).toBe(403);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).mobileNumber).toBe('0500000000');
    });

    it('double call: the same edit twice gives the same result', async () => {
      const e = await employee('A');
      await as('hrA');
      expect((await put(e.id, { mobileNumber: '0511111111' })).status).toBe(200);
      expect((await put(e.id, { mobileNumber: '0511111111' })).status).toBe(200);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).mobileNumber).toBe('0511111111');
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('POST /api/leaves/[id]/action ABSCOND', () => {
    async function leaveOf(company: 'A' | 'B') {
      const e = await employee(company);
      const l = await prisma.leave.create({
        data: { employeeId: e.id, leaveType: 'ANNUAL', startDate: new Date(`${day(-20)}T00:00:00Z`), endDate: new Date(`${day(-10)}T00:00:00Z`), totalDays: 11, status: 'APPROVED' },
      });
      return { e, l };
    }
    const abscond = (leaveId: string) =>
      leaveAction.POST(req('POST', `/api/leaves/${leaveId}/action`, { action: 'ABSCOND', reason: 'لم يعد بعد الإجازة', acknowledgeWarningIssued: true, terminationDate: day(-2) }), params(leaveId));

    it('allow: HR of A records "did not return": one T3 fact with ABSCONDING, login rule applied', async () => {
      const { e, l } = await leaveOf('A');
      await as('hrA');
      expect((await abscond(l.id)).status).toBe(200);
      const [f] = await exits(e.id);
      expect(f).toMatchObject({ transition: 'TERMINATE', exitReason: 'ABSCONDING', exitVoluntary: true, sourceType: 'LEAVE_ABSCOND', sourceId: l.id });
      const x = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
      expect([x.employmentState, x.isTerminated, x.exitReason]).toEqual(['TERMINATED', true, 'ABSCONDING']);
    });

    it('double call: the second is 409 and there is still one fact', async () => {
      const { e, l } = await leaveOf('A');
      await as('hrA');
      expect((await abscond(l.id)).status).toBe(200);
      expect((await abscond(l.id)).status).toBe(409);
      expect(await exits(e.id)).toHaveLength(1);
    });

    it('deny: an employee account (403)', async () => {
      const { e, l } = await leaveOf('A');
      await as('emp');
      expect((await abscond(l.id)).status).toBe(403);
      expect(await facts(e.id)).toHaveLength(0);
    });

    it('other company: HR of B cannot record it on an employee of A (404 since P1-SCOPE: not found in scope)', async () => {
      const { e, l } = await leaveOf('A');
      await as('hrB');
      expect((await abscond(l.id)).status).toBe(404);
      expect(await facts(e.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('PUT /api/settlements status=OWNER_APPROVED (finance.approveSettlement)', () => {
    async function pendingSettlement(company: 'A' | 'B', over: Record<string, unknown> = {}) {
      const e = await employee(company);
      const s = await moneyFixture((tx) => tx.settlement.create({
        data: { employeeId: e.id, type: 'END_OF_SERVICE', terminationReason: 'RESIGNATION', lastWorkingDate: new Date(`${day(-1)}T00:00:00Z`), totalSettlement: 1000, status: 'PENDING_APPROVAL', ...over },
      }));
      return { e, s };
    }
    const approve = (id: string) => settlementsRoute.PUT(req('PUT', '/api/settlements', { id, status: 'OWNER_APPROVED' }));

    it('allow: the owner approves; the employee exits through T3 and the effect log (SettlementEffect) is recorded, append-only', async () => {
      const { e, s } = await pendingSettlement('A');
      await as('owner');
      const res = await approve(s.id);
      expect(res.status).toBe(200);
      const [f] = await exits(e.id);
      expect(f).toMatchObject({ transition: 'TERMINATE', sourceType: 'SETTLEMENT', sourceId: s.id, exitReason: 'RESIGNATION', companyId: co.A });
      const log = await prisma.settlementEffect.findMany({ where: { settlementId: s.id } });
      const of = (kind: string) => log.filter((x) => x.kind === kind);
      const [pr] = await prisma.paymentRequest.findMany({ where: { entityType: 'SETTLEMENT', entityId: s.id } });
      expect(of('PAYMENT_REQUEST')).toMatchObject([{ refId: pr.id, employeeId: e.id, before: null, after: { paymentRequestId: pr.id, created: true } }]);
      const [employment] = of('EMPLOYMENT');
      expect(employment).toMatchObject({ refId: e.id, before: { isTerminated: false }, after: { employmentState: 'TERMINATED', stateChangeId: f.id, transition: 'TERMINATE' } });
      expect(of('LEAVE_ACCRUAL')).toHaveLength(1);
      // Append-only (trigger of 9zd).
      await expect(prisma.settlementEffect.update({ where: { id: employment.id }, data: { after: {} } })).rejects.toThrow(/append-only/);
      await expect(prisma.settlementEffect.delete({ where: { id: employment.id } })).rejects.toThrow(/append-only/);
    });

    it('double call: the second approval is 409, one fact and one payment request', async () => {
      const { e, s } = await pendingSettlement('A');
      await as('owner');
      expect((await approve(s.id)).status).toBe(200);
      expect((await approve(s.id)).status).toBe(409);
      expect(await exits(e.id)).toHaveLength(1);
      expect(await prisma.paymentRequest.count({ where: { entityType: 'SETTLEMENT', entityId: s.id } })).toBe(1);
      const log = await prisma.settlementEffect.findMany({ where: { settlementId: s.id } });
      expect(log.filter((x) => x.kind === 'EMPLOYMENT')).toHaveLength(1);
      expect(log.filter((x) => x.kind === 'PAYMENT_REQUEST')).toHaveLength(1);
    });

    it('the same last day as an exit already recorded: the approval goes through, no second fact (EX-LCY-010)', async () => {
      const { e, s } = await pendingSettlement('A');
      await as('hrA');
      expect((await employeeRoute.PATCH(req('PATCH', `/api/employees/${e.id}`, { action: 'terminate', reason: 'استقالة', terminationDate: day(-1), exitReason: 'RESIGNATION' }), params(e.id))).status).toBe(200);
      await as('owner');
      expect((await approve(s.id)).status).toBe(200);
      expect(await exits(e.id)).toHaveLength(1);
    });

    it('another last day than the recorded exit is refused (409, the way is D1), nothing approved', async () => {
      const { e, s } = await pendingSettlement('A');
      await as('hrA');
      await employeeRoute.PATCH(req('PATCH', `/api/employees/${e.id}`, { action: 'terminate', reason: 'استقالة', terminationDate: day(-5) }), params(e.id));
      await as('owner');
      expect((await approve(s.id)).status).toBe(409);
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('PENDING_APPROVAL');
    });

    it('deny: finance (a settlements role) cannot approve (403); nothing written', async () => {
      const { e, s } = await pendingSettlement('A');
      await as('fin');
      expect((await approve(s.id)).status).toBe(403);
      expect(await facts(e.id)).toHaveLength(0);
    });

    it('other company: approval is an owner act over every company (§5.4.3); HR of either company is refused (403)', async () => {
      const { e, s } = await pendingSettlement('B');
      await as('hrA');
      expect((await approve(s.id)).status).toBe(403);
      await as('hrB');
      expect((await approve(s.id)).status).toBe(403);
      expect(await facts(e.id)).toHaveLength(0);
    });
  });
});
