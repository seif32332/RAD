// P1-SCOPE (INV-SCOPE-01): the employee portal (/api/portal/**) on a real database with real sessions
// (src/test/route-harness.ts). SelfContext: an employee reads and writes his OWN rows only — never those of
// another employee of the same company (empA2), nor of another company (empB).
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe.skipIf(process.env.SCOPE_IT !== '1')('portal routes: self scope (real auth)', { timeout: 120_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // vitest runs a skipped suite body while collecting
  const h = await createRouteHarness(state);
  const { signSession } = await import('@/lib/session');
  const { FACE_CONSENT_VERSION } = await import('@/lib/self-attendance');
  const { TOTAL_REWARDS_ASSUMPTION_KEY } = await import('@/lib/workforce/total-rewards');
  const portal = await import('@/app/api/portal/route');
  const attendance = await import('@/app/api/portal/attendance/route');
  const punch = await import('@/app/api/portal/attendance/punch/route');
  const correction = await import('@/app/api/portal/correction/route');
  const face = await import('@/app/api/portal/face/route');
  const termination = await import('@/app/api/portal/termination/route');
  const rewards = await import('@/app/api/portal/total-rewards/route');
  const rewardsPdf = await import('@/app/api/portal/total-rewards/pdf/route');

  // A second employee of company A with his own login (same company as empA, another person).
  const a2 = await h.employee('A');
  const a2User = await h.prisma.user.create({ data: { email: `rh-empa2-${h.tag}@example.test`, passwordHash: 'x', role: 'EMPLOYEE' } });
  await h.prisma.employee.update({ where: { id: a2.id }, data: { userId: a2User.id } });
  await h.prisma.userCompanyScope.create({ data: { userId: a2User.id, companyId: h.co.A } });
  const asA2 = async () => {
    state.token = await signSession({ sub: a2User.id, role: 'EMPLOYEE', passwordHash: 'x', sessionVersion: 0 });
  };
  const empA = h.users.empA.employeeId!;
  const empB = h.users.empB.employeeId!;

  // Rows of every employee: the portal must return / touch the caller's only.
  for (const [i, id] of [empA, a2.id, empB].entries()) {
    await h.prisma.leave.create({ data: { employeeId: id, leaveType: 'ANNUAL', startDate: new Date(`2031-0${i + 1}-01`), endDate: new Date(`2031-0${i + 1}-03`), totalDays: 3, status: 'PENDING' } });
  }
  const punchOf = async (employeeId: string) =>
    h.prisma.attendancePunch.create({ data: { employeeId, workDate: new Date('2026-01-05T00:00:00.000Z'), type: 'IN', result: 'REJECTED', reasons: ['OUTSIDE_GEOFENCE'] } });
  const punchA2 = await punchOf(a2.id);
  const punchB = await punchOf(empB);
  const punchA = await punchOf(empA);

  // Tenant-wide settings touched by these tests, restored afterwards.
  const prevEnabled = await h.prisma.systemSetting.findUnique({ where: { key: 'self_attendance_enabled' } });
  const prevRewards = await h.prisma.workforceAssumption.findUnique({ where: { key_companyId: { key: TOTAL_REWARDS_ASSUMPTION_KEY, companyId: '' } } });
  afterAll(async () => {
    if (prevEnabled) await h.prisma.systemSetting.update({ where: { key: prevEnabled.key }, data: { value: prevEnabled.value } });
    else await h.prisma.systemSetting.deleteMany({ where: { key: 'self_attendance_enabled' } });
    if (prevRewards) await h.prisma.workforceAssumption.update({ where: { id: prevRewards.id }, data: { value: prevRewards.value, valueJson: prevRewards.valueJson } });
    else await h.prisma.workforceAssumption.deleteMany({ where: { key: TOTAL_REWARDS_ASSUMPTION_KEY, companyId: '' } });
    delete process.env.RENDER_SERVICE_URL;
    delete process.env.RENDER_SERVICE_TOKEN;
  });

  it('GET /api/portal: 401 without a session, 404 without an employee file, own rows only (same and other company)', async () => {
    await h.as(null);
    expect((await portal.GET()).status).toBe(401);
    await h.as('owner');
    expect((await portal.GET()).status).toBe(404);
    await h.as('empA');
    const res = await portal.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(empA);
    expect(body.leaves.map((l: { employeeId: string }) => l.employeeId)).toEqual([empA]);
    expect(body.legalCompany.id).toBe(h.co.A);
    await h.as('empB');
    const b = await (await portal.GET()).json();
    expect(b.id).toBe(empB);
    expect(b.leaves.every((l: { employeeId: string }) => l.employeeId === empB)).toBe(true);
  });

  it('GET /api/portal/attendance: 401 / 403 without an employee file; the caller\'s own card', async () => {
    await h.as(null);
    expect((await attendance.GET()).status).toBe(401);
    await h.as('hrA'); // staff login without an employee file
    expect((await attendance.GET()).status).toBe(403);
    await h.as('empA');
    const res = await attendance.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).nextAction).toBeTruthy();
  });

  it('POST /api/portal/attendance/punch: 401 / 403; the punch is always the caller\'s own', async () => {
    await h.as(null);
    expect((await punch.POST(new Request('http://localhost/api/portal/attendance/punch', { method: 'POST', body: form({ expectedAction: 'IN' }) }))).status).toBe(401);
    await h.as('owner');
    expect((await punch.POST(new Request('http://localhost/api/portal/attendance/punch', { method: 'POST', body: form({ expectedAction: 'IN' }) }))).status).toBe(403);
    await h.prisma.systemSetting.upsert({ where: { key: 'self_attendance_enabled' }, create: { key: 'self_attendance_enabled', value: '1' }, update: { value: '1' } });
    await h.prisma.employee.update({ where: { id: empA }, data: { attendanceGeoExempt: true, attendanceFaceExempt: true } });
    const before = { a2: await h.prisma.attendancePunch.count({ where: { employeeId: a2.id } }), b: await h.prisma.attendancePunch.count({ where: { employeeId: empB } }) };
    await h.as('empA');
    const res = await punch.POST(new Request('http://localhost/api/portal/attendance/punch', { method: 'POST', body: form({ expectedAction: 'IN' }) }));
    expect([201, 409]).toContain(res.status); // 409 = the day's plan differs (e.g. already complete); never another employee
    if (res.status === 201) {
      const { punchId } = await res.json();
      expect((await h.prisma.attendancePunch.findUniqueOrThrow({ where: { id: punchId } })).employeeId).toBe(empA);
    }
    expect(await h.prisma.attendancePunch.count({ where: { employeeId: a2.id } })).toBe(before.a2);
    expect(await h.prisma.attendancePunch.count({ where: { employeeId: empB } })).toBe(before.b);
  });

  it('POST /api/portal/correction: another employee (same or other company) or his punch is refused; own request allowed', async () => {
    const body = (over: Record<string, unknown> = {}) => ({ date: '2026-01-05', reason: `سبب ${h.next()}`, ...over });
    await h.as(null);
    expect((await correction.POST(h.req('POST', '/api/portal/correction', body()))).status).toBe(401);
    await h.as('owner');
    expect((await correction.POST(h.req('POST', '/api/portal/correction', body()))).status).toBe(403);
    await h.as('empA');
    expect((await correction.POST(h.req('POST', '/api/portal/correction', body({ employeeId: a2.id })))).status).toBe(403);
    expect((await correction.POST(h.req('POST', '/api/portal/correction', body({ employeeId: empB })))).status).toBe(403);
    expect((await correction.POST(h.req('POST', '/api/portal/correction', body({ punchId: punchA2.id, correctionType: 'ABSENT' })))).status).toBe(403);
    expect((await correction.POST(h.req('POST', '/api/portal/correction', body({ punchId: punchB.id, correctionType: 'ABSENT' })))).status).toBe(403);
    const ok = await correction.POST(h.req('POST', '/api/portal/correction', body({ punchId: punchA.id, correctionType: 'ABSENT' })));
    expect(ok.status).toBe(201);
    expect((await ok.json()).request.employeeId).toBe(empA);
    expect(await h.prisma.attendanceCorrection.count({ where: { punchId: { in: [punchA2.id, punchB.id] } } })).toBe(0);
  });

  it('POST /api/portal/termination: filed for the caller only', async () => {
    await h.as(null);
    expect((await termination.POST(h.req('POST', '/x', { terminationType: 'RESIGNATION' }))).status).toBe(401);
    await h.as('owner');
    expect((await termination.POST(h.req('POST', '/x', { terminationType: 'RESIGNATION' }))).status).toBe(403);
    await asA2();
    expect((await termination.POST(h.req('POST', '/x', { terminationType: 'RESIGNATION', employeeId: empA }))).status).toBe(403);
    expect((await termination.POST(h.req('POST', '/x', { terminationType: 'RESIGNATION', employeeId: empB }))).status).toBe(403);
    const ok = await termination.POST(h.req('POST', '/x', { terminationType: 'RESIGNATION' }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).employeeId).toBe(a2.id);
    expect(await h.prisma.terminationRequest.count({ where: { employeeId: { in: [empA, empB] } } })).toBe(0);
  });

  it('/api/portal/face: consent renewal and withdrawal touch the caller\'s own profile only', async () => {
    const profile = (employeeId: string) =>
      h.prisma.faceProfile.create({ data: { employeeId, embedding: 'sealed', model: 'test-model', consentAt: new Date(), consentVersion: 'old' } });
    await profile(a2.id);
    await profile(empB);
    await profile(empA);
    await h.as(null);
    expect((await face.DELETE(h.req('DELETE', '/x'))).status).toBe(401);
    await h.as('owner');
    expect((await face.DELETE(h.req('DELETE', '/x'))).status).toBe(403);
    await h.as('empA');
    // POST reaches the consent check (auth and self scope passed).
    const post = await face.POST(new Request('http://localhost/api/portal/face', { method: 'POST', body: form({ consent: 'true', consentVersion: 'outdated' }) }));
    expect(post.status).toBe(409);
    expect((await face.PATCH(h.req('PATCH', '/x', { consent: true, consentVersion: FACE_CONSENT_VERSION }))).status).toBe(200);
    expect((await face.DELETE(h.req('DELETE', '/x'))).status).toBe(200);
    const rows = await h.prisma.faceProfile.findMany({ where: { employeeId: { in: [empA, a2.id, empB] } } });
    const by = new Map(rows.map((r) => [r.employeeId, r]));
    expect(by.get(empA)!.embedding).toBe('');
    expect(by.get(a2.id)!.embedding).toBe('sealed');
    expect(by.get(a2.id)!.consentVersion).toBe('old');
    expect(by.get(empB)!.embedding).toBe('sealed');
  });

  it('GET /api/portal/total-rewards (+ pdf): the caller\'s own statement; another employee cannot be asked for', async () => {
    await h.prisma.workforceAssumption.upsert({
      where: { key_companyId: { key: TOTAL_REWARDS_ASSUMPTION_KEY, companyId: '' } },
      create: { key: TOTAL_REWARDS_ASSUMPTION_KEY, companyId: '', value: 1 },
      update: { value: 1, valueJson: null },
    });
    await h.as(null);
    expect((await rewards.GET(h.req('GET', '/api/portal/total-rewards'))).status).toBe(401);
    expect((await rewardsPdf.GET(h.req('GET', '/api/portal/total-rewards/pdf'))).status).toBe(401);
    await h.as('owner');
    expect((await rewards.GET(h.req('GET', '/api/portal/total-rewards'))).status).toBe(403);
    await h.as('empA');
    expect((await rewards.GET(h.req('GET', `/api/portal/total-rewards?employeeId=${a2.id}`))).status).toBe(400);
    expect((await rewards.GET(h.req('GET', `/api/portal/total-rewards?employeeId=${empB}`))).status).toBe(400);
    const res = await rewards.GET(h.req('GET', '/api/portal/total-rewards'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.statement.employee.id).toBe(empA);
    // PDF: 503 while the report service is not configured; with a (unreachable) service the same checks apply.
    expect((await rewardsPdf.GET(h.req('GET', '/api/portal/total-rewards/pdf'))).status).toBe(503);
    process.env.RENDER_SERVICE_URL = 'http://127.0.0.1:9';
    process.env.RENDER_SERVICE_TOKEN = 'test';
    expect((await rewardsPdf.GET(h.req('GET', `/api/portal/total-rewards/pdf?employeeId=${a2.id}`))).status).toBe(400);
    await h.as('owner');
    expect((await rewardsPdf.GET(h.req('GET', '/api/portal/total-rewards/pdf'))).status).toBe(403);
  });
});
