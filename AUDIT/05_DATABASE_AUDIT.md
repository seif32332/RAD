# 05 Database reality check

## Scope and method

Read the whole of `prisma/schema.prisma` (2,679 lines, 91 models, 17 enums) and every `prisma/migrations/*`
directory (27, `0_baseline` .. the uncommitted `9p_transfer_decision`). Cross-checked schema claims against code
with targeted `grep -rn` for `prisma.<camelModel>.`/`tx.<camelModel>.` across `src/` and `scripts/`, read
`.github/workflows/ci.yml` for the migration-drift job, and spot-read `src/app/api/companies/[id]/route.ts`,
`scripts/jobs.mjs` (`applyEmployeeChanges`), and `src/lib/documents/change-orders.ts` to confirm whether
apparent duplicate/dead schema surface is actually consumed. Money-column and status-column claims are exhaustive
greps over the whole schema, not samples. Evidence: EV-11001–EV-11021, EV-11040.

## Capability findings

### Schema and migration hygiene
Capability: keep `prisma/schema.prisma` and the applied migrations in lockstep, with CI catching drift.
Status: COMPLETE
Evidence: EV-11018, EV-11019, EV-11014, EV-11015
Files: `prisma/migrations/*`, `.github/workflows/ci.yml:74-120`
Functions/classes: n/a (CLI: `prisma migrate deploy`, `prisma migrate diff`)
DB tables: all
API routes: n/a
UI routes: n/a
Tests: CI job "Migrations on empty Postgres 16 (drift + idempotent seed)"
Observed behavior: 27 migrations apply cleanly in order (per CI); the uncommitted `9p_transfer_decision`
migration's `ALTER TABLE` statements match the uncommitted `schema.prisma` edits exactly (`EmployeeChangeOrder.departmentId/directManagerId`, `DocumentTypeSetting.optionsJson`).
Missing pieces: none found; this audit did not run `prisma migrate diff` itself (no DB connection per hard rules) — relies on CI's own drift gate plus manual read-through of the newest migration.
Risk: Low.
Confidence: High.

### Money precision (Float vs Decimal)
Capability: financial amounts stored without floating-point rounding risk.
Status: PARTIAL (adjusted from UNSAFE by adversarial verification — see below)
Evidence: EV-11002, EV-11003, EV-11900, EV-11901, EV-11902
Files: `prisma/schema.prisma` (88 `Float` columns; 0 `Decimal` columns)
Functions/classes: n/a
DB tables: `Company` (renewal/registration costs), `Employee` (`basicSalary`, `gosiDeduction`, `iqamaRenewalCost`), `Payroll` (all 15 money columns), `Loan`/`LoanInstallment`, `Deduction`, `Settlement`, `AccidentClaim`, `MedicalInsurance`, `PlannedPosition`, `SalaryChange`, `EmployeeChangeOrder`, and more.
API routes: every payroll/loan/settlement/finance write route ultimately persists into one of these `Float` columns.
UI routes: payrolls, loans, settlements, payments, medical-insurance, workforce.
Tests: `src/lib/__tests__/money.test.ts` tests `roundMoney` on float noise (`0.1 + 0.2`, `1.005`, negatives, non-finite) (EV-11902); calculator suites exercise the rounded outputs.
Observed behavior: every money-bearing column in the 2,679-line schema uses IEEE-754 `Float` (Postgres `double precision` under Prisma's default mapping), not `Decimal`/`numeric`. JS `Float`/`double` arithmetic on currency (SAR, 2 decimal places, and GOSI percentages with 2 decimal places) is a known source of cent-level drift after repeated add/subtract cycles (payroll runs, settlements, partial loan repayments).
Missing pieces: no `Decimal`/`numeric` column exists anywhere to compare against; this is systemic, not a one-off oversight. Whether the calculation layer (`src/lib/payroll-core`, etc.) rounds defensively at each step is a question for the Payroll domain report (09), not re-verified here; at the storage layer the precision guarantee itself is absent.
Risk: Medium (was High) — the storage layer has no exact-precision guarantee, but the application enforces a halala-rounding convention (`src/lib/money.ts` `roundMoney`/`sumMoney`, 89 import sites, EV-11900/EV-11901), so a correctly rounded 2-dp SAR value round-trips through `double precision` unchanged and sums are done in integer halalas. Residual risk: any new code path that skips `roundMoney`/`sumMoney`, and raw SQL/`_sum` arithmetic on the Float columns; a later `Float` to `Decimal` migration on live payroll tables would still be costly.
Confidence: High.

### Tenant/company ownership model
Capability: every HR record traces to the owning `Company` (legal entity) inside a tenant's shared database.
Status: PARTIAL
Evidence: EV-11004, EV-11006
Files: `prisma/schema.prisma:36-146` (`Employee`), `src/app/api/companies/[id]/route.ts:175-219`
Functions/classes: `deletionBlockers` (companies route)
DB tables: `Employee` (via `legalCompanyId`/`actualCompanyId` → `Company`), `Branch`, `Department`, `Administration` (each own `companyId`-shaped FK to `Company`), and everything hanging off `Employee`/`Branch`/`Department` transitively.
API routes: `DELETE /api/companies/[id]`
UI routes: `companies`
Tests: not found for this specific path (no route-level test, EV-11039).
Observed behavior: a literal `grep -c companyId` under-counts ownership because `Employee` uses `legalCompanyId`/`actualCompanyId` (two FKs, legal-vs-operating-company split, a real Saudi-market pattern) rather than a single `companyId`. Both are real `@relation` FKs with `onDelete: SetNull`, so deleting a `Company` does not orphan an `Employee`'s FK value silently — it nulls it. The `DELETE /api/companies/[id]` handler blocks deletion while any employees/branches/administrations/vehicles/meters/insurance/violations/documents exist, which covers the common destructive paths.
Missing pieces: the same delete handler does **not** count `HeadcountPlan`, `UserCompanyScope`, `NitaqatCurve`, `CandidateDocumentAccess`, or `SigningAuthorization` rows before allowing the delete, and all five cascade (`onDelete: Cascade`) from `Company` in the schema (EV-11005). A company that only has workforce-planning drafts or user scopes (no employees yet) can be deleted, silently cascading those rows away with no confirmation/count shown to the operator.
Risk: Medium — realistic scenario is a newly-created company being deleted during setup while a `HeadcountPlan` or `UserCompanyScope` already references it; low frequency, but no warning is given.
Confidence: Medium.

### Employee lifecycle status representation
Capability: employee/record lifecycle state is a closed, DB-enforced set of values.
Status: PARTIAL
Evidence: EV-11008, EV-11009, EV-11010
Files: `prisma/schema.prisma` (throughout)
DB tables: `Employee.employmentStatus`, plus ~29 other `status String` columns on `TransferRequest, Attendance, Loan, LoanInstallment, Investigation, OvertimeRequest, AttendanceCorrection, PaymentRequest, JobRequest, JobApplication, OnboardingRequest, Asset, Settlement, RenewalArchive, PromissoryNote, Lawsuit, JobRun, NotificationOutbox, MuqeemTransaction, IssuedDocument, DocumentRenderJob, CandidateDocumentAccess, HeadcountPlan` and others.
Observed behavior: 17 real Prisma `enum`s exist (`LeaveStatus`, `VisaStatus`, `PayrollStatus`, `ClaimStatus`, etc.) but roughly 30 other lifecycle columns are plain `String` with a `@default` and an inline comment listing the intended values (e.g. `status String @default("PENDING") // PENDING, APPROVED, REJECTED`). Nothing at the DB layer (no Postgres `CHECK` constraint on any status column; the six `CHECK`s that exist cover document-subject exclusivity and `DocumentTextOverride.slot`, EV-11903) stops an invalid string being written; correctness depends entirely on application code always writing from the documented set.
Missing pieces: DB-level enforcement (Prisma `enum` or `CHECK` constraint) for the ~30 string-status columns.
Risk: Medium — a bug, a raw SQL statement (the codebase does use raw SQL in at least one place, `DocumentCounter`, EV-11017), or a future migration script writing an unexpected value would not be rejected by the database; several of these are workflow-critical (`TerminationRequest.status`, `PaymentRequest.status`, `HeadcountPlan.status`).
Confidence: High.

### Salary as a single source of truth
Capability: an employee's current and historical `basicSalary` is unambiguous and reconciled across the lifecycle.
Status: PARTIAL
Evidence: EV-11011, EV-11012, EV-11013
Files: `prisma/schema.prisma` (`Employee`, `Payroll`, `OnboardingRequest`, `SalaryChange`, `EmployeeChangeOrder`, `PlannedPosition`), `scripts/jobs.mjs:761-798`, `src/lib/documents/change-orders.ts`
Functions/classes: `applyEmployeeChanges` (jobs.mjs)
DB tables: `Employee.basicSalary` (current), `SalaryChange` (history), `EmployeeChangeOrder` (pending decision, immutable once decided — EV-11014), `Payroll.basicSalary` (period snapshot), `OnboardingRequest.basicSalary` (pre-hire proposal), `PlannedPosition.basicSalary` (workforce-planning projection, hypothetical).
Observed behavior: `basicSalary` legitimately appears on 6 models because they represent different things in the lifecycle (current / snapshot / proposal / history / pending-decision / projection), and the `apply-employee-changes` job is the one writer that reconciles a decided `EmployeeChangeOrder` into `Employee.basicSalary` on its effective date, in a transaction, with an `AuditLog` row. This is a designed pattern, not an accidental duplicate-source bug.
Missing pieces: this audit did not verify that every code path that reads "current salary" for payroll generation actually reads `Employee.basicSalary` post-application (vs. a stale `Payroll`-embedded value) — that reconciliation-correctness question belongs to the Payroll domain report (09); here only the storage-level lineage was confirmed.
Risk: Medium (schema-level: correct by design, but 6 near-identical column names across models is a real footgun for anyone querying ad hoc, and there is no DB-level constraint tying them together — reconciliation is entirely job/service-layer).
Confidence: High (for what was checked at the storage layer); Low for cross-domain reconciliation correctness (not this specialist's evidence).

### Change-order immutability / audit trail
Capability: once an `EmployeeChangeOrder` (promotion, salary change, transfer) is decided, it cannot be altered or deleted.
Status: COMPLETE
Evidence: EV-11014
Files: `prisma/migrations/9p_transfer_decision/migration.sql:9-25` (trigger function, uncommitted), earlier `9j_employee_change_orders` (not re-read line-by-line, referenced by the 9p trigger replacement)
DB tables: `EmployeeChangeOrder`
Observed behavior: a Postgres trigger function `employee_change_order_guard()` raises on `DELETE`, on any change to the decided/immutable columns once `appliedAt`/`cancelledAt` is set, and if both `appliedAt` and `cancelledAt` end up set simultaneously — enforced at the database level, not just in application code.
Missing pieces: none found within the scope read (trigger logic only, not exhaustively fuzz-tested).
Risk: Low.
Confidence: High.

### Dead/unused schema surface
Capability: every table in the 91-model schema is actually read or written somewhere in the product.
Status: PARTIAL
Evidence: EV-11016, EV-11017
Files: `prisma/schema.prisma` (`CompanyDocument`, `EvaluationTemplateSection`, `EvaluationTemplateItem`, `DocumentCounter`)
Observed behavior: mechanical `prisma.<camelModel>.`/`tx.<camelModel>.` search over `src/` and `scripts/` initially flagged 4 models as unused. Three are false positives once nested-write and raw-SQL access patterns are followed (`EvaluationTemplateSection`/`Item` via `sections: { create: [...] }` in `src/app/api/evaluations/route.ts`; `DocumentCounter` via raw `INSERT ... ON CONFLICT` in `src/lib/documents/service.ts:448`). `CompanyDocument` (companyId, documentType, documentUrl, expirationDate, isAlertSent) has zero references anywhere outside `schema.prisma` — genuinely dead.
Missing pieces: `CompanyDocument` should either be wired up (it looks intended for company-level license/registration expiry tracking and alerting, functionality that appears to instead live as discrete columns directly on `Company`, e.g. `commercialRegCost`/`iqamaFeeYear`/`trademarkCost`) or removed.
Risk: Low (dead weight, not a correctness bug) but a caution for anyone auditing "does expiry alerting cover company documents" — the table's existence could mislead a reviewer into thinking that capability exists when it does not.
Confidence: High.

### Audit-actor referential integrity
Capability: `createdById`/`approvedById`/`paidInPayrollId`-style actor/reference columns point to a real, still-existing row.
Status: PARTIAL
Evidence: EV-11021, EV-11007
Files: `prisma/schema.prisma` (spot-checked `Loan:795`, `Deduction:965-966`, `IssuedDocument:2189`, and the broader pattern across `AuditLog`, `DocumentApproval`, `DocumentEvent`, `UploadedFile`)
Observed behavior: many actor/cross-reference columns are plain `String?` with no `@relation`, so Prisma/Postgres enforce no FK integrity on them. In practice this is mitigated because this audit found no hard-delete path for `User`, `Payroll`, or `Settlement` rows (consistent with the `Employee` no-hard-delete finding, EV-11007), so the orphan scenario is currently theoretical rather than observed.
Missing pieces: no DB-level guarantee; if any admin tooling or future job ever hard-deletes a `User`/`Payroll`/`Settlement` row, every unenforced string reference to it silently dangles with no cascade, no null, and no error.
Risk: Low today, Medium as a latent design gap.
Confidence: Medium.

### Indexing
Capability: high-cardinality lookup columns (employeeId, companyId, status, dates used in reports) are indexed.
Status: COMPLETE
Evidence: EV-11020
Files: `prisma/schema.prisma`
Observed behavior: 170 `@@index` declarations plus 13 multi-column `@@unique` constraints, in addition to inline `@unique` on natural keys (`Employee.employeeId`, `Employee.iqamaOrIdNumber`, `Employee.biometricId`). Not verified against actual query plans (no DB connection permitted), so this is schema-declared coverage, not measured query performance.
Missing pieces: no `EXPLAIN`-level verification possible under the audit's read-only/no-DB constraint.
Risk: Low.
Confidence: Medium.

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| A `Company` cannot be deleted while it has employees/branches/administrations/vehicles/meters/insurance/violations/documents | `src/app/api/companies/[id]/route.ts` (`deletionBlockers`) | API route only, not a DB constraint (no FK `RESTRICT`; relies on the count check running first) | none found (EV-11039) | Org, Legal, Assets | No — single implementation, but not backed by DB `onDelete: Restrict` |
| An `EmployeeChangeOrder`, once decided, is immutable and cannot be deleted | `employee_change_order_guard()` Postgres trigger (`9p_transfer_decision`/`9j_employee_change_orders`) | DB trigger (enforced regardless of caller) | not directly tested at DB level within this audit's scope | Workforce, Documents | No |
| `basicSalary` moves from proposal → decision → application → history | `scripts/jobs.mjs` `applyEmployeeChanges` + `src/lib/documents/change-orders.ts` | Job (cron) + documents service | referenced tests: `src/lib/__tests__/documents-pipeline.test.ts` (per EV-11017) | Payroll, Documents, Workforce | Yes, by design (6 models carry the field — see finding above) — not flagged as a bug, but is a real duplication surface |
| Employee lifecycle/status values are drawn from a fixed set | Inline schema comments only (`// ACTIVE, ON_LEAVE, EXCLUDED` etc.) | Application code (wherever each status is written) — no DB enum/CHECK | not verifiable generically | Nearly every domain | N/A — the rule exists only as documentation, not as enforced logic |

## Edge cases checked

- **Deleting a company with no employees yet, but with a headcount plan or user scope**: `DELETE /api/companies/[id]` does not count `HeadcountPlan`/`UserCompanyScope`/`NitaqatCurve`/`CandidateDocumentAccess`/`SigningAuthorization` before deleting, and all cascade from `Company`. Finding: silent cascade possible in this narrow window. EV-11005, EV-11006.
- **Hard-deleting an employee**: no code path does this anywhere in `src/` or `scripts/`; termination is a status flag, not a row delete, so the 35 `onDelete: Cascade` relations attached to `Employee` are not exercised in practice. EV-11007.
- **Decided change order being edited after the fact (e.g. correcting a typo in a transfer decision)**: blocked at the DB trigger level, not just the API — cannot be bypassed by a direct SQL update either. EV-11014.
- **Uncommitted migration (`9p_transfer_decision`) vs. working-tree schema**: read together and found consistent (new columns and trigger match the schema edits exactly). EV-11014, EV-11015.
- **Money rounding across repeated payroll/settlement cycles**: not independently reproduced (would need a live calculation trace across periods, out of this specialist's evidence-gathering scope), but the structural precondition (no `Decimal` anywhere) is confirmed. Adversarial verification found the calculators do round defensively via `src/lib/money.ts` (EV-11900–EV-11902), so the capability is PARTIAL, not UNSAFE. EV-11002, EV-11003.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Platform/DB | 9 | 4 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Money stored as Float everywhere (no Decimal), mitigated by an app-level halala-rounding convention; ~30 lifecycle status columns not DB-enforced; Company delete doesn't count workforce/scope rows | Medium-High |

## Adversarial verification

Verifier re-opened every cited file and grepped for code the specialist may have missed. New evidence EV-11900–EV-11904 in `AUDIT/_work/ledger_K.md`.

| Finding | Verdict | Final status / severity | Reason |
|---|---|---|---|
| K-1 Money precision | ADJUSTED | PARTIAL / Medium (was UNSAFE / Critical in the brief, High in the matrix) | The fact is true: `grep -c Decimal prisma/schema.prisma` = 0, 88 `Float` fields, no `numeric`/`DECIMAL` in any migration, and `Payroll` (`schema.prisma:812-834`) and `Employee.basicSalary` (`:393`) are `Float`. But the specialist missed `src/lib/money.ts`: a documented convention that every computed amount is rounded to halalas with `roundMoney()` before storage, and that sums go through `sumMoney()` in integer halalas. It is imported at 89 sites; `payroll-core.ts` uses it for every stored figure, including cumulative-rounding allocation, and dashboard and owner-report `_sum` aggregates are re-rounded (EV-11900, EV-11901). A rounding-specific test exists (`money.test.ts`, EV-11902). A 2-dp SAR amount rounded this way round-trips exactly through `double precision`, so cent drift needs a code path that skips the helpers. That is a real but conventional-only risk: PARTIAL, not UNSAFE. |
| K-2 Lifecycle status enforcement | ADJUSTED | PARTIAL / Medium (the brief said High; report and matrix already said Medium) | The core claim holds. There are exactly 17 `enum`s, and about 35 status-type `String` columns (40 lines matching `*status String`) have only comment-documented values. No `CHECK` constraint covers any status column. Two corrections: (a) six `CHECK` constraints do exist in migrations 9k/9l/9o, one of them an IN-list (`DocumentTextOverride.slot`), so the report's "no CHECK constraint in any migration" was wrong and the fix pattern already exists in the repo (EV-11903). (b) `Employee.employmentStatus` is at `schema.prisma:402`, not `:88`. 14 API Zod schemas use `status: z.enum(...)` (EV-11904), which gives partial application-boundary validation. Severity stays Medium: a closed set enforced in app code plus some Zod is not High. |


Cross-check with other reports. `AUDIT/03_DOMAIN_REPORTS/09_payroll.md:192` independently reaches the same conclusion as the K-1 adjustment: no Decimal columns, and correctness depends on every writer calling `roundMoney`. It rates this acceptable at SAR scale but not auditable by type.
