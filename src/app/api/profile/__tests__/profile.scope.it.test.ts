// P1-SCOPE: /api/profile on a real database with real sessions (src/test/route-harness.ts). The
// profile is the session user's own User row (no company-scoped model): a user only ever reads or
// edits himself. Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('profile route: own user only (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/profile/route');

  it('401 without a session; each user reads and edits only his own row (the other company\'s user is untouched)', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    expect((await route.PUT(h.req('PUT', '/api/profile', { name: 'x' }))).status).toBe(401);
    await h.as('empA');
    expect((await (await route.GET()).json()).id).toBe(h.users.empA.id);
    // An avatar outside our own uploads is refused.
    expect((await route.PUT(h.req('PUT', '/api/profile', { avatarUrl: 'https://evil.example/x.png' }))).status).toBe(400);
    expect((await route.PUT(h.req('PUT', '/api/profile', { name: `موظف أ ${h.tag}` }))).status).toBe(200);
    expect((await h.prisma.user.findUnique({ where: { id: h.users.empA.id } }))?.name).toBe(`موظف أ ${h.tag}`);
    expect((await h.prisma.user.findUnique({ where: { id: h.users.empB.id } }))?.name).not.toBe(`موظف أ ${h.tag}`);
    await h.as('hrB');
    expect((await (await route.GET()).json()).id).toBe(h.users.hrB.id);
  });
});
