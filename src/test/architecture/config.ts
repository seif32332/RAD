// Architecture conformance tests (ARCH-001..021): the facts the rules check against.
//
// Everything here is DERIVED FROM THE CONSTITUTION (docs/architecture). It is not a place to make
// exceptions: a legitimate exception is a baseline entry (baseline.json, may only shrink) or an ADR
// that changes the constitution and then this file.
//
// - Table ownership is parsed from DOMAIN_BOUNDARIES.md §5.2 at test time (see ownership.ts), so
//   the doc and the check cannot drift. Only renamed-future models that the doc writes inside
//   parentheses are supplemented below.
// - The dependency layers are §5.3 as amended by ADR-0001 #5 and ADR-0002 #7 (finance BELOW payroll).
// - LEGACY_PATH_MODULES assigns today's code (src/lib/*, src/app/**) to the module that will own it
//   when it moves to src/modules/<module>/ (§5.1). Code in src/modules/<m>/ always belongs to <m>.

/** Future models the §5.2 table names only inside a parenthesis ("Payroll (يصبح PayrollLine)"). */
export const OWNERSHIP_SUPPLEMENT: Record<string, string> = {
  PayrollLine: 'payroll',
  WorkPattern: 'calendar',
};

/**
 * §5.3 layers, bottom (0) to top. A module may import only modules on a LOWER layer; same-layer
 * imports are refused too (the doc: "الأعلى يستدعي الأدنى فقط"). `legal` and `communications` are
 * not in the §5.3 picture; they sit with the other leaf modules (gov, documents), which call down
 * only. `workflow` is special: it may import platform and iam only, and every module may import it
 * (adapters register with the engine).
 */
export const MODULE_LAYERS: Record<string, number> = {
  iam: 0.5, // "iam · platform": iam uses platform (prisma, audit); platform never calls iam
  platform: 0,
  rules: 1,
  calendar: 1,
  people: 2,
  org: 2,
  lifecycle: 3,
  compensation: 4,
  decisions: 5,
  leave: 6,
  time: 7,
  finance: 8, // ADR-0002 #7: finance under payroll; never calls payroll or offboarding
  payroll: 9,
  assets: 10,
  benefits: 10,
  onboarding: 11,
  recruitment: 12,
  offboarding: 13,
  requests: 14,
  performance: 14,
  learning: 14,
  workforce: 14,
  documents: 14,
  gov: 14,
  legal: 14,
  communications: 14,
  reporting: 15,
};
export const WORKFLOW_MODULE = 'workflow';
export const WORKFLOW_ALLOWED_DEPS = ['platform', 'iam'];

/**
 * Where today's code will live. Longest matching prefix wins; paths are repo-relative with '/'.
 * `null` = legacy code that spans several modules (it has no owner, so every write from it to an
 * owned table is an ARCH-002 finding until it is split into the owning modules).
 */
export const LEGACY_PATH_MODULES: Record<string, string | null> = {
  // src/lib
  'src/lib/access.ts': 'iam',
  'src/lib/auth.ts': 'iam',
  'src/lib/session.ts': 'iam',
  'src/lib/company-scope.ts': 'iam',
  'src/lib/alerts.ts': 'reporting',
  'src/lib/alerts-digest.ts': 'reporting', // the expiry-digest job (P1-FND-JOBS)
  'src/lib/attendance': 'time', // attendance.ts, attendance-locations.ts
  'src/lib/self-attendance': 'time',
  'src/lib/face.ts': 'time',
  'src/lib/biometric-storage.ts': 'time',
  'src/lib/geo.ts': 'time',
  'src/lib/position-tracker.ts': 'time',
  'src/lib/audit.ts': 'platform',
  'src/lib/http.ts': 'platform',
  'src/lib/prisma.ts': 'platform',
  'src/lib/rate-limit.ts': 'platform',
  'src/lib/storage.ts': 'platform',
  'src/lib/mailer.ts': 'platform',
  'src/lib/crypto.ts': 'platform',
  'src/lib/dates.ts': 'platform',
  'src/lib/validation.ts': 'platform',
  'src/lib/constants.ts': 'platform',
  'src/lib/menu.ts': 'platform',
  'src/lib/money.ts': 'platform',
  'src/lib/transliterate.ts': 'platform',
  'src/lib/image-dimensions.ts': 'platform',
  'src/lib/reconciliation/': 'platform',
  'src/lib/banks.ts': 'compensation',
  'src/lib/iban.ts': 'compensation',
  'src/lib/employee': 'people', // employee.ts, employee-shared.ts
  'src/lib/identity.ts': 'people',
  'src/lib/nationality.ts': 'people',
  'src/lib/finance.ts': 'payroll', // loans and deductions; its settlement part belongs to offboarding
  'src/lib/gosi.ts': 'payroll',
  'src/lib/payroll': 'payroll', // payroll.ts, payroll-core.ts
  'src/lib/hr-workflows.ts': null, // leaves + transfers + attendance corrections
  'src/lib/leave': 'leave', // leave.ts, leave-server.ts
  'src/lib/muqeem': 'gov', // muqeem-sync.ts, muqeem/
  'src/lib/onboarding-company.ts': 'onboarding',
  'src/lib/settlement': 'offboarding', // settlement.ts, settlement-payment.ts
  'src/lib/termination.ts': 'offboarding',
  'src/lib/documents/': 'documents',
  'src/lib/workforce/': 'workforce',
  // src/app/api/<segment> and the page of the same segment (src/app/<segment>)
  'src/app/api/admin/': 'reporting',
  'src/app/api/administrations/': 'org',
  'src/app/api/applications/': 'recruitment',
  'src/app/api/apply/': 'recruitment',
  'src/app/api/assets/': 'assets',
  'src/app/api/attendance-': 'time',
  'src/app/api/auth/': 'iam',
  'src/app/api/branches/': 'org',
  'src/app/api/calendar/': 'calendar', // P1-CAL: holidays, Ramadan
  'src/app/api/claims/': 'assets',
  'src/app/api/companies/': 'org',
  'src/app/api/compliance/': 'gov',
  'src/app/api/dashboard/': 'reporting',
  'src/app/api/departments/': 'org',
  'src/app/api/dept-manager/': null,
  'src/app/api/documents/': 'documents',
  'src/app/api/employees/': 'people',
  'src/app/api/evaluations/': 'performance',
  'src/app/api/face-profiles/': 'time',
  'src/app/api/files/': 'platform',
  'src/app/api/financial-changes/': 'compensation', // P1-PAY-B: EmployeeFinancialChange (BR-PAY-009)
  'src/app/api/gov-platforms/': 'gov',
  'src/app/api/health/': 'platform',
  'src/app/api/hr/': 'reporting',
  'src/app/api/incoming-requests/': 'requests',
  'src/app/api/integrations/': 'gov',
  'src/app/api/leaves/': 'leave',
  'src/app/api/legal/': 'legal',
  'src/app/api/logistics/': 'reporting',
  'src/app/api/manager-portal/': null,
  'src/app/api/medical-insurance/': 'benefits',
  'src/app/api/nationalities/': 'people',
  'src/app/api/notifications/': 'platform',
  'src/app/api/owner-portal/': 'requests',
  'src/app/api/owner-reports/': 'reporting',
  'src/app/api/payments/': 'finance',
  'src/app/api/payroll-hub/': 'payroll',
  'src/app/api/portal/': null, // employee self-service over several modules
  'src/app/api/portal/attendance/': 'time',
  'src/app/api/portal/correction/': 'time',
  'src/app/api/portal/face/': 'time',
  'src/app/api/portal/financial-changes/': 'compensation', // P1-PAY-B: the employee's own IBAN requests
  'src/app/api/portal/termination/': 'offboarding',
  'src/app/api/portal/total-rewards/': 'workforce',
  'src/app/api/profile/': 'iam',
  'src/app/api/recruitment/': 'recruitment',
  'src/app/api/renewals/': 'gov',
  'src/app/api/search/': 'reporting',
  'src/app/api/services/': 'assets',
  'src/app/api/settings/': 'platform',
  'src/app/api/settings/users/': 'iam',
  'src/app/api/settings/permissions/': 'iam',
  'src/app/api/settings/profile/': 'iam',
  'src/app/api/settlements/': 'offboarding',
  'src/app/api/transfers/': 'org',
  'src/app/api/upload/': 'platform',
  'src/app/api/vehicles/': 'assets',
  'src/app/api/visas/': 'gov',
  'src/app/api/work-schedules/': 'calendar',
  'src/app/api/workforce/': 'workforce',
};

/**
 * Projection columns on Employee and their projector (DOMAIN_BOUNDARIES §5.2 "Employee حالة خاصة",
 * SOURCE_OF_TRUTH §3.1). Columns that do not exist yet are listed so the rule bites when they appear.
 */
export const EMPLOYEE_PROJECTIONS: Record<string, string> = {
  // lifecycle (EmploymentStateChange / EmploymentPeriod / ContractPeriod)
  employmentState: 'lifecycle',
  employmentStatus: 'lifecycle', // legacy state column (ACTIVE / ON_LEAVE / EXCLUDED)
  isTerminated: 'lifecycle',
  terminationDate: 'lifecycle',
  contractEndDate: 'lifecycle',
  probationEndDate: 'lifecycle',
  // offboarding (ExitCase)
  exitReason: 'offboarding',
  exitVoluntary: 'offboarding',
  // compensation (CompensationPeriod / BankIdentityPeriod)
  basicSalary: 'compensation',
  housingAllowance: 'compensation',
  transportAllowance: 'compensation',
  otherAllowances: 'compensation',
  ibanNumber: 'compensation',
  bankName: 'compensation',
  salaryPaymentMethod: 'compensation',
  payrollReady: 'compensation',
  // org (AssignmentPeriod)
  legalCompanyId: 'org',
  actualCompanyId: 'org',
  administrationId: 'org',
  branchId: 'org',
  departmentId: 'org',
  directManagerId: 'org',
  jobTitle: 'org',
  workSchedule: 'org',
  workPatternId: 'org', // P1-CAL: projection of AssignmentPeriod.workPatternId
  // payroll (GosiRegistrationPeriod)
  gosiRegime: 'payroll',
  gosiDeduction: 'payroll',
  // leave (LeaveLedgerEntry)
  leaveAccrualStartDate: 'leave',
  // iam (UserEmployeeLink, ADR-0007): the access link, written by projectAccessLink only
  userId: 'iam',
};

/** ARCH-005: the employment-state columns only `transitionEmploymentState` may write. */
export const EMPLOYMENT_STATE_FIELDS = ['employmentState', 'employmentStatus', 'isTerminated', 'terminationDate'];
/** ARCH-005: the lifecycle fact tables, written by lifecycle transitions only. */
export const EMPLOYMENT_STATE_MODELS = ['EmploymentStateChange', 'EmploymentPeriod'];

/**
 * ARCH-004: money tables (today's and the plan's). Their sole writer is the owning module's
 * transition file, reached through money.gateway (ADR-0001 #2).
 */
export const MONEY_MODELS = [
  'Payroll',
  'PayrollLine',
  'PayrollMonth',
  'PayrollSnapshot',
  'PayrollAdjustment',
  'PayrollCoverage',
  'Deduction',
  'Bonus',
  'Loan',
  'LoanInstallment',
  'Settlement',
  'PaymentRequest',
  'BankExport',
  'BankConfirmation',
  'EmployeeDebt',
  'LeaveCaseResolution',
  'Allowance',
  'SalaryChange',
  'CompensationPeriod',
  'BankIdentityPeriod',
  'EmployeeFinancialChange',
];
/** ARCH-004: money projection columns on Employee. */
export const EMPLOYEE_MONEY_FIELDS = [
  'basicSalary',
  'housingAllowance',
  'transportAllowance',
  'otherAllowances',
  'gosiDeduction',
  'ibanNumber',
  'bankName',
  'salaryPaymentMethod',
  // P1-PAY-B: the projection of compensation that gates pay (pay-to-be §2 control fields, ARC-PAY-A4)
  'payrollReady',
];

/** ARCH-011: modules whose calculations have a financial effect. */
export const FINANCIAL_CALC_MODULES = ['payroll', 'offboarding', 'leave', 'finance'];
/** ARCH-011: projected salary columns a financial calculation must not read. */
export const PROJECTED_SALARY_FIELDS = ['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowances', 'gosiDeduction'];

/** ARCH-013: modules that handle amounts. money.ts files are the only place for amount arithmetic. */
export const MONEY_MODULES = ['payroll', 'finance', 'compensation', 'offboarding'];
/** ARCH-013: an integer operand of * or / that signals amount arithmetic (per-day, per-month, percent). */
export const MONEY_ARITH_INTEGERS = [12, 30, 100, 360, 365];

/**
 * ARCH-007: legal numbers (the §4.1.1 list plus the overtime factor 1.5 and the 120-day sick-leave
 * limit) and the words that make a statement "legal context". A literal counts only when its
 * enclosing statement (or declaration / property / parameter) mentions one of the words.
 */
export const LEGAL_NUMBERS = [21, 30, 60, 90, 120, 180, 720, 0.5, 1.5, 9.75];
export const LEGAL_CONTEXT =
  /leave|vacation|annual|notice|probation|overtime|gratuity|end[-_ ]?of[-_ ]?service|\beos|gosi|sick|maternity|paternity|hajj|bereavement|marriage|iddah|entitle|accru|resign|terminat|serviceYears|yearsOfService|wage|levy/i;
/**
 * ARCH-007: files that hold demo or mock data, not rules (seed values are not a legal source), and
 * the rules catalogue (P1-RULE): the one documented code mirror of the dated RuleParameter / GosiRate
 * seed rows, kept equal to the migrations by src/modules/rules/__tests__/rules-catalogue.test.ts.
 */
export const LEGAL_SCAN_EXEMPT = [/^scripts\/seed-[^/]*\.mjs$/, /^scripts\/muqeem-mock\.mjs$/, /^src\/modules\/rules\/catalogue\.ts$/];

/** ARCH-008: scripts allowed to write (J1 = the jobs runner, and one-off data migrations). */
export const SCRIPT_WRITE_ALLOWLIST: string[] = [];

/** ARCH-016: routes that are public by design (no session). Adding one is a reviewed change here. */
export const PUBLIC_ROUTES = [
  'src/app/api/auth/login/route.ts',
  'src/app/api/auth/logout/route.ts',
  'src/app/api/auth/credential-setup/route.ts', // BL-PAY-005: the one-time credential link is the credential
  'src/app/api/health/route.ts',
  'src/app/api/apply/[jobRequestId]/route.ts', // public job application form
];
/** ARCH-016: functions that establish the actor (the permission guard). */
export const AUTH_GUARDS = ['requireUser', 'requireDocumentsUser', 'requireEmployeeId', 'getSessionUser', 'getDocumentsSessionUser'];

/** ARCH-006: identifiers that show a route applies the company scope contract (§5.4). */
export const SCOPE_MARKERS = [
  'userCompanyScope',
  'companyScopeWhere',
  'assertCompaniesInScope',
  'companiesInScope',
  'staffCompanyScope',
  'requireEmployeeId', // SelfContext: employeeId from the session
  'ScopedContext',
  'SelfContext',
  'TeamContext',
  'CrossCompanyContext',
  'crossCompany',
  'scopedContext',
  'assertManagerScope',
];

/**
 * ARCH-017: calls that are side effects (mail, documents, files, network, integrations). Anything
 * calling one of these, directly or through a function that does, may not run inside $transaction.
 * Writing a NotificationOutbox row / DomainEvent inside the transaction is the correct pattern and
 * is not a side effect.
 */
export const SIDE_EFFECT_CALLS = [
  'sendMail',
  'sendEmail',
  'fetch',
  'issueDocument',
  'renderDocument',
  'renderPdf',
  'writeFile',
  'saveUpload',
  'unlink',
  'rm',
];

/**
 * ARCH-021 (ADR-0005, DEC-PO-129): the owning module of each effective-period kind, the only module
 * that may call the platform/effective writers for it. A new kind declares its owner here and in the
 * kind registry (platform/effective/kinds.ts).
 */
export const PERIOD_KIND_OWNERS: Record<string, string> = {
  EMPLOYMENT: 'lifecycle',
  COMPENSATION: 'compensation',
  ASSIGNMENT: 'org',
  BANK_IDENTITY: 'compensation', // P1-PAY-B (9zg, ARC-PAY-A3)
};
/** ARCH-021: the platform/effective writers that take a kind (openLegacyPeriod / backfillLegacyOpenings are exempt). */
export const PERIOD_WRITERS = ['openPeriod', 'closePeriod', 'supersedePeriod'];

/** ARCH-015: String columns named like a state that are attributes, not state machines. */
export const STATE_NAME_EXEMPT = ['maritalStatus'];
