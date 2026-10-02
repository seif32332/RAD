# Missing and defective capabilities, by priority

Scope: capabilities whose final status after adversarial verification is MISSING, DISCONNECTED, BROKEN, UNSAFE, or PARTIAL with a material gap.

**How priority was set.** Priority is the severity the adversarial verifier gave the finding, not the specialist's first rating and not a preference. Where no verifier ran (Medium and Low items), the specialist's rating stands. Several first ratings were lowered by the verifiers; the "Verified" column notes each change.

- **Critical**: statutory, financial or security exposure with no in-product workaround.
- **High**: the core lifecycle is broken, or it works only through manual re-entry that has a financial, legal or security cost.
- **Medium**: a standard HR capability is absent, or a control is weak, with limited direct exposure.
- **Low**: convenience features and hygiene.
- **Optional**: absent by explicit design decision.

## Critical

| # | Capability | Domain | Why | Status | Evidence | Verified |
|---|---|---|---|---|---|---|
| C1 | WPS / Mudad salary file (SIF generation, reconciliation) | 09, 10 | Wage protection requires the bank/Mudad upload. "WPS" is only a payment-method label; the only export says it is **not** a WPS file. | MISSING | EV-4022, EV-5002, EV-5003 | Confirmed Critical (E-1); Confirmed (D-4) |
| C2 | Absence detection, and attendance-driven absence/lateness deductions | 07, 09 | No code writes `ABSENT`, and payroll never reads `Attendance`. Absences are paid unless someone types a manual penalty, and absence KPIs always read 0. | MISSING + DISCONNECTED | EV-3009, EV-3022, EV-3023, EV-4004, EV-4005, EV-4006 | C-2 confirmed Critical; C-1 confirmed Critical. D-1 verifier lowered to High because a manual penalty route exists. Kept Critical: two of three verdicts, and the workaround needs every absence to be keyed by hand. |

## High

| # | Capability | Domain | Why | Status | Evidence | Verified |
|---|---|---|---|---|---|---|
| H1 | Payroll segregation of duties (generator ≠ approver ≠ payer; `generatedBy`/`approvedBy` columns) | 09, 24 | One FINANCE_MANAGER / PAYROLL_ADMIN / COMPANY_ADMIN user can generate, approve and mark a month paid in one call. | MISSING | EV-4016, EV-4017, EV-9034 | Confirmed (D-2, I-3) |
| H2 | Company isolation inside a tenant (company-scoped HR/payroll/finance queries, per-company payroll run, company-scoped admin) | 09, 24, 25 | `UserCompanyScope` is enforced only by the document engine. Payroll has no `companyId`, so one month is generated and approved for all legal entities together. | PARTIAL | EV-4002, EV-4003, EV-9017, EV-9018, EV-9019, EV-9072 | Confirmed (D-3, I-1). High only for multi-company tenants. |
| H3 | Multi-factor authentication | 24 | `twoFactorEnabled`/`twoFactorSecret` columns exist but are unused. A single password protects national IDs, IBANs, salaries and government-portal passwords. | MISSING | EV-9010 | Confirmed (I-2) |
| H4 | Final settlement completeness: final-month GOSI, open deductions, unpaid bonuses, last-month unpaid leave | 18, 09 | Not in `computeSettlement`. Payroll drops the employee once any non-rejected END_OF_SERVICE settlement exists, so these items are never settled. | DISCONNECTED | EV-4313, EV-4033, EV-4025 | Confirmed (D-8) |
| H5 | Art. 77 compensation and notice pay-in-lieu in the payable settlement | 18, 10 | Computed only in the workforce exit-cost estimate; HR must type it as a manual entitlement. | DISCONNECTED | EV-4314, EV-5044 | D-11 adjusted to DISCONNECTED/High; E-3 lowered the notice part to Medium (a TERMINATION_NOTICE letter exists) |
| H6 | Separation request → termination / settlement link; resignation withdrawal | 18 | Approving a TerminationRequest only stores the last working day. Nothing terminates the employee, opens a settlement or revokes access on that date. No withdrawal endpoint exists. | DISCONNECTED | EV-4303, EV-4304, EV-4305, EV-12021 | Confirmed (D-10) |
| H7 | Retroactive and mid-month salary changes, payroll reversal | 09 | Payroll uses the live `basicSalary` for the whole month. No arrears, no split, no reversal of an approved month. | MISSING | EV-4018, EV-4019, EV-4020, EV-12001 | Confirmed (D-5) |
| H8 | Leave → attendance: `ON_LEAVE` handling | 07, 08 | Approved Leave rows are ignored. `ON_LEAVE` is set only by a paid leave settlement and never cleared, so every later punch is FLAGGED. | BROKEN | EV-3016, EV-3017 | Confirmed (C-3) |
| H9 | Backdated leave against finalised payroll months | 08, 09 | Deductions falling in an APPROVED/PAID month are silently lost. Overtime has a carry-over; leave has none. | DISCONNECTED | EV-3047, EV-3045 | Confirmed (C-5) |
| H10 | Leave encashment tied to the balance | 08, 18 | A LEAVE_SETTLEMENT has no Leave link and never reduces the balance, so the same days can be taken or encashed again. | PARTIAL | EV-3053 | Confirmed, strengthened (C-6) |
| H11 | Public holidays, Ramadan reduced hours, 48 h/week limit, rest-day calendar | 07, 08, 10 | Nothing is modelled. `WorkSchedule.workDays` is never read. Ramadan lateness and overtime are computed against the normal shift. | MISSING | EV-3006, EV-3007, EV-5046, EV-5047, EV-5048 | Confirmed (C-7, E-4) |
| H12 | Sick-leave tier history (art. 117) | 08 | Leaves that straddle the 12-month window are counted in full, which pushes employees into the 75% and unpaid tiers early. No medical certificate is stored. | PARTIAL | EV-3033, EV-3050 | Adjusted, kept High (C-8) |
| H13 | Timesheets and attendance export | 07 | The only HR list is the latest 500 rows tenant-wide, with no period filter and no export. | PARTIAL | EV-3010 | Confirmed (C-9) |
| H14 | Overtime controls (attendance cross-check, caps, maker-checker, termination check) | 07, 09 | Hours are typed by hand, including the "BIOMETRIC" type. PAYROLL can create overtime already APPROVED. No caps. | PARTIAL | EV-3024, EV-3025, EV-3026, EV-3062, EV-3066 | Confirmed (C-10) |
| H15 | Overtime default basis (art. 107 reading) | 09, 10 | The default is basic × 1.5; the "hourly wage + 50 % of basic" basis is opt-in per company. The legal reading needs counsel. | PARTIAL | EV-4008, EV-3027 | Confirmed (D-6) |
| H16 | Biometric terminal integration or import | 07 | `biometricId` is a manual reference, and the UI says the system does not connect to devices. | MISSING | EV-3008 | Confirmed (C-11) |
| H17 | Qiwa and GOSI platform integrations | 10 | No client, URL or env var. Qiwa is a manual checkbox and GOSI is an internal calculator. | MISSING | EV-5001, EV-5004, EV-5005 | Confirmed (E-7) |
| H18 | Muqeem verified against the real Elm service | 10 | The client is real and guarded but was tested only against a local mock; the contract tests are skipped. | PARTIAL | EV-5013, EV-5018, EV-5019 | Confirmed (E-5) |
| H19 | Candidate → employee / onboarding conversion | 05, 06 | HIRED creates nothing: no FK, no prefill. Offer terms are re-keyed. | DISCONNECTED | EV-2022, EV-2023, EV-2013 | B-1 lowered from Critical to High |
| H20 | Legal company on employees created by onboarding | 06, 04 | `approveOnboarding` sets no `legalCompanyId`, so every official document, including the automatic work-commencement notice, is refused or skipped until HR edits the file. | DISCONNECTED | EV-0026, EV-0027, EV-12008 | Orchestrator tie-break (verified in code) |
| H21 | Business-event notifications, and actual e-mail delivery | 20, 19 | No SMTP provider is chosen and `OUTBOX_SEND` is off, so nothing is delivered. Leave rejection, payments, transfers, corrections, assets, loans and owner requests notify no one. Enabling SMTP would first send a stale backlog, because the outbox has no TTL. | PARTIAL | EV-8017, EV-8019, EV-8020, EV-8021, EV-0014 | H-1 lowered to High; H-4 confirmed High |
| H22 | Loan disbursement maker-checker and loan caps | 16 | A PAYROLL+FINANCE user can clear the HR, transfer and final stages, including on their own loan. No 10 % cap. The payment-request branch for loans is dead code. | PARTIAL | EV-4202, EV-4203, EV-4204, EV-4214 | Confirmed (D-12) |
| H23 | Two uncoordinated transfer mechanisms (TransferRequest vs TRANSFER_DECISION) | 02, 25 | Both write `branchId` with no mutual guard, and neither updates `legalCompanyId`/`actualCompanyId`. Nitaqat, GOSI establishment and letterheads stay on the old company. | DISCONNECTED | EV-1038, EV-1039, EV-1012, EV-12015, EV-12016 | A-7 confirmed High (TRANSFER_DECISION exists only in uncommitted work) |
| H24 | Employee history / timeline view | 01 | SalaryChange and change orders are recorded but never shown. Direct edits through `PUT /api/employees/[id]` write no SalaryChange, and the audit log keeps only field names. | PARTIAL | EV-1008, EV-1009, EV-1010, EV-1011 | Adjusted, kept High (A-2) |
| H25 | Learning and development (entire domain) | 14 | No catalog, enrollment, certificates, skills or cost. Known and deprioritised in docs/council-domain/PANELS.md:36. | MISSING | EV-7021 .. EV-7026 | Confirmed (G-2) |
| H26 | CI actually running on the development branch | 29, 28 | `ci.yml` triggers on pushes to `main`; the repository only has `master` and is developed by direct commits, so tests, drift check, secret scan and AI gate do not run automatically. | UNSAFE | EV-0021, EV-10104, EV-10105, EV-10106 | J-1 lowered from Critical to High |
| H27 | Off-site, encrypted backups | 29 | Backups are local and unencrypted; the off-site copy is opt-in per tenant and unset by default. | PARTIAL | EV-10108, EV-10109, EV-10110, EV-10111 | J-4 lowered from Critical to High |
| H28 | Tested restore | 29 | No automated or recorded restore test exists; the monthly drill in the readiness plan is unchecked. | PARTIAL | EV-10112, EV-10113 | J-5 lowered from Critical to High |
| H29 | Scheduled jobs actually enabled | 29 | RUNBOOK enables only 4 of 7 job timers. apply-employee-changes, documents-integrity and documents-retention are never enabled. | PARTIAL | EV-10114, EV-10115, EV-10116, EV-10117, EV-10908 | Worse than stated (J-9) |
| H30 | Route-handler tests with real auth; DB-integration and E2E tests in CI | 28 | About 140 of 149 API routes have no handler test, and auth is mocked where one exists. The only DB+render E2E suite is opt-in and not in CI. No browser tests. | PARTIAL / MISSING | EV-10006, EV-10008, EV-10012, EV-10015, EV-10025 | J-3, J-6, J-8 confirmed High |

## Medium

| Capability | Domain | Status | Evidence |
|---|---|---|---|
| Medical insurance enrollment per employee (policy link, member no., dates), dependants, contribution, CCHI | 15 | PARTIAL (class tier only) / MISSING | EV-4101, EV-4103, EV-4104, EV-4107 (D-13 adjusted to PARTIAL/Medium) |
| Unpaid/sick leave deduction rate basic/30 vs payroll's documented (basic+allowances)/30 | 08, 09 | PARTIAL (under-deducts, in the employee's favour) | EV-3035, EV-3036, EV-3037 (C-4) |
| Final-month salary uses day-of-month × wage/30 | 18 | PARTIAL | EV-4311 (D-9) |
| Statutory deduction caps (arts. 70/92/93) enforced, not only flagged | 09 | PARTIAL | EV-4012, EV-4038 |
| Emergency contacts | 01 | MISSING | EV-1002 (A-1 lowered to Medium) |
| Dependents as structured records | 01, 15 | MISSING | EV-1003 |
| Custom fields, employee notes log | 01 | MISSING | EV-1004, EV-1005 |
| Position / grade / level / cost-center entities | 02 | MISSING | EV-1021 |
| Org chart | 02 | MISSING | EV-1023 |
| Onboarding checklist / task tracking | 06 | MISSING | EV-2010, EV-2011, EV-2017 (B-2 lowered to Medium) |
| Version history for uploaded personal documents | 04 | MISSING | EV-2001 |
| Candidate scoring / assessments | 05 | MISSING | EV-2020, EV-2027 |
| Self-assessment, 360, calibration, PIP | 13 | MISSING | EV-7010 .. EV-7013 |
| Evaluation recommendation → change order (link and prefill) | 13 | DISCONNECTED | EV-7014 (G-3 lowered to Medium) |
| Server-side custody/loan warning on direct terminate (UI says "cannot terminate") | 17, 18 | PARTIAL | EV-7033, EV-7034 (G-1 lowered; clearance certificate is blocked server-side) |
| Vehicles and utility meters in the custody workflow | 17 | PARTIAL | EV-7030 |
| Approval delegation, escalation, SLA, reminders | 19 | MISSING | EV-8014 |
| Self-approval guard beyond payments (leave/corrections checked; transfers, evaluations unknown) | 19 | UNKNOWN | EV-8006, EV-3065 |
| Persisted in-app notifications with read state | 20 | PARTIAL | EV-8023 (H-2 adjusted from MOCKED) |
| SMS / WhatsApp / web push | 20, 26 | MISSING | EV-8024, EV-8025, EV-6018 |
| Configurable permissions actually enforced (RolePermission is menu-only) | 24 | UI_ONLY | EV-9016 |
| Finance roles can download identity, passport and health files | 24 | PARTIAL | EV-9020, EV-9023 |
| Immutable, fail-safe audit log; VIEW audit of full employee records | 24 | PARTIAL | EV-9038, EV-9039 |
| Persistent login lockout (throttle resets on restart) | 24 | PARTIAL | EV-9008 |
| Encryption at rest for national ID, IBAN, salary, uploads | 24 | PARTIAL | EV-9035, EV-9036 |
| Global CSP and Origin check | 24 | PARTIAL | EV-9030, EV-9031 |
| Cascade deletes from Employee to statutory history | 25 | PARTIAL | EV-9050, EV-9052 |
| Company-deletion guard misses cascade-deleted planning/scope tables | Platform/DB | PARTIAL | EV-11005, EV-11006 |
| DB enforcement (enum/CHECK) for ~35 string status columns | Platform/DB | PARTIAL | EV-11008, EV-11009, EV-11010 (K-2 lowered) |
| Money columns as Decimal (all 88 are Float; mitigated by halala rounding in money.ts) | Platform/DB | PARTIAL | EV-11002, EV-11003, EV-4001 (K-1 lowered from UNSAFE/Critical) |
| Labour-law parameter register read by operational code (payroll/settlement use their own constants) | 10 | DISCONNECTED | EV-5045, EV-5042, EV-5043 (E-2 lowered) |
| Notice periods in the settlement | 10 | PARTIAL | EV-5044, EV-5041 (E-3) |
| Government-portal credential vault scoped by company | 10 | PARTIAL | EV-5021, EV-5022 (E-6) |
| Nitaqat reference data seeded on new tenants | 10 | PARTIAL | EV-5023 .. EV-5028 |
| GOSI for GCC nationals | 10 | PARTIAL | EV-5083 |
| PDPL data-subject rights, processing register, master-data retention | 10 | PARTIAL | EV-5058 .. EV-5061 |
| Workforce plan → requisitions / budget / execution | 22 | DISCONNECTED | EV-5063, EV-5068, EV-5070 (E-10 lowered) |
| Workforce cost screens scoped by legal company | 22 | PARTIAL | EV-5073, EV-5074 |
| Leave calendar / team availability; carry-forward cap; per-company leave policy; iddah leave | 08 | MISSING | EV-3051, EV-3031, EV-3048, EV-3049 |
| Late return from leave converted to absence or unpaid days | 08 | PARTIAL | EV-3043 |
| Attendance corrections: date window, evidence | 07 | PARTIAL | EV-3019, EV-3020, EV-3021 |
| Rotating shifts / rosters; schedule by FK instead of name | 07 | MISSING | EV-3005, EV-12018 |
| Visa `returnBefore` overstay alert; leave–visa link by FK | 08, 10 | MISSING | EV-12011, EV-12013 |
| Expiry e-mail digest covering contract, probation, leave, notes; employee-facing reminders | 04, 20 | PARTIAL | EV-12014 |
| Expense / reimbursement / travel claims | 16 | MISSING | EV-4207, EV-4208 |
| Exit interview and departmental clearance workflow | 18 | MISSING | EV-4318, EV-4321 |
| Absenteeism rate over a period | 21 | MISSING | EV-7050 |
| English UI / i18n | 27 | MISSING | EV-6019, EV-6020 |
| Hijri display of employee-facing dates | 27 | PARTIAL | EV-6021, EV-6022 |
| requireUser role-branch tests; proxy tests; manager-scope boundary tests | 28 | PARTIAL / MISSING | EV-10016, EV-10017, EV-6029 (J-2, J-7, F-1 lowered to Medium) |
| Face-service tests in CI | 28 | DISCONNECTED | EV-10023, EV-10024 |
| Pagination of HR pending-request queues | 30 | PARTIAL | EV-6026 |
| Circulars scoped by company | 11 | PARTIAL | EV-6027 |

## Low

| Capability | Domain | Evidence |
|---|---|---|
| Recruitment funnel analytics; talent pool | 05 | EV-2026 |
| Commissions earning type | 09 | EV-4029 |
| Demand / capacity modelling | 22 | EV-5070 |
| Self-service password reset | 24 | EV-9012 |
| Per-employee audit rows for Excel import | 01 | EV-1027 |
| Route-specific error boundaries | 30 | EV-6023, EV-6038 |
| Remove or wire the dead `CompanyDocument` model | Platform/DB | EV-11016 |
| FKs for actor/reference columns (`createdById`, `paidInPayrollId` …) | Platform/DB | EV-11021, EV-11007 |
| Explicit renewal counter (art. 55 fixed-to-unlimited conversion) | 03 | EV-1032 (A-9 refuted as a High gap: the contract type is correctly derived from `contractEndDate`) |

## Optional

| Capability | Why optional | Evidence |
|---|---|---|
| LLM / AI assistant | Excluded by decision DEC-006 and enforced in CI. Not a gap against the product's own decisions. | EV-0018, EV-8028, EV-8029, EV-8030 |
