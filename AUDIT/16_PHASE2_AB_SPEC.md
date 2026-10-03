# Build spec: phase 2 packages A (WFE-001 schema) and B (WFE-002 core)

Checked against HEAD 4b326dc. I wrote nothing to the repo. A "display" citation means the line as it appeared in a combined `cat -n`; every other citation is a real file line.

## 0. Places where the sources conflict, and which one wins

| Item | Older source | Wins (newer amendment) | Effect |
|---|---|---|---|
| Location of the core | BACKLOG BL-WFE-002 says `src/lib/workflow` | ARC-WFE-A9 (arc-conformance.md:165) | Core goes in `src/modules/workflow` |
| `Employee.exitPolicyPendingAt` | BL-WFE-001 title, wfe-to-be.md:552 | ARC-WFE-A5 (arc-conformance.md:161) deletes it | **Package A does not add it** |
| Job side `scripts/lib/workflow.mjs` and the HTTP recheck route | wfe-to-be.md:569-583 | ARC-WFE-A6 (arc-conformance.md:162) | Not built. Jobs call module functions (package E) |
| Status columns | Recent code uses String + CHECK (schema.prisma:3515) | ARC-WFE-A9 says "enum" | Use Prisma enums |

## 1. The six questions

| Question | Answer |
|---|---|
| Owning module | `src/modules/workflow`. It imports only `@/modules/platform` and `@/modules/iam` (DOMAIN_BOUNDARIES.md:81, 91; this is already checked at rules.ts:209-211). Other modules may import workflow (rules.ts:209). |
| Source of truth | WorkflowInstance and WorkflowTask hold the approval decision. WorkflowDefinition holds the versioned path. ApprovalDelegation holds delegations. A request row keeps its own status, written by its adapter (G10, P1: wfe-to-be.md:127, 329-333). Ownership is already listed in §5.2 (DOMAIN_BOUNDARIES.md:51), so **no §5.2 change and no ADR is needed for the tables**. **A gap exists:** SOURCE_OF_TRUTH has no row for these facts, and §3.3 rule 1 (SOURCE_OF_TRUTH.md:70) says the row must exist before the migration. This needs **ADR-0006**, a small one that adds three SoT rows (decision, definition, delegation), each with sole writer `workflow` transitions. The ADR must be accepted before package A merges. |
| Transitions | `startWorkflow`, `actOnWorkflowTask`, `cancelWorkflow`, `pauseWorkflow`, `resumeWorkflow`, `closeWorkflowExternally`, `recheckWorkflow`. **Two more are added**, `resubmitWorkflow` and `restartWorkflowRound`, because the §11.1 state machine needs them (wfe-to-be.md:217, 219). Definitions get `saveWorkflowDefinitionDraft`, `activateWorkflowDefinition` and `retireWorkflowDefinition` (§12.9, wfe-to-be.md:422-425). Every transition is idempotent on its operation key and uses CAS on `version` (ARC-WFE-A3, arc-conformance.md:159). |
| Temporal effect | None. No effective periods. Task deadlines are working-day dates. The delegation window is the validity interval of a grant, not a DOMAIN_MODEL §1.3 period. |
| Invariants | INV-WF-01 (ARCHITECTURE_INVARIANTS.md:103; the check is built in package E, and A/B supply the columns it reads), INV-SCOPE-01 (:104), INV-EVT-01 (:107), ARCH-001/002/006/009/014/015/017/019/020 (:29-47). |
| Scope contract | Instance and Task carry `companyId`, which is the beneficiaries' company at start (DOMAIN_BOUNDARIES.md:143; ADR-0001 #14). Instance and Task are scoped automatically by the companyId column rule (iam/scope-models.ts:81). ApprovalDelegation has `companyIds[]` and so is not scoped automatically (scope-models.ts:73-90); `workflow/scope.ts` filters it. `WorkflowDefinition.companyId` is nullable, meaning a tenant default (ARC-WFE-A7). Rows with a null companyId are invisible to a restricted scopedPrisma, so definitions are resolved through `queries.ts` with an explicit OR (see §3.6). **Phase 2 refuses `crossCompany` adapters.** |

## 2. Package A: schema (WFE-001)

**Migration name:** `<letter>_workflow_engine`. Take the next free letter at build time. That is `9zi` unless BL-PAY-030 (BACKLOG:588) has used it, in which case take the next one. Never `10+` (`prisma/migrations` currently ends at `9zh_money_fixes`). The migration is expand-only, with no data move. Rollback: the previous release ignores the new tables.

### 2.1 Prisma enums

```prisma
enum WorkflowDefinitionStatus { DRAFT ACTIVE RETIRED }
enum WorkflowInstanceStatus  { RUNNING AWAITING_REQUIREMENT RETURNED PAUSED BLOCKED APPROVED REJECTED CANCELLED }
enum WorkflowCloseKind       { DECIDED AUTO_APPROVED CANCELLED_BY_ACTOR RETURN_EXPIRED EXTERNAL MIGRATION }
enum WorkflowTaskKind        { APPROVE REJECT_PAIR CANCEL_CONFIRM REQUIREMENT_CHECK DEFERRAL_DECISION }
enum WorkflowTaskStatus      { OPEN APPROVED REJECTED RETURNED NOT_REQUIRED CANCELLED }
```

- Task status `CANCELLED` is reserved by §11.2. Nothing writes it in phase 2.
- `closeSource`, `pauseReasons`, `blockedReason` and `awaitingRequirement` are free **codes** that each adapter declares, checked by format only. This keeps module and money reasons out of the core (DEC-PO-139).

### 2.2 Models

All foreign keys use `onDelete: Restrict`. `@updatedAt` is used where shown. The migrator adds the back-relations on `User` and `Company`.

**WorkflowDefinition** `/// kind: FACT`: a versioned configuration. Owner workflow. G6.

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| id | String | no | uuid() | PK |
| requestType | String | no | | e.g. `requests.general`; format CHECK |
| companyId | String | yes | | FK Company. NULL = tenant default (ARC-WFE-A7) |
| version | Int | no | | ≥1; unique per (type, company) |
| status | WorkflowDefinitionStatus | no | DRAFT | |
| definitionJson | Json | no | | §3.3 schema |
| checksum | String | no | | sha256 hex of the canonical JSON |
| basedOnId | String | yes | | FK self (the version it was copied from) |
| changeNote | String | yes | | |
| createdById | String | no | | FK User |
| createdAt | DateTime | no | now() | |
| activatedById / activatedAt | String / DateTime | yes | | FK User |
| retiredById / retiredAt | String / DateTime | yes | | FK User |
| updatedAt | DateTime | no | @updatedAt | |

Index: `@@index([requestType, companyId, status])`.

**WorkflowInstance** `/// kind: REQUEST`

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| id | String | no | uuid() | |
| companyId | String | no | | FK Company. Scope key |
| requestType | String | no | | format CHECK |
| requestId | String | no | | polymorphic, no FK |
| definitionId | String | no | | FK WorkflowDefinition (pinned version, G6) |
| status | WorkflowInstanceStatus | no | RUNNING | |
| previousStatus | WorkflowInstanceStatus | yes | | |
| version | Int | no | 0 | CAS |
| round | Int | no | 1 | |
| returns | Int | no | 0 | |
| beneficiaryEmployeeIds | String[] | no | [] | GIN |
| requesterUserId | String | yes | | FK User (null only for migrated rows, §17.3) |
| hasPayEffect | Boolean | no | false | **CHECK = false in phase 2** |
| contextSnapshotJson | Json | no | "{}" | |
| managerChainSnapshot | Json | no | "[]" | |
| pathTaken | Json | no | "[]" | |
| pauseReasons | String[] | no | [] | stack with set semantics |
| pausedAt | DateTime | yes | | |
| blockedAt / blockedReason | DateTime / String | yes | | |
| awaitingRequirement / awaitingSince | String / DateTime | yes | | |
| effectFailedAt / lastEffectError | DateTime / String | yes | | |
| startedAt | DateTime | no | now() | |
| closedAt | DateTime | yes | | |
| closeKind | WorkflowCloseKind | yes | | |
| closeSource | String | yes | | adapter code |
| closedByUserId | String | yes | | FK User |
| createdAt / updatedAt | DateTime | no | now() / @updatedAt | |

Constraints and indexes:
- `@@unique([requestType, requestId])` (ARC-WFE-A3)
- `@@unique([id, companyId])`, the target of the task's composite FK
- `@@index([companyId, status])`
- `@@index([requesterUserId])`
- `@@index([definitionId])`
- `@@index([beneficiaryEmployeeIds], type: Gin)`

**WorkflowTask** `/// kind: REQUEST`

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| id | String | no | uuid() | |
| instanceId | String | no | | **composite FK (instanceId, companyId) → WorkflowInstance(id, companyId)** |
| companyId | String | no | | FK Company. Equals the instance's company, enforced by the composite FK |
| round | Int | no | | ≥1 |
| nodeId | String | no | | APPROVE tasks use the definition node id. Other kinds use `<kind>#<n>` (§3.5) |
| kind | WorkflowTaskKind | no | APPROVE | |
| status | WorkflowTaskStatus | no | OPEN | |
| candidateUserIds | String[] | no | [] | GIN (inbox) |
| candidatesSnapshotJson | Json | no | "[]" | `[{userId, via: STAGE\|COVER\|OWNER_COVER\|DELEGATE, reason?, onBehalfOf?}]` |
| dueAt | DateTime | yes | | |
| coverReason | String | yes | | APPROVER_UNAVAILABLE / NO_MANAGER / MANAGER_ON_LEAVE / DEADLINE |
| overdueAt / escalatedAt | DateTime | yes | | set by package E |
| actedByUserId / onBehalfOfUserId | String | yes | | FK User |
| decisionFieldsJson | Json | yes | | |
| decidedAt | DateTime | yes | | the time the task was closed (any non-OPEN status) |
| note | String | yes | | |
| createdAt / updatedAt | DateTime | no | | |

Constraints and indexes:
- `@@unique([instanceId, round, nodeId, kind])` (ARC-WFE-A3)
- `@@index([companyId, status])`
- `@@index([candidateUserIds], type: Gin)`
- `@@index([actedByUserId])`
- If `prisma validate` refuses the overlapping `companyId` in two relations, the migrator **stops and reports**. The migrator must not fall back to an SQL-only FK.

**ApprovalDelegation** `/// kind: FACT` (a grant whose only state is revocation)

| Column | Type | Null | Default | Note |
|---|---|---|---|---|
| id | String | no | uuid() | |
| fromUserId / toUserId | String | no | | FK User |
| companyIds | String[] | no | | ≥1; GIN |
| requestTypes | String[] | no | [] | empty = every type. A String[] replaces §17.1 `requestTypesJson` so containment can be indexed |
| startsAt / endsAt | DateTime | no | | |
| reason | String | yes | | required when the creator is not the delegator |
| createdById | String | no | | FK User |
| createdAt | DateTime | no | now() | |
| revokedAt / revokedById / revokeReason | | yes | | FK User for revokedById |

Indexes: `@@index([toUserId, startsAt])`, `@@index([fromUserId, startsAt])`, `@@index([companyIds], type: Gin)`.

### 2.3 SQL that Prisma cannot express (second half of the migration, following the 9zg precedent of partial uniques in SQL, 9zg migration.sql:242)

```sql
-- WorkflowDefinition
ALTER TABLE "WorkflowDefinition"
  ADD CONSTRAINT "WorkflowDefinition_request_type_format" CHECK ("requestType" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$'),
  ADD CONSTRAINT "WorkflowDefinition_version_positive" CHECK ("version" >= 1),
  ADD CONSTRAINT "WorkflowDefinition_checksum_sha256" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "WorkflowDefinition_activation_stamped" CHECK ("status" = 'DRAFT' OR ("activatedAt" IS NOT NULL AND "activatedById" IS NOT NULL)),
  ADD CONSTRAINT "WorkflowDefinition_retire_stamped" CHECK (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL AND "retiredById" IS NOT NULL));
CREATE UNIQUE INDEX "WorkflowDefinition_version_tenant"  ON "WorkflowDefinition"("requestType","version") WHERE "companyId" IS NULL;
CREATE UNIQUE INDEX "WorkflowDefinition_version_company" ON "WorkflowDefinition"("requestType","companyId","version") WHERE "companyId" IS NOT NULL;
CREATE UNIQUE INDEX "WorkflowDefinition_one_active_tenant"  ON "WorkflowDefinition"("requestType") WHERE "status" = 'ACTIVE' AND "companyId" IS NULL;
CREATE UNIQUE INDEX "WorkflowDefinition_one_active_company" ON "WorkflowDefinition"("requestType","companyId") WHERE "status" = 'ACTIVE' AND "companyId" IS NOT NULL;
CREATE UNIQUE INDEX "WorkflowDefinition_one_draft_tenant"   ON "WorkflowDefinition"("requestType") WHERE "status" = 'DRAFT' AND "companyId" IS NULL;
CREATE UNIQUE INDEX "WorkflowDefinition_one_draft_company"  ON "WorkflowDefinition"("requestType","companyId") WHERE "status" = 'DRAFT' AND "companyId" IS NOT NULL;
CREATE OR REPLACE FUNCTION workflow_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'WorkflowDefinition %: only a DRAFT can be deleted (G6)', OLD."id"; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."definitionJson" IS DISTINCT FROM OLD."definitionJson" OR NEW."checksum" IS DISTINCT FROM OLD."checksum"
      OR NEW."requestType" IS DISTINCT FROM OLD."requestType" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."version" IS DISTINCT FROM OLD."version") THEN
    RAISE EXCEPTION 'WorkflowDefinition %: an activated version is immutable (G6)', OLD."id";
  END IF;
  IF NOT (OLD."status" = NEW."status" OR (OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE') OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
    RAISE EXCEPTION 'WorkflowDefinition %: % -> % is not allowed', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "WorkflowDefinition_guard" BEFORE UPDATE OR DELETE ON "WorkflowDefinition" FOR EACH ROW EXECUTE FUNCTION workflow_definition_guard();

-- WorkflowInstance
ALTER TABLE "WorkflowInstance"
  ADD CONSTRAINT "WorkflowInstance_request_type_format" CHECK ("requestType" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$'),
  ADD CONSTRAINT "WorkflowInstance_counters" CHECK ("version" >= 0 AND "round" >= 1 AND "returns" >= 0),
  ADD CONSTRAINT "WorkflowInstance_closed_iff_terminal" CHECK ((("status" IN ('APPROVED','REJECTED','CANCELLED')) = ("closedAt" IS NOT NULL)) AND (("closedAt" IS NULL) = ("closeKind" IS NULL))),
  ADD CONSTRAINT "WorkflowInstance_pause_stack" CHECK (("status" <> 'PAUSED' OR cardinality("pauseReasons") > 0) AND ("status" IN ('PAUSED','BLOCKED') OR cardinality("pauseReasons") = 0)),
  ADD CONSTRAINT "WorkflowInstance_pause_codes" CHECK (array_to_string("pauseReasons", ',') ~ '^([A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*)?$'),
  ADD CONSTRAINT "WorkflowInstance_previous_status" CHECK (("previousStatus" IS NULL OR "previousStatus" IN ('RUNNING','RETURNED','AWAITING_REQUIREMENT'))
       AND ("status" <> 'PAUSED' OR "previousStatus" IS NOT NULL) AND ("status" IN ('PAUSED','BLOCKED') OR "previousStatus" IS NULL)),
  ADD CONSTRAINT "WorkflowInstance_paused_at" CHECK (("status" = 'PAUSED') = ("pausedAt" IS NOT NULL)),
  ADD CONSTRAINT "WorkflowInstance_blocked" CHECK ((("status" = 'BLOCKED') = ("blockedAt" IS NOT NULL)) AND (("blockedAt" IS NULL) = ("blockedReason" IS NULL))),
  ADD CONSTRAINT "WorkflowInstance_awaiting" CHECK (("status" <> 'AWAITING_REQUIREMENT' OR "awaitingSince" IS NOT NULL)
       AND ("status" IN ('AWAITING_REQUIREMENT','PAUSED') OR "awaitingSince" IS NULL) AND (("awaitingSince" IS NULL) = ("awaitingRequirement" IS NULL))),
  ADD CONSTRAINT "WorkflowInstance_codes_format" CHECK (("closeSource" IS NULL OR "closeSource" ~ '^[A-Z][A-Z0-9_]{1,63}$')
       AND ("blockedReason" IS NULL OR "blockedReason" ~ '^[A-Z][A-Z0-9_]{1,63}$') AND ("awaitingRequirement" IS NULL OR "awaitingRequirement" ~ '^[A-Z][A-Z0-9_]{1,63}$')),
  ADD CONSTRAINT "WorkflowInstance_effect_failure" CHECK ("effectFailedAt" IS NULL OR "lastEffectError" IS NOT NULL),
  -- DEC-PO-139: no pay-effect request type runs on the engine in phase 2. Dropped only by the migration
  -- that activates the first pay-effect type (phase 3, after the money-adapters design is accepted).
  ADD CONSTRAINT "WorkflowInstance_phase2_no_pay_effect" CHECK ("hasPayEffect" = false);
CREATE INDEX "WorkflowInstance_open" ON "WorkflowInstance"("companyId","status") WHERE "status" NOT IN ('APPROVED','REJECTED','CANCELLED');

-- WorkflowTask
ALTER TABLE "WorkflowTask"
  ADD CONSTRAINT "WorkflowTask_round_positive" CHECK ("round" >= 1),
  ADD CONSTRAINT "WorkflowTask_node_format" CHECK ("nodeId" ~ '^[A-Za-z0-9_.:#-]{1,64}$'),
  ADD CONSTRAINT "WorkflowTask_open_undecided" CHECK (("status" = 'OPEN') = ("decidedAt" IS NULL)),
  ADD CONSTRAINT "WorkflowTask_actor_on_decision" CHECK ("status" NOT IN ('APPROVED','REJECTED','RETURNED') OR "actedByUserId" IS NOT NULL),
  ADD CONSTRAINT "WorkflowTask_on_behalf_distinct" CHECK ("onBehalfOfUserId" IS NULL OR "onBehalfOfUserId" <> "actedByUserId"),
  ADD CONSTRAINT "WorkflowTask_reject_reason" CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("note", ''))) > 0),
  ADD CONSTRAINT "WorkflowTask_return_only_approve" CHECK ("status" <> 'RETURNED' OR "kind" = 'APPROVE');
CREATE UNIQUE INDEX "WorkflowTask_one_open_special" ON "WorkflowTask"("instanceId","kind")
  WHERE "status" = 'OPEN' AND "kind" IN ('REJECT_PAIR','CANCEL_CONFIRM','DEFERRAL_DECISION','REQUIREMENT_CHECK');
CREATE INDEX "WorkflowTask_open_due" ON "WorkflowTask"("dueAt") WHERE "status" = 'OPEN' AND "dueAt" IS NOT NULL;

-- ApprovalDelegation (btree_gist exists since 9u, migration.sql:29)
ALTER TABLE "ApprovalDelegation"
  ADD CONSTRAINT "ApprovalDelegation_distinct_parties" CHECK ("fromUserId" <> "toUserId" AND "toUserId" <> "createdById"),
  ADD CONSTRAINT "ApprovalDelegation_window" CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "ApprovalDelegation_companies" CHECK (cardinality("companyIds") >= 1),
  ADD CONSTRAINT "ApprovalDelegation_reason_on_behalf" CHECK ("createdById" = "fromUserId" OR length(btrim(coalesce("reason", ''))) > 0),
  ADD CONSTRAINT "ApprovalDelegation_revocation" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL)),
  ADD CONSTRAINT "ApprovalDelegation_one_delegate" EXCLUDE USING gist ("fromUserId" WITH =, tsrange("startsAt","endsAt",'[)') WITH &&) WHERE ("revokedAt" IS NULL);
```

`WorkflowTask_one_open_special` is ARC-WFE-A3's partial unique (three kinds) plus REQUIREMENT_CHECK, which is stricter and safe. `ApprovalDelegation_one_delegate` means one delegate per delegator at any moment (DEC-PO-103).

**ADR and ownership:**
- The 4 tables are already in §5.2 (DOMAIN_BOUNDARIES.md:51). ARCH-002.owner requires that (rules.ts:253-262), so **no extra table is allowed**. Versions are rows of WorkflowDefinition. History is WorkflowTask rows plus AuditRecord plus DomainEvent, so there is no history table.
- The only ADR needed is ADR-0006 for the SoT rows (§1).
- The Notification models do need their own ADR (14_PHASE2_PLAN.md:63-64), but that is package F and is not affected here.

## 3. Package B: core (WFE-002)

### 3.1 File layout (`src/modules/workflow/`)

| File | Contents |
|---|---|
| `index.ts` | The only public API. Facade `workflow = {start, act, cancel, pause, resume, closeExternally, recheck, resubmit, restartRound}`, the definition commands, `registerWorkflowAdapter`, `registerWorkflowPort`, port and adapter types, queries, `WORKFLOW_EVENTS`, `WorkflowError` |
| `transitions/instance.ts`, `transitions/task.ts`, `transitions/definition.ts` | **The only files that write** the 4 tables (ARCH-002). ARCH-014 accepts `transitions/*.ts` (rules.ts:625) |
| `engine.ts` | Pure functions, no DB. The §11.1 table as data (command → allowed from-states → to-state), the node walker (sequence, condition, parallel ALL/ANY), terminal handling (open tasks → NOT_REQUIRED, §11.1, wfe-to-be.md:229) |
| `definition.ts` | Strict zod schema, the save-time checks of §12.3 without the money amendment, the limits (depth 5, 20 stages, chain 5), canonical-JSON sha256 checksum |
| `resolve.ts` | §12.4 and §12.5 without the money rules: MANAGER_CHAIN, ROLE, cover, strict G1/G1b exclusion, adapter `guards`, BLOCKED. A pure resolver plus `gatherResolveInputs(tx, …)` (ports and iam) |
| `ports.ts` | Port interfaces, registry, `requirePort()` (fail-closed) |
| `adapters.ts` | Adapter interface, registry with runtime validation |
| `activation.ts` | `activationBlockers(requestType)` |
| `events.ts` | Event names, payload types, key builders |
| `scope.ts` | `assertInstanceInScope`, Self/Team filters, delegation `companyIds` filter |
| `queries.ts` | Instance by request, `tasksForUser` (inbox data), `timelineOf` (tasks + AuditRecord), active-definition lookup |
| `errors.ts` | `WorkflowError(code)` mapped to `HttpError` (src/lib/http.ts:7-21) |
| `testing.ts` | Registry reset. Tests only, never exported from `index.ts` |
| `__tests__/` | |

**Outside the module (registered at the composition root):**
- **people/index.ts:** `registerPeopleWorkflowPorts()` registers the **EmployeeLockPort**, wrapping `lockEmployees` (people/index.ts:20-32).
- **lifecycle/index.ts:** `registerLifecycleWorkflowPorts()` registers the **BeneficiaryStatePort**. This port serves any employee id (beneficiaries and managers) and returns userId, legal company, employmentState and lastWorkingDay, read with the lifecycle readers.
- **Mechanical ports:**
  - org: ManagerChainPort, using `assignmentAt` (org/index.ts:22).
  - calendar: WorkingDaysPort.
  - AvailabilityPort: a legacy implementation over `isOnLeave` (src/lib/leave-server.ts:11), registered in the wiring file because no leave module exists yet (14_PHASE2_PLAN.md:67).
- **iam/users.ts:** add `activeUsersWithRolesInCompany(db, roles, companyId)`. It returns active users that are not documents-only and that have a role in `roles` and either an owner role, no UserCompanyScope rows, or a row for `companyId` (the semantics of iam/context.ts:108-110).
- **Composition root:** `src/lib/workflow-wiring.ts` exports `ensureWorkflowWiring()` (idempotent) and is called from `src/jobs/consumers.ts` and from every route that calls the engine (packages G and J). The path has no module mapping (source.ts:59-77), so ARCH-001.dir allows it.

### 3.2 Ports (ARC-WFE-A1, arc-conformance.md:157; lock order ADR-0002 #2, LIFECYCLE_MODEL.md:44)

```ts
interface EmployeeLockPort { lockEmployees(tx: TxClient, employeeIds: readonly string[], companyIds: CompanySet): Promise<{ id: string; legalCompanyId: string | null }[]> }
interface BeneficiaryStatePort { employees(tx: TxClient, ids: readonly string[], asOf: Date): Promise<{ employeeId: string; userId: string | null; companyId: string | null; employmentState: 'ACTIVE'|'NOTICE'|'TERMINATED'; lastWorkingDay: Date | null }[]> }
interface ManagerChainPort { managerOf(tx: TxClient, employeeId: string, asOf: Date): Promise<string | null> }  // managerEmployeeId
interface AvailabilityPort { unavailable(tx: TxClient, employeeIds: readonly string[], day: Date): Promise<Set<string>> }
interface WorkingDaysPort { addWorkingDays(tx: TxClient, companyId: string, from: Date, days: number): Promise<Date> }
```

- **Required for every command:** EmployeeLockPort and BeneficiaryStatePort. This holds even when there are no beneficiaries.
- **Required on use:** ManagerChainPort and AvailabilityPort when the definition has a MANAGER_CHAIN stage. WorkingDaysPort when any deadline exists.
- If a required port is missing, `WorkflowError('WFE_PORT_MISSING', port)` is thrown **before any write**.
- Registering the same port name twice throws, so nothing can be overridden.
- The port method is named `lockEmployees` so that the AST rules can see it.

**Lock sequence in every transition:**
1. `EmployeeLockPort.lockEmployees(tx, sorted beneficiaries, ctx.companies)`. This is the first lock.
2. `adapter.lockKeys?`.
3. Reads and the CAS write.

The instance row is never locked with `FOR UPDATE`; CAS alone protects it. When the engine runs inside a module's transaction, the module has already locked those employees first (ARCH-019), and locking the same rows again in the same transaction is harmless.

### 3.3 Definition language (stored in `definitionJson`, zod `.strict()` at every level)

```ts
{ schemaVersion: 1,
  settings: { maxReturns: int>=0|null, returnExpiryWorkingDays: int>=1|null, coverRole: Role|null, rejectRequiresPair: boolean,
              rejectAuthority: Role[], autoDefaults?: Record<string,unknown> },
  root: Node }
Node = { type:'sequence', id, children: Node[] }                       // may be empty (zero stages → auto path)
     | { type:'stage', id, approver: {kind:'MANAGER_CHAIN', levels:1..5} | {kind:'ROLE', role: Role},
         deadline?: { workingDays:1..60, onDeadline:'COVER'|'NOTIFY'|'ESCALATE' }, distinctFromPrior?: boolean, decisionFields?: string[] }
     | { type:'condition', id, branches: {when: Expr, node: Node}[] (>=1), otherwise?: Node }
     | { type:'parallel', id, join:'ALL'|'ANY', branches: Node[] (>=2) }
Expr = {field, op:'eq'|'neq'|'in'|'gt'|'gte'|'lt'|'lte'|'exists', value?} | {all: Expr[]} | {any: Expr[]} | {not: Expr}
```

- `MANAGER_CHAIN(k)` expands at start into k sequential APPROVE tasks (`<id>.L1..Lk`), using the chain snapshot (up to 5 levels).
- A missing manager or a loop sends that level to cover with reason NO_MANAGER (X-WFE-004).
- `settings` must **not** accept `adminMoneyMode`, `alternateCollision`, `loanCancelApprovers`, `dropDeductionApprovers` or any other money key (DEC-PO-139). Because the schema is strict, they are refused.

### 3.4 Adapter interface (generic)

```ts
interface WorkflowAdapter<R = unknown> {
  requestType: string; ownerModule: string;
  payEffect: 'NONE';                       // phase 2: literal only. Runtime check too (DEC-PO-139)
  crossCompany?: false;                    // phase 2 refuses true
  fieldCatalog: FieldCatalog; decisionFieldCatalog: FieldCatalog; requiredDecisionFields?: string[];
  closeSources: readonly string[]; pauseReasons: readonly string[]; blockReasons?: readonly string[];
  decisionStatuses: readonly string[]; domainStatuses: readonly string[]; legacyDecisionEntryPoints: readonly string[]; recheckTriggers: readonly string[];
  exitPolicy?: ExitPolicyDeclaration;      // interface property only; the core never ASSIGNS `exitPolicy:` (ARCH-020, rules.ts:845-863)
  load(tx, requestId): Promise<R>;
  parties(tx, req: R): Promise<{ beneficiaryEmployeeIds: string[]; requesterUserId: string | null; companyIdWhenNoBeneficiary?: string; contextSnapshot: Record<string, unknown> }>;
  lockKeys?(tx, req: R): Promise<void>;
  validateSubmit(tx, req: R): Promise<void>;
  validateFinal(tx, req: R): Promise<{ ok: true } | { awaitable: true; requirement: string } | { error: string }>;
  refresh?(tx, req: R): Promise<void>;
  canReject(actor, req): boolean; canReturn(actor, req): boolean; canCancel(actor, req): boolean; cancelNeedsConfirm(instance, req): boolean;
  guards?: readonly CandidateGuard[];      // generic exclusion predicates, applied in resolve and again at act
  onStageApproved?(tx, ctx: HookContext): Promise<void>; onApproved(tx, ctx): Promise<void>;
  onRejected(tx, ctx): Promise<void>; onReturned?(tx, ctx): Promise<void>; onCancelled(tx, ctx): Promise<void>;
  summary(viewer, req: R): Record<string, unknown>;
}
type CandidateGuard = (c: { userId: string; instance: InstanceView; stage: StageView }) => { ok: true } | { exclude: true; reason: string };
```

`registerWorkflowAdapter` refuses each of the following:
- `payEffect !== 'NONE'`
- `crossCompany === true`
- a duplicate type
- a bad type format
- any code that fails `^[A-Z][A-Z0-9_]{1,63}$`

Hooks run inside the engine's transaction. They call only their own module's transitions and produce no side effects (ARC-WFE-A2, arc-conformance.md:158).

### 3.5 Transition signatures

```ts
type WfActor = { type: 'USER'; userId: string } | { type: 'SYSTEM'; job: string };
type WorkflowResult = { instanceId: string; status: WorkflowInstanceStatus; version: number; round: number; outcome: 'APPLIED' | 'NO_CHANGE'; openedTaskIds: string[] };

startWorkflow(tx: TxClient, i: { ctx: ScopeContext; requestType: string; requestId: string }): Promise<WorkflowResult>
actOnWorkflowTask(prisma: RootClient, i: { ctx: ScopedContext|SelfContext|TeamContext; taskId: string; expectedVersion: number;
   decision: 'APPROVE'|'REJECT'|'RETURN'|'CONFIRM'|'DECLINE'|'RECHECK'; note?: string; decisionFields?: Record<string, unknown>; idempotencyKey?: string }): Promise<OperationOutcome<WorkflowResult>>
cancelWorkflow(prisma: RootClient, i: { ctx; instanceId; expectedVersion: number; reason: string; idempotencyKey?: string }): Promise<OperationOutcome<WorkflowResult>>
pauseWorkflow(tx, i: { ctx; instanceId; reason: string; callerKey: string }): Promise<WorkflowResult>
resumeWorkflow(tx, i: { ctx; instanceId; reason: string; callerKey: string }): Promise<WorkflowResult>
closeWorkflowExternally(tx, i: { ctx; instanceId; outcome: 'APPROVED'|'REJECTED'|'CANCELLED'; source: string; actor: WfActor; note?: string }): Promise<WorkflowResult>
recheckWorkflow(tx, i: { ctx; instanceId; callerKey: string }): Promise<WorkflowResult>
resubmitWorkflow(tx, i: { ctx; instanceId }): Promise<WorkflowResult>
restartWorkflowRound(tx, i: { ctx; instanceId; reason: string; callerKey: string }): Promise<WorkflowResult>
saveWorkflowDefinitionDraft / activateWorkflowDefinition / retireWorkflowDefinition(prisma, { ctx, … })   // G7 role check: OWNER group or COMPANY_ADMIN
```

Common rules for all transitions:
- The actor is always `ctx.actor.userId` and is never taken from the client.
- Commands that take `tx` join the calling module's transaction through `idempotent(tx, …)` (platform/operations.ts:117-149). Commands that take `prisma` open their own transaction through `runTransition` (operations.ts:162-184).
- The instance's company must be in `ctx.companies`. Otherwise the error is `WFE_NOT_FOUND` (404, so no existence leak).

Behaviour of individual transitions:
- **start:** locks the beneficiaries, then calls `adapter.lockKeys`. It checks that all beneficiaries are in one company (otherwise `WFE_CROSS_COMPANY`) and that the company is in ctx. It then:
  1. runs `validateSubmit`;
  2. loads the active definition (company first, then tenant; otherwise `WFE_NO_ACTIVE_DEFINITION`);
  3. takes the chain snapshot and walks the definition.
  - If the path is empty, it runs `validateFinal`. `ok` leads to APPROVED with closeKind AUTO_APPROVED and the audit action `AUTO_APPROVED_BY_DEFINITION`, then `onApproved`. `awaitable` leads to AWAITING_REQUIREMENT. `error` throws.
- **act, persistent `onApproved` failure:** the main transaction aborts and the task stays OPEN. A separate `runTransition` then writes `effectFailedAt`/`lastEffectError` under CAS and emits `effectFailed` (§12.11, wfe-to-be.md:483).
- **DEFERRAL_DECISION:** `act` is refused with `WFE_KIND_NOT_SUPPORTED` until BL-WFE-011.
- **Strict G1/G1b in B:** the beneficiary's user and the requester never act. There is no single-operator exception; package C adds it.
- **closeExternally with a USER actor:** applies strict G1/G1b.

### 3.6 Operation keys, CAS and scope reads

| Command | Operation key | Fingerprint |
|---|---|---|
| start | `wf:start:${requestType}:${requestId}` (natural) | — |
| act | `wf:act:${userId}:${idempotencyKey}`, or `wf:act:${taskId}:${userId}:${decision}:v${expectedVersion}` | sha256({taskId, decision, note, decisionFields}) |
| cancel | `wf:cancel:${userId}:${idempotencyKey}`, or `wf:cancel:${instanceId}:${userId}:v${expectedVersion}` | sha256({reason}) |
| pause / resume | `wf:pause:${instanceId}:${reason}:${callerKey}` / `wf:resume:…` | — |
| closeExternally | `wf:close:${instanceId}` (one close per instance) | sha256({outcome, source}). A different outcome gives `OperationKeyConflictError` |
| recheck | `wf:recheck:${instanceId}:${callerKey}` (jobs pass their JobRun id) | — |
| resubmit | `wf:resubmit:${instanceId}:r${round}` | — |
| restartRound | `wf:restart:${instanceId}:r${round}:${callerKey}` | — |
| definition | `wf:def:draft:${type}:${companyId ?? 'tenant'}:${checksum}`, `wf:def:activate:${id}`, `wf:def:retire:${id}` | — |
| events | `${opKey}:${eventType}` (instance) and `${opKey}:${eventType}:${taskId}` (task) | — |

**CAS rules:**
- Every instance write is `updateMany({ where: { id, version: V, status: { in: allowedFrom } }, data: { …, version: V + 1 } })`.
- If the count is 0, the engine reads the instance again. If it is terminal, or the target task is no longer OPEN, the result is `NO_CHANGE` ("already processed"). Otherwise it throws `conflict()` 409 with `retryable: true` (§12.11, wfe-to-be.md:479-481).
- A task write is `updateMany where {id, status: 'OPEN'}`. A count of 0 throws, which aborts the transaction.
- A stale `expectedVersion` follows the same 409 / NO_CHANGE rule.

**Pause and resume semantics:**
- The pause stack is a set. Pushing a reason that is already present changes nothing, which makes a double call idempotent.
- `previousStatus` is saved only on the first pause, and is RUNNING when the instance is BLOCKED (wfe-to-be.md:221-227).
- When the instance leaves PAUSED, the `dueAt` of OPEN APPROVE tasks is recomputed from the resume time.

**Reads (`queries.ts`):**
- The active definition is read with `where: { requestType, status: 'ACTIVE', OR: [{ companyId }, { companyId: null }] }`, preferring the company row.
- Self context: only instances where `ctx.employeeId` is in `beneficiaryEmployeeIds` or `requesterUserId = actor`. The automatic column rule would otherwise return the whole company (scope.ts filterFor → companyFilter).
- Inbox: `candidateUserIds has actor` and companyId in ctx.
- Delegations: `companyIds hasSome ctx.companies`. Self and Team contexts cannot write delegations.

### 3.7 DomainEvents emitted by B (only types already in §5.5, DOMAIN_BOUNDARIES.md:164, so no ADR)

| Event | When | Payload (ids only, plus companyId and actorId) |
|---|---|---|
| `workflow.task.assigned` | each new OPEN task | instanceId, taskId, kind, round, nodeId, candidateUserIds, dueAt, requestType, requestId |
| `workflow.task.notRequired` | each task closed as NOT_REQUIRED | taskId, instanceId, candidateUserIds, priorApproverUserIds (N-WFE-011) |
| `workflow.instance.decided` | APPROVED, REJECTED or CANCELLED | outcome, closeKind, closeSource, requesterUserId, requestType, requestId |
| `workflow.instance.returned` | RETURNED | round, requesterUserId |
| `workflow.instance.blocked` | entering BLOCKED | blockedReason, nodeId |
| `workflow.instance.awaitingRequirement` | entering AWAITING_REQUIREMENT | requirement |
| `workflow.instance.effectFailed` | persistent hook failure | error code |

- Pause, resume, resubmit and restartRound write an AuditRecord only (`audit()`, platform/audit.ts:36), because adding event types would need an ADR.
- `overdue` and `escalated` belong to package E. `delegation.*` belongs to package D.

### 3.8 Activation gate (phase 2 is un-activatable by construction)

`activationBlockers(type)` returns the non-empty list `['BL-PAY-005', 'WFE-003']` from compile-time constants, plus `'DEC-PO-139'` when the adapter's payEffect is not NONE. Both `activateWorkflowDefinition` and `startWorkflow` refuse while the list is non-empty. Tests replace `activation.ts` with `vi.mock`, so there is no seam in production. The other layers of protection are the DB CHECK (§2.3), the `payEffect: 'NONE'` literal type, and the strict settings schema.

### 3.9 Money rules deferred (DEC-PO-139); B must not implement them

| Rule | Source | What B does instead |
|---|---|---|
| §12.3 money amendment: refuse a path with no human stage for pay types; G1b relaxation only in SINGLE_OPERATOR | wfe-money-adapters.md:82, 229 | No pay types exist, and auto-approve is generic |
| §12.4 money exclusion: `decideSelfDealing`/`decideMakerChecker`, adminMoneyMode, alternateCollision DEC-PO-110 | money-adapters:83, 230; wfe-to-be.md:368-375 | The generic `guards` hook only |
| §12.5 GATEWAY_GUARD block reason | money-adapters:83 | `blockedReason` is a free code |
| §12.11 step 3b hasPayEffect flip and its separate-transaction save | wfe-to-be.md:469-473 | Unreachable. If a refresh would set the flag, `WFE_PAY_EFFECT_UNSUPPORTED` is thrown |
| G1 single-operator money exception; G9 attestation on money stages | wfe-to-be.md:309-311, 321-328 | Package C or later, after BL-PAY-005/021 |
| Appendix A in full (C7, C8, C12-C15, G10 money table, money exit rows, loan migration), §12.12 | wfe-to-be.md:485-495, 764-886 | Not touched |

## 4. Tests and ARCH rules

**Unit tests:**
- **definition:**
  - every §12.3 refusal;
  - the limits;
  - money settings keys refused;
  - the checksum is stable when keys are reordered.
- **engine:**
  - every allowed §11.1 row, and every other (status, command) pair refused;
  - the pause set and the BLOCKED rules;
  - parallel ALL/ANY, and any reject rejects the whole request.
- **resolve:**
  - MANAGER_CHAIN(k), loop leading to NO_MANAGER, on-leave cover;
  - ROLE filtered by company;
  - strict G1/G1b;
  - REJECT_PAIR candidates exclude the first rejecter;
  - empty → BLOCKED.
- **registries:**
  - `payEffect` cast to another value is refused;
  - crossCompany refused;
  - duplicate type refused;
  - bad code refused;
  - missing port gives WFE_PORT_MISSING.

**Integration tests (`WFE_IT=1`, fresh database, real iam contexts, auth not mocked):**
- **Migration constraints:**
  - every CHECK rejects a bad row;
  - composite FK company mismatch rejected;
  - partial uniques;
  - definition trigger (activated JSON edit, DRAFT→RETIRED, deleting ACTIVE);
  - EXCLUDE overlap rejected;
  - `hasPayEffect = true` rejected.
- **Double-call for each of the 12 exported transitions:** sequential and `Promise.all`. Each name must appear in the test titles, with an idempotency word (ARCH-014, rules.ts:595-633). The second call is replayed, and the counts of rows, events and audit records are the same.
- **Concurrency:**
  - two candidates act on an ANY task (one APPLIED, one NO_CHANGE);
  - act racing cancel;
  - act on a paused instance → 409;
  - stale version → retryable 409 or NO_CHANGE;
  - two starts with beneficiaries {e1, e2} given in opposite order both complete without deadlock;
  - a spy shows `lockEmployees` runs before `lockKeys` and before any write.
- **Fail-closed:**
  - no lock port or no state port → error and zero rows;
  - start without the activation mock → WFE_NOT_ACTIVATABLE.
- **Scope (module level):**
  - allow: same-company candidate;
  - deny: a non-candidate in the same company (403); the beneficiary is never a candidate;
  - other company: act, read and inbox give 404 or no rows;
  - a Self context sees only its own instances;
  - Team and System-per-company contexts;
  - two-company beneficiaries refused;
  - the tenant definition is visible to both companies and a company definition overrides it;
  - the delegation filter.
- **Events and effects:**
  - each transition emits exactly its event set, with unique keys and companyId;
  - effectFailed is written in a separate transaction and emitted only once on a double call.

**ARCH rules:** none of these needs an ADR. The two new sub-rules refine existing ids, following the precedent of ARCH-001.dir and ARCH-016.test. The baseline must not grow.
- **Already enforced, no change:** ARCH-002.owner, ARCH-001/001.dir (the workflow module cannot read Employee or User directly; rules.ts:182, 210), ARCH-014, ARCH-015.
- **New `ARCH-019.port`:** every export of `src/modules/workflow/transitions/*.ts` that writes a Workflow* table must call `lockEmployees` before its first write. The existing rule sees only employee-keyed models (rules.ts:812-836).
- **New `ARCH-017.adapter`:** no side-effect calls anywhere in `src/modules/*/workflow-adapter.ts` or in `src/modules/workflow/**`. The existing rule checks only the lexical `$transaction` scope.
- **Guard test (a plain test, not an ARCH rule):** no adapter in `src/` registers a `payEffect` other than `'NONE'`.

## 5. Blockers still open at 4b326dc

| Blocker | Evidence | Effect |
|---|---|---|
| BL-PAY-005 (isVendorStaff, User.createdById, attestation) not built | The User model has neither column (schema.prisma:44-80). TODO at lifecycle/policy.ts:16-17, 88-93. AUDIT/13_MASTER_PLAN.md:203 says "not started yet: BL-PAY-005, then 017/022, then 021" | G9 cannot be built. Activation is blocked (wfe-to-be.md:328, 586; BR-REQ-009, req-to-be.md:216-217) |
| BL-PAY-017/022 and BL-PAY-021 not built | Operator mode is only a SystemSetting placeholder (platform/invariants/policy.ts:44-61). BL-PAY-021 also depends on G8 email (BACKLOG:150) | Package C (G9, single operator, digest) is blocked. REQ needs the digest and banner (req-to-be.md:218) |
| LCY-M2 (Release C) not built | `employmentState` is nullable (schema.prisma:551). `employmentStatus` is still present (:548). No M2 CHECK in any migration (lcy-to-be.md:476) | Hard condition for REQ in BR-REQ-009 (req-to-be.md:219). The owner must schedule it, or decide to accept the fallback reader |
| BL-PAY-004 | Built (schema.prisma:3509, cdab83b) | That REQ condition is met |
| Lock order | Fixed in B by the EmployeeLockPort | — |
| Money adapters | Provisional baseline only (wfe-money-adapters.md:3, DEC-PO-139) | No money type in phase 2 |

**What this means:** on the current path, **no request type can be activated** at the end of phase 2. The DEC-PO-131 exit gate (general, data-update without IBAN, medical insurance, asset, owner requests) is reached only if all of these land: BL-PAY-005, BL-PAY-017/022, BL-PAY-021 (and G8 for external delivery), and LCY-M2, followed by packages C, I, J and K. LEV is phase 3, OFF is phase 4, and every money type stays off in phase 2. **The Chair should schedule P1-PAY-B (BL-PAY-005 first) in parallel now.**

## 6. Order of work and routing (.claude/agent-routing.md:14, 35, 38)

1. **Chair, with doc-scribe (Sonnet) drafting:** ADR-0006 for the SoT rows. The owner accepts it before A merges.
2. **migrator (Sonnet):** package A exactly as in §2, then `prisma validate` and the drift diff. It stops and reports on any validation question, such as the composite relation (rule 3).
3. **Chair:** fresh-database deploy, drift check, ARCH-002.owner and ARCH-015 green.
4. **Opus implementer** (`general-purpose`, `model: "opus"`):
   - the whole of `src/modules/workflow`: engine, definition, resolve, transitions, scope, queries, activation, adapters, ports, events, errors;
   - the iam function `activeUsersWithRolesInCompany`;
   - the people EmployeeLockPort and the lifecycle BeneficiaryStatePort.
   
   These cover scope, lock order and segregation of duties, so they stay on Opus.
5. **mechanic (Sonnet):** the org, calendar and legacy-availability ports; `src/lib/workflow-wiring.ts` and its call from `src/jobs/consumers.ts`; the `ARCH-019.port` and `ARCH-017.adapter` sub-rules with fixtures in rules.arch.test.ts.
6. **test-writer (Sonnet):** the §4 list, unit tests first, then `WFE_IT`.
7. **reviewer (Sonnet), one lens each:** correctness, scope, idempotency. Any scope or auth finding goes to **refuter on Opus**.
8. **Chair:** all `*_IT` suites twice on a fresh database, drift check, typecheck, lint. Then scribe (Haiku) writes the commit text and the Chair adds the `.claude/agent-usage.md` rows.

## Key files

- C:\Users\saif\Pictures\radeef-main\AUDIT\14_PHASE2_PLAN.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\workflows\wfe-to-be.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\workflows\arc-conformance.md
- C:\Users\saif\Pictures\radeef-main\.claude\councils\people-os\outputs\workflows\wfe-money-adapters.md
- C:\Users\saif\Pictures\radeef-main\docs\architecture\DOMAIN_BOUNDARIES.md
- C:\Users\saif\Pictures\radeef-main\docs\architecture\SOURCE_OF_TRUTH.md
- C:\Users\saif\Pictures\radeef-main\prisma\schema.prisma
- C:\Users\saif\Pictures\radeef-main\src\modules\platform\operations.ts
- C:\Users\saif\Pictures\radeef-main\src\modules\platform\events.ts
- C:\Users\saif\Pictures\radeef-main\src\modules\people\index.ts
- C:\Users\saif\Pictures\radeef-main\src\modules\iam\scope-models.ts
- C:\Users\saif\Pictures\radeef-main\src\modules\iam\scope.ts
- C:\Users\saif\Pictures\radeef-main\src\test\architecture\rules.ts
- C:\Users\saif\Pictures\radeef-main\src\test\architecture\config.ts
- C:\Users\saif\Pictures\radeef-main\src\jobs\consumers.ts
