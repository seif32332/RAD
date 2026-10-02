// P1-FND-JOBS against a real PostgreSQL with all migrations applied. Opt-in: JOBS_IT=1 with
// DATABASE_URL pointing at a THROWAWAY database (CI: the `integration` job).
//
// Isolation: other integration files run in parallel on the same database and start some registered
// jobs themselves (documents-pipeline: deactivate-terminated, apply-employee-changes,
// documents-retention). This file never starts those: the runner is exercised with its own job names,
// and the registered jobs it runs (purge-attendance-biometrics, domain-events, the outbox dispatcher)
// are not run by any other test.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DomainEventRecord, EventConsumer } from '@/modules/platform';

const RUN = process.env.JOBS_IT === '1';

describe.skipIf(!RUN)('background jobs on PostgreSQL (P1-FND-JOBS)', { timeout: 120_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const platform = await import('@/modules/platform');
  const { scopeWhere } = await import('@/modules/iam');
  const { systemJobScopes } = await import('../scopes');
  const { runRegisteredJob } = await import('../run');
  const { runJob, createDomainEventsJob, ConsumerRegistry, runTransition, emitEvent, enqueueEmails, dispatchOutbox } = platform;
  type Ctx = import('@/modules/iam').SystemContext;

  const newTag = () => `x${randomUUID().replace(/-/g, '').slice(0, 10)}`;

  async function newCompany(tag: string, i: number) {
    return prisma.company.create({ data: { nameArabic: `شركة ${tag} ${i}`, commercialRegNum: `9${tag}${i}`.slice(0, 20), commercialRegExp: new Date('2030-01-01') } });
  }
  async function newEmployee(tag: string, i: number, over: Record<string, unknown> = {}) {
    return prisma.employee.create({
      data: {
        employeeId: `J-${tag}-${i}`, firstNameArabic: 'سالم', lastNameArabic: 'الاختبار', nationality: 'سعودي',
        iqamaOrIdNumber: `1${String(Date.now()).slice(-6)}${i}${Math.floor(Math.random() * 1000)}`, iqamaOrIdExp: new Date('2030-01-01'),
        dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2020-01-01'), basicSalary: 8000,
        ...over,
      },
    });
  }

  it('JobRun: a real run is recorded RUNNING -> SUCCEEDED with its summary', async () => {
    const name = `it-jobs-${newTag()}`;
    const r = await runJob(prisma, { name, description: 'it', crossCompany: false, run: async (ctx) => ({ dryRun: ctx.dryRun, n: 1 }) }, systemJobScopes, { dryRun: true });
    expect(r).toMatchObject({ status: 'SUCCEEDED', details: { dryRun: true, n: 1 } });
    const rows = await prisma.jobRun.findMany({ where: { job: name } });
    expect(rows.map((x) => [x.status, JSON.parse(x.details ?? '{}')])).toEqual([['SUCCEEDED', { dryRun: true, n: 1 }]]);
  });

  it('double call, concurrently: one run executes, the other is skipped (advisory lock + RUNNING row)', async () => {
    const name = `it-jobs-${newTag()}`;
    let calls = 0;
    const def = {
      name,
      description: 'it',
      crossCompany: false,
      run: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 300));
        return {};
      },
    };
    const results = await Promise.all([1, 2, 3].map(() => runJob(prisma, def, systemJobScopes)));
    expect(results.filter((r) => 'skipped' in r)).toHaveLength(2);
    expect(results.filter((r) => 'status' in r && r.status === 'SUCCEEDED')).toHaveLength(1);
    expect(calls).toBe(1);
    expect(await prisma.jobRun.count({ where: { job: name } })).toBe(1);
    // And again once it is over (sequential double call): it runs.
    expect(await runJob(prisma, def, systemJobScopes)).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls).toBe(2);
  });

  it('per company: one SystemContext per company, and its scope filter finds only that company', async () => {
    const tag = newTag();
    const [a, b] = [await newCompany(tag, 1), await newCompany(tag, 2)];
    await newEmployee(tag, 1, { legalCompanyId: a.id });
    await newEmployee(tag, 2, { legalCompanyId: b.id });
    await newEmployee(tag, 3, { legalCompanyId: b.id });
    const name = `it-jobs-${tag}`;
    const r = await runJob(
      prisma,
      {
        name,
        description: 'it',
        crossCompany: false,
        run: async (ctx) => {
          const seen = await ctx.forEachCompany(async (scope: Ctx, companyId) => {
            const where = { AND: [{ employeeId: { startsWith: `J-${tag}-` } }, scopeWhere(scope, 'Employee') ?? {}] };
            return { companies: scope.companies, kind: scope.kind, employees: await prisma.employee.count({ where }), companyId };
          });
          return { scope: ctx.scope, seen };
        },
      },
      systemJobScopes,
    );
    expect(r).toMatchObject({ status: 'SUCCEEDED' });
    const details = (r as unknown as { details: { scope: unknown; seen: Record<string, { companies: string[]; kind: string; employees: number }> } }).details;
    expect(details.scope).toBeNull();
    expect(details.seen[a.id]).toMatchObject({ kind: 'system', companies: [a.id], employees: 1 });
    expect(details.seen[b.id]).toMatchObject({ kind: 'system', companies: [b.id], employees: 2 });
  });

  it('a job not declared cross-company cannot get the all-companies scope (iam refuses)', async () => {
    const name = `it-jobs-${newTag()}`;
    const r = await runJob(prisma, { name, description: 'it', crossCompany: true, run: async () => ({ ran: true }) }, systemJobScopes);
    expect(r).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/not declared cross-company/) });
    expect((await prisma.jobRun.findFirstOrThrow({ where: { job: name } })).status).toBe('FAILED');
  });

  it('domain-events: consumers run at most once per event, however often the job runs', async () => {
    const tag = newTag();
    const type = `itest.${tag}.happened`;
    const registry = new ConsumerRegistry();
    const handled: string[] = [];
    const consumer: EventConsumer = {
      name: `itest.${tag}Consumer`,
      eventTypes: [type],
      handle: async (e: DomainEventRecord) => {
        handled.push(e.idempotencyKey);
      },
    };
    registry.register(consumer);
    await runTransition(prisma, { key: `itest:${tag}:op`, operation: 'itest.jobs.emit', actorId: null }, async (tx) => {
      await emitEvent(tx, { type, aggregateType: 'ItJobs', aggregateId: tag, idempotencyKey: `itest:${tag}:1`, payload: {} });
      await emitEvent(tx, { type, aggregateType: 'ItJobs', aggregateId: tag, idempotencyKey: `itest:${tag}:2`, payload: {} });
      return {};
    });
    const job = createDomainEventsJob<Ctx>({ registry });
    const dry = await runJob(prisma, job, systemJobScopes, { dryRun: true });
    expect(dry).toMatchObject({ status: 'SUCCEEDED', details: { dryRun: true, due: 2 } });
    expect(handled).toEqual([]);
    expect(await runJob(prisma, job, systemJobScopes)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await runJob(prisma, job, systemJobScopes)).toMatchObject({ status: 'SUCCEEDED' });
    expect(handled.sort()).toEqual([`itest:${tag}:1`, `itest:${tag}:2`]);
    expect(await prisma.domainEvent.count({ where: { aggregateId: tag, status: 'DISPATCHED' } })).toBe(2);
  });

  it('outbox: queued once per key; dispatched once; a refused recipient is not sent; stale rows expire', async () => {
    const tag = newTag();
    const msg = (i: number) => ({ idempotencyKey: `itest:${tag}:${i}`, recipient: `r${i}-${tag}@example.test`, subject: 's', body: 'b' });
    expect(await enqueueEmails(prisma, [msg(1), msg(2), msg(3)])).toBe(3);
    expect(await enqueueEmails(prisma, [msg(1), msg(2)])).toBe(0); // same keys: nothing new
    const sent: string[] = [];
    const transport = { sendMail: async (m: { to: string }) => void sent.push(m.to) };
    const env = { OUTBOX_SEND: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@example.test', OUTBOX_BATCH: '200' };
    const shouldSend = async (_db: unknown, m: { idempotencyKey: string }) => m.idempotencyKey !== `itest:${tag}:3`;
    // A row already older than the TTL: EXPIRED, never sent.
    await prisma.notificationOutbox.create({ data: { ...msg(4), channel: 'EMAIL', createdAt: new Date(Date.now() - 100 * 3600e3) } });
    await dispatchOutbox(prisma, { env, transport, shouldSend });
    await dispatchOutbox(prisma, { env, transport, shouldSend });
    const mine = sent.filter((to) => to.endsWith(`${tag}@example.test`)).sort();
    expect(mine).toEqual([`r1-${tag}@example.test`, `r2-${tag}@example.test`]);
    const rows = await prisma.notificationOutbox.findMany({ where: { idempotencyKey: { startsWith: `itest:${tag}:` } }, orderBy: { idempotencyKey: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT', 'FAILED', 'EXPIRED']);
    expect(rows[2].lastError).toBe('recipient no longer active');
  });

  /** An issued document of `companyId` (rows only; no PDF on disk). */
  async function issuedDocument(tag: string, i: number, companyId: string, employeeId: string) {
    const req = await prisma.documentRequest.create({ data: { typeKey: 'PROMOTION_DECISION', legalCompanyId: companyId, employeeId, source: 'HR', paramsJson: '{}', status: 'ISSUED' } });
    const snap = await prisma.documentSnapshot.create({ data: { requestId: req.id, typeKey: 'PROMOTION_DECISION', contractVersion: 1, data: '{"x":1}', dataSha256: 'a'.repeat(64), brand: '{}' } });
    const u = randomUUID();
    return prisma.issuedDocument.create({
      data: {
        number: `IT-${tag}-${i}`, legalCompanyId: companyId, employeeId, typeKey: 'PROMOTION_DECISION', requestId: req.id, snapshotId: snap.id, snapshotSha256: 'a'.repeat(64),
        templateRef: 'it', templateSha256: 'b'.repeat(64), rendererId: 'it', rendererVersion: '1', typstSha256: 'c'.repeat(64), fontsSha256: 'd'.repeat(64), pdfStandard: 'a-2b',
        storedName: `2026/${u}.pdf`, pdfSha256: 'e'.repeat(64), pdfSize: 1, verifyTokenHash: randomUUID(), issuedAt: new Date('2026-01-01'),
      },
    });
  }

  // Far-future dates: the documents-pipeline integration tests run these jobs with "now" up to 2099 on
  // the same database; nothing of theirs is due at 2150+, and nothing of ours is due before.
  it('apply-employee-changes, company by company: only the company\'s decisions are due; applied once however often it runs', async () => {
    const { dueChangeOrderIds, applyChangeOrders } = await import('@/lib/documents/change-orders');
    const { systemContext } = await import('@/modules/iam');
    const tag = newTag();
    const [a, b] = [await newCompany(tag, 1), await newCompany(tag, 2)];
    const ea = await newEmployee(tag, 1, { legalCompanyId: a.id });
    const eb = await newEmployee(tag, 2, { legalCompanyId: b.id });
    const [da, db] = [await issuedDocument(tag, 1, a.id, ea.id), await issuedDocument(tag, 2, b.id, eb.id)];
    const effectiveDate = new Date('2150-01-01T00:00:00+03:00');
    const oa = await prisma.employeeChangeOrder.create({ data: { employeeId: ea.id, documentId: da.id, effectiveDate, basicSalary: 9100, jobTitle: 'مشرف' } });
    const ob = await prisma.employeeChangeOrder.create({ data: { employeeId: eb.id, documentId: db.id, effectiveDate, basicSalary: 9200 } });
    const now = new Date('2150-06-01T08:00:00Z');
    const dueA = await dueChangeOrderIds(now, systemContext('apply-employee-changes', a.id));
    expect(dueA).toContain(oa.id);
    expect(dueA).not.toContain(ob.id);
    expect(await dueChangeOrderIds(new Date('2149-06-01T08:00:00Z'), systemContext('apply-employee-changes', a.id))).not.toContain(oa.id);
    expect(await applyChangeOrders([oa.id])).toEqual({ applied: 1, failed: 0 });
    expect(await applyChangeOrders([oa.id])).toEqual({ applied: 0, failed: 0 }); // double call: nothing more
    const [ra, rb] = await Promise.all([applyChangeOrders([ob.id]), applyChangeOrders([ob.id])]); // concurrent double call
    expect(ra.applied + rb.applied).toBe(1);
    expect(await prisma.salaryChange.count({ where: { employeeId: { in: [ea.id, eb.id] }, isPlanned: false } })).toBe(2);
    const after = await prisma.employee.findMany({ where: { id: { in: [ea.id, eb.id] } }, orderBy: { employeeId: 'asc' }, select: { basicSalary: true, jobTitle: true } });
    expect(after).toEqual([{ basicSalary: 9100, jobTitle: 'مشرف' }, { basicSalary: 9200, jobTitle: null }]);
  });

  it('documents-retention, company by company: purges the company\'s due documents once; a second run changes nothing', async () => {
    const { purgeRetainedDocuments } = await import('@/lib/documents/jobs');
    const { systemContext } = await import('@/modules/iam');
    const tag = newTag();
    const [a, b] = [await newCompany(tag, 1), await newCompany(tag, 2)];
    const leftOn = new Date('2140-01-01T00:00:00Z');
    const ea = await newEmployee(tag, 1, { legalCompanyId: a.id, isTerminated: true, terminationDate: leftOn });
    const eb = await newEmployee(tag, 2, { legalCompanyId: b.id, isTerminated: true, terminationDate: leftOn });
    const [da, db] = [await issuedDocument(tag, 1, a.id, ea.id), await issuedDocument(tag, 2, b.id, eb.id)];
    const uploads = mkdtempSync(join(tmpdir(), 'radeef-jobs-it-'));
    mkdirSync(join(uploads, '.documents', '2026'), { recursive: true });
    writeFileSync(join(uploads, '.documents', ...da.storedName.split('/')), 'pdf');
    const opts = { now: new Date('2155-01-01T00:00:00Z'), env: { ...process.env, UPLOAD_DIR: uploads } };
    const ctxA = systemContext('documents-retention', a.id);
    expect(await purgeRetainedDocuments(prisma, ctxA, { ...opts, dryRun: true })).toMatchObject({ due: 1, purged: 0, dryRun: true });
    expect(await purgeRetainedDocuments(prisma, ctxA, opts)).toMatchObject({ due: 1, purged: 1, missingFiles: 0 });
    expect(await purgeRetainedDocuments(prisma, ctxA, opts)).toMatchObject({ due: 0, purged: 0 });
    expect(existsSync(join(uploads, '.documents', ...da.storedName.split('/')))).toBe(false);
    const rows = await prisma.issuedDocument.findMany({ where: { id: { in: [da.id, db.id] } }, select: { id: true, purgedAt: true } });
    expect(rows.find((r) => r.id === da.id)?.purgedAt).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === db.id)?.purgedAt).toBeNull(); // the other company is untouched
    expect(await prisma.documentSnapshot.findFirstOrThrow({ where: { requestId: da.requestId }, select: { data: true } })).toEqual({ data: '{}' });
    expect(await prisma.documentEvent.count({ where: { documentId: da.id, type: 'PURGED' } })).toBe(1);
  });

  it('purge-attendance-biometrics: a terminated employee\'s face data is erased once; a second run changes nothing', async () => {
    const tag = newTag();
    const uploads = mkdtempSync(join(tmpdir(), 'radeef-jobs-it-'));
    const dir = join(uploads, '.biometric');
    mkdirSync(dir);
    const photo = `${randomUUID()}.jpg`;
    writeFileSync(join(dir, photo), 'x');
    const e = await newEmployee(tag, 1, { isTerminated: true, terminationDate: new Date('2026-01-01') });
    const profile = await prisma.faceProfile.create({ data: { employeeId: e.id, embedding: '[]', model: 'it', consentAt: new Date(), consentVersion: 'it', photoStoredName: photo } });
    const env = { ...process.env, UPLOAD_DIR: uploads };
    const first = await runRegisteredJob(prisma, 'purge-attendance-biometrics', { env });
    expect(first).toMatchObject({ status: 'SUCCEEDED' });
    expect(await prisma.faceProfile.findUnique({ where: { id: profile.id } })).toBeNull();
    expect(existsSync(join(dir, photo))).toBe(false);
    const second = await runRegisteredJob(prisma, 'purge-attendance-biometrics', { env });
    expect(second).toMatchObject({ status: 'SUCCEEDED' });
    expect(await prisma.auditLog.count({ where: { entityType: 'FaceProfile', entityId: profile.id, action: 'DELETE' } })).toBe(1);
  });
});
