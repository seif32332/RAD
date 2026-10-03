// BL-PAY-021: /api/controls-mode (the persistent single-operator banner) on a real database with real sessions
// (src/test/route-harness.ts). The mode is tenant-wide: every signed-in user of every company gets the same
// answer, which names no company, person or amount; the control gaps are shown to financial approvers only.
// The mode is the one resolver's (here the test switch, src/test/controls-mode.ts; the computed mode itself is
// covered by src/modules/iam/__tests__/controls-acceptance.it.test.ts on tenants of their own).
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { withControlsMode } from '@/test/controls-mode';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('controls-mode route: tenant-wide banner (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/controls-mode/route');
  const get = async () => {
    const res = await route.GET();
    return { status: res.status, cache: res.headers.get('cache-control'), body: res.status === 200 ? ((await res.json()) as { mode: string; banner: string | null; companies: string[]; notices: string[] }) : null };
  };

  it('deny: no session is 401; a deactivated account is 401 (the session is checked against the database)', async () => {
    await h.as(null);
    expect((await get()).status).toBe(401);
    const { identityFixture } = await import('@/test/money-fixtures');
    await identityFixture(h.users.buyerA.id, { isActive: false });
    await h.as('buyerA');
    expect((await get()).status).toBe(401);
  });

  it('allow: an employee and an HR manager of company A; ENFORCED → no banner; company A SINGLE_OPERATOR → the Arabic banner naming A; the employee never gets the approvers notices', async () => {
    const nameA = (await h.prisma.company.findUniqueOrThrow({ where: { id: h.co.A } })).nameArabic;
    await h.as('empA');
    const enforced = await get();
    expect(enforced).toMatchObject({ status: 200, body: { mode: 'ENFORCED', banner: null, companies: [], notices: [] } });
    expect(enforced.cache).toMatch(/no-store/);
    await withControlsMode({ [h.co.A]: 'SINGLE_OPERATOR' }, async () => {
      const single = await get();
      expect(single.body).toMatchObject({ mode: 'SINGLE_OPERATOR', companies: [nameA], notices: [] });
      expect(single.body?.banner).toContain('الشركة في وضع المشغّل الواحد: العمليات على مالك تُسجَّل وتُرسل لصاحب الشركة');
      expect(single.body?.banner).toContain(nameA);
      await h.as('hrA');
      const hr = await get();
      expect(hr.body).toMatchObject({ mode: 'SINGLE_OPERATOR', companies: [nameA] });
      for (const n of hr.body?.notices ?? []) expect(typeof n).toBe('string');
      await h.as('owner'); // every company: A is named
      expect((await get()).body?.companies).toContain(nameA);
    });
  });

  it('other company: while only company A is SINGLE_OPERATOR, users of company B get no banner and nothing of A (no name, no id)', async () => {
    const nameA = (await h.prisma.company.findUniqueOrThrow({ where: { id: h.co.A } })).nameArabic;
    await withControlsMode({ [h.co.A]: 'SINGLE_OPERATOR' }, async () => {
      for (const who of ['hrB', 'empB', 'payrollB'] as const) {
        await h.as(who);
        const b = await get();
        expect(b.body, who).toMatchObject({ mode: 'ENFORCED', banner: null, companies: [] });
        const text = JSON.stringify(b.body);
        for (const leak of [nameA, h.co.A, h.users.hrA.id]) expect(text).not.toContain(leak);
      }
    });
  });
});
