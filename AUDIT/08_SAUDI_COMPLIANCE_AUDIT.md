# Saudi compliance audit

Group E, 2026-09-27, working tree as on disk. Evidence IDs point to `AUDIT/_work/ledger_E.md`; the full capability detail is in `03_DOMAIN_REPORTS/10_saudi_compliance.md`.
Legal values come from three sources, each labelled in the tables: (a) code comments or seed rows that cite official URLs, (b) the auditor's own knowledge, marked "auditor knowledge" (EV-5085), not fetched online in this pass.

## 1. Integration classification

Before the classification, I checked each integration for: an HTTP client, call sites, error handling, and whether the product can reach it.

| Integration | Classification | HTTP client | Reachable from product | Error handling | Evidence |
|---|---|---|---|---|---|
| Muqeem (Elm) | PARTIAL: real client, verified only against the local mock | yes: src/lib/muqeem/client.ts (`fetch`, AbortController, token cache, one re-auth on 401) | yes: /integrations/muqeem, /visas, /employees/[id], /settlements (ROLE_GROUPS.GOV, explicit confirmation) | strong: idempotency key, UNKNOWN_OUTCOME with reconciliation, secret redaction, audit | EV-5012..EV-5020 |
| GOSI | MISSING as an integration; the internal calculator is COMPLETE | none | the calculator is used by payroll | n/a | EV-5004, EV-5005, EV-5008 |
| Qiwa | MISSING (manual "documented in Qiwa" flag only) | none | n/a | n/a | EV-5001, EV-5084 |
| WPS / Mudad | MISSING (only a payment-method label; the export says it is not a WPS file) | none | n/a | n/a | EV-5002, EV-5003 |
| Nitaqat (Qiwa) | internal estimate, no integration; data provisioned manually | none (links to the HRSD calculator only) | yes: /workforce/saudization | flags per assumption | EV-5023..EV-5029 |
| Absher / Tamm | MISSING | none | n/a | n/a | EV-5004 |
| HRDF | internal estimate only (RuleParameter values) | none | workforce screens | n/a | EV-5081 |
| Government credential vault (GovPlatform) | REAL (local, encrypted), not company-scoped | n/a | /gov-platforms | reveal is rate-limited and audited | EV-5021, EV-5022 |

## 2. Labour-law and regulatory rule table

| Rule | Law article / source | Implemented where | Correct? | Tests | EV |
|---|---|---|---|---|---|
| EOSB: half a month per year for 5 years, then a month per year | Labour Law art.84 (code comment settlement.ts:109; auditor knowledge) | src/lib/settlement.ts:116-132 | Yes | settlement.test (25) | EV-5032, EV-5035 |
| Resignation EOSB: 0 / one third / two thirds / full at <2, 2-5, 5-10, >=10 years | art.85 (code comment; auditor knowledge) | settlement.ts:125-130 | Yes | settlement.test | EV-5032 |
| Art.80 dismissal and probation: no EOSB | art.80 (code label) | settlement.ts:122 | Yes (auditor knowledge) | settlement.test | EV-5032 |
| Art.81 / art.87 / contract expiry: full EOSB | code marks the reading "pending counsel" | settlement.ts:51 | Provisional by the code's own statement | settlement.test | EV-5033 |
| Notice: 60 days employer, 30 days employee (indefinite contract) | art.75 as amended (RuleParameter source quote from laws.boe.gov.sa) | only in workforce exit-cost.ts:192-202; operations use Employee.noticePeriodDays default 30 for employee exits, the documents TERMINATION_NOTICE form defaults to 60 (EV-5904), and the settlement computes no notice in lieu (manual entitlement only, EV-5905) | No for employer terminations | wf-exit-cost only | EV-5041..EV-5044 |
| Art.77 compensation: 15 days per year, minimum 2 months | art.77 (RuleParameter) | exit-cost.ts:207-224 (risk line only) | Estimate only, not in the settlement | wf-exit-cost | EV-5052 |
| Probation maximum 180 days | art.53 (RuleParameter source quote) | employee-shared.ts:79-87 (warning only) | Partly: warns, does not enforce | - | EV-5039, EV-5040 |
| Working hours 8/day, 48/week; Ramadan 6/day, 36/week for Muslims | art.98 (auditor knowledge + brief) | not implemented | Missing | - | EV-5046, EV-5047, EV-5085 |
| Overtime premium 50% of basic; cap 720 h/year | art.107 (RuleParameter); cap per HRSD (RuleParameter notes that the regulation article is unsure) | premium in payroll settings; cap only in workforce | Cap not enforced in operations | r3-payroll-overtime, wf-true-cost | EV-5049, EV-5081 |
| Annual leave 21 days, 30 after 5 years | art.109 (RuleParameter + leave.ts) | leave.ts:235-236 | Yes | leave.test | EV-5036 |
| Sick leave 30 full, 60 at 75%, 30 unpaid | art.117 (auditor knowledge) | leave.ts:240 | Yes | leave.test | EV-5036 |
| Maternity 12 weeks; paternity 3 days; marriage 5; bereavement 5/3; Hajj 10-15 once after 2 years | 2025 amendment, cited in leave.ts:55-81 (secondary sources, marked provisional) | leave.ts:137-148 | Plausible; the code marks it provisional | x-X-LEAVE-statutory (26) | EV-5037, EV-5038 |
| Non-Saudi contract must be fixed-term | art.37 (code message) | employee-shared.ts:158-160 (warning only); no term type in ContractType | Partly | - | EV-5050, EV-5051 |
| GOSI: Saudi 9.75% employee / 11.75% employer; non-Saudi 2% employer; wage 1,500-45,000; new regime +0.5/side each July 2025-2028 | SI Law art.8/15, Royal Decree M/273 (migration sources); auditor knowledge agrees | gosi.ts + GosiRate | Yes, except GCC nationals | x-X-PAYROLL-gosi (15) | EV-5006, EV-5007, EV-5009 |
| GOSI for GCC nationals | GCC insurance extension (auditor knowledge, flagged) | treated as non-Saudi 2% | Probably wrong | - | EV-5083 |
| Expat levy 700/800, work permit 100, dependent fee 400 | Qiwa / MoF (RuleParameter) | workforce estimates only | n/a for payroll | wf-true-cost | EV-5081 |
| Nitaqat Mutawar 2026 weights, caps, bands | HRSD guide (code comments, prisma/data/nitaqat-2026) | nitaqat.ts | Estimate; curves need a manual seed | wf-nitaqat (20) | EV-5023..EV-5028 |
| Wage protection (WPS) | MHRSD WPS programme (auditor knowledge) | not implemented | Missing | - | EV-5002, EV-5003 |
| Personal data (PDPL) | PDPL (auditor knowledge) | biometric consent + purge; disability redaction | Partial | self-attendance tests | EV-5058..EV-5061 |

## 3. Gaps ranked by legal / financial exposure

1. **No WPS / Mudad file (Critical).** Salaries cannot be proven compliant from the system, and each month's upload is manual with no trace from the payroll run to the submitted file. Missing WPS compliance can block government services for the establishment (auditor knowledge). EV-5002, EV-5003.
2. **Labour-law parameters split between two sources (Medium; adjusted from High by adversarial verification: duplicated values currently agree, risk is drift, EV-5903).** RuleParameter is dated and sourced but only the workforce engine reads it. Payroll, leave, settlement and termination use separate constants (notice 30 vs 60, probation, leave days, exit/re-entry fees). A legal change updates the forecasts but not the payouts. EV-5045, EV-5042, EV-5043, EV-5082.
3. **Employer-termination notice pay missing from the settlement (Medium; adjusted from High: a termination-notice letter with a 60-day default exists and HR can add pay in lieu as a manual entitlement, EV-5904, EV-5905).** An art.75/76 pay-in-lieu can be left out of the final settlement, while the planning estimate includes it. EV-5044, EV-5043.
4. **No working-hours limits or Ramadan hours (High).** Weekly limits are never checked, and in Ramadan attendance measures lateness and overtime against normal shifts. This can produce wrong deductions and wrong overtime. EV-5046, EV-5047.
5. **Muqeem not verified against a live or sandbox Elm endpoint (High).** The operations are irreversible government transactions. The safety design is strong, but the only evidence is a local mock and skipped contract tests. EV-5018, EV-5019.
6. **Government credential vault not company-scoped (Medium, security; adjusted from High: no domain is company-scoped outside documents, EV-5908).** Any COMPANY_ADMIN or GOV_RELATIONS user can reveal every portal password in the tenant (audited and rate-limited, but not scoped). EV-5021, EV-5022.
7. **No GOSI or Qiwa integration (High).** GOSI registration, wage updates and Qiwa contract documentation are manual. The Nitaqat estimate relies on a manual Qiwa flag. EV-5001, EV-5004, EV-5084.
8. **GOSI for GCC nationals (Medium).** They are priced as expats (2%). EV-5083.
9. **Nitaqat curves not provisioned on deploy (Medium).** A fresh tenant shows no band until someone runs `scripts/seed-nitaqat.mjs --apply` by hand. EV-5024, EV-5025.
10. **Overtime cap and probation maximum not enforced (Medium).** They are warnings or estimates only. EV-5039, EV-5049.
11. **No public-holiday calendar (Medium).** EV-5048.
12. **PDPL (Medium).** No data-subject rights endpoints, no processing register and no retention policy for master data; the applicant consent text is still a draft. EV-5059, EV-5060.
13. **No regulatory alerts for Nitaqat, GOSI or WPS, and no compliance reporting (Medium).** EV-5057.

## 4. Conflicts with earlier self-assessments
- The code's own comments call Muqeem "tested against a mock only" (EV-5018). Any doc that presents Muqeem as a working integration overstates it.
- Migration `9_workforce_engine` marks the NEW-regime GOSI rows VERIFIED, while `src/lib/gosi.ts:16-17` still says the NEW-regime rows are PROVISIONAL. The comment is stale; the data is authoritative (EV-5007, EV-5005).
