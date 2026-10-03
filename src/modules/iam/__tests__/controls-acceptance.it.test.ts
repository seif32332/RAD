// BL-PAY-021 acceptance (BACKLOG: "a 1-, 2- and 3-person tenant fixture each completes a payroll month"), with
// the REAL computed controls mode PER LEGAL COMPANY and Radeef's readiness mark (DEC-PO-144; no test switch): each
// tenant is a database of its own (./tenant-db.ts), because the mode counts the tenant's attested approvers.
//
//   1 person   not ready: ENFORCED (his own line is held and his self-approval refused, 403). Radeef marks the
//              company ready (vendor CLI controls-ready, setControlsReadiness twice with one request id = once):
//              SINGLE_OPERATOR; he approves his own line and pays as recorded self-acts; the owner digest lists
//              them first, per company; a discrepancy he explains alone waits for the owner, whose answer Radeef
//              records with owner-confirm (twice with one request id = once).
//   2 people   root + one attested payroll approver, ready: ENFORCED; the approver approves, the root pays; no
//              self-act. The approver leaves: the drop is recorded once for the company and the owner is alerted.
//   3 people   root + two attested employees, ready: ENFORCED; the approver's own line is held for the root, a
//              third person pays; no self-act.
//   2 companies, one approver each, both ready: each SINGLE_OPERATOR (no deadlock); each completes its month; and
//              the owner-digest job FAILS while no owner contact is registered (DEC-PO-144).
//   The security review's HIGH: an HR approver exiting the only other counted approver of the company alone is
//   refused (409 TWO_PERSON_REQUIRED, the login stays, the company stays ENFORCED); the actor or the leaver as the
//   "second person" is refused; another counted approver's approval lets the genuine departure through.
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY server whose role may CREATE DATABASE.
import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTestControlsMode } from '@/test/controls-mode';
import { enterTenantDatabase, leaveTenantDatabase, migratedTemplate, tenantFromTemplate, type TenantDatabase } from './tenant-db';

const RUN = process.env.PAY_IT === '1';
const PAY_YEAR = 2031;
const PAY_MONTH = 5;
const IBAN = 'SA0380000000608010167519';

type Actor = { id: string; role: string; employeeId: string | null };

describe.skipIf(!RUN)('BL-PAY-021 acceptance: companies of 1, 2 and 3 people each complete a payroll month in the computed per-company controls mode', { timeout: 600_000 }, () => {
  let template: TenantDatabase;
  const tenants: TenantDatabase[] = [];

  beforeAll(async () => {
    // The REAL resolver: iam's readiness mark and count of attested approvers, per company, in the tenant's own database.
    setTestControlsMode('COMPUTED');
    template = await migratedTemplate('p021acc');
  }, 300_000);

  afterAll(async () => {
    setTestControlsMode('ENFORCED');
    await leaveTenantDatabase();
    for (const t of tenants) await t.drop().catch(() => undefined);
    await template?.drop().catch(() => undefined);
  }, 120_000);

  /** A tenant of its own, the app modules loaded on it, and the fixtures of its people. */
  async function openTenant(label: string) {
    const t = await tenantFromTemplate(template, label);
    tenants.push(t);
    await enterTenantDatabase(t.url);
    const { prisma } = await import('@/lib/prisma');
    const iam = await import('@/modules/iam');
    const platform = await import('@/modules/platform');
    const payroll = await import('@/modules/payroll');
    const lifecycle = await import('@/modules/lifecycle');
    const lib = await import('@/lib/payroll');
    const fx = await import('@/test/money-fixtures');
    const { scopeFixture } = fx;
    const tag = randomBytes(4).toString('hex');
    let cn = 0;
    const company = async () => {
      cn += 1;
      return (await prisma.company.create({ data: { nameArabic: `شركة ${label} ${cn} ${tag}`, commercialRegNum: `CM${cn}${tag}`, commercialRegExp: new Date('2035-01-01') } })).id;
    };
    const main = await company();
    let n = 0;
    const employee = (companyId = main) => {
      n += 1;
      return fx.employeeFixture({
        employeeId: `CM-${tag}-${n}`, firstNameArabic: 'موظف', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `CM${tag}${n}`,
        iqamaOrIdExp: new Date('2035-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 7000, legalCompanyId: companyId, actualCompanyId: companyId, salaryPaymentMethod: 'BANK_TRANSFER', bankName: 'بنك', ibanNumber: IBAN,
      });
    };
    let attester: string | null = null;
    /**
     * A person of the tenant: the root (VENDOR_BOOTSTRAP first admin marked by Radeef), or an attested approver
     * (attested by `by`, else the root). `scope`: the companies he acts in (no row: every company).
     */
    const person = async (key: string, role: string, opts: { root?: boolean; employee: boolean; companyId?: string; scope?: string[]; by?: string }): Promise<Actor> => {
      const u = await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, name: `مستخدم ${key}`, passwordHash: 'x', role: role as never } });
      if (opts.root) await fx.identityFixture(u.id, { tenantRoot: true, identityStatus: 'VENDOR_BOOTSTRAP' });
      else if (opts.by !== '') {
        const by = opts.by ?? attester;
        if (by) await fx.identityFixture(u.id, { identityStatus: 'ATTESTED', identityAttestedById: by, identityAttestedAt: new Date(), attestedEmail: `${key}-${tag}@example.test` });
      }
      for (const c of opts.scope ?? []) await scopeFixture.create({ data: { userId: u.id, companyId: c } });
      let employeeId: string | null = null;
      if (opts.employee) {
        employeeId = (await employee(opts.companyId ?? main)).id;
        await fx.linkFixture(u.id, employeeId);
      }
      if (opts.root) attester = u.id;
      return { id: u.id, role, employeeId };
    };
    const attest = (userId: string, by: string, email: string) =>
      fx.identityFixture(userId, { identityStatus: 'ATTESTED', identityAttestedById: by, identityAttestedAt: new Date(), attestedEmail: email });
    const generate = (actor: Actor, companyId = main) => lib.generatePayrollMonth(prisma, { companyId, year: PAY_YEAR, month: PAY_MONTH, actor });
    const approve = (actor: Actor, key = `acc:approve:${randomUUID()}`, companyId = main) =>
      payroll.runPayrollTransaction(prisma, (tx) => payroll.approvePayrollMonth(tx, { actor, companyId, year: PAY_YEAR, month: PAY_MONTH, operationKey: key }));
    const pay = (actor: Actor, key = `acc:pay:${randomUUID()}`, companyId = main) =>
      payroll.runPayrollTransaction(prisma, (tx) => payroll.markPayrollMonthPaid(tx, { actor, companyId, year: PAY_YEAR, month: PAY_MONTH, operationKey: key }));
    const month = (companyId = main) => prisma.payrollMonth.findUniqueOrThrow({ where: { companyId_year_month: { companyId, year: PAY_YEAR, month: PAY_MONTH } } });
    const selfActs = (companyId?: string) => prisma.auditRecord.count({ where: { action: 'SELF_ACT_SINGLE_OPERATOR', ...(companyId ? { companyId } : {}) } });
    const mode = (companyId = main) => platform.resolveOperatorMode(prisma, companyId);
    /** The vendor CLI exactly as radeef-manage runs it (one JSON request on stdin, one JSON line back). */
    const vendor = async (request: Record<string, unknown>) => {
      const { main: cli } = await import('@/modules/iam/vendor-cli');
      const lines: string[] = [];
      const code = await cli(JSON.stringify({ operator: 'acc.operator', requestRef: 'OWNER-REQ-21', ...request }), { ...process.env, NEXT_RUNTIME: undefined }, { write: (l) => lines.push(l) });
      return { code, reply: JSON.parse(lines[lines.length - 1]) as { ok: boolean; result?: Record<string, unknown>; status?: number; error?: string } };
    };
    const ready = async (companyId = main, basis = 'ATTESTED') => {
      const r = await vendor({ command: 'controls-ready', requestId: randomBytes(16).toString('hex'), companyId, basis });
      expect(r.reply.ok, JSON.stringify(r.reply)).toBe(true);
      return r;
    };
    const ownerEmail = `owner-${tag}@example.test`;
    return { t, prisma, iam, platform, payroll, lifecycle, main, company, employee, person, attest, generate, approve, pay, month, selfActs, mode, vendor, ready, ownerEmail, tag };
  }

  /** The month after the real current one (the digest of "the previous month" then covers today's records). */
  const nextMonthStart = () => {
    const now = new Date(Date.now() + 3 * 3600_000);
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6));
  };

  it('1 person: not ready = ENFORCED (self-approval refused); setControlsReadiness marks it ready (idempotent: twice with one request id); then SINGLE_OPERATOR with recorded self-acts, the per-company digest, the owner confirmation through Radeef', async () => {
    const x = await openTenant('one');
    const solo = await x.person('solo', 'SUPER_ADMIN', { root: true, employee: true });
    await x.employee();
    await x.employee();
    expect(x.platform.operatorModeResolverOwner()).toBe('iam');
    expect(await x.mode()).toBe('ENFORCED'); // not ready: whatever the count
    expect(await x.iam.readControlsMode(x.prisma, x.main)).toBe('ENFORCED');

    // Not ready: his own line is held, and approving it alone is refused (fail closed, the rollout gate).
    await x.generate(solo);
    expect(await x.approve(solo)).toMatchObject({ count: 2, reservedEmployeeIds: [solo.employeeId], monthStatus: 'CALCULATED' });
    await expect(x.approve(solo)).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['SELF_BENEFICIARY'] } });
    expect(await x.selfActs()).toBe(0);

    // Radeef registers the owner contact and marks the company ready (one-person company, on the owner's request).
    expect((await x.vendor({ command: 'set-owner-contact', requestId: randomBytes(16).toString('hex'), email: x.ownerEmail, name: 'صاحب الشركة' })).reply.ok).toBe(true);
    const requestId = randomBytes(16).toString('hex');
    const m1 = await x.vendor({ command: 'controls-ready', requestId, companyId: x.main, basis: 'ONE_PERSON' });
    const m2 = await x.vendor({ command: 'controls-ready', requestId, companyId: x.main, basis: 'ONE_PERSON' });
    expect(m1.reply).toMatchObject({ ok: true, result: { action: 'MARKED', ready: true, basis: 'ONE_PERSON', replayed: false } });
    expect(m2.reply).toMatchObject({ ok: true, result: { replayed: true } });
    expect(await x.prisma.controlsReadiness.count({ where: { companyId: x.main } })).toBe(1);
    expect(await x.prisma.auditRecord.count({ where: { action: 'iam.vendor.controlsReadiness.mark', entityId: x.main } })).toBe(1);
    // Refused without the owner's request, with a bad basis, or for a company that does not exist.
    expect((await x.vendor({ command: 'controls-ready', requestId: randomBytes(16).toString('hex'), companyId: x.main, requestRef: '' })).reply).toMatchObject({ ok: false, status: 400 });
    expect((await x.vendor({ command: 'controls-ready', requestId: randomBytes(16).toString('hex'), companyId: x.main, basis: 'MAYBE' })).reply).toMatchObject({ ok: false, status: 400 });
    expect((await x.vendor({ command: 'controls-ready', requestId: randomBytes(16).toString('hex'), companyId: randomUUID() })).reply).toMatchObject({ ok: false, status: 404 });
    expect(await x.mode()).toBe('SINGLE_OPERATOR');
    expect(await x.iam.lastRecordedControlsMode(x.prisma, x.main)).toMatchObject({ mode: 'SINGLE_OPERATOR' });

    const approveKey = `acc:approve:${randomUUID()}`;
    expect(await x.approve(solo, approveKey)).toMatchObject({ count: 1, reservedEmployeeIds: [], monthStatus: 'APPROVED' });
    expect((await x.approve(solo, approveKey)).replayed).toBe(true); // double call: the recorded result
    const payKey = `acc:pay:${randomUUID()}`;
    expect(await x.pay(solo, payKey)).toMatchObject({ count: 3 });
    expect((await x.pay(solo, payKey)).replayed).toBe(true);
    expect((await x.month()).status).toBe('PAID');
    expect(await x.selfActs(x.main)).toBe(2);
    const approveAct = await x.prisma.auditRecord.findFirstOrThrow({ where: { operationKey: approveKey, action: 'SELF_ACT_SINGLE_OPERATOR' } });
    expect(approveAct.companyId).toBe(x.main);
    expect((approveAct.after as { reasons: string[] }).reasons).toContain('SELF_BENEFICIARY');
    const payAct = await x.prisma.auditRecord.findFirstOrThrow({ where: { operationKey: payKey, action: 'SELF_ACT_SINGLE_OPERATOR' } });
    expect((payAct.after as { reasons: string[] }).reasons).toContain('PAYER_IS_APPROVER');

    // A blocking finding the sole operator explains alone: it waits for the owner (ADR-0002 #1), visible to Radeef.
    const d = await x.prisma.discrepancy.create({
      data: {
        fingerprint: `acc-${randomUUID()}`, ruleId: 'INV-PAY-03', checkId: 'wps-line-mismatch', domain: 'payroll', companyId: x.main,
        entityType: 'BankExport', entityId: 'bx-acc', period: '2031-05', severity: 'BLOCKING', blocking: true, blocks: ['payroll.export', 'payroll.pay'],
      },
    });
    const explained = await x.platform.explainDiscrepancy(x.prisma, { discrepancyId: d.id, expectedVersion: 0, explanation: 'عدّل المالك المبلغ قبل الإرسال', reference: 'OWNER-7' }, { userId: solo.id, employeeId: solo.employeeId });
    expect(explained.result).toMatchObject({ pendingAction: 'EXPLANATION', ownerConfirmation: 'PENDING' });
    expect((await x.iam.controlsNotice(x.prisma, { role: 'SUPER_ADMIN', companyIds: 'ALL', singleCompanyIds: [x.main] })).join(' ')).toContain('بانتظار تأكيد صاحب الشركة');
    expect(await x.iam.controlsNotice(x.prisma, { role: 'EMPLOYEE', companyIds: [x.main], singleCompanyIds: [x.main] })).toEqual([]);

    // The digest job (dry run first: nothing written), then twice: queued once, to the owner contact, per company.
    const now = nextMonthStart();
    const outboxBefore = await x.prisma.notificationOutbox.count();
    expect((await x.iam.runOwnerDigest(x.prisma, { now, dryRun: true, env: {} })).digest).toBe('DRY_RUN');
    expect(await x.prisma.notificationOutbox.count()).toBe(outboxBefore);
    const names = async (_db: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, id === x.main ? 'شركة الشخص الواحد' : id]));
    const first = await x.iam.runOwnerDigest(x.prisma, { now, env: {}, companyNames: names });
    const second = await x.iam.runOwnerDigest(x.prisma, { now, env: {}, companyNames: names });
    expect(first).toMatchObject({ digest: 'QUEUED', singleOperatorCompanies: [x.main], delivery: { live: false } });
    expect(first.alert).toMatch(/DIGEST_NOT_SENT/);
    expect(second.digest).toBe('ALREADY_QUEUED');
    // approve (own line) → «المستفيد = المشغّل»; pay + the explanation made alone → «معتمد واحد».
    expect(first.counts).toMatchObject({ selfBeneficiary: 1, singleApprover: 2, pendingConfirmations: 1 });
    const rows = await x.prisma.notificationOutbox.findMany({ where: { idempotencyKey: { startsWith: 'owner-digest:' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(x.ownerEmail);
    const body = rows[0].body;
    expect(body).toContain('■ شركة الشخص الواحد');
    expect(body.indexOf('١) المستفيد = المشغّل')).toBeGreaterThan(body.indexOf('■ شركة الشخص الواحد'));
    expect(body.indexOf('١) المستفيد = المشغّل')).toBeLessThan(body.indexOf('٢) معتمد واحد'));
    expect(body).toContain('payroll.month.approve');
    expect(body).toContain('بانتظار تأكيدك (1)');
    expect(body).not.toContain(IBAN);
    expect(body).not.toMatch(/SA\d{22}/);
    expect(body).not.toMatch(/\{\{|credential/i);
    expect(await x.prisma.domainEvent.count({ where: { type: 'iam.ownerDigest.queued' } })).toBe(1);

    // Radeef sees the controls per company, the digest and the pending confirmation, and records the owner's answer.
    const controls = await x.vendor({ command: 'controls' });
    expect(controls.reply.ok).toBe(true);
    const c = controls.reply.result as { companies: { companyId: string; ready: boolean; mode: string; approvers: number }[]; pendingOwnerConfirmations: { id: string; version: number }[]; alerts: string[]; digests: unknown[] };
    expect(c.companies).toEqual([expect.objectContaining({ companyId: x.main, ready: true, mode: 'SINGLE_OPERATOR', approvers: 1 })]);
    expect(c.pendingOwnerConfirmations.map((p) => p.id)).toEqual([d.id]);
    expect(c.alerts.some((a) => a.startsWith('DELIVERY_NOT_CONFIGURED'))).toBe(true);
    expect(c.digests).toHaveLength(1);
    const fetched = await x.vendor({ command: 'digest', month: x.iam.monthLabel(x.iam.previousMonth(now)) });
    expect((fetched.reply.result as { body: string }).body).toBe(body);
    const confirmId = randomBytes(16).toString('hex');
    const confirm = { command: 'owner-confirm', requestId: confirmId, discrepancyId: d.id, decision: 'CONFIRMED', expectedVersion: c.pendingOwnerConfirmations[0].version };
    const c1 = await x.vendor(confirm);
    const c2 = await x.vendor(confirm);
    expect(c1.reply).toMatchObject({ ok: true, result: { status: 'EXPLAINED', ownerConfirmation: 'CONFIRMED', replayed: false } });
    expect(c2.reply).toMatchObject({ ok: true, result: { replayed: true } });
    expect((await x.prisma.discrepancy.findUniqueOrThrow({ where: { id: d.id } })).ownerConfirmationRef).toBe('radeef:acc.operator:OWNER-REQ-21');
    expect((await x.vendor({ ...confirm, requestId: randomBytes(16).toString('hex'), requestRef: '' })).reply).toMatchObject({ ok: false, status: 400 });

    // Taking the mark back makes the company ENFORCED again (recorded once).
    const unmark = await x.vendor({ command: 'controls-not-ready', requestId: randomBytes(16).toString('hex'), companyId: x.main });
    expect(unmark.reply).toMatchObject({ ok: true, result: { action: 'UNMARKED', ready: false } });
    expect(await x.mode()).toBe('ENFORCED');
    expect(await x.iam.lastRecordedControlsMode(x.prisma, x.main)).toMatchObject({ mode: 'ENFORCED' });
  });

  it('2 people (the root + one attested approver), ready: ENFORCED; the approver approves, the root pays; no self-act; the approver leaving drops the company once and alerts the owner', async () => {
    const x = await openTenant('two');
    const root = await x.person('root', 'SUPER_ADMIN', { root: true, employee: true });
    const approver = await x.person('payroll', 'PAYROLL_ADMIN', { employee: false });
    await x.employee();
    expect((await x.vendor({ command: 'set-owner-contact', requestId: randomBytes(16).toString('hex'), email: x.ownerEmail })).reply.ok).toBe(true);
    await x.ready();
    expect(await x.mode()).toBe('ENFORCED');

    await x.generate(root);
    expect(await x.approve(approver)).toMatchObject({ count: 2, reservedEmployeeIds: [], monthStatus: 'APPROVED' });
    await expect(x.pay(approver)).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED', reasons: ['PAYER_IS_APPROVER'] } });
    expect(await x.pay(root)).toMatchObject({ count: 2 });
    expect((await x.month()).status).toBe('PAID');
    expect(await x.selfActs()).toBe(0);

    // recordControlsMode: twice and two at once → nothing more to record.
    await Promise.all([x.iam.recordControlsMode(x.prisma, 'test'), x.iam.recordControlsMode(x.prisma, 'test')]);
    const again = await x.iam.recordControlsMode(x.prisma, 'test');
    expect(again.companies).toEqual([expect.objectContaining({ companyId: x.main, mode: 'ENFORCED', changed: false, previous: 'ENFORCED' })]);

    // The approver (no employee file) leaves: deactivated as a fixture (the two-person deactivation is BL-PAY-005's).
    const { identityFixture } = await import('@/test/money-fixtures');
    await identityFixture(approver.id, { isActive: false });
    expect(await x.mode()).toBe('SINGLE_OPERATOR');
    const [d1, d2] = await Promise.all([x.iam.recordControlsMode(x.prisma, 'test:drop'), x.iam.recordControlsMode(x.prisma, 'test:drop')]);
    expect([...d1.changed, ...d2.changed]).toEqual([x.main]);
    expect((await x.iam.recordControlsMode(x.prisma, 'test:drop')).changed).toEqual([]);
    const [drop] = await x.prisma.domainEvent.findMany({ where: { type: 'iam.controls.modeChanged', aggregateId: x.main }, orderBy: { seq: 'desc' }, take: 1 });
    expect(drop.payload).toMatchObject({ companyId: x.main, from: 'ENFORCED', to: 'SINGLE_OPERATOR', approvers: 1 });
    expect(drop.companyId).toBe(x.main);
    expect(await x.prisma.auditRecord.count({ where: { action: 'iam.controls.modeChanged', operationKey: drop.idempotencyKey } })).toBe(1);
    for (let i = 0; i < 2; i += 1) {
      await x.prisma.$transaction((tx) => x.iam.controlsOwnerAlertConsumer.handle(drop as never, { tx, attempt: 1, operationKey: 'k' }));
    }
    const alerts = await x.prisma.notificationOutbox.findMany({ where: { idempotencyKey: { startsWith: 'iam.controlsOwnerAlert:' } } });
    expect(alerts.map((a) => a.recipient)).toEqual([x.ownerEmail]);
  });

  it("3 people (root + two attested employees), ready: ENFORCED; the approver's own line is held for the root, a third person pays; no self-act", async () => {
    const x = await openTenant('three');
    const root = await x.person('root', 'SUPER_ADMIN', { root: true, employee: true });
    const hr = await x.person('hr', 'HR_MANAGER', { employee: true });
    const fin = await x.person('fin', 'FINANCE_MANAGER', { employee: true });
    await x.employee();
    await x.ready();
    expect(await x.mode()).toBe('ENFORCED');
    expect((await x.iam.countedApproversIn(x.prisma, x.main)).length).toBe(3);

    await x.generate(root);
    expect(await x.approve(hr)).toMatchObject({ count: 3, reservedEmployeeIds: [hr.employeeId], monthStatus: 'CALCULATED' });
    await expect(x.pay(fin)).rejects.toMatchObject({ status: 409 }); // the held line is not approved yet
    expect(await x.approve(root)).toMatchObject({ count: 1, monthStatus: 'APPROVED' });
    await expect(x.pay(hr)).rejects.toMatchObject({ status: 403, details: { code: 'MONEY_GUARD_BLOCKED' } });
    expect(await x.pay(fin)).toMatchObject({ count: 4 });
    expect((await x.month()).status).toBe('PAID');
    expect(await x.selfActs()).toBe(0);
    // A clean ENFORCED month far away with no identity change and no self-act is not sent; no contact needed then.
    expect((await x.iam.runOwnerDigest(x.prisma, { now: new Date(Date.UTC(2040, 0, 15)), env: {} })).digest).toBe('NOTHING_TO_REPORT');
  });

  it('two companies with one approver each, both ready: each SINGLE_OPERATOR (no deadlock), each completes its month; with no owner contact the owner-digest job fails (DEC-PO-144)', async () => {
    const x = await openTenant('pair');
    const other = await x.company();
    const a = await x.person('a', 'HR_MANAGER', { employee: true, companyId: x.main, scope: [x.main], by: '' });
    const b = await x.person('b', 'FINANCE_MANAGER', { employee: true, companyId: other, scope: [other], by: '' });
    await x.attest(a.id, b.id, `a-${x.tag}@example.test`);
    await x.attest(b.id, a.id, `b-${x.tag}@example.test`);
    await x.employee(x.main);
    await x.employee(other);
    // Not ready yet: both ENFORCED although each has one approver.
    expect([await x.mode(x.main), await x.mode(other)]).toEqual(['ENFORCED', 'ENFORCED']);
    await x.ready(x.main);
    await x.ready(other);
    expect([await x.mode(x.main), await x.mode(other)]).toEqual(['SINGLE_OPERATOR', 'SINGLE_OPERATOR']);
    for (const [who, companyId] of [[a, x.main], [b, other]] as const) {
      await x.generate(who, companyId);
      expect(await x.approve(who, undefined, companyId)).toMatchObject({ count: 2, reservedEmployeeIds: [], monthStatus: 'APPROVED' });
      expect(await x.pay(who, undefined, companyId)).toMatchObject({ count: 2 });
      expect((await x.month(companyId)).status).toBe('PAID');
      expect(await x.selfActs(companyId)).toBe(2);
    }
    // a cannot act in b's company: his scope does not reach it, so he does not count there.
    expect((await x.iam.countedApproversIn(x.prisma, other)).map((u) => u.id)).toEqual([b.id]);
    // Ready companies in SINGLE_OPERATOR and no owner contact registered by Radeef: the job fails (monitoring).
    await expect(x.iam.runOwnerDigest(x.prisma, { now: nextMonthStart(), env: {} })).rejects.toMatchObject({ name: 'OwnerContactMissingError' });
    const controls = await x.vendor({ command: 'controls' });
    expect((controls.reply.result as { alerts: string[] }).alerts.some((al) => al.startsWith('OWNER_CONTACT_MISSING (FATAL'))).toBe(true);
  });

  it("security review HIGH (DEC-PO-021): an HR approver exiting the company's only other counted approver alone is refused, and the company stays ENFORCED; the leaver's consent or another counted approver's approval lets the departure through", async () => {
    const x = await openTenant('exit');
    const elsewhere = await x.company();
    const hr = await x.person('hr', 'HR_MANAGER', { employee: true, scope: [x.main], by: '' });
    const fin = await x.person('fin', 'FINANCE_MANAGER', { employee: true, scope: [x.main], by: '' });
    const third = await x.person('third', 'FINANCE_MANAGER', { employee: false, scope: [elsewhere], by: '' });
    await x.attest(hr.id, fin.id, `hr-${x.tag}@example.test`);
    await x.attest(fin.id, hr.id, `fin-${x.tag}@example.test`);
    await x.attest(third.id, hr.id, `third-${x.tag}@example.test`);
    await x.ready();
    expect(await x.mode()).toBe('ENFORCED');

    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const exit = (approvedById: string | null) =>
      x.lifecycle.runEmploymentTransition(x.prisma, {
        employeeId: fin.employeeId!,
        command: 'EXIT',
        date: today,
        exitReason: 'RESIGNATION',
        source: { type: 'TEST', id: fin.employeeId! },
        actor: { type: 'USER', id: hr.id },
        approvedById,
        operationKey: `acc:exit:${randomUUID()}`,
        companyIds: [x.main],
        noticeReleased: true,
      });
    for (const second of [null, hr.id]) {
      await expect(exit(second)).rejects.toMatchObject({ status: 409, details: { code: 'TWO_PERSON_REQUIRED' } });
    }
    // Nothing moved: the leaver's login is active, the company is still ENFORCED, and HR still cannot pay alone.
    const login = await x.prisma.user.findUniqueOrThrow({ where: { id: fin.id }, select: { isActive: true, documentsOnlyUntil: true } });
    expect(login).toEqual({ isActive: true, documentsOnlyUntil: null });
    expect((await x.prisma.employee.findUniqueOrThrow({ where: { id: fin.employeeId! } })).isTerminated).toBe(false);
    expect(await x.prisma.employmentStateChange.count({ where: { employeeId: fin.employeeId!, sourceType: 'TEST' } })).toBe(0);
    expect(await x.mode()).toBe('ENFORCED');
    // DEC-PO-021 literally: the leaver's own consent counts (two real people: the actor and the leaver).
    const consented = await exit(fin.id);
    expect(consented).toMatchObject({ changed: true, eligibleApproverRemoved: true });
    expect(await x.mode()).toBe('SINGLE_OPERATOR');
    // Another counted approver (not the actor) approving is accepted too, in a second company of two approvers.
    const co2 = await x.company();
    const hr2 = await x.person('hr2', 'HR_MANAGER', { employee: true, companyId: co2, scope: [co2], by: '' });
    const fin2 = await x.person('fin2', 'FINANCE_MANAGER', { employee: true, companyId: co2, scope: [co2], by: '' });
    await x.attest(hr2.id, third.id, `hr2-${x.tag}@example.test`);
    await x.attest(fin2.id, third.id, `fin2-${x.tag}@example.test`);
    const exit2 = (approvedById: string | null) =>
      x.lifecycle.runEmploymentTransition(x.prisma, {
        employeeId: fin2.employeeId!, command: 'EXIT', date: today, exitReason: 'RESIGNATION', source: { type: 'TEST', id: fin2.employeeId! },
        actor: { type: 'USER', id: hr2.id }, approvedById, operationKey: `acc:exit:${randomUUID()}`, companyIds: [co2], noticeReleased: true,
      });
    await expect(exit2(null)).rejects.toMatchObject({ status: 409, details: { code: 'TWO_PERSON_REQUIRED' } });
    expect(await exit2(third.id)).toMatchObject({ changed: true, eligibleApproverRemoved: true });
  });
});
