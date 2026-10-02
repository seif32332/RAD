# 04 Cross-domain dependencies (lifecycle traces)

## Scope and method

I traced nine employee lifecycles end to end in code and checked each hand-off from one domain to the next. The questions at each hand-off were: is there a foreign key, does a later step read the status, is data re-keyed or copied instead of referenced, and is the job scheduled? Specialist findings were reused only where the verifier CONFIRMED or ADJUSTED them, and always at their adjusted status. No REFUTED claim is used. Where a specialist claim sat on a lifecycle edge, I re-read the code myself. For example, the claim that change orders run before payroll had only been read from a comment; it is now confirmed at EV-12001.

New evidence is EV-12001..EV-12027 in `AUDIT/_work/ledger_X.md`. Other groups' EV ids are cited where they already prove a step. Read-only audit: no database, server or install was used. The working tree includes uncommitted document-engine changes (TRANSFER_DECISION, migration 9p), and these traces cover them as they stand.

Status legend: COMPLETE (wired and read downstream) · PARTIAL (wired, but with a gap that loses data or money) · DISCONNECTED (both sides exist, no link) · MISSING (the step does not exist) · BROKEN (wired, but produces a wrong result).

---

## 1. Employee -> Contract -> Payroll

| Step | Mechanism (file:line) | Status | EV |
|---|---|---|---|
| Employee record created | `POST /api/employees` (route.ts:110-230), onboarding approval (incoming-requests/route.ts:1129), Excel import | COMPLETE | EV-1006, EV-2900 |
| Contract as an entity | No Contract model. Contract terms are scalars on Employee plus an uploaded `workContractUrl`. There is no EMPLOYMENT_CONTRACT document type, no version history and no renewal count | MISSING (as an entity) | EV-12003, EV-1909 |
| Fixed-term vs unlimited | Derived from `contractEndDate` and used by exit-cost, settlement and alerts | COMPLETE (A-9 adjusted) | EV-1908 |
| Contract change (raise, allowance, branch, end date) | CONTRACT_ADDENDUM / PROMOTION_DECISION -> EmployeeChangeOrder -> `applyChangeOrder` (change-orders.ts:21-57) | COMPLETE | EV-1013, EV-1904 |
| Other writers of the same fields | `PUT /api/employees/[id]` writes basicSalary and placement with no SalaryChange row. The renewals action writes contractEndDate and probationEndDate directly | PARTIAL (3 writers, 1 audited with history) | EV-1901, EV-12004 |
| Due change applied before payroll | `payroll-hub/generate/route.ts:31-32` calls `applyDueChangeOrders()` first | COMPLETE | EV-12001 |
| Payroll reads contract | `generatePayrollMonth` reads live `Employee.basicSalary` and monthly Allowance rows (payroll.ts:423-455). It does not read contractEndDate, SalaryChange or employmentStatus | PARTIAL | EV-12002, EV-4020 |
| Mid-month or backdated salary change | Whole month is paid at the current rate: no split, no arrears | MISSING | EV-4904 |
| GOSI follows salary | A manual `Employee.gosiDeduction > 0` overrides the computed share, and no change order resets it | BROKEN for overridden employees | EV-12005 |
| Contract expiry -> payroll | Payroll keeps paying after `contractEndDate`. The only reaction is an in-app alert, and the e-mail digest does not include contracts | DISCONNECTED | EV-12002, EV-12014 |

**Where it breaks:** the contract is not an object, so three code paths write its fields. Payroll reads only the current values. A raise dated to the 15th, or backdated, is paid for the whole month at the new rate, or not paid at all for past months. A stored GOSI override silently survives any raise. **Impact:** wrong GOSI deduction after promotions for overridden employees. Backdated raises cause lost arrears. Payroll continues past the contract end date unless HR acts. **Confidence:** High.

## 2. Employee -> Attendance -> Overtime -> Payroll

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Shift assignment | `Employee.workSchedule` holds a free-text schedule name, matched by string inside the current branch (attendance.ts:148-160) | PARTIAL (copied name, not FK) | EV-12018 |
| Punch -> Attendance row | Self punch, HR manual entry and corrections compute lateMinutes, earlyLeaveMin and overtimeMin | COMPLETE | EV-3016 |
| Absence recorded | No code writes `status='ABSENT'` | MISSING | EV-3009, EV-3900 |
| Attendance -> Overtime | OvertimeRequest has no attendanceId, and hours are typed by hand (BIOMETRIC too). No check against `Attendance.overtimeMin` | DISCONNECTED | EV-3024, EV-3908 |
| Overtime -> Payroll | Approved OT is reserved by the draft (`paidInPayrollId`), carried over and priced | COMPLETE (basis defaults to BASIC) | EV-3027, EV-4905 |
| Attendance -> Payroll (lateness/absence) | Payroll never queries attendance. The only route is a manual ATTENDANCE deduction | DISCONNECTED (High) | EV-3022, EV-4900 |
| Holidays / Ramadan | No model | MISSING | EV-3906, EV-5906 |

**Where it breaks:** at two edges. Attendance minutes are computed and then only displayed, and overtime pay is based on typed hours that nothing reconciles with punches. **Impact:** absences and lateness are not deducted unless a manager types a penalty. Overtime can be paid for hours no punch supports. Absence KPIs always read 0. **Confidence:** High.

## 3. Candidate -> Offer -> Employee -> Onboarding

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Application -> Offer | Issuing JOB_OFFER sets JobApplication to OFFERED in the same transaction | COMPLETE | EV-2024, EV-2902 |
| Offer terms captured | The JOB_OFFER params carry `legalCompanyId` and `basicSalary` (service.ts:129, types.ts:1540) | COMPLETE | EV-12010 |
| Offer accepted -> HIRED | `answerOffer` only acknowledges and notifies. HIRED is a manual status change that archives the file | DISCONNECTED | EV-2902, EV-2901 |
| HIRED -> Employee | No FK in either direction. None of the 3 `employee.create` sites reads JobApplication or offer params | DISCONNECTED (High) | EV-2900, EV-2903, EV-12010 |
| Onboarding request -> Employee | `approveOnboarding` creates the Employee without legalCompanyId, actualCompanyId, allowances, contractEndDate, probationEndDate or User. OnboardingRequest keeps no link to the created Employee | PARTIAL (data loss) | EV-12008 |
| Employee -> commencement notice | Auto WORK_COMMENCEMENT is requested, but the builder refuses an employee with no legal company. The result is SKIPPED with a console warning and no retry | BROKEN for every onboarding hire | EV-12009 |
| Login account | Created separately under settings/users | MISSING (manual) | EV-2908 |
| Onboarding checklist | None | MISSING | EV-2908 |

**Where it breaks:** at every hand-off after the offer. The offer's company and salary are re-keyed twice: once into the manager-portal onboarding form, then again by HR to add the company and allowances that the form cannot hold. The automatic commencement notice fails silently because of the missing company. Until HR edits the file, the new hire is also missing from company-scoped Nitaqat counts and from the letterhead company for every document. **Impact:** re-keying errors in salary and IBAN, and no traceability from employee back to candidate. Commencement notices, which count as legal evidence of the start date, are never produced for onboarding hires. **Confidence:** High for the missing company and the SKIPPED path, which I traced statically. It was not executed.

## 4. Employee -> Leave -> Attendance / Payroll / Exit-Re-entry visa

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Leave approval | hr-workflows.ts:560-594 runs the manager stage, then HR. The leave letter is auto-issued | COMPLETE | EV-8900 |
| Leave -> Attendance | The self punch reads only `employmentStatus`. `ON_LEAVE` is set only by a paid LEAVE_SETTLEMENT (finance.ts:792) and is never reset | BROKEN | EV-3016, EV-3017, EV-3902 |
| Leave -> Payroll | `leaveDeductionForMonth` spreads `totalDeduction`. The rate is basic/30 against a documented total/30. Months already finalised lose their share | PARTIAL / DISCONNECTED for backdated leaves | EV-3035, EV-3047, EV-3903 |
| Leave -> Visa | Approval opens a Visa and a PaymentRequest, but the link is text: `deductedFrom` contains the leave id, with no FK | PARTIAL (text join) | EV-3042, EV-12011 |
| Leave extend -> Visa | EDIT/EXTEND never reads the visa, so the leave can outlast `returnBefore` | DISCONNECTED | EV-12012 |
| Visa return deadline -> alert | `returnBefore` is written by Muqeem but read by no alert or digest | MISSING | EV-12013 |
| Late return | Overstay days are not converted to unpaid days or absence | PARTIAL | EV-3043 |
| Leave encashment -> balance | LEAVE_SETTLEMENT has no Leave link and does not reduce the balance | PARTIAL (High) | EV-3053, EV-3904 |

**Where it breaks:** Leave does not reach Attendance at all, and a leave settlement leaves a status stuck that flags every later punch. The Leave-Visa relation depends on a substring match, and neither extensions nor the visa deadline are checked. **Impact:** after one leave settlement, every punch the employee makes is FLAGGED for good. Backdated leave deductions are lost. An employee can overstay an exit/re-entry visa with no system warning, which is an immigration compliance exposure for non-Saudis. The same days can be encashed twice. **Confidence:** High.

## 5. Employee -> Performance -> Promotion -> Compensation

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Evaluation closed | Closed-enum recommendation plus reason. EVALUATION_REPORT is auto-issued | COMPLETE | EV-7908, EV-7910 |
| Recommendation -> promotion/raise | No evaluationId on SalaryChange or EmployeeChangeOrder, and no prefill | DISCONNECTED (Medium) | EV-7014, EV-7909 |
| Other recommendations | NO_RENEWAL, TERMINATION and BONUS lead nowhere. They do not touch contractEndDate, TerminationRequest or Allowance | DISCONNECTED | EV-12024 |
| Promotion decision -> Employee | PROMOTION_DECISION -> change order -> Employee + SalaryChange + audit | COMPLETE | EV-1013 |
| Compensation -> payroll | Applied before generation. Whole month at the new rate | PARTIAL | EV-12001, EV-4904 |
| Compensation -> GOSI | Stale manual override survives | BROKEN (overridden employees) | EV-12005 |
| Salary history | SalaryChange is complete only for decision-driven raises. The profile has no history view | PARTIAL | EV-1901, EV-1008 |
| Workforce plan raises -> execution | PlanRaise never becomes a change order | MISSING | EV-5063 |
| Pending raise vs termination | `applyChangeOrder` has no isTerminated guard, and termination does not cancel orders | BROKEN (edge) | EV-12006 |

**Where it breaks:** the evaluation-to-decision edge and the plan-to-decision edge have no link, and the decision-to-GOSI edge is stale. **Impact:** there is no audit trail from a raise back to its justification. A raise dated after the exit date is written onto a terminated employee's file. That corrupts the SalaryChange history and the workforce cost, though payroll skips terminated employees. **Confidence:** High.

## 6. Employee -> Resignation -> Clearance -> Asset return -> Final settlement -> Archive

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Resignation request | Portal POST, manager stage, then HR. Approval stores only `lastWorkingDate`. No withdrawal endpoint | PARTIAL | EV-4303, EV-4909 |
| Request -> settlement | Settlement has no terminationRequestId. The reason vocabularies differ and have no mapping | DISCONNECTED (High) | EV-4305, EV-12021 |
| Request -> termination / access | Nothing acts on an approved `lastWorkingDate`: no job, and alerts count only PENDING | DISCONNECTED | EV-4909 |
| Asset return | Asset custody module. Transfers can clear assets. Terminate does not block (warn by design, DOM-005) | PARTIAL (G-1 adjusted) | EV-7900, EV-7901 |
| Final settlement | computeSettlement uses EOSB, leave, OT and loans. It has no GOSI, open penalties, unpaid bonuses, notice pay or Art. 77 | DISCONNECTED on those items (High) | EV-4906, EV-4910 |
| Settlement -> payroll | Payroll drops the employee as soon as any non-rejected EOS settlement exists, even one still pending | PARTIAL | EV-4907 |
| Settlement -> terminate + revoke | Owner approval sets isTerminated, EXCLUDED and exit fields, and deactivates login | COMPLETE | EV-4316, EV-4307 |
| Direct terminate path | Sets isTerminated but not employmentStatus. Pending change orders are not cancelled | PARTIAL | EV-12020, EV-12006 |
| Clearance certificate | Server refuses it while assets, SIMs, vehicles or loans are open or the settlement is unpaid | COMPLETE | EV-4319, EV-7903 |
| Archive | documents-retention job: 10 years after end of service. The RUNBOOK never enables its timer. There is no employee "archived" state beyond isTerminated | PARTIAL | EV-10908 |

**Where it breaks:** the resignation request is an island. Approving it neither terminates, schedules, prefills a settlement nor revokes access. The settlement is built from free inputs and re-keyed reasons. **Impact:** a resigned employee keeps full access and stays in payroll past the last working day until HR remembers to act. Final pay omits GOSI and open deductions and bonuses, so money is left unsettled after the employee is dropped from payroll. **Confidence:** High.

## 7. Employee -> Document -> Expiry -> Notification

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Employee identity documents | Expiry dates on Employee plus uploaded copy URLs. Uploads have no versioning | PARTIAL | EV-2001 |
| Company documents | Read from Company and Branch columns. The CompanyDocument model is dead | PARTIAL (dead model) | EV-11016, EV-2009 |
| Renewal | The renewals action updates the Employee date, archives the old one and opens a PaymentRequest. Muqeem sync updates iqama and passport | COMPLETE | EV-2009, EV-12004 |
| In-app alerts | alerts.ts covers iqama, passport, health, contract, probation and annual leave | COMPLETE | EV-1908 |
| E-mail digest | jobs.mjs `expiry-digest` re-implements the alert thresholds but leaves out contract, probation, annual leave and promissory notes. It goes to admins only | PARTIAL | EV-12014 |
| Visa return deadline / Muawama certificate | No alert | MISSING | EV-12013 |
| Delivery | Outbox dispatcher runs in dry-run (no SMTP, OUTBOX_SEND off). A backlog builds with no TTL | PARTIAL (nothing delivered) | EV-8906, EV-8907 |
| Employee notified | Never. The bell reads only legacy tables | MISSING | EV-8905 |

**Where it breaks:** at delivery. Every digest is queued and none is sent, and the digest covers a subset of what the in-app alerts cover. **Impact:** expiry management depends on someone opening the renewals page. Contract and probation expiry are never e-mailed, even after SMTP is configured, and visa return deadlines are not tracked at all. Once SMTP is switched on, the stale backlog is sent first. **Confidence:** High.

## 8. Employee -> Access -> Offboarding -> Revocation

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Account creation | Manual under settings/users. `linkEmployee` does not refuse a terminated employee | PARTIAL | EV-12023 |
| Role vs position | User.role is set by hand and is independent of jobTitle. Manager scope comes from the Employee's branch and department | PARTIAL (by design) | EV-6902 |
| Company scope | UserCompanyScope is enforced only in documents | PARTIAL | EV-9900, EV-9017 |
| Termination -> login | `deactivateEmployeeUser` runs in the same transaction on both termination paths, with grace and documents-only windows. The `deactivate-terminated` timer is enabled | COMPLETE | EV-4307, EV-10908 |
| Resignation approval -> login | No effect until an actual termination | DISCONNECTED | EV-4909 |
| Manager exits -> subordinates | directManagerId is not reassigned. Approvals keep routing to a deactivated user | DISCONNECTED | EV-12022 |
| Biometrics purge | `purge-attendance-biometrics` timer is enabled (RUNBOOK:619) | COMPLETE | EV-10908 |
| Other system credentials (gov portal vault) | GovPlatform has no user or company link, so nothing is rotated on exit | MISSING | EV-5021 |

**Where it breaks:** revocation is triggered only by a termination write, not by the approved resignation or its last working day. A departing manager leaves orphaned approval routes. **Impact:** access continues past the last working day. Subordinates' requests stall at the manager stage unless HR or an owner skips it. **Confidence:** High for revocation, Medium for how much approvals actually stall.

## 9. Transfer (branch / company) -> Payroll / GOSI / Nitaqat / documents

| Step | Mechanism | Status | EV |
|---|---|---|---|
| Two transfer mechanisms | TransferRequest (branch, schedule, assets) and TRANSFER_DECISION change order (branch, department, manager). Neither checks the other | DISCONNECTED (High) | EV-1904, EV-1905, EV-1906 |
| Destination company check | Neither path compares Branch.companyId with the employee's company, and legal and actual company are never updated. The create-time invariant (`orgPlacementErrors`) is bypassed | BROKEN | EV-12015, EV-12016 |
| FKs | TransferRequest.from/toBranchId are plain strings, and toWorkSchedule is a name | PARTIAL | EV-12017 |
| Shift after transfer | TRANSFER_DECISION does not set workSchedule. Name matching falls back to "the branch's only schedule" or null | PARTIAL | EV-12018 |
| Attendance geofence | Follows branchId only once the order is applied. The apply job is not enabled; the order is applied when the documents list is opened or payroll is generated | PARTIAL | EV-12027, EV-10908 |
| Payroll | Payroll has no companyId and rows keep no company or branch snapshot. Historical exports show today's placement and IBAN | PARTIAL | EV-4902, EV-12019 |
| GOSI | No GOSI platform integration. GOSI establishment follows legalCompanyId, which a transfer never changes | MISSING (integration) / BROKEN (attribution) | EV-5909, EV-12015 |
| Nitaqat | Counted by `legalCompanyId`, so a cross-company transfer keeps counting the employee at the old establishment | BROKEN (for cross-company) | EV-12015, EV-5023 |
| Documents | Letterhead and scope use `legalCompanyId`, so they stay on the old company. TransferRequest approval issues no decision document | PARTIAL | EV-12015, EV-1905 |

**Where it breaks:** a "transfer" moves only the branch pointer. Company, establishment and schedule are not carried with it, and the two mechanisms can overwrite each other. **Impact:** in multi-company groups, Saudization bands, GOSI establishment attribution, document letterheads and the company column on payroll are all wrong after a cross-company branch move. Only HR editing the company by hand prevents this. **Confidence:** High for the code path. Whether groups actually move staff between legal companies this way is operational and unverified.

---

## Dependency summary

| # | Lifecycle | Weakest edge | Worst status | Impact |
|---|---|---|---|---|
| 1 | Employee -> Contract -> Payroll | salary change -> payroll period / GOSI override | BROKEN (GOSI override), MISSING (retro) | High |
| 2 | Attendance -> OT -> Payroll | attendance -> payroll, attendance -> OT | DISCONNECTED | High |
| 3 | Candidate -> Employee -> Onboarding | HIRED -> Employee; onboarding -> company | DISCONNECTED / BROKEN (commencement) | High |
| 4 | Leave -> Attendance / Payroll / Visa | leave -> attendance; visa deadline | BROKEN / MISSING | High |
| 5 | Performance -> Promotion -> Pay | evaluation -> decision | DISCONNECTED | Medium |
| 6 | Resignation -> Settlement -> Archive | request -> settlement / termination | DISCONNECTED | High |
| 7 | Document -> Expiry -> Notification | outbox delivery; digest coverage | PARTIAL / MISSING | High |
| 8 | Access -> Offboarding -> Revocation | resignation -> revocation; manager exit | DISCONNECTED | Medium |
| 9 | Transfer -> Payroll / GOSI / Nitaqat / docs | branch move without company move | BROKEN | High (multi-company) |

## Broken lifecycle connections ranked by impact

1. **Attendance never reaches payroll** (L2). No lateness or absence deductions, and no absence is recorded at all. Money and compliance impact every month. EV-3022, EV-4900, EV-3009.
2. **Resignation / termination request is not connected to settlement, termination or revocation** (L6, L8). The last working day passes with no effect. The settlement is re-keyed and omits GOSI, open deductions, bonuses and notice pay, and payroll then drops the employee, so those items are never settled. EV-4909, EV-4305, EV-4906, EV-12021.
3. **Cross-company transfer moves the branch but not the legal or actual company** (L9). Nitaqat, GOSI establishment, letterheads and payroll company attribution are all wrong, and the two transfer mechanisms can overwrite each other. EV-12015, EV-12016, EV-1904..1906.
4. **Leave -> Attendance broken, and the ON_LEAVE status sticks for ever** (L4). Every punch after a leave settlement is FLAGGED, and approved leaves are ignored. EV-3016, EV-3017.
5. **Onboarding hire is created with no company, and the commencement notice is always skipped** (L3). The candidate-to-employee path is re-keyed twice. EV-12008, EV-12009, EV-2900.
6. **Visa lifecycle is tied to leave by a text field, and the return deadline is never checked** (L4, L7). Overstay exposure for non-Saudis. EV-12011, EV-12012, EV-12013.
7. **Backdated leave, backdated raises and mid-month changes never reach finalised months** (L1, L4, L5). EV-3903, EV-4904.
8. **The expiry digest covers fewer categories than the in-app alerts, and the outbox delivers nothing** (L7). EV-12014, EV-8906, EV-8907.
9. **The GOSI manual override survives raises** (L1, L5). Wrong employee share for overridden staff. EV-12005.
10. **Change orders apply to terminated employees, and termination does not cancel them** (L5, L6). EV-12006.
11. **Evaluation recommendations, including NO_RENEWAL and TERMINATION, lead nowhere** (L5). EV-7909, EV-12024.
12. **Manager exit leaves orphaned approval routes, and a terminated employee can be linked to a new user** (L8). EV-12022, EV-12023.
13. **Historical payroll exports join live placement and IBAN** (L9). EV-12019.

## Duplicated sources of truth (cross-domain)

- **Basic salary**: Employee.basicSalary is the live value. Payroll.basicSalary is a snapshot. SalaryChange is history, but only for decision-driven changes. EmployeeChangeOrder holds pending values. OnboardingRequest and the JOB_OFFER params hold copies that are re-keyed. PlannedPosition and PlanRaise hold planned values. Payroll reads the live field while the workforce engine rebuilds history from SalaryChange, so the two diverge whenever salary is edited by hand (EV-12025, EV-1901, EV-11011).
- **Contract end date**: written by the direct PUT, the renewals action and the CONTRACT_ADDENDUM change order. Only the last one leaves a document trail (EV-12004).
- **Employment status**: `isTerminated` boolean vs `employmentStatus` string (ACTIVE / ON_LEAVE / EXCLUDED). Direct terminate writes only the first; ON_LEAVE is never cleared. Readers use different combinations of the two (EV-12020, EV-3017).
- **Exit reason**: TerminationRequest.terminationType, Settlement.terminationReason and Employee.exitReason, joined by mapping tables. There is no mapping from the request's terminationType (EV-12021).
- **GOSI employee share**: the manual Employee.gosiDeduction override in payroll vs rate-computed GOSI in the workforce engine (EV-12005).
- **Shift**: Employee.workSchedule (a name) vs TransferRequest.toWorkSchedule (a name) vs WorkSchedule rows, joined by string equality (EV-12018).
- **Leave -> Visa link**: the leave id embedded in the Visa.deductedFrom text (EV-12011).
- **Change-order application**: `scripts/jobs.mjs` applyEmployeeChanges re-implements `applyChangeOrder`, `setMonthlyAllowance` and `allowanceLine`. The audit payloads already differ, and only allowanceLine has a parity test (EV-12007).
- **Expiry thresholds**: jobs.mjs DIGEST_THRESHOLDS vs alerts.ts ALERT thresholds. Parity is tested for the shared keys, but the digest leaves out 4 categories (EV-12014).
- **Labour-law constants**: RuleParameter (workforce only) vs operational constants: notice, probation 180, exit/re-entry fee (SystemSetting + DEFAULT 200 + RuleParameter) (EV-5045, EV-12026).
- **Status value lists**: Prisma enums (LeaveStatus, PayrollStatus, SettlementType) are mirrored as string maps in `src/lib/constants.ts:79-146`. Many other statuses exist only as comments on String columns (EV-11903).
- **Company attribution**: legalCompanyId, actualCompanyId and Branch.companyId, with the invariant enforced only on create and edit and bypassed by transfers (EV-12016).
- **Emails**: User.email (login and notices) vs Employee.email (HR record). A grep of settings/users and employees routes found no code that synchronises them (Low confidence: no EV id).
