// Package C guardrails (BL-WFE-003) against a real PostgreSQL with every migration applied (9zn included), real iam
// contexts (no auth mock), the real ports (src/lib/workflow-wiring.ts) and the REAL controls mode (iam's resolver:
// a readiness mark + the counted approvers of the company), in a tenant database of its own.
//
//   - the two-person activation (DEC-PO-146 / ADR-0011) and its single-operator exception, with the INV-IAM-01
//     regressions (ADR-0010): one person alone never activates an approval path where the company is ENFORCED;
//   - the §12.1 editor warnings, their confirmation, and the CONTROL_RELAXED record;
//   - the single-operator exception to G1 / G1b / G2b at resolution and at act time, recorded SELF_ACT_SINGLE_OPERATOR,
//     with the INV-IAM-01 regressions: in ENFORCED (or while a second eligible person exists) the operator never
//     approves his own request;
//   - the iam.controls.modeChanged consumer (X-WFE-012), its double run;
//   - vendor accounts never act; the owner digest shows the engine's self-acts, relaxations and automatic approvals.
//
// Opt-in: WFE_IT=1 with DATABASE_URL on a THROWAWAY server whose role may CREATE DATABASE.
import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enterTenantDatabase, leaveTenantDatabase, migratedTemplate, tenantFromTemplate, type TenantDatabase } from '@/modules/iam/__tests__/tenant-db';
import { setTestControlsMode, testControlsMode, type TestControlsMode } from '@/test/controls-mode';

// The FIRST-TYPE gate is the owner's (activation.ts); the tests replace it (AUDIT/16 §3.8). Every package C rule is real.
vi.mock('../activation', () => ({ ACTIVATION_BLOCKERS: [], activationBlockers: () => [] }));

interface Req {
  id: string;
  beneficiaries: string[];
  requester: string | null;
}

describe('workflow guardrails on PostgreSQL (BL-WFE-003, package C)', { timeout: 900_000 }, () => {
  if (process.env.WFE_IT !== '1') return; // skipped: build nothing (the suite creates a database)

  let template: TenantDatabase;
  let tenant: TenantDatabase;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: any;
  let wf: typeof import('@/modules/workflow');
  let iam: typeof import('@/modules/iam');
  let platform: typeof import('@/modules/platform');
  let fx: typeof import('@/test/money-fixtures');
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const store = new Map<string, Req>();
  const tag = randomBytes(4).toString('hex');
  const U: Record<string, string> = {};
  const E: Record<string, string> = {};
  let C = '';
  const startedAt = new Date();
  let previousMode: TestControlsMode = 'ENFORCED';

  const SETTINGS = { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null, rejectRequiresPair: false, rejectAuthority: ['HR_MANAGER'] };
  const hrStage = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'stage', id, approver: { kind: 'ROLE', role: 'HR_MANAGER' }, ...extra });
  const doc = (children: unknown[], settings: Record<string, unknown> = {}) => ({ schemaVersion: 1, settings: { ...SETTINGS, ...settings }, root: { type: 'sequence', id: 'root', children } });
  const TYPES = ['tests.g', 'tests.gtwo', 'tests.gact', 'tests.gauto', 'tests.gten', 'tests.gret', 'tests.gkey', 'tests.gpup', 'tests.gstale'];

  function adapterFor(requestType: string) {
    return {
      requestType,
      ownerModule: 'tests',
      payEffect: 'NONE' as const,
      fieldCatalog: {},
      decisionFieldCatalog: {},
      closeSources: [],
      pauseReasons: [],
      decisionStatuses: [],
      domainStatuses: [],
      legacyDecisionEntryPoints: [],
      recheckTriggers: [],
      load: async (_tx: unknown, id: string) => {
        const r = store.get(id);
        if (!r) throw new Error(`no request ${id}`);
        return r;
      },
      parties: async (_tx: unknown, r: Req) => ({ beneficiaryEmployeeIds: r.beneficiaries, requesterUserId: r.requester, contextSnapshot: { kind: requestType } }),
      validateSubmit: async () => undefined,
      validateFinal: async () => ({ ok: true as const }),
      canReject: () => true,
      canReturn: () => true,
      canCancel: () => true,
      cancelNeedsConfirm: () => false,
      onApproved: async () => undefined,
      onRejected: async () => undefined,
      onCancelled: async () => undefined,
      summary: () => ({}),
    };
  }

  // ------------------------------------------------------------------------------------------------
  // Fixtures

  beforeAll(async () => {
    // This file owns its tenant database: the REAL computed mode (src/test/controls-mode.ts COMPUTED).
    previousMode = testControlsMode();
    setTestControlsMode('COMPUTED');
    template = await migratedTemplate('wfg');
    tenant = await tenantFromTemplate(template, 'core');
    await enterTenantDatabase(tenant.url);
    prisma = (await import('@/lib/prisma')).prisma;
    wf = await import('@/modules/workflow');
    iam = await import('@/modules/iam');
    platform = await import('@/modules/platform');
    fx = await import('@/test/money-fixtures');
    (await import('@/lib/workflow-wiring')).ensureWorkflowWiring();
    for (const t of TYPES) wf.registerWorkflowAdapter(adapterFor(t) as never);

    C = (await prisma.company.create({ data: { nameArabic: `WFG ${tag}`, commercialRegNum: `WFG${tag}`, commercialRegExp: new Date('2035-01-01') } })).id;
    const user = async (key: string, role: string, scope: string[] | null) => {
      const id = (await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, name: key, passwordHash: 'x', role } })).id;
      if (scope) for (const companyId of scope) await fx.moneyFixture((tx) => tx.userCompanyScope.create({ data: { userId: id, companyId } }));
      U[key] = id;
    };
    await user('attester', 'SUPER_ADMIN', null); // attests the two owners independently (inactive: never a candidate)
    await user('author', 'SUPER_ADMIN', null); // writes the paths (attested)
    await user('second', 'SUPER_ADMIN', null); // the attested second person (counts toward ENFORCED)
    await user('solo', 'COMPANY_ADMIN', [C]); // the company's sole operator (not attested)
    await user('hr', 'HR_MANAGER', [C]); // a second eligible person, active only where a test says so
    await user('vendorHr', 'HR_MANAGER', [C]); // a Radeef account
    // DEC-PO-147: neither owner is on the other's side (the attester of an account is on its side).
    for (const k of ['author', 'second']) {
      await fx.identityFixture(U[k], { identityStatus: 'ATTESTED', identityAttestedById: U.attester, identityAttestedAt: new Date(), attestedEmail: `${k}-${tag}@example.test` });
    }
    await fx.identityFixture(U.attester, { isActive: false });
    await fx.identityFixture(U.vendorHr, { isVendorStaff: true });
    await fx.identityFixture(U.hr, { isActive: false });
    const employee = async (key: string) => {
      const t = randomBytes(4).toString('hex');
      const e = await fx.employeeFixture({
        employeeId: `WFG-${t}`, firstNameArabic: 'موظف', lastNameArabic: key, nationality: 'SA', iqamaOrIdNumber: `WFG${t}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId: C,
      });
      E[key] = e.id;
    };
    await employee('solo');
    await employee('other');
    await fx.linkFixture(U.solo, E.solo);

    // The tenant-default paths of the act tests: written by the author, activated by the attested second person.
    const author = await ctxOf('author');
    const second = await ctxOf('second');
    for (const [t, d] of [['tests.g', doc([hrStage('hr')])], ['tests.gtwo', doc([hrStage('first'), hrStage('again', { distinctFromPrior: true })])], ['tests.gret', doc([hrStage('hr')])]] as const) {
      const s = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: author, requestType: t, companyId: null, definition: d });
      await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: s.result.id });
    }
  }, 600_000);

  afterAll(async () => {
    setTestControlsMode(previousMode);
    await leaveTenantDatabase();
    await tenant?.drop().catch(() => undefined);
    await template?.drop().catch(() => undefined);
  }, 120_000);

  // ------------------------------------------------------------------------------------------------
  // Helpers

  async function ctxOf(key: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: U[key] }, select: { id: true, role: true } });
    const e = await prisma.employee.findFirst({ where: { userId: u.id }, select: { id: true } });
    return iam.scopedContext(await iam.resolveActor(prisma, { id: u.id, role: u.role, employeeId: e?.id ?? null }));
  }
  async function refused(p: Promise<unknown>): Promise<{ status: number; code: string; detail?: string }> {
    try {
      await p;
    } catch (err) {
      const e = err as { status?: number; code?: string; details?: { code?: string; detail?: string } };
      return { status: e.status ?? 0, code: e.code ?? e.details?.code ?? (err as Error).name, detail: e.details?.detail };
    }
    throw new Error('expected a refusal');
  }
  const markReady = () => fx.moneyFixture((tx) => tx.controlsReadiness.create({ data: { companyId: C, basis: 'ONE_PERSON', requestRef: `REQ-${tag}`, markedBy: 'test' } }));
  const revokeReady = () =>
    fx.moneyFixture((tx) => tx.controlsReadiness.updateMany({ where: { companyId: C, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: 'test', revokeRequestRef: `REV-${tag}` } }));
  const modeNow = () => platform.resolveOperatorMode(prisma, C);
  const setActive = (key: string, isActive: boolean) => fx.identityFixture(U[key], { isActive });
  /** An owner-group account created by `creator` (DEC-PO-147: on the creator's side), unattested. */
  async function puppetOf(key: string, creator: string) {
    const id = (await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, name: key, passwordHash: 'x', role: 'COMPANY_ADMIN' } })).id;
    await fx.identityFixture(id, { createdById: U[creator] });
    U[key] = id;
    return ctxOf(key);
  }
  /** Records the mode change (iam), then runs the engine's consumer only (its own registry). */
  async function recordAndConsume() {
    const rec = await iam.recordControlsMode(prisma, 'test');
    const registry = new platform.ConsumerRegistry();
    registry.register(wf.controlsModeRecheckConsumer);
    const run = await platform.runConsumers({ client: prisma, registry });
    return { rec, run };
  }
  async function start(type: string, over: Partial<Req> = {}) {
    const r: Req = { id: randomUUID(), beneficiaries: [E.solo], requester: U.solo, ...over };
    store.set(r.id, r);
    const res = await prisma.$transaction((tx: never) => wf.startWorkflow(tx, { ctx: iam.systemContext('workflow-test', C), requestType: type, requestId: r.id }));
    return prisma.workflowInstance.findUniqueOrThrow({ where: { id: res.instanceId } });
  }
  const openTasks = (instanceId: string) => prisma.workflowTask.findMany({ where: { instanceId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } });
  const instanceOf = (id: string) => prisma.workflowInstance.findUniqueOrThrow({ where: { id } });
  async function act(key: string, taskId: string, decision = 'APPROVE', idempotencyKey?: string) {
    const t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId }, include: { instance: true } });
    return wf.actOnWorkflowTask(prisma, { ctx: await ctxOf(key), taskId, expectedVersion: t.instance.version, decision: decision as never, note: 'ok', ...(idempotencyKey ? { idempotencyKey } : {}) });
  }
  const selfActAudits = (instanceId: string) => prisma.auditRecord.findMany({ where: { entityType: 'WorkflowInstance', entityId: instanceId, action: 'workflow.task.selfAct' }, orderBy: { seq: 'asc' } });

  // ------------------------------------------------------------------------------------------------
  // Two-person activation

  describe('two-person activation (DEC-PO-146 / ADR-0011; INV-IAM-01 regressions)', () => {
    it('INV-IAM-01: one owner writes a path and activates it alone (company ENFORCED): WFE_TWO_PERSON_REQUIRED, nothing ACTIVE, no operation recorded', async () => {
      expect(await modeNow()).toBe('ENFORCED');
      const author = await ctxOf('author');
      const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: author, requestType: 'tests.gact', companyId: C, definition: doc([hrStage('hr')]) });
      expect(await refused(wf.activateWorkflowDefinition(prisma, { ctx: author, definitionId: d.result.id }))).toMatchObject({ status: 403, code: 'WFE_TWO_PERSON_REQUIRED' });
      expect(await prisma.workflowDefinition.count({ where: { requestType: 'tests.gact', status: 'ACTIVE' } })).toBe(0);
      expect(await prisma.operationLog.count({ where: { operationKey: `wf:def:activate:${d.result.id}` } })).toBe(0);
    });

    it('the last editor is an author too; an unattested second owner is no second person in ENFORCED; a counted second person activates (idempotent on a double call)', async () => {
      const author = await ctxOf('author');
      const second = await ctxOf('second');
      const solo = await ctxOf('solo');
      // The second person edits the author's draft: now HE is its last editor and may not activate it.
      const edited = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: second, requestType: 'tests.gact', companyId: C, definition: doc([hrStage('hr2')]) });
      expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: edited.result.id } })).lastEditedById).toBe(U.second);
      expect(await refused(wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: edited.result.id }))).toMatchObject({ code: 'WFE_TWO_PERSON_REQUIRED' });
      expect(await refused(wf.activateWorkflowDefinition(prisma, { ctx: author, definitionId: edited.result.id }))).toMatchObject({ code: 'WFE_TWO_PERSON_REQUIRED' });
      // Neither author, but not attested: ENFORCED wants a counted approver.
      const r = await refused(wf.activateWorkflowDefinition(prisma, { ctx: solo, definitionId: edited.result.id }));
      expect(r).toMatchObject({ status: 403, code: 'WFE_TWO_PERSON_REQUIRED' });
      expect(r.detail).toMatch(/UNATTESTED_SECOND_PERSON/);
      // The author edits again (last editor: the author); the second person, who did not write this content, activates.
      const again = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: author, requestType: 'tests.gact', companyId: C, definition: doc([hrStage('hr3')]) });
      const a1 = await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: again.result.id });
      const a2 = await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: again.result.id });
      expect(a2.replayed).toBe(true);
      expect(a1.result).toMatchObject({ status: 'ACTIVE', selfAct: false });
      const row = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: again.result.id } });
      expect(row).toMatchObject({ createdById: U.author, lastEditedById: U.author, activatedById: U.second, activationSelfAct: false });
      const audit = await prisma.auditRecord.findFirstOrThrow({ where: { entityType: 'WorkflowDefinition', entityId: row.id, action: 'workflow.definition.activate' } });
      expect(audit.reason).toBeNull();
      expect(audit.after).toMatchObject({ createdById: U.author, lastEditedById: U.author, mode: 'ENFORCED' });
    });

    it('BL-WFE-014: a save over a different draft is a new operation (C saves X, A saves Y, C saves X again: X, last edited by C); the same call twice is idempotent', async () => {
      const author = await ctxOf('author');
      const second = await ctxOf('second');
      const X = doc([hrStage('x')]);
      const save = (ctx: unknown, d: unknown) => wf.saveWorkflowDefinitionDraft(prisma, { ctx: ctx as never, requestType: 'tests.gkey', companyId: C, definition: d });
      const first = await save(author, X);
      await save(second, doc([hrStage('y')]));
      const again = await save(author, X);
      expect(again.replayed).toBe(false);
      const row = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: first.result.id } });
      expect(row.checksum).toBe(first.result.checksum);
      expect(row.lastEditedById).toBe(U.author);
      expect(await prisma.auditRecord.count({ where: { entityId: row.id, action: 'workflow.definition.saveDraft' } })).toBe(3);
      // The same content once more: no write, no audit; repeated, a replay.
      expect((await save(author, X)).result.checksum).toBe(row.checksum);
      expect((await save(author, X)).replayed).toBe(true);
      expect(await prisma.auditRecord.count({ where: { entityId: row.id, action: 'workflow.definition.saveDraft' } })).toBe(3);
    });

    it('DEC-PO-147 / INV-IAM-01: an owner writes a path through an account he created and activates it with his own (ENFORCED): WFE_TWO_PERSON_REQUIRED (AUTHOR_ACTIVATED)', async () => {
      const puppet = await puppetOf('puppetA', 'author');
      try {
        const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: puppet, requestType: 'tests.gpup', companyId: C, definition: doc([hrStage('p')]) });
        expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: d.result.id } })).toMatchObject({ createdById: U.puppetA, lastEditedById: U.puppetA });
        const r = await refused(wf.activateWorkflowDefinition(prisma, { ctx: await ctxOf('author'), definitionId: d.result.id }));
        expect(r).toMatchObject({ status: 403, code: 'WFE_TWO_PERSON_REQUIRED' });
        expect(r.detail).toMatch(/AUTHOR_ACTIVATED/);
        expect(await prisma.workflowDefinition.count({ where: { requestType: 'tests.gpup', status: 'ACTIVE' } })).toBe(0);
        // The other direction: the puppet activates its creator's draft (tests.gkey, written by the author alone).
        const mine = await prisma.workflowDefinition.findFirstOrThrow({ where: { requestType: 'tests.gkey', companyId: C, status: 'DRAFT' } });
        expect(mine.lastEditedById).toBe(U.author);
        expect((await refused(wf.activateWorkflowDefinition(prisma, { ctx: puppet, definitionId: mine.id }))).detail).toMatch(/AUTHOR_ACTIVATED/);
        // A second person, attested on his own (not on the author's side), activates it.
        expect((await wf.activateWorkflowDefinition(prisma, { ctx: await ctxOf('second'), definitionId: mine.id })).result.status).toBe('ACTIVE');
      } finally {
        await setActive('puppetA', false);
      }
    });

    it('DEC-PO-147 / INV-IAM-01: retiring a version so that a looser one governs needs two people — one person alone only records a request (idempotent); his puppet cannot confirm; a second person retires', async () => {
      const author = await ctxOf('author');
      const second = await ctxOf('second');
      const strict = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: author, requestType: 'tests.gret', companyId: C, definition: doc([hrStage('a'), hrStage('b', { distinctFromPrior: true })]) });
      await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: strict.result.id });
      const id = strict.result.id;
      const retire = (ctx: unknown, confirmRelaxations?: boolean) => wf.retireWorkflowDefinition(prisma, { ctx: ctx as never, definitionId: id, confirmRelaxations });
      expect(await refused(retire(author))).toMatchObject({ status: 409, code: 'WFE_CONFIRMATION_REQUIRED' });
      const asked = await retire(author, true);
      expect(asked.result).toMatchObject({ status: 'ACTIVE', pendingSecondPerson: true });
      // The same person again: still one pending request (no second request, nothing retired).
      const twice = await retire(author, true);
      expect(twice.result).toMatchObject({ status: 'ACTIVE', pendingSecondPerson: true });
      const tenantGret = await prisma.workflowDefinition.findFirstOrThrow({ where: { requestType: 'tests.gret', companyId: null, status: 'ACTIVE' } });
      // What the requester reviewed is stored with the request (DEC-PO-147 re-check).
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE', retireRequestedById: U.author, retireFallbackId: tenantGret.id, retireRelaxations: ['DISTINCT_FROM_PRIOR_REMOVED', 'FEWER_HUMAN_STAGES'] });
      expect(await prisma.auditRecord.count({ where: { entityId: id, action: 'workflow.definition.retireRequest' } })).toBe(1);
      const puppet = await puppetOf('puppetR', 'author');
      try {
        expect(await refused(wf.retireWorkflowDefinition(prisma, { ctx: puppet, definitionId: id, confirmRelaxations: true }))).toMatchObject({ code: 'WFE_TWO_PERSON_REQUIRED' });
      } finally {
        await setActive('puppetR', false);
      }
      expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
      const done = await retire(second, true);
      expect(done.result).toMatchObject({ status: 'RETIRED', selfAct: false });
      expect((await retire(second, true)).replayed).toBe(true);
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).toMatchObject({ retireRequestedById: U.author, retiredById: U.second, retireSelfAct: false });
      const relaxed = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: id, action: 'CONTROL_RELAXED' } });
      expect(relaxed.after).toMatchObject({ requestedBy: U.author, confirmedBy: U.second, relaxations: expect.arrayContaining(['FEWER_HUMAN_STAGES']) });
    });

    it('DEC-PO-147 re-check: a retire request is confirmed only against the effect its requester reviewed — a new tenant default clears it; an effect that grew is refused (WFE_CONFLICT) and the request cleared; clearWorkflowRetireRequest is idempotent on a double call', async () => {
      const author = await ctxOf('author');
      const second = await ctxOf('second');
      const save = (ctx: unknown, companyId: string | null, d: unknown) => wf.saveWorkflowDefinitionDraft(prisma, { ctx: ctx as never, requestType: 'tests.gstale', companyId, definition: d });
      // The tenant default only drops the second rejecter; the company version keeps it.
      const t1 = await save(author, null, doc([hrStage('hr')]));
      await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: t1.result.id });
      const c = await save(author, C, doc([hrStage('hr')], { rejectRequiresPair: true }));
      await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: c.result.id });
      const id = c.result.id;
      const retire = (ctx: unknown) => wf.retireWorkflowDefinition(prisma, { ctx: ctx as never, definitionId: id, confirmRelaxations: true });
      expect((await retire(author)).result.pendingSecondPerson).toBe(true);
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).toMatchObject({ retireRequestedById: U.author, retireFallbackId: t1.result.id, retireRelaxations: ['REJECT_PAIR_REMOVED'] });

      // Months later a new tenant default with an automatic path is activated: the pending request is cleared (audited).
      const t2 = await save(author, null, doc([]));
      const act = await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: t2.result.id, confirmRelaxations: true });
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE', retireRequestedById: null, retireFallbackId: null, retireRelaxations: [] });
      const cleared = await prisma.auditRecord.findMany({ where: { entityId: id, action: 'workflow.definition.retireRequestClear' } });
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({ reason: 'FALLBACK_CHANGED', actorId: U.second });
      expect((await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: t2.result.id, confirmRelaxations: true })).replayed).toBe(true);
      expect(act.result.status).toBe('ACTIVE');
      // B's "confirmation" now confirms nothing: it is a fresh request of B against the new effect, and nothing is retired.
      const b = await retire(second);
      expect(b.result).toMatchObject({ status: 'ACTIVE', pendingSecondPerson: true });
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).toMatchObject({ retireRequestedById: U.second, retireFallbackId: t2.result.id, retireRelaxations: ['AUTO_APPROVE_PATH', 'REJECT_PAIR_REMOVED'] });

      // A request whose recorded effect is smaller than the current one (a stale row: e.g. written before the clearing
      // existed) is refused at confirmation and cleared: never confirmed as the requester's decision.
      await prisma.$executeRawUnsafe(`UPDATE "WorkflowDefinition" SET "retireRelaxations" = ARRAY['REJECT_PAIR_REMOVED']::text[] WHERE "id" = '${id}'`);
      const r = await refused(retire(author));
      expect(r).toMatchObject({ status: 409, code: 'WFE_CONFLICT' });
      expect(r.detail).toMatch(/effect of this retirement changed/);
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE', retireRequestedById: null });
      const stale = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: id, action: 'workflow.definition.retireRequestClear', reason: 'EFFECT_CHANGED' } });
      expect(stale.after).toMatchObject({ grew: ['AUTO_APPROVE_PATH'] });
      expect(await prisma.auditRecord.count({ where: { entityId: id, action: 'CONTROL_RELAXED' } })).toBe(0);

      // clearWorkflowRetireRequest: a fresh request, withdrawn twice — concurrent twins clear it once (one key per
      // request), and a later call finds nothing to clear (NO_CHANGE).
      expect((await retire(author)).result.pendingSecondPerson).toBe(true);
      const [w1, w2] = await Promise.all([0, 1].map(() => wf.clearWorkflowRetireRequest(prisma, { ctx: author, definitionId: id, reason: 'not now' })));
      expect([w1.replayed, w2.replayed].sort()).toEqual([false, true]);
      expect(w1.result.cleared).toBe(true);
      expect((await wf.clearWorkflowRetireRequest(prisma, { ctx: author, definitionId: id, reason: 'not now' })).result.cleared).toBe(false);
      expect(await prisma.auditRecord.count({ where: { entityId: id, action: 'workflow.definition.retireRequestClear' } })).toBe(3);
      expect((await wf.clearWorkflowRetireRequest(prisma, { ctx: second, definitionId: id })).result.cleared).toBe(false);
      expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    });

    it('§12.1: a version that loosens a control returns warnings on save, is refused without confirmation, and its activation records CONTROL_RELAXED', async () => {
      const author = await ctxOf('author');
      const second = await ctxOf('second');
      const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: author, requestType: 'tests.gauto', companyId: C, definition: doc([]) });
      expect(d.result.warnings?.map((w) => w.code)).toEqual(['AUTO_APPROVE_PATH']);
      expect(await refused(wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: d.result.id }))).toMatchObject({ status: 409, code: 'WFE_CONFIRMATION_REQUIRED' });
      expect(await prisma.operationLog.count({ where: { operationKey: `wf:def:activate:${d.result.id}` } })).toBe(0);
      const ok = await wf.activateWorkflowDefinition(prisma, { ctx: second, definitionId: d.result.id, confirmRelaxations: true });
      expect(ok.result.status).toBe('ACTIVE');
      const relaxed = await prisma.auditRecord.findMany({ where: { action: 'CONTROL_RELAXED', entityId: d.result.id } });
      expect(relaxed).toHaveLength(1);
      expect(relaxed[0]).toMatchObject({ companyId: C, actorId: U.second, after: expect.objectContaining({ relaxations: ['AUTO_APPROVE_PATH'], confirmedBy: U.second }) });
      // The save audit keeps who changed what from what to what.
      const save = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: d.result.id, action: 'workflow.definition.saveDraft' } });
      expect(save.after).toMatchObject({ lastEditedById: U.author, warnings: ['AUTO_APPROVE_PATH'] });
    });

    it('the tenant default has no company and is always ENFORCED: the author alone is refused even while a company is SINGLE_OPERATOR', async () => {
      await markReady();
      await setActive('second', false); // one counted approver left (the author): SINGLE_OPERATOR
      try {
        expect(await modeNow()).toBe('SINGLE_OPERATOR');
        const author = await ctxOf('author');
        const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: author, requestType: 'tests.gten', companyId: null, definition: doc([hrStage('hr')]) });
        expect(await refused(wf.activateWorkflowDefinition(prisma, { ctx: author, definitionId: d.result.id }))).toMatchObject({ code: 'WFE_TWO_PERSON_REQUIRED' });
      } finally {
        await setActive('second', true);
        await revokeReady();
      }
    });

    it('SINGLE_OPERATOR: the sole operator activates his own path only when no other eligible editor exists; recorded SELF_ACT (activationSelfAct, owner digest); ENFORCED again refuses', async () => {
      await markReady();
      await setActive('second', false); // the author is the one counted approver left: SINGLE_OPERATOR
      expect(await modeNow()).toBe('SINGLE_OPERATOR');
      const solo = await ctxOf('solo');
      const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: solo, requestType: 'tests.gact', companyId: C, definition: doc([hrStage('solo1')]) });
      // The author is still an active owner: another editor exists, so no exception.
      const r = await refused(wf.activateWorkflowDefinition(prisma, { ctx: solo, definitionId: d.result.id }));
      expect(r).toMatchObject({ code: 'WFE_TWO_PERSON_REQUIRED' });
      expect(r.detail).toMatch(/another eligible editor/);
      // He leaves: the company has one operator (and no counted approver left: still SINGLE_OPERATOR).
      await setActive('author', false);
      expect(await modeNow()).toBe('SINGLE_OPERATOR');
      const a = await wf.activateWorkflowDefinition(prisma, { ctx: solo, definitionId: d.result.id });
      expect(a.result).toMatchObject({ status: 'ACTIVE', selfAct: true });
      const row = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: d.result.id } });
      expect(row).toMatchObject({ createdById: U.solo, activatedById: U.solo, activationSelfAct: true });
      const audit = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: d.result.id, action: 'workflow.definition.activate' } });
      expect(audit.reason).toMatch(/^SELF_ACT_SINGLE_OPERATOR/);
      expect((audit.after as { reasons: string[] }).reasons).toEqual(['AUTHOR_ACTIVATED', 'UNATTESTED_SECOND_PERSON']);
      const records = await platform.selfActRecords(prisma, { from: startedAt, to: new Date(Date.now() + 60_000) });
      expect(records.find((x) => x.entityId === d.result.id)).toMatchObject({ operation: 'workflow.definition.activate', companyId: C, actorId: U.solo, reasons: ['AUTHOR_ACTIVATED', 'UNATTESTED_SECOND_PERSON'] });

      // DEC-PO-147 variant: the operator drafts and activates through an account he created. Still recorded as the
      // author's own act (AUTHOR_ACTIVATED, not only UNATTESTED_SECOND_PERSON), so the digest says so.
      const puppet = await puppetOf('puppetS', 'solo');
      try {
        const p = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: solo, requestType: 'tests.gact', companyId: C, definition: doc([hrStage('solo3')]) });
        const pa = await wf.activateWorkflowDefinition(prisma, { ctx: puppet, definitionId: p.result.id });
        expect(pa.result).toMatchObject({ status: 'ACTIVE', selfAct: true });
        const pAudit = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: p.result.id, action: 'workflow.definition.activate' } });
        expect((pAudit.after as { reasons: string[] }).reasons).toEqual(['AUTHOR_ACTIVATED', 'UNATTESTED_SECOND_PERSON']);
      } finally {
        await setActive('puppetS', false);
      }

      // DEC-PO-147 in SINGLE_OPERATOR with no other editor: the operator's retirement that loosens a control is done at
      // once, recorded as SELF_ACT (AUTHOR_RETIRED) and CONTROL_RELAXED.
      const strict = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: solo, requestType: 'tests.gret', companyId: C, definition: doc([hrStage('a'), hrStage('b', { distinctFromPrior: true })]) });
      await wf.activateWorkflowDefinition(prisma, { ctx: solo, definitionId: strict.result.id });
      const gone = await wf.retireWorkflowDefinition(prisma, { ctx: solo, definitionId: strict.result.id, confirmRelaxations: true });
      expect(gone.result).toMatchObject({ status: 'RETIRED', selfAct: true });
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: strict.result.id } })).toMatchObject({ retireRequestedById: U.solo, retiredById: U.solo, retireSelfAct: true });
      const retAudit = await prisma.auditRecord.findFirstOrThrow({ where: { entityId: strict.result.id, action: 'workflow.definition.retire' } });
      expect(retAudit.reason).toMatch(/^SELF_ACT_SINGLE_OPERATOR: AUTHOR_RETIRED/);
      // ENFORCED again (Radeef revokes the readiness mark): the same person alone is refused.
      await revokeReady();
      const v2 = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: solo, requestType: 'tests.gact', companyId: C, definition: doc([hrStage('solo2')]) });
      expect(await refused(wf.activateWorkflowDefinition(prisma, { ctx: solo, definitionId: v2.result.id }))).toMatchObject({ code: 'WFE_TWO_PERSON_REQUIRED' });
      expect(await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: v2.result.id } })).toMatchObject({ status: 'DRAFT' });
    });
  });

  // ------------------------------------------------------------------------------------------------
  // The single-operator exception at act time (from here on the company's only active staff login is `solo`)

  describe('the single-operator exception to G1 / G1b / G2b (§12.1, §12.5 step 2; INV-IAM-01 regressions)', () => {
    let blockedId = '';

    it('ENFORCED: the operator\'s own request is BLOCKED (nobody else) and he cannot act on it', async () => {
      expect(await modeNow()).toBe('ENFORCED');
      const i = await start('tests.g');
      blockedId = i.id;
      expect(i).toMatchObject({ status: 'BLOCKED', blockedReason: 'NO_CANDIDATE' });
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).toEqual([]);
      // A BLOCKED step cannot be decided by anyone (409); the operator is not even a candidate of it.
      expect(await refused(act('solo', t.id))).toMatchObject({ status: 409, code: 'WFE_INVALID_STATE' });
      expect((await refused(act('vendorHr', t.id))).status).toBeGreaterThanOrEqual(400);
      expect(await selfActAudits(i.id)).toHaveLength(0);
    });

    it('iam.controls.modeChanged to SINGLE_OPERATOR: the consumer rechecks the BLOCKED approval (idempotent on a double run); the operator approves alone, recorded SELF_ACT once (double call)', async () => {
      await markReady();
      const { rec, run } = await recordAndConsume();
      expect(rec.changed).toEqual([C]);
      expect(run.applied).toBe(1);
      const i = await instanceOf(blockedId);
      expect(i.status).toBe('RUNNING');
      const [t] = await openTasks(blockedId);
      expect(t.candidateUserIds).toEqual([U.solo]); // never the vendor account
      expect(t.candidatesSnapshotJson[0].waived).toEqual(['G1_BENEFICIARY', 'G1B_REQUESTER']);
      // The double run: nothing new (the consumption is DONE; a recheck replays its key).
      const again = await recordAndConsume();
      expect(again.rec.changed).toEqual([]);
      expect(again.run.applied).toBe(0);
      expect((await instanceOf(blockedId)).version).toBe(i.version);

      const first = await act('solo', t.id, 'APPROVE', `self-${tag}`);
      const second = await act('solo', t.id, 'APPROVE', `self-${tag}`);
      expect(second.replayed).toBe(true);
      expect(second.result).toEqual(first.result);
      expect(first.result.status).toBe('APPROVED');
      const audits = await selfActAudits(blockedId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: U.solo, companyId: C, reason: 'SELF_ACT_SINGLE_OPERATOR: G1_BENEFICIARY,G1B_REQUESTER' });
      expect((audits[0].after as { reasons: string[] }).reasons).toEqual(['SELF_BENEFICIARY', 'SAME_PERSON_TWICE']);
    });

    it('SINGLE_OPERATOR with a second eligible person: no exception — the operator is no candidate, and a waiver opened before the second person appeared is refused at act time', async () => {
      expect(await modeNow()).toBe('SINGLE_OPERATOR');
      // A task opened while the operator was alone (waived), then the HR login is active again.
      const stale = await start('tests.g');
      const [st] = await openTasks(stale.id);
      expect(st.candidateUserIds).toEqual([U.solo]);
      await setActive('hr', true);
      try {
        expect(await refused(act('solo', st.id))).toMatchObject({ status: 403, code: 'WFE_SELF_ACTION' });
        expect(await selfActAudits(stale.id)).toHaveLength(0);
        const fresh = await start('tests.g');
        const [t] = await openTasks(fresh.id);
        expect(t.candidateUserIds).toEqual([U.hr]);
        expect(await refused(act('solo', t.id))).toMatchObject({ status: 403 });
        expect((await act('hr', t.id)).result.status).toBe('APPROVED');
      } finally {
        await setActive('hr', false);
      }
    });

    it('the company becomes ENFORCED: act time refuses the waived candidate (mode read now), and the modeChanged recheck BLOCKs the approval', async () => {
      const i = await start('tests.g');
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).toEqual([U.solo]);
      await revokeReady();
      expect(await modeNow()).toBe('ENFORCED');
      expect(await refused(act('solo', t.id))).toMatchObject({ status: 403, code: 'WFE_SELF_ACTION' });
      const { rec } = await recordAndConsume();
      expect(rec.changed).toEqual([C]);
      expect(await instanceOf(i.id)).toMatchObject({ status: 'BLOCKED' });
      expect((await openTasks(i.id))[0].candidateUserIds).toEqual([]);
      expect(await selfActAudits(i.id)).toHaveLength(0);
    });

    it('G2b / distinctFromPrior: in ENFORCED the sole operator never approves both steps (BLOCKED); in SINGLE_OPERATOR he does, recorded ONE_PERSON_TWO_STEPS', async () => {
      const enforced = await start('tests.gtwo', { beneficiaries: [E.other], requester: null });
      const [e1] = await openTasks(enforced.id);
      expect(e1.candidateUserIds).toEqual([U.solo]); // the owner cover, nothing waived
      await act('solo', e1.id);
      expect(await instanceOf(enforced.id)).toMatchObject({ status: 'BLOCKED' });

      await markReady();
      const i = await start('tests.gtwo', { beneficiaries: [E.other], requester: null });
      const [s1] = await openTasks(i.id);
      await act('solo', s1.id);
      const [s2] = await openTasks(i.id);
      expect(s2.candidatesSnapshotJson[0].waived).toEqual(['PRIOR_APPROVER']);
      expect((await act('solo', s2.id)).result.status).toBe('APPROVED');
      const [audit] = await selfActAudits(i.id);
      expect((audit.after as { reasons: string[] }).reasons).toEqual(['ONE_PERSON_TWO_STEPS']);
    });

    it('the owner digest lists the engine\'s self-acts (section 1), the loosened path and the automatic approvals (section 5) under the company', async () => {
      const auto = await start('tests.gauto', { beneficiaries: [E.other], requester: null });
      expect(auto.status).toBe('APPROVED');
      const local = new Date(Date.now() + 3 * 3600_000);
      const digest = await iam.buildOwnerDigest(prisma, { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1 });
      const mine = digest.companies.find((c) => c.companyId === C);
      // CONTROL_RELAXED: the automatic path, the two-person retirement, the operator's own retirement.
      expect(mine?.counts).toMatchObject({ relaxedControls: 3, autoApprovals: 1 });
      expect(mine!.counts.selfBeneficiary).toBeGreaterThanOrEqual(1);
      expect(mine!.counts.singleApprover).toBeGreaterThanOrEqual(2); // the self-activation and the two-step approval
      expect(digest.reportable).toBe(true);
      expect(digest.body).toContain('workflow.task.selfAct');
      expect(digest.body).toContain('workflow.definition.activate');
      expect(digest.body).toContain('من كتب مسار الموافقة هو من فعّله'); // AUTHOR_ACTIVATED, the puppet variant included
      expect(digest.body).toContain('من طلب إيقاف مسار الموافقة هو من أكّده'); // AUTHOR_RETIRED
      expect(digest.body).toContain('المنفّذ هو المستفيد');
      expect(digest.body).toContain('٥) مسارات الموافقة');
      expect(digest.body).toContain('tests.gauto v');
    });
  });
});
