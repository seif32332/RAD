// Public API of the iam module (DOMAIN_BOUNDARIES §5.1): other modules and legacy code import from
// '@/modules/iam' only. iam sits just above platform (§5.3) and imports no other module.
//
// P1-FND-SCOPE: the company-scope layers of §5.4.1 — Actor → Company Scope → authz.can → (service) →
// scopedPrisma (fail-closed safety net). Usage in a route:
//
//   const user = await requireUser(ROLE_GROUPS.HR);
//   const ctx = scopedContext(await resolveActor(prisma, user));
//   authz.assert(ctx, 'recruitment.jobRequest.decide', { companyId });
//   const db = scopedPrisma(ctx);
import { registerControlsModeResolver } from './controls';

export {
  ALL_COMPANIES,
  MissingScopeContextError,
  actorCompanies,
  actorFromSession,
  resolveActor,
  intersectCompanies,
  companiesAllowed,
  scopedContext,
  selfContext,
  teamContext,
  crossCompanyContext,
  recordCrossCompanyOperation,
  systemContext,
  forEachCompany,
  isScopeContext,
  assertScopeContext,
  CROSS_COMPANY_OPERATIONS,
  CROSS_COMPANY_JOBS,
} from './context';
export type {
  Actor,
  CompanySet,
  ScopeContext,
  ScopedContext,
  SelfContext,
  TeamContext,
  CrossCompanyContext,
  SystemContext,
  CrossCompanyInput,
  SessionUserLike,
  EmployeePlacement,
} from './context';

export {
  scopedPrisma,
  ambientPrisma,
  runInScope,
  currentScope,
  scopeWhere,
  applyScope,
  teamEmployeeWhere,
  isTeamMember,
  ScopeViolationError,
} from './scope';
export type { ScopedPrismaClient, ScopedPrismaOptions, ScopeLookup } from './scope';

export { SCOPE_RULES, INFRA_MODELS, companyScopedModels, scopeRuleOf, buildScopeRules } from './scope-models';
export type { ScopeRule } from './scope-models';

export { authz, POLICIES } from './authz';
export type { AuthzResource, AuthzDecision } from './authz';

export { activeUsersWithRoles } from './users';
export type { ActiveUser } from './users';

// BL-PAY-005 identity controls (pay-to-be.md BR-PAY-005): the rules, the writers (behind money.gateway's iam
// operations), the one-time credential links and the side effects of their events.
export {
  FINANCIAL_APPROVER_ROLES,
  IDENTITY_SELECT,
  ATTEST_MESSAGES,
  isFinancialApproverRole,
  identityOf,
  isActingRoot,
  isAttestedPerson,
  countsTowardEnforced,
  protectedByTwoPerson,
  attestationChain,
  attestProblems,
  attestPlan,
  namedPersonOf,
  namedLinkIntact,
  ROOT_ATTEST_OWN_WAIVES,
  ROOT_ATTEST_OWN_STARTED_EVENT,
  NAMED_PERSON_SELECT,
  linkConfirmReasons,
  canApproveChange,
  needsTwoChannel,
  identityView,
  CREDENTIAL_LINK_ISSUED_EVENT,
  OPEN_LINK_STATUSES,
  RESET_MARKER,
  EMAIL_CHANGED_BY_ADMIN_EVENT,
  RESET_NOTICE_PREVIOUS_EMAIL_EVENT,
  RESET_NOTICE_WINDOW_HOURS,
  touchedByAttester,
  emailSetByAttesterSide,
  attesterSide,
  creatorAncestry,
  touchedBySide,
  emailSetBySide,
  emailOwnedByHolder,
  creatorUnknown,
  isResetMarker,
  inspectCredentialToken,
} from './identity';
export type { IdentityUser, IdentityView, AttestProblem, ChainResult, AttestPlan, NamedPersonLink } from './identity';
export {
  AttestRefusedError,
  createUser,
  proposeLink,
  confirmLink,
  rejectLink,
  endLink,
  attestIdentity,
  completeCredentialSetup,
  requestCredentialReset,
  changeUserByAdmin,
  decideChangeRequest,
  changeOwnPassword,
  rehashLegacyPassword,
  changeOwnEmail,
  confirmOwnEmail,
  setUserCompanyScope,
  scopeChangeDrops,
} from './transitions/identity';
export type {
  CreateUserInput,
  LinkView,
  AttestInput,
  AttestResult,
  CredentialSetupOutcome,
  ChangeRequestView,
  ChangeOutcome,
  AdminChangeInput,
  AdminChangeOutcome,
  ScopeChangeInput,
  ScopeChangeOutcome,
} from './transitions/identity';
export { CODE_MAX_ATTEMPTS, credentialCodeFor, credentialTokenId, appBaseUrl } from './credentials';
export { runIdentityTransaction } from './run';

// BL-PAY-021: the computed controlsMode (BR-PAY-020). iam registers it as platform's one controls-mode
// resolver when this index is loaded; every reader asks platform.resolveOperatorMode.
registerControlsModeResolver();
export {
  CONTROLS_MODE_CHANGED_EVENT,
  CONTROLS_AGGREGATE_TYPE,
  ENFORCED_MIN_APPROVERS,
  READINESS_BASES,
  controlsModeFor,
  controlsApprovers,
  approverScopes,
  actsIn,
  countedApproversIn,
  readinessOf,
  readyCompanies,
  readControlsMode,
  controlsOfCompanies,
  approverExitEffect,
  isCountedApprover,
  registerControlsModeResolver,
  lastRecordedControlsMode,
  recordControlsMode,
  recordControlsModeQuietly,
} from './controls';
export type { ControlsModeRecord, ControlsModeChange, CompanyControls, ApproverExitEffect, ApproverScope, Readiness, ReadinessBasis } from './controls';
export { runExitAccessChange } from './exit-access';
export {
  CREDENTIAL_LINK_MAIL_CONSUMER,
  IAM_CONSUMERS,
  credentialLinkMail,
  credentialLinkMailConsumer,
  credentialOutboxRender,
  ACCOUNT_NOTICE_MAIL_CONSUMER,
  accountNoticeMail,
  accountNoticeMailConsumer,
  CONTROLS_OWNER_ALERT_CONSUMER,
  controlsDropMail,
  controlsOwnerAlertConsumer,
  registerIamConsumers,
} from './consumers';

// BL-PAY-021: the owner's monthly digest (job owner-digest) and Radeef's reads of it.
export {
  OWNER_DIGEST_JOB,
  OWNER_DIGEST_QUEUED_EVENT,
  OWNER_DIGEST_KEY_PREFIX,
  DIGEST_SECTION_LINES,
  DIGEST_DELIVERY_PROBLEMS,
  previousMonth,
  monthPeriod,
  monthLabel,
  ownerDigestKey,
  ownerContactOf,
  modeSpanOf,
  buildOwnerDigest,
  runOwnerDigest,
  createOwnerDigestJob,
  OwnerContactMissingError,
  recentDigests,
  queuedDigest,
  controlsNotice,
  SINGLE_OPERATOR_BANNER,
} from './digest';
export type { DigestMonth, ModeSpan, OwnerDigest, OwnerDigestRun, DigestDelivery, DigestCounts, CompanyDigest, CompanyNames } from './digest';

