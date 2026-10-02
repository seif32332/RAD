// P1-SCOPE (INV-SCOPE-01): /api/attendance-hub on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('attendance-hub route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const hub = await import('@/app/api/attendance-hub/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const attB = await h.prisma.attendance.create({ data: { employeeId: empB.id, date: new Date('2026-09-01'), status: 'PRESENT' } });

  it('GET: 401 / 403, HR of A reads employees and attendance of A only, the owner both', async () => {
    await h.as(null);
    expect((await hub.GET()).status).toBe(401);
    await h.as('finA');
    expect((await hub.GET()).status).toBe(403);
    await h.as('hrA');
    const a = await (await hub.GET()).json();
    expect(ids(a.employees)).toContain(empA.id);
    expect(ids(a.employees)).not.toContain(empB.id);
    expect(ids(a.attendances)).not.toContain(attB.id);
    await h.as('owner');
    const all = await (await hub.GET()).json();
    expect(ids(all.employees)).toEqual(expect.arrayContaining([empA.id, empB.id]));
  });

  it('POST: an employee of another company 404 and untouched; own company allowed, a repeated entry stays one row', async () => {
    await h.as('hrB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'UPDATE_BIOMETRIC', payload: { id: empA.id, biometricId: `X${h.tag}` } }))).status).toBe(404);
    const add = { actionType: 'ADD_ATTENDANCE', payload: { employeeId: empA.id, date: '2026-09-03', checkIn: '08:00', checkOut: '16:00' } };
    expect((await hub.POST(h.req('POST', '/x', add))).status).toBe(404);
    expect(
      (await hub.POST(h.req('POST', '/x', { actionType: 'SET_ATTENDANCE_EXEMPTIONS', payload: { employeeId: empA.id, geoExempt: true, faceExempt: false, reason: 'ميداني' } }))).status,
    ).toBe(404);
    const a = await h.prisma.employee.findUnique({ where: { id: empA.id } });
    expect(a?.biometricId ?? null).toBeNull();
    expect(a?.attendanceGeoExempt).toBe(false);
    expect(await h.prisma.attendance.count({ where: { employeeId: empA.id } })).toBe(0);
    await h.as('hrA');
    expect((await hub.POST(h.req('POST', '/x', add))).status).toBe(200);
    expect((await hub.POST(h.req('POST', '/x', add))).status).toBe(200);
    expect(await h.prisma.attendance.count({ where: { employeeId: empA.id } })).toBe(1);
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'UPDATE_BIOMETRIC', payload: { id: empA.id, biometricId: `X${h.tag}` } }))).status).toBe(200);
  });
});
