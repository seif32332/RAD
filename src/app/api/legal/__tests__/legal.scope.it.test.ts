// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the legal routes on a real database with REAL
// authentication (src/test/route-harness.ts). Allow, deny (401 / wrong role 403) and other company
// (legalB gets no row of company A and cannot act on it) for list, detail and write handlers.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database (rows are never cleaned up).
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('legal routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const contracts = await import('@/app/api/legal/contracts/route');
  const contract = await import('@/app/api/legal/contracts/[id]/route');
  const lawsuits = await import('@/app/api/legal/lawsuits/route');
  const notes = await import('@/app/api/legal/promissory-notes/route');
  const note = await import('@/app/api/legal/promissory-notes/[id]/route');
  const agencies = await import('@/app/api/legal/agencies/route');
  const alerts = await import('@/app/api/legal/alerts/route');
  const investigations = await import('@/app/api/legal/investigations/route');

  const soon = new Date(Date.now() + 3 * 86_400_000);
  const row = {} as Record<'A' | 'B', { contract: string; lawsuit: string; note: string; agency: string; investigation: string; employee: string }>;
  for (const k of ['A', 'B'] as const) {
    const companyId = h.co[k];
    const e = await h.employee(k);
    row[k] = {
      employee: e.id,
      contract: (await h.prisma.legalContract.create({ data: { companyId, title: `عقد ${k} ${h.tag}`, firstParty: 'x', secondParty: 'y', startDate: new Date('2024-01-01'), endDate: soon } })).id,
      lawsuit: (await h.prisma.lawsuit.create({ data: { companyId, caseType: 'LABOR', plaintiff: 'x', defendant: 'y', subject: 's' } })).id,
      note: (await h.prisma.promissoryNote.create({ data: { companyId, amount: 100, creditorName: 'x', debtorName: 'y', dueDate: soon } })).id,
      agency: (await h.prisma.certifiedAgency.create({ data: { companyId, agencyNumber: `AG-${k}-${h.tag}`, principalName: 'x', principalId: '1', agentName: 'y', agentId: '2', startDate: new Date('2024-01-01'), endDate: soon } })).id,
      investigation: (await h.prisma.investigation.create({ data: { employeeId: e.id, subject: `تحقيق ${k}` } })).id,
    };
  }

  it('deny: no session 401, employee 403, a role outside the legal group 403', async () => {
    await h.as(null);
    expect((await contracts.GET()).status).toBe(401);
    await h.as('empA');
    expect((await contracts.GET()).status).toBe(403);
    expect((await investigations.GET()).status).toBe(403);
    await h.as('hrA');
    expect((await lawsuits.GET()).status).toBe(403);
    expect((await notes.POST(h.req('POST', '/api/legal/promissory-notes', { amount: 5, creditorName: 'a', debtorName: 'b' }))).status).toBe(403);
  });

  it('lists: legalA sees company A only; the owner sees both', async () => {
    await h.as('legalA');
    const lists = {
      contract: ids(await (await contracts.GET()).json()),
      lawsuit: ids(await (await lawsuits.GET()).json()),
      note: ids(await (await notes.GET()).json()),
      agency: ids(await (await agencies.GET()).json()),
      investigation: ids(await (await investigations.GET()).json()),
    };
    for (const [key, list] of Object.entries(lists)) {
      const k = key as keyof (typeof row)['A'];
      expect(list, key).toContain(row.A[k]);
      expect(list, key).not.toContain(row.B[k]);
    }
    const alertText = JSON.stringify(await (await alerts.GET()).json());
    expect(alertText).toContain(row.A.contract);
    expect(alertText).toContain(row.A.note);
    expect(alertText).not.toContain(row.B.contract);
    expect(alertText).not.toContain(row.B.note);

    await h.as('hrB'); // investigations are shared with HR
    const inv = ids(await (await investigations.GET()).json());
    expect(inv).toContain(row.B.investigation);
    expect(inv).not.toContain(row.A.investigation);

    await h.as('owner');
    const all = ids(await (await contracts.GET()).json());
    expect(all).toEqual(expect.arrayContaining([row.A.contract, row.B.contract]));
  });

  it('other company: legalB cannot update, close, pay or delete a record of company A (404)', async () => {
    await h.as('legalB');
    const p = h.params({ id: row.A.contract });
    expect((await contract.PATCH(h.req('PATCH', '/x', { notes: 'b' }), p)).status).toBe(404);
    expect((await contract.DELETE(h.req('DELETE', '/x'), p)).status).toBe(404);
    expect((await note.PATCH(h.req('PATCH', '/x', { status: 'CANCELLED' }), h.params({ id: row.A.note }))).status).toBe(404);
    expect((await lawsuits.POST(h.req('POST', '/x', { actionType: 'CLOSE_CASE', payload: { id: row.A.lawsuit, judgmentAttachment: '/api/files/j.pdf' } }))).status).toBe(404);
    for (const [action, payload] of [
      ['UPDATE_STATUS', { id: row.A.investigation, status: 'IN_PROGRESS' }],
      ['SUSPEND', { id: row.A.investigation, suspensionStartDate: '2026-01-01' }],
      ['ATTACH', { id: row.A.investigation, attachmentUrl: '/api/files/x.pdf' }],
      ['CREATE', { employeeId: row.A.employee, subject: 'x' }],
    ] as const) {
      expect((await investigations.POST(h.req('POST', '/x', { action, payload }))).status, action).toBe(404);
    }
    // Nothing changed on company A's rows.
    expect(await h.prisma.legalContract.findUnique({ where: { id: row.A.contract } })).toMatchObject({ notes: null });
    expect(await h.prisma.promissoryNote.findUnique({ where: { id: row.A.note } })).toMatchObject({ status: 'ACTIVE' });
    expect(await h.prisma.lawsuit.findUnique({ where: { id: row.A.lawsuit } })).toMatchObject({ status: 'REFERRED' });
    expect(await h.prisma.investigation.findUnique({ where: { id: row.A.investigation } })).toMatchObject({ status: 'OPENED', attachmentUrl: null });
  });

  it('allow: legalA acts on company A; a new record takes his company, another company is refused (403)', async () => {
    await h.as('legalA');
    expect((await contract.PATCH(h.req('PATCH', '/x', { notes: 'a' }), h.params({ id: row.A.contract }))).status).toBe(200);
    expect((await investigations.POST(h.req('POST', '/x', { action: 'ATTACH', payload: { id: row.A.investigation, attachmentUrl: '/api/files/a.pdf' } }))).status).toBe(200);

    const body = { title: `جديد ${h.tag}`, firstParty: 'x', secondParty: 'y', startDate: '2026-01-01' };
    const created = await contracts.POST(h.req('POST', '/x', body));
    expect(created.status).toBe(200);
    const { data } = (await created.json()) as { data: { id: string; companyId: string } };
    expect(data.companyId).toBe(h.co.A);
    expect((await contracts.POST(h.req('POST', '/x', { ...body, companyId: h.co.B }))).status).toBe(403);

    const suit = await lawsuits.POST(h.req('POST', '/x', { caseType: 'OTHER', plaintiff: 'a', defendant: 'b', subject: 's' }));
    expect(((await suit.json()) as { data: { companyId: string } }).data.companyId).toBe(h.co.A);
    const agency = await agencies.POST(h.req('POST', '/x', { agencyNumber: 'N', principalName: 'a', principalId: '1', agentName: 'b', agentId: '2', startDate: '2026-01-01', endDate: '2027-01-01' }));
    expect(((await agency.json()) as { data: { companyId: string } }).data.companyId).toBe(h.co.A);
    const pn = await notes.POST(h.req('POST', '/x', { amount: 10, creditorName: 'a', debtorName: 'b', isOnDemand: true }));
    expect(((await pn.json()) as { data: { companyId: string } }).data.companyId).toBe(h.co.A);

    // legalB never sees the new contract.
    await h.as('legalB');
    expect(ids(await (await contracts.GET()).json())).not.toContain(data.id);
  });
});
