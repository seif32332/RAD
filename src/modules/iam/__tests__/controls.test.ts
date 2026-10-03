// BL-PAY-021 without a database: the computed controlsMode (BR-PAY-020), the one resolver and its fail-closed
// default, the gateway deciding a caller's reasons in the mode IT reads, the owner digest's month arithmetic,
// the vendor CLI's new commands, and the static guarantees (no setting is read, no caller passes a mode, the
// owner's confirmation has no tenant entry point).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTestControlsMode } from '@/test/controls-mode';

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
const APP = walk(join(ROOT, 'src'))
  .map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }))
  .filter((f) => !isTest(f.path));

afterEach(() => setTestControlsMode('ENFORCED'));

/** A User row as IDENTITY_SELECT returns it. */
function user(over: Record<string, unknown> = {}) {
  return {
    id: `u-${Math.random().toString(36).slice(2)}`, email: 'x@example.test', role: 'HR_MANAGER', isActive: true, documentsOnlyUntil: null, createdById: null,
    isVendorStaff: false, identityStatus: 'ATTESTED', identityAttestedById: 'r', identityAttestedAt: new Date(), attestedEmail: 'x@example.test',
    noEmployeeAttestedById: null, identityDroppedReason: null, identityDroppedAt: null, tenantRoot: false, rootSuspendedAt: null, emailSetById: null, emailSetAt: null,
    ...over,
  };
}
const CO = 'co-a';
/**
 * A db stub: user.findMany returns `rows` (the resolver narrows in SQL, then applies countsTowardEnforced); `scopes`
 * are UserCompanyScope rows; `ready` the companies Radeef marked ready (default: CO).
 */
const dbOf = (rows: ReturnType<typeof user>[], opts: { scopes?: { userId: string; companyId: string }[]; ready?: string[] } = {}) =>
  ({
    user: { findMany: vi.fn(async () => rows) },
    userCompanyScope: { findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => (opts.scopes ?? []).filter((r) => where.userId.in.includes(r.userId))) },
    controlsReadiness: {
      findFirst: vi.fn(async ({ where }: { where: { companyId: string } }) => ((opts.ready ?? [CO]).includes(where.companyId) ? { id: 'r', companyId: where.companyId, basis: 'ATTESTED' } : null)),
      findMany: vi.fn(async ({ where }: { where: { companyId: { in: string[] } } }) => (opts.ready ?? [CO]).filter((c) => where.companyId.in.includes(c)).map((companyId) => ({ companyId, basis: 'ATTESTED' }))),
    },
  }) as never;

describe('controlsMode is computed (BR-PAY-020)', () => {
  it('ENFORCED from two counted approvers; SINGLE_OPERATOR below (0, 1, nonsense)', async () => {
    const { controlsModeFor } = await import('@/modules/iam');
    expect([0, 1, 2, 3, 10].map(controlsModeFor)).toEqual(['SINGLE_OPERATOR', 'SINGLE_OPERATOR', 'ENFORCED', 'ENFORCED', 'ENFORCED']);
    expect(controlsModeFor(Number.NaN)).toBe('SINGLE_OPERATOR');
    expect(controlsModeFor(-1)).toBe('SINGLE_OPERATOR');
  });

  it('who counts: attested approvers and the acting root (RT-PAY-710); never a vendor, an inactive, a documents-only leaver, a suspended root, a non-approver role or an unattested account', async () => {
    const { readControlsMode, controlsApprovers } = await import('@/modules/iam');
    const root = user({ identityStatus: 'VENDOR_BOOTSTRAP', tenantRoot: true });
    const attested = user();
    expect(await readControlsMode(dbOf([root, attested]), CO)).toBe('ENFORCED');
    expect(await readControlsMode(dbOf([root]), CO)).toBe('SINGLE_OPERATOR');
    const notCounted = [
      user({ isVendorStaff: true }),
      user({ isActive: false }),
      user({ documentsOnlyUntil: new Date() }),
      user({ identityStatus: 'VENDOR_BOOTSTRAP', tenantRoot: true, rootSuspendedAt: new Date() }),
      user({ role: 'EMPLOYEE' }),
      user({ identityStatus: 'UNATTESTED' }),
      user({ identityStatus: 'VENDOR_BOOTSTRAP' }),
    ];
    // Even if the narrowing query returned them, the rule drops each one: with one real approver the tenant stays single.
    expect(await controlsApprovers(dbOf([attested, ...notCounted]))).toHaveLength(1);
    expect(await readControlsMode(dbOf([attested, ...notCounted]), CO)).toBe('SINGLE_OPERATOR');
    // The query itself asks only active, non-vendor approver roles that are attested or the unsuspended root.
    const db = dbOf([]);
    await controlsApprovers(db);
    const where = (db as unknown as { user: { findMany: { mock: { calls: [{ where: Record<string, unknown> }][] } } } }).user.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ isActive: true, isVendorStaff: false, OR: [{ identityStatus: 'ATTESTED' }, { tenantRoot: true, rootSuspendedAt: null }] });
  });

  it('per company (DEC-PO-144): not ready is ENFORCED whatever the count; an approver counts where his scope reaches (owner role / no scope row: everywhere); unknown company ENFORCED', async () => {
    const { readControlsMode, controlsOfCompanies, approverExitEffect } = await import('@/modules/iam');
    const root = user({ identityStatus: 'VENDOR_BOOTSTRAP', tenantRoot: true, role: 'SUPER_ADMIN' });
    const a = user({ role: 'HR_MANAGER' });
    const b = user({ role: 'FINANCE_MANAGER' });
    // Not ready: ENFORCED even with one person.
    expect(await readControlsMode(dbOf([root], { ready: [] }), CO)).toBe('ENFORCED');
    expect(await readControlsMode(dbOf([root]), '')).toBe('ENFORCED');
    // a scoped to A, b scoped to B, no owner: both ready companies are SINGLE_OPERATOR (no deadlock).
    const scopes = [{ userId: a.id, companyId: 'A' }, { userId: b.id, companyId: 'B' }];
    const two = dbOf([a, b], { scopes, ready: ['A', 'B'] });
    expect(await readControlsMode(two, 'A')).toBe('SINGLE_OPERATOR');
    expect(await readControlsMode(two, 'B')).toBe('SINGLE_OPERATOR');
    expect((await controlsOfCompanies(two, ['A', 'B', 'C'])).map((c) => [c.companyId, c.ready, c.approvers, c.mode])).toEqual([
      ['A', true, 1, 'SINGLE_OPERATOR'],
      ['B', true, 1, 'SINGLE_OPERATOR'],
      ['C', false, 0, 'ENFORCED'],
    ]);
    // The owner-role root counts in both: each is ENFORCED.
    const withRoot = dbOf([root, a, b], { scopes, ready: ['A', 'B'] });
    expect(await readControlsMode(withRoot, 'A')).toBe('ENFORCED');
    expect(await readControlsMode(withRoot, 'B')).toBe('ENFORCED');
    // The exit read port: b leaving drops B below two (root + b), not A (root + a).
    expect(await approverExitEffect(withRoot, b.id, ['A', 'B'])).toEqual({ counts: true, companiesBelowTwo: ['B'] });
    expect(await approverExitEffect(withRoot, 'nobody', ['A', 'B'])).toEqual({ counts: false, companiesBelowTwo: [] });
    expect(await approverExitEffect(withRoot, root.id, ['A', 'B'])).toEqual({ counts: true, companiesBelowTwo: ['A', 'B'] });
  });

  it('the one resolver: iam registers it when its index loads; platform.resolveOperatorMode answers it, and only "SINGLE_OPERATOR" is single (fail closed)', async () => {
    const platform = await import('@/modules/platform');
    await import('@/modules/iam');
    expect(platform.operatorModeResolverOwner()).toBe('iam');
    setTestControlsMode('COMPUTED');
    const root = user({ identityStatus: 'VENDOR_BOOTSTRAP', tenantRoot: true });
    expect(await platform.resolveOperatorMode(dbOf([root]), CO)).toBe('SINGLE_OPERATOR');
    expect(await platform.resolveOperatorMode(dbOf([root, user()]), CO)).toBe('ENFORCED');
    // A second source of the mode is refused; iam re-registering itself is a no-op.
    expect(() => platform.registerOperatorModeResolver('rules', async () => 'SINGLE_OPERATOR')).toThrow(/already registered/);
    const actual = await vi.importActual<typeof import('@/modules/platform/controls')>('@/modules/platform/controls');
    expect(actual.operatorModeResolverOwner()).toBe('iam');
  });

  it('with no resolver registered the mode is ENFORCED (a process that never loaded iam fails closed)', async () => {
    vi.resetModules();
    const fresh = await vi.importActual<typeof import('@/modules/platform/controls')>('@/modules/platform/controls');
    // importActual after a reset is a new module instance: nothing registered in it yet.
    if (fresh.operatorModeResolverOwner() === null) {
      expect(await fresh.resolveOperatorMode({} as never, CO)).toBe('ENFORCED');
    }
    fresh.registerOperatorModeResolver('iam', async () => 'single' as never);
    expect(await fresh.resolveOperatorMode({} as never, CO)).toBe('ENFORCED'); // an unknown answer is ENFORCED
    expect(await fresh.resolveOperatorMode({} as never, null)).toBe('ENFORCED'); // no company: ENFORCED
    vi.resetModules();
  });
});

describe('money.gateway decides in the mode it reads itself (no caller passes a mode)', () => {
  it('a decision taken as SINGLE_OPERATOR is refused when the gateway reads ENFORCED; a malformed refusal is refused; decideByMode', async () => {
    const platform = await import('@/modules/platform');
    const op = platform.defineMoneyOperation({ name: 'unit.controls.approve', owner: 'unit', act: 'APPROVE', source: 'USER', writes: { Loan: '*' } });
    const fakeTx = {} as never;
    const actor = platform.moneyActorOf({ id: 'u1' });
    const stale = platform.decideByMode(['SAME_PERSON_TWICE'], 'SINGLE_OPERATOR');
    expect(stale).toEqual({ ok: true, reasons: ['SAME_PERSON_TWICE'], selfAct: true });
    setTestControlsMode('ENFORCED');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the blocked record has no database here
    const fn = vi.fn(async () => 1);
    await expect(platform.runMoneyOperation(fakeTx, op, { actor, input: {}, operationKey: 'k1', decision: stale }, fn)).rejects.toMatchObject({
      status: 403,
      details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['SAME_PERSON_TWICE'] },
    });
    await expect(platform.runMoneyOperation(fakeTx, op, { actor, input: {}, operationKey: 'k2', decision: { ok: false, reasons: [], selfAct: false } }, fn)).rejects.toThrow(/without a reason/);
    expect(fn).not.toHaveBeenCalled();
    // A clean act runs in either mode.
    expect(await platform.runMoneyOperation(fakeTx, op, { actor, input: {}, operationKey: 'k3', decision: platform.decideByMode([], 'ENFORCED') }, fn)).toBe(1);
    spy.mockRestore();
    expect(platform.decideByMode(['PAYER_IS_APPROVER'], 'ENFORCED')).toEqual({ ok: false, reasons: ['PAYER_IS_APPROVER'], selfAct: false });
    expect(platform.decideByMode(['PAYER_IS_APPROVER'], 'whatever' as never).ok).toBe(false);
  });
});

describe('the owner digest month (Asia/Riyadh)', () => {
  it('previousMonth / monthPeriod / ownerDigestKey', async () => {
    const { previousMonth, monthPeriod, ownerDigestKey, monthLabel } = await import('@/modules/iam');
    expect(previousMonth(new Date('2026-10-03T06:00:00Z'))).toEqual({ year: 2026, month: 9 });
    expect(previousMonth(new Date('2026-01-01T00:30:00Z'))).toEqual({ year: 2025, month: 12 }); // 03:30 Riyadh, 1 January
    expect(previousMonth(new Date('2026-09-30T22:00:00Z'))).toEqual({ year: 2026, month: 9 }); // already 1 October in Riyadh
    expect(monthPeriod({ year: 2026, month: 9 })).toEqual({ from: new Date('2026-08-31T21:00:00Z'), to: new Date('2026-09-30T21:00:00Z') });
    expect(monthPeriod({ year: 2026, month: 12 }).to).toEqual(new Date('2026-12-31T21:00:00Z'));
    expect(() => monthPeriod({ year: 2026, month: 13 })).toThrow();
    expect(ownerDigestKey({ year: 2026, month: 9 }, 'c1')).toBe('owner-digest:2026-09:c1');
    expect(monthLabel({ year: 2026, month: 1 })).toBe('2026-01');
  });

  it('the drop alert names no person and no amount', async () => {
    const { controlsDropMail } = await import('@/modules/iam');
    const m = controlsDropMail(1);
    expect(m.subject).toContain('المشغّل الواحد');
    expect(m.body).toContain('(العدد الآن: 1)');
    expect(m.body).not.toMatch(/@|SA\d{2}/);
  });
});

describe('the vendor CLI (BL-PAY-021 commands)', () => {
  it('controls and digest are reads (no requestId); owner-confirm is a write (a requestId, the owner request reference)', async () => {
    const { parseVendorRequest, VENDOR_COMMANDS, VENDOR_READ_COMMANDS } = await import('@/modules/iam/vendor-cli');
    expect(VENDOR_COMMANDS).toEqual(expect.arrayContaining(['controls', 'digest', 'owner-confirm', 'controls-ready', 'controls-not-ready']));
    expect(() => parseVendorRequest(JSON.stringify({ command: 'controls-ready', companyId: 'x' }))).toThrow(/requestId/);
    // The readiness mark is a vendor-only table: no in-app operation may write it (money.gateway VENDOR_ONLY_TABLES).
    const { VENDOR_ONLY_TABLES, IDENTITY_TABLES } = await import('@/modules/platform');
    expect(VENDOR_ONLY_TABLES).toContain('ControlsReadiness');
    expect(IDENTITY_TABLES).toContain('ControlsReadiness');
    expect(VENDOR_READ_COMMANDS).toEqual(['status', 'controls', 'digest']);
    expect(parseVendorRequest(JSON.stringify({ command: 'controls' })).command).toBe('controls');
    expect(parseVendorRequest(JSON.stringify({ command: 'digest', month: '2026-09' })).body.month).toBe('2026-09');
    expect(() => parseVendorRequest(JSON.stringify({ command: 'owner-confirm' }))).toThrow(/requestId/);
    const { ownerDecisionOf } = await import('@/modules/iam/vendor');
    expect(ownerDecisionOf('confirmed')).toBe('CONFIRMED');
    expect(() => ownerDecisionOf('yes')).toThrow();
  });
});

describe('static guarantees (BL-PAY-021)', () => {
  it('the placeholder setting platform.operatorMode is read nowhere; resolveOperatorMode is defined only in platform/controls.ts', () => {
    expect(APP.filter((f) => f.text.includes("'platform.operatorMode'")).map((f) => f.path)).toEqual([]);
    expect(APP.filter((f) => /export (async )?function resolveOperatorMode\b/.test(f.text)).map((f) => f.path)).toEqual(['src/modules/platform/controls.ts']);
    expect(APP.filter((f) => /registerOperatorModeResolver\(/.test(f.text) && !f.path.startsWith('src/modules/platform/')).map((f) => f.path)).toEqual(['src/modules/iam/controls.ts']);
  });

  it('no application code passes a controls mode into a transition or the gateway (the mode is always read on the server)', () => {
    const offenders = APP.filter((f) => /\bmode:\s*['"](SINGLE_OPERATOR|ENFORCED)['"]\s*[,})]/.test(f.text) || /\bmode\?:\s*(OperatorMode|'ENFORCED')/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
    const gateway = APP.find((f) => f.path === 'src/modules/platform/money/gateway.ts')!.text;
    expect(gateway).not.toMatch(/spec\.mode/);
  });

  it("the owner's confirmation has no tenant entry point: only the vendor CLI calls confirmSingleOperatorAct", () => {
    const callers = APP.filter((f) => /confirmSingleOperatorAct\(/.test(f.text) && !f.path.startsWith('src/modules/platform/')).map((f) => f.path);
    expect(callers).toEqual(['src/modules/iam/vendor-cli.ts']);
  });

  it('the banner is in the application shell, Arabic and RTL', () => {
    const shell = APP.find((f) => f.path === 'src/components/AppShell.tsx')!.text;
    expect(shell).toMatch(/<ControlsModeBanner \/>/);
    const banner = APP.find((f) => f.path === 'src/components/shell/ControlsModeBanner.tsx')!.text;
    expect(banner).toMatch(/dir="rtl"/);
    expect(banner).toMatch(/\/api\/controls-mode/);
  });
});
