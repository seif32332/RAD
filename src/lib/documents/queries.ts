// Read models for the documents screens (portal "مستنداتي" and the HR queue).
import 'server-only';
import { prisma } from '@/lib/prisma';
import { roleIn } from '@/lib/constants';
import { validityStatus, effectivePolicy } from './policy';
import { DOCUMENT_TYPES, getDocumentType } from './types';
import { issuanceReadiness, staffCan, staffCompanyScope, type Actor } from './service';

const typeLabel = (key: string) => getDocumentType(key)?.labelAr ?? key;

function docView(d: { id: string; number: string; issuedAt: Date; validUntil: Date | null; status: string; purgedAt: Date | null; revokeReason: string | null }) {
  return { id: d.id, number: d.number, issuedAt: d.issuedAt, validUntil: d.validUntil, status: d.status, validity: validityStatus(d), revokeReason: d.revokeReason };
}

function jobView(j: { status: string; lastError: string | null; attempts: number; number: string } | null) {
  if (!j || j.status === 'DONE') return null;
  return { status: j.status, lastError: j.lastError, attempts: j.attempts, number: j.number };
}

/** Types the employee may request from the portal (policy of his legal company). */
export async function portalTypesFor(employeeId: string) {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { legalCompanyId: true, isTerminated: true } });
  if (!e?.legalCompanyId) return { available: [], reason: 'الشركة النظامية غير محددة في ملفك؛ تواصل مع الموارد البشرية' };
  // Not configured for this company yet: the portal keeps the manual request flow (gradual rollout).
  if (!(await issuanceReadiness(prisma, e.legalCompanyId)).ready) return { available: [], reason: null };
  const settings = await prisma.documentTypeSetting.findMany({ where: { companyId: e.legalCompanyId } });
  const available = Object.values(DOCUMENT_TYPES)
    .map((def) => ({ def, policy: effectivePolicy(def, settings.find((s) => s.typeKey === def.key) ?? null) }))
    .filter(({ def, policy }) => policy.enabled && policy.selfService && !(def.requiresActiveEmployee && e.isTerminated))
    .map(({ def, policy }) => ({ key: def.key, labelAr: def.labelAr, labelEn: def.labelEn, validityDays: policy.validityDays }));
  return { available, reason: null };
}

export async function myDocumentRequests(employeeId: string) {
  const rows = await prisma.documentRequest.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      issuedDocument: { select: { id: true, number: true, issuedAt: true, validUntil: true, status: true, purgedAt: true, revokeReason: true } },
      renderJob: { select: { status: true, lastError: true, attempts: true, number: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    typeKey: r.typeKey,
    typeLabel: typeLabel(r.typeKey),
    language: (JSON.parse(r.paramsJson) as { language?: string }).language ?? 'ar',
    status: r.status,
    createdAt: r.createdAt,
    rejectReason: r.rejectReason,
    document: r.issuedDocument ? docView(r.issuedDocument) : null,
    processing: jobView(r.renderJob),
  }));
}

const employeeName = (e: { firstNameArabic: string; lastNameArabic: string; employeeId: string }) => ({ name: `${e.firstNameArabic} ${e.lastNameArabic}`, employeeNumber: e.employeeId });

/** HR queue: pending approvals, processing problems, recent documents; filtered to the actor's types. */
export async function staffDocumentOverview(actor: Actor, opts: { q?: string; employeeId?: string } = {}) {
  const typeKeys = Object.values(DOCUMENT_TYPES).filter((d) => !!actor.role && roleIn(actor.role, d.staffRoles)).map((d) => d.key);
  const employee = { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } } as const;
  const q = opts.q?.trim();
  const search = q
    ? { OR: [
        { number: { contains: q, mode: 'insensitive' as const } },
        { employee: { employeeId: { contains: q, mode: 'insensitive' as const } } },
        { employee: { firstNameArabic: { contains: q } } },
        { employee: { lastNameArabic: { contains: q } } },
      ] }
    : {};
  const scope = await staffCompanyScope(prisma, actor);
  const forEmployee = { ...(opts.employeeId ? { employeeId: opts.employeeId } : {}), ...(scope ? { legalCompanyId: { in: scope } } : {}) };
  const [pending, stuck, issued] = await Promise.all([
    prisma.documentRequest.findMany({
      where: { typeKey: { in: typeKeys }, status: 'PENDING_APPROVAL', ...forEmployee },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { employee, legalCompany: { select: { nameArabic: true } } },
    }),
    prisma.documentRequest.findMany({
      where: { typeKey: { in: typeKeys }, status: 'APPROVED', renderJob: { status: { in: ['FAILED', 'BLOCKED', 'RENDERING', 'QUEUED'] } }, ...forEmployee },
      include: { employee, renderJob: { select: { status: true, lastError: true, attempts: true, number: true } } },
      take: 50,
    }),
    prisma.issuedDocument.findMany({
      where: { typeKey: { in: typeKeys }, ...search, ...forEmployee },
      orderBy: { issuedAt: 'desc' },
      take: 100,
      include: { employee, legalCompany: { select: { nameArabic: true } } },
    }),
  ]);
  return {
    types: typeKeys.map((k) => ({ key: k, labelAr: typeLabel(k) })),
    pending: pending.map((r) => ({
      id: r.id, typeKey: r.typeKey, typeLabel: typeLabel(r.typeKey), source: r.source, createdAt: r.createdAt,
      company: r.legalCompany.nameArabic, ...employeeName(r.employee),
    })),
    processing: stuck.map((r) => ({ id: r.id, typeLabel: typeLabel(r.typeKey), ...employeeName(r.employee), job: jobView(r.renderJob) })),
    issued: issued.map((d) => ({ ...docView(d), typeKey: d.typeKey, typeLabel: typeLabel(d.typeKey), company: d.legalCompany.nameArabic, ...employeeName(d.employee) })),
  };
}

/**
 * Request detail. For an approver it includes the snapshot content and its hash: the approval
 * is bound to exactly what is shown here (DOC-05).
 */
export async function documentRequestDetail(requestId: string, actor: Actor) {
  const r = await prisma.documentRequest.findUnique({
    where: { id: requestId },
    include: {
      currentSnapshot: true,
      employee: { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } },
      legalCompany: { select: { nameArabic: true } },
      approvals: { orderBy: { decidedAt: 'asc' }, select: { decision: true, decidedAt: true, invalidatedAt: true, invalidReason: true, note: true } },
      issuedDocument: { select: { id: true, number: true, issuedAt: true, validUntil: true, status: true, purgedAt: true, revokeReason: true } },
      renderJob: { select: { status: true, lastError: true, attempts: true, number: true } },
    },
  });
  const def = r ? getDocumentType(r.typeKey) : null;
  const isStaff = !!r && !!def && (await staffCan(prisma, def, actor, r.legalCompanyId));
  const isSignatory = !!r && !!actor.userId && !!(await prisma.signatory.findFirst({ where: { userId: actor.userId, companyId: r.legalCompanyId, isActive: true }, select: { id: true } }));
  if (!r || !def || !(isStaff || isSignatory || (actor.employeeId && actor.employeeId === r.employeeId))) return null;
  const material = r.currentSnapshot ? JSON.parse(r.currentSnapshot.data) : null;
  return {
    id: r.id,
    typeKey: r.typeKey,
    typeLabel: def.labelAr,
    status: r.status,
    source: r.source,
    createdAt: r.createdAt,
    rejectReason: r.rejectReason,
    company: r.legalCompany.nameArabic,
    ...employeeName(r.employee),
    params: material?.params ?? null,
    snapshot: r.currentSnapshot ? { sha256: r.currentSnapshot.dataSha256, createdAt: r.currentSnapshot.createdAt, data: material?.data ?? null } : null,
    approvals: r.approvals,
    document: r.issuedDocument ? docView(r.issuedDocument) : null,
    processing: jobView(r.renderJob),
    canDecide: (isStaff || isSignatory) && r.status === 'PENDING_APPROVAL' && actor.employeeId !== r.employeeId,
  };
}
