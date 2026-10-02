-- 9t_platform_events_audit (master plan P1-FND-EVT + P1-FND-AUDIT)
-- Expand-only: four new tables owned by the platform module (DOMAIN_BOUNDARIES §5.2), no change to
-- any existing table. Sole writer: src/modules/platform.
--
--   DomainEvent       transactional outbox (LIFECYCLE_MODEL §2.1, §2.4). idempotencyKey UNIQUE (ARCH-010).
--   EventConsumption  (consumer, eventId) UNIQUE: a consumer's effect commits with this row, so it runs
--                     at most once per event (LIFECYCLE_MODEL §2.2 item 4); named outcomes such as
--                     RETRO_ROUTED (ADR-0002 #14).
--   OperationLog      operationKey UNIQUE: a repeated operation returns the recorded result (§2.2 item 1).
--   AuditRecord       append-only audit with before/after values (P1-FND-AUDIT). The legacy AuditLog is
--                     not touched: it has a User FK with ON DELETE SET NULL (a user delete UPDATEs its
--                     rows, e.g. scripts/seed-demo.mjs) and a fire-and-forget writer, so it stays the
--                     documented mutable exception until its writers move to AuditRecord.
--
-- Rollback: the tables are new and nothing existing reads them; a previous release ignores them.

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "companyId" TEXT,
    "actorId" TEXT,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "effectiveDate" DATE,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventConsumption" (
    "id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationLog" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actorId" TEXT,
    "companyId" TEXT,
    "fingerprint" TEXT,
    "resultRef" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OperationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRecord" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "companyId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "operationKey" TEXT,
    "ipAddress" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainEvent_seq_key" ON "DomainEvent"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEvent_idempotencyKey_key" ON "DomainEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DomainEvent_status_nextAttemptAt_idx" ON "DomainEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DomainEvent_aggregateType_aggregateId_seq_idx" ON "DomainEvent"("aggregateType", "aggregateId", "seq");

-- CreateIndex
CREATE INDEX "DomainEvent_type_recordedAt_idx" ON "DomainEvent"("type", "recordedAt");

-- CreateIndex
CREATE INDEX "DomainEvent_companyId_idx" ON "DomainEvent"("companyId");

-- CreateIndex
CREATE INDEX "EventConsumption_eventId_idx" ON "EventConsumption"("eventId");

-- CreateIndex
CREATE INDEX "EventConsumption_status_nextAttemptAt_idx" ON "EventConsumption"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventConsumption_consumer_eventId_key" ON "EventConsumption"("consumer", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationLog_operationKey_key" ON "OperationLog"("operationKey");

-- CreateIndex
CREATE INDEX "OperationLog_operation_createdAt_idx" ON "OperationLog"("operation", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditRecord_seq_key" ON "AuditRecord"("seq");

-- CreateIndex
CREATE INDEX "AuditRecord_entityType_entityId_idx" ON "AuditRecord"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditRecord_actorId_idx" ON "AuditRecord"("actorId");

-- CreateIndex
CREATE INDEX "AuditRecord_companyId_occurredAt_idx" ON "AuditRecord"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditRecord_operationKey_idx" ON "AuditRecord"("operationKey");

-- AddForeignKey
ALTER TABLE "EventConsumption" ADD CONSTRAINT "EventConsumption_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DomainEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Status columns (ARCH-015) and shape rules. Prisma does not model CHECK constraints or triggers, so
-- they live here only (and `prisma migrate diff` ignores them).
-- ---------------------------------------------------------------------------
ALTER TABLE "DomainEvent"
  ADD CONSTRAINT "DomainEvent_status_check" CHECK ("status" IN ('PENDING', 'DISPATCHED')),
  ADD CONSTRAINT "DomainEvent_type_check" CHECK ("type" ~ '^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$'),
  ADD CONSTRAINT "DomainEvent_idempotencyKey_check" CHECK (length(btrim("idempotencyKey")) > 0),
  ADD CONSTRAINT "DomainEvent_dispatched_check" CHECK (("status" = 'DISPATCHED') = ("dispatchedAt" IS NOT NULL));

ALTER TABLE "EventConsumption"
  ADD CONSTRAINT "EventConsumption_status_check" CHECK ("status" IN ('DONE', 'FAILED', 'DEAD')),
  ADD CONSTRAINT "EventConsumption_outcome_check" CHECK ("outcome" IS NULL OR "outcome" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "EventConsumption_done_check" CHECK ("status" <> 'DONE' OR ("outcome" IS NOT NULL AND "processedAt" IS NOT NULL));

ALTER TABLE "OperationLog"
  ADD CONSTRAINT "OperationLog_operationKey_check" CHECK (length(btrim("operationKey")) > 0);

ALTER TABLE "AuditRecord"
  ADD CONSTRAINT "AuditRecord_actorType_check" CHECK ("actorType" IN ('USER', 'SYSTEM')),
  ADD CONSTRAINT "AuditRecord_userActor_check" CHECK ("actorType" <> 'USER' OR "actorId" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Immutability (same pattern as DocumentEvent in 9b_document_engine): enforced in the database, so a
-- bug, a script or a manual statement cannot rewrite history.
-- ---------------------------------------------------------------------------

-- AuditRecord: append-only. UPDATE, DELETE and TRUNCATE are refused.
CREATE FUNCTION "audit_record_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditRecord is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "AuditRecord_append_only"
  BEFORE UPDATE OR DELETE ON "AuditRecord"
  FOR EACH ROW EXECUTE FUNCTION "audit_record_append_only"();
CREATE TRIGGER "AuditRecord_no_truncate"
  BEFORE TRUNCATE ON "AuditRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_record_append_only"();

-- DomainEvent: never deleted; the event itself never changes. Only the dispatch columns (status,
-- attempts, nextAttemptAt, leaseUntil, dispatchedAt) are written after the insert.
CREATE FUNCTION "domain_event_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DomainEvent rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."seq" IS DISTINCT FROM OLD."seq"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."aggregateType" IS DISTINCT FROM OLD."aggregateType"
     OR NEW."aggregateId" IS DISTINCT FROM OLD."aggregateId"
     OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
     OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
     OR NEW."effectiveDate" IS DISTINCT FROM OLD."effectiveDate"
     OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt" THEN
    RAISE EXCEPTION 'DomainEvent % is immutable (only dispatch columns change)', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DomainEvent_guard"
  BEFORE UPDATE OR DELETE ON "DomainEvent"
  FOR EACH ROW EXECUTE FUNCTION "domain_event_guard"();

-- EventConsumption: never deleted, and a DONE consumption is final (it is the proof that the effect
-- happened once). FAILED and DEAD rows may still change (retry, or an operator re-queues a DEAD one).
CREATE FUNCTION "event_consumption_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EventConsumption rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DONE' THEN
    RAISE EXCEPTION 'EventConsumption % is DONE and final', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."consumer" IS DISTINCT FROM OLD."consumer" OR NEW."eventId" IS DISTINCT FROM OLD."eventId" THEN
    RAISE EXCEPTION 'EventConsumption % cannot move to another consumer or event', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EventConsumption_guard"
  BEFORE UPDATE OR DELETE ON "EventConsumption"
  FOR EACH ROW EXECUTE FUNCTION "event_consumption_guard"();
