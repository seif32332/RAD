// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): file download (/api/files) on a real database with REAL
// authentication (src/test/route-harness.ts). A file a role may read is further limited to the user's
// companies: the company of its employee, else of its (restricted) uploader; unknown = refused to a
// restricted reader (fail closed).
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('files: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const dir = mkdtempSync(path.join(tmpdir(), 'radeef-files-it-'));
  process.env.UPLOAD_DIR = dir;
  const h = await createRouteHarness(state);
  const files = await import('@/app/api/files/[...path]/route');

  const file = async (name: string, data: { employeeId?: string; uploadedById?: string; category?: string }) => {
    const storedName = `${h.tag}-${name}.pdf`;
    writeFileSync(path.join(dir, storedName), '%PDF-1.4\n%%EOF\n');
    await h.prisma.uploadedFile.create({ data: { storedName, category: 'CONTRACT', ...data } });
    return storedName;
  };
  const empA = (await h.employee('A')).id;
  const empB = (await h.employee('B')).id;
  const f = {
    empA: await file('emp-a', { employeeId: empA }),
    empB: await file('emp-b', { employeeId: empB }),
    govA: await file('gov-a', { uploadedById: h.users.govA.id }), // no employee: the uploader's company (A)
    owner: await file('owner', { uploadedById: h.users.owner.id }), // no employee, unrestricted uploader: unknown
  };
  const get = (storedName: string) => files.GET(h.req('GET', `/api/files/${storedName}`), { params: Promise.resolve({ path: [storedName] }) });

  it('deny: no session 401; an employee may not read another employee\'s file (403)', async () => {
    await h.as(null);
    expect((await get(f.empA)).status).toBe(401);
    await h.as('empA');
    expect((await get(f.empB)).status).toBe(403);
  });

  it('allow: HR of A reads the files of company A (employee or restricted uploader)', async () => {
    await h.as('hrA');
    expect((await get(f.empA)).status).toBe(200);
    expect((await get(f.govA)).status).toBe(200);
    await h.as('owner');
    for (const name of Object.values(f)) expect((await get(name)).status, name).toBe(200);
  });

  it('other company: HR of B cannot read a file of company A; an unknown company is refused (fail closed)', async () => {
    await h.as('hrB');
    expect((await get(f.empA)).status).toBe(403);
    expect((await get(f.govA)).status).toBe(403);
    expect((await get(f.empB)).status).toBe(200);
    await h.as('hrA');
    expect((await get(f.empB)).status).toBe(403);
    expect((await get(f.owner)).status).toBe(403);
    // His own upload stays readable whatever its company.
    await h.as('govA');
    expect((await get(f.govA)).status).toBe(200);
  });
});
