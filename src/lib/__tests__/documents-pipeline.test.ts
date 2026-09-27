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

// Real database + real render service: generous per-test timeout (a loaded machine, the numbering
// test runs 50 issuances).
describe.skipIf(!RUN)('document issuance pipeline (Postgres + radeef-render)', { timeout: 30_000 }, async () => {
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

  // ---- Phase 2 (SPEC §14): warning, clearance, system suggestions ----

  const warning = { subjectAr: 'التأخر المتكرر عن الدوام', bodyAr: 'تكرر تأخرك عن بداية الدوام الرسمي خلال شهر أغسطس.\n\nنأمل الالتزام بمواعيد العمل.' };

  it('warning: maker-checker approval of the exact text; hidden from the employee until issued; acknowledged once', async () => {
    const e = await newEmployee(900);
    const r = await svc.createDocumentRequest({ typeKey: 'WARNING_LETTER', employeeId: e.employeeId, params: { language: 'ar', warning }, source: 'HR' }, hr(), renderer);
    expect(r.status).toBe('PENDING_APPROVAL'); // locked: no pre-authorization or setting skips it
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect(JSON.parse(req.currentSnapshot!.data).data.warning.bodyAr).toBe(warning.bodyAr);

    // The author cannot approve his own text; the employee neither sees nor cancels it.
    await expect(svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer)).rejects.toThrow(/شخص آخر/);
    const { myDocumentRequests, documentRequestDetail } = await import('@/lib/documents/queries');
    expect((await myDocumentRequests(e.employeeId)).some((x) => x.id === r.requestId)).toBe(false);
    expect(await documentRequestDetail(r.requestId, self(e.employeeId, e.userId))).toBeNull();
    await expect(svc.cancelDocumentRequest(r.requestId, self(e.employeeId, e.userId))).rejects.toThrow(/غير موجود/);
    await expect(svc.createDocumentRequest({ typeKey: 'WARNING_LETTER', employeeId: e.employeeId, params: { language: 'ar', warning }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer)).rejects.toThrow(/البوابة/);

    const checker = { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null };
    const issued = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, checker, renderer);
    expect(issued.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: issued.documentId! } });
    expect(doc.number).toMatch(/^TST-WRN-\d{4}-\d{6}$/);
    expect(doc.validUntil).toBeNull();
    const notice = await prisma.notificationOutbox.findFirstOrThrow({ where: { idempotencyKey: { startsWith: `doc:issued:${doc.id}` } } });
    expect(notice.body).toMatch(/الإقرار باستلامه/);
    const mine = await myDocumentRequests(e.employeeId);
    expect(mine.find((x) => x.id === r.requestId)?.document?.acknowledgement).toEqual({ kind: 'RECEIPT', at: null, decision: null, comment: null });

    // Only the employee concerned, once; then HR sees it.
    const other = await newEmployee(901);
    await expect(svc.acknowledgeDocument(doc.id, { comment: null }, self(other.employeeId, other.userId))).rejects.toThrow(/غير موجود/);
    await expect(svc.acknowledgeDocument(doc.id, { decision: 'ACCEPTED', comment: null }, self(e.employeeId, e.userId))).rejects.toThrow(/استلامه فقط/);
    await svc.acknowledgeDocument(doc.id, { comment: 'أعتذر عن التأخر لظروف النقل' }, self(e.employeeId, e.userId));
    await expect(svc.acknowledgeDocument(doc.id, { comment: null }, self(e.employeeId, e.userId))).rejects.toThrow(/مسبقاً/);
    const view = await (await import('@/lib/documents/queries')).staffDocumentOverview(hr(), { employeeId: e.employeeId });
    expect(view.issued[0].acknowledgement?.comment).toBe('أعتذر عن التأخر لظروف النقل');
    const ev = await prisma.documentEvent.findFirstOrThrow({ where: { documentId: doc.id, type: 'ACKNOWLEDGED' } });
    expect(ev.metaJson).not.toContain('أعتذر'); // the comment is not copied into the log

    // Acknowledgement guard: never rewritten or deleted; only the retention purge clears the comment.
    const ack = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId: doc.id } });
    await expect(prisma.documentAcknowledgement.update({ where: { id: ack.id }, data: { comment: 'تعديل' } })).rejects.toThrow(/immutable/);
    await expect(prisma.documentAcknowledgement.update({ where: { id: ack.id }, data: { acknowledgedAt: new Date() } })).rejects.toThrow(/immutable/);
    await expect(prisma.documentAcknowledgement.delete({ where: { id: ack.id } })).rejects.toThrow(/never deleted/);
    await prisma.documentAcknowledgement.update({ where: { id: ack.id }, data: { comment: null } });

    // Types without acknowledgement refuse it.
    const cert = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
    await expect(svc.acknowledgeDocument(cert.documentId!, { comment: null }, self(e.employeeId, e.userId))).rejects.toThrow(/لا يحتاج/);
  });

  it('clearance: refused while anything is open (listing it); issued after approval once all is settled', async () => {
    const e = await newEmployee(950, { isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') });
    const asset = await prisma.asset.create({ data: { employeeId: e.employeeId, assetType: 'لابتوب', description: 'Dell', status: 'ACTIVE' } });
    const st = await prisma.settlement.create({ data: { employeeId: e.employeeId, type: 'END_OF_SERVICE', status: 'OWNER_APPROVED', lastWorkingDate: new Date('2026-08-30T21:00:00Z') } });
    const attempt = svc.createDocumentRequest({ typeKey: 'CLEARANCE_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar-en' }, source: 'HR' }, hr(), renderer);
    await expect(attempt).rejects.toThrow(/عهدة لم تُسترجع: لابتوب - Dell/);
    await expect(attempt).rejects.toThrow(/لم تُصرف بعد/);

    await prisma.asset.update({ where: { id: asset.id }, data: { status: 'RETURNED', returnDate: new Date() } });
    await prisma.settlement.update({ where: { id: st.id }, data: { status: 'PAID' } });
    const r = await svc.createDocumentRequest({ typeKey: 'CLEARANCE_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar-en' }, source: 'HR' }, hr(), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });

    // A custody item handed out before approval blocks issuance (facts are re-read: DOC-05).
    const late = await prisma.asset.create({ data: { employeeId: e.employeeId, assetType: 'جوال', status: 'ACTIVE' } });
    await expect(svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer)).rejects.toThrow(/جوال/);
    await prisma.asset.update({ where: { id: late.id }, data: { status: 'RETURNED' } });

    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(out.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: out.documentId! } });
    expect(doc.number).toMatch(/^TST-CLR-/);
    expect(doc.templateRef).toBe('typst:clearance-certificate/ar-en@1');
  });

  it('paid settlement: clearance + experience requests suggested for approval, once (SPEC §13)', async () => {
    const e = await newEmployee(970, { isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') });
    const st = await prisma.settlement.create({ data: { employeeId: e.employeeId, type: 'END_OF_SERVICE', status: 'OWNER_APPROVED' } });
    expect(await svc.suggestExitDocuments(st.id)).toEqual([]); // not paid yet
    await prisma.settlement.update({ where: { id: st.id }, data: { status: 'PAID' } });

    const first = await svc.suggestExitDocuments(st.id);
    expect(first.map((x) => [x.typeKey, x.outcome])).toEqual([['CLEARANCE_CERTIFICATE', 'CREATED'], ['EXPERIENCE_CERTIFICATE', 'CREATED'], ['SETTLEMENT_STATEMENT', 'SKIPPED']]);
    expect(first[2].reason).toMatch(/إثبات الصرف/); // paid before payment proof existed: no statement
    const rows = await prisma.documentRequest.findMany({ where: { sourceRef: `settlement:${st.id}` } });
    expect(rows.map((x) => [x.source, x.status])).toEqual([['SYSTEM', 'PENDING_APPROVAL'], ['SYSTEM', 'PENDING_APPROVAL']]);
    // The employee does not cancel a system suggestion.
    await expect(svc.cancelDocumentRequest(rows[0].id, self(e.employeeId, e.userId))).rejects.toThrow(/غير موجود/);

    const again = await Promise.all([svc.suggestExitDocuments(st.id), svc.suggestExitDocuments(st.id)]);
    for (const r of again) expect(r.filter((x) => x.typeKey !== 'SETTLEMENT_STATEMENT').every((x) => x.outcome === 'EXISTS')).toBe(true);
    expect(await prisma.documentRequest.count({ where: { sourceRef: `settlement:${st.id}` } })).toBe(2);
    await expect(prisma.documentRequest.create({
      data: { typeKey: 'CLEARANCE_CERTIFICATE', legalCompanyId: companyId, employeeId: e.employeeId, source: 'SYSTEM', sourceRef: `settlement:${st.id}`, paramsJson: '{}', status: 'CANCELLED' },
    })).rejects.toThrow(); // unique (typeKey, sourceRef)

    // Blocked suggestion (open custody) is SKIPPED with the reason, and created by a later sweep.
    const b = await newEmployee(971, { isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') });
    const item = await prisma.asset.create({ data: { employeeId: b.employeeId, assetType: 'سيارة', status: 'ACTIVE' } });
    const st2 = await prisma.settlement.create({ data: { employeeId: b.employeeId, type: 'END_OF_SERVICE', status: 'PAID' } });
    const blocked = await svc.suggestExitDocuments(st2.id);
    expect(blocked.find((x) => x.typeKey === 'CLEARANCE_CERTIFICATE')).toMatchObject({ outcome: 'SKIPPED', reason: expect.stringMatching(/سيارة/) });
    expect(blocked.find((x) => x.typeKey === 'EXPERIENCE_CERTIFICATE')?.outcome).toBe('CREATED');
    await prisma.asset.update({ where: { id: item.id }, data: { status: 'RETURNED' } });
    await svc.suggestDueExitDocuments();
    expect(await prisma.documentRequest.count({ where: { sourceRef: `settlement:${st2.id}` } })).toBe(2);
  });

  it('settlement statement: payment proof from finance, itemized to the halala, accepted or disputed once by the employee', async () => {
    const { markSettlementPaid } = await import('@/lib/finance');
    const { saveUpload } = await import('@/lib/storage');
    const { createHash } = await import('crypto');
    const finance = { id: (await prisma.user.create({ data: { email: `fin-${tag}@example.test`, passwordHash: 'x', role: 'FINANCE_MANAGER' } })).id, email: '', role: 'FINANCE_MANAGER' as const, name: '', avatarUrl: null, employeeId: null, sessionVersion: 0 };
    const e = await newEmployee(990, { isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') });
    // Components as the settlement screen stores them: 1200 + 30000 + 4500 + (overtime 800 + other 300) - (loans 2000 + other 500) = 34300
    const st = await prisma.settlement.create({
      data: {
        employeeId: e.employeeId, type: 'END_OF_SERVICE', terminationReason: 'RESIGNATION', status: 'OWNER_APPROVED', lastWorkingDate: new Date('2026-08-30T21:00:00Z'),
        yearsOfService: 7.4789, workingDaysSalary: 1200, endOfServiceAmount: 30000, leaveCompensation: 4500, overtimeAmount: 800, additionalEntitlements: 1100,
        loansDeduction: 2000, additionalDeductions: 2500, totalSettlement: 34300,
      },
    });
    // Not paid yet, then paid without proof is impossible (the proof is a required parameter).
    await expect(svc.createDocumentRequest({ typeKey: 'SETTLEMENT_STATEMENT', employeeId: e.employeeId, params: { language: 'ar', settlementId: st.id }, source: 'HR' }, hr(), renderer)).rejects.toThrow(/لم تُصرف/);
    const receipt = Buffer.from('%PDF-1.4 receipt of transfer 88213', 'latin1');
    const up = await saveUpload(receipt, 'pdf');
    await prisma.$transaction((tx) => markSettlementPaid(tx, st.id, up.url, finance, {}, { paymentMethod: 'BANK_TRANSFER', paymentReference: 'TRX-88213', paidAt: '2026-09-02' }));
    const paid = await prisma.settlement.findUniqueOrThrow({ where: { id: st.id } });
    expect([paid.status, paid.paymentMethod, paid.paymentReference, paid.paidAt?.toISOString()]).toEqual(['PAID', 'BANK_TRANSFER', 'TRX-88213', '2026-09-01T21:00:00.000Z']);

    const r = await svc.createDocumentRequest({ typeKey: 'SETTLEMENT_STATEMENT', employeeId: e.employeeId, params: { language: 'ar-en', settlementId: st.id }, source: 'HR' }, hr(), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    const data = JSON.parse(req.currentSnapshot!.data).data.settlement;
    expect(data.entitlements.map((x: { key: string; amount: string }) => [x.key, x.amount])).toEqual([
      ['WORKING_DAYS', '1200.00'], ['END_OF_SERVICE', '30000.00'], ['LEAVE', '4500.00'], ['OVERTIME', '800.00'], ['OTHER_ENTITLEMENTS', '300.00'],
    ]);
    expect(data.deductions.map((x: { key: string; amount: string }) => [x.key, x.amount])).toEqual([['LOANS', '2000.00'], ['OTHER_DEDUCTIONS', '500.00']]);
    expect(data.net).toBe('34300.00');
    expect(data.payment).toEqual({ method: 'BANK_TRANSFER', reference: 'TRX-88213', paidDate: '2026-09-02', amount: '34300.00', receiptSha256: createHash('sha256').update(receipt).digest('hex') });
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(out.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: out.documentId! } });
    expect(doc.number).toMatch(/^TST-STL-/);

    // Verification shows the discharge state; the employee accepts once (a dispute needs a reason).
    const token = tokenOfLastRender();
    expect((await svc.verifyDocumentToken(token, null))?.release).toEqual({ status: 'PENDING', at: null });
    await expect(svc.acknowledgeDocument(doc.id, { comment: null }, self(e.employeeId, e.userId))).rejects.toThrow(/الموافقة/);
    await expect(svc.acknowledgeDocument(doc.id, { decision: 'DISPUTED', comment: 'لا' }, self(e.employeeId, e.userId))).rejects.toThrow(/سبب الاعتراض/);
    await svc.acknowledgeDocument(doc.id, { decision: 'ACCEPTED', comment: null }, self(e.employeeId, e.userId));
    expect((await svc.verifyDocumentToken(token, null))?.release?.status).toBe('ACCEPTED');
    await expect(svc.acknowledgeDocument(doc.id, { decision: 'DISPUTED', comment: 'غيرت رأيي' }, self(e.employeeId, e.userId))).rejects.toThrow(/مسبقاً/);
    const ack = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId: doc.id } });
    await expect(prisma.documentAcknowledgement.update({ where: { id: ack.id }, data: { decision: 'DISPUTED' } })).rejects.toThrow(/immutable/);

    // A corrected statement (reissue) asks again; a dispute reaches the issuer and approver.
    const again = await svc.createDocumentRequest({ typeKey: 'SETTLEMENT_STATEMENT', employeeId: e.employeeId, params: { language: 'ar', settlementId: st.id }, source: 'HR', supersedesDocumentId: doc.id }, hr(), renderer);
    const req2 = await prisma.documentRequest.findUniqueOrThrow({ where: { id: again.requestId }, include: { currentSnapshot: true } });
    const doc2 = await svc.approveDocumentRequest(again.requestId, req2.currentSnapshot!.dataSha256, null, { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null }, renderer);
    await svc.acknowledgeDocument(doc2.documentId!, { decision: 'DISPUTED', comment: 'بدل الإجازة أقل من المستحق' }, self(e.employeeId, e.userId));
    const notices = await prisma.notificationOutbox.findMany({ where: { idempotencyKey: { startsWith: `doc:disputed:${doc2.documentId}` } } });
    expect(notices.map((n) => n.recipient).sort()).toEqual([`hr-${tag}@example.test`, `sig-${tag}@example.test`]);
    expect(notices[0].body).not.toContain('بدل الإجازة'); // the reason stays behind the login

    // Inconsistent stored components are refused rather than printed.
    await prisma.settlement.update({ where: { id: st.id }, data: { totalSettlement: 34300.5 } });
    await expect(svc.createDocumentRequest({ typeKey: 'SETTLEMENT_STATEMENT', employeeId: e.employeeId, params: { language: 'ar', settlementId: st.id }, source: 'HR' }, hr(), renderer)).rejects.toThrow(/لا يطابق/);

    // A paid leave settlement suggests its statement (and nothing else).
    const lv = await prisma.settlement.create({
      data: { employeeId: e.employeeId, type: 'LEAVE_SETTLEMENT', status: 'PAID', leaveCompensation: 3000, totalSettlement: 3000, paymentMethod: 'CASH_VOUCHER', paymentReference: 'SV-17', paidAt: new Date('2026-09-10T21:00:00Z') },
    });
    const sug = await svc.suggestExitDocuments(lv.id);
    expect(sug.map((x) => [x.typeKey, x.outcome])).toEqual([['SETTLEMENT_STATEMENT', 'CREATED']]);
  });

  it('leaver: documents-only window at termination (not for absconding), then the nightly job deactivates', async () => {
    const { deactivateEmployeeUser } = await import('@/lib/access');
    const { runJob } = await import('../../../scripts/jobs.mjs');
    const e = await newEmployee(995, { isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: e.userId } });
    const r = await prisma.$transaction((tx) => deactivateEmployeeUser(tx, e.employeeId, { reason: 'test' }));
    expect(r.deactivated).toBe(false);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: e.userId } });
    expect(u.isActive).toBe(true);
    expect(u.sessionVersion).toBe(before.sessionVersion + 1); // full sessions revoked
    expect(Math.round((u.documentsOnlyUntil!.getTime() - Date.now()) / 86400e3)).toBe(30);

    // The job keeps it during the window and deactivates it after.
    await runJob(prisma, 'deactivate-terminated', { now: new Date() });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: e.userId } })).isActive).toBe(true);
    await runJob(prisma, 'deactivate-terminated', { now: new Date(Date.now() + 31 * 86400e3) });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: e.userId } });
    expect([after.isActive, after.documentsOnlyUntil]).toEqual([false, null]);

    // Absconding: no documents window.
    const a = await newEmployee(996, { isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') });
    await prisma.$transaction((tx) => deactivateEmployeeUser(tx, a.employeeId, { reason: 'ABSCONDED', documentsAccess: false }));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).isActive).toBe(false);
  });

  it('payslips: issued for the whole month once paid, unsigned, no approval, once per row; a failed month blocks nothing', async () => {
    const { markPayrollMonthPaid } = await import('@/lib/payroll');
    const a = await newEmployee(1001);
    const b = await newEmployee(1002);
    const row = (employeeId: string, month: number) => prisma.payroll.create({
      data: {
        employeeId, month, year: 2031, status: 'APPROVED', basicSalary: 9500, totalAllowances: 2375, bonusAmount: 0, overtimeCost: 0,
        gosiEmployee: 1068.75, loansDeduction: 0, violationsDeduction: 0, leaveDeduction: 0, otherDeductions: 0, totalDeductions: 1068.75, netSalary: 10806.25,
      },
    });
    const [ra, rb] = [await row(a.employeeId, 3), await row(b.employeeId, 3)];
    expect((await svc.issuePayslips({ year: 2031, month: 3 })).issued).toBe(0); // approved, not paid yet

    await prisma.$transaction((tx) => markPayrollMonthPaid(tx, 2031, 3));
    const run = await svc.issuePayslips({ year: 2031, month: 3 });
    expect(run).toEqual({ issued: 2, existing: 0, failed: [] });
    const docs = await prisma.issuedDocument.findMany({ where: { typeKey: 'PAYSLIP', employeeId: { in: [a.employeeId, b.employeeId] } }, include: { request: true } });
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d.number).toMatch(/^TST-PAY-/);
      expect([d.signatoryId, d.approvalId, d.request.source]).toEqual([null, null, 'SYSTEM']);
    }
    expect((await svc.issuePayslips({ year: 2031, month: 3 }))).toEqual({ issued: 0, existing: 2, failed: [] }); // once per row

    // Not requestable by HR or from the portal (only a reissue that supersedes).
    await expect(svc.createDocumentRequest({ typeKey: 'PAYSLIP', employeeId: a.employeeId, params: { payrollId: ra.id }, source: 'HR' }, hr(), renderer)).rejects.toThrow(/آلياً/);

    // A month whose render fails stays APPROVED and does not block the next month.
    const rb4 = await row(b.employeeId, 4);
    await prisma.$transaction((tx) => markPayrollMonthPaid(tx, 2031, 4));
    const broken = { id: 'typst' as const, render: async () => { throw new RenderError('down', 'SERVICE_UNAVAILABLE', true); } };
    const stuck = await svc.createDocumentRequest({ typeKey: 'PAYSLIP', employeeId: b.employeeId, params: { language: 'ar', payrollId: rb4.id }, source: 'SYSTEM', sourceRef: `payroll:${rb4.id}` }, svc.SYSTEM_ACTOR, broken);
    expect(stuck.status).toBe('APPROVED');
    const rb5 = await row(b.employeeId, 5);
    await prisma.$transaction((tx) => markPayrollMonthPaid(tx, 2031, 5));
    expect((await svc.issuePayslips({ year: 2031, month: 5 })).issued).toBe(1);
    expect(rb5.id).toBeTruthy();
    expect(rb.id).toBeTruthy();
  });

  it('exit acceptance: suggested once when a resignation is approved with its last working day, then issued on approval', async () => {
    const e = await newEmployee(1101);
    const t = await prisma.terminationRequest.create({ data: { employeeId: e.employeeId, terminationType: 'RESIGNATION', status: 'PENDING' } });
    expect((await svc.suggestExitAcceptance(t.id)).outcome).toBe('SKIPPED'); // not approved yet
    await prisma.terminationRequest.update({ where: { id: t.id }, data: { status: 'APPROVED', hrApprovedAt: new Date(), lastWorkingDate: new Date('2026-10-30T21:00:00Z') } });
    expect((await svc.suggestExitAcceptance(t.id)).outcome).toBe('CREATED');
    expect((await svc.suggestExitAcceptance(t.id)).outcome).toBe('EXISTS');
    const req = await prisma.documentRequest.findFirstOrThrow({ where: { sourceRef: `termination:${t.id}` }, include: { currentSnapshot: true } });
    expect([req.source, req.status]).toEqual(['SYSTEM', 'PENDING_APPROVAL']);
    expect(JSON.parse(req.currentSnapshot!.data).data.exit).toMatchObject({ kind: 'RESIGNATION', lastWorkingDate: '2026-10-31' });
    const out = await svc.approveDocumentRequest(req.id, req.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(out.status).toBe('ISSUED');
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: out.documentId! } })).number).toMatch(/^TST-RSG-/);
  });

  it('termination notice: second-person approval, Article 80 tied to the investigation, acknowledged by the employee', async () => {
    const e = await newEmployee(1201);
    const inv = await prisma.investigation.create({ data: { employeeId: e.employeeId, subject: 'غياب متصل', status: 'OPENED' } });
    const params = { language: 'ar', terminationNotice: { reason: 'ARTICLE_80', lastWorkingDate: '2026-10-15', investigationId: inv.id } };
    await expect(svc.createDocumentRequest({ typeKey: 'TERMINATION_NOTICE', employeeId: e.employeeId, params, source: 'HR' }, hr(), renderer)).rejects.toThrow(/لم ينته بقرار إدانة/);
    await prisma.investigation.update({ where: { id: inv.id }, data: { status: 'COMPLETED_GUILTY' } });
    const r = await svc.createDocumentRequest({ typeKey: 'TERMINATION_NOTICE', employeeId: e.employeeId, params, source: 'HR' }, hr(), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    await expect(svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer)).rejects.toThrow(/شخص آخر/);
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null }, renderer);
    expect(out.status).toBe('ISSUED');
    await svc.acknowledgeDocument(out.documentId!, { comment: null }, self(e.employeeId, e.userId));
    expect((await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId: out.documentId! } })).decision).toBe('RECEIVED');
  });

  it('salary transfer: waits for approval even with an accepted pre-authorization; later bank changes are flagged', async () => {
    const { encryptField } = await import('@/lib/crypto');
    const { salaryTransferConflict } = await import('@/lib/documents/queries');
    const iban = 'SA0380000000608010167519';
    const e = await newEmployee(1301, { bankName: 'مصرف الراجحي', ibanNumber: encryptField(iban) });
    await prisma.documentTypeSetting.create({ data: { companyId, typeKey: 'SALARY_TRANSFER', signatoryId, requiresApproval: false } });
    await prisma.signingAuthorization.create({ data: { signatoryId, legalCompanyId: companyId, typeKey: 'SALARY_TRANSFER', validFrom: new Date('2026-01-01'), grantedById: signatoryUserId, acceptedAt: new Date() } });
    const r = await svc.createDocumentRequest({ typeKey: 'SALARY_TRANSFER', employeeId: e.employeeId, params: { language: 'ar' }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    expect(r.status).toBe('PENDING_APPROVAL'); // a financial commitment: always a human
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect(JSON.parse(req.currentSnapshot!.data).data.bank).toEqual({ name: 'مصرف الراجحي', iban });
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(out.status).toBe('ISSUED');

    expect(await salaryTransferConflict(e.employeeId, encryptField(iban), 'مصرف الراجحي')).toBeNull();
    expect(await salaryTransferConflict(e.employeeId, encryptField('SA4420000001234567891234'), 'البنك الأهلي')).toMatch(/خطاب تحويل راتب ساري .*TST-STF-/);
  });

  it('promotion decision: applied on issuance when due, later by the job when future; revocation cancels a pending order only', async () => {
    const { runJob } = await import('../../../scripts/jobs.mjs');
    const checker = { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null };
    const issue = async (employeeId: string, promotion: Record<string, unknown>) => {
      const r = await svc.createDocumentRequest({ typeKey: 'PROMOTION_DECISION', employeeId, params: { language: 'ar', promotion }, source: 'HR' }, hr(), renderer);
      expect(r.status).toBe('PENDING_APPROVAL');
      const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
      await expect(svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer)).rejects.toThrow(/شخص آخر/);
      const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, checker, renderer);
      expect(out.status).toBe('ISSUED');
      return out.documentId!;
    };

    // Effective today: applied at issuance (file + SalaryChange + order).
    const a = await newEmployee(1401);
    const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const docA = await issue(a.employeeId, { newJobTitleAr: 'مهندس أول', newBasicSalary: 11000, effectiveDate: today });
    const empA = await prisma.employee.findUniqueOrThrow({ where: { id: a.employeeId } });
    expect([empA.basicSalary, empA.jobTitle]).toEqual([11000, 'مهندس أول']);
    expect(await prisma.salaryChange.count({ where: { employeeId: a.employeeId, isPlanned: false, basicSalary: 11000 } })).toBe(1);
    await expect(svc.revokeIssuedDocument(docA, 'خطأ', hr())).rejects.toThrow(/نُفّذ على ملف الموظف/);

    // Future date: nothing yet; the job applies it once the date comes.
    const b = await newEmployee(1402);
    await issue(b.employeeId, { newBasicSalary: 12000, effectiveDate: '2099-01-01' });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: b.employeeId } })).basicSalary).toBe(9500);
    await runJob(prisma, 'apply-employee-changes', { now: new Date('2099-01-01T08:00:00Z') });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: b.employeeId } })).basicSalary).toBe(12000);

    // Future + revoked before the date: cancelled, never applied.
    const c = await newEmployee(1403);
    const docC = await issue(c.employeeId, { newBasicSalary: 13000, effectiveDate: '2098-01-01' });
    await svc.revokeIssuedDocument(docC, 'تراجع', hr());
    await runJob(prisma, 'apply-employee-changes', { now: new Date('2098-06-01T08:00:00Z') });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: c.employeeId } })).basicSalary).toBe(9500);
    const order = await prisma.employeeChangeOrder.findUniqueOrThrow({ where: { documentId: docC } });
    expect([order.appliedAt, order.cancelledAt === null]).toEqual([null, false]);
    await expect(prisma.employeeChangeOrder.update({ where: { id: order.id }, data: { cancelledAt: null } })).rejects.toThrow(/decided by its document/);
  });

  it('job offer: to a candidate, second-person approval, private link, answered once, purged after the candidate retention', async () => {
    const cand = await import('@/lib/documents/candidate');
    const { runJob } = await import('../../../scripts/jobs.mjs');
    const hrEmployee = await newEmployee(1501);
    const jr = await prisma.jobRequest.create({ data: { requesterId: hrEmployee.employeeId, jobTitle: 'محاسب', jobType: 'كامل', nationality: 'غير محدد', description: 'x', status: 'APPROVED' } });
    const app = await prisma.jobApplication.create({ data: { jobRequestId: jr.id, candidateName: 'سارة أحمد', candidatePhone: '0500000000', candidateEmail: `cand-${tag}@example.test`, status: 'INTERVIEW' } });
    const offer = { legalCompanyId: companyId, jobTitleAr: 'محاسبة', basicSalary: 8000, housingAllowance: 2000, startDate: '2026-11-01', probationDays: 90, annualLeaveDays: 21 };

    // Only HR, never with an employee, exactly one subject (also a DB CHECK).
    await expect(svc.createDocumentRequest({ typeKey: 'JOB_OFFER', employeeId: hrEmployee.employeeId, params: { offer }, source: 'HR' }, hr(), renderer)).rejects.toThrow(/لمرشح/);
    await expect(prisma.documentRequest.create({ data: { typeKey: 'JOB_OFFER', legalCompanyId: companyId, source: 'HR', paramsJson: '{}', status: 'CANCELLED' } })).rejects.toThrow();

    const r = await svc.createDocumentRequest({ typeKey: 'JOB_OFFER', jobApplicationId: app.id, params: { language: 'ar', offer }, source: 'HR' }, hr(), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect([req.employeeId, req.jobApplicationId]).toEqual([null, app.id]);
    await expect(svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer)).rejects.toThrow(/شخص آخر/);
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null }, renderer);
    expect(out.status).toBe('ISSUED');
    const doc = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: out.documentId! } });
    expect([doc.employeeId, doc.jobApplicationId, doc.validUntil !== null]).toEqual([null, app.id, true]);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('OFFERED');

    // The candidate email carries the link, no personal data; HR can copy the same link.
    const mail = await prisma.notificationOutbox.findFirstOrThrow({ where: { idempotencyKey: `doc:offer:${doc.id}` } });
    expect(mail.recipient).toBe(`cand-${tag}@example.test`);
    expect(mail.body).not.toMatch(/سارة|8000|محاسبة/);
    const link = await cand.candidateLinkOf(doc.id);
    expect(mail.body).toContain(link!.url);
    const token = link!.url.split('/offer/')[1];

    // Through the link: view, PDF, answer once. A wrong token looks like nothing.
    expect(await cand.candidateOffer('A'.repeat(26))).toBeNull();
    expect(await cand.candidateOffer(token)).toMatchObject({ candidateName: 'سارة أحمد', status: 'OPEN', expired: false });
    expect((await cand.candidateOfferPdf(token, null))!.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await cand.answerOffer(token, 'ACCEPTED', null, '10.0.0.9');
    await expect(cand.answerOffer(token, 'DECLINED', 'x', null)).rejects.toThrow(/مسبقاً/);
    expect((await cand.candidateOffer(token))?.status).toBe('ACCEPTED');
    const ack = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect([ack.via, ack.userId, ack.employeeId, ack.decision]).toEqual(['LINK', null, null, 'ACCEPTED']);
    expect(await prisma.notificationOutbox.count({ where: { idempotencyKey: { startsWith: `doc:offer-answer:${doc.id}` } } })).toBe(2); // issuer + approver
    // Staff only: an employee account never reads a candidate document.
    await expect(svc.readIssuedDocument(doc.id, self(hrEmployee.employeeId, hrEmployee.userId))).rejects.toThrow(/غير موجود/);
    await expect(prisma.candidateDocumentAccess.update({ where: { documentId: doc.id }, data: { expiresAt: new Date() } })).rejects.toThrow(/append-only/);

    // Candidate retention: 2 years after issuance by default.
    await runJob(prisma, 'documents-retention', { now: new Date(Date.now() + 366 * 86400e3), env: { ...process.env } });
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } })).purgedAt).toBeNull();
    await runJob(prisma, 'documents-retention', { now: new Date(Date.now() + 3 * 366 * 86400e3), env: { ...process.env } });
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } })).purgedAt).not.toBeNull();
    expect(await cand.candidateOfferPdf(token, null)).toBeNull();
  });

  it('leave letter: issued automatically, reissued on new dates, revoked on cancellation; never for sick leave', async () => {
    const e = await newEmployee(1601);
    const lv = await prisma.leave.create({
      data: { employeeId: e.employeeId, leaveType: 'ANNUAL', status: 'APPROVED', startDate: new Date('2026-12-01T21:00:00Z'), endDate: new Date('2026-12-20T21:00:00Z'), totalDays: 20, isOutsideKSA: true },
    });
    expect(await svc.syncLeaveLetter(lv.id)).toBe('ISSUED');
    expect(await svc.syncLeaveLetter(lv.id)).toBe('UP_TO_DATE');
    const first = await prisma.issuedDocument.findFirstOrThrow({ where: { typeKey: 'LEAVE_APPROVAL', employeeId: e.employeeId }, include: { request: true } });
    expect([first.status, first.signatoryId, first.approvalId, first.templateRef]).toEqual(['ISSUED', null, null, 'typst:leave-approval/ar-en@1']);

    await prisma.leave.update({ where: { id: lv.id }, data: { endDate: new Date('2026-12-25T21:00:00Z'), totalDays: 25 } });
    expect(await svc.syncLeaveLetter(lv.id)).toBe('ISSUED');
    // issuedAt is whole seconds (the PDF timestamp): two letters in the same second tie, so order by creation.
    const docs = await prisma.issuedDocument.findMany({ where: { typeKey: 'LEAVE_APPROVAL', employeeId: e.employeeId }, orderBy: { createdAt: 'asc' } });
    expect(docs.map((d) => d.status)).toEqual(['REVOKED', 'ISSUED']);

    await prisma.leave.update({ where: { id: lv.id }, data: { status: 'CANCELLED' } });
    expect(await svc.syncLeaveLetter(lv.id)).toBe('REVOKED');
    expect(await prisma.issuedDocument.count({ where: { typeKey: 'LEAVE_APPROVAL', employeeId: e.employeeId, status: 'ISSUED' } })).toBe(0);

    const sick = await prisma.leave.create({ data: { employeeId: e.employeeId, leaveType: 'SICK', status: 'APPROVED', startDate: new Date('2027-01-01T21:00:00Z'), endDate: new Date('2027-01-03T21:00:00Z'), totalDays: 3 } });
    expect(await svc.syncLeaveLetter(sick.id)).toBe('NONE');
  });

  it('evaluation report: issued automatically once the evaluation is closed, once', async () => {
    const e = await newEmployee(1701);
    const t = await prisma.evaluationTemplate.create({ data: { name: 'عام', sections: { create: [{ title: 'الأداء', weight: 100, items: { create: [{ title: 'إنجاز المهام' }] } }] } }, include: { sections: { include: { items: true } } } });
    const cycle = await prisma.evaluationCycle.create({ data: { title: 'تقييم 2026', templateId: t.id, startDate: new Date('2026-01-01'), endDate: new Date('2026-06-30') } });
    const ev = await prisma.employeeEvaluation.create({
      data: { cycleId: cycle.id, employeeId: e.employeeId, status: 'PENDING_EMPLOYEE_ACK', totalScore: 90, finalRating: 'ممتاز 🌟', strengths: 'الالتزام', itemScores: { create: [{ itemId: t.sections[0].items[0].id, score: 5 }] } },
    });
    expect(await svc.issueEvaluationReport(ev.id)).toBe('NONE'); // not closed yet
    await prisma.employeeEvaluation.update({ where: { id: ev.id }, data: { status: 'CLOSED', employeeAcknowledgedAt: new Date(), employeeComment: 'شكرا' } });
    expect(await svc.issueEvaluationReport(ev.id)).toBe('ISSUED');
    expect(await svc.issueEvaluationReport(ev.id)).toBe('EXISTS');
    const doc = await prisma.issuedDocument.findFirstOrThrow({ where: { typeKey: 'EVALUATION_REPORT', employeeId: e.employeeId }, include: { snapshot: true } });
    expect([doc.signatoryId, doc.approvalId]).toEqual([null, null]);
    expect(JSON.parse(doc.snapshot.data).data.evaluation.finalRating).toBe('ممتاز'); // the emoji was dropped, the render did not fail
  });

  it('investigation minutes: suggested on conclusion, second-person approval, hidden until issued, acknowledged', async () => {
    const e = await newEmployee(1801);
    const inv = await prisma.investigation.create({ data: { employeeId: e.employeeId, subject: 'غياب متصل', status: 'IN_PROGRESS', findings: 'ثبت الغياب' } });
    expect(await svc.suggestInvestigationMinutes(inv.id)).toBe('NONE');
    await prisma.investigation.update({ where: { id: inv.id }, data: { status: 'COMPLETED_GUILTY', penaltyDays: 2 } });
    expect(await svc.suggestInvestigationMinutes(inv.id)).toBe('CREATED');
    expect(await svc.suggestInvestigationMinutes(inv.id)).toBe('EXISTS');
    const req = await prisma.documentRequest.findFirstOrThrow({ where: { sourceRef: `investigation:${inv.id}` }, include: { currentSnapshot: true } });
    expect([req.source, req.status]).toEqual(['SYSTEM', 'PENDING_APPROVAL']);
    const { myDocumentRequests } = await import('@/lib/documents/queries');
    // Locked: not shown to the employee before issuance even though the system created it, and not cancellable by him.
    expect((await myDocumentRequests(e.employeeId)).some((x) => x.id === req.id)).toBe(false);
    await expect(svc.cancelDocumentRequest(req.id, self(e.employeeId, e.userId))).rejects.toThrow(/غير موجود/);
    const out = await svc.approveDocumentRequest(req.id, req.currentSnapshot!.dataSha256, null, hr(), renderer);
    expect(out.status).toBe('ISSUED');
    await svc.acknowledgeDocument(out.documentId!, { comment: 'لي اعتراض على المدة' }, self(e.employeeId, e.userId));
  });

  it('company texts: owner-only, versioned, part of the snapshot; a change invalidates a pending approval', async () => {
    const { applySettingsAction } = await import('@/lib/documents/settings');
    const owner = { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null };
    await expect(applySettingsAction({ action: 'text', companyId, typeKey: 'EMPLOYMENT_CERTIFICATE', slot: 'CLOSING', textAr: 'x', textEn: null }, hr())).rejects.toThrow(/للمالك/);
    await applySettingsAction({ action: 'text', companyId, typeKey: 'EMPLOYMENT_CERTIFICATE', slot: 'CLOSING', textAr: 'للاستفسار: إدارة الموارد البشرية', textEn: null }, owner);

    const e = await newEmployee(1901);
    await prisma.documentTypeSetting.update({ where: { companyId_typeKey: { companyId, typeKey: 'EMPLOYMENT_CERTIFICATE' } }, data: { requiresApproval: true } });
    const r = await svc.createDocumentRequest({ typeKey: 'EMPLOYMENT_CERTIFICATE', employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect(JSON.parse(req.currentSnapshot!.data).data.texts).toMatchObject({ closingAr: 'للاستفسار: إدارة الموارد البشرية', openingAr: null });

    // The owner changes the wording before approval: the old approval target is stale.
    await applySettingsAction({ action: 'text', companyId, typeKey: 'EMPLOYMENT_CERTIFICATE', slot: 'CLOSING', textAr: 'نص جديد', textEn: null }, owner);
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, owner, renderer);
    expect(out.status).toBe('PENDING_APPROVAL'); // approved the old text -> invalidated, a new snapshot waits
    const fresh = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect(JSON.parse(fresh.currentSnapshot!.data).data.texts.closingAr).toBe('نص جديد');
    expect((await svc.approveDocumentRequest(r.requestId, fresh.currentSnapshot!.dataSha256, null, owner, renderer)).status).toBe('ISSUED');

    const row = await prisma.documentTextOverride.findFirstOrThrow({ where: { companyId, typeKey: 'EMPLOYMENT_CERTIFICATE' } });
    await expect(prisma.documentTextOverride.update({ where: { id: row.id }, data: { textAr: 'x' } })).rejects.toThrow(/append-only/);
    await prisma.documentTypeSetting.update({ where: { companyId_typeKey: { companyId, typeKey: 'EMPLOYMENT_CERTIFICATE' } }, data: { requiresApproval: null } });
    await applySettingsAction({ action: 'text', companyId, typeKey: 'EMPLOYMENT_CERTIFICATE', slot: 'CLOSING', textAr: '', textEn: '' }, owner); // cleared for later tests
  });

  it('contract addendum: second-person approval; nothing changes until the employee accepts by the effective date; a decline or no answer changes nothing', async () => {
    const { runJob } = await import('../../../scripts/jobs.mjs');
    const checker = { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null };
    const riyadh = (offsetDays: number) => new Date(Date.now() + 3 * 3600e3 + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const [b1, b2] = await Promise.all(['فرع الرياض', 'فرع جدة'].map((nameArabic) => prisma.branch.create({ data: { companyId, nameArabic } })));
    const issue = async (employeeId: string, addendum: Record<string, unknown>) => {
      const r = await svc.createDocumentRequest({ typeKey: 'CONTRACT_ADDENDUM', employeeId, params: { language: 'ar', addendum }, source: 'HR' }, hr(), renderer);
      expect(r.status).toBe('PENDING_APPROVAL');
      const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
      await expect(svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, hr(), renderer)).rejects.toThrow(/شخص آخر/);
      const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, checker, renderer);
      expect(out.status).toBe('ISSUED');
      return out.documentId!;
    };

    // Effective today, accepted: applied at once (salary + housing + branch + contract end), once.
    const a = await newEmployee(2501, { branchId: b1.id });
    const today = riyadh(0);
    const docA = await issue(a.employeeId, { effectiveDate: today, newBasicSalary: 10500, newHousingAllowance: 2625, newTransportAllowance: 700, newBranchId: b2.id, newContractEndDate: '2029-12-31' });
    expect(await prisma.employeeChangeOrder.count({ where: { documentId: docA } })).toBe(0); // issued, not yet accepted
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: a.employeeId } })).basicSalary).toBe(9500);
    const token = tokenOfLastRender();
    expect((await svc.verifyDocumentToken(token, null))?.consent).toMatchObject({ status: 'PENDING' });
    await expect(svc.acknowledgeDocument(docA, { decision: 'DISPUTED', comment: 'x'.repeat(10) }, self(a.employeeId, a.userId))).rejects.toThrow(/الموافقة على الملحق أو رفضه/);
    const other = await newEmployee(2502);
    await expect(svc.acknowledgeDocument(docA, { decision: 'ACCEPTED', comment: null }, self(other.employeeId, other.userId))).rejects.toThrow(/غير موجود/);

    await svc.acknowledgeDocument(docA, { decision: 'ACCEPTED', comment: null }, self(a.employeeId, a.userId));
    const empA = await prisma.employee.findUniqueOrThrow({ where: { id: a.employeeId }, include: { allowances: true } });
    expect([empA.basicSalary, empA.branchId, empA.contractEndDate?.toISOString()]).toEqual([10500, b2.id, '2029-12-30T21:00:00.000Z']);
    expect(empA.allowances.filter((x) => x.isMonthly).map((x) => [x.allowanceType, x.amount]).sort()).toEqual([['HOUSING', 2625], ['TRANSPORT', 700]]);
    expect(await prisma.salaryChange.count({ where: { employeeId: a.employeeId, isPlanned: false, basicSalary: 10500 } })).toBe(1);
    expect((await prisma.employeeChangeOrder.findUniqueOrThrow({ where: { documentId: docA } })).appliedAt).not.toBeNull();
    expect((await svc.verifyDocumentToken(token, null))?.consent).toMatchObject({ status: 'ACCEPTED' });
    await expect(svc.acknowledgeDocument(docA, { decision: 'DECLINED', comment: null }, self(a.employeeId, a.userId))).rejects.toThrow(/مسبقاً/);
    await expect(svc.revokeIssuedDocument(docA, 'خطأ', hr())).rejects.toThrow(/نُفّذ على ملف الموظف/);

    // Future date, accepted: the order waits; the job applies it on the date.
    const b = await newEmployee(2503);
    const docB = await issue(b.employeeId, { effectiveDate: '2097-01-01', newJobTitleAr: 'مهندس مدني أول' });
    await svc.acknowledgeDocument(docB, { decision: 'ACCEPTED', comment: 'موافق' }, self(b.employeeId, b.userId));
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: b.employeeId } })).jobTitle).toBe('مهندس مدني');
    await runJob(prisma, 'apply-employee-changes', { now: new Date('2097-01-01T08:00:00Z') });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: b.employeeId } })).jobTitle).toBe('مهندس مدني أول');

    // Declined: no order, nothing changes; HR is told.
    const c = await newEmployee(2504);
    const docC = await issue(c.employeeId, { effectiveDate: riyadh(10), newBasicSalary: 8000 });
    await svc.acknowledgeDocument(docC, { decision: 'DECLINED', comment: null }, self(c.employeeId, c.userId));
    expect(await prisma.employeeChangeOrder.count({ where: { documentId: docC } })).toBe(0);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: c.employeeId } })).basicSalary).toBe(9500);

    // Past the effective date: the answer is refused (HR issues a new addendum).
    const d = await newEmployee(2505);
    const docD = await issue(d.employeeId, { effectiveDate: riyadh(-1), newBasicSalary: 9900 });
    await expect(svc.acknowledgeDocument(docD, { decision: 'ACCEPTED', comment: null }, self(d.employeeId, d.userId))).rejects.toThrow(/انتهت مهلة الرد/);

    // Revoked before an answer: the employee can no longer accept it.
    const e = await newEmployee(2506);
    const docE = await issue(e.employeeId, { effectiveDate: riyadh(5), newBasicSalary: 9900 });
    await svc.revokeIssuedDocument(docE, 'خطأ في المبلغ', hr());
    await expect(svc.acknowledgeDocument(docE, { decision: 'ACCEPTED', comment: null }, self(e.employeeId, e.userId))).rejects.toThrow(/ملغى أو مستبدل/);
    expect(await prisma.employeeChangeOrder.count({ where: { documentId: docE } })).toBe(0);
  });

  it('work commencement: automatic unsigned notice once per confirmed event; the signed letter on request goes through approval', async () => {
    const e = await newEmployee(2601);
    const lv = await prisma.leave.create({
      data: { employeeId: e.employeeId, leaveType: 'ANNUAL', status: 'APPROVED', startDate: new Date('2026-08-31T21:00:00Z'), endDate: new Date('2026-09-09T21:00:00Z'), totalDays: 10 },
    });
    // Not confirmed yet: nothing.
    expect(await svc.issueCommencementNotice({ kind: 'RETURN', leaveId: lv.id })).toBe('NONE');
    await prisma.leave.update({ where: { id: lv.id }, data: { isReturned: true, actualReturnDate: new Date('2026-09-12T21:00:00Z') } });
    expect(await svc.issueCommencementNotice({ kind: 'RETURN', leaveId: lv.id })).toBe('ISSUED');
    expect(await svc.issueCommencementNotice({ kind: 'RETURN', leaveId: lv.id })).toBe('EXISTS');
    const notice = await prisma.issuedDocument.findFirstOrThrow({ where: { employeeId: e.employeeId, typeKey: 'WORK_COMMENCEMENT' }, include: { snapshot: true } });
    expect(notice.number).toMatch(/^TST-CMN-\d{4}-\d{6}$/);
    expect(notice.signatoryId).toBeNull(); // automatic: unsigned, no approval
    expect(JSON.parse(notice.snapshot.data!).data.commencement).toMatchObject({ kind: 'RETURN', requested: false, date: '2026-09-13', leave: { lateDays: 2 } });

    // Joining, and the sweep does not duplicate the return notice.
    expect(await svc.issueCommencementNotice({ kind: 'JOIN', employeeId: e.employeeId })).toBe('ISSUED');
    await svc.issueDueCommencementNotices();
    expect(await prisma.issuedDocument.count({ where: { employeeId: e.employeeId, typeKey: 'WORK_COMMENCEMENT' } })).toBe(2);

    // The notice cannot be requested by hand; the signed letter can, from the portal, and waits for approval.
    await expect(svc.createDocumentRequest({ typeKey: 'WORK_COMMENCEMENT', employeeId: e.employeeId, params: { language: 'ar', commencement: { kind: 'JOIN' } }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer)).rejects.toThrow(/آلياً/);
    await prisma.documentTypeSetting.create({ data: { companyId, typeKey: 'WORK_COMMENCEMENT_LETTER', signatoryId } });
    const r = await svc.createDocumentRequest({ typeKey: 'WORK_COMMENCEMENT_LETTER', employeeId: e.employeeId, params: { language: 'ar', commencement: { kind: 'RETURN' } }, source: 'PORTAL' }, self(e.employeeId, e.userId), renderer);
    expect(r.status).toBe('PENDING_APPROVAL');
    const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
    expect(JSON.parse(req.currentSnapshot!.data).data.commencement).toMatchObject({ kind: 'RETURN', requested: true, leave: { id: lv.id } }); // latest confirmed return
    const out = await svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null }, renderer);
    expect(out.status).toBe('ISSUED');
    expect((await prisma.issuedDocument.findUniqueOrThrow({ where: { id: out.documentId! } })).number).toMatch(/^TST-CML-/);

    // Someone else's leave is refused.
    const other = await newEmployee(2602);
    await expect(svc.createDocumentRequest({ typeKey: 'WORK_COMMENCEMENT_LETTER', employeeId: other.employeeId, params: { language: 'ar', commencement: { kind: 'RETURN', leaveId: lv.id } }, source: 'PORTAL' }, self(other.employeeId, other.userId), renderer)).rejects.toThrow();
  });

  it('PAdES seal: every issued PDF is sealed with the company key (one per company, stored encrypted), verifiable and tamper-evident', async () => {
    const e = await newEmployee(1900);
    // Issued whatever the earlier tests left in the policy: the signatory approves when approval is needed.
    const issue = async (typeKey: string) => {
      const r = await svc.createDocumentRequest({ typeKey, employeeId: e.employeeId, params: { language: 'ar' }, source: 'HR' }, hr(), renderer);
      if (r.status === 'ISSUED') return r;
      const req = await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { currentSnapshot: true } });
      return svc.approveDocumentRequest(r.requestId, req.currentSnapshot!.dataSha256, null, { userId: signatoryUserId, role: 'COMPANY_ADMIN', employeeId: null, ip: null }, renderer);
    };
    const r1 = await issue('EMPLOYMENT_CERTIFICATE');
    const token = tokenOfLastRender();
    const r2 = await issue('SALARY_CERTIFICATE');
    const [d1, d2] = await Promise.all([r1, r2].map((r) => prisma.issuedDocument.findUniqueOrThrow({ where: { id: r.documentId! } })));
    const keys = await prisma.documentSealKey.findMany({ where: { companyId } });
    expect(keys).toHaveLength(1); // created by the first issuance of the company, then reused
    expect(d1.sealKeyId).toBe(keys[0].id);
    expect(d2.sealKeyId).toBe(keys[0].id);
    expect(keys[0].keyEnc.startsWith('enc:')).toBe(true);
    expect(keys[0].keyEnc).not.toContain('PRIVATE KEY');
    expect(await prisma.documentEvent.count({ where: { type: 'SEAL_KEY_CREATED', metaJson: { contains: keys[0].id } } })).toBe(1);

    // The stored file is the sealed one (its hash is the recorded one), and the seal verifies.
    const { pdf } = await svc.readIssuedDocument(d1.id, hr());
    expect(pdf.toString('latin1')).toContain('/SubFilter/ETSI.CAdES.detached');
    const { hasOpenssl, opensslVerify } = await import('./seal-fixtures');
    if (hasOpenssl) {
      expect(opensslVerify(pdf, Buffer.from(keys[0].certDer))).toBe(true);
      const tampered = Buffer.from(pdf);
      tampered[2000] ^= 0x01;
      expect(opensslVerify(tampered, Buffer.from(keys[0].certDer))).toBe(false);
    }

    // Verification page: the certificate fingerprint and its public download.
    expect((await svc.verifyDocumentToken(token, null))?.sealFingerprint).toBe(keys[0].fingerprint);
    const cert = await svc.sealCertificateForToken(token);
    expect(cert?.certDer.equals(Buffer.from(keys[0].certDer))).toBe(true);
    expect(await svc.sealCertificateForToken('A'.repeat(26))).toBeNull();

    // Key guards: never changed or deleted, one active key per company, retired once.
    await expect(prisma.documentSealKey.update({ where: { id: keys[0].id }, data: { keyEnc: 'x' } })).rejects.toThrow(/immutable/);
    await expect(prisma.documentSealKey.delete({ where: { id: keys[0].id } })).rejects.toThrow(/never deleted/);
    await expect(prisma.documentSealKey.create({
      data: { companyId, certDer: Buffer.from('x'), keyEnc: 'x', fingerprint: randomUUID(), serialHex: '01', notBefore: new Date(), notAfter: new Date() },
    })).rejects.toThrow();
    await expect(prisma.issuedDocument.update({ where: { id: d1.id }, data: { sealKeyId: null } })).rejects.toThrow(/immutable/);
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
