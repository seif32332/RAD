# Matrix B (Group B: 04 Documents, 05 Recruitment, 06 Onboarding)

| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| 04 Documents | Upload (validation, allow-list, magic-byte check) | COMPLETE | EV-2002, EV-2004 | High | High |
| 04 Documents | Storage (path safety, registry) | COMPLETE | EV-2001, EV-2003 | High | High |
| 04 Documents | Download / access control by role+category+scope | COMPLETE | EV-2005, EV-2006 | Critical | High |
| 04 Documents | Sensitive-document audit trail (VIEW logging) | COMPLETE | EV-2005 | High | High |
| 04 Documents | CompanyDocument tracking | PARTIAL | EV-2007 | Medium | Medium |
| 04 Documents | Renewals / expiry queue (multi-entity) | COMPLETE | EV-2008, EV-2009 | High | High |
| 04 Documents | Document versioning (uploaded files) | MISSING | EV-2001 (no version/parent field) | Medium | High |
| 04 Documents | Generated letters/certificates: request pipeline | COMPLETE | EV-2030, EV-2032, EV-2042 | Critical | High |
| 04 Documents | Snapshot immutability + approval-to-exact-hash | COMPLETE | EV-2031, EV-2033, EV-2035 | High | High |
| 04 Documents | Signature authorization (signatory / pre-auth) | COMPLETE | EV-2033 | High | High |
| 04 Documents | Document numbering / issuance atomicity | COMPLETE | EV-2031, EV-2032 | High | High |
| 04 Documents | Audit hash-chain (DocumentEvent) | COMPLETE | EV-2034, EV-2035 | High | High |
| 04 Documents | Digital seal (PAdES) | COMPLETE | EV-2036, EV-2037 | High | High |
| 04 Documents | Public verification (/v) | COMPLETE | EV-2038 | High | High |
| 04 Documents | Retention / purge / archive (jobs) | COMPLETE | EV-2041 | Medium | High |
| 04 Documents | Integrity monitoring job | COMPLETE | EV-2041 | Medium | High |
| 04 Documents | Test coverage (engine) | COMPLETE | EV-2039 | Medium | High |
| 04 Documents | In-progress transfer-decision doc type (uncommitted) | PARTIAL | EV-2040 | Low | Medium |
| 05 Recruitment | Manpower requisition (JobRequest) create/approve | COMPLETE | EV-2018, EV-2019 | High | High |
| 05 Recruitment | Candidate pipeline (apply -> interview -> offer -> hired) status machine | COMPLETE | EV-2020, EV-2021 | High | High |
| 05 Recruitment | Public application form (/apply) | COMPLETE | EV-2029 | Medium | Medium |
| 05 Recruitment | Offer generation + candidate self-service accept/decline | COMPLETE | EV-2024, EV-2025 | High | High |
| 05 Recruitment | CV parsing | MISSING | (no evidence found; resumeUrl is a raw upload only) | Low | Medium |
| 05 Recruitment | Interview scheduling | PARTIAL | EV-2020 (single `interviewDate` field only, no calendar/multi-round) | Medium | Medium |
| 05 Recruitment | Evaluation / scoring / assessments | MISSING | EV-2027 | Medium | High |
| 05 Recruitment | Talent pool | MISSING | EV-2026 | Low | High |
| 05 Recruitment | Recruitment analytics | MISSING | (no dashboard/report found for recruitment funnel) | Low | Medium |
| 05 Recruitment | Candidate -> Employee conversion on HIRED | **DISCONNECTED** (verifier CONFIRMED status) | EV-2022, EV-2023, EV-2900, EV-2902, EV-2903 | High (verifier-adjusted from Critical) | High |
| 05 Recruitment | Test coverage of pipeline/transitions | MISSING | EV-2028 | Medium | High |
| 06 Onboarding | OnboardingRequest submission (manager-portal) | COMPLETE | EV-2013 | High | High |
| 06 Onboarding | HR review/approval -> Employee creation | COMPLETE | EV-2014 | Critical | High |
| 06 Onboarding | Rejection flow | COMPLETE | EV-2015 | Medium | High |
| 06 Onboarding | Duplicate-identity / org-unit / manager validation | COMPLETE | EV-2014 | High | High |
| 06 Onboarding | Data-completeness flags (placeholder dates, nationality review) | COMPLETE | EV-2014, EV-2016 | Medium | High |
| 06 Onboarding | Document collection (attachments on the request) | COMPLETE | EV-2012 | Medium | High |
| 06 Onboarding | Checklist / task tracking (equipment, access, orientation, training) | MISSING (verifier CONFIRMED status; adjacent: commencement notice, dataReviewNote, Asset custody, probation alert) | EV-2010, EV-2017, EV-2904..EV-2908 | Medium (verifier-adjusted from High) | High |
| 06 Onboarding | User-account (login) creation on hire | MISSING/manual | EV-2011 (separate manual checklist step, not automated from OnboardingRequest approval) | Medium | Medium |
| 06 Onboarding | Probation lifecycle tracking as an onboarding step | MISSING | EV-2017 (probation date exists on Employee/renewals only) | Low | Medium |
| 06 Onboarding | Manager assignment | COMPLETE (as a data field) | EV-2012, EV-2014 | Medium | High |
| 06 Onboarding | Progress / completion tracking of onboarding steps | MISSING | EV-2010 (that page is company-setup, not per-hire onboarding progress) | Medium | High |
| 06 Onboarding | Recruitment -> Onboarding link (hired candidate becomes an onboarding case) | **DISCONNECTED** (verifier CONFIRMED status) | EV-2022, EV-2023, EV-2013, EV-2900..EV-2903 | High (verifier-adjusted from Critical) | High |
| 06 Onboarding | Unit test coverage (pure helpers) | PARTIAL | EV-2016 | Low | High |
