// Public API of the rules module (DOMAIN_BOUNDARIES §5.1, §5.2: RuleParameter, GosiRate,
// CompanyRuleOverride). THE reader of a regulatory value is valueAt(key, companyId, d)
// (SOURCE_OF_TRUTH «القيم القانونية»); no legal constant lives in code outside catalogue.ts (ARCH-007).
//
// Client-safe: pure helpers imported by client pages (leave, settlement, payroll-core,
// employee-shared) read the catalogue defaults through this index, so nothing here imports the
// Prisma client or the platform module at load time (queries/transitions load them lazily).
export { RULE_CATALOGUE, GOSI_FALLBACK_RATES } from './catalogue';
export type { RuleDef, RuleVersionDef, RuleBound, RuleSourceStatus } from './catalogue';

export {
  LABOR_LAW_KEYS,
  RuleOverrideAckRequiredError,
  RuleOverrideBoundError,
  UnknownRuleKeyError,
  assertOverrideAllowed,
  catalogueLaborLaw,
  catalogueValueAt,
  catalogueVersions,
  isRuleKey,
  laborLawFromValues,
  overrideBoundBreach,
  overtimeMultiplierOf,
  pickVersion,
  resolveRule,
  ruleDef,
  withinBound,
} from './resolve';
export type {
  AnnualLeaveLaw,
  EosLaw,
  LaborLaw,
  LaborLawKey,
  LegalVersion,
  NoticeLaw,
  OverrideBoundBreach,
  OverrideVersion,
  OvertimeLaw,
  ProbationLaw,
  ResolvedRuleValue,
  RuleKey,
  SickLeaveLaw,
  StatutoryLeaveLaw,
  WorkHoursLaw,
} from './resolve';

export { companyRuleOverrides, createRulesReader, laborLawFor, ruleAt, valueAt } from './queries';
export type { RulesDb, RulesReader } from './queries';

export { RuleOverrideInputError, revokeCompanyRuleOverride, setCompanyRuleOverride } from './transitions';
export { RULES_OVERRIDE_BELOW_LEGAL_EVENT } from './events';
export type {
  OverrideView,
  RevokeCompanyRuleOverrideInput,
  RuleOverrideOp,
  SetCompanyRuleOverrideInput,
  SetCompanyRuleOverrideResult,
} from './transitions';

export { RuleScopeError, assertCompanyInScope } from './scope';

// DEC-PO-126: the owner alert consumer and the INV-RULE-02 check. They are registered with platform by
// the composition roots (src/jobs/consumers.ts, the integrity route), not here: this index stays
// client-safe and import-side-effect free.
export { BELOW_LEGAL_OWNER_ALERT_CONSUMER, RULES_CONSUMERS, belowLegalOwnerAlert, belowLegalOwnerAlertConsumer, ownerAlertRecipient } from './consumers';
export { BELOW_LEGAL_CATEGORY, BELOW_LEGAL_CHECK, INV_RULE_02_ID, belowLegalOverrideCheck, belowLegalOverrideResults } from './invariants';
export type { RuleCompanyScope } from './scope';
