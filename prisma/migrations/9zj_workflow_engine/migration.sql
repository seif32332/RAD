-- 9zj_workflow_engine (WFE-001, phase 2 package A): the approval engine tables, owner `workflow`.
-- ADR-0006 (source-of-truth rows for decision, definition, delegation). DEC-PO-139: the
-- WorkflowInstance_phase2_no_pay_effect CHECK (hasPayEffect = false) is dropped only by the migration
-- that activates the first pay-effect request type (phase 3).
-- Expand-only, no data move. Rollback = drop the four tables, the five enums and the
-- workflow_definition_guard function; the previous release ignores them.
-- Part 1: Prisma DDL. Part 2: SQL Prisma cannot express (CHECKs, partial uniques, trigger, EXCLUDE).

-- CreateEnum
CREATE TYPE "WorkflowDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "WorkflowInstanceStatus" AS ENUM ('RUNNING', 'AWAITING_REQUIREMENT', 'RETURNED', 'PAUSED', 'BLOCKED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowCloseKind" AS ENUM ('DECIDED', 'AUTO_APPROVED', 'CANCELLED_BY_ACTOR', 'RETURN_EXPIRED', 'EXTERNAL', 'MIGRATION');

-- CreateEnum
CREATE TYPE "WorkflowTaskKind" AS ENUM ('APPROVE', 'REJECT_PAIR', 'CANCEL_CONFIRM', 'REQUIREMENT_CHECK', 'DEFERRAL_DECISION');

-- CreateEnum
CREATE TYPE "WorkflowTaskStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'RETURNED', 'NOT_REQUIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "companyId" TEXT,
    "version" INTEGER NOT NULL,
    "status" "WorkflowDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "definitionJson" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "basedOnId" TEXT,
    "changeNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "status" "WorkflowInstanceStatus" NOT NULL DEFAULT 'RUNNING',
    "previousStatus" "WorkflowInstanceStatus",
    "version" INTEGER NOT NULL DEFAULT 0,
    "round" INTEGER NOT NULL DEFAULT 1,
    "returns" INTEGER NOT NULL DEFAULT 0,
    "beneficiaryEmployeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requesterUserId" TEXT,
    "hasPayEffect" BOOLEAN NOT NULL DEFAULT false,
    "contextSnapshotJson" JSONB NOT NULL DEFAULT '{}',
    "managerChainSnapshot" JSONB NOT NULL DEFAULT '[]',
    "pathTaken" JSONB NOT NULL DEFAULT '[]',
    "pauseReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pausedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "awaitingRequirement" TEXT,
    "awaitingSince" TIMESTAMP(3),
    "effectFailedAt" TIMESTAMP(3),
    "lastEffectError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeKind" "WorkflowCloseKind",
    "closeSource" TEXT,
    "closedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTask" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "WorkflowTaskKind" NOT NULL DEFAULT 'APPROVE',
    "status" "WorkflowTaskStatus" NOT NULL DEFAULT 'OPEN',
    "candidateUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "candidatesSnapshotJson" JSONB NOT NULL DEFAULT '[]',
    "dueAt" TIMESTAMP(3),
    "coverReason" TEXT,
    "overdueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "actedByUserId" TEXT,
    "onBehalfOfUserId" TEXT,
    "decisionFieldsJson" JSONB,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDelegation" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "companyIds" TEXT[],
    "requestTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowDefinition_requestType_companyId_status_idx" ON "WorkflowDefinition"("requestType", "companyId", "status");

-- CreateIndex
CREATE INDEX "WorkflowInstance_companyId_status_idx" ON "WorkflowInstance"("companyId", "status");

-- CreateIndex
CREATE INDEX "WorkflowInstance_requesterUserId_idx" ON "WorkflowInstance"("requesterUserId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_definitionId_idx" ON "WorkflowInstance"("definitionId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_beneficiaryEmployeeIds_idx" ON "WorkflowInstance" USING GIN ("beneficiaryEmployeeIds");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_requestType_requestId_key" ON "WorkflowInstance"("requestType", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_id_companyId_key" ON "WorkflowInstance"("id", "companyId");

-- CreateIndex
CREATE INDEX "WorkflowTask_companyId_status_idx" ON "WorkflowTask"("companyId", "status");

-- CreateIndex
CREATE INDEX "WorkflowTask_candidateUserIds_idx" ON "WorkflowTask" USING GIN ("candidateUserIds");

-- CreateIndex
CREATE INDEX "WorkflowTask_actedByUserId_idx" ON "WorkflowTask"("actedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTask_instanceId_round_nodeId_kind_key" ON "WorkflowTask"("instanceId", "round", "nodeId", "kind");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_toUserId_startsAt_idx" ON "ApprovalDelegation"("toUserId", "startsAt");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_fromUserId_startsAt_idx" ON "ApprovalDelegation"("fromUserId", "startsAt");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_companyIds_idx" ON "ApprovalDelegation" USING GIN ("companyIds");

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_basedOnId_fkey" FOREIGN KEY ("basedOnId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_retiredById_fkey" FOREIGN KEY ("retiredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_instanceId_companyId_fkey" FOREIGN KEY ("instanceId", "companyId") REFERENCES "WorkflowInstance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_actedByUserId_fkey" FOREIGN KEY ("actedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Part 2: hand-written constraints (AUDIT/16_PHASE2_AB_SPEC.md section 2.3)

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
