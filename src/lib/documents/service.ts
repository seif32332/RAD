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
import { cancelChangeOrder, createChangeOrder } from './change-orders';
import { grantCandidateAccess } from './candidate';
import { loadDocumentTexts } from './texts';
import { loadAddendumFacts, loadCircularFacts, loadCommencementFacts, loadEvaluationFacts, loadLeaveFacts, loadBankFacts, loadExitFacts, loadInvestigationFacts, loadPayrollFacts, loadSettlementFacts, loadTerminationFacts } from './facts';
import { employeeUserId, enqueueNotice } from './notify';
import {
  computeValidUntil, decideSignature, effectivePolicy, needsApproval, validityStatus,
  type ApprovalRow, type AuthorizationRow, type SignatoryRow,
} from './policy';
import { formatGregorian } from './format';
import { qrSvg, verifyUrl } from './qr';
import { buildRenderModel, type BrandSnapshot, type SignatureBlock } from './render-model';
import { RenderError, renderServiceConfig, typstServiceRenderer, type DocumentRenderer } from './renderer';
import { readAsset, readIssuedPdf, storeIssuedPdf } from './storage';
import { SealError } from './seal/pades';
import { selfSealProvider } from './seal/provider';
import { loadTemplate } from './templates';
import {
  buildCandidateContractData, buildCompanyContractData, buildContractData, ContractValidationError, getDocumentType, LEAVE_LETTER_TYPES, paramsSchema,
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

/**
 * Read-only branding of a legal company for other PDF producers (e.g. internal workforce reports
 * rendered by radeef-render outside this pipeline): colours, numerals, contact lines and the logo
 * bytes (hash-checked). No numbering, no verification: those belong to official documents only.
 */
export async function companyBranding(companyId: string): Promise<{ brand: BrandSnapshot; logo: Buffer | null }> {
  const b = await loadBrand(prisma, companyId);
  const { numberPrefix: _prefix, logoStoredName, ...brand } = b;
  return { brand, logo: logoStoredName ? await readAsset(logoStoredName) : null };
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

/** Who a document belongs to: an employee, or a job applicant (JOB_OFFER). Exactly one is set. */
export interface DocumentSubject {
  employeeId: string | null;
  jobApplicationId: string | null;
}

const subjectKey = (s: DocumentSubject) => (s.employeeId ? `e:${s.employeeId}` : `c:${s.jobApplicationId}`);

/** A candidate document's snapshot: the application and the legal company HR chose (DOC-03 for candidates). */
async function buildCandidateSnapshot(db: Tx, def: DocumentTypeDefinition, jobApplicationId: string, params: DocumentParams) {
  const candidate = await db.jobApplication.findUnique({ where: { id: jobApplicationId }, select: { id: true, candidateName: true, candidateEmail: true, status: true } });
  if (!candidate) throw notFound('طلب التوظيف غير موجود');
  const companyId = params.offer?.legalCompanyId;
  if (!companyId) throw badRequest('اختر الشركة النظامية التي يصدر منها العرض');
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, nameArabic: true, nameEnglish: true, commercialRegNum: true, unifiedNumber: true } });
  if (!company) throw badRequest('الشركة النظامية غير موجودة');
  let data: Record<string, unknown>;
  try {
    data = buildCandidateContractData(def, { candidate, company, params });
  } catch (e) {
    if (e instanceof ContractValidationError) throw new HttpError(422, e.message, { errors: e.errors });
    throw e;
  }
  const texts = await loadDocumentTexts(db, company.id, def.key);
  if (texts) data = { ...data, texts };
  const policy = await loadPolicy(db, def, company.id);
  const material = { typeKey: def.key, contractVersion: def.contractVersion, legalCompanyId: company.id, signatoryId: policy.signatoryId, params, data };
  const text = canonicalJson(material);
  return { text, sha256: sha256Hex(text), legalCompanyId: company.id, policy, data, employee: null, candidate };
}

/**
 * A company document's snapshot (circular): the legal company HR chose and the recipients resolved
 * now, so the approval covers exactly who receives it (a change of the audience makes a new snapshot).
 */
async function buildCompanySnapshot(db: Tx, def: DocumentTypeDefinition, params: DocumentParams) {
  const c = params.circular;
  if (!c) throw badRequest('اكتب موضوع القرار أو التعميم ونصه وحدد المستلمين');
  const company = await db.company.findUnique({ where: { id: c.legalCompanyId }, select: { id: true, nameArabic: true, nameEnglish: true, commercialRegNum: true, unifiedNumber: true } });
  if (!company) throw badRequest('الشركة النظامية غير موجودة');
  const circular = await loadCircularFacts(db, company.id, c.audience);
  let data: Record<string, unknown>;
  try {
    data = buildCompanyContractData(def, { company, params, circular });
  } catch (e) {
    if (e instanceof ContractValidationError) throw new HttpError(422, e.message, { errors: e.errors });
    throw e;
  }
  const texts = await loadDocumentTexts(db, company.id, def.key);
  if (texts) data = { ...data, texts };
  const policy = await loadPolicy(db, def, company.id);
  const material = { typeKey: def.key, contractVersion: def.contractVersion, legalCompanyId: company.id, signatoryId: policy.signatoryId, params, data };
  const text = canonicalJson(material);
  return { text, sha256: sha256Hex(text), legalCompanyId: company.id, policy, data, employee: null, candidate: null };
}

/** Material content of a request (DOC-05): its hash decides whether an approval is still valid. */
async function buildMaterialSnapshot(db: Tx, def: DocumentTypeDefinition, subject: DocumentSubject, params: DocumentParams) {
  if (def.subject === 'COMPANY') {
    if (subject.employeeId || subject.jobApplicationId) throw badRequest('القرار الإداري والتعميم يصدران من الشركة لا لموظف بعينه');
    return buildCompanySnapshot(db, def, params);
  }
  if (def.subject === 'CANDIDATE') {
    if (!subject.jobApplicationId || subject.employeeId) throw badRequest('هذا المستند يصدر لمرشح من طلبات التوظيف');
    return buildCandidateSnapshot(db, def, subject.jobApplicationId, params);
  }
  if (!subject.employeeId || subject.jobApplicationId) throw badRequest('هذا المستند يصدر لموظف');
  const employeeId = subject.employeeId;
  const employee = await loadEmployee(db, employeeId);
  if (!employee.legalCompanyId) {
    throw badRequest('الشركة النظامية غير محددة في ملف الموظف؛ لا يصدر المستند حتى تُستكمل (DOC-03)');
  }
  const company = await db.company.findUnique({
    where: { id: employee.legalCompanyId },
    select: { id: true, nameArabic: true, nameEnglish: true, commercialRegNum: true, unifiedNumber: true },
  });
  if (!company) throw badRequest('الشركة النظامية للموظف غير موجودة');
  const facts = def.facts === 'EXIT' ? await loadExitFacts(db, employeeId) : undefined;
  const settlement = def.facts === 'SETTLEMENT' ? await loadSettlementFacts(db, params.settlementId) : undefined;
  const payroll = def.facts === 'PAYROLL' ? await loadPayrollFacts(db, params.payrollId) : undefined;
  const termination = def.facts === 'TERMINATION' ? await loadTerminationFacts(db, params.terminationRequestId) : undefined;
  const investigation = def.facts === 'INVESTIGATION' ? await loadInvestigationFacts(db, params.terminationNotice?.investigationId ?? params.investigationId) : undefined;
  const bank = def.facts === 'BANK' ? await loadBankFacts(db, employeeId) : undefined;
  const leave = def.facts === 'LEAVE' ? await loadLeaveFacts(db, params.leaveId) : undefined;
  const evaluation = def.facts === 'EVALUATION' ? await loadEvaluationFacts(db, params.evaluationId) : undefined;
  const addendum = def.facts === 'ADDENDUM' ? await loadAddendumFacts(db, employeeId, params.addendum?.newBranchId) : undefined;
  const commencement = def.facts === 'COMMENCEMENT' ? await loadCommencementFacts(db, employeeId, params.commencement?.kind, params.commencement?.leaveId) : undefined;
  let data: Record<string, unknown>;
  try {
    data = buildContractData(def, { employee, company, params, facts, settlement, payroll, termination, investigation, bank, leave, evaluation, addendum, commencement });
  } catch (e) {
    if (e instanceof ContractValidationError) throw new HttpError(422, e.message, { errors: e.errors });
    throw e;
  }
  // The company's opening / closing paragraphs in force are part of what is approved and issued.
  const texts = await loadDocumentTexts(db, company.id, def.key);
  if (texts) data = { ...data, texts };
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
  return { text, sha256: sha256Hex(text), legalCompanyId: company.id, policy, data, employee, candidate: null };
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

/** Who may see a request / document: the employee himself, or staff of that type within scope (a candidate document: staff only). */
export async function canSee(db: Tx, def: DocumentTypeDefinition, actor: Actor, employeeId: string | null, legalCompanyId: string): Promise<boolean> {
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
  /** The employee the document is for, or ... */
  employeeId?: string | null;
  /** ... the job application (JOB_OFFER). Exactly one. */
  jobApplicationId?: string | null;
  params: unknown;
  source: 'PORTAL' | 'HR' | 'SYSTEM';
  /** SYSTEM only: the business event behind the request (e.g. settlement:<id>); one request per type and ref. */
  sourceRef?: string | null;
  /** Reissue: the new document supersedes this one when issued (DOC-09). */
  supersedesDocumentId?: string | null;
}

export async function createDocumentRequest(input: CreateRequestInput, actor: Actor, renderer: DocumentRenderer = typstServiceRenderer()) {
  const def = getDocumentType(input.typeKey);
  if (!def) throw badRequest('نوع مستند غير معروف');
  const params = paramsSchema.parse(input.params ?? {});
  const subject: DocumentSubject = { employeeId: input.employeeId ?? null, jobApplicationId: input.jobApplicationId ?? null };
  const companyDoc = def.subject === 'COMPANY';
  if (companyDoc ? !!(subject.employeeId || subject.jobApplicationId) : !subject.employeeId === !subject.jobApplicationId) throw badRequest('حدد الموظف أو المرشح');
  if (def.subject === 'CANDIDATE' && input.source !== 'HR') throw forbidden('العرض الوظيفي يصدره قسم الموارد البشرية');
  if (companyDoc && input.source !== 'HR') throw forbidden('القرار الإداري والتعميم يصدرهما قسم الموارد البشرية');

  if (input.source === 'PORTAL') {
    if (!actor.employeeId || actor.employeeId !== subject.employeeId) throw forbidden('لا يمكنك طلب مستند لموظف آخر');
  } else if (input.source === 'HR' && !isStaffFor(def, actor)) {
    throw forbidden();
  }
  // AUTO documents come from the system (HR may only reissue one, which supersedes it).
  if (def.issuance === 'AUTO' && input.source !== 'SYSTEM' && !input.supersedesDocumentId) throw badRequest('هذا المستند يصدر آلياً');

  const requestId = await prisma.$transaction(async (tx) => {
    const snap = await buildMaterialSnapshot(tx, def, subject, params);
    if (!snap.policy.enabled) throw badRequest('هذا النوع من المستندات غير مفعّل لهذه الشركة');
    if (input.source === 'HR' && !(await staffCan(tx, def, actor, snap.legalCompanyId))) throw forbidden('الشركة النظامية لهذا الموظف خارج نطاق صلاحيتك');
    const readiness = await issuanceReadiness(tx, snap.legalCompanyId);
    if (!readiness.ready) throw new HttpError(503, `إصدار المستندات غير مهيأ لهذه الشركة: ${readiness.missing.join('، ')}`, { missing: readiness.missing });
    if (input.source === 'PORTAL' && !snap.policy.selfService) throw forbidden('هذا المستند لا يُطلب من البوابة؛ تواصل مع الموارد البشرية');

    if (input.supersedesDocumentId) {
      const old = await tx.issuedDocument.findUnique({ where: { id: input.supersedesDocumentId } });
      if (!old || old.employeeId !== subject.employeeId || old.jobApplicationId !== subject.jobApplicationId || old.typeKey !== def.key) throw badRequest('المستند المراد استبداله غير مطابق');
      if (old.status !== 'ISSUED') throw conflict('المستند المراد استبداله لم يعد سارياً');
      if (!isStaffFor(def, actor)) throw forbidden();
    }

    // One open request per employee and type: a double click must not issue twice. The advisory
    // lock serializes concurrent creations for the same employee + type before the check.
    // Company documents (circulars) have no single subject: several may be open at once.
    if (!companyDoc) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`doc-req:${subjectKey(subject)}:${def.key}`}))`;
    // AUTO documents are deduplicated by their source (one per payroll row), not by "one open
    // request": a month whose render is retrying must not block the next month.
    const open = def.issuance === 'AUTO' || companyDoc ? null : await tx.documentRequest.findFirst({
      where: { employeeId: subject.employeeId, jobApplicationId: subject.jobApplicationId, typeKey: def.key, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
      select: { id: true },
    });
    if (open) throw conflict('يوجد طلب مفتوح لنفس المستند؛ تابعه من قائمة الطلبات', { requestId: open.id });

    const brand = await loadBrand(tx, snap.legalCompanyId);
    const req = await tx.documentRequest.create({
      data: {
        typeKey: def.key,
        legalCompanyId: snap.legalCompanyId,
        employeeId: subject.employeeId,
        jobApplicationId: subject.jobApplicationId,
        requestedById: actor.userId,
        source: input.source,
        sourceRef: input.source === 'SYSTEM' ? input.sourceRef ?? null : null,
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
    const snap = await buildMaterialSnapshot(tx, def, { employeeId: req.employeeId, jobApplicationId: req.jobApplicationId }, params);
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

    // A request the system suggests (SPEC §13: settlement paid) always waits for a human; an AUTO
    // document (payslip) was approved with its payroll and is issued unsigned, without approval.
    const policy = req.source === 'SYSTEM' ? { ...snap.policy, requiresApproval: true } : snap.policy;
    if (def.issuance !== 'AUTO' && needsApproval(policy, decision, approvals, snapshotSha!)) {
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
        // Due at once by the app clock (the claim compares with it; the database default could run ahead).
        nextAttemptAt: now,
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
      typeLabelAr: def.titleOf?.(material.data).ar ?? def.labelAr, typeLabelEn: def.titleOf?.(material.data).en ?? def.labelEn, number: job.number,
      issuedDate: riyadhDate(job.issuedAt), validUntilDate: validUntil ? riyadhDate(validUntil) : null,
      verifyUrl: url, language: params.language, addresseeAr: params.addresseeAr ?? null, addresseeEn: params.addresseeEn ?? null,
      addressedToEmployee: !!def.addressedToEmployee, signature, hasLogo: !!assets['logo.png'],
    });
    const bundle = await loadTemplate(def, params.language);
    const out = await renderer.render({
      templateRef: bundle.templateRef, template: bundle.files, data: model, assets,
      creationTimestamp: Math.floor(job.issuedAt.getTime() / 1000), pdfStandard: 'a-2b',
    });
    // PAdES seal with the company's key (SPEC §9 level 3): after rendering, before the fingerprint.
    // Fails closed: a document is never issued unsealed once the seal exists.
    let sealed: { pdf: Buffer; sealKeyId: string };
    try {
      sealed = await selfSealProvider.seal({ pdf: out.pdf, legalCompanyId: job.legalCompanyId, issuedAt: job.issuedAt, number: job.number, actorId: actor.userId });
    } catch (err) {
      throw new RenderError('تعذّر ختم المستند رقمياً', 'SEAL_FAILED', !(err instanceof SealError), err instanceof Error ? err.message : String(err));
    }
    const pdfSha256 = sha256Hex(sealed.pdf);
    const storedName = await storeIssuedPdf(sealed.pdf, job.issuedAt);

    const documentId = await prisma.$transaction(async (tx) => {
      const doc = await tx.issuedDocument.create({
        data: {
          number: job.number, legalCompanyId: job.legalCompanyId, employeeId: req.employeeId, jobApplicationId: req.jobApplicationId, typeKey: def.key,
          requestId: req.id, snapshotId: snapshot.id, snapshotSha256: snapshot.dataSha256,
          approvalId: job.approvalId, signatoryId: job.signatoryId,
          authorizationId: decision.printImage ? decision.authorizationId : null,
          templateRef: bundle.templateRef, templateSha256: bundle.sha256,
          rendererId: out.rendererId, rendererVersion: out.rendererVersion, typstSha256: out.typstSha256, fontsSha256: out.fontsSha256,
          pdfStandard: 'a-2b', storedName, pdfSha256, pdfSize: sealed.pdf.length, sealKeyId: sealed.sealKeyId,
          verifyTokenHash: job.verifyTokenHash, validUntil, issuedAt: job.issuedAt, issuedById: actor.userId ?? req.requestedById,
        },
      });
      await tx.documentRenderJob.update({ where: { id: job.id }, data: { status: 'DONE', verifyTokenEnc: null, lastError: null } });
      await tx.documentRequest.update({ where: { id: req.id }, data: { status: 'ISSUED', closedAt: new Date() } });
      await appendEvent(tx, { type: 'ISSUED', requestId: req.id, documentId: doc.id, actorId: actor.userId, meta: { number: job.number, pdfSha256, sealKeyId: sealed.sealKeyId, signaturePrinted: decision.printImage } });
      if (req.employeeId) {
        const consentBy = def.acknowledgement === 'CONSENT' ? formatGregorian((material.data as unknown as { addendum: { effectiveDate: string } }).addendum.effectiveDate, 'ar') : undefined;
        await enqueueNotice(tx, [await employeeUserId(tx, req.employeeId)], `issued:${doc.id}`, { kind: 'ISSUED', number: job.number, typeLabel: def.labelAr, acknowledge: !!def.acknowledgement, consentBy });
      } else if (def.subject === 'COMPANY') {
        // Circular: the distribution approved in the snapshot, one row per recipient, each told once.
        const c = (material.data as unknown as { circular: { recipientIds: string[]; acknowledge: boolean } }).circular;
        await tx.circularRecipient.createMany({ data: c.recipientIds.map((employeeId) => ({ documentId: doc.id, employeeId })), skipDuplicates: true });
        const users = await tx.employee.findMany({ where: { id: { in: c.recipientIds }, userId: { not: null } }, select: { userId: true } });
        const title = def.titleOf?.(material.data).ar ?? def.labelAr;
        await enqueueNotice(tx, users.map((u) => u.userId!), `issued:${doc.id}`, { kind: 'ISSUED', number: job.number, typeLabel: title, acknowledge: c.acknowledge });
      } else if (req.jobApplicationId) {
        // A candidate has no account: a private link, valid until the offer's deadline (candidate.ts).
        await grantCandidateAccess(tx, { documentId: doc.id, jobApplicationId: req.jobApplicationId, validUntil, issuedAt: job.issuedAt, number: job.number });
      }
      if (def.executesChange) {
        const ch = (material.data as { change: { effectiveDate: string; toBasicSalary: string | null; toJobTitleAr: string | null; toJobTitleEn: string | null } }).change;
        if (supersedesDocumentId && (await cancelChangeOrder(tx, supersedesDocumentId)) === 'APPLIED') {
          throw new RenderError('القرار السابق نُفّذ على ملف الموظف؛ لا يُستبدل بإعادة الإصدار بل بقرار جديد', 'CHANGE_ALREADY_APPLIED', false);
        }
        await createChangeOrder(tx, {
          documentId: doc.id, employeeId: req.employeeId!, effectiveDate: ch.effectiveDate,
          basicSalary: ch.toBasicSalary !== null ? Number(ch.toBasicSalary) : null, jobTitle: ch.toJobTitleAr, jobTitleEnglish: ch.toJobTitleEn,
        }, actor.userId);
      }
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
  if (def.approvalLocked && req.requestedById === actor.userId) throw forbidden('لا يعتمد كاتب الطلب طلبه بنفسه؛ يعتمده شخص آخر');
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
    if (req.employeeId) await enqueueNotice(tx, [await employeeUserId(tx, req.employeeId)], `rejected:${requestId}`, { kind: 'REJECTED', typeLabel: def.labelAr });
  });
  return { requestId, status: 'REJECTED' };
}

/** The employee (or staff) cancels a request that has not been reserved yet. */
export async function cancelDocumentRequest(requestId: string, actor: Actor) {
  const { req, def } = await loadOpenRequest(requestId);
  // A warning is HR's act, a system suggestion HR's queue: the employee neither cancels them.
  const allowed = def.approvalLocked || req.source === 'SYSTEM' || !req.employeeId ? await staffCan(prisma, def, actor, req.legalCompanyId) : await canSee(prisma, def, actor, req.employeeId, req.legalCompanyId);
  if (!allowed) throw notFound('الطلب غير موجود');
  await prisma.$transaction(async (tx) => {
    const moved = await tx.documentRequest.updateMany({ where: { id: requestId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED', closedAt: new Date() } });
    if (moved.count !== 1) throw conflict('لا يمكن إلغاء الطلب بعد حجز رقم المستند');
    await appendEvent(tx, { type: 'CANCELLED', requestId, actorId: actor.userId, ip: actor.ip });
  });
  return { requestId, status: 'CANCELLED' };
}

export async function retryDocumentRequest(requestId: string, actor: Actor, renderer?: DocumentRenderer) {
  const { req, def } = await loadOpenRequest(requestId);
  const own = !!actor.employeeId && actor.employeeId === req.employeeId;
  if (!own && !(await staffCan(prisma, def, actor, req.legalCompanyId))) throw forbidden();
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
    // A decision already carried out on the employee file cannot be revoked by revoking its letter.
    if ((def.executesChange || def.executesOnConsent) && (await cancelChangeOrder(tx, documentId)) === 'APPLIED') {
      throw conflict('القرار نُفّذ على ملف الموظف؛ صحّح الملف بقرار جديد بدلاً من إلغاء هذا');
    }
    const moved = await tx.issuedDocument.updateMany({
      where: { id: documentId, status: 'ISSUED' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId, revokeReason: reason },
    });
    if (moved.count !== 1) throw conflict('المستند ملغى أو مستبدل مسبقاً');
    await appendEvent(tx, { type: 'REVOKED', documentId, actorId: actor.userId, ip: actor.ip, meta: { reason } });
    if (doc.employeeId) await enqueueNotice(tx, [await employeeUserId(tx, doc.employeeId)], `revoked:${documentId}`, { kind: 'REVOKED', number: doc.number, typeLabel: def.labelAr });
    if (def.subject === 'COMPANY') {
      const users = await tx.circularRecipient.findMany({ where: { documentId, employee: { userId: { not: null } } }, select: { employee: { select: { userId: true } } } });
      await enqueueNotice(tx, users.map((u) => u.employee.userId!), `revoked:${documentId}`, { kind: 'REVOKED', number: doc.number, typeLabel: def.labelAr });
    }
  });
  await logAudit({ userId: actor.userId, action: 'UPDATE', entityType: 'IssuedDocument', entityId: documentId, details: { status: 'REVOKED', number: doc.number }, ipAddress: actor.ip });
  return { documentId, status: 'REVOKED' };
}

// ---------------------------------------------------------------------------
// Acknowledgement of receipt (warning letters)
// ---------------------------------------------------------------------------

export type AcknowledgementDecision = 'RECEIVED' | 'ACCEPTED' | 'DISPUTED' | 'DECLINED';

/**
 * The employee's answer to a document that asks for one, once, never edited (DocumentAcknowledgement
 * guard): RECEIPT types (warning) -> RECEIVED; RELEASE types (settlement statement) -> ACCEPTED (the
 * discharge) or DISPUTED (a reason is required, and HR is told). The event records the decision and
 * whether a comment was given, never the comment itself.
 */
export async function acknowledgeDocument(
  documentId: string,
  input: { decision?: AcknowledgementDecision; comment: string | null },
  actor: Actor,
) {
  const doc = await prisma.issuedDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true, employeeId: true, typeKey: true, status: true, number: true, snapshot: { select: { data: true } },
      request: { select: { requestedById: true, approvals: { select: { approverId: true } } } },
    },
  });
  const def = doc ? getDocumentType(doc.typeKey) : null;
  if (doc && def?.subject === 'COMPANY') return acknowledgeCircular(doc, actor);
  if (!doc || !def || !actor.userId || !actor.employeeId || actor.employeeId !== doc.employeeId) throw notFound('المستند غير موجود');
  if (!def.acknowledgement) throw badRequest('هذا المستند لا يحتاج إقراراً');
  if (doc.status !== 'ISSUED') throw conflict('المستند ملغى أو مستبدل؛ لا يلزم الرد عليه');
  const comment = input.comment?.trim() || null;
  let decision: AcknowledgementDecision;
  let consent: AddendumTerms | null = null;
  if (def.acknowledgement === 'RECEIPT') {
    if (input.decision && input.decision !== 'RECEIVED') throw badRequest('هذا المستند يُقر باستلامه فقط');
    decision = 'RECEIVED';
  } else if (def.acknowledgement === 'CONSENT') {
    if (input.decision !== 'ACCEPTED' && input.decision !== 'DECLINED') throw badRequest('اختر الموافقة على الملحق أو رفضه');
    consent = addendumTermsOf(doc.snapshot.data);
    // The answer is due by the effective date (Riyadh); later, HR issues a new addendum with a new date.
    if (riyadhDate(new Date()) > consent.effectiveDate) throw conflict('انتهت مهلة الرد على هذا الملحق (تاريخ السريان)؛ راجع الموارد البشرية');
    decision = input.decision;
  } else {
    if (input.decision !== 'ACCEPTED' && input.decision !== 'DISPUTED') throw badRequest('اختر الموافقة على المخالصة أو الاعتراض عليها');
    if (input.decision === 'DISPUTED' && (!comment || comment.length < 5)) throw badRequest('اكتب سبب الاعتراض');
    decision = input.decision;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.documentAcknowledgement.create({ data: { documentId, employeeId: doc.employeeId, userId: actor.userId!, decision, comment } });
      await appendEvent(tx, { type: 'ACKNOWLEDGED', documentId, actorId: actor.userId, ip: actor.ip, meta: { decision, withComment: !!comment } });
      const staff = [doc.request.requestedById, ...doc.request.approvals.map((a) => a.approverId)];
      if (decision === 'DISPUTED') {
        // Whoever issued and approved it follows the dispute up (the reason stays behind the login).
        await enqueueNotice(tx, staff, `disputed:${documentId}`, { kind: 'DISPUTED', number: doc.number, typeLabel: def.labelAr });
      }
      if (consent) {
        // Acceptance orders the change (applied now when due, else on the effective date); a decline changes nothing.
        if (decision === 'ACCEPTED') {
          const a = consent.apply;
          const num = (v: string | null) => (v === null ? null : Number(v));
          await createChangeOrder(tx, {
            documentId, employeeId: doc.employeeId!, effectiveDate: consent.effectiveDate,
            basicSalary: num(a.basicSalary), jobTitle: a.jobTitleAr, jobTitleEnglish: a.jobTitleEn,
            housingAllowance: num(a.housingAllowance), transportAllowance: num(a.transportAllowance), branchId: a.branchId, contractEndDate: a.contractEndDate,
          }, actor.userId);
        }
        await enqueueNotice(tx, staff, `consent:${documentId}`, { kind: 'CONSENT_ANSWERED', number: doc.number, typeLabel: def.labelAr, accepted: decision === 'ACCEPTED' });
      }
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw conflict('سُجّل ردك على هذا المستند مسبقاً');
    throw e;
  }
  return { documentId, decision };
}

/** A circular's recipient confirms having read it (once; the guard refuses a second time). */
async function acknowledgeCircular(doc: { id: string; status: string; snapshot: { data: string | null } }, actor: Actor) {
  if (!actor.userId || !actor.employeeId) throw notFound('المستند غير موجود');
  const row = await prisma.circularRecipient.findUnique({ where: { documentId_employeeId: { documentId: doc.id, employeeId: actor.employeeId } } });
  if (!row) throw notFound('المستند غير موجود');
  const wanted = doc.snapshot.data ? (JSON.parse(doc.snapshot.data) as { data?: { circular?: { acknowledge?: boolean } } }).data?.circular?.acknowledge : true;
  if (wanted === false) throw badRequest('هذا التعميم لا يحتاج إقراراً');
  if (doc.status !== 'ISSUED') throw conflict('المستند ملغى أو مستبدل؛ لا يلزم الرد عليه');
  await prisma.$transaction(async (tx) => {
    const moved = await tx.circularRecipient.updateMany({ where: { id: row.id, acknowledgedAt: null }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.userId } });
    if (moved.count !== 1) throw conflict('سُجّل ردك على هذا المستند مسبقاً');
    await appendEvent(tx, { type: 'ACKNOWLEDGED', documentId: doc.id, actorId: actor.userId, ip: actor.ip, meta: { decision: 'RECEIVED', circular: true } });
  });
  return { documentId: doc.id, decision: 'RECEIVED' as AcknowledgementDecision };
}

interface AddendumTerms {
  effectiveDate: string;
  apply: { basicSalary: string | null; housingAllowance: string | null; transportAllowance: string | null; jobTitleAr: string | null; jobTitleEn: string | null; branchId: string | null; contractEndDate: string | null };
}

/** The terms a contract addendum's approved snapshot orders (what the employee saw and accepts). */
function addendumTermsOf(snapshotText: string | null): AddendumTerms {
  const terms = snapshotText ? (JSON.parse(snapshotText) as { data?: { addendum?: AddendumTerms } }).data?.addendum : undefined;
  if (!terms?.effectiveDate || !terms.apply) throw conflict('بيانات الملحق غير متاحة');
  return terms;
}

// ---------------------------------------------------------------------------
// System suggestions (SPEC §13): a paid end-of-service settlement -> clearance + experience letter
// ---------------------------------------------------------------------------

/** Documents suggested when a settlement is paid: its statement, and for a leaver clearance + experience. */
export function suggestedTypesFor(settlementType: string): readonly string[] {
  return settlementType === 'END_OF_SERVICE'
    ? ['CLEARANCE_CERTIFICATE', 'EXPERIENCE_CERTIFICATE', 'SETTLEMENT_STATEMENT']
    : ['SETTLEMENT_STATEMENT'];
}

export interface SuggestionOutcome {
  typeKey: string;
  outcome: 'CREATED' | 'EXISTS' | 'SKIPPED';
  reason?: string;
}

/**
 * Owner decisions 2026-09-26: when a settlement is PAID, the system creates requests that wait for
 * approval (never issued unattended): the settlement statement, and for an end-of-service
 * settlement also the clearance and the experience letter. Idempotent: one request per type and
 * settlement (DocumentRequest.sourceRef unique), and nothing is created when the employee already
 * has an open request of that type or the document was already issued (since the settlement; for
 * the statement: for this settlement). A request that cannot be created yet (e.g. a custody item
 * still open) is SKIPPED and tried again by the next sweep.
 */
export async function suggestExitDocuments(settlementId: string): Promise<SuggestionOutcome[]> {
  const st = await prisma.settlement.findUnique({ where: { id: settlementId }, select: { id: true, employeeId: true, type: true, status: true, createdAt: true } });
  if (!st || st.status !== 'PAID') return [];
  const sourceRef = `settlement:${st.id}`;
  const out: SuggestionOutcome[] = [];
  for (const typeKey of suggestedTypesFor(st.type)) {
    const statement = typeKey === 'SETTLEMENT_STATEMENT';
    const [bySource, open, issued] = await Promise.all([
      prisma.documentRequest.findUnique({ where: { typeKey_sourceRef: { typeKey, sourceRef } }, select: { id: true } }),
      prisma.documentRequest.findFirst({ where: { employeeId: st.employeeId, typeKey, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } }, select: { id: true } }),
      prisma.issuedDocument.findFirst({
        where: statement
          ? { employeeId: st.employeeId, typeKey, status: 'ISSUED', request: { paramsJson: { contains: `"settlementId":"${st.id}"` } } }
          : { employeeId: st.employeeId, typeKey, status: 'ISSUED', issuedAt: { gte: st.createdAt } },
        select: { id: true },
      }),
    ]);
    if (bySource || open || issued) {
      out.push({ typeKey, outcome: 'EXISTS' });
      continue;
    }
    try {
      const params = statement ? { language: 'ar', settlementId: st.id } : { language: 'ar' };
      await createDocumentRequest({ typeKey, employeeId: st.employeeId, params, source: 'SYSTEM', sourceRef }, SYSTEM_ACTOR);
      out.push({ typeKey, outcome: 'CREATED' });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002' || (e instanceof HttpError && e.status === 409)) {
        out.push({ typeKey, outcome: 'EXISTS' });
      } else if (e instanceof HttpError) {
        out.push({ typeKey, outcome: 'SKIPPED', reason: e.message });
      } else {
        throw e;
      }
    }
  }
  return out;
}

/**
 * Owner decision 2026-09-26: an approved resignation / termination request suggests its acceptance
 * letter (waits for approval; one per request via sourceRef termination:<id>).
 */
export async function suggestExitAcceptance(terminationRequestId: string): Promise<SuggestionOutcome> {
  const r = await prisma.terminationRequest.findUnique({ where: { id: terminationRequestId }, select: { id: true, employeeId: true, status: true } });
  const typeKey = 'EXIT_ACCEPTANCE';
  if (!r || r.status !== 'APPROVED') return { typeKey, outcome: 'SKIPPED', reason: 'الطلب غير معتمد' };
  try {
    await createDocumentRequest(
      { typeKey, employeeId: r.employeeId, params: { language: 'ar', terminationRequestId: r.id }, source: 'SYSTEM', sourceRef: `termination:${r.id}` },
      SYSTEM_ACTOR,
    );
    return { typeKey, outcome: 'CREATED' };
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002' || (e instanceof HttpError && e.status === 409)) return { typeKey, outcome: 'EXISTS' };
    if (e instanceof HttpError) return { typeKey, outcome: 'SKIPPED', reason: e.message };
    throw e;
  }
}

export function suggestExitAcceptanceQuietly(terminationRequestId: string): Promise<void> {
  return suggestExitAcceptance(terminationRequestId).then(
    (r) => {
      if (r.outcome === 'SKIPPED') console.warn(`[documents] exit acceptance for ${terminationRequestId} skipped: ${r.reason}`);
    },
    (e) => console.error('[documents] exit acceptance:', e instanceof Error ? e.message : e),
  );
}

/** Best effort after a settlement is paid: never fails the payment that already committed. */
export function suggestExitDocumentsQuietly(settlementId: string): Promise<void> {
  return suggestExitDocuments(settlementId).then(
    (r) => {
      const skipped = r.filter((x) => x.outcome === 'SKIPPED');
      if (skipped.length) console.warn(`[documents] exit suggestions for settlement ${settlementId} skipped:`, skipped.map((x) => `${x.typeKey}: ${x.reason}`).join(' | '));
    },
    (e) => console.error('[documents] exit suggestions:', e instanceof Error ? e.message : e),
  );
}

/** Sweep (documents list opens): settlements paid in the last 30 days still missing a suggestion. */
export async function suggestDueExitDocuments(limit = 10): Promise<number> {
  const since = new Date(Date.now() - 30 * 86400e3);
  const paid = await prisma.settlement.findMany({
    where: { status: 'PAID', updatedAt: { gte: since } },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, type: true },
  });
  if (!paid.length) return 0;
  const refs = paid.map((p) => `settlement:${p.id}`);
  const done = await prisma.documentRequest.findMany({ where: { sourceRef: { in: refs } }, select: { sourceRef: true, typeKey: true } });
  const complete = new Set(
    paid
      .filter((p) => suggestedTypesFor(p.type).every((t) => done.some((d) => d.sourceRef === `settlement:${p.id}` && d.typeKey === t)))
      .map((p) => `settlement:${p.id}`),
  );
  const due = paid.filter((p) => !complete.has(`settlement:${p.id}`)).slice(0, limit);
  for (const p of due) await suggestExitDocumentsQuietly(p.id);
  return due.length;
}

// ---------------------------------------------------------------------------
// Leave letters (owner decision 2026-09-26): issued automatically once a leave is approved, and
// kept in line with it: new dates -> a new letter (the old one revoked), cancelled -> revoked.
// Each date version has its own sourceRef leave:<id>:<start>:<end>, so reruns are idempotent.
// ---------------------------------------------------------------------------

const day = (d: Date) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);

/** The system revokes a document whose basis changed (no staff actor involved). */
async function revokeBySystem(documentId: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.issuedDocument.updateMany({ where: { id: documentId, status: 'ISSUED' }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason } });
    if (moved.count !== 1) return false;
    await appendEvent(tx, { type: 'REVOKED', documentId, meta: { reason, by: 'SYSTEM' } });
    return true;
  });
}

/** Brings one leave's letter in line with the leave. Returns what it did. */
export async function syncLeaveLetter(leaveId: string): Promise<'ISSUED' | 'UP_TO_DATE' | 'REVOKED' | 'NONE' | 'SKIPPED'> {
  const l = await prisma.leave.findUnique({ where: { id: leaveId }, select: { id: true, employeeId: true, leaveType: true, status: true, startDate: true, endDate: true } });
  if (!l) return 'NONE';
  const prefix = `leave:${l.id}:`;
  const letters = await prisma.issuedDocument.findMany({
    where: { typeKey: 'LEAVE_APPROVAL', status: 'ISSUED', request: { sourceRef: { startsWith: prefix } } },
    select: { id: true, request: { select: { sourceRef: true } } },
  });
  const active = l.status === 'APPROVED' && LEAVE_LETTER_TYPES.includes(String(l.leaveType));
  const ref = `${prefix}${day(l.startDate)}:${day(l.endDate)}`;
  let revoked = 0;
  for (const d of letters) {
    if (!active || d.request.sourceRef !== ref) {
      if (await revokeBySystem(d.id, active ? 'تغيرت تواريخ الإجازة؛ صدر خطاب جديد' : 'أُلغيت الإجازة')) revoked++;
    }
  }
  if (!active) return revoked ? 'REVOKED' : 'NONE';
  if (await prisma.documentRequest.findUnique({ where: { typeKey_sourceRef: { typeKey: 'LEAVE_APPROVAL', sourceRef: ref } }, select: { id: true } })) return 'UP_TO_DATE';
  // Bilingual when the employee's English data allows it (embassies), else Arabic.
  for (const language of ['ar-en', 'ar'] as const) {
    try {
      await createDocumentRequest({ typeKey: 'LEAVE_APPROVAL', employeeId: l.employeeId, params: { language, leaveId: l.id }, source: 'SYSTEM', sourceRef: ref }, SYSTEM_ACTOR);
      return 'ISSUED';
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return 'UP_TO_DATE';
      const englishMissing = e instanceof HttpError && e.status === 422 && language === 'ar-en'
        && ((e.details as { errors?: { code: string }[] } | undefined)?.errors ?? []).every((x) => /_EN$|UNKNOWN_NATIONALITY_EN/.test(x.code));
      if (englishMissing) continue;
      if (e instanceof HttpError) return 'SKIPPED';
      throw e;
    }
  }
  return 'SKIPPED';
}

export function syncLeaveLetterQuietly(leaveId: string): Promise<void> {
  return syncLeaveLetter(leaveId).then(
    (r) => {
      if (r === 'SKIPPED') console.warn(`[documents] leave letter for ${leaveId} not issued (company not configured or employee data incomplete)`);
    },
    (e) => console.error('[documents] leave letter:', e instanceof Error ? e.message : e),
  );
}

// ---------------------------------------------------------------------------
// Work commencement notices (owner decisions 2026-09-27): issued automatically when HR confirms
// that an employee started work (approval of a new-hire commencement request) or came back from a
// leave (confirmation of the return), once per event (sourceRef).
// ---------------------------------------------------------------------------

export type CommencementEvent = { kind: 'JOIN'; employeeId: string } | { kind: 'RETURN'; leaveId: string };

export async function issueCommencementNotice(ev: CommencementEvent): Promise<'ISSUED' | 'EXISTS' | 'NONE' | 'SKIPPED'> {
  let employeeId: string;
  let sourceRef: string;
  if (ev.kind === 'RETURN') {
    const l = await prisma.leave.findUnique({ where: { id: ev.leaveId }, select: { id: true, employeeId: true, isReturned: true, actualReturnDate: true } });
    if (!l || !l.isReturned || !l.actualReturnDate) return 'NONE';
    employeeId = l.employeeId;
    sourceRef = `leave:${l.id}:return`;
  } else {
    employeeId = ev.employeeId;
    sourceRef = `employee:${ev.employeeId}:join`;
  }
  if (await prisma.documentRequest.findUnique({ where: { typeKey_sourceRef: { typeKey: 'WORK_COMMENCEMENT', sourceRef } }, select: { id: true } })) return 'EXISTS';
  const commencement = ev.kind === 'RETURN' ? { kind: 'RETURN' as const, leaveId: ev.leaveId } : { kind: 'JOIN' as const };
  try {
    await createDocumentRequest({ typeKey: 'WORK_COMMENCEMENT', employeeId, params: { language: 'ar', commencement }, source: 'SYSTEM', sourceRef }, SYSTEM_ACTOR);
    return 'ISSUED';
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return 'EXISTS';
    if (e instanceof HttpError) {
      console.warn(`[documents] commencement notice ${sourceRef} not issued: ${e.message}`);
      return 'SKIPPED';
    }
    throw e;
  }
}

export function issueCommencementNoticeQuietly(ev: CommencementEvent): Promise<void> {
  return issueCommencementNotice(ev).then(
    () => undefined,
    (e) => console.error('[documents] commencement notice:', e instanceof Error ? e.message : e),
  );
}

/**
 * Sweep: returns confirmed in the last 30 days without their notice (a failed or skipped attempt).
 * Joinings are issued at approval only: a join date the request left empty is filled with a
 * placeholder, which must never be printed (the approval skips it).
 */
export async function issueDueCommencementNotices(limit = 30): Promise<number> {
  const since = new Date(Date.now() - 30 * 86400e3);
  const leaves = await prisma.leave.findMany({
    where: { isReturned: true, actualReturnDate: { gte: since } },
    orderBy: { actualReturnDate: 'desc' },
    take: limit,
    select: { id: true },
  });
  for (const l of leaves) await issueCommencementNoticeQuietly({ kind: 'RETURN', leaveId: l.id });
  return leaves.length;
}

/**
 * Evaluation reports (owner decision 2026-09-26): issued automatically when an evaluation closes,
 * once per evaluation (sourceRef evaluation:<id>).
 */
export async function issueEvaluationReport(evaluationId: string): Promise<'ISSUED' | 'EXISTS' | 'NONE' | 'SKIPPED'> {
  const ev = await prisma.employeeEvaluation.findUnique({ where: { id: evaluationId }, select: { id: true, employeeId: true, status: true } });
  if (!ev || ev.status !== 'CLOSED') return 'NONE';
  const sourceRef = `evaluation:${ev.id}`;
  if (await prisma.documentRequest.findUnique({ where: { typeKey_sourceRef: { typeKey: 'EVALUATION_REPORT', sourceRef } }, select: { id: true } })) return 'EXISTS';
  try {
    await createDocumentRequest({ typeKey: 'EVALUATION_REPORT', employeeId: ev.employeeId, params: { language: 'ar', evaluationId: ev.id }, source: 'SYSTEM', sourceRef }, SYSTEM_ACTOR);
    return 'ISSUED';
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return 'EXISTS';
    if (e instanceof HttpError) {
      console.warn(`[documents] evaluation report ${evaluationId} not issued: ${e.message}`);
      return 'SKIPPED';
    }
    throw e;
  }
}

export function issueEvaluationReportQuietly(evaluationId: string): Promise<void> {
  return issueEvaluationReport(evaluationId).then(() => undefined, (e) => console.error('[documents] evaluation report:', e instanceof Error ? e.message : e));
}

/**
 * Investigation minutes (owner decision 2026-09-26): a concluded investigation suggests its minutes
 * (waits for a second person's approval), once per investigation (sourceRef investigation:<id>).
 */
export async function suggestInvestigationMinutes(investigationId: string): Promise<'CREATED' | 'EXISTS' | 'NONE' | 'SKIPPED'> {
  const i = await prisma.investigation.findUnique({ where: { id: investigationId }, select: { id: true, employeeId: true, status: true } });
  if (!i || !['COMPLETED_GUILTY', 'COMPLETED_INNOCENT'].includes(i.status)) return 'NONE';
  const sourceRef = `investigation:${i.id}`;
  if (await prisma.documentRequest.findUnique({ where: { typeKey_sourceRef: { typeKey: 'INVESTIGATION_MINUTES', sourceRef } }, select: { id: true } })) return 'EXISTS';
  try {
    await createDocumentRequest({ typeKey: 'INVESTIGATION_MINUTES', employeeId: i.employeeId, params: { language: 'ar', investigationId: i.id }, source: 'SYSTEM', sourceRef }, SYSTEM_ACTOR);
    return 'CREATED';
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002' || (e instanceof HttpError && e.status === 409)) return 'EXISTS';
    if (e instanceof HttpError) {
      console.warn(`[documents] investigation minutes ${investigationId} not suggested: ${e.message}`);
      return 'SKIPPED';
    }
    throw e;
  }
}

export function suggestInvestigationMinutesQuietly(investigationId: string): Promise<void> {
  return suggestInvestigationMinutes(investigationId).then(() => undefined, (e) => console.error('[documents] investigation minutes:', e instanceof Error ? e.message : e));
}

/** Sweep: evaluations closed in the last 60 days without a report. */
export async function issueDueEvaluationReports(limit = 20): Promise<number> {
  const since = new Date(Date.now() - 60 * 86400e3);
  const closed = await prisma.employeeEvaluation.findMany({ where: { status: 'CLOSED', updatedAt: { gte: since } }, select: { id: true }, take: 500 });
  if (!closed.length) return 0;
  const done = await prisma.documentRequest.findMany({ where: { typeKey: 'EVALUATION_REPORT', sourceRef: { in: closed.map((c) => `evaluation:${c.id}`) } }, select: { sourceRef: true } });
  const have = new Set(done.map((d) => d.sourceRef));
  const due = closed.filter((c) => !have.has(`evaluation:${c.id}`)).slice(0, limit);
  for (const c of due) await issueEvaluationReportQuietly(c.id);
  return due.length;
}

/** Sweep (documents list opens): leaves changed in the last 30 days. */
export async function syncDueLeaveLetters(limit = 30): Promise<number> {
  const since = new Date(Date.now() - 30 * 86400e3);
  const leaves = await prisma.leave.findMany({ where: { updatedAt: { gte: since } }, orderBy: { updatedAt: 'desc' }, take: limit, select: { id: true } });
  for (const l of leaves) await syncLeaveLetterQuietly(l.id);
  return leaves.length;
}

// ---------------------------------------------------------------------------
// Payslips (owner decisions 2026-09-26): issued automatically once a month's payroll is PAID
// ---------------------------------------------------------------------------

export interface PayslipRunResult {
  issued: number;
  existing: number;
  failed: Array<{ payrollId: string; reason: string }>;
}

/**
 * Issues the payslip of every PAID payroll row of the month that has none yet (sourceRef
 * payroll:<id>, unique). Sequential (the render service renders one at a time anyway); a row that
 * cannot be issued (e.g. company not configured for documents) is reported and retried by the sweep.
 */
export async function issuePayslips(where: { year: number; month: number } | { payrollIds: string[] }): Promise<PayslipRunResult> {
  const rows = await prisma.payroll.findMany({
    where: { status: 'PAID', ...('payrollIds' in where ? { id: { in: where.payrollIds } } : { year: where.year, month: where.month }) },
    select: { id: true, employeeId: true },
    orderBy: { employeeId: 'asc' },
  });
  const done = await prisma.documentRequest.findMany({
    where: { typeKey: 'PAYSLIP', sourceRef: { in: rows.map((r) => `payroll:${r.id}`) } },
    select: { sourceRef: true },
  });
  const have = new Set(done.map((d) => d.sourceRef));
  const out: PayslipRunResult = { issued: 0, existing: have.size, failed: [] };
  for (const r of rows) {
    const sourceRef = `payroll:${r.id}`;
    if (have.has(sourceRef)) continue;
    try {
      await createDocumentRequest({ typeKey: 'PAYSLIP', employeeId: r.employeeId, params: { language: 'ar', payrollId: r.id }, source: 'SYSTEM', sourceRef }, SYSTEM_ACTOR);
      out.issued++;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') out.existing++;
      else if (e instanceof HttpError) out.failed.push({ payrollId: r.id, reason: e.message });
      else throw e;
    }
  }
  return out;
}

/** After a month is marked paid: never fails the payment that already committed. */
export function issuePayslipsQuietly(year: number, month: number): Promise<void> {
  return issuePayslips({ year, month }).then(
    (r) => {
      if (r.failed.length) console.warn(`[documents] payslips ${month}/${year}: ${r.issued} issued, ${r.failed.length} not issued:`, r.failed[0].reason);
    },
    (e) => console.error('[documents] payslips:', e instanceof Error ? e.message : e),
  );
}

/** Sweep (documents list opens): PAID payroll rows of the last 45 days still without a payslip. */
export async function issueDuePayslips(limit = 25): Promise<number> {
  const since = new Date(Date.now() - 45 * 86400e3);
  const paid = await prisma.payroll.findMany({ where: { status: 'PAID', paidAt: { gte: since } }, select: { id: true }, take: 2000 });
  if (!paid.length) return 0;
  const done = await prisma.documentRequest.findMany({
    where: { typeKey: 'PAYSLIP', sourceRef: { in: paid.map((p) => `payroll:${p.id}`) } },
    select: { sourceRef: true },
  });
  const have = new Set(done.map((d) => d.sourceRef));
  const due = paid.filter((p) => !have.has(`payroll:${p.id}`)).slice(0, limit).map((p) => p.id);
  if (due.length) await issuePayslips({ payrollIds: due });
  return due.length;
}

// ---------------------------------------------------------------------------
// Read: download (DOC-10) and public verification (DOC-06)
// ---------------------------------------------------------------------------

export async function readIssuedDocument(documentId: string, actor: Actor) {
  const doc = await prisma.issuedDocument.findUnique({ where: { id: documentId } });
  const def = doc ? getDocumentType(doc.typeKey) : null;
  // Same answer whether it exists or not: ids cannot be probed.
  const recipient = !!doc && def?.subject === 'COMPANY' && !!actor.employeeId
    && !!(await prisma.circularRecipient.findUnique({ where: { documentId_employeeId: { documentId: doc.id, employeeId: actor.employeeId } }, select: { id: true } }));
  if (!doc || !def || !(recipient || (await canSee(prisma, def, actor, doc.employeeId, doc.legalCompanyId)))) throw notFound('المستند غير موجود');
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
  /** Settlement statement: whether the employee accepted the discharge (the document says it counts from then). */
  release: { status: 'PENDING' | 'ACCEPTED' | 'DISPUTED'; at: string | null } | null;
  /** Contract addendum: whether the employee accepted it (it takes effect only then). */
  consent: { status: 'PENDING' | 'ACCEPTED' | 'DECLINED'; at: string | null } | null;
  /** PAdES seal: SHA-256 of the company certificate that sealed the PDF; null for documents issued before the seal. */
  sealFingerprint: string | null;
}

/** Minimal, PII-free metadata (DOC-06). Nothing from the data contract is returned. */
export async function verifyDocumentToken(token: string, ip: string | null): Promise<PublicVerification | null> {
  if (!TOKEN_RE.test(token)) return null;
  const doc = await prisma.issuedDocument.findUnique({
    where: { verifyTokenHash: hashVerifyToken(token) },
    include: {
      legalCompany: { select: { nameArabic: true, nameEnglish: true } },
      acknowledgement: { select: { decision: true, acknowledgedAt: true } },
      sealKey: { select: { fingerprint: true } },
    },
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
    release: def?.acknowledgement === 'RELEASE'
      ? {
          status: doc.acknowledgement?.decision === 'ACCEPTED' ? 'ACCEPTED' : doc.acknowledgement?.decision === 'DISPUTED' ? 'DISPUTED' : 'PENDING',
          at: doc.acknowledgement ? riyadhDate(doc.acknowledgement.acknowledgedAt) : null,
        }
      : null,
    consent: def?.acknowledgement === 'CONSENT'
      ? {
          status: doc.acknowledgement?.decision === 'ACCEPTED' ? 'ACCEPTED' : doc.acknowledgement?.decision === 'DECLINED' ? 'DECLINED' : 'PENDING',
          at: doc.acknowledgement ? riyadhDate(doc.acknowledgement.acknowledgedAt) : null,
        }
      : null,
    sealFingerprint: doc.sealKey?.fingerprint ?? null,
  };
}

/** Public certificate that sealed the document of a verification token (download from the verification page). */
export async function sealCertificateForToken(token: string): Promise<{ certDer: Buffer; number: string } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const doc = await prisma.issuedDocument.findUnique({
    where: { verifyTokenHash: hashVerifyToken(token) },
    select: { number: true, sealKey: { select: { certDer: true } } },
  });
  return doc?.sealKey ? { certDer: Buffer.from(doc.sealKey.certDer), number: doc.number } : null;
}
