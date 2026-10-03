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

Run: people-os-red-team (Opus), commit fb8e001, brief = owner 10 focus points + 6 conflations; OA-1..11 not re-reported. Verbatim report:

AGENT: people-os-red-team · Mode D · Commit fb8e001 (HEAD; origin/master 5e57859; `git rev-list --count origin/master..HEAD` → 24)

FINDINGS (none of them repeat OA-1..11)

**LR-1 CRITICAL · §3, §5 stage 3. The settlement dependency chain is circular, and the plan hides it.**
- Evidence: BL-OFF-001 depends on BL-LCY-008 (BACKLOG.md:279). BL-OFF-007 depends on 006, and 006 depends on 001 (:282-283). BL-OFF-007/008 ship in T0 with BL-PAY-008b (:543). The fixed order is {PAY-008b, PAY-026, OFF-007/008} → PAY-009 → LEV-013 → LCY-008 (:545).
- What is wrong: LCY-008 has to come both before and after OFF-007. The plan cites the order as "fixed by BACKLOG.md:46" (that line is inside BL-PAY-001), then quietly reorders it: M3-4 is listed with no dependencies and BL-LEV-013 is moved to LB.
- Plan v2: an owner or architect decision that breaks the cycle, recorded in BACKLOG. Correct the citation.

**LR-2 CRITICAL · §2.2, §3. A pilot blocker depends on a launch blocker.**
- Evidence: BL-PAY-009 (PB, on the critical path) depends on BL-PAY-006 and BL-PAY-020 (BACKLOG.md:203). BL-PAY-020 is the WPS file (H-4, LB). The plan never names BL-PAY-020.
- BL-PAY-006 is only partly built: schema.prisma has no BankExport, BankCertificate or lineStatus.
- Plan v2: put the WPS file and the rest of BL-PAY-006 on the pilot path, or re-scope BL-PAY-009.

**LR-3 HIGH · M3-3, DS-2, the Decimal row. Frozen money design gets built before it is reopened.**
- M3-3 builds the deduction and loan caps and EmployeeDebt. Those are the collection-ownership parts that DEC-PO-139 freezes as "not build-ready" (DECISIONS.md:119-121). M3-3 runs before DS-2.
- DS-2 starts on "ExitCase + EmployeeDebt". DEC-PO-139 also requires settlement reversal and exit cancellation to exist in code first. No package builds them: BL-LCY-015 reverse is absent from the plan.
- The rule "new money tables in Decimal(14,2)" pulls P6-MONEY forward. DOMAIN_MODEL.md:93 keeps halala Floats until P6-MONEY. The only justification given is "no extra cost", and there is no ADR.
- Plan v2: put DS-2 before the M3-3 caps/debt work. Add the missing preconditions. Decide Decimal through an ADR.

**LR-4 HIGH · RE-9, §7.4, risk 4. "Onboard identity and mark readiness before deploying" cannot be done.**
- The vendor commands write tables that only exist after 9zk–9zm are applied.
- The `controls-ready` command (src/modules/iam/vendor-cli.ts:167-170) is not documented in RUNBOOK 3.5.1: `rg controls-ready docs ops` returns nothing.
- What every tenant hits on day one:
  - ENFORCED refusals (guards.ts:76-80).
  - Legacy payment rows with no recorded requester or approver cannot be paid (UNKNOWN_APPROVER, guards.ts:126-132).
  - Link confirmation needs an attested person (identity.ts:399), but every user starts UNATTESTED (9zk:55).
  - HR can no longer replace an IBAN; only the employee can, from the portal (financial-change.ts:188).
- Plan v2: a named go/no-go for R1 that lists these effects, a deploy window, and tenant notice.

**LR-5 HIGH · §9(a)3. "Queues worked off in staging" is untestable.**
- LEGACY_UNVERIFIED IBANs can only be cleared by each employee in the production portal (financial-change.ts:4,475). HR review work done on a restored staging copy is thrown away.
- Plan v2: measure the queues after deploy in production, with a target count and a date.

**LR-6 HIGH · §7.5, S0-2, (a)11. Rollback per migration is not possible as described.**
- One pre-deploy dump covers all 24 migrations (deploy.sh:185,308-312).
- Migrations run while the old app is still live, with lock_timeout=10s (deploy.sh:22). If the canary fails, "nothing was switched", but the database is already migrated.
- 9x stops the deploy if CompanyDocument has rows (9x:35). That check is not in S0-3.
- Constraints left NOT VALID still refuse any update to a violating legacy row (9x:10-12; 9zf:240). Classing a row "EXPLAINED" does not make it editable again.
- §7.4 omits these data steps: the 9zb, 9zf and 9zk backfills, the 9zh settlement update, and the 9zm DELETE.
- The 9zd drop costs nothing in production: approvalEffects was added in c4530e3 and was never deployed (`git log -S approvalEffects`).
- 8_ is one plain CREATE INDEX on a table that is already in production (7_). Its risk is LOW.
- Plan v2: an all-or-nothing rollback model, a rehearsed migration failure partway through, and a staging check for CompanyDocument and NOT VALID constraints.

**LR-7 HIGH · §2.1. The GA scope cannot be met as defined, and the pilot scope is too large.**
- Lifecycle #4's weakest edges are leave→attendance and the visa deadline (AUDIT/04:162). The plan puts ATT in PL and Muqeem in FUT.
- Lifecycle #7 is DOC, which is only DISCOVERED (STATE.md:19), and no LB package builds it.
- For a shadow pilot, the PB list still includes D, F, G, I, J and M. It also includes WFE-010/011, which BACKLOG marks P2 and AUDIT/14 marks "out of phase 2".
- Plan v2: trim the GA lifecycle list, and give the shadow pilot its own blocker list.

**LR-8 HIGH · §0, §1.1, §6. The plan treats "exists" as "done".**
- The definition of done (AUDIT/13:312-325) requires migration on a real data copy, reconciliation on the customer's copy, and E2E tests. No phase 0/1 package meets it.
- Yet the plan says "phases 0 and 1 done" and calibrates its estimates on that.
- Plan v2: report "built, not accepted".

**LR-9 MEDIUM · §11. The AI mapping misses four things.**
- Face enrollment does tenant-wide 1:N identification across all companies (portal/face/route.ts:126-138). That is biometric identification, a PDPL matter.
- The CI `face-service` job downloads models from GitHub (ci.yml:260-281; download_models.py:24,31). With §9(a)2 "all jobs green" as a required check, ML becomes a release dependency, against DEC-PO-148.
- R1 ships face hardening (7dc214e, c0b64c3), including the fix to the Docker path of the biometric purge job. Face code is already in production (services/face is in the origin/master tree).
- New tenants get FACE_SERVICE_* environment variables (new-tenant.sh:155-192).

**LR-10 MEDIUM · WPS and Muqeem tiers.**
- The plan cites "auditor knowledge" for WPS, but E5 evidence exists (EVD-CMP-006..009).
- EVD-CMP-007 says the employer uploads a bank-signed file. By the plan's own GOSI reasoning, the WPS export is then product or operational work, not a legal blocker.
- GA criterion (b)2, "accepted by the bank", requires Radeef to be the system of record. That contradicts shadow mode.
- FUT does not mean switched off. The Muqeem client is live code; Plan v2 should verify MUQEEM_ENABLED=false on every tenant (config.ts:68).

**LR-11 MEDIUM.** INV-SCOPE-01 is "BLOCKING (for release)" (ARCHITECTURE_INVARIANTS:104). R1 ships with ARCH-016.test at 6, and the plan gates this only at the pilot.

**LR-12 MEDIUM · §3. Critical-path errors.**
- The D→E arrow is wrong: E only needs B (AUDIT/14:59).
- F does not wait on SES to be built; SES is needed at deploy.
- The R1 deploy does not block the PAY-008b build.
- Missing from the path: golden cases from counsel and the accountant (C10), and the pilot tenant's payroll calendar.

**LR-13 MEDIUM · §6. Cost: the arithmetic is right, the calibration is not.**
- Recomputed: 7,667,791 tokens since routing; Sonnet+Haiku 628,082 (8.2%); 15.21M in total.
- The Chair's own runs are excluded, so cost is understated.
- AUDIT/14 forecast 40% Opus for phase 2. Packages A–C actually ran at 81.9% Opus (1.50M of 1.83M). The plan's 70–80% has no mechanism behind it.
- Agent time "3–6 weeks" does not match the logged throughput: 888.7 min for 7.67M tokens is 0.52M per hour, so 15–25M is about 29–48 agent-hours.

**LR-14 LOW · bookkeeping.**
- AUDIT/13:201 lists P1-PAY-A as still remaining, and RELEASE_NOTES:44 is about the NOTICE flag. Neither supports "built".
- The code does exist (src/modules/platform/money/).
- BL-PAY-003 (ARCH-004=6 still open) and BL-PAY-006 should be marked PARTIAL, not DONE.
- The 10-04 dates repeat in the freeze header and DEC-PO-148, while fb8e001 is dated 2026-10-03 22:18.

VERIFIED CORRECT
- 24 migrations since origin.
- Baseline total 225, `growth` empty, per-rule counts as stated.
- ARCH-016.test entries: 5 documents routes and auth/me.
- `ACTIVATION_BLOCKERS` (activation.ts:13).
- 92 Float and 3 Decimal in the schema; twoFactor columns only.
- The release-notes base commit and the migration-table gaps.
- BL-PAY-001/002/003/006/008/024/012 show TODO.
- ONB: REDESIGNED v14 in AUDIT/13:301 vs READY v16.1 in STATE.md:14.
- DEC-PO-147 and BL-WFE-014 are dated 10-04.
- `.gitignore:75`.
- deploy.sh:47 defaults to `origin/main`.
- Self-attendance is off by default (self-attendance.ts:53).
- Face is the only ML inference: package.json has no AI SDK.

UNVERIFIED / COULD NOT CHECK
- Whether Prisma wraps each migration in a transaction and the exact order it applies 8_ in: needs a staging run.
- Tenant count and production env/timers.
- Whether pilot employees have portal accounts (owner/data).
- Whether BL-LCY-003 (Release B) is complete: BACKLOG status not reconciled.

Key files: C:\Users\saif\Pictures\radeef-main\AUDIT\17_LAUNCH_PLAN_v1.md, C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\backlog\BACKLOG.md, C:\Users\saif\Pictures\radeef-main\ops\deploy.sh, C:\Users\saif\Pictures\radeef-main\prisma\migrations\9x_db_constraints\migration.sql, C:\Users\saif\Pictures\radeef-main\src\modules\iam\vendor-cli.ts, C:\Users\saif\Pictures\radeef-main\src\app\api\portal\face\route.ts


## 3. Owner decisions taken in this audit

Recorded as DEC-PO-148:
- R1 is an Infrastructure / Hardening Release, not a product launch.
- No AI/ML feature is a launch dependency. Face self-attendance stays optional, off by default, post-launch (not removed now: no scope change during launch planning). Workforce NL assistant: FUTURE. Automatic absence detection: POST-LAUNCH.
- Government integrations: FUTURE for baseline GA; customer/contract-specific if required.
- Money redesign closure rule: max 3 rounds unless a new Critical/High invariant appears; convergence over count.
- Plan v1 frozen as evidence baseline; Plan v2 only after red team and owner decisions. General Request stays on hold until this audit closes.
