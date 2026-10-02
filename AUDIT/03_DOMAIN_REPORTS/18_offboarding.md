# 18 Offboarding

## Scope and method
Traced Employee -> Separation (TerminationRequest / direct termination) -> Clearance -> Final settlement -> Payment -> Access revocation -> Documents. Read `src/lib/termination.ts`, `src/lib/settlement.ts`, `src/lib/settlement-payment.ts`, `src/lib/finance.ts` (settlement approval/payment), `src/lib/access.ts`, `scripts/jobs.mjs` (deactivate-terminated), `src/app/api/portal/termination`, the TERMINATION handler of `src/app/api/incoming-requests/route.ts`, `src/app/api/employees/[id]/route.ts` PATCH terminate, `src/app/api/settlements/route.ts`, exit documents in `src/lib/documents/types.ts`. Verified EOSB math against Labor Law arts. 84/85 using code and settlement.test.ts (EV-4308, EV-4325, EV-4026).

## Capability findings

### Resignation / employee-initiated separation request
Capability: Employee submits resignation / non-renewal / mutual agreement; HR approves with last working day
Status: PARTIAL
Evidence: EV-4301, EV-4302, EV-4303, EV-4304, EV-4305
Files: src/app/api/portal/termination/route.ts; src/app/api/incoming-requests/route.ts:804-836; src/lib/termination.ts
DB tables: TerminationRequest
API routes: POST /api/portal/termination; /api/incoming-requests (type TERMINATION)
UI routes: /portal, /incoming-requests
Tests: termination-last-day.test.ts (2)
Observed behavior: one pending request per employee; HR approval requires a last working day >= submission (+8 days for resignation); exit acceptance letter suggested.
Missing pieces: no withdrawal endpoint although a 7-day withdrawal right is encoded (EV-4304); no manager stage despite isManagerApproved column; approval does not terminate the employee or open a settlement (EV-4305).
Risk: Medium
Confidence: High

### Employer termination (direct)
Status: COMPLETE
Evidence: EV-4306, EV-4307, EV-4325
Files: src/app/api/employees/[id]/route.ts:406-485
Observed behavior: written reason required, protected maternity/sick leave guard with audited override, structured exit reason, login deactivated in the same transaction, audit.
Missing pieces: no art. 75 notice-period record or notice pay; no art. 77 handling (see below).
Risk: Low-Medium
Confidence: High

### Notice period / last working day
Status: PARTIAL
Evidence: EV-4303, EV-4301
Observed behavior: noticePeriodDays on employee used to suggest the last day; migration 9h stores lastWorkingDate on the request.
Missing pieces: no pay-in-lieu of notice; settlement lastWorkingDate is entered separately and not tied to the request (EV-4305).
Confidence: High

### End-of-service award (EOSB) calculation
Capability: Arts. 84/85 award
Status: COMPLETE
Evidence: EV-4308, EV-4309, EV-4310, EV-4325, EV-4026
Files: src/lib/settlement.ts:88-132
Functions/classes: yearsOfService, endOfServiceAward
Tests: settlement.test.ts:15-92 (termination 3y=1.5 months, 7.5y=5 months, resignation 1/3, 2/3, full at 10y, fractions, art. 80/probation zero)
Observed behavior: formulas match arts. 84/85 (half month for each of first five years, one month per year thereafter, fractions prorated; resignation <2y nil, 2-<5 one third, 5-<10 two thirds, >=10 full). ARTICLE_81/87/CONTRACT_EXPIRY pay full, flagged provisional pending counsel.
Missing pieces: wage basis is HR-selectable 'basic' or 'total' (EV-4312); choosing 'basic' under-pays against the "last wage" rule.
Risk: Medium
Confidence: High

### Final settlement (statement of dues)
Capability: EOSB + final-month salary + leave encashment + overtime - loans - manual items, approval, payment
Status: PARTIAL
Evidence: EV-4311, EV-4313, EV-4316, EV-4317, EV-4328, EV-4027
Files: src/lib/settlement.ts:201-360; src/app/api/settlements/route.ts; src/lib/finance.ts:575-799
DB tables: Settlement, PaymentRequest, Loan, OvertimeRequest, Payroll (drafts released)
API routes: POST/PUT /api/settlements, /api/owner-portal/payments
UI routes: /settlements, /settlements/new, /owner-portal, /payments
Tests: settlement.test.ts computeSettlement blocks; no test of approveSettlement (EV-4027)
Observed behavior: server-computed amounts (preview + save), HR creates, owner approves (terminates, deactivates login, drops drafts, pays off loans, re-checks overtime, creates PaymentRequest), finance marks paid with proof under maker-checker; art. 88 deadline shown.
Missing pieces: final-month salary uses wage/30 x day-of-month, so a 31st last day pays 31/30 and the join date in the same month is ignored (EV-4311); no GOSI deduction for the final month; open penalties, unpaid one-off bonuses and last-month unpaid-leave deductions are neither in the settlement nor in payroll afterwards (EV-4313, EV-4033); no art. 77 compensation or notice pay (EV-4314).
Risk: High (monetary errors on every exit that has these items)
Confidence: High

### Leave encashment at exit
Status: PARTIAL
Evidence: EV-4313, EV-4322
Observed behavior: accrued balance (21/30 days rule) x daily rate; negative balance of non-Saudis charged 30 SAR/day, Saudis not charged.
Missing pieces: the 30 SAR/day "sponsorship cost" is a company policy with no legal basis cited; charging only non-Saudis is a nationality-based difference that needs counsel review.
Confidence: High

### Clearance
Status: PARTIAL
Evidence: EV-4318, EV-4319
Observed behavior: settlement creation warns about open assets/SIMs/vehicles/leaves/visas; the clearance certificate refuses to issue while anything is outstanding or the settlement is unpaid.
Missing pieces: no departmental clearance checklist/sign-offs (IT, finance, custody), no workflow tasks.
Confidence: High

### Asset return
Status: PARTIAL
Evidence: EV-4318, EV-4319
Observed behavior: detected and blocking only at certificate time; no return task.
Confidence: Medium

### Access revocation
Status: COMPLETE
Evidence: EV-4307, EV-4306, EV-4316
Observed behavior: deactivation at termination or settlement approval with configurable grace and documents-only window; sessions revoked by sessionVersion; nightly job ends grace; audited.
Missing pieces: settlement approval deactivates immediately even if lastWorkingDate is in the future (EV-4323).
Confidence: High

### Exit interview
Status: MISSING
Evidence: EV-4321
Confidence: High

### Final payroll
Status: DISCONNECTED
Evidence: EV-4033, EV-4025, EV-4313
Observed behavior: payroll stops at the EOS month; the settlement carries the final month's pay but not the payroll items listed above.
Confidence: High

### Art. 77 compensation (unlawful termination)
Status: DISCONNECTED (corrected from MISSING by adversarial verification): notice pay and art. 77 are calculated by the workforce exit-cost engine but never reach the payable settlement
Evidence: EV-4314, EV-4910
Confidence: High

### Service / experience certificate (art. 64)
Status: COMPLETE
Evidence: EV-4320, EV-4023 (same document engine)
Observed behavior: EXPERIENCE_CERTIFICATE available after termination, self-service, with service dates.
Missing pieces: depends on render service (tests skipped without it).
Confidence: Medium

### Exit documents (acceptance letter, settlement statement, clearance)
Status: COMPLETE
Evidence: EV-4326, EV-4319
Confidence: Medium

### Payment deadline tracking (art. 88)
Status: COMPLETE
Evidence: EV-4315
Confidence: High

### Archive / final exit visa
Status: PARTIAL
Evidence: EV-4324, EV-4307
Observed behavior: final exit via Muqeem linked to settlement (not traced in depth, see report 10); employee kept as isTerminated/EXCLUDED; documents-only access window. No archival/retention step for the employee file itself found in this pass.
Confidence: Low

## Business rules
| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| EOSB half month x first 5 years, full month after | art. 84 | settlement.ts:116-132 | settlement.test.ts:18-28 | 18, 22 | Reused by workforce exit-cost (same computeSettlement) |
| Resignation fractions 0 / 1/3 / 2/3 / full | art. 85 | settlement.ts:125-130 | settlement.test.ts:30-37 | 18 | No |
| Art. 80 / probation = no award | arts. 80, 54 | settlement.ts:122; settlements/route.ts:84-110 guards | settlement.test.ts:39-42; c2-termination:26-84 | 18, 13 | No |
| Art. 81/87/contract expiry = full (provisional) | Counsel pending | settlement.ts:45-69 | x-X-PAYROLL-breakdown:201 | 18 | No |
| Service years = y + m/12 + d/360, last day inclusive | MLSD calculator (code comment) | settlement.ts:88-114 | settlement.test.ts:53-92 | 18 | No |
| Resignation withdrawal 7 days | Owner decision | termination.ts:5-17 | termination-last-day.test.ts | 18 | No |
| Payment within 7/14 days | art. 88 | settlements/route.ts:119-150 | c2-termination:85-112 | 18 | No |
| Final-month salary = wage/30 x day of month | Code | settlement.ts:273-274 | settlement.test.ts:189-190 | 18, 09 | Conflicts with payroll calendar proration (EV-4007) |

## Edge cases checked
- Terminated mid-month who joined the same month: final-month pay counts from day 1 (EV-4311).
- Last working day on the 31st / in February: 31/30 or 28/30 of wage (EV-4311).
- Future last working day at owner approval: terminated and locked out immediately (EV-4323).
- Penalty or bonus pending at exit: dropped by both settlement and payroll (EV-4313).
- Employee terminated directly (no settlement) after payroll draft: draft not flagged (EV-4037).
- Protected leave (maternity/sick) at termination: blocked unless audited override (EV-4306).
- Non-Saudi negative leave balance: charged 30 SAR/day, Saudi not (EV-4322).
- Multi-company: settlements not company-scoped (EV-4327).

## Scorecard
| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 18 Offboarding | 16 | 6 | 7 | 0 | 0 | 1 | 0 | 0 | 2 | 0 | 0 | Request not linked to settlement; final-settlement omissions (GOSI, penalties, bonuses); no art. 77/notice pay; no exit interview/clearance workflow | High |

## Adversarial verification
Verifier pass on 2026-09-27 (read-only).

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| D-8 Final settlement / final payroll | CONFIRMED | DISCONNECTED / High | Settlement creation reads no open deductions, unpaid bonuses or GOSI; only HR-typed manual fields can carry them (EV-4906). Payroll drops the employee as soon as any non-rejected END_OF_SERVICE settlement exists, including one still pending owner approval (EV-4907). |
| D-9 Final-month salary | ADJUSTED (severity) | PARTIAL / Medium (was High) | Formula confirmed with no HR override (EV-4908); the amount at stake is a fraction of one month's wage, so Medium. |
| D-10 Separation request -> settlement | CONFIRMED | DISCONNECTED / High | Approval updates only the TerminationRequest row; the portal route has only POST (no withdrawal); no job or alert picks up approved requests; termination happens only at settlement owner approval or direct termination (EV-4909). |
| D-11 Art. 77 / notice pay | ADJUSTED (status) | DISCONNECTED / High (was MISSING) | The calculation exists: the workforce exit-cost engine computes notice pay (60/30 days) and art. 77 (15 days per year, remaining term, 2-month minimum) on top of computeSettlement, but the payable settlement has no such line and HR can only type the amount as a manual entitlement (EV-4910). Built but not wired, so DISCONNECTED. Capability block, scorecard and matrix_D corrected. |
