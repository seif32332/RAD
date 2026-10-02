# 25 Multi-tenancy / data isolation

## Scope and method
Read `ecosystem.config.js`, `docker-compose.yml`, `ops/new-tenant.sh`, `ops/run-jobs.sh`, `ops/backup.sh`, `radeef-manage/{server.js,lib/ops.js}`, `scripts/jobs.mjs` (env handling), `src/lib/session.ts`, `src/lib/documents/{service,settings,queries}.ts`, and the Prisma schema (UserCompanyScope, cascades, soft delete, Circular).
Grepped every use of `UserCompanyScope`/`staffCompanyScope` and traced the employee, payroll and payroll-approval queries. There are two layers of tenancy: (a) one deployment, database and upload directory per customer; (b) several `Company` rows (legal entities) inside one tenant database.
Evidence IDs: EV-9001..EV-9073 (`AUDIT/_work/ledger_I.md`).

## Capability findings

### Per-tenant deployment / process isolation
Capability: one app process per customer
Status: COMPLETE
Evidence: EV-9045
Files: ecosystem.config.js, docker-compose.yml
Observed behavior: one pm2 app (or container) per `/etc/radeef/<tenant>.env`, bound to 127.0.0.1, with its own port. Docker uses a per-tenant env_file and volume.
Risk: Low
Confidence: High

### Per-tenant database and least-privilege role
Status: COMPLETE
Evidence: EV-9044, EV-9046
Files: ops/new-tenant.sh:135-150, radeef-manage/lib/ops.js:343-346
Observed behavior: a separate database and login role per tenant (NOSUPERUSER, NOCREATEDB, NOCREATEROLE). `REVOKE ALL ON DATABASE ... FROM PUBLIC` and `REVOKE ALL ON SCHEMA public FROM PUBLIC` mean one tenant's role cannot connect to another tenant's database.
Risk: Low
Confidence: High (the provisioning script was not executed)

### Per-tenant secrets (session signing, data key)
Status: COMPLETE
Evidence: EV-9044, EV-9046, EV-9067, EV-9006
Observed behavior: SESSION_SECRET and DATA_ENCRYPTION_KEY are generated per tenant, both by `new-tenant.sh` and by radeef-manage. Even if two tenants shared a secret, a token's `sub` (UUID) would not exist in the other tenant's User table (EV-9004), and the cookie is host-only.
Risk: Low
Confidence: High

### Storage separation (UPLOAD_DIR per tenant)
Status: COMPLETE
Evidence: EV-9044, EV-9045, EV-9047
Observed behavior: `UPLOAD_DIR=/var/lib/radeef/<tenant>/uploads` for pm2, and separate volumes for docker. Jobs refuse to run file operations without UPLOAD_DIR.
Risk: Low
Confidence: High

### Tenant-aware background jobs
Status: COMPLETE
Evidence: EV-9047
Observed behavior: `ops/run-jobs.sh` loops over the tenant env files (plus `jobs-extra.list`) and runs `node --env-file=<tenant.env> scripts/jobs.mjs`. `RADEEF_JOBS="off"` skips a suspended tenant.
Risk: Low
Confidence: High

### Cross-tenant session/cookie leakage
Status: COMPLETE
Evidence: EV-9006, EV-9067, EV-9004
Observed behavior: host-only cookie, distinct secret per tenant, and the user is reloaded from the tenant's own database.
Missing pieces: the JWT carries no `iss`/`aud` claim (defense in depth only).
Risk: Low
Confidence: High

### Shared sidecar services (face, render) across tenants
Status: PARTIAL
Evidence: EV-9048
Observed behavior: one face service and one render service serve all tenants, and each has a single bearer token copied into every tenant env file. Both are bound to localhost and store nothing (render deletes its temp directory; no writes found in the face app).
Missing pieces: no per-tenant token, so compromising one tenant's env file exposes the shared token. The impact is limited because the services are stateless and bound to 127.0.0.1.
Risk: Low
Confidence: Medium

### Intra-tenant company isolation (UserCompanyScope)
Capability: a staff user limited to company A must not see company B's employees, payroll, loans or documents
Status: PARTIAL
Evidence: EV-9017, EV-9018, EV-9019, EV-9072, EV-9054, EV-9063
Files: src/lib/documents/service.ts:242-246 (only enforcement point), src/app/api/employees/route.ts:277-293, src/app/api/payroll-hub/route.ts:103-130, src/lib/payroll.ts:254-260
DB tables: UserCompanyScope (userId, companyId)
API routes: POST /api/documents/settings {action:'scope'} (the only writer)
UI routes: /documents/settings
Tests: documents-pipeline.test.ts (documents only)
Observed behavior: the document engine filters requests and issued documents by the actor's company scope. Nothing else does. HR sees and edits all employees of all companies. PAYROLL sees and approves every company's payroll for a month in one action. GOV sees every company's gov-platform passwords.
Missing pieces: a scope filter in every domain query, a scope-aware `managedEmployeesWhere`, and company-level payroll approval.
Risk: High for multi-company groups that delegate HR per legal entity. Low for single-company tenants.
Confidence: High

### Company-scoped administrator
Status: MISSING
Evidence: EV-9015, EV-9017 (`staffCompanyScope` returns null for OWNER roles; COMPANY_ADMIN belongs to every role group)
Observed behavior: despite its label "صاحب العمل / مدير الشركة" (employer / company manager), COMPANY_ADMIN is a tenant-wide administrator.
Risk: Medium
Confidence: High

### Row-level security in the database
Status: MISSING
Evidence: EV-9049
Risk: Low (tenancy is enforced by the database-per-tenant layout; RLS would only matter for intra-tenant company isolation)
Confidence: High

### Referential integrity / cascading deletes on HR data
Status: PARTIAL
Evidence: EV-9050, EV-9052
Observed behavior: deleting an Employee would cascade to attendance, punches, face profile, visas, allowances, overtime, corrections, evaluations, salary changes and transfers. No application path hard-deletes an Employee, and Company delete is refused while it has dependents.
Missing pieces: history is protected only by application discipline. A manual or scripted delete would silently erase statutory records.
Risk: Medium
Confidence: High

### Soft deletion / historical records
Status: MISSING
Evidence: EV-9051
Observed behavior: there is no deletedAt/isDeleted anywhere. Employees are kept through `isTerminated`/`employmentStatus`; other entities (legal contracts, payment requests, work schedules) are hard-deleted through `deleteMany` in their routes.
Risk: Low
Confidence: Medium

### Tenant manager panel security
Status: COMPLETE
Evidence: EV-9046
Observed behavior: localhost bind, server-side random session, SameSite=Strict, same-origin write check, rate-limited timing-safe login.
Risk: Low (it holds SSH power over production; its own single admin credential has no MFA)
Confidence: Medium

### Tenant-level backup separation
Status: PARTIAL
Evidence: EV-9043
Observed behavior: per-tenant dump and uploads archive, `umask 077`.
Missing pieces: local copies are unencrypted.
Risk: Medium
Confidence: High

### Tenant-wide broadcast data (circulars)
Status: PARTIAL
Evidence: EV-9053
Observed behavior: the legacy Circular model has no company, so every employee of every company in the tenant can download any published circular attachment.
Risk: Low
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| One DB + role + secrets + upload dir per tenant | ops/new-tenant.sh:135-178 | also radeef-manage/lib/ops.js:343-395 | x-ops-panel.test.ts (by name, not reviewed) | 25, 29 | Yes (two provisioning paths) |
| Staff company scope (null = all) | documents/service.ts:242-246 | documents only | documents-pipeline.test.ts | 04 (enforced), 01/09/16/22 (not) | No |
| Jobs per tenant env | ops/run-jobs.sh:60-86 | scripts/jobs.mjs:925-929 | x-ops-jobs.test.ts (by name) | 20, 29 | No |
| Company delete blocked by dependents | companies/[id]/route.ts:203-217 | same | not found | 02 | No |

## Edge cases checked
- Multi-company tenant: a company-scoped HR user still sees all companies outside the document engine (EV-9017, EV-9018).
- Payroll approval for a month covers every company in the tenant (EV-9072).
- Transferred employees (moved between companies in the same tenant): because there is no company scope, the previous company's staff keep full visibility (EV-9018).
- Terminated employees: their history is preserved because no employee hard-delete exists, but cascades would erase it on a manual delete (EV-9050).
- Suspended tenant: jobs are skipped with `RADEEF_JOBS="off"` (EV-9047).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 25 Multi-tenancy | 15 | 7 | 5 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | Company scope enforced only in documents; no company-scoped admin; cascades on HR history | High |

## Adversarial verification

Verifier pass over finding I-1, which this report shares with report 24. No status or severity changed, so the capability block, scorecard and matrix_I.md are unchanged.

| Finding | Capability | Verdict | Reason | New evidence |
|---|---|---|---|---|
| I-1 | Intra-tenant company isolation (UserCompanyScope) | CONFIRMED (PARTIAL, High for multi-company tenants) | I searched for a global guard and found none. There is no Prisma `$extends`/`$use`, no company column on User, and no route reads a user's company. UserCompanyScope is referenced only in src/lib/documents/{queries,service,settings}.ts, and owner-only documents settings is its only writer (settings.ts:160-170). Payroll generation (generate/route.ts:25-32) and approval (payroll.ts:254-260) are both month-wide for the whole tenant. The document-engine SPEC (§2 line 49, §10 line 473) and migration 9d ("No rows = unrestricted") acknowledge the gap as a general Radeef issue outside the document engine. | EV-9900, EV-9901, EV-9902 |
