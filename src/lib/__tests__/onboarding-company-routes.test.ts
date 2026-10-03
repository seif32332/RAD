// P0-05 / BL-ONB-012 against a real PostgreSQL (migrations applied, including 9r_onboarding_company).
// Opt-in: ONBOARDING_IT=1 with DATABASE_URL pointing at a THROWAWAY database (the test creates its
// own companies, users and employees and does not clean them up).
//
// Authentication is real: each call carries a session token signed by src/lib/session.ts for a real
// User row, and requireUser() verifies it against the database. Only the Next.js request plumbing is
// replaced: `cookies()` (no request scope in vitest) and `after()` (the post-commit commencement
// notice is captured, not run).
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';
import { scopeFixture } from '@/test/money-fixtures';

const RUN = process.env.ONBOARDING_IT === '1';

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

describe.skipIf(!RUN)('onboarding / recruitment company keys and scope (P0-05)', { timeout: 30_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { signSession } = await import('@/lib/session');
  const hub = await import('@/app/api/incoming-requests/route');
  const portal = await import('@/app/api/manager-portal/route');
  const recruitment = await import('@/app/api/recruitment/route');

  const tag = randomUUID().slice(0, 8);
  const digits = tag.replace(/\D/g, '').padEnd(4, '3').slice(0, 4);
  let seq = 0;
  const iqama = () => `2${digits}${String(++seq).padStart(5, '0')}`;

  const co = { A: '', B: '' };
  const branch = { A: '', B: '' };
  const dept = { A: '', B: '' };
  let requesterId = '';
  const users: Record<'hrA' | 'hrB' | 'owner', { id: string; role: string }> = {
    hrA: { id: '', role: 'HR_MANAGER' },
    hrB: { id: '', role: 'HR_MANAGER' },
    owner: { id: '', role: 'SUPER_ADMIN' },
  };

  async function as(who: keyof typeof users) {
    const u = users[who];
    state.token = await signSession({ sub: u.id, role: u.role, passwordHash: 'x', sessionVersion: 0 });
  }

  function post(url: string, body: unknown) {
    return new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.9' },
      body: JSON.stringify(body),
    });
  }

  const approve = (dbId: string, updatedData: Record<string, unknown> = {}) =>
    hub.POST(post('/api/incoming-requests', { actionType: 'APPROVE', type: 'ONBOARDING', dbId, updatedData }));
  const reject = (dbId: string) =>
    hub.POST(post('/api/incoming-requests', { actionType: 'REJECT', type: 'ONBOARDING', dbId, reason: 'اختبار الرفض' }));

  async function newRequest(over: Record<string, unknown> = {}) {
    return prisma.onboardingRequest.create({
      data: {
        requesterId,
        fullNameArabic: 'سالم',
        lastNameArabic: 'القحطاني',
        nationality: 'سعودي',
        iqamaOrIdNumber: iqama(),
        mobileNumber: '0500000000',
        dateOfBirth: new Date('1995-01-01'),
        iqamaOrIdExp: new Date('2030-01-01'),
        joinDate: new Date('2026-10-01'),
        ...over,
      },
    });
  }

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      const c = await prisma.company.create({
        data: { nameArabic: `شركة ${k} ${tag}`, commercialRegNum: `9${k}${tag}${Date.now()}`.slice(0, 20), commercialRegExp: new Date('2030-01-01') },
      });
      co[k] = c.id;
      branch[k] = (await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${k}` } })).id;
      dept[k] = (await prisma.department.create({ data: { branchId: branch[k], nameArabic: `قسم ${k}` } })).id;
    }
    for (const [key, u] of Object.entries(users)) {
      u.id = (await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, passwordHash: 'x', role: u.role as 'HR_MANAGER' } })).id;
    }
    await scopeFixture.createMany({
      data: [
        { userId: users.hrA.id, companyId: co.A },
        { userId: users.hrB.id, companyId: co.B },
      ],
    });
    requesterId = (
      await employeeFixture({
          employeeId: `R-${tag}`,
          firstNameArabic: 'مدير',
          lastNameArabic: 'الفرع',
          nationality: 'سعودي',
          iqamaOrIdNumber: iqama(),
          iqamaOrIdExp: new Date('2030-01-01'),
          dateOfBirth: new Date('1985-01-01'),
          gender: 'MALE',
          joinDate: new Date('2020-01-01'),
          basicSalary: 10000,
          legalCompanyId: co.A,
          actualCompanyId: co.A,
          branchId: branch.A,
        })
    ).id;
  });

  beforeEach(() => {
    state.token = undefined;
    state.scheduled.length = 0;
  });

  it('no session -> 401', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    expect((await approve(r.id)).status).toBe(401);
  });

  it('allow: HR of company A approves; the employee gets the legal and actual company of the branch and the notice is scheduled', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    await as('hrA');
    const res = await approve(r.id);
    expect(res.status).toBe(200);
    const { employeeId } = (await res.json()) as { employeeId: string };
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    expect(e.legalCompanyId).toBe(co.A);
    expect(e.actualCompanyId).toBe(co.A);
    const after = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.companyId).toBe(co.A);
    expect(state.scheduled).toHaveLength(1); // WORK_COMMENCEMENT notice, now issuable (EV-0027)
  });

  it('double call: the second approval is refused and exactly one employee exists', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    await as('hrA');
    expect((await approve(r.id)).status).toBe(200);
    expect((await approve(r.id)).status).toBe(409);
    expect(await prisma.employee.count({ where: { iqamaOrIdNumber: r.iqamaOrIdNumber } })).toBe(1);
  });

  it('deny: HR of company B cannot approve or reject a request of company A', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    await as('hrB');
    expect((await approve(r.id)).status).toBe(403);
    expect((await reject(r.id)).status).toBe(403);
    expect((await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('PENDING');
    expect(await prisma.employee.count({ where: { iqamaOrIdNumber: r.iqamaOrIdNumber } })).toBe(0);
  });

  it('other company: the hub lists a request only to HR of its company, and offers only his companies', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    type Hub = { managerRequests: { dbId: string; customData?: { orgCompanyId?: string } }[]; companies: { id: string }[] };
    await as('hrA');
    const a = (await (await hub.GET()).json()) as Hub;
    const mine = a.managerRequests.find((x) => x.dbId === r.id);
    expect(mine?.customData?.orgCompanyId).toBe(co.A);
    expect(a.companies.map((c) => c.id)).toEqual([co.A]);
    await as('hrB');
    const b = (await (await hub.GET()).json()) as Hub;
    expect(b.managerRequests.some((x) => x.dbId === r.id)).toBe(false);
    // The company list is only sent with visible onboarding requests; company A is never offered to B.
    expect(b.companies.map((c) => c.id)).not.toContain(co.A);
  });

  it('other company: HR of A cannot register the hire on company B', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    await as('hrA');
    expect((await approve(r.id, { legalCompanyId: co.B })).status).toBe(403);
    expect((await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('PENDING');
  });

  it('without a branch the companies are required; with them the hire is registered on them', async () => {
    const r = await newRequest();
    await as('owner');
    const missing = await approve(r.id);
    expect(missing.status).toBe(400);
    const ok = await approve(r.id, { legalCompanyId: co.A, actualCompanyId: co.B });
    expect(ok.status).toBe(200);
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: ((await ok.json()) as { employeeId: string }).employeeId } });
    expect([e.legalCompanyId, e.actualCompanyId]).toEqual([co.A, co.B]);
  });

  it('an actual company other than the branch company is refused (INV-ORG-01)', async () => {
    const r = await newRequest({ branchId: branch.A, companyId: co.A });
    await as('owner');
    expect((await approve(r.id, { actualCompanyId: co.B })).status).toBe(400);
    expect((await approve(r.id, { departmentId: dept.B })).status).toBe(400); // department of another branch
  });

  it('manager portal: the onboarding request takes the branch company; another company is denied to a scoped user', async () => {
    const submit = (branchId: string) =>
      portal.POST(
        post('/api/manager-portal', {
          actionType: 'SUBMIT_ONBOARDING',
          requesterId,
          fullNameArabic: 'نورة',
          iqamaOrIdNumber: iqama(),
          mobileNumber: '0511111111',
          branchId,
        }),
      );
    await as('hrA');
    const ok = await submit(branch.A);
    expect(ok.status).toBe(200);
    const created = ((await ok.json()) as { data: { id: string } }).data;
    expect((await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: created.id } })).companyId).toBe(co.A);
    expect((await submit(branch.B)).status).toBe(403);
  });

  it('recruitment: the job request takes the department company; another company is denied to a scoped user', async () => {
    const create = (departmentId: string) =>
      recruitment.POST(
        post('/api/recruitment', { requesterId, departmentId, jobTitle: 'محاسب', jobType: 'FULL_TIME', nationality: 'غير محدد', description: 'اختبار' }),
      );
    await as('hrA');
    const ok = await create(dept.A);
    expect(ok.status).toBe(200);
    const created = ((await ok.json()) as { data: { id: string } }).data;
    expect((await prisma.jobRequest.findUniqueOrThrow({ where: { id: created.id } })).companyId).toBe(co.A);
    // P1-SCOPE: another company's department is not a valid reference for a scoped user (400), and nothing is created.
    const before = await prisma.jobRequest.count({ where: { departmentId: dept.B } });
    expect((await create(dept.B)).status).toBe(400);
    expect(await prisma.jobRequest.count({ where: { departmentId: dept.B } })).toBe(before);
  });
});
