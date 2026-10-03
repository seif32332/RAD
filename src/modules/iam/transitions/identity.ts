// Identity controls: the writers (BL-PAY-005; pay-to-be.md BR-PAY-005, §2; DEC-PO-013 / 016 / 021 / 024 /
// 027; RT-PAY-302 / 404 / 801 / 901 / 1001 / 1102 / 1201 / 1301). The only code that writes the identity
// tables (UserEmployeeLink, CredentialToken, IdentityChangeRequest), the User control and credential columns
// and Employee.userId (the access link, projection of UserEmployeeLink): each write runs inside an iam
// operation of money.gateway (../operations.ts), which refuses those writes anywhere else.
//
//   createUser                   an admin creates an account: createdById = the session user, UNATTESTED
//   proposeLink → confirmLink    the two-step link (BR-PAY-005): a second person confirms; no self-link;
//                                ENFORCED refuses the proposer, the account's creator or an unattested
//                                confirmer, SINGLE_OPERATOR records the self-act (BR-PAY-020)
//   rejectLink / endLink         a proposal refused or withdrawn; a link ended (unlink), audited
//   attestIdentity               chained to TENANT_ROOT (DEC-PO-016). A first attestation (or an email never
//                                confirmed) opens the two-channel setup: a one-time link to the attested
//                                email + a code the attester hands over in person; the account is ATTESTED
//                                only when the holder used both (RT-PAY-1102 / 1201). After a reset or a
//                                promotion only the root re-attests (DEC-PO-027)
//   completeCredentialSetup      the holder chooses his password with the link (+ code); sessionVersion++
//   requestCredentialReset       identity.resetCredentials (DEC-PO-024 / 027): UNATTESTED at once, every
//                                session ends, the old password stops working, a one-time link goes to the
//                                attested email; two people for an account that counts (DEC-PO-021 rule)
//   changeUserByAdmin            role / active / email of an account: promoteApprover (attestation dropped,
//                                root re-attests), deactivateApprover / demotion of a protected account as a
//                                two-person request (DEC-PO-021); an attested email is never changed in-app
//   decideChangeRequest          the second person approves (the change runs), rejects; the requester cancels
//   changeOwnPassword / rehashLegacyPassword / changeOwnEmail   the named self-change operations (RT-PAY-904)
//
// Every exported transition takes an operation key (a repeat replays the first result, ARCH-014), except
// completeCredentialSetup whose single use is the link itself (a second call finds it used: 410).
// Side effects never run here: a link is sent by the consumer of iam.credentialLink.issued (../consumers.ts)
// through the outbox, and the link secret is rendered only at send time (../credentials.ts).
import { randomUUID } from 'crypto';
import { Prisma, type Role, type UserEmployeeLinkStatus } from '@prisma/client';
import { isAppRole, type AppRole } from '@/lib/constants';
import { HttpError, badRequest, conflict, forbidden, notFound } from '@/lib/http';
import {
  assertTransactionClient,
  audit,
  auditTrailOf,
  emitEvent,
  idempotent,
  resolveOperatorMode,
  runMoneyOperation,
  type GuardDecision,
  type MoneyActor,
  type MoneyOperation,
  type MoneyRunInfo,
  type TxClient,
} from '@/modules/platform';
import {
  CODE_MAX_ATTEMPTS,
  credentialCodeFor,
  credentialCodeHash,
  credentialCodeMatches,
  credentialFingerprintMatches,
  credentialFingerprintOf,
  credentialTokenFor,
  credentialTokenHash,
  credentialTokenId,
  credentialTokenMatches,
} from '../credentials';
import {
  ATTEST_MESSAGES,
  CREDENTIAL_LINK_ISSUED_EVENT,
  OPEN_LINK_STATUSES,
  RESET_MARKER,
  EMAIL_CHANGED_BY_ADMIN_EVENT,
  RESET_NOTICE_PREVIOUS_EMAIL_EVENT,
  RESET_NOTICE_WINDOW_HOURS,
  TOKEN_SELECT,
  attestProblems,
  attesterSide,
  canApproveChange,
  creatorAncestry,
  creatorUnknown,
  emailOwnedByHolder,
  isActingRoot,
  emailSetBySide,
  identityOf,
  isFinancialApproverRole,
  linkConfirmReasons,
  needsTwoChannel,
  protectedByTwoPerson,
  type IdentityUser,
} from '../identity';
import {
  ATTEST,
  CHANGE_DECIDE,
  CHANGE_REQUEST,
  CREDENTIAL_COMPLETE,
  CREDENTIAL_RESET,
  LINK_CONFIRM,
  LINK_END,
  LINK_PROPOSE,
  SELF_CHANGE_EMAIL,
  SELF_CHANGE_PASSWORD,
  SELF_REHASH_PASSWORD,
  USER_CHANGE,
  USER_CREATE,
  USER_PROMOTE,
  type IdentitySubject,
} from '../operations';


const MIN_NOTE = 10;

function needText(value: string | null | undefined, what: string): string {
  const t = (value ?? '').trim();
  if (t.length < MIN_NOTE) throw badRequest(`${what} مطلوب (${MIN_NOTE} أحرف على الأقل)`);
  if (t.length > 1000) throw badRequest(`${what} طويل جداً`);
  return t;
}

function needKey(key: string | null | undefined, what: string): string {
  if (!key?.trim()) throw new Error(`${what}: an operation key is required`);
  return key;
}

async function loadIdentity(tx: TxClient, userId: string, what = 'المستخدم غير موجود'): Promise<IdentityUser> {
  const u = await identityOf(tx, userId);
  if (!u) throw notFound(what);
  return u;
}

function clampHours(hours: number | null | undefined): number {
  const n = Number(hours);
  if (!Number.isFinite(n)) return 24;
  return Math.min(72, Math.max(1, Math.floor(n)));
}

function selfActDecision(reasons: GuardDecision['reasons'], mode: 'ENFORCED' | 'SINGLE_OPERATOR'): GuardDecision {
  if (!reasons.length) return { ok: true, reasons, selfAct: false };
  return mode === 'SINGLE_OPERATOR' ? { ok: true, reasons, selfAct: true } : { ok: false, reasons, selfAct: false };
}

/** Runs `fn` behind the gateway under the iam operation `op` for `subject`. */
function guarded<T>(
  tx: TxClient,
  op: MoneyOperation<IdentitySubject>,
  spec: { actor: MoneyActor | null; userId: string; operationKey: string; decision?: GuardDecision; mode?: 'ENFORCED' | 'SINGLE_OPERATOR' },
  fn: (w: TxClient, info: MoneyRunInfo) => Promise<T>,
): Promise<T> {
  return runMoneyOperation(tx, op, { actor: spec.actor, input: { userId: spec.userId }, operationKey: spec.operationKey, decision: spec.decision, mode: spec.mode }, fn);
}

/** Revokes the account's usable links (a new link, a reset or an email change supersedes them). */
async function revokeOpenTokens(w: TxClient, userId: string, reason: string): Promise<number> {
  const r = await w.credentialToken.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  return r.count;
}

/** Creates a one-time link row (the secret is derived from its id, only the keyed hashes are stored). */
async function issueToken(
  w: TxClient,
  input: {
    userId: string;
    purpose: 'RESET' | 'FIRST_ATTESTATION';
    sentTo: string;
    issuedById: string | null;
    attesterId?: string | null;
    verificationNote?: string | null;
    changeRequestId?: string | null;
    hours: number;
    operationKey: string;
  },
): Promise<{ id: string; expiresAt: Date }> {
  await revokeOpenTokens(w, input.userId, input.purpose === 'RESET' ? 'SUPERSEDED_BY_RESET' : 'SUPERSEDED_BY_ATTESTATION');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + clampHours(input.hours) * 3600_000);
  const { passwordHash } = await w.user.findUniqueOrThrow({ where: { id: input.userId }, select: { passwordHash: true } });
  await w.credentialToken.create({
    data: {
      id,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: credentialTokenHash(credentialTokenFor(id)),
      codeHash: input.purpose === 'FIRST_ATTESTATION' ? credentialCodeHash(id, credentialCodeFor(id)) : null,
      sentTo: input.sentTo,
      credentialFingerprint: credentialFingerprintOf(passwordHash),
      issuedById: input.issuedById,
      attesterId: input.attesterId ?? null,
      verificationNote: input.verificationNote ?? null,
      changeRequestId: input.changeRequestId ?? null,
      expiresAt,
    },
  });
  await emitEvent(w, {
    type: CREDENTIAL_LINK_ISSUED_EVENT,
    aggregateType: 'User',
    aggregateId: input.userId,
    idempotencyKey: `${input.operationKey}:${CREDENTIAL_LINK_ISSUED_EVENT}`,
    payload: { tokenId: id, userId: input.userId, purpose: input.purpose },
    actorId: input.issuedById,
  });
  return { id, expiresAt };
}

/**
 * The ONLY writer of Employee.userId (the access link): iam's projection of UserEmployeeLink (BL-PAY-005; the
 * column-ownership row is the ADR of this package). Compare-and-set on the current value.
 */
async function projectAccessLink(w: TxClient, employeeId: string, change: { from: string | null; to: string | null }): Promise<number> {
  const r = await w.employee.updateMany({ where: { id: employeeId, userId: change.from }, data: { userId: change.to } });
  return r.count;
}

/** The open link of an account (any open state), or null. */
async function openLinkOf(w: TxClient, userId: string) {
  return w.userEmployeeLink.findFirst({ where: { userId, status: { in: [...OPEN_LINK_STATUSES] } }, select: { id: true, employeeId: true, status: true } });
}

/** The attestation fields written when an attestation completes (and the legacy link it confirms). */
async function markAttested(w: TxClient, target: IdentityUser, attesterId: string, attestedEmail: string, extra: Prisma.UserUpdateInput = {}) {
  const link = await openLinkOf(w, target.id);
  await w.user.update({
    where: { id: target.id },
    data: {
      ...extra,
      identityStatus: 'ATTESTED',
      identityAttestedBy: { connect: { id: attesterId } },
      identityAttestedAt: new Date(),
      attestedEmail,
      identityDroppedReason: null,
      identityDroppedAt: null,
      // BR-PAY-005: a user with no employee file needs a "real person" attestation of its own.
      ...(link && link.status !== 'PROPOSED' ? {} : { noEmployeeAttestedBy: { connect: { id: attesterId } } }),
    },
  });
  // §17: an existing (LEGACY_LINKED) link is confirmed by the attestation itself.
  if (link?.status === 'LEGACY_LINKED') {
    await w.userEmployeeLink.updateMany({
      where: { id: link.id, status: 'LEGACY_LINKED' },
      data: { status: 'CONFIRMED', confirmedById: attesterId, confirmedAt: new Date() },
    });
  }
}

/** The fields that drop an attestation (DEC-PO-024 / 027, promoteApprover): the account no longer counts. */
function dropAttestation(target: IdentityUser, reason: 'CREDENTIAL_RESET' | 'PROMOTION' | 'EMAIL_CHANGE'): Prisma.UserUpdateInput {
  const wasCounting = target.identityStatus === 'ATTESTED' || target.identityStatus === 'VENDOR_BOOTSTRAP' || target.tenantRoot;
  if (!wasCounting) return {};
  return {
    identityStatus: 'UNATTESTED',
    identityDroppedReason: reason,
    identityDroppedAt: new Date(),
    // RT-PAY-1004 / DEC-PO-042: a root whose credentials are reset loses the root powers until Radeef
    // re-confirms him on the owner's formal request (BL-PAY-022).
    ...(target.tenantRoot && reason === 'CREDENTIAL_RESET' && !target.rootSuspendedAt ? { rootSuspendedAt: new Date() } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------------------------------

export interface CreateUserInput {
  actor: MoneyActor;
  email: string;
  /** bcrypt hash computed by the caller (never the password). */
  passwordHash: string;
  role: AppRole;
  isActive?: boolean;
  name?: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

export async function createUser(tx: TxClient, input: CreateUserInput): Promise<{ userId: string; replayed: boolean }> {
  assertTransactionClient(tx, 'createUser');
  const key = needKey(input.operationKey, 'createUser');
  if (!isAppRole(input.role)) throw badRequest('الدور غير صالح');
  const email = input.email.trim().toLowerCase();
  const out = await idempotent(tx, { key, operation: USER_CREATE.name, actorId: input.actor.id }, (t) =>
    guarded(t, USER_CREATE, { actor: input.actor, userId: 'new', operationKey: key }, async (w) => {
      const taken = await w.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
      if (taken) throw conflict('هذا البريد الإلكتروني مسجل لحساب آخر مسبقاً');
      const created = await w.user.create({
        data: {
          email,
          passwordHash: input.passwordHash,
          role: input.role,
          isActive: input.isActive ?? true,
          ...(input.name ? { name: input.name } : {}),
          // BR-PAY-005: who created the account (mandatory for every new account).
          createdBy: { connect: { id: input.actor.id } },
          // Who set the login email (an admin here): he never attests it, nor anyone he attested.
          emailSetBy: { connect: { id: input.actor.id } },
          emailSetAt: new Date(),
        },
        select: { id: true },
      });
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: USER_CREATE.name,
        entity: { type: 'User', id: created.id },
        after: { email, role: input.role, isActive: input.isActive ?? true, createdById: input.actor.id, identityStatus: 'UNATTESTED' },
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      await emitEvent(w, {
        type: 'iam.user.created',
        aggregateType: 'User',
        aggregateId: created.id,
        idempotencyKey: `${key}:iam.user.created`,
        payload: { userId: created.id, role: input.role },
        actorId: input.actor.id,
      });
      return { userId: created.id };
    }),
  );
  return { userId: out.result.userId, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// The two-step link
// ---------------------------------------------------------------------------------------------------

export interface LinkView {
  id: string;
  userId: string;
  employeeId: string;
  status: UserEmployeeLinkStatus;
  proposedById: string | null;
  confirmedById: string | null;
  selfActSingleOperator: boolean;
}

const LINK_SELECT = { id: true, userId: true, employeeId: true, status: true, proposedById: true, confirmedById: true, selfActSingleOperator: true } as const;

export async function proposeLink(
  tx: TxClient,
  input: { actor: MoneyActor; userId: string; employeeId: string; operationKey: string; ipAddress?: string | null },
): Promise<{ link: LinkView; replayed: boolean }> {
  assertTransactionClient(tx, 'proposeLink');
  const key = needKey(input.operationKey, 'proposeLink');
  if (input.actor.id === input.userId) throw forbidden('لا يجوز ربط حسابك بملف موظف بنفسك (لا ربط ذاتي)');
  const out = await idempotent(tx, { key, operation: LINK_PROPOSE.name, actorId: input.actor.id }, (t) =>
    guarded(t, LINK_PROPOSE, { actor: input.actor, userId: input.userId, operationKey: key }, async (w) => {
      const target = await loadIdentity(w, input.userId);
      if (!target.isActive) throw conflict('الحساب معطّل');
      if (await openLinkOf(w, target.id)) throw conflict('الحساب مرتبط بملف موظف (أو بطلب ربط قائم)؛ افصل الربط الحالي أولاً');
      const busy = await w.userEmployeeLink.findFirst({ where: { employeeId: input.employeeId, status: { in: [...OPEN_LINK_STATUSES] } }, select: { id: true } });
      if (busy) throw conflict('هذا الموظف مرتبط بحساب مستخدم آخر (أو بطلب ربط قائم)');
      const link = await w.userEmployeeLink.create({
        data: { userId: target.id, employeeId: input.employeeId, status: 'PROPOSED', proposedById: input.actor.id },
        select: LINK_SELECT,
      });
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: LINK_PROPOSE.name,
        entity: { type: 'UserEmployeeLink', id: link.id },
        after: { userId: target.id, employeeId: input.employeeId, status: 'PROPOSED' },
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      await emitEvent(w, {
        type: 'iam.link.proposed',
        aggregateType: 'UserEmployeeLink',
        aggregateId: link.id,
        idempotencyKey: `${key}:iam.link.proposed`,
        payload: { linkId: link.id, userId: target.id, employeeId: input.employeeId },
        actorId: input.actor.id,
      });
      return link;
    }),
  );
  return { link: out.result as LinkView, replayed: out.replayed };
}

export async function confirmLink(
  tx: TxClient,
  input: {
    actor: MoneyActor;
    linkId: string;
    operationKey: string;
    ipAddress?: string | null;
    /** Operator mode already read by a server-side caller (never from a client); else read here. */
    mode?: 'ENFORCED' | 'SINGLE_OPERATOR';
  },
): Promise<{ link: LinkView; selfAct: boolean; replayed: boolean }> {
  assertTransactionClient(tx, 'confirmLink');
  const key = needKey(input.operationKey, 'confirmLink');
  const out = await idempotent(tx, { key, operation: LINK_CONFIRM.name, actorId: input.actor.id }, async (t) => {
    const link = await t.userEmployeeLink.findUnique({ where: { id: input.linkId }, select: LINK_SELECT });
    if (!link) throw notFound('طلب الربط غير موجود');
    if (link.status !== 'PROPOSED') throw conflict('طلب الربط ليس بانتظار التأكيد');
    // No self-link, in every mode (BR-PAY-005): the account never confirms its own link, and nobody links an
    // account to his own employee file.
    if (link.userId === input.actor.id) throw forbidden('لا يجوز تأكيد ربط حسابك بنفسك (لا ربط ذاتي)');
    if (input.actor.employeeId && input.actor.employeeId === link.employeeId) throw forbidden('لا يجوز تأكيد ربط ملفك الوظيفي بحساب');
    const [confirmer, target] = await Promise.all([loadIdentity(t, input.actor.id), loadIdentity(t, link.userId)]);
    const mode = input.mode ?? (await resolveOperatorMode(t));
    const decision = selfActDecision(linkConfirmReasons({ confirmer, proposedById: link.proposedById, target }), mode);
    return guarded(t, LINK_CONFIRM, { actor: input.actor, userId: link.userId, operationKey: key, decision, mode }, async (w, info) => {
      const done = await w.userEmployeeLink.updateMany({
        where: { id: link.id, status: 'PROPOSED' },
        data: { status: 'CONFIRMED', confirmedById: input.actor.id, confirmedAt: new Date(), selfActSingleOperator: info.selfAct },
      });
      if (done.count !== 1) throw conflict('تغيّر طلب الربط؛ أعد المحاولة');
      // The access link (projection): only onto a file that has no login.
      const projected = await projectAccessLink(w, link.employeeId, { from: null, to: link.userId });
      if (projected !== 1) throw conflict('ملف الموظف مرتبط بحساب آخر');
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: LINK_CONFIRM.name,
        entity: { type: 'UserEmployeeLink', id: link.id },
        before: { status: 'PROPOSED' },
        after: { status: 'CONFIRMED', userId: link.userId, employeeId: link.employeeId, proposedById: link.proposedById, selfAct: info.selfAct },
        reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      await emitEvent(w, {
        type: 'iam.link.confirmed',
        aggregateType: 'UserEmployeeLink',
        aggregateId: link.id,
        idempotencyKey: `${key}:iam.link.confirmed`,
        payload: { linkId: link.id, userId: link.userId, employeeId: link.employeeId, selfAct: info.selfAct },
        actorId: input.actor.id,
      });
      return { link: { ...link, status: 'CONFIRMED' as const, confirmedById: input.actor.id, selfActSingleOperator: info.selfAct }, selfAct: info.selfAct };
    });
  });
  return { link: out.result.link as LinkView, selfAct: out.result.selfAct, replayed: out.replayed };
}

/** A proposal refused by someone (REJECTED) or withdrawn by its proposer (CANCELLED). */
export async function rejectLink(
  tx: TxClient,
  input: { actor: MoneyActor; linkId: string; operationKey: string; ipAddress?: string | null },
): Promise<{ link: LinkView; replayed: boolean }> {
  assertTransactionClient(tx, 'rejectLink');
  const key = needKey(input.operationKey, 'rejectLink');
  const out = await idempotent(tx, { key, operation: LINK_END.name, actorId: input.actor.id }, async (t) => {
    const link = await t.userEmployeeLink.findUnique({ where: { id: input.linkId }, select: LINK_SELECT });
    if (!link) throw notFound('طلب الربط غير موجود');
    if (link.status !== 'PROPOSED') throw conflict('طلب الربط ليس بانتظار التأكيد');
    const status = link.proposedById === input.actor.id ? 'CANCELLED' : 'REJECTED';
    return guarded(t, LINK_END, { actor: input.actor, userId: link.userId, operationKey: key }, async (w) => {
      const done = await w.userEmployeeLink.updateMany({ where: { id: link.id, status: 'PROPOSED' }, data: { status, endedById: null } });
      if (done.count !== 1) throw conflict('تغيّر طلب الربط؛ أعد المحاولة');
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: `iam.identity.link${status === 'CANCELLED' ? 'Cancel' : 'Reject'}`,
        entity: { type: 'UserEmployeeLink', id: link.id },
        before: { status: 'PROPOSED' },
        after: { status },
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { ...link, status };
    });
  });
  return { link: out.result as LinkView, replayed: out.replayed };
}

/** Unlink (one admin, audited, BR-PAY-005 "كل ربط أو فك مُدقَّق"): the open link ends, the access link is removed. */
export async function endLink(
  tx: TxClient,
  input: { actor: MoneyActor; userId: string; reason?: string | null; operationKey: string; ipAddress?: string | null },
): Promise<{ link: LinkView | null; replayed: boolean }> {
  assertTransactionClient(tx, 'endLink');
  const key = needKey(input.operationKey, 'endLink');
  const out = await idempotent(tx, { key, operation: LINK_END.name, actorId: input.actor.id }, (t) =>
    guarded(t, LINK_END, { actor: input.actor, userId: input.userId, operationKey: key }, async (w) => {
      const link = await w.userEmployeeLink.findFirst({ where: { userId: input.userId, status: { in: [...OPEN_LINK_STATUSES] } }, select: LINK_SELECT });
      if (!link) return null;
      const status = link.status === 'PROPOSED' ? 'CANCELLED' : 'ENDED';
      await w.userEmployeeLink.updateMany({
        where: { id: link.id, status: link.status },
        data: status === 'ENDED' ? { status, endedById: input.actor.id, endedAt: new Date(), endReason: input.reason ?? null } : { status },
      });
      if (status === 'ENDED') await projectAccessLink(w, link.employeeId, { from: input.userId, to: null });
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: LINK_END.name,
        entity: { type: 'UserEmployeeLink', id: link.id },
        before: { status: link.status },
        after: { status, userId: link.userId, employeeId: link.employeeId },
        reason: input.reason ?? null,
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { ...link, status } as LinkView;
    }),
  );
  return { link: out.result as LinkView | null, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------------------------------

export interface AttestInput {
  actor: MoneyActor;
  userId: string;
  /** The attester names the address and confirms it belongs to the person (RT-PAY-1201). */
  attestedEmail: string;
  emailConfirmed: boolean;
  /** The attester has seen the credential history of the account (BR-PAY-005 "كل مُقرّ يرى سجل بيانات الدخول"). */
  historyReviewed: boolean;
  /** How the attester verified the person outside the system. */
  verificationNote: string;
  /** Lifetime of the link of a first attestation (security setting credential_link_hours). */
  linkHours: number;
  operationKey: string;
  ipAddress?: string | null;
}

export interface AttestResult {
  /** ATTESTED: done (a re-attestation). PENDING_SETUP: the holder must use the link and the code. */
  status: 'ATTESTED' | 'PENDING_SETUP';
  /** The link row of a first attestation: the caller shows its code (credentialCodeFor) to the attester ONCE. */
  tokenId: string | null;
  expiresAt: string | null;
  replayed: boolean;
}

export class AttestRefusedError extends HttpError {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(403, problems.map((p) => ATTEST_MESSAGES[p as keyof typeof ATTEST_MESSAGES] ?? p).join('، '), { code: 'ATTEST_REFUSED', problems });
    this.problems = problems;
  }
}

export async function attestIdentity(tx: TxClient, input: AttestInput): Promise<AttestResult> {
  assertTransactionClient(tx, 'attestIdentity');
  const key = needKey(input.operationKey, 'attestIdentity');
  if (!input.emailConfirmed) throw badRequest('يجب أن تؤكد صراحةً أن البريد يخص هذا الشخص');
  if (!input.historyReviewed) throw badRequest('يجب الاطلاع على سجل بيانات الدخول قبل الإقرار');
  const note = needText(input.verificationNote, 'طريقة التحقق من الشخص خارج النظام');
  const out = await idempotent(tx, { key, operation: ATTEST.name, actorId: input.actor.id }, async (t) => {
    const [attester, target] = await Promise.all([loadIdentity(t, input.actor.id), loadIdentity(t, input.userId)]);
    const problems = await attestProblems(t, attester, target);
    if (problems.length) throw new AttestRefusedError(problems);
    const email = input.attestedEmail.trim().toLowerCase();
    if (email !== target.email.toLowerCase()) throw badRequest('البريد المُقرّ يجب أن يكون بريد الحساب نفسه');
    return guarded(t, ATTEST, { actor: input.actor, userId: target.id, operationKey: key }, async (w) => {
      if (needsTwoChannel(target)) {
        // Review rounds 1 and 2 (b): the link of a first attestation goes only to an address the holder confirmed
        // himself (or a vendor script set), never one set by anyone of the attester's side, and never to an
        // account his side created (attestProblems refuses these too; kept here explicitly, fail closed).
        const side = await attesterSide(w, attester);
        if (!emailOwnedByHolder(target) || emailSetBySide(side, target)) {
          throw new AttestRefusedError([emailSetBySide(side, target) ? 'EMAIL_SET_BY_ATTESTER' : 'EMAIL_NOT_SELF_CONFIRMED']);
        }
        if (side.has(target.id) || (await creatorAncestry(w, target)).some((id) => side.has(id))) throw new AttestRefusedError(['CREATOR']);
        if (creatorUnknown(target) && !isActingRoot(attester)) throw new AttestRefusedError(['UNKNOWN_CREATOR_ROOT_ONLY']);
        const token = await issueToken(w, {
          userId: target.id,
          purpose: 'FIRST_ATTESTATION',
          sentTo: email,
          issuedById: input.actor.id,
          attesterId: input.actor.id,
          verificationNote: note,
          hours: input.linkHours,
          operationKey: key,
        });
        await audit(w, {
          actor: { type: 'USER', id: input.actor.id },
          action: 'iam.identity.attest.started',
          entity: { type: 'User', id: target.id },
          after: { attestedEmail: email, emailConfirmed: true, historyReviewed: true, twoChannel: true, expiresAt: token.expiresAt },
          reason: note,
          operationKey: key,
          ipAddress: input.ipAddress ?? null,
        });
        return { status: 'PENDING_SETUP' as const, tokenId: token.id, expiresAt: token.expiresAt.toISOString() };
      }
      await revokeOpenTokens(w, target.id, 'SUPERSEDED_BY_ATTESTATION');
      await markAttested(w, target, input.actor.id, email);
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: ATTEST.name,
        entity: { type: 'User', id: target.id },
        before: { identityStatus: target.identityStatus, identityDroppedReason: target.identityDroppedReason },
        after: { identityStatus: 'ATTESTED', identityAttestedById: input.actor.id, attestedEmail: email, emailConfirmed: true, historyReviewed: true },
        reason: note,
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      await emitEvent(w, {
        type: 'iam.identity.attested',
        aggregateType: 'User',
        aggregateId: target.id,
        idempotencyKey: `${key}:iam.identity.attested`,
        payload: { userId: target.id, attestedById: input.actor.id, reattestation: true },
        actorId: input.actor.id,
      });
      return { status: 'ATTESTED' as const, tokenId: null, expiresAt: null };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// completeCredentialSetup (public: the link is the credential)
// ---------------------------------------------------------------------------------------------------

export type CredentialSetupOutcome =
  | { ok: true; userId: string; purpose: 'RESET' | 'FIRST_ATTESTATION'; attested: boolean }
  | { ok: false; reason: 'INVALID' | 'USED_OR_EXPIRED' | 'BAD_CODE' | 'ATTESTER_INELIGIBLE'; attemptsLeft?: number };


/**
 * The holder uses his link: verifies it (constant time), the code of a first attestation (a wrong code counts
 * an attempt, the link is revoked at CODE_MAX_ATTEMPTS; the result is returned, not thrown, so the count
 * commits), re-checks the attester, then sets the password chosen by the holder, ends every session and, for
 * a first attestation, makes the account ATTESTED. Single use: a second call finds the link used.
 */
export async function completeCredentialSetup(
  tx: TxClient,
  input: { token: string; code?: string | null; passwordHash: string; ipAddress?: string | null },
): Promise<CredentialSetupOutcome> {
  assertTransactionClient(tx, 'completeCredentialSetup');
  const id = credentialTokenId(input.token);
  if (!id) return { ok: false, reason: 'INVALID' };
  const row = await tx.credentialToken.findUnique({ where: { id }, select: TOKEN_SELECT });
  if (!row || !credentialTokenMatches(row, input.token)) return { ok: false, reason: 'INVALID' };
  if (row.usedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'USED_OR_EXPIRED' };
  const key = `iam.credential.complete:${row.id}`;
  return guarded(tx, CREDENTIAL_COMPLETE, { actor: null, userId: row.userId, operationKey: key }, async (w) => {
    const revoke = (reason: string) => w.credentialToken.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    const user = await loadIdentity(w, row.userId);
    const { passwordHash: currentHash } = await w.user.findUniqueOrThrow({ where: { id: row.userId }, select: { passwordHash: true } });
    // The account changed since the link was issued (inactive, another email, other credentials): unusable.
    const changed = !user.isActive ? 'ACCOUNT_INACTIVE' : user.email.toLowerCase() !== row.sentTo.toLowerCase() ? 'EMAIL_CHANGED' : !credentialFingerprintMatches(row.credentialFingerprint, currentHash) ? 'CREDENTIALS_CHANGED' : null;
    if (changed) {
      await revoke(changed);
      return { ok: false as const, reason: 'USED_OR_EXPIRED' as const };
    }
    if (row.purpose === 'FIRST_ATTESTATION') {
      if (!credentialCodeMatches(row, input.code)) {
        const attempts = row.attempts + 1;
        await w.credentialToken.updateMany({
          where: { id: row.id, usedAt: null, revokedAt: null },
          data: attempts >= CODE_MAX_ATTEMPTS ? { attempts, revokedAt: new Date(), revokeReason: 'TOO_MANY_CODE_ATTEMPTS' } : { attempts },
        });
        return { ok: false as const, reason: 'BAD_CODE' as const, attemptsLeft: Math.max(0, CODE_MAX_ATTEMPTS - attempts) };
      }
      const attester = row.attesterId ? await identityOf(w, row.attesterId) : null;
      const problems = attester ? (await attestProblems(w, attester, user)).filter((p) => p !== 'ALREADY_ATTESTED') : ['NOT_ATTESTED'];
      if (problems.length) {
        await revoke('ATTESTER_INELIGIBLE');
        return { ok: false as const, reason: 'ATTESTER_INELIGIBLE' as const };
      }
    }
    const used = await w.credentialToken.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) return { ok: false as const, reason: 'USED_OR_EXPIRED' as const };
    const credential: Prisma.UserUpdateInput = { passwordHash: input.passwordHash, sessionVersion: { increment: 1 } };
    if (row.purpose === 'FIRST_ATTESTATION' && row.attesterId) {
      await markAttested(w, user, row.attesterId, row.sentTo.toLowerCase(), credential);
    } else {
      await w.user.update({ where: { id: user.id }, data: credential });
    }
    await audit(w, {
      actor: { type: 'SYSTEM', id: CREDENTIAL_COMPLETE.name },
      action: CREDENTIAL_COMPLETE.name,
      entity: { type: 'User', id: user.id },
      after: { purpose: row.purpose, passwordChosenByHolder: true, sessionsRevoked: true, ...(row.purpose === 'FIRST_ATTESTATION' ? { identityStatus: 'ATTESTED', identityAttestedById: row.attesterId } : {}) },
      operationKey: key,
      ipAddress: input.ipAddress ?? null,
    });
    await emitEvent(w, {
      type: row.purpose === 'FIRST_ATTESTATION' ? 'iam.identity.attested' : 'iam.credential.reset',
      aggregateType: 'User',
      aggregateId: user.id,
      idempotencyKey: `${key}:${row.purpose}`,
      payload: { userId: user.id, tokenId: row.id, ...(row.purpose === 'FIRST_ATTESTATION' ? { attestedById: row.attesterId, reattestation: false } : {}) },
      actorId: null,
    });
    return { ok: true as const, userId: user.id, purpose: row.purpose, attested: row.purpose === 'FIRST_ATTESTATION' };
  });
}

// ---------------------------------------------------------------------------------------------------
// Credential reset and the two-person identity changes
// ---------------------------------------------------------------------------------------------------

export interface ChangeRequestView {
  id: string;
  userId: string;
  kind: 'DEACTIVATE' | 'CHANGE_ROLE' | 'RESET_CREDENTIALS';
  nextRole: Role | null;
  status: 'PENDING' | 'EXECUTED' | 'REJECTED' | 'CANCELLED';
  twoPerson: boolean;
  requestedById: string;
  decidedById: string | null;
}

const CHANGE_SELECT = { id: true, userId: true, kind: true, nextRole: true, status: true, twoPerson: true, requestedById: true, decidedById: true } as const;

export interface ChangeOutcome {
  request: ChangeRequestView;
  executed: boolean;
  /** A reset's link row (no secret): sent by the consumer of iam.credentialLink.issued. */
  tokenId: string | null;
  replayed: boolean;
}

/** The previous address when the email was changed by someone other than the holder within the window. */
async function previousAddressNotice(w: TxClient, target: IdentityUser): Promise<{ previousEmail: string; changedById: string; changedAt: Date } | null> {
  if (!target.emailSetById || target.emailSetById === target.id || !target.emailSetAt) return null;
  if (Date.now() - target.emailSetAt.getTime() > RESET_NOTICE_WINDOW_HOURS * 3600_000) return null;
  const rows = await auditTrailOf(w, { entityType: 'User', entityId: target.id, actions: ['iam.user.change', 'iam.identity.promoteApprover'] }, 20);
  for (const r of rows) {
    const email = (r.after as { email?: { from?: unknown } } | null)?.email;
    if (email && typeof email.from === 'string') return { previousEmail: email.from, changedById: r.actorId ?? target.emailSetById, changedAt: r.occurredAt };
  }
  return null;
}

/** Executes an approved change (inside an iam operation). */
async function executeChange(
  w: TxClient,
  req: { id: string; kind: ChangeRequestView['kind']; nextRole: Role | null; requestedById: string },
  target: IdentityUser,
  actorId: string,
  opts: { linkHours: number; operationKey: string },
): Promise<{ tokenId: string | null; after: Record<string, unknown> }> {
  if (req.kind === 'DEACTIVATE') {
    await w.user.update({ where: { id: target.id }, data: { isActive: false, sessionVersion: { increment: 1 } } });
    return { tokenId: null, after: { isActive: false, sessionsRevoked: true } };
  }
  if (req.kind === 'CHANGE_ROLE') {
    const nextRole = req.nextRole as Role;
    // Into (or between) financial approver roles: identity.promoteApprover — the root re-attests.
    const promote = isFinancialApproverRole(nextRole);
    await w.user.update({ where: { id: target.id }, data: { role: nextRole, ...(promote ? dropAttestation(target, 'PROMOTION') : {}) } });
    return { tokenId: null, after: { role: nextRole, attestationDropped: promote && target.identityStatus === 'ATTESTED' } };
  }
  // RESET_CREDENTIALS (DEC-PO-024 / 027): the old password stops working, every session ends, the account no
  // longer counts, and the holder chooses a new password through a one-time link to the attested email.
  await w.user.update({
    where: { id: target.id },
    data: { passwordHash: `${RESET_MARKER}${randomUUID()}`, sessionVersion: { increment: 1 }, ...dropAttestation(target, 'CREDENTIAL_RESET') },
  });
  // Review MEDIUM (DEC-PO-027): a reset soon after an admin changed the email also tells the PREVIOUS address.
  const notice = await previousAddressNotice(w, target);
  if (notice) {
    await emitEvent(w, {
      type: RESET_NOTICE_PREVIOUS_EMAIL_EVENT,
      aggregateType: 'User',
      aggregateId: target.id,
      idempotencyKey: `${opts.operationKey}:${RESET_NOTICE_PREVIOUS_EMAIL_EVENT}`,
      payload: { userId: target.id, previousEmail: notice.previousEmail, requestId: req.id, emailChangedById: notice.changedById },
      actorId,
    });
    await audit(w, {
      actor: { type: 'USER', id: actorId },
      action: 'iam.identity.resetCredentials.previousEmailNotified',
      entity: { type: 'User', id: target.id },
      after: { requestId: req.id, emailChangedById: notice.changedById, emailChangedAt: notice.changedAt },
      operationKey: opts.operationKey,
    });
  }
  const token = await issueToken(w, {
    userId: target.id,
    purpose: 'RESET',
    sentTo: (target.attestedEmail ?? target.email).toLowerCase(),
    issuedById: actorId,
    changeRequestId: req.id,
    hours: opts.linkHours,
    operationKey: opts.operationKey,
  });
  return { tokenId: token.id, after: { previousEmailNotified: !!notice, passwordInvalidated: true, sessionsRevoked: true, identityStatus: 'UNATTESTED', linkSentTo: target.attestedEmail ? 'attestedEmail' : 'email', rootSuspended: target.tenantRoot } };
}

export async function requestCredentialReset(
  tx: TxClient,
  input: { actor: MoneyActor; userId: string; reason?: string | null; linkHours: number; operationKey: string; ipAddress?: string | null },
): Promise<ChangeOutcome> {
  assertTransactionClient(tx, 'requestCredentialReset');
  const key = needKey(input.operationKey, 'requestCredentialReset');
  if (input.actor.id === input.userId) throw forbidden('لتغيير كلمة مرورك استخدم صفحة حسابك');
  const out = await idempotent(tx, { key, operation: CREDENTIAL_RESET.name, actorId: input.actor.id }, (t) =>
    guarded(t, CREDENTIAL_RESET, { actor: input.actor, userId: input.userId, operationKey: key }, async (w) => {
      const target = await loadIdentity(w, input.userId);
      if (target.isVendorStaff) throw forbidden('بيانات دخول حسابات رديف تُدار من رديف');
      if (await w.identityChangeRequest.findFirst({ where: { userId: target.id, status: 'PENDING' }, select: { id: true } })) {
        throw conflict('يوجد طلب تغيير قائم على هذا الحساب بانتظار شخص ثانٍ');
      }
      // DEC-PO-024: an account that counts is reset like a deactivation (two people).
      const twoPerson = protectedByTwoPerson(target);
      const now = new Date();
      const request = await w.identityChangeRequest.create({
        data: {
          userId: target.id,
          kind: 'RESET_CREDENTIALS',
          status: twoPerson ? 'PENDING' : 'EXECUTED',
          twoPerson,
          requestedById: input.actor.id,
          reason: input.reason ?? null,
          ...(twoPerson ? {} : { decidedById: input.actor.id, decidedAt: now, executedAt: now }),
        },
        select: CHANGE_SELECT,
      });
      let tokenId: string | null = null;
      let after: Record<string, unknown> = { status: request.status };
      if (!twoPerson) {
        const r = await executeChange(w, request, target, input.actor.id, { linkHours: input.linkHours, operationKey: key });
        tokenId = r.tokenId;
        after = { ...after, ...r.after };
      }
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: CREDENTIAL_RESET.name,
        entity: { type: 'User', id: target.id },
        before: { identityStatus: target.identityStatus, tenantRoot: target.tenantRoot },
        after: { requestId: request.id, twoPerson, ...after },
        reason: input.reason ?? null,
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { request: request as ChangeRequestView, executed: !twoPerson, tokenId };
    }),
  );
  return { ...out.result, replayed: out.replayed };
}

export interface AdminChangeInput {
  actor: MoneyActor;
  userId: string;
  email?: string;
  role?: AppRole;
  isActive?: boolean;
  name?: string | null;
  reason?: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

export interface AdminChangeOutcome {
  /** The changes applied now. */
  applied: Record<string, unknown>;
  /** A two-person request opened instead of a deactivation / role change (DEC-PO-021). */
  request: ChangeRequestView | null;
  replayed: boolean;
}

/**
 * An admin edits another account. Email: never for an attested account (RT-PAY-1001: through Radeef). Role /
 * active of a protected account (DEC-PO-021): a pending two-person request. Otherwise applied now; a role
 * into (or between) financial approver roles is identity.promoteApprover (attestation dropped).
 */
export async function changeUserByAdmin(tx: TxClient, input: AdminChangeInput): Promise<AdminChangeOutcome> {
  assertTransactionClient(tx, 'changeUserByAdmin');
  const key = needKey(input.operationKey, 'changeUserByAdmin');
  if (input.role !== undefined && !isAppRole(input.role)) throw badRequest('الدور غير صالح');
  const out = await idempotent(tx, { key, operation: USER_CHANGE.name, actorId: input.actor.id }, async (t) => {
    const target = await loadIdentity(t, input.userId);
    const roleChanges = input.role !== undefined && input.role !== target.role;
    const deactivates = input.isActive === false && target.isActive;
    const reactivates = input.isActive === true && !target.isActive;
    const emailChanges = input.email !== undefined && input.email.trim().toLowerCase() !== target.email.toLowerCase();
    if (emailChanges && (target.identityStatus !== 'UNATTESTED' || target.tenantRoot || target.isVendorStaff)) {
      throw forbidden('لا يغيّر المسؤول بريد حساب مُقرّ به أو حساب تمهيدي؛ يتم ذلك عبر رديف (RT-PAY-1001)');
    }
    if (roleChanges && deactivates) throw badRequest('غيّر الدور أو عطّل الحساب، كلٌّ في طلب مستقل');

    // DEC-PO-021: a protected account is deactivated / demoted / re-roled only with a second person.
    if ((roleChanges || deactivates) && protectedByTwoPerson(target)) {
      if (input.actor.id === target.id) throw forbidden('لا يمكنك تغيير دور حسابك أو تعطيله');
      return guarded(t, CHANGE_REQUEST, { actor: input.actor, userId: target.id, operationKey: key }, async (w) => {
        if (await w.identityChangeRequest.findFirst({ where: { userId: target.id, status: 'PENDING' }, select: { id: true } })) {
          throw conflict('يوجد طلب تغيير قائم على هذا الحساب بانتظار شخص ثانٍ');
        }
        const request = await w.identityChangeRequest.create({
          data: {
            userId: target.id,
            kind: deactivates ? 'DEACTIVATE' : 'CHANGE_ROLE',
            nextRole: deactivates ? null : (input.role as Role),
            status: 'PENDING',
            twoPerson: true,
            requestedById: input.actor.id,
            reason: input.reason ?? null,
          },
          select: CHANGE_SELECT,
        });
        await audit(w, {
          actor: { type: 'USER', id: input.actor.id },
          action: 'iam.identity.deactivateApprover.requested',
          entity: { type: 'User', id: target.id },
          after: { requestId: request.id, kind: request.kind, nextRole: request.nextRole },
          reason: input.reason ?? null,
          operationKey: key,
          ipAddress: input.ipAddress ?? null,
        });
        await emitEvent(w, {
          type: 'iam.identity.changeRequested',
          aggregateType: 'User',
          aggregateId: target.id,
          idempotencyKey: `${key}:iam.identity.changeRequested`,
          payload: { requestId: request.id, userId: target.id, kind: request.kind },
          actorId: input.actor.id,
        });
        // The display name is no identity column: it changes now, whatever the pending request.
        if (input.name !== undefined) await w.user.update({ where: { id: target.id }, data: { name: input.name } });
        return { applied: input.name !== undefined ? { name: true } : {}, request: request as ChangeRequestView };
      });
    }

    const promote = roleChanges && isFinancialApproverRole(input.role);
    const op = promote ? USER_PROMOTE : USER_CHANGE;
    return guarded(t, op, { actor: input.actor, userId: target.id, operationKey: key }, async (w) => {
      const data: Prisma.UserUpdateInput = {};
      const applied: Record<string, unknown> = {};
      if (input.name !== undefined) {
        data.name = input.name;
        applied.name = true;
      }
      if (emailChanges) {
        const email = input.email!.trim().toLowerCase();
        const taken = await w.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: target.id } }, select: { id: true } });
        if (taken) throw conflict('هذا البريد الإلكتروني مسجل لحساب آخر مسبقاً');
        data.email = email;
        data.emailSetBy = { connect: { id: input.actor.id } };
        data.emailSetAt = new Date();
        applied.email = { from: target.email, to: email };
        // A pending link was sent to the old address: it no longer applies.
        await revokeOpenTokens(w, target.id, 'EMAIL_CHANGED');
        // Review MEDIUM (DEC-PO-027): the holder learns of it at the PREVIOUS address (outbox, after commit).
        await emitEvent(w, {
          type: EMAIL_CHANGED_BY_ADMIN_EVENT,
          aggregateType: 'User',
          aggregateId: target.id,
          idempotencyKey: `${key}:${EMAIL_CHANGED_BY_ADMIN_EVENT}`,
          payload: { userId: target.id, previousEmail: target.email, changedById: input.actor.id },
          actorId: input.actor.id,
        });
      }
      if (roleChanges) {
        data.role = input.role as Role;
        applied.role = { from: target.role, to: input.role };
        if (promote) Object.assign(data, dropAttestation(target, 'PROMOTION'));
      }
      if (deactivates || reactivates) {
        data.isActive = !deactivates;
        applied.isActive = { from: target.isActive, to: !deactivates };
        // Deactivation also revokes existing sessions, so reactivating never revives an old token.
        if (deactivates) data.sessionVersion = { increment: 1 };
      }
      if (!Object.keys(data).length) return { applied, request: null };
      await w.user.update({ where: { id: target.id }, data });
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: op.name,
        entity: { type: 'User', id: target.id },
        before: { role: target.role, isActive: target.isActive, identityStatus: target.identityStatus },
        after: { ...applied, ...(promote && target.identityStatus !== 'UNATTESTED' ? { identityStatus: 'UNATTESTED', identityDroppedReason: 'PROMOTION' } : {}) },
        reason: input.reason ?? null,
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { applied, request: null };
    });
  });
  return { applied: out.result.applied, request: out.result.request as ChangeRequestView | null, replayed: out.replayed };
}

export async function decideChangeRequest(
  tx: TxClient,
  input: { actor: MoneyActor; requestId: string; decision: 'APPROVE' | 'REJECT' | 'CANCEL'; note?: string | null; linkHours: number; operationKey: string; ipAddress?: string | null },
): Promise<ChangeOutcome> {
  assertTransactionClient(tx, 'decideChangeRequest');
  const key = needKey(input.operationKey, 'decideChangeRequest');
  const out = await idempotent(tx, { key, operation: CHANGE_DECIDE.name, actorId: input.actor.id }, async (t) => {
    const req = await t.identityChangeRequest.findUnique({ where: { id: input.requestId }, select: CHANGE_SELECT });
    if (!req) throw notFound('طلب التغيير غير موجود');
    if (req.status !== 'PENDING') throw conflict('طلب التغيير ليس قائماً');
    const target = await loadIdentity(t, req.userId);
    if (input.decision === 'CANCEL') {
      if (req.requestedById !== input.actor.id) throw forbidden('يلغي الطلب من قدّمه فقط');
    } else {
      const approver = await loadIdentity(t, input.actor.id);
      if (!canApproveChange({ approver, requestedById: req.requestedById, target })) {
        throw forbidden(
          req.requestedById === input.actor.id
            ? 'يلزم شخص ثانٍ غير من طلب التغيير (DEC-PO-021)'
            : 'يعتمد هذا التغيير صاحب الحساب نفسه أو مسؤول آخر مُقرّ بهويته بدور معتمد مالي (DEC-PO-021)',
        );
      }
    }
    return guarded(t, CHANGE_DECIDE, { actor: input.actor, userId: req.userId, operationKey: key }, async (w) => {
      const now = new Date();
      const status = input.decision === 'APPROVE' ? 'EXECUTED' : input.decision === 'REJECT' ? 'REJECTED' : 'CANCELLED';
      const done = await w.identityChangeRequest.updateMany({
        where: { id: req.id, status: 'PENDING' },
        data: {
          status,
          ...(input.decision === 'CANCEL' ? {} : { decidedById: input.actor.id, decidedAt: now }),
          decisionNote: input.note ?? null,
          ...(status === 'EXECUTED' ? { executedAt: now } : {}),
        },
      });
      if (done.count !== 1) throw conflict('تغيّر طلب التغيير؛ أعد المحاولة');
      let tokenId: string | null = null;
      let after: Record<string, unknown> = {};
      if (status === 'EXECUTED') {
        const r = await executeChange(w, req, target, input.actor.id, { linkHours: input.linkHours, operationKey: key });
        tokenId = r.tokenId;
        after = r.after;
      }
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: `iam.identity.change.${status.toLowerCase()}`,
        entity: { type: 'IdentityChangeRequest', id: req.id },
        before: { status: 'PENDING' },
        after: { status, kind: req.kind, userId: req.userId, consent: input.actor.id === req.userId, ...after },
        reason: input.note ?? null,
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      await emitEvent(w, {
        type: 'iam.identity.changeDecided',
        aggregateType: 'User',
        aggregateId: req.userId,
        idempotencyKey: `${key}:iam.identity.changeDecided`,
        payload: { requestId: req.id, userId: req.userId, kind: req.kind, status },
        actorId: input.actor.id,
      });
      return { request: { ...req, status, decidedById: input.decision === 'CANCEL' ? null : input.actor.id } as ChangeRequestView, executed: status === 'EXECUTED', tokenId };
    });
  });
  return { ...out.result, replayed: out.replayed };
}

// ---------------------------------------------------------------------------------------------------
// The named self-change operations (RT-PAY-904): they never drop the attestation.
// ---------------------------------------------------------------------------------------------------

/** The session user changes his own password (the caller checked the current one). Other sessions end (cv). */
export async function changeOwnPassword(
  tx: TxClient,
  input: { actor: MoneyActor; passwordHash: string; operationKey: string; ipAddress?: string | null },
): Promise<{ replayed: boolean }> {
  assertTransactionClient(tx, 'changeOwnPassword');
  const key = needKey(input.operationKey, 'changeOwnPassword');
  const out = await idempotent(tx, { key, operation: SELF_CHANGE_PASSWORD.name, actorId: input.actor.id }, (t) =>
    guarded(t, SELF_CHANGE_PASSWORD, { actor: input.actor, userId: input.actor.id, operationKey: key }, async (w) => {
      await w.user.update({ where: { id: input.actor.id }, data: { passwordHash: input.passwordHash } });
      await audit(w, {
        actor: { type: 'USER', id: input.actor.id },
        action: SELF_CHANGE_PASSWORD.name,
        entity: { type: 'User', id: input.actor.id },
        after: { field: 'password' },
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { done: true };
    }),
  );
  return { replayed: out.replayed };
}

/** Login: a legacy plaintext password is replaced by its bcrypt hash (no actor: the login itself). */
export async function rehashLegacyPassword(
  tx: TxClient,
  input: { userId: string; expectedHash: string; passwordHash: string; operationKey: string; ipAddress?: string | null },
): Promise<{ rehashed: boolean; replayed: boolean }> {
  assertTransactionClient(tx, 'rehashLegacyPassword');
  const key = needKey(input.operationKey, 'rehashLegacyPassword');
  const out = await idempotent(tx, { key, operation: SELF_REHASH_PASSWORD.name, actorId: input.userId }, (t) =>
    guarded(t, SELF_REHASH_PASSWORD, { actor: null, userId: input.userId, operationKey: key }, async (w) => {
      // CAS on the stored value: a password changed meanwhile is never overwritten.
      const r = await w.user.updateMany({ where: { id: input.userId, passwordHash: input.expectedHash }, data: { passwordHash: input.passwordHash } });
      if (r.count) {
        await audit(w, {
          actor: { type: 'SYSTEM', id: SELF_REHASH_PASSWORD.name },
          action: SELF_REHASH_PASSWORD.name,
          entity: { type: 'User', id: input.userId },
          after: { field: 'password', legacyPlaintextRehashed: true },
          operationKey: key,
          ipAddress: input.ipAddress ?? null,
        });
      }
      return { rehashed: r.count === 1 };
    }),
  );
  return { rehashed: out.result.rehashed, replayed: out.replayed };
}

/**
 * The session user changes his own email: only while the account is not attested (an attested one changes
 * it through Radeef, RT-PAY-1001). A link already sent to the old address is revoked; the change shows in the
 * credential history the next attester sees.
 */
export async function changeOwnEmail(
  tx: TxClient,
  input: { actor: MoneyActor; newEmail: string; operationKey: string; ipAddress?: string | null },
): Promise<{ replayed: boolean }> {
  assertTransactionClient(tx, 'changeOwnEmail');
  const key = needKey(input.operationKey, 'changeOwnEmail');
  const email = input.newEmail.trim().toLowerCase();
  const out = await idempotent(tx, { key, operation: SELF_CHANGE_EMAIL.name, actorId: input.actor.id }, async (t) => {
    const me = await loadIdentity(t, input.actor.id);
    if (me.identityStatus !== 'UNATTESTED' || me.tenantRoot || me.isVendorStaff) {
      throw forbidden('حسابك مُقرّ بهويته: يُغيَّر بريده عبر رديف فقط، ويُسقط ذلك الإقرار (RT-PAY-1001)');
    }
    return guarded(t, SELF_CHANGE_EMAIL, { actor: input.actor, userId: me.id, operationKey: key }, async (w) => {
      const taken = await w.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: me.id } }, select: { id: true } });
      if (taken) throw conflict('هذا البريد الإلكتروني مستخدم من قبل حساب آخر');
      await w.user.update({ where: { id: me.id }, data: { email, emailSetBy: { connect: { id: me.id } }, emailSetAt: new Date() } });
      await revokeOpenTokens(w, me.id, 'EMAIL_CHANGED');
      await audit(w, {
        actor: { type: 'USER', id: me.id },
        action: SELF_CHANGE_EMAIL.name,
        entity: { type: 'User', id: me.id },
        before: { email: me.email },
        after: { email },
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { done: true };
    });
  });
  return { replayed: out.replayed };
}

/**
 * The holder re-confirms, from his own session (the caller checked his current password), that the login email
 * is his (BL-PAY-005 review round 2): emailSetById = the holder. A first attestation needs it whenever an admin
 * set the address. It changes no address and drops nothing. A repeat (same key) replays; a second confirmation
 * with another key changes nothing more than the confirmation time.
 */
export async function confirmOwnEmail(
  tx: TxClient,
  input: { actor: MoneyActor; operationKey: string; ipAddress?: string | null },
): Promise<{ replayed: boolean }> {
  assertTransactionClient(tx, 'confirmOwnEmail');
  const key = needKey(input.operationKey, 'confirmOwnEmail');
  const out = await idempotent(tx, { key, operation: SELF_CHANGE_EMAIL.name, actorId: input.actor.id }, async (t) => {
    const me = await loadIdentity(t, input.actor.id);
    if (!me.isActive || me.documentsOnlyUntil) throw forbidden('الحساب غير نشط');
    return guarded(t, SELF_CHANGE_EMAIL, { actor: input.actor, userId: me.id, operationKey: key }, async (w) => {
      await w.user.update({ where: { id: me.id }, data: { emailSetBy: { connect: { id: me.id } }, emailSetAt: new Date() } });
      await audit(w, {
        actor: { type: 'USER', id: me.id },
        action: 'iam.self.confirmEmail',
        entity: { type: 'User', id: me.id },
        before: { emailSetById: me.emailSetById },
        after: { emailSetById: me.id, email: me.email },
        operationKey: key,
        ipAddress: input.ipAddress ?? null,
      });
      return { done: true };
    });
  });
  return { replayed: out.replayed };
}
