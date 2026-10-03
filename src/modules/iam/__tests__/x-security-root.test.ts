// BL-PAY-017 / BL-PAY-022 acceptance: "no tenant user can write these fields; tested through the gateway"
// (TENANT_ROOT and TenantNamedPerson from the vendor panel; DEC-PO-016 / 018 / 022; RT-PAY-602 / 603 / 702 / 1301).
//
// Part 1 (always): money.gateway refuses User.tenantRoot and TenantNamedPerson outside the iam VENDOR operations,
// and no in-app operation may write them (new guard: before 9zl every iam operation listed tenantRoot and the
// account create listed User '*'); only the vendor CLI reaches the vendor transitions; they refuse to run inside
// Next.js; the ROOT_ATTEST_OWN rule; the vendor CLI bundle builds and answers under plain node.
// Part 2 (PAY_IT=1, a THROWAWAY migrated database): every vendor transition twice with one key (ARCH-014), the root
// lifecycle (mark, suspend, restore, re-root), the named list (register, link, invite, owner contact, revoke) and
// ROOT_ATTEST_OWN end to end (the code from Radeef, never the root), and the run-time refusal of the same writes
// inside a tenant operation.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { MoneyGatewayViolationError, assertWriteAllowed, contextAllows, moneyOperations, type MoneyContext } from '@/modules/platform';
import { ROOT_ATTEST_OWN_WAIVES, credentialCodeFor, credentialLinkMail, namedLinkIntact, type NamedPersonLink } from '@/modules/iam';
import { assertVendorProcess, normalizeNationalId } from '@/modules/iam/vendor';
import { parseVendorRequest } from '@/modules/iam/vendor-cli';
import { buildJobsBundle, ALLOWED_PACKAGES, VENDOR_ENTRY } from '../../../../scripts/build-jobs.mjs';

const ROOT = join(__dirname, '..', '..', '..', '..');
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const isTest = (p: string) => /\.test\.ts$/.test(p) || p.includes('/__tests__/') || p.startsWith('src/test/');
const SRC = walk(join(ROOT, 'src')).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') })).filter((f) => !isTest(f.path));

const VENDOR_FILES = ['src/modules/iam/vendor.ts', 'src/modules/iam/transitions/vendor.ts', 'src/modules/iam/vendor-cli.ts'];

function ctxOf(name: string): MoneyContext {
  const op = moneyOperations().find((o) => o.name === name);
  if (!op) throw new Error(`operation ${name} not registered`);
  return { operation: op.name, operationKey: 'k', allow: new Map(Object.entries(op.writes)), actorUserId: null };
}

describe('BL-PAY-017 money.gateway: TENANT_ROOT and the named list are the vendor operations\' only', () => {
  it('outside any operation: tenantRoot and TenantNamedPerson writes are refused (create, update, upsert, nested, raw)', () => {
    const refused = (model: string | undefined, op: string, args: unknown) => expect(() => assertWriteAllowed(model, op, args)).toThrow(MoneyGatewayViolationError);
    refused('User', 'update', { where: { id: 'u' }, data: { tenantRoot: true } });
    refused('User', 'create', { data: { email: 'a@b.c', passwordHash: 'x', tenantRoot: true } });
    refused('User', 'update', { where: { id: 'u' }, data: { rootSuspendedAt: null } });
    for (const op of ['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) refused('TenantNamedPerson', op, { where: {}, data: {}, create: {}, update: {} });
    refused('User', 'update', { where: { id: 'u' }, data: { namedPersons: { create: { kind: 'NAMED_PERSON', email: 'x@y.z', requestRef: 'r', addedBy: 'a' } } } });
    refused(undefined, '$executeRawUnsafe', ['INSERT INTO "TenantNamedPerson" ("id") VALUES (1)']);
    refused(undefined, '$executeRawUnsafe', ['UPDATE "TenantNamedPerson" SET "userId" = NULL']);
  });

  it('no in-app operation lists tenantRoot or TenantNamedPerson; rootSuspendedAt only where a reset suspends a root (before 9zl: every iam operation could write tenantRoot)', async () => {
    // Register every module's operations.
    for (const f of SRC.filter((x) => /^src\/modules\/[a-z]+\/operations\.ts$/.test(x.path))) await import(/* @vite-ignore */ join(ROOT, f.path));
    const ops = moneyOperations().filter((o) => o.name !== 'test.fixture.write');
    expect(ops.length).toBeGreaterThan(20);
    const vendor = ops.filter((o) => o.name.startsWith('iam.vendor.'));
    expect(vendor.map((o) => o.name).sort()).toEqual(['iam.vendor.invite', 'iam.vendor.namedPerson', 'iam.vendor.releaseCode', 'iam.vendor.setRoot', 'iam.vendor.suspendRoot']);
    for (const o of vendor) expect(o.source, o.name).toBe('SYSTEM');
    for (const o of ops.filter((x) => !x.name.startsWith('iam.vendor.'))) {
      expect(Object.keys(o.writes), o.name).not.toContain('TenantNamedPerson');
      const user = o.writes.User;
      expect(user, o.name).not.toBe('*');
      if (Array.isArray(user)) {
        expect(user, o.name).not.toContain('tenantRoot');
        if (!['iam.identity.resetCredentials', 'iam.identity.changeDecide'].includes(o.name)) expect(user, o.name).not.toContain('rootSuspendedAt');
      }
      // The gateway's own check, operation by operation.
      expect(contextAllows(ctxOf(o.name), 'User', ['tenantRoot']), o.name).toBe(false);
      expect(contextAllows(ctxOf(o.name), 'TenantNamedPerson', ['email']), o.name).toBe(false);
    }
    expect(contextAllows(ctxOf('iam.vendor.setRoot'), 'User', ['tenantRoot', 'rootSuspendedAt'])).toBe(true);
    expect(contextAllows(ctxOf('iam.vendor.setRoot'), 'User', ['identityStatus'])).toBe(false);
    expect(contextAllows(ctxOf('iam.vendor.releaseCode'), 'CredentialToken', ['codeReleasedAt'])).toBe(true);
    expect(contextAllows(ctxOf('iam.vendor.releaseCode'), 'CredentialToken', ['usedAt'])).toBe(false);
    // A new account never starts as root / vendor staff / attested (iam.user.create lists its columns).
    expect(contextAllows(ctxOf('iam.user.create'), 'User', ['email', 'createdById'])).toBe(true);
    for (const c of ['tenantRoot', 'isVendorStaff', 'identityStatus', 'identityAttestedById']) expect(contextAllows(ctxOf('iam.user.create'), 'User', [c]), c).toBe(false);
  });

  it('only the vendor CLI reaches the vendor transitions; only they write tenantRoot = true or the named list; they never log', () => {
    // Static and dynamic imports of the vendor transitions / helpers / CLI (by alias or relative path).
    const IMPORT = /(?:from\s+|import\(\s*)['"](?:@\/modules\/iam\/|\.\.?\/(?:\.\.\/)*)(?:transitions\/vendor|vendor|vendor-cli)['"]/;
    const importers = SRC.filter((f) => IMPORT.test(f.text)).map((f) => f.path).sort();
    expect(importers).toEqual(['src/modules/iam/transitions/vendor.ts', 'src/modules/iam/vendor-cli.ts']);
    // The module's public interface does not export them.
    const index = SRC.find((f) => f.path === 'src/modules/iam/index.ts')!.text;
    expect(index).not.toMatch(/['"]\.\/(transitions\/vendor|vendor|vendor-cli|tokens)['"]/);
    const vendorOps = SRC.filter((f) => /\bVENDOR_(SET_ROOT|SUSPEND_ROOT|NAMED_PERSON|INVITE|RELEASE_CODE)\b/.test(f.text)).map((f) => f.path).sort();
    expect(vendorOps).toEqual(['src/modules/iam/operations.ts', 'src/modules/iam/transitions/vendor.ts']);
    // A write of the mark (`data: { … tenantRoot: … }`; a select such as IDENTITY_SELECT is a read).
    expect(SRC.filter((f) => /data:\s*\{[^}]*tenantRoot\s*:/.test(f.text)).map((f) => f.path)).toEqual(['src/modules/iam/transitions/vendor.ts']);
    expect(SRC.filter((f) => /tenantNamedPerson\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(f.text)).map((f) => f.path)).toEqual(['src/modules/iam/transitions/vendor.ts']);
    for (const f of VENDOR_FILES) expect(SRC.find((x) => x.path === f)?.text, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it('the vendor transitions refuse to run inside the Next.js server', () => {
    expect(() => assertVendorProcess({ NEXT_RUNTIME: 'nodejs' })).toThrow(/لا تُنفَّذ من داخل التطبيق/);
    expect(() => assertVendorProcess({})).not.toThrow();
  });
});

describe('BL-PAY-022 the ROOT_ATTEST_OWN rule (DEC-PO-018; RT-PAY-702 / 1301)', () => {
  const named = (over: Partial<NamedPersonLink> = {}): NamedPersonLink => ({
    id: 'n',
    kind: 'NAMED_PERSON',
    email: 'p@x.test',
    userId: 'u',
    linkedAt: new Date('2026-10-01T10:00:00Z'),
    revokedAt: null,
    requestRef: 'REQ',
    ...over,
  });
  const target = (over: Record<string, unknown> = {}) => ({ id: 'u', email: 'P@x.test', emailSetAt: new Date('2026-09-01T00:00:00Z'), ...over }) as never;

  it('the link holds while open, on this account, the email is the named one and nobody wrote the email since Radeef linked it', () => {
    expect(namedLinkIntact(named(), target())).toBe(true);
    expect(namedLinkIntact(named(), target({ emailSetAt: null }))).toBe(true);
    expect(namedLinkIntact(null, target())).toBe(false);
    expect(namedLinkIntact(named({ revokedAt: new Date() }), target())).toBe(false);
    expect(namedLinkIntact(named({ userId: 'other' }), target())).toBe(false);
    expect(namedLinkIntact(named({ kind: 'OWNER_CONTACT' }), target())).toBe(false);
    expect(namedLinkIntact(named({ linkedAt: null }), target())).toBe(false);
    expect(namedLinkIntact(named(), target({ email: 'q@x.test' }))).toBe(false);
    // An email write after the link breaks it, even back to the same address (pay-to-be "يفك ربطه بالقائمة").
    expect(namedLinkIntact(named(), target({ emailSetAt: new Date('2026-10-02T00:00:00Z') }))).toBe(false);
  });

  it('it lifts only the one-person-two-channels rules; self, vendor, chain, an attested target, a reset party, the root as target still refuse', () => {
    expect([...ROOT_ATTEST_OWN_WAIVES].sort()).toEqual(['CREATOR', 'EMAIL_NOT_SELF_CONFIRMED', 'EMAIL_SET_BY_ATTESTER', 'TOUCHED_BY_ATTESTER', 'UNKNOWN_CREATOR_ROOT_ONLY']);
    for (const p of ['SELF', 'VENDOR', 'NOT_ATTESTED', 'NOT_APPROVER', 'CHAIN', 'ROOT_ONLY', 'RESET_PARTY', 'TARGET_ROOT', 'TARGET_VENDOR', 'TARGET_INACTIVE', 'ALREADY_ATTESTED']) {
      expect(ROOT_ATTEST_OWN_WAIVES).not.toContain(p);
    }
  });

  it('the emails: Radeef (not an admin) hands the code of ROOT_ATTEST_OWN; the invite; never a code or link in the stored body', () => {
    const id = randomUUID();
    const v = credentialLinkMail('FIRST_ATTESTATION', id, new Date('2030-01-01T00:00:00Z'), 'VENDOR');
    expect(v.body).toMatch(/فريق رديف/);
    expect(v.body).not.toMatch(/المسؤول بنفسه/);
    const a = credentialLinkMail('FIRST_ATTESTATION', id, new Date('2030-01-01T00:00:00Z'));
    expect(a.body).toMatch(/المسؤول بنفسه/);
    const i = credentialLinkMail('INVITE', id, new Date('2030-01-01T00:00:00Z'));
    expect(i.subject).toMatch(/دعوة/);
    for (const m of [v, a, i]) {
      expect(m.body).not.toMatch(/#t=/);
      expect(m.body).not.toContain(credentialCodeFor(id));
    }
  });

  it('national ids are normalized (Arabic digits, spaces) and validated; the CLI request is validated before any database work', () => {
    expect(normalizeNationalId(' ١٠١٢٣٤٥٦٧٨ ')).toBe('1012345678');
    expect(() => normalizeNationalId('12')).toThrow();
    expect(() => parseVendorRequest('not json')).toThrow(/invalid JSON/);
    expect(() => parseVendorRequest(JSON.stringify({ command: 'drop' }))).toThrow(/unknown command/);
    expect(() => parseVendorRequest(JSON.stringify({ command: 'set-root', requestId: 'XYZ' }))).toThrow(/requestId/);
    expect(parseVendorRequest(JSON.stringify({ command: 'status' })).command).toBe('status');
  });
});

describe('vendor CLI bundle (scripts/build-jobs.mjs, src/modules/iam/vendor-cli.ts)', { timeout: 60_000 }, () => {
  it('builds with the runtime image packages only and answers under plain node (bad request: exit 2, one JSON line, nothing else)', async () => {
    const { bundle, modules, externals } = buildJobsBundle({ entry: VENDOR_ENTRY });
    expect(modules).toContain('src/modules/iam/transitions/vendor.ts');
    for (const p of externals) expect(ALLOWED_PACKAGES).toContain(p);
    const dir = join(process.cwd(), 'node_modules', '.cache', 'radeef-vendor-bundle-test');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `vendor-${process.pid}.cjs`);
    writeFileSync(file, bundle);
    try {
      const loaded = createRequire(file)(file) as { main: (stdin: string, env: Record<string, string>, out: { write: (l: string) => void }) => Promise<number> };
      const lines: string[] = [];
      expect(await loaded.main('{"command":"nope"}', {}, { write: (l) => lines.push(l) })).toBe(2);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ ok: false, status: 400 });
    } finally {
      rmSync(file, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Part 2: PostgreSQL
// ---------------------------------------------------------------------------------------------------

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('BL-PAY-017 / BL-PAY-022 on PostgreSQL (every vendor transition twice with one key, ARCH-014)', { timeout: 600_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const iam = await import('@/modules/iam');
  const vendor = { ...(await import('@/modules/iam/vendor')), ...(await import('@/modules/iam/transitions/vendor')) };
  const platform = await import('@/modules/platform');
  const { credentialTokenFor } = await import('@/modules/iam/credentials');
  const { identityFixture, releaseTenantRoot, moneyFixture } = await import('@/test/money-fixtures');
  const ops = await import('@/modules/iam/operations');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const emailOf = (k: string) => `vr-${k}-${tag}@example.test`;
  const key = () => `it:${randomUUID()}`;
  const hex = () => randomUUID().replace(/-/g, '');
  type Tx = import('@/modules/platform').TxClient;
  const run = <T,>(fn: (tx: Tx) => Promise<T>) => iam.runIdentityTransaction(prisma, fn);
  const ctx = (k = key(), requestRef = `REQ-${tag}`) => ({ operator: 'operator1', requestRef, operationKey: k });
  const twice = async <T,>(fn: (k: string) => Promise<T>) => {
    const k = `vendor:test:${hex()}`;
    const a = await fn(k);
    const b = await fn(k);
    return [a, b] as const;
  };
  const actor = (id: string, role = 'SUPER_ADMIN') => ({ id, role, employeeId: null });
  const mk = async (k: string, role: string, data: Record<string, unknown> = {}) => {
    const u = await prisma.user.create({ data: { email: emailOf(k), passwordHash: '$2b$12$fixture', role: role as never } });
    if (Object.keys(data).length) await identityFixture(u.id, data);
    return u.id;
  };
  const attestBody = (attester: string, userId: string, k = key()) =>
    run((tx) =>
      iam.attestIdentity(tx, {
        actor: actor(attester),
        userId,
        attestedEmail: emailOf(keyOf.get(userId) ?? ''),
        emailConfirmed: true,
        historyReviewed: true,
        verificationNote: 'طلب المالك الرسمي ومقابلة بالفيديو',
        linkHours: 24,
        operationKey: k,
      }),
    );
  const keyOf = new Map<string, string>();
  const asJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));

  /** Radeef marks `email` as root, waiting while another test file holds the database's one root (fixture protocol). */
  async function vendorMarksRoot(email: string): Promise<string> {
    const until = Date.now() + 240_000;
    for (;;) {
      try {
        const r = await run((tx) => vendor.setRoot(tx, { ctx: ctx(), email }));
        expect(['MARKED', 'UNCHANGED']).toContain(r.action);
        return r.userId;
      } catch (err) {
        if ((err as { status?: number }).status !== 409 || Date.now() > until) throw err;
        await new Promise((res) => setTimeout(res, 250));
      }
    }
  }

  const rootId = await mk('root', 'SUPER_ADMIN');
  keyOf.set(rootId, 'root');
  const root2Id = await mk('root2', 'SUPER_ADMIN');

  it('the tenant side cannot write them: inside a tenant operation (iam.user.change) tenantRoot and TenantNamedPerson are refused at run time', async () => {
    await expect(
      prisma.$transaction((tx) =>
        platform.runMoneyOperation(tx, ops.USER_CHANGE, { actor: actor(rootId), input: { userId: rootId }, operationKey: key() }, (w) => w.user.update({ where: { id: rootId }, data: { tenantRoot: true } })),
      ),
    ).rejects.toBeInstanceOf(MoneyGatewayViolationError);
    await expect(
      prisma.$transaction((tx) =>
        platform.runMoneyOperation(tx, ops.ATTEST, { actor: actor(rootId), input: { userId: rootId }, operationKey: key() }, (w) =>
          w.tenantNamedPerson.create({ data: { kind: 'NAMED_PERSON', email: emailOf('x'), nationalIdHash: 'a'.repeat(64), requestRef: 'r', addedBy: 'a' } }),
        ),
      ),
    ).rejects.toBeInstanceOf(MoneyGatewayViolationError);
    await expect(prisma.tenantNamedPerson.create({ data: { kind: 'OWNER_CONTACT', mobile: '0500000000', requestRef: 'r', addedBy: 'a' } })).rejects.toBeInstanceOf(MoneyGatewayViolationError);
    await expect(prisma.user.update({ where: { id: rootId }, data: { tenantRoot: true } })).rejects.toBeInstanceOf(MoneyGatewayViolationError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: rootId } })).tenantRoot).toBe(false);
  });

  it('setRoot refuses an account that cannot be the root (not an approver role, vendor staff, inactive, a pending reset, unknown)', async () => {
    const emp = await mk('emp', 'EMPLOYEE');
    const ven = await mk('ven', 'SUPER_ADMIN', { isVendorStaff: true, identityStatus: 'VENDOR_BOOTSTRAP' });
    const off = await mk('off', 'SUPER_ADMIN', { isActive: false });
    const reset = await mk('reset', 'SUPER_ADMIN', { passwordHash: '!reset:x' });
    for (const [id, k] of [[emp, 'emp'], [ven, 'ven'], [off, 'off'], [reset, 'reset']] as const) {
      await expect(run((tx) => vendor.setRoot(tx, { ctx: ctx(), email: emailOf(k) })), id).rejects.toMatchObject({ status: 409 });
    }
    await expect(run((tx) => vendor.setRoot(tx, { ctx: ctx(), email: emailOf('nobody') }))).rejects.toMatchObject({ status: 404 });
    await expect(run((tx) => vendor.setRoot(tx, { ctx: { operator: 'op', requestRef: '', operationKey: key() }, email: emailOf('root') }))).rejects.toMatchObject({ status: 400 });
  });

  it('setRoot / suspendRoot, the root lifecycle from the vendor panel: mark (double call replays, one audit), suspend, restore, re-root only when the request says so', async () => {
    try {
      await vendorMarksRoot(emailOf('root'));
      const marked = await prisma.auditRecord.findMany({ where: { entityId: rootId, action: 'iam.vendor.setRoot' } });
      expect(marked).toHaveLength(1);
      expect(marked[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'vendor:operator1' });
      expect(marked[0].reason).toContain(`REQ-${tag}`);
      // Same key twice: one change, the second replays.
      const [s1, s2] = await twice((k) => run((tx) => vendor.suspendRoot(tx, { ctx: ctx(k), reason: 'المالك أبلغ عن فقدان الجوال' })));
      expect([s1.action, s2.replayed]).toEqual(['SUSPENDED', true]);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: rootId } })).rootSuspendedAt).not.toBeNull();
      expect(await prisma.auditRecord.count({ where: { entityId: rootId, action: 'iam.vendor.suspendRoot' } })).toBe(1);
      // A suspended root attests nobody (DEC-PO-016 "يجمّد الإقرارات الجديدة").
      const t = await mk('frozen', 'HR_MANAGER', { createdBy: { connect: { id: root2Id } } });
      keyOf.set(t, 'frozen');
      await expect(attestBody(rootId, t)).rejects.toMatchObject({ status: 403 });
      // Another suspension changes nothing; a restore is a new formal request (RESTORED, double call replays).
      expect((await run((tx) => vendor.suspendRoot(tx, { ctx: ctx(), reason: 'مرة ثانية' }))).action).toBe('UNCHANGED');
      const [r1, r2] = await twice((k) => run((tx) => vendor.setRoot(tx, { ctx: ctx(k), email: emailOf('root') })));
      expect([r1.action, r2.replayed]).toEqual(['RESTORED', true]);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: rootId } })).rootSuspendedAt).toBeNull();
      expect((await run((tx) => vendor.setRoot(tx, { ctx: ctx(), email: emailOf('root') }))).action).toBe('UNCHANGED');
      // Re-root: refused without the explicit replacement; with it, the mark moves (one root, both audited).
      await expect(run((tx) => vendor.setRoot(tx, { ctx: ctx(), email: emailOf('root2') }))).rejects.toMatchObject({ status: 409 });
      const k = `vendor:test:${hex()}`;
      const moved = await run((tx) => vendor.setRoot(tx, { ctx: ctx(k), email: emailOf('root2'), replaceCurrent: true }));
      expect(moved).toMatchObject({ action: 'REPLACED', userId: root2Id, previousRootId: rootId });
      // The same key with another request is refused (fingerprint), never run.
      await expect(run((tx) => vendor.setRoot(tx, { ctx: ctx(k), email: emailOf('root'), replaceCurrent: true }))).rejects.toThrow(/already used/);
      expect(await prisma.user.count({ where: { tenantRoot: true, id: { in: [rootId, root2Id] } } })).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: root2Id } })).tenantRoot).toBe(true);
      expect(await prisma.auditRecord.count({ where: { entityId: rootId, action: 'iam.vendor.setRoot.previous' } })).toBe(1);
      // Back to the first root for the rest of the file.
      await run((tx) => vendor.setRoot(tx, { ctx: ctx(), email: emailOf('root'), replaceCurrent: true }));
    } finally {
      for (const id of [rootId, root2Id]) await releaseTenantRoot(id);
    }
  });

  it('registerNamedPerson / linkNamedPerson / setOwnerContact / revokeNamedPerson, the named list: register (double call replays; the national id only as a keyed hash), duplicate 409, link to the same email, owner contact replaced, revoke', async () => {
    const [a, b] = await twice((k) => run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(k), email: emailOf('n1').toUpperCase(), nationalId: '1012345678', name: 'شخص مسمّى' })));
    expect(b).toMatchObject({ namedPersonId: a.namedPersonId, replayed: true });
    const row = await prisma.tenantNamedPerson.findUniqueOrThrow({ where: { id: a.namedPersonId } });
    expect(row).toMatchObject({ kind: 'NAMED_PERSON', email: emailOf('n1'), addedBy: 'operator1', requestRef: `REQ-${tag}`, userId: null });
    expect(row.nationalIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.nationalIdHash).toBe(vendor.nationalIdHashOf('1012345678'));
    const trail = asJson(await prisma.auditRecord.findMany({ where: { entityId: a.namedPersonId } }));
    const log = JSON.stringify(await prisma.operationLog.findMany({ where: { operationKey: { contains: 'vendor:test' } } }));
    for (const text of [trail, log, JSON.stringify(row)]) expect(text).not.toContain('1012345678');
    await expect(run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('n1'), nationalId: '1012345678' }))).rejects.toMatchObject({ status: 409 });
    // Link: an account with that email must exist; the root is never linked.
    await expect(run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(), email: emailOf('n1') }))).rejects.toMatchObject({ status: 404 });
    const n1 = await mk('n1', 'FINANCE_MANAGER');
    const [l1, l2] = await twice((k) => run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(k), email: emailOf('n1') })));
    expect([l1.userId, l1.relinked, l2.replayed]).toEqual([n1, false, true]);
    // The database: one open entry per email and per account.
    await expect(moneyFixture((tx) => tx.tenantNamedPerson.create({ data: { kind: 'NAMED_PERSON', email: emailOf('n1'), nationalIdHash: 'b'.repeat(64), requestRef: 'r', addedBy: 'a' } }))).rejects.toThrow();
    // Owner contact (DEC-PO-022): set, unchanged, replaced; one open row.
    const [o1, o2] = await twice((k) => run((tx) => vendor.setOwnerContact(tx, { ctx: ctx(k), email: emailOf('owner'), mobile: '+966500000000' })));
    expect([o1.action, o2.replayed]).toEqual(['SET', true]);
    expect((await run((tx) => vendor.setOwnerContact(tx, { ctx: ctx(), email: emailOf('owner'), mobile: '+966500000000' }))).action).toBe('UNCHANGED');
    expect((await run((tx) => vendor.setOwnerContact(tx, { ctx: ctx(), mobile: '0511111111' }))).action).toBe('SET');
    expect(await prisma.tenantNamedPerson.count({ where: { kind: 'OWNER_CONTACT', revokedAt: null } })).toBe(1);
    // Revoke (double call replays).
    const [v1, v2] = await twice((k) => run((tx) => vendor.revokeNamedPerson(tx, { ctx: ctx(k), email: emailOf('n1') })));
    expect([v1.namedPersonId, v2.replayed]).toEqual([a.namedPersonId, true]);
    expect((await prisma.tenantNamedPerson.findUniqueOrThrow({ where: { id: a.namedPersonId } })).revokedAt).not.toBeNull();
    const st = await vendor.vendorStatus(prisma);
    expect(JSON.stringify(st)).not.toMatch(/nationalId|[0-9a-f]{64}/);
  });

  it('inviteNamedPerson: Radeef creates the account (UNATTESTED, no creator, no usable password), links it, and sends a one-time INVITE link to the named email; double call replays', async () => {
    await run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('inv'), nationalId: '2012345678' }));
    const [i1, i2] = await twice((k) => run((tx) => vendor.inviteNamedPerson(tx, { ctx: ctx(k), email: emailOf('inv'), role: 'PAYROLL_ADMIN' })));
    expect(i2).toMatchObject({ userId: i1.userId, tokenId: i1.tokenId, replayed: true });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: i1.userId } });
    expect(u).toMatchObject({ email: emailOf('inv'), role: 'PAYROLL_ADMIN', identityStatus: 'UNATTESTED', isVendorStaff: false, createdById: null, tenantRoot: false });
    expect(iam.isResetMarker(u.passwordHash)).toBe(true);
    const tok = await prisma.credentialToken.findUniqueOrThrow({ where: { id: i1.tokenId } });
    expect(tok).toMatchObject({ purpose: 'INVITE', sentTo: emailOf('inv'), codeHash: null, attesterId: null });
    expect(await prisma.user.count({ where: { email: emailOf('inv') } })).toBe(1);
    // The outbox mail (after commit): the invite text, a placeholder, no link.
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: iam.CREDENTIAL_LINK_ISSUED_EVENT, aggregateId: i1.userId } });
    await prisma.$transaction((tx) => iam.credentialLinkMailConsumer.handle(ev as never, { tx, attempt: 1, operationKey: `c:${ev.id}` }) as Promise<unknown>);
    const mail = await prisma.notificationOutbox.findFirstOrThrow({ where: { idempotencyKey: `iam.credentialLinkMail:${i1.tokenId}` } });
    expect(mail.subject).toMatch(/دعوة/);
    expect(mail.body).not.toContain(credentialTokenFor(i1.tokenId));
    // The holder chooses his password; he is still not attested.
    const done = await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(i1.tokenId), passwordHash: '$2b$12$holderchosen' }));
    expect(done).toMatchObject({ ok: true, purpose: 'INVITE', attested: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: i1.userId } })).identityStatus).toBe('UNATTESTED');
    // A second invite for the same person: 409.
    await expect(run((tx) => vendor.inviteNamedPerson(tx, { ctx: ctx(), email: emailOf('inv'), role: 'PAYROLL_ADMIN' }))).rejects.toMatchObject({ status: 409 });
  });

  it('ROOT_ATTEST_OWN: the root attests an account he CREATED once Radeef linked it to a named person; releaseCode: the code comes from Radeef only, once (double call replays); link + code make it ATTESTED', async () => {
    try {
      await vendorMarksRoot(emailOf('root'));
      // The single-admin tenant (RT-PAY-602): the root created the account; normally refused (CREATOR).
      const created = await run((tx) => iam.createUser(tx, { actor: actor(rootId), email: emailOf('own'), passwordHash: '$2b$12$rootknows', role: 'FINANCE_MANAGER', operationKey: key() }));
      const C = created.userId;
      keyOf.set(C, 'own');
      await expect(attestBody(rootId, C)).rejects.toMatchObject({ status: 403, details: { problems: expect.arrayContaining(['CREATOR']) } });
      // Radeef registers the owner's named person and links the account.
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('own'), nationalId: '1098765432' }));
      await run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(), email: emailOf('own') }));
      // No code for the root (VENDOR), a link to the named email; a double call replays one link.
      const k = key();
      const [a1, a2] = [await attestBody(rootId, C, k), await attestBody(rootId, C, k)];
      expect(a1).toMatchObject({ status: 'PENDING_SETUP', codeDelivery: 'VENDOR' });
      expect(a2).toMatchObject({ tokenId: a1.tokenId, replayed: true });
      const tok = await prisma.credentialToken.findUniqueOrThrow({ where: { id: a1.tokenId! } });
      expect(tok).toMatchObject({ codeDelivery: 'VENDOR', sentTo: emailOf('own'), attesterId: rootId, codeReleasedAt: null });
      expect(await prisma.auditRecord.count({ where: { entityId: C, action: 'iam.identity.attest.started', reason: { startsWith: 'ROOT_ATTEST_OWN' } } })).toBe(1);
      // A guessed code fails (counts an attempt).
      expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(tok.id), code: '0000-0001', passwordHash: '$2b$12$x' }))).toMatchObject({ ok: false, reason: 'BAD_CODE' });
      // Radeef releases the code ONCE (double call replays without a second release; a new request is refused).
      const [c1, c2] = await twice((kk) => run((tx) => vendor.releaseCode(tx, { ctx: ctx(kk), email: emailOf('own') })));
      expect([c1.tokenId, c2.replayed]).toEqual([tok.id, true]);
      await expect(run((tx) => vendor.releaseCode(tx, { ctx: ctx(), email: emailOf('own') }))).rejects.toMatchObject({ status: 409 });
      expect(await prisma.auditRecord.count({ where: { entityId: C, action: 'iam.vendor.releaseCode' } })).toBe(1);
      const code = iam.credentialCodeFor(tok.id);
      expect(asJson(await prisma.auditRecord.findMany({ where: { entityId: C } }))).not.toContain(code.replace('-', ''));
      // The holder completes with link + code: ATTESTED by the root, recorded as ROOT_ATTEST_OWN; counts toward ENFORCED.
      expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(tok.id), code, passwordHash: '$2b$12$holder' }))).toMatchObject({ ok: true, attested: true });
      const after = await iam.identityOf(prisma, C);
      expect(after).toMatchObject({ identityStatus: 'ATTESTED', identityAttestedById: rootId, attestedEmail: emailOf('own') });
      expect(iam.countsTowardEnforced(after!)).toBe(true);
      const rec = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: C, action: 'iam.identity.completeCredentialSetup' } });
      expect(rec.after).toMatchObject({ rootAttestOwn: true });
    } finally {
      await releaseTenantRoot(rootId);
    }
  });

  it('revokeNamedPerson after the attestation (DEC-PO-143): the ATTESTED account drops to UNATTESTED in the same transaction (double call replays, one audit row); only the root re-attests it, through the normal path', async () => {
    try {
      await vendorMarksRoot(emailOf('root'));
      // An invited named person, attested by the root under ROOT_ATTEST_OWN (Radeef's code).
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('rv'), nationalId: '1033333333' }));
      const inv = await run((tx) => vendor.inviteNamedPerson(tx, { ctx: ctx(), email: emailOf('rv'), role: 'FINANCE_MANAGER' }));
      const R = inv.userId;
      keyOf.set(R, 'rv');
      expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(inv.tokenId), passwordHash: '$2b$12$rvchosen' }))).toMatchObject({ ok: true });
      const started = await attestBody(rootId, R);
      expect(started.codeDelivery).toBe('VENDOR');
      const rel = await run((tx) => vendor.releaseCode(tx, { ctx: ctx(), email: emailOf('rv') }));
      expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(rel.tokenId), code: iam.credentialCodeFor(rel.tokenId), passwordHash: '$2b$12$rvheld' }))).toMatchObject({ ok: true, attested: true });
      expect(iam.countsTowardEnforced((await iam.identityOf(prisma, R))!)).toBe(true);

      // Radeef revokes the person on the owner's request: the attestation drops at once; a double call replays.
      const [v1, v2] = await twice((k) => run((tx) => vendor.revokeNamedPerson(tx, { ctx: ctx(k), email: emailOf('rv') })));
      expect(v1).toMatchObject({ attestationDropped: true, replayed: false });
      expect(v2).toMatchObject({ attestationDropped: true, replayed: true });
      const dropped = await iam.identityOf(prisma, R);
      expect(dropped).toMatchObject({ identityStatus: 'UNATTESTED', identityDroppedReason: 'NAMED_PERSON_REVOKED' });
      expect(iam.countsTowardEnforced(dropped!)).toBe(false);
      expect(iam.identityView(dropped!).reattestRootOnly).toBe(true);
      expect(await prisma.auditRecord.count({ where: { entityId: R, action: 'iam.vendor.namedPerson.revoke.attestationDropped' } })).toBe(1);
      expect(await prisma.domainEvent.count({ where: { type: vendor.VENDOR_EVENTS.namedPersonChanged, payload: { path: ['userId'], equals: R } } })).toBe(1);

      // Re-attestation: ROOT_ONLY (an attested admin who is not the root is refused) ...
      const X = await mk('rvx', 'SUPER_ADMIN', { identityStatus: 'ATTESTED', identityAttestedById: rootId, identityAttestedAt: new Date(), attestedEmail: emailOf('rvx') });
      await expect(attestBody(X, R)).rejects.toMatchObject({ status: 403, details: { problems: expect.arrayContaining(['ROOT_ONLY']) } });
      // ... and the root re-attests through the normal path (the attested email is unchanged: no second channel).
      const again = await attestBody(rootId, R);
      expect(again).toMatchObject({ status: 'ATTESTED', codeDelivery: null });
      const back = await iam.identityOf(prisma, R);
      expect(back).toMatchObject({ identityStatus: 'ATTESTED', identityAttestedById: rootId, identityDroppedReason: null });
      expect(iam.countsTowardEnforced(back!)).toBe(true);
      // Revoking a person whose account is not attested drops nothing.
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('rv2'), nationalId: '1044444444' }));
      expect((await run((tx) => vendor.revokeNamedPerson(tx, { ctx: ctx(), email: emailOf('rv2') }))).attestationDropped).toBe(false);
    } finally {
      await releaseTenantRoot(rootId);
    }
  });

  it('ROOT_ATTEST_OWN fails closed: an email write after the link breaks it (re-link by Radeef restores it); a revoked entry kills the pending link; another admin gets no waiver', async () => {
    try {
      await vendorMarksRoot(emailOf('root'));
      const D = (await run((tx) => iam.createUser(tx, { actor: actor(rootId), email: emailOf('brk'), passwordHash: '$2b$12$x', role: 'HR_MANAGER', operationKey: key() }))).userId;
      keyOf.set(D, 'brk');
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('brk'), nationalId: '1011111111' }));
      await run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(), email: emailOf('brk') }));
      // The root changes the email and back (RT-PAY-1301): the link is broken, even at the same address.
      await run((tx) => iam.changeUserByAdmin(tx, { actor: actor(rootId), userId: D, email: emailOf('brk-x'), operationKey: key() }));
      await run((tx) => iam.changeUserByAdmin(tx, { actor: actor(rootId), userId: D, email: emailOf('brk'), operationKey: key() }));
      await expect(attestBody(rootId, D)).rejects.toMatchObject({ status: 403, details: { problems: expect.arrayContaining(['NAMED_LINK_BROKEN']) } });
      const st = await vendor.vendorStatus(prisma);
      expect(st.namedPeople.find((n) => n.email === emailOf('brk'))).toMatchObject({ intact: false });
      // Radeef re-links on the owner's request: the link holds again.
      expect((await run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(), email: emailOf('brk') }))).relinked).toBe(true);
      const started = await attestBody(rootId, D);
      expect(started.codeDelivery).toBe('VENDOR');
      // An email write while the attestation is pending: the release is refused, and the completion too.
      await identityFixture(D, { emailSetAt: new Date(Date.now() + 1000) });
      await expect(run((tx) => vendor.releaseCode(tx, { ctx: ctx(), email: emailOf('brk') }))).rejects.toMatchObject({ status: 409 });
      const code = iam.credentialCodeFor(started.tokenId!);
      expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(started.tokenId!), code, passwordHash: '$2b$12$y' }))).toMatchObject({ ok: false, reason: 'ATTESTER_INELIGIBLE' });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: D } })).identityStatus).toBe('UNATTESTED');
      // Revocation: re-link (fresh), start again, Radeef revokes the person: the pending link dies with him.
      await identityFixture(D, { emailSetAt: new Date(Date.now() - 60_000) });
      await run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(), email: emailOf('brk') }));
      const again = await attestBody(rootId, D);
      const rv = await run((tx) => vendor.revokeNamedPerson(tx, { ctx: ctx(), email: emailOf('brk') }));
      expect(rv.linksRevoked).toBe(1);
      expect(await run((tx) => iam.completeCredentialSetup(tx, { token: credentialTokenFor(again.tokenId!), code: iam.credentialCodeFor(again.tokenId!), passwordHash: '$2b$12$z' }))).toMatchObject({ ok: false, reason: 'USED_OR_EXPIRED' });
      // No waiver for anyone but the acting root: an attested admin who created a named account is refused (CREATOR).
      const X = await mk('xadmin', 'SUPER_ADMIN', { identityStatus: 'ATTESTED', identityAttestedById: rootId, identityAttestedAt: new Date(), attestedEmail: emailOf('xadmin') });
      const E = (await run((tx) => iam.createUser(tx, { actor: actor(X), email: emailOf('xmade'), passwordHash: '$2b$12$x', role: 'HR_MANAGER', operationKey: key() }))).userId;
      keyOf.set(E, 'xmade');
      await run((tx) => vendor.registerNamedPerson(tx, { ctx: ctx(), email: emailOf('xmade'), nationalId: '1022222222' }));
      await run((tx) => vendor.linkNamedPerson(tx, { ctx: ctx(), email: emailOf('xmade') }));
      await expect(attestBody(X, E)).rejects.toMatchObject({ status: 403, details: { problems: expect.arrayContaining(['CREATOR']) } });
    } finally {
      await releaseTenantRoot(rootId);
    }
  });
});
