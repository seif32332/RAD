// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the Muqeem integration routes on a real database with
// REAL authentication (src/test/route-harness.ts): allow, deny and other company. Muqeem itself is not
// configured here, so an allowed call that reaches Muqeem ends in NOT_CONFIGURED (503): the point is
// that another company's id is refused (404) BEFORE any call.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('muqeem integration routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const status = await import('@/app/api/integrations/muqeem/status/route');
  const lookups = await import('@/app/api/integrations/muqeem/lookups/route');
  const testConnection = await import('@/app/api/integrations/muqeem/test-connection/route');
  const sync = await import('@/app/api/integrations/muqeem/residents/sync/route');
  const apply = await import('@/app/api/integrations/muqeem/residents/apply/route');
  const transactions = await import('@/app/api/integrations/muqeem/transactions/route');
  const report = await import('@/app/api/integrations/muqeem/transactions/interactive-report/route');
  const reconcile = await import('@/app/api/integrations/muqeem/transactions/[id]/reconcile/route');

  const platform = { A: '', B: '' };
  const tx = { A: '', B: '' };
  const resident = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    platform[k] = (await h.prisma.govPlatform.create({ data: { companyId: h.co[k], platformName: `مقيم ${k} ${h.tag}`, username: 'u', password: 'p' } })).id;
    resident[k] = (await h.employee(k, { nationality: 'EG' })).id;
    tx[k] = (
      await h.prisma.muqeemTransaction.create({
        data: { companyId: h.co[k], employeeId: resident[k], operation: 'IQAMA_ISSUE', status: 'UNKNOWN', idempotencyKey: `it-${h.tag}-${k}` },
      })
    ).id;
  }
  const reportBody = (companyId: string) => ({ companyId, fromDate: '2026-01-01', toDate: '2026-01-10', operatorId: '1234567890' });
  const applyBody = (companyId: string, employeeId: string) => ({ companyId, updates: [{ employeeId, fields: ['passportExp'] }] });

  it('deny: no session 401, roles outside government relations 403', async () => {
    await h.as(null);
    expect((await status.GET()).status).toBe(401);
    for (const who of ['empA', 'legalA', 'buyerA'] as const) {
      await h.as(who);
      expect((await status.GET()).status, who).toBe(403);
      expect((await transactions.GET(h.req('GET', '/x'))).status, who).toBe(403);
    }
    await h.as('hrA'); // HR_MANAGER is not in the credentials-vault roles
    expect((await testConnection.POST(h.req('POST', '/x', { companyId: h.co.A }))).status).toBe(403);
  });

  it('lists: govA gets the companies, platforms and transactions of company A only', async () => {
    await h.as('govA');
    const s = (await (await status.GET()).json()) as { companies: { id: string }[]; platforms: { id: string }[] };
    expect(s.companies.map((c) => c.id)).toEqual([h.co.A]);
    expect(s.platforms.map((p) => p.id)).toEqual([platform.A]);
    const t = (await (await transactions.GET(h.req('GET', '/x'))).json()) as { items: { id: string }[]; total: number };
    expect(t.items.map((i) => i.id)).toContain(tx.A);
    expect(t.items.map((i) => i.id)).not.toContain(tx.B);
    // Filtering by the other company's id returns nothing.
    const other = (await (await transactions.GET(h.req('GET', `/x?companyId=${h.co.B}`))).json()) as { items: unknown[]; total: number };
    expect(other).toMatchObject({ items: [], total: 0 });
    await h.as('owner');
    const all = (await (await transactions.GET(h.req('GET', '/x?take=200'))).json()) as { items: { id: string }[] };
    expect(all.items.map((i) => i.id)).toEqual(expect.arrayContaining([tx.A, tx.B]));
  });

  it('other company: govB gets 404 for every action on company A (before any Muqeem call)', async () => {
    await h.as('govB');
    expect((await lookups.GET(h.req('GET', `/x?type=countries&companyId=${h.co.A}`))).status).toBe(404);
    expect((await testConnection.POST(h.req('POST', '/x', { companyId: h.co.A }))).status).toBe(404);
    expect((await sync.POST(h.req('POST', '/x', { companyId: h.co.A }))).status).toBe(404);
    expect((await apply.POST(h.req('POST', '/x', applyBody(h.co.A, resident.A)))).status).toBe(404);
    expect((await report.POST(h.req('POST', '/x', reportBody(h.co.A)))).status).toBe(404);
    expect((await reconcile.POST(h.req('POST', '/x', { status: 'FAILED', note: 'checked' }), h.params({ id: tx.A }))).status).toBe(404);
    expect(await h.prisma.muqeemTransaction.findUnique({ where: { id: tx.A } })).toMatchObject({ status: 'UNKNOWN' });
  });

  it('allow: govA reaches Muqeem for company A (not configured here) and reconciles its transaction once', async () => {
    await h.as('govA');
    expect((await lookups.GET(h.req('GET', `/x?type=countries&companyId=${h.co.A}`))).status).toBe(503);
    expect(await (await testConnection.POST(h.req('POST', '/x', { companyId: h.co.A }))).json()).toMatchObject({ ok: false, kind: 'NOT_CONFIGURED' });
    expect((await sync.POST(h.req('POST', '/x', { companyId: h.co.A }))).status).toBe(503);
    expect((await apply.POST(h.req('POST', '/x', applyBody(h.co.A, resident.A)))).status).toBe(503);
    expect((await report.POST(h.req('POST', '/x', reportBody(h.co.A)))).status).toBe(503);
    const settle = () => reconcile.POST(h.req('POST', '/x', { status: 'FAILED', note: 'checked in Muqeem' }), h.params({ id: tx.A }));
    expect((await settle()).status).toBe(200);
    expect((await settle()).status).toBe(409);
  });
});
