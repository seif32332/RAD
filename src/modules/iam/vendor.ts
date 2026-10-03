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
