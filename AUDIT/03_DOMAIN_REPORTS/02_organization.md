# 02 Organization

## Scope and method

Read `prisma/schema.prisma` (Company, Administration, Branch, Department, TransferRequest, PlannedPosition,
RolePermission models), `src/app/api/companies/**`, `src/app/api/administrations/**`, `src/app/api/branches/**`,
`src/app/api/departments/**`, `src/app/api/transfers/route.ts`, `src/lib/hr-workflows.ts` (referenced for
`approveTransfer`/`rejectTransfer`/`managedEmployeesWhere`), and the corresponding `src/app/{companies,
administrations,branches,departments,transfers}/page.tsx` pages. Ran targeted negative greps for position/
grade/cost-center/org-chart concepts. Did not connect to a database.

## Capability findings

### Legal entities (Company) CRUD
Capability: manage legal-entity records (commercial registration, tax number, GOSI/MOL/MOI establishment numbers, Nitaqat activity, cost-engine settings).
Status: COMPLETE
Evidence: EV-1017, EV-1024
Files: `prisma/schema.prisma:90-161`, `src/app/api/companies/route.ts`, `src/app/api/companies/[id]/route.ts`
DB tables: `Company`
API routes: `/api/companies`, `/api/companies/[id]`
UI routes: `/companies`
Observed behavior: POST/PUT/DELETE require `WRITERS` (ADMIN ∪ HR) and every mutation calls `logAudit`.
Confidence: High

### Administrations / Branches / Departments CRUD
Capability: manage the mid-tier org hierarchy (Administration → Branch → Department).
Status: COMPLETE
Evidence: EV-1018, EV-1019, EV-1020, EV-1024, EV-1025
Files: `src/app/api/administrations/**`, `src/app/api/branches/**`, `src/app/api/departments/**`
DB tables: `Administration`, `Branch`, `Department`
API routes: `/api/administrations[/[id]]`, `/api/branches[/[id]]`, `/api/departments[/[id]]`
UI routes: `/administrations`, `/branches`, `/departments`
Observed behavior: every verb `requireUser`s and `logAudit`s. Departments require `ROLE_GROUPS.HR` on write while Companies/Branches/Administrations use `WRITERS` = ADMIN ∪ HR (EV-1025) — a naming inconsistency across otherwise-parallel endpoints; not proven to create an actual authorization gap since `src/lib/constants.ts` documents SUPER_ADMIN/COMPANY_ADMIN as members of every role group, but it is worth normalizing for maintainability.
Missing pieces: none material to CRUD correctness.
Risk: Low (cosmetic/maintainability, not a proven security hole).
Confidence: High

### Divisions / teams / positions / grades / levels / cost centers
Capability: manage finer-grained org concepts below Department — divisions, teams, formal positions (as opposed to a free-text job title), grades/levels, and cost centers.
Status: MISSING
Evidence: EV-1021
Files: `prisma/schema.prisma` (full-file `grep -n "^model "` scan)
Observed behavior: the org hierarchy modeled in the schema stops at Company → Administration → Branch → Department. `Employee.jobTitle` is a free-text `String?`, not a foreign key into a titles/positions/grades table (EV-1021). No `CostCenter` model or field exists anywhere.
Risk: Medium — any requirement to report or budget by cost center, or to manage a formal position/grade ladder (as distinct from a free-text job title), has no data model to build on. This is a structural gap, not a bug.
Confidence: High

### Headcount allocation / workforce planning
Capability: plan future headcount by position, department, nationality class, etc.
Status: PARTIAL
Evidence: EV-1022, EV-1023
Files: `prisma/schema.prisma:2637-2661` (`PlannedPosition`), `src/app/api/workforce/plans/**`
DB tables: `HeadcountPlan`, `PlannedPosition`, `PlanRaise`
API routes: `/api/workforce/plans[/[id]]`
Observed behavior: a real headcount-planning subsystem exists (forecasted new-hire/backfill/exit rows with cost projections), but it is a workforce-planning *forecast* tool (domain 22), not a "current headcount allocation against live positions" register — there is no live `Position` entity that an active `Employee` occupies a "seat" of, so headcount allocation in the classical org-management sense (seats defined, seats filled/vacant) does not exist.
Missing pieces: a live position/seat register distinct from the planning forecast.
Risk: Medium.
Confidence: High

### Reporting lines / org chart
Capability: model and visualize who reports to whom across the company.
Status: PARTIAL
Evidence: EV-1023
Files: `prisma/schema.prisma:440-441` (`directManagerId` / `ManagerToEmployee` self-relation), `src/lib/hr-workflows.ts` (`managedEmployeesWhere`)
Observed behavior: the underlying reporting-line data is real and used functionally (to scope which employees a manager can see/act on in transfers, requests, evaluations, etc. — confirmed via `managedEmployeesWhere` usage in `src/app/api/transfers/route.ts`). No org-chart visualization page/component was found anywhere in `src/app` or `src/components`.
Missing pieces: an org-chart UI.
Risk: Medium — the data to build one exists; only the visualization is missing.
Confidence: High

### Branch transfer workflow (Employee → Branch)
Capability: a manager or HR requests moving an employee to a different branch/work schedule; HR approves or rejects; on approval the employee's branch (and schedule, and optionally asset return) updates.
Status: COMPLETE
Evidence: EV-1038, EV-1039
Files: `prisma/schema.prisma:491-511` (`TransferRequest`), `src/app/api/transfers/route.ts`, `src/app/transfers/page.tsx`
DB tables: `TransferRequest`
API routes: `/api/transfers`
UI routes: `/transfers`
Functions/classes: `approveTransfer`, `rejectTransfer`, `assertCanManageEmployee`, `managedEmployeesWhere` (all in `src/lib/hr-workflows.ts`)
Observed behavior: role-scoped visibility (HR sees all, managers see only their team or their own filed requests); validation blocks transferring a terminated employee, a same-branch no-op, a work schedule that doesn't belong to the target branch, and a second pending request for the same employee; approve/reject run inside `$transaction` and only HR can decide; creation is audited.
Missing pieces: none material.
Risk: Low.
Confidence: High

### Department / manager transfer (via decision document)
Capability: move an employee's department and/or direct manager through an issued, effective-dated administrative decision.
Status: COMPLETE (mechanism) / UNKNOWN (UI reachability)
Evidence: EV-1012, EV-1013, EV-1036, EV-1037
Files: `prisma/schema.prisma:2490-2511` (`EmployeeChangeOrder.departmentId`/`directManagerId`, added by the uncommitted `9p_transfer_decision` migration), `src/lib/documents/change-orders.ts`, `src/lib/documents/types.ts` (`TRANSFER_DECISION` document type), `src/lib/documents/templates/transfer-decision.typ`
DB tables: `EmployeeChangeOrder`
Tests: `src/lib/__tests__/documents-transfer.test.ts` (6/6 pass)
Observed behavior: this is a **second, separate** transfer mechanism from `TransferRequest` (EV-1038) — it moves department/manager **and can also move the branch** (`apply.branchId`, corrected by adversarial verification, EV-1904), is issued as a decision document rather than a request/approval workflow, and applies atomically on its effective date through the same `applyChangeOrder` machinery used for promotions/raises (see 01 Core HR and 03 Contracts reports). The registry entry and template exist and the write/apply path is tested. Whether the document-creation UI actually lets a user pick `TRANSFER_DECISION` was not confirmed statically (the documents page is data-driven from an API response, not hardcoded per type — EV-1037), so UI reachability is UNKNOWN rather than assumed working or assumed broken.
Missing pieces: none provable from static code; UI reachability needs either a DB-backed run or a frontend trace not completed in this pass.
Risk: Medium until UI reachability is confirmed — an unreachable document type would make this a BACKEND_ONLY capability in practice.
Confidence: Medium

### Permissions and audit trail on org-unit mutations
Capability: only authorized roles can create/edit/delete org units, and every such change is recorded.
Status: COMPLETE
Evidence: EV-1024, EV-1025
Confidence: High

### Page-level permission model (RolePermission)
Capability: control which pages/menu items a role can see.
Status: PARTIAL
Evidence: EV-1040
Files: `prisma/schema.prisma:36-42`, `src/app/api/auth/me/route.ts`, `src/app/api/settings/permissions/route.ts`
Observed behavior: `RolePermission.allowedPages` is a simple string array consumed only to compute what the frontend nav should render for the logged-in user's role; it plays no role in actual API authorization, which is `requireUser(ROLE_GROUPS.X)` on every handler (confirmed across every route reviewed in this report). This layering is fine as a UX convenience, but it means `RolePermission` alone is not a security control and should not be treated as one.
Risk: Low, since backend authorization does not rely on it, but worth flagging so it is never mistaken for the enforcement layer.
Confidence: Medium

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Org hierarchy is exactly Company → Administration → Branch → Department (no finer tiers) | prisma/schema.prisma:90-310 | schema FKs | none directly | 01, 02, 03, 09 (payroll cost allocation) | No |
| A department cannot be created/kept without a branch (`onDelete: Restrict`) | prisma/schema.prisma:303 | schema | none found | 02 | No |
| A branch transfer is blocked for a terminated employee, a same-branch move, a mismatched work schedule, or a second pending request | src/app/api/transfers/route.ts:171-175 | inline validation | none found directly for these specific guards | 02 | No |
| Only HR may approve/reject a transfer; a manager may only file for their own team | src/app/api/transfers/route.ts:138,149,173 | `roleIn`, `assertCanManageEmployee` | none found directly | 02 | No |
| A department/manager change via `TRANSFER_DECISION` applies exactly once, atomically, on its effective date | src/lib/documents/change-orders.ts | `applyChangeOrder` | documents-transfer.test.ts | 01, 02, 03 | Shares the exact same apply mechanism as salary/job-title/branch/contract-end changes (not duplicated — one engine, many field sets) |

## Edge cases checked

- **Deleting a branch that still has departments**: `Department.branch` FK uses `onDelete: Restrict` (EV-1020), so the database itself prevents an orphaned department; not independently tested at the application layer in this pass.
- **Transferring a terminated employee**: explicitly blocked with a specific Arabic error (`لا يمكن نقل موظف منتهية خدماته`), `src/app/api/transfers/route.ts:172`.
- **Duplicate pending transfer**: blocked (`pending` lookup, L175/181) before a second `TransferRequest` can be created for the same employee.
- **Two transfer mechanisms coexisting** (verified DISCONNECTED, High, see Adversarial verification, EV-1904..EV-1906): `TransferRequest` (branch only, approval-workflow) and `EmployeeChangeOrder` (department/manager and also branch, decision-document) are structurally separate paths that both mutate `Employee` org placement fields; no cross-check was found preventing both from being in flight for the same employee at once (e.g., a pending branch `TransferRequest` and a not-yet-applied `TRANSFER_DECISION` for department could both resolve in the same window). Not confirmed as an actual bug (would need a live DB reproduction), so recorded as a design observation rather than a BROKEN finding.
- **Multi-company org structure**: `Administration`/`Branch` both carry `companyId`, and `Employee` carries both `legalCompanyId` and `actualCompanyId` separately (EV-1017/EV-1001) — supports the secondment/outsourcing pattern common in Saudi HR (legal employer ≠ actual work site); not independently exercised by a test in this pass.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 02 Organization | 11 | 5 | 3 | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 1 | No cost-center/position/grade entities; org chart not visualized; two independent transfer mechanisms (branch vs department/manager) with no observed cross-check between them | High |

## Adversarial verification

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| A-7 Two uncoordinated transfer mechanisms | ADJUSTED (detail; confirmed as DISCONNECTED) | DISCONNECTED / High | No guard was found in either direction. `/api/transfers` checks only for a pending `TransferRequest`, and the documents path never checks `TransferRequest` or other pending change orders for the same employee (EV-1905). The specialist understated the overlap: `TRANSFER_DECISION` also moves the **branch** (`apply.branchId`, with a city-change guard), so both mechanisms write `Employee.branchId` directly (EV-1904). `applyChangeOrder` does not re-check on the effective date: the department-belongs-to-branch rule is enforced only when the decision is built, and the order never updates `workSchedule` or custody. A branch TransferRequest approved between issue and effective date can therefore be silently overwritten, or leave the employee in branch B with a department of branch A (EV-1906). Mitigating factors: both paths are HR-only on approval and fully audited. `TRANSFER_DECISION` exists only in the uncommitted working tree (EV-1907). |

Corrections applied:
- The "Department / manager transfer (via decision document)" block describes TRANSFER_DECISION as "department/manager (not branch)". That is wrong: it can also change the branch (EV-1904).
- A new capability row, "Transfer mechanisms coordination (TransferRequest vs TRANSFER_DECISION)", is DISCONNECTED and added to `_work/matrix_A.md`. The scorecard below supersedes the one above: Total 11, Disconnected 1.

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 02 Organization (verified) | 11 | 5 | 3 | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 1 | No cost-center/position/grade entities; org chart not visualized; the two transfer mechanisms both write branch/department with no cross-check, and a pending TRANSFER_DECISION is applied on its effective date without re-validation (DISCONNECTED) | High |
