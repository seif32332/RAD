# 12 Manager self service (MSS)

## Scope and method

Read `src/app/api/manager-portal/route.ts` (517 lines, full), `src/app/api/dept-manager/route.ts`
(200 lines, full), `src/app/manager-portal/page.tsx` (12 lines, full),
`src/app/dept-manager/page.tsx`, `src/app/dept-actions/page.tsx`,
`src/app/portal/_components/ManagerWorkspace.tsx` (712 lines, by grep/targeted read),
`src/lib/hr-workflows.ts` scope functions (`assertCanManageEmployee` lines 281-293,
`managedEmployeesWhere` lines 300-311), and `src/lib/menu.ts` role-to-page mapping for MSS routes.
Scope-check method: for every manager-facing GET/POST, traced the `where` clause or guard function
back to the session user's own `Employee.branchId`/`departmentId`/`directManagerId`, and confirmed a
company-wide role (HR) is a deliberate `null` bypass rather than an accidental one.

## Capability findings

### Company -> Branch -> Department -> Team scoping
Capability: a BRANCH_MANAGER only acts on their branch, a DEPT_MANAGER only on their department; HR
sees everyone.
Status: COMPLETE
Evidence: EV-6008, EV-6009, EV-6013
Files: src/lib/hr-workflows.ts:281-311; src/app/api/manager-portal/route.ts:81-83;
src/app/api/dept-manager/route.ts:33-40
Functions/classes: assertCanManageEmployee, managedEmployeesWhere, managedDepartmentsWhere
DB tables: Employee (branchId, departmentId, directManagerId), Department
API routes: GET/POST /api/manager-portal, GET/POST /api/dept-manager
UI routes: /manager-portal, /dept-manager, /dept-actions
Tests: none found scoping `assertCanManageEmployee`/`managedEmployeesWhere`/
`managedDepartmentsWhere` directly (negative search, see Business rules row below); only
`r3-shell-menu.test.ts` checks which *menu links* appear per role (line 41-44), not the API-level
enforcement. Adversarial verification (EV-6900): c2-portal.test.ts:125-129 exercises the
direct-report ALLOW branch indirectly via approveAttendanceCorrection; the branch-match,
department-match and out-of-scope DENY branches remain untested.
Observed behavior:
- `assertCanManageEmployee` (hr-workflows.ts:281-293): refuses self-approval unless OWNER
  (line 282-284); HR group passes unconditionally (285); any other role must be in
  `ROLE_GROUPS.MANAGERS` (286); then checks direct-report (288), else looks up the manager's own
  `branchId`/`departmentId` and matches `BRANCH_MANAGER`→employee.branchId or
  `DEPT_MANAGER`→employee.departmentId (290-291); anything else is `forbidden('هذا الموظف ليس ضمن
  نطاق إدارتك')`.
- `managedEmployeesWhere` (hr-workflows.ts:300-311) builds the equivalent Prisma `OR` filter for
  list endpoints: `{id: user.employeeId}` plus (`directManagerId`, and branch/department depending
  on role) — used directly in manager-portal GET (route.ts:82-83, `employeeWhere = scope ?
  {employee: scope} : {}`) and in the POST asset-request "get_employees" list (route.ts:70-78).
- `managedDepartmentsWhere` (dept-manager/route.ts:33-40) is the department-level analogue: a
  DEPT_MANAGER's filter is `{id: me.departmentId}`; a BRANCH_MANAGER's is `{branchId: me.branchId}`
  (covering every department in their branch); anyone else (no employeeId) gets `{id:'__none__'}`
  — an unsatisfiable filter, not an accidental "see everything" default.
- The single-department GET (dept-manager/route.ts:66-117) uses `AND: [{id: departmentId}, scope]`
  with an explicit code comment explaining why a spread would be wrong (line 67: "the DEPT_MANAGER
  scope is itself `{id}` and would overwrite the requested id") — and distinguishes "department does
  not exist" (404) from "department exists but is not yours" (403) by re-querying without scope
  (lines 112-117), so a manager cannot use a 404-vs-403 timing/response difference to enumerate
  other departments' existence either way (both are refused, just with different codes).
Missing pieces: no automated test directly exercises the scope boundary (e.g., a DEPT_MANAGER of
dept A being refused for an employee in dept B). This was verified by static trace only.
Risk: Medium — the logic is correct on read, but a refactor could silently break it with no test to
catch a regression.
Confidence: High (code trace); Medium (no regression test safety net)

### Team dashboard (department detail, stats)
Capability: manager sees their team's roster, pending leaves, pending corrections, and today's
attendance stats.
Status: COMPLETE
Evidence: EV-6013, EV-6014
Files: src/app/api/dept-manager/route.ts:44-161
Functions/classes: GET()
DB tables: Department, Employee, Leave, AttendanceCorrection, Attendance
API routes: GET /api/dept-manager, GET /api/dept-manager?departmentId=...
UI routes: /dept-manager
Tests: none direct
Observed behavior: general requests (letters, IBAN/data updates) are explicitly excluded from the
manager's correction queue with a `NOT: {reason: {startsWith: GENERAL_REQUEST_PREFIX}}` filter and
a comment citing "DOM-006" (route.ts:123-125) — confirming the ESS finding that general requests
skip the manager stage is enforced on the read side too, not just on creation. Stats
(`presentToday`, `absentToday`, `lateToday`) are computed from a real `Attendance.findMany` scoped
to `activeIds` for today (route.ts:140-154), not hard-coded.
Missing pieces: none found.
Risk: Low.
Confidence: High

### Approvals: leave, attendance correction (manager stage)
Capability: manager approves/rejects a subordinate's leave or attendance correction, which then
routes to HR.
Status: COMPLETE
Evidence: src/app/api/dept-manager/route.ts:163-199 (actionSchema, POST switch)
Files: src/app/api/dept-manager/route.ts; src/lib/hr-workflows.ts (approveLeave/rejectLeave/
approveAttendanceCorrection/rejectAttendanceCorrection — signatures re-checked for
assertCanManageEmployee calls at lines 562, 666, 690, 748, 800, 994, 1137 in hr-workflows.ts)
Functions/classes: POST(), approveLeave, rejectLeave, approveAttendanceCorrection,
rejectAttendanceCorrection
DB tables: Leave, AttendanceCorrection
API routes: POST /api/dept-manager
UI routes: /dept-manager
Tests: c2-portal.test.ts:111-124 (HR-direct vs manager-approval branching for general/fingerprint
requests)
Observed behavior: every one of the four workflow functions re-runs `assertCanManageEmployee`
inside its own transaction (hr-workflows.ts grep hits above) — i.e. the scope check is not only
done once at the route layer but repeated at the domain-function layer, so calling these functions
from any other route (e.g. a future bulk-action endpoint) cannot bypass the scope rule. A rejection
requires a non-empty `reason` (zText, not zOptText — dept-manager/route.ts:166,168), consistent with
the portal showing `rejectionReason` to the employee.
Missing pieces: none found.
Risk: Low.
Confidence: High

### Overtime / work-task / penalty assignment
Capability: manager assigns overtime, an external work task, or a disciplinary deduction to a team
member.
Status: COMPLETE
Evidence: EV-6011
Files: src/app/api/manager-portal/route.ts:236-260 (schemas), 345-403 (POST cases)
Functions/classes: loadManagedEmployee (route.ts:40-46), POST() ASSIGN_OVERTIME/
ASSIGN_WORK_TASK/ASSIGN_PENALTY branches
DB tables: OvertimeRequest, WorkAssignment, Deduction
API routes: POST /api/manager-portal
UI routes: /manager-portal (ManagerWorkspace)
Tests: none route-specific found
Observed behavior: `loadManagedEmployee` (route.ts:40-46) is the single choke point for these three
actions: it loads the target Employee, calls `assertCanManageEmployee`, and additionally refuses
raising anything against a terminated employee (`badRequest('لا يمكن رفع طلب لموظف منتهية
خدماته')`, line 44) — an edge case (terminated employee) explicitly handled, not just an oversight
that happens to work. Every create is followed by `logAudit` (route.ts:364, 382, 401) recording the
acting user, entity, and details — an audit trail, not silent.
Missing pieces: none found in this pass.
Risk: Low.
Confidence: High

### Hiring request / onboarding submission (manager-initiated)
Capability: a manager requests headcount or submits a new-hire onboarding packet.
Status: COMPLETE (as a manager-portal action) — the manager side of REQUEST_HIRING/SUBMIT_ONBOARDING
Evidence: src/app/api/manager-portal/route.ts:262-269 (hiringSchema), 277-310 (onboardingSchema),
405-482 (POST cases)
Files: src/app/api/manager-portal/route.ts
Functions/classes: resolveRequesterId (route.ts:52-59), POST() REQUEST_HIRING/SUBMIT_ONBOARDING
DB tables: JobRequest, OnboardingRequest, Employee
API routes: POST /api/manager-portal
UI routes: /manager-portal
Tests: none found
Observed behavior: `resolveRequesterId` (route.ts:52-59) prefers the session's own employeeId, and
only accepts a client-supplied `requesterId` when the session user has no employee file *and* that
id exists — i.e. this is for admin accounts, not a general bypass, and it is still constrained to a
real existing employee. Onboarding checks for a duplicate iqama/ID both against existing employees
and other pending onboarding requests (route.ts:438-443) before creating.
Missing pieces: this action is not scope-checked against `assertCanManageEmployee` because it does
not target an existing managed employee — it targets a not-yet-hired person. That is architecturally
correct (there is no employee to scope against yet) but means a DEPT_MANAGER of a small department
can request hiring under any `departmentId` implicitly derived from the *requester's own*
department (route.ts:407-411, `requester?.departmentId`), which is itself scoped correctly (the
department is always the requester's own, never client-supplied).
Risk: Low.
Confidence: High

### Return-from-leave notice
Capability: manager records that a returning employee is back at work.
Status: COMPLETE
Evidence: src/app/api/manager-portal/route.ts:271-275 (returnSchema), 423-433 (POST case)
Files: src/app/api/manager-portal/route.ts; src/lib/hr-workflows.ts (recordLeaveReturn)
Functions/classes: POST() RETURN_FROM_LEAVE case
DB tables: Leave
API routes: POST /api/manager-portal
Tests: none direct
Observed behavior: wrapped in `prisma.$transaction` with a raw `SELECT ... FOR UPDATE` row lock on
the Leave row (route.ts:427) before checking `actualReturnDate`, explicitly to prevent "a double
submit ... record (and audit) the return twice" (code comment, route.ts:425-426) — this is a
deliberately engineered concurrency edge case, not an accident.
Missing pieces: `recordLeaveReturn` itself was not re-read in full in this pass to confirm it
re-applies `assertCanManageEmployee` on the leave's employee — it is listed among the grep hits for
`assertCanManageEmployee` at hr-workflows.ts (multiple call sites in the 550-1140 range which
include leave-workflow functions), so this is very likely covered, but not individually confirmed
line-by-line for `recordLeaveReturn` specifically.
Risk: Low.
Confidence: Medium

### Asset requests raised on behalf of a team member
Capability: manager (or logistics staff) requests equipment for someone they manage.
Status: COMPLETE
Evidence: EV-6012
Files: src/app/api/manager-portal/route.ts:24-25 (ASSET_REQUEST_ROLES = MANAGERS ∪ LOGISTICS),
484-509 (POST REQUEST_ASSET), src/app/asset-request/page.tsx (136 lines)
Functions/classes: loadManagedEmployee, POST() REQUEST_ASSET case
DB tables: AssetRequest
API routes: POST /api/manager-portal, GET /api/manager-portal?action=get_employees
Tests: none direct
Observed behavior: when the requester is a manager acting for someone else (`!isSelf`), it calls
`loadManagedEmployee` (route.ts:488-490) — so a BRANCH_MANAGER cannot raise an asset request for an
employee outside their branch. Logistics staff (not managers) may request for *any* active,
non-terminated employee (route.ts:490-494) — a deliberately broader scope for that role, matching
its purpose (equipment fulfillment across the company), and still blocks terminated employees.
Missing pieces: none found.
Risk: Low.
Confidence: High

### Manager's own request history / team history feed
Capability: manager sees a combined recent-activity feed for their team (overtime, deductions,
tasks, hiring, onboarding, returns, asset requests).
Status: COMPLETE
Evidence: src/app/api/manager-portal/route.ts:105-217 (GET action=get_history)
Files: src/app/api/manager-portal/route.ts
Functions/classes: GET()
DB tables: OvertimeRequest, Deduction, WorkAssignment, JobRequest, OnboardingRequest, Leave,
AssetRequest
API routes: GET /api/manager-portal?action=get_history
Tests: none direct
Observed behavior: every sub-query in the `Promise.all` (route.ts:107-150) is scoped with
`employeeWhere` (built from `managedEmployeesWhere`) or `requesterWhere` for requester-owned rows
(jobReqs, onboardingReqs) — consistent scoping across 7 different tables in one endpoint, each
correctly choosing "employee" vs "requester" as the scoping field depending on what the row
represents. Result is capped at `.slice(0, 50)` after merging and sorting (route.ts:216) — a
reasonable cap, though see the UX report (Domain 30) for the lack of pagination beyond that cap.
Missing pieces: none found; UX/pagination concern cross-referenced to Domain 30.
Risk: Low.
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Manager scope = direct reports + own branch (BRANCH_MANAGER) or own department (DEPT_MANAGER); HR = everyone | assertCanManageEmployee / managedEmployeesWhere / managedDepartmentsWhere | src/lib/hr-workflows.ts:281-311; src/app/api/dept-manager/route.ts:33-40 | none found (negative search: no test file matches `assertCanManageEmployee`, `managedEmployeesWhere`, or `managedDepartmentsWhere`) | 11, 12 | No — single pair of helpers reused by manager-portal and dept-manager |
| Nobody approves their own request (except OWNER) | assertCanManageEmployee | src/lib/hr-workflows.ts:282-284 | none direct | 12 | No |
| General/HR-direct requests never appear in the manager's correction queue | GENERAL_REQUEST_PREFIX filter | src/app/api/dept-manager/route.ts:123-125 (read side), src/app/api/portal/correction/route.ts:38 (write side, isHrDirectRequest) | c2-portal.test.ts:111-124 | 11, 12 | No — same predicate used on both sides |
| A rejection must carry a non-empty reason | zText vs zOptText | src/app/api/dept-manager/route.ts:166,168 | none direct | 12 | No |
| Terminated employees cannot receive new manager-raised actions (overtime/task/penalty/asset) | loadManagedEmployee | src/app/api/manager-portal/route.ts:44 | none direct | 11, 12 | No |

## Edge cases checked

- **BRANCH_MANAGER acting on an employee outside their branch**: refused with a specific message
  ("هذا الموظف ليس ضمن نطاق إدارتك") by `assertCanManageEmployee` (hr-workflows.ts:290-292).
  Finding: handled by code trace; **not covered by any automated test** (negative search, no
  matching test file). EV-6008/6009.
- **Department existence-enumeration via 404 vs 403**: dept-manager GET explicitly separates "does
  not exist" (404) from "exists but out of scope" (403) via a second unscoped lookup
  (route.ts:112-117). Finding: handled deliberately, not an oversight. EV-6014.
- **Double return-from-leave submission (race)**: blocked via `FOR UPDATE` row lock + a 409 conflict
  if `actualReturnDate` is already set (manager-portal/route.ts:424-432). Finding: handled.
- **Manager requests hiring/onboarding with no existing employee to scope against**: correctly
  bypasses `assertCanManageEmployee` (there is no target employee yet) but still derives the
  department from the requester's own record, never from client input (route.ts:407-411). Finding:
  handled by design.
- **Terminated employee as the target of ASSIGN_OVERTIME/ASSIGN_WORK_TASK/ASSIGN_PENALTY/
  REQUEST_ASSET**: explicitly blocked (`loadManagedEmployee`, route.ts:44; also route.ts:493 for the
  self-request asset path). Finding: handled.
- **Multi-company**: `assertCanManageEmployee`/`managedEmployeesWhere` scope on branch/department id
  only, not on `Company`/legal-entity id. Within a single tenant with several `Company` rows sharing
  branches/departments, this appears sufficient (branches/departments already imply a company via
  their own FK, not independently re-verified in this pass). Flagged as **UNKNOWN** whether a
  branch/department can span more than one `Company` row in this schema — not re-checked against
  `prisma/schema.prisma`'s Branch/Department models in this pass.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 12 MSS | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | No automated regression test exists for the branch/department scope boundary itself (assertCanManageEmployee / managedEmployeesWhere / managedDepartmentsWhere) despite it being the domain's central security control | High (code trace); Medium (no test safety net) |

## Adversarial verification

| Finding | Verdict | Final status | Final severity | Reason |
|---|---|---|---|---|
| F-1 Branch/Department manager scope enforcement | ADJUSTED | COMPLETE (code) / PARTIAL (tests) | Medium (was High) | The code claim holds and the test gap is real, but "zero tests" goes too far and High is too severe for a test gap on logic that is correct. |

Details:
- **Code claim confirmed (EV-6902).** `assertCanManageEmployee` runs inside every leave, transfer
  and correction workflow function (hr-workflows.ts:562, 666, 690, 748, 800, 861, 931, 994, 1137)
  and in manager-portal `loadManagedEmployee`. No other manager-scoping code path that skips these
  helpers was found. HR group (SUPER_ADMIN, COMPANY_ADMIN, HR_MANAGER) bypasses to all employees
  as stated. Self-approval is refused except for OWNER.
- **Test claim narrowed (EV-6900, EV-6901).** A search of all 96 test files found no test that
  names these helpers or checks the scope 403 message. However, c2-portal.test.ts:125-129 has a
  DEPT_MANAGER approve a correction for a direct report through `approveAttendanceCorrection`. That
  test runs `assertCanManageEmployee` and covers the direct-report ALLOW path indirectly. What has
  no test: the BRANCH_MANAGER branch match, the DEPT_MANAGER department match, the out-of-scope
  DENY, the no-employee-file DENY, and both list-filter builders (`managedEmployeesWhere`,
  `managedDepartmentsWhere`). The 403 in that same test file (line 120) comes from the HR-only
  general-request rule, not from scope.
- **Severity: Medium, not High.** No wrong behaviour was found. The risk is that a future change
  could break the scope check without any test failing. The report's own Risk line already says
  Medium, so the matrix row now says Medium too. It is still the most important missing test in
  this domain.
- **Detail correction (EV-6903).** The claim "plus direct reports" is true for
  `assertCanManageEmployee` and `managedEmployeesWhere`, but not for `managedDepartmentsWhere`. The
  /dept-manager dashboard does not list a DEPT_MANAGER's direct reports who sit in another
  department. Those reports can still be reached through /manager-portal. This is a usability
  inconsistency, not a security hole.
- **Edge cases checked (EV-6904).** Create, import and transfer all keep an employee's department
  inside the employee's branch, so the Department-based dashboard view and the Employee-based
  approval check stay in line. `UserCompanyScope` (legal-company limit) applies only to official
  documents, by design. The HR bypass ignores it, which matters only if company-scoped HR users
  are also expected to be limited for approvals.
- No status change: the capability stays COMPLETE, so the scorecard is unchanged.
