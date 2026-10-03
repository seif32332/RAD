// iam's identity operations (BL-PAY-005): money.gateway is the guard of the identity controls too
// (pay-to-be.md BR-PAY-018 names identity.link / identity.attest; §2 puts the User control and credential
// columns, Employee.userId and UserEmployeeLink in its scope). The gateway refuses a write of those tables /
// columns outside one of these operations (platform money/tables.ts IDENTITY_*); iam's transitions
// (transitions/identity.ts) are the only callers. None of them moves money: they carry no beneficiary, and
// the act only names the kind of step for the records.
//
// BL-PAY-017 / BL-PAY-022: the in-app operations never name User.tenantRoot or TenantNamedPerson (the gateway
// refuses those writes inside them); rootSuspendedAt only where a credential reset suspends a root (RT-PAY-1004).
// The VENDOR operations at the end are SYSTEM operations run by Radeef's vendor CLI (vendor-cli.ts →
// transitions/vendor.ts), never by a route.
import { USER_CONTROL_COLUMNS, VENDOR_ONLY_USER_COLUMNS, defineMoneyOperation } from '@/modules/platform';

const USER_STANDING = ['role', 'isActive', 'sessionVersion', 'documentsOnlyUntil'] as const;
const USER_CREDENTIALS = ['passwordHash', 'email', 'sessionVersion'] as const;
/** The User control columns an in-app operation may write: never the root mark, never the root suspension. */
const IDENTITY = USER_CONTROL_COLUMNS.filter((c) => !(VENDOR_ONLY_USER_COLUMNS as readonly string[]).includes(c) && c !== 'rootSuspendedAt');
/** A credential reset of the root suspends his powers (RT-PAY-1004, DEC-PO-027): the reset operations only. */
const IDENTITY_RESET = [...IDENTITY, 'rootSuspendedAt'] as const;

export type IdentitySubject = { userId: string };

/** An admin creates an account (createdById is the session user, BR-PAY-005; UNATTESTED by default). */
export const USER_CREATE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.user.create',
  owner: 'iam',
  act: 'REQUEST',
  source: 'USER',
  // An explicit list (BL-PAY-017): a new account never starts as root, vendor staff or attested.
  writes: { User: ['email', 'passwordHash', 'role', 'isActive', 'name', 'createdById', 'emailSetById', 'emailSetAt'] },
});

/** An admin edits an account that does not count toward ENFORCED: email (unattested only), role, active. */
export const USER_CHANGE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.user.change',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { User: [...USER_STANDING, 'email', 'name', ...IDENTITY], CredentialToken: '*' },
});

/** identity.promoteApprover: into a financial approver role; drops the attestation (root re-attests). */
export const USER_PROMOTE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.promoteApprover',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { User: [...USER_STANDING, ...IDENTITY], CredentialToken: '*' },
});

/**
 * identity.deactivateApprover (DEC-PO-021) and the two-person credential reset (DEC-PO-024): the request,
 * its decision, and the change executed on approval.
 */
export const CHANGE_REQUEST = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.changeRequest',
  owner: 'iam',
  act: 'REQUEST',
  source: 'USER',
  writes: { IdentityChangeRequest: '*' },
});

export const CHANGE_DECIDE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.changeDecide',
  owner: 'iam',
  act: 'APPROVE',
  source: 'USER',
  notBeneficiary: false,
  writes: { IdentityChangeRequest: '*', User: [...USER_STANDING, ...USER_CREDENTIALS, ...IDENTITY_RESET], CredentialToken: '*', UserCompanyScope: '*' },
});

/**
 * BL-PAY-021 (security re-check): an account's company scope (UserCompanyScope). Applied at once when no company
 * drops below two counted approvers; otherwise a two-person CHANGE_SCOPE request (CHANGE_REQUEST / CHANGE_DECIDE).
 */
export const USER_SCOPE_SET = defineMoneyOperation<IdentitySubject>({
  name: 'iam.user.scope',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  writes: { UserCompanyScope: '*' },
});

/** identity.resetCredentials: the account becomes UNATTESTED, every session ends, a one-time link is issued. */
export const CREDENTIAL_RESET = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.resetCredentials',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { IdentityChangeRequest: '*', User: [...USER_CREDENTIALS, ...IDENTITY_RESET], CredentialToken: '*' },
});

/** The two-step link (BR-PAY-005): proposal, confirmation (writes the Employee.userId projection), end. */
export const LINK_PROPOSE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.link',
  owner: 'iam',
  act: 'REQUEST',
  source: 'USER',
  writes: { UserEmployeeLink: '*' },
});

export const LINK_CONFIRM = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.linkConfirm',
  owner: 'iam',
  act: 'APPROVE',
  source: 'USER',
  notBeneficiary: false,
  writes: { UserEmployeeLink: '*', Employee: ['userId'] },
});

export const LINK_END = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.linkEnd',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { UserEmployeeLink: '*', Employee: ['userId'] },
});

/** identity.attest: a re-attestation (at once) or the start of a first attestation (two channels). */
export const ATTEST = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.attest',
  owner: 'iam',
  act: 'ATTEST',
  source: 'USER',
  notBeneficiary: false,
  writes: { User: [...IDENTITY], CredentialToken: '*', UserEmployeeLink: '*' },
});

/**
 * The holder uses a one-time link (and, for a first attestation, the in-person code): he chooses his
 * password; a first attestation completes. A SYSTEM operation: there is no session, the token is the credential.
 */
export const CREDENTIAL_COMPLETE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.completeCredentialSetup',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { User: [...USER_CREDENTIALS, ...IDENTITY], CredentialToken: '*', UserEmployeeLink: '*' },
});

/** A wrong code counts an attempt (and revokes the link at the limit), outside the refused transaction. */
export const CREDENTIAL_ATTEMPT = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.credentialAttempt',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { CredentialToken: ['attempts', 'revokedAt', 'revokeReason'] },
});

/** The named self-change operations (RT-PAY-904): they never drop the attestation. */
export const SELF_CHANGE_PASSWORD = defineMoneyOperation<IdentitySubject>({
  name: 'iam.self.changePassword',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { User: ['passwordHash'] },
});

export const SELF_REHASH_PASSWORD = defineMoneyOperation<IdentitySubject>({
  name: 'iam.self.rehashPassword',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { User: ['passwordHash'] },
});

/** A self email change: only an account that is not attested (an attested one changes it through Radeef). */
export const SELF_CHANGE_EMAIL = defineMoneyOperation<IdentitySubject>({
  name: 'iam.self.changeEmail',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { User: ['email', 'emailSetById', 'emailSetAt'], CredentialToken: '*' },
});

/**
 * The end of a leaver's login (src/lib/access.ts: documents-only window, then deactivation). The two-person
 * gate of an attested approver's exit is the lifecycle transition's (BL-LCY-010, assertFinancialApproverExit).
 */
export const ACCESS_END_ON_EXIT = defineMoneyOperation<IdentitySubject>({
  name: 'iam.access.endOnExit',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { User: ['isActive', 'documentsOnlyUntil', 'sessionVersion'] },
});

// ---------------------------------------------------------------------------------------------------
// VENDOR operations (BL-PAY-017 / BL-PAY-022; DEC-PO-016 / 018 / 022): Radeef acting on the owner's formal
// request, from the vendor panel (radeef-manage) through the vendor CLI on the tenant's host. SYSTEM: there is
// no tenant session; the vendor operator and the request reference are recorded on every audit row. Their only
// caller is src/modules/iam/transitions/vendor.ts (static test x-security-root.test.ts).
// ---------------------------------------------------------------------------------------------------

/** Mark TENANT_ROOT, re-root on a new formal request, or restore a suspended root (DEC-PO-016, RT-PAY-603). */
export const VENDOR_SET_ROOT = defineMoneyOperation<IdentitySubject>({
  name: 'iam.vendor.setRoot',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { User: ['tenantRoot', 'rootSuspendedAt'] },
});

/** Suspend the root's powers (the owner's request; a reset outside the app). New attestations freeze. */
export const VENDOR_SUSPEND_ROOT = defineMoneyOperation<IdentitySubject>({
  name: 'iam.vendor.suspendRoot',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { User: ['rootSuspendedAt'] },
});

/**
 * The owner's named people and contact (TenantNamedPerson): register, link to an account, revoke. A revocation
 * drops the linked account's attestation (DEC-PO-143): the three drop columns of User, nothing else.
 */
export const VENDOR_NAMED_PERSON = defineMoneyOperation<IdentitySubject>({
  name: 'iam.vendor.namedPerson',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { TenantNamedPerson: '*', CredentialToken: ['revokedAt', 'revokeReason'], User: ['identityStatus', 'identityDroppedReason', 'identityDroppedAt'] },
});

/** Radeef's invitation of a named person: the account (UNATTESTED, no creator), its list link, a one-time link. */
export const VENDOR_INVITE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.vendor.invite',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { User: '*', TenantNamedPerson: '*', CredentialToken: '*' },
});

/**
 * BL-PAY-021 (ADR-0009, DEC-PO-144): Radeef marks a legal company ready for the computed controls mode, or takes
 * the mark back (the company is then ENFORCED whatever its count). ControlsReadiness only.
 */
export const VENDOR_CONTROLS_READINESS = defineMoneyOperation<IdentitySubject>({
  name: 'iam.vendor.controlsReadiness',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { ControlsReadiness: '*' },
});

/** ROOT_ATTEST_OWN: Radeef releases the second-channel code once to its operator (RT-PAY-1301). */
export const VENDOR_RELEASE_CODE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.vendor.releaseCode',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { CredentialToken: ['codeReleasedAt'] },
});
