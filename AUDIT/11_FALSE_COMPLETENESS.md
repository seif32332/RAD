# False completeness

Capabilities that **look** complete from a menu item, a page, a table, a label or a test count, but are not, after tracing the code. Every entry survived adversarial verification or was checked by the orchestrator. Where a verifier corrected the category, the corrected one is shown.

The section at the end lists the opposite case: things that looked missing but are implemented.

| # | What it looks like | What it actually is | True status | Evidence |
|---|---|---|---|---|
| 1 | Employee form offers the payment method "مدد (حماية الأجور)"; payroll has an export button. | A stored label. The export is an internal review .xlsx that says it is **not** a WPS/Mudad file. No SIF is generated. | MISSING | EV-4022, EV-4035, EV-5002, EV-5003 |
| 2 | Attendance hub with lateness, early-leave and overtime minutes; manager dashboards show "absent" counts. | Nothing reaches payroll. `ABSENT` is never written, so absence counts are always 0. | DISCONNECTED / MISSING | EV-3009, EV-3022, EV-3023, EV-4004 |
| 3 | Overtime type "BIOMETRIC". | Treated exactly like typed hours; `Attendance.overtimeMin` is never read. | PARTIAL | EV-3066, EV-3024, EV-3023 |
| 4 | Self clock-in flags punches made "while on leave". | Keys off `employmentStatus`, which only a paid leave settlement sets and nothing clears. Approved Leave rows are ignored. | BROKEN | EV-3016, EV-3017 |
| 5 | Schedule form captures work days (Sun–Thu). | Stored free text that no calculation reads. | DISCONNECTED | EV-3007, EV-3001 |
| 6 | Settings label says the weekend overtime multiplier covers holidays (العطل). | There is no holiday model at all. | MISSING | EV-3006 (C-7 verifier note) |
| 7 | Employee field "biometric device ID". | A manual reference; the system connects to no device. | MISSING | EV-3008 |
| 8 | payroll-core header: every per-day charge uses (basic+allowances)/30. | Leaves record `totalDeduction` at basic/30, and payroll uses the recorded amount. | PARTIAL | EV-3035, EV-3036 |
| 9 | Candidate pipeline button "قبول التوظيف ومباشرة" (accept hiring and start). | Sets `JobApplication.status = HIRED` only. No Employee or OnboardingRequest is created or linked. (The modal title does mention archiving, per verifier B-1.) | DISCONNECTED | EV-2022, EV-2023 |
| 10 | Onboarding approval "issues a work-commencement notice". | The notice is attempted but always SKIPPED, because the new Employee has no `legalCompanyId`. Every other official document is refused for that employee too. | DISCONNECTED | EV-0026, EV-0027, EV-12008 |
| 11 | Dashboard module `api/dashboard/onboarding.ts` with a checklist and progress %. | A first-run tenant **setup** checklist (add a company, a branch, run a first payroll), unrelated to new-hire onboarding. | Naming false positive | EV-2011 |
| 12 | Employee termination modal: red banner "لا يمكن إتمام عملية الإنهاء" (cannot complete termination) with outstanding custody or loans. | Enforced only in the browser; `PATCH /api/employees/[id]` terminate checks nothing. The server does block the clearance certificate and nets loans in the settlement, and warn-don't-block is a documented decision (DOM-005). So the UI contradicts the server policy. | PARTIAL (UI misleads) | EV-7033, EV-7034 (G-1 adjusted) |
| 13 | `RESIGNATION_WITHDRAWAL_DAYS = 7` and HR messages about a withdrawal window. | No endpoint lets an employee withdraw; the portal termination route only exports POST. | MISSING | EV-4304 |
| 14 | Approving a resignation/termination request. | Stores the last working day only. It does not terminate, open a settlement, or revoke access on that day. | DISCONNECTED | EV-4305, EV-12021 |
| 15 | `Payroll.isFinalSettlement` / `settlementReason` columns. | Never set by any code. | DISCONNECTED | EV-4025 |
| 16 | Review labels citing arts. 70/92/93 (deduction caps). | Flags only; amounts are never capped or carried forward. | PARTIAL | EV-4012, EV-4038 |
| 17 | `/medical-insurance` module with list, new, edit, audit and expiry alerts. | A company-level policy register. Employees carry only a validated class tier (VIP/A+/A/B/C), with no enrollment, dependants, contribution or CCHI. | PARTIAL | EV-4101, EV-4103, EV-4104 |
| 18 | `/claims` module. | Vehicle accident insurance claims. There are no employee expense claims. | MISSING (for expenses) | EV-4207, EV-4208 |
| 19 | Labour-law rule register `/workforce/rules`, dated, sourced, "VERIFIED_PRIMARY". | Read only by workforce planning; payroll, leave and settlement use their own constants (currently matching). | DISCONNECTED | EV-5045, EV-5078 |
| 20 | Workforce plan approval (maker-checker). | Freezes a snapshot. It creates no requisition, salary change or budget control. | DISCONNECTED | EV-5063, EV-5068, EV-5070 |
| 21 | Employee flag "العقد موثّق في قوى" (contract documented in Qiwa). | A manual checkbox; there is no Qiwa API. | MISSING | EV-5001, EV-5084 |
| 22 | Full Muqeem menu: status, test connection, visas, iqama, final exit. | A real client, exercised only against the local mock; the contract tests are skipped. | PARTIAL | EV-5018, EV-5019 |
| 23 | Compliance page "إدارة الالتزام والمخالفات" (compliance and violations management). | A manual register of government fines; no rule checks. | PARTIAL | EV-5053, EV-5054 |
| 24 | `SalaryChange` / `EmployeeChangeOrder` tables, written atomically and audited. | Never displayed on the employee file. Direct edits write no SalaryChange, so the history is incomplete even at the data level. | PARTIAL | EV-1008, EV-1009, EV-1010, EV-1011 |
| 25 | HeadcountPlan / PlannedPosition look like position management. | A cost-forecasting tool. There is no live position, grade or cost-center register. | MISSING (as position management) | EV-1021, EV-1022 |
| 26 | Settings → role permissions page (RolePermission). | Changes only the sidebar menu. Every API still authorizes by hard-coded role groups. | UI_ONLY | EV-9016 |
| 27 | `twoFactorEnabled` / `twoFactorSecret` on User, returned by the users API. | Nothing enables, verifies or enforces 2FA. | MISSING | EV-9010 |
| 28 | `UserCompanyScope` table with an owner-only editor and audited changes. | Honoured only by the document engine. Employees, payroll, loans, leave, attendance and the gov-platform vault ignore it. | PARTIAL | EV-9017, EV-9018, EV-9019 |
| 29 | Role label "صاحب العمل / مدير الشركة" (company manager). | A tenant-wide administrator across all Company rows. | MISSING (company admin) | EV-9015, EV-9017 |
| 30 | Security setting `max_login_attempts`. | An in-memory, per-process counter that resets on every restart or deploy. | PARTIAL | EV-9008 |
| 31 | Notification bell and `/api/notifications`. | A live 5-item query over loans, leaves, legacy circulars and audit rows. No Notification table, no read state. Document-engine notices never appear. | PARTIAL | EV-8023 (H-2 adjusted from MOCKED) |
| 32 | `NotificationOutbox.channel` documented as EMAIL/WHATSAPP/SMS/IN_APP. | Every producer writes EMAIL, and the dispatcher claims only EMAIL rows. | MISSING | EV-8024, EV-8025 |
| 33 | A production-grade outbox + SMTP dispatcher. | No SMTP provider is chosen and `OUTBOX_SEND` is off, so nothing is delivered. Most HR approvals do not enqueue anything. | PARTIAL | EV-8017, EV-8019, EV-8020, EV-0014 |
| 34 | Portal payslip "print" button next to real salary figures. | Client-side HTML plus `window.print()`, not the official, sealed document. (Official payslips are issued by the document engine when a month is PAID.) | PARTIAL | EV-0028, EV-4023 |
| 35 | 1,584 passing tests. | Almost all are pure-function tests. About 140 of 149 API routes have no handler test, auth is mocked where one exists, and the only DB+render end-to-end suite is opt-in and not in CI. | PARTIAL | EV-0022, EV-0023, EV-10008, EV-10012 |
| 36 | A comprehensive CI workflow (typecheck, lint, tests, drift, secret scan, AI gate, Docker). | Triggered on pushes to `main`, a branch that does not exist; development happens by direct pushes to `master`. | UNSAFE | EV-0021, EV-10104, EV-10105, EV-10106 |
| 37 | Detailed backup/restore scripts and runbook. | Local, unencrypted dumps; off-site copy is opt-in and unset; restore never tested. Only 4 of 7 job timers are enabled by the runbook. | PARTIAL | EV-10108, EV-10109, EV-10112, EV-10114, EV-10908 |
| 38 | Recommendation PROMOTION / RAISE at the end of each evaluation. | Validated and printed in the evaluation report, but nothing links it to a change order. | DISCONNECTED | EV-7014 |
| 39 | `CompanyDocument` model with expiry and alert flags. | Zero references in code. Company expiries are read from Company/Branch columns. | Dead table | EV-11016, EV-2007 |

## The opposite: looked missing but implemented

These were flagged by a naive search and corrected by the specialist or verifier. They are recorded so the next audit does not repeat the mistake.

| Looked like | Reality | Evidence |
|---|---|---|
| About 40 % of write routes have no Zod validation (per-file grep). | Schemas are imported from sibling `_lib/schemas.ts` or applied through `parseBody` in shared helpers. After following imports, no unvalidated POST/PUT/PATCH remains. | EV-11031, EV-11032, EV-11034 |
| Workforce-plan transition routes (approve/submit/reject …) have no auth guard. | One-line wrappers around `transitionHandler`, which calls `requireUser(ROLE_GROUPS.WORKFORCE)`. | EV-11024 |
| About 65 API routes are never called by a page. | Called through shared hooks or dynamic URLs; no dead route found in sampling (coverage PARTIAL). | EV-11035 .. EV-11038 |
| `EvaluationTemplateSection/Item` and `DocumentCounter` are unused tables. | Used through nested writes and raw SQL. | EV-11017 |
| No fixed-term vs unlimited contract classification. | Derived correctly from `contractEndDate` and branched on in settlement, exit cost, art. 37 warnings and alerts. | A-9 refuted (see 03_contracts.md) |
| Money as Float is an unsafe precision bug. | Every stored amount is rounded to halalas through `money.ts` (89 call sites, tested). The risk is convention drift, not present error. | EV-4001, EV-11002 (K-1 adjusted) |
| "قريباً" (soon) placeholders on 5 pages. | All are document-expiry labels ("expires soon"), not unfinished stubs. | EV-6037 |
