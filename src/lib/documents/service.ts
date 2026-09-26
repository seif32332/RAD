// Document issuance pipeline (SPEC §5-§6, ADR-001). Every state change goes through here.
//
//   create ─► snapshot ─► (stale? invalidate approvals, new snapshot) ─► signature decision
//          ─► needs approval? PENDING_APPROVAL : reserve number (tx) ─► render ─► store once
//          ─► IssuedDocument (tx) ─► ISSUED
//
// Business state lives on DocumentRequest / IssuedDocument; rendering progress on
// DocumentRenderJob only (DOC-08). Numbers and the issuance instant are reserved before rendering
// and never change across retries (DOC-02), so a retry renders the very same bytes.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { decryptField, encryptField } from '@/lib/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { canonicalJson, formatDocumentNumber, hashVerifyToken, newVerifyToken, riyadhDate, riyadhYear, sha256Hex, TOKEN_RE } from './core';
import { appendEvent, truncateIp } from './events';
import { employeeUserId, enqueueNotice } from './notify';
import {
  computeValidUntil, decideSignature, effectivePolicy, needsApproval, validityStatus,
  type ApprovalRow, type AuthorizationRow, type SignatoryRow,
} from './policy';
import { qrSvg, verifyUrl } from './qr';
import { buildRenderModel, type BrandSnapshot, type SignatureBlock } from './render-model';
import { RenderError, renderServiceConfig, typstServiceRenderer, type DocumentRenderer } from './renderer';
import { readAsset, readIssuedPdf, storeIssuedPdf } from './storage';
import { loadTemplate } from './templates';
import {
  buildContractData, ContractValidationError, getDocumentType, paramsSchema,
  type DocumentParams, type DocumentTypeDefinition, type EmployeeRecord,
} from './types';

export interface Actor {
  userId: string | null;
  role: string | null;
  employeeId: string | null;
  ip: string | null;
}

export const SYSTEM_ACTOR: Actor = { userId: null, role: null, employeeId: null, ip: null };

type Tx = Prisma.TransactionClient;
type SnapshotBrand = BrandSnapshot & { numberPrefix: string | null; logoStoredName: string | null };

const MAX_RENDER_ATTEMPTS = 8;
const STUCK_RENDER_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const EMPLOYEE_SELECT = {
  id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, firstNameEnglish: true, lastNameEnglish: true,
  nationality: true, iqamaOrIdNumber: true, idType: true, passportNumber: true, jobTitle: true, jobTitleEnglish: true,
  joinDate: true, basicSalary: true, isTerminated: true, terminationDate: true, legalCompanyId: true,
  allowances: { select: { name: true, amount: true, isMonthly: true, allowanceType: true } },
} as const;

async function loadEmployee(db: Tx, employeeId: string): Promise<EmployeeRecord> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: EMPLOYEE_SELECT });
  if (!e) throw notFound('الموظف غير موجود');
  return { ...e, idType: e.idType ?? null };
}

async function loadBrand(db: Tx, companyId: string): Promise<SnapshotBrand> {
  const b = await db.brandProfile.findUnique({ where: { companyId } });
  let logo: { sha256: string; storedName: string } | null = null;
  if (b?.logoAssetId) {
    logo = await db.documentAsset.findFirst({ where: { id: b.logoAssetId, companyId, kind: 'LOGO' }, select: { sha256: true, storedName: true } });
  }
  return {
    numberPrefix: b?.numberPrefix ?? null,
    primaryColor: b?.primaryColor ?? '#0F4C81',
    numerals: b?.numerals === 'arab' ? 'arab' : 'latn',
    addressAr: b?.addressAr ?? null,
    addressEn: b?.addressEn ?? null,
    phone: b?.phone ?? null,
    email: b?.email ?? null,
    logoSha256: logo?.sha256 ?? null,
    logoStoredName: logo?.storedName ?? null,
  };
}

async function loadPolicy(db: Tx, def: DocumentTypeDefinition, companyId: string) {
  const setting = await db.documentTypeSetting.findUnique({ where: { companyId_typeKey: { companyId, typeKey: def.key } } });
  return effectivePolicy(def, setting);
}

async function loadSignatory(db: Tx, signatoryId: string | null): Promise<(SignatoryRow & { nameAr: string; nameEn: string | null; titleAr: string; titleEn: string | null }) | null> {
  if (!signatoryId) return null;
  return db.signatory.findUnique({ where: { id: signatoryId } });
}

function parseParams(json: string): DocumentParams {
  return paramsSchema.parse(JSON.parse(json));
}

/** Material content of a request (DOC-05): its hash decides whether an approval is still valid. */
async function buildMaterialSnapshot(db: Tx, def: DocumentTypeDefinition, employeeId: string, params: DocumentParams) {
  const employee = await loadEmployee(db, employeeId);
  if (!employee.legalCompanyId) {
    throw badRequest('الشركة النظامية غير محددة في ملف الموظف؛ لا يصدر المستند حتى تُستكمل (DOC-03)');
  }
  const company = await db.company.findUnique({
    where: { id: employee.legalCompanyId },
    select: { id: true, nameArabic: true, nameEnglish: true, commercialRegNum: true, unifiedNumber: true },
  });
  if (!company) throw badRequest('الشركة النظامية للموظف غير موجودة');
  let data: Record<string, unknown>;
  try {
    data = buildContractData(def, { employee, company, params });
  } catch (e) {
    if (e instanceof ContractValidationError) throw new HttpError(422, e.message, { errors: e.errors });
    throw e;
  }
  const policy = await loadPolicy(db, def, company.id);
  const material = {
    typeKey: def.key,
    contractVersion: def.contractVersion,
    legalCompanyId: company.id,
    signatoryId: policy.signatoryId,
    params,
    data,
  };
  const text = canonicalJson(material);
  return { text, sha256: sha256Hex(text), legalCompanyId: company.id, policy, data, employee };
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

function isStaffFor(def: DocumentTypeDefinition, actor: Actor): boolean {
  return !!actor.role && roleIn(actor.role, def.staffRoles);
}

/**
 * Legal companies a back-office user may act on for documents (UserCompanyScope, SPEC §10):
 * null = all companies (owners always; any user without scope rows).
 */
export async function staffCompanyScope(db: Tx, actor: Actor): Promise<string[] | null> {
  if (!actor.userId || !actor.role || roleIn(actor.role, ROLE_GROUPS.OWNER)) return null;
  const rows = await db.userCompanyScope.findMany({ where: { userId: actor.userId }, select: { companyId: true } });
  return rows.length ? rows.map((r) => r.companyId) : null;
}

/** Staff of this type AND within the user's company scope. */
export async function staffCan(db: Tx, def: DocumentTypeDefinition, actor: Actor, legalCompanyId: string): Promise<boolean> {
  if (!isStaffFor(def, actor)) return false;
  const scope = await staffCompanyScope(db, actor);
  return !scope || scope.includes(legalCompanyId);
}

/** Who may see a request / document: the employee himself, or staff of that type within scope. */
export async function canSee(db: Tx, def: DocumentTypeDefinition, actor: Actor, employeeId: string, legalCompanyId: string): Promise<boolean> {
  return (!!actor.employeeId && actor.employeeId === employeeId) || staffCan(db, def, actor, legalCompanyId);
}

async function isCompanySignatoryUser(db: Tx, userId: string | null, companyId: string): Promise<boolean> {
  if (!userId) return false;
  return !!(await db.signatory.findFirst({ where: { userId, companyId, isActive: true }, select: { id: true } }));
}

// ---------------------------------------------------------------------------
// Readiness: a request is only created when it can be issued (no request stranded in DRAFT)
// ---------------------------------------------------------------------------

export async function issuanceReadiness(db: Tx, legalCompanyId: string): Promise<{ ready: boolean; missing: string[] }> {
  const missing: string[] = [];
  const brand = await db.brandProfile.findUnique({ where: { companyId: legalCompanyId }, select: { numberPrefix: true } });
  if (!brand?.numberPrefix) missing.push('بادئة ترقيم المستندات للشركة');
  if (!process.env.APP_URL?.trim()) missing.push('عنوان النظام APP_URL (رابط التحقق)');
  if (!renderServiceConfig()) missing.push('خدمة إصدار المستندات RENDER_SERVICE_URL / RENDER_SERVICE_TOKEN');
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateRequestInput {
  typeKey: string;
  employeeId: string;
  params: unknown;
  source: 'PORTAL' | 'HR' | 'SYSTEM';
  /** Reissue: the new document supersedes this one when issued (DOC-09). */
  supersedesDocumentId?: string | null;
}

export async function createDocumentRequest(input: CreateRequestInput, actor: Actor, renderer: DocumentRenderer = typstServiceRenderer()) {
  const def = getDocumentType(input.typeKey);
  if (!def) throw badRequest('نوع مستند غير معروف');
  const params = paramsSchema.parse(input.params ?? {});

  if (input.source === 'PORTAL') {
    if (!actor.employeeId || actor.employeeId !== input.employeeId) throw forbidden('لا يمكنك طلب مستند لموظف آخر');
  } else if (input.source === 'HR' && !isStaffFor(def, actor)) {
    throw forbidden();
  }

  const requestId = await prisma.$transaction(async (tx) => {
    const snap = await buildMaterialSnapshot(tx, def, input.employeeId, params);
    if (!snap.policy.enabled) throw badRequest('هذا النوع من المستندات غير مفعّل لهذه الشركة');
    if (input.source === 'HR' && !(await staffCan(tx, def, actor, snap.legalCompanyId))) throw forbidden('الشركة النظامية لهذا الموظف خارج نطاق صلاحيتك');
    const readiness = await issuanceReadiness(tx, snap.legalCompanyId);
    if (!readiness.ready) throw new HttpError(503, `إصدار المستندات غير مهيأ لهذه الشركة: ${readiness.missing.join('، ')}`, { missing: readiness.missing });
    if (input.source === 'PORTAL' && !snap.policy.selfService) throw forbidden('هذا المستند لا يُطلب من البوابة؛ تواصل مع الموارد البشرية');

    if (input.supersedesDocumentId) {
      const old = await tx.issuedDocument.findUnique({ where: { id: input.supersedesDocumentId } });
      if (!old || old.employeeId !== input.employeeId || old.typeKey !== def.key) throw badRequest('المستند المراد استبداله غير مطابق');
      if (old.status !== 'ISSUED') throw conflict('المستند المراد استبداله لم يعد سارياً');
      if (!isStaffFor(def, actor)) throw forbidden();
    }

    // One open request per employee and type: a double click must not issue twice. The advisory
    // lock serializes concurrent creations for the same employee + type before the check.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`doc-req:${input.employeeId}:${def.key}`}))`;
    const open = await tx.documentRequest.findFirst({
      where: { employeeId: input.employeeId, typeKey: def.key, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
      select: { id: true },
    });
    if (open) throw conflict('يوجد طلب مفتوح لنفس المستند؛ تابعه من قائمة الطلبات', { requestId: open.id });

    const brand = await loadBrand(tx, snap.legalCompanyId);
    const req = await tx.documentRequest.create({
      data: {
        typeKey: def.key,
        legalCompanyId: snap.legalCompanyId,
        employeeId: input.employeeId,
        requestedById: actor.userId,
        source: input.source,
        paramsJson: canonicalJson({ ...params, supersedesDocumentId: input.supersedesDocumentId ?? null }),
        status: 'DRAFT',
      },
    });
    const snapshot = await tx.documentSnapshot.create({
      data: { requestId: req.id, typeKey: def.key, contractVersion: def.contractVersion, data: snap.text, dataSha256: snap.sha256, brand: canonicalJson(brand) },
    });
    await tx.documentRequest.update({ where: { id: req.id }, data: { currentSnapshotId: snapshot.id } });
    await appendEvent(tx, { type: 'REQUEST_CREATED', requestId: req.id, actorId: actor.userId, ip: actor.ip, meta: { typeKey: def.key, source: input.source, language: params.language } });
    await appendEvent(tx, { type: 'SNAPSHOT_CREATED', requestId: req.id, actorId: actor.userId, meta: { snapshotId: snapshot.id, sha256: snap.sha256 } });
    return req.id;
  });

  return advanceRequest(requestId, actor, renderer);
}

// ---------------------------------------------------------------------------
// Advance: stale check, signature decision, approval gate, reservation
// ---------------------------------------------------------------------------

export interface AdvanceResult {
  requestId: string;
  status: string;
  documentId?: string;
  renderError?: { code: string; message: string; retryable: boolean };
}

async function currentState(requestId: string) {
  return prisma.documentRequest.findUnique({
    where: { id: requestId },
    include: { currentSnapshot: true, approvals: true, renderJob: true, issuedDocument: { select: { id: true } } },
  });
}

export async function advanceRequest(requestId: string, actor: Actor, renderer: DocumentRenderer = typstServiceRenderer()): Promise<AdvanceResult> {
  const reservedJobId = await prisma.$transaction(async (tx) => {
    const req = await tx.documentRequest.findUnique({
      where: { id: requestId },
      include: { currentSnapshot: true, approvals: true, renderJob: { select: { id: true } } },
    });
    if (!req) throw notFound('الطلب غير موجود');
    if (req.renderJob) return req.renderJob.id; // already reserved: just (re)try rendering
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(req.status)) return null;
    const def = getDocumentType(req.typeKey);
    if (!def) throw badRequest('نوع مستند غير معروف');
    const params = parseParams(req.paramsJson);

    // DOC-05: rebuild from the source; any material change invalidates approvals and makes a new snapshot.
    const snap = await buildMaterialSnapshot(tx, def, req.employeeId, params);
    let snapshotSha = req.currentSnapshot?.dataSha256 ?? null;
    let approvals: ApprovalRow[] = req.approvals;
    if (snapshotSha !== snap.sha256) {
      const now = new Date();
      const stale = req.approvals.filter((a) => !a.invalidatedAt);
      if (stale.length) {
        await tx.documentApproval.updateMany({ where: { id: { in: stale.map((a) => a.id) }, invalidatedAt: null }, data: { invalidatedAt: now, invalidReason: 'STALE_SNAPSHOT' } });
        await appendEvent(tx, { type: 'APPROVAL_INVALIDATED', requestId, actorId: actor.userId, meta: { approvals: stale.map((a) => a.id), reason: 'STALE_SNAPSHOT' } });
        approvals = req.approvals.map((a) => (a.invalidatedAt ? a : { ...a, invalidatedAt: now }));
      }
      const brand = await loadBrand(tx, snap.legalCompanyId);
      const s = await tx.documentSnapshot.create({
        data: { requestId, typeKey: def.key, contractVersion: def.contractVersion, data: snap.text, dataSha256: snap.sha256, brand: canonicalJson(brand) },
      });
      await tx.documentRequest.update({ where: { id: requestId }, data: { currentSnapshotId: s.id, legalCompanyId: snap.legalCompanyId } });
      await appendEvent(tx, { type: 'SNAPSHOT_CREATED', requestId, actorId: actor.userId, meta: { snapshotId: s.id, sha256: snap.sha256, replaced: snapshotSha } });
      snapshotSha = snap.sha256;
    }

    const signatory = await loadSignatory(tx, snap.policy.signatoryId);
    const authorizations: AuthorizationRow[] = signatory
      ? await tx.signingAuthorization.findMany({ where: { signatoryId: signatory.id, typeKey: def.key, legalCompanyId: snap.legalCompanyId } })
      : [];
    const totalSalary = (snap.data as { salary?: { total: string } }).salary?.total ?? null;
    const now = new Date();
    const decision = decideSignature({ signatory, legalCompanyId: snap.legalCompanyId, typeKey: def.key, snapshotSha256: snapshotSha!, approvals, authorizations, now, totalSalary });

    if (needsApproval(snap.policy, decision, approvals, snapshotSha!)) {
      if (req.status !== 'PENDING_APPROVAL') {
        await tx.documentRequest.update({ where: { id: requestId }, data: { status: 'PENDING_APPROVAL' } });
        await appendEvent(tx, { type: 'APPROVAL_REQUESTED', requestId, actorId: actor.userId, meta: { snapshotSha256: snapshotSha } });
        // The designated signatory is asked (HR sees the queue on /documents anyway).
        await enqueueNotice(tx, [signatory?.userId], `approval:${requestId}:${snapshotSha}`, { kind: 'APPROVAL_REQUESTED', typeLabel: def.labelAr });
      }
      return null;
    }

    // Reserve (DOC-02). Brand must carry the company's number prefix.
    const brand = await loadBrand(tx, snap.legalCompanyId);
    if (!brand.numberPrefix) throw new HttpError(422, 'بادئة ترقيم المستندات غير محددة لهذه الشركة؛ أكمل إعدادات هوية المستندات');
    if (!process.env.APP_URL?.trim()) throw new HttpError(503, 'عنوان النظام (APP_URL) غير مهيأ؛ لا يمكن إنشاء رابط التحقق');
    const moved = await tx.documentRequest.updateMany({ where: { id: requestId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { status: 'APPROVED' } });
    if (moved.count !== 1) return null; // someone else advanced it
    const year = riyadhYear(now);
    const [{ seq }] = await tx.$queryRaw<{ seq: number }[]>`
      INSERT INTO "DocumentCounter" ("legalCompanyId", "typeCode", "year", "next")
      VALUES (${snap.legalCompanyId}, ${def.code}, ${year}, 2)
      ON CONFLICT ("legalCompanyId", "typeCode", "year") DO UPDATE SET "next" = "DocumentCounter"."next" + 1
      RETURNING "next" - 1 AS seq`;
    const number = formatDocumentNumber(brand.numberPrefix, def.code, year, Number(seq));
    const token = newVerifyToken();
    const approval = approvals.find((a) => a.decision === 'APPROVED' && !a.invalidatedAt && a.snapshotSha256 === snapshotSha);
    const job = await tx.documentRenderJob.create({
      data: {
        requestId, legalCompanyId: snap.legalCompanyId, typeCode: def.code, year, seq: Number(seq), number,
        issuedAt: new Date(Math.floor(now.getTime() / 1000) * 1000), // whole seconds = the PDF creation timestamp
        verifyTokenHash: hashVerifyToken(token), verifyTokenEnc: encryptField(token),
        signatoryId: signatory?.id ?? null,
        authorizationId: decision.printImage ? decision.authorizationId : null,
        approvalId: approval?.id ?? null,
      },
    });
    await appendEvent(tx, { type: 'NUMBER_RESERVED', requestId, actorId: actor.userId, meta: { number, jobId: job.id } });
    return job.id;
  });

  if (reservedJobId) {
    const r = await processRenderJob(reservedJobId, actor, renderer);
    return { requestId, status: r.status, documentId: r.documentId, renderError: r.renderError };
  }
  const state = await currentState(requestId);
  return { requestId, status: state?.status ?? 'UNKNOWN', documentId: state?.issuedDocument?.id };
}

// ---------------------------------------------------------------------------
// Render + issue
// ---------------------------------------------------------------------------

/**
 * An asset file that is missing or does not match its hash will not fix itself: fail the job as
 * BLOCKED (not retried) with a message HR can act on, instead of retrying on a timer.
 */
async function assetFile(storedName: string, label: string): Promise<Buffer> {
  try {
    return await readAsset(storedName);
  } catch (e) {
    console.error(`[documents] asset ${storedName}:`, e instanceof Error ? e.message : e);
    throw new RenderError(`ملف ${label} غير موجود على الخادم أو تغيّر محتواه؛ أعد رفعه من إعدادات المستندات`, 'ASSET_FILE_MISSING', false);
  }
}

function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1)); // 30 s, 1 min, 2 min ... 1 h
}

export async function processRenderJob(jobId: string, actor: Actor = SYSTEM_ACTOR, renderer: DocumentRenderer = typstServiceRenderer()): Promise<AdvanceResult> {
  const now = new Date();
  const claimed = await prisma.documentRenderJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: { in: ['QUEUED', 'FAILED'] }, nextAttemptAt: { lte: now } },
        { status: 'RENDERING', updatedAt: { lt: new Date(now.getTime() - STUCK_RENDER_MS) } }, // crashed worker
      ],
    },
    data: { status: 'RENDERING', attempts: { increment: 1 } },
  });
  const job = await prisma.documentRenderJob.findUnique({ where: { id: jobId }, include: { request: { include: { currentSnapshot: true, approvals: true } } } });
  if (!job) throw notFound('مهمة الإصدار غير موجودة');
  if (claimed.count !== 1) {
    const state = await currentState(job.requestId);
    return { requestId: job.requestId, status: state?.status ?? job.request.status, documentId: state?.issuedDocument?.id };
  }

  const req = job.request;
  const def = getDocumentType(req.typeKey)!;
  const params = paramsSchema.parse(JSON.parse(req.paramsJson));
  const supersedesDocumentId = (JSON.parse(req.paramsJson) as { supersedesDocumentId?: string | null }).supersedesDocumentId ?? null;
  try {
    const snapshot = req.currentSnapshot!;
    const material = JSON.parse(snapshot.data) as { data: Parameters<typeof buildRenderModel>[0] };
    const brand = JSON.parse(snapshot.brand) as SnapshotBrand;
    const token = decryptField(job.verifyTokenEnc);
    if (!token || !TOKEN_RE.test(token)) throw new RenderError('رمز التحقق غير متاح لهذه المهمة', 'TOKEN_UNAVAILABLE', false);
    const url = verifyUrl(process.env.APP_URL ?? '', token);

    // DOC-04 at the moment of issuance: a revoked authorization no longer prints the signature.
    const signatory = await loadSignatory(prisma, job.signatoryId);
    const authorizations = signatory
      ? await prisma.signingAuthorization.findMany({ where: { signatoryId: signatory.id, typeKey: def.key, legalCompanyId: job.legalCompanyId } })
      : [];
    const totalSalary = (material.data as { salary?: { total: string } }).salary?.total ?? null;
    const decision = decideSignature({ signatory, legalCompanyId: job.legalCompanyId, typeKey: def.key, snapshotSha256: snapshot.dataSha256, approvals: req.approvals, authorizations, now: job.issuedAt, totalSalary });
    const printStamp = decision.printImage && !!signatory?.stampAssetId;
    const signature: SignatureBlock | null = signatory
      ? { nameAr: signatory.nameAr, nameEn: signatory.nameEn, titleAr: signatory.titleAr, titleEn: signatory.titleEn, printImage: decision.printImage, printStamp }
      : null;

    const assets: Record<string, Buffer> = { 'qr.svg': await qrSvg(url) };
    if (brand.logoStoredName) assets['logo.png'] = await assetFile(brand.logoStoredName, 'الشعار');
    if (decision.printImage && signatory?.signatureAssetId) {
      const sig = await prisma.documentAsset.findFirst({ where: { id: signatory.signatureAssetId, companyId: job.legalCompanyId, kind: 'SIGNATURE' } });
      if (!sig) throw new RenderError('صورة التوقيع غير موجودة', 'SIGNATURE_ASSET_MISSING', false);
      assets['signature.png'] = await assetFile(sig.storedName, 'صورة التوقيع');
    }
    if (printStamp && signatory?.stampAssetId) {
      const stamp = await prisma.documentAsset.findFirst({ where: { id: signatory.stampAssetId, companyId: job.legalCompanyId, kind: 'STAMP' } });
      if (!stamp) throw new RenderError('صورة الختم غير موجودة', 'STAMP_ASSET_MISSING', false);
      assets['stamp.png'] = await assetFile(stamp.storedName, 'صورة الختم');
    }

    const policy = await loadPolicy(prisma, def, job.legalCompanyId);
    const validUntil = computeValidUntil(job.issuedAt, policy.validityDays);
    const model = buildRenderModel(material.data, brand, {
      typeLabelAr: def.labelAr, typeLabelEn: def.labelEn, number: job.number,
      issuedDate: riyadhDate(job.issuedAt), validUntilDate: validUntil ? riyadhDate(validUntil) : null,
      verifyUrl: url, language: params.language, addresseeAr: params.addresseeAr ?? null, addresseeEn: params.addresseeEn ?? null,
      signature, hasLogo: !!assets['logo.png'],
    });
    const bundle = await loadTemplate(def, params.language);
    const out = await renderer.render({
      templateRef: bundle.templateRef, template: bundle.files, data: model, assets,
      creationTimestamp: Math.floor(job.issuedAt.getTime() / 1000), pdfStandard: 'a-2b',
    });
    const storedName = await storeIssuedPdf(out.pdf, job.issuedAt);

    const documentId = await prisma.$transaction(async (tx) => {
      const doc = await tx.issuedDocument.create({
        data: {
          number: job.number, legalCompanyId: job.legalCompanyId, employeeId: req.employeeId, typeKey: def.key,
          requestId: req.id, snapshotId: snapshot.id, snapshotSha256: snapshot.dataSha256,
          approvalId: job.approvalId, signatoryId: job.signatoryId,
          authorizationId: decision.printImage ? decision.authorizationId : null,
          templateRef: bundle.templateRef, templateSha256: bundle.sha256,
          rendererId: out.rendererId, rendererVersion: out.rendererVersion, typstSha256: out.typstSha256, fontsSha256: out.fontsSha256,
          pdfStandard: 'a-2b', storedName, pdfSha256: out.pdfSha256, pdfSize: out.pdf.length,
          verifyTokenHash: job.verifyTokenHash, validUntil, issuedAt: job.issuedAt, issuedById: actor.userId ?? req.requestedById,
        },
      });
      await tx.documentRenderJob.update({ where: { id: job.id }, data: { status: 'DONE', verifyTokenEnc: null, lastError: null } });
      await tx.documentRequest.update({ where: { id: req.id }, data: { status: 'ISSUED', closedAt: new Date() } });
      await appendEvent(tx, { type: 'ISSUED', requestId: req.id, documentId: doc.id, actorId: actor.userId, meta: { number: job.number, pdfSha256: out.pdfSha256, signaturePrinted: decision.printImage } });
      await enqueueNotice(tx, [await employeeUserId(tx, req.employeeId)], `issued:${doc.id}`, { kind: 'ISSUED', number: job.number, typeLabel: def.labelAr });
      if (supersedesDocumentId) {
        const replaced = await tx.issuedDocument.updateMany({ where: { id: supersedesDocumentId, status: 'ISSUED' }, data: { status: 'SUPERSEDED', supersededById: doc.id } });
        if (replaced.count) await appendEvent(tx, { type: 'SUPERSEDED', documentId: supersedesDocumentId, actorId: actor.userId, meta: { by: doc.id } });
      }
      return doc.id;
    });
    await logAudit({ userId: actor.userId, action: 'CREATE', entityType: 'IssuedDocument', entityId: documentId, details: { number: job.number, typeKey: def.key }, ipAddress: actor.ip });
    return { requestId: req.id, status: 'ISSUED', documentId };
  } catch (err) {
    const re = err instanceof RenderError ? err : null;
    const retryable = re ? re.retryable : true;
    const code = re?.code ?? 'INTERNAL';
    const attempts = job.attempts; // already incremented by the claim
    const blocked = !retryable || attempts >= MAX_RENDER_ATTEMPTS;
    await prisma.$transaction(async (tx) => {
      await tx.documentRenderJob.update({
        where: { id: job.id },
        data: { status: blocked ? 'BLOCKED' : 'FAILED', lastError: code, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
      });
      await appendEvent(tx, { type: 'RENDER_FAILED', requestId: req.id, actorId: actor.userId, meta: { code, attempts, blocked } });
    });
    if (!re) console.error('[documents] render job failed:', err instanceof Error ? err.message : err);
    return {
      requestId: req.id, status: req.status,
      renderError: { code, retryable: !blocked, message: re?.message ?? 'تعذر إصدار المستند حالياً؛ ستُعاد المحاولة تلقائياً' },
    };
  }
}

/** Retries due render jobs (called when document lists open; also by the retry endpoint). */
export async function processDueRenderJobs(limit = 3, renderer: DocumentRenderer = typstServiceRenderer()): Promise<number> {
  const now = new Date();
  const due = await prisma.documentRenderJob.findMany({
    where: {
      OR: [
        { status: { in: ['QUEUED', 'FAILED'] }, nextAttemptAt: { lte: now } },
        { status: 'RENDERING', updatedAt: { lt: new Date(now.getTime() - STUCK_RENDER_MS) } },
      ],
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  for (const j of due) await processRenderJob(j.id, SYSTEM_ACTOR, renderer);
  return due.length;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

async function loadOpenRequest(requestId: string) {
  const req = await prisma.documentRequest.findUnique({ where: { id: requestId }, include: { currentSnapshot: true } });
  if (!req) throw notFound('الطلب غير موجود');
  const def = getDocumentType(req.typeKey);
  if (!def) throw badRequest('نوع مستند غير معروف');
  return { req, def };
}

/** Approves the snapshot the approver saw (DOC-05). A stale hash is refused: reload and look again. */
export async function approveDocumentRequest(requestId: string, seenSnapshotSha256: string, note: string | null, actor: Actor, renderer?: DocumentRenderer) {
  const { req, def } = await loadOpenRequest(requestId);
  const allowed = (await staffCan(prisma, def, actor, req.legalCompanyId)) || (await isCompanySignatoryUser(prisma, actor.userId, req.legalCompanyId));
  if (!allowed || !actor.userId) throw forbidden();
  if (req.status !== 'PENDING_APPROVAL') throw conflict('الطلب ليس بانتظار الاعتماد');
  if (actor.employeeId && actor.employeeId === req.employeeId) throw forbidden('لا يعتمد الموظف مستنداً صادراً باسمه');
  if (!req.currentSnapshot || req.currentSnapshot.dataSha256 !== seenSnapshotSha256) {
    throw conflict('تغيّرت بيانات المستند منذ عرضه؛ أعد تحميل الطلب وراجعه قبل الاعتماد');
  }
  await prisma.$transaction(async (tx) => {
    await tx.documentApproval.create({
      data: { requestId, snapshotId: req.currentSnapshot!.id, snapshotSha256: seenSnapshotSha256, approverId: actor.userId!, decision: 'APPROVED', note },
    });
    await appendEvent(tx, { type: 'APPROVED', requestId, actorId: actor.userId, ip: actor.ip, meta: { snapshotSha256: seenSnapshotSha256 } });
  });
  return advanceRequest(requestId, actor, renderer);
}

export async function rejectDocumentRequest(requestId: string, reason: string, actor: Actor) {
  const { req, def } = await loadOpenRequest(requestId);
  const allowed = (await staffCan(prisma, def, actor, req.legalCompanyId)) || (await isCompanySignatoryUser(prisma, actor.userId, req.legalCompanyId));
  if (!allowed || !actor.userId) throw forbidden();
  if (req.status !== 'PENDING_APPROVAL') throw conflict('الطلب ليس بانتظار الاعتماد');
  await prisma.$transaction(async (tx) => {
    const moved = await tx.documentRequest.updateMany({ where: { id: requestId, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED', rejectReason: reason, closedAt: new Date() } });
    if (moved.count !== 1) throw conflict('تغيّرت حالة الطلب');
    await tx.documentApproval.create({
      data: { requestId, snapshotId: req.currentSnapshot!.id, snapshotSha256: req.currentSnapshot!.dataSha256, approverId: actor.userId!, decision: 'REJECTED', note: reason },
    });
    await appendEvent(tx, { type: 'REJECTED', requestId, actorId: actor.userId, ip: actor.ip });
    await enqueueNotice(tx, [await employeeUserId(tx, req.employeeId)], `rejected:${requestId}`, { kind: 'REJECTED', typeLabel: def.labelAr });
  });
  return { requestId, status: 'REJECTED' };
}

/** The employee (or staff) cancels a request that has not been reserved yet. */
export async function cancelDocumentRequest(requestId: string, actor: Actor) {
  const { req, def } = await loadOpenRequest(requestId);
  if (!(await canSee(prisma, def, actor, req.employeeId, req.legalCompanyId))) throw notFound('الطلب غير موجود');
  await prisma.$transaction(async (tx) => {
    const moved = await tx.documentRequest.updateMany({ where: { id: requestId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED', closedAt: new Date() } });
    if (moved.count !== 1) throw conflict('لا يمكن إلغاء الطلب بعد حجز رقم المستند');
    await appendEvent(tx, { type: 'CANCELLED', requestId, actorId: actor.userId, ip: actor.ip });
  });
  return { requestId, status: 'CANCELLED' };
}

export async function retryDocumentRequest(requestId: string, actor: Actor, renderer?: DocumentRenderer) {
  const { req, def } = await loadOpenRequest(requestId);
  if (actor.employeeId !== req.employeeId && !(await staffCan(prisma, def, actor, req.legalCompanyId))) throw forbidden();
  const job = await prisma.documentRenderJob.findUnique({ where: { requestId } });
  if (!job) return advanceRequest(requestId, actor, renderer);
  if (job.status === 'DONE') return { requestId, status: 'ISSUED' };
  // A manual retry is allowed now (also for BLOCKED, e.g. after fixing a font / asset problem).
  await prisma.documentRenderJob.updateMany({ where: { id: job.id, status: { in: ['FAILED', 'BLOCKED'] } }, data: { status: 'FAILED', nextAttemptAt: new Date() } });
  return processRenderJob(job.id, actor, renderer);
}

export async function revokeIssuedDocument(documentId: string, reason: string, actor: Actor) {
  const doc = await prisma.issuedDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw notFound('المستند غير موجود');
  const def = getDocumentType(doc.typeKey);
  if (!def || !actor.userId || !(await staffCan(prisma, def, actor, doc.legalCompanyId))) throw forbidden();
  await prisma.$transaction(async (tx) => {
    const moved = await tx.issuedDocument.updateMany({
      where: { id: documentId, status: 'ISSUED' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId, revokeReason: reason },
    });
    if (moved.count !== 1) throw conflict('المستند ملغى أو مستبدل مسبقاً');
    await appendEvent(tx, { type: 'REVOKED', documentId, actorId: actor.userId, ip: actor.ip, meta: { reason } });
    await enqueueNotice(tx, [await employeeUserId(tx, doc.employeeId)], `revoked:${documentId}`, { kind: 'REVOKED', number: doc.number, typeLabel: def.labelAr });
  });
  await logAudit({ userId: actor.userId, action: 'UPDATE', entityType: 'IssuedDocument', entityId: documentId, details: { status: 'REVOKED', number: doc.number }, ipAddress: actor.ip });
  return { documentId, status: 'REVOKED' };
}

// ---------------------------------------------------------------------------
// Read: download (DOC-10) and public verification (DOC-06)
// ---------------------------------------------------------------------------

export async function readIssuedDocument(documentId: string, actor: Actor) {
  const doc = await prisma.issuedDocument.findUnique({ where: { id: documentId } });
  const def = doc ? getDocumentType(doc.typeKey) : null;
  // Same answer whether it exists or not: ids cannot be probed.
  if (!doc || !def || !(await canSee(prisma, def, actor, doc.employeeId, doc.legalCompanyId))) throw notFound('المستند غير موجود');
  if (doc.purgedAt) throw new HttpError(410, 'انتهت مدة الاحتفاظ بهذا المستند وحُذف ملفه');
  const pdf = await readIssuedPdf(doc.storedName, doc.pdfSha256);
  await prisma.$transaction((tx) => appendEvent(tx, { type: 'DOWNLOADED', documentId, actorId: actor.userId, ip: actor.ip }));
  return { pdf, fileName: `${doc.number}.pdf`, sha256: doc.pdfSha256 };
}

export interface PublicVerification {
  status: ReturnType<typeof validityStatus>;
  typeLabelAr: string;
  typeLabelEn: string;
  number: string;
  issuerAr: string;
  issuerEn: string | null;
  issuedAt: string; // YYYY-MM-DD
  validUntil: string | null;
  revokedAt: string | null;
  pdfSha256: string | null; // for the in-browser file check; null once purged
}

/** Minimal, PII-free metadata (DOC-06). Nothing from the data contract is returned. */
export async function verifyDocumentToken(token: string, ip: string | null): Promise<PublicVerification | null> {
  if (!TOKEN_RE.test(token)) return null;
  const doc = await prisma.issuedDocument.findUnique({
    where: { verifyTokenHash: hashVerifyToken(token) },
    include: { legalCompany: { select: { nameArabic: true, nameEnglish: true } } },
  });
  if (!doc) return null;
  const def = getDocumentType(doc.typeKey);
  await prisma.$transaction((tx) => appendEvent(tx, { type: 'VERIFIED', documentId: doc.id, ip: truncateIp(ip) }));
  return {
    status: validityStatus(doc),
    typeLabelAr: def?.labelAr ?? doc.typeKey,
    typeLabelEn: def?.labelEn ?? doc.typeKey,
    number: doc.number,
    issuerAr: doc.legalCompany.nameArabic,
    issuerEn: doc.legalCompany.nameEnglish,
    issuedAt: riyadhDate(doc.issuedAt),
    validUntil: doc.validUntil ? riyadhDate(doc.validUntil) : null,
    revokedAt: doc.revokedAt ? riyadhDate(doc.revokedAt) : null,
    pdfSha256: doc.purgedAt ? null : doc.pdfSha256,
  };
}
