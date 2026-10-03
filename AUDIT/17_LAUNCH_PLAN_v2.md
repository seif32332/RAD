> **Status: PROPOSED. Pending owner decisions OD-1..OD-8 and owner approval. Supersedes nothing until approved.**
> Plan v1 (AUDIT/17_LAUNCH_PLAN_v1.md) stays frozen as the evidence baseline. v2 changes it only where the change log (§0) cites a finding (OA-n from AUDIT/18 §1, LR-n from AUDIT/18 §2) and the source behind that finding. General Request and every other package stay on hold until v2 is approved (DEC-PO-148; AUDIT/18:4).

# Radeef: launch plan v2 (milestones P0 to P3)

**Basis.** Repo at HEAD 288beb5 (2026-10-03), read-only. Inputs: Plan v1, AUDIT/18 (OA-1..OA-11, OA-4b, OA-5b, LR-1..LR-14, §3 owner rulings), DEC-PO-125..148 (`.claude/councils/people-os/outputs/decisions/DECISIONS.md`), BACKLOG "Depends on" fields (`.claude/councils/people-os/outputs/backlog/BACKLOG.md`), AUDIT/04, AUDIT/13, AUDIT/14. **[UNVERIFIED]** keeps the v1 meaning: not checkable from the repo. No code was changed. No requirement, feature, package or gate item is added unless v1, an OA/LR finding or a cited source names it.

**What v2 does and does not do.** It fixes planning contradictions, dependency order, gate definitions, evidence criteria and the owner-decision list. Where a red-team contradiction needs a choice that no source makes, v2 does not choose: it lists the choice in §12 (OD-1..OD-8) and marks every affected row **pending OD-n**. The plan is meant to stay consistent under each option.

**How to audit v2:** §0 change log → §1 Launch Scope Completion → §2 Launch Gate per milestone → §3 Critical path → §4 Blockers → §5 Parallel work → §6 Packages → §7 ETA and cost → §8 R1 release engineering → §9 Go/No-Go per milestone → §10 Commercial Readiness Gate → §11 Customer Exit → §12 Open owner decisions → §13 Bookkeeping corrections → §14 AI mapping → §15 Risks, six questions, not verified.

---

## 0. Change log (v1 → v2)

Each row: the v1 section, the v2 change, the finding, and the source it rests on.

| # | v1 section | v2 change | Finding | Source |
|---|---|---|---|---|
| CL-01 | Header | Status set to PROPOSED. v2 supersedes nothing until approved. | OA-4b and the task (rule 8) | AUDIT/18:4; DEC-PO-148 (DECISIONS.md:50) |
| CL-02 | §0.1, §1.1 | "About 25–30% of the master plan" and the per-phase % column are removed. They are replaced by Launch Scope Completion per dimension, using evidence states and no percentages (§1). | OA-9 | AUDIT/18:34 |
| CL-03 | §0.1, §1.1, §6 | "Phases 0 and 1 done" becomes **built, not accepted**. No package has evidence for definition-of-done items 1 (migration on a real data copy), 2 (reconciliation on the customer copy) or 6 (E2E). | LR-8 | AUDIT/13:312-325 (DoD); AUDIT/18:92-95 |
| CL-04 | §0.2, §5 stage 0, §7.10 | "Release R1 (ship what exists)" is renamed **R1 Infrastructure / Hardening Release**. It moves the foundation from laptop-only to controlled production. It is not a product launch and is not sold. | OA-4 | DEC-PO-148 (DECISIONS.md:46); AUDIT/18:18 |
| CL-05 | Tier legend; §2.2 | The tiers PB/LB/PL/FUT are replaced by four milestones with separate gates: **P0** R1 production infrastructure, **P1** Pilot Shadow, **P2** Pilot Operational and **P3** GA, plus PL and FUT. Every v1 item is re-placed (§2). | OA-7 | AUDIT/18:25 |
| CL-06 | Tier legend (FUT); §2.2 compliance rows; O16 | FUT now reads: "not required for this launch scope (baseline GA); becomes a customer- or contract-specific blocker if a contract requires it". | OA-10 | DEC-PO-148 (DECISIONS.md:48); AUDIT/18:35 |
| CL-07 | §2.2 RE-1, §7.1, §3 | Release order becomes 0A Preserve → 0B push shared source → CI → 0C CI triage (six failure classes) → 0D release candidate → staging → real-tenant rehearsal. No production deploy directly after the first green CI. Commit count corrected to 25 at 288beb5 (23 code commits plus the 2 audit-doc commits). | OA-4b | AUDIT/18:27; `git rev-list --count origin/master..HEAD` |
| CL-08 | §7.1, §9(a)2 | "CI green twice in a row" is no longer a readiness criterion. CI validates the software, staging validates the release, and the real-tenant rehearsal validates the migration (it is the key R1 test). Master protection follows DEC-PO-130: after the first push, once the new CI jobs have run green once (v1 said twice). | OA-5b | AUDIT/18:28; DEC-PO-130 (DECISIONS.md:162) |
| CL-09 | RE-11, S0-4, §9(a)2, risk 5 | BL-IAM-001 "flaky identity tests" becomes a **root-cause disposition**: (A) root cause found and closed, or (B) proof that it is a test-harness issue and not a race in production code. It is never closed as "flaky". It stays in the release audit. | OA-5 | AUDIT/18:23; BACKLOG.md:592 |
| CL-10 | §7.1, §9(a)2 "all jobs" | The CI `face-service` job downloads models from GitHub. It must not be a required check for merge or release, or it must be isolated so that ML is not a release dependency. This is a required plan change; the implementation is left to S0-1. | LR-9, OA-11 | ci.yml:260-281; DEC-PO-148 (DECISIONS.md:47) |
| CL-11 | §7.5, S0-2, §9(a)11 | "Rollback per migration" becomes an **all-or-nothing** model. There is one pre-deploy dump per tenant for all 24 migrations, and the migrations run while the old app is live. Rollback means restoring that dump plus the code rollback. A rehearsed migration failure partway through is added. | LR-6 | deploy.sh:22, :185, :308-312 |
| CL-12 | S0-3, §7.3 | Two staging checks are added: the CompanyDocument row count (9x aborts if rows exist) and the per-tenant list of constraints left NOT VALID. A NOT VALID constraint still refuses updates to its violating rows, even when the row is classed EXPLAINED. | LR-6 | 9x_db_constraints/migration.sql:8-13, :33-37; 9zf:240 (per LR-6) |
| CL-13 | §7.4 | Data steps that v1 omitted are added: the 9zb, 9zf and 9zk backfills, the 9zh `UPDATE "Settlement"` and the 9zm `DELETE`. | LR-6 | 9zh_money_fixes/migration.sql:27; 9zm_controls_mode/migration.sql:10; LR-6 for 9zb/9zf/9zk |
| CL-14 | §7.5 | "9zd irreversible" is corrected: dropping approvalEffects loses no production data, because the column came in c4530e3, which was never deployed. 8_ is one CREATE INDEX on an existing table, so its risk is LOW. 9x stays irreversible without a restore. | LR-6 | `git log -S approvalEffects` → c4530e3, not an ancestor of origin/master |
| CL-15 | RE-9, S0-5, §7.4, risk 4 | "Onboard identity and mark readiness **before** deploying" cannot be done, because the vendor commands write tables created by 9zk–9zm. Onboarding moves to after migrate, inside the deploy window. An **R1 go/no-go** is added that lists the day-one effects, the deploy window and the tenant notice (§8.6). | LR-4 | vendor-cli.ts:167-170; guards.ts:76-80, :126-132; identity.ts:399; 9zk:55; financial-change.ts:188 (per LR-4) |
| CL-16 | S0-2 scope | RUNBOOK 3.5.1 must document `controls-ready` / `controls-not-ready`. Today it does not (RUNBOOK:321-339 lists set-root … release-code only). | LR-4 | vendor-cli.ts:9, :47; RUNBOOK:321-339 |
| CL-17 | §9(a)3, RE-10 | "Queues worked off in staging" is replaced. Staging records counts only. The LEGACY_UNVERIFIED IBAN and EmploymentMigrationReview queues are measured in **production after deploy**, against a target count and date that owner/ops set. The DEC-PO-138 review stays with M3-7, where v1 already placed its tooling. | LR-5 | financial-change.ts:4, :475 (per LR-5); DEC-PO-138 (DECISIONS.md:127) |
| CL-18 | §2.2 (new P0 check) | MUQEEM_ENABLED is verified as not `true` on every tenant at R1. | LR-10 | src/lib/muqeem/config.ts:68; DEC-PO-148 (DECISIONS.md:48) |
| CL-19 | §2.2 "Documents API scope tests", H-3, §9(a)8 | ARCH-016.test → 0 moves from the pilot gate to the **P0 R1 gate**. INV-SCOPE-01 is "BLOCKING (for release)". Of the six baseline entries, `documents/[id]/recipients` is new since origin/master (b556235). | LR-11 | ARCHITECTURE_INVARIANTS.md:104; baseline.json:100-107; `git cat-file -e origin/master:<path>` |
| CL-20 | §3 | The D → E arrow is removed. E needs only B. | LR-12 | AUDIT/14:54 ("E after B"); LR-12 cites :59 (citation drift) |
| CL-21 | §3, §5 stage 1 row F | F's build no longer waits on SES. SES is needed when F is deployed. F depends on ADR-N and B, not E. | LR-12 | AUDIT/14:55 ("Parallel after B: F, G, H"), :63-64 |
| CL-22 | §3 | The R1 deploy no longer blocks the BL-PAY-008b build. It blocks the start of P1. | LR-12 | AUDIT/18:114 |
| CL-23 | §3 | C10 golden cases (counsel and accountant) and the pilot tenant's payroll calendar (O5) are added to the critical path. | LR-12 | v1 §8 C10, O5; AUDIT/18:115 |
| CL-24 | §3 footnote | The citation "BACKLOG.md:46" for the leave → payroll → settlement order is corrected to BACKLOG.md:545. | LR-1 | BACKLOG.md:46 (inside BL-PAY-001), :545 |
| CL-25 | §5 M3-4 "Depends on —", §3 | The LCY-008 ↔ OFF dependency cycle is made explicit. BL-OFF-001 needs BL-LCY-008, and BL-OFF-007 needs 006, which needs 001. Yet the fixed order puts LCY-008 after OFF-007/008. M3-4/M3-5/M3-6 are **pending OD-1**. | LR-1 | BACKLOG.md:279, :282-283, :543, :545; DEC-PO-125 (DECISIONS.md:169) |
| CL-26 | §2.2 BL-LEV-013 (LB) | BL-LEV-013 is in the fixed order before BL-LCY-008, so its tier is **pending OD-1**. | LR-1 | BACKLOG.md:545 |
| CL-27 | §2.2, §3, M3-7 | BL-PAY-020 (the WPS file) is named. BL-PAY-009 depends on BL-PAY-006 and BL-PAY-020, so in v1 a pilot blocker depended on a launch blocker. The tiers of M3-7 and H-4 are **pending OD-2** (coupled with OD-7). | LR-2 | BACKLOG.md:183-203 |
| CL-28 | §1.2 bookkeeping | BL-PAY-006 is PARTIAL: the schema has no BankExport, BankCertificate or lineStatus. BL-PAY-003 is PARTIAL: ARCH-004 = 6. | LR-2, LR-14 | BACKLOG.md:85-96; `grep` on schema.prisma (no matches); baseline.json |
| CL-29 | §5 M3-3 | M3-3 (XL) is split into **M3-3A** (snapshot, Decimal pending OD-3, coverage), **M3-3B** (deduction/loan collection ownership and caps), **M3-3C** (retro difference), **M3-3D** (EmployeeDebt) and **M3-3E** (golden cases and reconciliation). Each has its own gate (§6.3). | OA-3 | AUDIT/18:16 |
| CL-30 | §2.2 "New money tables … Decimal(14,2)" | The Decimal row is **pending OD-3** (ADR). DOMAIN_MODEL keeps halala amounts until P6-MONEY, and the constitution changes only by ADR. | LR-3 | DOMAIN_MODEL.md:93; CLAUDE.md ("propose an ADR"); docs/council/DECISIONS.md:150, :158 |
| CL-31 | §3, §5 DS-2 / M3-3 order | Whether DS-2 runs before the M3-3B/M3-3D caps and debt work is **pending OD-4**. DEC-PO-139 freezes those parts as "not build-ready". | LR-3 | DEC-PO-139 §2, §4 (DECISIONS.md:119, :121) |
| CL-32 | §5 DS-2 "Depends on" | The DS-2 preconditions DEC-PO-139 names but v1 omitted are added: settlement reversal (BL-LCY-015 reverse, BACKLOG LCY order 13) and exit cancellation in code. | LR-3 | DEC-PO-139 §4 (DECISIONS.md:121); BACKLOG.md LCY order 13; DEC-PO-137 (DECISIONS.md:134) |
| CL-33 | §5 DS-2, risk 6 | The money redesign closure rule changes from "time-boxed to 3 rounds" to: at most 3 rounds unless a new Critical/High invariant appears, then finding → resolve → targeted review. The goal is convergence, not a count. | OA-8 | DEC-PO-148 (DECISIONS.md:49) |
| CL-34 | §2.1 GA lifecycles | Lifecycle #4 (leave → attendance and visa edges) and #7 (DOC, DISCOVERED only) cannot be met as defined. The GA lifecycle list is **pending OD-5**. | LR-7 | AUDIT/04:162, :165; STATE.md:19 |
| CL-35 | §2.2 phase 2 rows, LEV/OFF rows | The shadow pilot gets its own blocker list. D, E, F, G, I, J, M and BL-WFE-010/011 are **pending OD-6**. | LR-7 | AUDIT/14:58-59; BACKLOG.md WFE order 10-11 (P2); DEC-PO-131 (DECISIONS.md:30) |
| CL-36 | §9 | Milestone **P2 Pilot Operational** is added with its own gate: agreed scope and a clear rollback. | OA-7 | AUDIT/18:25 |
| CL-37 | §2.2 P5-WPS row, §9(b)2, C9 | The WPS legal basis changes from "auditor knowledge" to E5 evidence (EVD-CMP-006..009). The WPS tier and the "accepted by the bank" criterion (which conflicts with shadow mode) are **pending OD-7**. | LR-10 | evidence-ledger.md:2881-2928; AUDIT/13:371 |
| CL-38 | §2.2 all legal rows | Every legal or compliance blocker carries one of the five classes (§2.6). | OA-6 | AUDIT/18:24 |
| CL-39 | §2.2 Mudad, GOSI API, QIWA, MQM rows | These are FUT for baseline GA and contract-specific if a contract requires them. | OA-10 | DEC-PO-148 (DECISIONS.md:48) |
| CL-40 | §2.2 AI rows, §11, O2, P3-ATT row | No AI/ML feature is a launch dependency. Face self-attendance is optional, off by default and PL (not removed). The workforce assistant is FUT. Automatic absence detection is PL. v1 O2 is resolved for options (a), (b) and (d). | OA-11 | DEC-PO-148 (DECISIONS.md:47) |
| CL-41 | §11 mapping | Four rows are added: tenant-wide 1:N face identification (a PDPL item for counsel, new C11); the CI model download; face hardening shipping in R1; and FACE_SERVICE_* in new-tenant provisioning. | LR-9 | portal/face/route.ts:126-138; ci.yml:260-281; 7dc214e, c0b64c3; new-tenant.sh:155-160 |
| CL-42 | (new) §10 | A Commercial Readiness Gate is added before GA, listing exactly the items the owner named. Status: owner/ops to define. | OA-1 | AUDIT/18:14 |
| CL-43 | (new) §11 | A Customer Exit (tenant offboarding) lifecycle is added, listing exactly the items the owner named. Status: owner/ops to define. | OA-2 | AUDIT/18:15; RUNBOOK §3.6 (:340-344) as existing partial basis |
| CL-44 | §9(b)8 | "Support and on-call process" moves into the Commercial Readiness Gate (support and escalation, support hours, incident communication). | OA-1 | AUDIT/18:14 |
| CL-45 | §6 | Estimates are recalibrated: 7,667,791 tokens since routing; Sonnet+Haiku 8.2%; phase 2 A–C ran 81.9% Opus; 0.52M tokens per agent-hour. Agent time is restated in agent-hours. Chair runs are excluded, so cost is understated. All figures stay estimates and ranges. | LR-13 | AUDIT/18:117-121; AUDIT/14 "Token budget" |
| CL-46 | §9(a)1, (b)1 | "Done, meeting the definition of done" is replaced by an explicit proof set per item (§2.0, DoD-proof). | LR-8, task rule 7 | AUDIT/13:312-325 |
| CL-47 | §1.2 bookkeeping | Status corrections are listed for application after approval, not applied (§13). The 10-04 dates are **pending OD-8**. | LR-14 | AUDIT/18:123-127; `git log` (fb8e001 2026-10-03 22:18) |
| CL-48 | §1.2 | The v1 citation RELEASE_NOTES:44 as evidence that P1-PAY-A is built is withdrawn (that line is about the NOTICE flag). The evidence is now `src/modules/platform/money/` and commit c4530e3. | LR-14 | RELEASE_NOTES_2026-10.md:44; AUDIT/13:201 |
| CL-49 | §8 Counsel | C9 is narrowed: the WPS employer obligation is E5-verified. Counsel still confirms the PDPL minimum and the version currency of the WPS spec (EVD-CMP-006 note). C11 is added: 1:N biometric identification under PDPL. | LR-10, LR-9 | evidence-ledger.md:2881-2892; portal/face/route.ts:126-138 |

**Count: 49 changes.**

---

## 1. Launch Scope Completion (replaces "25–30%")

No percentages (OA-9). Each dimension is reported in evidence states:

| State | Meaning (testable) |
|---|---|
| NOT DESIGNED | No READY design (STATE.md) |
| DESIGNED | READY design and backlog exist; no code |
| PARTIAL | Some of the backlog item's listed changes exist in code; the rest is named |
| BUILT, NOT ACCEPTED | Code and tests exist locally. At least one of DoD items 1, 2 or 6 (AUDIT/13:312-325) has no evidence. Not in production |
| ACCEPTED | Every DoD item has evidence, including a migration and reconciliation on a real tenant copy |
| IN PRODUCTION | Deployed on origin/master 5e57859 or later. [UNVERIFIED per tenant] |

As of 288beb5, **no component is ACCEPTED**, and nothing after origin/master 5e57859 is in production (LR-8; v1 §1.2).

| Dimension | Component (launch scope) | State | Evidence |
|---|---|---|---|
| Infrastructure | CI jobs (P0-01) | BUILT, NOT ACCEPTED (never run on GitHub) | AUDIT/15:116; ci.yml:18-410 |
| | Job timers (P0-03), off-site backup and drill (P0-04) | BUILT; production state [UNVERIFIED] | AUDIT/13:169 |
| | Staging host | NOT STARTED | none found in RUNBOOK (v1 RE-5) |
| | Deploy default ref | DEFECT (`origin/main`) | deploy.sh:47; RUNBOOK:259 |
| Core HR | Employment state (P1-LCY, 9y), effective periods (9u), scope layer (9zb) | BUILT, NOT ACCEPTED | AUDIT/13:201 |
| | Compensation via EmployeeFinancialChange (BL-PAY-004, 9zg) | BUILT, NOT ACCEPTED | AUDIT/13:203; cdab83b |
| | Cross-legal-company transfer | BROKEN; design pending (DS-1) | AUDIT/04:167 |
| | ONB | DESIGNED (READY v16.1) | STATE.md:14 |
| | ORG | NOT DESIGNED (PL) | AUDIT/13:303 |
| Payroll | Money gateway (P1-PAY-A) | BUILT, NOT ACCEPTED | src/modules/platform/money/; c4530e3 |
| | BL-PAY-003 writes behind the gateway | PARTIAL (ARCH-004 = 6) | baseline.json |
| | BL-PAY-006 money controls migration | PARTIAL (no BankExport, BankCertificate or lineStatus) | BACKLOG.md:85-96; schema.prisma |
| | BL-PAY-027 / BL-PAY-030 live-bug fixes | BUILT, NOT ACCEPTED, not deployed | BACKLOG.md:585, :588 |
| | BL-PAY-008b, 026, 016, 007, 011; caps; WPS file BL-PAY-020 | DESIGNED | BACKLOG.md:156-203, :530 |
| | Money storage | Float (92 Float, 3 Decimal lines) | schema.prisma (LR verified) |
| Leave | WF-LEV-001 v11.1 + WF-LEV-002 v9 | DESIGNED | STATE.md:15; BACKLOG LEV section |
| Settlement | WF-OFF-001 v6.1 | DESIGNED | STATE.md:13 |
| | SettlementEffect table (9zd) | BUILT, NOT ACCEPTED | DEC-PO-128 |
| | Today's settlement (H4–H6) | INCOMPLETE in production | AUDIT/10 (v1 §1.3) |
| Workflow | Engine packages A–C | BUILT, NOT ACCEPTED; 0 request types (`ACTIVATION_BLOCKERS = ['FIRST-TYPE']`) | activation.ts:13 |
| | Packages D–M, ADR-N | NOT STARTED | AUDIT/14:35-56 |
| Security | Identity controls BL-PAY-005/017/021, INV-IAM-01 | BUILT, NOT ACCEPTED | 502b62a, 2161b7a, 599837c, cd11d3f |
| | Append-only AuditRecord (9t), encrypted IBAN (9zg) | BUILT, NOT ACCEPTED | v1 §1.1 |
| | MFA | NOT STARTED (columns only) | schema.prisma:54-55 |
| | INV-SCOPE-01 | 6 open entries (ARCH-016.test) | baseline.json:100-107 |
| Saudi compliance | WPS bank input file and reconciliation | DESIGNED (BL-PAY-020 TODO) | BACKLOG.md:183-196 |
| | Legal values through RuleParameter (P1-RULE) | BUILT, NOT ACCEPTED (ARCH-007 = 30 remaining) | AUDIT/13:201 |
| | Muqeem client | BUILT, not live-certified (FUT) | AUDIT/13:265 |
| | PDPL minimum | NOT STARTED | AUDIT/08:43, :58 |
| | Nitaqat seed | Script exists (P5-NIT) | AUDIT/13:265 |
| QA | Unit and Postgres suite | Exists; last full run agent-reported "2798 x2"; Chair saw 4 of 5 green | .claude/agent-usage.md |
| | Real-auth scope tests | 49 `*.scope.it` files | AUDIT/13:201 |
| | Invariants | 6 measured, 2 registered, 1 DB-enforced, 20 planned | planned.ts:11-47 |
| | E2E (Playwright), golden cases, parallel run | NOT STARTED | package.json; v1 §1.1 |
| Operations | Release notes | STALE (wrong base, 10 migrations missing) | RELEASE_NOTES_2026-10.md:3, :96-117 |
| | Per-tenant controls onboarding | MANUAL; `controls-ready` undocumented | RUNBOOK:321-339; vendor-cli.ts:167-170 |
| | Support / on-call | NO DOC (now in §10) | v1 §9(b)8 |

---

## 2. Launch gate

### 2.0 Milestones, tiers and the proof standard

| Milestone | Definition (OA-7, verbatim intent) | Who uses it |
|---|---|---|
| **P0 R1 Production Infrastructure** | The current foundation moves from laptop-only to controlled production infrastructure. Not a product launch, not sold as GA (OA-4, DEC-PO-148) | Existing tenants, unchanged product scope |
| **P1 Pilot Shadow** | A real company with real data runs payroll in parallel. **Radeef is not the system of record** | Pilot tenant |
| **P2 Pilot Operational** | The company uses Radeef in an agreed scope, with a clear rollback | Pilot tenant |
| **P3 GA** | Any qualified company can be onboarded | All |
| PL | Post-launch: blocks no milestone | — |
| FUT | Not required for this launch scope (baseline GA). Becomes a customer- or contract-specific blocker if a contract requires it (OA-10, DEC-PO-148) | — |

Each item sits in the **earliest** milestone it blocks, and it also blocks every later one.

**DoD-proof** (used in place of "done with DoD"). An item passes only with this evidence, from AUDIT/13:312-325:
1. A migration log on an empty DB **and** on a restored real tenant copy, with `prisma migrate diff --exit-code` = 0, before/after totals and a written rollback (under the all-or-nothing model, §8.5).
2. Reconcile output on the pilot copy: 0 open BLOCKING/HIGH, and every residual EXPECTED or EXPLAINED.
3. Ratchet `growth: []` and no baseline increase.
4. Real-auth allow, deny and other-company tests for each new or changed route.
5. Double-call tests (sequential and concurrent), and a replayed consumer producing identical facts, events and notifications.
6. Unit, Postgres integration, HTTP real-auth and concurrency tests, plus E2E where there is UI.
7–11. Events after commit, audit before/after, safe per-company default (DEC-PO-116), mobile-width UI, RUNBOOK/SPEC update (an ADR if the constitution is touched).
12. `/code-review` and a security check with no open CRITICAL/HIGH, then CI green.

Item-specific proofs are added in the tables.

### 2.1 GA lifecycle scope (pending OD-5)

AUDIT/13 §12 stays the "integrated HRMS" target after launch (v1 §2.1, unchanged).

- **Unaffected by OD-5:** #1 Contract→Payroll, #6 Resignation→Settlement→Archive, #8 Access→Offboarding→Revocation, and #9 limited to "cross-company transfer is correct or refused".
- **Pending OD-5:** #4 Leave→Attendance/Payroll/Visa and #7 Document→Expiry→Notification. The weakest edges of #4 are leave→attendance (ATT is PL) and the visa deadline (Muqeem is FUT) (AUDIT/04:162). #7 is DOC, which is DISCOVERED only (STATE.md:19), and no v1 package builds it (LR-7).
- **Out of GA:** #2, #3 (beyond today's flow) and #5 (v1, unchanged). Automatic absence detection is PL by owner ruling (DEC-PO-148).

### 2.2 P0: R1 Production Infrastructure

| ID | Item | Acceptance proof | Source / change |
|---|---|---|---|
| P0-01 | **0A Preserve**: `git status`, a saved `git log origin/master..HEAD` (25 commits at 288beb5), tag `backup-pre-release`, backup branch pushed | The saved log file; `git tag -l backup-pre-release`; `git ls-remote` shows the backup branch | OA-4b (CL-07) |
| P0-02 | RE-12: back up `.claude/` (git-ignored) off the laptop | A file listing of the restored copy, matching the local file count and checksums | v1 RE-12; .gitignore:75 |
| P0-03 | **0B** Push shared source (needs O3 push access) | `git rev-list --count origin/master..HEAD` = 0 on the release branch | OA-4b; v1 RE-1 |
| P0-04 | **0C CI triage**: each failure of the first CI run is classified as environmental, test defect, existing defect, regression, migration issue or security issue, with a disposition. No fix without a class | A triage table: one row per failing job/test, with its class, disposition and fixing commit | OA-4b (CL-07) |
| P0-05 | BL-IAM-001 root-cause disposition | **(A)** A reproducer, the root cause in `runIdentityTransaction` or the tests, a fix, and a regression test that failed before the fix and passes under full-suite parallel load (run count recorded). **or (B)** Evidence that the failure needs shared-DB interference from the harness (it fails only with the shared DB and never with an isolated DB under the same load), and a written argument that the production path cannot hit it. Never "flaky" | OA-5 (CL-09); BACKLOG.md:592 |
| P0-06 | The CI `face-service` job is not a required check, or is isolated from the model download | Branch-protection required-checks list (GitHub API output) without `face-service`, or a CI log showing the job runs without network model download | LR-9 (CL-10); ci.yml:260-281 |
| P0-07 | RE-2: master protection after the first push, once the new jobs ran green once | GitHub branch-protection API output | DEC-PO-130 (CL-08) |
| P0-08 | **0D release candidate**: tag; RE-3 fixes the deploy.sh default ref and RUNBOOK:259 | The tag exists; `deploy.sh --ref <tag>` dry run on staging; diff of deploy.sh:47 | OA-4b; v1 RE-3 |
| P0-09 | RE-4 revised: release notes for base 5e57859 → tag, with all 24 migrations, the full list of data steps (§8.4) and the all-or-nothing rollback (§8.5) | Release notes migration table = `ls prisma/migrations` delta; the §8.4 list is present | LR-6 (CL-11, CL-13); v1 RE-4 |
| P0-10 | RE-5 Staging per tenant (restored latest dump) | Per tenant: drift = 0; reconcile output (0 open BLOCKING/HIGH, or each EXPLAINED); CompanyDocument count; NOT VALID constraint list; time per migration; EmploymentMigrationReview and LEGACY_UNVERIFIED **counts**; observed apply order of 8_ | LR-6, LR-5 (CL-12, CL-17); v1 RE-5 |
| P0-11 | **Real-tenant rehearsal** (the key R1 test): restore real tenant → migrate → reconcile → verify → rollback rehearsal; plus a migration failure partway through | Timed log of each step. Rollback = restore the pre-deploy dump and start the old code, verified by reconcile. The partway failure stops the deploy (`--max-migrate-failures 1`) and is recovered by restore | OA-5b, LR-6 (CL-08, CL-11) |
| P0-12 | H-3: ARCH-016.test → 0 (documents routes and auth/me get real-auth scope tests). DS-4 only if the tests need it (v1 DS-4 scope) | `baseline.json` has no ARCH-016.test key; scope tests for the 6 routes pass with real auth (allow, deny, other company) | LR-11 (CL-19); ARCHITECTURE_INVARIANTS.md:104 |
| P0-13 | RE-6: encrypted off-site backup and monthly drill live in production | Off-site object listing per tenant; JobRun row for the drill SUCCEEDED within 7 days | v1 RE-6 |
| P0-14 | RE-7: SES, OWNER_ALERT_EMAIL, dry run of `outbox-dispatch` before `OUTBOX_SEND=true` | Dry-run log; a test mail received; OWNER_ALERT_EMAIL present per tenant env | v1 RE-7; DEC-PO-144 |
| P0-15 | RE-8a: uptime check on /api/health; alerts on JobRun FAILED, non-zero reconcile, stuck outbox | A test alert of each kind received by a named human | v1 RE-8a |
| P0-16 | MUQEEM_ENABLED is not `true` on any tenant, unless a contract requires it | Per-tenant output of the Muqeem status (config.ts:68 → `enabled: false`) | LR-10 (CL-18) |
| P0-17 | RUNBOOK 3.5.1 documents `controls-ready` / `controls-not-ready` | The RUNBOOK section exists; a staging run of the command | LR-4 (CL-16) |
| P0-18 | **R1 go/no-go** (§8.6): day-one effects, deploy window, tenant notice; RE-9 controls onboarding scheduled **after migrate** inside the window | A signed go/no-go sheet; a notice sent to each tenant (date recorded); an onboarding log per tenant (set-root, persons, owner contact, attestation, readiness or a recorded ENFORCED choice) | LR-4 (CL-15); DEC-PO-144 |
| P0-19 | Production queue measurement after deploy | Day-1 counts of LEGACY_UNVERIFIED IBANs and EmploymentMigrationReview per tenant, recorded | LR-5 (CL-17) |

### 2.3 P1: Pilot Shadow

#### Phase 2 (AUDIT/14 packages)

| Item | Milestone | Acceptance proof | Source / change |
|---|---|---|---|
| ADR-N Notification ownership | Same milestone as F | ADR accepted (O14) | AUDIT/14:63-64 |
| D Delegation (WFE-006) | **pending OD-6**: P1 (option a) or P2/P3 (option b) | DoD-proof; delegation, reassign and BLOCKED tests | LR-7 (CL-35) |
| E Jobs, deadlines, exit, INV-WF-01 (WFE-004/005) | **pending OD-6** (v1 reason: the LEV/OFF adapters need BL-WFE-005) | DoD-proof; INV-WF-01 measured | LR-7; BACKLOG WFE order 5 |
| F Inbox and email notifications | **pending OD-6** | DoD-proof; SES live at deploy (P0-14) | LR-7, LR-12 (CL-21) |
| G "اعتماداتي" and timeline (WFE-008) | **pending OD-6** | DoD-proof incl. E2E | LR-7 |
| I REQ schema; J REQ adapters; M parity | **pending OD-6** (J also needs O7 first request type; General Request on hold until v2 approval, DEC-PO-148) | DoD-proof; M = parity tests green (BL-WFE-009) | LR-7; DEC-PO-145 |
| H Editor, K legacy retirement, L owner requests / "طلباتي" | P3 | DoD-proof | v1 LB |
| Web push; BL-WFE-013; BL-PAY-031 | PL | — | v1 |

#### Phase 3: money core and lifecycles

| Item | Milestone | Acceptance proof | Legal class (OA-6, §2.6) | Source / change |
|---|---|---|---|---|
| M3-1 BL-LEV-001, 011, 006 | P1 | DoD-proof; leave migration sums match before/after (BL-LEV-010) | L-03, L-04 | v1 |
| M3-2 BL-LEV-008, 005, 007, 002 | P1 | DoD-proof; INV-LEV-02 measured | L-03 | v1 |
| BL-WFE-010 LEV adapter | **pending OD-6** (BACKLOG P2; "out of phase 2", AUDIT/14:58) | DoD-proof; parity LEV C1/C9 | — | LR-7 (CL-35) |
| M3-3A..E (split of M3-3) | P1 | Gates in §6.3 | L-05, L-06 | OA-3 (CL-29) |
| New money tables in Decimal(14,2) | **pending OD-3** | — | — | LR-3 (CL-30) |
| DS-2 money redesign (convergence rule) | P1; position **pending OD-4** | §6.3 DS-2 gate | L-05 | OA-8, LR-3 (CL-31..33) |
| BL-LCY-015 (reverse) settlement reversal | P1 (DS-2 precondition). Reversal of PAID stays on hold until Q-LCY-E | DoD-proof; reverse tests | L-07 (Q-LCY-E) | LR-3 (CL-32) |
| Exit cancellation in code (BL-OFF-005 withdrawal is the nearest backlog item; mapping [UNVERIFIED], architect to confirm) | P1 (DS-2 precondition) | DoD-proof; DEC-PO-137 cancel path test | L-08 | LR-3 (CL-32) |
| M3-4 BL-LCY-018, BL-LCY-008 | P1; order **pending OD-1** | DoD-proof | L-07 | LR-1 (CL-25) |
| M3-5 OFF BL-OFF-001, 003, 005, 006, 002, 012 | P1; order **pending OD-1**. BL-WFE-011 **pending OD-6** | DoD-proof; INV-OFF-01 measured | L-08 | LR-1, LR-7 |
| M3-6 BL-OFF-007/008 settlement, BL-PAY-028/029, refund, ARCH-004 → 0 | P1 | DoD-proof; INV-PAY-02, INV-EOS-01 measured; baseline ARCH-004 = 0 | L-05, L-08 | v1 |
| M3-7 BL-PAY-009 legacy money attestation; DEC-PO-138 review tooling | **pending OD-2**: P1 (a/b) or P2 (c). Under every option it completes before Radeef pays (BACKLOG.md:200) | `legacy-attestation.test.ts` and `reverse-money.test.ts` pass (BACKLOG.md:202); DoD-proof | — | LR-2 (CL-27) |
| BL-LEV-013 re-pricing | **pending OD-1**: P1 if it stays before LCY-008 in the order; P3 otherwise | DoD-proof | — | LR-1 (CL-26) |
| M3-8 cross-company transfer per DS-1 | P1 | Refuse: API/UI tests showing the refusal. Build: DoD-proof | L-09 (Q-LPB-1) | v1 |
| BL-OFF-004, 009, 010 | P3 | DoD-proof | L-08, L-10 | v1 LB |
| BL-LCY-017, 004, 006; BL-LEV-003, 009; BL-PAY-014; ONB BL-ONB-001..006, 010, 011 | P3 | DoD-proof | L-11 (ONB) | v1 LB |
| BL-ONB-007/008/009; BL-LEV-004; BL-OFF-011; BL-PAY-019/023; BL-LCY-007/009/013/014 | PL | — | — | v1 |
| P3-ATT automatic absence detection | PL (owner ruling) | — | — | DEC-PO-148 (CL-40) |
| P3-ATT rest (DayRecord, attendance-to-payroll inputs) | PL (v1 recommendation, still O1) | — | — | v1 |
| P3-ORG in full | PL | — | — | v1 |

#### Security, QA, other P1 items

| Item | Milestone | Acceptance proof | Source / change |
|---|---|---|---|
| H-1 P6-MFA (TOTP for admin, finance, owner; step-up on approve and pay) | P1 | Login without a second factor refused for those roles (real-auth test); step-up test on approve and pay | v1 PB (real IBANs in the pilot) |
| Q-1 P7-GOLD initial set (C10) | P1 (M3-3E) | Each case passes at halala precision | v1; LR-12 (CL-23) |
| RE-10 pilot queues | P1 | Production counts on the pilot tenant ≤ target by the date owner/ops set | LR-5 (CL-17) |
| DR exercise meeting the owner's RPO/RTO (O6) | P1 | Drill log with measured RPO/RTO ≤ the values in O6 | v1 §7.6 |
| Security review of the release in use | P1 | Review report with no open CRITICAL/HIGH | v1 (a)10 |

### 2.4 P2: Pilot Operational

| Item | Acceptance proof | Source / change |
|---|---|---|
| P1 exit met (shadow cycle 1: every line difference explained) | Reconciliation export: every difference EXPECTED or EXPLAINED | v1 pilot exit; OA-7 |
| Agreed operational scope with the pilot company | A written scope, signed. **Content: owner/pilot to define** | OA-7 (CL-36) |
| Clear rollback to the pilot's previous payroll path | A written procedure and one rehearsal record. **Content: owner/ops to define** | OA-7 (CL-36) |
| BL-PAY-009 complete for the pilot tenant before the first PAY/TRANSFER/EXPORT from Radeef | As M3-7 | BACKLOG.md:200-202; OD-2 |
| WPS bank input file and bank-signed reconciliation for the pilot's bank | **pending OD-7** (and OD-2) | LR-10 |
| Phase 2 packages inside the agreed scope | **pending OD-6** | LR-7 |

### 2.5 P3: GA

| Item | Acceptance proof | Source |
|---|---|---|
| All P3 items in §2.3 (H, K, L; BL-OFF-004/009/010; ONB; LCY-017/004/006; LEV-003/009; PAY-014) | DoD-proof each | v1 LB |
| RE-8b structured logs, request id, metrics (H-10) | A request id traced end to end in the logs; metrics endpoint scraped | v1 LB |
| H-2 P6-WEB (global CSP, Origin check, persistent lockout, self-service reset) | CSP header on every route (test); lockout survives a restart (test) | v1 LB |
| H-8 P6-AUTHZ minimum | The RolePermission screen is enforced or removed (test); finance roles get 403 on identity documents (test) | v1 LB |
| H-7 P6-SCALE pagination and indexes, perf test | 5,000-employee payroll in under 1 minute in CI | v1 LB; AUDIT/13 §10 |
| H-6 P5-NIT seed per new tenant | `new-tenant` run seeds Nitaqat (test on a fresh tenant) | v1 LB |
| H-5 P5-PDPL minimum | Access/export/correct request endpoints with tests; processing record; leaver retention job; audit of full-file views | v1 LB; class L-12 |
| H-4 P5-WPS file and bank-return reconciliation (BL-PAY-020) | **pending OD-7**. If kept: reconciliation fixtures (good, tampered, replayed, rejected) pass and a sample file from a real bank validates (BACKLOG.md:195) | LR-10 |
| Q-1 full golden set; H-11 P7-E2E for MVP journeys | All golden cases pass at halala; E2E green in CI | v1 LB |
| P7-PARALLEL: 2 consecutive parallel cycles (AUDIT/13:291, :371) | Two reconciliation exports with no unexplained difference | v1 LB |
| Q-3 UAT, counsel sign-off, re-audit limited to launch scope (per OD-5) | Signed UAT; counsel letter or per-company default marking; re-audit report with no Critical/High | v1 LB |
| Commercial Readiness Gate (§10) | Every §10 row evidenced | OA-1 (CL-42) |
| Customer Exit lifecycle documented (§11) | Every §11 row has an owner-approved documented procedure | OA-2 (CL-43) |
| Mudad API, GOSI API, P5-QIWA, P5-MQM live | FUT for baseline GA; a P3 blocker only for a customer whose contract requires it | OA-10, DEC-PO-148 (CL-39) |
| P5-GCC GOSI | PL; P3 only if a GA customer employs GCC nationals (counsel C8) | v1 |
| GOSI invoice reconciliation (INV-GOSI-02); P5-HIJRI; P6-AUTHZ fine-grained; P6-MONEY legacy Float; P6-CRYPT | PL | v1 |
| Redis/queue/read models; P6-I18N (unless O10); P4-BEN, P4-LRN | FUT | v1 |
| P4-PERF, FIN, CORE, ASSET, RPT, WFP | PL | v1 |
| Face self-attendance | PL: optional, off by default, not removed | DEC-PO-148 (CL-40) |
| Workforce NL assistant | FUT | DEC-PO-148 (CL-40) |

### 2.6 Legal classification register (OA-6)

Classes: **VS** Verified statutory requirement (E5 VERIFIED in the council evidence ledger), **CC** Counsel-confirmed requirement, **CR** Contractual customer requirement, **PD** Product decision, **OR** Operational recommendation. Where no source supports a class, the row says **UNCLASSIFIED: counsel to classify**. Such a row cannot appear as a legal reason in any acceptance criterion until it is classified.

| # | Legal / compliance item | Class | Basis | Gate effect |
|---|---|---|---|---|
| L-01 | Employer uploads a bank-signed WPS file to Mudad within 30 days, any establishment size | VS (employer duty) | EVD-CMP-006..009 (evidence-ledger.md:2881-2928) | The duty sits with the employer. The bank produces the signed file (EVD-CMP-007) |
| L-02 | Radeef produces the bank input file and reconciles the bank-signed output | PD | DEC-PO-020, 025, 026, 028; DEC-002 (docs/council/DECISIONS.md:151, :250) | Tier **pending OD-7** |
| L-03 | Statutory leave: annual (Arts 109/110), sick tiers (Art. 117), maternity (Art. 151) | VS | EVD-CMP-015, 016, 017 | M3-1, M3-2 |
| L-04 | Provisional leave types (paternity, marriage, bereavement, Hajj); Q-LEV-A..G | UNCLASSIFIED: counsel C3/C4. Meanwhile PD (flagged per-company default, DEC-PO-116/126) | v1 C3, C4 | Build proceeds; counsel sign-off at P3 |
| L-05 | Deduction caps Arts 70/92/93, loan cap, Art. 92 with loans and excess leave | UNCLASSIFIED: counsel C1 | v1 C1, C8; no E5 record found | M3-3B, M3-6 run on flagged defaults |
| L-06 | Art. 107 overtime basis; Ramadan hours; Arts 81/87 | UNCLASSIFIED: counsel C8 | v1 C8 | M3-3A |
| L-07 | Q-LCY-A/E/F; gosiRegime on re-registration | UNCLASSIFIED: counsel C6 | BACKLOG LCY counsel table | M3-4, BL-LCY-015 |
| L-08 | Resignation deemed accepted (Art. 79 bis), notice (Art. 75), dues within 1–2 weeks (Art. 88), protection (Arts 82/155) | VS | EVD-CMP-010, 011, 012, 013 | M3-5, M3-6, BL-OFF-004 |
| L-09 | Leave difference after transfer and lineage after rehire (Q-LPB-1/2) | UNCLASSIFIED: counsel C2 | v1 C2 | DS-1, M3-3C |
| L-10 | GOSI notification of a leaver within 15 days | VS | EVD-CMP-014 | BL-OFF-009 (P3) |
| L-11 | Q-ONB-A..D | UNCLASSIFIED: counsel C7 | v1 C7 | H-9 (P3) |
| L-12 | PDPL minimum (data-subject requests, processing record, retention) | UNCLASSIFIED: counsel C9 | AUDIT/08:43 ("auditor knowledge"), :58 | H-5 stays P3 as v1. The legal reason cannot be cited until classified |
| L-13 | 1:N biometric identification across companies at face enrollment | UNCLASSIFIED: counsel C11 (new) | portal/face/route.ts:126-138 (LR-9) | Face is PL and off by default. The code is already in production (LR-9) |
| L-14 | Mudad / GOSI / Qiwa / Muqeem integrations | CR when a contract requires them; otherwise not required for baseline GA | DEC-PO-148 | FUT |
| L-15 | INV-SCOPE-01 cross-company isolation | Not legal: constitution, BLOCKING (for release) | ARCHITECTURE_INVARIANTS.md:104 | P0-12 |

---

## 3. Critical path (corrected)

```
P0 (R1, infrastructure)
0A preserve ─► 0B push ─► CI ─► 0C triage (6 classes; BL-IAM-001 A|B; face job not required)
   ─► H-3 ARCH-016.test → 0 ─► 0D release candidate ─► staging (per tenant) ─► real-tenant rehearsal
   (incl. rollback + partway failure) ─► R1 go/no-go (notice, window) ─► deploy, pilot tenant first
   ─► controls onboarding after migrate ─► production queue counts                    ─┐
                                                                                        │ blocks P1 START,
Build path (does NOT wait for the R1 deploy, CL-22)                                     │ not the build
M3-1 BL-LEV-001 ─► M3-2 BL-LEV-008 ─► M3-3A BL-PAY-008b snapshots/coverage ─► M3-3C retro difference
                                          │            (BL-PAY-026 cases)
M3-4 BL-LCY-018, BL-LCY-008 [order pending OD-1] ─► M3-5 BL-OFF-001…006 + BL-LCY-015 reverse + exit cancellation
                                          ▼
           DS-2 reopen (≤3 rounds unless new Critical/High; convergence) [position pending OD-4]
                                          ▼
           M3-3B caps / collection owner, M3-3D EmployeeDebt ─► M3-6 OFF-007/008 settlement, PAY-028/029, ARCH-004 → 0
                                          ▼
           T0 release: BL-PAY-008b + BL-PAY-026 + settlement parts of BL-OFF-007/008 together (BACKLOG.md:531, :543)
                                          ▼
           M3-7 BL-PAY-009 [P1 or P2, pending OD-2; needs BL-PAY-020 unless re-scoped]
C10 golden cases (counsel + accountant) ─► M3-3E golden + reconciliation ─┐
O5 pilot tenant + payroll calendar ──────────────────────────────────────┤
P0 deployed on the pilot tenant ─────────────────────────────────────────┤
                                                                          ▼
           P1 shadow cycle 1 ─► P1 exit ─► P2 (agreed scope, rollback, WPS per OD-7)
           ─► 2 parallel cycles + 30 days zero on ≥2 tenants + §10 + §11 ─► P3 GA
Phase 2: A → B → C → D; E after B only (AUDIT/14:54); F, G, H after B (F also ADR-N; SES at deploy only)
```

The order of the leave → payroll → settlement → legacy chain comes from BACKLOG.md:545 (WF-LEV-002 §10), not BACKLOG.md:46 (CL-24). As written, that order and BL-OFF-001's dependency on BL-LCY-008 (BACKLOG.md:279) form a cycle (LR-1). §12 OD-1 lists the ways to break it.

---

## 4. Blockers (outside the agents)

Open owner decisions with options are in §12. The inputs below have no options; they are values or actions that only others can supply.

### 4.1 Owner inputs

| # | Input | Blocks | Status / change |
|---|---|---|---|
| O1 | MVP/GA line in §2 (ORG and the non-automatic parts of ATT as PL) | Everything | Open. Automatic absence is resolved as PL (DEC-PO-148) |
| O2 | Meaning of «شيل اي حاجة للتعرف التلقائي على ai» | — | **Resolved by DEC-PO-148** for v1 §11 options (a), (b), (d). (c) "smart automation" wording and (e) the existing bans were not ruled; both are non-blocking |
| O3 | GitHub push access | P0-01 (backup branch), P0-03 | Open |
| O4 | Master protection rules (DEC-PO-130) | P0-07 | Open |
| O5 | Pilot tenant, shadow months, **payroll calendar** | P1 start (critical path, CL-23) | Open |
| O6 | RPO and RTO values | P1 DR exercise, P3 | Open |
| O7 | First request type and expansion order | J (pending OD-6); General Request on hold until v2 approval | Open |
| O8 | G8 SMS/WhatsApp provider | PL | Open |
| O9 | Monitoring provider | P0-15, H-10 | Open |
| O10 | English UI at launch | P6-I18N tier | Open |
| O11 | Cross-company transfer: refuse or build | DS-1, M3-8 | Open |
| O12 | Q-OFF-C; Q-LEV-H; Q-LPB-3 | M3-5, M3-3C, M3-6 | Open |
| O13 | Official per-tenant requests naming root and approvers | P0-18 | Open |
| O14 | Accept the Notification ADR | F | Open |
| O15 | Order of phases 4, 5, 6 after launch | Roadmap | Open |
| O16 | Government accounts | FUT items; contract-specific if a contract requires (CL-06) | Open |
| O17 | R1 deploy window and tenant-notice date | P0-18 | New (LR-4). **Owner to set** |
| O18 | Target counts and dates for the LEGACY_UNVERIFIED and EmploymentMigrationReview queues | P1 (RE-10), P3 | New (LR-5). **Owner/ops to set** |
| O19 | P2 agreed scope and rollback procedure | P2 | New (OA-7). **Owner/pilot to define** |
| O20 | Owners for each Commercial Readiness row (§10) and each Customer Exit row (§11) | P3 | New (OA-1, OA-2) |

### 4.2 Counsel

Designs run on flagged provisional defaults, so these do not stop the build. They do block P3 sign-off (AUDIT/13:363, :292).

| # | Question | Blocks |
|---|---|---|
| C1 | Art. 92 cap with loans and excess leave at exit | DS-2, M3-3B, M3-6 |
| C2 | Q-LPB-1, Q-LPB-2 | M3-3C, DS-1 |
| C3 | Provisional leave types | M3-1 |
| C4 | Q-LEV-A..G | M3-1, M3-2 |
| C5 | Q-OFF-A, B, D–H; Q-OFF-I/J; Q-WFE-D/E | M3-5, M3-6 |
| C6 | Q-LCY-A/E/F; gosiRegime (Q-LCY-E also holds reversal of PAID) | M3-4, BL-LCY-015 |
| C7 | Q-ONB-A..D | H-9 |
| C8 | Art. 107; Ramadan hours; Arts 81/87; GCC GOSI | M3-3A, P5-GCC |
| C9 | **Narrowed (CL-49):** the PDPL minimum for launch, and whether the 2017 WPS spec version is current (EVD-CMP-006 note). The WPS employer duty is already VS | H-5; H-4 |
| C10 | Golden payroll and settlement cases (with the accountant) | M3-3E, Q-1 (critical path) |
| C11 | **New (LR-9):** is tenant-wide 1:N face identification at enrollment lawful under PDPL, and on what basis? | Face (PL); class L-13 |

### 4.3 Ops

| # | Task | Blocks |
|---|---|---|
| X1 | Push credentials; staging host; tenant dump access | P0-03, P0-10, P0-11 |
| X2 | SES, DNS, DKIM, production access; OWNER_ALERT_EMAIL per tenant | P0-14 |
| X3 | Off-site storage, age keypair off the server, DRILL_PG_URL | P0-13 |
| X4 | Uptime and alert routing | P0-15 |
| X5 | Vendor identity commands per tenant; root codes by phone (DEC-PO-143) | P0-18 |
| X6 | The pilot bank's WPS/SIF template | H-4 (pending OD-7/OD-2) |
| X7 | Face service only if self-attendance is used | PL |
| X8 | Per-tenant MUQEEM_ENABLED check | P0-16 (new, LR-10) |

---

## 5. Parallel work

| Track | Runs alongside | Constraint | Change |
|---|---|---|---|
| Phase 2 E | After B | Out of resolve.ts if it runs alongside C/D (AUDIT/14:54) | LR-12 |
| Phase 2 F, G, H | After B; F also after ADR-N | Schema edits one at a time (AUDIT/14:55). SES only at F's deploy | LR-12 |
| Phase 2 I | After A | Schema edits one at a time | v1 |
| P3 build path (M3-*) | From now; does not wait on the R1 deploy | Avoid parallel edits under `money/`, `payroll/`, `offboarding/` | LR-12 |
| H-1 MFA, H-2 WEB, H-10 observability, H-5 PDPL, H-6 NIT, H-7 SCALE | Anytime | As above | v1 |
| H-3 documents scope tests | **Before 0D** (now P0) | Coordinate with the document-engine session | LR-11 |
| Design: DS-1; DS-4 (only if H-3 needs it); DS-3 only for any ATT part the owner pulls into GA (not automatic absence) | Now | Council on Opus | DEC-PO-148 |
| P5-WPS file (H-4) | After BL-PAY-008b | Needs X6; tier pending OD-7/OD-2 | LR-10, LR-2 |
| Commercial Readiness (§10) and Customer Exit (§11) definition | Now; no build dependency | Owner/ops | OA-1, OA-2 |
| P7-E2E harness, perf test | Anytime | — | v1 |

---

## 6. Packages by stage

Routing follows `.claude/agent-routing.md` (v1 §5, unchanged). Sizes follow the AUDIT/13 §6 scale. Only changed packages are restated here; the rest are as in v1 §5.

### 6.1 Stage 0: R1 Infrastructure / Hardening Release (renamed, OA-4)

| Pkg | Scope (v2) | Depends on | Change |
|---|---|---|---|
| S0-0 | 0A Preserve (P0-01); `.claude/` backup (P0-02) | O3 for the backup branch | OA-4b |
| S0-1 | 0B push; first CI; **0C triage** with six classes; face-service job not required or isolated; master protection after the first green (DEC-PO-130) | S0-0 | OA-4b, OA-5b, LR-9 |
| S0-4 | BL-IAM-001 disposition A or B | — | OA-5 |
| S0-H3 | H-3 ARCH-016.test → 0 (+ DS-4 only if needed) | — | LR-11 |
| S0-2 | deploy.sh ref; RUNBOOK 3.1 and **3.5.1 (`controls-ready`)**; release notes 5e57859 → tag with the full data-step list; **all-or-nothing rollback** note | — | LR-4, LR-6 |
| S0-RC | **0D** release-candidate tag | S0-1, S0-4, S0-H3, S0-2 | OA-4b |
| S0-3 | Staging per tenant with the checks of P0-10 | S0-RC | LR-6, LR-5 |
| S0-3R | Real-tenant rehearsal, rollback rehearsal, partway-failure rehearsal | S0-3 | OA-5b, LR-6 |
| S0-6 | SES, OWNER_ALERT_EMAIL, backup remote, DRILL_PG_URL, uptime, JobRun alerting; MUQEEM_ENABLED check | — | LR-10 |
| S0-7 | R1 go/no-go (§8.6), then deploy: pilot tenant first, then the rest one at a time, `--max-migrate-failures 1` | S0-3R, S0-6 | LR-4 |
| S0-5 | Per-tenant controls onboarding **after migrate**, inside the window | S0-7 | LR-4 |
| S0-8 | Day-1 production queue counts | S0-7 | LR-5 |

### 6.2 Stage 1: phase 2

As v1, with two changes: **F** depends on ADR-N and B; its only SES dependency is at deploy (LR-12; AUDIT/14:55, :63). The milestones of D, E, F, G, I, J and M are **pending OD-6**.

### 6.3 Stage 3: money core, M3-3 split (OA-3) and changed rows

Each sub-package has its own gate: the DoD-proof plus the item-specific proof below. The three parts of T0 (BL-PAY-008b, BL-PAY-026, and the settlement parts of BL-OFF-007/008) are **released together** (BACKLOG.md:531, :543). The split is a split of build and gates, not of releases.

| Pkg | Scope (from v1 M3-3) | Depends on | Gate (item-specific proof) | Pending |
|---|---|---|---|---|
| M3-3A | BL-PAY-008b per-line approval, ibanSnapshot/paymentMethodSnapshot, PayrollMonth use, PayrollCoverage, lines only for payrollReady; BL-PAY-016 parameters and leave inputs through the gateway; BL-PAY-007 PENDING lines; BL-PAY-011 frozen overtime rate; one daily-rate RuleParameter; snapshot column type per OD-3 | M3-2; BL-PAY-025; P1-CAL; P1-RULE (BACKLOG.md:543) | INV-PAY-01 (net = recompute from snapshot, at halala) measured 0 on the restored pilot copy; INV-PAY-04 measured 0; INV-RULE-01 (snapshot carries key and version); approver's own line held for another approver (test) | OD-3 |
| M3-3B | Deduction and loan collection ownership (one active owner per deduction, DEC-PO-137); caps Arts 70/92/93; 10% loan cap | M3-3A; DS-2 per OD-4 | Test that no deduction is in two collection paths at once; cap tests per flagged default; every owner change audited (DEC-PO-137) | OD-4 |
| M3-3C | Retro difference in the first open month; BL-PAY-026 leave-difference cases and resolutions | M3-3A, BL-LEV-008 (BACKLOG.md:530) | INV-LEV-02 measured 0 (open case = EXPLAINED); stable line ids across regeneration (test) | — |
| M3-3D | EmployeeDebt (the BL-PAY-026 debt part; DEC-PO-135/137) | M3-3B; DS-2 per OD-4 | A debt created at settlement is never collected from it (DEC-PO-135 test); a cancelled exit returns debts to payroll (DEC-PO-137 test) | OD-3, OD-4 |
| M3-3E | Golden cases (C10) and reconciliation | C10; M3-3A..D | Every initial golden case passes at halala; INV-PAY-01/02/04 reconcile at 0 on the pilot copy | — |
| DS-2 | Reopen wfe-money-adapters v5 against real code. Preconditions: ExitCase (M3-5), EmployeeDebt (M3-3D or not yet, per OD-4), **settlement reversal BL-LCY-015 (reverse)**, **exit cancellation** (DEC-PO-139 §4). Closure: at most 3 red-team rounds unless a new Critical/High invariant is found; then finding → resolve → targeted review; convergence, not a count | per OD-4 | The red-team report of the final round has no open Critical/High; the owner accepts | OD-4 |
| M3-4 | BL-LCY-018 (P1-FND-DB); BL-LCY-008 (BL-LCY-003, BL-PAY-004, plus the position per OD-1). BL-LCY-003's status: in P1-LCY scope (AUDIT/13:194), reported built (:201); BACKLOG not reconciled | per OD-1 | DoD-proof | OD-1 |
| M3-5 | BL-OFF-001 (BL-LCY-003, BL-LCY-008, BL-LCY-018), 003, 005, 006 (also BL-LCY-012, BL-ONB-012), 002, 012 | per OD-1; BL-WFE-011 per OD-6 | DoD-proof; INV-OFF-01 measured | OD-1, OD-6 |
| M3-7 | BL-PAY-009 (BL-PAY-006 remainder, BL-PAY-020 unless re-scoped) | per OD-2 | `legacy-attestation.test.ts`, `reverse-money.test.ts` | OD-2 |

The other stage 3 rows (M3-1, M3-2, M3-6, M3-8, DS-1, DS-3, DS-4) are unchanged from v1, apart from the milestone placements in §2.3.

### 6.4 Stage 4 and stage 5

As v1 §5, with three changes: H-3 has moved to stage 0 (LR-11); H-4 is pending OD-7/OD-2; Q-2 runs the P1 shadow cycles and Q-4 the P2/P3 rollout per tenant.

---

## 7. Realistic ETA and cost (estimates, not commitments)

**Calibration (LR-13, red team's recomputed figures).**
- 7,667,791 subagent tokens since routing started. Sonnet+Haiku 628,082 (**8.2%**), so about 91.8% Opus.
- Phase 2 A–C ran at **81.9% Opus** (1.50M of 1.83M), against AUDIT/14's forecast of 40%.
- Throughput: 888.7 agent-minutes for 7.67M tokens, about **0.52M tokens per agent-hour**.
- Total logged: 15.21M. **The Chair's own runs are excluded, so cost is understated.**
- v1's 70–80% Opus share had no mechanism behind it. v2 uses the observed range.

| Stage | Tokens (range, v1) | Opus share (estimate) | Agent time (estimate, at 0.52M/h) | Calendar driver |
|---|---|---|---|---|
| 0 R1 (now also H-3, rehearsals) | 0.5–1.5M (+ H-3 not separately estimated in v1) | ~80–92% (observed) | ~1–3 agent-hours + H-3 | Push access, staging host, tenant notice and window (O17), per-tenant onboarding |
| 1 Phase 2 D–M | 5–8M | ~80–92% (A–C: 81.9%) | ~10–15 agent-hours | O7 first request type; OD-6 |
| 2 Design rounds (without ATT) | 1.5–3M | ~100% | ~3–6 agent-hours | Owner answers per round; DS-2 convergence (OA-8) |
| 3 Money core (M3-1..M3-8, M3-3A..E) | 15–25M | ~85–92% | **~29–48 agent-hours** | Counsel answers; OD-1..OD-4 |
| 4 GA hardening | 8–14M | ~80–92% | ~15–27 agent-hours | Bank SIF spec (X6); counsel on PDPL (C9) |
| 5 Pilot and GA | 2–5M | ~80–92% | ~4–10 agent-hours | **Monthly payroll cycles** |
| **Total remaining** | **~32–56M** | **~80–92%** | **~62–108 agent-hours** | Calendar, not agent time |

Agent-hours are not calendar time. The binding constraints stay the monthly payroll cycles, counsel turnaround, the pilot calendar (O5) and DS-2 convergence (v1 §6; AUDIT/13 §12.2–12.3).

**Calendar (estimate; v1 dates kept, with the directions v2 adds).**

| Milestone | v1 estimate | v2 note |
|---|---|---|
| P0 R1 in production | Mid to late October 2026 | Now also gated by H-3 (size S), the real-tenant rehearsal and the tenant notice (O17). No new date is set |
| P1 shadow cycle 1 starts | About 8–12 weeks from now (December 2026 to early January 2027) | OD-1, OD-2 (option a), OD-4 (option a) and OD-6 (option a) can each lengthen the path. The size of each effect is not estimated |
| P2 Pilot Operational | — (new) | Not earlier than one payroll cycle after P1 starts (the P1 exit needs shadow cycle 1 explained) |
| P3 GA | About March to May 2027 | Pending OD-5 and OD-7. Also needs §10 and §11, which have no build dependency |

---

## 8. Release engineering for R1

### 8.1 Order (OA-4b, OA-5b)

1. **0A Preserve:** `git status`, save `git log origin/master..HEAD` (25 commits at 288beb5), tag `backup-pre-release`, push a backup branch, back up `.claude/`.
2. **0B Push** the shared source.
3. **CI** runs on master (ci.yml:6).
4. **0C Triage:** every failure classified (environmental, test defect, existing defect, regression, migration issue, security issue), each with a disposition. No random fixes. BL-IAM-001 is closed only by disposition A or B. The face-service job is not required, or is isolated (LR-9).
5. **0D Release candidate:** tag, then deploy with `--ref <tag>` only (deploy.sh:47 fixed).
6. **Staging**, then the **real-tenant rehearsal**. No production deploy directly after the first green CI.

What each step validates: CI validates the software, staging validates the release, and the real-tenant rehearsal validates the migration. The rehearsal is the key R1 test (OA-5b).

### 8.2 Staging checks (per tenant, restored latest dump, Postgres 16)

- `prisma migrate diff --exit-code`
- `reconcile` and `/settings/integrity`
- **CompanyDocument row count.** 9x aborts if it is > 0; export the rows per the 9x message first (9x:33-37).
- **The list of constraints left NOT VALID and their violating rows.** Those rows refuse any update until fixed, whatever their discrepancy class (9x:8-13; 9zf:240).
- Time per migration
- Apply order of `8_attendance_punch_attendance_index` [UNVERIFIED until run]
- EmploymentMigrationReview and LEGACY_UNVERIFIED **counts only**. Review work done on a staging copy is thrown away (LR-5).

### 8.3 Real-tenant rehearsal

Restore the real tenant → migrate → reconcile → verify → rollback rehearsal (restore the pre-deploy dump and start the old code; reconcile again) → a rehearsed failure partway through the migrations. Every step is timed.

### 8.4 Data steps in 8_, 9o..9zn (completed list)

- From v1: 9r company backfill, 9s ON_LEAVE reset, 9u LEGACY_OPENING periods, 9y opening states, 9zd SettlementEffect, 9zg LEGACY_UNVERIFIED IBANs and compensation periods, 9zj..9zn engine and identity.
- **Added (LR-6):** 9zb backfill, 9zf backfill, 9zk backfill (every user starts UNATTESTED, 9zk:55), the 9zh `UPDATE "Settlement"` (9zh:27) and the 9zm `DELETE FROM "SystemSetting"` (9zm:10).

### 8.5 Rollback model (all-or-nothing)

- One pre-deploy dump per tenant covers all 24 migrations (deploy.sh:185, :308-312). The migrations run while the old app is live, with lock_timeout=10s (deploy.sh:22). If the canary fails, the code is not switched, but **the database is already migrated**.
- Therefore: rollback = restore the pre-deploy dump + `deploy.sh --rollback`. Data written after the dump is lost.
- After the rollback-decision deadline, the only path is a forward fix. **The deadline is for owner/ops to set** (v1: "within the first hours").
- 9x is irreversible without a restore. The 9zd drop of approvalEffects loses nothing in production (never deployed). 8_ is LOW risk (one CREATE INDEX on an existing table).
- Per-migration rollback notes are withdrawn as a gate item (v1 S0-2, (a)11). They are replaced by P0-09 and P0-11.

### 8.6 R1 go/no-go: day-one effects (LR-4)

The go/no-go sheet must list these effects, and each tenant notice must state them.

| Effect on every tenant from the first request after migrate | Source |
|---|---|
| Companies stay ENFORCED until marked ready; payroll approvals need two attested people | guards.ts:76-80; DEC-PO-144; ADR-0009:13 |
| Legacy payment rows with no recorded requester or approver cannot be paid (UNKNOWN_APPROVER) | guards.ts:126-132 |
| Every user starts UNATTESTED; link confirmation needs an attested person | 9zk:55; identity.ts:399 |
| HR can no longer replace an IBAN; only the employee can, from the portal | financial-change.ts:188 |
| Vendor onboarding (set-root, persons, owner contact, attestation, `controls-ready`) is only possible after 9zk–9zm are applied | LR-4; vendor-cli.ts:167-170 |
| Face hardening (7dc214e, c0b64c3) ships; face stays off by default | LR-9; settings/definitions.ts:103 |

- **Deploy window:** owner to set (O17).
- **Tenant notice:** sent before the window, date owner to set (O17).
- **Order:** the pilot tenant first, then the others one by one.

### 8.7 Unchanged from v1

§7.6 Backups and DR, §7.7 Monitoring, §7.8 Email, §7.9 Deploy notes (base 5e57859 → tag(R1)), and §7.10 Rollout (with "R1" now read as the infrastructure release).

---

## 9. Go/No-Go criteria per milestone

### P0 R1: GO only if all hold

1. P0-01 to P0-17 each show the acceptance proof in §2.2.
2. The real-tenant rehearsal (P0-11) passed on **every** tenant to be deployed, including the rollback rehearsal and the partway failure.
3. Staging per tenant (P0-10): drift 0; reconcile 0 open BLOCKING/HIGH, or each EXPLAINED; CompanyDocument 0 or exported; NOT VALID list recorded.
4. BL-IAM-001 is closed by disposition A or B (P0-05).
5. Required CI checks are green on the release-candidate tag; face-service is not among them, or is isolated (P0-06).
6. ARCH-016.test = 0 (P0-12).
7. MUQEEM_ENABLED is not `true` on any tenant without a contract (P0-16).
8. The R1 go/no-go sheet is signed, with day-one effects, window and notice (P0-18).

**After deploy:** day-1 queue counts recorded (P0-19); controls onboarding logged per tenant.

### P1 Pilot Shadow: GO only if all hold

1. P0 GO met, and R1 deployed on the pilot tenant.
2. Every P1 item in §2.3 shows its proof. Rows pending OD-1/2/3/4/6 are resolved first.
3. The pilot company is readiness-marked (DEC-PO-144), or explicitly kept ENFORCED. Root and approvers are attested. INV-IAM-01 regression tests are green.
4. Pilot production queues are ≤ the O18 targets by the O18 date (production measurement, LR-5). Whether pilot employees have portal accounts to clear IBANs is [UNVERIFIED] (red team).
5. The DR exercise met the O6 RPO/RTO.
6. MFA is enforced for owner, admin and finance at the pilot (H-1 proof).
7. ARCH-004 = 0; ARCH-016.test = 0; `growth` empty; baseline below 225.
8. The initial golden cases (C10) pass at halala precision (M3-3E). Every provisional legal value in pilot computations is flagged in the UI and carries a §2.6 class.
9. The security review of the release in use has no open CRITICAL/HIGH.
10. Shadow mode holds: no PAY, TRANSFER or EXPORT from Radeef on the pilot tenant (per-company flag state recorded). Radeef is not the system of record (OA-7).

**P1 exit:** shadow cycle 1 has every line difference against the current payroll classed EXPECTED or EXPLAINED.

### P2 Pilot Operational: GO only if all hold

1. P1 exit met.
2. Agreed scope written and signed (O19).
3. Rollback to the previous payroll path written and rehearsed (O19).
4. BL-PAY-009 is complete for the pilot tenant before the first PAY/TRANSFER/EXPORT (BACKLOG.md:200-202).
5. WPS file and reconciliation as OD-7 decides.
6. The phase 2 packages in the agreed scope show their proofs (OD-6).

### P3 GA: GO only if all hold

1. Every P3 item in §2.5 shows its proof.
2. Two consecutive parallel payroll cycles with no unexplained difference (AUDIT/13:371). **WPS bank acceptance per OD-7** (v1 (b)2 conflicts with shadow mode, LR-10).
3. 30 consecutive days with no open HIGH or BLOCKING discrepancy on at least 2 real tenants (§12.2). With only one pilot, the owner must explicitly accept "1 pilot + 1 friendly tenant" (v1).
4. Re-audit limited to the launch scope fixed by OD-5: no Critical or High.
5. CI mandatory for merge: unit, Postgres integration, real-auth route tests, E2E for MVP journeys, the perf test, and the secret and AI-processor scans. ML jobs are not required (DEC-PO-148).
6. A DR drill within RPO/RTO in the GA month.
7. Counsel has signed off every provisional value, or each is marked an explicit per-company default (DEC-PO-116/126). No legal blocker is left UNCLASSIFIED in §2.6.
8. RUNBOOK and release notes are current; per-tenant onboarding (identity, readiness, SES, backups) is scripted.
9. Commercial Readiness Gate: every §10 row evidenced.
10. Customer Exit: every §11 row has an owner-approved documented procedure.
11. No government integration is required unless a GA customer's contract requires it. Where it is required, that integration is a blocker for that customer only (DEC-PO-148).

---

## 10. Commercial Readiness Gate (OA-1), before GA

Production-ready is not the same as sellable (OA-1). The rows are exactly the items the owner named (AUDIT/18:14). v2 writes no content for them: no prices, SLA values or terms.

| # | Item | Status | Acceptance evidence |
|---|---|---|---|
| CRG-01 | Pricing | Owner/ops to define | [placeholder: owner/ops to define] |
| CRG-02 | Contract | Owner/ops to define | [placeholder] |
| CRG-03 | SLA | Owner/ops to define | [placeholder] |
| CRG-04 | Onboarding procedure | Owner/ops to define (existing partial basis: RUNBOOK 3.5, 3.5.1) | [placeholder] |
| CRG-05 | Data-migration service | Owner/ops to define | [placeholder] |
| CRG-06 | Support and escalation | Owner/ops to define (absorbs v1 (b)8 "support and on-call process") | [placeholder] |
| CRG-07 | Billing | Owner/ops to define | [placeholder] |
| CRG-08 | Customer-admin training | Owner/ops to define | [placeholder] |
| CRG-09 | Employee onboarding | Owner/ops to define | [placeholder] |
| CRG-10 | Arabic documentation | Owner/ops to define | [placeholder] |
| CRG-11 | Privacy notice | Owner/ops to define (interacts with L-12, counsel C9) | [placeholder] |
| CRG-12 | DPA / data-processing terms | Owner/ops to define (interacts with L-12) | [placeholder] |
| CRG-13 | Support hours | Owner/ops to define | [placeholder] |
| CRG-14 | Incident communication | Owner/ops to define | [placeholder] |
| CRG-15 | Cancellation / offboarding procedure | Owner/ops to define (see §11) | [placeholder] |
| CRG-16 | Data export on customer exit | Owner/ops to define (see §11 CE-01) | [placeholder] |

---

## 11. Customer Exit (tenant offboarding) lifecycle (OA-2)

At least a documented process, as part of the commercial/operational gate (AUDIT/18:15). The rows are exactly the items the owner named. The existing partial basis is RUNBOOK §3.6 (:340-344): final backup, stop the process, disable the site, and `DROP DATABASE` only after the contractually agreed retention period. v2 does not set retention periods, hold rules or deletion methods.

| # | Item | Status | Acceptance evidence |
|---|---|---|---|
| CE-01 | Data export | Owner/ops to define | [placeholder] |
| CE-02 | Retention | Owner/ops to define (counsel: L-12) | [placeholder] |
| CE-03 | Deletion | Owner/ops to define (RUNBOOK 3.6 step 4 as basis) | [placeholder] |
| CE-04 | Legal holds | Owner/ops to define | [placeholder] |
| CE-05 | Employee documents | Owner/ops to define | [placeholder] |
| CE-06 | Payroll history | Owner/ops to define | [placeholder] |
| CE-07 | Audit records (AuditRecord is append-only, DEC-PO-127) | Owner/ops to define | [placeholder] |
| CE-08 | Backups (off-site copies, RE-6) | Owner/ops to define | [placeholder] |
| CE-09 | Access revocation | Owner/ops to define (RUNBOOK 3.6 steps 2–3 as basis) | [placeholder] |
| CE-10 | Billing termination | Owner/ops to define | [placeholder] |

---

## 12. Open owner decisions

Each decision lists the options the sources support and what each option changes. v2 does not choose. Rows marked "pending OD-n" in §2–§9 follow the chosen option.

| OD | Finding | Question | Options the sources support | What each option changes | Blocks |
|---|---|---|---|---|---|
| **OD-1** | LR-1 | How is the LCY-008 ↔ OFF cycle broken? BL-OFF-001 needs BL-LCY-008 (BACKLOG.md:279), but the fixed order puts LCY-008 after the settlement parts of OFF-007/008, PAY-009 and LEV-013 (:545). | **(a)** Follow DEC-PO-125 (DECISIONS.md:169): the T4 condition in BL-LCY-008 lifts "once BL-LEV-001 ships". BL-LCY-008 then goes after BL-LCY-003, BL-PAY-004 and BL-LEV-001, before BL-OFF-001, and the tail of :545 is amended. **(b)** Use the split BACKLOG.md:543 already names: the "settlement parts of BL-OFF-007/008" (BR-LPB-011 commands and the migration of existing settlements) ship in T0 on today's Settlement without ExitCase; the ExitCase chain (OFF-001 → 006 → the rest of 007/008) follows BL-LCY-008 at the tail. **(c)** Another architect decision, recorded with its reason in BACKLOG (LR-1 asks for "an owner or architect decision") | (a) M3-4 gains a dependency on M3-1. The OFF chain can run inside P1. BL-LEV-013 is no longer forced before LCY-008, so it can stay P3. (b) T0 is not blocked by OFF-001. The ExitCase chain moves after M3-7. DS-2's "exit workflow in code" precondition moves later, so P1 gets longer if ExitCase stays P1. BL-LEV-013 becomes P1. (c) Depends on the decision | M3-4, M3-5, M3-6, M3-7, DS-2, BL-LEV-013 tier |
| **OD-2** | LR-2 | BL-PAY-009 (on the pilot path in v1) depends on BL-PAY-020, the WPS file (GA in v1), and on the unfinished rest of BL-PAY-006 (BACKLOG.md:203) | **(a)** Move BL-PAY-020 and the rest of BL-PAY-006 (BankExport, BankCertificate, lineStatus) onto the P1 path. **(b)** Re-scope BL-PAY-009 in BACKLOG: the attestation, tagging and PAY/TRANSFER block stay on the pilot path, and the EXPORT block ships with BL-PAY-020. **(c)** Place BL-PAY-009 at P2: in P1 Radeef is not the system of record (OA-7), so no PAY/TRANSFER/EXPORT happens from Radeef. BL-PAY-009 completes before the first payment (BACKLOG.md:200) | (a) H-4 joins the P1 critical path, and X6 (bank SIF spec) is needed before P1. (b) A BACKLOG change; H-4 keeps its OD-7 tier. (c) M3-7 leaves the P1 path; P2 gains M3-7 and, unless (b) is also chosen, BL-PAY-020. **Coupled with OD-7:** if OD-7 places the WPS file at PL, only (b) keeps BL-PAY-009 buildable | M3-7, H-4, the P1 and P2 gates |
| **OD-3** | LR-3 | Are the new money tables (snapshot, settlement, debt) built as Decimal(14,2) before P6-MONEY? | **(a)** Write and accept an ADR. DOMAIN_MODEL.md:93 keeps halala Float until P6-MONEY, and the constitution changes only by ADR (CLAUDE.md). Supporting precedent: DEC-002 MUST-2 "PayrollLine بنوع Decimal" and DO_NOT "Float→Decimal in one batch" (docs/council/DECISIONS.md:150, :158). **(b)** Keep halala Float per DOMAIN_MODEL.md:93; P6-MONEY migrates everything later; v1's Decimal row is dropped | (a) M3-3A's gate includes ADR acceptance; P6-MONEY scope shrinks. (b) No ADR; INV-PAY-01 stays at halala via `money.ts`; P6-MONEY scope unchanged (PL) | M3-3A, M3-3D, M3-6 |
| **OD-4** | LR-3 | Does DS-2 run before the M3-3B caps/collection ownership and M3-3D EmployeeDebt work? DEC-PO-139 §2 calls those parts "not build-ready", while §4 wants them in code before the reopen | **(a)** DS-2 first (red-team recommendation), on ExitCase + settlement reversal + exit cancellation in code; then M3-3B/D. **(b)** Build M3-3B/D first, explicitly as provisional on the v5 baseline; then DS-2 reopens on real code and may change them (the literal order in DEC-PO-139 §4). Needs the owner to state that v5 is used as a provisional build basis for these parts | (a) M3-3B/D and M3-6 wait for DS-2 convergence, so the path gets longer by the DS-2 duration. (b) Earlier code, with a risk of rework after DS-2 (DEC-PO-139's stated reason) | M3-3B, M3-3D, M3-6, DS-2 |
| **OD-5** | LR-7 | GA lifecycle list | **#4:** (a) narrow to Leave→Payroll, with the attendance edge PL (ATT) and the visa edge FUT (Muqeem live, DEC-PO-148); or (b) keep #4 whole, which pulls the leave→attendance edge into P3 (a DS-3 design round, v1). **#7:** (a) move #7 to PL; or (b) keep it, which needs the DOC design (AUDIT/13:303) and a DOC build that no v1 package has (the owner would add it) | #4(a): the GA re-audit scope narrows; no package change. #4(b): DS-3 plus ATT build on the P3 path (+L in v1 §2.2). #7(a): no package change. #7(b): a new design and build in P3 | Q-3 re-audit scope; P3 gate 4; DS-3, DS-4 |
| **OD-6** | LR-7 | The shadow pilot's own blocker list | **(a)** Keep v1: D, E, F, G, I, J, M and BL-WFE-010/011 in P1. **(b)** P1 holds only what the parallel payroll needs (the money core, LEV/OFF data, MFA, golden cases, R1). D, E, F, G, I, J, M move to P2 if the agreed scope (O19) includes approvals through the engine, or to P3 otherwise. BL-WFE-010/011 follow them. Sources: OA-7 (Radeef not the system of record); BL-WFE-010/011 are P2 in BACKLOG and "out of phase 2" (AUDIT/14:58); DEC-PO-131 moves leave and offboarding onto the engine in phase 3 | (a) As v1. (b) A shorter P1 path. E's P1 reason (the LEV/OFF adapters) moves with it. M3-2 and M3-5 lose their dependency on E. J's first request type (O7) is not on the P1 path | D, E, F, G, I, J, M, BL-WFE-010/011, M3-2, M3-5 |
| **OD-7** | LR-10 | WPS tier, and the GA criterion "WPS file accepted by the bank" (v1 (b)2; AUDIT/13:371), which needs Radeef to be the system of record and so conflicts with shadow mode | **Tier:** (a) P3 as a product decision (L-02; DEC-002 "files before integrations"); (b) PL as an operational recommendation, P3 only where a contract requires it (CR). The employer duty is L-01 (VS) and is met by the bank-signed file, so by v1's own GOSI reasoning the export is product work, not a legal blocker. **Bank acceptance:** (i) required in P2, where Radeef is the system of record, as a P3 entry condition; (ii) replaced by BL-PAY-020's own acceptance ("a sample file from a real bank is validated", BACKLOG.md:195) without system-of-record use; (iii) removed from baseline GA under tier (b) | (a)+(i): H-4 on the P2 path; X6 needed before P2. (a)+(ii): H-4 at P3; no system-of-record dependency. (b)+(iii): H-4 PL; GA diverges from AUDIT/13 §12.3, so v1's "§12.3 in full" no longer holds. **Coupled with OD-2** | H-4, P2 gate 5, P3 gate 2, BL-PAY-009 (via OD-2) |
| **OD-8** | LR-14 | Dates written as 2026-10-04 (the v1 freeze header, AUDIT/18 §1, DEC-PO-147, DEC-PO-148, BL-WFE-014) although the commits are dated 2026-10-03 (fb8e001 22:18, 288beb5 22:31; d6bd888 21:48) | **(a)** Correct them to 2026-10-03, the commit date. **(b)** Keep them and annotate the commit date | Bookkeeping only (§13); no gate effect | §13 rows B-08 to B-10 |

---

## 13. Bookkeeping corrections (to apply after approval, not applied)

| # | File / location | Correction | Finding | Evidence |
|---|---|---|---|---|
| B-01 | BACKLOG.md:20-83 (BL-PAY-024, 012, 001, 002, 008) | TODO → DONE (P1-PAY-A, c4530e3) | LR-14 | src/modules/platform/money/; AUDIT/18:125 |
| B-02 | BACKLOG.md:67-73 (BL-PAY-003) | TODO → PARTIAL (ARCH-004 = 6 open) | LR-14 | baseline.json |
| B-03 | BACKLOG.md:85-96 (BL-PAY-006) | TODO → PARTIAL (no BankExport, BankCertificate, lineStatus) | LR-2, LR-14 | schema.prisma |
| B-04 | AUDIT/13:201 | Status line still says P1-PAY-A remains; record it as built in c4530e3 | LR-14 | AUDIT/18:124 |
| B-05 | AUDIT/13:301 | ONB "REDESIGNED v14" → READY v16.1 | v1 §1.2, LR verified | STATE.md:14 |
| B-06 | docs/RELEASE_NOTES_2026-10.md:3, :96-117 | Base b556235 → 5e57859; add 8_, 9o, 9zg..9zn; add the §8.4 data steps; replace per-migration rollback with §8.5 | v1 §1.2, LR-6 | `git rev-list origin/master..HEAD` |
| B-07 | BACKLOG LCY table (BL-LCY-003) | Reconcile status with AUDIT/13:194/:201 | LR (UNVERIFIED list) | AUDIT/18:148 |
| B-08 | AUDIT/17_LAUNCH_PLAN_v1.md:1 freeze header | Date per OD-8 (v1 stays frozen; only the header date, if the owner allows) | LR-14 | fb8e001 2026-10-03 22:18 |
| B-09 | DECISIONS.md:44, :54 (DEC-PO-148, DEC-PO-147); AUDIT/18:6 | Date per OD-8 | LR-14 | git log |
| B-10 | BACKLOG.md:591 (BL-WFE-014 "2026-10-04") | Date per OD-8 | LR-14 | d6bd888 2026-10-03 |
| B-11 | BACKLOG.md:545 and :279 | Record the OD-1 decision and the corrected order | LR-1 | — |
| B-12 | BACKLOG.md:198-203 (BL-PAY-009) | Re-scope or re-tier per OD-2 | LR-2 | — |
| B-13 | BACKLOG.md:592 (BL-IAM-001, P2) | Record that it is a P0 release-audit item with disposition A or B | OA-5 | AUDIT/18:23 |
| B-14 | RUNBOOK 3.5.1 | Add `controls-ready` / `controls-not-ready` (this is S0-2 work; listed so the bookkeeping is complete) | LR-4 | vendor-cli.ts:9, :47 |

---

## 14. "Automatic AI recognition": mapping (v1 §11 updated)

**Owner ruling (DEC-PO-148):**
- No AI/ML feature is a launch dependency.
- Face self-attendance stays optional, off by default and post-launch. It is not removed.
- The workforce NL assistant is FUTURE.
- Automatic absence detection is POST-LAUNCH.

v1 rows 1–8 stand. Added rows (LR-9):

| # | Where | What it is | Plan consequence |
|---|---|---|---|
| 9 | src/app/api/portal/face/route.ts:126-138 | At enrollment, the face is matched **tenant-wide across all companies** (1:N identification) to prevent duplicate enrollment | Counsel C11; class L-13 UNCLASSIFIED. Not a launch dependency (face is PL) |
| 10 | .github/workflows/ci.yml:260-281; services/face/scripts/download_models.py | The CI job downloads ML models from GitHub | P0-06: not a required check, or isolated |
| 11 | 7dc214e, c0b64c3 (in R1); services/face exists in origin/master | Face hardening, including the Docker path of the biometric purge job, ships in R1. Face code is already in production | Listed in the R1 day-one effects (§8.6). Off by default (settings/definitions.ts:103) |
| 12 | ops/new-tenant.sh:155-160 | New tenants get FACE_SERVICE_* variables (left empty until the face service is installed) | Recorded for CRG-04 onboarding procedure; no gate item |

---

## 15. Risks, six questions, not verified

**Risks (v1 §10 carried; changed rows only).**

| # | Risk | Change |
|---|---|---|
| 4 | After the deploy, ENFORCED mode, UNKNOWN_APPROVER, UNATTESTED users and the IBAN restriction hit every tenant on day one | Mitigation: the R1 go/no-go with notice and window; onboarding after migrate, not before (LR-4) |
| 5 | CI has never run; BL-IAM-001 is open | Mitigation: triage classes and disposition A/B (OA-4b, OA-5) |
| 6 | The money design may not converge | Closure by convergence: ≤3 rounds unless a new Critical/High invariant (OA-8). Order per OD-4 |
| 10 | Opus share stays at ~82–92% | Estimates now use the observed share (LR-13) |
| 15 (new) | The plan's own dependency cycle (LCY-008 ↔ OFF) | OD-1 (LR-1) |
| 16 (new) | Treating "built" as "done" | Launch Scope Completion states plus DoD-proof (LR-8) |

**Six questions (programme level).** As v1 §12. Every package plan answers them before it starts (docs/architecture/README.md).

**Not verified** (v1 §13, plus the red team's list):
- What is deployed on each server; the tenant count; whether timers, backups and the drill are active in production.
- Whether any customer contract requires WPS, GOSI, Qiwa, Mudad or Muqeem.
- How Prisma orders `8_` on tenants that already applied 9a..9n, and whether it wraps each migration in a transaction (a staging run will show).
- The exact full-suite test count on a fresh database.
- The statutory text behind PDPL (WPS is now E5 for the employer duty).
- The server-side state of the GitHub SSH key.
- Whether pilot employees have portal accounts (needed to clear LEGACY_UNVERIFIED IBANs).
- BL-LCY-003 (Release B) completion against BACKLOG.
- That BL-OFF-005 is the backlog item for "exit cancellation" in DEC-PO-139 §4 (architect to confirm).
- The 9zb/9zf/9zk backfills and 9zf:240 are taken from LR-6. 9zh:27, 9zm:10, 9x:8-13 and 9x:33-37 were re-read for v2.

## Key files
- C:\Users\saif\Pictures\radeef-main\AUDIT\17_LAUNCH_PLAN_v1.md
- C:\Users\saif\Pictures\radeef-main\AUDIT\18_LAUNCH_AUDIT.md
- C:\Users\saif\Pictures\radeef-main\AUDIT\13_MASTER_PLAN.md
- C:\Users\saif\Pictures\radeef-main\AUDIT\14_PHASE2_PLAN.md
- C:\Users\saif\Pictures\radeef-main\AUDIT\04_CROSS_DOMAIN_DEPENDENCIES.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\backlog\BACKLOG.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\decisions\DECISIONS.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\audits\evidence-ledger.md
- C:\Users\saif\Pictures\radeef-main\docs\architecture\ARCHITECTURE_INVARIANTS.md
- C:\Users\saif\Pictures\radeef-main\docs\architecture\DOMAIN_MODEL.md
- C:\Users\saif\Pictures\radeef-main\ops\deploy.sh
- C:\Users\saif\Pictures\radeef-main\prisma\migrations\9x_db_constraints\migration.sql
- C:\Users\saif\Pictures\radeef-main\src\modules\iam\vendor-cli.ts
- C:\Users\saif\Pictures\radeef-main\src\app\api\portal\face\route.ts
- C:\Users\saif\Pictures\radeef-main\src\test\architecture\baseline.json
