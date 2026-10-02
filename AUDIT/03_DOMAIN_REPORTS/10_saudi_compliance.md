# 10 Saudi compliance

## Scope and method
Read `AUDIT/SYSTEM_MAP.md`, then searched the whole of `src`, `scripts` and `prisma` for every Saudi platform name (qiwa, mudad, wps, sif, gosi api, absher, tamm, nitaqat, hijri) and for labour-law rules (notice, probation, ramadan, weekly hours, holiday, 720 h cap). I read the relevant ranges of `src/lib/gosi.ts`, `src/lib/muqeem/*` (config, client, transactions, hijri), the Muqeem API routes, `src/lib/settlement.ts`, `src/lib/leave.ts`, `src/lib/termination.ts`, `src/lib/employee-shared.ts`, `src/lib/alerts.ts`, `src/app/api/compliance`, `src/app/api/gov-platforms` and `src/lib/workforce/{nitaqat,exit-cost,rules}.ts`. I also read the GosiRate and RuleParameter seed SQL (migrations `5_*`, `9_workforce_engine`, `9c_*`). I ran these 6 test files on 2026-09-27: 103 passed, 5 skipped (EV-5076). Legal values that come from my own knowledge are flagged as such (EV-5085). No official source was fetched in this pass.

## Capability findings

### Qiwa integration
Capability: Qiwa integration (contract documentation, work permits, Nitaqat reading)
Status: MISSING
Evidence: EV-5001, EV-5084
Files: src/app/api/employees/_workforce-fields.ts:183-184; prisma/schema.prisma:413-414; src/lib/workforce/nitaqat.ts:14-17
Functions/classes: none (no client)
DB tables: Employee.qiwaContractDocumented / qiwaContractDocumentedAt (manual flags)
API routes: none
UI routes: the employee form field only
Tests: wf-data-employee-fields.test.ts (field validation only)
Observed behavior: HR ticks a manual "العقد موثّق في قوى" checkbox and enters a date. The Nitaqat estimate counts an undocumented Saudi as 0.
Missing pieces: an HTTP client, contract push/pull, a work-permit link and a Nitaqat read-back from Qiwa.
Risk: the Nitaqat estimate depends on a manual flag that nothing checks. If the flag is stale, the band shown is wrong.
Confidence: High

### GOSI contribution calculation (payroll)
Capability: Employee and employer GOSI contributions in payroll
Status: COMPLETE
Evidence: EV-5005, EV-5006, EV-5007, EV-5008, EV-5009, EV-5010, EV-5011, EV-5076
Files: src/lib/gosi.ts; src/lib/payroll-core.ts:563-571, 856-868; migrations 5_*:142-156, 9_workforce_engine:113-118
Functions/classes: calculateGosi, pickGosiRate, gosiBaseWage
DB tables: GosiRate, Employee.gosiRegime, Allowance.countsTowardGosi
API routes: payroll generation (group D)
UI routes: /payrolls
Tests: x-X-PAYROLL-gosi.test.ts (15 tests, passed)
Observed behavior: rates come from dated rows and are picked by the first day of the month. OLD Saudi is 9.75/11.75 (9% annuities + 0.75% SANED, plus employer 2% hazards). Non-Saudi is 0/2. The NEW regime (from 2024-07-03) adds +0.5/side every 1 July 2025-2028. The wage is clamped to 1,500-45,000. An UNKNOWN regime falls back to OLD with a review flag. The rates match my own knowledge of the GOSI rules (flagged, EV-5085), and the migration cites primary sources (EV-5007).
Missing pieces: GCC nationals (see the next block). The minimum wage for the NEW regime is still PROVISIONAL (EV-5081).
Risk: Low for the calculation itself. The employee default regime is UNKNOWN (EV-5011), so a Saudi hired after 2024-07-03 is priced at OLD rates until HR sets the regime. The line is flagged, not blocked.
Confidence: High

### GOSI platform integration
Capability: Registering and deregistering employees, syncing wages, reconciling invoices with GOSI
Status: MISSING
Evidence: EV-5004, EV-5005
Files: none
Observed behavior: GOSI exists only as a pure calculator. Joining, leaving and wage changes are never reported to GOSI, and the GOSI invoice is never reconciled with payroll.
Risk: High. The system cannot show that GOSI registration matches payroll, and a wage change needs a manual update on the GOSI portal.
Confidence: High

### GOSI for GCC nationals
Capability: Contributions for GCC (non-Saudi Gulf) nationals
Status: PARTIAL
Evidence: EV-5083
Files: src/lib/gosi.ts:72-77; src/lib/nationality.ts:137-160
Observed behavior: `isSaudiForGosi` returns true only for Saudis, so a GCC national goes to the non-Saudi row (employer 2% only). Nitaqat, by contrast, has a GCC class.
Missing pieces: rates for GCC nationals under the GCC social-insurance extension. From my own knowledge (flagged), the employer pays contributions for these employees under their home-country scheme.
Risk: Medium. Contributions for GCC employees are understated.
Confidence: Medium

### WPS / Mudad salary file
Capability: Producing the Wage Protection System / Mudad salary file (SIF) and reconciling its result
Status: MISSING
Evidence: EV-5002, EV-5003
Files: src/app/api/payroll-hub/export/route.ts:17-18; src/lib/employee.ts:539, 832-833
Observed behavior: 'WPS' exists only as a payment-method label. The only payroll export states that it is not a WPS file.
Missing pieces: a WPS/SIF generator, bank formats, Mudad upload and status, and a compliance-rate check.
Risk: Critical for a Saudi payroll product. Every WPS submission is manual work outside the system, with no traceability from the payroll run to the file that was submitted.
Confidence: High

### Nitaqat / Saudization estimate
Capability: Nitaqat Mutawar band estimate per legal company
Status: PARTIAL
Evidence: EV-5023, EV-5024, EV-5025, EV-5026, EV-5027, EV-5028, EV-5029, EV-5084
Files: src/lib/workforce/nitaqat.ts; src/app/api/workforce/nitaqat/route.ts; src/app/api/workforce/saudization/*; scripts/seed-nitaqat.mjs; prisma/data/nitaqat-2026/*
Functions/classes: nitaqatEstimate, curveSetFor, capRules
DB tables: NitaqatActivity, NitaqatCurve, Company.nitaqatActivityKey, Employee flags (disabled, student, part-time, qiwa)
API routes: GET/POST /api/workforce/nitaqat, GET /api/workforce/saudization, POST /api/workforce/saudization/solve
UI routes: /workforce/saudization, /workforce/nitaqat-register
Tests: wf-nitaqat (20), wf-saudization (16)
Observed behavior: a detailed, deterministic estimate built from real employee data. It covers weights, caps, the Qiwa documentation gate and the 26-week average, and it flags every assumption. The code itself says the official reference is Qiwa.
Missing pieces: the curve tables start empty (the migration inserts nothing, EV-5024). They are filled only by running `scripts/seed-nitaqat.mjs --apply` by hand, and no deploy or new-tenant step runs it (EV-5025). There is no Qiwa read-back to check the estimate, and several categories are not modelled (EV-5023).
Risk: on a fresh tenant the screens show no band until someone seeds the curves or enters them. The estimate may differ from Qiwa, which the UI does disclose.
Confidence: High

### Localization (occupation Saudization) decisions
Status: PARTIAL
Evidence: EV-5079, EV-5024, EV-5025
Observed behavior: the decisions register and the compliance solver exist. The data comes only from the manual seed or in-app entry. The result is an estimate that is not enforced on hiring (a JobRequest does not check it).
Risk: Medium.
Confidence: Medium

### Muqeem integration
Capability: Muqeem (Elm) residency services: exit/re-entry, final exit, iqama renewal, passport update, resident sync
Status: PARTIAL (classification: REAL client, reachable from the product, verified only against a local mock)
Evidence: EV-5012, EV-5013, EV-5014, EV-5015, EV-5016, EV-5017, EV-5018, EV-5019, EV-5020, EV-5076
Files: src/lib/muqeem/{config,client,transactions,errors,hijri,tx-rules,types}.ts; src/lib/muqeem-sync.ts; src/app/api/integrations/muqeem/**; src/app/api/visas/muqeem/*; src/app/api/employees/[id]/muqeem/*; src/app/api/settlements/[id]/muqeem/*; src/app/api/companies/_muqeem.ts; scripts/muqeem-mock.mjs
Functions/classes: createMuqeemClient, runMuqeemTransaction, reconcileTransaction, muqeemIdempotencyKey
DB tables: MuqeemTransaction (idempotencyKey unique), GovPlatform, Company.moiNumber / muqeemPlatformId
API routes: /api/integrations/muqeem/{status,test-connection,lookups,residents/sync,residents/apply,transactions,transactions/[id]/reconcile,transactions/interactive-report}; /api/visas/muqeem; /api/employees/[id]/muqeem; /api/settlements/[id]/muqeem
UI routes: /integrations/muqeem, /visas, /employees/[id], /settlements
Tests: muqeem-client (22), muqeem-transactions (20), mq-* (~108), muqeem-helpers (11); muqeem-mock-contract (5) skipped at audit time
Observed behavior: a real `fetch` client with timeouts, token caching and one re-authentication on 401. An ambiguous result is marked UNKNOWN_OUTCOME and blocks retries until someone reconciles it. Idempotency keys prevent a double issue. Writes need ROLE_GROUPS.GOV plus an explicit confirmation, and every result is audited. The client is off unless MUQEEM_ENABLED and three env vars are set.
Missing pieces: no proof of a call against Elm's real or sandbox endpoint. The README says it was tested only against the local mock (EV-5018), and the contract tests are skipped unless the mock is running (EV-5019).
Risk: High until it is verified live. These are irreversible government transactions, but the safety design (idempotency, UNKNOWN reconciliation) is strong.
Confidence: High

### Absher / Tamm integration
Status: MISSING
Evidence: EV-5004
Risk: Low. Muqeem covers most of the residency operations.
Confidence: High

### Government platform credential vault
Capability: Storing the organisation's government-portal credentials
Status: PARTIAL
Evidence: EV-5021, EV-5022
Files: src/app/api/gov-platforms/route.ts; prisma/schema.prisma:1925-1937; scripts/encrypt-gov-passwords.mjs
Observed behavior: passwords are encrypted with encryptField (key id supported) and legacy plaintext is migrated on update. Revealing a password is rate-limited and audited, and access is limited to SUPER_ADMIN, COMPANY_ADMIN and GOV_RELATIONS.
Missing pieces: GovPlatform has no companyId (EV-5022). Any COMPANY_ADMIN or GOV_RELATIONS user can reveal the portal passwords of every legal company in the tenant.
Risk: Medium (adjusted from High by adversarial verification, EV-5908). Access to plaintext government credentials is not scoped by company, but no other domain is company-scoped either (UserCompanyScope is read only by the documents engine), COMPANY_ADMIN is the group owner, and HR_MANAGER is excluded. The exposure is limited to a GOV_RELATIONS user meant to serve one legal company.
Confidence: High

### EOSB (end-of-service award)
Status: COMPLETE
Evidence: EV-5032, EV-5033, EV-5034, EV-5035, EV-5072
Files: src/lib/settlement.ts:34-132
Functions/classes: endOfServiceAward, yearsOfService, computeSettlement
Tests: settlement.test.ts (25, passed)
Observed behavior: art.84 rates (half a month per year for the first 5 years, a full month per year after that). Art.85 resignation fractions (0 / one third / two thirds / full). Art.80 and probation pay 0. Art.81, art.87 and contract expiry pay the full award, marked "pending counsel". Service years use days/360. The workforce engine reuses the same function (EV-5072).
Missing pieces: the art.87 and contract-expiry readings are provisional by the code's own statement. The wage base is basic + recurring allowances.
Risk: Low to Medium, pending counsel.
Confidence: High

### Working hours 48 h/week and Ramadan 36 h (art.98)
Status: MISSING
Evidence: EV-5046, EV-5047, EV-5085
Observed behavior: WorkSchedule stores shift times and flexible hours only. Nothing checks weekly hours, there is no Ramadan schedule, and there is no Muslim / non-Muslim distinction.
Risk: High. Scheduling beyond the legal limit is not detected. In Ramadan, the attendance engine uses the normal shift, so lateness, early leave and overtime are computed against the wrong hours.
Confidence: High

### Public holidays calendar
Status: MISSING
Evidence: EV-5048
Risk: Medium. Eid and National Day holidays can be counted as absences or as leave days.
Confidence: High

### Overtime annual cap (720 h)
Status: PARTIAL
Evidence: EV-5049, EV-5081
Observed behavior: the cap exists as a RuleParameter and is used in workforce estimates. Overtime requests and payroll do not enforce it or warn about it.
Risk: Medium.
Confidence: High

### Statutory leave rules
Status: COMPLETE (detail in domain 08)
Evidence: EV-5036, EV-5037, EV-5038
Observed behavior: annual leave 21/30 days, sick leave 30 full / 60 at 75% / 30 unpaid. Maternity 12 weeks, paternity 3 days, marriage 5, bereavement 5/3, Hajj 10-15 days after 2 years. Every value is company-editable and cites its source as provisional.
Risk: Low.
Confidence: Medium

### Contract term rules (fixed-term for non-Saudis)
Status: PARTIAL
Evidence: EV-5050, EV-5051
Observed behavior: a warning (art.37) appears when a non-Saudi has no contract end date. ContractType has no fixed-term / indefinite distinction.
Missing pieces: a term type on the contract, so the right notice (art.75), art.77 compensation and EOSB variant can be applied.
Risk: Medium.
Confidence: High

### Probation (art.53)
Status: PARTIAL
Evidence: EV-5039, EV-5040, EV-5081
Observed behavior: more than 180 days gives a warning only. The end date is computed only by the Excel import; the API takes a free date. There is a probation-ending alert (EV-5055).
Missing pieces: enforcement, and the written-agreement extension rule.
Confidence: High

### Notice periods (art.75)
Status: PARTIAL
Evidence: EV-5041, EV-5042, EV-5043, EV-5044
Observed behavior: an employee-initiated exit uses Employee.noticePeriodDays (default 30). An employer termination is issued through the documents engine TERMINATION_NOTICE letter, which requires noticeDays > 0 for NOTICE / NON_RENEWAL and whose form defaults to 60 days (a hard-coded copy, no 60-day floor, EV-5904). The real settlement computes no pay in lieu; HR can only add it as a free manual entitlement (EV-5905). The 60/30 values in RuleParameter are not read by operational code.
Risk: Medium (adjusted from High by adversarial verification). A settlement for an employer termination can leave out notice pay in lieu, because nothing computes it or links the termination letter to the settlement; the manual entitlement field is the only path.
Confidence: High

### Art.77 unlawful-termination compensation
Status: PARTIAL
Evidence: EV-5052, EV-5044
Observed behavior: it appears only as a risk line in the exit-cost estimate, not in the settlement.
Confidence: High

### Regulatory expiry alerts
Status: COMPLETE
Evidence: EV-5055, EV-5056
Observed behavior: configurable windows for iqama, passport, health certificate, contract, probation, CR, municipal licence, civil defence and others, plus a daily digest job through the outbox (e-mail only when OUTBOX_SEND=true, per SYSTEM_MAP). Renewals are limited to GOV roles.
Confidence: Medium (the job runtime is covered in domains 20 and 29)

### Regulatory alerts for Nitaqat / GOSI / WPS
Status: MISSING
Evidence: EV-5057, EV-5080
Observed behavior: the alert engine has no alert for a Nitaqat band drop, GOSI regime UNKNOWN, WPS or Qiwa documentation. The workforce overview does list upcoming rule changes (EV-5080), but only inside the planning screens.
Confidence: High

### Compliance violations register
Status: PARTIAL
Evidence: EV-5053, EV-5054
Observed behavior: a manual log of government fines (authority as free text, amount, correction period, status PENDING_PAYMENT, CORRECTED or PAID). Writes are audited. GET is open to all STAFF roles and is not scoped by company.
Missing pieces: a link to a rule, employee or evidence document, due-date alerts, and payment linkage.
Confidence: High

### Compliance reporting
Status: MISSING
Evidence: EV-5002, EV-5004, EV-5057
Observed behavior: no GOSI, WPS, Nitaqat or labour-office report or submission is produced. The workforce Excel/PDF exports are planning reports.
Confidence: Medium

### Labour-law parameter register (single source of truth)
Status: DISCONNECTED
Evidence: EV-5045, EV-5042, EV-5043, EV-5082, EV-5078
Observed behavior: RuleParameter is a well-built register (dated, sourced, status, audited versions), but only the workforce engine reads it. Payroll, leave, settlement and termination use their own constants or SystemSetting values. For example, notice is 60 days in RuleParameter but defaults to 30 in Employee, and the exit/re-entry fee exists in two copies.
Risk: Medium (adjusted from High by adversarial verification, EV-5903). A legal change entered in the register does not reach payroll or settlement, while the planning numbers do change. Today the duplicated values agree (probation 180, exit/re-entry 200/300/+100, overtime 1.5, annual leave 21/30), and the notice example is not a conflict: Employee.noticePeriodDays is used only for employee-initiated exits, where 30 matches NOTICE_DAYS_EMPLOYEE. The risk is future drift, not a wrong payout now.
Confidence: High

### PDPL controls
Status: PARTIAL
Evidence: EV-5058, EV-5059, EV-5060, EV-5061
Observed behavior: face-biometric consent is versioned and can be withdrawn, with a purge job. Disability data is redacted in the workforce screens. Documents have a retention job.
Missing pieces: data-subject access, export and erasure; a processing register; a retention policy for employee master data. The applicant consent text is still a "DRAFT PENDING LEGAL REVIEW".
Confidence: Medium

### Hijri dates
Status: PARTIAL
Evidence: EV-5030, EV-5031
Observed behavior: Umm al-Qura conversion (Intl) is used for Muqeem payloads and document rendering. The UI shows no Hijri dates elsewhere, and there is no Hijri input.
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| GOSI rates by regime / nationality / date | GosiRate table (migrations 5, 9) | src/lib/gosi.ts | x-X-PAYROLL-gosi | Payroll, Workforce | No: workforce reuses calculateGosi (EV-5072) |
| GOSI wage cap 1,500-45,000 | GosiRate.minWage/maxWage + RuleParameter GOSI_MAX/MIN | gosi.ts:205 | yes | Payroll | Yes: the values are in two tables (EV-5006, EV-5081) |
| EOSB art.84/85 | code constants | settlement.ts:116-132 | settlement.test | Offboarding, Workforce | No: reused (EV-5072) |
| Notice 60 employer / 30 employee | RuleParameter (workforce) vs Employee.noticePeriodDays default 30 | exit-cost.ts:192-202 vs termination.ts:19-23 | wf-exit-cost, termination-last-day | Offboarding, Workforce | Yes, and they diverge (EV-5042, EV-5043) |
| Probation max 180 | RuleParameter PROBATION_MAX_DAYS vs PROBATION_WARNING_DAYS const | employee-shared.ts:82 | - | Core HR | Yes (EV-5039, EV-5081) |
| Annual leave 21/30 | leave.ts constants + SystemSetting annual_leave_days; RuleParameter ANNUAL_LEAVE_DAYS | leave.ts:235 | leave.test | Leave, Settlement | Yes (EV-5036, EV-5081) |
| Overtime premium 50% / cap 720 h | Payroll settings (multiplier) vs RuleParameter | payroll-core.ts / formulas.ts | r3-payroll-overtime, wf-true-cost | Payroll, Workforce | Yes; the cap is only in workforce (EV-5049) |
| Exit/re-entry fee | constants.ts:137 + settlement.ts:195 vs RuleParameter EXIT_REENTRY_* | settlement.ts | settlement.test | Leave settlement, Workforce | Yes, values consistent (EV-5082) |
| Nitaqat weights / caps / bands | NitaqatCurve (seeded manually) + code | nitaqat.ts | wf-nitaqat | Workforce | No |
| Non-Saudi fixed-term contract | code warning | employee-shared.ts:158 | - | Contracts | No |

## Edge cases checked
- Mid-year GOSI step (1 July): the correct row is picked by the first day of the month, and the 2024-07-03 start applies to July (EV-5009).
- Saudi with regime UNKNOWN: OLD rates plus a review note, not blocked (EV-5010, EV-5011).
- GCC national: treated as non-Saudi for GOSI but as GCC for Nitaqat. The two are inconsistent (EV-5083).
- Ramadan: no reduced hours. Attendance lateness and overtime use the normal shift (EV-5046, EV-5047).
- Holidays: no calendar (EV-5048).
- Employer-initiated termination: no notice pay in the settlement (EV-5044).
- Resignation under 2 years: EOSB 0; art.80: 0 (EV-5032).
- Multi-company: Muqeem credentials are linked per company (EV-5020), but the GovPlatform vault and the compliance register are not scoped by company (EV-5022, EV-5053).
- Fresh tenant: Nitaqat curves are empty until the manual seed (EV-5024, EV-5025).
- Hijri: correct Umm al-Qura conversion for Muqeem (EV-5030); not shown elsewhere (EV-5031).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 Saudi compliance | 26 | 4 | 13 | 0 | 0 | 8 | 0 | 0 | 1 | 0 | 0 | No WPS/Mudad; no Qiwa/GOSI integration; Muqeem verified only against a mock; labour-law register not used by payroll/settlement; no 48h/Ramadan hours; notice pay missing in settlement; gov vault not company-scoped | High |

## Adversarial verification

Verifier pass on 2026-09-27 (read-only). Each finding was re-opened at the cited lines and searched for missed code (other routes, jobs, shared libs, the documents engine, Arabic terms). No status changed; three severities were lowered (risk lines above, AUDIT/_work/matrix_E.md and AUDIT/08_SAUDI_COMPLIANCE_AUDIT.md updated). New evidence: EV-5900..EV-5909 in AUDIT/_work/ledger_E.md.

| ID | Capability | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|---|
| E-1 | WPS / Mudad salary file | CONFIRMED | MISSING / Critical | Broad grep (mudad, wps, sif, مدد, حماية الأجور) finds only the payment-method label and the export disclaimer. Payroll has IBAN readiness flags but produces no file (EV-5900), and the council backlog defers the file until the Mudad spec is obtained (EV-5901). |
| E-2 | Labour-law parameter register | ADJUSTED | DISCONNECTED / Medium (was High) | The core claim holds: payroll, leave, settlement and termination never read RuleParameter. Two minor outside readers exist (company page iqama fee, portal total rewards, EV-5902). The notice example is mis-framed: Employee.noticePeriodDays (30) is used only for employee-initiated exits, where it equals NOTICE_DAYS_EMPLOYEE. The duplicated values currently agree, so the risk is future drift, not a current wrong payout (EV-5903). |
| E-3 | Notice periods (art.75/76) | ADJUSTED | PARTIAL / Medium (was High) | Missed code: the documents engine issues an employer TERMINATION_NOTICE that requires noticeDays and defaults the form to 60 (EV-5904). The settlement still computes no pay in lieu; HR can add it only as a free manual entitlement (EV-5905). The gap is real but narrower than stated. |
| E-4 | Working hours 48 h / Ramadan 36 h | CONFIRMED | MISSING / High | No weekly cap, Ramadan rule or holiday model. The portal shows a 'HOLIDAY' attendance status that nothing writes (dead branch), and the only Ramadan workaround is editing branch schedule times by hand (EV-5906). |
| E-5 | Muqeem integration | CONFIRMED | PARTIAL / High | Client, idempotency, GOV role and confirm gate verified at the cited lines. The README states no live test, the contract tests use describe.skipIf, and the local env points at the mock on 127.0.0.1:4010 (EV-5907). |
| E-6 | Government credential vault | ADJUSTED | PARTIAL / Medium (was High) | GovPlatform has no companyId, as stated. But no other domain is company-scoped (UserCompanyScope is read only by the documents engine), COMPANY_ADMIN is the group owner, and HR_MANAGER is deliberately excluded. The exposure is limited to a GOV_RELATIONS user meant for one legal company; secrets are encrypted, masked, rate-limited and audited (EV-5908). |
| E-7 | Qiwa and GOSI integration | CONFIRMED | MISSING / High | No env var, URL or client for Qiwa or GOSI (EV-5909). The Qiwa flag is manual and gates Nitaqat from 2026-04-15 (nitaqat.ts:192, 263); gosi.ts is a pure calculator. |
