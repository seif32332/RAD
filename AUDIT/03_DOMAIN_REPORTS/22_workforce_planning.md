# 22 Workforce planning

## Scope and method
Read the headers and key ranges of `src/lib/workforce/{planning,load,hiring,overview,formulas,nitaqat,benchmarks}.ts`, the plan schema (`HeadcountPlan`, `PlannedPosition`, `PlanRaise`, `JobRequest`) and the `src/app/api/workforce/plans/**` handlers (list/create, positions, approve, actual). I also checked the plan UI (`src/app/workforce/plans/**`, `src/lib/menu.ts`). Searches for budget / capacity / demand models, plan-to-requisition links and company scoping are recorded as negative evidence. I ran `wf-planning.test.ts` (21 tests, passed; EV-5076).

## Capability findings

### Headcount plans (create, positions, raises, workflow)
Capability: Headcount plan with planned hires, backfills, exits and raises, plus DRAFT -> SUBMITTED -> APPROVED/REJECTED -> ARCHIVED
Status: COMPLETE
Evidence: EV-5062, EV-5065, EV-5066, EV-5075, EV-5077
Files: prisma/schema.prisma:2612-2679; src/app/api/workforce/plans/**; src/app/api/workforce/plans/_lib/{actions,server,schemas,views}.ts; src/app/workforce/plans/**
Functions/classes: assertAllowed, transitionHandler, computePlan, planSnapshotRecord
DB tables: HeadcountPlan, PlannedPosition, PlanRaise, WorkforceCalculation (approval snapshot)
API routes: GET/POST /api/workforce/plans; /plans/[id]; /positions; /raises; /submit; /approve; /reject; /archive; /copy; /actual; /plans/compare
UI routes: /workforce/plans, /workforce/plans/[id]
Tests: wf-planning.test.ts:254-363 (roles, maker-checker, read-only after approval, copy)
Observed behavior: roles are ROLE_GROUPS.WORKFORCE. Creates and position changes are audited inside the transaction. Approval must come from an owner role that did not create, submit or edit the plan. Approval freezes a snapshot, and approved plans are read-only.
Missing pieces: approval sends no notification.
Risk: Low.
Confidence: High

### Plan cost forecast from real employee data
Status: COMPLETE
Evidence: EV-5063, EV-5064, EV-5072, EV-5077
Files: src/lib/workforce/planning.ts; src/lib/workforce/load.ts; src/lib/workforce/true-cost.ts
Observed behavior: the baseline is the actual Employee rows (with allowances, leaves, loans and payroll) priced by the true-cost engine. That engine reuses the payroll GOSI and settlement EOSB functions. Planned hires are hypothetical employees. Exit one-offs release the EOSB provision, and attrition is a separate statistical line. The forecast is wired to real data, not just to assumptions, and it states the assumptions it uses.
Missing pieces: the regulatory values it uses (RuleParameter) differ from the ones operational code uses (see domain 10, EV-5045).
Confidence: High

### Plan vs actual (payroll)
Status: COMPLETE
Evidence: EV-5067, EV-5077
Observed behavior: variance drivers come from APPROVED/PAID payroll rows in the plan scope. A partial month without stored employer GOSI is compared without GOSI.
Confidence: Medium

### Scenarios, comparison and sensitivity
Status: COMPLETE
Evidence: EV-5071, EV-5075, EV-5077
Observed behavior: hire scenarios (Saudi / expat / overtime / outsourcing), a plan comparison endpoint and a sensitivity page. Nothing is written by these screens.
Confidence: Medium

### Nitaqat impact of a plan
Status: PARTIAL
Evidence: EV-5063, EV-5024, EV-5025
Observed behavior: a year-end Nitaqat estimate is shown with and without the plan, with band-drop flags. It depends on curve data that a fresh tenant does not have until the manual seed is run.
Confidence: High

### Plan -> recruitment requisitions
Capability: Turning an approved planned position into a job requisition, and tracking fill against the plan
Status: DISCONNECTED
Evidence: EV-5068, EV-5069
Files: prisma/schema.prisma:1231-1252 (JobRequest), 2637-2663 (PlannedPosition)
Observed behavior: neither model references the other, and no code creates a JobRequest from a plan. Recruitment is read only for a time-to-hire benchmark. Plan vs actual matches a hire by timing, not by a link (wf-planning.test.ts:376-383).
Missing pieces: a position-to-requisition link, a check that a requisition fits the approved plan, and a count of open positions against the plan.
Risk: Medium (adjusted from High by adversarial verification, EV-5910). Managers can raise requisitions outside the approved headcount, and the approved plan does not control hiring. Each JobRequest still passes a human HR approval (PENDING -> APPROVED), and plans are scenario data by design.
Confidence: High

### Budget integration
Status: MISSING
Evidence: EV-5070
Observed behavior: there is no budget entity and no budget-vs-plan check. The plan itself acts as the cost reference.
Confidence: High

### Demand / capacity / staffing-gap modelling
Status: MISSING
Evidence: EV-5070, EV-5047
Observed behavior: there is no demand driver, no capacity or FTE requirement per branch or shift, and no staffing-gap calculation. Planning is entirely cost and head-count driven.
Confidence: High

### Branch staffing view
Status: PARTIAL
Evidence: EV-5062, EV-5064
Observed behavior: planned positions carry a branchId and department, and scope filters exist. I did not find a dedicated view of branch staffing against a target.
Confidence: Low

### Plan execution (plan -> salary changes / hires)
Status: MISSING
Evidence: EV-5063, EV-5068
Observed behavior: approved raises and hires never become SalaryChange or Employee rows. The code says this is deferred to a "money gateway" that does not exist.
Confidence: High

### Access scoping by legal company
Status: PARTIAL
Evidence: EV-5073, EV-5074
Observed behavior: every WORKFORCE role (including HR_MANAGER and FINANCE_MANAGER) sees the costs and plans of every legal company in the tenant. companyId is only an optional query filter, and UserCompanyScope is enforced only in the document engine.
Risk: Medium. Salary cost data crosses legal-entity boundaries inside a tenant (see domains 24/25).
Confidence: Medium

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Plan approval by a different owner (maker-checker) | code | plans/_lib/server.ts assertAllowed | wf-planning:254, 356, 363 | Workflow | No |
| Exit one-off = EOSB + notice + leave payout; provision released | code | planning.ts / exit-cost.ts | wf-planning:110 | Offboarding | Notice pay is not in the real settlement (EV-5044) |
| Raise replaces the ANNUAL_RAISE_PCT assumption | code | planning.ts:19-23 | wf-planning:131, 152 | Payroll | No |
| Attrition = actual trailing 12-month turnover if not set | code | planning.ts:24-26; benchmarks.ts | wf-planning:176, 192 | Reporting | No |
| Regulatory values (levy, notice, OT cap, HRDF) | RuleParameter | rules.ts / load.ts | wf-rules | Compliance | Yes, versus operational constants (EV-5045) |

## Edge cases checked
- Backfill in the leaver's exit month counts as a handover month (wf-planning:83, EV-5077).
- A raise does not apply to an employee who joins on or after its month (wf-planning:152).
- A hire that joins before the plan start counts as an unplanned hire, with a one-month tolerance (wf-planning:376-383).
- Multi-company: plans can be scoped to a company, but viewer access is not scoped (EV-5073).
- A terminated employee with a recorded exit is used as the leaver's exit when the plan has none (planning.ts:13-14, EV-5063).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 22 Workforce planning | 11 | 4 | 3 | 0 | 0 | 3 | 0 | 0 | 1 | 0 | 0 | Plan not linked to recruitment; no budget or capacity model; plans never executed into payroll or hires; access not scoped by company | High |

## Adversarial verification

Verifier pass on 2026-09-27 (read-only). No status changed; one severity lowered (risk line above and AUDIT/_work/matrix_E.md updated). New evidence: EV-5910 in AUDIT/_work/ledger_E.md.

| ID | Capability | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|---|
| E-10 | Plan -> recruitment requisitions | ADJUSTED | DISCONNECTED / Medium (was High) | Confirmed that neither model references the other and that no code in the plans API, planning lib, workforce UI or recruitment route/page links them; JobRequest is read only by the time-to-hire benchmark (EV-5910). Severity lowered: each requisition still passes a human HR approval (PENDING -> APPROVED), and plans are scenario data by design, so this is a workflow-integration gap rather than a control or money risk. |
