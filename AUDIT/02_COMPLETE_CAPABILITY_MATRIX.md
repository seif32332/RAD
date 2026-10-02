# Complete capability matrix

One row per capability audited, merged from the 11 specialist groups after adversarial verification (`AUDIT/_work/matrix_*.md`). Status is normalized to exactly one of the ten audit statuses; where a verifier changed a status, the note column says so. Evidence IDs resolve in [12_AUDIT_EVIDENCE_LEDGER.md](12_AUDIT_EVIDENCE_LEDGER.md).

Orchestrator correction applied: the onboarding row "Work commencement notice on approval" behaves as SKIPPED for every new hire (EV-0026, EV-0027); see 06_onboarding.md.

| Domain | Capability | Status | Evidence | Criticality | Confidence | Verification note |
|---|---|---|---|---|---|---|
| 01 Core HR | Employee profile CRUD (create/list/detail/edit) | COMPLETE | EV-1006, EV-1007 | Critical | High |  |
| 01 Core HR | Termination (status change) | COMPLETE | EV-1007 | Critical | High |  |
| 01 Core HR | Personal/contact info fields | COMPLETE | EV-1001 | High | High |  |
| 01 Core HR | Nationality classification | COMPLETE | EV-1031 | High | High |  |
| 01 Core HR | National ID / Iqama / passport format validation | PARTIAL | EV-1030 | Medium | High |  |
| 01 Core HR | Dependents (structured list) | MISSING | EV-1003 | Medium | High |  |
| 01 Core HR | Emergency contacts | MISSING | EV-1002, EV-1900 | Medium | High |  |
| 01 Core HR | Employment history / job history / salary history view | PARTIAL | EV-1008, EV-1009, EV-1010, EV-1011, EV-1901, EV-1902, EV-1903 | High | High |  |
| 01 Core HR | Salary history via promotion/raise decisions (data + apply engine) | COMPLETE | EV-1012, EV-1013, EV-1014, EV-1015, EV-1016 | High | High |  |
| 01 Core HR | Manager / department / branch / cost center assignment | PARTIAL | EV-1020, EV-1021 | High | High |  |
| 01 Core HR | Employee timeline (single-view chronology) | MISSING | EV-1009 | Medium | High |  |
| 01 Core HR | Directory / search | COMPLETE | EV-1028 | Medium | High |  |
| 01 Core HR | Bulk operations (Excel import) | COMPLETE | EV-1026, EV-1029 | High | High |  |
| 01 Core HR | Bulk import audit granularity | PARTIAL | EV-1027 | Low | Medium |  |
| 01 Core HR | Custom fields | MISSING | EV-1004 | Low | High |  |
| 01 Core HR | Employee notes | MISSING | EV-1005 | Medium | High |  |
| 01 Core HR | Permissions on employee mutations | COMPLETE | EV-1006, EV-1007 | Critical | High |  |
| 01 Core HR | Audit trail on employee mutations | COMPLETE | EV-1006, EV-1007, EV-1013 | Critical | High |  |
| 02 Organization | Legal entities / companies CRUD | COMPLETE | EV-1017, EV-1024 | Critical | High |  |
| 02 Organization | Administrations CRUD | COMPLETE | EV-1018, EV-1024 | High | High |  |
| 02 Organization | Branches CRUD | COMPLETE | EV-1019, EV-1024 | High | High |  |
| 02 Organization | Departments CRUD | COMPLETE | EV-1020, EV-1025 | High | High |  |
| 02 Organization | Divisions / teams | MISSING | EV-1021 | Low | High |  |
| 02 Organization | Positions / job titles as managed entities | MISSING | EV-1021 | Medium | High |  |
| 02 Organization | Grades / levels | MISSING | EV-1021 | Low | High |  |
| 02 Organization | Cost centers | MISSING | EV-1021 | Medium | High |  |
| 02 Organization | Headcount allocation / planning | PARTIAL | EV-1022, EV-1023 | Medium | High |  |
| 02 Organization | Reporting lines (manager hierarchy data) | COMPLETE | EV-1023 | Medium | High |  |
| 02 Organization | Org chart visualization | MISSING | EV-1023 | Medium | High |  |
| 02 Organization | Branch transfer workflow (employee moves branch) | COMPLETE | EV-1038, EV-1039 | High | High |  |
| 02 Organization | Department/manager (and branch) transfer via decision document | COMPLETE | EV-1012, EV-1013, EV-1036, EV-1904, EV-1907 | High | High |  |
| 02 Organization | Transfer mechanisms coordination (TransferRequest vs TRANSFER_DECISION) | DISCONNECTED | EV-1038, EV-1039, EV-1904, EV-1905, EV-1906 | High | High |  |
| 02 Organization | Transfer-decision reachable from UI | UNKNOWN | EV-1037 | Medium | Low |  |
| 02 Organization | Permissions on org-unit mutations | COMPLETE | EV-1024, EV-1025 | Critical | High |  |
| 02 Organization | Audit trail on org-unit mutations | COMPLETE | EV-1024, EV-1025 | Critical | High |  |
| 02 Organization | Page-level permission model (RolePermission) | PARTIAL | EV-1040 | Low | Medium |  |
| 03 Contracts | Contract type classification (employment type) | COMPLETE | EV-1032 | Medium | High |  |
| 03 Contracts | Fixed-term vs. unlimited-term distinction | COMPLETE | EV-1033, EV-1908, EV-1909 (implicit via contractEndDate, used by Art. 77/CONTRACT_EXPIRY/Art. 37 rules; residual Low gap: no renewal count for Art. 55) | Low | High |  |
| 03 Contracts | Probation tracking + alerting | COMPLETE | (ledger_0 alerts evidence; src/lib/alerts.ts:115,300,322,424-436) | Medium | Medium |  |
| 03 Contracts | Contract amendments/addenda (allowances, branch, contract end date) | COMPLETE | EV-1012, EV-1013, EV-1034, EV-1035, EV-1036 | High | High |  |
| 03 Contracts | Salary-term changes via decision (effective-dated, atomic, audited) | COMPLETE | EV-1013, EV-1014, EV-1016 | Critical | High |  |
| 03 Contracts | Allowance changes (housing/transport) on amendment | COMPLETE | EV-1013 | Medium | High |  |
| 03 Contracts | Background application of due decisions | COMPLETE | EV-1014, EV-1015 | High | High |  |
| 03 Contracts | Revocation safety (cannot silently undo an applied change) | COMPLETE | EV-1016 | Medium | High |  |
| 03 Contracts | Renewals (contract end-date extension as a first-class workflow) | UNKNOWN | (contractEndDate is editable via EmployeeChangeOrder/addendum, EV-1012; no dedicated "renewal" workflow/page found, but not exhaustively searched) | Medium | Low |  |
| 03 Contracts | Contract templates (offer / addendum letters) | COMPLETE | EV-1035, EV-1036 | Medium | High |  |
| 03 Contracts | Acceptance / e-signing of contracts | UNKNOWN | (Signatory model exists in schema per system map but signing/acceptance flow not verified in this pass — belongs mainly to Documents domain 04) | Medium | Low |  |
| 03 Contracts | Test coverage (transfer-decision path) | COMPLETE | EV-1029 | Medium | High |  |
| 04 Documents | Upload (validation, allow-list, magic-byte check) | COMPLETE | EV-2002, EV-2004 | High | High |  |
| 04 Documents | Storage (path safety, registry) | COMPLETE | EV-2001, EV-2003 | High | High |  |
| 04 Documents | Download / access control by role+category+scope | COMPLETE | EV-2005, EV-2006 | Critical | High |  |
| 04 Documents | Sensitive-document audit trail (VIEW logging) | COMPLETE | EV-2005 | High | High |  |
| 04 Documents | CompanyDocument tracking | PARTIAL | EV-2007 | Medium | Medium |  |
| 04 Documents | Renewals / expiry queue (multi-entity) | COMPLETE | EV-2008, EV-2009 | High | High |  |
| 04 Documents | Document versioning (uploaded files) | MISSING | EV-2001 (no version/parent field) | Medium | High |  |
| 04 Documents | Generated letters/certificates: request pipeline | COMPLETE | EV-2030, EV-2032, EV-2042 | Critical | High |  |
| 04 Documents | Snapshot immutability + approval-to-exact-hash | COMPLETE | EV-2031, EV-2033, EV-2035 | High | High |  |
| 04 Documents | Signature authorization (signatory / pre-auth) | COMPLETE | EV-2033 | High | High |  |
| 04 Documents | Document numbering / issuance atomicity | COMPLETE | EV-2031, EV-2032 | High | High |  |
| 04 Documents | Audit hash-chain (DocumentEvent) | COMPLETE | EV-2034, EV-2035 | High | High |  |
| 04 Documents | Digital seal (PAdES) | COMPLETE | EV-2036, EV-2037 | High | High |  |
| 04 Documents | Public verification (/v) | COMPLETE | EV-2038 | High | High |  |
| 04 Documents | Retention / purge / archive (jobs) | COMPLETE | EV-2041 | Medium | High |  |
| 04 Documents | Integrity monitoring job | COMPLETE | EV-2041 | Medium | High |  |
| 04 Documents | Test coverage (engine) | COMPLETE | EV-2039 | Medium | High |  |
| 04 Documents | In-progress transfer-decision doc type (uncommitted) | PARTIAL | EV-2040 | Low | Medium |  |
| 05 Recruitment | Manpower requisition (JobRequest) create/approve | COMPLETE | EV-2018, EV-2019 | High | High |  |
| 05 Recruitment | Candidate pipeline (apply -> interview -> offer -> hired) status machine | COMPLETE | EV-2020, EV-2021 | High | High |  |
| 05 Recruitment | Public application form (/apply) | COMPLETE | EV-2029 | Medium | Medium |  |
| 05 Recruitment | Offer generation + candidate self-service accept/decline | COMPLETE | EV-2024, EV-2025 | High | High |  |
| 05 Recruitment | CV parsing | MISSING | (no evidence found; resumeUrl is a raw upload only) | Low | Medium |  |
| 05 Recruitment | Interview scheduling | PARTIAL | EV-2020 (single `interviewDate` field only, no calendar/multi-round) | Medium | Medium |  |
| 05 Recruitment | Evaluation / scoring / assessments | MISSING | EV-2027 | Medium | High |  |
| 05 Recruitment | Talent pool | MISSING | EV-2026 | Low | High |  |
| 05 Recruitment | Recruitment analytics | MISSING | (no dashboard/report found for recruitment funnel) | Low | Medium |  |
| 05 Recruitment | Candidate -> Employee conversion on HIRED | DISCONNECTED | EV-2022, EV-2023, EV-2900, EV-2902, EV-2903 | High (verifier-adjusted from Critical) | High | (verifier CONFIRMED status) |
| 05 Recruitment | Test coverage of pipeline/transitions | MISSING | EV-2028 | Medium | High |  |
| 06 Onboarding | OnboardingRequest submission (manager-portal) | COMPLETE | EV-2013 | High | High |  |
| 06 Onboarding | HR review/approval -> Employee creation | COMPLETE | EV-2014 | Critical | High |  |
| 06 Onboarding | Rejection flow | COMPLETE | EV-2015 | Medium | High |  |
| 06 Onboarding | Duplicate-identity / org-unit / manager validation | COMPLETE | EV-2014 | High | High |  |
| 06 Onboarding | Data-completeness flags (placeholder dates, nationality review) | COMPLETE | EV-2014, EV-2016 | Medium | High |  |
| 06 Onboarding | Document collection (attachments on the request) | COMPLETE | EV-2012 | Medium | High |  |
| 06 Onboarding | Checklist / task tracking (equipment, access, orientation, training) | MISSING | EV-2010, EV-2017, EV-2904..EV-2908 | Medium (verifier-adjusted from High) | High | (verifier CONFIRMED status; adjacent: commencement notice, dataReviewNote, Asset custody, probation alert) |
| 06 Onboarding | User-account (login) creation on hire | MISSING | EV-2011 (separate manual checklist step, not automated from OnboardingRequest approval) | Medium | Medium | /manual |
| 06 Onboarding | Probation lifecycle tracking as an onboarding step | MISSING | EV-2017 (probation date exists on Employee/renewals only) | Low | Medium |  |
| 06 Onboarding | Manager assignment | COMPLETE | EV-2012, EV-2014 | Medium | High | (as a data field) |
| 06 Onboarding | Progress / completion tracking of onboarding steps | MISSING | EV-2010 (that page is company-setup, not per-hire onboarding progress) | Medium | High |  |
| 06 Onboarding | Recruitment -> Onboarding link (hired candidate becomes an onboarding case) | DISCONNECTED | EV-2022, EV-2023, EV-2013, EV-2900..EV-2903 | High (verifier-adjusted from Critical) | High | (verifier CONFIRMED status) |
| 06 Onboarding | Unit test coverage (pure helpers) | PARTIAL | EV-2016 | Low | High |  |
| 07 Attendance | Manual attendance entry (HR) | PARTIAL | EV-3011, EV-3002, EV-3004 | Medium | High |  |
| 07 Attendance | Self clock-in (GPS geofence + face) | PARTIAL | EV-3012, EV-3013, EV-3014, EV-3015, EV-3016, EV-3017 | High | High |  |
| 07 Attendance | Geofencing / attendance locations | COMPLETE | EV-3018, EV-3058, EV-3013 | Medium | High |  |
| 07 Attendance | Face verification and biometric lifecycle (consent, purge) | COMPLETE | EV-3018, EV-3056, EV-3057 | High | Medium |  |
| 07 Attendance | Biometric device integration | MISSING | EV-3008 | High | High |  |
| 07 Attendance | QR attendance | MISSING | EV-3008 | Low | High |  |
| 07 Attendance | Work schedules / shifts (fixed, split, flexible, night) | PARTIAL | EV-3001, EV-3005, EV-3059, EV-3060, EV-3004 | High | High |  |
| 07 Attendance | Rotating shifts / rosters | MISSING | EV-3062, EV-3005 | Medium | High |  |
| 07 Attendance | Ramadan working hours | MISSING | EV-3006 | High | High |  |
| 07 Attendance | Weekends / rest days per schedule | DISCONNECTED | EV-3001, EV-3007, EV-3028 | Medium | High |  |
| 07 Attendance | Public holidays | MISSING | EV-3006, EV-3028 | High | High |  |
| 07 Attendance | Breaks | MISSING | EV-3062 | Low | High |  |
| 07 Attendance | Late arrival / early departure / OT minutes | PARTIAL | EV-3004, EV-3023 | Medium | High |  |
| 07 Attendance | Absence detection and recording | MISSING | EV-3009, EV-3007, EV-3006 | Critical | High |  |
| 07 Attendance | Missing punches handling | PARTIAL | EV-3020, EV-3021, EV-3061 | Medium | High |  |
| 07 Attendance | Attendance corrections workflow | PARTIAL | EV-3019, EV-3020, EV-3021, EV-3065 | Medium | High |  |
| 07 Attendance | Flagged/rejected punch review | COMPLETE | EV-3067, EV-3018 | Medium | Medium |  |
| 07 Attendance | Timesheets / attendance reports | PARTIAL | EV-3010 | High | High |  |
| 07 Attendance | Overtime requests and approval | PARTIAL | EV-3024, EV-3025, EV-3026, EV-3062, EV-3066 | High | High |  |
| 07 Attendance | Overtime -> payroll | COMPLETE | EV-3022, EV-3027, EV-3028, EV-3029 | High | High |  |
| 07 Attendance | Attendance -> payroll (absence / lateness deductions) | DISCONNECTED | EV-3022, EV-3023, EV-3009 | Critical | High |  |
| 07 Attendance | Leave -> attendance integration (ON_LEAVE) | BROKEN | EV-3016, EV-3017 | High | High |  |
| 07 Attendance | Attendance access control / multi-company scoping | PARTIAL | EV-3065, EV-3054 | Medium | High |  |
| 07 Attendance | Attendance notifications | MISSING | EV-3052 | Medium | High |  |
| 08 Leave | Leave types catalogue | PARTIAL | EV-3070, EV-3069, EV-3049 | Medium | High |  |
| 08 Leave | Leave policies (configurable) | PARTIAL | EV-3048, EV-3031 | Medium | High |  |
| 08 Leave | Annual entitlement 21/30 (art. 109) | COMPLETE | EV-3030, EV-3031, EV-3029 | Critical | High |  |
| 08 Leave | Accrual and balance | COMPLETE | EV-3031, EV-3055, EV-3063 | Critical | High |  |
| 08 Leave | Carry-forward / expiry | MISSING | EV-3031 | Medium | High |  |
| 08 Leave | Sick leave tiers (art. 117) | PARTIAL | EV-3032, EV-3033, EV-3064, EV-3035, EV-3050 | High | High |  |
| 08 Leave | Statutory special leaves | PARTIAL | EV-3048, EV-3049 | Medium | High |  |
| 08 Leave | Eligibility checks | COMPLETE | EV-3049, EV-3039 | Medium | High |  |
| 08 Leave | Leave request and validation | COMPLETE | EV-3039, EV-3040, EV-3038 | High | High |  |
| 08 Leave | Approval workflow (manager -> HR) | COMPLETE | EV-3041, EV-3065 | High | High |  |
| 08 Leave | Cancellation | COMPLETE | EV-3044, EV-3042 | Medium | High |  |
| 08 Leave | Modification / extension | PARTIAL | EV-3045, EV-3047 | Medium | High |  |
| 08 Leave | Return to work (early / late) | PARTIAL | EV-3043, EV-3068 | Medium | High |  |
| 08 Leave | Absconding from leave | COMPLETE | EV-3046 | Medium | Medium |  |
| 08 Leave | Leave day counting (calendar vs working days) | PARTIAL | EV-3038, EV-3006, EV-3007 | Medium | High |  |
| 08 Leave | Public holidays in leave | MISSING | EV-3006 | Medium | High |  |
| 08 Leave | Unpaid / sick deductions -> payroll | PARTIAL | EV-3035, EV-3036, EV-3037 | High | High |  |
| 08 Leave | Backdated leave vs finalised payroll month | DISCONNECTED | EV-3047, EV-3045 | High | High |  |
| 08 Leave | Leave encashment / leave settlement | PARTIAL | EV-3053, EV-3017, EV-3904 | High | High |  |
| 08 Leave | Exit/re-entry visa link | COMPLETE | EV-3042, EV-3039, EV-3041 | Medium | High |  |
| 08 Leave | Leave calendar / team availability | MISSING | EV-3051 | Medium | High |  |
| 08 Leave | Employee-specific leave rules | MISSING | EV-3031, EV-3048 | Medium | High |  |
| 08 Leave | Medical certificate / attachments | MISSING | EV-3050 | Medium | High |  |
| 08 Leave | Leave notifications | MISSING | EV-3052 | Medium | High |  |
| 08 Leave | Leave history and access scoping | PARTIAL | EV-3039, EV-3054, EV-3055 | Medium | High |  |
| 08 Leave | Leave -> attendance | BROKEN | EV-3016, EV-3017 | High | High |  |
| 09 Payroll | Payroll calculation engine (per-employee line) | PARTIAL | EV-4004, EV-4007, EV-4013, EV-4036 | Critical | High |  |
| 09 Payroll | Salary structure (basic + allowances) | PARTIAL | EV-4002, EV-4021, EV-4020 | High | High |  |
| 09 Payroll | Overtime -> payroll | PARTIAL | EV-4008, EV-4030 | High | High |  |
| 09 Payroll | Deductions (penalties) -> payroll | PARTIAL | EV-4012, EV-4013, EV-4014 | High | High |  |
| 09 Payroll | Loans -> payroll | PARTIAL | EV-4205, EV-4014, EV-4027 | High | High |  |
| 09 Payroll | Leave -> payroll | COMPLETE | EV-4031, EV-4032 | High | High |  |
| 09 Payroll | Attendance -> payroll | DISCONNECTED | EV-4004, EV-4005, EV-4006 | Critical | High |  |
| 09 Payroll | Bonuses | COMPLETE | EV-4028, EV-4014 | Medium | Medium |  |
| 09 Payroll | Commissions | MISSING | EV-4029 | Low | High |  |
| 09 Payroll | GOSI employee/employer contributions | PARTIAL | EV-4009, EV-4010, EV-4011 | Critical | High |  |
| 09 Payroll | Payroll periods / runs / generation | PARTIAL | EV-4002, EV-4003, EV-4017, EV-4030 | Critical | High |  |
| 09 Payroll | Approval, locking, payment status | PARTIAL | EV-4014, EV-4015, EV-4016, EV-4018 | Critical | High |  |
| 09 Payroll | Recalculation / retroactive changes | MISSING | EV-4018, EV-4019, EV-4020 | High | High |  |
| 09 Payroll | Payslips (employee visible) | COMPLETE | EV-4023, EV-4024 | High | Medium |  |
| 09 Payroll | Payroll history and reports | PARTIAL | EV-4034, EV-4021 | Medium | Medium |  |
| 09 Payroll | Bank / WPS / Mudad file | MISSING | EV-4022, EV-4035 | Critical | High |  |
| 09 Payroll | Final settlement in payroll | DISCONNECTED | EV-4025, EV-4033, EV-4313 | High | High |  |
| 09 Payroll | Money type and rounding | PARTIAL | EV-4001 | Medium | High |  |
| 10 Saudi compliance | Qiwa integration | MISSING | EV-5001, EV-5084 | High | High |  |
| 10 Saudi compliance | GOSI contribution calculation (payroll) | COMPLETE | EV-5005, EV-5006, EV-5007, EV-5008, EV-5009, EV-5010, EV-5076 | Critical | High |  |
| 10 Saudi compliance | GOSI platform integration (registration, wage sync, invoices) | MISSING | EV-5004, EV-5005 | High | High |  |
| 10 Saudi compliance | GOSI for GCC nationals | PARTIAL | EV-5083 | Medium | Medium |  |
| 10 Saudi compliance | WPS / Mudad salary file | MISSING | EV-5002, EV-5003 | Critical | High |  |
| 10 Saudi compliance | Nitaqat / Saudization estimate | PARTIAL | EV-5023, EV-5024, EV-5025, EV-5026, EV-5027, EV-5028, EV-5029 | High | High |  |
| 10 Saudi compliance | Localization (occupation Saudization) decisions | PARTIAL | EV-5079, EV-5024, EV-5025 | Medium | Medium |  |
| 10 Saudi compliance | Muqeem integration | PARTIAL | EV-5012..EV-5020, EV-5076 | High | High |  |
| 10 Saudi compliance | Absher / Tamm integration | MISSING | EV-5004 | Low | High |  |
| 10 Saudi compliance | Government platform credential vault | PARTIAL | EV-5021, EV-5022 | Medium | High |  |
| 10 Saudi compliance | EOSB (art.84/85) | COMPLETE | EV-5032, EV-5033, EV-5034, EV-5035, EV-5072 | Critical | High |  |
| 10 Saudi compliance | Working hours 48 h/week and Ramadan 36 h (art.98) | MISSING | EV-5046, EV-5047 | High | High |  |
| 10 Saudi compliance | Public holidays (Eid, National Day) calendar | MISSING | EV-5048 | Medium | High |  |
| 10 Saudi compliance | Overtime annual cap 720 h | PARTIAL | EV-5049, EV-5081 | Medium | High |  |
| 10 Saudi compliance | Statutory leave rules | COMPLETE | EV-5036, EV-5037, EV-5038 | High | Medium |  |
| 10 Saudi compliance | Contract term rules (non-Saudi fixed term) | PARTIAL | EV-5050, EV-5051 | Medium | High |  |
| 10 Saudi compliance | Probation max 180 days (art.53) | PARTIAL | EV-5039, EV-5040, EV-5081 | Medium | High |  |
| 10 Saudi compliance | Notice periods (art.75) | PARTIAL | EV-5041, EV-5042, EV-5043, EV-5044 | Medium | High |  |
| 10 Saudi compliance | Art.77 unlawful termination compensation | PARTIAL | EV-5052, EV-5044 | Medium | High |  |
| 10 Saudi compliance | Regulatory expiry alerts (iqama, passport, contract, probation, licences) | COMPLETE | EV-5055, EV-5056 | High | Medium |  |
| 10 Saudi compliance | Regulatory alerts for Nitaqat / GOSI / WPS | MISSING | EV-5057, EV-5080 | Medium | High |  |
| 10 Saudi compliance | Compliance violations register | PARTIAL | EV-5053, EV-5054 | Low | High |  |
| 10 Saudi compliance | Compliance reporting (regulatory reports) | MISSING | EV-5002, EV-5004, EV-5057 | Medium | Medium |  |
| 10 Saudi compliance | Labor-law parameter register (single source of truth) | DISCONNECTED | EV-5045, EV-5043, EV-5042, EV-5082, EV-5078 | Medium | High |  |
| 10 Saudi compliance | PDPL controls | PARTIAL | EV-5058, EV-5059, EV-5060, EV-5061 | High | Medium |  |
| 10 Saudi compliance | Hijri dates | PARTIAL | EV-5030, EV-5031 | Low | High |  |
| 11 ESS | Profile / dashboard (GET /api/portal) | COMPLETE | EV-6001, EV-6007 | High | High |  |
| 11 ESS | IDOR protection across ESS write endpoints | COMPLETE | EV-6001..EV-6007 | Critical | High |  |
| 11 ESS | Attendance (self clock-in/out, GPS + face) | COMPLETE | EV-6002, EV-6015, EV-6016 | Critical | High |  |
| 11 ESS | Leave requests, balance, cancellation | COMPLETE | portal/page.tsx:300-432,435-465,645-685 | High | Medium |  |
| 11 ESS | Attendance correction requests (self-service) | COMPLETE | EV-6003 | High | High |  |
| 11 ESS | Loan request | PARTIAL | portal/page.tsx:687-730 (server side deferred to Domain 09) | Medium | Low |  |
| 11 ESS | Letters / certificates (document engine + fallback) | PARTIAL | portal/page.tsx:146-151,554-561 (primary path deferred to Domain 04) | Medium | Low |  |
| 11 ESS | Asset (custody) self-request | COMPLETE | EV-6012 | Medium | High |  |
| 11 ESS | Contract termination / resignation request | COMPLETE | EV-6005 | High | High |  |
| 11 ESS | Face enrollment / biometric consent lifecycle | COMPLETE | EV-6004 | Critical | High |  |
| 11 ESS | Payslip view / print | PARTIAL | portal/page.tsx:817-841 (client-built print, not signed PDF; only last 5 shown) | Low | High |  |
| 11 ESS | Total rewards statement | COMPLETE | EV-6006 | Medium | Medium |  |
| 11 ESS | Evaluation acknowledgment | COMPLETE | portal/page.tsx:313-323,467-493 | Medium | Medium |  |
| 11 ESS | Circulars shown without company scoping within a tenant | PARTIAL | EV-6027 | Medium | High |  |
| 12 MSS | Company->Branch->Department->Team scoping | COMPLETE | EV-6008, EV-6009, EV-6013 | Critical | High |  |
| 12 MSS | Team dashboard (department detail, stats) | COMPLETE | EV-6013, EV-6014 | High | High |  |
| 12 MSS | Approvals: leave, attendance correction (manager stage) | COMPLETE | dept-manager/route.ts:163-199; hr-workflows.ts multi-site assertCanManageEmployee calls | Critical | High |  |
| 12 MSS | Overtime / work-task / penalty assignment | COMPLETE | EV-6011 | High | High |  |
| 12 MSS | Hiring request / onboarding submission (manager-initiated) | COMPLETE | manager-portal/route.ts:262-269,277-310,405-482 | Medium | High |  |
| 12 MSS | Return-from-leave notice | COMPLETE | EV-6039 | Medium | Medium |  |
| 12 MSS | Asset requests raised on behalf of a team member | COMPLETE | EV-6012 | Medium | High |  |
| 12 MSS | Manager's own request history / team history feed | COMPLETE | manager-portal/route.ts:105-217 | Medium | High |  |
| 12 MSS | Scope-boundary functions lack dedicated automated tests | PARTIAL | EV-6029, EV-6900, EV-6901 | Medium (adjusted from High by adversarial verification F-1) | High | (gap) |
| 13 Performance | Evaluation templates (sections, weighted items) | COMPLETE | EV-7001, EV-7002 | Medium | High |  |
| 13 Performance | Evaluation cycles (create/enroll/close) | COMPLETE | EV-7003, EV-7004 | High | Medium |  |
| 13 Performance | Manager scoring + submission workflow | COMPLETE | EV-7005, EV-7006, EV-7007 | High | High |  |
| 13 Performance | Approval workflow (approve/return) | COMPLETE | EV-7008 | Medium | Medium |  |
| 13 Performance | Employee acknowledgement | PARTIAL | EV-7009 | Low | Medium |  |
| 13 Performance | Self-assessment | MISSING | EV-7010 | Medium | High |  |
| 13 Performance | 360-degree feedback | MISSING | EV-7011 | Medium | High |  |
| 13 Performance | Competency ratings / calibration | MISSING | EV-7012 | Medium | High |  |
| 13 Performance | PIP tracking | MISSING | EV-7013 | Medium | High |  |
| 13 Performance | Recommendation -> promotion/compensation feed | DISCONNECTED | EV-7014, EV-7908, EV-7909, EV-7910 | Medium (verifier-adjusted from High) | High |  |
| 13 Performance | Evaluation dashboard/reports | COMPLETE | EV-7015 | Medium | Medium |  |
| 13 Performance | PDF evaluation report | COMPLETE | EV-7016 | Low | Medium |  |
| 14 Learning | Training / course catalog | MISSING | EV-7021, EV-7906, EV-7907 | High | High |  |
| 14 Learning | Training requests / approvals | MISSING | EV-7022 | High | High |  |
| 14 Learning | Enrollment / course attendance | MISSING | EV-7023 | Medium | High |  |
| 14 Learning | Certificates | MISSING | EV-7024 | Medium | High |  |
| 14 Learning | Skills / competencies / learning paths | MISSING | EV-7025 | Medium | High |  |
| 14 Learning | Training cost / effectiveness / history | MISSING | EV-7026 | Medium | Medium |  |
| 15 Benefits | Medical insurance policy register | PARTIAL | EV-4101, EV-4102, EV-4105 | Medium | High |  |
| 15 Benefits | Employee enrollment / plan assignment | PARTIAL | EV-4101, EV-4103, EV-4912 | High | High |  |
| 15 Benefits | Dependents | MISSING | EV-4103, EV-4104 | Medium | High |  |
| 15 Benefits | Eligibility rules / packages | MISSING | EV-4104, EV-4106 | Medium | High |  |
| 15 Benefits | Employer / employee contribution | MISSING | EV-4107 | Medium | High |  |
| 15 Benefits | Benefit history | MISSING | EV-4101, EV-4103 | Low | High |  |
| 15 Benefits | CCHI / insurer integration | MISSING | EV-4104 | Medium | High |  |
| 15 Benefits | Annual air tickets | MISSING | EV-4108 | Medium | High |  |
| 15 Benefits | Total rewards statement | PARTIAL | EV-4106 | Low | Medium |  |
| 16 Employee finance | Loans / salary advances | PARTIAL | EV-4201, EV-4202, EV-4203, EV-4204, EV-4214 | High | High |  |
| 16 Employee finance | Installment schedule | PARTIAL | EV-4201, EV-4205 | Medium | High |  |
| 16 Employee finance | Deductions request -> approval -> payroll | PARTIAL | EV-4212, EV-4213, EV-4013 | High | High |  |
| 16 Employee finance | Payment requests with maker-checker | COMPLETE | EV-4209, EV-4210, EV-4211 | High | High |  |
| 16 Employee finance | Expenses / reimbursements / claims | MISSING | EV-4207, EV-4208 | Medium | High |  |
| 16 Employee finance | Travel expenses / per diem | MISSING | EV-4215 | Low | High |  |
| 16 Employee finance | Employee finance -> payroll integration | PARTIAL | EV-4205, EV-4013, EV-4036 | High | High |  |
| 17 Assets/Custody | Asset (custody item) CRUD | COMPLETE | EV-7027 | Medium | High |  |
| 17 Assets/Custody | Custody assign/transfer/clear/damage actions | COMPLETE | EV-7028 | Medium | High |  |
| 17 Assets/Custody | Telecom SIM as custody item | COMPLETE | EV-7029 | Low | High |  |
| 17 Assets/Custody | Vehicles / utility meters as custody | PARTIAL | EV-7030 | Medium | Medium |  |
| 17 Assets/Custody | Asset needs request 3-stage approval -> fulfilment | COMPLETE | EV-7031, EV-7032 | High | High |  |
| 17 Assets/Custody | Offboarding integration (termination blocks on unreturned assets) | PARTIAL | EV-7033, EV-7034, EV-7900, EV-7901, EV-7903, EV-7904, EV-7905 | Medium (verifier-adjusted from Critical) | High | (verifier-adjusted from DISCONNECTED) |
| 17 Assets/Custody | Offboarding integration (termination blocks on unpaid loans) | PARTIAL | EV-7036, EV-7902, EV-7903 | Low-Medium (verifier-adjusted from Critical) | High | (verifier-adjusted from DISCONNECTED) |
| 18 Offboarding | Resignation / employee separation request | PARTIAL | EV-4301, EV-4302, EV-4303, EV-4304, EV-4305 | High | High |  |
| 18 Offboarding | Employer termination (direct) | COMPLETE | EV-4306, EV-4307 | High | High |  |
| 18 Offboarding | Notice period / last working day | PARTIAL | EV-4303, EV-4301 | Medium | High |  |
| 18 Offboarding | EOSB calculation (arts. 84/85) | COMPLETE | EV-4308, EV-4309, EV-4310, EV-4325 | Critical | High |  |
| 18 Offboarding | Final settlement | PARTIAL | EV-4311, EV-4313, EV-4316, EV-4317, EV-4328 | Critical | High |  |
| 18 Offboarding | Leave encashment at exit | PARTIAL | EV-4313, EV-4322 | High | High |  |
| 18 Offboarding | Clearance | PARTIAL | EV-4318, EV-4319 | Medium | High |  |
| 18 Offboarding | Asset return | PARTIAL | EV-4318, EV-4319 | Medium | Medium |  |
| 18 Offboarding | Access revocation | COMPLETE | EV-4307, EV-4306, EV-4323 | High | High |  |
| 18 Offboarding | Exit interview | MISSING | EV-4321 | Low | High |  |
| 18 Offboarding | Final payroll | DISCONNECTED | EV-4033, EV-4025, EV-4313 | High | High |  |
| 18 Offboarding | Art. 77 compensation / notice pay | DISCONNECTED | EV-4314, EV-4910 | High | High |  |
| 18 Offboarding | Service / experience certificate (art. 64) | COMPLETE | EV-4320 | Medium | Medium |  |
| 18 Offboarding | Exit documents (acceptance, statement, clearance) | COMPLETE | EV-4326, EV-4319 | Medium | Medium |  |
| 18 Offboarding | Payment deadline tracking (art. 88) | COMPLETE | EV-4315 | Medium | High |  |
| 18 Offboarding | Archive / final exit visa | PARTIAL | EV-4324, EV-4307 | Low | Low |  |
| 19 Workflow engine | Generic/configurable workflow-definition engine | MISSING | EV-8001, EV-8002 | Medium | High |  |
| 19 Workflow engine | Per-module guarded status machines (Leave/Transfer/AttendanceCorrection/etc.) | COMPLETE | EV-8003, EV-8004 | High | High |  |
| 19 Workflow engine | Maker-checker / self-approval prevention (payments) | COMPLETE | EV-8006, EV-8007, EV-8008 | Critical | High |  |
| 19 Workflow engine | OwnerRequest tracked directive workflow | PARTIAL | EV-8009, EV-8010 | Low | High |  |
| 19 Workflow engine | Evaluation approval trail (EvaluationApproval) | PARTIAL | EV-8011 | Medium | Low |  |
| 19 Workflow engine | Cancellation (Leave) | COMPLETE | EV-8005, EV-8013 | Medium | High |  |
| 19 Workflow engine | Resubmission after rejection | MISSING | EV-8012 | Low | High |  |
| 19 Workflow engine | Delegation of approval authority (routing, not signing) | MISSING | EV-8014 | Medium | High |  |
| 19 Workflow engine | Escalation on timeout | MISSING | EV-8014 | Medium | High |  |
| 19 Workflow engine | SLA tracking on pending approvals | MISSING | EV-8014 | Medium | High |  |
| 19 Workflow engine | Approval reminders | MISSING | EV-8014 | Medium | High |  |
| 19 Workflow engine | Document approval chain (snapshot-bound, versioned) | COMPLETE | EV-8015, EV-8016 | High | High |  |
| 20 Notifications | Email delivery pipeline (outbox, retry, idempotency, lease) | COMPLETE | EV-8017, EV-8018, EV-8019 | High | High |  |
| 20 Notifications | Business-event triggers: documents engine | COMPLETE | EV-8021 | High | High |  |
| 20 Notifications | Business-event triggers: leave/payments/transfers/attendance/assets/owner-requests | PARTIAL | EV-8020, EV-8022, EV-8900, EV-8901, EV-8902, EV-8903, EV-8904 | High | High | (verifier: was DISCONNECTED) |
| 20 Notifications | In-app notification center (persisted, read/unread) | PARTIAL | EV-8023, EV-8905 | Medium | High | (verifier: was MOCKED) |
| 20 Notifications | SMS channel | MISSING | EV-8024, EV-8025 | Medium | High |  |
| 20 Notifications | Push channel | MISSING | EV-8024 | Low | High |  |
| 20 Notifications | WhatsApp channel | MISSING | EV-8024, EV-8025 | Medium | High |  |
| 20 Notifications | Notification templates (data-driven, editable) | MISSING | EV-8026 | Low | High |  |
| 20 Notifications | Per-user notification preferences | MISSING | EV-8026 | Low | High |  |
| 20 Notifications | Scheduled reminder digests (expiry-digest, documents-integrity) | COMPLETE | EV-8022 | Medium | High |  |
| 20 Notifications | Arabic/RTL email formatting | PARTIAL | EV-8027 | Low | Medium |  |
| 20 Notifications | Operational readiness (SMTP provider actually configured) | PARTIAL | EV-8017, EV-8018, EV-8019, EV-8906, EV-8907 | High | High | (verifier: aligned with finding H-4; was MISSING) |
| 21 Reporting/Analytics | Owner report (financial + compliance overview) | COMPLETE | EV-7041, EV-7042, EV-7043 | High | High |  |
| 21 Reporting/Analytics | Role-scoped dashboard KPIs | COMPLETE | EV-7044, EV-7045 | High | High |  |
| 21 Reporting/Analytics | Unified alerts aggregation | COMPLETE | EV-7046 | Medium | Medium |  |
| 21 Reporting/Analytics | Payroll export | COMPLETE | EV-7047 | Medium | Medium |  |
| 21 Reporting/Analytics | Workforce overview/benchmarks (turnover, time-to-hire, cost) | COMPLETE | EV-7048, EV-7049 | Medium | Medium |  |
| 21 Reporting/Analytics | Absenteeism rate (dedicated metric) | MISSING | EV-7050 | Medium | High |  |
| 21 Reporting/Analytics | Training / learning reporting | MISSING | EV-7051 | Low | High |  |
| 21 Reporting/Analytics | Performance reporting (evaluation dashboard) | COMPLETE | EV-7052 | Medium | Medium |  |
| 21 Reporting/Analytics | Saudization / Nitaqat reporting | COMPLETE | EV-7053 | Medium | Low-Medium |  |
| 22 Workforce planning | Headcount plans (create, positions, raises, workflow) | COMPLETE | EV-5062, EV-5065, EV-5066, EV-5075, EV-5077 | High | High |  |
| 22 Workforce planning | Plan cost forecast from real employee data | COMPLETE | EV-5063, EV-5064, EV-5072, EV-5077 | High | High |  |
| 22 Workforce planning | Plan vs actual (payroll) | COMPLETE | EV-5067, EV-5077 | Medium | Medium |  |
| 22 Workforce planning | Scenarios / plan comparison / sensitivity | COMPLETE | EV-5071, EV-5075, EV-5077 | Medium | Medium |  |
| 22 Workforce planning | Nitaqat impact of a plan | PARTIAL | EV-5063, EV-5024, EV-5025 | Medium | High |  |
| 22 Workforce planning | Plan -> recruitment requisitions | DISCONNECTED | EV-5068, EV-5069 | Medium | High |  |
| 22 Workforce planning | Budget integration | MISSING | EV-5070 | Medium | High |  |
| 22 Workforce planning | Demand / capacity / staffing-gap modelling | MISSING | EV-5070, EV-5047 | Medium | High |  |
| 22 Workforce planning | Branch staffing view | PARTIAL | EV-5062, EV-5064 | Low | Low |  |
| 22 Workforce planning | Plan execution (plan -> salary changes / hires) | MISSING | EV-5063, EV-5068 | Medium | High |  |
| 22 Workforce planning | Access scoping by legal company | PARTIAL | EV-5073, EV-5074 | Medium | Medium |  |
| 23 AI / decision intelligence | LLM/agent integration (chat, generation, NL-to-SQL, ranking) | MISSING | EV-8028, EV-8029, EV-8030 | N/A (by design) | High |  |
| 23 AI / decision intelligence | On-premise ML face service (correctly not "AI agent") | COMPLETE | EV-8031 | N/A (classification) | High |  |
| 23 AI / decision intelligence | Workforce rule-based decision support (not AI) | COMPLETE | EV-8032, EV-8033 | N/A (classification) | High |  |
| 24 Security | Password authentication | COMPLETE | EV-9003, EV-9004, EV-9007, EV-9009 | Critical | High |  |
| 24 Security | Brute-force protection / lockout | PARTIAL | EV-9007, EV-9008, EV-9055, EV-9057 | High | High |  |
| 24 Security | Password policy | PARTIAL | EV-9011 | Medium | High |  |
| 24 Security | Multi-factor authentication | MISSING | EV-9010 | High | High |  |
| 24 Security | Self-service password reset | MISSING | EV-9012 | Low | High |  |
| 24 Security | Session management and revocation | COMPLETE | EV-9004, EV-9006, EV-9013, EV-9014, EV-9066 | Critical | High |  |
| 24 Security | Cookie security flags | COMPLETE | EV-9006 | High | High |  |
| 24 Security | Route-level auth guard coverage (246 handlers) | COMPLETE | EV-9001, EV-9002, EV-9003, EV-9065 | Critical | High |  |
| 24 Security | Role-based authorization (code-defined) | COMPLETE | EV-9015, EV-9069 | Critical | High |  |
| 24 Security | Configurable RBAC (RolePermission) | UI_ONLY | EV-9016 | Medium | High |  |
| 24 Security | Manager team scope (ABAC) | COMPLETE | EV-9021, EV-9058, EV-9059, EV-9060 | High | High |  |
| 24 Security | Company isolation for company-scoped staff | PARTIAL | EV-9017, EV-9018, EV-9019, EV-9072 | High | High |  |
| 24 Security | Field-level permissions (salary, IBAN, ID) | PARTIAL | EV-9020, EV-9023, EV-9068 | High | High |  |
| 24 Security | Document / file access control | COMPLETE | EV-9022, EV-9023, EV-9024, EV-9025 | Critical | High |  |
| 24 Security | IDOR protection on [id] routes | COMPLETE | EV-9058, EV-9059, EV-9060, EV-9061, EV-9062, EV-9063 | High | Medium |  |
| 24 Security | Privilege escalation protection | COMPLETE | EV-9032, EV-9071 | Critical | High |  |
| 24 Security | Maker-checker on payments | PARTIAL | EV-9033, EV-9073 | High | High |  |
| 24 Security | Payroll segregation of duties | MISSING | EV-9034 | High | High |  |
| 24 Security | Secrets management | COMPLETE | EV-9005, EV-9040, EV-9041, EV-9042, EV-9044 | Critical | High |  |
| 24 Security | Encryption at rest | PARTIAL | EV-9035, EV-9036, EV-9043 | High | High |  |
| 24 Security | Gov-platform credential vault | COMPLETE | EV-9037 | High | High |  |
| 24 Security | Audit logging | PARTIAL | EV-9038, EV-9039 | High | High |  |
| 24 Security | Upload validation | COMPLETE | EV-9026, EV-9027 | Medium | High |  |
| 24 Security | Public routes (/apply, /offer, /v) | COMPLETE | EV-9027, EV-9028, EV-9029 | Medium | High |  |
| 24 Security | CSRF protection | PARTIAL | EV-9006, EV-9031 | Medium | High |  |
| 24 Security | Security headers / CSP | PARTIAL | EV-9030 | Medium | High |  |
| 24 Security | Error handling without leakage | COMPLETE | EV-9056 | Low | High |  |
| 24 Security | Database least privilege | COMPLETE | EV-9044, EV-9046 | High | High |  |
| 24 Security | Backup confidentiality | PARTIAL | EV-9043 | Medium | High |  |
| 24 Security | Terminated-employee access cut-off | COMPLETE | EV-9066, EV-9025 | High | High |  |
| 24 Security | Security test coverage | PARTIAL | EV-9025, EV-9057 | Medium | High |  |
| 25 Multi-tenancy | Per-tenant deployment / process | COMPLETE | EV-9045 | Critical | High |  |
| 25 Multi-tenancy | Per-tenant database and role | COMPLETE | EV-9044, EV-9046 | Critical | High |  |
| 25 Multi-tenancy | Per-tenant secrets | COMPLETE | EV-9044, EV-9046, EV-9067 | Critical | High |  |
| 25 Multi-tenancy | Storage separation (UPLOAD_DIR) | COMPLETE | EV-9044, EV-9045, EV-9047 | High | High |  |
| 25 Multi-tenancy | Tenant-aware background jobs | COMPLETE | EV-9047 | High | High |  |
| 25 Multi-tenancy | Cross-tenant session/cookie leakage prevention | COMPLETE | EV-9006, EV-9067, EV-9004 | Critical | High |  |
| 25 Multi-tenancy | Shared sidecar services (face, render) | PARTIAL | EV-9048 | Low | Medium |  |
| 25 Multi-tenancy | Intra-tenant company isolation | PARTIAL | EV-9017, EV-9018, EV-9019, EV-9072, EV-9054 | High | High |  |
| 25 Multi-tenancy | Company-scoped administrator | MISSING | EV-9015, EV-9017 | Medium | High |  |
| 25 Multi-tenancy | Database row-level security | MISSING | EV-9049 | Low | High |  |
| 25 Multi-tenancy | Cascading deletes on HR history | PARTIAL | EV-9050, EV-9052 | Medium | High |  |
| 25 Multi-tenancy | Soft deletion / historical records | MISSING | EV-9051 | Low | Medium |  |
| 25 Multi-tenancy | Tenant manager panel security | COMPLETE | EV-9046 | High | Medium |  |
| 25 Multi-tenancy | Tenant-level backup separation | PARTIAL | EV-9043 | Medium | High |  |
| 25 Multi-tenancy | Tenant-wide circulars (no company) | PARTIAL | EV-9053 | Low | High |  |
| 26 Mobile | PWA installability (manifest) | COMPLETE | EV-6017 | Medium | High |  |
| 26 Mobile | Offline support | MISSING | EV-6018 | Low | High | (by design) |
| 26 Mobile | Location (GPS) capture for attendance | COMPLETE | EV-6015 | Critical | High |  |
| 26 Mobile | Camera capture for face verification | COMPLETE | EV-6016 | Critical | High |  |
| 26 Mobile | Responsive layout (phone-width usability) | PARTIAL | portal/page.tsx responsive classes; PortalTabBar.tsx; manager pages unverified | Medium | Medium |  |
| 26 Mobile | Push / SMS notifications to the mobile portal | MISSING | SYSTEM_MAP EV-0014/0015, corroborated | Medium | High |  |
| 27 Arabic/RTL | Bilingual UI (Arabic/English toggle) | MISSING | EV-6019, EV-6020 | Medium | High |  |
| 27 Arabic/RTL | RTL layout correctness | COMPLETE | src/app/layout.tsx:31; 15-file dir="rtl" sample | High | Medium |  |
| 27 Arabic/RTL | Font (Arabic typography) | COMPLETE | src/app/layout.tsx:2,7-11; EV-6035 | Medium | High |  |
| 27 Arabic/RTL | Hijri / Gregorian date handling | PARTIAL | EV-6021, EV-6022 | Medium | High |  |
| 27 Arabic/RTL | Currency formatting (SAR, Arabic-Indic digits) | COMPLETE | EV-6033 | Medium | High |  |
| 27 Arabic/RTL | Validation and error messages | COMPLETE | sampled across Domains 11/12 routes | Medium | High |  |
| 27 Arabic/RTL | Transliteration (Arabic -> English name suggestion) | COMPLETE | EV-6034 | Low | Medium |  |
| 27 Arabic/RTL | Mixed Arabic/English data (bilingual names) | PARTIAL | EV-6036 | Low | High |  |
| 27 Arabic/RTL | Official PDF documents in Arabic (document engine) | PARTIAL | EV-6035 (source only, not rendered in this pass) | Medium | Medium |  |
| 28 Testing | Unit tests of pure domain calculators (payroll/GOSI/EOSB/leave/attendance) | COMPLETE | EV-10001,EV-10002,EV-10003,EV-10004,EV-10005 | High | High |  |
| 28 Testing | Route-handler (HTTP-level) tests | PARTIAL | EV-10006,EV-10007,EV-10008,EV-10009,EV-10010,EV-10902 | High | High |  |
| 28 Testing | Helper-module tests reached through `@/app/api/**/_lib` imports | PARTIAL | EV-10008,EV-10011 | High | High |  |
| 28 Testing | Database-integration tests (documents pipeline, Muqeem mock contract) | DISCONNECTED | EV-10012,EV-10013,EV-10014,EV-10015 | High | High |  |
| 28 Testing | Authorization core (`requireUser`) unit tests | PARTIAL | EV-10016,EV-10900,EV-10901 | Medium | High |  |
| 28 Testing | Edge authentication middleware (`src/proxy.ts`) tests | MISSING | EV-10017,EV-10911 | Medium | High |  |
| 28 Testing | Maker-checker rule tests | PARTIAL | EV-10018,EV-10019 | Medium | Medium |  |
| 28 Testing | File-scope access control tests | COMPLETE | EV-10020,EV-10005 | Medium | Medium |  |
| 28 Testing | Attendance lateness tests | COMPLETE | EV-10021 | Medium | High |  |
| 28 Testing | Sidecar service tests (render, face) wired into CI | DISCONNECTED | EV-10022,EV-10023,EV-10024,EV-10913 | Medium | High |  |
| 28 Testing | E2E / browser tests | MISSING | EV-10025,EV-10912 | High | High |  |
| 29 Infrastructure | Deployment (Dockerfile/docker-compose/pm2) | COMPLETE | EV-10101,EV-10102,EV-10103 | High | Medium |  |
| 29 Infrastructure | CI/CD pipeline trigger correctness | UNSAFE | EV-10104,EV-10105,EV-10106,EV-10903 | High | High |  |
| 29 Infrastructure | Migrations CI verification (drift + idempotent seed) | COMPLETE | EV-10107 | Critical | High |  |
| 29 Infrastructure | Backups (encryption, offsite, retention) | PARTIAL | EV-10108,EV-10109,EV-10110,EV-10111,EV-10904,EV-10905,EV-10906 | High | High |  |
| 29 Infrastructure | Restore (tested?) | PARTIAL | EV-10112,EV-10113,EV-10907 | High | High |  |
| 29 Infrastructure | Scheduled background jobs (systemd/cron actually installed) | PARTIAL | EV-10114,EV-10115,EV-10116,EV-10117,EV-10908,EV-10909,EV-10910 | High | High |  |
| 29 Infrastructure | Job idempotency / concurrency safety | COMPLETE | EV-10118,EV-10119,EV-10120 | High | Medium |  |
| 29 Infrastructure | Logging / monitoring / observability | PARTIAL | EV-10121,EV-10122,EV-10123 | Medium | High |  |
| 29 Infrastructure | Rate limiting | PARTIAL | EV-10124,EV-10125 | Medium | High |  |
| 29 Infrastructure | Disaster recovery documentation (RUNBOOK/DATABASE) | COMPLETE | EV-10126 | Low | Medium |  |
| 30 UX | Navigation / menu, permission-mirrored | COMPLETE | EV-6024, EV-6030 | High | High |  |
| 30 UX | Error boundaries (route-level) | PARTIAL | EV-6023, EV-6038 | Medium | High |  |
| 30 UX | Loading states (route-level) | PARTIAL | EV-6023, EV-6038; portal/page.tsx:495-506 (ad hoc pattern) | Low | Medium |  |
| 30 UX | Empty states | COMPLETE | portal/page.tsx:526-534,920 | Low | Medium |  |
| 30 UX | Confirmation dialogs for destructive/formal actions | COMPLETE | EV-6031, EV-6032 | Medium | High |  |
| 30 UX | Toast / inline feedback for async actions | COMPLETE | consistent pattern across Domain 11/12 submit handlers | Medium | High |  |
| 30 UX | Fetch-target integrity (no calls to nonexistent APIs) | COMPLETE | EV-6025 | Medium | Medium | (sample) |
| 30 UX | Pagination on request/queue lists | PARTIAL | EV-6026 | Medium | Medium |  |
| 30 UX | Dead buttons / stub features | COMPLETE | EV-6037 | Low | Medium | (no counter-example found) |
| Platform/DB | Schema/migration integrity (baseline→9p, drift-checked in CI) | COMPLETE | EV-11018, EV-11019, EV-11014, EV-11015 | High | High |  |
| Platform/DB | Money stored with exact precision (no float rounding risk) | PARTIAL | EV-11002, EV-11003, EV-11900, EV-11901, EV-11902 | High | High |  |
| Platform/DB | Multi-entity tenant ownership (Employee → legal/actual Company via FK) | COMPLETE | EV-11004 | High | High |  |
| Platform/DB | Company hard-delete safety (deletion blockers) | PARTIAL | EV-11006 | Medium | Medium |  |
| Platform/DB | Employee hard-delete safety / no destructive cascade in practice | COMPLETE | EV-11007 | High | High |  |
| Platform/DB | Lifecycle status values enforced at the DB layer (enum/CHECK) | PARTIAL | EV-11008, EV-11009, EV-11010, EV-11903, EV-11904 | Medium | High |  |
| Platform/DB | Single source of truth for employee salary | PARTIAL | EV-11011, EV-11012, EV-11013 | Medium | High |  |
| Platform/DB | Immutability / audit-trail guarantee for decided change orders | COMPLETE | EV-11014 | Medium | High |  |
| Platform/DB | No orphaned/unused schema surface | PARTIAL | EV-11016, EV-11017 | Low | Medium |  |
| Platform/DB | Referential integrity of "*ById" audit/actor columns | PARTIAL | EV-11021 | Low | Medium |  |
| Platform/DB | Indexing of high-cardinality lookups | COMPLETE | EV-11020 | Medium | Medium |  |
| Platform/API | Route inventory / auth-guard coverage | COMPLETE | EV-11022, EV-11023, EV-11024, EV-11025, EV-11026 | High | Medium |  |
| Platform/API | Scoped file-access control with audit logging | COMPLETE | EV-11028 | High | High |  |
| Platform/API | Upload endpoint auth boundary (anonymous cases) | UNKNOWN | EV-11027 | Medium | Low |  |
| Platform/API | Centralized, non-leaking error handling | COMPLETE | EV-11029, EV-11030 | Medium | High |  |
| Platform/API | Input validation coverage on write endpoints | COMPLETE | EV-11031, EV-11032, EV-11033, EV-11034 | High | Medium |  |
| Platform/API | Route↔page connectivity (no orphaned/undead endpoints found in sample) | PARTIAL | EV-11035, EV-11036, EV-11037, EV-11038 | Low | Low |  |
| Platform/API | Route-level (HTTP-wiring) automated test coverage | PARTIAL | EV-11039, EV-11040, EV-11905, EV-11906 | Medium | High |  |

## Scorecard derived from this matrix

| Domain | Total | Complete | Partial | UI_only | Backend_only | Mocked | Broken | Disconnected | Unsafe | Unknown | Missing | Critical/High rows not COMPLETE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 Core HR | 18 | 9 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 2 |
| 02 Organization | 18 | 9 | 2 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 5 | 1 |
| 03 Contracts | 12 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| 04 Documents | 18 | 15 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| 05 Recruitment | 11 | 4 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 5 | 1 |
| 06 Onboarding | 13 | 7 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 4 | 2 |
| 07 Attendance | 24 | 4 | 9 | 0 | 0 | 0 | 1 | 2 | 0 | 0 | 8 | 10 |
| 08 Leave | 26 | 8 | 10 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 6 | 5 |
| 09 Payroll | 18 | 3 | 10 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 3 | 12 |
| 10 Saudi compliance | 26 | 4 | 13 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 8 | 7 |
| 11 ESS | 14 | 10 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 12 MSS | 9 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| 13 Performance | 12 | 6 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 4 | 1 |
| 14 Learning | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 2 |
| 15 Benefits | 9 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 1 |
| 16 Employee finance | 7 | 1 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 3 |
| 17 Assets/Custody | 7 | 4 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| 18 Offboarding | 16 | 6 | 7 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 1 | 5 |
| 19 Workflow engine | 12 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 |
| 20 Notifications | 12 | 3 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 2 |
| 21 Reporting/Analytics | 9 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| 22 Workforce planning | 11 | 4 | 3 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 3 | 0 |
| 23 AI / decision intelligence | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| 24 Security | 31 | 16 | 11 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 8 |
| 25 Multi-tenancy | 15 | 7 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 1 |
| 26 Mobile | 6 | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| 27 Arabic/RTL | 9 | 5 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| 28 Testing | 11 | 3 | 4 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 2 | 4 |
| 29 Infrastructure | 10 | 4 | 5 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 4 |
| 30 UX | 9 | 6 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Platform/DB | 11 | 5 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| Platform/API | 7 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |

Totals across 420 rows: COMPLETE 181, PARTIAL 124, UI_ONLY 1, BACKEND_ONLY 0, MOCKED 0, BROKEN 2, DISCONNECTED 15, UNSAFE 1, UNKNOWN 4, MISSING 92. These counts are **not** a completeness percentage: rows differ enormously in weight (a missing WPS file is not comparable to a missing org-chart widget).
