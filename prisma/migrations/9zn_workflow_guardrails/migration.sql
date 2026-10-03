-- 9zn_workflow_guardrails (BL-WFE-003, package C; DEC-PO-146 / ADR-0011, INV-IAM-01 / ADR-0010).
--
-- Two-person activation of an approval path: the person who activates a version is neither the one who created
-- the draft nor the one who last edited it. The engine refuses it (workflow.activateWorkflowDefinition); this
-- migration records the last editor and adds the database backstop:
--   lastEditedById      the login whose save produced the current content of the draft (null on rows saved before
--                       this migration: the creator is then the last editor, read as COALESCE).
--   activationSelfAct   true only when the activation was the recorded single-operator exception (the company read
--                       SINGLE_OPERATOR at activation, SELF_ACT_SINGLE_OPERATOR in the audit and the owner digest).
-- CHECK WorkflowDefinition_two_person_activation: an activated (ACTIVE or RETIRED) row has an activator other than
-- its creator and its last editor, unless activationSelfAct is set. No row is ACTIVE or RETIRED in any tenant
-- (phase 2 is un-activatable, activationBlockers), so the CHECK is validated.
-- The guard trigger is extended: the authorship of an activated version (creator, last editor, activator, the
-- self-act flag) is as immutable as its content (G6), and so is the retirement of a retired one.
--
-- DEC-PO-147: retiring a version so that a looser one governs needs two people too. The first person's request is
-- recorded on the ACTIVE row (retireRequestedById / retireRequestedAt) and a second person confirms it (retiredById);
-- retireSelfAct marks the recorded single-operator exception. CHECK WorkflowDefinition_two_person_retire: a requested
-- retirement is confirmed by someone else unless retireSelfAct is set. A retirement that loosens nothing (or the one an
-- activation performs) has no request and stays one person.
-- The request also records WHAT was reviewed: the version that would govern (retireFallbackId) and the sorted relaxation
-- codes (retireRelaxations). The confirmation recomputes them from the current state and is refused (and the request
-- cleared) when the fallback changed or the effect grew (the BL-PAY-031 principle).

-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN     "activationSelfAct" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastEditedById" TEXT,
ADD COLUMN     "retireFallbackId" TEXT,
ADD COLUMN     "retireRelaxations" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "retireRequestedAt" TIMESTAMP(3),
ADD COLUMN     "retireRequestedById" TEXT,
ADD COLUMN     "retireSelfAct" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_retireRequestedById_fkey" FOREIGN KEY ("retireRequestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_retireFallbackId_fkey" FOREIGN KEY ("retireFallbackId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkflowDefinition"
  ADD CONSTRAINT "WorkflowDefinition_two_person_activation" CHECK (
    "status" = 'DRAFT'
    OR "activationSelfAct"
    OR ("activatedById" <> "createdById" AND "activatedById" <> COALESCE("lastEditedById", "createdById"))
  ),
  ADD CONSTRAINT "WorkflowDefinition_self_act_activated" CHECK (NOT "activationSelfAct" OR "status" <> 'DRAFT'),
  ADD CONSTRAINT "WorkflowDefinition_retire_request_stamped" CHECK (
    ("retireRequestedById" IS NULL) = ("retireRequestedAt" IS NULL)
    AND ("retireRequestedById" IS NULL) = ("retireFallbackId" IS NULL)
    AND "retireRelaxations" IS NOT NULL
    AND ("retireRequestedById" IS NULL) = (cardinality("retireRelaxations") = 0)
  ),
  ADD CONSTRAINT "WorkflowDefinition_retire_request_active" CHECK ("retireRequestedById" IS NULL OR "status" <> 'DRAFT'),
  ADD CONSTRAINT "WorkflowDefinition_two_person_retire" CHECK (
    "status" <> 'RETIRED'
    OR "retireRequestedById" IS NULL
    OR "retireSelfAct"
    OR "retiredById" <> "retireRequestedById"
  ),
  ADD CONSTRAINT "WorkflowDefinition_retire_self_act_retired" CHECK (NOT "retireSelfAct" OR ("status" = 'RETIRED' AND "retireRequestedById" IS NOT NULL));

CREATE OR REPLACE FUNCTION workflow_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'WorkflowDefinition %: only a DRAFT can be deleted (G6)', OLD."id"; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."definitionJson" IS DISTINCT FROM OLD."definitionJson" OR NEW."checksum" IS DISTINCT FROM OLD."checksum"
      OR NEW."requestType" IS DISTINCT FROM OLD."requestType" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."lastEditedById" IS DISTINCT FROM OLD."lastEditedById"
      OR NEW."activatedById" IS DISTINCT FROM OLD."activatedById" OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
      OR NEW."activationSelfAct" IS DISTINCT FROM OLD."activationSelfAct") THEN
    RAISE EXCEPTION 'WorkflowDefinition %: an activated version is immutable (G6)', OLD."id";
  END IF;
  IF NOT (OLD."status" = NEW."status" OR (OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE') OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
    RAISE EXCEPTION 'WorkflowDefinition %: % -> % is not allowed', OLD."id", OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'RETIRED' AND (NEW."retiredById" IS DISTINCT FROM OLD."retiredById" OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt"
      OR NEW."retireRequestedById" IS DISTINCT FROM OLD."retireRequestedById" OR NEW."retireRequestedAt" IS DISTINCT FROM OLD."retireRequestedAt"
      OR NEW."retireSelfAct" IS DISTINCT FROM OLD."retireSelfAct" OR NEW."retireFallbackId" IS DISTINCT FROM OLD."retireFallbackId"
      OR NEW."retireRelaxations" IS DISTINCT FROM OLD."retireRelaxations") THEN
    RAISE EXCEPTION 'WorkflowDefinition %: a retired version is immutable (G6)', OLD."id";
  END IF;
  RETURN NEW;
END $$;
