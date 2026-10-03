// iam's identity operations (BL-PAY-005): money.gateway is the guard of the identity controls too
// (pay-to-be.md BR-PAY-018 names identity.link / identity.attest; §2 puts the User control and credential
// columns, Employee.userId and UserEmployeeLink in its scope). The gateway refuses a write of those tables /
// columns outside one of these operations (platform money/tables.ts IDENTITY_*); iam's transitions
// (transitions/identity.ts) are the only callers. None of them moves money: they carry no beneficiary, and
// the act only names the kind of step for the records.
import { USER_CONTROL_COLUMNS, defineMoneyOperation } from '@/modules/platform';

const USER_STANDING = ['role', 'isActive', 'sessionVersion', 'documentsOnlyUntil'] as const;
const USER_CREDENTIALS = ['passwordHash', 'email', 'sessionVersion'] as const;
const IDENTITY = [...USER_CONTROL_COLUMNS] as const;

export type IdentitySubject = { userId: string };

/** An admin creates an account (createdById is the session user, BR-PAY-005; UNATTESTED by default). */
export const USER_CREATE = defineMoneyOperation<IdentitySubject>({
  name: 'iam.user.create',
  owner: 'iam',
  act: 'REQUEST',
  source: 'USER',
  writes: { User: '*' },
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
  writes: { IdentityChangeRequest: '*', User: [...USER_STANDING, ...USER_CREDENTIALS, ...IDENTITY], CredentialToken: '*' },
});

/** identity.resetCredentials: the account becomes UNATTESTED, every session ends, a one-time link is issued. */
export const CREDENTIAL_RESET = defineMoneyOperation<IdentitySubject>({
  name: 'iam.identity.resetCredentials',
  owner: 'iam',
  act: 'APPLY_CHANGE',
  source: 'USER',
  notBeneficiary: false,
  writes: { IdentityChangeRequest: '*', User: [...USER_CREDENTIALS, ...IDENTITY], CredentialToken: '*' },
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
