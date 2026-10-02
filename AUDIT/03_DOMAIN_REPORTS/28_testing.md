# 28 Testing

## Scope and method

Read `package.json` (test script, deps), `vitest.config.*`, all 116 files under `src/lib/__tests__/`,
`src/app/api/settings/__tests__/`, `services/render/test/`, `services/face/tests/`. Grepped every test
file for `describe(`/`it(`/`vi.mock(`/`skipIf`/route imports to classify each as pure-helper, mocked-route,
or real-DB/service integration test. Ran `npx vitest run` on three representative unit-test files to confirm
they pass on this machine (EV-10005). Did not run the full suite myself (task states 86/3, 1584/90 already ran);
did not touch any database. Cross-checked `.github/workflows/ci.yml` for what CI actually executes.

## Capability findings

### Unit tests of pure domain calculators
Capability: payroll/GOSI/EOSB/leave/attendance/settlement math as pure, DB-free functions.
Status: COMPLETE
Evidence: EV-10001, EV-10002, EV-10003, EV-10004, EV-10005
Files: `src/lib/__tests__/payroll.test.ts`, `x-X-PAYROLL-gosi.test.ts`, `x-X-PAYROLL-breakdown.test.ts`, `settlement.test.ts`, `leave.test.ts`, `x-X-LEAVE-statutory.test.ts`, `attendance.test.ts`
Functions/classes: `computePayrollLine`, `calculateGosi`, `endOfServiceAward`, `computeLeaveBalance`, `computeLateEarly`
DB tables: none (fixtures only)
API routes: none
UI routes: none
Tests: see rule table below
Observed behavior: `vitest.config.ts` runs `environment: 'node'`, `TZ: UTC`, no DB; every file above runs with real assertions against hand-built fixtures, no mocking framework needed since the functions are pure. `npx vitest run payroll.test.ts x-security-maker-checker.test.ts x-security-file-scope.test.ts` passed 69/69 (EV-10005).
Missing pieces: none for the calculators themselves; the gap is that these tests never touch the API layer that calls them (see next finding).
Risk: Low for the calculators in isolation; risk moves to the integration boundary.
Confidence: High

### Route-handler tests (API layer)
Capability: HTTP-level behavior of `route.ts` handlers (status codes, request parsing, response shape).
Status: PARTIAL
Evidence: EV-10006, EV-10007, EV-10008, EV-10009
Files: `src/lib/__tests__/wf-total-rewards.test.ts` (imports `GET` from `@/app/api/portal/total-rewards/route`), `wf-report-pdf.test.ts` (imports from `@/app/api/workforce/report/route` and `@/app/api/portal/total-rewards/pdf/route`)
Functions/classes: `GET` handlers invoked directly with a `new Request(...)`
DB tables: none (Prisma/service layer mocked with `vi.mock`)
API routes: `/api/portal/total-rewards`, `/api/workforce/report`, `/api/portal/total-rewards/pdf`
UI routes: n/a
Tests: `wf-total-rewards.test.ts` lines 167-203 (`GET /api/portal/total-rewards`)
Observed behavior: [Verification note J-3: actually 3 route.ts files are invoked as handlers (`portal/total-rewards`, `workforce/report` GET+POST, `portal/total-rewards/pdf`), plus `transitionHandler` which is the whole body of 4 workforce-plan routes; auth is mocked in all of them, EV-10902.] Only 2 of 153 `route.ts` files (EV-10010: `find src/app/api -name route.ts | wc -l` = 153, system map EV-0002) are exercised as actual HTTP handlers in tests, and in both cases `@/lib/auth` is fully mocked (`wf-total-rewards.test.ts:149` `vi.mock('@/lib/auth', ...)`), so the real `requireUser`/`getSessionUser` code never runs in these tests — the mock supplies a fixed session user. The rest of the 153 routes are tested, if at all, only through the pure `_lib`/`shared`/`logic` helper modules they import (see next finding), never through the exported `GET`/`POST`/`PUT`/`DELETE` functions themselves.
Missing pieces: No test invokes a route handler with a *real* (non-mocked) `requireUser`/session to verify that an unauthorized role actually gets 403/401 from the route itself; no test verifies request-body validation (zod) failure paths at the route boundary for the large majority of routes.
Risk: High — authorization bugs introduced inside a specific route.ts (wrong role list, forgotten `requireUser` call, wrong scoping) would not be caught by any existing test, because the 25 files that touch `@/app/api/...` imports (EV-10008) import helper/`_lib` functions, not the route's exported HTTP methods, and the 2 that do import real handlers stub out auth.
Confidence: High

### Helper-module tests reached through `@/app/api/**/_lib` imports
Capability: business-rule logic that lives inside the `app/api` tree but is exported as a plain function (not the route handler) for testing.
Status: PARTIAL
Evidence: EV-10008, EV-10011
Files: `c2-discipline.test.ts` (`@/app/api/legal/investigations/route`, `@/app/api/payroll-hub/route` — imports named exports, not `GET`/`POST`), `c2-logistics-access.test.ts` (`@/app/api/vehicles/_lib`, `@/app/api/claims/_lib`, `@/app/api/assets/_lib`, `@/app/api/services/_lib`), `c2-talent.test.ts`, `c2-termination.test.ts` (`@/app/api/settlements/route`, `@/app/api/employees/[id]/route`, `@/app/api/leaves/[id]/action/route`), `mq-*.test.ts` (Muqeem `_logic`/`logic` modules), `r3-admin-files.test.ts`, `r3-finance-payment-delete.test.ts`, `r3-hubs-onboarding.test.ts`, `wf-api-shared.test.ts`, `wf-api-views.test.ts`, `wf-data-company.test.ts`, `wf-data-employee-fields.test.ts`, `wf-export.test.ts`, `wf-fix-exit-fields.test.ts`, `wf-reasons.test.ts`, `x-X-UX-helpers.test.ts`
Observed behavior: These 21 files (of 25 that reference `@/app/api`) import named business-logic exports co-located with a route file (validation schemas, decision functions, formatters) and unit-test them directly, bypassing Next.js request/response plumbing, session handling and Prisma entirely. This is legitimate and valuable unit testing of business logic, but it means the route file's own glue code (auth call order, error mapping to HTTP status, query-param parsing) is untested for those routes.
Missing pieces: no coverage of the route's own request/response wiring for these 21 files' routes.
Risk: Medium — logic bugs are caught, wiring bugs (e.g., the route forgetting to call the tested validator, or catching the wrong error type) are not.
Confidence: High

### Database-integration tests
Capability: tests that exercise real Prisma queries against a real Postgres database.
Status: DISCONNECTED (real Postgres + render-service tests exist but are opt-in and not wired into CI; corrected from MOCKED by adversarial verification, J-6)
Evidence: EV-10012, EV-10013
Files: `src/lib/__tests__/documents-pipeline.test.ts:1-20` (`describe.skipIf(!RUN)`, `RUN = process.env.DOCUMENTS_IT === '1'`, needs `DATABASE_URL` + `RENDER_SERVICE_URL`), `documents-render.test.ts:74` (`describe.skipIf(!config)`), `muqeem-mock-contract.test.ts:35` (`describe.skipIf(!up)`, needs the Muqeem mock server running)
Observed behavior: These are the "3 skipped files" the harness's pre-run noted. `npm test` (`vitest run`, no env vars) never touches Postgres, the render service, or the Muqeem mock — every `prisma.*` call in the rest of the suite is against a `vi.mock('@/lib/prisma', ...)` stub (7 files mock Prisma directly per EV-10014; most others test pure functions that take plain objects, never importing `@/lib/prisma` at all).
Missing pieces: In CI, only the separate `migrations` job (a different GitHub Actions job, not `npm test`) touches a real Postgres, and only for schema-drift/seed-idempotency/job-dry-run checks (see Infrastructure report) — not for `DOCUMENTS_IT=1` pipeline tests or the Muqeem contract test, neither of which appears to run in CI at all (grep of `ci.yml` for `DOCUMENTS_IT` and `MUQEEM_MOCK` finds nothing, EV-10015). So the one true DB-integration test suite in the repo (`documents-pipeline.test.ts`, ADR-001 DOC-02/04/05/06/07/08/09/10 criteria) is never run automatically by CI or by plain `npm test`; it only runs if a developer manually sets `DOCUMENTS_IT=1` with a throwaway database.
Risk: High for the document-engine pipeline specifically (the most complex, most recently touched subsystem per git status) — its only end-to-end test is opt-in and not wired into CI.
Confidence: High

### Authorization core (`requireUser`, `ROLE_GROUPS`) unit tests
Capability: the single function that enforces role-based authorization for essentially every protected API route.
Status: PARTIAL (corrected from MISSING by adversarial verification, J-2: `documents-leaver-access.test.ts` runs the REAL `requireUser`/`getSessionUser` for the no-session path, EV-10900; the 403 role branch and `ROLE_GROUPS` remain untested, EV-10901)
Evidence: EV-10016 (negative search)
Files: `src/lib/auth.ts:107-111` defines `requireUser(roles)`; searched every test file for `from '@/lib/auth'` not inside a `vi.mock` block — only `c2-portal.test.ts` and `muqeem-transactions.test.ts` import from `@/lib/auth`, and both import only the `AuthUser` *type*, never call `requireUser`, `getSessionUser`, or `hasRole`. `grep -rln "requireUser" src/lib/__tests__/*.test.ts` finds 4 files (`documents-leaver-access.test.ts`, `wf-report-pdf.test.ts`, `wf-review-p3.test.ts`, `wf-total-rewards.test.ts`) and in every one it appears only inside a `vi.mock('@/lib/auth', ...)` block that replaces it with a stub — none calls the real implementation.
Missing pieces: no test verifies `requireUser(ROLE_GROUPS.X)` actually throws 403 for a role outside the list, or 401 for no session, using the real function; no test verifies `ROLE_GROUPS` membership tables in `src/lib/constants.ts` against the intended role matrix.
Risk: High — this is the single choke point for authorization across 153 API routes; it has zero direct unit-test coverage, only indirect coverage through the 2 route tests that mock it away.
Confidence: High

### Edge authentication middleware (`src/proxy.ts`)
Capability: rejects unauthenticated requests to non-public pages/APIs at the edge before they reach a route handler.
Status: MISSING
Evidence: EV-10017 (negative search: `grep -rln "proxy" src/lib/__tests__/*.test.ts` → no matches; `find . -iname "*proxy*test*" -not -path "*/node_modules/*"` → no matches; `src/proxy.ts` is 61 lines with no co-located test)
Files: `src/proxy.ts` (61 lines)
Missing pieces: no unit or integration test for the public-path allow-list, cookie parsing, JWT verification call, or the credential-version/session-version revocation check at this layer.
Risk: Medium-High — a change to the public-path allow-list (e.g. accidentally widening it) would not be caught by any test.
Confidence: High

### Maker-checker rule tests
Capability: self-approval prevention for payment/decision workflows.
Status: PARTIAL
Evidence: EV-10018, EV-10019
Files: `src/lib/__tests__/x-security-maker-checker.test.ts` (6 tests, pure function `decideMakerChecker`), used by `src/app/api/payments/access.ts` and `src/app/api/payments/maker-checker.ts` (EV-10019: only 2 call sites in the whole app tree, both under `payments`)
Tests: `decideMakerChecker` — self-approval refused (line 7), different user allowed (16), legacy rows without requester flagged unknown (20), SUPER_ADMIN audited override (25), `allow_self_approval` company setting (32)
Observed behavior: the decision function itself is well unit-tested (5 scenarios incl. the regression case). It is wired into exactly 2 files under `src/app/api/payments/`; neither `access.ts` nor `maker-checker.ts` is itself under test (not in the `@/app/api` import list, EV-10008), so the *route-level* wiring of the maker-checker rule (is it actually called before the payment is marked approved, in the right order relative to other checks) is unverified.
Missing pieces: no test confirms maker-checker is applied to any workflow-engine approval outside `payments/` (e.g., leave approvals, settlement approvals) — a repo-wide grep found only the 2 payments files importing `decideMakerChecker`, so if maker-checker is meant to be a general control it is not applied elsewhere, or is enforced by different, untested code.
Risk: Medium.
Confidence: Medium

### File-scope access control tests
Capability: `decideScopedFileAccess` — who may read an uploaded/sensitive file.
Status: COMPLETE (as a pure function)
Evidence: EV-10020
Files: `src/lib/__tests__/x-security-file-scope.test.ts` — 33 tests covering full-access roles, legacy unregistered files, sensitive categories (self vs. others), managers (team vs. unowned), other back-office roles, plain employees, null-id non-matching, unknown-role fallback, category inference
Observed behavior: Ran directly (`npx vitest run x-security-file-scope.test.ts`) — 33/33 pass (EV-10005). This is the most thoroughly unit-tested authorization primitive in the codebase.
Missing pieces: not verified whether `src/app/api/files/[...path]/route.ts` actually calls `decideScopedFileAccess` on every code path (route itself not under test, consistent with the general route-test gap above).
Risk: Low for the decision logic; Medium for whether it is actually invoked everywhere it should be (unverified — route not tested).
Confidence: Medium

### Attendance lateness tests
Capability: `computeLateEarly`, shift/overnight handling.
Status: COMPLETE
Evidence: EV-10021
Files: `src/lib/__tests__/attendance.test.ts` lines 62-141: on-time+overtime, weekend/overnight shifts, two-shift days, flexible schedules, exempt employees, check-in-only.
Tests: `computeLateEarly` (8 scenarios)
Missing pieces: no test of the route that persists computed lateness against real attendance records (route/DB layer untested, same general gap).
Risk: Low for the calculator, Medium for the persistence path.
Confidence: High

### Payroll net / GOSI / EOSB / leave balance — rule-to-test map
See table below (Business rules).

### Sidecar service tests (render, face)
Capability: `services/render` (Typst PDF renderer) and `services/face` (Python liveness/embedding) each have their own test suites, run as separate CI jobs, not part of `npm test`.
Status: COMPLETE (for what they cover), DISCONNECTED from the main app's `npm test`
Evidence: EV-10022, EV-10023
Files: `services/render/test/{fonts,server,validate}.test.mjs` + `helpers.mjs` + 3 golden fixture sets (F2-ar-en, F5-arabnum, F7-inject); `services/face/tests/test_service.py`
Observed behavior: `services/render` tests run under Node's own runner (matrix Node 20/24) as the `render-service` CI job (`.github/workflows/ci.yml`, "Document renderer" job) — separate from the `build` job that runs `npm test`. `services/face/tests/test_service.py` is a pytest file; `ci.yml` has no job that installs Python deps or runs `pytest` (grep for "pytest\|face" in ci.yml finds only the `ai-processors` job checking `requirements.txt` against the approved list, EV-10024) — the face-service Python test suite does not appear to run in CI at all.
Missing pieces: face-service tests are not wired into CI (best-effort local-only evidence; could not run pytest without violating the read-only/no-install rule).
Risk: Medium — the face-liveness service handles biometric self-attendance clock-in (per MEMORY.md, recently changed); its only test suite is not confirmed to run in CI.
Confidence: Medium (CI grep is conclusive; whether it runs manually elsewhere is unknown)

### E2E / browser tests
Capability: full end-to-end UI test coverage (login → action → assertion in a real browser).
Status: MISSING
Evidence: EV-10025 (negative search: `grep -i "playwright\|cypress\|e2e" package.json` → no matches; `find . -iname "playwright.config*" -o -iname "cypress.config*"` outside node_modules → no matches)
Risk: Medium-High for a multi-role, RTL, workflow-heavy product — no browser-level regression coverage exists at all; every UI page (109 `page.tsx` files) is unverified by automated test.
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Payroll net never negative | `src/lib/payroll.ts` | `computePayrollLine` | `payroll.test.ts:322` "never returns a negative net salary" | Payroll | No |
| GOSI 9.75%/11.75% (OLD) and NEW-regime by month, employer/employee split, 45,000 cap | `src/lib/payroll-gosi.ts` (per test import) | `calculateGosi` | `x-X-PAYROLL-gosi.test.ts:71-177` (10 tests incl. July-boundary, clamp, manual override) | Payroll, Saudi compliance | No (single calculator, reused by `x-X-PAYROLL-breakdown.test.ts`) |
| EOSB (arts. 84/85): half-month/year up to 5y, full month/year after; resignation tiers; art. 80/probation pay nothing | `src/lib/settlement.ts` | `endOfServiceAward`, `computeSettlement` | `settlement.test.ts:15-52,152-289` | Offboarding, Payroll | No |
| Annual leave accrual 21→30 days at 5y, never negative balance | `src/lib/leave.ts` | `computeLeaveBalance` | `leave.test.ts:37-158` | Leave | No |
| Sick leave tiers (art. 117): full/75%/unpaid/>120 days | `src/lib/leave.ts` | `computeSickLeaveTiers` | `leave.test.ts:160-168` | Leave, Payroll | No |
| Attendance lateness/early-leave incl. overnight & two-shift | `src/lib/attendance.ts` | `computeLateEarly` | `attendance.test.ts:62-141` | Attendance | No |
| Overtime multipliers (weekday 1.5x, weekend), hourly basis company setting | `src/lib/payroll.ts` | overtime rate functions | `payroll.test.ts:76-164` | Payroll, Attendance | No |
| Self-approval refused in maker-checker | `src/lib/*` (maker-checker decision) | `decideMakerChecker` | `x-security-maker-checker.test.ts:7` | Payments only (2 call sites, EV-10019) | Not duplicated but narrowly applied |
| File access scoping by role/category/ownership | `src/lib/*` file-scope module | `decideScopedFileAccess` | `x-security-file-scope.test.ts` (33 tests) | Documents, Files, Portal | No |
| Role-based route authorization | `src/lib/auth.ts:107` | `requireUser` | **None** (EV-10016) | All 153 API routes | N/A — single implementation, zero direct tests |
| Edge authentication / public-path allow-list | `src/proxy.ts` | proxy middleware | **None** (EV-10017) | All pages/APIs | N/A |

## Edge cases checked

- **Real-DB pipeline test not in CI**: `documents-pipeline.test.ts` is the only true end-to-end (DB+render-service) test and requires manual opt-in (`DOCUMENTS_IT=1`); confirmed absent from `ci.yml` (EV-10015). Finding: DISCONNECTED from continuous verification.
- **Auth mocked in the only 2 route-level tests**: both `wf-total-rewards.test.ts` and `wf-report-pdf.test.ts` `vi.mock('@/lib/auth', ...)`, so "tests hit a route handler" does not mean "tests hit real authorization" (EV-10007, EV-10009).
- **Face service Python tests not in CI**: confirmed by absence of a pytest step in `ci.yml` (EV-10024).
- **Timezone**: `vitest.config.ts` pins `TZ=UTC` explicitly to catch accidental local-time bugs (EV-10026) — a good practice, noted as a strength not a gap.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 Testing | 11 | 3 | 4 | 0 | 0 | 2 | 0 | 0 | 2 | 0 | 0 | (verified) proxy.ts has zero tests and requireUser's 403 branch is untested (its 401 path is tested); no test hits a real route with real auth; route-handler HTTP layer almost entirely untested; DB-integration test not in CI; no E2E | High |

## Adversarial verification

Verifier re-opened every cited file and searched for missed coverage. Evidence EV-10900..EV-10913 is in `AUDIT/_work/ledger_J.md`.

| ID | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| J-2 | ADJUSTED | PARTIAL / Medium | The claim that every test mocks `requireUser` is wrong. `documents-leaver-access.test.ts:9-15` mocks only `next/headers`, `@/lib/session` and `@/lib/prisma`. It imports the real `@/lib/auth` and asserts that the real `requireUser()` rejects when there is no valid session (line 38), and it exercises the real `getSessionUser` (EV-10900). What remains untested is the 403 role branch (`auth.ts:109`, `roles.includes`), the `ROLE_GROUPS` membership tables, and the sessionVersion, isActive and credential-mismatch branches (EV-10901). The function is 4 lines long, so the real risk sits in the role lists each route passes, which is J-3. Severity lowered from Critical to Medium. |
| J-3 | ADJUSTED | PARTIAL / High (unchanged) | The count is wrong: tests invoke 3 route.ts handlers, not 2 (`workforce/report` GET and POST, `portal/total-rewards/pdf`, `portal/total-rewards`). `wf-review-p3.test.ts` also drives `transitionHandler`, which is the entire body of 4 workforce-plan routes (approve, reject, submit, archive) (EV-10902). The core claim holds: every one of these tests mocks `@/lib/auth`, and none shows a real session with the wrong role getting 401 or 403 from a route. |
| J-6 | CONFIRMED | DISCONNECTED / High | `documents-pipeline.test.ts:12,17` is gated by `DOCUMENTS_IT === '1'`, and neither `DOCUMENTS_IT` nor `RENDER_SERVICE_URL` appears in `ci.yml`. The CI `render-service` job tests the renderer on its own, and the `migrations` job uses Postgres only for drift, seed and job dry runs. So nothing in CI runs app, DB and renderer together. The capability status was corrected from MOCKED to DISCONNECTED, because these tests are real, not mocked, and are simply not wired into CI. |
| J-7 | ADJUSTED | MISSING / Medium | No test anywhere imports `src/proxy.ts`. It is a defense-in-depth layer, not the only gate. 135 of 153 routes call `requireUser`. The rest are intentionally public or delegate to `transitionHandler`, which calls `requireUser`. Legacy `/uploads/*` is rewritten to `/api/files/[...path]`, which calls `requireUser()` (EV-10911). A proxy regression would expose page shells, not data. Severity lowered from High to Medium. |
| J-8 | CONFIRMED | MISSING / High | `@playwright/test` appears in `package-lock.json` only as Next's optional peer. `PRODUCTION_READINESS_PLAN.md:217` lists one Playwright E2E flow as an unchecked to-do, and `docs/council/DECISIONS.md:827` only plans Playwright keyboard checks (EV-10912). There is no config and no spec file. |
| J-11 | CONFIRMED | DISCONNECTED / Medium | CI's only face-related step checks `requirements.txt` against `docs/processors.md`. The face Dockerfile has no test step, and the `docker` job does not even build the face image. The README documents running pytest by hand only (EV-10913). |

Status changes applied: Authorization core MISSING -> PARTIAL; Database-integration MOCKED -> DISCONNECTED. Scorecard recounted (11 capabilities, as in `matrix_J.md`; the previous row said 10 and omitted one MISSING).
