# 08 Leave

## Scope and method
I read `src/lib/leave.ts` in full (769 lines) and the leave part of `src/lib/hr-workflows.ts`: balance, evaluation, locking, the state machine and the visa link.
Routes read: `api/leaves` (GET/POST), `api/leaves/[id]/action` (all 10 actions), `api/leaves/balance` and `api/leaves/preview`.
Schema read: `Leave`, `enum LeaveType`, `Visa` and `Settlement`.
For Leave -> Payroll I read `leaveDeductionForMonth` and `computePayrollLine` in `payroll-core.ts` and the leave select in `payroll.ts`. For encashment I read `settlement.ts`.
I checked the formulas against Saudi Labor Law arts. 109 and 117 as cited in the code. Legal readings marked "counsel" are not settled by this audit.
I ran leave.test.ts, r3-R3-LEAVE-balance.test.ts and x-X-LEAVE-statutory.test.ts: all pass (EV-3029). They are pure-function tests; no route or DB test covers the leave workflow. Evidence is in `AUDIT/_work/ledger_C.md`.

## Calculation verification (summary)
| Calculation | Verdict | Evidence |
|---|---|---|
| Annual entitlement 21 days, 30 days after 5 years (art. 109) | Correct. The tier switches on the joinDate + 5 years anniversary, even when the accrual period started later. The company setting can only raise the entitlement. | EV-3030, EV-3031; leave.test.ts:27-78 |
| Accrual formula | Daily pro-rata `days × rate / 365`. In a leap year an employee accrues 21.06 instead of 21 (small over-accrual). Accrual is not paused during unpaid leave (for counsel: long unpaid leave or contract suspension). There is no cap and no expiry. | EV-3031 |
| Paid days from balance | `floor(available)`, so a fractional balance of 20.9 pays 20 days and makes 1 day unpaid. The rounding goes against the employee. | EV-3034 (leave.ts:575) |
| Sick tiers (art. 117) 30 full / 60 at 75 % / 30 unpaid | Tier sizes are correct. The history uses a rolling 12 months before the leave start, and `getPastSickDays` counts the whole `totalDays` of a leave that straddles the 12-month boundary, so it overstates past days and pushes the employee into lower-paid tiers too early. Payroll's `priorSickDays` differs (`<=` vs `<`). The reading of "within one year" (rolling vs from the first sick day) is for counsel. | EV-3032, EV-3033, EV-3064 |
| Day counting | Inclusive calendar days: weekends and Eid/national holidays inside the leave are consumed from the balance. There is no holiday calendar, so the product cannot apply a different reading even if counsel requires it. | EV-3038, EV-3006 |
| Deduction rate for unpaid days and 75 % sick days | Recorded at basic/30 (EV-3035). Payroll's own documented convention says (basic + recurring allowances)/30 for every per-day charge (EV-3036), but payroll uses the recorded amount. Example: basic 6,000, housing 1,500, transport 500. Ten unpaid days deduct 2,000; the documented convention gives 2,666.67. The employee is paid 666.67 of allowances for days not worked. A test locks the basic-only rate (EV-3037). | EV-3035, EV-3036, EV-3037 |
| Split of the deduction across months | Correct and exact (cumulative rounding). Only the month being generated is charged. | EV-3047 |

## Capability findings

### Leave types catalogue
Capability: Supported leave types.
Status: PARTIAL
Evidence: EV-3070, EV-3069, EV-3049
Files: prisma/schema.prisma:672-684, src/lib/leave.ts:11-43
Observed behavior: A fixed DB enum of 10 types with Arabic labels in one map. EMERGENCY and DEDUCTED consume the annual balance (product rules).
Missing pieces: Custom types (study, exam, compensatory, remote days), iddah leave (explicitly not modelled, leave.ts:61-62) and the sick-newborn month. Adding a type requires a migration.
Risk: Medium
Confidence: High

### Leave policies (configurable)
Status: PARTIAL
Evidence: EV-3048, EV-3031
Observed behavior: Tenant-wide `SystemSetting` keys: `annual_leave_days` (can only raise the 21/30 minimum) and the statutory leave values, with range validation.
Missing pieces: Per-company, per-grade or per-contract policies. Multi-company tenants share one policy. There are no accrual-frequency, probation-eligibility or negative-balance options.
Risk: Medium
Confidence: High

### Annual entitlement (art. 109: 21 days, then 30 after 5 years)
Status: COMPLETE
Evidence: EV-3030, EV-3031, EV-3029
Files: src/lib/leave.ts:233-260, 330-374
Functions/classes: annualEntitlementRates, computeLeaveBalance
Tests: leave.test.ts (switch at 5 years, straddling the mark, company setting above the minimum)
Observed behavior: Correct tiering based on the service anniversary.
Missing pieces: None for the rule itself. See accrual caveats.
Risk: Low
Confidence: High

### Accrual and balance
Status: COMPLETE
Evidence: EV-3031, EV-3055, EV-3063, EV-3029
Files: src/lib/leave.ts, src/lib/hr-workflows.ts:318-357, src/app/api/leaves/balance/route.ts
DB tables: Leave, Employee.joinDate/leaveAccrualStartDate, SystemSetting
API routes: GET /api/leaves/balance, /api/leaves/preview, /api/portal
Tests: leave.test.ts (11 balance cases), r3-R3-LEAVE-balance.test.ts
Observed behavior: One formula is reused by the leaves API, the approvals inbox, the portal and settlements. Pending days are shown but not subtracted, and only one open leave per employee is allowed (EV-3040), so a pending request cannot double-spend.
Missing pieces: Leap-year over-accrual (+0.06 day). No pause during unpaid leave. No ledger of balance adjustments: a manual correction requires changing `leaveAccrualStartDate`.
Risk: Low to Medium
Confidence: High

### Carry-forward / expiry
Status: MISSING
Evidence: EV-3031 (the balance accumulates indefinitely from the accrual start; no cap or expiry logic in leave.ts)
Risk: Medium. Unlimited accumulation increases the end-of-service leave liability. Art. 109/111 obligations about taking leave in its year and the deferral limits cannot be enforced (legal reading for counsel).
Confidence: High

### Sick leave tiers (art. 117)
Status: PARTIAL
Evidence: EV-3032, EV-3033, EV-3064, EV-3035, EV-3050
Files: src/lib/leave.ts:240, 380-406; src/lib/hr-workflows.ts:359-373; src/lib/payroll-core.ts:431-441, 459-523
Tests: leave.test.ts:160-213, 319-332
Observed behavior: 30/60/30 tiers. The 25 % deduction on 75 % days and the 100 % deduction on unpaid days are recorded on the leave and charged in payroll. The 120-day yearly limit blocks the request.
Missing pieces: Past sick days are over-counted for leaves that straddle the 12-month boundary (EV-3033). Two sick-history implementations differ (EV-3064); the verifier found the boundary difference has no practical effect (EV-3905). The rate is basic-only (EV-3035). No medical certificate is required or stored (EV-3050). Pending sick leaves are not counted when tiering a new one.
Risk: High (wrong pay for long or chronic sick cases)
Confidence: High

### Statutory special leaves (maternity, paternity, marriage, bereavement, Hajj)
Status: PARTIAL
Evidence: EV-3048, EV-3049, EV-3029
Files: src/lib/leave.ts:46-547
Tests: x-X-LEAVE-statutory.test.ts (33)
Observed behavior: The 2025-amendment values are applied as provisional configurable defaults: maternity 12 weeks plus one optional unpaid month, paternity 3 days within 7, marriage 5, bereavement 5 or sibling 3, Hajj 10-15 days once after 2 years. None of them consume the annual balance.
Missing pieces: Iddah leave and the sick-newborn month (not modelled). The event date is optional, so the window check is skipped when HR or the employee omits it. The values await counsel confirmation (stated in the code).
Risk: Medium
Confidence: High

### Eligibility checks
Status: COMPLETE
Evidence: EV-3049, EV-3039
Observed behavior: Gender checks for maternity and paternity, Hajj service and once-only checks, terminated employees refused, UNPAID refused while balance >= 1, excess ANNUAL days need acceptance.
Risk: Low
Confidence: High

### Leave request and validation
Status: COMPLETE
Evidence: EV-3039, EV-3040, EV-3038
Files: src/app/api/leaves/route.ts, src/lib/hr-workflows.ts:414-495
API routes: POST /api/leaves, GET /api/leaves/preview
UI routes: /leaves/new, /portal
Observed behavior: The server computes days, split and deduction. The employee row is locked (FOR UPDATE), then the open-leave and overlap checks run. Only HR may file for others. Audited.
Missing pieces: No lead-time rule or minimum notice.
Risk: Low
Confidence: High

### Approval workflow (manager then HR)
Status: COMPLETE
Evidence: EV-3041, EV-3065, EV-3063
Files: src/lib/hr-workflows.ts:559-599, src/app/api/leaves/[id]/action/route.ts, src/app/api/incoming-requests/route.ts
Observed behavior: Two stages with guarded updates. HR may skip the manager only when there is no direct manager, or when the approver is OWNER. Self-approval is blocked. Audited.
Missing pieces: Notifications (see below). The balance is not re-evaluated at approval, which is acceptable because only one open leave is allowed.
Risk: Low
Confidence: High

### Cancellation
Status: COMPLETE
Evidence: EV-3044, EV-3042
Observed behavior: Pending leaves are cancelled by the owner or HR. For approved leaves, HR cancels (not started) or cuts short (started, recomputed). The unpaid visa is cancelled and its payment withdrawn.
Risk: Low
Confidence: High

### Modification / extension
Status: PARTIAL
Evidence: EV-3045, EV-3047
Observed behavior: EDIT/EXTEND by HR is recomputed on the server, overlap-checked and uses optimistic concurrency. Audited.
Missing pieces: No guard when the edited period falls in a payroll month already APPROVED or PAID, so the deduction change for that month is lost (EV-3047). The employee cannot request an extension; only HR records it.
Risk: Medium
Confidence: High

### Return to work (early / late)
Status: PARTIAL
Evidence: EV-3043, EV-3068
Observed behavior: Record return, then HR confirms. An early return shortens the leave, and the unused paid days go back to the balance (unpaid days are removed first).
Missing pieces: A late return (after `endDate`) is not converted into unpaid days, absence or an extension. The only tool is ABSCOND or a manual EXTEND.
Risk: Medium (salary paid for overstay days)
Confidence: High

### Absconding from leave
Status: COMPLETE
Evidence: EV-3046
Observed behavior: HR-only. Terminates the employee, records exitReason ABSCONDING, deactivates the account, audited.
Risk: Low (termination consequences are reviewed in report 18)
Confidence: Medium

### Leave day counting (working days vs calendar days)
Status: PARTIAL
Evidence: EV-3038, EV-3006, EV-3007
Observed behavior: Inclusive calendar days only. That is a defensible reading, but it is not configurable, and rest days and holidays cannot be excluded because no calendar exists.
Risk: Medium (counsel to confirm the treatment of Eid holidays inside annual leave)
Confidence: High

### Public holidays in leave
Status: MISSING
Evidence: EV-3006
Risk: Medium
Confidence: High

### Unpaid leave and sick deductions -> payroll
Capability: Unpaid and partially paid leave days reduce the monthly payroll.
Status: PARTIAL
Evidence: EV-3035, EV-3036, EV-3037, EV-3047, EV-3022
Files: src/lib/leave.ts:573-632, 666-669; src/lib/hr-workflows.ts:442; src/lib/payroll-core.ts:459-523, 846-849; src/lib/payroll.ts:495-507
Tests: leave.test.ts:261-280, payroll.test.ts (leaveDeductionForMonth)
Observed behavior: The APPROVED/COMPLETED leave's `totalDeduction` is split by deductible days per month and charged in the draft payroll of each month, without double counting.
Missing pieces: The rate is basic/30 while payroll's documented rule is total wage/30 (EV-3036), a systematic under-deduction for every employee with recurring allowances. The test suite enshrines the basic-only rate (EV-3037).
Risk: Medium after adversarial verification (was High). The contradiction is real, but the error under-deducts in the employee's favour (the 75 % sick tier pays more than 75 % of the wage), so there is no statutory underpayment; the exposure is employer cost and cross-screen inconsistency (settlements use total/30).
Confidence: High

### Backdated leave / leave edits against finalised payroll months
Status: DISCONNECTED
Evidence: EV-3047, EV-3045, EV-3039
Observed behavior: A leave can be filed, approved or edited for past dates. Payroll charges only the month being generated, and no route checks whether an affected month is already APPROVED or PAID. The deduction share for a closed month is never charged and no adjustment is raised.
Risk: High (silent salary overpayment; no audit signal)
Confidence: High

### Leave encashment / leave settlement
Status: PARTIAL
Evidence: EV-3053
Files: src/lib/settlement.ts:144-192, 290-317; src/app/api/settlements/route.ts
Observed behavior: END_OF_SERVICE pays the accrued balance using the same formula, and a negative balance is charged for non-Saudis. LEAVE_SETTLEMENT pays `min(requested, accrued)` at the settlement daily rate.
Missing pieces: A LEAVE_SETTLEMENT stores no link to a `Leave` row, and nothing updates the balance. If HR pays a leave settlement without also recording the matching Leave, the paid days stay in the balance and can be taken or encashed again. Paying the settlement also sets the sticky ON_LEAVE status (EV-3017).
Risk: High (double payment is possible)
Confidence: High after adversarial verification (was Medium): the Settlement row stores no leave dates or requested days at all, and the duplicate guard stops blocking once a settlement is PAID (EV-3904).

### Exit/re-entry visa link
Status: COMPLETE
Evidence: EV-3042, EV-3039, EV-3041
Observed behavior: For non-Saudis leaving KSA: a pre-check for an active visa at creation, then at HR approval a Visa (PENDING_PAYMENT) and a PaymentRequest to finance. On cancellation the unpaid visa is cancelled and the payment withdrawn.
Missing pieces: No Muqeem issuance from the leave (see report 10).
Risk: Low
Confidence: High

### Leave calendar / team availability
Status: MISSING
Evidence: EV-3051
Risk: Medium (managers approve without seeing overlaps within the team)
Confidence: High

### Employee-specific leave rules
Status: MISSING
Evidence: EV-3031, EV-3048 (only `leaveAccrualStartDate` per employee; entitlement comes from tenant settings)
Risk: Medium (contracts granting more than 21/30 days cannot be represented per employee)
Confidence: High

### Medical certificate / attachments for leave
Status: MISSING
Evidence: EV-3050
Risk: Medium (art. 117 sick leave is conditional on a medical certificate; there is no evidence trail)
Confidence: High

### Leave notifications
Status: MISSING
Evidence: EV-3052
Risk: Medium
Confidence: High

### Leave history and access scoping
Status: PARTIAL
Evidence: EV-3039, EV-3054, EV-3055, EV-3065
Observed behavior: HR and PAYROLL see all leaves; managers see their scope; employees see their own. Salary is shown only to HR and PAYROLL.
Missing pieces: No company scoping for HR in multi-company tenants.
Risk: Medium
Confidence: High

### Leave -> attendance
Status: BROKEN
Evidence: EV-3016, EV-3017 (see report 07)
Risk: High
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Annual 21 days/yr, 30 after 5 years of service | leave.ts:233-260 | computeLeaveBalance | leave.test.ts | 08, 09, 18 | No (one formula, reused by settlement.ts:184) |
| Balance = accrued since accrual start − paid days of APPROVED/COMPLETED ANNUAL/DEDUCTED/EMERGENCY | leave.ts:330-374 | computeLeaveBalance | leave.test.ts, r3-R3-LEAVE-balance | 08, 18 | No |
| Sick tiers 30/60/30, 120-day cap | leave.ts:240 | computeSickLeaveTiers; payroll-core leaveDeductionForMonth | leave.test.ts, payroll.test.ts | 08, 09 | YES: sick history in hr-workflows.ts:359 and payroll-core.ts:431, with different boundaries |
| Leave days = inclusive calendar days | hr-workflows.ts:415 | evaluateLeave | leave.test.ts | 08, 09 | payroll-core leaveDayKeys recomputes the days from totalDays |
| Daily deduction rate | leave.ts:666 (basic/30) vs payroll-core.ts:177-183 (total/30) | evaluateLeave vs dailyRate | leave.test.ts:216 locks basic/30 | 08, 09, 18 | YES: conflicting |
| UNPAID refused while balance >= 1 | leave.ts:608-614 | computeLeaveRequest | leave.test.ts | 08 | No |
| One open leave per employee; no overlap | hr-workflows.ts:465-495 | assertNoOpenLeave / assertNoOverlappingLeave | none (DB) | 08 | No |
| Manager then HR approval; HR skips when no manager | hr-workflows.ts:559-599 | approveLeave | none | 08, 19 | No |
| Non-Saudi leaving KSA: exit/re-entry visa and fee payment request | hr-workflows.ts:601-660 | openExitReentryVisa | none | 08, 10, 16 | Visa fee table also in settlement.ts:195-199 |
| Statutory special leave values (provisional) | leave.ts:137-147 + SystemSetting | computeStatutoryLeave | x-X-LEAVE-statutory | 08 | No |

## Edge cases checked
- Terminated employee: new leave refused (EV-3039). Absconding path covered (EV-3046). Future approved leaves at end of service are only warned about (settlements route, report 18).
- Crossing the 5-year anniversary inside the accrual period: correct split (leave.test.ts:69, EV-3031).
- Leap year: 366/365 × 21 = 21.06 days accrued (EV-3031).
- Leave spanning two months or the year end: split by month, paid days first (leave.test.ts:231-258). The deduction is split exactly.
- Backdated leave into a closed payroll month: the deduction is lost (EV-3047).
- Mid-period salary change: `dailyDeductionRate` is frozen at request time. A raise before approval or payroll is not reflected; recomputation happens only on EDIT/EXTEND (EV-3045).
- Sick leave straddling the 12-month look-back: over-counted (EV-3033).
- Late return: not converted into unpaid days (EV-3043).
- Ramadan / Eid inside annual leave: consumed as calendar days; no holiday calendar (EV-3006, EV-3038).
- Multi-company: one policy for all companies, and HR sees all (EV-3048, EV-3054).
- Concurrency: the employee row lock serialises requests (EV-3040).
- Arabic data: labels in one map; statutory markers stored in the notes text (`[event:...]`), which is fragile but parsed defensively (leave.ts:643-665).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 08 Leave | 26 | 8 | 10 | 0 | 0 | 6 | 1 | 0 | 1 | 0 | 0 | Deduction rate basic/30 contradicts payroll convention; backdated leave deductions lost in closed months; leave settlement not linked to balance; sick history over-count; no holidays or carry-forward policy; no calendar or notifications | High |

## Adversarial verification

Verifier pass on 2026-09-27 against the working tree. Each finding was re-opened at the cited lines and searched for missed code paths. No capability status changed, so the scorecard and the matrix status column stand. Two block-level edits were made: the Risk line of "Unpaid leave and sick deductions -> payroll" (High to Medium) and the Confidence of "Leave encashment / leave settlement" (Medium to High, mirrored in matrix_C.md).

| Finding | Capability | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|---|
| C-3 | Leave -> attendance | CONFIRMED | BROKEN / High | See 07_attendance.md. The main dashboard (EV-3900) is the only consumer that reads approved `Leave` rows to decide who is off; the punch route and the dept-manager stats (EV-3902) rely on the sticky `employmentStatus`. |
| C-4 | Unpaid / sick leave deduction rate | ADJUSTED | PARTIAL / Medium (was High) | The defect is real. `evaluateLeave` uses `dailyWage(basic) = basic/30` (hr-workflows.ts:442, leave.ts:666-669), the value is stored as `totalDeduction` by leaves/route.ts:180, and `leaveDeductionForMonth` uses it whenever it is set (payroll-core.ts:511-523). Payroll's own `dailyRate` defaults to total/30 (payroll-core.ts:177-183). The example (2,000 vs 2,666.67) is correct and leave.test.ts:216-220 locks in basic/30. No setting or decision record chooses basic/30. The severity is lowered because the error always under-deducts, in the employee's favour: the 75 % sick tier ends up paying more than 75 % of the wage, so there is no statutory underpayment. The exposure is employer cost and a contradiction with settlements, which use total/30. |
| C-5 | Backdated leave vs finalised payroll | CONFIRMED | DISCONNECTED / High | The leave routes and hr-workflows contain no payroll lookup and no past-date guard. `leaveDeductionForMonth` is called only from payroll-core.ts:848, for the month being generated. Overtime has an explicit CARRY_OVER mechanism for months already finalised (EV-3903); leaves have none, which confirms the gap is an omission and not a design choice. |
| C-6 | Leave encashment / leave settlement | CONFIRMED | PARTIAL / High (confidence raised to High) | Stronger than stated (EV-3904). `Settlement` stores no leave dates, no requested days and no leave link; `unusedLeaveDays` holds the accrued balance. The open-settlement guard only matches PENDING_APPROVAL/OWNER_APPROVED, so a second LEAVE_SETTLEMENT is allowed after the first is PAID. With `requestedLeaveDays` empty, the whole accrued balance is paid. `accruedLeaveBalance` skips only a Leave near the settled dates, i.e. it relies on HR recording a matching Leave. Payroll excludes the settled days (settlementCoverage, payroll-core.ts:994-1001), but the balance is never reduced. |
| C-8 | Sick leave tiers (art. 117) | ADJUSTED | PARTIAL / High | The main defect is confirmed: `getPastSickDays` (hr-workflows.ts:359-373) and `priorSickDays` (payroll-core.ts:431-441) both add the full `totalDays` of a leave that straddles the 12-month boundary, which moves the employee into the 75 %/unpaid tiers early. This is an employee-adverse, compliance-relevant error. One detail is overstated: the `<=` vs `<` start-boundary difference has no practical effect, because `assertNoOverlappingLeave` refuses any two leaves that share a day, and payroll only redistributes the recorded `totalDeduction` (EV-3905). The missing medical certificate is confirmed (the `Leave` model has only `extensionFileUrl`, and no route or page handles a medical report). |
| C-7 | Public holidays / rest days in leave counting | CONFIRMED | MISSING / High | See 07_attendance.md; `evaluateLeave` counts calendar days (hr-workflows.ts:414-458) and there is no holiday source (EV-3006, EV-3906). |
