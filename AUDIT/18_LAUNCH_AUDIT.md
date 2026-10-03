# Launch plan release audit

Subject: AUDIT/17_LAUNCH_PLAN_v1.md (Plan v1, evidence baseline, frozen).
Process: owner audit (this file, §1) → red team (§2) → owner decisions (§3) → Plan v2. No package (including General Request) starts before Plan v2 is approved.

## 1. Owner audit findings (2026-10-04)

Verdict: strong as a programme map; not yet an approved execution plan. The backbone is right: R1 → Phase 2 → Money/Lifecycles → Pilot → Parallel payroll → GA. Separating "100% HRMS" from the GA launch line is correct. One red-team revision is needed, not a rewrite.

### Critical

| # | Finding | Required in Plan v2 |
|---|---|---|
| OA-1 | Commercial launch gate missing. Production-ready ≠ sellable. | New section "Commercial Readiness Gate" before GA: pricing, contract, SLA, onboarding procedure, data-migration service, support and escalation, billing, customer-admin training, employee onboarding, Arabic documentation, privacy notice, DPA / data-processing terms, support hours, incident communication, cancellation/offboarding procedure, data export on customer exit. |
| OA-2 | Customer exit (tenant offboarding) lifecycle missing. | Documented process at least: data export, retention, deletion, legal holds, employee documents, payroll history, audit records, backups, access revocation, billing termination. Part of the commercial/operational gate. |
| OA-3 | M3-3 (XL, 15–25M tokens) is a mini-programme; must not be built as one Opus package. | Split at least into M3-3A payroll snapshot + Decimal + coverage; M3-3B deduction/loan collection ownership + caps; M3-3C retro difference; M3-3D EmployeeDebt; M3-3E golden cases + reconciliation. Each with its own gate. |
| OA-4 | "R1 (ship what exists)" is misleading: R1 is not a product release (no user-visible approval flow). | Rename R1 = Infrastructure / Hardening Release: moving the current foundation from laptop-only to controlled production infrastructure. Not "launching Radeef". |

### High

| # | Finding | Required in Plan v2 |
|---|---|---|
| OA-5 | BL-IAM-001 must get a root-cause disposition, not "make CI green". Evidence today: intermittent identity test failure observed twice under load; not reproduced across three later fresh-DB runs; root cause open. | Either (A) find and close the root cause, or (B) prove it is a test-harness issue and not a race in production code. Never closed as "flaky" only. Stays in the release audit. |
| OA-6 | Legal requirements need explicit classification; no "legal leakage" from planning wording into acceptance criteria. | Every legal blocker carries one of: Verified statutory requirement / Counsel-confirmed requirement / Contractual customer requirement / Product decision / Operational recommendation. Especially WPS and PDPL. |
| OA-7 | Pilot gates conflated (shadow payroll ≠ pilot production). | Four explicit milestones with separate gates: P0 R1 production infrastructure (not sold as GA); P1 Pilot Shadow (real company, real data, parallel payroll, Radeef not system of record); P2 Pilot Operational (company uses Radeef in agreed scope with clear rollback); P3 GA (any qualified company can be onboarded). |
| OA-8 | Money redesign must not be bounded by round count alone. | Rule: at most 3 rounds unless a new Critical/High invariant is discovered; then finding → resolve → targeted review. The goal is convergence, not a number of rounds. |
| OA-4b | Release order: push → CI → deploy is wrong. | 0A Preserve (status, log origin/master..HEAD, tag backup-pre-release, push a backup branch) → 0B push shared source → CI → 0C CI triage (each failure classified: environmental / test defect / existing defect / regression / migration issue / security issue; no random fixes) → 0D release candidate → staging. No production directly after the first green CI. |
| OA-5b | "CI green twice" is not a production-readiness criterion. | Order of importance: CI validates the software; staging validates the release; real-tenant rehearsal (restore real tenant → migrate → reconcile → verify → rollback rehearsal) validates the migration. The real-tenant rehearsal is the key R1 test. |

### Medium

| # | Finding | Required in Plan v2 |
|---|---|---|
| OA-9 | "25–30% of the master plan" has no fixed denominator. | Drop it from management indicators. Replace with "Launch Scope Completion" per dimension: Infrastructure, Core HR, Payroll, Leave, Settlement, Workflow, Security, Saudi compliance, QA, Operations. |
| OA-10 | Government integrations as "FUTURE" must not become a permanent assumption. | Wording: "Future for baseline GA; customer/contract-specific blocker if required." FUTURE means "not required for this launch scope", not "not required". |
| OA-11 | AI must never enter the critical path. | Rule: no AI/ML feature is a launch dependency (see DEC-PO-148). |

## 2. Red team

To be filled after the red-team run (brief: owner's 10 focus points and 6 conflations; owner findings OA-1..11 are known and must not be re-reported, only extended or contradicted with evidence).

## 3. Owner decisions taken in this audit

Recorded as DEC-PO-148:
- R1 is an Infrastructure / Hardening Release, not a product launch.
- No AI/ML feature is a launch dependency. Face self-attendance stays optional, off by default, post-launch (not removed now: no scope change during launch planning). Workforce NL assistant: FUTURE. Automatic absence detection: POST-LAUNCH.
- Government integrations: FUTURE for baseline GA; customer/contract-specific if required.
- Money redesign closure rule: max 3 rounds unless a new Critical/High invariant appears; convergence over count.
- Plan v1 frozen as evidence baseline; Plan v2 only after red team and owner decisions. General Request stays on hold until this audit closes.
