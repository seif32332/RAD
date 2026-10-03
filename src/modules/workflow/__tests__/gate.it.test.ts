// The activation gate WITHOUT the test mock (AUDIT/16 §3.8; INV-IAM-01 / ADR-0010 regression): in phase 2 nobody — not
// even the owner, alone — can activate an approval path or start an instance. A draft can be saved (G7) and stays a
// draft; no ACTIVE row, no instance, no operation is written.
//
// Opt-in: WFE_IT=1 with DATABASE_URL on a THROWAWAY database.
import { randomBytes, randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';

describe('the activation gate on PostgreSQL (WFE-002, phase 2)', { timeout: 120_000 }, () => {
  if (process.env.WFE_IT !== '1') return; // skipped: build nothing (the suite writes to the database)

  it('INV-IAM-01: one owner saves a draft and tries to activate it and to start a request: WFE_NOT_ACTIVATABLE, nothing activated, zero rows', async () => {
    const { prisma } = await import('@/lib/prisma');
    const wf = await import('@/modules/workflow');
    const iam = await import('@/modules/iam');
    (await import('@/lib/workflow-wiring')).ensureWorkflowWiring();
    const tag = randomBytes(4).toString('hex');
    const type = `tests.gate${tag}`;
    wf.registerWorkflowAdapter({
      requestType: type,
      ownerModule: 'tests',
      payEffect: 'NONE',
      fieldCatalog: {},
      decisionFieldCatalog: {},
      closeSources: [],
      pauseReasons: [],
      decisionStatuses: [],
      domainStatuses: [],
      legacyDecisionEntryPoints: [],
      recheckTriggers: [],
      load: async () => ({}),
      parties: async () => ({ beneficiaryEmployeeIds: [], requesterUserId: null, contextSnapshot: {} }),
      validateSubmit: async () => undefined,
      validateFinal: async () => ({ ok: true }),
      canReject: () => true,
      canReturn: () => true,
      canCancel: () => true,
      cancelNeedsConfirm: () => false,
      onApproved: async () => undefined,
      onRejected: async () => undefined,
      onCancelled: async () => undefined,
      summary: () => ({}),
    });
    const owner = await prisma.user.create({ data: { email: `gate-${tag}@example.test`, passwordHash: 'x', role: 'SUPER_ADMIN' } });
    try {
      const ctx = iam.scopedContext(await iam.resolveActor(prisma, { id: owner.id, role: 'SUPER_ADMIN', employeeId: null }));
      const def = { schemaVersion: 1, settings: { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null, rejectRequiresPair: false, rejectAuthority: [] }, root: { type: 'sequence', id: 'r', children: [] } };
      const draft = await wf.saveWorkflowDefinitionDraft(prisma, { ctx, requestType: type, companyId: null, definition: def });
      expect(draft.result.status).toBe('DRAFT');
      const opsBefore = await prisma.operationLog.count({ where: { operationKey: { startsWith: `wf:def:activate:${draft.result.id}` } } });
      await expect(wf.activateWorkflowDefinition(prisma, { ctx, definitionId: draft.result.id })).rejects.toMatchObject({ code: 'WFE_NOT_ACTIVATABLE', status: 409 });
      expect(await prisma.workflowDefinition.count({ where: { requestType: type, status: 'ACTIVE' } })).toBe(0);
      expect(await prisma.operationLog.count({ where: { operationKey: { startsWith: `wf:def:activate:${draft.result.id}` } } })).toBe(opsBefore);
      const company = await prisma.company.create({ data: { nameArabic: `Gate ${tag}`, commercialRegNum: `GATE${tag}`, commercialRegExp: new Date('2035-01-01') } });
      const requestId = randomUUID();
      await expect(prisma.$transaction((tx) => wf.startWorkflow(tx, { ctx: iam.systemContext('gate', company.id), requestType: type, requestId }))).rejects.toMatchObject({ code: 'WFE_NOT_ACTIVATABLE' });
      expect(await prisma.workflowInstance.count({ where: { requestType: type } })).toBe(0);
      expect(await prisma.operationLog.count({ where: { operationKey: `wf:start:${type}:${requestId}` } })).toBe(0);
    } finally {
      await (await import('@/test/money-fixtures')).identityFixture(owner.id, { isActive: false });
    }
  });
});
