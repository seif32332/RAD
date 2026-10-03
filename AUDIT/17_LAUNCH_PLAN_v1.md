> **Plan v1 — Evidence Baseline.** Frozen 2026-10-03 by owner instruction: not edited. Changes go through red team → findings → owner decisions → Plan v2 (AUDIT/18_LAUNCH_AUDIT.md).

# Radeef: plan from today to a full production launch ("إطلاق كامل")

**Basis.** The repo at HEAD d6bd888 on 2026-10-03, read-only. Every status claim cites a file and line or a doc section. **[UNVERIFIED]** marks anything I could not check from the repo, including anything about the production servers. This is a planning document: no code was changed, and it should be red-teamed before any work starts.

**Reading the tiers.** Each item sits in exactly one tier: the earliest gate it blocks.
- **PILOT BLOCKER (PB):** must be done before the first pilot company goes live on the new release. Because it comes first, it also blocks general availability (GA).
- **LAUNCH BLOCKER (LB):** must be done before GA, but not before the pilot.
- **POST-LAUNCH (PL):** important, but blocks neither gate.
- **FUTURE (FUT):** integrations and features outside the launch gate. A government integration is placed above FUT only where a legal or contractual reason is cited.

---

## 0. Summary

1. **Progress.** About 25–30% of the master plan is built (phases 0 and 1 done, phase 2 packages A–C done). The work so far is mostly the hidden foundations: the money gateway, company scope, employment state, the approval-engine core and identity controls. **No user-visible approval flow is live yet**: the engine is locked by `ACTIVATION_BLOCKERS = ['FIRST-TYPE']` (src/modules/workflow/activation.ts:13).
2. **Nothing new is in production.** All 23 commits since origin/master 5e57859 are local only. That includes 24 migrations (`8_attendance_punch_attendance_index`, `9o`…`9zn`) and fixes for confirmed money bugs that are still live in production: BL-PAY-027 (4b326dc) and BL-PAY-030 (9b85ca2) (BACKLOG.md:585,588). **The first recommended milestone is shipping what already exists (release R1), not building more.**
3. **The critical path to the pilot** is the payroll money core:
   - leave ledger, then per-line payroll snapshots and difference cases, then offboarding settlement (with the frozen money design reopened, DEC-PO-139), then legacy money attestation;
   - then a shadow payroll on the pilot tenant.
4. **GA is limited by the calendar, not by agent speed.** It needs two parallel payroll cycles and a 30-day zero-discrepancy window (AUDIT/13 §12.2–12.3). Estimates: pilot starts in about 8–12 weeks; GA in about 5–7 months.
5. **Recommended MVP line (owner decides):** core HR, leave, payroll and end-of-service settlement correct per legal company, the approval engine with the request types, a WPS **file** export, MFA, a minimum PDPL, backups, DR and monitoring. Attendance-to-payroll automation, full ORG, performance, learning, benefits and all government **API** integrations go to POST-LAUNCH or FUTURE.

---

## 1. Where we are

### 1.1 Progress per master-plan phase

| Phase | Built (code) | Evidence | % (estimate) | Exit gate status |
|---|---|---|---|---|
| 0 Stop the bleeding | P0-01..10 all built; P0-02 (9p) committed in c4530e3 | AUDIT/13:168-171; AUDIT/15:61,113 | ~90% | 0 of 4 gate items verified in production: CI has never run on GitHub (AUDIT/15:116); restore drill, timers and nightly reconcile on the server are [UNVERIFIED]; master protection waits for the first push (DEC-PO-130) |
| 1 Foundations + backbone | 1a: 8/8 packages (9t..9x). 1b: LCY, CAL, RULE, SCOPE, PAY-A, BL-LCY-012. P1-PAY-B: BL-PAY-004 (cdab83b), 005 (502b62a), 017/022 (2161b7a), 021 (599837c) | AUDIT/13:188,201,203; git log | ~90% | Not fully met. The gate says no money or state write outside the gateways (AUDIT/13:209), but the ratchet baseline still holds ARCH-004 = 6 (finance.ts 4, settlements/route.ts 2) and ARCH-002 = 69. INV gates on real tenant data have never been measured |
| 2 Approval engine + notifications | A schema (1d2e64d, 9zj), B core (b6b721c + c02605e), C guardrails (d6bd888, 9zn); R0 recon | AUDIT/14:35-56,74-81 | ~30% (3 of 13 packages, by weight) | Not met. 0 request types run through the engine (activation.ts:13); no Notification model (schema has only NotificationOutbox, schema.prisma:2672) |
| 3 Core lifecycles | Groundwork only: PayrollMonth per company (9zf); fixes BL-PAY-027/030; READY designs PAY, LCY, OFF, ONB (v16.1), LEV (+ lpb v9) | STATE.md:11-15 | ~5% | ATT and DOC are only DISCOVERED (STATE.md:16,19); ORG has no design (AUDIT/13:303) |
| 4 Talent / benefits / reports | Nothing under this plan (legacy evaluations and the workforce engine exist outside it) | AUDIT/13:245-256 | 0% | — |
| 5 Saudi integrations | Muqeem client code exists (54dcd45, before origin), not live-certified; Nitaqat seed script; no WPS | AUDIT/08:15,47; AUDIT/13:265 | ~10% | — |
| 6 Security / scale | Append-only AuditRecord (9t); encrypted IBAN with fingerprint (9zg). No MFA: only `twoFactorEnabled` / `twoFactorSecret` columns (schema.prisma:54-55), no verification code found. Money is still Float (92 `Float` lines in schema.prisma, 3 `Decimal`). CSP on 3 routes only | grep evidence | ~15% | — |
| 7 QA and release | No Playwright (not in package.json); no golden cases; no parallel run | — | 0% | — |
| **Overall** | | AUDIT/15:15 said 20–25% before 2A-C and identity | **~25–30%** | |

### 1.2 Verified, deployed, and drifted

**Verified (test runs reported by the Chair).**
- The latest full run was "2798 x2" by the agent, with the Chair seeing 4 of 5 runs green on d6bd888 (.claude/agent-usage.md, package C row).
- One flaky identity test is open (BL-IAM-001, BACKLOG.md:592).
- No drift between migrations and the schema was reported for 9zn [UNVERIFIED by me].

**Ratchet baseline** (src/test/architecture/baseline.json; `growth: []`):
- Went from 709 to 338 to **225** today.
- Remaining by rule: ARCH-002 69, ARCH-008 37, ARCH-007 30, ARCH-013 21, ARCH-009 17, ARCH-011 15, ARCH-001 10, ARCH-019 10, ARCH-004 6, ARCH-016.test 6 (all six are `documents/*` and `auth/me` routes with no real-auth scope test), ARCH-003 4.

**Invariants measured.**
- Checks run today for INV-DOC-01, INV-LCY-01, INV-ORG-01, INV-PAY-01, INV-PAY-02 and INV-RULE-02 (src/modules/platform/invariants/inv-*.ts).
- INV-SAL-01 and INV-PAY-04 are registered by their modules (src/jobs/consumers.ts:31,36).
- INV-EFF-01 is enforced by a DB constraint.
- The other 20 rows in §4.2.1 are "planned, not measured" (planned.ts:11-47).

**Deployed.** Production runs origin/master **5e57859 at most** [UNVERIFIED: no server access].
- Every commit from e43ec3e to d6bd888 is unpushed (`git rev-list --count origin/master..HEAD` = 23).
- `docs/RELEASE_NOTES_2026-10.md:3` assumes the release sits on top of b556235. That is wrong: b556235, e43ec3e, 74ebe77, c0b64c3, 7dc214e and e5792fa are also undeployed.
- The release notes' migration table (:96-117) omits `8_attendance_punch_attendance_index`, `9o`, and `9zg`…`9zn`.

**Bookkeeping drift** (fix before the red team):
- BACKLOG.md:45-86 still shows BL-PAY-001/002/003/006/008/024/012 as TODO, but they were built in P1-PAY-A (AUDIT/13:201, RELEASE_NOTES:44).
- AUDIT/13 §7 (:301) shows ONB as REDESIGNED v14, but STATE.md:14 shows READY v16.1.
- DEC-PO-147 and BL-WFE-014 are dated 2026-10-04, after today.

**Single point of loss.**
- `.claude/` (the council designs, BACKLOG, DECISIONS, routing) is git-ignored (.gitignore:75; AUDIT/15:35).
- Together with the 23 unpushed commits, this means one laptop holds the only copy.

### 1.3 Large and complete, but not ready to sell (and the reverse)

| Area | State | Why it is not sellable yet / what is missing |
|---|---|---|
| Approval engine (B + C) | Large, heavily tested, reviewed | Zero request types, no inbox, no notifications; activation is locked (activation.ts:13) |
| Identity and controls mode (BL-PAY-005/017/021) | Complete | Each tenant needs vendor-panel onboarding first (RUNBOOK 3.5.1:321-338). Until then companies stay ENFORCED and fail closed (ADR-0009:13,26) |
| Workforce decision engine, document engine (PAdES, verifiable letters) | Large, complete | Sellable, but outside the integrity backbone (baseline entries in workforce/* and documents/*) |
| Muqeem integration | Code complete | Not live-certified (P5-MQM, AUDIT/13:265) |
| Face self-attendance | Complete, off by default (settings/definitions.ts:103) | Needs pilot calibration (RUNBOOK §5.4:630-645) |
| Payroll | Looks complete in the UI | No WPS file (AUDIT/10 C1); settlement incomplete (H4-H6); attendance does not feed payroll (C2); money stored as Float |
| Money gateway, per-company payroll, scope layer | Small to the user's eye, but this is what makes Radeef sellable | Done, not deployed |

---

## 2. Launch gate

### 2.1 Recommended launch line (owner decides scope)

AUDIT/13 §12 ("متى نقول HRMS متكامل") is broader than a launch. It asks for all nine lifecycles COMPLETE, no Critical or High finding in a full 360° re-audit, and E2E across every journey (AUDIT/13:369-374). **Recommendation:** treat §12 as the "integrated HRMS" target after launch. GA uses the narrower gate below: §12.2, §12.3, §12.5 and §12.6 in full, with §12.1 and §12.4 limited to the lifecycles in launch scope.

- **Lifecycles in GA scope** (AUDIT/04:159-167): #1 Contract→Payroll, #4 Leave→Payroll, #6 Resignation→Settlement→Archive, #7 Document→Expiry→Notification, #8 Access→Offboarding→Revocation, plus #9 limited to "cross-company transfer is correct or refused".
- **Out of GA scope:** #2 Attendance→OT→Payroll, #3 Candidate→Onboarding (beyond today's flow), #5 Performance→Pay. These go to POST-LAUNCH.

### 2.2 Every item, classified

#### Release engineering and operations

| Item | Tier | One-line justification |
|---|---|---|
| RE-1 Push the 23 commits; first CI run green | PB | Nothing reaches production without it; the new CI jobs have never run (AUDIT/15:116) |
| RE-2 Protect master on GitHub | PB | Owner decision DEC-PO-130; parallel sessions edit the tree (CLAUDE.md) |
| RE-3 Fix the `ops/deploy.sh` default `REF=origin/main` (deploy.sh:47; RUNBOOK:259) | PB | Only `origin/master` exists, so a default deploy fails or picks a stale ref |
| RE-4 Complete release notes and per-migration rollback for 8_, 9o, 9zg..9zn | PB | RELEASE_NOTES:3,117 cover only up to 9zf |
| RE-5 Staging rehearsal on a restored copy of each tenant DB | PB | 24 migrations with backfills, CHECK/FK, triggers and irreversible steps (9x, 9zd; RELEASE_NOTES:204-223); no staging exists (none found in RUNBOOK) |
| RE-6 Encrypted off-site backup and a monthly drill, live in production | PB | P0-04 is built but its production state is [UNVERIFIED]; §12.6 |
| RE-7 SES, OWNER_ALERT_EMAIL, `OUTBOX_SEND` | PB | The owner digest fails without an owner contact (DEC-PO-144); decisions must reach people (RUNBOOK:425-452) |
| RE-8a Uptime check on /api/health plus alerts on failed JobRun, non-zero reconcile and a stuck outbox | PB | Minimum observability to run real payroll (RUNBOOK 3.3:276-280) |
| RE-8b Structured logs, request id, metrics (rest of P6-OBS) | LB | Needed to support many tenants, not one pilot |
| RE-9 Per-tenant root, named persons, attestation and readiness mark | PB | Otherwise ENFORCED mode blocks single-operator companies from approving payroll after deploy (ADR-0009:13) |
| RE-10 Legacy data reviews: EmploymentMigrationReview, LEGACY_UNVERIFIED IBANs, DEC-PO-138 settlement overlap | PB (per tenant, before its migration) | The data must be clean before the new gates read it |
| RE-11 BL-IAM-001 flaky identity tests | PB | CI cannot be a mandatory gate while it is flaky (agent-usage: Chair 4/5 green) |
| RE-12 Back up `.claude/` (council corpus) outside the laptop | PB | Only copy (.gitignore:75) |

#### Phase 2 (AUDIT/14 packages)

| Item | Tier | One-line justification |
|---|---|---|
| D Delegation (WFE-006) | PB | Needed for leave and offboarding approvals when an approver is absent |
| E Jobs, deadlines, exit, INV-WF-01 (WFE-004/005) | PB | The LEV and OFF adapters depend on BL-WFE-005 (BACKLOG WFE order 5, 10, 11) |
| F Inbox and email notifications, with the Notification ADR first (AUDIT/14:63) | PB | "Every decision reaches its owner" (phase 2 exit gate) |
| G "اعتماداتي" inbox and timeline (WFE-008) | PB | Approvers need somewhere to act |
| I REQ schema; J REQ adapters; M parity | PB | DEC-PO-145: the first request type goes live first, then expansion; the pilot is where that happens |
| H Editor /settings/workflows (WFE-007) | LB | DEC-PO-116 promises per-company editable defaults; the pilot can run on seeded v1 templates |
| K Retire legacy prefix requests (data move) | LB | Legacy flows keep working during the pilot |
| L Owner requests and the "طلباتي" portal | LB | Completes DEC-PO-131/133 |
| Web push | PL | DEC-PO-132 |
| BL-WFE-013, BL-PAY-031 | PL | P3 and P2, explicitly not blockers (BACKLOG:589-590; DEC-PO-145) |

#### Phase 3: money core and lifecycles

| Item | Tier | One-line justification |
|---|---|---|
| LEV core: BL-LEV-001, 008, 002, 005, 006, 007, 011, 012, 010, plus BL-WFE-010 | PB | Leave pay effects (sick-leave tiers, legal types, balances) flow into payroll; INV-LEV-01 blocks settlement (planned.ts) |
| PAY core: BL-PAY-008b (per-line approval, snapshots, retro difference), BL-PAY-026, BL-PAY-016, BL-PAY-007, BL-PAY-011; deduction caps (Arts 70/92/93), 10% loan cap, one daily-rate rule | PB | Legal caps; INV-PAY-01/03/04 need snapshots; WPS needs a snapshot (AUDIT/13:237) |
| New money tables (snapshot, settlement, debt) built as Decimal(14,2) | PB | Built that way from day one at no extra cost; halala-exact INV-PAY-01/03 |
| Reopen the money design (DEC-PO-139) once ExitCase and EmployeeDebt exist | PB | Settlement, debt and reversal cannot be built without it |
| OFF: BL-OFF-001, 002, 003, 005, 006, 007, 008, 012, plus BL-WFE-011; BL-PAY-028/029; BL-LCY-008 and BL-LCY-018 (prerequisites) | PB | End-of-service settlement is incomplete today (EV-4313, H4-H6); legal payout |
| BL-PAY-009 retro-attestation of legacy money | PB | Legacy money enters the gates with matched totals (AUDIT/13 §9) |
| ARCH-004 baseline down to 0 | PB | The phase 1 gate "no money write outside gateways" (AUDIT/13:209) |
| Cross-legal-company transfer: refuse in API and UI, or make it correct | PB | Lifecycle #9 is BROKEN/High (AUDIT/04:167); Q-LPB-1 |
| BL-OFF-004 (day-30 deemed acceptance), BL-OFF-009 (GOSI and Qiwa dated tasks), BL-OFF-010 (experience certificate) | LB | Legal process completeness; not needed to validate money in the pilot |
| BL-LCY-017 ContractPeriod, BL-LCY-004 Release C, BL-LCY-006 HR lists | LB | Release C needs J1 in every tenant (BACKLOG LCY order 10) |
| BL-LEV-003, 009, 013; BL-PAY-014 | LB | Notifications, badges, re-pricing, UI reasons |
| ONB: BL-ONB-001..006, 010, 011 | LB | Hiring with pay through a financial change; probation; catch-up pay. The pilot runs on existing employees |
| BL-ONB-007/008/009; BL-LEV-004; BL-OFF-011; BL-PAY-019/023; BL-LCY-007/009/013/014 | PL | P1/P2 polish |
| P3-ATT (DayRecord, automatic absence detection, attendance-to-payroll inputs), including its design round | PL (recommended; **owner decision**) | Needs a full design round (DISCOVERED only). The MVP keeps manual absence and overtime entries through the money gateway. Audit C2 rates this Critical, so if the owner pulls it into GA it joins the critical path (+L) |
| P3-ORG in full (Position, JobGrade, CostCenter, org chart) | PL | AssignmentPeriod and a minimal applyAssignment already exist (AUDIT/13:179) |

#### Phases 5–7: compliance, security, QA

| Item | Tier | One-line justification |
|---|---|---|
| P5-WPS **file export** from the approved snapshot, plus bank-return reconciliation, for the pilot's bank | LB | Legal: the MHRSD Wage Protection programme makes employers upload wage files (AUDIT/08:42,47, "auditor knowledge", counsel to confirm). A bank-accepted file is §12.3. DEC-002 already rules "files before integrations" (docs/council/DECISIONS.md:149,160) |
| Mudad API upload | FUT | No public spec; DEC-002 |
| P5-GOSI API registration and wage changes | FUT | The employer's legal duty is met on the GOSI portal; Radeef's legal exposure is a correct calculation (INV-GOSI-01, inside PAY core) |
| GOSI invoice reconciliation by file (INV-GOSI-02) | PL | HIGH but non-blocking invariant (planned.ts) |
| P5-QIWA | FUT | No contractual or legal requirement for the HRMS to integrate [contracts UNVERIFIED] |
| P5-MQM live certification | FUT | Code exists; **do not market it as live** until certified |
| P5-NIT Nitaqat seed for every new tenant | LB | New tenants otherwise get wrong Saudization numbers (S) |
| P5-PDPL minimum (access/export/correct requests, processing record, retention of leavers, audit of full-file views) | LB | Legal: Saudi PDPL [counsel to confirm the minimum] |
| P5-GCC GOSI | PL | Becomes LB only if a GA customer employs GCC nationals (counsel) |
| P5-HIJRI | PL | Display only |
| P6-MFA (TOTP for admin, finance, owner; step-up on approve and pay) | PB | Audit H3 High; real IBANs and payroll in the pilot; M size and parallel, so it does not lengthen the path |
| P6-WEB (global CSP, Origin check, persistent lockout, self-service reset) | LB | Public multi-tenant baseline |
| P6-AUTHZ minimum: enforce or remove the misleading RolePermission screen; keep identity documents away from finance roles | LB | False completeness (AUDIT/11); PDPL |
| P6-AUTHZ fine-grained permissions | PL | |
| P6-SCALE pagination and monthly indexes | LB | §10 targets; HR sees 500 rows today (AUDIT/13:344) |
| Redis, job queue, read models (multi-instance) | FUT | One instance per tenant today |
| P6-MONEY: migrate legacy Float columns | PL | Staged expand/contract; new tables are already Decimal (PB row above) |
| P6-CRYPT for national ID and files | PL | IBAN is already encrypted (9zg) |
| P6-I18N English UI | FUT unless the owner says otherwise (§11.4) | |
| Documents API scope tests (ARCH-016.test → 0) | PB | INV-SCOPE-01 is BLOCKING for release (ARCHITECTURE_INVARIANTS:104) |
| P7-GOLD initial set (accountant and counsel) | PB | The shadow run is meaningless without expected values |
| P7-GOLD full set; P7-E2E for MVP journeys; payroll performance test (5,000 employees in under 1 minute) | LB | §12.5 |
| P7-PARALLEL (2 cycles) and P7-UAT including counsel sign-off of provisional values | LB | §12.3; AUDIT/13:292 |
| Independent re-audit limited to launch scope | LB | §12.4, narrowed |

#### Phase 4, AI items, everything else

| Item | Tier | One-line justification |
|---|---|---|
| P4-PERF, P4-FIN, P4-CORE, P4-ASSET, P4-RPT, P4-WFP | PL | Not on any legal or money path for launch |
| P4-BEN, P4-LRN | FUT | |
| Face self-attendance calibration | PL | Optional and off by default; **see §11 (AI question)** |
| Workforce natural-language "assistant" | FUT | Not built; DEC-006 forbids LLM features (§11) |

---

## 3. Critical path

```
RE-1 push + CI ─► RE-5 staging rehearsal ─► R1 to production (pilot tenant first, then others)
                                                   │
Phase 2: D ─► E ─────────────────────────┐         │
                                         ▼         ▼
BL-LEV-001 ─► BL-LEV-008 ─► BL-PAY-008b + BL-PAY-026 (snapshots, Decimal)
       │                         │
       │      BL-LCY-018, BL-LCY-008 ─► BL-OFF-001 ─► BL-OFF-006 (ExitCase + EmployeeDebt in code)
       │                                                   │
       │                    reopen money design (DEC-PO-139), architect + red team
       │                                                   ▼
       └──────────────► BL-OFF-007/008 + BL-PAY-028/029 + WFE-010/011 adapters
                                                   ▼
                          BL-PAY-009 legacy money ─► P7-GOLD initial ─► PILOT shadow cycle 1
                                                   ▼
                    P5-WPS file (needs snapshots) ─► cycles 2–3 + bank acceptance + 30 days zero ─► GA
```

The order of the leave → payroll → settlement → legacy chain is fixed by BACKLOG (WF-LEV-002 §10, BACKLOG.md:46).

## 4. What runs in parallel with the critical path

| Track | Runs alongside | Constraint |
|---|---|---|
| Phase 2 F, G, H, I | After B (done) | Schema edits one at a time (AUDIT/14:55) |
| P6-MFA, P6-WEB, RE-8b, P5-PDPL, P5-NIT, P6-SCALE pagination | Anytime | Avoid files under `money/`, `payroll/`, `offboarding/` while those are being built |
| Documents scope tests (ARCH-016.test → 0) | Anytime | Coordinate with the document-engine session |
| Design: cross-company transfer rule; ATT round (only if pulled into GA); DOC-lite | Now | Council run on Opus |
| P5-WPS file | After BL-PAY-008b | Needs the pilot bank's SIF spec (ops/owner) |
| ONB LB items | After E and J | |
| P7-E2E harness and the perf test | Anytime; the journeys fill in as features land | |

---

## 5. Packages by stage

Routing follows `.claude/agent-routing.md`:
- **Opus (architect or general-purpose):** money, scope, auth, legal values, data-moving migrations.
- **Sonnet:** mechanic, test-writer, migrator for decided DDL, reviewer for single-lens checks, doc-scribe.
- **Haiku:** scout and scribe.

Sizes use the AUDIT/13 §6 scale (S up to 3 days, M 1–2 weeks, L 2–4 weeks, XL more than 4 weeks for one developer). At the pace so far, agent-time is roughly 5–10x shorter.

### Stage 0: Release R1 (ship what exists)

| Pkg | Scope | Depends on | Owner module | Routing | Size | Blocker that only others can clear |
|---|---|---|---|---|---|---|
| S0-1 | Push; fix whatever the first CI run surfaces; protect master | SSH/deploy key | — | Chair; CI fixes by mechanic (Sonnet), Opus if scope/money/auth tests fail | S | **Owner/ops:** GitHub push access (the SSH key problem) |
| S0-2 | deploy.sh default ref; RUNBOOK 3.1; release notes for 8_, 9o..9zn with rollback per migration | — | ops/docs | Rollback analysis of the data-moving steps (9zg IBAN to LEGACY_UNVERIFIED, 9zh, 9zi, 9zk, 9zm): architect (Opus). Prose: doc-scribe (Sonnet). deploy.sh edit: mechanic | S | — |
| S0-3 | Staging: restore each tenant's latest dump to a staging host; `migrate deploy`; drift check; reconcile; time each migration; record NOT VALID notices and the EmploymentMigrationReview count | S0-2 | ops | Chair + migrator (Sonnet) for checks; Opus to triage discrepancies | M | **Ops:** staging host and dump access |
| S0-4 | BL-IAM-001 contention in runIdentityTransaction | — | iam | general-purpose Opus (auth) | S | — |
| S0-5 | Per-tenant controls onboarding: set-root, register/link persons, set-owner-contact, attestation, readiness mark (RUNBOOK 3.5.1) | S0-3 | iam (vendor) | Ops runbook by doc-scribe; executed by ops | S per tenant | **Owner:** official request with named persons per tenant. **Ops:** releasing the root code by phone (DEC-PO-143) |
| S0-6 | SES setup, OWNER_ALERT_EMAIL, backup remote + age key, DRILL_PG_URL, uptime monitor, JobRun alerting | — | ops | Ops; doc-scribe | S | **Ops:** SES production access, DNS, storage account. **Owner:** RPO/RTO values; monitoring provider (§11.5) |
| S0-7 | Deploy R1: pilot tenant, then the rest one at a time, `--max-migrate-failures 1` | S0-1..6 | ops | Chair + ops | S | **Owner:** release window |

### Stage 1: Finish phase 2

Order and routing exactly as AUDIT/14:35-56.

| Pkg | Scope | Depends on | Routing | Size | Blocker |
|---|---|---|---|---|---|
| ADR-N | Notification, NotificationPreference, PushSubscription ownership (AUDIT/14:63) | — | architect (Opus) | S | **Owner:** accept the ADR |
| D | Delegation, reassign, BLOCKED | C | Opus | M | — |
| E | workflow-deadlines and workflow-repair jobs, closeExternally, INV-WF-01, timers (ARCH-018) | B | Core Opus; job wiring by mechanic | M | — |
| F | Inbox, preferences, Arabic templates, consumer, email | ADR-N, E | Recipients/scope/confidentiality on Opus; templates and UI by mechanic | L | SES live (S0-6) |
| G | Tasks API, timeline, "اعتماداتي" page | B | mechanic + test-writer; refuter on Opus for findings | M | — |
| I | 3 request tables, asset reservation, `Asset.companyId` NOT NULL with backfill, OwnerRequest company | A | Backfill on Opus; DDL by migrator | M | **Owner/HR:** assign companies where they cannot be derived (DEC-PO-133) |
| J | requests + assets adapters, reservation atomicity, terminated consumers | B, C, I | Opus; mechanical parts by mechanic | L | **Owner:** first request type and order (lifts FIRST-TYPE, activation.ts:9-13) |
| M | Parity tests for the v1 templates | J | test-writer; Opus checks fixtures | S | — |
| H | Editor; activation authority check | C | UI by mechanic; authority check on Opus | M | — |
| K | Migrate prefixed AttendanceCorrection rows into instances; remove the prefix route; G10 CI test | J | Data move on Opus; removal by mechanic | M | — |
| L | Owner requests with a real assignee; portal "طلباتي" | D, G | mechanic + test-writer | M | — |

### Stage 2: Design rounds (parallel with stage 1)

| Pkg | Scope | Routing | Size | Blocker |
|---|---|---|---|---|
| DS-1 | Cross-company transfer: refuse rule, or design it correctly with GOSI, payroll and Q-LPB-1 | architect (Opus) | S | **Owner:** refuse vs build. **Counsel:** Q-LPB-1 |
| DS-2 | Reopen the money design v5 against real ExitCase/EmployeeDebt code (DEC-PO-139), time-boxed to 3 red-team rounds | people-os-hris-architect + red team (Opus) | M | **Owner:** answers at each round. **Counsel:** Art. 92 with loans and excess leave |
| DS-3 | ATT design (only if the owner moves P3-ATT into GA) | council (Opus) | L | **Owner:** scope |
| DS-4 | DOC-lite (versions of uploaded files, permissions), only what the document scope tests need | architect (Opus) | S | — |

### Stage 3: Money core (pilot scope)

| Pkg | Scope | Depends on | Owner module | Routing | Size | Blocker |
|---|---|---|---|---|---|---|
| M3-1 | BL-LEV-001 migration and new types; BL-LEV-011; BL-LEV-006 legal floors | P1-CAL, P1-FND-DB | leave (new) | Migration DDL by migrator; legal values on Opus | M | **Counsel:** provisional leave types (paternity, marriage, bereavement, Hajj); Q-LEV-A..G. Flagged defaults allowed |
| M3-2 | BL-LEV-008 writer matrix, schedule versioning; BL-LEV-005 medical gate; BL-LEV-007 balances and carry-over; BL-LEV-002 manager stage; BL-WFE-010 adapter | M3-1, E | leave, workflow | Opus (money); tests by test-writer | L | — |
| M3-3 | BL-PAY-008b per-line approval, snapshots (Decimal), PayrollCoverage, retro difference in the first open month; BL-PAY-026 cases, EmployeeDebt; BL-PAY-016, 007, 011; deduction and loan caps; one daily-rate RuleParameter | M3-2 | payroll | general-purpose Opus throughout | XL | **Counsel:** Art. 107 overtime basis; Arts 70/92/93; Q-LPB-1/2. **Owner:** Q-LEV-H |
| M3-4 | BL-LCY-018 ExitReason; BL-LCY-008 rehire / currentPeriod | — | lifecycle | Opus | M | **Counsel:** Q-LCY-A/E/F |
| M3-5 | BL-OFF-001 (with legacy data move), 003, 005, 006, 002; BL-WFE-011 | M3-4, E | offboarding | Data move and transitions on Opus; screens by mechanic | L | **Counsel:** Q-OFF-A..H (except C), Q-OFF-I/J, Q-WFE-D/E. **Owner:** Q-OFF-C |
| DS-2 | (see stage 2) | M3-5 + EmployeeDebt in code | — | Opus | M | as above |
| M3-6 | BL-OFF-007/008 settlement commands (BR-LPB-011), BL-PAY-028/029, refund entity, ARCH-004 → 0 | DS-2, M3-3 | offboarding, payroll | Opus | L | **Owner:** Q-LPB-3 |
| M3-7 | BL-PAY-009 legacy money retro-attestation; DEC-PO-138 legacy settlement review tooling | M3-6 | payroll | Data move on Opus | M | **HR at the pilot tenant:** one-time review |
| M3-8 | Cross-company transfer per DS-1 | DS-1 | org | Opus | S–M | — |

### Stage 4: GA hardening (parallel with stage 3 and the pilot)

| Pkg | Scope | Routing | Size | Blocker |
|---|---|---|---|---|
| H-1 | P6-MFA | Opus (auth); UI by mechanic | M | — |
| H-2 | P6-WEB | Opus (auth/web); tests by test-writer | M | — |
| H-3 | Documents scope tests, ARCH-016.test → 0 | Scope on Opus; tests by test-writer | S | Coordinate with the document-engine session |
| H-4 | P5-WPS file plus bank-return reconciliation (INV-PAY-03/05/06) | Opus (money); per-bank template wiring by mechanic | L | **Ops/owner:** the pilot bank's SIF spec and templates |
| H-5 | P5-PDPL minimum | Opus (data rights and scope); UI by mechanic | M | **Counsel:** minimum scope |
| H-6 | P5-NIT | mechanic | S | — |
| H-7 | P6-SCALE pagination and indexes; perf test in CI | mechanic; query review by reviewer | M | — |
| H-8 | P6-AUTHZ minimum | Opus | M | — |
| H-9 | ONB LB items (BL-ONB-001..006, 010, 011), BL-LCY-017, BL-LCY-004/006, BL-OFF-004/009/010, BL-LEV-003/009/013, BL-PAY-014 | Money, scope and state on Opus; screens by mechanic; tests by test-writer | XL in total | **Counsel:** Q-ONB-A..D |
| H-10 | RE-8b observability | mechanic | M | **Owner:** provider (processors.md) |
| H-11 | P7-E2E harness and MVP journeys | test-writer (Sonnet) | L | — |

### Stage 5: Pilot, then GA

| Pkg | Scope | Routing | Blocker |
|---|---|---|---|
| Q-1 | P7-GOLD initial set, then full set at halala precision | test-writer encodes; Opus validates expected values | **Counsel + accountant:** provide the cases |
| Q-2 | Pilot shadow payroll cycles (new payroll beside the current one), discrepancy triage | Chair + Opus | **Owner:** pilot tenant and months |
| Q-3 | UAT; counsel sign-off of provisional values; re-audit limited to launch scope | reviewer lenses (Sonnet), Opus on money/scope | **Counsel:** sign-off |
| Q-4 | GA rollout per tenant (per-company feature flags, §9) | ops | — |

---

## 6. Realistic ETA and cost (estimates, not commitments)

**How these were calibrated** (.claude/agent-usage.md):
- Phase 0 and 1 baseline: 22 agents, 7.55M tokens, 100% Opus.
- Since routing started, I summed about 7.7M more across the per-agent rows (P1-PAY-B, the money-design rounds, BL-PAY-027/030, identity, phase 2 A–C and reviews). Sonnet and Haiku account for only about 0.63M of that (about 8%), because almost all of the work was money, auth or scope.
- In total that is about 15M logged subagent tokens over about 6 calendar days (2026-09-28 to 10-03), excluding the Chair's own runs. Over that time AUDIT/13 phases 0 and 1 were done; AUDIT/13 sized them at 9–14 developer-weeks.
- Phase 3 is harder than that: the money design did not converge after 5 rounds (HIGH findings ran 10, 4, 1, 2, 5; STATE.md RUN-142..151). So I assume lower compression.

| Stage | Tokens (range) | Opus share (expected) | Agent time | Calendar driver |
|---|---|---|---|---|
| 0 Release R1 | 0.5–1.5M | ~50% | 2–4 days | Push access, staging host, per-tenant onboarding: **1–3 weeks** |
| 1 Phase 2 D–M | 5–8M | ~60% | 1–2 weeks | Owner picks the first request type |
| 2 Design rounds (without ATT) | 1.5–3M (+2–4M with ATT) | ~100% | parallel | Owner answers per round |
| 3 Money core | 15–25M | ~85% | 3–6 weeks | Counsel answers (provisional defaults let the build proceed) |
| 4 GA hardening | 8–14M | ~60% | 2–4 weeks, parallel | Bank SIF spec; counsel on PDPL |
| 5 Pilot and GA | 2–5M (fix rounds) | ~80% | — | **Monthly payroll cycles**: 1 shadow cycle for the pilot exit, 2 parallel cycles + bank acceptance + 30 days zero for GA |
| **Total remaining** | **~32–56M** (about 2–4x what has been spent so far) | **~70–80%** | | |

**Calendar (estimate).**
- R1 in production: mid to late October 2026.
- Pilot shadow cycle 1 starts: about 8–12 weeks from now, i.e. December 2026 to early January 2027.
- GA: about March to May 2027. Including ATT in GA adds roughly 3–6 weeks to the critical path.
- The dominant uncertainties are counsel turnaround, the pilot tenant's payroll calendar, and the money-design convergence. Agent throughput is not the constraint.

---

## 7. Release engineering for launch

1. **Push and first CI.**
   - Resolve the SSH key, or use an HTTPS token / deploy key. Push the 23 commits as they are.
   - CI triggers on `master` (ci.yml:6). Jobs: build, migrations, integration, face-service, render-service, ai-processors, secret-scan, docker (ci.yml:18-410).
   - It must be green twice in a row, after BL-IAM-001 is fixed. Then enable master protection with required checks and PRs (DEC-PO-130).
2. **Tag every release** and always deploy with `--ref <tag>`. Fix `deploy.sh:47` and RUNBOOK:259.
3. **Staging.** Restore each tenant's latest encrypted daily dump to a staging Postgres 16. Run the same `deploy.sh` there and check:
   - `prisma migrate diff --exit-code`;
   - `reconcile` and `/settings/integrity`;
   - `EmploymentMigrationReview` and NOT VALID notices (RELEASE_NOTES §2.2, §8);
   - the time taken by each migration;
   - the legacy-only `8_attendance_punch_attendance_index`, which sorts before `9*` but was added after `9a..9n` were applied [UNVERIFIED: how Prisma orders it on those tenants; the rehearsal will show].
4. **Data migration of existing tenants.**
   - Migrations 9o..9zn include data steps: 9r company backfill, 9s ON_LEAVE reset, 9u LEGACY_OPENING periods, 9y opening states, 9zd SettlementEffect, 9zg LEGACY_UNVERIFIED IBANs and compensation periods, 9zj..9zn engine and identity.
   - Per tenant: pre-deploy dump (automatic, RUNBOOK 3.1), then migrate, then reconcile, then the HR review queue, then vendor identity onboarding (RUNBOOK 3.5.1), then the **readiness mark (DEC-PO-144)** per legal company.
   - Until a company is marked, it stays ENFORCED: two attested people are needed for payroll approvals. Tell each tenant before the deploy.
5. **Rollback.**
   - Code only: `deploy.sh --rollback` (RUNBOOK 3.2).
   - Migrations: restore the pre-deploy dump, which loses data written since (RELEASE_NOTES:204-223). 9x and 9zd are irreversible without a restore, and the append-only tables cannot be edited. Decide within the first hours.
   - Write and rehearse a rollback note for each of 9zg..9zn (S0-2).
6. **Backups and DR.** Off-site encryption is mandatory (rclone crypt or age; the private key is kept off the server). The monthly drill writes to JobRun (RUNBOOK 3.4). Before the pilot, run a full DR exercise that measures the owner's RPO and RTO (§12.6).
7. **Monitoring.** Uptime check on `/api/health`; alerts on JobRun FAILED, non-zero reconcile, an outbox older than its TTL, and owner-digest failure. Ping URLs for backup and drill (RUNBOOK:290-305).
8. **Email.** SES in `me-south-1` or `eu-central-1` with DKIM, SPF and production access. Set `OWNER_ALERT_EMAIL`. Do a dry run of `outbox-dispatch` before setting `OUTBOX_SEND=true` (RUNBOOK:425-452).
9. **Deploy notes.** Rewrite RELEASE_NOTES_2026-10 for base 5e57859 → tag(R1) (S0-2), and keep a release note per later release.
10. **Rollout.** R1 to the pilot tenant first, then the remaining tenants one by one. New modules are behind per-company flags, and the new payroll runs in shadow until there are zero unexplained differences (AUDIT/13 §9). Then GA tenant by tenant.

---

## 8. Decisions still needed

### Owner

| # | Decision | Blocks |
|---|---|---|
| O1 | Accept or adjust the MVP/GA line in §2 (in particular ATT and ORG as POST-LAUNCH) | Everything |
| O2 | What «شيل اي حاجة للتعرف التلقائي على ai» refers to (see §11) | Face self-attendance (PL), workforce assistant (FUT), P3-ATT wording |
| O3 | GitHub push access: SSH key, or a token / deploy key | S0-1 |
| O4 | Master protection rules after the first green CI (DEC-PO-130) | S0-1 |
| O5 | Pilot tenant, and which payroll months run in shadow | Q-2 |
| O6 | RPO and RTO values (§12.6) | S0-6, GA gate |
| O7 | First request type and expansion order (FIRST-TYPE; DEC-PO-145) | J |
| O8 | G8 SMS/WhatsApp provider; root codes go by phone until then (DEC-PO-143) | PL; ops load |
| O9 | Monitoring provider, external (to be listed in processors.md) or self-hosted (§11.5) | S0-6, H-10 |
| O10 | English UI at launch? (§11.4) | P6-I18N tier |
| O11 | Cross-company transfer: refuse or build | DS-1, M3-8 |
| O12 | Q-OFF-C manager deadline; Q-LEV-H who pays the reversed final month; Q-LPB-3 correcting an approved leave encashment | M3-5, M3-3, M3-6 |
| O13 | Official per-tenant requests naming root and approvers | S0-5 |
| O14 | Accept the Notification ADR | F |
| O15 | Order of phases 4, 5 and 6 after launch (§11.1) | Post-launch roadmap |
| O16 | Government accounts (GOSI, Qiwa, Mudad, Muqeem sandbox) | FUT items only |

### Counsel

Designs run on flagged provisional defaults, so these do not stop the build. They do block GA sign-off (AUDIT/13:363, :292).

| # | Question | Blocks |
|---|---|---|
| C1 | Art. 92 cap combined with loan recovery and excess leave at exit (AUDIT/15:119) | DS-2, M3-3, M3-6 |
| C2 | Q-LPB-1 (leave difference after transfer), Q-LPB-2 (old lineage after rehire) | M3-3, DS-1 |
| C3 | Provisional leave types: paternity, marriage, bereavement, Hajj (AUDIT/15:119) | M3-1 |
| C4 | Q-LEV-A..G | M3-1, M3-2 |
| C5 | Q-OFF-A, B, D–H; Q-OFF-I/J; Q-WFE-D/E | M3-5, M3-6 |
| C6 | Q-LCY-A/E/F; gosiRegime on re-registration | M3-4 |
| C7 | Q-ONB-A..D | H-9 |
| C8 | Art. 107 overtime basis; Ramadan hours; Arts 81/87; GCC GOSI | M3-3, P5-GCC |
| C9 | Confirm the WPS obligation and the PDPL minimum for launch | H-4, H-5 tiers |
| C10 | Golden payroll and settlement cases (with the accountant) | Q-1 |

### Ops

| # | Task | Blocks |
|---|---|---|
| X1 | Push credentials; staging host; access to tenant dumps | S0-1, S0-3 |
| X2 | SES account, DNS, DKIM, production access; OWNER_ALERT_EMAIL per tenant | S0-6 |
| X3 | Off-site storage, age keypair kept off-server, DRILL_PG_URL role | S0-6 |
| X4 | Uptime and alert routing | S0-6 |
| X5 | Vendor identity commands per tenant; releasing root codes by phone | S0-5 |
| X6 | The pilot bank's WPS/SIF template | H-4 |
| X7 | Face service only if self-attendance is used | PL |

---

## 9. Go/No-Go criteria

### (a) Pilot: GO only if all hold

1. All PILOT BLOCKER items are done, each meeting the §8 definition of done (AUDIT/13:310-325).
2. The release is tagged; CI is green twice in a row on master with all jobs; master is protected; BL-IAM-001 is closed.
3. Staging rehearsal on the pilot tenant's real dump shows:
   - all migrations applied, 0 drift;
   - reconcile with **0 open BLOCKING or HIGH** discrepancies, or each one EXPLAINED;
   - the EmploymentMigrationReview and LEGACY_UNVERIFIED IBAN queues worked off.
4. The pilot company is readiness-marked (DEC-PO-144), its root and approvers are attested, and the INV-IAM-01 regression tests are green.
5. An off-site encrypted backup exists; the restore drill shows SUCCEEDED within the last 7 days; a DR drill met the owner's RPO and RTO.
6. Uptime and JobRun/reconcile/outbox alerts deliver to a human. SES works and OWNER_ALERT_EMAIL is set.
7. MFA is enforced for owner, admin and finance roles at the pilot.
8. ARCH-004 = 0 and ARCH-016.test = 0; ratchet `growth` is empty; the baseline is below 225.
9. The initial golden cases pass at halala precision. Every provisional legal value used in pilot computations is flagged in the UI and listed for counsel.
10. The security review of the release has no open CRITICAL or HIGH finding.
11. Rollback per migration is written and the restore was timed in staging.

**Pilot exit** (to keep going toward GA): shadow cycle 1 has every line difference against the current payroll explained.

### (b) General launch: GO only if all hold

1. All LAUNCH BLOCKER items are done, with the definition of done.
2. **Two consecutive parallel payroll cycles** with no unexplained difference, and the **WPS file accepted by the bank** for at least one cycle (§12.3).
3. **30 consecutive days** with no open HIGH or BLOCKING discrepancy on **at least 2 real tenants** (§12.2). If only one pilot exists, the owner must explicitly accept "1 pilot + 1 friendly tenant".
4. Re-audit limited to launch scope: no Critical or High (§12.4, narrowed).
5. CI mandatory for merge: unit, Postgres integration, real-auth route tests, E2E for the MVP journeys, the perf test (5,000-employee payroll in under 1 minute, §10), secret and AI-processor scans (§12.5).
6. DR drill within RPO and RTO in the GA month (§12.6).
7. Counsel has signed off every provisional value used, or marked each as an explicit per-company default (DEC-PO-116/126).
8. RUNBOOK and release notes are current; per-tenant onboarding (identity, readiness, SES, backups) is scripted; a support and on-call process exists [no doc found; owner to define].

---

## 10. Top risks and mitigations

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| 1 | Confirmed money bugs are still live in production because their fixes are unpushed | BACKLOG.md:585,588; AUDIT/15:109-112 | Make R1 the first milestone |
| 2 | One laptop holds 23 unpushed commits and the git-ignored council corpus | .gitignore:75; AUDIT/15:35 | Push now; back up `.claude/` today |
| 3 | Big-bang migration of 24 migrations, some irreversible, on real data | RELEASE_NOTES:204-223 | Staging rehearsal per tenant; one tenant at a time; pre-deploy dumps; `--max-migrate-failures 1` |
| 4 | After the deploy, ENFORCED mode blocks single-operator companies from approving | ADR-0009:13,26 | Onboard identity and mark readiness before deploying; tell tenants |
| 5 | CI has never run; one identity test is flaky | AUDIT/15:116; BACKLOG:592 | S0-1, S0-4 before making CI mandatory |
| 6 | The money design may not converge | STATE.md RUN-142..151; DEC-PO-139 | Reopen only with real code; time-box to 3 rounds; owner rulings like DEC-PO-136/137 |
| 7 | Counsel latency on provisional legal values | AUDIT/13:363 | Flagged defaults; counsel sign-off is a GA gate, not a build gate |
| 8 | Monthly payroll cycles fix the GA date | §12.2-12.3 | Start the shadow run on the pilot at the earliest cycle; keep ATT and ORG off the critical path |
| 9 | Scope creep toward "100%" | §12 breadth | The tiers in §2; owner signs the line |
| 10 | Opus cost stays high (about 92% of tokens since routing were Opus) | agent-usage.md | Push mechanical, UI and test work to Sonnet as AUDIT/14 routes it; measure per package |
| 11 | Stale status docs mislead the executors | BACKLOG PAY statuses; AUDIT/13 §7; RELEASE_NOTES:3 | A scribe pass to reconcile statuses before the red team |
| 12 | Government access is outside our control | AUDIT/13:413 | Files first (DEC-002); APIs are FUTURE |
| 13 | Float money | 92 Float lines in schema.prisma | New tables in Decimal; INV-PAY-01 at halala; staged P6-MONEY after launch |
| 14 | Parallel sessions and citation drift | CLAUDE.md | Branch per package plus PRs once master is protected |

---

## 11. "Automatic AI recognition": where it appears (mapping only, no recommendation)

| # | Where | What it is | AI/ML? |
|---|---|---|---|
| 1 | `services/face/` (README.md:1-30; models/MODELS.md:7-11); `src/lib/face.ts:12` (`FACE_MODEL='sface_2021dec'`); `src/app/api/portal/attendance/punch/route.ts:13,114-142`; `src/app/api/portal/face/route.ts:11-12`; `src/app/api/face-profiles/[employeeId]/photo/route.ts`; `ops/face-setup.sh`; `ops/systemd/radeef-face.service`; `radeef-jobs@purge-attendance-biometrics.timer`; RUNBOOK §5 (:551-645); decision DEC-011 (docs/council/DECISIONS.md:866) | On-premise face service for portal self clock-in. It detects the face (YuNet), computes a 128-d embedding (SFace) and a passive liveness score (MiniFASNet); Radeef matches the embedding against the enrolled template. Off by default (settings/definitions.ts:103) | **Yes. This is the only ML model inference in the repo** (AUDIT/03_DOMAIN_REPORTS/23_ai.md:5) |
| 2 | docs/workforce-engine/SPEC.md:32 (item 11 "المساعد") and :247 ("deferred by owner decision"); owner memory "AI assistant still open" | Planned natural-language assistant for the workforce engine: turns a question into a scenario and explains it; generates no numbers. **Not built** | Planned LLM; would conflict with DEC-006 |
| 3 | AUDIT/03_DOMAIN_REPORTS/19_workflow_notifications_ai.md:66-67; SPEC.md:7 | Workforce "recommendations" and "reasons" | No: deterministic rule lookups |
| 4 | .github/workflows/ci.yml:309-360 (`ai-processors` job); docs/processors.md:11-31; DEC-006 (docs/council/DECISIONS.md:462-526) | A guard that fails CI if any AI or OCR SDK is added | It is a prohibition, not a feature |
| 5 | src/app/employees/page.tsx:437, "استفد من الأتمتة الذكية" | Marketing wording for "smart automation" in the empty state | Wording only (DEC-006 forbids AI marketing; RUNBOOK:645) |
| 6 | `classifyEmployeeDocuments` (src/app/api/employees/route.ts:250; upload/route.ts:112); `classifyExpiry` (src/lib/alerts.ts:34); scripts/report-nationality-review.mjs:35-45 (ID and nationality mismatch; "لا يمكن الحكم تلقائياً"); `classifyMuqeemApiError` (muqeem/logic.ts:453) | Rule-based automatic classification | No |
| 7 | AUDIT/13:235 (P3-ATT "كشف الغياب آلياً"); AUDIT/03_DOMAIN_REPORTS/07_attendance.md:154 (automatic detection of missing punches) | Planned automatic absence and missing-punch detection | No: rule-based, planned |
| 8 | DEC-002 DO_NOT (docs/council/DECISIONS.md:158: chatbot, automatic CV reading, cloud OCR, any AI claim); PANELS.md:92-93 (HR-37/38: no automated sanctions, no AI CV ranking), :175 (DATA-21: no AI resignation prediction), :457 (LEGAL-35) | Items already excluded by decision | Not built |

**What the phrase could mean** (owner to say which):
- (a) Remove the face-recognition step from self clock-in, keeping GPS only. Row 1 is the only real "automatic recognition" in the code.
- (b) Drop the planned workforce NL assistant (row 2).
- (c) Remove the "smart automation" wording (row 5).
- (d) Drop planned automatic absence detection from P3-ATT (row 7).
- (e) Confirm the existing bans (rows 4 and 8).

---

## 12. Six questions (programme level)

Each package's own architect plan answers these in detail.
- **Owning modules:** platform, iam, lifecycle, compensation, payroll, finance, offboarding, leave (new), workflow, requests and assets (new), org, rules, calendar, time.
- **Source of truth:** per SOURCE_OF_TRUTH.md. New facts need rows first: Notification (ADR-N), and the leave ledger and ExitCase tables per the READY designs.
- **Transitions:** only through each module's `transitions.ts` with `runTransition`, an operation key and CAS.
- **Temporal effect:** effective periods via `effectiveContext`; retro changes become a difference line in the first open month.
- **Invariants:** INV-PAY-01..06, LEV-01/02, EOS-01, OFF-01, WF-01, SCOPE-01, IAM-01, GOSI-01, RULE-01; ARCH-004/011/013/016/019.
- **Scope:** every new or changed route has real-auth allow, deny and other-company tests (CLAUDE.md).

## 13. Not verified

- What is actually deployed on each server, how many tenants there are, and whether timers, backups and the drill are active in production.
- Whether any customer contract requires WPS, GOSI, Qiwa or Mudad integration.
- How Prisma orders `8_attendance_punch_attendance_index` on tenants that already applied 9a..9n.
- The exact current full-suite test count on a fresh database (taken from agent-usage only).
- The statutory texts behind WPS and PDPL (from the audit's "auditor knowledge"; counsel to confirm).
- Server-side state of the GitHub SSH key.

## Key files
- C:\Users\saif\Pictures\radeef-main\AUDIT\13_MASTER_PLAN.md
- C:\Users\saif\Pictures\radeef-main\AUDIT\14_PHASE2_PLAN.md
- C:\Users\saif\Pictures\radeef-main\AUDIT\15_CTO_HANDOVER.md
- C:\Users\saif\Pictures\radeef-main\docs\RELEASE_NOTES_2026-10.md
- C:\Users\saif\Pictures\radeef-main\docs\RUNBOOK.md
- C:\Users\saif\Pictures\radeef-main\ops\deploy.sh
- C:\Users\saif\Pictures\radeef-main\src\test\architecture\baseline.json
- C:\Users\saif\Pictures\radeef-main\src\modules\platform\invariants\planned.ts
- C:\Users\saif\Pictures\radeef-main\src\modules\workflow\activation.ts
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\STATE.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\backlog\BACKLOG.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\decisions\DECISIONS.md
- C:\Users\saif\Pictures\radeef-main\.claude\agent-usage.md
- C:\Users\saif\Pictures\radeef-main\services\face\README.md
- C:\Users\saif\Pictures\radeef-main\docs\workforce-engine\SPEC.md
