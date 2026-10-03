// BL-PAY-021 security re-check (HIGH): a company scope change is a single-person path to SINGLE_OPERATOR unless it is
// two-person. An owner-role user A narrows the other counted approver B from every company to [X]: company Y would
// keep one counted approver, so A could then approve and pay alone in Y. Now (real auth, through the documents
// settings route that edits scopes): 409 TWO_PERSON_REQUIRED, the scope unchanged, Y still ENFORCED, a pending
// CHANGE_SCOPE request opened; A cannot approve it himself; B's consent (the holder, DEC-PO-021) executes it through
// /api/settings/identity-requests, and Y becomes SINGLE_OPERATOR with a recorded mode change. A change that drops
// nothing applies at once (setUserCompanyScope, idempotent: twice with one key = once). The tenant is a database of
// its own (./tenant-db.ts): the mode counts the whole tenant's approvers.
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY server whose role may CREATE DATABASE.
import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTestControlsMode } from '@/test/controls-mode';
import { enterTenantDatabase, leaveTenantDatabase, migratedTemplate, tenantFromTemplate, type TenantDatabase } from './tenant-db';

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.9' }),
}));

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('BL-PAY-021 company scope changes and the controls mode (setUserCompanyScope, scopeChangeDrops)', { timeout: 600_000 }, () => {
  let template: TenantDatabase;
  let tenant: TenantDatabase;

  beforeAll(async () => {
    setTestControlsMode('COMPUTED');
    template = await migratedTemplate('p021scope');
    tenant = await tenantFromTemplate(template, 'scope');
    await enterTenantDatabase(tenant.url);
  }, 300_000);

  afterAll(async () => {
    setTestControlsMode('ENFORCED');
    await leaveTenantDatabase();
    await tenant?.drop().catch(() => undefined);
    await template?.drop().catch(() => undefined);
  }, 120_000);

  it('A (owner role) narrowing B so company Y keeps one counted approver: 409 TWO_PERSON_REQUIRED, nothing changes, Y stays ENFORCED; A cannot approve it; B\'s consent executes it and Y becomes SINGLE_OPERATOR (recorded); a change that drops nothing applies at once; setUserCompanyScope idempotent (twice with one key); scopeChangeDrops ignores an owner role', async () => {
    const { prisma } = await import('@/lib/prisma');
    const { signSession } = await import('@/lib/session');
    const iam = await import('@/modules/iam');
    const platform = await import('@/modules/platform');
    const fx = await import('@/test/money-fixtures');
    const settings = await import('@/app/api/documents/settings/route');
    const decide = await import('@/app/api/settings/identity-requests/[id]/route');
    const tag = randomBytes(4).toString('hex');
    const company = async (n: string) => (await prisma.company.create({ data: { nameArabic: `شركة ${n} ${tag}`, commercialRegNum: `SC${n}${tag}`, commercialRegExp: new Date('2035-01-01') } })).id;
    const X = await company('X');
    const Y = await company('Y');
    const user = async (key: string, role: string) => (await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, name: key, passwordHash: 'x', role: role as never } })).id;
    const A = await user('a', 'SUPER_ADMIN');
    const B = await user('b', 'FINANCE_MANAGER');
    const C = await user('c', 'EMPLOYEE');
    await fx.identityFixture(A, { tenantRoot: true, identityStatus: 'VENDOR_BOOTSTRAP' });
    await fx.identityFixture(B, { identityStatus: 'ATTESTED', identityAttestedById: A, identityAttestedAt: new Date(), attestedEmail: `b-${tag}@example.test` });
    // Radeef marks both companies ready (the vendor operation; a fixture here).
    for (const companyId of [X, Y]) await fx.moneyFixture((tx) => tx.controlsReadiness.create({ data: { companyId, basis: 'ATTESTED', requestRef: 'REQ', markedBy: 'test' } }));
    const mode = (c: string) => platform.resolveOperatorMode(prisma, c);
    expect([await mode(X), await mode(Y)]).toEqual(['ENFORCED', 'ENFORCED']);
    const as = async (id: string, role: string) => {
      state.token = await signSession({ sub: id, role, passwordHash: 'x', sessionVersion: 0 });
    };
    const post = (body: unknown) => settings.POST(new Request('http://localhost/api/documents/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const scopeOf = async (id: string) => (await prisma.userCompanyScope.findMany({ where: { userId: id }, select: { companyId: true } })).map((r) => r.companyId);

    // The gateway refuses a direct write of the table (it is an identity table now).
    await expect(prisma.userCompanyScope.create({ data: { userId: C, companyId: X } })).rejects.toThrow();

    // A narrows B to [X]: Y would drop from 2 (A, B) to 1. Refused: 409, scope unchanged, a pending request.
    await as(A, 'SUPER_ADMIN');
    const narrowed = await post({ action: 'scope', userId: B, companyIds: [X] });
    expect(narrowed.status).toBe(409);
    const body = (await narrowed.json()) as { details: { code: string; requestId: string } };
    expect(body.details.code).toBe('TWO_PERSON_REQUIRED');
    expect(await scopeOf(B)).toEqual([]);
    expect(await mode(Y)).toBe('ENFORCED');
    // The same request again: the same pending request (replayed), still 409, still nothing written.
    const again = await post({ action: 'scope', userId: B, companyIds: [X] });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { details: { requestId: string } }).details.requestId).toBe(body.details.requestId);
    expect(await prisma.identityChangeRequest.count({ where: { userId: B, kind: 'CHANGE_SCOPE' } })).toBe(1);

    // A cannot approve his own request.
    const decideAs = (id: string) =>
      decide.POST(new Request(`http://localhost/api/settings/identity-requests/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'APPROVE' }) }), { params: Promise.resolve({ id }) });
    expect((await decideAs(body.details.requestId)).status).toBe(403);
    expect(await scopeOf(B)).toEqual([]);

    // B consents (the holder, DEC-PO-021): executed; Y becomes SINGLE_OPERATOR, and the change is recorded.
    await as(B, 'FINANCE_MANAGER');
    const consent = await decideAs(body.details.requestId);
    expect(consent.status).toBe(200);
    expect(await scopeOf(B)).toEqual([X]);
    expect([await mode(X), await mode(Y)]).toEqual(['ENFORCED', 'SINGLE_OPERATOR']);
    expect(await iam.lastRecordedControlsMode(prisma, Y)).toMatchObject({ mode: 'SINGLE_OPERATOR' });

    // A change that drops nothing (an employee account) applies at once; setUserCompanyScope twice with one key = once.
    await as(A, 'SUPER_ADMIN');
    const plain = await post({ action: 'scope', userId: C, companyIds: [Y] });
    expect(plain.status).toBe(200);
    expect(await scopeOf(C)).toEqual([Y]);
    const key = `it:scope:${randomUUID()}`;
    const run = () =>
      iam.runIdentityTransaction(prisma, (tx) => iam.setUserCompanyScope(tx, { actor: { id: A, role: 'SUPER_ADMIN', employeeId: null }, userId: C, companyIds: [X, Y], allCompanyIds: [X, Y], operationKey: key }));
    const [r1, r2] = [await run(), await run()];
    expect([r1.applied, r1.replayed, r2.replayed]).toEqual([true, false, true]);
    expect((await scopeOf(C)).sort()).toEqual([X, Y].sort());
    expect(await prisma.auditRecord.count({ where: { operationKey: key, action: 'iam.user.scope' } })).toBe(1);
    // scopeChangeDrops: narrowing A (owner role, every company whatever its rows) drops nothing.
    expect(await prisma.$transaction((tx) => iam.scopeChangeDrops(tx, A, [X], [X, Y]))).toEqual([]);
  });

  it('runIdentityTransaction refuses to be re-entered from inside an identity task (it would wait on itself)', async () => {
    const { prisma } = await import('@/lib/prisma');
    const iam = await import('@/modules/iam');
    await expect(iam.runIdentityTransaction(prisma, () => iam.runIdentityTransaction(prisma, async () => 1))).rejects.toMatchObject({ name: 'IdentityTransactionReentryError' });
    expect(await iam.runIdentityTransaction(prisma, async () => 2)).toBe(2); // the queue is not stuck
  });
});
