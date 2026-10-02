# 09 Payroll

## Scope and method
Read `src/lib/payroll-core.ts` (settings, rates, proration, overtime, leave deductions, GOSI legacy path, computePayrollLine, settlement coverage), `src/lib/payroll.ts` (generate / approve / pay / release), `src/lib/gosi.ts`, `src/lib/money.ts`, `src/app/api/payroll-hub/{route,generate,export,summary}`, the payslip document type and issuance (`src/lib/documents/types.ts`, `service.ts`), `Payroll`/`Allowance`/`Deduction`/`Loan`/`GosiRate`/`SalaryChange` in `prisma/schema.prisma`, migration `5_gosi_regime_payroll_breakdown_maker_checker`, and the change-order path. Ran 10 related vitest files (159 tests passed, EV-4026). No database was used; DB-dependent behaviour is inferred from code only.

## Capability findings

### Payroll calculation engine (per-employee line)
Capability: Compute gross, deductions and net per employee per month
Status: PARTIAL
Evidence: EV-4004, EV-4007, EV-4013, EV-4036, EV-4032, EV-4026
Files: src/lib/payroll-core.ts, src/lib/payroll.ts
Functions/classes: computePayrollLine, employmentDaysInMonth, dailyRate, leaveDeductionForMonth, overtimeAmount
DB tables: Payroll, Allowance, Deduction, Loan, LoanInstallment, OvertimeRequest, Leave, Settlement
API routes: POST /api/payroll-hub/generate
UI routes: /payrolls
Tests: payroll.test.ts, x-X-PAYROLL-breakdown.test.ts (pure)
Observed behavior: gross = prorated basic + prorated recurring allowances + one-off bonuses + approved overtime; deductions = leave (recorded leave.totalDeduction split by month) + penalties + GOSI employee + loan installments (loans capped by what is left). Net clamped at 0 and flagged.
Missing pieces: no attendance input (absence/lateness never reaches payroll, EV-4005/EV-4006); "other deductions" hard-coded 0 (EV-4036); two day-bases (calendar proration vs /30 daily rate, EV-4007); penalties/leave/GOSI not limited to available net, and uncollected penalties are marked linked on approval (EV-4013).
Risk: High. Net pay can be wrong for absences unless HR manually enters a Deduction; clamped nets silently lose penalty amounts.
Confidence: High

### Salary structure: basic + allowances
Capability: Basic salary and typed recurring allowances (housing/transport/other), GOSI flag
Status: PARTIAL
Evidence: EV-4002, EV-4021, EV-4020
Files: prisma/schema.prisma:783-803, src/lib/payroll-core.ts:139-185, src/app/api/employees/[id]/route.ts
Functions/classes: allowanceLine, splitRecurringAllowances, monthlyWage
DB tables: Employee.basicSalary, Allowance
API routes: PUT /api/employees/[id]
UI routes: /employees/[id]/edit
Tests: payroll.test.ts rates
Observed behavior: Allowance rows with isMonthly, allowanceType, countsTowardGosi; payslip split housing/transport/other (migration 9i).
Missing pieces: no pay grades/structures/components catalogue; allowance edits delete and recreate rows (no history); audit stores only field names, not old/new amounts (EV-4021).
Risk: Medium
Confidence: High

### Overtime -> payroll
Capability: Approved overtime paid in its month or carried to the next
Status: PARTIAL
Evidence: EV-4008, EV-4030, EV-4026
Files: src/lib/payroll-core.ts:216-310, 1043-1245; src/lib/payroll.ts:463-470, 636-648
Functions/classes: overtimeAmount, overtimeHourlyRate, overtimeDueInMonth, overtimeDueInSettlement
DB tables: OvertimeRequest (paidInPayrollId, paidInSettlementId), Company.overtimeHourlyBasis
API routes: payroll-hub UPDATE_OVERTIME_STATUS / CREATE_OVERTIME_ASSIGNMENT
UI routes: /overtimes, /payrolls
Tests: r3-payroll-overtime.test.ts (26), payroll.test.ts overtime blocks
Observed behavior: reservation by draft, released on regeneration, conflict if taken concurrently; lump sum supported.
Missing pieces: default basis BASIC (1.5 x basic hourly) under-pays versus the Labor Law formula (hourly wage + 50% of basic) whenever allowances exist; the compliant basis is opt-in per company (EV-4008).
Risk: High (statutory under-payment by default)
Confidence: High

### Deductions (penalties) -> payroll
Capability: Approved disciplinary deductions deducted once
Status: PARTIAL
Evidence: EV-4012, EV-4013, EV-4014, EV-4212
Files: src/lib/payroll.ts:477-490, 303-312; src/app/api/payroll-hub/route.ts:476-551
Functions/classes: generatePayrollMonth (deduction filter), approvePayrollMonth
DB tables: Deduction (payrollMonth, isLinkedToPayroll)
Tests: none for the DB path (EV-4027)
Observed behavior: reserved by draft via payrollMonth, linked on approval; late-approved deductions roll into the next month.
Missing pieces: statutory caps flagged but not enforced and no carry-forward (EV-4012, EV-4038); clamped net marks unrecovered amounts as linked (EV-4013).
Risk: Medium-High
Confidence: High

### Loans/advances -> payroll
Capability: Installments deducted and balance reduced
Status: PARTIAL
Evidence: EV-4205, EV-4014, EV-4203
Files: src/lib/payroll.ts, src/lib/payroll-core.ts:894-901
DB tables: Loan, LoanInstallment
Tests: r3-payroll-loans.test.ts (settlement formula, stage tables) only
Observed behavior: installment limited to available net; balance decremented once at approval; loan COMPLETED at 0.
Missing pieces: 10% cap only flagged; no DB-level test of the reserve/approve cycle (EV-4027).
Risk: Medium
Confidence: High

### Leave -> payroll
Capability: Unpaid and sick-tier leave deductions
Status: COMPLETE (calculation), see edge cases
Evidence: EV-4031, EV-4032
Files: src/lib/payroll-core.ts:387-527
Tests: payroll.test.ts:328-415
Observed behavior: deduction recorded at leave approval is split across months by deductible days with cumulative rounding; sick 30/60/unpaid tiers on a one-year look-back.
Missing pieces: uses /30 daily rate while salary proration is calendar (EV-4007).
Risk: Low
Confidence: High

### Attendance -> payroll
Capability: Absence / lateness affecting pay
Status: DISCONNECTED
Evidence: EV-4004, EV-4005, EV-4006
Observed behavior: attendance data exists (domain 07) but payroll never reads it and no process creates Deduction rows from it; only manual deductions.
Risk: High (absences are paid unless HR re-keys them)
Confidence: High

### Bonuses
Capability: One-off bonus paid in a target month
Status: COMPLETE
Evidence: EV-4028, EV-4014
Files: src/app/api/payroll-hub/route.ts:762-803; src/lib/payroll.ts:535-541, 301
API routes: POST /api/payroll-hub CREATE_BONUS
UI routes: /overtimes
Observed behavior: PAYROLL role, targets first non-finalized month, reserved by draft, isPaid on approval, audited.
Missing pieces: no approval step for a bonus (created and paid by the same PAYROLL user); no DB test.
Risk: Medium (SoD)
Confidence: Medium

### Commissions
Status: MISSING
Evidence: EV-4029
Risk: Low-Medium (sales-driven customers)
Confidence: High

### GOSI (social insurance)
Capability: Employee + employer shares by regime, nationality, dated rates, cap
Status: PARTIAL
Evidence: EV-4009, EV-4010, EV-4011, EV-4026
Files: src/lib/gosi.ts, migration 5_gosi_regime_payroll_breakdown_maker_checker, src/app/api/employees/gosi-review/route.ts
Functions/classes: calculateGosi, pickGosiRate, gosiBaseWage
DB tables: GosiRate, Employee.gosiRegime (enum GosiRegime OLD/NEW/UNKNOWN), Allowance.countsTowardGosi
Tests: x-X-PAYROLL-gosi.test.ts (15), x-X-PAYROLL-breakdown.test.ts
Observed behavior: base = basic + flagged allowances (housing by default), clamped 1,500..45,000; Saudi OLD 9.75/11.75, non-Saudi 0/2 employer; NEW regime steps +0.5/side each July 2025-2028; UNKNOWN Saudi -> OLD + review flag; employer share stored (gosiEmployer), never deducted.
Missing pieces: every NEW-regime row is provisional (unconfirmed with GOSI, EV-4010); proration of GOSI by days worked is an implementation choice not verified against GOSI rules (UNKNOWN); no GOSI file/integration (report 10). Legacy path still in code (EV-4011).
Risk: Medium
Confidence: High (code), Low (rate correctness for NEW regime)

### Payroll periods, runs, generation
Capability: Monthly draft generation and regeneration
Status: PARTIAL
Evidence: EV-4002, EV-4003, EV-4017, EV-4018, EV-4030
Files: src/lib/payroll.ts:392-673, src/app/api/payroll-hub/generate/route.ts
API routes: POST /api/payroll-hub/generate {month, year, supplementary}
UI routes: /payrolls (calls /api/payroll-hub/generate at page.tsx:364)
Observed behavior: one run per calendar month for the whole tenant; supplementary mode for late joiners; reads up-front, writes in one transaction with re-checks.
Missing pieces: no per-company (legal entity) run, Payroll has no companyId (EV-4002, EV-4003); no pay-group / cut-off dates / off-cycle runs.
Risk: High for multi-company tenants (one approval covers all companies; no company scoping, EV-4327)
Confidence: High

### Approval and locking
Capability: Approve a month, lock it, mark paid
Status: PARTIAL
Evidence: EV-4014, EV-4015, EV-4016, EV-4018
Files: src/lib/payroll.ts:254-346; src/app/api/payroll-hub/route.ts:429-474
Observed behavior: guarded DRAFT->APPROVED->PAID, month named explicitly, regeneration refused after approval, audit rows.
Missing pieces: no maker-checker: a PAYROLL_ADMIN/COMPANY_ADMIN/FINANCE_MANAGER can generate, approve and mark paid alone (EV-4016); no reopen/reversal (EV-4019).
Risk: High (segregation of duties on the largest cash outflow)
Confidence: High

### Recalculation and retroactive changes
Status: MISSING (retro) / PARTIAL (draft recalculation)
Evidence: EV-4018, EV-4019, EV-4020
Observed behavior: drafts can be regenerated at will; once approved, nothing recalculates. A salary change is applied to the employee file on its date and the next generated month uses the new amount for the whole month; no mid-month split and no back-pay for a backdated effective date.
Risk: High (wrong pay on mid-month raises, lost arrears)
Confidence: High

### Payslips
Capability: Payslip per employee per paid month, visible to the employee
Status: COMPLETE
Evidence: EV-4023, EV-4024
Files: src/lib/documents/types.ts:925-1003, src/lib/documents/service.ts:1207-1256, src/app/api/portal/route.ts:94-98
Observed behavior: official numbered PAYSLIP document auto-issued once the month is PAID (sweep retries); portal lists own non-draft rows.
Missing pieces: portal also shows APPROVED (not yet paid) rows; issuance depends on the render service (skipped tests).
Risk: Low
Confidence: Medium

### Payroll history and reports
Status: PARTIAL
Evidence: EV-4034, EV-4002, EV-4021
Observed behavior: stored rows per month with breakdown columns, month summaries, export.
Missing pieces: no salary history from direct edits (EV-4021); no GL/journal export, no cost-centre report.
Confidence: Medium

### Bank / WPS / Mudad file
Status: MISSING
Evidence: EV-4022, EV-4035
Observed behavior: .xlsx is explicitly "not a WPS file"; salaryPaymentMethod 'WPS' is a label only; IBAN validity only flagged.
Risk: High for a Saudi payroll (wage protection upload is manual outside the system)
Confidence: High

### Final settlement in payroll
Status: DISCONNECTED
Evidence: EV-4025, EV-4033, EV-4313
Observed behavior: final pay lives in Settlement (domain 18); payroll just stops from the last month. Payroll.isFinalSettlement is never set. Items left in payroll (penalties, bonuses, GOSI of the final month) are not carried into the settlement.
Risk: High
Confidence: High

### Money type and rounding
Status: PARTIAL
Evidence: EV-4001
Observed behavior: all amounts are Float; every computed amount is rounded to halalas and summed in integer cents; tests (money.test.ts) cover it.
Missing pieces: no Decimal columns; correctness depends on every writer calling roundMoney. Acceptable at SAR scale but not auditable-by-type.
Risk: Medium
Confidence: High

## Business rules
| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Daily rate = monthly wage / 30 | Company convention | payroll-core.ts:182-184 | payroll.test.ts rates | 09, 16, 18, 08 | No, but calendar proration used alongside (EV-4007) |
| Proration by calendar days of month | Code | payroll-core.ts:363-381 | payroll.test.ts:220 | 09 | Conflicts with settlement final month (EV-4311) |
| Overtime = basic hourly x 1.5 (2.0 weekend) default | Company setting | payroll-core.ts:235-310 | payroll.test.ts:76-164 | 09, 18 | No |
| GOSI base basic+housing, 1,500-45,000, dated rates | GosiRate table | gosi.ts:86-227; migration 5 | x-X-PAYROLL-gosi | 09, 22 | Legacy path in payroll-core.ts:530-548 |
| Sick leave 30 full / 60 at 75% / rest unpaid per year | Labor Law art. 117 | payroll-core.ts:444-527 | payroll.test.ts:328 | 08, 09 | Also leave.ts (domain 08) |
| Penalty <= 5 days wage per violation | art. 70 (per code comment) | finance.ts:56-63 (enforced), payroll-core.ts:711 (monthly flag) | c2-discipline | 09, 16 | Yes (two places) |
| Loan installment <= 10% ; deductions <= 50% | art. 92/93 | payroll-core.ts:713-765 flags only | payroll tests | 09, 16 | No |
| Month locked after approval | Code | payroll.ts:405-414 | none (DB) | 09 | No |

## Edge cases checked
- Mid-month joiner/leaver: prorated by calendar days (EV-4007); leaver by terminationDate or EOS settlement (EV-4033).
- Mid-period salary change: whole month at the current salary, no split (EV-4020).
- Backdating: backdated raise after approval produces no arrears (EV-4019, EV-4020).
- Terminated after draft generation (direct PATCH): draft is not flagged stale (EV-4037).
- Deductions above net: net clamped 0, penalties still marked linked (EV-4013).
- Multi-company: single tenant-wide run, no company scope on routes (EV-4003, EV-4327).
- Ramadan: payroll uses a single workHoursPerDay setting; `grep -i ramadan src/lib/payroll*.ts` no match, so Ramadan-hours overtime is not modelled (EV-4008 context).
- Timezone: dates handled as date-only UTC keys; weekend by getUTCDay (payroll-core.ts:210-214). No defect found.

## Scorecard
| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 09 Payroll | 18 | 3 | 10 | 0 | 0 | 3 | 0 | 0 | 2 | 0 | 0 | No attendance->payroll; no maker-checker; no per-company run; no WPS file; no retro; overtime default basis | High |

## Adversarial verification
Verifier pass on 2026-09-27 (read-only). Each finding re-opened at the cited lines and attacked with repo-wide searches.

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| D-1 Attendance -> payroll | ADJUSTED (severity) | DISCONNECTED / High (was Critical) | Confirmed: no payroll or job reads Attendance; attendance stores late/early/overtime minutes but never creates Deduction or OvertimeRequest rows (EV-4900). Severity lowered to High because a designed manual bridge exists (penalties and payroll screens call CREATE_DEDUCTION, category ATTENDANCE, days x daily rate). This matches this report's own Risk line. |
| D-2 Maker-checker on payroll | CONFIRMED | PARTIAL / High | enforceMakerChecker is used only for payment requests and settlement payment, never in payroll-hub; APPROVE_DRAFTS with markPaid approves and pays in one transaction (EV-4901, EV-4016). HR_MANAGER can also generate and approve. |
| D-3 Per-company runs | CONFIRMED | PARTIAL / High | No companyId on Payroll, generation selects all employees, no company filter anywhere in payroll. The only split is a legal-company column in the review .xlsx. UserCompanyScope is a documents-only concept, so the gap is system-wide, not payroll-specific (EV-4902). |
| D-4 Bank / WPS / Mudad file | CONFIRMED | MISSING / High | Every WPS/Mudad hit is a label or the "not a WPS file" note; no SIF or bank file writer exists (EV-4903). |
| D-5 Retro / mid-month change | CONFIRMED | MISSING / High | Only change-orders.ts writes SalaryChange and payroll never reads it; the current salary is used for the whole month. The only workaround is a manual one-off bonus (EV-4904). |
| D-6 Overtime default basis | CONFIRMED | PARTIAL / High | Column default 'BASIC' in schema and migration 9a; TOTAL_PLUS_HALF_BASIC is an opt-in company setting (EV-4905, EV-4008). |
| D-8 Final settlement / final payroll | CONFIRMED | DISCONNECTED / High | Settlement creation reads allowances, leaves and overtime only; open deductions, unpaid bonuses and final-month GOSI are left to HR-typed manual fields (EV-4906). New detail: payroll skips the employee as soon as a non-rejected END_OF_SERVICE settlement exists, even before owner approval (EV-4907). isFinalSettlement has only the schema default as writer. |
| D-9 Final-month salary in settlement | ADJUSTED (severity) | PARTIAL / Medium (was High) | Code confirmed (settlement.ts:273, day-of-month x wage/30, no HR override). Severity lowered: the error is at most about 1/30 over or 2/30 under one month's wage, and the 30-day month is a common Saudi convention; the real defects are the 31st, February and same-month joiners (EV-4908). |
