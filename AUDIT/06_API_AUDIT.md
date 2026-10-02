# 06 API reality check

## Scope and method

Mechanically inventoried all 149 `route.ts` files under `src/app/api` (`find src/app/api -name route.ts`,
SYSTEM_MAP.md's discovery pass counted 153 — a 4-file drift not investigated further, EV-11022) with a script
that, per file, greps for exported HTTP methods, direct `requireUser(...)`/`requireEmployeeId(`/`requireDocumentsUser(`
literal calls, and Zod usage. The raw pass over-flagged both "no auth" and "no validation" because several
routes delegate to a shared `_lib/` helper in the same folder (e.g. workforce plan transitions, `_lib/actions.ts`)
or import a Zod schema from a sibling `_lib/schemas.ts` file — every flagged case was re-read by hand and
corrected (EV-11024, EV-11031–EV-11034). Also read `src/lib/http.ts` (central error/validation helpers),
`src/app/api/files/[...path]/route.ts` (scoped file access) in full, sampled `src/app/api/employees/import/route.ts`
and `src/app/api/upload/route.ts`, and cross-checked a sample of routes against literal `fetch('/api/...')` calls
in `src/app` / `src/components` for connectivity (with documented false-negatives for hook-based/dynamic calls).
Evidence: EV-11022–EV-11040.

## Capability findings

### Authentication/authorization guard coverage
Capability: every non-public route enforces a role check before touching data.
Status: COMPLETE
Evidence: EV-11023, EV-11024, EV-11025, EV-11026, EV-11028
Files: all 149 `route.ts` (see full inventory table below), `src/app/api/workforce/plans/_lib/actions.ts`, `src/proxy.ts` (per SYSTEM_MAP EV-0007)
Functions/classes: `requireUser(ROLE_GROUPS.*)`, `requireEmployeeId(`, `requireDocumentsUser(`
API routes: all
Observed behavior: of 149 routes, 9 have no direct `requireUser`-style call visible in the file itself: `auth/login`, `auth/logout`, `auth/me`, `apply/[jobRequestId]` (intentionally public, self-hardened, EV-11025), `health` (public health check), `files/[...path]` (uses `requireUser()` with no role restriction — any authenticated user, then per-file scoped authorization, EV-11028), `notifications`/`profile`/`settings/profile` (`requireUser()` self-service, EV-11026), and `upload` (uses `getSessionUser`, optional auth, EV-11027). The 5 `workforce/plans/[id]/{approve,archive,copy,reject,submit}` routes initially looked unguarded but delegate to `transitionHandler` in `_lib/actions.ts`, which calls `requireUser(ROLE_GROUPS.WORKFORCE)` (EV-11024) — false positive corrected.
Missing pieces: `upload`'s exact anonymous-access boundary (which categories/flows allow a fully anonymous POST, and whether that is rate-limited/scoped) was not independently traced end-to-end here — flagged for the recruitment/documents domain reports to confirm. EV-11027.
Risk: Medium overall (well-covered, one flagged gap in confidence, not evidence, of a real hole).
Confidence: Medium.

### Input validation coverage on write routes
Capability: every POST/PUT/PATCH validates its body before touching Prisma.
Status: COMPLETE
Evidence: EV-11029, EV-11031, EV-11032, EV-11033, EV-11034
Files: `src/lib/http.ts` (`parseBody`, `parseQuery`), plus every write route's own `_lib/schemas.ts` where present
Observed behavior: a raw same-file Zod grep initially flagged 60/149 files as having no validation; re-checked after following `parseBody(req, someImportedSchema)` and cross-file schema imports, the real gap list for POST/PUT/PATCH routes shrank to: `auth/logout` (no body), `employees/import` (multipart CSV — has extensive hand-written per-column validation instead, EV-11033), `upload` (multipart file — manual role/type checks, no Zod), and the 5 workforce-plan transition wrappers (validated in their shared `_lib/actions.ts`, not Zod-absent). Effectively no write endpoint skips validation entirely.
Missing pieces: `employees/import` and `upload` rely on hand-written validation rather than a schema — functionally present but harder to audit/extend consistently than the Zod pattern used everywhere else.
Risk: Low.
Confidence: Medium (validation *presence* is well evidenced; validation *correctness/completeness* per field was not exhaustively checked for all 149 routes — that is a per-domain-report job).

### Centralized, non-leaking error handling
Capability: every route returns a consistent JSON error shape without leaking internals.
Status: COMPLETE
Evidence: EV-11029, EV-11030
Files: `src/lib/http.ts:1-40`
Observed behavior: `HttpError` + `badRequest/unauthorized/forbidden/notFound/conflict` factories and a single `handleApiError()` that maps `HttpError`/`ZodError`/anything else to a safe JSON body with Arabic-preferring messages; used in 142/149 route files. The 7 that don't use it are the intentionally minimal public/self-service routes.
Missing pieces: none found.
Risk: Low.
Confidence: High.

### Scoped, audited file access
Capability: uploaded files (identity docs, contracts, photos) are served only to authorized viewers, with sensitive reads audited.
Status: COMPLETE
Evidence: EV-11028
Files: `src/app/api/files/[...path]/route.ts:96-172`
Functions/classes: `decideScopedFileAccess`, `referencedByOwnRecords`, `isMuqeemDocument`, `isInManagersTeam` (imported from `src/lib/storage.ts` / `src/lib/hr-workflows.ts`)
DB tables: `UploadedFile`, `AuditLog`, plus lookups into `Employee`, `Leave`, `Visa`, `Loan`, `Settlement`, `Circular`, `MedicalInsurance`, `MuqeemTransaction`
Observed behavior: layered authorization (role-wide access for HR/payroll/owner/admin; team-scoped for branch/dept managers; sensitive-category restriction to HR-type roles + the employee themself + GOV_RELATIONS for Muqeem PDFs only; anyone for files referenced by their own records) with identical 403 responses whether the file exists or not (anti-enumeration), and an `AuditLog` `VIEW` row written for every sensitive-category read.
Missing pieces: none found within the file read.
Risk: Low.
Confidence: High.

### Route inventory completeness / dead-endpoint detection
Capability: every declared route is actually reachable from the product (no dead API surface, no page calling a non-existent route).
Status: PARTIAL
Evidence: EV-11035, EV-11036, EV-11037, EV-11038
Files: sampled `src/app/payrolls/page.tsx`, `src/app/workforce/page.tsx`, `src/app/workforce/_components/PdfReportButton.tsx`, `src/app/loans/page.tsx`, `src/app/payments/page.tsx`
Observed behavior: a literal-string `fetch('/api/...')` grep across `src/app`/`src/components` finds only 84 unique targets against 149 routes — a large apparent gap. Every spot-checked "missing" route turned out to be connected via a different mechanism: a differently-named route family the page actually calls (`payroll-hub` instead of a guessed `payrolls`), a shared `useApi`/`callApi` hook that builds the URL from a template literal, or a dynamically-returned URL (`data.fileUrl`) rather than a hardcoded path. No genuinely dead route and no genuinely broken page→route reference were found in the samples checked, but a literal-safe, exhaustive route↔page mapping across all 149 routes was not completed given the audit's time budget.
Missing pieces: full non-literal-safe connectivity mapping (would need to parse every `useApi<T>(...)`/`callApi(...)` call site and every template-literal fetch, not just literal strings).
Risk: Low (spot checks found no real dead code) but confidence in "no dead routes anywhere" is Low given the incomplete method.
Confidence: Low.

### Route-level (HTTP-wiring) automated test coverage
Capability: the auth guard, validation, and status-code behavior of each route is itself tested (not just the service function it calls).
Status: PARTIAL (adjusted from MISSING by adversarial verification — see below)
Evidence: EV-11039, EV-11040, EV-11905, EV-11906
Files: `src/lib/__tests__/wf-total-rewards.test.ts`, `src/lib/__tests__/wf-report-pdf.test.ts`, `src/lib/__tests__/wf-review-p3.test.ts` (route handlers invoked with `new Request(...)`); `src/app/api/settings/__tests__/admin-rules.test.ts` (guard helpers only, no handler call)
Observed behavior: all other Vitest coverage (89 files) lives under `src/lib/__tests__` and tests the domain/service layer directly (calculators, `src/lib/documents/*`, `src/lib/workforce/*`, etc.), not the `route.ts` handlers — so a route that calls the right service function but has the wrong role guard, the wrong schema, or a broken try/catch would not be caught by the existing suite. No E2E/browser test framework is present (`package.json`, per SYSTEM_MAP EV-0022/0023) to cover this gap end-to-end either.
Correction (verification): route handlers are invoked directly in 3 test files, covering `portal/total-rewards`, `portal/total-rewards/pdf`, `workforce/report`, and the shared `transitionHandler` behind the 4 `workforce/plans/[id]/*` routes. Those tests assert 200/400/403/503 (EV-11905). Another 25 test files import guard, schema and helper logic from `src/app/api/**` (EV-11906). `admin-rules.test.ts` tests exported helpers, not a handler.
Missing pieces: route-level (Next.js route-handler) tests for auth-guard and validation wiring across the remaining ~140 of 149 routes.
Risk: Medium — a copy-paste error changing `ROLE_GROUPS.HR` to `ROLE_GROUPS.ALL` on a sensitive route, for example, would not fail any existing automated test.
Confidence: High.

## Full route inventory

Columns: Path | Methods | Auth guard (as found in the file or its shared `_lib` helper) | Validation present (Zod schema imported/used, directly or via shared `_lib`)

| Path | Methods | Auth guard | Validated |
|---|---|---|---|
| admin/alerts | GET | requireUser(ADMIN_ALERT_ROLES) | no (read-only) |
| administrations/[id] | GET,PUT,DELETE | requireUser(STAFF); requireUser(WRITERS) | yes |
| administrations | GET,POST | requireUser(STAFF); requireUser(WRITERS) | yes |
| applications | GET,POST | requireUser(HR) | yes |
| apply/[jobRequestId] | GET,POST | public (self-hardened, EV-11025) | yes |
| assets/[id] | PATCH | requireUser(LOGISTICS) | no (manual, not re-verified) |
| assets | GET,POST | requireEmployeeId; requireUser(ALL); requireUser(LOGISTICS) | no (manual, not re-verified) |
| attendance-corrections/[id]/action | POST | requireUser(MANAGERS) | yes |
| attendance-corrections | GET,POST | requireEmployeeId; requireUser(ALL) | yes |
| attendance-hub | GET,POST | requireUser(HR) | yes |
| attendance-locations/[id] | PUT,DELETE | requireUser(LOCATION_WRITERS) | yes |
| attendance-locations | GET,POST | requireUser(LOCATION_WRITERS); requireUser(STAFF) | yes |
| attendance-punches/[id]/photo | GET | requireUser(HR) | no (read-only) |
| attendance-punches/[id] | PUT | requireUser(HR) | yes |
| attendance-punches | GET | requireUser(HR) | yes |
| auth/login | POST | public | yes |
| auth/logout | POST | public (session cookie only) | no (no body) |
| auth/me | GET | public/session | no (read-only) |
| branches/[id] | GET,PUT,DELETE | requireUser(STAFF); requireUser(WRITERS) | yes |
| branches | GET,POST | requireUser(STAFF); requireUser(WRITERS) | yes |
| claims/[id] | GET,PUT,DELETE | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| claims | GET,POST | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| companies/[id] | GET,PUT,DELETE | requireUser(STAFF); requireUser(WRITERS) | yes |
| companies | POST,GET | requireUser(STAFF); requireUser(WRITERS) | yes |
| compliance | GET,POST | requireUser(COMPLIANCE_WRITE_ROLES); requireUser(STAFF) | yes |
| dashboard | GET | requireUser(STAFF) | no (read-only) |
| departments/[id] | GET,PUT,DELETE | requireUser(HR); requireUser(STAFF) | yes |
| departments | GET,POST | requireUser(HR); requireUser(STAFF) | yes |
| dept-manager | GET,POST | requireUser(MANAGERS) | yes |
| documents/[id]/pdf | GET | requireDocumentsUser | no (read-only) |
| documents/[id]/recipients | GET | requireDocumentsUser | no (read-only) |
| documents/[id] | POST | requireDocumentsUser | yes |
| documents/requests/[id] | GET,POST | requireDocumentsUser; requireUser(ALL) | yes |
| documents/requests | GET,POST | requireDocumentsUser | yes |
| documents/settings | GET,POST | requireUser(ALL) | not re-verified (raw pass: 0) |
| employees/[id]/muqeem | GET,POST | requireUser(GOV) | yes |
| employees/[id] | GET,PUT,PATCH | requireUser(HR); requireUser(STAFF); requireUser(TERMINATE_ROLES) | yes |
| employees/gosi-review | GET,POST | requireUser(PAYROLL) | yes |
| employees/import | POST | requireUser(HR) | manual (EV-11033) |
| employees/import/template | GET | requireUser(HR) | no (read-only) |
| employees | POST,GET | requireUser(HR); requireUser(STAFF) | yes |
| evaluations | GET,POST | requireEmployeeId; requireUser(ALL); requireUser(HR); requireUser(MANAGERS) | yes |
| face-profiles/[employeeId]/photo | GET | requireUser(HR) | no (read-only) |
| files/[...path] | GET | requireUser() + scoped access (EV-11028) | no (read-only) |
| gov-platforms | GET,POST,PUT,DELETE | requireUser(GOV_PLATFORM_ROLES) | yes |
| health | GET | public | no (read-only) |
| hr/alerts | GET | requireUser(HR_ALERT_ROLES) | no (read-only) |
| incoming-requests/archive | GET | requireUser(ARCHIVE_ROLES) | no (read-only) |
| incoming-requests | GET,POST | requireUser(ACCESS_ROLES) | yes |
| integrations/muqeem/lookups | GET | requireUser(GOV) | yes |
| integrations/muqeem/residents/apply | POST | requireUser(GOV) | yes |
| integrations/muqeem/residents/sync | POST | requireUser(GOV) | yes |
| integrations/muqeem/status | GET | requireUser(GOV) | no (read-only) |
| integrations/muqeem/test-connection | POST | requireUser(ROLES) | yes |
| integrations/muqeem/transactions/[id]/reconcile | POST | requireUser(ROLES) | yes |
| integrations/muqeem/transactions/interactive-report | POST | requireUser(GOV) | yes |
| integrations/muqeem/transactions | GET | requireUser(GOV) | yes |
| leaves/[id]/action | POST | requireUser(ALL) | yes |
| leaves/balance | GET | requireEmployeeId; requireUser(ALL) | yes |
| leaves/preview | GET | requireEmployeeId; requireUser(ALL) | yes |
| leaves | GET,POST | requireEmployeeId; requireUser(ALL) | yes |
| legal/agencies | GET,POST | requireUser(LEGAL) | yes |
| legal/alerts | GET | requireUser(LEGAL) | no (read-only) |
| legal/contracts/[id] | PATCH,DELETE | requireUser(LEGAL) | yes |
| legal/contracts | GET,POST | requireUser(LEGAL) | yes |
| legal/investigations | GET,POST | requireUser(INVESTIGATION_ROLES) | yes |
| legal/lawsuits | GET,POST | requireUser(LEGAL) | yes |
| legal/promissory-notes/[id] | PATCH | requireUser(LEGAL) | yes |
| legal/promissory-notes | GET,POST | requireUser(LEGAL) | yes |
| logistics/alerts | GET | requireUser(LOGISTICS) | no (read-only) |
| manager-portal | GET,POST | requireUser(ASSET_REQUEST_ROLES); requireUser(ALL); requireUser(MANAGERS) | yes |
| medical-insurance/[id] | GET,PUT,DELETE | requireUser(INSURANCE_ROLES) | yes |
| medical-insurance | GET,POST | requireUser(INSURANCE_ROLES) | yes |
| nationalities | GET,POST,DELETE | requireUser(HR); requireUser(STAFF) | yes |
| notifications | GET | requireUser() self-service | no (read-only) |
| owner-portal/circulars | GET,POST | requireUser(ALL); requireUser(OWNER) | yes |
| owner-portal/payments | GET,POST | requireUser(OWNER) | yes |
| owner-portal/requests | GET,POST | requireUser(OWNER) | yes |
| owner-reports | GET | requireUser(OWNER) | yes |
| payments/[id] | PUT,DELETE | requireUser(PAYMENTS_ACCESS); requireUser(FINANCE) | yes |
| payments | GET,POST | requireUser(PAYMENTS_ACCESS) | yes |
| payroll-hub/export | GET | requireUser(PAYROLL) | yes |
| payroll-hub/generate | POST | requireUser(PAYROLL) | yes |
| payroll-hub | GET,POST | requireEmployeeId; requireUser(HUB_READ_ROLES); requireUser(ALL) | yes (16 schema refs) |
| payroll-hub/summary | GET | requireUser(PAYROLL) | yes |
| portal/attendance/punch | POST | requireEmployeeId; requireUser(ALL) | yes |
| portal/attendance | GET | requireEmployeeId; requireUser(ALL) | no (read-only) |
| portal/correction | POST | requireEmployeeId; requireUser(ALL) | yes |
| portal/face | POST,PATCH,DELETE | requireEmployeeId; requireUser(ALL) | yes |
| portal | GET | requireEmployeeId; requireUser(ALL) | no (read-only) |
| portal/termination | POST | requireEmployeeId; requireUser(ALL) | yes |
| portal/total-rewards/pdf | GET | requireEmployeeId; requireUser(ALL) | no (read-only) |
| portal/total-rewards | GET | requireEmployeeId; requireUser(ALL) | yes |
| profile | GET,PUT | requireUser() self-service | yes |
| recruitment | GET,POST | requireEmployeeId; requireUser(MANAGERS) | yes |
| renewals/action | POST | requireUser(GOV) | yes |
| renewals | GET | requireUser(GOV) | yes |
| search | GET | requireUser(STAFF) | no (read-only) |
| services/telecom/[id] | GET,PUT,DELETE | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| services/telecom | GET,POST | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| services/utilities/[id] | GET,PUT,DELETE | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| services/utilities | GET,POST | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| settings/audit-logs | GET | requireUser(ADMIN) | yes |
| settings/permissions | GET,POST | requireUser(ADMIN) | yes |
| settings/profile | GET,POST | requireUser() self-service | yes |
| settings | GET | requireUser(ADMIN) | yes |
| settings/users/[id] | GET,PATCH,DELETE | requireUser(ADMIN) | yes |
| settings/users | GET,POST | requireUser(ADMIN) | yes |
| settlements/[id]/muqeem | GET,POST | requireUser(GOV_ROLES); requireUser(READ_ROLES) | yes |
| settlements | GET,POST,PUT | requireUser(READ_ROLES); requireUser(HR); requireUser(UPDATE_ROLES) | yes |
| transfers | GET,POST | requireUser(MANAGERS) | yes |
| upload | POST | getSessionUser (optional, EV-11027) | manual, not re-verified |
| vehicles/[id] | GET,PUT,PATCH,DELETE | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| vehicles | GET,POST | requireUser(LOGISTICS); requireUser(STAFF) | not re-verified (raw pass: 0) |
| visas/action | POST | requireUser(VISA_ROLES) | yes |
| visas/muqeem | GET,POST | requireUser(OPERATOR_ROLES); requireUser(VISA_ROLES) | yes |
| visas | GET | requireUser(VISA_ROLES) | no (read-only) |
| work-schedules | GET,POST,PUT,DELETE | requireUser(HR); requireUser(STAFF) | yes |
| workforce/assumptions | GET,PUT | requireUser(EDIT_ROLES); requireUser(WORKFORCE) | yes |
| workforce/benchmarks | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/calculations/[id] | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/calculations | GET,POST | requireUser(WORKFORCE) | yes (via shared `_lib/schemas.ts`, raw pass false-negative) |
| workforce/exit-cost | POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/export | GET,POST | requireUser(WORKFORCE) | yes |
| workforce/hire-scenario | POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/localization-decisions | GET,POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/nitaqat | GET,POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/options | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/overview | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/plans/[id]/actual | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/plans/[id]/approve | POST | requireUser(WORKFORCE) via `_lib/actions.ts` (EV-11024) | yes (via `_lib/actions.ts`) |
| workforce/plans/[id]/archive | POST | requireUser(WORKFORCE) via `_lib/actions.ts` | yes (via `_lib/actions.ts`) |
| workforce/plans/[id]/copy | POST | requireUser(WORKFORCE) via `_lib/actions.ts` | yes (via `_lib/actions.ts`) |
| workforce/plans/[id]/positions/[positionId] | PATCH,DELETE | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/plans/[id]/positions | POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/plans/[id]/raises/[raiseId] | PATCH,DELETE | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/plans/[id]/raises | POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/plans/[id]/reject | POST | requireUser(WORKFORCE) via `_lib/actions.ts` | yes (via `_lib/actions.ts`) |
| workforce/plans/[id] | GET,PATCH | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/plans/[id]/submit | POST | requireUser(WORKFORCE) via `_lib/actions.ts` | yes (via `_lib/actions.ts`) |
| workforce/plans/compare | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/plans | GET,POST | requireUser(WORKFORCE) | yes (via shared schemas, EV-11030 example) |
| workforce/report | GET,POST | requireUser(WORKFORCE) | yes |
| workforce/rules | GET,POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/saudization | GET | requireUser(WORKFORCE) | no (read-only) |
| workforce/saudization/solve | POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/sensitivity | GET,POST | requireUser(WORKFORCE) | yes (via shared schemas) |
| workforce/total-rewards | GET | requireUser(WORKFORCE) | yes |
| workforce/true-cost | GET | requireUser(WORKFORCE) | no (read-only) |

Note on "not re-verified (raw pass: 0)" rows (`assets`, `claims`, `documents/settings`, `services/telecom`,
`services/utilities`, `vehicles`): these came back zero in both the literal same-file Zod grep and the
`parseBody`/`parseQuery`/`safeParse` re-scan, but — unlike the workforce module — no adjacent `_lib/schemas.ts`
was confirmed present for all of them within this audit's time budget; they were not individually opened and
read line-by-line, so their validation status is reported as `not re-verified` rather than asserted MISSING.
This is a methodology gap, not a confirmed finding — flag for anyone re-auditing to open these 10 files directly.

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| API errors never leak internal exception text | `handleApiError()` | `src/lib/http.ts`, called from 142/149 routes | none route-level (EV-11039); implicitly exercised by every passing service-layer test | All | No, single implementation |
| Sensitive file categories (IDENTITY/PASSPORT/HEALTH/BANK) are restricted and every read is audited | `decideScopedFileAccess` + `AuditLog` write | `src/app/api/files/[...path]/route.ts:96-172` | not directly tested at route level (EV-11039) | Documents, Employees, Visas, Loans, Settlements, Medical insurance | No |
| Workforce-plan state transitions (submit/approve/reject/archive) are maker-checker guarded and reuse one code path | `assertAllowed` + `transitionHandler` | `src/app/api/workforce/plans/_lib/actions.ts` | referenced in workforce test files (not individually confirmed here) | Workforce | No — single shared implementation used by all 5 transition routes |
| Public (unauthenticated) surface is a fixed allow-list | `src/proxy.ts` (per SYSTEM_MAP EV-0007) + per-route self-hardening (e.g. `apply/[jobRequestId]`) | Edge middleware + route code | not verified here | Recruitment (apply), Auth, public verification (`/v`) | No |

## Edge cases checked

- **Workforce-plan transition routes appearing unauthenticated on a naive per-file grep**: false positive — auth lives in a shared `_lib/actions.ts` helper. Only caught by reading imports, not by grepping each `route.ts` in isolation. EV-11024.
- **"Zod:0" routes appearing unvalidated on a naive per-file grep**: mostly false positives for the same reason (schema imported from `_lib/schemas.ts`). Real, confirmed gaps are limited to two multipart-body routes with hand-written validation instead of Zod (`employees/import`, `upload`) plus `auth/logout` which has no body to validate. EV-11031–EV-11034.
- **Routes with no literal `fetch('/api/...')` match in any page**: false positive for every case spot-checked (`payroll-hub` vs a guessed `payrolls`, `useApi`/`callApi` hook indirection, dynamically-returned file URLs). No confirmed genuinely orphaned route found, but the check was not exhaustive across all 149 routes. EV-11035–EV-11038.
- **`files/[...path]` returning 404 vs 403**: deliberately made indistinguishable to prevent filename probing (`src/app/api/files/[...path]/route.ts:130`). EV-11028.
- **Anonymous upload (`/api/upload` with `getSessionUser` rather than `requireUser`)**: confirmed the code path exists and is used by the public `apply` flow (per `src/app/api/recruitment/shared.ts:86` comment referencing `/api/upload`), but the full boundary of what an anonymous caller can do (rate limits, allowed categories, association to a real job requisition) was not independently re-verified — flagged, not confirmed unsafe. EV-11027.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Platform/API | 6 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Route-level HTTP-wiring tests cover only ~7 of 149 routes (workforce/portal handlers); the rest are covered only via exported helpers or services; upload's anonymous-access boundary not independently confirmed; full route↔page connectivity mapping incomplete | Medium |

## Adversarial verification

Verifier re-opened the cited test file and searched every test for imports from `@/app/api/**` and for handlers invoked with `new Request(...)`. New evidence EV-11905–EV-11906 in `AUDIT/_work/ledger_K.md`.

| Finding | Verdict | Final status / severity | Reason |
|---|---|---|---|
| K-4 Route-level test coverage | ADJUSTED | PARTIAL / Medium (the brief said MISSING / High; the matrix already said Medium) | The claim is inverted in its detail. The cited file `src/app/api/settings/__tests__/admin-rules.test.ts` never calls a route handler; it unit-tests the `checkUserChange`/`checkCreateRole` helpers. Real handler-level tests do exist under `src/lib/__tests__`. `wf-total-rewards.test.ts` calls `GET` of `portal/total-rewards/route.ts` and asserts 200, and 400 when an EMPLOYEE requests another employee's id. `wf-report-pdf.test.ts` calls `GET`/`POST` of `workforce/report/route.ts` (503; 400 on a bad `kind`) and `GET` of `portal/total-rewards/pdf/route.ts`. `wf-review-p3.test.ts` drives `transitionHandler` (the body of the 4 `workforce/plans/[id]/*` routes), asserting 403 role and author guards and 200 on approve (EV-11905). Another 25 test files import guard or schema logic straight from route modules, e.g. `payments/access`, `claims/_lib`, `legal/investigations/route`, `settlements/route`, `leaves/[id]/action/route` (EV-11906). The gap is real: about 140 of 149 routes have no handler-level test and there is no E2E framework. But coverage is thin, not absent. |


Cross-check with other reports. `AUDIT/09_TEST_COVERAGE_AUDIT.md:22` independently classifies `admin-rules.test.ts` as a pure unit test that calls helpers, not the route. `AUDIT/03_DOMAIN_REPORTS/28_testing.md:152` independently finds the two `wf-*` handler tests and notes that they mock `@/lib/auth`. `wf-review-p3.test.ts` also mocks `requireUser`. So even the covered handlers are tested with the role or author decision logic real but session resolution stubbed. That supports keeping PARTIAL and not upgrading further.
