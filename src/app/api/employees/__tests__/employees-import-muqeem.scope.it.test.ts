// P1-SCOPE (INV-SCOPE-01): /api/employees/import and /api/employees/[id]/muqeem on a real database with
// real sessions (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { DEFAULT_NATIONALITY, GENDER_LABELS, IMPORT_TEMPLATE } from '@/lib/employee';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

type Row = Partial<Record<(typeof IMPORT_TEMPLATE)[number]['field'], string | Date>>;

async function workbook(rows: Row[]): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('الموظفين');
  sheet.addRow(IMPORT_TEMPLATE.map((c) => c.header));
  for (const r of rows) sheet.addRow(IMPORT_TEMPLATE.map((c) => r[c.field] ?? null));
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buf as ArrayBuffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

describe.skipIf(process.env.SCOPE_IT !== '1')('employees import and muqeem routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const importRoute = await import('@/app/api/employees/import/route');
  const muqeem = await import('@/app/api/employees/[id]/muqeem/route');
  const a = await h.employee('A');
  const b = await h.employee('B');
  const [coA, coB] = await Promise.all([h.prisma.company.findUniqueOrThrow({ where: { id: h.co.A } }), h.prisma.company.findUniqueOrThrow({ where: { id: h.co.B } })]);

  const post = async (rows: Row[]) => {
    const form = new FormData();
    form.set('file', await workbook(rows), 'employees.xlsx');
    form.set('validateOnly', '1');
    return importRoute.POST(new Request('http://localhost/api/employees/import', { method: 'POST', body: form }));
  };
  const newRow = (company: string): Row => ({
    fullNameArabic: `موظف مستورد ${h.next()}`, nationality: DEFAULT_NATIONALITY, gender: GENDER_LABELS.MALE, dateOfBirth: new Date('1990-01-01'),
    joinDate: new Date('2024-01-01'), iqamaOrIdNumber: `IMP${h.tag}${h.next()}`, iqamaOrIdExp: new Date('2030-01-01'), basicSalary: '5000', legalCompanyName: company,
  });
  const existingRow = (e: { iqamaOrIdNumber: string; firstNameArabic: string }): Row => ({ fullNameArabic: `${e.firstNameArabic} معدل`, iqamaOrIdNumber: e.iqamaOrIdNumber, jobTitle: 'معدل' });

  it('import: 401 / 403; a scoped HR user updates and creates only in his companies (validateOnly: nothing written)', async () => {
    await h.as(null);
    expect((await post([newRow(coA.commercialRegNum)])).status).toBe(401);
    await h.as('finA');
    expect((await post([newRow(coA.commercialRegNum)])).status).toBe(403);
    await h.as('hrA');
    const res = await post([existingRow(a), existingRow(b), newRow(coA.commercialRegNum), newRow(coB.commercialRegNum)]);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.updatedCount).toBe(1); // A's employee
    expect(out.createdCount).toBe(1); // new employee of A
    expect(out.errors.map((e: { row: number }) => e.row).sort()).toEqual([3, 5]); // B's employee, new employee of B
    expect(JSON.stringify(out)).not.toContain(b.employeeId);
    await h.as('owner');
    const all = await (await post([existingRow(a), existingRow(b), newRow(coB.commercialRegNum)])).json();
    expect(all.errorCount).toBe(0);
    expect(all.updatedCount).toBe(2);
  });

  it('muqeem: GET / POST on an employee of another company are 404; own company readable; wrong role 403', async () => {
    const reconcile = { action: 'RECONCILE', transactionId: 'no-such-transaction', outcome: 'FAILED', note: 'تحقق يدوي', confirmed: true };
    await h.as(null);
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(401);
    await h.as('empA');
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(403);
    await h.as('govB');
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(404);
    const denied = await muqeem.POST(h.req('POST', '/x', reconcile), h.params({ id: a.id }));
    expect(denied.status).toBe(404);
    expect((await denied.json()).error).toContain('الموظف');
    await h.as('govA');
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(200);
    // Past the scope check: the (unknown) transaction is what is missing now.
    const own = await muqeem.POST(h.req('POST', '/x', reconcile), h.params({ id: a.id }));
    expect(own.status).toBe(404);
    expect((await own.json()).error).toContain('عملية مقيم');
  });
});
