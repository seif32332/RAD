// The hand-written constraints of 9zj_workflow_engine (AUDIT/16 §2.3), each one individually, against a real PostgreSQL
// with every migration applied: one test per constraint, a bad row rejected with the constraint's name in the database
// error and a good row accepted. Postgres checks CHECKs in name order and reports the first that fails, so every bad row
// is built to violate ONLY the constraint under test (the name in the message proves it). WorkflowInstance_phase2_no_pay_effect
// is tested in workflow.it.test.ts.
//
// Rows are written with raw SQL (the constraints are the subject; Prisma would not let some bad rows through its types).
// The tenant is a database of its own (iam/__tests__/tenant-db.ts).
//
// Opt-in: WFE_IT=1 with DATABASE_URL on a THROWAWAY server whose role may CREATE DATABASE.
import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterTenantDatabase, leaveTenantDatabase, migratedTemplate, tenantFromTemplate, type TenantDatabase } from '@/modules/iam/__tests__/tenant-db';

describe('9zj constraints on PostgreSQL, one by one (WFE-001)', { timeout: 600_000 }, () => {
  if (process.env.WFE_IT !== '1') return; // skipped: build nothing (the suite creates a database)

  let template: TenantDatabase;
  let tenant: TenantDatabase;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const tag = randomBytes(4).toString('hex');
  const NOW = new Date();
  const LATER = new Date(NOW.getTime() + 86_400_000);
  let C1 = '';
  let C2 = '';
  let U1 = '';
  let U2 = '';
  let DEF = ''; // an ACTIVE tenant definition every instance points at
  let counter = 0;

  // ------------------------------------------------------------------------------------------------
  // SQL helpers (values are test-local literals, never user input)

  type Val = string | number | boolean | null | Date | string[] | undefined;
  const L = (v: Val): string => {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Date) return `'${v.toISOString()}'::timestamp`;
    if (Array.isArray(v)) return v.length ? `ARRAY[${v.map((x) => L(x)).join(',')}]::text[]` : 'ARRAY[]::text[]';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${v.replace(/'/g, "''")}'`;
  };
  // A unique violation names no index in the driver's message ("Key (...) already exists"), so the insert runs in a DO
  // block that re-raises it with the name of the violated index. Every other error (CHECK, EXCLUDE, FK) is untouched.
  const insert = (table: string, row: Record<string, Val>) => {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const stmt = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((k) => L(row[k])).join(',')})`;
    return prisma.$executeRawUnsafe(
      `DO $$ DECLARE c text; BEGIN ${stmt}; EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME; RAISE EXCEPTION 'unique index % violated', c; END $$`,
    );
  };
  const update = (table: string, id: string, set: Record<string, Val>) =>
    prisma.$executeRawUnsafe(`UPDATE "${table}" SET ${Object.entries(set).map(([k, v]) => `"${k}" = ${L(v)}`).join(', ')} WHERE "id" = ${L(id)}`);
  const remove = (table: string, id: string) => prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = ${L(id)}`);
  /** The write is refused by the database, and the error names `constraint` (or the trigger's message). */
  const rejected = (p: Promise<unknown>, constraint: string) => expect(p).rejects.toThrow(constraint);
  const accepted = async (p: Promise<unknown>) => void (await p);

  const rt = () => `tests.c${++counter}`;
  const hex = (c = 'a') => c.repeat(64);

  // ------------------------------------------------------------------------------------------------
  // Row builders (a valid row; each test overrides what it breaks)

  const def = (over: Record<string, Val> = {}): Record<string, Val> => ({
    id: randomUUID(),
    requestType: rt(),
    companyId: null,
    version: 1,
    status: 'DRAFT',
    definitionJson: '{}',
    checksum: hex(),
    createdById: U1,
    updatedAt: NOW,
    ...over,
  });
  // Getters: U1 exists only after beforeAll, and a spread reads them when the test runs. The activator is U2, not the
  // creator U1 (9zn WorkflowDefinition_two_person_activation, DEC-PO-146).
  const stamped = {
    activatedAt: NOW,
    get activatedById() {
      return U2;
    },
  };
  const retired = {
    status: 'RETIRED',
    activatedAt: NOW,
    retiredAt: NOW,
    get activatedById() {
      return U2;
    },
    get retiredById() {
      return U1;
    },
  };

  /** What a retire request reviewed (9zn, DEC-PO-147 re-check): the fallback version and the relaxation codes. */
  const reviewed = (): Record<string, Val> => ({ retireFallbackId: DEF, retireRelaxations: ['REJECT_PAIR_REMOVED'] });

  const inst = (over: Record<string, Val> = {}): Record<string, Val> => ({
    id: randomUUID(),
    companyId: C1,
    requestType: 'tests.cinst',
    requestId: randomUUID(),
    definitionId: DEF,
    status: 'RUNNING',
    updatedAt: NOW,
    ...over,
  });
  /** A valid PAUSED instance (previousStatus, pausedAt and a reason on the stack). */
  const paused: Record<string, Val> = { status: 'PAUSED', previousStatus: 'RUNNING', pausedAt: NOW, pauseReasons: ['DEFERRAL'] };
  const blocked: Record<string, Val> = { status: 'BLOCKED', blockedAt: NOW, blockedReason: 'NO_CANDIDATE' };
  const awaiting: Record<string, Val> = { status: 'AWAITING_REQUIREMENT', awaitingSince: NOW, awaitingRequirement: 'DOCUMENT_MISSING' };

  async function newInstance(over: Record<string, Val> = {}): Promise<string> {
    const row = inst(over);
    await insert('WorkflowInstance', row);
    return row.id as string;
  }

  const task = (instanceId: string, over: Record<string, Val> = {}): Record<string, Val> => ({
    id: randomUUID(),
    instanceId,
    companyId: C1,
    round: 1,
    nodeId: `n${++counter}`,
    kind: 'APPROVE',
    status: 'OPEN',
    updatedAt: NOW,
    ...over,
  });
  const decided = (over: Record<string, Val> = {}): Record<string, Val> => ({ status: 'APPROVED', decidedAt: NOW, actedByUserId: U1, ...over });

  const delegation = (from: string, to: string, over: Record<string, Val> = {}): Record<string, Val> => ({
    id: randomUUID(),
    fromUserId: from,
    toUserId: to,
    companyIds: [C1],
    startsAt: NOW,
    endsAt: LATER,
    createdById: from,
    ...over,
  });
  async function users(n: number): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push((await prisma.user.create({ data: { email: `c${++counter}-${tag}@example.test`, passwordHash: 'x', role: 'EMPLOYEE' } })).id);
    return out;
  }

  beforeAll(async () => {
    template = await migratedTemplate('wfc');
    tenant = await tenantFromTemplate(template, 'core');
    await enterTenantDatabase(tenant.url);
    prisma = (await import('@/lib/prisma')).prisma;
    const company = async (n: string) => (await prisma.company.create({ data: { nameArabic: `WFC ${n} ${tag}`, commercialRegNum: `WFC${n}${tag}`, commercialRegExp: new Date('2035-01-01') } })).id;
    C1 = await company('1');
    C2 = await company('2');
    [U1, U2] = await users(2);
    DEF = randomUUID();
    await insert('WorkflowDefinition', def({ id: DEF, requestType: 'tests.cdefinst', status: 'ACTIVE', ...stamped }));
  }, 600_000);

  afterAll(async () => {
    await leaveTenantDatabase();
    await tenant?.drop().catch(() => undefined);
    await template?.drop().catch(() => undefined);
  }, 120_000);

  // ------------------------------------------------------------------------------------------------
  // WorkflowDefinition

  describe('WorkflowDefinition', () => {
    it('WorkflowDefinition_request_type_format: a dotted lower-camel type; no dot, an upper first letter or a symbol is refused', async () => {
      for (const bad of ['nodots', 'Tests.upper', 'tests.Upper', 'tests.', '.tests', 'tests.a-b', 'tests.a b', '1tests.x', '']) {
        await rejected(insert('WorkflowDefinition', def({ requestType: bad })), 'WorkflowDefinition_request_type_format');
      }
      await accepted(insert('WorkflowDefinition', def({ requestType: 'tests.okType' })));
      await accepted(insert('WorkflowDefinition', def({ requestType: 'tests.a.b2C' })));
    });

    it('WorkflowDefinition_version_positive: version 0 and negative are refused, 1 is accepted', async () => {
      await rejected(insert('WorkflowDefinition', def({ version: 0 })), 'WorkflowDefinition_version_positive');
      await rejected(insert('WorkflowDefinition', def({ version: -3 })), 'WorkflowDefinition_version_positive');
      await accepted(insert('WorkflowDefinition', def({ version: 1 })));
    });

    it('WorkflowDefinition_checksum_sha256: exactly 64 lower-case hex characters', async () => {
      for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)} `]) {
        await rejected(insert('WorkflowDefinition', def({ checksum: bad })), 'WorkflowDefinition_checksum_sha256');
      }
      await accepted(insert('WorkflowDefinition', def({ checksum: '0123456789abcdef'.repeat(4) })));
    });

    it('WorkflowDefinition_activation_stamped: a non-DRAFT needs activatedAt and activatedById; a DRAFT needs neither', async () => {
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE' })), 'WorkflowDefinition_activation_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', activatedAt: NOW })), 'WorkflowDefinition_activation_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', activatedById: U1 })), 'WorkflowDefinition_activation_stamped');
      // RETIRED, stamped as retired but never activated
      await rejected(insert('WorkflowDefinition', def({ status: 'RETIRED', retiredAt: NOW, retiredById: U1 })), 'WorkflowDefinition_activation_stamped');
      await accepted(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped })));
      await accepted(insert('WorkflowDefinition', def({ status: 'DRAFT' })));
    });

    it('WorkflowDefinition_retire_stamped: RETIRED iff retiredAt and retiredById are both set', async () => {
      await rejected(insert('WorkflowDefinition', def({ status: 'RETIRED', ...stamped })), 'WorkflowDefinition_retire_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'RETIRED', ...stamped, retiredAt: NOW })), 'WorkflowDefinition_retire_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'RETIRED', ...stamped, retiredById: U1 })), 'WorkflowDefinition_retire_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, retiredAt: NOW, retiredById: U1 })), 'WorkflowDefinition_retire_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'DRAFT', retiredAt: NOW, retiredById: U1 })), 'WorkflowDefinition_retire_stamped');
      await accepted(insert('WorkflowDefinition', def(retired)));
    });

    it('WorkflowDefinition_version_tenant: one version number per request type among the tenant definitions (companyId NULL)', async () => {
      const type = rt();
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 1, ...retired })));
      await rejected(insert('WorkflowDefinition', def({ requestType: type, version: 1, ...retired })), 'WorkflowDefinition_version_tenant');
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 2, ...retired })));
      // The same number in a company definition, and for another type, is a different series.
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1, ...retired })));
      await accepted(insert('WorkflowDefinition', def({ requestType: rt(), version: 1, ...retired })));
    });

    it('WorkflowDefinition_version_company: one version number per request type and company', async () => {
      const type = rt();
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1, ...retired })));
      await rejected(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1, ...retired })), 'WorkflowDefinition_version_company');
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 2, ...retired })));
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C2, version: 1, ...retired })));
    });

    it('WorkflowDefinition_one_active_tenant: one ACTIVE tenant definition per request type', async () => {
      const type = rt();
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 1, status: 'ACTIVE', ...stamped })));
      await rejected(insert('WorkflowDefinition', def({ requestType: type, version: 2, status: 'ACTIVE', ...stamped })), 'WorkflowDefinition_one_active_tenant');
      // A retired or draft sibling, and an ACTIVE definition of a company or of another type, are fine.
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 3, ...retired })));
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 4 })));
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1, status: 'ACTIVE', ...stamped })));
      await accepted(insert('WorkflowDefinition', def({ requestType: rt(), version: 1, status: 'ACTIVE', ...stamped })));
    });

    it('WorkflowDefinition_one_active_company: one ACTIVE definition per request type and company', async () => {
      const type = rt();
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1, status: 'ACTIVE', ...stamped })));
      await rejected(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 2, status: 'ACTIVE', ...stamped })), 'WorkflowDefinition_one_active_company');
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C2, version: 1, status: 'ACTIVE', ...stamped })));
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 3, ...retired })));
    });

    it('WorkflowDefinition_one_draft_tenant: one DRAFT tenant definition per request type', async () => {
      const type = rt();
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 1 })));
      await rejected(insert('WorkflowDefinition', def({ requestType: type, version: 2 })), 'WorkflowDefinition_one_draft_tenant');
      await accepted(insert('WorkflowDefinition', def({ requestType: type, version: 3, status: 'ACTIVE', ...stamped }))); // a draft beside an ACTIVE
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1 })));
    });

    it('WorkflowDefinition_one_draft_company: one DRAFT definition per request type and company', async () => {
      const type = rt();
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 1 })));
      await rejected(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 2 })), 'WorkflowDefinition_one_draft_company');
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C2, version: 1 })));
      await accepted(insert('WorkflowDefinition', def({ requestType: type, companyId: C1, version: 3, status: 'ACTIVE', ...stamped })));
    });

    it('trigger workflow_definition_guard: DRAFT -> RETIRED is refused (it must be activated first); DRAFT -> ACTIVE -> RETIRED is accepted', async () => {
      const d = def();
      await insert('WorkflowDefinition', d);
      // Fully stamped, so that only the trigger can be the reason.
      await rejected(update('WorkflowDefinition', d.id as string, { status: 'RETIRED', ...stamped, retiredAt: NOW, retiredById: U1 }), 'DRAFT -> RETIRED is not allowed');
      expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('DRAFT');
      await accepted(update('WorkflowDefinition', d.id as string, { status: 'ACTIVE', ...stamped }));
      await accepted(update('WorkflowDefinition', d.id as string, { status: 'RETIRED', retiredAt: NOW, retiredById: U1 }));
      expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('RETIRED');
    });

    it('trigger workflow_definition_guard: a status never goes back (ACTIVE -> DRAFT, RETIRED -> ACTIVE, RETIRED -> DRAFT)', async () => {
      const active = def({ status: 'ACTIVE', ...stamped });
      await insert('WorkflowDefinition', active);
      await rejected(update('WorkflowDefinition', active.id as string, { status: 'DRAFT' }), 'ACTIVE -> DRAFT is not allowed');
      const gone = def(retired);
      await insert('WorkflowDefinition', gone);
      await rejected(update('WorkflowDefinition', gone.id as string, { status: 'ACTIVE', retiredAt: null, retiredById: null }), 'RETIRED -> ACTIVE is not allowed');
      await rejected(update('WorkflowDefinition', gone.id as string, { status: 'DRAFT', retiredAt: null, retiredById: null }), 'RETIRED -> DRAFT is not allowed');
    });

    it('trigger workflow_definition_guard: deleting a non-DRAFT (ACTIVE or RETIRED) is refused; deleting a DRAFT is accepted (G6)', async () => {
      const active = def({ status: 'ACTIVE', ...stamped });
      const gone = def(retired);
      const draft = def();
      for (const r of [active, gone, draft]) await insert('WorkflowDefinition', r);
      await rejected(remove('WorkflowDefinition', active.id as string), 'only a DRAFT can be deleted');
      await rejected(remove('WorkflowDefinition', gone.id as string), 'only a DRAFT can be deleted');
      expect(await prisma.workflowDefinition.count({ where: { id: { in: [active.id, gone.id] } } })).toBe(2);
      await accepted(remove('WorkflowDefinition', draft.id as string));
      expect(await prisma.workflowDefinition.count({ where: { id: draft.id } })).toBe(0);
    });

    it('trigger workflow_definition_guard: an activated version is immutable (json, checksum, type, company, version); a DRAFT is editable', async () => {
      const active = def({ status: 'ACTIVE', ...stamped });
      await insert('WorkflowDefinition', active);
      const id = active.id as string;
      await rejected(update('WorkflowDefinition', id, { definitionJson: '{"x":1}' }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { checksum: hex('b') }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { requestType: rt() }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { companyId: C1 }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { version: 9 }), 'an activated version is immutable');
      // Retiring (status and stamps only) is allowed, and the row stays immutable afterwards.
      await accepted(update('WorkflowDefinition', id, { status: 'RETIRED', retiredAt: NOW, retiredById: U1 }));
      await rejected(update('WorkflowDefinition', id, { definitionJson: '{"x":2}' }), 'an activated version is immutable');

      const draft = def();
      await insert('WorkflowDefinition', draft);
      await accepted(update('WorkflowDefinition', draft.id as string, { definitionJson: '{"x":1}', checksum: hex('c'), version: 5, changeNote: 'edited' }));
    });

    // 9zn (BL-WFE-003; DEC-PO-146 / ADR-0011, INV-IAM-01): the database backstop of the two-person activation.
    it('WorkflowDefinition_two_person_activation: an activated row whose activator is its creator or its last editor is refused unless activationSelfAct is set', async () => {
      // The creator activates alone (INV-IAM-01: one person routes the approvals of a type).
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', activatedAt: NOW, activatedById: U1 })), 'WorkflowDefinition_two_person_activation');
      // Another created it, the activator was its last editor.
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', activatedAt: NOW, activatedById: U2, lastEditedById: U2 })), 'WorkflowDefinition_two_person_activation');
      await rejected(insert('WorkflowDefinition', def({ ...retired, activatedById: U1 })), 'WorkflowDefinition_two_person_activation');
      // A second person: accepted. The recorded single-operator exception: accepted.
      await accepted(insert('WorkflowDefinition', def({ status: 'ACTIVE', activatedAt: NOW, activatedById: U2, lastEditedById: U1 })));
      await accepted(insert('WorkflowDefinition', def({ status: 'ACTIVE', activatedAt: NOW, activatedById: U1, activationSelfAct: true })));
      // DRAFT → ACTIVE by the creator, through an UPDATE as well.
      const d = def({ lastEditedById: U2 });
      await insert('WorkflowDefinition', d);
      await rejected(update('WorkflowDefinition', d.id as string, { status: 'ACTIVE', activatedAt: NOW, activatedById: U2 }), 'WorkflowDefinition_two_person_activation');
      await rejected(update('WorkflowDefinition', d.id as string, { status: 'ACTIVE', activatedAt: NOW, activatedById: U1 }), 'WorkflowDefinition_two_person_activation');
    });

    it('WorkflowDefinition_self_act_activated: a DRAFT never carries the self-act flag', async () => {
      await rejected(insert('WorkflowDefinition', def({ activationSelfAct: true })), 'WorkflowDefinition_self_act_activated');
      await accepted(insert('WorkflowDefinition', def({ activationSelfAct: false })));
    });

    it('WorkflowDefinition_two_person_retire (DEC-PO-147): a requested retirement confirmed by its requester is refused unless retireSelfAct is set; the request is stamped and never on a DRAFT', async () => {
      await rejected(insert('WorkflowDefinition', def({ ...retired, retiredById: U1, retireRequestedById: U1, retireRequestedAt: NOW, ...reviewed() })), 'WorkflowDefinition_two_person_retire');
      await accepted(insert('WorkflowDefinition', def({ ...retired, retiredById: U1, retireRequestedById: U2, retireRequestedAt: NOW, ...reviewed() })));
      await accepted(insert('WorkflowDefinition', def({ ...retired, retiredById: U1, retireRequestedById: U1, retireRequestedAt: NOW, ...reviewed(), retireSelfAct: true })));
      await accepted(insert('WorkflowDefinition', def({ ...retired, retiredById: U1 }))); // no request: a retirement that loosens nothing
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, retireRequestedById: U1 })), 'WorkflowDefinition_retire_request_stamped');
      // The request records what was reviewed (fallback + relaxation codes), and only with a request.
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, retireRequestedById: U1, retireRequestedAt: NOW })), 'WorkflowDefinition_retire_request_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, retireRequestedById: U1, retireRequestedAt: NOW, retireFallbackId: DEF })), 'WorkflowDefinition_retire_request_stamped');
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, ...reviewed() })), 'WorkflowDefinition_retire_request_stamped');
      await accepted(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, retireRequestedById: U1, retireRequestedAt: NOW, ...reviewed() })));
      await rejected(insert('WorkflowDefinition', def({ retireRequestedById: U1, retireRequestedAt: NOW })), 'WorkflowDefinition_retire_request_active');
      await rejected(insert('WorkflowDefinition', def({ status: 'ACTIVE', ...stamped, retireSelfAct: true })), 'WorkflowDefinition_retire_self_act_retired');
      // ACTIVE → RETIRED by the requester himself, through an UPDATE.
      const a = def({ status: 'ACTIVE', ...stamped, retireRequestedById: U1, retireRequestedAt: NOW, ...reviewed() });
      await insert('WorkflowDefinition', a);
      await rejected(update('WorkflowDefinition', a.id as string, { status: 'RETIRED', retiredAt: NOW, retiredById: U1 }), 'WorkflowDefinition_two_person_retire');
      await accepted(update('WorkflowDefinition', a.id as string, { status: 'RETIRED', retiredAt: NOW, retiredById: U2 }));
      // A retired version's retirement is immutable (9zn trigger).
      await rejected(update('WorkflowDefinition', a.id as string, { retiredById: U1 }), 'a retired version is immutable');
      await rejected(update('WorkflowDefinition', a.id as string, { retireRequestedById: U2 }), 'a retired version is immutable');
      await rejected(update('WorkflowDefinition', a.id as string, { retireSelfAct: true }), 'a retired version is immutable');
      await rejected(update('WorkflowDefinition', a.id as string, { retireRelaxations: ['AUTO_APPROVE_PATH'] }), 'a retired version is immutable');
      await rejected(update('WorkflowDefinition', a.id as string, { retireFallbackId: null }), 'a retired version is immutable');
    });

    it('trigger workflow_definition_guard (9zn): the authorship of an activated version is immutable (creator, last editor, activator, activatedAt, the self-act flag)', async () => {
      const [u3] = await users(1);
      const active = def({ status: 'ACTIVE', ...stamped, lastEditedById: U1 });
      await insert('WorkflowDefinition', active);
      const id = active.id as string;
      await rejected(update('WorkflowDefinition', id, { createdById: u3 }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { lastEditedById: u3 }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { activatedById: u3 }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { activatedAt: LATER }), 'an activated version is immutable');
      await rejected(update('WorkflowDefinition', id, { activationSelfAct: true }), 'an activated version is immutable');
      await accepted(update('WorkflowDefinition', id, { status: 'RETIRED', retiredAt: NOW, retiredById: U1 }));
      await rejected(update('WorkflowDefinition', id, { activatedById: u3 }), 'an activated version is immutable');
      // A DRAFT's last editor changes with every save.
      const draft = def();
      await insert('WorkflowDefinition', draft);
      await accepted(update('WorkflowDefinition', draft.id as string, { lastEditedById: u3 }));
    });
  });

  // ------------------------------------------------------------------------------------------------
  // WorkflowInstance

  describe('WorkflowInstance', () => {
    it('WorkflowInstance_request_type_format: the same dotted lower-camel format as the definition', async () => {
      for (const bad of ['nodots', 'Tests.upper', 'tests.a-b', '']) {
        await rejected(insert('WorkflowInstance', inst({ requestType: bad })), 'WorkflowInstance_request_type_format');
      }
      await accepted(insert('WorkflowInstance', inst({ requestType: 'tests.okType' })));
    });

    it('WorkflowInstance_counters: version >= 0, round >= 1, returns >= 0', async () => {
      await rejected(insert('WorkflowInstance', inst({ version: -1 })), 'WorkflowInstance_counters');
      await rejected(insert('WorkflowInstance', inst({ round: 0 })), 'WorkflowInstance_counters');
      await rejected(insert('WorkflowInstance', inst({ returns: -1 })), 'WorkflowInstance_counters');
      await accepted(insert('WorkflowInstance', inst({ version: 0, round: 1, returns: 0 })));
      await accepted(insert('WorkflowInstance', inst({ version: 7, round: 3, returns: 2 })));
    });

    it('WorkflowInstance_closed_iff_terminal: closedAt iff APPROVED / REJECTED / CANCELLED, and closeKind iff closedAt', async () => {
      for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
        await rejected(insert('WorkflowInstance', inst({ status })), 'WorkflowInstance_closed_iff_terminal'); // terminal and not closed
        await rejected(insert('WorkflowInstance', inst({ status, closedAt: NOW })), 'WorkflowInstance_closed_iff_terminal'); // closed without a kind
        await accepted(insert('WorkflowInstance', inst({ status, closedAt: NOW, closeKind: 'DECIDED' })));
      }
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', closedAt: NOW, closeKind: 'DECIDED' })), 'WorkflowInstance_closed_iff_terminal'); // closed and not terminal
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', closeKind: 'DECIDED' })), 'WorkflowInstance_closed_iff_terminal'); // a kind without closedAt
      await accepted(insert('WorkflowInstance', inst({ status: 'RUNNING' })));
    });

    it('WorkflowInstance_pause_stack: PAUSED needs at least one reason; only PAUSED and BLOCKED may carry reasons', async () => {
      await rejected(insert('WorkflowInstance', inst({ ...paused, pauseReasons: [] })), 'WorkflowInstance_pause_stack');
      for (const status of ['RUNNING', 'RETURNED']) {
        await rejected(insert('WorkflowInstance', inst({ status, pauseReasons: ['DEFERRAL'] })), 'WorkflowInstance_pause_stack');
      }
      await rejected(insert('WorkflowInstance', inst({ ...awaiting, pauseReasons: ['DEFERRAL'] })), 'WorkflowInstance_pause_stack');
      await accepted(insert('WorkflowInstance', inst(paused)));
      await accepted(insert('WorkflowInstance', inst({ ...blocked, pauseReasons: ['CANCEL_REQUESTED'] }))); // BLOCKED may hold a stack
      await accepted(insert('WorkflowInstance', inst(blocked))); // and an empty one
    });

    it('WorkflowInstance_pause_codes: every pause reason is an upper-case code of 2 to 64 characters', async () => {
      for (const bad of ['deferral', 'A', 'HAS SPACE', '1ABC', 'AB-CD', 'A'.repeat(65)]) {
        await rejected(insert('WorkflowInstance', inst({ ...paused, pauseReasons: [bad] })), 'WorkflowInstance_pause_codes');
      }
      await rejected(insert('WorkflowInstance', inst({ ...paused, pauseReasons: ['DEFERRAL', 'bad'] })), 'WorkflowInstance_pause_codes');
      await accepted(insert('WorkflowInstance', inst({ ...paused, pauseReasons: ['DEFERRAL', 'SUPERSEDED_2', 'AB'] })));
      await accepted(insert('WorkflowInstance', inst({ ...paused, pauseReasons: ['A'.repeat(64)] })));
    });

    it('WorkflowInstance_previous_status: only RUNNING / RETURNED / AWAITING_REQUIREMENT, required while PAUSED, never outside PAUSED and BLOCKED', async () => {
      for (const bad of ['APPROVED', 'PAUSED', 'BLOCKED', 'CANCELLED']) {
        await rejected(insert('WorkflowInstance', inst({ ...paused, previousStatus: bad })), 'WorkflowInstance_previous_status');
      }
      await rejected(insert('WorkflowInstance', inst({ ...paused, previousStatus: null })), 'WorkflowInstance_previous_status');
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', previousStatus: 'RUNNING' })), 'WorkflowInstance_previous_status');
      for (const ok of ['RUNNING', 'RETURNED', 'AWAITING_REQUIREMENT']) await accepted(insert('WorkflowInstance', inst({ ...paused, previousStatus: ok })));
      await accepted(insert('WorkflowInstance', inst({ ...blocked, previousStatus: 'RUNNING' })));
      await accepted(insert('WorkflowInstance', inst({ ...blocked, previousStatus: null })));
    });

    it('WorkflowInstance_paused_at: pausedAt is set iff PAUSED', async () => {
      await rejected(insert('WorkflowInstance', inst({ ...paused, pausedAt: null })), 'WorkflowInstance_paused_at');
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', pausedAt: NOW })), 'WorkflowInstance_paused_at');
      await rejected(insert('WorkflowInstance', inst({ ...blocked, pausedAt: NOW })), 'WorkflowInstance_paused_at');
      await accepted(insert('WorkflowInstance', inst(paused)));
    });

    it('WorkflowInstance_blocked: blockedAt iff BLOCKED, and blockedReason iff blockedAt', async () => {
      await rejected(insert('WorkflowInstance', inst({ status: 'BLOCKED' })), 'WorkflowInstance_blocked');
      await rejected(insert('WorkflowInstance', inst({ ...blocked, blockedAt: null, blockedReason: null })), 'WorkflowInstance_blocked');
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', blockedAt: NOW, blockedReason: 'NO_CANDIDATE' })), 'WorkflowInstance_blocked');
      await rejected(insert('WorkflowInstance', inst({ ...blocked, blockedReason: null })), 'WorkflowInstance_blocked'); // blockedAt without a reason
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', blockedReason: 'NO_CANDIDATE' })), 'WorkflowInstance_blocked'); // a reason without blockedAt
      await accepted(insert('WorkflowInstance', inst(blocked)));
    });

    it('WorkflowInstance_awaiting: AWAITING_REQUIREMENT needs awaitingSince; only AWAITING / PAUSED may have it; since and requirement go together', async () => {
      await rejected(insert('WorkflowInstance', inst({ status: 'AWAITING_REQUIREMENT' })), 'WorkflowInstance_awaiting');
      await rejected(insert('WorkflowInstance', inst({ ...awaiting, awaitingSince: null })), 'WorkflowInstance_awaiting');
      await rejected(insert('WorkflowInstance', inst({ ...awaiting, awaitingRequirement: null })), 'WorkflowInstance_awaiting'); // since without a requirement
      await rejected(insert('WorkflowInstance', inst({ status: 'RUNNING', awaitingSince: NOW, awaitingRequirement: 'DOCUMENT_MISSING' })), 'WorkflowInstance_awaiting');
      await rejected(insert('WorkflowInstance', inst({ ...blocked, awaitingSince: NOW, awaitingRequirement: 'DOCUMENT_MISSING' })), 'WorkflowInstance_awaiting'); // BLOCKED cannot hold it
      await rejected(insert('WorkflowInstance', inst({ ...paused, awaitingRequirement: 'DOCUMENT_MISSING' })), 'WorkflowInstance_awaiting'); // a requirement without since
      await accepted(insert('WorkflowInstance', inst(awaiting)));
      await accepted(insert('WorkflowInstance', inst({ ...paused, previousStatus: 'AWAITING_REQUIREMENT', awaitingSince: NOW, awaitingRequirement: 'DOCUMENT_MISSING' })));
    });

    it('WorkflowInstance_codes_format: closeSource, blockedReason and awaitingRequirement are upper-case codes', async () => {
      for (const bad of ['deemed', 'A', 'HAS SPACE', 'A'.repeat(65)]) {
        await rejected(insert('WorkflowInstance', inst({ closeSource: bad })), 'WorkflowInstance_codes_format');
        await rejected(insert('WorkflowInstance', inst({ ...blocked, blockedReason: bad })), 'WorkflowInstance_codes_format');
        await rejected(insert('WorkflowInstance', inst({ ...awaiting, awaitingRequirement: bad })), 'WorkflowInstance_codes_format');
      }
      await accepted(insert('WorkflowInstance', inst({ closeSource: 'DEEMED_ACCEPTANCE' })));
      await accepted(insert('WorkflowInstance', inst({ status: 'APPROVED', closedAt: NOW, closeKind: 'EXTERNAL', closeSource: 'WITHDRAWAL' })));
      await accepted(insert('WorkflowInstance', inst({ ...blocked, blockedReason: 'NO_CANDIDATE' })));
    });

    it('WorkflowInstance_effect_failure: effectFailedAt needs lastEffectError', async () => {
      await rejected(insert('WorkflowInstance', inst({ effectFailedAt: NOW })), 'WorkflowInstance_effect_failure');
      await accepted(insert('WorkflowInstance', inst({ effectFailedAt: NOW, lastEffectError: 'downstream refused' })));
      await accepted(insert('WorkflowInstance', inst({ lastEffectError: 'recorded without a time' })));
      await accepted(insert('WorkflowInstance', inst()));
    });
  });

  // ------------------------------------------------------------------------------------------------
  // WorkflowTask

  describe('WorkflowTask', () => {
    it('WorkflowTask_round_positive: round >= 1', async () => {
      const i = await newInstance();
      await rejected(insert('WorkflowTask', task(i, { round: 0 })), 'WorkflowTask_round_positive');
      await rejected(insert('WorkflowTask', task(i, { round: -2 })), 'WorkflowTask_round_positive');
      await accepted(insert('WorkflowTask', task(i, { round: 1 })));
      await accepted(insert('WorkflowTask', task(i, { round: 4 })));
    });

    it('WorkflowTask_node_format: 1 to 64 characters of letters, digits and _ . : # -', async () => {
      const i = await newInstance();
      for (const bad of ['', 'has space', 'bad/slash', 'bad!', 'x'.repeat(65), 'عربي']) {
        await rejected(insert('WorkflowTask', task(i, { nodeId: bad })), 'WorkflowTask_node_format');
      }
      for (const ok of ['hr', 'mgr.L1', 'REJECT_PAIR#1', 'CANCEL_CONFIRM#2', 'a:b-c_d.e', 'x'.repeat(64)]) await accepted(insert('WorkflowTask', task(i, { nodeId: ok })));
    });

    it('WorkflowTask_open_undecided: a task is OPEN iff it has no decidedAt', async () => {
      const i = await newInstance();
      await rejected(insert('WorkflowTask', task(i, { status: 'OPEN', decidedAt: NOW })), 'WorkflowTask_open_undecided');
      for (const status of ['APPROVED', 'NOT_REQUIRED', 'CANCELLED']) {
        await rejected(insert('WorkflowTask', task(i, { status, decidedAt: null, actedByUserId: U1 })), 'WorkflowTask_open_undecided');
        await accepted(insert('WorkflowTask', task(i, { status, decidedAt: NOW, actedByUserId: U1 })));
      }
      await accepted(insert('WorkflowTask', task(i, { status: 'OPEN' })));
    });

    it('WorkflowTask_actor_on_decision: APPROVED, REJECTED and RETURNED name the person who acted; NOT_REQUIRED and CANCELLED need none', async () => {
      const i = await newInstance();
      for (const status of ['APPROVED', 'REJECTED', 'RETURNED']) {
        const extra = { note: 'because' };
        await rejected(insert('WorkflowTask', task(i, { status, decidedAt: NOW, actedByUserId: null, ...extra })), 'WorkflowTask_actor_on_decision');
        await accepted(insert('WorkflowTask', task(i, { status, decidedAt: NOW, actedByUserId: U1, ...extra })));
      }
      await accepted(insert('WorkflowTask', task(i, { status: 'NOT_REQUIRED', decidedAt: NOW })));
      await accepted(insert('WorkflowTask', task(i, { status: 'CANCELLED', decidedAt: NOW })));
    });

    it('WorkflowTask_on_behalf_distinct: onBehalfOfUserId is never the person who acted', async () => {
      const i = await newInstance();
      await rejected(insert('WorkflowTask', task(i, decided({ actedByUserId: U1, onBehalfOfUserId: U1 }))), 'WorkflowTask_on_behalf_distinct');
      await accepted(insert('WorkflowTask', task(i, decided({ actedByUserId: U1, onBehalfOfUserId: U2 }))));
      await accepted(insert('WorkflowTask', task(i, decided({ actedByUserId: U1, onBehalfOfUserId: null }))));
    });

    it('WorkflowTask_reject_reason: a REJECTED task has a non-blank note', async () => {
      const i = await newInstance();
      await rejected(insert('WorkflowTask', task(i, decided({ status: 'REJECTED' }))), 'WorkflowTask_reject_reason');
      await rejected(insert('WorkflowTask', task(i, decided({ status: 'REJECTED', note: '' }))), 'WorkflowTask_reject_reason');
      await rejected(insert('WorkflowTask', task(i, decided({ status: 'REJECTED', note: '   ' }))), 'WorkflowTask_reject_reason');
      await accepted(insert('WorkflowTask', task(i, decided({ status: 'REJECTED', note: 'incomplete file' }))));
      // The reason is required of a rejection only.
      await accepted(insert('WorkflowTask', task(i, decided({ status: 'APPROVED' }))));
    });

    it('WorkflowTask_return_only_approve: only an APPROVE task can be RETURNED', async () => {
      const i = await newInstance();
      for (const kind of ['REJECT_PAIR', 'CANCEL_CONFIRM', 'REQUIREMENT_CHECK', 'DEFERRAL_DECISION']) {
        await rejected(insert('WorkflowTask', task(i, decided({ status: 'RETURNED', kind, note: 'n' }))), 'WorkflowTask_return_only_approve');
      }
      await accepted(insert('WorkflowTask', task(i, decided({ status: 'RETURNED', kind: 'APPROVE', note: 'n' }))));
    });

    it('WorkflowTask_one_open_special: one OPEN task per special kind per instance; APPROVE tasks are not limited', async () => {
      for (const kind of ['REJECT_PAIR', 'CANCEL_CONFIRM', 'DEFERRAL_DECISION', 'REQUIREMENT_CHECK']) {
        const i = await newInstance();
        await accepted(insert('WorkflowTask', task(i, { kind })));
        await rejected(insert('WorkflowTask', task(i, { kind })), 'WorkflowTask_one_open_special');
        // Another instance, another kind, and a decided task of the same kind do not collide.
        await accepted(insert('WorkflowTask', task(await newInstance(), { kind })));
        await accepted(insert('WorkflowTask', task(i, { kind, status: 'NOT_REQUIRED', decidedAt: NOW })));
      }
      const i = await newInstance();
      await accepted(insert('WorkflowTask', task(i, { kind: 'REJECT_PAIR' })));
      await accepted(insert('WorkflowTask', task(i, { kind: 'CANCEL_CONFIRM' })));
      for (let n = 0; n < 3; n += 1) await accepted(insert('WorkflowTask', task(i, { kind: 'APPROVE' })));
    });

    it('the task of another company than its instance is refused (composite foreign key)', async () => {
      const i = await newInstance({ companyId: C1 });
      await rejected(insert('WorkflowTask', task(i, { companyId: C2 })), 'WorkflowTask_instanceId_companyId_fkey');
      await accepted(insert('WorkflowTask', task(i, { companyId: C1 })));
    });
  });

  // ------------------------------------------------------------------------------------------------
  // ApprovalDelegation

  describe('ApprovalDelegation', () => {
    it('ApprovalDelegation_distinct_parties: the delegator, the delegate and the creator: from <> to and to <> creator', async () => {
      const [a, b, c] = await users(3);
      await rejected(insert('ApprovalDelegation', delegation(a, a)), 'ApprovalDelegation_distinct_parties'); // from = to
      await rejected(insert('ApprovalDelegation', delegation(a, b, { createdById: b })), 'ApprovalDelegation_distinct_parties'); // the delegate creates it for himself
      await accepted(insert('ApprovalDelegation', delegation(a, b))); // the delegator creates it
      // A third party (an owner) creates it on behalf: allowed, with a reason (checked separately).
      await accepted(insert('ApprovalDelegation', delegation(c, b, { createdById: a, reason: 'on leave' })));
    });

    it('ApprovalDelegation_window: endsAt must be after startsAt', async () => {
      const [a, b] = await users(2);
      await rejected(insert('ApprovalDelegation', delegation(a, b, { startsAt: NOW, endsAt: NOW })), 'ApprovalDelegation_window');
      await rejected(insert('ApprovalDelegation', delegation(a, b, { startsAt: LATER, endsAt: NOW })), 'ApprovalDelegation_window');
      await accepted(insert('ApprovalDelegation', delegation(a, b, { startsAt: NOW, endsAt: new Date(NOW.getTime() + 1) })));
    });

    it('ApprovalDelegation_companies: at least one company', async () => {
      const [a, b, c] = await users(3);
      await rejected(insert('ApprovalDelegation', delegation(a, b, { companyIds: [] })), 'ApprovalDelegation_companies');
      await accepted(insert('ApprovalDelegation', delegation(a, b, { companyIds: [C1] })));
      await accepted(insert('ApprovalDelegation', delegation(c, b, { companyIds: [C1, C2] })));
    });

    it('ApprovalDelegation_reason_on_behalf: a delegation created by someone other than the delegator needs a non-blank reason', async () => {
      const [a, b, c] = await users(3);
      await rejected(insert('ApprovalDelegation', delegation(a, b, { createdById: c })), 'ApprovalDelegation_reason_on_behalf');
      await rejected(insert('ApprovalDelegation', delegation(a, b, { createdById: c, reason: '' })), 'ApprovalDelegation_reason_on_behalf');
      await rejected(insert('ApprovalDelegation', delegation(a, b, { createdById: c, reason: '   ' })), 'ApprovalDelegation_reason_on_behalf');
      await accepted(insert('ApprovalDelegation', delegation(a, b, { createdById: c, reason: 'the delegator is abroad' })));
      // The delegator himself needs no reason.
      const [d, e] = await users(2);
      await accepted(insert('ApprovalDelegation', delegation(d, e, { createdById: d, reason: null })));
    });

    it('ApprovalDelegation_revocation: revokedAt and revokedById are set together', async () => {
      const [a, b, c, d] = await users(4);
      await rejected(insert('ApprovalDelegation', delegation(a, b, { revokedAt: NOW })), 'ApprovalDelegation_revocation');
      await rejected(insert('ApprovalDelegation', delegation(a, b, { revokedById: a })), 'ApprovalDelegation_revocation');
      await accepted(insert('ApprovalDelegation', delegation(c, d, { revokedAt: NOW, revokedById: c, revokeReason: 'back at work' })));
      await accepted(insert('ApprovalDelegation', delegation(a, b)));
    });

    it('ApprovalDelegation_one_delegate: a delegator has one live delegation in a window (EXCLUDE); adjacent windows and revoked rows do not collide', async () => {
      const [a, b, c] = await users(3);
      const day = 86_400_000;
      const t0 = NOW.getTime();
      await accepted(insert('ApprovalDelegation', delegation(a, b, { startsAt: new Date(t0), endsAt: new Date(t0 + 2 * day) })));
      // Overlapping (to another delegate too), and contained: refused.
      await rejected(insert('ApprovalDelegation', delegation(a, c, { startsAt: new Date(t0 + day), endsAt: new Date(t0 + 3 * day) })), 'ApprovalDelegation_one_delegate');
      await rejected(insert('ApprovalDelegation', delegation(a, b, { startsAt: new Date(t0 + 1000), endsAt: new Date(t0 + 2000) })), 'ApprovalDelegation_one_delegate');
      // The window is half open: starting exactly when the first ends is fine.
      await accepted(insert('ApprovalDelegation', delegation(a, c, { startsAt: new Date(t0 + 2 * day), endsAt: new Date(t0 + 3 * day) })));
      // Another delegator in the same window is fine.
      await accepted(insert('ApprovalDelegation', delegation(b, c, { startsAt: new Date(t0), endsAt: new Date(t0 + 2 * day) })));
      // A revoked delegation frees its window.
      await accepted(insert('ApprovalDelegation', delegation(c, a, { startsAt: new Date(t0 + 10 * day), endsAt: new Date(t0 + 12 * day), revokedAt: NOW, revokedById: c })));
      await accepted(insert('ApprovalDelegation', delegation(c, b, { startsAt: new Date(t0 + 10 * day), endsAt: new Date(t0 + 12 * day) })));
    });
  });
});
