// Read models for the documents screens (portal "مستنداتي" and the HR queue).
import 'server-only';
import { prisma } from '@/lib/prisma';
import { decryptField } from '@/lib/crypto';
import { normalizeIban } from '@/lib/iban';
import { roleIn } from '@/lib/constants';
import { validityStatus, effectivePolicy } from './policy';
import { DOCUMENT_TYPES, getDocumentType } from './types';
import { issuanceReadiness, staffCan, staffCompanyScope, type Actor } from './service';

const typeLabel = (key: string) => getDocumentType(key)?.labelAr ?? key;

type DocRow = {
  id: string; number: string; typeKey: string; issuedAt: Date; validUntil: Date | null; status: string; purgedAt: Date | null; revokeReason: string | null;
  acknowledgement?: { acknowledgedAt: Date; decision: string; comment: string | null } | null;
};

function docView(d: DocRow) {
  const kind = getDocumentType(d.typeKey)?.acknowledgement ?? null;
  return {
    id: d.id, number: d.number, issuedAt: d.issuedAt, validUntil: d.validUntil, status: d.status, validity: validityStatus(d), revokeReason: d.revokeReason,
    // Warning: receipt; settlement statement: discharge accepted or disputed (null = not applicable).
    acknowledgement: kind
      ? { kind, at: d.acknowledgement?.acknowledgedAt ?? null, decision: d.acknowledgement?.decision ?? null, comment: d.acknowledgement?.comment ?? null }
      : null,
  };
}

const DOC_SELECT = {
  id: true, number: true, typeKey: true, issuedAt: true, validUntil: true, status: true, purgedAt: true, revokeReason: true,
  acknowledgement: { select: { acknowledgedAt: true, decision: true, comment: true } },
} as const;

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
    .map(({ def, policy }) => ({ key: def.key, labelAr: def.labelAr, labelEn: def.labelEn, validityDays: policy.validityDays, languages: def.languages, noc: def.key === 'NO_OBJECTION', commencement: def.facts === 'COMMENCEMENT' }));
  return { available, reason: null };
}

/** Circulars addressed to the employee, as rows of "مستنداتي" (acknowledged like a receipt). */
async function myCirculars(employeeId: string) {
  const rows = await prisma.circularRecipient.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { document: { select: { id: true, number: true, typeKey: true, issuedAt: true, validUntil: true, status: true, purgedAt: true, revokeReason: true, snapshot: { select: { data: true } } } } },
  });
  return rows.map((r) => {
    const def = getDocumentType(r.document.typeKey);
    const c = r.document.snapshot.data ? (JSON.parse(r.document.snapshot.data) as { data?: { circular?: { kind: string; subjectAr: string; acknowledge: boolean } } }).data?.circular : undefined;
    const title = c && def?.titleOf ? def.titleOf({ circular: c }).ar : typeLabel(r.document.typeKey);
    const view = docView({ ...r.document, acknowledgement: null });
    return {
      id: `circular:${r.document.id}`,
      typeKey: r.document.typeKey,
      typeLabel: c ? `${title}: ${c.subjectAr}` : title,
      source: 'HR',
      language: 'ar',
      status: 'ISSUED',
      createdAt: r.document.issuedAt,
      rejectReason: null,
      document: {
        ...view,
        acknowledgement: c?.acknowledge === false ? null : { kind: 'RECEIPT' as const, at: r.acknowledgedAt, decision: r.acknowledgedAt ? 'RECEIVED' : null, comment: null },
      },
      processing: null,
    };
  });
}

export async function myDocumentRequests(employeeId: string) {
  const circulars = await myCirculars(employeeId);
  const rows = await prisma.documentRequest.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      issuedDocument: { select: DOC_SELECT },
      renderJob: { select: { status: true, lastError: true, attempts: true, number: true } },
    },
  });
  // Locked documents (warning, termination notice, minutes, decisions) are HR's act: the employee
  // sees them only once issued, whoever created the request (HR or the system).
  const own = rows.filter((r) => r.status === 'ISSUED' || !getDocumentType(r.typeKey)?.approvalLocked).map((r) => ({
    id: r.id,
    typeKey: r.typeKey,
    typeLabel: typeLabel(r.typeKey),
    source: r.source,
    language: (JSON.parse(r.paramsJson) as { language?: string }).language ?? 'ar',
    status: r.status,
    createdAt: r.createdAt,
    rejectReason: r.rejectReason,
    document: r.issuedDocument ? docView(r.issuedDocument) : null,
    processing: jobView(r.renderJob),
  }));
  return [...own, ...circulars].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 60);
}

/** Display name of a document's subject: the employee, or the job applicant (offer). */
const employeeName = (e: { firstNameArabic: string; lastNameArabic: string; employeeId: string } | null, c?: { candidateName: string } | null) =>
  e ? { name: `${e.firstNameArabic} ${e.lastNameArabic}`, employeeNumber: e.employeeId, candidate: false }
    : c ? { name: c.candidateName, employeeNumber: 'مرشح', candidate: true }
      : { name: 'مجموعة من الموظفين', employeeNumber: 'قرار / تعميم', candidate: false };

/** HR queue: pending approvals, processing problems, recent documents; filtered to the actor's types. */
export async function staffDocumentOverview(actor: Actor, opts: { q?: string; employeeId?: string } = {}) {
  const typeKeys = Object.values(DOCUMENT_TYPES).filter((d) => !!actor.role && roleIn(actor.role, d.staffRoles)).map((d) => d.key);
  const employee = { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } } as const;
  const jobApplication = { select: { candidateName: true } } as const;
  const q = opts.q?.trim();
  const search = q
    ? { OR: [
        { number: { contains: q, mode: 'insensitive' as const } },
        { employee: { employeeId: { contains: q, mode: 'insensitive' as const } } },
        { employee: { firstNameArabic: { contains: q } } },
        { employee: { lastNameArabic: { contains: q } } },
        { jobApplication: { candidateName: { contains: q } } },
      ] }
    : {};
  const scope = await staffCompanyScope(prisma, actor);
  const forEmployee = { ...(opts.employeeId ? { employeeId: opts.employeeId } : {}), ...(scope ? { legalCompanyId: { in: scope } } : {}) };
  const [pending, stuck, issued] = await Promise.all([
    prisma.documentRequest.findMany({
      where: { typeKey: { in: typeKeys }, status: 'PENDING_APPROVAL', ...forEmployee },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { employee, jobApplication, legalCompany: { select: { nameArabic: true } } },
    }),
    prisma.documentRequest.findMany({
      where: { typeKey: { in: typeKeys }, status: 'APPROVED', renderJob: { status: { in: ['FAILED', 'BLOCKED', 'RENDERING', 'QUEUED'] } }, ...forEmployee },
      include: { employee, jobApplication, renderJob: { select: { status: true, lastError: true, attempts: true, number: true } } },
      take: 50,
    }),
    prisma.issuedDocument.findMany({
      where: { typeKey: { in: typeKeys }, ...search, ...forEmployee },
      orderBy: { issuedAt: 'desc' },
      take: 100,
      include: { employee, jobApplication, legalCompany: { select: { nameArabic: true } }, acknowledgement: { select: { acknowledgedAt: true, decision: true, comment: true } }, _count: { select: { recipients: true } } },
    }),
  ]);
  // Circulars: how many of the recipients acknowledged.
  const circularIds = issued.filter((d) => d._count.recipients > 0).map((d) => d.id);
  const acked = circularIds.length
    ? await prisma.circularRecipient.groupBy({ by: ['documentId'], where: { documentId: { in: circularIds }, acknowledgedAt: { not: null } }, _count: { _all: true } })
    : [];
  return {
    types: typeKeys.map((k) => {
      const d = getDocumentType(k)!;
      // What the issue form asks for: a warning's text, and the languages the template supports.
      return {
        key: k, labelAr: d.labelAr, languages: d.languages, warningText: k === 'WARNING_LETTER', settlement: d.facts === 'SETTLEMENT',
        terminationNotice: k === 'TERMINATION_NOTICE', noc: k === 'NO_OBJECTION', promotion: k === 'PROMOTION_DECISION', addendum: k === 'CONTRACT_ADDENDUM', circular: d.subject === 'COMPANY', commencement: d.facts === 'COMMENCEMENT', candidate: d.subject === 'CANDIDATE', addressable: !d.addressedToEmployee && d.facts !== 'SETTLEMENT', auto: d.issuance === 'AUTO',
        // Requests that answer a record (resignation) are created by the system, not from this form.
        fromRecord: d.facts === 'TERMINATION',
      };
    }),
    pending: pending.map((r) => ({
      id: r.id, typeKey: r.typeKey, typeLabel: typeLabel(r.typeKey), source: r.source, createdAt: r.createdAt,
      company: r.legalCompany.nameArabic, ...employeeName(r.employee, r.jobApplication),
    })),
    processing: stuck.map((r) => ({ id: r.id, typeLabel: typeLabel(r.typeKey), ...employeeName(r.employee, r.jobApplication), job: jobView(r.renderJob) })),
    issued: issued.map((d) => ({
      ...docView(d), typeKey: d.typeKey, typeLabel: typeLabel(d.typeKey), company: d.legalCompany.nameArabic, ...employeeName(d.employee, d.jobApplication),
      circular: d._count.recipients ? { total: d._count.recipients, acknowledged: acked.find((a) => a.documentId === d.id)?._count._all ?? 0 } : null,
    })),
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
      jobApplication: { select: { candidateName: true } },
      legalCompany: { select: { nameArabic: true } },
      approvals: { orderBy: { decidedAt: 'asc' }, select: { decision: true, decidedAt: true, invalidatedAt: true, invalidReason: true, note: true } },
      issuedDocument: { select: DOC_SELECT },
      renderJob: { select: { status: true, lastError: true, attempts: true, number: true } },
    },
  });
  const def = r ? getDocumentType(r.typeKey) : null;
  const isStaff = !!r && !!def && (await staffCan(prisma, def, actor, r.legalCompanyId));
  const isSignatory = !!r && !!actor.userId && !!(await prisma.signatory.findFirst({ where: { userId: actor.userId, companyId: r.legalCompanyId, isActive: true }, select: { id: true } }));
  const isSubject = !!actor.employeeId && actor.employeeId === r?.employeeId && !(def?.approvalLocked && r?.status !== 'ISSUED');
  if (!r || !def || !(isStaff || isSignatory || isSubject)) return null;
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
    ...employeeName(r.employee, r.jobApplication),
    params: material?.params ?? null,
    snapshot: r.currentSnapshot ? { sha256: r.currentSnapshot.dataSha256, createdAt: r.currentSnapshot.createdAt, data: material?.data ?? null } : null,
    approvals: r.approvals,
    document: r.issuedDocument ? docView(r.issuedDocument) : null,
    processing: jobView(r.renderJob),
    canDecide: (isStaff || isSignatory) && r.status === 'PENDING_APPROVAL' && actor.employeeId !== r.employeeId
      && !(def.approvalLocked && r.requestedById === actor.userId),
    /** Maker-checker types: the author sees why he cannot approve his own text. */
    ownRequest: !!def.approvalLocked && !!actor.userId && r.requestedById === actor.userId,
  };
}

/** Paid settlements of an employee, for issuing a settlement statement (staff of that type only). */
export async function paidSettlementsFor(actor: Actor, employeeId: string) {
  const def = getDocumentType('SETTLEMENT_STATEMENT')!;
  if (!actor.role || !roleIn(actor.role, def.staffRoles)) return null;
  const rows = await prisma.settlement.findMany({
    where: { employeeId, status: 'PAID' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, type: true, totalSettlement: true, paidAt: true, paymentReference: true, createdAt: true },
  });
  return rows.map((s) => ({
    id: s.id,
    label: `${s.type === 'END_OF_SERVICE' ? 'نهاية خدمة' : 'تسوية إجازة'} · ${(s.totalSettlement ?? 0).toFixed(2)} ر.س`,
    paidAt: s.paidAt,
    hasProof: !!s.paidAt && !!s.paymentReference,
  }));
}

/** Concluded investigations of an employee, for an Article 80 termination notice (HR of that type only). */
export async function concludedInvestigationsFor(actor: Actor, employeeId: string) {
  const def = getDocumentType('TERMINATION_NOTICE')!;
  if (!actor.role || !roleIn(actor.role, def.staffRoles)) return null;
  const rows = await prisma.investigation.findMany({
    where: { employeeId, status: { in: ['COMPLETED_GUILTY', 'CLOSED'] } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { id: true, subject: true, status: true, updatedAt: true },
  });
  return rows.map((r) => ({ id: r.id, label: `${r.subject}${r.status === 'COMPLETED_GUILTY' ? ' · إدانة' : ' · مغلق'}`, closedAt: r.updatedAt }));
}

/**
 * Owner decision 2026-09-26 (warning only): the employee has a valid salary transfer letter that
 * commits the company to another bank / IBAN than the one just saved. Returns the warning text.
 */
export async function salaryTransferConflict(employeeId: string, ibanStored: string | null, bankName: string | null): Promise<string | null> {
  const letters = await prisma.issuedDocument.findMany({
    where: { employeeId, typeKey: 'SALARY_TRANSFER', status: 'ISSUED', purgedAt: null, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] },
    orderBy: { issuedAt: 'desc' },
    select: { number: true, snapshot: { select: { data: true } } },
  });
  if (!letters.length) return null;
  let iban = '';
  try {
    iban = normalizeIban(decryptField(ibanStored) ?? '');
  } catch {
    iban = '';
  }
  for (const l of letters) {
    const committed = (JSON.parse(l.snapshot.data) as { data?: { bank?: { name: string; iban: string } } }).data?.bank;
    if (!committed) continue;
    if (committed.iban !== iban || (bankName ?? '').trim() !== committed.name) {
      return `يوجد خطاب تحويل راتب ساري (${l.number}) تلتزم فيه الشركة بالتحويل إلى ${committed.name} (آيبان ينتهي بـ ${committed.iban.slice(-4)}). البيانات البنكية الجديدة تخالفه: لا تُحوَّل الرواتب إلى البنك الجديد قبل استلام خطاب إخلاء طرف من البنك، ثم ألغِ الخطاب من المستندات الرسمية.`;
    }
  }
  return null;
}

/** Open job applications (for a job offer) and the legal companies the actor may issue from. */
/** A circular's recipients and who acknowledged (staff of the type, within the company scope). */
export async function circularRecipientsFor(documentId: string, actor: Actor) {
  const doc = await prisma.issuedDocument.findUnique({ where: { id: documentId }, select: { id: true, typeKey: true, legalCompanyId: true } });
  const def = doc ? getDocumentType(doc.typeKey) : null;
  if (!doc || !def || def.subject !== 'COMPANY' || !(await staffCan(prisma, def, actor, doc.legalCompanyId))) return null;
  const rows = await prisma.circularRecipient.findMany({
    where: { documentId },
    include: { employee: { select: { employeeId: true, firstNameArabic: true, lastNameArabic: true } } },
    orderBy: [{ acknowledgedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({ employeeNumber: r.employee.employeeId, name: `${r.employee.firstNameArabic} ${r.employee.lastNameArabic}`, acknowledgedAt: r.acknowledgedAt }));
}

export async function offerCandidatesFor(actor: Actor) {
  const def = getDocumentType('JOB_OFFER')!;
  if (!actor.role || !roleIn(actor.role, def.staffRoles)) return null;
  const scope = await staffCompanyScope(prisma, actor);
  const [apps, companies] = await Promise.all([
    prisma.jobApplication.findMany({
      where: { status: { in: ['APPLIED', 'INTERVIEW', 'OFFERED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { id: true, candidateName: true, status: true, jobRequest: { select: { jobTitle: true } } },
    }),
    prisma.company.findMany({ where: scope ? { id: { in: scope } } : {}, select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
  ]);
  return {
    candidates: apps.map((a) => ({ id: a.id, label: `${a.candidateName} · ${a.jobRequest.jobTitle}`, jobTitle: a.jobRequest.jobTitle, status: a.status })),
    companies: companies.map((c) => ({ id: c.id, label: c.nameArabic })),
  };
}
