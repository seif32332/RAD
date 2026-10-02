# 07 Security audit

Scope: working tree at `b556235` plus uncommitted document-engine changes. Evidence: `AUDIT/_work/ledger_I.md` (EV-9001..EV-9073). Domain detail: `03_DOMAIN_REPORTS/24_security.md` and `25_multi_tenancy.md`.

## Threat summary

| Asset | Where | Main threats | Current posture |
|---|---|---|---|
| Identity data (iqama/passport numbers, copies), IBAN, salary, health | `Employee` columns (plain, EV-9036); UPLOAD_DIR files (plain) | Insider over-reach, stolen admin password, disk/backup theft | Role- and field-level filtering in the API (EV-9020). No MFA (EV-9010). No encryption of these columns or files (EV-9036, EV-9043). Reads of full records are not audited (EV-9039). |
| Biometric data (selfies, face templates) | `UPLOAD_DIR/.biometric`; `FaceProfile` (encrypted embedding) | Leak or reuse | Not servable by `/api/files` (EV-9024). Embeddings encrypted (EV-9035). Photos HR-only and audited (EV-9062). Excluded from backups (EV-9043). |
| Government portal passwords, seal keys | `GovPlatform.password`, seal key rows | Theft | AES-256-GCM, fail-closed key handling (EV-9035). Masked, audited reveal (EV-9037). |
| Salary disbursement | Payroll, PaymentRequest | Fraud or error by a single privileged user | Payment maker-checker exists (EV-9033). Payroll has none (EV-9034). |
| Accounts and sessions | User, JWT cookie | Credential stuffing, session theft | bcrypt, DB-checked revocation (EV-9004). In-memory throttling only (EV-9008). No MFA. |
| Tenant data | One database per tenant | Cross-tenant leakage | Strong: separate database, role, secrets and upload directory (EV-9044, EV-9045). |
| Company data inside a tenant | Shared database | Staff of company A reading company B | Enforced only by the document engine (EV-9017). |

## Auth-guard enumeration

Method: a script listed every `route.ts` under `src/app` (153 files: 149 under `/api`, 4 under `/offer` and `/v`). For each of the 246 exported HTTP handlers under `/api`, it checked the handler body for `requireUser`, `requireDocumentsUser`, `requireEmployeeId`, `getSessionUser` or `getDocumentsSessionUser` (EV-9001, EV-9002). Guard distribution: 192 role-specific `requireUser(...)` calls, 25 `ROLE_GROUPS.ALL`, 7 bare `requireUser()`, 6 `requireDocumentsUser`, 3 `getSessionUser`/`getDocumentsSessionUser`, 9 delegations to guarded helpers, 4 unguarded (public).

Unguarded or weakly guarded handlers:

| Route (handler) | Guard | Assessment | Evidence |
|---|---|---|---|
| `api/auth/login` POST | none | Public by design; rate-limited, audited | EV-9007 |
| `api/health` GET | none | Public; returns `{status, db, latencyMs}` only | EV-9002 |
| `api/apply/[jobRequestId]` GET, POST | none | Public job form; open vacancies only, rate limits, 32 KB cap | EV-9027 |
| `api/upload` POST | optional `getSessionUser` | Anonymous allowed with a restricted policy (10/h/IP, small allow-list, magic bytes) | EV-9026 |
| `offer/[token]`, `offer/[token]/pdf`, `v/[token]`, `v/[token]/certificate` | token | 128-bit hashed tokens, per-IP rate limits, strict CSP, no PII on `/v` | EV-9028, EV-9029 |
| `api/settings` POST/PUT | delegated `saveSettings` -> `requireUser(ADMIN)` | Guarded (the script reports "NONE" only because of the alias export) | EV-9002 |
| `api/workforce/export` GET/POST | delegated `handle` -> `requireUser(WORKFORCE)` | Guarded | EV-9002 |
| `api/workforce/plans/[id]/{approve,archive,copy,reject,submit}` POST | delegated -> `requireUser(WORKFORCE)` | Guarded | EV-9002 |
| 25 handlers with `ROLE_GROUPS.ALL`, 7 with `requireUser()` | any logged-in user | Each one sampled narrows access inside (own employeeId, team scope, owner-only actions): leaves, leave balance, corrections, assets, documents settings, payroll-hub POST | EV-9058, EV-9059, EV-9065 |

Result: **no API handler reachable without authentication other than the intended public ones.** The edge proxy also returns 401 for any other `/api/*` request without a signed cookie (EV-9003).

## IDOR checks

| Route | Guard | Ownership / scope check | Verdict | Evidence |
|---|---|---|---|---|
| `employees/[id]` GET | STAFF | HR/payroll full (payroll redacted); managers `managedEmployeesWhere`; other staff basic fields | OK (tenant-wide for HR) | EV-9020 |
| `leaves/[id]/action` POST | ALL | `approveLeave` -> `assertCanManageEmployee` + stage roles | OK | EV-9059 |
| `attendance-corrections/[id]/action` POST | MANAGERS | `assertCanManageEmployee` + HR stage | OK | EV-9060 |
| `attendance-punches/[id]` PUT | HR | `assertCanManageEmployee` (blocks self) | OK | EV-9063 |
| `attendance-punches/[id]/photo` GET | HR | HR only, VIEW audited | OK | EV-9062 |
| `face-profiles/[employeeId]/photo` GET | HR | HR only, VIEW audited | OK | EV-9062 |
| `documents/requests/[id]` GET/POST | ALL / documents user | `canSee` / `staffCan` with company scope | OK | EV-9061 |
| `documents/[id]/pdf` GET | documents user | `readIssuedDocument` owner or staff of the type | OK | EV-9061 |
| `files/[...path]` GET | any user | registry decision, team, references | OK, but finance roles read identity files (EV-9023) | EV-9022 |
| `payments/[id]` PUT/DELETE | FINANCE / PAYMENTS_ACCESS | maker-checker on PAY | OK | EV-9033 |
| `claims/[id]`, `assets/[id]`, `legal/promissory-notes/[id]`, `medical-insurance/[id]`, `workforce/plans/[id]` | role groups | none needed (back-office entities); no company scope | OK within role; tenant-wide | EV-9063 |
| `settings/users/[id]` PUT/DELETE | ADMIN | `checkUserChange` (SUPER_ADMIN protection, self-protection) | OK | EV-9032 |

## Role / permission matrix (from code)

SA = SUPER_ADMIN, CA = COMPANY_ADMIN, HR = HR_MANAGER, FIN = FINANCE_MANAGER, PA = PAYROLL_ADMIN, GOV = GOV_RELATIONS, LEG = LEGAL_ADMIN, BM = BRANCH_MANAGER, DM = DEPT_MANAGER, PUR = PURCHASING_AGENT, EMP = EMPLOYEE.

| Capability | SA | CA | HR | FIN | PA | GOV | LEG | BM | DM | PUR | EMP | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Employee full record incl. national ID, IBAN, salary (all companies) | Y | Y | Y | no ID fields | no ID fields | basic | basic | team basic | team basic | basic | own via portal | EV-9018, EV-9020 |
| Identity/passport/health/bank files | all | all | all | all | all | Muqeem PDFs only | refs only | refs only | refs only | refs only | own | EV-9022, EV-9023 |
| Payroll hub read (all companies) | Y | Y | Y | Y | Y | - | - | team deductions | team deductions | - | - | EV-9019 |
| Generate / approve payroll | Y | Y | Y | Y | Y | - | - | - | - | - | - | EV-9034 |
| Mark payroll paid | Y | Y | - | Y | Y | - | - | - | - | - | - | EV-9034 |
| Approve payment request (owner portal) | Y | Y | - | - | - | - | - | - | - | - | - | EV-9033 |
| Mark payment paid | Y | Y | - | Y | Y | Y | - | - | - | - | - | EV-9033, EV-9069 |
| Gov-platform password reveal | Y | Y | - | - | - | Y | - | - | - | - | - | EV-9037 |
| Terminate employee | Y | Y | Y | - | - | - | Y | - | - | - | - | EV-9069 |
| Workforce engine (salary scenarios) | Y | Y | Y | Y | - | - | - | - | - | - | - | EV-9015 |
| Biometric photos | Y | Y | Y | - | - | - | - | - | - | - | - | EV-9062 |
| Users & roles, settings, audit logs | Y | Y | - | - | - | - | - | - | - | - | - | EV-9032, EV-9015 |
| Grant SUPER_ADMIN | Y | - | - | - | - | - | - | - | - | - | - | EV-9032 |
| Set company scopes (UserCompanyScope) | Y | Y | - | - | - | - | - | - | - | - | - | EV-9054 |

`RolePermission` (settings/permissions) changes only the menu. It changes none of the rows above (EV-9016).

## Findings (ranked)

### High
- **S-H1 No company isolation outside the document engine.** `UserCompanyScope` is read only in `src/lib/documents/*`. HR, payroll, finance and gov users see and act on every legal entity. Payroll approval approves a month across all companies. (EV-9017, EV-9018, EV-9019, EV-9072)
- **S-H2 No MFA.** Schema columns exist and nothing uses them. A single password protects tenant-wide access to identity, bank and salary data and government-portal credentials. (EV-9010)
- **S-H3 No segregation of duties on payroll.** One PAYROLL ∩ FINANCE user can generate, approve and mark paid in one action, and the Payroll row has no generatedBy/approvedBy. (EV-9034)

### Medium
- **S-M1 RolePermission is not enforced.** It is a menu-only setting presented as permissions. (EV-9016)
- **S-M2 Finance roles can open identity, passport and health documents** through `/api/files`, contradicting the API redaction rule. (EV-9023, EV-9020)
- **S-M3 Audit trail gaps.** Audit failures are swallowed. The table is mutable by the app role. Deleting a user nulls the actor. Viewing full employee records and the payroll hub is not audited. (EV-9038, EV-9039)
- **S-M4 Brute-force protection is in memory only.** It resets on every reload or deploy, and there is no persistent lockout. (EV-9008)
- **S-M5 PII is not encrypted at the application layer** (national ID, IBAN, salary, uploaded documents), and local backups are unencrypted. (EV-9036, EV-9043)
- **S-M6 No global CSP.** CSRF protection relies only on SameSite=Lax (no Origin or Content-Type checks). (EV-9030, EV-9031)
- **S-M7 Payment maker-checker is two-person, not three.** The approver can also pay (CA is in OWNER and FINANCE). Rows without a requester pass. (EV-9033)
- **S-M8 No tests for login, rate limiting, the proxy allow-list or role gating.** (EV-9057)
- **S-M9 Cascading deletes on statutory HR history** (attendance, salary changes, visas...). There is no app path, but a manual delete erases the history. (EV-9050)

### Low
- **S-L1** The legacy plaintext-password login branch is still present. (EV-9009)
- **S-L2** The SESSION_SECRET minimum is enforced at 16 characters while the documentation requires 32. (EV-9005)
- **S-L3** One face token and one render token are shared by all tenants (both services are stateless and on localhost). (EV-9048)
- **S-L4** Anonymous uploads are not bound to an application: orphans accumulate, and disk abuse is possible across many IPs. (EV-9026)
- **S-L5** Circular attachments are readable by every employee of every company in the tenant. (EV-9053)
- **S-L6** The JWT has no iss/aud (mitigated by per-tenant secrets and the database lookup). (EV-9067)

### Strengths (verified)
- All 246 API handlers are authenticated except the intended public ones (EV-9001, EV-9002).
- Revocation is checked against the database on every request (EV-9004, EV-9013).
- The file-access model is strong, tested and audited (EV-9022, EV-9025).
- Privilege escalation to SUPER_ADMIN is blocked and tested (EV-9032).
- No secrets have ever been committed, and production fails closed without keys (EV-9005, EV-9040).
- Tenant isolation is by separate database, role, secrets and storage (EV-9044, EV-9045).
- Public endpoints are rate-limited and minimal (EV-9027, EV-9028, EV-9029).
