# 24 Security

## Scope and method
Read `src/proxy.ts`, `src/lib/{auth,session,rate-limit,constants,crypto,audit,http,storage,employee,hr-workflows,validation,menu}.ts`, the login/logout/profile/users/permissions/settings routes, `/api/files`, `/api/upload`, the public `/apply`, `/offer`, `/v` handlers, payments and payroll-hub approval code, `.env.example`, `.gitignore`, `next.config.ts`, the nginx template and `ops/backup.sh`.
Every one of the 153 route handler files was enumerated mechanically, and each exported HTTP method was checked for an auth guard (EV-9001, EV-9002). Ten `[id]` routes plus the ALL-role list endpoints were traced to their ownership checks.
Ran the five existing security test files: 68 tests passed (EV-9025). No database was touched. Evidence IDs are EV-9001..EV-9073 (`AUDIT/_work/ledger_I.md`).

## Capability findings

### Password authentication
Capability: email + bcrypt login issuing a signed session cookie
Status: COMPLETE
Evidence: EV-9003, EV-9004, EV-9007, EV-9009
Files: src/app/api/auth/login/route.ts, src/lib/session.ts, src/lib/auth.ts, src/proxy.ts
Functions/classes: POST login, signSession, verifySession, loadSessionUser
DB tables: User, AuditLog, SystemSetting
API routes: POST /api/auth/login, GET /api/auth/me
UI routes: /login
Tests: admin-rules.test.ts:90-111 covers only the credential-version helper. No test covers the login route itself (EV-9057).
Observed behavior: zod input validation. A dummy bcrypt compare runs for unknown emails to blunt timing-based enumeration. Inactive account returns 403. LOGIN / LOGIN_FAILED are audited. The session lifetime comes from a setting clamped to 15 min..7 days.
Missing pieces: a legacy plaintext-password branch still exists (EV-9009). No route-level tests.
Risk: Low
Confidence: High

### Brute-force protection / lockout
Capability: throttle password guessing
Status: PARTIAL
Evidence: EV-9007, EV-9008, EV-9055, EV-9057
Files: src/lib/rate-limit.ts, src/app/api/auth/login/route.ts
Observed behavior: per account, `max_login_attempts` failures per 15 min (default 5). Per IP, 50 per 15 min, with successful logins refunded. The client IP comes from X-Real-IP, which is safe only because the app binds to 127.0.0.1 behind nginx.
Missing pieces: counters live in memory and are lost on every `pm2 reload` or deploy. There is no persistent lockout, no alert on repeated failures and no tests.
Risk: Medium
Confidence: High

### Password policy
Capability: strength rules for new passwords
Status: PARTIAL
Evidence: EV-9011
Observed behavior: at least 8 characters (configurable 8..64), at most 128, at least one letter and one digit. The same rules apply to create, admin reset and self change.
Missing pieces: no password history, expiry or breached-password check.
Risk: Low
Confidence: High

### Multi-factor authentication
Status: MISSING
Evidence: EV-9010 (the `twoFactorEnabled`/`twoFactorSecret` columns exist but no code reads them at login, and there is no OTP library)
Risk: High. Single-factor access protects the national IDs, IBANs, salaries and government-portal passwords of every employee in the tenant.
Confidence: High

### Self-service password reset
Status: MISSING
Evidence: EV-9012 (only an admin reset and the `scripts/create-admin.mjs` CLI exist)
Risk: Low (security-positive: no reset-token attack surface; operational cost only)
Confidence: High

### Session management and revocation
Capability: expiry, logout-everywhere, revocation on password change or deactivation
Status: COMPLETE
Evidence: EV-9004, EV-9006, EV-9013, EV-9014, EV-9066
Observed behavior: an HS256 JWT carrying `sv` (sessionVersion) and `cv` (HMAC of the password hash). Every request reloads the user from the database, and the role is taken from the database, not the token. Logout, deactivation and delete bump `sessionVersion`. A password change invalidates `cv`. Documents-only (terminated) accounts are refused by `requireUser`.
Missing pieces: tokens issued without a `cv` claim are still accepted until they expire (at most 7 days; legacy). There is no session list per user.
Risk: Low
Confidence: High

### Cookie security flags
Status: COMPLETE
Evidence: EV-9006
Observed behavior: httpOnly, Secure in production, SameSite=Lax, host-only cookie (no Domain attribute).
Risk: Low
Confidence: High

### Route-level authentication guard coverage
Capability: every API handler requires a session and a role
Status: COMPLETE
Evidence: EV-9001, EV-9002, EV-9003, EV-9065
Observed behavior: of 246 exported handlers, only these are unguarded: login, health, and `apply/[jobRequestId]` GET/POST, all public by design. Seven handlers delegate to guarded helpers. Of the remaining 25 handlers guarded with `ROLE_GROUPS.ALL` and 7 with a bare `requireUser()`, each one checked narrows access inside the handler or service (EV-9058, EV-9059, EV-9065). The edge proxy additionally returns 401 for any non-public `/api/*` request without a signed cookie.
Missing pieces: no automated test enforces "every route has a guard"; the enumeration had to be done by script.
Risk: Low
Confidence: High

### Role-based authorization (code-defined)
Status: COMPLETE
Evidence: EV-9015, EV-9069
Observed behavior: 11 roles and 12 role groups, checked on the server by `requireUser(group)`, plus local role sets (TERMINATE, INSURANCE, PAYMENTS_ACCESS, GOV_PLATFORM_ROLES...). See the matrix in `AUDIT/07_SECURITY_AUDIT.md`.
Risk: Low
Confidence: High

### Configurable RBAC (RolePermission / settings/permissions)
Status: UI_ONLY
Evidence: EV-9016
Observed behavior: the admin page edits `RolePermission.allowedPages`, which only changes which menu groups a role sees. No API handler reads it; `canAccessPath` is explicitly "UX only".
Missing pieces: permission changes made there are not enforced. An administrator who removes the "payroll" menu from HR_MANAGER still leaves every payroll API open to HR_MANAGER.
Risk: Medium (it gives a false sense of control)
Confidence: High

### Attribute-based / team scope (managers)
Status: COMPLETE
Evidence: EV-9021, EV-9058, EV-9059, EV-9060
Observed behavior: branch and department managers see and act only on direct reports and their own branch or department. Nobody except the owner group approves their own request.
Risk: Low
Confidence: High

### Company isolation for company-scoped staff (inside a tenant)
Status: PARTIAL
Evidence: EV-9017, EV-9018, EV-9019, EV-9072, EV-9054
Observed behavior: `UserCompanyScope` is enforced only by the document engine. Employees, payroll, loans, leave, attendance, settlements, gov-platform credentials and workforce data are visible tenant-wide to every user in the relevant role group. Payroll approval approves the month for all companies at once.
Missing pieces: company-scope filtering in every non-document query. There is also no company-scoped admin role. Details are in report 25.
Risk: High
Confidence: High

### Field-level permissions (salary, IBAN, national ID, health)
Status: PARTIAL
Evidence: EV-9020, EV-9023, EV-9064, EV-9068
Observed behavior: in the API, finance roles do not receive ID/passport numbers, DOB, disability or identity-copy URLs. Managers and other staff get basic fields only (no salary or IBAN).
Missing pieces: `/api/files` gives FINANCE_MANAGER and PAYROLL_ADMIN the same "allow everything" decision as HR. They can open iqama, passport and health copies whose numbers the API deliberately hides from them. HR sees IBAN and ID unmasked in list responses.
Risk: Medium
Confidence: High

### Document / file access control
Status: COMPLETE
Evidence: EV-9022, EV-9023, EV-9024, EV-9070, EV-9025
Tests: x-security-file-scope.test.ts (33 tests, passing)
Observed behavior: a registry-based decision (owner, uploader, category, team, record reference). The same 403 is returned for "missing" and "forbidden". Sensitive reads are audited and sent `no-store`. Dot-directories (biometric, issued documents) cannot be reached. Issued PDFs are served only by `/api/documents/[id]/pdf` with a hash check.
Missing pieces: the finance-roles inconsistency above.
Risk: Medium
Confidence: High

### IDOR protection on [id] routes
Status: COMPLETE
Evidence: EV-9058, EV-9059, EV-9060, EV-9061, EV-9062, EV-9063
Observed behavior: all 10 sampled routes check role plus ownership or team scope where the entity belongs to an employee. Back-office entities (payments, claims, assets, promissory notes, insurance, workforce plans) are role-guarded and tenant-wide.
Risk: Low (tenant-wide visibility is the company-isolation gap, not an IDOR)
Confidence: Medium (sample of 10 plus the list endpoints, not every route)

### Privilege escalation protection (user management)
Status: COMPLETE
Evidence: EV-9032, EV-9071
Tests: admin-rules.test.ts (11 tests, passing)
Observed behavior: only SUPER_ADMIN may create, promote or modify a SUPER_ADMIN. The last active SUPER_ADMIN is protected. Users cannot change their own role or deactivate themselves. Profile updates are limited to name and avatar.
Missing pieces: COMPANY_ADMIN can create further COMPANY_ADMINs and reset any non-super user's password (by design; audited).
Risk: Low
Confidence: High

### Maker-checker on payments
Status: PARTIAL
Evidence: EV-9033, EV-9073
Tests: x-security-maker-checker.test.ts (6 tests, passing)
Observed behavior: the requester cannot approve or pay their own request. The SUPER_ADMIN override is audited. `allow_self_approval` cannot be set through the settings API.
Missing pieces: the approver and the payer may be the same user (COMPANY_ADMIN belongs to both OWNER and FINANCE), and requests with no recorded requester pass.
Risk: Medium
Confidence: High

### Payroll segregation of duties (generate / approve / pay)
Status: MISSING
Evidence: EV-9034
Observed behavior: one user in PAYROLL ∩ FINANCE (SUPER_ADMIN, COMPANY_ADMIN, FINANCE_MANAGER, PAYROLL_ADMIN) can generate a month, approve it and mark it paid in a single call. No generatedBy/approvedBy columns exist.
Risk: High (fraud or error in salary disbursement goes unchecked)
Confidence: High

### Secrets management
Status: COMPLETE
Evidence: EV-9005, EV-9035, EV-9040, EV-9041, EV-9042, EV-9044
Observed behavior: no real secret has ever been committed (history checked). `.env.local` is untracked. Production fails closed without SESSION_SECRET or DATA_ENCRYPTION_KEY. Secrets are generated per tenant. gitleaks runs in CI.
Missing pieces: the minimum-length check is 16 characters while the documentation says 32 (EV-9005).
Risk: Low
Confidence: High

### Encryption at rest
Status: PARTIAL
Evidence: EV-9035, EV-9036, EV-9043
Observed behavior: AES-256-GCM with key ids protects gov-platform passwords, seal private keys, face embeddings and document tokens.
Missing pieces: national ID, IBAN and salary are plain columns. Uploaded identity, passport, health and bank documents are plain files on disk. Local backups are unencrypted (an optional rclone crypt remote exists). Disk or database encryption is not configured anywhere in the repo.
Risk: Medium
Confidence: High

### Gov-platform credential vault
Status: COMPLETE
Evidence: EV-9037, EV-9035
Risk: Low
Confidence: High

### Audit logging
Status: PARTIAL
Evidence: EV-9038, EV-9039, EV-9007, EV-9022
Observed behavior: 107 files write AuditLog, and sensitive keys (password, token, IBAN) are redacted.
Missing pieces: a write failure is swallowed, so the action succeeds unaudited. There is no database-level immutability (the app role owns the table and can UPDATE or DELETE it). Deleting a user nulls the actor. Viewing full employee records (IBAN, ID, salary) and the payroll hub is not audited.
Risk: Medium
Confidence: High

### Upload validation (authenticated and anonymous)
Status: COMPLETE
Evidence: EV-9026, EV-9027
Observed behavior: size caps, extension allow-list, magic-byte check and HTML/SVG sniffing. Anonymous uploads are limited to 10 per hour per IP, stay uncategorized and are readable by HR only.
Missing pieces: anonymous files are not tied to an application (orphans accumulate; a disk-filling campaign is possible across many IPs).
Risk: Low
Confidence: High

### Public routes (/apply, /offer, /v)
Status: COMPLETE
Evidence: EV-9027, EV-9028, EV-9029
Observed behavior: rate-limited, minimal disclosure (the verification page shows no personal data), 128-bit tokens stored as hashes, strict CSP.
Risk: Low
Confidence: High

### CSRF protection
Status: PARTIAL
Evidence: EV-9006, EV-9031
Observed behavior: SameSite=Lax blocks cross-site POSTs carrying the cookie, and no state-changing GET handler was found.
Missing pieces: no Origin check and no Content-Type enforcement (JSON is parsed from any content type). Sibling subdomains are same-site and are not covered by Lax.
Risk: Medium
Confidence: High

### Security headers / CSP
Status: PARTIAL
Evidence: EV-9030
Missing pieces: no global Content-Security-Policy for the application pages.
Risk: Medium
Confidence: High

### Error handling (no information leakage)
Status: COMPLETE
Evidence: EV-9056
Confidence: High

### Database security (least privilege)
Status: COMPLETE
Evidence: EV-9044, EV-9046
Observed behavior: one non-superuser role per tenant database, and PUBLIC is revoked on both the database and the schema.
Risk: Low
Confidence: High

### Backups (confidentiality)
Status: PARTIAL
Evidence: EV-9043
Missing pieces: local dumps and upload archives are not encrypted. Offsite encryption depends on how the operator configures rclone.
Risk: Medium
Confidence: High

### Terminated-employee access cut-off
Status: COMPLETE
Evidence: EV-9066, EV-9025 (documents-leaver-access tests)
Confidence: High

### Security test coverage
Status: PARTIAL
Evidence: EV-9025, EV-9057
Observed behavior: 68 tests cover file scoping, crypto, payment maker-checker, admin rules and leaver access.
Missing pieces: no tests for login, rate limiting, the proxy allow-list, `requireUser` role gating, or per-route guard presence.
Risk: Medium
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Unauthenticated API -> 401 except public list | src/proxy.ts:11-17 | proxy + requireUser per handler | none (EV-9057) | all | Yes (proxy + handler) |
| Role groups | src/lib/constants.ts:40-65 | requireUser(group) | indirect | all | Local role sets in routes (EV-9069) |
| Session revoked on logout/password change/deactivation | src/lib/auth.ts:84-86 | logout, users/[id], profile | admin-rules.test.ts:90-104 | 24 | No |
| Login throttle = max_login_attempts / 15 min / account | settings/definitions.ts:50,104 | login/route.ts:31 | none | 24 | No |
| Password >= 8, letter + digit | src/lib/validation.ts:59-63 | users, profile | validation.test.ts (not reviewed in detail) | 24 | Min length also in security.ts |
| Payroll/finance must not see identity data | src/lib/employee.ts:309-317 | employees routes | x-X-EMPLOYEES-identity.test.ts (by name) | 01, 09 | Contradicted by storage.ts:383 (EV-9023) |
| Sensitive file categories IDENTITY/PASSPORT/HEALTH/BANK | src/lib/storage.ts:353 | files route | x-security-file-scope | 04, 01 | No |
| Requester ≠ approver/payer for payments | payments/access.ts:90-101 | payments, owner-portal, finance.ts | x-security-maker-checker | 16, 09 | No |
| Only SUPER_ADMIN grants SUPER_ADMIN | settings/users/shared.ts:64-83 | users routes | admin-rules.test.ts | 24 | No |
| Company scope for staff | documents/service.ts:242-246 | documents only | documents-pipeline.test.ts | 04, and missing elsewhere | No (absent elsewhere) |

## Edge cases checked
- Terminated employees: their account becomes documents-only and is refused by every non-document API (EV-9066). The job later deactivates it.
- Multi-company tenant: company-scoped staff still see every company's employees, payroll and loans (EV-9017, EV-9018, EV-9019).
- Deactivated user with a live token: the next request is rejected, because `isActive` and `sv` are checked against the database on every call (EV-9004, EV-9013).
- Role change while logged in: takes effect on the next request, because the role is read from the database (EV-9004).
- Server restart during a brute-force attempt: the counters reset (EV-9008).
- Arabic data: error messages are Arabic; no security relevance found.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 24 Security | 31 | 16 | 11 | 1 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | No MFA; payroll has no maker-checker; company scope only in documents; RolePermission not enforced | High |

## Adversarial verification

Verifier pass over the three High findings in group I. I re-opened each cited file and searched for code the specialist might have missed. No status or severity changed, so the capability blocks, scorecard and matrix_I.md are unchanged.

| Finding | Capability | Verdict | Reason | New evidence |
|---|---|---|---|---|
| I-1 | Company isolation for company-scoped staff | CONFIRMED (PARTIAL, High) | `staffCompanyScope`/`staffCan` (documents/service.ts:242-252) are the only enforcement points. No Prisma extension or middleware applies a global filter, User has no companyId, and only documents/{queries,service,settings}.ts read UserCompanyScope. GET /api/employees (277-293) runs `findMany` with no `where` for HR/payroll levels. payroll-hub GET (118-130) filters only by month/year. `approvePayrollMonth` (payroll.ts:254-260) and `generatePayrollMonth` take no company. The document-engine SPEC §10 calls this a known Radeef-wide gap. High applies to multi-company tenants and Low to single-company ones, as report 25 notes. | EV-9900, EV-9901, EV-9902 |
| I-2 | Multi-factor authentication | CONFIRMED (MISSING, High) | `twoFactorEnabled` is referenced only in the settings/users select list (shared.ts:18), and `twoFactorSecret` only in the audit redaction list (audit.ts:24). src/app/api/auth has only login/logout/me. No OTP, TOTP or WebAuthn dependency or endpoint exists, and there is no step-up re-authentication. The only `currentPassword` check is on the password change. | EV-9904 |
| I-3 | Payroll segregation of duties | CONFIRMED (MISSING, High) | Stronger than stated: a user needs only one role, not membership in two groups. FINANCE_MANAGER and PAYROLL_ADMIN (and SUPER_ADMIN/COMPANY_ADMIN) are in both PAYROLL and FINANCE (constants.ts:52-54), and User.role is single-valued. Any holder of those roles can generate (generate/route.ts:27), `APPROVE_DRAFTS` with `markPaid` (route.ts:429-463) or `MARK_PAYROLL_PAID` (465-471). Neither handler compares the actor with the generator, and the Payroll model has no generatedBy/approvedBy. `approvedBy` exists only on other models (schema :1040, :1735), not on Payroll. | EV-9903 |
