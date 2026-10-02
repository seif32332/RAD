// P1-SCOPE: /api/nationalities on a real database with real sessions (src/test/route-harness.ts).
// Nationality is tenant-wide reference data (no company key, DOMAIN_BOUNDARIES §5.4.3): every user
// reads the same list; staff add, HR deletes. Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('nationalities route: roles on shared reference data (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/nationalities/route');
  const label = `جنسية ${h.tag}`;

  it('401 / 403; staff of A adds, staff of B reads the same row; only HR deletes', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('empA');
    expect((await route.POST(h.req('POST', '/api/nationalities', { label }))).status).toBe(403);
    await h.as('finA');
    const created = await route.POST(h.req('POST', '/api/nationalities', { label }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    await h.as('empB');
    expect(((await (await route.GET()).json()) as Array<{ id: string }>).map((n) => n.id)).toContain(id);
    await h.as('finB');
    expect((await route.DELETE(h.req('DELETE', `/api/nationalities?id=${id}`))).status).toBe(403);
    await h.as('hrB');
    expect((await route.DELETE(h.req('DELETE', `/api/nationalities?id=${id}`))).status).toBe(200);
  });
});
