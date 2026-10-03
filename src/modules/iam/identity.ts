// Identity controls: the rules (BL-PAY-005; pay-to-be.md BR-PAY-005, BR-PAY-020 "حساب الوضع";
// DEC-PO-013 / 016 / 018 / 021 / 024 / 027; lcy-to-be.md BR-LCY-012 "من يُحمى / من يعتمد").
// Pure functions over User rows plus the iam reads they need (User and UserEmployeeLink are iam tables).
// The writers are transitions/identity.ts. Who counts and who may attest are architecture of the control,
// not company settings; the lifetime of a link is (security setting credential_link_hours).
import type { IdentityStatus, Prisma, PrismaClient, UserEmployeeLinkStatus } from '@prisma/client';
import { ROLE_GROUPS, type AppRole } from '@/lib/constants';
import { auditTrailOf, legacyAuditOf, type GuardReason, type RootClient, type TxClient } from '@/modules/platform';
import { credentialTokenId, credentialTokenMatches } from './credentials';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Roles that approve money (wfe-to-be.md G9: a ROLE stage of the HR, PAYROLL, FINANCE or OWNER group). A
 * user with one of them "is a financial approver" for BR-PAY-020 and DEC-PO-021.
 */
export const FINANCIAL_APPROVER_ROLES: readonly AppRole[] = Object.freeze([
  ...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.PAYROLL, ...ROLE_GROUPS.FINANCE, ...ROLE_GROUPS.OWNER]),
]) as readonly AppRole[];

export function isFinancialApproverRole(role: string | null | undefined): boolean {
  return !!role && (FINANCIAL_APPROVER_ROLES as readonly string[]).includes(role);
}

/** The columns every identity rule reads. */
export const IDENTITY_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  documentsOnlyUntil: true,
  createdById: true,
  isVendorStaff: true,
  identityStatus: true,
  identityAttestedById: true,
  identityAttestedAt: true,
  attestedEmail: true,
  noEmployeeAttestedById: true,
  identityDroppedReason: true,
  identityDroppedAt: true,
  tenantRoot: true,
  rootSuspendedAt: true,
  emailSetById: true,
  emailSetAt: true,
} as const satisfies Prisma.UserSelect;

export type IdentityUser = Prisma.UserGetPayload<{ select: typeof IDENTITY_SELECT }>;

export async function identityOf(db: Db, userId: string): Promise<IdentityUser | null> {
  return db.user.findUnique({ where: { id: userId }, select: IDENTITY_SELECT });
}

/** TENANT_ROOT with its powers (not suspended, active). DEC-PO-016, RT-PAY-1004, DEC-PO-042. */
export function isActingRoot(u: Pick<IdentityUser, 'tenantRoot' | 'rootSuspendedAt' | 'isActive' | 'isVendorStaff'>): boolean {
  return u.tenantRoot && !u.rootSuspendedAt && u.isActive && !u.isVendorStaff;
}

/**
 * A real, attested person (BR-PAY-005 / BR-PAY-020: "TENANT_ROOT counts as attested", RT-PAY-710): active,
 * not a vendor account, ATTESTED or an acting root. VENDOR_BOOTSTRAP is never an attestation.
 */
export function isAttestedPerson(u: IdentityUser): boolean {
  if (!u.isActive || u.isVendorStaff || u.documentsOnlyUntil) return false;
  return u.identityStatus === 'ATTESTED' || isActingRoot(u);
}

/** Counts toward ENFORCED (BR-PAY-020): an attested person with a financial approver role. */
export function countsTowardEnforced(u: IdentityUser): boolean {
  return isAttestedPerson(u) && isFinancialApproverRole(u.role);
}

/**
 * Protected by DEC-PO-021 (deactivation, demotion or a credential reset needs two people): the wide reading
 * of lcy-to-be BR-LCY-012 "من يُحمى" — an active non-vendor approver who is ATTESTED, an acting root, or the
 * VENDOR_BOOTSTRAP first admin. Fail closed: when in doubt the change needs a second person.
 */
export function protectedByTwoPerson(u: IdentityUser): boolean {
  if (!u.isActive || u.isVendorStaff) return false;
  if (!isFinancialApproverRole(u.role)) return false;
  return u.identityStatus === 'ATTESTED' || u.identityStatus === 'VENDOR_BOOTSTRAP' || isActingRoot(u);
}

/** Why `attester` may not attest `target` (empty = allowed). Arabic, for the 403. */
export type AttestProblem =
  | 'NOT_ATTESTED'
  | 'NOT_APPROVER'
  | 'VENDOR'
  | 'SELF'
  | 'CREATOR'
  | 'CHAIN'
  | 'ROOT_ONLY'
  | 'RESET_PARTY'
  | 'TARGET_INACTIVE'
  | 'TARGET_VENDOR'
  | 'TARGET_ROOT'
  | 'ALREADY_ATTESTED'
  | 'TOUCHED_BY_ATTESTER'
  | 'EMAIL_SET_BY_ATTESTER'
  | 'EMAIL_NOT_SELF_CONFIRMED'
  | 'UNKNOWN_CREATOR_ROOT_ONLY'
  | 'NAMED_LINK_BROKEN';

export const ATTEST_MESSAGES: Readonly<Record<AttestProblem, string>> = Object.freeze({
  NOT_ATTESTED: 'المُقرّ يجب أن يكون هو نفسه مُقرّاً بهويته من سلسلة الجذر (أو الجذر نفسه)',
  NOT_APPROVER: 'المُقرّ يجب أن يحمل دور معتمد مالي',
  VENDOR: 'حسابات رديف لا تُقرّ هويات المستخدمين',
  SELF: 'لا يجوز لك إقرار هويتك بنفسك',
  CREATOR: 'لا يُقرّ الحساب من أنشأه، ولا من أنشأ منشئه، ولا من في سلسلة إقراره. إن سمّى المالك صاحبه في طلبه الرسمي لرديف فيقرّه الجذر بعد أن تسجّله رديف في قائمة الأشخاص المسمَّين وتربطه بالحساب (ROOT_ATTEST_OWN)',
  CHAIN: 'سلسلة إقرار المُقرّ لا تعود إلى جذر ثقة فعّال، أو تمر بهذا الحساب نفسه (لا يقرّ حسابان كلٌّ منهما بالآخر)',
  ROOT_ONLY: 'بعد إعادة ضبط بيانات الدخول أو الترقية إلى دور معتمد مالي أو سحب رديف للشخص المسمّى لا يعيد الإقرار إلا جذر الثقة (TENANT_ROOT)',
  RESET_PARTY: 'لا يعيد الإقرار من طلب إعادة الضبط أو وافق عليها',
  TARGET_INACTIVE: 'الحساب معطّل',
  TARGET_VENDOR: 'حسابات رديف لا يُقرّ بها (هوية المورّد فقط)',
  TARGET_ROOT: 'جذر الثقة يعيد تأكيده رديف بطلب رسمي من صاحب الشركة',
  ALREADY_ATTESTED: 'الحساب مُقرّ به مسبقاً',
  TOUCHED_BY_ATTESTER: 'لا يُقرّ الحساب من غيّر بريده أو دوره أو كلمة مروره، هو أو حساب من جهته (أنشأه هو أو حساب أنشأه، أو في سلسلة إقراره)؛ يقرّه مسؤول آخر مستقل',
  UNKNOWN_CREATOR_ROOT_ONLY:
    'منشئ هذا الحساب غير معروف (حساب قديم): لا يُقرّ هويته أول مرة إلا جذر الثقة في الشركة (TENANT_ROOT). اطلب ذلك من جذر الثقة',
  EMAIL_NOT_SELF_CONFIRMED:
    'بريد الحساب عيّنه مسؤول: يؤكد صاحب الحساب بريده بنفسه من صفحة حسابه (تأكيد البريد) قبل الإقرار الأول، فلا يُرسل الرابط إلى بريد اختاره غيره',
  EMAIL_SET_BY_ATTESTER:
    'بريد الحساب عيّنه المُقرّ نفسه أو شخص أقرّه هو: لا يُرسل رابط الإقرار إلى بريد اختاره المُقرّ. يغيّر صاحب الحساب بريده بنفسه أو يقرّه مسؤول آخر مُقرّ به',
  NAMED_LINK_BROKEN:
    'الحساب مسجّل لدى رديف لشخص سمّاه المالك، لكن ربطه انفكّ (تغيّر بريد الحساب بعد الربط أو لم يعد يطابق البريد المسمّى): اطلب من رديف إعادة الربط بطلب المالك',
});

export interface ChainResult {
  ok: boolean;
  /** The user ids from the attester up to the root (inclusive). */
  path: string[];
}

const CHAIN_MAX = 64;

/**
 * DEC-PO-016: the attester's own attestation chains back to an acting TENANT_ROOT. Every link on the way is
 * currently ATTESTED (an account reset since then breaks the chain for NEW attestations), the end is an
 * acting root (a suspended or inactive root freezes new attestations), and no account appears twice.
 */
export async function attestationChain(db: Db, attester: IdentityUser): Promise<ChainResult> {
  const path: string[] = [];
  let cur: IdentityUser | null = attester;
  for (let i = 0; cur && i < CHAIN_MAX; i += 1) {
    if (path.includes(cur.id)) return { ok: false, path };
    path.push(cur.id);
    if (cur.tenantRoot) return { ok: isActingRoot(cur), path };
    if (cur.identityStatus !== 'ATTESTED' || cur.isVendorStaff || !cur.identityAttestedById) return { ok: false, path };
    cur = await identityOf(db, cur.identityAttestedById);
  }
  return { ok: false, path };
}

/** The last executed credential reset of `userId` after `since` (its requester and approver are excluded). */
export async function lastResetSince(db: Db, userId: string, since: Date | null) {
  return db.identityChangeRequest.findFirst({
    where: { userId, kind: 'RESET_CREDENTIALS', status: 'EXECUTED', ...(since ? { executedAt: { gt: since } } : {}) },
    orderBy: { executedAt: 'desc' },
    select: { id: true, requestedById: true, decidedById: true, executedAt: true },
  });
}

/**
 * Whether this attestation must be the two-channel setup (RT-PAY-1102 / 1201): a first attestation, or an
 * attested email that no longer matches the account's email (a new address was never confirmed).
 */
export function needsTwoChannel(target: Pick<IdentityUser, 'attestedEmail' | 'email'>): boolean {
  return !target.attestedEmail || target.attestedEmail.toLowerCase() !== target.email.toLowerCase();
}

/**
 * Every reason `attester` may not attest `target` now (BR-PAY-005, DEC-PO-016 / 027). Reads the chain and
 * the last reset. An empty list = allowed.
 */
export async function attestProblems(db: Db, attester: IdentityUser, target: IdentityUser): Promise<AttestProblem[]> {
  const out: AttestProblem[] = [];
  if (attester.id === target.id) out.push('SELF');
  if (attester.isVendorStaff) out.push('VENDOR');
  if (!isAttestedPerson(attester)) out.push('NOT_ATTESTED');
  if (!isFinancialApproverRole(attester.role)) out.push('NOT_APPROVER');
  if (!target.isActive || target.documentsOnlyUntil) out.push('TARGET_INACTIVE');
  if (target.isVendorStaff) out.push('TARGET_VENDOR');
  if (target.tenantRoot) out.push('TARGET_ROOT');
  if (target.identityStatus === 'ATTESTED') out.push('ALREADY_ATTESTED');
  // Review rounds 1 and 2 (BL-PAY-005): one human must never hold both channels. Everything is judged against
  // the attester's SIDE (attesterSide): himself, every account he created or attested (transitively, so a
  // second login he created counts), and his own attestation chain up to the root.
  const side = await attesterSide(db, attester);
  // Nobody attests an account that someone of his side created, directly or through accounts it created
  // (creator ancestry). The exception is ROOT_ATTEST_OWN (DEC-PO-018, attestPlan below): the acting root and an
  // account Radeef linked to a person the owner named, with the link and the code coming from Radeef.
  const createdBySide = (await creatorAncestry(db, target)).some((id) => side.has(id));
  if (createdBySide) out.push('CREATOR');
  // Nobody attests an account whose email, role or (legacy) password someone of his side changed.
  if (await touchedBySide(db, side, target.id)) out.push('TOUCHED_BY_ATTESTER');
  // Nor one whose current email someone of his side set.
  if (emailSetBySide(side, target)) out.push('EMAIL_SET_BY_ATTESTER');
  // A first attestation (two channels) sends its link only to an address the holder confirmed himself (or that
  // a vendor script set): an email set by an admin is re-confirmed by the holder from his own session first.
  if (needsTwoChannel(target)) {
    if (!emailOwnedByHolder(target)) out.push('EMAIL_NOT_SELF_CONFIRMED');
    // Final re-check (Chair, fail closed, like DEC-PO-027): an account whose creator is unknown may have a
    // password someone else knows (legacy admin-set, shared, seeded); only the acting root first-attests it.
    if (creatorUnknown(target) && !isActingRoot(attester)) out.push('UNKNOWN_CREATOR_ROOT_ONLY');
    // A first attestation of an account of the attester's own side (one he created or attested, or on his chain).
    if (side.has(target.id)) out.push('CREATOR');
  }
  const chain = await attestationChain(db, attester);
  if (!chain.ok || chain.path.includes(target.id)) out.push('CHAIN');
  // DEC-PO-027: after a reset or a promotion only the root re-attests, never a party to the reset; DEC-PO-143: the
  // same after Radeef revoked the named person the account was attested as.
  if (reattestRootOnly(target)) {
    if (!isActingRoot(attester)) out.push('ROOT_ONLY');
  }
  const reset = await lastResetSince(db, target.id, null);
  if (reset && (reset.requestedById === attester.id || reset.decidedById === attester.id)) {
    const attestedAfter = target.identityAttestedAt && reset.executedAt && target.identityAttestedAt > reset.executedAt;
    if (!attestedAfter) out.push('RESET_PARTY');
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------
// ROOT_ATTEST_OWN (DEC-PO-018; pay-to-be BR-PAY-005 "إقرار الجذر لما سمّاه المالك"; RT-PAY-702 / 1301 / 1305)
// ---------------------------------------------------------------------------------------------------

/** The columns of a TenantNamedPerson entry the rules read (never the national id hash). */
export const NAMED_PERSON_SELECT = { id: true, kind: true, email: true, userId: true, linkedAt: true, revokedAt: true, requestRef: true } as const;

export interface NamedPersonLink {
  id: string;
  kind: 'NAMED_PERSON' | 'OWNER_CONTACT';
  email: string | null;
  userId: string | null;
  linkedAt: Date | null;
  revokedAt: Date | null;
  requestRef: string;
}

/** The open (not revoked) named-person entry linked to the account, if any (written by Radeef only). */
export async function namedPersonOf(db: Db, userId: string): Promise<NamedPersonLink | null> {
  return db.tenantNamedPerson.findFirst({ where: { userId, kind: 'NAMED_PERSON', revokedAt: null }, select: NAMED_PERSON_SELECT });
}

/**
 * The link still holds (pay-to-be: "attestedEmail = TenantNamedPerson.email" and "any change of a named
 * person's account email, before or after the attestation, unlinks it"): open, this account, the account's
 * email IS the named email, and no in-app email write since Radeef linked it (emailSetAt after linkedAt).
 */
export function namedLinkIntact(named: NamedPersonLink | null, target: Pick<IdentityUser, 'id' | 'email' | 'emailSetAt'>): boolean {
  if (!named || named.kind !== 'NAMED_PERSON' || named.revokedAt || named.userId !== target.id || !named.linkedAt || !named.email) return false;
  if (named.email !== target.email.trim().toLowerCase()) return false;
  return !target.emailSetAt || target.emailSetAt.getTime() <= named.linkedAt.getTime();
}

/**
 * What ROOT_ATTEST_OWN lifts for the root and an intact named account: the creation / touch / email-setter
 * rules exist so that one person never holds both channels; in ROOT_ATTEST_OWN neither channel is the root's
 * (the link goes to the email only Radeef writes, the code comes from Radeef, RT-PAY-1301). Every other rule
 * (self, vendor, chain, an attested target, a party to a reset, ...) still applies.
 */
export const ROOT_ATTEST_OWN_WAIVES: readonly AttestProblem[] = Object.freeze([
  'CREATOR',
  'TOUCHED_BY_ATTESTER',
  'EMAIL_SET_BY_ATTESTER',
  'EMAIL_NOT_SELF_CONFIRMED',
  'UNKNOWN_CREATOR_ROOT_ONLY',
] as AttestProblem[]);

export interface AttestPlan {
  problems: AttestProblem[];
  /** Set when the attestation is ROOT_ATTEST_OWN: two channels, the code delivered by Radeef only. */
  rootAttestOwn: { namedPersonId: string; email: string } | null;
}

/**
 * The attestation `attester` may make of `target` now: the problems of attestProblems, unless every one of them
 * is lifted by ROOT_ATTEST_OWN (acting root + intact named link). `ignore`: problems not relevant to the caller
 * (ALREADY_ATTESTED when a started attestation completes).
 */
export async function attestPlan(db: Db, attester: IdentityUser, target: IdentityUser, ignore: readonly AttestProblem[] = []): Promise<AttestPlan> {
  const problems = (await attestProblems(db, attester, target)).filter((p) => !ignore.includes(p));
  if (!problems.length || !isActingRoot(attester)) return { problems, rootAttestOwn: null };
  const named = await namedPersonOf(db, target.id);
  if (!named) return { problems, rootAttestOwn: null };
  const rest = problems.filter((p) => !ROOT_ATTEST_OWN_WAIVES.includes(p));
  if (rest.length) return { problems, rootAttestOwn: null };
  if (!namedLinkIntact(named, target)) return { problems: [...problems, 'NAMED_LINK_BROKEN'], rootAttestOwn: null };
  return { problems: [], rootAttestOwn: { namedPersonId: named.id, email: named.email as string } };
}

/** iam actions that change an account's email or role (AuditRecord actions of the identity operations). */
const EMAIL_OR_ROLE_ACTIONS = ['iam.user.change', 'iam.identity.promoteApprover'] as const;

function jsonHasKey(v: unknown, keys: readonly string[]): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && keys.some((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== null);
}

const SIDE_MAX = 5000;

/**
 * The attester's SIDE (BL-PAY-005, DEC-PO-142): the attester; every account he created, transitively through
 * createdById only (accounts created by accounts he created…); and every account on his own attestation chain
 * up to the root. Accounts he ATTESTED are not his side: every single-person attack needs a created account,
 * and collusion with someone he attested needs two real people (accepted, logged). So the root may first-attest
 * accounts created or touched by people it attested.
 */
export async function attesterSide(db: Db, attester: Pick<IdentityUser, 'id'> & Partial<IdentityUser>): Promise<Set<string>> {
  const side = new Set<string>([attester.id]);
  const full = 'identityStatus' in attester && attester.identityStatus !== undefined ? (attester as IdentityUser) : await identityOf(db, attester.id);
  if (full) for (const id of (await attestationChain(db, full)).path) side.add(id);
  const down = new Set<string>([attester.id]);
  let frontier = [attester.id];
  while (frontier.length && down.size < SIDE_MAX) {
    const kids = await db.user.findMany({ where: { createdById: { in: frontier } }, select: { id: true } });
    frontier = kids.map((k) => k.id).filter((id) => !down.has(id));
    for (const id of frontier) down.add(id);
  }
  for (const id of down) side.add(id);
  return side;
}

/** Who created the account, who created that one, and so on (createdById up, at most CHAIN_MAX steps). */
export async function creatorAncestry(db: Db, target: Pick<IdentityUser, 'createdById'>): Promise<string[]> {
  const out: string[] = [];
  let cur = target.createdById;
  while (cur && !out.includes(cur) && out.length < CHAIN_MAX) {
    out.push(cur);
    cur = (await db.user.findUnique({ where: { id: cur }, select: { createdById: true } }))?.createdById ?? null;
  }
  return out;
}

/**
 * Has anyone of `side` ever changed the email or the role of `targetId`, or set its password on the legacy users
 * screen? Read from the identity records, the executed two-person role changes they asked for or approved, and
 * the legacy AuditLog.
 */
export async function touchedBySide(db: Db, side: ReadonlySet<string>, targetId: string): Promise<boolean> {
  const records = await auditTrailOf(db as TxClient, { entityType: 'User', entityId: targetId, actions: EMAIL_OR_ROLE_ACTIONS });
  if (records.some((r) => !!r.actorId && side.has(r.actorId) && jsonHasKey(r.after, ['email', 'role']))) return true;
  const roleChanges = await db.identityChangeRequest.findMany({ where: { userId: targetId, kind: 'CHANGE_ROLE', status: 'EXECUTED' }, select: { requestedById: true, decidedById: true } });
  if (roleChanges.some((c) => side.has(c.requestedById) || (!!c.decidedById && side.has(c.decidedById)))) return true;
  const legacy = await legacyAuditOf(db as TxClient, { entityType: 'User', entityId: targetId });
  return legacy.some(
    (l) => !!l.userId && side.has(l.userId) && (l.action === 'PASSWORD_RESET' || (l.action === 'UPDATE' && /"(email|role)":\{"from"|"credentialsReset":true/.test(l.details ?? ''))),
  );
}

/** Kept for callers of the first review round: has `attesterId`'s side changed the target's email or role? */
export async function touchedByAttester(db: Db, attesterId: string, targetId: string): Promise<boolean> {
  return touchedBySide(db, await attesterSide(db, { id: attesterId }), targetId);
}

/** Was the account's current email set by someone of `side` other than the holder? */
export function emailSetBySide(side: ReadonlySet<string>, target: Pick<IdentityUser, 'id' | 'emailSetById'>): boolean {
  const setter = target.emailSetById;
  return !!setter && setter !== target.id && side.has(setter);
}

/** Was the account's current email set by someone of `attesterId`'s side other than the holder? */
export async function emailSetByAttesterSide(db: Db, attesterId: string, target: Pick<IdentityUser, 'id' | 'emailSetById'>): Promise<boolean> {
  return emailSetBySide(await attesterSide(db, { id: attesterId }), target);
}

/**
 * The account's creator is unknown (createdById NULL: a legacy account 9zk found no creator for) and it is not an
 * untouched vendor-bootstrap account (no creator, no recorded email setter, VENDOR_BOOTSTRAP).
 */
export function creatorUnknown(target: Pick<IdentityUser, 'createdById' | 'emailSetById' | 'identityStatus'>): boolean {
  if (target.createdById) return false;
  return !(target.identityStatus === 'VENDOR_BOOTSTRAP' && !target.emailSetById);
}

/**
 * The current email belongs to the holder for a first attestation: he set or re-confirmed it himself
 * (emailSetById = holder), or a vendor script set it (an untouched account the vendor created: no recorded
 * setter, no creator, VENDOR_BOOTSTRAP). Anything else (an admin's choice, an unknown legacy setter) fails closed.
 */
export function emailOwnedByHolder(target: Pick<IdentityUser, 'id' | 'emailSetById' | 'createdById' | 'identityStatus'>): boolean {
  if (target.emailSetById) return target.emailSetById === target.id;
  return !target.createdById && target.identityStatus === 'VENDOR_BOOTSTRAP';
}

/** Only TENANT_ROOT re-attests after these drops (DEC-PO-027; DEC-PO-143 for a revoked named person). */
export function reattestRootOnly(u: Pick<IdentityUser, 'identityDroppedReason'>): boolean {
  return u.identityDroppedReason === 'CREDENTIAL_RESET' || u.identityDroppedReason === 'PROMOTION' || u.identityDroppedReason === 'NAMED_PERSON_REVOKED';
}

/**
 * The two-person decision of a link confirmation (BR-PAY-005): the confirmer is not the proposer, not the
 * account's creator, and is an attested person. Returned as guard reasons so the gateway refuses them in
 * ENFORCED and records them as a SINGLE_OPERATOR self-act otherwise (BR-PAY-020). The self-link (the
 * account confirming its own link) is refused before this, in every mode.
 */
export function linkConfirmReasons(input: { confirmer: IdentityUser; proposedById: string | null; target: IdentityUser }): GuardReason[] {
  const reasons: GuardReason[] = [];
  if (input.proposedById && input.proposedById === input.confirmer.id) reasons.push('SAME_PERSON_TWICE');
  if (input.target.createdById && input.target.createdById === input.confirmer.id) reasons.push('CREATOR_IS_SECOND_PERSON');
  if (!isAttestedPerson(input.confirmer)) reasons.push('UNATTESTED_SECOND_PERSON');
  return reasons;
}

/**
 * Who may approve a two-person identity change (DEC-PO-021 / 024): the user himself (consent), or another
 * attested person with a financial approver role (lcy-to-be "من يعتمد"); never the requester.
 */
export function canApproveChange(input: { approver: IdentityUser; requestedById: string; target: IdentityUser }): boolean {
  if (input.approver.id === input.requestedById) return false;
  if (input.approver.id === input.target.id) return input.approver.isActive && !input.approver.documentsOnlyUntil;
  return countsTowardEnforced(input.approver);
}

/** The identity summary shown on the users screen (never a hash, a token or a code). */
export interface IdentityView {
  identityStatus: IdentityStatus;
  attested: boolean;
  countsTowardEnforced: boolean;
  isVendorStaff: boolean;
  tenantRoot: boolean;
  rootSuspended: boolean;
  attestedEmail: string | null;
  identityAttestedById: string | null;
  identityAttestedAt: Date | null;
  identityDroppedReason: string | null;
  createdById: string | null;
  reattestRootOnly: boolean;
  twoChannelRequired: boolean;
}

export function identityView(u: IdentityUser): IdentityView {
  return {
    identityStatus: u.identityStatus,
    attested: isAttestedPerson(u),
    countsTowardEnforced: countsTowardEnforced(u),
    isVendorStaff: u.isVendorStaff,
    tenantRoot: u.tenantRoot,
    rootSuspended: !!u.rootSuspendedAt,
    attestedEmail: u.attestedEmail,
    identityAttestedById: u.identityAttestedById,
    identityAttestedAt: u.identityAttestedAt,
    identityDroppedReason: u.identityDroppedReason,
    createdById: u.createdById,
    reattestRootOnly: reattestRootOnly(u),
    twoChannelRequired: needsTwoChannel(u),
  };
}

/** ROOT_ATTEST_OWN started: Radeef's operator releases the code from the vendor panel (BL-PAY-022). */
export const ROOT_ATTEST_OWN_STARTED_EVENT = 'iam.identity.rootAttestOwnStarted';

/** The event that sends a one-time credential link (consumer iam.credentialLinkMail). */
export const CREDENTIAL_LINK_ISSUED_EVENT = 'iam.credentialLink.issued';

/** An admin changed the login email: a notice goes to the previous address (consumer iam.accountNoticeMail). */
export const EMAIL_CHANGED_BY_ADMIN_EVENT = 'iam.user.emailChangedByAdmin';
/** A reset requested soon after an admin email change: a notice goes to the previous address too. */
export const RESET_NOTICE_PREVIOUS_EMAIL_EVENT = 'iam.credential.resetNoticePreviousEmail';
/** How recent an admin email change makes a reset notify the previous address (review MEDIUM). */
export const RESET_NOTICE_WINDOW_HOURS = 72;

/** Open link states (one per account and one per employee file, partial unique indexes of 9zk). */
export const OPEN_LINK_STATUSES: readonly UserEmployeeLinkStatus[] = ['PROPOSED', 'CONFIRMED', 'LEGACY_LINKED'];

/** The prefix of an unusable password hash: after a reset the old password stops working (no bcrypt prefix). */
export const RESET_MARKER = '!reset:';

/** A stored password hash that is no password at all (a reset marker): login never compares it. */
export function isResetMarker(passwordHash: string | null | undefined): boolean {
  return typeof passwordHash === 'string' && passwordHash.startsWith('!');
}

export const TOKEN_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  tokenHash: true,
  codeHash: true,
  sentTo: true,
  credentialFingerprint: true,
  attesterId: true,
  expiresAt: true,
  attempts: true,
  usedAt: true,
  revokedAt: true,
  codeDelivery: true,
  codeReleasedAt: true,
  namedPersonId: true,
} as const;

/** What a presented link is (no secret, no account detail): for the set-password page. */
export async function inspectCredentialToken(
  db: TxClient | RootClient,
  token: string,
): Promise<{ valid: false } | { valid: true; purpose: 'RESET' | 'FIRST_ATTESTATION' | 'INVITE'; codeRequired: boolean; expiresAt: Date }> {
  const id = credentialTokenId(token);
  if (!id) return { valid: false };
  const row = await db.credentialToken.findUnique({ where: { id }, select: TOKEN_SELECT });
  if (!row || !credentialTokenMatches(row, token)) return { valid: false };
  if (row.usedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return { valid: false };
  return { valid: true, purpose: row.purpose, codeRequired: row.purpose === 'FIRST_ATTESTATION', expiresAt: row.expiresAt };
}

