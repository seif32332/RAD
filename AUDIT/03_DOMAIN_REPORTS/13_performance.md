# 13 Performance

## Scope and method

Read `prisma/schema.prisma` (EvaluationTemplate/Section/Item, EvaluationCycle, EmployeeEvaluation,
EvaluationItemScore, EvaluationApproval — lines 1782-1920), `src/app/api/evaluations/route.ts` (719
lines, full CRUD/workflow) and `src/app/api/evaluations/scoring.ts` (171 lines, pure scoring
helpers), `src/app/evaluations/**` pages (page.tsx, `[id]/page.tsx`, `print/[evalId]/page.tsx`,
`reports/page.tsx`, `templates/new/`), and `src/lib/__tests__/c2-talent.test.ts` (132 lines). Ran
targeted `grep -n` on `recommendation`, `self.assess`, `360`, `calibrat`, `PIP`, `competenc` to check
for promotion/compensation links and for capabilities the brief lists that might not exist. Did not
run vitest (scoring.ts is already exercised by c2-talent.test.ts, part of the reported 86/1584 pass).

## Capability findings

### Evaluation templates (sections, weighted items)
Capability: Build reusable evaluation templates with weighted sections and scored items.
Status: COMPLETE
Evidence: EV-7001, EV-7002
Files: prisma/schema.prisma:1782-1827; src/app/api/evaluations/route.ts (POST template, `weightsAreValid` check); src/app/api/evaluations/scoring.ts:120-124
Functions/classes: `weightsAreValid`, `checkScores`
DB tables: EvaluationTemplate, EvaluationTemplateSection, EvaluationTemplateItem
API routes: POST/GET /api/evaluations (view=templates)
UI routes: /evaluations/templates/new
Tests: c2-talent.test.ts:56 ("keeps score validation and default template weights")
Observed behavior: Section weights are validated to sum to 100 (`weightsAreValid`, scoring.ts:120-124); a default template (`DEFAULT_TEMPLATE_NAME`/`DEFAULT_TEMPLATE_SECTIONS`, scoring.ts:151-171) seeds a realistic 5-section Arabic template.
Missing pieces: none material.
Risk: Low.
Confidence: High.

### Evaluation cycles
Capability: Create a cycle from a template, auto-enrolling active employees, and close it.
Status: COMPLETE
Evidence: EV-7003, EV-7004
Files: src/app/api/evaluations/route.ts:445-505 (create cycle), :692-712 (close cycle)
DB tables: EvaluationCycle, EmployeeEvaluation
API routes: POST /api/evaluations (action=CREATE_CYCLE, action=CLOSE_CYCLE)
UI routes: /evaluations
Tests: none found at the API/DB level (only scoring.ts pure functions are tested).
Observed behavior: Cycle creation rejects an end date before the start date and rejects a cycle with zero active employees (route.ts:455,466); one `EmployeeEvaluation` (status DRAFT) is created per active employee in a single transaction.
Missing pieces: no DB-level test for cycle creation/closing.
Risk: Low-Medium (untested transactional bulk-create path).
Confidence: Medium.

### Manager scoring + submission workflow
Capability: Manager scores an employee against the template, saves drafts, submits for approval.
Status: COMPLETE
Evidence: EV-7005, EV-7006, EV-7007
Files: src/app/api/evaluations/route.ts:508-611 (SAVE_SCORES)
Functions/classes: `computeTotalScore`, `checkScores`, `ratingForScore` (scoring.ts:59-79)
DB tables: EmployeeEvaluation, EvaluationItemScore
API routes: POST /api/evaluations (action=SAVE_SCORES)
UI routes: /evaluations/[id]
Tests: c2-talent.test.ts:25-68 (weighted total, rating mapping, score validation) — pure-function level only.
Observed behavior: Only the direct manager (`managerId` or `Employee.directManagerId`, route.ts:65-71) or HR may score; submission requires all required items scored, final notes, and a recommendation (route.ts:546-552); status transition is guarded atomically (`updateMany` with a status/cycle-status where-clause, route.ts:561-578) to prevent a lost update from concurrent submit/approve.
Missing pieces: no self-assessment step — the employee never enters their own score before the manager scores (see "Self-assessment", MISSING below).
Risk: Low.
Confidence: High.

### Approval workflow (approve/return)
Capability: HR/approver reviews a submitted evaluation, approves or returns it with a comment.
Status: COMPLETE
Evidence: EV-7008
Files: prisma/schema.prisma:1908-1920 (EvaluationApproval); src/app/api/evaluations/route.ts (APPROVAL_ACTION.APPROVE/RETURN)
DB tables: EvaluationApproval
API routes: POST /api/evaluations (action=APPROVE_EVALUATION or similar)
UI routes: /evaluations/[id]
Tests: none at API/DB level.
Observed behavior: Each approval action (APPROVE/RETURN/REJECT) is appended to `EvaluationApproval` with approver, action, comment and timestamp — a full audit trail of the approval chain, separate from the generic `AuditLog`.
Missing pieces: no test coverage; single-level approval only (no configurable multi-step approval chain, unlike `DocumentApproval`/change-order approvals in the documents engine).
Risk: Low.
Confidence: Medium.

### Employee acknowledgement
Capability: Employee acknowledges a closed evaluation and may add a comment.
Status: PARTIAL
Evidence: EV-7009
Files: prisma/schema.prisma:1871-1873 (`employeeAcknowledgedAt`, `employeeComment`)
DB tables: EmployeeEvaluation
API routes: POST /api/evaluations (view=employee-pending / an ack action)
UI routes: /evaluations
Observed behavior: The schema and a `view=employee-pending` read path exist; the employee can only react after the manager/HR process is fully closed — there is no self-assessment input beforehand (see below).
Missing pieces: acknowledgement is one-way (read + comment), not a structured self-assessment.
Risk: Low.
Confidence: Medium.

### Self-assessment
Capability: Employee fills their own scores/comments before or alongside the manager's evaluation.
Status: MISSING
Evidence: EV-7010 (negative search: `grep -rniE "self.assess|selfScore|SELF" src/app/api/evaluations/route.ts src/app/evaluations/page.tsx prisma/schema.prisma` returns no match in the evaluation domain — the only `SELF` hit in the whole schema is `Attendance.origin = SELF`, an unrelated attendance-punch-source enum, prisma/schema.prisma:552)
Risk: Medium — the brief explicitly asks for self-assessment; its absence means the workflow is manager-driven only, no two-way input before scoring.
Confidence: High.

### 360-degree feedback
Capability: Multiple raters (peers, subordinates, self) contribute to one evaluation.
Status: MISSING
Evidence: EV-7011 (negative search: no "360", no multi-rater model; `EmployeeEvaluation.managerId` is singular, and `EvaluationItemScore` has one score per item per evaluation, no rater dimension)
Risk: Medium.
Confidence: High.

### Competency ratings / calibration
Capability: Standardized competency library, cross-team calibration of ratings.
Status: MISSING
Evidence: EV-7012 (negative search: `grep -rniE "calibrat|competenc" src/app/api/evaluations src/app/evaluations prisma/schema.prisma` — zero hits; template items are free-text titles per template, not a reusable competency taxonomy)
Risk: Medium — without calibration, cross-manager rating consistency (grade inflation) is not checked anywhere in the product.
Confidence: High.

### PIP (Performance Improvement Plan) tracking
Capability: Structured PIP with a start/end date, milestones, and progress tracking.
Status: MISSING
Evidence: EV-7013 (negative search: no `PIP` hits; the closest is the recommendation enum value `EXTEND_MONITORING` and `WARNING`/`NOTICE` — stored as a plain string on `EmployeeEvaluation.recommendation` with no linked plan, dates, or follow-up cycle, scoring.ts:19-30)
Risk: Medium — a low performer can be flagged but the product has no way to track the improvement plan itself.
Confidence: High.

### Promotion / compensation recommendation feed
Capability: A "PROMOTION"/"RAISE" recommendation from an evaluation flows into a salary change or promotion record.
Status: DISCONNECTED
Evidence: EV-7014 (negative search: `grep -n "recommendation\|SalaryChange\|EmployeeChangeOrder\|promot" src/app/api/evaluations/route.ts` shows `recommendation` is only read/written as a plain string, lines 353-354, 551-552, 573-574 — no code path creates or links a `SalaryChange`, `EmployeeChangeOrder`, or any workforce-decision record from it)
Files: src/app/api/evaluations/route.ts:353-354,551-552,573-574; prisma/schema.prisma:1863-1864 (`recommendation` is a String column but validated server-side against the closed `RECOMMENDATIONS` enum, scoring.ts:21-32; `recommendationReason` is free text; verifier correction, EV-7908)
Risk: Medium (verifier-adjusted from High; see "Adversarial verification") — this is the specific cross-domain question the brief asks ("does a rating feed promotion/compensation"); the answer is no. HR must manually re-key a PROMOTION/RAISE recommendation into the separate change-order or payroll flow; there is no traceability between the two once that happens.
Confidence: High.

### Evaluation dashboard / reports
Capability: Aggregated view (score buckets, cycle progress) for HR.
Status: COMPLETE
Evidence: EV-7015
Files: src/app/api/evaluations/route.ts (view=dashboard); src/app/evaluations/reports/page.tsx:60 (`fetch('/api/evaluations?view=dashboard')`); src/app/api/evaluations/scoring.ts:126-140 (`bucketScores`)
Functions/classes: `bucketScores`
Tests: c2-talent.test.ts (bucketScores not directly covered by name in the grep'd describe blocks — see Confidence).
Observed behavior: `bucketScores` buckets total scores into the same 5 rating bands used for individual ratings (>=90 ممتاز ... <60 ضعيف); the reports page fetches this from a real DB-backed view, not a static page.
Missing pieces: none found within scope.
Risk: Low.
Confidence: Medium (bucketScores itself is simple and consistent with `ratingForScore`, but no direct unit test located for it in the grepped output).

### PDF evaluation report
Capability: Generate an official evaluation document/PDF.
Status: COMPLETE
Evidence: EV-7016
Files: src/app/api/evaluations/route.ts:5 (`issueEvaluationReportQuietly` from `@/lib/documents/service`); src/app/evaluations/print/[evalId]/page.tsx
Observed behavior: The evaluations route imports and presumably calls the document engine's `issueEvaluationReportQuietly` (same rendering pipeline used by the documents domain), rather than building its own ad hoc PDF — a real integration point, not a mock.
Missing pieces: not traced end-to-end into the document engine's render service in this pass (that belongs to Domain 04 Documents); flagged as a cross-domain link only.
Risk: Low.
Confidence: Medium (integration point confirmed by import; full render path not re-verified here).

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Section weights must sum to 100 | `weightsAreValid` | scoring.ts:120-124 | c2-talent.test.ts:56 | Performance | No |
| Total score = Σ(section avg/5 × 100 × weight/100) | `computeTotalScore` | scoring.ts:59-71 | c2-talent.test.ts:25 | Performance | No |
| Rating bands (90/80/70/60) | `ratingForScore` | scoring.ts:73-79 | c2-talent.test.ts:45 | Performance | Same bands re-implemented in `bucketScores` (scoring.ts:126-140) — logically duplicated, not shared via one lookup |
| Submission requires all required items + final notes + recommendation | route.ts SAVE_SCORES | route.ts:546-552 | None (API-level) | Performance | No |
| Only direct manager or HR may score | `isManagerOf`, `evaluationScope` | route.ts:50-71 | None (API-level) | Performance, Security | No |
| Cannot edit a closed cycle or a non-editable-status evaluation | route.ts SAVE_SCORES guard | route.ts:536-539,561-566 | None (API-level) | Performance | No |

## Edge cases checked

- **Concurrent submit/approve race**: guarded — `SAVE_SCORES` uses `updateMany` with a `status IN (editable)` where-clause and checks `res.count === 0` to detect a concurrent change (route.ts:561-578). Finding: handled. EV-7017.
- **Terminated employee mid-cycle**: cycle creation only enrolls currently-active employees at creation time (route.ts:466, "لا يوجد موظفون على رأس العمل ضمن الدورة المحددة"); no evidence found of what happens to an in-flight `EmployeeEvaluation` when the employee is terminated mid-cycle (no filter/guard located in SAVE_SCORES or APPROVE for `employee.isTerminated`). Status: UNKNOWN — not enough evidence to call this safe or broken. EV-7018.
- **Manager reassignment mid-cycle**: `EmployeeEvaluation.managerId` is captured at cycle-creation time (a snapshot); if `Employee.directManagerId` changes afterward, `isManagerOf` checks both fields (route.ts:65-71) which could let two different people be treated as manager, or leave a gap. Not exercised by any test found. Status: UNKNOWN. EV-7019.
- **Arabic data**: all UI strings, enum labels (`ratingForScore`) and the default template are Arabic-first; consistent with the rest of the product. Finding: fine. EV-7020.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 13 Performance | 10 | 6 | 1 | 0 | 0 | 4 | 0 | 0 | 1 | 0 | 0 | No self-assessment/360/calibration/PIP; recommendation does not feed promotion/compensation | Medium-High |

## Adversarial verification

Verifier pass on group G findings (read-only). Evidence EV-7908..EV-7910 appended to `AUDIT/_work/ledger_G.md`.

### G-3 — Evaluation recommendation -> compensation/promotion: ADJUSTED (status DISCONNECTED kept; severity High -> Medium; detail corrected)

Confirmed: no code path turns a PROMOTION/RAISE recommendation into a `SalaryChange` or `EmployeeChangeOrder`. `grep -rn recommendation src` outside the evaluation pages/API hits only the legal investigations module and the document engine's printing of the evaluation report. `SalaryChange` (prisma/schema.prisma:2139-2151) has only a free `reason`, and `EmployeeChangeOrder` (2490-2512) links to the issuing document (`documentId`) but has no evaluation reference, so a raise or promotion issued later cannot be traced back to the evaluation. EV-7910.

Corrected detail:
- The recommendation is not free text. `POST /api/evaluations` (SAVE_SCORES) validates it with `z.enum(RECOMMENDATIONS)` (src/app/api/evaluations/route.ts:353; list in src/app/api/evaluations/scoring.ts:21-32) and submission requires both a recommendation and a written reason (route.ts:551-552). EV-7908.
- The recommendation is kept as a durable, issued record: when an evaluation closes, the document engine issues an `EVALUATION_REPORT` automatically (evaluations/route.ts:688 `issueEvaluationReportQuietly`; src/lib/documents/service.ts:1121-1180 with a sweep for missed ones; the template prints the Arabic recommendation label and reason, src/lib/documents/types.ts:1803-1861). EV-7909.
- The downstream flows HR would use already exist (contract addendum / decision documents that write `EmployeeChangeOrder.basicSalary` and `jobTitle`), so the gap is a missing link and prefill, not a missing capability.

Why Medium: nothing is computed wrongly and no money moves without an HR decision; the cost is re-keying and the lack of a queryable evaluation -> change-order link for audit and reporting.

