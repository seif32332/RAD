-- 9w_invariants_discrepancies (master plan P1-FND-INV; ARCHITECTURE_INVARIANTS §4.2, §4.3, ADR-0002 #1)
-- Expand-only: two new tables owned by the platform module (DOMAIN_BOUNDARIES §5.2), no change to any
-- existing table. Sole writer: src/modules/platform (reconcile and the discrepancy transitions).
--
--   Discrepancy   one finding of an invariant. fingerprint UNIQUE (rule + check + entity + period): a
--                 repeated detection updates the row, never adds one. Classification OPEN / EXPLAINED /
--                 RESOLVED / WAIVED / AUTO_CLOSED; the two-person columns (explanation + approval,
--                 waiver + approval) and the single-operator record (SELF_ACT_SINGLE_OPERATOR + owner
--                 confirmation over the DEC-PO-022 channel) live on the row, as §4.3 defines them.
--   InvariantRun  one execution of one invariant for one company (or the tenant-level pass).
--
-- Rollback: the tables are new and nothing existing reads them; a previous release ignores them.

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "companyId" TEXT,
    "subjectEmployeeId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "period" TEXT,
    "severity" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "blocks" TEXT[],
    "expectedValue" JSONB,
    "actualValue" JSONB,
    "delta" JSONB,
    "category" TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "pendingAction" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastRunId" TEXT,
    "ownerUserId" TEXT,
    "explanation" TEXT,
    "explanationRef" TEXT,
    "explainedById" TEXT,
    "explainedAt" TIMESTAMP(3),
    "explanationApprovedById" TEXT,
    "explanationApprovedAt" TIMESTAMP(3),
    "waiverReason" TEXT,
    "waivedById" TEXT,
    "waivedAt" TIMESTAMP(3),
    "waiverApprovedById" TEXT,
    "waiverApprovedAt" TIMESTAMP(3),
    "selfActSingleOperator" BOOLEAN NOT NULL DEFAULT false,
    "ownerConfirmation" TEXT,
    "ownerConfirmationRef" TEXT,
    "ownerConfirmedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolutionRef" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvariantRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "companyId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "found" INTEGER NOT NULL DEFAULT 0,
    "opened" INTEGER NOT NULL DEFAULT 0,
    "reopened" INTEGER NOT NULL DEFAULT 0,
    "autoClosed" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvariantRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Discrepancy_fingerprint_key" ON "Discrepancy"("fingerprint");

-- CreateIndex
CREATE INDEX "Discrepancy_companyId_status_severity_idx" ON "Discrepancy"("companyId", "status", "severity");

-- CreateIndex
CREATE INDEX "Discrepancy_status_blocking_idx" ON "Discrepancy"("status", "blocking");

-- CreateIndex
CREATE INDEX "Discrepancy_ruleId_companyId_status_idx" ON "Discrepancy"("ruleId", "companyId", "status");

-- CreateIndex
CREATE INDEX "Discrepancy_subjectEmployeeId_idx" ON "Discrepancy"("subjectEmployeeId");

-- CreateIndex
CREATE INDEX "InvariantRun_runId_idx" ON "InvariantRun"("runId");

-- CreateIndex
CREATE INDEX "InvariantRun_ruleId_companyId_startedAt_idx" ON "InvariantRun"("ruleId", "companyId", "startedAt");


-- ---------------------------------------------------------------------------
-- Status columns (ARCH-015) and the classification rules of §4.3. Prisma does not model CHECK
-- constraints, so they live here only (and `prisma migrate diff` ignores them).
-- ---------------------------------------------------------------------------
ALTER TABLE "Discrepancy"
  ADD CONSTRAINT "Discrepancy_status_check" CHECK ("status" IN ('OPEN', 'EXPLAINED', 'RESOLVED', 'WAIVED', 'AUTO_CLOSED')),
  ADD CONSTRAINT "Discrepancy_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'HIGH', 'BLOCKING')),
  ADD CONSTRAINT "Discrepancy_pendingAction_check" CHECK ("pendingAction" IS NULL OR ("pendingAction" IN ('EXPLANATION', 'WAIVER') AND "status" = 'OPEN')),
  ADD CONSTRAINT "Discrepancy_ownerConfirmation_check" CHECK ("ownerConfirmation" IS NULL OR ("ownerConfirmation" IN ('PENDING', 'CONFIRMED', 'REJECTED') AND "selfActSingleOperator")),
  ADD CONSTRAINT "Discrepancy_category_check" CHECK ("category" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "Discrepancy_ruleId_check" CHECK ("ruleId" ~ '^INV-[A-Z]+-[0-9]{2}$'),
  ADD CONSTRAINT "Discrepancy_period_check" CHECK ("period" IS NULL OR "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "Discrepancy_occurrences_check" CHECK ("occurrences" >= 1),
  -- EXPLAINED needs a text, a reference and an actor (§4.3 rule 5); two different people unless the
  -- single-operator record is set (ADR-0002 #1).
  ADD CONSTRAINT "Discrepancy_explained_check" CHECK ("status" <> 'EXPLAINED' OR ("explanation" IS NOT NULL AND "explanationRef" IS NOT NULL AND "explainedById" IS NOT NULL)),
  ADD CONSTRAINT "Discrepancy_explanation_two_person_check" CHECK ("explanationApprovedById" IS NULL OR "explanationApprovedById" <> "explainedById"),
  -- WAIVED needs two people, or the single-operator record (ADR-0002 #1).
  ADD CONSTRAINT "Discrepancy_waived_check" CHECK ("status" <> 'WAIVED' OR ("waiverReason" IS NOT NULL AND "waivedById" IS NOT NULL AND ("waiverApprovedById" IS NOT NULL OR "selfActSingleOperator"))),
  ADD CONSTRAINT "Discrepancy_waiver_two_person_check" CHECK ("waiverApprovedById" IS NULL OR "waiverApprovedById" <> "waivedById"),
  ADD CONSTRAINT "Discrepancy_resolved_check" CHECK ("status" <> 'RESOLVED' OR ("resolution" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL)),
  ADD CONSTRAINT "Discrepancy_closed_check" CHECK (("status" IN ('RESOLVED', 'AUTO_CLOSED')) = ("closedAt" IS NOT NULL));

ALTER TABLE "InvariantRun"
  ADD CONSTRAINT "InvariantRun_status_check" CHECK ("status" IN ('SUCCEEDED', 'FAILED')),
  ADD CONSTRAINT "InvariantRun_trigger_check" CHECK ("trigger" IN ('SCHEDULED', 'MANUAL', 'PRE_OPERATION')),
  ADD CONSTRAINT "InvariantRun_failed_check" CHECK (("status" = 'FAILED') = ("error" IS NOT NULL));
