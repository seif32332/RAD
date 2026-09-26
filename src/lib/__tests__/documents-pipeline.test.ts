// End-to-end issuance pipeline against a real PostgreSQL (migrations applied) and the real
// radeef-render service. Opt-in: DOCUMENTS_IT=1 with DATABASE_URL (a THROWAWAY database: the test
// creates its own rows and never cleans issued documents, which are immutable by design),
// RENDER_SERVICE_URL / RENDER_SERVICE_TOKEN, APP_URL and UPLOAD_DIR.
// Verifies the ADR-001 criteria: DOC-02/04/05/06/07/08/09/10 and the database guards.
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { storedNameFromSegments } from '@/lib/storage';

const RUN = process.env.DOCUMENTS_IT === '1';
const fixtures = path.join(process.cwd(), 'services', 'render', 'test', 'fixtures', 'F2-ar-en');

describe.skipIf(!RUN)('document issuance pipeline (Postgres + radeef-render)', async () => {
  const { prisma } = await import('@/lib/prisma');
  const svc = await import('@/lib/documents/service');
  const { typstServiceRenderer, RenderError } = await import('@/lib/documents/renderer');
  const { storeAsset } = await import('@/lib/documents/storage');
  const { verifyEventChain } = await import('@/lib/documents/events');
  const { getUploadDir } = await import('@/lib/storage');

  // Renderer wrapper: remembers the verification URL printed in the QR of each render.
  const seenUrls: string[] = [];
  const real = typstServiceRenderer();
  const renderer = {
    id: 'typst' as const,
    render: async (input: Parameters<typeof real.render>[0]) => {
      seenUrls.push((input.data as { doc: { verifyUrl: string } }).doc.verifyUrl);
      return real.render(input);
    },
  };
  const tokenOfLastRender = () => seenUrls[seenUrls.length - 1].split('/v/')[1];

  const tag = randomUUID().slice(0, 8);
  let companyId = '';
  let signatoryId = '';
  let signatoryUserId = '';
  let hrUserId = '';
  const hr = () => ({ userId: hrUserId, role: 'HR_MANAGER', employeeId: null, ip: '10.1.2.3' });
  const self = (employeeId: string, userId: string) => ({ userId, role: 'EMPLOYEE', employeeId, ip: '10.9.9.9' });

  async function newEmployee(i: number, over: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { email: `emp-${tag}-${i}@example.test`, passwordHash: 'x', role: 'EMPLOYEE' } });
    const e = await prisma.employee.create({
      data: {
        employeeId: `E-${tag}-${i}`, firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد', firstNameEnglish: 'Mohammed', lastNameEnglish: 'Alahmad',
        nationality: 'أردني', iqamaOrIdNumber: `2${tag.replace(/\D/g, '').padEnd(4, '7').slice(0, 4)}${String(i).padStart(5, '0')}`,
        iqamaOrIdExp: new Date('2027-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2019-03-09T21:00:00Z'),
        basicSalary: 9500, jobTitle: 'مهندس مدني', jobTitleEnglish: 'Civil Engineer', legalCompanyId: companyId, userId: user.id,
        allowances: { create: [{ name: 'بدل سكن', amount: 2375, isMonthly: true, allowanceType: 'HOUSING' }] },
        ...over,
      },
    });
    return { employeeId: e.id, userId: user.id };
  }

  beforeAll(async () => {
    const company = await prisma.company.create({
      data: { nameArabic: 'شركة الاختبار', nameEnglish: 'Test Co.', commercialRegNum: `10${Date.now()}${tag}`.slice(0, 20), commercialRegExp: new Date('2030-01-01'), unifiedNumber: '7001234567' },
    });
    companyId = company.id;
    hrUserId = (await prisma.user.create({ data: { email: `hr-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
    signatoryUserId = (await prisma.user.create({ data: { email: `sig-${tag}@example.test`, passwordHash: 'x', role: 'COMPANY_ADMIN' } })).id;
    const logo = await storeAsset(readFileSync(path.join(fixtures, 'logo.png')));
    const sig = await storeAsset(readFileSync(path.join(fixtures, 'signature.png')));
    const stamp = await storeAsset(readFileSync(path.join(fixtures, 'stamp.png')));
    const mk = (kind: string, a: { sha256: string; storedName: string }) =>
      prisma.documentAsset.create({ data: { companyId, kind, sha256: a.sha256, storedName: a.storedName, size: 1, width: 1, height: 1 } });
    const logoRow = await mk('LOGO', logo);
    const sigRow = await mk('SIGNATURE', sig);
    const stampRow = await mk('STAMP', stamp);
    await prisma.brandProfile.create({ data: { companyId, numberPrefix: 'TST', logoAssetId: logoRow.id } });
    const s = await prisma.signatory.create({
      data: { companyId, userId: signatoryUserId, nameAr: 'سارة العتيبي', titleAr: 'مديرة الموارد البشرية', signatureAssetId: sigRow.id, stampAssetId: stampRow.id },
    });
    signatoryId = s.id;
    await prisma.documentTypeSetting.create({ data: { companyId, typeKey: 'SALARY_CERTIFICATE', signatoryId } });
    await prisma.documentTypeSetting.create({ data: { companyId, typeKey: 'EMPLOYMENT_CERTIFICATE', signatoryId } });
  });

  it('portal request without a pre-authorization waits for approval; HR approval issues it WITHOUT the signature image (DOC-04)', async () => {
    const e = await newEmployee(1);
    const r = await svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });

    const approved = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(approved.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: approved.documentId! } });
    expect(doc.number).toMatch(/^TST-SAL-\d{4}-\d{6}$/);
    expect(doc.authorizationId).toBeNull(); // HR approved, not the signatory; no delegation
    expect(doc.approvalId).not.toBeNull();
    expect(doc.rendererVersion).toBe('0.15.1');
    expect(doc.pdfStandard).toBe('a-2b');
    expect(doc.fontsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.templateRef).toBe('typst:salary-certificate/ar@1');
    expect(doc.validUntil).not.toBeNull();
  });

  it('the signatory approving the snapshot prints the signature (DOC-04 case 1)', async () => {
    const e = await newEmployee(2);
    const r = await svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null }, renderer);
    const events = await prisma.documentEvent.findMany({ where: { documentId: out.documentId }, orderBy: { seq: 'asc' } });
    expect(JSON.parse(events.find((x) => x.type === 'ISSUED')!.metaJson!).signaturePrinted).toBe(true);
  });

  it('accepted pre-authorization: issued at once with signature; revoked: back to approval (DOC-04 case 2)', async () => {
    const auth = await prisma.signingAuthorization.create({
      data: { signatoryId, legalCompanyId: companyId, typeKey: 'SALARY_CERTIFICATE', validFrom: new Date('2026-01-01'), grantedById: signatoryUserId },
    });
    const e = await newEmployee(3);
    const notAccepted = await svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    expect(notAccepted.status).toBe('PENDING_APPROVAL'); // the signatory has an account and has not accepted yet
    await svc.cancelDocumentRequest(notAccepted.requestId, self(e.employeeId, e.userId));

    await prisma.signingAuthorization.update({ where: { id: auth.id }, data: { acceptedAt: new Date() } });
    const r = await svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar-en' }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    expect(r.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.documentId! } });
    expect(doc.authorizationId).toBe(auth.id);

    await prisma.signingAuthorization.update({ where: { id: auth.id }, data: { revokedAt: new Date(), revokedById: signatoryUserId, revokeReason: 'test' } });
    const e2 = await newEmployee(4);
    const after = await svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: e2.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(e2.employeeId, e2.userId), renderer);
    expect(after.status).toBe('PENDING_APPROVAL');
    // a revoked authorization cannot be un-revoked (guard trigger)
    await expect(prisma.signingAuthorization.update({ where: { id: auth.id }, data: { revokedAt: null } })).rejects.toThrow();
  });

  it('stale snapshot: approval of old data is refused; a data change invalidates approvals and makes a new snapshot (DOC-05)', async () => {
    const e = await newEmployee(5);
    const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const seen = (await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } })).currentSnapshot!;

    // Approve while the company prefix is missing: the approval is recorded, reservation fails.
    await prisma.brandProfile.update({ where: { companyId }, data: { numberPrefix: '' } });
    await expect(svc.approveDocumentRequest(r.requestId, seen.dataSha256, null, hr(), renderer)).rejects.toThrow(/بادئة ترقيم/);
    await prisma.brandProfile.update({ where: { companyId }, data: { numberPrefix: 'TST' } });

    // Material data changes after the approval, before issuance.
    await prisma.employee.update({ where: { id: e.employeeId }, data: { jobTitle: 'مهندس مدني أول' } });
    const adv = await svc.advanceRequest(r.requestId, hr(), renderer);
    expect(adv.status).toBe('PENDING_APPROVAL');
    const approvals = await prisma.documentApproval.findMany({ where: { requestId: r.requestId } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].invalidReason).toBe('STALE_SNAPSHOT');
    const now = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect(now.currentSnapshot!.dataSha256).not.toBe(seen.dataSha256);
    // The approver's old view is refused.
    await expect(svc.approveDocumentRequest(r.requestId, seen.dataSha256, null, hr(), renderer)).rejects.toThrow(/تغيّرت بيانات المستند/);
    // Approving what is current issues it.
    const ok = await svc.approveDocumentRequest(r.requestId, now.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(ok.status).toBe('ISSUED');
  });

  it('numbering: concurrent issuances get consecutive unique numbers; types have separate sequences (DOC-02)', async () => {
    await prisma.signingAuthorization.create({
      data: { signatoryId, legalCompanyId: companyId, typeKey: 'EMPLOYMENT_CERTIFICATE', validFrom: new Date('2026-01-01'), grantedById: signatoryUserId, acceptedAt: new Date() },
    });
    const emps = await Promise.all(Array.from({ length: 12 }, (_, i) => newEmployee(100 + i)));
    const before = await prisma.issuedDocument.count({ where: { legalCompanyId: companyId, typeKey: 'EMPLOYMENT_CERTIFICATE' } });
    const results = await Promise.all(emps.map((e) =>
      svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer)));
    expect(results.every((r) => r.status === 'ISSUED')).toBe(true);
    const docs = await prisma.issuedDocument.findMany({ where: { legalCompanyId: companyId, typeKey: 'EMPLOYMENT_CERTIFICATE' }, select: { number: true } });
    const seqs = docs.map((d) => Number(d.number.slice(-6))).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: before + 12 }, (_, i) => i + 1)); // no gaps
    const sal = await prisma.issuedDocument.findMany({ where: { legalCompanyId: companyId, typeKey: 'SALARY_CERTIFICATE' }, select: { number: true } });
    expect(sal.every((d) => d.number.includes('-SAL-'))).toBe(true);
  });

  it('render failure keeps the reserved number; the retry issues the same number (DOC-02 / DOC-08)', async () => {
    const e = await newEmployee(200);
    const down = { id: 'typst' as const, render: async () => { throw new RenderError('down', 'RENDERER_UNAVAILABLE', true); } };
    const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), down);
    expect(r.status).toBe('APPROVED'); // business state; the technical failure is on the job
    expect(r.renderError?.retryable).toBe(true);
    const job = await prisma.documentRenderJob.findUniqueOrThrow({ where: { requestId: r.requestId } });
    expect(job.status).toBe('FAILED');
    expect(job.verifyTokenEnc).not.toBeNull();
    const again = await svc.retryDocumentRequest(r.requestId, hr(), renderer);
    expect(again.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { requestId: r.requestId } });
    expect(doc.number).toBe(job.number);
    expect((await prisma.documentRenderJob.findUniqueOrThrow({ where: { id: job.id } })).verifyTokenEnc).toBeNull();
  });

  it('a missing asset file blocks the job at once (not retried on a timer) with an actionable message', async () => {
    const e = await newEmployee(250);
    const logo = await prisma.documentAsset.findFirstOrThrow({ where: { companyId, kind: 'LOGO' } });
    const file = path.join(getUploadDir(), '.document-assets', logo.storedName);
    const bytes = readFileSync(file);
    const { unlinkSync } = await import('fs');
    unlinkSync(file);
    try {
      const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
      expect(r.renderError).toMatchObject({ code: 'ASSET_FILE_MISSING', retryable: false });
      expect(r.renderError?.message).toMatch(/الشعار/);
      const job = await prisma.documentRenderJob.findUniqueOrThrow({ where: { requestId: r.requestId } });
      expect(job.status).toBe('BLOCKED');
      writeFileSync(file, bytes);
      const fixed = await svc.retryDocumentRequest(r.requestId, hr(), renderer); // manual retry after the fix
      expect(fixed.status).toBe('ISSUED');
    } finally {
      writeFileSync(file, bytes);
    }
  });

  it('public verification: opaque token, minimal metadata, no personal data; revoked shows as revoked (DOC-06)', async () => {
    const e = await newEmployee(300);
    const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
    const token = tokenOfLastRender();
    const v = await svc.verifyDocumentToken(token, '203.0.113.77');
    expect(v).toMatchObject({ status: 'VALID', issuerAr: 'شركة الاختبار', typeLabelAr: 'خطاب تعريف' });
    const text = JSON.stringify(v);
    for (const pii of ['محمد', 'Mohammed', 'مهندس', '9500', '2375', 'أردني']) expect(text).not.toContain(pii);
    expect(await svc.verifyDocumentToken('A'.repeat(26), null)).toBeNull();
    expect(await svc.verifyDocumentToken('not-a-token', null)).toBeNull();
    const ev = await prisma.documentEvent.findFirst({ where: { documentId: r.documentId, type: 'VERIFIED' } });
    expect(ev?.ip).toBe('203.0.113.0');

    await svc.revokeIssuedDocument(r.documentId!, 'خطأ في البيانات', hr());
    expect((await svc.verifyDocumentToken(token, null))?.status).toBe('REVOKED');
    await expect(svc.revokeIssuedDocument(r.documentId!, 'x', hr())).rejects.toThrow(/مسبقاً/);
  });

  it('download: owner and staff only, same 404 for others; tampering on disk is detected (DOC-10)', async () => {
    const e = await newEmployee(400);
    const other = await newEmployee(401);
    const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
    const own = await svc.readIssuedDocument(r.documentId!, self(e.employeeId, e.userId));
    expect(own.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await svc.readIssuedDocument(r.documentId!, hr());
    await expect(svc.readIssuedDocument(r.documentId!, self(other.employeeId, other.userId))).rejects.toThrow(/غير موجود/);
    await expect(svc.readIssuedDocument(randomUUID(), self(other.employeeId, other.userId))).rejects.toThrow(/غير موجود/);
    await expect(svc.readIssuedDocument(r.documentId!, { userId: 'x', role: 'PURCHASING_AGENT', employeeId: null, ip: null })).rejects.toThrow(/غير موجود/);

    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.documentId! } });
    const file = path.join(getUploadDir(), '.documents', ...doc.storedName.split('/'));
    const bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from(' ')]));
    await expect(svc.readIssuedDocument(r.documentId!, hr())).rejects.toThrow(/hash/);
    writeFileSync(file, bytes);
    // /api/files can never reach the dot-folder.
    expect(storedNameFromSegments(['.documents', ...doc.storedName.split('/')])).toBeNull();
  });

  it('reissue supersedes the previous document; duplicates are refused while one is open', async () => {
    const e = await newEmployee(500);
    const first = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
    const second = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR', supersedesDocumentId: first.documentId }, hr(), renderer);
    expect(second.status).toBe('ISSUED');
    const old = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: first.documentId! } });
    expect(old.status).toBe('SUPERSEDED');
    expect(old.supersededById).toBe(second.documentId);

    const pending = await newEmployee(501);
    await svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: pending.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(pending.employeeId, pending.userId), renderer);
    await expect(svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: pending.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(pending.employeeId, pending.userId), renderer)).rejects.toThrow(/طلب مفتوح/);
  });

  it('permissions and issuer: no request for someone else; legal company comes from the record (DOC-03)', async () => {
    const e = await newEmployee(600);
    const other = await newEmployee(601);
    await expect(svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: other.employeeId, params: {}, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer)).rejects.toThrow(/لموظف آخر/);
    await expect(svc.createDocumentRequest({ typeKey: 'SALARY_CERTIFICATE', employeeId: e.employeeId, params: {}, source: 'HR' }, { userId: 'x', role: 'PURCHASING_AGENT', employeeId: null, ip: null }, renderer)).rejects.toThrow();
    const noCompany = await newEmployee(602, { legalCompanyId: null });
    await expect(svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: noCompany.employeeId, params: {}, source: 'HR' }, hr(), renderer)).rejects.toThrow(/الشركة النظامية غير محددة/);
    const noEnglish = await newEmployee(603, { jobTitleEnglish: null });
    await expect(svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: noEnglish.employeeId, params: { language: 'ar-en' }, source: 'HR' }, hr(), renderer)).rejects.toThrow(/بالإنجليزية/);
  });

  it('notifications: one email per event and recipient, idempotent, without personal data', async () => {
    const e = await newEmployee(700);
    const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
    const rows = await prisma.notificationOutbox.findMany({ where: { idempotencyKey: { startsWith: `doc:issued:${r.documentId}` } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(`emp-${tag}-700@example.test`);
    expect(rows[0].body).toMatch(/صدر خطاب تعريف برقم TST-EMP-/);
    for (const pii of ['محمد', 'Mohammed', '9500', 'مهندس', 'أردني']) expect(rows[0].body + rows[0].subject).not.toContain(pii);
    // Rejection and revocation reach the employee too; the grant reaches the signatory.
    await svc.revokeIssuedDocument(r.documentId!, 'اختبار', hr());
    expect(await prisma.notificationOutbox.count({ where: { idempotencyKey: { startsWith: `doc:revoked:${r.documentId}` } } })).toBe(1);
    const grants = await prisma.notificationOutbox.count({ where: { idempotencyKey: { startsWith: 'doc:authorization:' }, recipient: `sig-${tag}@example.test` } });
    expect(grants).toBe(0); // authorizations in this suite are created directly, not through settings
  });

  it('company scope: a scoped HR user acts only on his legal companies; no scope = all (SPEC §10)', async () => {
    const other = await prisma.company.create({ data: { nameArabic: 'شركة أخرى', commercialRegNum: `20${Date.now()}${tag}`.slice(0, 20), commercialRegExp: new Date('2030-01-01') } });
    const scopedUser = await prisma.user.create({ data: { email: `scoped-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } });
    const scoped = { userId: scopedUser.id, role: 'HR_MANAGER', employeeId: null, ip: null };
    const e = await newEmployee(800);
    const issued = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, scoped, renderer);
    expect(issued.status).toBe('ISSUED'); // no scope rows yet: all companies

    await prisma.userCompanyScope.create({ data: { userId: scopedUser.id, companyId: other.id } });
    const e2 = await newEmployee(801);
    await expect(svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e2.employeeId, params: { language: 'ar' }, source: 'HR' }, scoped, renderer)).rejects.toThrow(/خارج نطاق صلاحيتك/);
    await expect(svc.readIssuedDocument(issued.documentId!, scoped)).rejects.toThrow(/غير موجود/);
    await expect(svc.revokeIssuedDocument(issued.documentId!, 'x', scoped)).rejects.toThrow();
    const { staffDocumentOverview } = await import('@/lib/documents/queries');
    const view = await staffDocumentOverview(scoped);
    expect(view.issued.some((d) => d.id === issued.documentId)).toBe(false);

    await prisma.userCompanyScope.create({ data: { userId: scopedUser.id, companyId } });
    await svc.readIssuedDocument(issued.documentId!, scoped); // now in scope
  });

  it('database guards: issued documents, snapshots and events cannot be rewritten or deleted (DOC-07 / DOC-12)', async () => {
    const doc = await prisma.issuedDocument.findFirstOrThrow({ where: { legalCompanyId: companyId, status: 'ISSUED' } });
    await expect(prisma.issuedDocument.update({ where: { id: doc.id }, data: { pdfSha256: 'f'.repeat(64) } })).rejects.toThrow(/immutable/);
    await expect(prisma.issuedDocument.update({ where: { id: doc.id }, data: { number: 'X' } })).rejects.toThrow();
    await expect(prisma.issuedDocument.delete({ where: { id: doc.id } })).rejects.toThrow();
    await expect(prisma.documentSnapshot.update({ where: { id: doc.snapshotId }, data: { dataSha256: 'x' } })).rejects.toThrow();
    await expect(prisma.documentSnapshot.update({ where: { id: doc.snapshotId }, data: { data: '{"x":1}' } })).rejects.toThrow(/purged/);
    const ev = await prisma.documentEvent.findFirstOrThrow();
    await expect(prisma.documentEvent.update({ where: { id: ev.id }, data: { type: 'X' } })).rejects.toThrow(/append-only/);
    await expect(prisma.documentEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
    expect((await verifyEventChain(prisma)).brokenAtSeq).toBeNull();
  });
});
