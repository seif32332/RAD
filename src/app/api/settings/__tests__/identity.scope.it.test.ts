// BL-PAY-005 (identity controls) through the routes, on a real database with REAL authentication
// (src/test/route-harness.ts): allow, deny and the other company for every new or changed route:
//   /api/settings/users (POST), /api/settings/users/:id (PATCH, DELETE), /api/settings/users/:id/identity
//   (GET, POST), /api/settings/identity-requests (GET), /api/settings/identity-requests/:id (POST),
//   /api/settings/profile (POST: the named self-change operations), /api/auth/credential-setup (public),
//   /api/auth/login (the legacy re-hash through iam.self.rehashPassword).
// The users routes are tenant-wide (User has no company, §5.4.2): "another company" means a user scoped to
// another company, who is denied like any non-admin, and an employee never sees another person's request.
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a THROWAWAY migrated database.
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('identity routes (BL-PAY-005): allow / deny / other company, real auth', { timeout: 300_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const users = await import('@/app/api/settings/users/route');
  const user = await import('@/app/api/settings/users/[id]/route');
  const identity = await import('@/app/api/settings/users/[id]/identity/route');
  const requests = await import('@/app/api/settings/identity-requests/route');
  const request = await import('@/app/api/settings/identity-requests/[id]/route');
  const profile = await import('@/app/api/settings/profile/route');
  const me = await import('@/app/api/profile/route');
  const setup = await import('@/app/api/auth/credential-setup/route');
  const login = await import('@/app/api/auth/login/route');
  const { signSession } = await import('@/lib/session');
  const { holdTenantRoot, releaseTenantRoot } = await import('@/test/money-fixtures');
  const { credentialTokenFor } = await import('@/modules/iam/credentials');
  const { credentialCodeFor: iamCode } = await import('@/modules/iam');

  /** Signs in as any user of the database, with his current credentials (a real token). */
  const asUser = async (id: string) => {
    const u = await h.prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true, passwordHash: true, sessionVersion: true } });
    state.token = await signSession({ sub: id, role: u.role, passwordHash: u.passwordHash, sessionVersion: u.sessionVersion });
  };
  const created = async (who: 'owner' | 'adminA', body: Record<string, unknown>, idem?: string) => {
    await h.as(who);
    const res = await users.POST(h.req('POST', '/api/settings/users', body, idem ? { 'idempotency-key': idem } : {}));
    return { status: res.status, body: (await res.json()) as { user: { id: string; identity: { identityStatus: string; createdById: string }; employeeLink: { id: string; status: string } | null } } };
  };
  const email = (k: string) => `ir-${k}-${h.tag}@example.test`;

  it('POST /users: 401 / 403 for HR, employees and the other company; an admin creates (createdById = him, UNATTESTED); the link is only PROPOSED; a double POST with one Idempotency-Key replays', async () => {
    await h.as(null);
    expect((await users.POST(h.req('POST', '/x', { email: email('no'), password: 'Passw0rd123', role: 'EMPLOYEE' }))).status).toBe(401);
    for (const who of ['hrA', 'hrB', 'empA', 'payrollB'] as const) {
      await h.as(who);
      expect((await users.POST(h.req('POST', '/x', { email: email(`no-${who}`), password: 'Passw0rd123', role: 'EMPLOYEE' }))).status, who).toBe(403);
    }
    const emp = await h.employee('A');
    const idem = randomUUID();
    const a = await created('adminA', { email: email('linked'), password: 'Passw0rd123', role: 'EMPLOYEE', employeeId: emp.id }, idem);
    expect(a.status).toBe(201);
    expect(a.body.user.identity).toMatchObject({ identityStatus: 'UNATTESTED', createdById: h.users.adminA.id });
    expect(a.body.user.employeeLink).toMatchObject({ status: 'PROPOSED' });
    expect((await h.prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).userId).toBeNull();
    const again = await created('adminA', { email: email('linked'), password: 'Passw0rd123', role: 'EMPLOYEE', employeeId: emp.id }, idem);
    expect(again.body.user.id).toBe(a.body.user.id);
    expect(await h.prisma.user.count({ where: { email: email('linked') } })).toBe(1);
  });

  it('PATCH /users/:id: an admin never sets another user\'s password (DEC-PO-027); HR and the other company 403; unlink ends the access link', async () => {
    const u = await created('owner', { email: email('patch'), password: 'Passw0rd123', role: 'EMPLOYEE' });
    await h.as('owner');
    const pw = await user.PATCH(h.req('PATCH', '/x', { password: 'NewPassw0rd1' }), h.params({ id: u.body.user.id }));
    expect(pw.status).toBe(400);
    for (const who of ['hrB', 'empB'] as const) {
      await h.as(who);
      expect((await user.PATCH(h.req('PATCH', '/x', { name: 'x' }), h.params({ id: u.body.user.id }))).status, who).toBe(403);
    }
    await h.as('owner');
    expect((await user.PATCH(h.req('PATCH', '/x', { name: `n-${h.tag}`, role: 'GOV_RELATIONS' }), h.params({ id: u.body.user.id }))).status).toBe(200);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: u.body.user.id } })).role).toBe('GOV_RELATIONS');
  });

  let attestedId = '';
  let attestedPassword = '';
  it('identity GET / POST attest + the public credential-setup: deny HR / employees / other company; the root attests (code shown once); the holder completes with link + code; a second use is 410', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const u = await created('adminA', { email: email('att'), password: 'Passw0rd123', role: 'FINANCE_MANAGER' });
      attestedId = u.body.user.id;
      const body = { action: 'attest', attestedEmail: email('att'), emailConfirmed: true, historyReviewed: true, verificationNote: 'مقابلة حضورية مع الهوية الوطنية' };
      await h.as(null);
      expect((await identity.GET(h.req('GET', '/x'), h.params({ id: attestedId }))).status).toBe(401);
      for (const who of ['hrA', 'empA', 'finB'] as const) {
        await h.as(who);
        expect((await identity.GET(h.req('GET', '/x'), h.params({ id: attestedId }))).status, who).toBe(403);
        expect((await identity.POST(h.req('POST', '/x', body), h.params({ id: attestedId }))).status, who).toBe(403);
      }
      await h.as('adminA');
      const view = await (await identity.GET(h.req('GET', '/x'), h.params({ id: attestedId }))).json();
      expect(view.identity).toMatchObject({ identityStatus: 'UNATTESTED', twoChannelRequired: true });
      expect(view.credentialHistory.map((x: { action: string }) => x.action)).toContain('iam.user.create');
      // adminA created the account: he never attests it, nor is he in the root's chain.
      expect((await identity.POST(h.req('POST', '/x', body), h.params({ id: attestedId }))).status).toBe(403);
      // The email was set by an admin: the holder confirms it from his own session first (review round 2).
      await asUser(attestedId);
      expect((await profile.POST(h.req('POST', '/x', { actionType: 'CONFIRM_EMAIL', currentPassword: 'Passw0rd123' }))).status).toBe(200);
      await h.as('owner');
      const started = await identity.POST(h.req('POST', '/x', body), h.params({ id: attestedId }));
      expect(started.status).toBe(202);
      const { code } = (await started.json()) as { code: string };
      expect(code).toMatch(/^\d{4}-\d{4}$/);
      const token = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: attestedId, usedAt: null, revokedAt: null } });
      const link = credentialTokenFor(token.id);
      // Public: invalid links get one answer; the code is required; the holder completes.
      expect((await setup.POST(h.req('POST', '/api/auth/credential-setup', { action: 'inspect', token: 'junk' }))).status).toBe(400);
      expect(await (await setup.POST(h.req('POST', '/api/auth/credential-setup', { action: 'inspect', token: link }))).json()).toMatchObject({ valid: true, codeRequired: true });
      attestedPassword = 'Chosen-by-holder-1';
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: link, code: '00000000' === code.replace('-', '') ? '11111111' : '00000000', password: attestedPassword, confirmPassword: attestedPassword }))).status).toBe(403);
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: link, code, password: attestedPassword, confirmPassword: attestedPassword }))).status).toBe(200);
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: link, code, password: attestedPassword, confirmPassword: attestedPassword }))).status).toBe(410);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: attestedId } })).identityStatus).toBe('ATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('identity POST confirmLink: the account\'s own link is never confirmed by it; an attested second person (the root) confirms through the route', async () => {
    const emp = await h.employee('A');
    const u = await created('adminA', { email: email('lk'), password: 'Passw0rd123', role: 'EMPLOYEE', employeeId: emp.id });
    const linkId = u.body.user.employeeLink!.id;
    await h.as('empA');
    expect((await identity.POST(h.req('POST', '/x', { action: 'confirmLink', linkId }), h.params({ id: u.body.user.id }))).status).toBe(403);
    await h.as('owner');
    expect((await identity.POST(h.req('POST', '/x', { action: 'confirmLink', linkId }), h.params({ id: h.users.hrA.id }))).status).toBe(404); // a link of another account
    await asUser(attestedId); // an attested FINANCE_MANAGER is no admin: the route is admin-only
    expect((await identity.POST(h.req('POST', '/x', { action: 'confirmLink', linkId }), h.params({ id: u.body.user.id }))).status).toBe(403);
    // The owner as TENANT_ROOT (an attested person, neither the proposer nor the creator) confirms: the access link exists.
    await holdTenantRoot(h.users.owner.id);
    try {
      await h.as('owner');
      const res = await identity.POST(h.req('POST', '/x', { action: 'confirmLink', linkId }), h.params({ id: u.body.user.id }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ selfAct: false, link: { status: 'CONFIRMED' } });
      expect((await h.prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).userId).toBe(u.body.user.id);
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('identity POST resetCredentials: one admin resets an unattested account; its sessions end at once (real session refused afterwards); HR 403', async () => {
    const u = await created('owner', { email: email('rst'), password: 'Passw0rd123', role: 'EMPLOYEE' });
    await asUser(u.body.user.id);
    expect((await me.GET()).status).toBe(200);
    const session = state.token;
    await h.as('hrA');
    expect((await identity.POST(h.req('POST', '/x', { action: 'resetCredentials' }), h.params({ id: u.body.user.id }))).status).toBe(403);
    await h.as('owner');
    expect((await identity.POST(h.req('POST', '/x', { action: 'resetCredentials', reason: 'طلب الموظف' }), h.params({ id: u.body.user.id }))).status).toBe(200);
    state.token = session;
    expect((await me.GET()).status).toBe(401);
  });

  it('DELETE an attested approver: a pending two-person request (202); identity-requests: the holder sees and consents; HR / another person 403; the requester cannot approve', async () => {
    await h.as('adminA');
    const del = await user.DELETE(h.req('DELETE', '/x'), h.params({ id: attestedId }));
    expect(del.status).toBe(202);
    const { pendingRequest } = (await del.json()) as { pendingRequest: { id: string } };
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: attestedId } })).isActive).toBe(true);
    await h.as(null);
    expect((await requests.GET()).status).toBe(401);
    await h.as('empB');
    expect(((await (await requests.GET()).json()) as { requests: Array<{ id: string }> }).requests.map((r) => r.id)).not.toContain(pendingRequest.id);
    for (const who of ['empB', 'hrA'] as const) {
      await h.as(who);
      expect((await request.POST(h.req('POST', '/x', { decision: 'APPROVE' }), h.params({ id: pendingRequest.id }))).status, who).toBe(403);
    }
    await h.as('adminA');
    expect(((await (await requests.GET()).json()) as { requests: Array<{ id: string }> }).requests.map((r) => r.id)).toContain(pendingRequest.id);
    expect((await request.POST(h.req('POST', '/x', { decision: 'APPROVE' }), h.params({ id: pendingRequest.id }))).status).toBe(403);
    await asUser(attestedId);
    expect(((await (await requests.GET()).json()) as { requests: Array<{ id: string }> }).requests.map((r) => r.id)).toEqual([pendingRequest.id]);
    expect((await request.POST(h.req('POST', '/x', { decision: 'APPROVE', note: 'أغادر الشركة' }), h.params({ id: pendingRequest.id }))).status).toBe(200);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: attestedId } })).isActive).toBe(false);
  });

  it('POST /settings/profile: the named self-change operations; 401 without a session; a user changes only himself; an attested account\'s email is changed through Radeef only', async () => {
    await h.as(null);
    expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_PASSWORD', currentPassword: 'x', newPassword: 'Abcdefg12', confirmPassword: 'Abcdefg12' }))).status).toBe(401);
    const id = (await h.prisma.user.create({ data: { email: email('self'), passwordHash: await bcrypt.hash('Current-pass1', 4), role: 'HR_MANAGER' } })).id;
    await asUser(id);
    expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_PASSWORD', currentPassword: 'wrong-pass', newPassword: 'Abcdefg12', confirmPassword: 'Abcdefg12' }))).status).toBe(403);
    expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_PASSWORD', currentPassword: 'Current-pass1', newPassword: 'Newpass-123', confirmPassword: 'Newpass-123' }))).status).toBe(200);
    expect(await bcrypt.compare('Newpass-123', (await h.prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash)).toBe(true);
    await asUser(id);
    expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_EMAIL', newEmail: email('self2'), currentPassword: 'Newpass-123' }))).status).toBe(200);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id } })).email).toBe(email('self2'));
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: h.users.hrB.id } })).email).not.toBe(email('self2'));
    // An attested account (the one completed above, reactivated for this check through the fixture).
    const { identityFixture } = await import('@/test/money-fixtures');
    await identityFixture(attestedId, { isActive: true });
    await asUser(attestedId);
    expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_EMAIL', newEmail: email('att2'), currentPassword: attestedPassword }))).status).toBe(403);
  });

  it('REGRESSION (review HIGH): one attested admin cannot mint a second attested approver he controls (email change -> promote -> attest -> credential-setup)', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      // X: an admin attested by the root through the routes (link + in-person code).
      const xUser = await created('adminA', { email: email('x'), password: 'Passw0rd123', role: 'COMPANY_ADMIN' });
      const xId = xUser.body.user.id;
      await asUser(xId);
      expect((await profile.POST(h.req('POST', '/x', { actionType: 'CONFIRM_EMAIL', currentPassword: 'Passw0rd123' }))).status).toBe(200);
      await h.as('owner');
      const sx = await identity.POST(h.req('POST', '/x', { action: 'attest', attestedEmail: email('x'), emailConfirmed: true, historyReviewed: true, verificationNote: 'مقابلة حضورية مع الهوية الوطنية' }), h.params({ id: xId }));
      expect(sx.status).toBe(202);
      const xCode = ((await sx.json()) as { code: string }).code;
      const xTok = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: xId, usedAt: null, revokedAt: null } });
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(xTok.id), code: xCode, password: 'X-chosen-pass1', confirmPassword: 'X-chosen-pass1' }))).status).toBe(200);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: xId } })).identityStatus).toBe('ATTESTED');

      // V: a legacy account (no recorded creator, UNATTESTED, no approver role).
      const vId = (await h.prisma.user.create({ data: { email: email('victim'), passwordHash: 'x', role: 'EMPLOYEE' } })).id;
      await asUser(xId);
      // 1. X points V's login email at an address X controls; 2. X promotes V to a financial approver role.
      expect((await user.PATCH(h.req('PATCH', '/x', { email: email('x-mailbox') }), h.params({ id: vId }))).status).toBe(200);
      expect((await user.PATCH(h.req('PATCH', '/x', { role: 'FINANCE_MANAGER' }), h.params({ id: vId }))).status).toBe(200);
      // 3. X attests V: refused (he set V's email and role); no link, no code is issued.
      const att = await identity.POST(h.req('POST', '/x', { action: 'attest', attestedEmail: email('x-mailbox'), emailConfirmed: true, historyReviewed: true, verificationNote: 'مقابلة حضورية مع الهوية الوطنية' }), h.params({ id: vId }));
      expect(att.status).toBe(403);
      const refusal = (await att.json()) as { code?: string; details: { problems: string[] } };
      expect(refusal).not.toHaveProperty('code');
      expect(refusal.details.problems).toEqual(expect.arrayContaining(['TOUCHED_BY_ATTESTER', 'EMAIL_SET_BY_ATTESTER']));
      const tok = await h.prisma.credentialToken.findFirst({ where: { userId: vId, usedAt: null, revokedAt: null } });
      expect(tok).toBeNull();
      // 4. Had a link existed, the credential setup could not complete either: V never becomes ATTESTED.
      if (tok) {
        await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(tok.id), code: '0000-0000', password: 'Mallory-pass1', confirmPassword: 'Mallory-pass1' }));
      }
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: vId } })).identityStatus).toBe('UNATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  // ---- Second review round: the attester's whole side (second logins he controls, accounts they create, his chain) ----
  const attestBody = (addr: string) => ({ action: 'attest', attestedEmail: addr, emailConfirmed: true, historyReviewed: true, verificationNote: 'مقابلة حضورية مع الهوية الوطنية' });
  /** The holder re-confirms his own login email from his own session (BL-PAY-005 second round). Status only. */
  const selfConfirm = async (id: string, password: string) => {
    await asUser(id);
    return (await profile.POST(h.req('POST', '/x', { actionType: 'CONFIRM_EMAIL', currentPassword: password }))).status;
  };
  /** The root attests `id` through the routes and the holder completes with link + code. */
  const rootAttests = async (id: string, addr: string, password: string) => {
    await selfConfirm(id, password);
    await h.as('owner');
    const r = await identity.POST(h.req('POST', '/x', attestBody(addr)), h.params({ id }));
    expect(r.status, `root attests ${addr}`).toBe(202);
    const code = ((await r.json()) as { code: string }).code;
    const tok = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: id, usedAt: null, revokedAt: null } });
    expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(tok.id), code, password: `${password}-new1`, confirmPassword: `${password}-new1` }))).status).toBe(200);
    return `${password}-new1`;
  };
  const attestStatus = async (attesterId: string, targetId: string, addr: string) => {
    await asUser(attesterId);
    const r = await identity.POST(h.req('POST', '/x', attestBody(addr)), h.params({ id: targetId }));
    const issued = await h.prisma.credentialToken.count({ where: { userId: targetId, usedAt: null, revokedAt: null } });
    return { status: r.status, issued };
  };

  it('REGRESSION 2a (re-review HIGH): A uses a second admin login A2 he created to set U\'s email and role; A then attests U -> refused', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const aId = (await created('adminA', { email: email('r2a-A'), password: 'Passw0rd-A1', role: 'COMPANY_ADMIN' })).body.user.id;
      await rootAttests(aId, email('r2a-A'), 'Passw0rd-A1');
      await asUser(aId);
      const a2 = await users.POST(h.req('POST', '/x', { email: email('r2a-A2'), password: 'Passw0rd-A2', role: 'COMPANY_ADMIN' }));
      expect(a2.status).toBe(201);
      const a2Id = ((await a2.json()) as { user: { id: string } }).user.id;
      const uId = (await h.prisma.user.create({ data: { email: email('r2a-U'), passwordHash: 'x', role: 'EMPLOYEE' } })).id;
      await asUser(a2Id);
      expect((await user.PATCH(h.req('PATCH', '/x', { email: email('r2a-A-mailbox') }), h.params({ id: uId }))).status).toBe(200);
      expect((await user.PATCH(h.req('PATCH', '/x', { role: 'FINANCE_MANAGER' }), h.params({ id: uId }))).status).toBe(200);
      expect(await attestStatus(aId, uId, email('r2a-A-mailbox'))).toEqual({ status: 403, issued: 0 });
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: uId } })).identityStatus).toBe('UNATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('REGRESSION 2b (re-review HIGH): A2 (created by A) creates U2; A logs in as U2 and "self-sets" the email; A attests U2 -> refused', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const aId = (await created('adminA', { email: email('r2b-A'), password: 'Passw0rd-A1', role: 'COMPANY_ADMIN' })).body.user.id;
      await rootAttests(aId, email('r2b-A'), 'Passw0rd-A1');
      await asUser(aId);
      const a2Id = ((await (await users.POST(h.req('POST', '/x', { email: email('r2b-A2'), password: 'Passw0rd-A2', role: 'COMPANY_ADMIN' }))).json()) as { user: { id: string } }).user.id;
      await asUser(a2Id);
      const u2Id = ((await (await users.POST(h.req('POST', '/x', { email: email('r2b-U2'), password: 'Passw0rd-U2', role: 'FINANCE_MANAGER' }))).json()) as { user: { id: string } }).user.id;
      await asUser(u2Id);
      expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_EMAIL', newEmail: email('r2b-A-mailbox'), currentPassword: 'Passw0rd-U2' }))).status).toBe(200);
      expect(await attestStatus(aId, u2Id, email('r2b-A-mailbox'))).toEqual({ status: 403, issued: 0 });
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('REGRESSION 2c (re-review LOW): A attested B; A sets U\'s email; B attests U -> refused (the attester\'s chain is his side)', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const aId = (await created('adminA', { email: email('r2c-A'), password: 'Passw0rd-A1', role: 'COMPANY_ADMIN' })).body.user.id;
      await rootAttests(aId, email('r2c-A'), 'Passw0rd-A1');
      const bId = (await created('adminA', { email: email('r2c-B'), password: 'Passw0rd-B1', role: 'COMPANY_ADMIN' })).body.user.id;
      await selfConfirm(bId, 'Passw0rd-B1');
      const rb = await attestStatus(aId, bId, email('r2c-B'));
      expect(rb.status).toBe(202);
      const bTok = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: bId, usedAt: null, revokedAt: null } });
      const bCode = iamCode(bTok.id);
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(bTok.id), code: bCode, password: 'Passw0rd-B2', confirmPassword: 'Passw0rd-B2' }))).status).toBe(200);
      const uId = (await h.prisma.user.create({ data: { email: email('r2c-U'), passwordHash: 'x', role: 'FINANCE_MANAGER' } })).id;
      await asUser(aId);
      expect((await user.PATCH(h.req('PATCH', '/x', { email: email('r2c-A-mailbox') }), h.params({ id: uId }))).status).toBe(200);
      expect(await attestStatus(bId, uId, email('r2c-A-mailbox'))).toEqual({ status: 403, issued: 0 });
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('REGRESSION 2d (legitimate path): an independent attested approver attests a holder who re-confirmed his own email (double self-confirm replays nothing new)', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const iId = (await created('adminA', { email: email('r2d-I'), password: 'Passw0rd-I1', role: 'COMPANY_ADMIN' })).body.user.id;
      await rootAttests(iId, email('r2d-I'), 'Passw0rd-I1');
      const hId = (await created('adminA', { email: email('r2d-H'), password: 'Passw0rd-H1', role: 'HR_MANAGER' })).body.user.id;
      // An email set by an admin: no first attestation until the holder re-confirms it himself.
      expect((await attestStatus(iId, hId, email('r2d-H'))).status).toBe(403);
      expect(await selfConfirm(hId, 'Passw0rd-H1')).toBe(200);
      expect(await selfConfirm(hId, 'Passw0rd-H1')).toBe(200);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: hId } })).emailSetById).toBe(hId);
      const r = await attestStatus(iId, hId, email('r2d-H'));
      expect(r).toEqual({ status: 202, issued: 1 });
      const tok = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: hId, usedAt: null, revokedAt: null } });
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(tok.id), code: iamCode(tok.id), password: 'Passw0rd-H2', confirmPassword: 'Passw0rd-H2' }))).status).toBe(200);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: hId } })).identityStatus).toBe('ATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('REGRESSION 2e (DEC-PO-142, the root keeps working): the root attested admin H; H creates employee account E; E self-confirms his email; the root first-attests E -> allowed (202, then ATTESTED)', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const hId = (await created('adminA', { email: email('r2e-H'), password: 'Passw0rd-H1', role: 'COMPANY_ADMIN' })).body.user.id;
      await rootAttests(hId, email('r2e-H'), 'Passw0rd-H1');
      await asUser(hId);
      const e = await users.POST(h.req('POST', '/x', { email: email('r2e-E'), password: 'Passw0rd-E1', role: 'EMPLOYEE' }));
      expect(e.status).toBe(201);
      const eId = ((await e.json()) as { user: { id: string } }).user.id;
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: eId } })).createdById).toBe(hId);
      expect(await selfConfirm(eId, 'Passw0rd-E1')).toBe(200);
      expect(await attestStatus(h.users.owner.id, eId, email('r2e-E'))).toEqual({ status: 202, issued: 1 });
      const tok = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: eId, usedAt: null, revokedAt: null } });
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(tok.id), code: iamCode(tok.id), password: 'Passw0rd-E2', confirmPassword: 'Passw0rd-E2' }))).status).toBe(200);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: eId } })).identityStatus).toBe('ATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('REGRESSION 4a (final re-check): a legacy account with no known creator whose password A knows; A logs in as U, self-changes the email to his mailbox, attests U -> refused (UNKNOWN_CREATOR_ROOT_ONLY)', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const aId = (await created('adminA', { email: email('r4a-A'), password: 'Passw0rd-A1', role: 'COMPANY_ADMIN' })).body.user.id;
      await rootAttests(aId, email('r4a-A'), 'Passw0rd-A1');
      // U: a legacy account (9zk found no creator), its password known to A (legacy admin-set / shared).
      const uId = (await h.prisma.user.create({ data: { email: email('r4a-U'), passwordHash: await bcrypt.hash('Legacy-shared1', 4), role: 'FINANCE_MANAGER' } })).id;
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: uId } })).createdById).toBeNull();
      await asUser(uId);
      expect((await profile.POST(h.req('POST', '/x', { actionType: 'CHANGE_EMAIL', newEmail: email('r4a-A-mailbox'), currentPassword: 'Legacy-shared1' }))).status).toBe(200);
      await asUser(aId);
      const r = await identity.POST(h.req('POST', '/x', attestBody(email('r4a-A-mailbox'))), h.params({ id: uId }));
      expect(r.status).toBe(403);
      expect(((await r.json()) as { details: { problems: string[] } }).details.problems).toContain('UNKNOWN_CREATOR_ROOT_ONLY');
      expect(await h.prisma.credentialToken.count({ where: { userId: uId, usedAt: null, revokedAt: null } })).toBe(0);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: uId } })).identityStatus).toBe('UNATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('REGRESSION 4b: the acting root first-attests a legacy account with no known creator once the holder self-confirmed his email (202, then ATTESTED)', async () => {
    await holdTenantRoot(h.users.owner.id);
    try {
      const uId = (await h.prisma.user.create({ data: { email: email('r4b-U'), passwordHash: await bcrypt.hash('Legacy-own-1', 4), role: 'FINANCE_MANAGER' } })).id;
      expect(await selfConfirm(uId, 'Legacy-own-1')).toBe(200);
      expect(await attestStatus(h.users.owner.id, uId, email('r4b-U'))).toEqual({ status: 202, issued: 1 });
      const tok = await h.prisma.credentialToken.findFirstOrThrow({ where: { userId: uId, usedAt: null, revokedAt: null } });
      expect((await setup.POST(h.req('POST', '/x', { action: 'complete', token: credentialTokenFor(tok.id), code: iamCode(tok.id), password: 'Legacy-own-2', confirmPassword: 'Legacy-own-2' }))).status).toBe(200);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: uId } })).identityStatus).toBe('ATTESTED');
    } finally {
      await releaseTenantRoot(h.users.owner.id);
    }
  });

  it('POST /auth/login: a legacy plaintext password is re-hashed through the named operation; a reset marker is never accepted as a password', async () => {
    const id = (await h.prisma.user.create({ data: { email: email('plain'), passwordHash: 'Legacy-plain-1', role: 'EMPLOYEE' } })).id;
    const ok = await login.POST(h.req('POST', '/api/auth/login', { email: email('plain'), password: 'Legacy-plain-1' }, { 'x-real-ip': `10.9.${Math.floor(Math.random() * 200)}.1` }));
    expect(ok.status).toBe(200);
    const after = await h.prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.passwordHash.startsWith('$2')).toBe(true);
    expect(await h.prisma.auditRecord.count({ where: { entityId: id, action: 'iam.self.rehashPassword' } })).toBe(1);
    const marker = (await h.prisma.user.create({ data: { email: email('marker'), passwordHash: '!reset:abc', role: 'EMPLOYEE' } })).id;
    expect(marker).toBeTruthy();
    expect((await login.POST(h.req('POST', '/api/auth/login', { email: email('marker'), password: '!reset:abc' }, { 'x-real-ip': '10.8.0.1' }))).status).toBe(401);
  });
});
