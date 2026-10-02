# Executive summary: 360° evidence-first audit of Radeef HRMS

**Date:** 2026-09-27
**Code audited:** `master` at `b556235`, plus the uncommitted document-engine work on disk (migration `9p_transfer_decision`, TRANSFER_DECISION)
**Changes to application code:** none. Everything this audit wrote is under `AUDIT/`.
**Method:** discovery by the orchestrator, then 11 specialist groups covering all 30 domains plus a database/API check. Each group's Critical and High findings were re-checked by an independent adversarial verifier. A cross-domain auditor then traced 9 employee lifecycles.
**Scale:** 23 agents, 781 evidence entries ([12_AUDIT_EVIDENCE_LEDGER.md](12_AUDIT_EVIDENCE_LEDGER.md)), 420 capability rows ([02_COMPLETE_CAPABILITY_MATRIX.md](02_COMPLETE_CAPABILITY_MATRIX.md)).
**Adversarial verification:** 60 Critical and High findings verified. 29 were confirmed as stated and 31 were adjusted, mostly in severity and some in status. One adjustment, A-9, reversed the specialist's conclusion to COMPLETE. The final statuses below are the post-verification ones.

## 1. Current product state

Radeef is a broad, Arabic-first, Saudi-focused HR system: Next.js 16 + Prisma/PostgreSQL, 109 pages, 153 route files with 246 API handlers, and 91 tables (EV-0002, EV-0004, EV-9001). It runs as **one deployment and one database per customer** (EV-0011). Inside a customer, several legal entities (`Company`) share one database.

Engineering quality is high where effort was focused. Around those areas, the product consists of well-built modules that are **not joined into end-to-end HR lifecycles**. The recurring pattern: each module is correct on its own, but the seams between modules are missing, manual, or contradicted by the UI.

## 2. Major strengths (verified)

| Strength | Evidence |
|---|---|
| **Authentication and API guarding.** All 246 API handlers require a session except the intended public ones. Sessions are revocable and checked against the database on every request. Escalation to SUPER_ADMIN is blocked and tested. | EV-9001, EV-9002, EV-9004, EV-9032 |
| **Tenant isolation.** Separate database, DB role, secrets, upload directory and job runs per customer. | EV-9044, EV-9045 |
| **Document-issuance engine.** Snapshot → approval → render → issue pipeline, DB-enforced immutability, hash-chained event log, PAdES seal, public QR verification. The most mature subsystem in the product. | 04_documents.md, EV-2035 |
| **Self clock-in.** GPS geofence, fail-closed face and liveness check (on-premise), server time, versioned consent, PDPL purge of selfies and templates. | EV-3012, EV-3018, EV-3056 |
| **Statutory calculators.** Correct against the law as implemented: EOSB (arts. 84/85), annual leave 21/30 (art. 109), sick-leave tier sizes (art. 117), GOSI dated rates with 1,500–45,000 clamp and old/new regimes. | EV-4308, EV-3030, EV-5006, EV-5032 |
| **ESS/MSS isolation.** Employee self-service derives the employee id from the session and never trusts the client. Manager scope is enforced inside the shared workflow functions. | EV-6008, EV-6009, 11_ess.md |
| **File access control.** Category-based rules, anti-enumeration, audit on every sensitive read. | EV-2005, EV-2006, EV-11028 |
| **Schema hygiene in CI.** Migrations applied to an empty Postgres, drift check, idempotent seed. | EV-0021 (but see CI trigger below) |
| **Money rounding.** Every amount is rounded to halalas through `money.ts`, which mitigates the Float storage. | EV-4001 |

## 3. Critical gaps

1. **No WPS / Mudad salary file.** Salaries cannot be paid through the system in a wage-protection-compliant way. "WPS" is a label, and the export says it is not a WPS file. **MISSING** (EV-4022, EV-5002, EV-5003).
2. **Attendance has no effect on pay or discipline.** No code ever records an absence, and payroll never reads attendance. Absences are paid unless someone keys a manual penalty, and absence KPIs always show 0. **MISSING + DISCONNECTED** (EV-3009, EV-3022, EV-4004). One of three verifiers rated the payroll half High because the manual penalty route exists; see 10_MISSING_FEATURES.md C2.

## 4. Critical and high risks

| Risk | Status | Evidence |
|---|---|---|
| **One user can generate, approve and mark payroll paid** (FINANCE_MANAGER, PAYROLL_ADMIN and COMPANY_ADMIN are in both the PAYROLL and FINANCE groups; no maker-checker; no approvedBy). | MISSING control | EV-4016, EV-9034 |
| **No company isolation inside a tenant, except in documents.** Payroll is one run and one approval for all legal entities. | PARTIAL | EV-4003, EV-9017, EV-9072 |
| **No MFA** on accounts that can read national IDs, IBANs, salaries and government-portal passwords. | MISSING | EV-9010 |
| **CI does not run on the branch the team pushes to.** It triggers on `main`; only `master` exists. | UNSAFE | EV-0021, EV-10104 |
| **Backups are local and unencrypted, off-site is opt-in, and restore has never been tested.** | PARTIAL | EV-10108, EV-10112 |
| **Only 4 of 7 background-job timers are enabled by the runbook.** apply-employee-changes, documents-integrity and documents-retention are never enabled. | PARTIAL | EV-10114, EV-10908 |
| **Nothing is e-mailed today.** No SMTP provider is chosen and `OUTBOX_SEND` is off. The outbox has no TTL, so enabling it sends a stale backlog first. | PARTIAL | EV-8019, EV-0014 |
| **Final settlement can underpay or leave items unsettled.** No final-month GOSI, open deductions or bonuses; art. 77 and notice pay only as manual entries. Payroll drops the employee once a settlement exists. | DISCONNECTED | EV-4313, EV-4314, EV-4033 |
| **Leave → attendance is broken.** `ON_LEAVE` is set by a paid leave settlement and never cleared, so every later punch is flagged. | BROKEN | EV-3016, EV-3017 |

## 5. False completeness

Full list: [11_FALSE_COMPLETENESS.md](11_FALSE_COMPLETENESS.md), 39 items. The most consequential:

- **The WPS payment label** (EV-4022).
- **Attendance minutes and "absent" counters**, which never reach pay and are always 0 (EV-3009, EV-3022).
- **The "accept hiring and start work" button.** It creates no employee (EV-2022).
- **The onboarding "work commencement notice".** Always skipped because new hires get no legal company (EV-0026, EV-0027).
- **The "cannot complete termination" banner.** Browser-only (EV-7033).
- **The role-permissions settings page.** Menu only (EV-9016).
- **`UserCompanyScope`.** Honoured only by documents (EV-9017).
- **The 2FA columns.** Unused (EV-9010).
- **The notification bell.** A live 5-item query (EV-8023).
- **The labour-law rule register.** Read only by planning (EV-5045).
- **The CI pipeline.** Wrong branch (EV-10104).
- **"1,584 passing tests".** Almost all pure functions; about 140 of 149 API routes have no handler test; the only DB end-to-end suite is not in CI (EV-10008, EV-10012).

## 6. Architectural problems

1. **No shared lifecycle backbone.** Each module has its own status strings and transition code (EV-8001), and about 35 status columns are unenforced strings (EV-11008). Cross-module hand-offs are therefore missing rather than configured: hire → employee, request → settlement, evaluation → raise, plan → requisition, leave → attendance.
2. **Duplicated sources of truth** (04_CROSS_DOMAIN_DEPENDENCIES.md). Some examples:
   - Basic salary is held in 7 places, and payroll reads the live value while cost engines rebuild history from SalaryChange (EV-12025).
   - Employment status is held twice: `isTerminated` and `employmentStatus` (EV-12020).
   - Exit reason has three vocabularies (EV-12021).
   - The shift is joined by name string (EV-12018).
   - The leave–visa link is an id inside free text (EV-12011).
   - `jobs.mjs` re-implements change-order and alert logic (EV-12007, EV-12014).
   - Labour-law constants live in both RuleParameter and code (EV-5045).
3. **Two tenancy layers, only one enforced.** The per-customer database is strong. The per-company layer inside a customer exists only in the document engine (EV-9017).
4. **Two transfer mechanisms with no mutual guard.** Neither updates the legal company (EV-1038, EV-12016).
5. **Tests stop at the pure-function boundary.** DB workflows (generate payroll, approve settlement, approve loan, approve onboarding) have no automated test (EV-4026, EV-4027, EV-2028).

## 7. High-impact missing capabilities

- Saudi integrations: WPS/Mudad, Qiwa and GOSI are **MISSING**. Muqeem is proven only against a mock (EV-5001, EV-5004, EV-5018).
- Public holiday and Ramadan calendars, and the 48 h/36 h limits (EV-3006, EV-5046).
- Absence detection (EV-3009).
- Biometric device import (EV-3008).
- Timesheets (EV-3010).
- Retroactive pay (EV-4019).
- Candidate → employee conversion (EV-2022).
- Onboarding task tracking (EV-2010).
- The whole learning domain (EV-7021).
- Medical-insurance enrollment and dependants (EV-4101, EV-1003).
- Emergency contacts (EV-1002).
- Positions, grades and cost centers (EV-1021).
- Approval delegation, escalation and SLA (EV-8014).
- MFA (EV-9010).
- English UI (EV-6019).
- E2E tests (EV-10025).

## 8. Scorecard by domain

Derived from the 420-row matrix. It is **not** a completeness percentage: a missing WPS file outweighs any number of convenience features.

| Domain | Total | Complete | Partial | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | UI-only | Critical gaps | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 Core HR | 18 | 9 | 4 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | History not viewable; emergency contacts, dependants | High |
| 02 Organization | 18 | 9 | 2 | 5 | 0 | 0 | 1 | 0 | 1 | 0 | Two transfer paths; no positions/grades/cost centers | High |
| 03 Contracts | 12 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | Three unaudited writers of contract fields | Medium-High |
| 04 Documents | 18 | 15 | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | Upload versioning; new hires blocked by missing legal company | High |
| 05 Recruitment | 11 | 4 | 1 | 5 | 0 | 0 | 1 | 0 | 0 | 0 | HIRED → employee | High |
| 06 Onboarding | 13 | 7 | 1 | 4 | 0 | 0 | 1 | 0 | 0 | 0 | No task tracking; no legal company | High |
| 07 Attendance | 24 | 4 | 9 | 8 | 1 | 0 | 2 | 0 | 0 | 0 | Absence, payroll link, holidays, Ramadan, devices | High |
| 08 Leave | 26 | 8 | 10 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | ON_LEAVE broken; backdating; encashment | High |
| 09 Payroll | 18 | 3 | 10 | 3 | 0 | 0 | 2 | 0 | 0 | 0 | WPS, SoD, per-company, retro, attendance | High |
| 10 Saudi compliance | 26 | 4 | 13 | 8 | 0 | 0 | 1 | 0 | 0 | 0 | WPS, Qiwa, GOSI, art. 98, art. 77 | High |
| 11 ESS | 14 | 10 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | High |
| 12 MSS | 9 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Scope boundary untested | High |
| 13 Performance | 12 | 6 | 1 | 4 | 0 | 0 | 1 | 0 | 0 | 0 | Recommendation → pay; no self/360 | Medium-High |
| 14 Learning | 6 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | Entire domain | High |
| 15 Benefits | 9 | 0 | 3 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | Enrollment, dependants, CCHI | High |
| 16 Employee finance | 7 | 1 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | Loan SoD; no expenses | High |
| 17 Assets | 7 | 4 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | UI/server policy mismatch | High |
| 18 Offboarding | 16 | 6 | 7 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | Request → settlement; settlement items | High |
| 19 Workflow engine | 12 | 4 | 2 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | No delegation/escalation/SLA | High |
| 20 Notifications | 12 | 3 | 4 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | Nothing delivered; most events silent | High |
| 21 Reporting | 9 | 7 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | Absenteeism rate | Medium-High |
| 22 Workforce planning | 11 | 4 | 3 | 3 | 0 | 0 | 1 | 0 | 0 | 0 | Plan not linked to hiring/budget | High |
| 23 AI | 3 | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | None (absent by design) | High |
| 24 Security | 31 | 16 | 11 | 3 | 0 | 0 | 0 | 0 | 0 | 1 | MFA, payroll SoD, company isolation | High |
| 25 Multi-tenancy | 15 | 7 | 5 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | Intra-tenant company isolation | High |
| 26 Mobile | 6 | 3 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | No push | High |
| 27 Arabic/RTL | 9 | 5 | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | No English UI | High |
| 28 Testing | 11 | 3 | 4 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | Route/DB/E2E tests | High |
| 29 Infrastructure | 10 | 4 | 5 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | CI trigger, backups, restore, timers | High |
| 30 UX | 9 | 6 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | Medium |
| Platform/DB | 11 | 5 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Status enforcement, Float money | Medium-High |
| Platform/API | 7 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | Route tests | Medium |

## 9. Production readiness

**Not production-ready as a complete Saudi HR and payroll platform.**

It is closer to ready as an HR records, documents, self-service and approvals system for a single-company customer. The blockers:

1. No compliant salary payment file (WPS/Mudad).
2. Payroll that one person can approve and pay.
3. Attendance that does not affect pay.
4. Final settlements that can omit statutory items.
5. No company isolation for multi-entity customers.
6. No MFA.
7. No delivered notifications.
8. Backups without an off-site copy or a tested restore.
9. Scheduled jobs not all enabled.
10. CI that does not run on the working branch.

## 10. Corrections made during verification

These are recorded so the conclusions can be reproduced:

- **Conclusion reversed (A-9):** "no fixed-term/unlimited contract classification". It is derived from `contractEndDate` and used correctly (03_contracts.md, A-9).
- **Lowered:** "money as Float is UNSAFE". Halala rounding is applied throughout (K-1).
- **Lowered:** "termination not blocked on custody is Critical". The server blocks the clearance certificate, and warn-don't-block is a documented decision (G-1).
- **Lowered:** "requireUser has zero tests". One real test covers the no-session path (J-2).
- **Orchestrator tie-break:** the onboarding commencement notice is always skipped (EV-0026, EV-0027). This overrides verifier B-2.
