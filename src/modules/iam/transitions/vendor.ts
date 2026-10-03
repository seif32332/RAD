// Radeef's vendor operations on a tenant (BL-PAY-017 / BL-PAY-022; pay-to-be.md BR-PAY-005 "جذر الثقة"،
// "إقرار الجذر لما سمّاه المالك"، "دورة حياة الجذر"، "الشخص المسمّى"، BR-PAY-020 "الملخص الشهري"; DEC-PO-016 /
// 018 / 022; RT-PAY-602 / 603 / 702 / 1301 / 1403).
//
// The ONLY writers of User.tenantRoot and of TenantNamedPerson (ADR-0007 SoT row "لوحة المورّد فقط"). The caller
// is the vendor CLI (../vendor-cli.ts), which radeef-manage runs over SSH on the tenant's host with the tenant's
// environment; the module's index.ts does not export these, no route, page or job imports this file (static test
// x-security-root.test.ts), and each refuses to run inside the Next.js server (assertVendorProcess). Each write
// runs inside an iam VENDOR operation of money.gateway (../operations.ts, SYSTEM: no tenant session), in a
// SERIALIZABLE transaction (runIdentityTransaction), once per operation key (ARCH-014), and leaves an AuditRecord naming the vendor
// operator and the reference of the owner's formal request.
//
//   setRoot            mark TENANT_ROOT; re-root to another account on a new formal request (explicit
//                      replaceCurrent); restore a suspended root (RT-PAY-603 / 1004)
//   suspendRoot        suspend the root's powers (new attestations freeze; DEC-PO-016 "تعطيل الجذر")
//   registerNamedPerson / revokeNamedPerson / linkNamedPerson   the owner's named people (RT-PAY-702 / 1403)
//   inviteNamedPerson  Radeef's invitation: the account (UNATTESTED, no creator), linked, a one-time INVITE link
//   setOwnerContact    the owner's contact of the DEC-PO-022 channel (digest, confirmations)
//   releaseCode        ROOT_ATTEST_OWN: the second-channel code, once, to the vendor operator (RT-PAY-1301)
//   (vendorStatus, the read of the panel, is ../vendor.ts)
//
// Nothing here prints, logs or stores a secret: the national id is kept as a keyed hash only, and the code of
// releaseCode is derived by the CLI from the link row (credentials.ts), never stored nor put in an audit row.
import { createHash, randomUUID } from 'crypto';
import type { Role } from '@prisma/client';
import { isAppRole, type AppRole } from '@/lib/constants';
import { badRequest, conflict, notFound } from '@/lib/http';
import { assertTransactionClient, audit, emitEvent, idempotent, runMoneyOperation, type MoneyOperation, type TxClient } from '@/modules/platform';
import {
  IDENTITY_SELECT,
  NAMED_PERSON_SELECT,
  RESET_MARKER,
  identityOf,
  isFinancialApproverRole,
  isResetMarker,
  namedLinkIntact,
  type IdentityUser,
} from '../identity';
import { VENDOR_INVITE, VENDOR_NAMED_PERSON, VENDOR_RELEASE_CODE, VENDOR_SET_ROOT, VENDOR_SUSPEND_ROOT, type IdentitySubject } from '../operations';
import { issueToken } from '../tokens';
import {
  VENDOR_EVENTS,
  actorOf,
  assertVendorProcess,
  nationalIdHashOf,
  normalizeEmail,
  normalizeMobile,
  validContext,
  type VendorContext,
} from '../vendor';

/** Body hash of a call: the same key with another request is refused (OperationKeyConflictError). No raw id. */
function fingerprint(command: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([command, input])).digest('hex');
}

function guarded<T>(tx: TxClient, op: MoneyOperation<IdentitySubject>, ctx: VendorContext, userId: string, fn: (w: TxClient) => Promise<T>): Promise<T> {
  return runMoneyOperation(tx, op, { actor: null, input: { userId }, operationKey: ctx.operationKey }, (w) => fn(w));
}

async function once<T>(tx: TxClient, ctx: VendorContext, operation: string, input: Record<string, unknown>, fn: (t: TxClient) => Promise<T>) {
  return idempotent(tx, { key: ctx.operationKey, operation, actorId: null, fingerprint: fingerprint(operation, { ...input, requestRef: ctx.requestRef }) }, fn);
}

async function userByEmail(db: TxClient, email: string): Promise<(IdentityUser & { passwordHash: string }) | null> {
  const found = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { ...IDENTITY_SELECT, passwordHash: true } });
  return found as (IdentityUser & { passwordHash: string }) | null;
}

async function currentRoot(db: TxClient): Promise<IdentityUser | null> {
  const row = await db.user.findFirst({ where: { tenantRoot: true }, select: { id: true } });
  return row ? identityOf(db, row.id) : null;
}

// ---------------------------------------------------------------------------------------------------
// TENANT_ROOT
// ---------------------------------------------------------------------------------------------------

export interface SetRootResult {
  action: 'MARKED' | 'REPLACED' | 'RESTORED' | 'UNCHANGED';
  userId: string;
  previousRootId: string | null;
}

/**
 * The owner named `email` as his trusted admin (DEC-PO-016). No root yet: MARKED. The same account suspended:
 * RESTORED (Radeef re-confirms him on the owner's request, RT-PAY-1004). Another account is root: refused unless
 * the formal request replaces it (replaceCurrent): REPLACED; the previous root loses the mark, every attestation
 * chained to him stops extending (attestationChain), his pending first-attestation links fail at completion.
 */
export async function setRoot(tx: TxClient, input: { ctx: VendorContext; email: string; replaceCurrent?: boolean }): Promise<SetRootResult & { replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.setRoot');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = normalizeEmail(input.email);
  const out = await once(tx, ctx, VENDOR_SET_ROOT.name, { email, replaceCurrent: !!input.replaceCurrent }, async (t) => {
    const target = await userByEmail(t, email);
    if (!target) throw notFound('لا يوجد حساب بهذا البريد في هذه النسخة');
    if (!target.isActive || target.documentsOnlyUntil) throw conflict('الحساب معطّل: لا يكون جذراً للثقة');
    if (target.isVendorStaff) throw conflict('حسابات رديف لا تكون جذراً للثقة في شركة العميل');
    if (!isFinancialApproverRole(target.role)) throw conflict('جذر الثقة يحمل دور معتمد مالي (مدير نظام أو موارد بشرية أو رواتب أو مالية)');
    if (isResetMarker(target.passwordHash)) throw conflict('أُعيد ضبط بيانات دخول الحساب ولم يختر صاحبه كلمة مرور بعد: يكمل رابط الضبط أولاً');
    const root = await currentRoot(t);
    if (root && root.id === target.id && !root.rootSuspendedAt) return { action: 'UNCHANGED' as const, userId: target.id, previousRootId: root.id };
    if (root && root.id !== target.id && !input.replaceCurrent) {
      throw conflict('للشركة جذر ثقة آخر: إعادة التعيين تحتاج طلباً رسمياً جديداً من المالك وتأكيد الاستبدال صراحةً');
    }
    return guarded(t, VENDOR_SET_ROOT, ctx, target.id, async (w) => {
      let action: SetRootResult['action'];
      if (root && root.id === target.id) {
        await w.user.update({ where: { id: target.id }, data: { rootSuspendedAt: null } });
        action = 'RESTORED';
      } else {
        if (root) await w.user.update({ where: { id: root.id }, data: { tenantRoot: false, rootSuspendedAt: null } });
        await w.user.update({ where: { id: target.id }, data: { tenantRoot: true, rootSuspendedAt: null } });
        action = root ? 'REPLACED' : 'MARKED';
      }
      await audit(w, {
        actor: actorOf(ctx),
        action: VENDOR_SET_ROOT.name,
        entity: { type: 'User', id: target.id },
        before: { tenantRoot: target.tenantRoot, rootSuspendedAt: target.rootSuspendedAt, previousRootId: root?.id ?? null },
        after: { tenantRoot: true, rootSuspendedAt: null, action, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      if (root && root.id !== target.id) {
        await audit(w, {
          actor: actorOf(ctx),
          action: `${VENDOR_SET_ROOT.name}.previous`,
          entity: { type: 'User', id: root.id },
          before: { tenantRoot: true, rootSuspendedAt: root.rootSuspendedAt },
          after: { tenantRoot: false, replacedBy: target.id, operator: ctx.operator, requestRef: ctx.requestRef },
          reason: `owner request ${ctx.requestRef}`,
          operationKey: ctx.operationKey,
        });
      }
      await emitEvent(w, {
        type: VENDOR_EVENTS.rootChanged,
        aggregateType: 'User',
        aggregateId: target.id,
        idempotencyKey: `${ctx.operationKey}:${VENDOR_EVENTS.rootChanged}`,
        payload: { userId: target.id, action, previousRootId: root?.id ?? null, requestRef: ctx.requestRef },
      });
      return { action, userId: target.id, previousRootId: root?.id ?? null };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

/** The owner asks Radeef to suspend the root (or the root was reset outside the app): new attestations freeze. */
export async function suspendRoot(tx: TxClient, input: { ctx: VendorContext; reason: string }): Promise<{ action: 'SUSPENDED' | 'UNCHANGED'; userId: string; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.suspendRoot');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5 || reason.length > 500) throw badRequest('سبب التعليق مطلوب (5 إلى 500 حرف)');
  const out = await once(tx, ctx, VENDOR_SUSPEND_ROOT.name, { reason }, async (t) => {
    const root = await currentRoot(t);
    if (!root) throw notFound('لا يوجد جذر ثقة في هذه النسخة');
    if (root.rootSuspendedAt) return { action: 'UNCHANGED' as const, userId: root.id };
    return guarded(t, VENDOR_SUSPEND_ROOT, ctx, root.id, async (w) => {
      const now = new Date();
      const done = await w.user.updateMany({ where: { id: root.id, tenantRoot: true, rootSuspendedAt: null }, data: { rootSuspendedAt: now } });
      if (done.count !== 1) throw conflict('تغيّر جذر الثقة؛ أعد المحاولة');
      await audit(w, {
        actor: actorOf(ctx),
        action: VENDOR_SUSPEND_ROOT.name,
        entity: { type: 'User', id: root.id },
        before: { rootSuspendedAt: null },
        after: { rootSuspendedAt: now, operator: ctx.operator, requestRef: ctx.requestRef },
        reason,
        operationKey: ctx.operationKey,
      });
      await emitEvent(w, {
        type: VENDOR_EVENTS.rootChanged,
        aggregateType: 'User',
        aggregateId: root.id,
        idempotencyKey: `${ctx.operationKey}:${VENDOR_EVENTS.rootChanged}`,
        payload: { userId: root.id, action: 'SUSPENDED', requestRef: ctx.requestRef },
      });
      return { action: 'SUSPENDED' as const, userId: root.id };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// The owner's named people (TenantNamedPerson NAMED_PERSON)
// ---------------------------------------------------------------------------------------------------

async function openNamedByEmail(db: TxClient, email: string) {
  return db.tenantNamedPerson.findFirst({ where: { kind: 'NAMED_PERSON', email, revokedAt: null }, select: NAMED_PERSON_SELECT });
}

async function namedEvent(w: TxClient, ctx: VendorContext, namedId: string, action: string, extra: Record<string, unknown> = {}) {
  await emitEvent(w, {
    type: VENDOR_EVENTS.namedPersonChanged,
    aggregateType: 'TenantNamedPerson',
    aggregateId: namedId,
    idempotencyKey: `${ctx.operationKey}:${VENDOR_EVENTS.namedPersonChanged}`,
    payload: { namedPersonId: namedId, action, requestRef: ctx.requestRef, ...extra },
  });
}

/** Registers a person the owner named (email + national id), not yet linked to an account. */
export async function registerNamedPerson(
  tx: TxClient,
  input: { ctx: VendorContext; email: string; nationalId: string; name?: string | null },
): Promise<{ namedPersonId: string; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.registerNamedPerson');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = normalizeEmail(input.email);
  const nationalIdHash = nationalIdHashOf(input.nationalId);
  const name = input.name?.toString().trim().slice(0, 200) || null;
  const out = await once(tx, ctx, `${VENDOR_NAMED_PERSON.name}.register`, { email, nationalIdHash, name }, async (t) => {
    if (await openNamedByEmail(t, email)) throw conflict('هذا البريد مسجّل مسبقاً في قائمة الأشخاص المسمَّين');
    return guarded(t, VENDOR_NAMED_PERSON, ctx, 'named-person', async (w) => {
      const row = await w.tenantNamedPerson.create({
        data: { kind: 'NAMED_PERSON', email, nationalIdHash, name, requestRef: ctx.requestRef, addedBy: ctx.operator },
        select: { id: true },
      });
      await audit(w, {
        actor: actorOf(ctx),
        action: `${VENDOR_NAMED_PERSON.name}.register`,
        entity: { type: 'TenantNamedPerson', id: row.id },
        after: { kind: 'NAMED_PERSON', email, name, nationalIdRecorded: true, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      await namedEvent(w, ctx, row.id, 'REGISTERED');
      return { namedPersonId: row.id };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

/**
 * Revokes a named person (the owner withdrew him). His pending ROOT_ATTEST_OWN links are revoked with him, and an
 * ATTESTED linked account loses its attestation in the same transaction (DEC-PO-143: UNATTESTED, dropped for
 * NAMED_PERSON_REVOKED, the dropAttestation pattern of transitions/identity.ts); only the root re-attests it
 * (ROOT_ONLY, identity.ts).
 */
export async function revokeNamedPerson(
  tx: TxClient,
  input: { ctx: VendorContext; email: string },
): Promise<{ namedPersonId: string; linksRevoked: number; attestationDropped: boolean; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.revokeNamedPerson');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = normalizeEmail(input.email);
  const out = await once(tx, ctx, `${VENDOR_NAMED_PERSON.name}.revoke`, { email }, async (t) => {
    const named = await openNamedByEmail(t, email);
    if (!named) throw notFound('لا يوجد شخص مسمّى قائم بهذا البريد');
    const holder = named.userId ? await identityOf(t, named.userId) : null;
    return guarded(t, VENDOR_NAMED_PERSON, ctx, named.userId ?? 'named-person', async (w) => {
      const done = await w.tenantNamedPerson.updateMany({
        where: { id: named.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: ctx.operator, revokeRequestRef: ctx.requestRef },
      });
      if (done.count !== 1) throw conflict('تغيّرت القائمة؛ أعد المحاولة');
      const links = await w.credentialToken.updateMany({
        where: { namedPersonId: named.id, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'NAMED_PERSON_REVOKED' },
      });
      // DEC-PO-143: an attested account of a revoked person no longer counts (compare-and-set on ATTESTED).
      let attestationDropped = false;
      if (holder && holder.identityStatus === 'ATTESTED') {
        const now = new Date();
        const dropped = await w.user.updateMany({
          where: { id: holder.id, identityStatus: 'ATTESTED' },
          data: { identityStatus: 'UNATTESTED', identityDroppedReason: 'NAMED_PERSON_REVOKED', identityDroppedAt: now },
        });
        attestationDropped = dropped.count === 1;
        if (attestationDropped) {
          await audit(w, {
            actor: actorOf(ctx),
            action: `${VENDOR_NAMED_PERSON.name}.revoke.attestationDropped`,
            entity: { type: 'User', id: holder.id },
            before: { identityStatus: 'ATTESTED', identityAttestedById: holder.identityAttestedById },
            after: { identityStatus: 'UNATTESTED', identityDroppedReason: 'NAMED_PERSON_REVOKED', namedPersonId: named.id, operator: ctx.operator, requestRef: ctx.requestRef },
            reason: `owner request ${ctx.requestRef}`,
            operationKey: ctx.operationKey,
          });
        }
      }
      await audit(w, {
        actor: actorOf(ctx),
        action: `${VENDOR_NAMED_PERSON.name}.revoke`,
        entity: { type: 'TenantNamedPerson', id: named.id },
        before: { revokedAt: null, userId: named.userId },
        after: { revoked: true, linksRevoked: links.count, attestationDropped, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      await namedEvent(w, ctx, named.id, 'REVOKED', { userId: named.userId, attestationDropped });
      return { namedPersonId: named.id, linksRevoked: links.count, attestationDropped };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

/**
 * Links a named person to the existing account with the SAME email (RT-PAY-1403: Radeef writes the link), or
 * re-links it after a break (a new linkedAt). The account is active, a tenant account, not the root.
 */
export async function linkNamedPerson(tx: TxClient, input: { ctx: VendorContext; email: string }): Promise<{ namedPersonId: string; userId: string; relinked: boolean; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.linkNamedPerson');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = normalizeEmail(input.email);
  const out = await once(tx, ctx, `${VENDOR_NAMED_PERSON.name}.link`, { email }, async (t) => {
    const named = await openNamedByEmail(t, email);
    if (!named) throw notFound('لا يوجد شخص مسمّى قائم بهذا البريد؛ سجّله أولاً');
    const user = await userByEmail(t, email);
    if (!user) throw notFound('لا يوجد حساب بهذا البريد؛ أرسل دعوة بدلاً من الربط');
    if (user.email.toLowerCase() !== email) throw conflict('بريد الحساب لا يطابق البريد المسمّى');
    if (!user.isActive || user.documentsOnlyUntil) throw conflict('الحساب معطّل');
    if (user.isVendorStaff) throw conflict('حسابات رديف لا تُربط بأشخاص المالك');
    if (user.tenantRoot) throw conflict('جذر الثقة لا يُربط بقائمة الأشخاص المسمَّين (لا يُقرّ نفسه)');
    if (named.userId && named.userId !== user.id) throw conflict('هذا الشخص المسمّى مربوط بحساب آخر');
    const other = await t.tenantNamedPerson.findFirst({ where: { userId: user.id, revokedAt: null, NOT: { id: named.id } }, select: { id: true } });
    if (other) throw conflict('الحساب مربوط بشخص مسمّى آخر');
    const relinked = named.userId === user.id;
    return guarded(t, VENDOR_NAMED_PERSON, ctx, user.id, async (w) => {
      const now = new Date();
      await w.tenantNamedPerson.update({ where: { id: named.id }, data: { userId: user.id, linkedAt: now, linkedBy: ctx.operator } });
      await audit(w, {
        actor: actorOf(ctx),
        action: `${VENDOR_NAMED_PERSON.name}.link`,
        entity: { type: 'TenantNamedPerson', id: named.id },
        before: { userId: named.userId, linkedAt: named.linkedAt },
        after: { userId: user.id, linkedAt: now, relinked, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      await namedEvent(w, ctx, named.id, relinked ? 'RELINKED' : 'LINKED', { userId: user.id });
      return { namedPersonId: named.id, userId: user.id, relinked };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

/**
 * Radeef invites a named person who has no account yet (pay-to-be "رديف ترسل دعوة الحساب إلى البريد المسمّى نفسه،
 * فيُنشأ الحساب مربوطاً بـ TenantNamedPerson"): the account is created UNATTESTED with no creator and an unusable
 * password, linked to the list entry, and a one-time INVITE link goes to the named email through the outbox
 * (iam.credentialLinkMail). The holder chooses his password; the root then attests him (ROOT_ATTEST_OWN).
 */
export async function inviteNamedPerson(
  tx: TxClient,
  input: { ctx: VendorContext; email: string; role: AppRole; name?: string | null; linkHours?: number },
): Promise<{ namedPersonId: string; userId: string; tokenId: string; expiresAt: string; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.inviteNamedPerson');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = normalizeEmail(input.email);
  if (!isAppRole(input.role)) throw badRequest('الدور غير صالح');
  const name = input.name?.toString().trim().slice(0, 200) || null;
  const hours = Number.isFinite(Number(input.linkHours)) ? Number(input.linkHours) : 72;
  const out = await once(tx, ctx, VENDOR_INVITE.name, { email, role: input.role, name, hours }, async (t) => {
    const named = await openNamedByEmail(t, email);
    if (!named) throw notFound('لا يوجد شخص مسمّى قائم بهذا البريد؛ سجّله أولاً');
    if (named.userId) throw conflict('الشخص المسمّى مربوط بحساب مسبقاً');
    if (await userByEmail(t, email)) throw conflict('يوجد حساب بهذا البريد: اربطه بدلاً من الدعوة');
    return guarded(t, VENDOR_INVITE, ctx, 'new', async (w) => {
      const created = await w.user.create({
        data: {
          email,
          // No usable password until the holder chooses one through the link (login never compares a marker).
          passwordHash: `${RESET_MARKER}${randomUUID()}`,
          role: input.role as Role,
          isActive: true,
          ...(name ? { name } : {}),
          // A tenant account, not attested: written explicitly, never left to defaults (BR-PAY-005 "التمهيد").
          isVendorStaff: false,
          identityStatus: 'UNATTESTED',
        },
        select: { id: true },
      });
      const now = new Date();
      await w.tenantNamedPerson.update({ where: { id: named.id }, data: { userId: created.id, linkedAt: now, linkedBy: ctx.operator } });
      const token = await issueToken(w, { userId: created.id, purpose: 'INVITE', sentTo: email, issuedById: null, hours, operationKey: ctx.operationKey });
      await audit(w, {
        actor: actorOf(ctx),
        action: VENDOR_INVITE.name,
        entity: { type: 'User', id: created.id },
        after: { email, role: input.role, identityStatus: 'UNATTESTED', createdById: null, namedPersonId: named.id, linkSentTo: 'namedEmail', expiresAt: token.expiresAt, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      await emitEvent(w, {
        type: VENDOR_EVENTS.invited,
        aggregateType: 'User',
        aggregateId: created.id,
        idempotencyKey: `${ctx.operationKey}:${VENDOR_EVENTS.invited}`,
        payload: { userId: created.id, namedPersonId: named.id, requestRef: ctx.requestRef },
      });
      return { namedPersonId: named.id, userId: created.id, tokenId: token.id, expiresAt: token.expiresAt.toISOString() };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// The owner's contact (DEC-PO-022)
// ---------------------------------------------------------------------------------------------------

/** Records the owner's contact from the formal request (replaces the previous one; not editable in-tenant). */
export async function setOwnerContact(
  tx: TxClient,
  input: { ctx: VendorContext; email?: string | null; mobile?: string | null; name?: string | null },
): Promise<{ ownerContactId: string; action: 'SET' | 'UNCHANGED'; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.setOwnerContact');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = input.email ? normalizeEmail(input.email) : null;
  const mobile = input.mobile ? normalizeMobile(input.mobile) : null;
  if (!email && !mobile) throw badRequest('بريد المالك أو جواله مطلوب');
  const name = input.name?.toString().trim().slice(0, 200) || null;
  const out = await once(tx, ctx, `${VENDOR_NAMED_PERSON.name}.ownerContact`, { email, mobile, name }, async (t) => {
    const current = await t.tenantNamedPerson.findFirst({ where: { kind: 'OWNER_CONTACT', revokedAt: null }, select: { id: true, email: true, mobile: true, name: true } });
    if (current && current.email === email && current.mobile === mobile && current.name === name) return { ownerContactId: current.id, action: 'UNCHANGED' as const };
    return guarded(t, VENDOR_NAMED_PERSON, ctx, 'owner-contact', async (w) => {
      if (current) {
        await w.tenantNamedPerson.update({ where: { id: current.id }, data: { revokedAt: new Date(), revokedBy: ctx.operator, revokeRequestRef: ctx.requestRef } });
      }
      const row = await w.tenantNamedPerson.create({
        data: { kind: 'OWNER_CONTACT', email, mobile, name, requestRef: ctx.requestRef, addedBy: ctx.operator },
        select: { id: true },
      });
      await audit(w, {
        actor: actorOf(ctx),
        action: `${VENDOR_NAMED_PERSON.name}.ownerContact`,
        entity: { type: 'TenantNamedPerson', id: row.id },
        before: current ? { email: current.email, mobile: current.mobile, name: current.name } : null,
        after: { email, mobile, name, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      await emitEvent(w, {
        type: VENDOR_EVENTS.ownerContactChanged,
        aggregateType: 'TenantNamedPerson',
        aggregateId: row.id,
        idempotencyKey: `${ctx.operationKey}:${VENDOR_EVENTS.ownerContactChanged}`,
        payload: { ownerContactId: row.id, previousId: current?.id ?? null, requestRef: ctx.requestRef },
      });
      return { ownerContactId: row.id, action: 'SET' as const };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// ROOT_ATTEST_OWN: the code from Radeef (RT-PAY-1301)
// ---------------------------------------------------------------------------------------------------

/**
 * Marks the pending ROOT_ATTEST_OWN link of the account as released to Radeef's operator, ONCE. The caller (the
 * vendor CLI) derives the code from the returned tokenId on the first call only (a replay never re-reveals it);
 * the operator hands it to the named person over the contact of the owner's request. Refused when the link is
 * missing, expired, used or revoked, already released, or its named link no longer holds.
 */
export async function releaseCode(tx: TxClient, input: { ctx: VendorContext; email: string }): Promise<{ tokenId: string; expiresAt: string; replayed: boolean }> {
  assertTransactionClient(tx, 'vendor.releaseCode');
  assertVendorProcess();
  const ctx = validContext(input.ctx);
  const email = normalizeEmail(input.email);
  const out = await once(tx, ctx, VENDOR_RELEASE_CODE.name, { email }, async (t) => {
    const user = await userByEmail(t, email);
    if (!user) throw notFound('لا يوجد حساب بهذا البريد');
    const token = await t.credentialToken.findFirst({
      where: { userId: user.id, purpose: 'FIRST_ATTESTATION', codeDelivery: 'VENDOR', usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, expiresAt: true, codeReleasedAt: true, namedPersonId: true },
    });
    if (!token) throw notFound('لا يوجد إقرار من الجذر بانتظار رمز رديف لهذا الحساب');
    if (token.codeReleasedAt) throw conflict('سُلّم رمز هذا الإقرار مسبقاً. لرمز جديد يبدأ الجذر الإقرار من جديد');
    const named = await t.tenantNamedPerson.findUnique({ where: { id: token.namedPersonId ?? '' }, select: NAMED_PERSON_SELECT });
    if (!named || !namedLinkIntact(named, user)) throw conflict('انفكّ ربط الحساب بالشخص المسمّى منذ بدء الإقرار: لا يُسلَّم الرمز');
    return guarded(t, VENDOR_RELEASE_CODE, ctx, user.id, async (w) => {
      const now = new Date();
      const done = await w.credentialToken.updateMany({ where: { id: token.id, codeReleasedAt: null, usedAt: null, revokedAt: null }, data: { codeReleasedAt: now } });
      if (done.count !== 1) throw conflict('تغيّر الرابط؛ أعد المحاولة');
      await audit(w, {
        actor: actorOf(ctx),
        action: VENDOR_RELEASE_CODE.name,
        entity: { type: 'User', id: user.id },
        // Never the code: only that it was released, to whom, on which request.
        after: { tokenId: token.id, codeReleasedAt: now, namedPersonId: named.id, operator: ctx.operator, requestRef: ctx.requestRef },
        reason: `owner request ${ctx.requestRef}`,
        operationKey: ctx.operationKey,
      });
      await emitEvent(w, {
        type: VENDOR_EVENTS.codeReleased,
        aggregateType: 'User',
        aggregateId: user.id,
        idempotencyKey: `${ctx.operationKey}:${VENDOR_EVENTS.codeReleased}`,
        payload: { userId: user.id, tokenId: token.id, requestRef: ctx.requestRef },
      });
      return { tokenId: token.id, expiresAt: token.expiresAt.toISOString() };
    });
  });
  return { ...out.result, replayed: out.replayed };
}
