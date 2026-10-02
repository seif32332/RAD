// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the tenant-wide settings routes (settings, users,
// permissions, audit log) on a real database with REAL authentication (src/test/route-harness.ts).
// They stay tenant-wide and admin-only: allow (owner / admin), deny (no session 401, HR and employee
// 403, whatever their company). "Other company" does not apply to tenant-wide rows; the routes require
// an actor who sees every company (scopedContext(actor, ALL_COMPANIES)), which today every admin role
// is (owner roles are never restricted by UserCompanyScope, iam actorCompanies).
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('settings routes: admin-only, tenant-wide (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const settings = await import('@/app/api/settings/route');
  const permissions = await import('@/app/api/settings/permissions/route');
  const users = await import('@/app/api/settings/users/route');
  const user = await import('@/app/api/settings/users/[id]/route');
  const auditLogs = await import('@/app/api/settings/audit-logs/route');

  const target = h.params({ id: h.users.hrB.id });
  const calls = () => [
    ['settings GET', () => settings.GET()],
    ['settings POST', () => settings.POST(h.req('POST', '/x', { settings: {} }))],
    ['settings PUT', () => settings.PUT(h.req('PUT', '/x', { settings: {} }))],
    ['permissions GET', () => permissions.GET()],
    ['permissions POST', () => permissions.POST(h.req('POST', '/x', { role: 'PURCHASING_AGENT', allowedPages: ['/vehicles'] }))],
    ['users GET', () => users.GET()],
    ['user GET', () => user.GET(h.req('GET', '/x'), target)],
    ['user PATCH', () => user.PATCH(h.req('PATCH', '/x', { name: `n-${h.tag}` }), target)],
    ['audit-logs GET', () => auditLogs.GET(h.req('GET', '/api/settings/audit-logs?take=5'))],
  ] as const;

  it('deny: no session 401; HR of any company and employees 403 on every handler', async () => {
    await h.as(null);
    for (const [name, call] of calls()) expect((await call()).status, name).toBe(401);
    for (const who of ['hrA', 'hrB', 'empA', 'govA'] as const) {
      await h.as(who);
      for (const [name, call] of calls()) expect((await call()).status, `${who} ${name}`).toBe(403);
      expect((await user.DELETE(h.req('DELETE', '/x'), target)).status, `${who} DELETE`).toBe(403);
      expect((await users.POST(h.req('POST', '/x', { email: `x-${who}-${h.tag}@example.test`, password: 'Passw0rd123', role: 'EMPLOYEE' }))).status).toBe(403);
    }
  });

  it('allow: the owner and a company admin (never restricted) manage the tenant-wide settings', async () => {
    for (const who of ['owner', 'adminA'] as const) {
      await h.as(who);
      for (const [name, call] of calls()) expect((await call()).status, `${who} ${name}`).toBe(200);
    }
    await h.as('owner');
    const created = await users.POST(h.req('POST', '/x', { email: `new-${h.tag}@example.test`, password: 'Passw0rd123', role: 'EMPLOYEE' }));
    expect(created.status).toBe(201);
    const { user: u } = (await created.json()) as { user: { id: string } };
    expect((await user.DELETE(h.req('DELETE', '/x'), h.params({ id: u.id }))).status).toBe(200);
    // Replay: already deactivated.
    expect((await user.DELETE(h.req('DELETE', '/x'), h.params({ id: u.id }))).status).toBe(409);
  });
});
