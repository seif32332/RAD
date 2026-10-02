# 09 Test coverage audit

Written by group J (28 Testing, 29 Infrastructure). Evidence IDs EV-10001..EV-10126, ledger at
`AUDIT/_work/ledger_J.md`. Method: read all 116 test files listed by the harness
(`src/lib/__tests__`, `src/app/api/settings/__tests__`, `services/render/test`, `services/face/tests`),
classified each by what it actually exercises (pure helper vs. mocked route vs. real DB/service), and
ran 3 representative files with `npx vitest run` to confirm the claimed 86/3 passed/skipped split is real.

## Test inventory by domain

| Domain | Test files (representative) | Type |
|---|---|---|
| Payroll / GOSI | `payroll.test.ts`, `x-X-PAYROLL-gosi.test.ts`, `x-X-PAYROLL-breakdown.test.ts`, `r3-payroll-overtime.test.ts`, `r3-payroll-loans.test.ts` | Pure unit |
| Leave | `leave.test.ts`, `x-X-LEAVE-statutory.test.ts`, `r3-R3-LEAVE-balance.test.ts` | Pure unit |
| Settlement / EOSB | `settlement.test.ts`, `termination-last-day.test.ts` | Pure unit |
| Attendance | `attendance.test.ts`, `self-attendance.test.ts`, `self-attendance-jobs.test.ts`, `geo.test.ts` | Pure unit (jobs test partially mocks side effects) |
| Documents engine | `documents-core.test.ts`, `documents-rules.test.ts`, `documents-pipeline.test.ts` (real-DB, opt-in), `documents-render.test.ts` (opt-in), `documents-chain-parity.test.ts`, `documents-seal.test.ts`, `documents-addendum.test.ts`, `documents-circular.test.ts`, `documents-commencement.test.ts`, `documents-transfer.test.ts`, `documents-leaver-access.test.ts`, `documents-phase2.test.ts` | Mostly pure unit; one real-DB+render-service suite, opt-in |
| Muqeem integration | `muqeem-client.test.ts`, `muqeem-helpers.test.ts`, `muqeem-mock-contract.test.ts` (opt-in, needs mock server), `muqeem-transactions.test.ts`, `mq-*.test.ts` (5 files) | Pure unit + one opt-in contract test |
| Workforce planning | `wf-*.test.ts` (23 files: hiring, planning, saudization, nitaqat, true-cost, total-rewards, exit-cost, sensitivity, privacy, benchmarks, report-pdf, etc.) | Pure unit; 2 files exercise real route `GET` handlers with auth mocked |
| Security primitives | `x-security-crypto.test.ts`, `x-security-file-scope.test.ts`, `x-security-maker-checker.test.ts` | Pure unit |
| Cross-domain (X council) | `x-X-EMPLOYEES-*.test.ts` (3), `x-X-UX-helpers.test.ts`, `x-ops-jobs.test.ts`, `x-ops-panel.test.ts` | Pure unit |
| Settings/admin API | `src/app/api/settings/__tests__/admin-rules.test.ts` | Pure unit (imports `checkCreateRole`/`checkUserChange` helpers, not the route) |
| Document renderer sidecar | `services/render/test/{fonts,server,validate}.test.mjs` + golden fixtures | Real service, own CI job, separate from `npm test` |
| Face-liveness sidecar | `services/face/tests/test_service.py` | Python pytest; no CI job runs it (EV-10024) |
| Core HR / org / c2-* | `c2-alerts.test.ts`, `c2-discipline.test.ts`, `c2-logistics-access.test.ts`, `c2-master-data.test.ts`, `c2-portal.test.ts`, `c2-reporting.test.ts`, `c2-talent.test.ts`, `c2-termination.test.ts`, `employee.test.ts`, `position-tracker.test.ts` | Pure unit / helper-module tests |
| Misc utilities | `dates.test.ts`, `money.test.ts`, `validation.test.ts`, `image-dimensions.test.ts`, `alerts.test.ts` | Pure unit |

Total: 116 test files found by the harness's glob (89 under `src/lib/__tests__` + `src/app/api/settings/__tests__` were the "89 test files" figure quoted in the brief at spawn time; the fuller count including `services/render/test` and `services/face/tests` fixtures/helpers is 116 files, of which a subset are non-test fixture/helper `.mjs` files).

## Critical-rule coverage table

| Rule | Test file:name | What it asserts | Gap |
|---|---|---|---|
| Payroll net never negative | `payroll.test.ts:322` "never returns a negative net salary" | Clamps net to 0 when deductions exceed pay | Not verified at the route/DB layer that persists payroll runs |
| GOSI OLD/NEW regime, employer/employee split, 45,000 cap, July-2024/2026 boundaries | `x-X-PAYROLL-gosi.test.ts:71-177` (10 cases) | Rate selection by effective date, wage clamp, manual override, non-Saudi employer-only | Route that persists/reports GOSI breakdown not directly tested |
| EOSB (arts 84/85): half/full month per year, resignation tiers, art. 80/probation nil | `settlement.test.ts:15-52` | Award formula across tenure bands and termination reasons | `computeSettlement` route wiring (approval workflow) not directly tested |
| Leave balance accrual 21→30 days, never negative | `leave.test.ts:37-158` | Accrual, proration, 5-year switch, balance floor at 0 | Leave-request approval route not directly tested |
| Overtime multipliers (1.5x weekday, weekend rate, hourly basis setting) | `payroll.test.ts:76-164` | BASIC vs TOTAL_PLUS_HALF_BASIC bases, company resolution order | No route test for overtime approval → payroll line |
| Attendance lateness/early-leave | `attendance.test.ts:62-141` | 8 scenarios incl. overnight, two-shift, flexible schedule | Persistence route (`/api/attendance/...`) not directly tested |
| Authorization of portal (role-based route access) | **none** (see 28 Testing report, EV-10016) | — | `requireUser`/`ROLE_GROUPS` have zero direct unit tests; the 2 route tests that exist mock `@/lib/auth` away entirely |
| File scope (who can read which uploaded file) | `x-security-file-scope.test.ts` (33 cases) | Role/category/ownership matrix | Not verified that `/api/files/[...path]/route.ts` actually calls the tested decision function on every path (route untested) |
| Maker-checker (no self-approval) | `x-security-maker-checker.test.ts` (6 cases) | Self-approval refused, SUPER_ADMIN override, company opt-in setting | Applied only in `src/app/api/payments/{access,maker-checker}.ts` (EV-10019); those 2 files are not under test themselves, and no other approval workflow (leave, settlement) appears to use this same decision function |

## Test types present / absent

| Type | Present? | Evidence |
|---|---|---|
| Unit (pure functions) | Yes, extensive (majority of the 116 files) | EV-10001-10004, 10018, 10020, 10021 |
| Integration — route handler with real auth | No (both existing route tests mock `@/lib/auth`) | EV-10007, EV-10009 |
| Integration — real database | Opt-in only, not in CI (`DOCUMENTS_IT=1`) | EV-10012, EV-10013, EV-10015 |
| Contract test (Muqeem mock) | Opt-in only | EV-10013 |
| API/HTTP-level (status codes, request parsing) for the majority of 153 routes | No | EV-10008, EV-10010 |
| Workflow / cross-service | Partial (workforce report-pdf test invokes 2 route handlers together) | EV-10009 |
| Payroll / compliance calculators | Yes, strong | EV-10001-10004 |
| Security (authz decision functions) | Yes for file-scope and maker-checker decision functions; No for `requireUser` itself or `src/proxy.ts` | EV-10016, EV-10017, EV-10018, EV-10020 |
| Regression | Yes — several tests explicitly named as regressions (e.g. `x-security-maker-checker.test.ts:7` "regression: self-approval path"; `mq-review-fixes.test.ts`) | EV-10018 |
| E2E / browser | No framework present | EV-10025 |
| Sidecar service tests (render) | Yes, own CI job | EV-10022 |
| Sidecar service tests (face) | Test file exists but not run by CI | EV-10023, EV-10024 |

## CI reality

- `.github/workflows/ci.yml` triggers push-CI only on `branches: [main]` (line 5-8); the repository's actual and only branch, locally and on `origin`, is `master` (EV-10105, EV-10106). Recent commits on `master` are direct commits, not PR merges (EV-10104). **Conclusion: CI's `build` (typecheck/lint/vitest/build), `migrations` (drift+seed idempotency), `render-service`, `ai-processors`, and `secret-scan` jobs do not run on ordinary pushes to `master`** — only on a pull request (against any base branch, since `pull_request:` has no branch filter) or a manual `workflow_dispatch`.
- When CI does run (PR/manual), `npm test` = `vitest run` executes the full 89-file `src/lib/__tests__` + `src/app/api/settings/__tests__` suite, which per the harness's pre-run is 86 files/1,584 tests passing and 3 files/90 tests skipped (the `describe.skipIf` gated real-DB/service/mock-dependent suites, EV-10012/10013).
- The separate `migrations` CI job independently exercises a real Postgres 16 instance for schema-drift and seed-idempotency checks and dry-runs 3 of the 7 `scripts/jobs.mjs` jobs (EV-10107) — this is real DB coverage, but scoped to migrations/seed/job-dry-run, not to `npm test`'s unit suite and not to the `DOCUMENTS_IT=1` pipeline test.
- `render-service` CI job runs `services/render`'s own test suite (Node test runner, matrix Node 20/24) — separate job, separate test runner, not `vitest`.
- No CI job runs `services/face/tests/test_service.py` (EV-10024).
- Equating "1,584 tests passed" with full coverage would be wrong: the count is dominated by pure-function unit tests; the HTTP/authorization/route layer that fronts 153 API routes is almost entirely untested (2 of 153 routes have a direct handler-level test, both with auth mocked out), and the one real end-to-end DB+render-service suite (`documents-pipeline.test.ts`) does not run in CI at all.
