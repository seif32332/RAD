// P1-SCOPE (INV-SCOPE-01): /api/companies and /api/companies/[id] on a real database with real sessions
// (src/test/route-harness.ts). Creating a company is an owner act (iam company.create, audited
// CrossCompanyContext). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('companies routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/companies/route');
  const item = await import('@/app/api/companies/[id]/route');

  it('list: 401 / 403; a scoped user sees only his company; the owner both', async () => {
    await h.as(null);
    expect((await list.GET()).status).toBe(401);
    await h.as('empA');
    expect((await list.GET()).status).toBe(403);
    await h.as('legalA');
    expect(ids(await (await list.GET()).json())).toEqual([h.co.A]);
    await h.as('owner');
    expect(ids(await (await list.GET()).json())).toEqual(expect.arrayContaining([h.co.A, h.co.B]));
  });

  it('detail / update / delete of another company: 404 and unchanged; own company readable and editable', async () => {
    const p = h.params({ id: h.co.A });
    await h.as(null);
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(401);
    await h.as('hrB');
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(404);
    expect((await item.PUT(h.req('PUT', '/x', { nameEnglish: 'hacked' }), p)).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), p)).status).toBe(404);
    expect((await h.prisma.company.findUnique({ where: { id: h.co.A } }))?.nameEnglish).not.toBe('hacked');
    await h.as('finA');
    expect((await item.PUT(h.req('PUT', '/x', { nameEnglish: 'x' }), p)).status).toBe(403);
    await h.as('hrA');
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(200);
    expect((await item.PUT(h.req('PUT', '/x', { nameEnglish: `Company A ${h.tag}` }), p)).status).toBe(200);
  });

  it('create: owner only (HR 403, even unscoped by role); the owner creates through an audited cross-company context', async () => {
    const body = { nameArabic: `شركة جديدة ${h.tag}`, commercialRegNum: `RHN${h.tag}`, commercialRegExp: '2030-01-01' };
    await h.as(null);
    expect((await list.POST(h.req('POST', '/api/companies', body))).status).toBe(401);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/companies', body))).status).toBe(403);
    await h.as('owner');
    const res = await list.POST(h.req('POST', '/api/companies', body));
    expect(res.status).toBe(201);
    const { company } = await res.json();
    const opened = await h.prisma.auditRecord.findFirst({ where: { action: 'iam.crossCompany.open', actorId: h.users.owner.id }, orderBy: { seq: 'desc' } });
    expect(opened).not.toBeNull();
    // A scoped HR user never sees the new company.
    await h.as('hrA');
    expect(ids(await (await list.GET()).json())).not.toContain(company.id);
    await h.as('owner');
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: company.id }))).status).toBe(200);
  });
});
