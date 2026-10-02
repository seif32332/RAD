# Phase 2 plan: approval engine and notifications (WFE, NOTIF, REQ)

Written 2026-10-02 by the architect agent (Opus, read-only), from AUDIT/13_MASTER_PLAN.md phase 2,
wfe-to-be.md v14.1, req-to-be.md v14.1, arc-conformance.md (ARC-WFE-A1..A9, ARC-REQ-A1..A4) and the
BACKLOG. Routing follows `.claude/agent-routing.md`.

## Six questions (whole phase)

- Owning module: `src/modules/workflow` (new; imports only platform and iam). Adapters in
  `src/modules/requests` and `src/modules/assets` (new). In-app notifications in platform.
- Source of truth: WorkflowInstance and WorkflowTask for the decision; request rows hold their own
  state, written by their adapter (ARC-REQ-A4, G10).
- Transitions: `workflow.start/act/cancel/pause/resume/closeExternally/recheck`, each through
  `runTransition` with an operationKey and CAS on version (ARC-WFE-A3).
- Temporal effect: none.
- Invariants: INV-WF-01 (new), INV-SCOPE-01, INV-EVT-01, ARCH-014/016/017/020.
- Scope: Instance and Task carry the beneficiary's companyId; a delegation carries companyIds[].

## Owner decisions (2026-10-02)

- Exit gate narrowed (DEC-PO-131): engine live + general, data-update, medical-insurance, asset and owner requests on it.
- Web push after the in-app inbox and email (DEC-PO-132): package F builds inbox + email only.
- Owner requests always belong to one company (DEC-PO-133): package I adds a required OwnerRequest.companyId.
- Money-adapters design round starts now in parallel (DEC-PO-134).

## Blockers

1. BL-PAY-005 / BL-PAY-021 (vendor staff, attestation, operator mode) are P1-PAY-B. The core can be
   built now; no request type is activated until they are committed.
2. Lock order: workflow may not import people. Fix: an EmployeeLockPort that people registers,
   required and fail-closed.
3. The money gateway does not unblock BL-WFE-012 (money adapters): it needs a council design round
   (RT-WFE-601..609 open).

## Packages (each leaves the tree green; migration letters provisional, next free when started)

| # | Package | Build | Routing |
|---|---|---|---|
| R0 | Recon | legacy decision entry points of the 4 REQ types, ASSET_STATUS readers, notification producers, prefixed AttendanceCorrection rows | scout (Haiku) |
| A | Schema (WFE-001) | WorkflowDefinition, Instance, Task, ApprovalDelegation; enums; uniques | Opus spec, migrator (Sonnet) |
| B | Core (WFE-002) | definition, resolve, engine, ports, adapters registry, events, scope, queries, transitions | **Opus**; tests test-writer (Sonnet) |
| C | Guardrails (WFE-003) | G1/G1b/G2b/G9, single operator, hasPayEffect, change log, owner digest | **Opus**; after P1-PAY-B |
| D | Delegation (WFE-006) | create/revoke, ignore rules, reassign, BLOCKED | **Opus** |
| E | Jobs + exit (WFE-004/005) | workflow-deadlines, workflow-repair, closeExternally, INV-WF-01 | core Opus; job wiring mechanic (Sonnet) |
| F | Notifications (P2-NOTIF) | in-app inbox, preferences, Arabic templates, consumer, web push | recipients/scope/confidentiality **Opus**; templates/UI mechanic |
| G | Inbox + timeline (WFE-008) | tasks API, instance timeline, "اعتماداتي" page | mechanic + test-writer; reviewer, refuter Opus on findings |
| H | Editor (WFE-007) | /settings/workflows | UI mechanic; activation authority check Opus |
| I | REQ schema (REQ-001) | 3 request tables, asset reservation, Asset.companyId NOT NULL with backfill, OwnerRequest assignee | backfill **Opus**; DDL migrator |
| J | REQ adapters (REQ-002/003) | requests + assets adapters, reservation atomicity, employment.terminated consumers | **Opus**; mechanical parts mechanic |
| K | Legacy retirement (REQ-004 minus IBAN) | remove prefix route, migrate open rows into instances, G10 CI test | data move **Opus**; removal mechanic |
| L | Owner requests + portal (REQ-006/007) | real assignee, "طلباتي", per-type forms | mechanic + test-writer |
| M | Parity (WFE-009) | REQ v1 templates end to end | test-writer; Opus checks fixtures |

Sequential: A → B → C → D. E after B (alongside C/D only if it stays out of resolve.ts).
Parallel after A: I (schema edits one at a time). Parallel after B: F, G, H.
J needs B, C, I (+ P1-PAY-B to activate); then K and L in parallel; M last.

Out of phase 2: BL-WFE-010 (leave adapter, phase 3), BL-WFE-011 (offboarding adapter, phase 3),
BL-WFE-012 (money adapters, design round), BL-REQ-005 (letters, document-engine session).

## Gaps found

- The master plan names a Notification model, but DOMAIN_BOUNDARIES §5.2 lists only
  NotificationOutbox; Notification, NotificationPreference, PushSubscription need an ADR.
- Asset.companyId nullable; AssetRequest and OwnerRequest have no company key; AssetRequest cascades
  on Employee delete.
- leave, requests and assets modules do not exist yet.

## Token budget

About 8.3M tokens in total, about 3.3M on Opus (about 40%), against the phase 0/1 baseline of 7.55M
at 100% Opus: roughly 60% less Opus.

## R0 recon results (scout, Haiku, 2026-10-02)

- General and data-update requests are not their own tables today: they are AttendanceCorrection rows whose `reason` starts with `[طلب:` (GENERAL_REQUEST_PREFIX) or `[طلب: تحديث بيانات]` (DATA_UPDATE_PREFIX), constants at src/lib/hr-workflows.ts:92-94; created by src/app/api/portal/correction/route.ts:115 and src/app/api/attendance-corrections/route.ts:113; decided by approveAttendanceCorrection / rejectAttendanceCorrection (src/lib/hr-workflows.ts:1050, 1177); filtered out of manager views by prefix (attendance-corrections/route.ts:41, dept-manager/route.ts:148, isHrDirectRequest hr-workflows.ts:105). Package K migrates these rows.
- Medical-insurance requests have no distinct type in code today (handled as general requests): package I creates the table from scratch.
- AssetRequest state machine lives in src/app/api/incoming-requests/route.ts:954-1002 (PENDING_HR → PENDING_OWNER → PENDING_PURCHASING → COMPLETED / REJECTED; completion sets an Asset ACTIVE or creates one).
- Asset.status readers/writers: constants.ts:165, assets/_lib.ts:98-106, assets/route.ts:60, assets/[id]/route.ts:163-219, incoming-requests/route.ts:386 and 1002, assets/page.tsx:420-424, hr-workflows.ts:919-927. Package I/J add RESERVED and must update each.
- GET /api/notifications computes its list on read (pending loans, pending leaves, published circulars, audit log for admins): src/app/api/notifications/route.ts:58-86. There is no notification table; package F replaces this with the platform inbox.
- No id-prefix routing on POST: incoming-requests builds prefixed ids for the UI only; POST receives an explicit `type`.
