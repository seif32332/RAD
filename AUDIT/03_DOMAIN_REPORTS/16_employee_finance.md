# 16 Employee finance

## Scope and method
Read `src/lib/finance.ts` (loan, deduction, settlement state machines), loan/deduction/bonus handlers in `src/app/api/payroll-hub/route.ts`, `src/app/api/payments/**` including `maker-checker.ts` and `access.ts`, owner-portal payment approval, `Loan`/`LoanInstallment`/`Deduction`/`PaymentRequest`/`AccidentClaim` models, and loans/penalties/payments pages (API calls only). Ran r3-payroll-loans, x-security-maker-checker tests (EV-4026, EV-4211). Traced Request -> Approval -> Financial record -> Payroll for loans and deductions.

## Capability findings

### Loans / salary advances
Capability: Employee or HR requests a loan, multi-stage approval, disbursement, installments via payroll
Status: PARTIAL
Evidence: EV-4201, EV-4202, EV-4203, EV-4204, EV-4205, EV-4206, EV-4214, EV-4027
Files: src/lib/finance.ts:106-345; src/app/api/payroll-hub/route.ts:702-760; src/app/api/owner-portal/payments/route.ts:104-116; src/app/api/incoming-requests/route.ts:761
Functions/classes: approveLoanStep, rejectLoan, markLoanTransferred, forgiveLoan, settleEmployeeLoans
DB tables: Loan, LoanInstallment
API routes: POST /api/payroll-hub (CREATE_LOAN, APPROVE_LOAN, REJECT_LOAN, FORGIVE_LOAN); /api/owner-portal/payments; /api/incoming-requests
UI routes: /loans, /payrolls, /portal, /owner-portal
Tests: r3-payroll-loans.test.ts (stage tables, settlement formula); no DB test of the chain
Observed behavior: PENDING -> MANAGER_APPROVED -> HR_APPROVED -> FINANCE_TRANSFERRED (receipt) -> FINANCE_APPROVED; guarded updates, audit each step; installments collected by payroll, balance reduced at approval, loan completed at 0; forgiveness and settlement payoff.
Missing pieces: no installment cap (10%) or maximum at request time (EV-4203); disbursement is a receipt URL with no PaymentRequest / maker-checker (EV-4204); same PAYROLL+FINANCE user can clear HR, transfer and final stages, and nothing stops a payroll user acting on their own loan (EV-4214).
Risk: High (SoD on cash out)
Confidence: High

### Installment schedule
Status: PARTIAL
Evidence: EV-4201, EV-4205
Observed behavior: flat monthlyInstallment; LoanInstallment rows exist only per generated payroll; no forward schedule, no pause/reschedule.
Confidence: High

### Deductions (penalties) request -> approval -> payroll
Status: PARTIAL
Evidence: EV-4212, EV-4213, EV-4013, EV-4012
Files: src/app/api/payroll-hub/route.ts:476-700; src/lib/finance.ts:346-445
Observed behavior: per-violation 5-day cap enforced (400); HR > 1 day or manager-issued needs amount approval; objection, investigation referral, waive; draft reservation released when waived.
Missing pieces: monthly caps only flagged; uncollected amounts marked linked when net clamps (EV-4013).
Risk: Medium
Confidence: High

### Payment requests with maker-checker
Capability: Generic payment request (renewals, visas, settlements) with owner approval and finance payment
Status: COMPLETE
Evidence: EV-4209, EV-4210, EV-4211
Files: src/app/api/payments/route.ts, [id]/route.ts, maker-checker.ts, access.ts; src/app/api/owner-portal/payments/route.ts
DB tables: PaymentRequest, AuditLog
UI routes: /payments, /owner-portal
Tests: x-security-maker-checker.test.ts, r3-finance-payment-delete.test.ts
Observed behavior: PENDING_OWNER -> PENDING_FINANCE -> PAID, requester cannot approve/pay own request, override audited, receipt required, linked requests not deletable.
Missing pieces: settlement payment requests are created with requestedById = approvedById = owner (EV-4316), so the checker is effectively "finance user != approver". No DB test.
Risk: Low
Confidence: High

### Expenses / reimbursements / claims
Status: MISSING
Evidence: EV-4207, EV-4208
Observed behavior: no expense model, no receipt claim flow, no reimbursement to payroll. The "claims" module (AccidentClaim) is a vehicle insurance claim tied to vehicleId.
Risk: Medium (common HR finance need)
Confidence: High

### Travel expenses / per diem
Status: MISSING
Evidence: EV-4215
Confidence: High

### Employee finance -> payroll integration
Status: PARTIAL
Evidence: EV-4205, EV-4013, EV-4036
Observed behavior: loans, penalties and bonuses reach payroll; no reimbursement or "other" line (hard-coded 0).
Confidence: High

## Business rules
| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Loan approval chain | Code (finance.ts header) | finance.ts:121-206 | r3-payroll-loans | 16, 09, 12 | No |
| Installment <= amount | Code | payroll-hub/route.ts:711 | none | 16 | No |
| Installment <= 10% of wage | art. 92 (code comment) | payroll-core.ts:713, 755 (flag only) | payroll tests | 09, 16 | No |
| Penalty <= 5 days wage | art. 70 (code comment) | finance.ts:56-63 | c2-discipline | 16, 09 | Yes (monthly flag too) |
| Requester != approver/payer | DEC maker-checker | payments/maker-checker.ts:20-55 | x-security-maker-checker | 16, 18 | No |
| Loan outstanding deducted at settlement | Code | settlement.ts:389-398, finance.ts:297-345 | r3-payroll-loans | 16, 18 | No |

## Edge cases checked
- Terminated employee requesting a loan: refused (EV-4203).
- Loan while a settlement is pending: outstanding balance netted in settlement, draft installments of earlier months kept (EV-4206).
- Net too small for installment: installment reduced, rest stays on loan (EV-4205).
- Self-approval by a payroll user on own loan: not blocked (EV-4214).
- Multi-company: no company scope on loan/payment routes (EV-4327).

## Scorecard
| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 16 Employee finance | 7 | 1 | 4 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | Loan SoD / disbursement outside maker-checker; no expenses/reimbursements | High |

## Adversarial verification
Verifier pass on 2026-09-27 (read-only).

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| D-12 Loans | CONFIRMED | PARTIAL / High | Stage table (finance.ts:121-153) lets one PAYROLL+FINANCE user run the HR stage, the transfer and the final approval; assertLoanScope applies to managers only, so a PAYROLL_ADMIN can approve their own loan; CREATE_LOAN has no 10% or maximum check. New evidence: payments/[id] contains a LOAN branch that would route disbursement through the maker-checker PaymentRequest, but nothing creates a LOAN-linked PaymentRequest, so that path is dead and the live path is a receipt URL (EV-4911). |
