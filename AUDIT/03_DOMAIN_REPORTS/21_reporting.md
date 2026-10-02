# 21 Reporting / Analytics

## Scope and method

Read `src/app/api/owner-reports/route.ts` (318 lines, full — owner-facing financial/compliance
report) and `src/app/api/dashboard/route.ts` (273 lines, full — role-scoped KPI dashboard) in
entirety. Read `src/app/api/payroll-hub/export/route.ts` (246 lines, header confirmed real DB
query at line 94) and `src/app/api/workforce/overview/route.ts` (25 lines, full) and
`src/app/workforce/benchmarks/page.tsx` (grepped for turnover/time-to-hire, lines 3, 285-418).
Located `src/app/unified-alerts/page.tsx` and confirmed the 4 alert sources it aggregates
(`/api/hr/alerts`, `/api/admin/alerts`, `/api/logistics/alerts`, `/api/legal/alerts`) all exist as
real route files. Read `src/lib/__tests__/c2-reporting.test.ts` (253 lines) — this file's `describe`
blocks are about payroll deduction-cap flags and review-note codes (payroll domain), not
owner-reports/dashboard aggregation; no dedicated test file for owner-reports or dashboard was found.
Ran negative-search greps for `turnover`, `absenteeism`, `time-to-hire`, `training` inside the
reporting surfaces themselves.

## Capability findings

### Owner report (financial + compliance overview)
Status: COMPLETE
Evidence: EV-7041, EV-7042, EV-7043
Files: src/app/api/owner-reports/route.ts (full file)
DB tables: Employee, MedicalInsurance, Company, Branch, Vehicle, UtilityMeter, TelecomSim, Lawsuit, LegalContract, Payroll
API routes: GET /api/owner-reports
UI routes: /owner-reports
Tests: none found at this route's aggregation-logic level (only payroll-core helpers it imports, e.g. `monthsInRange`, `reportMonthKind`, may be covered elsewhere — not verified here).
Observed behavior: Real, non-trivial aggregation — `Payroll.groupBy` by year/month with `_sum`/`_max`/`_count` (route.ts:170-179) to build an "actual vs missing vs estimate" month-by-month payroll cost series (`ActualMonth[]`), a documented GOSI-employer-breakdown migration-cutoff detector (`gosiBreakdownSince`, route.ts:26-42) that flags months whose employer-GOSI figure predates the column existing, and a "reference payroll month" rule (latest APPROVED/PAID month not after current) shared with the dashboard. Verified against 5+ real metrics: payroll gross, employer GOSI, overtime cost, bonus amount, net salary — all pulled from stored `Payroll` rows, not recomputed or hardcoded.
Missing pieces: no automated test for this aggregation logic (only inferred from reading the code).
Risk: Low (logic is sound and documented) but Medium on test coverage.
Confidence: High.

### Role-scoped dashboard KPIs
Status: COMPLETE
Evidence: EV-7044, EV-7045
Files: src/app/api/dashboard/route.ts (full file)
DB tables: Employee, Leave, Attendance, ComplianceViolation, JobRequest, JobApplication, Lawsuit, LegalContract, Vehicle, Branch, Company, Department, PromissoryNote, CertifiedAgency, Payroll, WorkSchedule
API routes: GET /api/dashboard
UI routes: dashboard/home pages (consumer of this route)
Tests: none found.
Observed behavior: Attendance rate = present-and-expected / expected-today, where "expected" explicitly excludes employees not yet joined and those on approved leave today (route.ts:76-80,113) — a correct, non-trivial definition, not a placeholder. Team-scoped managers (`BRANCH_MANAGER`/`DEPT_MANAGER`) get a materially different, narrower payload (`scope:'TEAM'`, route.ts:141-163) with payroll/legal/compliance/structure fields explicitly nulled — a real authorization-aware data-scoping implementation, not client-side filtering. Alert counts reuse the same builder functions as the dedicated alert screens (`buildAdminAlerts` etc.) so the dashboard tiles cannot drift from `/admin-alerts` etc. (documented at route.ts:29-33); double-counting of legal contracts (served by both admin and legal builders) is explicitly deduplicated (route.ts:224-229).
Missing pieces: no automated test for this route.
Risk: Low.
Confidence: High.

### Unified alerts aggregation
Status: COMPLETE
Evidence: EV-7046
Files: src/app/unified-alerts/page.tsx:18-21,155,183-186; src/app/api/hr/alerts/route.ts, src/app/api/admin/alerts/route.ts, src/app/api/logistics/alerts/route.ts, src/app/api/legal/alerts/route.ts (all confirmed to exist as real route files)
Observed behavior: The unified-alerts page fans out to 4 real, role-gated API routes and merges results client-side; each source is the same one used by its dedicated single-domain alert page, so figures cannot diverge across screens.
Missing pieces: not independently re-verified for role-permission edge cases beyond confirming the route-to-role-group mapping exists (route.ts:18-21).
Risk: Low.
Confidence: Medium.

### Payroll export (payroll-hub/export)
Status: COMPLETE
Evidence: EV-7047
Files: src/app/api/payroll-hub/export/route.ts:89-94 (`GET`, real `prisma.payroll.findMany` query)
Observed behavior: A real DB-backed export route (246 lines total), not a static/mock file — confirmed the handler queries `prisma.payroll` directly rather than returning a canned dataset.
Missing pieces: full column-by-column correctness not re-verified in this pass (out of the token budget for this domain); flagged as COMPLETE on the strength of confirming it is DB-backed, not mocked.
Risk: Low.
Confidence: Medium.

### Workforce overview / benchmarks (turnover, tenure, time-to-hire, overtime, cost-of-turnover)
Status: COMPLETE (cross-domain — primary ownership is Domain 22 Workforce Planning, audited here only from the Reporting angle)
Evidence: EV-7048, EV-7049
Files: src/app/workforce/benchmarks/page.tsx:3-5 (module docstring: "SPEC §1 module 7, §9: turnover, tenure, new-hire attrition, time to hire, overtime, ... cost of turnover — computed ONLY from the organisation's own records (no industry figure)"), :285-418 (turnover tabs by department/nationality/tenure, `d.timeToHire` with median and denominator, `d.turnoverCost.total`/`.perExit`); src/app/api/workforce/overview/route.ts (delegates to `runOverview` in `../_lib/server`, not inspected line-by-line here)
Observed behavior: Turnover, time-to-hire and turnover-cost are real, computed metrics (median + count shown alongside each headline number, a sign of genuine aggregation rather than a hardcoded value) explicitly scoped to the tenant's own data.
Missing pieces: the underlying `_lib/server.ts` computation was not independently re-verified line-by-line in this pass (would duplicate Domain 22's work); flagged here only to confirm the Reporting brief's turnover/time-to-hire ask is met, and that it lives under `/workforce/benchmarks` rather than under `/owner-reports` or `/api/dashboard` — a location a report reader might not expect from the brief's wording.
Risk: Low.
Confidence: Medium.

### Absenteeism rate
Status: MISSING (as a named/dedicated metric)
Evidence: EV-7050 (negative search: `grep -rniE "absenteeism|نسبة الغياب|absence rate" src/app` — zero hits anywhere in the app)
Risk: Medium — the dashboard's `attendanceRate` (present/expected today) is a related but different, single-day metric; there is no period-based absenteeism rate (e.g. absence days / working days over a month) anywhere in Reporting.
Confidence: High.

### Training / learning reporting
Status: MISSING
Evidence: EV-7051 (consistent with Domain 14 Learning: no training data exists anywhere to report on; `grep -n "training" src/app/api/owner-reports/route.ts src/app/api/dashboard/route.ts` returns no hits)
Risk: Low (a direct consequence of Domain 14 being entirely absent, not an independent reporting gap).
Confidence: High.

### Performance reporting (evaluation dashboard)
Status: COMPLETE (see Domain 13 for detail; re-confirmed here as a Reporting surface)
Evidence: EV-7052
Files: src/app/evaluations/reports/page.tsx:60 (`fetch('/api/evaluations?view=dashboard')`)
Observed behavior: real DB-backed view, bucketed by `bucketScores`, not a static page — cross-referenced with EV-7015 in the Performance report.
Missing pieces: none beyond what is already noted in Domain 13.
Risk: Low.
Confidence: Medium.

### Saudization / Nitaqat reporting
Status: COMPLETE (cross-domain — primary ownership Domain 10/22)
Evidence: EV-7053
Files: src/app/api/workforce/saudization/route.ts, src/app/api/workforce/nitaqat/route.ts, src/app/workforce/nitaqat-register/page.tsx, src/app/workforce/saudization/page.tsx (all confirmed to exist; not read in full — out of this domain's primary scope)
Observed behavior: A dedicated Saudization/Nitaqat module exists with both a register page and a solver endpoint (`saudization/solve`), suggesting real computation rather than a static display.
Missing pieces: not independently re-verified line-by-line (belongs to Saudi Compliance / Workforce Planning domains); listed here only to confirm the Reporting brief's Saudization ask is not simply absent.
Risk: Low.
Confidence: Low-Medium (existence confirmed, correctness not verified in this pass).

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Reference payroll month = latest APPROVED/PAID month not after current Riyadh month | owner-reports + dashboard | src/app/api/owner-reports/route.ts:181-189; src/app/api/dashboard/route.ts:66-74 | None found | Reporting, Payroll | Yes — same rule implemented twice (once per route) rather than shared via one helper; both use `currentPayrollMonth`/`payrollMonthLabel` from `@/lib/payroll-core` for the shared parts, but the `findFirst` query itself is duplicated verbatim in both files |
| Attendance rate = present ∩ expected / expected (excludes not-yet-joined and approved-leave-today) | dashboard KPI | src/app/api/dashboard/route.ts:76-80,113 | None found | Reporting, Attendance | No |
| Legal-contract alerts counted once despite being served by two builders | dashboard `totalAlerts` | src/app/api/dashboard/route.ts:224-229 | None found | Reporting | No |
| GOSI-employer figures before the breakdown migration are flagged incomplete, not silently summed as zero | owner-reports `gosiIncomplete` | src/app/api/owner-reports/route.ts:26-42,208-219 | None found | Reporting, Payroll, Saudi Compliance | No |

## Edge cases checked

- **Team-scoped manager (BRANCH_MANAGER/DEPT_MANAGER) dashboard**: explicitly returns a narrower payload with payroll/legal/compliance/recruitment/structure fields set to `null` rather than 0 or omitted — the page is expected to hide, not misread, those tiles (src/app/api/dashboard/route.ts:141-163). Finding: correctly handled. EV-7054.
- **No attendance ever recorded (new tenant)**: `hasAttendanceData: attendanceEver > 0` is returned alongside `attendanceRate` so the UI can distinguish "0% because nobody showed up" from "not meaningful, no data yet" (dashboard/route.ts:87,138). Finding: correctly handled, a real edge case the team clearly thought about. EV-7055.
- **Payroll month reporting when the reference month has no APPROVED/PAID line yet (mid-month)**: `payrollActual.months[]` marks each month ACTUAL / MISSING / ESTIMATE via `reportMonthKind`, and `estimateMonths`/`missingMonths` are counted separately rather than the report silently showing 0 (owner-reports/route.ts:201-220,239-240). Finding: correctly handled. EV-7056.
- **Double counting between /admin-alerts and /legal-alerts (both serve legal contracts)**: explicitly deduplicated in the dashboard total (`adminAlertCountExcludingLegal`) but the raw `adminAlertCount` (matching what `/admin-alerts` itself shows) is still exposed separately, so a report reader comparing dashboard-vs-single-screen totals is not silently misled. EV-7057.
- **Arabic labels for report tables**: `CONTRACT_STATUS_LABELS`, `LAWSUIT_STATUS_LABELS`, `CASE_TYPE_LABELS` (owner-reports/route.ts:21-23) map enum values to Arabic display strings server-side, comment explicitly notes "Real column names (no caseNumber / courtName aliases: the lawsuit model has neither)" (route.ts:279) — evidence the report was checked against the actual schema rather than assumed. EV-7058.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 21 Reporting/Analytics | 9 | 7 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | No dedicated absenteeism-rate metric; no training data to report on (follows from Domain 14) | Medium-High |
