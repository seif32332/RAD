// Radeef's vendor operations on a tenant (BL-PAY-017 / BL-PAY-022): the shared pieces (who acts, the validators,
// the process guard, the keyed national-id hash) and the read the vendor panel shows. The writers are
// transitions/vendor.ts; their only caller is the vendor CLI (vendor-cli.ts). Nothing here is exported by the
// module's index.ts: no route, page or job can reach it (static test x-security-root.test.ts).
import type { Prisma } from '@prisma/client';
import { dataKeyDigest } from '@/lib/crypto';
import { HttpError, badRequest } from '@/lib/http';
import type { AuditActor } from '@/modules/platform';
import { namedLinkIntact } from './identity';

/** Who acts and on what request: the radeef-manage operator, the owner's formal request, the operation key. */
export interface VendorContext {
  operator: string;
  requestRef: string;
  operationKey: string;
}

export const VENDOR_EVENTS = Object.freeze({
  rootChanged: 'iam.vendor.rootChanged',
  namedPersonChanged: 'iam.vendor.namedPersonChanged',
  ownerContactChanged: 'iam.vendor.ownerContactChanged',
  invited: 'iam.vendor.invited',
  codeReleased: 'iam.vendor.codeReleased',
  controlsReadinessChanged: 'iam.vendor.controlsReadinessChanged',
});

const OPERATOR = /^[A-Za-z0-9._@-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE = /^\+?[0-9]{8,15}$/;
/** A Saudi national id / iqama (10 digits, 1 or 2 first) or a passport-like id. */
const NATIONAL_ID = /^(?:[12][0-9]{9}|[A-Z0-9]{6,20})$/;

/** Refuses to run inside the Next.js server: these operations belong to the vendor CLI process only. */
export function assertVendorProcess(env: Record<string, string | undefined> = process.env): void {
  if (env.NEXT_RUNTIME) throw new HttpError(403, 'عمليات رديف (المورّد) لا تُنفَّذ من داخل التطبيق', { code: 'VENDOR_ONLY' });
}

export function validContext(ctx: VendorContext): VendorContext {
  if (!OPERATOR.test(String(ctx?.operator ?? ''))) throw badRequest('اسم مشغّل لوحة رديف غير صالح');
  const requestRef = String(ctx.requestRef ?? '').trim();
  if (requestRef.length < 3 || requestRef.length > 200) throw badRequest('مرجع الطلب الرسمي من المالك مطلوب (3 إلى 200 حرف)');
  if (!String(ctx.operationKey ?? '').trim()) throw new Error('vendor operation: an operation key is required');
  return { operator: ctx.operator, requestRef, operationKey: ctx.operationKey };
}

export function normalizeEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw badRequest('البريد الإلكتروني غير صالح');
  return email;
}

export function normalizeMobile(value: unknown): string {
  const mobile = String(value ?? '').replace(/[\s-]/g, '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!MOBILE.test(mobile)) throw badRequest('رقم الجوال غير صالح');
  return mobile;
}

export function normalizeNationalId(value: unknown): string {
  const id = String(value ?? '').replace(/[\s-]/g, '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).toUpperCase();
  if (!NATIONAL_ID.test(id)) throw badRequest('رقم الهوية أو الإقامة غير صالح');
  return id;
}

/** The keyed hash stored for a national id (never the number; key = the tenant's data key). */
export function nationalIdHashOf(nationalId: string): string {
  return dataKeyDigest('tenant-named-person-id.v1', normalizeNationalId(nationalId));
}

export const actorOf = (ctx: VendorContext): AuditActor => ({ type: 'SYSTEM', id: `vendor:${ctx.operator}` });

// ---------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------

export interface VendorStatus {
  root: { email: string; userId: string; suspendedAt: string | null; active: boolean } | null;
  namedPeople: { id: string; email: string | null; name: string | null; requestRef: string; addedAt: string; addedBy: string; linkedEmail: string | null; linkedAt: string | null; intact: boolean }[];
  ownerContact: { email: string | null; mobile: string | null; name: string | null; requestRef: string; addedAt: string } | null;
  pendingCodes: { email: string; expiresAt: string; released: boolean }[];
}

/** What the vendor panel shows (no national id, no hash, no code). */
export async function vendorStatus(db: Prisma.TransactionClient): Promise<VendorStatus> {
  const rootRow = await db.user.findFirst({ where: { tenantRoot: true }, select: { id: true, email: true, rootSuspendedAt: true, isActive: true } });
  const named = await db.tenantNamedPerson.findMany({
    where: { kind: 'NAMED_PERSON', revokedAt: null },
    orderBy: { addedAt: 'asc' },
    select: { id: true, email: true, name: true, requestRef: true, addedAt: true, addedBy: true, userId: true, linkedAt: true, kind: true, revokedAt: true },
  });
  const linkedUsers = await db.user.findMany({ where: { id: { in: named.map((n) => n.userId).filter((x): x is string => !!x) } }, select: { id: true, email: true, emailSetAt: true } });
  const owner = await db.tenantNamedPerson.findFirst({ where: { kind: 'OWNER_CONTACT', revokedAt: null }, select: { email: true, mobile: true, name: true, requestRef: true, addedAt: true } });
  const codes = await db.credentialToken.findMany({
    where: { purpose: 'FIRST_ATTESTATION', codeDelivery: 'VENDOR', usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { expiresAt: true, codeReleasedAt: true, user: { select: { email: true } } },
  });
  return {
    root: rootRow ? { email: rootRow.email, userId: rootRow.id, suspendedAt: rootRow.rootSuspendedAt?.toISOString() ?? null, active: rootRow.isActive } : null,
    namedPeople: named.map((n) => {
      const u = linkedUsers.find((x) => x.id === n.userId);
      return {
        id: n.id,
        email: n.email,
        name: n.name,
        requestRef: n.requestRef,
        addedAt: n.addedAt.toISOString(),
        addedBy: n.addedBy,
        linkedEmail: u?.email ?? null,
        linkedAt: n.linkedAt?.toISOString() ?? null,
        intact: !!u && namedLinkIntact({ ...n, kind: 'NAMED_PERSON' }, { id: u.id, email: u.email, emailSetAt: u.emailSetAt }),
      };
    }),
    ownerContact: owner ? { email: owner.email, mobile: owner.mobile, name: owner.name, requestRef: owner.requestRef, addedAt: owner.addedAt.toISOString() } : null,
    pendingCodes: codes.map((c) => ({ email: c.user.email, expiresAt: c.expiresAt.toISOString(), released: !!c.codeReleasedAt })),
  };
}

// ---------------------------------------------------------------------------------------------------
// BL-PAY-021: the controls mode, the owner digest and the owner's confirmations, as Radeef sees them
// ---------------------------------------------------------------------------------------------------

export interface VendorCompanyControls {
  companyId: string;
  /** Radeef's readiness mark (DEC-PO-144): not ready = ENFORCED whatever the count. */
  ready: boolean;
  basis: string | null;
  /** Counted approvers who can act in the company. */
  approvers: number;
  mode: 'ENFORCED' | 'SINGLE_OPERATOR';
  lastRecorded: { mode: string | null; at: string | null };
}

export interface VendorControls {
  /** Per legal company (DEC-PO-144): every company marked, in an approver's scope, named by a pending item, or asked for. */
  companies: VendorCompanyControls[];
  /** Who counts toward ENFORCED, and where ('ALL': an owner role or no scope row). */
  approvers: { email: string; role: string; root: boolean; companies: 'ALL' | string[] }[];
  ownerContact: { present: boolean; hasEmail: boolean; hasMobile: boolean };
  /** Whether the outbox can send now (G8 / SES via SMTP) and why not. */
  delivery: { live: boolean; reason: string | null };
  digests: { month: string; status: string; attempts: number; sentAt: string | null; createdAt: string }[];
  /** Classifications waiting for the owner's answer, which Radeef records with `owner-confirm`. */
  pendingOwnerConfirmations: {
    id: string;
    ruleId: string;
    companyId: string | null;
    status: string;
    blocksUntilConfirmed: boolean;
    version: number;
    kind: 'EXPLANATION' | 'WAIVER';
    text: string | null;
    reference: string | null;
    actedByEmail: string | null;
    actedAt: string | null;
  }[];
  /** What Radeef must act on (DEC-PO-022: a delivery failure alerts the tenant and Radeef). */
  alerts: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `controls` read of the vendor CLI (no national id, no hash, no digest body). `companyIds`: extra companies to show. */
export async function vendorControls(db: Prisma.TransactionClient, env: Record<string, string | undefined>, companyIdsValue?: unknown): Promise<VendorControls> {
  const [controls, { recentDigests, ownerContactOf, DIGEST_DELIVERY_PROBLEMS }, platform] = await Promise.all([import('./controls'), import('./digest'), import('@/modules/platform')]);
  const asked = Array.isArray(companyIdsValue) ? companyIdsValue.map((x) => String(x).trim().toLowerCase()) : [];
  if (asked.some((x) => !UUID.test(x)) || asked.length > 200) throw badRequest('أرقام الشركات غير صالحة');
  const approvers = await controls.controlsApprovers(db);
  const scopes = await controls.approverScopes(db, approvers);
  const pending = await platform.pendingOwnerConfirmations(db);
  const marked = await db.controlsReadiness.findMany({ distinct: ['companyId'], select: { companyId: true } });
  const scoped = await db.userCompanyScope.findMany({ distinct: ['companyId'], select: { companyId: true } });
  const ids = [...new Set([...marked.map((m) => m.companyId), ...scoped.map((m) => m.companyId), ...pending.map((p) => p.companyId).filter((x): x is string => !!x), ...asked])].sort();
  const states = await controls.controlsOfCompanies(db, ids);
  const companies: VendorCompanyControls[] = [];
  for (const st of states) {
    const last = await controls.lastRecordedControlsMode(db, st.companyId);
    companies.push({ ...st, lastRecorded: { mode: last.mode, at: last.at?.toISOString() ?? null } });
  }
  const contact = await ownerContactOf(db);
  const cfg = platform.outboxSendConfig(env);
  const digests = await recentDigests(db);
  const actors = await db.user.findMany({ where: { id: { in: pending.map((p) => p.actedById).filter((x): x is string => !!x) } }, select: { id: true, email: true } });
  const single = companies.filter((c) => c.ready && c.mode === 'SINGLE_OPERATOR');
  const alerts: string[] = [];
  if (!contact) alerts.push(single.length ? `OWNER_CONTACT_MISSING (FATAL: ${single.length} ready company(ies) in SINGLE_OPERATOR; the owner-digest job fails)` : 'OWNER_CONTACT_MISSING');
  else if (!contact.email) alerts.push('OWNER_EMAIL_MISSING');
  if (!cfg.live) alerts.push(`DELIVERY_NOT_CONFIGURED: ${cfg.reason}`);
  for (const d of digests) if (DIGEST_DELIVERY_PROBLEMS.includes(d.status)) alerts.push(`DIGEST_${d.status}: ${d.month}`);
  if (pending.length) alerts.push(`OWNER_CONFIRMATIONS_PENDING: ${pending.length}`);
  return {
    companies,
    approvers: approvers.map((u) => {
      const sc = scopes.get(u.id);
      return { email: u.email, role: u.role, root: u.tenantRoot && !u.rootSuspendedAt, companies: sc === 'ALL' || !sc ? ('ALL' as const) : [...sc].sort() };
    }),
    ownerContact: { present: !!contact, hasEmail: !!contact?.email, hasMobile: !!contact?.mobile },
    delivery: { live: cfg.live, reason: cfg.reason },
    digests,
    pendingOwnerConfirmations: pending.map((p) => ({
      id: p.id,
      ruleId: p.ruleId,
      companyId: p.companyId,
      status: p.status,
      blocksUntilConfirmed: !!p.pendingAction,
      version: p.version,
      kind: p.waiverReason ? ('WAIVER' as const) : ('EXPLANATION' as const),
      text: p.waiverReason ?? p.explanation,
      reference: p.explanationRef,
      actedByEmail: actors.find((a) => a.id === p.actedById)?.email ?? null,
      actedAt: p.actedAt?.toISOString() ?? null,
    })),
    alerts,
  };
}

const MONTH = /^(\d{4})-(\d{2})$/;

/** The `digest` read: one month's queued digest (the text Radeef relays to the owner until G8). */
export async function vendorDigest(db: Prisma.TransactionClient, monthValue: unknown) {
  const m = MONTH.exec(String(monthValue ?? '').trim());
  if (!m) throw badRequest('الشهر بصيغة YYYY-MM');
  const { queuedDigest, monthPeriod } = await import('./digest');
  const month = { year: Number(m[1]), month: Number(m[2]) };
  monthPeriod(month); // validates the range
  const row = await queuedDigest(db, month);
  if (!row) throw new HttpError(404, 'لا يوجد ملخص مسجّل لهذا الشهر (لم يكن فيه ما يُبلَّغ، أو لم تسجّل رديف جهة اتصال المالك بعد)');
  return row;
}

/** The owner's answer recorded by Radeef (DEC-PO-022 channel until G8, RT-PAY-1205): CONFIRMED or REJECTED. */
export function ownerDecisionOf(value: unknown): 'CONFIRMED' | 'REJECTED' {
  const v = String(value ?? '').trim().toUpperCase();
  if (v !== 'CONFIRMED' && v !== 'REJECTED') throw badRequest('قرار المالك: CONFIRMED أو REJECTED');
  return v;
}
