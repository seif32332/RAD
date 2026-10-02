// P0-08 (AUDIT/13_MASTER_PLAN.md, EV-10016): requireUser / getSessionUser with REAL session tokens.
// Tokens are signed and verified by the real src/lib/session.ts (jose, HS256, test secret). Only the
// request cookie store (next/headers) and the database (Prisma) are replaced.
import { SignJWT } from 'jose';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'p0-08-test-secret-0123456789abcdef0123456789';
const prevSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = TEST_SECRET;

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  user: null as Record<string, unknown> | null,
  findUnique: [] as unknown[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'radeef_session' && mocks.cookie !== undefined ? { name, value: mocks.cookie } : undefined),
  }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async (args: unknown) => {
        mocks.findUnique.push(args);
        return mocks.user;
      },
    },
  },
}));

import { signSession, credentialVersion } from '@/lib/session';
import { HttpError } from '@/lib/http';
import { ROLE_GROUPS } from '@/lib/constants';

const PASSWORD_HASH = '$2b$04$abcdefghijklmnopqrstuuHASHofTHEcurrentPASSWORDxxxxxxx';

function dbUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'hr@example.test',
    role: 'HR_MANAGER',
    name: 'HR One',
    avatarUrl: null,
    isActive: true,
    passwordHash: PASSWORD_HASH,
    sessionVersion: 2,
    documentsOnlyUntil: null,
    employeeProfile: { id: 'e1', firstNameArabic: 'م', lastNameArabic: 'ع' },
    ...over,
  };
}

/** A token exactly as the login route issues it for dbUser(). */
function loginToken(over: { sub?: string; role?: string; passwordHash?: string; sessionVersion?: number } = {}, maxAge?: number) {
  return signSession(
    { sub: over.sub ?? 'u1', role: over.role ?? 'HR_MANAGER', passwordHash: over.passwordHash ?? PASSWORD_HASH, sessionVersion: over.sessionVersion ?? 2 },
    maxAge,
  );
}

async function loadAuth() {
  // react `cache` is per request in RSC; a fresh module per test = a fresh request.
  vi.resetModules();
  return import('@/lib/auth');
}

async function expectStatus(p: Promise<unknown>, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected HttpError ${status}`).toBeInstanceOf(Error);
  expect((err as HttpError).status).toBe(status);
}

beforeEach(() => {
  mocks.cookie = undefined;
  mocks.user = dbUser();
  mocks.findUnique = [];
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = prevSecret;
});

describe('requireUser: no or unusable session -> 401', () => {
  it('no cookie: 401 and the database is not queried', async () => {
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect(await auth.getSessionUser()).toBeNull();
    expect(mocks.findUnique).toHaveLength(0);
  });

  it('empty cookie value: 401', async () => {
    mocks.cookie = '';
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });

  it('garbage (not a JWT): 401', async () => {
    mocks.cookie = 'not-a-jwt';
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect(mocks.findUnique).toHaveLength(0);
  });

  it('tampered payload (role raised to SUPER_ADMIN, signature kept): 401', async () => {
    const token = await loginToken({ role: 'EMPLOYEE' });
    const [h, p, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.role = 'SUPER_ADMIN';
    claims.sub = 'someone-else';
    mocks.cookie = [h, Buffer.from(JSON.stringify(claims)).toString('base64url'), s].join('.');
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect(mocks.findUnique).toHaveLength(0);
  });

  it('tampered signature: 401', async () => {
    const token = await loginToken();
    // Change the FIRST signature character (the last one partly carries padding bits).
    const [h, p, s] = token.split('.');
    mocks.cookie = [h, p, (s[0] === 'A' ? 'B' : 'A') + s.slice(1)].join('.');
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });

  it('token signed with a different secret: 401', async () => {
    mocks.cookie = await new SignJWT({ role: 'SUPER_ADMIN', sv: 2 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-secret-0123456789abcdef'));
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });

  it('unsigned token (alg "none"): 401', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    mocks.cookie = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: 'u1', role: 'SUPER_ADMIN', sv: 2, iat: now, exp: now + 3600 })}.`;
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });

  it('expired token (right secret): 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.cookie = await new SignJWT({ role: 'HR_MANAGER', sv: 2, cv: await credentialVersion(PASSWORD_HASH) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(TEST_SECRET));
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect(mocks.findUnique).toHaveLength(0);
  });

  it('valid signature but no role claim: 401', async () => {
    mocks.cookie = await new SignJWT({ sv: 2 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });
});

describe('requireUser: the database decides, not the token', () => {
  it('user no longer exists: 401', async () => {
    mocks.cookie = await loginToken();
    mocks.user = null;
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect(mocks.findUnique[0]).toMatchObject({ where: { id: 'u1' } });
  });

  it('deactivated user: 401 even with a valid, unexpired token', async () => {
    mocks.cookie = await loginToken();
    mocks.user = dbUser({ isActive: false });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect(await auth.getSessionUser()).toBeNull();
  });

  it('logout elsewhere (sessionVersion bumped): the older token is revoked -> 401', async () => {
    mocks.cookie = await loginToken({ sessionVersion: 2 });
    mocks.user = dbUser({ sessionVersion: 3 });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });

  it('token without an sv claim is accepted only while User.sessionVersion is still 0', async () => {
    mocks.cookie = await signSession({ sub: 'u1', role: 'HR_MANAGER', passwordHash: PASSWORD_HASH });
    mocks.user = dbUser({ sessionVersion: 0 });
    expect((await (await loadAuth()).requireUser()).id).toBe('u1');
    mocks.user = dbUser({ sessionVersion: 1 });
    await expectStatus((await loadAuth()).requireUser(), 401);
  });

  it('password changed / reset (credential version differs): 401', async () => {
    mocks.cookie = await loginToken();
    mocks.user = dbUser({ passwordHash: '$2b$04$aDIFFERENTsaltANDhashAFTERpasswordRESETxxxxxxxxxxxxxx' });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
  });

  it('legacy token without a cv claim is still accepted until it expires (documented behaviour)', async () => {
    mocks.cookie = await signSession({ sub: 'u1', role: 'HR_MANAGER', sessionVersion: 2 });
    const auth = await loadAuth();
    expect((await auth.requireUser()).id).toBe('u1');
  });

  it('documents-only leaver: logged out for requireUser (401), accepted by requireDocumentsUser', async () => {
    mocks.cookie = await loginToken();
    mocks.user = dbUser({ documentsOnlyUntil: new Date(Date.now() + 86_400_000) });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(), 401);
    expect((await auth.requireDocumentsUser()).documentsOnly).toBe(true);
  });

  it('a token claiming SUPER_ADMIN for a user whose stored role is EMPLOYEE gets the EMPLOYEE role (403 on admin routes)', async () => {
    mocks.cookie = await loginToken({ role: 'SUPER_ADMIN' });
    mocks.user = dbUser({ role: 'EMPLOYEE' });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(ROLE_GROUPS.ADMIN), 403);
    expect((await auth.requireUser()).role).toBe('EMPLOYEE');
  });

  it('a role removed in the database takes effect on the next request (no re-login needed)', async () => {
    mocks.cookie = await loginToken({ role: 'HR_MANAGER' });
    expect((await (await loadAuth()).requireUser(ROLE_GROUPS.HR)).role).toBe('HR_MANAGER');
    mocks.user = dbUser({ role: 'DEPT_MANAGER' });
    await expectStatus((await loadAuth()).requireUser(ROLE_GROUPS.HR), 403);
  });
});

describe('requireUser: role groups', () => {
  it('allowed role: returns the user built from the database row', async () => {
    mocks.cookie = await loginToken();
    const auth = await loadAuth();
    const u = await auth.requireUser(ROLE_GROUPS.HR);
    expect(u).toEqual({
      id: 'u1',
      email: 'hr@example.test',
      role: 'HR_MANAGER',
      name: 'HR One',
      avatarUrl: null,
      employeeId: 'e1',
      sessionVersion: 2,
    });
  });

  it('role not in the group: 403 (not 401)', async () => {
    mocks.cookie = await loginToken();
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(ROLE_GROUPS.FINANCE), 403);
    await expectStatus(auth.requireUser(ROLE_GROUPS.ADMIN), 403);
    await expectStatus(auth.requireUser(ROLE_GROUPS.LEGAL), 403);
  });

  it('no argument = ROLE_GROUPS.ALL: a plain employee passes', async () => {
    mocks.cookie = await loginToken({ role: 'EMPLOYEE' });
    mocks.user = dbUser({ role: 'EMPLOYEE' });
    const auth = await loadAuth();
    expect((await auth.requireUser()).role).toBe('EMPLOYEE');
  });

  it('EMPLOYEE is not STAFF', async () => {
    mocks.cookie = await loginToken({ role: 'EMPLOYEE' });
    mocks.user = dbUser({ role: 'EMPLOYEE' });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser(ROLE_GROUPS.STAFF), 403);
  });

  it('every role group: members pass, non-members get 403', async () => {
    const { ALL_ROLES } = await import('@/lib/constants');
    mocks.cookie = await loginToken();
    for (const [group, members] of Object.entries(ROLE_GROUPS)) {
      for (const role of ALL_ROLES as readonly string[]) {
        mocks.user = dbUser({ role });
        const auth = await loadAuth();
        if ((members as readonly string[]).includes(role)) {
          expect((await auth.requireUser(members)).role, `${role} in ${group}`).toBe(role);
        } else {
          await expectStatus(auth.requireUser(members), 403);
        }
      }
    }
    // Every group × every role, each with a fresh module load: slow under a full parallel run.
  }, 30_000);

  it('an empty group denies everyone (fail closed)', async () => {
    mocks.cookie = await loginToken({ role: 'SUPER_ADMIN' });
    mocks.user = dbUser({ role: 'SUPER_ADMIN' });
    const auth = await loadAuth();
    await expectStatus(auth.requireUser([]), 403);
  });
});

describe('requireEmployeeId / hasRole / getClientIp', () => {
  it('requireEmployeeId: 403 when the account has no employee file, the id otherwise', async () => {
    mocks.cookie = await loginToken();
    mocks.user = dbUser({ employeeProfile: null });
    await expectStatus((await loadAuth()).requireEmployeeId(), 403);
    mocks.user = dbUser();
    expect(await (await loadAuth()).requireEmployeeId()).toBe('e1');
  });

  it('requireEmployeeId without a session: 401', async () => {
    await expectStatus((await loadAuth()).requireEmployeeId(), 401);
  });

  it('hasRole: null user is never in a group', async () => {
    const { hasRole } = await loadAuth();
    expect(hasRole(null, ROLE_GROUPS.ALL)).toBe(false);
    expect(hasRole(undefined, ROLE_GROUPS.ALL)).toBe(false);
    expect(hasRole({ role: 'HR_MANAGER' }, ROLE_GROUPS.HR)).toBe(true);
    expect(hasRole({ role: 'EMPLOYEE' }, ROLE_GROUPS.STAFF)).toBe(false);
  });

  it('getClientIp: X-Real-IP first, else the RIGHT-most X-Forwarded-For hop (client-supplied hops ignored)', async () => {
    const { getClientIp } = await loadAuth();
    const req = (h: Record<string, string>) => new Request('http://x.test/', { headers: h });
    expect(getClientIp(req({ 'x-real-ip': ' 10.0.0.9 ', 'x-forwarded-for': '1.1.1.1, 10.0.0.1' }))).toBe('10.0.0.9');
    expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 10.0.0.1' }))).toBe('10.0.0.1');
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe(getClientIp(req({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })));
    expect(getClientIp(req({}))).toBe('unknown');
  });
});
