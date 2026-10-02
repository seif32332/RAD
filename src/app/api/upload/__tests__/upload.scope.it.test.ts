// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): upload on behalf of an employee (/api/upload) on a real
// database with REAL authentication (src/test/route-harness.ts): staff may attach a file only to an
// employee of their companies.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { mkdtempSync } from 'fs';
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

describe.skipIf(process.env.SCOPE_IT !== '1')('upload: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'radeef-upload-it-'));
  const h = await createRouteHarness(state);
  const upload = await import('@/app/api/upload/route');

  const empA = (await h.employee('A')).id;
  const upload1 = (employeeId?: string) => {
    const form = new FormData();
    form.append('file', new File([new TextEncoder().encode('%PDF-1.4\n%%EOF\n')], 'contract.pdf', { type: 'application/pdf' }));
    form.append('category', 'CONTRACT');
    if (employeeId) form.append('employeeId', employeeId);
    return upload.POST(new Request('http://localhost/api/upload', { method: 'POST', headers: { 'x-real-ip': '10.0.0.8' }, body: form }));
  };
  const registered = async (res: Response) => {
    const { url } = (await res.json()) as { url: string };
    return h.prisma.uploadedFile.findUnique({ where: { storedName: url.split('/').pop()! } });
  };

  it('allow: HR of A attaches a file to an employee of company A', async () => {
    await h.as('hrA');
    const res = await upload1(empA);
    expect(res.status).toBe(200);
    expect(await registered(res)).toMatchObject({ employeeId: empA, uploadedById: h.users.hrA.id });
  });

  it('other company: HR of B cannot attach a file to an employee of company A (400, nothing stored)', async () => {
    await h.as('hrB');
    const before = await h.prisma.uploadedFile.count({ where: { employeeId: empA } });
    expect((await upload1(empA)).status).toBe(400);
    expect(await h.prisma.uploadedFile.count({ where: { employeeId: empA } })).toBe(before);
  });

  it('deny: an employee cannot attach a file to another employee (the file stays his own)', async () => {
    await h.as('empB');
    const res = await upload1(empA);
    expect(res.status).toBe(200);
    expect(await registered(res)).toMatchObject({ employeeId: h.users.empB.employeeId, uploadedById: h.users.empB.id });
  });
});
