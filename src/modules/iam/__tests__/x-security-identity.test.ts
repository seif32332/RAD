// BL-PAY-005 acceptance (pay-to-be.md §25 "x-security-identity.test.ts: createdById, the two-step link, the
// bootstrap"; BR-PAY-005; DEC-PO-013 / 016 / 021 / 024 / 027; RT-PAY-302 / 404 / 801 / 901 / 1001 / 1102 /
// 1201 / 1301).
//
// Part 1 (always): the one-time link and code (derived, never stored, constant-time), money.gateway refuses
// every identity write outside an iam operation, the rules (who counts, who may attest, who confirms a link),
// and the vendor scripts write isVendorStaff / identityStatus explicitly.
// Part 2 (PAY_IT=1, a THROWAWAY migrated database): every transition of transitions/identity.ts on PostgreSQL,
// each called twice with one key (ARCH-014 double call), and the end-to-end controls.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  CODE_MAX_ATTEMPTS,
  credentialCodeFor,
  credentialTokenId,
  FINANCIAL_APPROVER_ROLES,
  canApproveChange,
  countsTowardEnforced,
  isAttestedPerson,
  isResetMarker,
  linkConfirmReasons,
  needsTwoChannel,
  protectedByTwoPerson,
  type IdentityUser,
} from '@/modules/iam';
import { MoneyGatewayViolationError, assertWriteAllowed } from '@/modules/platform';
import {
  credentialCodeHash,
  credentialCodeMatches,
  credentialLinkIds,
  credentialLinkPlaceholder,
  credentialTokenFor,
  credentialTokenHash,
  credentialTokenMatches,
  renderCredentialLinkBody,
} from '../credentials';

const ROOT = join(__dirname, '..', '..', '..', '..');

function user(over: Partial<IdentityUser> = {}): IdentityUser {
  return {
    id: randomUUID(),
    email: 'u@example.test',
    role: 'FINANCE_MANAGER',
    isActive: true,
    documentsOnlyUntil: null,
    createdById: null,
    isVendorStaff: false,
    identityStatus: 'UNATTESTED',
    identityAttestedById: null,
    identityAttestedAt: null,
    attestedEmail: null,
    noEmployeeAttestedById: null,
    identityDroppedReason: null,
    identityDroppedAt: null,
    tenantRoot: false,
    rootSuspendedAt: null,
    ...over,
  } as IdentityUser;
}

describe('BL-PAY-005 one-time credential links (derived secret, keyed hashes, constant-time)', () => {
  const id = randomUUID();
  const token = credentialTokenFor(id);

  it('the token is derived from the row id; only a keyed hash is stored; a tampered token never matches', () => {
    expect(credentialTokenId(token)).toBe(id);
    expect(credentialTokenFor(id)).toBe(token); // deterministic: nothing to store
    const row = { id, tokenHash: credentialTokenHash(token) };
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toContain(token.split('.')[1]);
    expect(credentialTokenMatches(row, token)).toBe(true);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(credentialTokenMatches(row, tampered)).toBe(false);
    expect(credentialTokenMatches({ id: randomUUID(), tokenHash: row.tokenHash }, token)).toBe(false);
    expect(credentialTokenId('not-a-token')).toBeNull();
    expect(credentialTokenId(`${id}.short`)).toBeNull();
  });

  it('the in-person code: 8 digits, keyed hash, Arabic digits and dashes accepted, a wrong code refused', () => {
    const code = credentialCodeFor(id);
    expect(code).toMatch(/^\d{4}-\d{4}$/);
    const row = { id, codeHash: credentialCodeHash(id, code) };
    expect(credentialCodeMatches(row, code)).toBe(true);
    expect(credentialCodeMatches(row, code.replace('-', ''))).toBe(true);
    const arabic = code.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    expect(credentialCodeMatches(row, arabic)).toBe(true);
    const wrong = code.replace(/^\d/, (d) => String((Number(d) + 1) % 10));
    expect(credentialCodeMatches(row, wrong)).toBe(false);
    expect(credentialCodeMatches(row, undefined)).toBe(false);
    expect(credentialCodeMatches({ id, codeHash: null }, code)).toBe(false);
    expect(CODE_MAX_ATTEMPTS).toBeGreaterThan(0);
  });

  it('the stored email holds a placeholder, never the link; the link is rendered at send time into the URL fragment', () => {
    const body = `hello\n${credentialLinkPlaceholder(id)}\nbye`;
    expect(body).not.toContain(token);
    expect(credentialLinkIds(body)).toEqual([id]);
    const sent = renderCredentialLinkBody(body, { APP_URL: 'https://hr.example.test/' });
    expect(sent).toContain(`https://hr.example.test/login/set-password#t=${token}`);
    expect(renderCredentialLinkBody(body, {})).toBeNull(); // no APP_URL: nothing is sent
  });
});

describe('BL-PAY-005 money.gateway refuses identity writes outside an iam operation (fail closed)', () => {
  const refused = (model: string | undefined, op: string, args: unknown) => expect(() => assertWriteAllowed(model, op, args)).toThrow(MoneyGatewayViolationError);
  const allowed = (model: string, op: string, args: unknown) => expect(() => assertWriteAllowed(model, op, args)).not.toThrow();

  it('User control columns: on every write, a CREATE included (no vendor staff, attested or root account in-app)', () => {
    for (const col of ['createdById', 'isVendorStaff', 'identityStatus', 'identityAttestedById', 'attestedEmail', 'noEmployeeAttestedById', 'tenantRoot', 'rootSuspendedAt', 'identityDroppedReason']) {
      refused('User', 'update', { where: { id: 'x' }, data: { [col]: null } });
      refused('User', 'create', { data: { email: 'a@b.c', passwordHash: 'x', [col]: null } });
    }
    refused('User', 'upsert', { where: { id: 'x' }, create: { email: 'a', passwordHash: 'x' }, update: { tenantRoot: true } });
  });

  it('User credentials and standing (passwordHash, email, role, isActive): an account is created with them, every change is a named operation', () => {
    allowed('User', 'create', { data: { email: 'a@b.c', passwordHash: 'x', role: 'HR_MANAGER', isActive: true } });
    for (const col of ['passwordHash', 'email', 'role', 'isActive']) refused('User', 'updateMany', { where: {}, data: { [col]: 'x' } });
    allowed('User', 'update', { where: { id: 'x' }, data: { name: 'n', avatarUrl: null, sessionVersion: { increment: 1 } } });
  });

  it('Employee.userId (the access link) and the identity tables, nested and raw writes included', () => {
    refused('Employee', 'update', { where: { id: 'e' }, data: { userId: 'u' } });
    refused('Employee', 'update', { where: { id: 'e' }, data: { user: { connect: { id: 'u' } } } });
    refused('Employee', 'create', { data: { employeeId: 'E1', userId: 'u' } });
    allowed('Employee', 'update', { where: { id: 'e' }, data: { jobTitle: 'x' } });
    for (const t of ['UserEmployeeLink', 'CredentialToken', 'IdentityChangeRequest']) {
      refused(t, 'create', { data: {} });
      refused(t, 'updateMany', { where: {}, data: { status: 'x' } });
    }
    refused('User', 'update', { where: { id: 'u' }, data: { employeeLinks: { create: { employeeId: 'e', status: 'PROPOSED' } } } });
    refused(undefined, '$executeRawUnsafe', ['UPDATE "User" SET "tenantRoot" = true']);
    refused(undefined, '$executeRawUnsafe', ['INSERT INTO "UserEmployeeLink" VALUES (1)']);
    allowed('User', 'findMany', { where: { tenantRoot: true } });
  });
});

describe('BL-PAY-005 the rules (BR-PAY-005, BR-PAY-020, DEC-PO-021)', () => {
  it('financial approver roles are the HR, PAYROLL, FINANCE and OWNER groups (wfe G9)', () => {
    expect([...FINANCIAL_APPROVER_ROLES].sort()).toEqual(['COMPANY_ADMIN', 'FINANCE_MANAGER', 'HR_MANAGER', 'PAYROLL_ADMIN', 'SUPER_ADMIN']);
  });

  it('attested person: ATTESTED or an acting root; never vendor staff, inactive, documents-only; VENDOR_BOOTSTRAP is not an attestation', () => {
    expect(isAttestedPerson(user({ identityStatus: 'ATTESTED' }))).toBe(true);
    expect(isAttestedPerson(user({ tenantRoot: true }))).toBe(true);
    expect(isAttestedPerson(user({ tenantRoot: true, rootSuspendedAt: new Date() }))).toBe(false);
    expect(isAttestedPerson(user({ identityStatus: 'VENDOR_BOOTSTRAP' }))).toBe(false);
    expect(isAttestedPerson(user({ identityStatus: 'ATTESTED', isActive: false }))).toBe(false);
    expect(isAttestedPerson(user({ identityStatus: 'ATTESTED', documentsOnlyUntil: new Date() }))).toBe(false);
    expect(countsTowardEnforced(user({ identityStatus: 'ATTESTED', role: 'EMPLOYEE' }))).toBe(false);
    expect(countsTowardEnforced(user({ identityStatus: 'ATTESTED', role: 'PAYROLL_ADMIN' }))).toBe(true);
  });

  it('protected by two people (DEC-PO-021, lcy "من يُحمى"): attested, acting root or the VENDOR_BOOTSTRAP first admin with an approver role', () => {
    expect(protectedByTwoPerson(user({ identityStatus: 'ATTESTED' }))).toBe(true);
    expect(protectedByTwoPerson(user({ identityStatus: 'VENDOR_BOOTSTRAP', role: 'SUPER_ADMIN' }))).toBe(true);
    expect(protectedByTwoPerson(user({ identityStatus: 'VENDOR_BOOTSTRAP', isVendorStaff: true }))).toBe(false);
    expect(protectedByTwoPerson(user({ identityStatus: 'UNATTESTED' }))).toBe(false);
    expect(protectedByTwoPerson(user({ identityStatus: 'ATTESTED', role: 'EMPLOYEE' }))).toBe(false);
  });

  it('link confirmation: not the proposer, not the creator, an attested person (guard reasons)', () => {
    const creator = user({ identityStatus: 'ATTESTED' });
    const target = user({ createdById: creator.id, role: 'EMPLOYEE' });
    expect(linkConfirmReasons({ confirmer: creator, proposedById: creator.id, target })).toEqual(['SAME_PERSON_TWICE', 'CREATOR_IS_SECOND_PERSON']);
    expect(linkConfirmReasons({ confirmer: user(), proposedById: creator.id, target })).toEqual(['UNATTESTED_SECOND_PERSON']);
    expect(linkConfirmReasons({ confirmer: user({ identityStatus: 'ATTESTED' }), proposedById: creator.id, target })).toEqual([]);
  });

  it('a two-person change is approved by the holder (consent) or another attested approver, never the requester', () => {
    const target = user({ identityStatus: 'ATTESTED' });
    const requester = user({ identityStatus: 'ATTESTED' });
    expect(canApproveChange({ approver: target, requestedById: requester.id, target })).toBe(true);
    expect(canApproveChange({ approver: requester, requestedById: requester.id, target })).toBe(false);
    expect(canApproveChange({ approver: user({ identityStatus: 'ATTESTED' }), requestedById: requester.id, target })).toBe(true);
    expect(canApproveChange({ approver: user(), requestedById: requester.id, target })).toBe(false);
    expect(canApproveChange({ approver: user({ identityStatus: 'ATTESTED', role: 'EMPLOYEE' }), requestedById: requester.id, target })).toBe(false);
  });

  it('creatorUnknown: no recorded creator and not an untouched vendor-bootstrap account (first attestation by the acting root only)', async () => {
    const { creatorUnknown } = await import('@/modules/iam');
    expect(creatorUnknown({ createdById: null, emailSetById: null, identityStatus: 'UNATTESTED' })).toBe(true);
    expect(creatorUnknown({ createdById: null, emailSetById: 'u', identityStatus: 'UNATTESTED' })).toBe(true);
    expect(creatorUnknown({ createdById: null, emailSetById: 'u', identityStatus: 'VENDOR_BOOTSTRAP' })).toBe(true);
    expect(creatorUnknown({ createdById: null, emailSetById: null, identityStatus: 'VENDOR_BOOTSTRAP' })).toBe(false);
    expect(creatorUnknown({ createdById: 'c', emailSetById: null, identityStatus: 'UNATTESTED' })).toBe(false);
  });

  it('two channels for a first attestation and for an email never confirmed; a reset marker is never a password', () => {
    expect(needsTwoChannel({ attestedEmail: null, email: 'a@x.test' })).toBe(true);
    expect(needsTwoChannel({ attestedEmail: 'a@x.test', email: 'A@x.test' })).toBe(false);
    expect(needsTwoChannel({ attestedEmail: 'a@x.test', email: 'b@x.test' })).toBe(true);
    expect(isResetMarker('!reset:abc')).toBe(true);
    expect(isResetMarker('$2b$12$abc')).toBe(false);
  });
});

describe('BL-PAY-005 bootstrap: the vendor scripts write isVendorStaff and identityStatus explicitly (BR-PAY-005 "التمهيد")', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  /** The text of every `.user.create({ … })` call of a script (balanced braces). */
  function userCreates(text: string): string[] {
    const out: string[] = [];
    for (let i = text.indexOf('.user.create('); i >= 0; i = text.indexOf('.user.create(', i + 1)) {
      let depth = 0;
      let j = text.indexOf('(', i);
      for (; j < text.length; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')' && --depth === 0) break;
      }
      out.push(text.slice(i, j + 1));
    }
    return out;
  }

  it.each(['prisma/seed.mjs', 'scripts/create-admin.mjs', 'prisma/demo-seed.mjs', 'scripts/seed-demo.mjs'])('%s: every account it creates has isVendorStaff and identityStatus', (p) => {
    const creates = userCreates(read(p));
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) {
      expect(c, p).toMatch(/isVendorStaff/);
      expect(c, p).toMatch(/identityStatus:\s*'VENDOR_BOOTSTRAP'/);
    }
  });

  it('create-admin: a new account needs --vendor-staff or --customer-admin; a reset of a non-vendor account drops the attestation', () => {
    const t = read('scripts/create-admin.mjs');
    expect(t).toMatch(/a new account needs --vendor-staff or --customer-admin/);
    expect(t).toMatch(/isVendorStaff = args\.kind === '--vendor-staff'/);
    expect(t).toMatch(/data\.identityStatus = 'UNATTESTED'/);
    expect(t).toMatch(/sessionVersion: \{ increment: 1 \}/);
  });

  it('no in-app code writes isVendorStaff or tenantRoot (only the vendor scripts and the vendor panel do)', () => {
    const files = ['src/modules/iam/transitions/identity.ts', 'src/modules/iam/operations.ts', 'src/app/api/settings/users/route.ts', 'src/app/api/settings/users/[id]/route.ts', 'src/app/api/settings/users/[id]/identity/route.ts'];
    for (const f of files) {
      const t = read(f);
      expect(t, f).not.toMatch(/isVendorStaff:\s*(true|false)/);
      expect(t, f).not.toMatch(/tenantRoot:\s*(true|false)/);
    }
  });

  it('nothing in the identity code logs (no token, code or password ever reaches a log)', () => {
    for (const f of ['src/modules/iam/transitions/identity.ts', 'src/modules/iam/credentials.ts', 'src/modules/iam/consumers.ts', 'src/app/api/auth/credential-setup/route.ts', 'src/app/api/settings/users/[id]/identity/route.ts']) {
      expect(read(f), f).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
});


// ---------------------------------------------------------------------------------------------------
// Part 2: PostgreSQL
// ---------------------------------------------------------------------------------------------------

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('BL-PAY-005 identity controls on PostgreSQL (every transition twice with one key, ARCH-014)', { timeout: 600_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const iam = await import('@/modules/iam');
  const { employeeFixture, identityFixture, linkFixture, moneyFixture, holdTenantRoot, releaseTenantRoot } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  let n = 0;
  const emailOf = (k: string) => `id-${k}-${tag}@example.test`;
  const userIdKey = new Map<string, string>();
  const mkt = async (k: string, role: string, extra: Record<string, unknown> = {}) => {
    const u = await prisma.user.create({ data: { email: emailOf(k), passwordHash: 'x', role: role as never } });
    // A known creator (an unattested admin) unless the case says otherwise: an account with an unknown creator
    // is first-attested by the acting root only (final re-check; tested on its own below).
    const creatorDefault = k === 'root' || k === 'creator' || k === 'legacy-nocreator' ? {} : { createdBy: { connect: { id: creatorIdRef.id } } };
    const data = { ...creatorDefault, ...extra };
    if (Object.keys(data).length) await identityFixture(u.id, data);
    // The holder confirms his own login email (review round 2: needed before a first attestation).
    await run((tx) => iam.confirmOwnEmail(tx, { actor: actor(u.id, role), operationKey: key() }));
    userIdKey.set(u.id, k);
    return u.id;
  };
  const actor = (id: string, role = 'SUPER_ADMIN', employeeId: string | null = null) => ({ id, role, employeeId });
  const key = () => `it:${randomUUID()}`;
  type Tx = import('@/modules/platform').TxClient;
  const run = <T,>(fn: (tx: Tx) => Promise<T>) => iam.runIdentityTransaction(prisma, fn);
  const twice = async <T,>(fn: (k: string) => Promise<T>) => {
    const k = key();
    const a = await fn(k);
    const b = await fn(k);
    return [a, b] as const;
  };
  const employee = async () => {
    n += 1;
    return employeeFixture({
      employeeId: `ID-${tag}-${n}`, firstNameArabic: 'م', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `ID${tag}${n}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'), basicSalary: 5000,
    });
  };
  const status = (id: string) =>
    prisma.user.findUniqueOrThrow({
      where: { id },
      select: { identityStatus: true, identityAttestedById: true, attestedEmail: true, identityDroppedReason: true, sessionVersion: true, passwordHash: true, rootSuspendedAt: true, isActive: true, role: true, email: true, createdById: true, noEmployeeAttestedById: true },
    });
  const attest = (attester: string, attesterRole: string, userId: string, k = key(), linkHours = 24) =>
    run((tx) =>
      iam.attestIdentity(tx, {
        actor: actor(attester, attesterRole),
        userId,
        attestedEmail: emailOf(userIdKey.get(userId) ?? ''),
        emailConfirmed: true,
        historyReviewed: true,
        verificationNote: 'مقابلة حضورية مع الهوية الوطنية',
        linkHours,
        operationKey: k,
      }),
    );
  /** The holder completes a first attestation (the emailed link + the code the attester handed over). */
  const completeFirst = (tokenId: string, passwordHash = '$2b$12$heldbyholder') =>
    run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(tokenId), code: iam.credentialCodeFor(tokenId), passwordHash }));
  const attested = async (attester: string, attesterRole: string, userId: string) => {
    const r = await attest(attester, attesterRole, userId);
    if (r.tokenId) expect(await completeFirst(r.tokenId)).toMatchObject({ ok: true });
    return r;
  };

  const creatorIdRef = { id: '' };
  const rootId = await mkt('root', 'SUPER_ADMIN');
  const creatorId = await mkt('creator', 'SUPER_ADMIN');
  creatorIdRef.id = creatorId;
  let A = '';
  let B = '';

  it("an admin outside the root's chain attests nobody (fail closed, DEC-PO-016)", async () => {
    const target = await mkt('nochain', 'HR_MANAGER');
    await expect(attest(creatorId, 'SUPER_ADMIN', target)).rejects.toMatchObject({ status: 403, details: { code: 'ATTEST_REFUSED' } });
  });

  it('createUser: createdById is the session user, UNATTESTED; a double call (same operation key) replays: one account, one audit', async () => {
    const email = emailOf('new');
    const [a, b] = await twice((k) => run((tx) => iam.createUser(tx, { actor: actor(creatorId), email, passwordHash: '$2b$12$x', role: 'FINANCE_MANAGER', operationKey: k })));
    expect(b.userId).toBe(a.userId);
    expect(b.replayed).toBe(true);
    expect(await status(a.userId)).toMatchObject({ createdById: creatorId, identityStatus: 'UNATTESTED' });
    expect(await prisma.auditRecord.count({ where: { entityId: a.userId, action: 'iam.user.create' } })).toBe(1);
    await expect(run((tx) => iam.createUser(tx, { actor: actor(creatorId), email: email.toUpperCase(), passwordHash: 'x', role: 'EMPLOYEE', operationKey: key() }))).rejects.toMatchObject({ status: 409 });
  });

  it('(the root) Radeef marks TENANT_ROOT (a vendor-panel fixture, BL-PAY-017)', async () => {
    await holdTenantRoot(rootId);
  });

  it('attestIdentity: a first attestation is two channels (link + in-person code); the account counts only after both; a double call replays one link (RT-PAY-1102 / 1201)', async () => {
    A = await mkt('a', 'FINANCE_MANAGER', { createdBy: { connect: { id: creatorId } } });
    const [r1, r2] = await twice((k) => attest(rootId, 'SUPER_ADMIN', A, k));
    expect(r1.status).toBe('PENDING_SETUP');
    expect(r2).toMatchObject({ status: 'PENDING_SETUP', tokenId: r1.tokenId, replayed: true });
    expect(await prisma.credentialToken.count({ where: { userId: A } })).toBe(1);
    expect((await status(A)).identityStatus).toBe('UNATTESTED');
    // Nothing secret is stored: neither the token nor the code is in the row or the operation log.
    const code = iam.credentialCodeFor(r1.tokenId!);
    const row = await prisma.credentialToken.findUniqueOrThrow({ where: { id: r1.tokenId! } });
    expect(JSON.stringify(row)).not.toContain(code.replace('-', ''));
    expect(JSON.stringify(row)).not.toContain(credentialTokenFor(r1.tokenId!).split('.')[1]);
    const logs = await prisma.operationLog.findMany({ where: { operation: 'iam.identity.attest', actorId: rootId } });
    for (const l of logs) expect(JSON.stringify(l.result)).not.toContain(code);
    // The consumer queues a placeholder; the render gives the link only while the link is usable.
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { type: iam.CREDENTIAL_LINK_ISSUED_EVENT, aggregateId: A } });
    await prisma.$transaction((tx) => iam.credentialLinkMailConsumer.handle(event as never, { tx, attempt: 1, operationKey: `c:${event.id}` }) as Promise<unknown>);
    const mail = await prisma.notificationOutbox.findFirstOrThrow({ where: { idempotencyKey: `iam.credentialLinkMail:${r1.tokenId}` } });
    expect(mail.recipient).toBe(emailOf('a'));
    expect(mail.body).not.toContain('#t=');
    expect(mail.body).not.toContain(code);
    const prevUrl = process.env.APP_URL;
    process.env.APP_URL = 'https://hr.example.test';
    try {
      expect(await iam.credentialOutboxRender(prisma, mail)).toContain('/login/set-password#t=');
    } finally {
      process.env.APP_URL = prevUrl;
    }
  });

  it("completeCredentialSetup: a wrong code counts an attempt, a tampered link is invalid; link + code make the account ATTESTED with the holder's password; a second use (double call) is refused", async () => {
    const t = await prisma.credentialToken.findFirstOrThrow({ where: { userId: A, usedAt: null, revokedAt: null } });
    const right = iam.credentialCodeFor(t.id);
    const wrong = right === '1234-5678' ? '8765-4321' : '1234-5678';
    expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(t.id), code: wrong, passwordHash: '$2b$12$nope' }))).toMatchObject({ ok: false, reason: 'BAD_CODE', attemptsLeft: CODE_MAX_ATTEMPTS - 1 });
    expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(t.id).slice(0, -2) + 'AA', code: right, passwordHash: 'x' }))).toMatchObject({ ok: false, reason: 'INVALID' });
    const before = await status(A);
    expect(await completeFirst(t.id)).toMatchObject({ ok: true, attested: true, purpose: 'FIRST_ATTESTATION' });
    const after = await status(A);
    expect(after).toMatchObject({ identityStatus: 'ATTESTED', identityAttestedById: rootId, attestedEmail: emailOf('a'), passwordHash: '$2b$12$heldbyholder', noEmployeeAttestedById: rootId });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(await completeFirst(t.id)).toMatchObject({ ok: false, reason: 'USED_OR_EXPIRED' });
    expect(await iam.credentialOutboxRender(prisma, { body: `x ${credentialLinkPlaceholder(t.id)}` })).toBeNull();
  });

  it('completeCredentialSetup: CODE_MAX_ATTEMPTS wrong codes revoke the link; an expired link is refused', async () => {
    const victim = await mkt('brute', 'HR_MANAGER');
    const r = await attest(rootId, 'SUPER_ADMIN', victim);
    const right = iam.credentialCodeFor(r.tokenId!);
    const wrong = right === '1234-5678' ? '8765-4321' : '1234-5678';
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(r.tokenId!), code: wrong, passwordHash: 'x' }));
    expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(r.tokenId!), code: right, passwordHash: 'x' }))).toMatchObject({ ok: false, reason: 'USED_OR_EXPIRED' });
    expect((await prisma.credentialToken.findUniqueOrThrow({ where: { id: r.tokenId! } })).revokeReason).toBe('TOO_MANY_CODE_ATTEMPTS');
    const r2 = await attest(rootId, 'SUPER_ADMIN', victim, key(), 1);
    await moneyFixture((tx) => tx.credentialToken.update({ where: { id: r2.tokenId! }, data: { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1000) } }));
    expect(await completeFirst(r2.tokenId!)).toMatchObject({ ok: false, reason: 'USED_OR_EXPIRED' });
    // A link is bound to the credentials it was issued for: a vendor-script reset (create-admin) kills it.
    const r3 = await attest(rootId, 'SUPER_ADMIN', victim);
    await identityFixture(victim, { passwordHash: '$2b$12$vendorscriptreset' });
    expect(await completeFirst(r3.tokenId!)).toMatchObject({ ok: false, reason: 'USED_OR_EXPIRED' });
    expect((await prisma.credentialToken.findUniqueOrThrow({ where: { id: r3.tokenId! } })).revokeReason).toBe('CREDENTIALS_CHANGED');
  });

  it("attestation rules: an attested approver extends the chain; the creator never attests; an unattested admin is no link of the chain; the attester confirms the account's own address; no mutual attestation", async () => {
    B = await mkt('b', 'PAYROLL_ADMIN');
    await attested(A, 'FINANCE_MANAGER', B);
    expect(await status(B)).toMatchObject({ identityStatus: 'ATTESTED', identityAttestedById: A });
    const made = await mkt('made', 'HR_MANAGER', { createdBy: { connect: { id: A } } });
    await expect(attest(A, 'FINANCE_MANAGER', made)).rejects.toMatchObject({ status: 403, details: { problems: ['CREATOR'] } });
    const lone = await mkt('lone', 'SUPER_ADMIN');
    await expect(attest(lone, 'SUPER_ADMIN', made)).rejects.toMatchObject({ status: 403 });
    await expect(
      run((tx) => iam.attestIdentity(tx, { actor: actor(rootId), userId: lone, attestedEmail: `someone-else-${tag}@example.test`, emailConfirmed: true, historyReviewed: true, verificationNote: 'مقابلة حضورية مع الهوية', linkHours: 24, operationKey: key() })),
    ).rejects.toMatchObject({ status: 400 });
    // No mutual attestation: B (attested by A) never attests A back (A is in B's chain).
    await identityFixture(A, { identityStatus: 'UNATTESTED', identityDroppedReason: 'EMAIL_CHANGE', identityDroppedAt: new Date() });
    await expect(attest(B, 'PAYROLL_ADMIN', A)).rejects.toMatchObject({ status: 403 });
    await identityFixture(A, { identityStatus: 'ATTESTED', identityDroppedReason: null, identityDroppedAt: null });
  });

  it('proposeLink / confirmLink: two steps; no self-link; ENFORCED refuses the proposer-creator and an unattested confirmer; an attested second person confirms (double call replays)', async () => {
    const e = await employee();
    const holder = await mkt('holder', 'EMPLOYEE', { createdBy: { connect: { id: creatorId } } });
    await expect(run((tx) => iam.proposeLink(tx, { actor: actor(holder, 'EMPLOYEE'), userId: holder, employeeId: e.id, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    const [p1, p2] = await twice((k) => run((tx) => iam.proposeLink(tx, { actor: actor(creatorId), userId: holder, employeeId: e.id, operationKey: k })));
    expect(p2).toMatchObject({ replayed: true, link: { id: p1.link.id, status: 'PROPOSED' } });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).userId).toBeNull(); // no access before the second step
    const unattested = await mkt('unatt', 'SUPER_ADMIN');
    for (const who of [creatorId, unattested]) {
      await expect(run((tx) => iam.confirmLink(tx, { actor: actor(who), linkId: p1.link.id, operationKey: key(), mode: 'ENFORCED' }))).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED' } });
    }
    await expect(run((tx) => iam.confirmLink(tx, { actor: actor(holder, 'EMPLOYEE'), linkId: p1.link.id, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    const [c1, c2] = await twice((k) => run((tx) => iam.confirmLink(tx, { actor: actor(B, 'PAYROLL_ADMIN'), linkId: p1.link.id, operationKey: k, mode: 'ENFORCED' })));
    expect(c1).toMatchObject({ selfAct: false, link: { status: 'CONFIRMED' } });
    expect(c2.replayed).toBe(true);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).userId).toBe(holder);
    expect(await prisma.auditRecord.count({ where: { entityId: p1.link.id, action: 'iam.identity.linkConfirm' } })).toBe(1);
  });

  it('confirmLink in SINGLE_OPERATOR: the sole admin confirms his own proposal as a recorded self-act (BR-PAY-020); two concurrent confirmations: exactly one', async () => {
    const e = await employee();
    const holder = await mkt('solo', 'EMPLOYEE');
    const p = await run((tx) => iam.proposeLink(tx, { actor: actor(creatorId), userId: holder, employeeId: e.id, operationKey: key() }));
    const k1 = key();
    const k2 = key();
    const results = await Promise.allSettled([
      run((tx) => iam.confirmLink(tx, { actor: actor(creatorId), linkId: p.link.id, operationKey: k1, mode: 'SINGLE_OPERATOR' })),
      run((tx) => iam.confirmLink(tx, { actor: actor(creatorId), linkId: p.link.id, operationKey: k2, mode: 'SINGLE_OPERATOR' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.userEmployeeLink.findUniqueOrThrow({ where: { id: p.link.id } })).toMatchObject({ status: 'CONFIRMED', selfActSingleOperator: true, confirmedById: creatorId });
    expect(await prisma.auditRecord.count({ where: { operationKey: { in: [k1, k2] }, action: 'SELF_ACT_SINGLE_OPERATOR' } })).toBe(1);
  });

  it('rejectLink / endLink: a proposal refused; an unlink ends the access link; double calls replay', async () => {
    const holder = await mkt('rej', 'EMPLOYEE');
    const ePropose = await employee();
    const p = await run((tx) => iam.proposeLink(tx, { actor: actor(creatorId), userId: holder, employeeId: ePropose.id, operationKey: key() }));
    const [r1, r2] = await twice((k) => run((tx) => iam.rejectLink(tx, { actor: actor(rootId), linkId: p.link.id, operationKey: k })));
    expect(r1.link.status).toBe('REJECTED');
    expect(r2.replayed).toBe(true);
    await linkFixture(holder, (await employee()).id);
    const [u1, u2] = await twice((k) => run((tx) => iam.endLink(tx, { actor: actor(creatorId), userId: holder, reason: 'خطأ في الربط', operationKey: k })));
    expect(u1.link?.status).toBe('ENDED');
    expect(u2.replayed).toBe(true);
    expect(await prisma.employee.count({ where: { userId: holder } })).toBe(0);
  });

  it('a legacy link (9zk LEGACY_LINKED) is confirmed by the attestation itself', async () => {
    const legacyUser = await mkt('legacy', 'HR_MANAGER');
    await linkFixture(legacyUser, (await employee()).id);
    await attested(rootId, 'SUPER_ADMIN', legacyUser);
    expect(await prisma.userEmployeeLink.findFirstOrThrow({ where: { userId: legacyUser } })).toMatchObject({ status: 'CONFIRMED', confirmedById: rootId });
    expect((await status(legacyUser)).noEmployeeAttestedById).toBeNull(); // he has an employee file
  });

  it('requestCredentialReset / decideChangeRequest: an attested approver is reset only with a second person; old password stops, sessions end, UNATTESTED; only the root re-attests (DEC-PO-024 / 027; double calls replay)', async () => {
    const before = await status(B);
    const [q1, q2] = await twice((k) => run((tx) => iam.requestCredentialReset(tx, { actor: actor(A, 'FINANCE_MANAGER'), userId: B, reason: 'نسي كلمة المرور', linkHours: 24, operationKey: k })));
    expect(q1).toMatchObject({ executed: false, request: { status: 'PENDING', twoPerson: true } });
    expect(q2.replayed).toBe(true);
    expect((await status(B)).passwordHash).toBe(before.passwordHash);
    await expect(run((tx) => iam.decideChangeRequest(tx, { actor: actor(A, 'FINANCE_MANAGER'), requestId: q1.request.id, decision: 'APPROVE', linkHours: 24, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    await expect(run((tx) => iam.decideChangeRequest(tx, { actor: actor(creatorId), requestId: q1.request.id, decision: 'APPROVE', linkHours: 24, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    const [d1, d2] = await twice((k) => run((tx) => iam.decideChangeRequest(tx, { actor: actor(B, 'PAYROLL_ADMIN'), requestId: q1.request.id, decision: 'APPROVE', linkHours: 24, operationKey: k })));
    expect(d1).toMatchObject({ executed: true, request: { status: 'EXECUTED' } });
    expect(d2.replayed).toBe(true);
    const after = await status(B);
    expect(after).toMatchObject({ identityStatus: 'UNATTESTED', identityDroppedReason: 'CREDENTIAL_RESET' });
    expect(iam.isResetMarker(after.passwordHash)).toBe(true);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    const reset = await prisma.credentialToken.findFirstOrThrow({ where: { userId: B, purpose: 'RESET' } });
    expect(reset.sentTo).toBe(before.attestedEmail);
    expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(reset.id), passwordHash: '$2b$12$newbyholder' }))).toMatchObject({ ok: true, attested: false });
    await expect(attest(A, 'FINANCE_MANAGER', B)).rejects.toMatchObject({ status: 403, details: { problems: expect.arrayContaining(['ROOT_ONLY']) } });
    expect((await attest(rootId, 'SUPER_ADMIN', B)).status).toBe('ATTESTED'); // the attested email is unchanged: no new two-channel setup
    expect((await status(B)).identityStatus).toBe('ATTESTED');
  });

  it('requestCredentialReset: an unattested account is reset at once by one admin, and whoever asked never attests it (RESET_PARTY)', async () => {
    const plain = await mkt('plain', 'EMPLOYEE');
    const r = await run((tx) => iam.requestCredentialReset(tx, { actor: actor(rootId), userId: plain, linkHours: 24, operationKey: key() }));
    expect(r).toMatchObject({ executed: true, request: { twoPerson: false, status: 'EXECUTED' } });
    expect(await prisma.credentialToken.count({ where: { userId: plain, purpose: 'RESET', usedAt: null, revokedAt: null } })).toBe(1);
    await expect(attest(rootId, 'SUPER_ADMIN', plain)).rejects.toMatchObject({ status: 403, details: { problems: ['RESET_PARTY'] } });
  });

  it('changeUserByAdmin: promoteApprover drops the attestation (only the root re-attests); an attested email is never changed in-app; a protected account is deactivated only by a second person (DEC-PO-021); double calls replay', async () => {
    const clerk = await mkt('clerk', 'EMPLOYEE');
    await attested(rootId, 'SUPER_ADMIN', clerk);
    const [c1, c2] = await twice((k) => run((tx) => iam.changeUserByAdmin(tx, { actor: actor(creatorId), userId: clerk, role: 'FINANCE_MANAGER', operationKey: k })));
    expect(c1.request).toBeNull();
    expect(c2.replayed).toBe(true);
    expect(await status(clerk)).toMatchObject({ role: 'FINANCE_MANAGER', identityStatus: 'UNATTESTED', identityDroppedReason: 'PROMOTION' });
    await expect(attest(B, 'PAYROLL_ADMIN', clerk)).rejects.toMatchObject({ status: 403, details: { problems: ['ROOT_ONLY'] } });
    await expect(run((tx) => iam.changeUserByAdmin(tx, { actor: actor(creatorId), userId: A, email: `evil-${tag}@example.test`, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    const d = await run((tx) => iam.changeUserByAdmin(tx, { actor: actor(creatorId), userId: A, isActive: false, operationKey: key() }));
    expect(d.request).toMatchObject({ kind: 'DEACTIVATE', status: 'PENDING' });
    expect((await status(A)).isActive).toBe(true);
    await expect(run((tx) => iam.decideChangeRequest(tx, { actor: actor(creatorId), requestId: d.request!.id, decision: 'APPROVE', linkHours: 24, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    await run((tx) => iam.decideChangeRequest(tx, { actor: actor(B, 'PAYROLL_ADMIN'), requestId: d.request!.id, decision: 'APPROVE', linkHours: 24, operationKey: key() }));
    expect((await status(A)).isActive).toBe(false);
  });

  it('decideChangeRequest: REJECT by an eligible approver, CANCEL by the requester only (double calls replay)', async () => {
    const r = await run((tx) => iam.requestCredentialReset(tx, { actor: actor(creatorId), userId: B, linkHours: 24, operationKey: key() }));
    const [x1, x2] = await twice((k) => run((tx) => iam.decideChangeRequest(tx, { actor: actor(B, 'PAYROLL_ADMIN'), requestId: r.request.id, decision: 'REJECT', linkHours: 24, operationKey: k })));
    expect(x1.request.status).toBe('REJECTED');
    expect(x2.replayed).toBe(true);
    const r2 = await run((tx) => iam.requestCredentialReset(tx, { actor: actor(creatorId), userId: B, linkHours: 24, operationKey: key() }));
    await expect(run((tx) => iam.decideChangeRequest(tx, { actor: actor(rootId), requestId: r2.request.id, decision: 'CANCEL', linkHours: 24, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    expect((await run((tx) => iam.decideChangeRequest(tx, { actor: actor(creatorId), requestId: r2.request.id, decision: 'CANCEL', linkHours: 24, operationKey: key() }))).request.status).toBe('CANCELLED');
    expect((await status(B)).identityStatus).toBe('ATTESTED');
  });

  it('the self-change operations: changeOwnPassword keeps the attestation; changeOwnEmail is refused for an attested account and revokes a pending link otherwise; rehashLegacyPassword is a CAS (double calls replay)', async () => {
    const [p1, p2] = await twice((k) => run((tx) => iam.changeOwnPassword(tx, { actor: actor(B, 'PAYROLL_ADMIN'), passwordHash: '$2b$12$selfchosen', operationKey: k })));
    expect([p1.replayed, p2.replayed]).toEqual([false, true]);
    expect(await status(B)).toMatchObject({ identityStatus: 'ATTESTED', passwordHash: '$2b$12$selfchosen' });
    await expect(run((tx) => iam.changeOwnEmail(tx, { actor: actor(B, 'PAYROLL_ADMIN'), newEmail: `b2-${tag}@example.test`, operationKey: key() }))).rejects.toMatchObject({ status: 403 });
    const fresh = await mkt('fresh', 'HR_MANAGER');
    const started = await attest(rootId, 'SUPER_ADMIN', fresh);
    const [e1, e2] = await twice((k) => run((tx) => iam.changeOwnEmail(tx, { actor: actor(fresh, 'HR_MANAGER'), newEmail: `fresh2-${tag}@example.test`, operationKey: k })));
    expect([e1.replayed, e2.replayed]).toEqual([false, true]);
    expect((await prisma.credentialToken.findUniqueOrThrow({ where: { id: started.tokenId! } })).revokeReason).toBe('EMAIL_CHANGED');
    const legacy = await mkt('plaintext', 'EMPLOYEE', { passwordHash: 'plain-legacy-1' });
    const [h1, h2] = await twice((k) => run((tx) => iam.rehashLegacyPassword(tx, { userId: legacy, expectedHash: 'plain-legacy-1', passwordHash: '$2b$12$rehashed', operationKey: k })));
    expect(h1.rehashed).toBe(true);
    expect(h2.replayed).toBe(true);
    expect((await run((tx) => iam.rehashLegacyPassword(tx, { userId: legacy, expectedHash: 'plain-legacy-1', passwordHash: '$2b$12$other', operationKey: key() }))).rehashed).toBe(false);
  });

  it('the database refuses what the code refuses: no self-link, one open link per account / file, one root, a vendor account never attested', async () => {
    const u = await mkt('db', 'EMPLOYEE');
    const e = await employee();
    await expect(moneyFixture((tx) => tx.userEmployeeLink.create({ data: { userId: u, employeeId: e.id, status: 'PROPOSED', proposedById: u } }))).rejects.toThrow();
    await linkFixture(u, e.id);
    const e2 = await employee();
    await expect(moneyFixture((tx) => tx.userEmployeeLink.create({ data: { userId: u, employeeId: e2.id, status: 'LEGACY_LINKED', legacy: true } }))).rejects.toThrow();
    await expect(identityFixture(u, { tenantRoot: true })).rejects.toThrow(); // the root is held by this file
    await expect(identityFixture(u, { isVendorStaff: true, identityStatus: 'ATTESTED', identityAttestedById: rootId, identityAttestedAt: new Date(), attestedEmail: 'x@y.z' })).rejects.toThrow();
  });

  it('DEC-PO-142: the attester side is himself, what he created (transitively) and his chain up; an account touched by someone the root attested is first-attested by the root once the holder confirmOwnEmail (double call replays); one touched by an account the root created is refused', async () => {
    // S is attested by B (B was re-attested by the root after his reset: chain S -> B -> root). S changes T's email.
    const S = await mkt('setter', 'SUPER_ADMIN');
    await attested(B, 'PAYROLL_ADMIN', S);
    const T = await mkt('tgt', 'HR_MANAGER');
    await run((tx) => iam.changeUserByAdmin(tx, { actor: actor(S), userId: T, email: emailOf('tgt2'), operationKey: key() }));
    userIdKey.set(T, 'tgt2');
    expect(await status(T)).toMatchObject({ email: emailOf('tgt2') });
    await expect(attest(S, 'SUPER_ADMIN', T)).rejects.toMatchObject({ status: 403, details: { problems: expect.arrayContaining(['TOUCHED_BY_ATTESTER', 'EMAIL_SET_BY_ATTESTER']) } });
    // S's side holds his chain upward (B, the root); B's side does not hold S (attested, not created).
    const sideS = await iam.attesterSide(prisma, { id: S });
    expect([B, rootId].every((id) => sideS.has(id))).toBe(true);
    expect((await iam.attesterSide(prisma, { id: B })).has(S)).toBe(false);
    // An address set by an admin: no first link before the holder re-confirms it from his own session.
    await expect(attest(rootId, 'SUPER_ADMIN', T)).rejects.toMatchObject({ status: 403, details: { problems: ['EMAIL_NOT_SELF_CONFIRMED'] } });
    const [c1, c2] = await twice((k) => run((tx) => iam.confirmOwnEmail(tx, { actor: actor(T, 'HR_MANAGER'), operationKey: k })));
    expect([c1.replayed, c2.replayed]).toEqual([false, true]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: T } })).emailSetById).toBe(T);
    // The toucher S was ATTESTED by the root's chain, not created by it: the root may first-attest T.
    const ok = await attest(rootId, 'SUPER_ADMIN', T);
    expect(ok.status).toBe('PENDING_SETUP');
    expect((await prisma.credentialToken.findUniqueOrThrow({ where: { id: ok.tokenId! } })).sentTo).toBe(emailOf('tgt2'));
    // A toucher CREATED by the root (its side): the root may not attest what he touched.
    const C = await mkt('rootmade', 'COMPANY_ADMIN', { createdBy: { connect: { id: rootId } } });
    const T2 = await mkt('tgt-b', 'HR_MANAGER');
    await run((tx) => iam.changeUserByAdmin(tx, { actor: actor(C, 'COMPANY_ADMIN'), userId: T2, role: 'FINANCE_MANAGER', operationKey: key() }));
    await expect(attest(rootId, 'SUPER_ADMIN', T2)).rejects.toMatchObject({ status: 403, details: { problems: ['TOUCHED_BY_ATTESTER'] } });
    expect(await iam.touchedByAttester(prisma, rootId, T2)).toBe(true);
  });

  it('review MEDIUM: an admin email change, and a reset soon after it, notify the PREVIOUS address (outbox after commit, no secret)', async () => {
    const holder = await mkt('notice', 'EMPLOYEE');
    const before = emailOf('notice');
    await run((tx) => iam.changeUserByAdmin(tx, { actor: actor(creatorId), userId: holder, email: emailOf('notice-new'), operationKey: key() }));
    const consume = async (type: string) => {
      const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type, aggregateId: holder }, orderBy: { occurredAt: 'desc' } });
      await prisma.$transaction((tx) => iam.accountNoticeMailConsumer.handle(ev as never, { tx, attempt: 1, operationKey: `c:${ev.id}` }) as Promise<unknown>);
      return prisma.notificationOutbox.findFirstOrThrow({ where: { idempotencyKey: `iam.accountNoticeMail:${ev.idempotencyKey}` } });
    };
    const changed = await consume(iam.EMAIL_CHANGED_BY_ADMIN_EVENT);
    expect(changed.recipient).toBe(before);
    expect(changed.body).not.toContain(emailOf('notice-new'));
    expect(changed.body).not.toMatch(/#t=|radeef-credential-link|\d{4}-\d{4}/);
    const r = await run((tx) => iam.requestCredentialReset(tx, { actor: actor(rootId), userId: holder, linkHours: 24, operationKey: key() }));
    expect(r.executed).toBe(true);
    const reset = await consume(iam.RESET_NOTICE_PREVIOUS_EMAIL_EVENT);
    expect(reset.recipient).toBe(before);
    expect(reset.body).not.toMatch(/#t=|radeef-credential-link/);
    expect(await prisma.auditRecord.count({ where: { entityId: holder, action: 'iam.identity.resetCredentials.previousEmailNotified' } })).toBe(1);
    // The reset link itself goes to the current address only.
    expect((await prisma.credentialToken.findFirstOrThrow({ where: { userId: holder, purpose: 'RESET' } })).sentTo).toBe(emailOf('notice-new'));
  });

  it('a root credential reset suspends the root (RT-PAY-1004): no more attestations, and no in-app re-attestation of the root', async () => {
    try {
      const r = await run((tx) => iam.requestCredentialReset(tx, { actor: actor(creatorId), userId: rootId, linkHours: 24, operationKey: key() }));
      expect(r.executed).toBe(false); // the root counts: two people
      await run((tx) => iam.decideChangeRequest(tx, { actor: actor(rootId), requestId: r.request.id, decision: 'APPROVE', linkHours: 24, operationKey: key() }));
      expect((await status(rootId)).rootSuspendedAt).not.toBeNull();
      await expect(attest(rootId, 'SUPER_ADMIN', await mkt('afterroot', 'HR_MANAGER'))).rejects.toMatchObject({ status: 403 });
      await expect(attest(B, 'PAYROLL_ADMIN', rootId)).rejects.toMatchObject({ status: 403 });
    } finally {
      await releaseTenantRoot(rootId);
    }
  });
});
