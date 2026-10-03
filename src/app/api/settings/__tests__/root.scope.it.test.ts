// BL-PAY-017 / BL-PAY-022 through the routes, on a real database with REAL authentication (src/test/route-harness.ts):
//   - no tenant user writes TENANT_ROOT or the named list: POST /api/settings/users and PATCH /api/settings/users/:id
//     with tenantRoot / isVendorStaff / identityStatus in the body change nothing of them (the most powerful
//     tenant user, SUPER_ADMIN, included);
//   - ROOT_ATTEST_OWN through /api/settings/users/:id/identity (changed route): 401 without a session, 403 for HR,
//     an employee and the other company; the root's 202 carries NO code; GET shows the named entry (no id, no
//     hash); Radeef's vendor operation releases the code; the holder completes on /api/auth/credential-setup.
// The vendor side has no route by design: it runs as the vendor CLI (src/modules/iam/vendor-cli.ts); its
// transitions are called here directly.
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a THROWAWAY migrated database.
import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('TENANT_ROOT and the named list (BL-PAY-017 / 022): allow / deny / other company, real auth', { timeout: 300_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const users = await import('@/app/api/settings/users/route');
  const user = await import('@/app/api/settings/users/[id]/route');
  const identity = await import('@/app/api/settings/users/[id]/identity/route');
  const setup = await import('@/app/api/auth/credential-setup/route');
  const iam = await import('@/modules/iam');
  const vendor = await import('@/modules/iam/transitions/vendor');
  const { credentialTokenFor } = await import('@/modules/iam/credentials');
  const { holdTenantRoot, releaseTenantRoot } = await import('@/test/money-fixtures');
  const { prisma } = h;

  const email = (k: string) => `rr-${k}-${h.tag}@example.test`;
  const run = <T,>(fn: (tx: import('@/modules/platform').TxClient) => Promise<T>) => iam.runIdentityTransaction(prisma, fn);
  const vctx = () => ({ operator: 'operator1', requestRef: `REQ-${h.tag}`, operationKey: `vendor:it:${randomUUID()}` });
  const marks = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { tenantRoot: true, rootSuspendedAt: true, isVendorStaff: true, identityStatus: true } });

  it('POST /users and PATCH /users/:id: no tenant user (SUPER_ADMIN included) sets tenantRoot, vendor staff or an attestation', async () => {
    await h.as('owner');
    const res = await users.POST(
      h.req('POST', '/api/settings/users', { email: email('new'), password: 'Passw0rd123', role: 'FINANCE_MANAGER', tenantRoot: true, isVendorStaff: true, identityStatus: 'ATTESTED' }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { user: { id: string } }).user.id;
    expect(await marks(id)).toMatchObject({ tenantRoot: false, isVendorStaff: false, identityStatus: 'UNATTESTED' });
    for (const who of ['owner', 'adminA'] as const) {
      await h.as(who);
      for (const target of [id, h.users[who].id]) {
        const r = await user.PATCH(h.req('PATCH', '/x', { tenantRoot: true, rootSuspendedAt: null, isVendorStaff: true, identityStatus: 'ATTESTED' }), h.params({ id: target }));
        expect(r.status, `${who} -> ${target}`).toBeLessThan(500);
        expect(await marks(target)).toMatchObject({ tenantRoot: false, isVendorStaff: false, identityStatus: 'UNATTESTED' });
      }
    }
    // HR and the other company are not even admins of users.
    for (const who of ['hrA', 'finB', 'empA'] as const) {
      await h.as(who);
      expect((await user.PATCH(h.req('PATCH', '/x', { tenantRoot: true }), h.params({ id }))).status, who).toBe(403);
    }
    expect(await prisma.tenantNamedPerson.count({ where: { requestRef: `REQ-${h.tag}` } })).toBe(0);
  });

  it('ROOT_ATTEST_OWN through the identity route: deny 401 / HR / employee / other company; the root gets 202 WITHOUT a code; Radeef releases it; the holder completes', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      // The root (owner) created the account: the ordinary rule refuses him (CREATOR).
      await h.as('owner');
      const created = await users.POST(h.req('POST', '/api/settings/users', { email: email('own'), password: 'Passw0rd123', role: 'PAYROLL_ADMIN' }));
      const id = ((await created.json()) as { user: { id: string } }).user.id;
      const body = { action: 'attest', attestedEmail: email('own'), emailConfirmed: true, historyReviewed: true, verificationNote: 'طلب المالك الرسمي ومقابلة بالفيديو' };
      const refused = await identity.POST(h.req('POST', '/x', body), h.params({ id }));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { details: { problems: string[] } }).details.problems).toContain('CREATOR');

      // Radeef registers the owner's named person and links the account (vendor CLI path).
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: vctx(), email: email('own'), nationalId: '1055555555' }));
      await run((tx) => vendor.linkNamedPerson(tx, { ctx: vctx(), email: email('own') }));

      // Deny: no session, HR, an employee, the other company.
      await h.as(null);
      expect((await identity.POST(h.req('POST', '/x', body), h.params({ id }))).status).toBe(401);
      expect((await identity.GET(h.req('GET', '/x'), h.params({ id }))).status).toBe(401);
      for (const who of ['hrA', 'empA', 'finB', 'adminB'] as const) {
        await h.as(who);
        expect((await identity.POST(h.req('POST', '/x', body), h.params({ id }))).status, who).toBe(403);
      }
      expect(await prisma.credentialToken.count({ where: { userId: id, usedAt: null, revokedAt: null } })).toBe(0);

      // Allow: the root. GET shows the named entry (intact), never an id number or its hash.
      await h.as('owner');
      const view = await (await identity.GET(h.req('GET', '/x'), h.params({ id }))).json();
      expect(view.namedPerson).toMatchObject({ email: email('own'), intact: true, requestRef: `REQ-${h.tag}` });
      expect(JSON.stringify(view)).not.toMatch(/1055555555|nationalIdHash|[0-9a-f]{64}/);
      const idem = randomUUID();
      const started = await identity.POST(h.req('POST', '/x', body, { 'idempotency-key': idem }), h.params({ id }));
      expect(started.status).toBe(202);
      const sb = (await started.json()) as Record<string, unknown>;
      expect(sb).toMatchObject({ status: 'PENDING_SETUP', rootAttestOwn: true });
      expect(sb).not.toHaveProperty('code');
      // A double click (same Idempotency-Key) replays: one link, still no code.
      const again = await identity.POST(h.req('POST', '/x', body, { 'idempotency-key': idem }), h.params({ id }));
      expect(again.status).toBe(202);
      expect(await again.json()).not.toHaveProperty('code');
      expect(await prisma.credentialToken.count({ where: { userId: id } })).toBe(1);

      // Radeef releases the code (once); the holder completes with link + code on the public route.
      const rel = await run((tx) => vendor.releaseCode(tx, { ctx: vctx(), email: email('own') }));
      const code = iam.credentialCodeFor(rel.tokenId);
      const link = credentialTokenFor(rel.tokenId);
      await h.as(null);
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: link, code, password: 'Holder-chosen-1', confirmPassword: 'Holder-chosen-1' }))).status).toBe(200);
      expect(await prisma.user.findUniqueOrThrow({ where: { id }, select: { identityStatus: true, identityAttestedById: true } })).toMatchObject({
        identityStatus: 'ATTESTED',
        identityAttestedById: h.users.owner.id,
      });
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('an admin email change of a named account breaks its link (GET shows it); the root is refused NAMED_LINK_BROKEN', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      await h.as('owner');
      const created = await users.POST(h.req('POST', '/api/settings/users', { email: email('brk'), password: 'Passw0rd123', role: 'HR_MANAGER' }));
      const id = ((await created.json()) as { user: { id: string } }).user.id;
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: vctx(), email: email('brk'), nationalId: '1066666666' }));
      await run((tx) => vendor.linkNamedPerson(tx, { ctx: vctx(), email: email('brk') }));
      await h.as('adminA');
      expect((await user.PATCH(h.req('PATCH', '/x', { email: email('brk2') }), h.params({ id }))).status).toBe(200);
      expect((await user.PATCH(h.req('PATCH', '/x', { email: email('brk') }), h.params({ id }))).status).toBe(200);
      await h.as('owner');
      expect((await (await identity.GET(h.req('GET', '/x'), h.params({ id }))).json()).namedPerson).toMatchObject({ intact: false });
      const r = await identity.POST(
        h.req('POST', '/x', { action: 'attest', attestedEmail: email('brk'), emailConfirmed: true, historyReviewed: true, verificationNote: 'طلب المالك الرسمي ومقابلة بالفيديو' }),
        h.params({ id }),
      );
      expect(r.status).toBe(403);
      expect(((await r.json()) as { details: { problems: string[] } }).details.problems).toContain('NAMED_LINK_BROKEN');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });
});
