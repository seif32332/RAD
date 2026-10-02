-- 9zd_lcy_tables (DEC-PO-128, ADR-0004 #1 and #2 accepted as tables; DOMAIN_BOUNDARIES §5.2)
--
-- The two stored-field workarounds of P1-LCY (9y) become the tables lcy-to-be.md LCY-M1 designed:
--
--   * SettlementEffect (owner offboarding, FACT, append-only): one row per value a settlement approval
--     changed (settlementId, kind, refId, before, after). Replaces Settlement.approvalEffects. Sole
--     writer offboarding.recordSettlementEffects, called by the approval inside its transaction.
--     Unique (settlementId, kind, refId): a repeated write adds nothing.
--   * EmploymentMigrationReview (owner lifecycle): one row per (employee, review code) raised by the
--     LCY-J1 opening (DEC-PO-051). Replaces the "review" array of EmploymentStateChange.legacy. Written
--     only by lifecycle_open_state, recreated below (it stays the single definition of the opening).
--     EmploymentStateChange.legacy keeps the projection values found (the opening's evidence); openings
--     recorded before this migration keep their legacy.review too (the table is append-only), the rows
--     below are the truth.
--
-- Data moved (idempotent: ON CONFLICT DO NOTHING on the unique keys):
--   Settlement.approvalEffects (version 1)  -> SettlementEffect rows (only values that changed, as the
--                                              writer records them; any other version stops the migration)
--   EmploymentStateChange.legacy.review     -> EmploymentMigrationReview rows (details = legacy - review)
-- Then the column Settlement.approvalEffects, its trigger and its function are dropped.
--
-- Release note: code and migration ship together (the release before this one writes approvalEffects on
-- approval). Rollback: re-add the column and rebuild it from SettlementEffect (the rows keep every value).

-- CreateTable
CREATE TABLE "EmploymentMigrationReview" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "stateChangeId" TEXT,
    "code" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,

    CONSTRAINT "EmploymentMigrationReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementEffect" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementEffect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmploymentMigrationReview_code_resolvedAt_idx" ON "EmploymentMigrationReview"("code", "resolvedAt");

-- CreateIndex
CREATE INDEX "EmploymentMigrationReview_stateChangeId_idx" ON "EmploymentMigrationReview"("stateChangeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentMigrationReview_employeeId_code_key" ON "EmploymentMigrationReview"("employeeId", "code");

-- CreateIndex
CREATE INDEX "SettlementEffect_employeeId_idx" ON "SettlementEffect"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementEffect_settlementId_kind_refId_key" ON "SettlementEffect"("settlementId", "kind", "refId");

-- AddForeignKey
ALTER TABLE "EmploymentMigrationReview" ADD CONSTRAINT "EmploymentMigrationReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentMigrationReview" ADD CONSTRAINT "EmploymentMigrationReview_stateChangeId_fkey" FOREIGN KEY ("stateChangeId") REFERENCES "EmploymentStateChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementEffect" ADD CONSTRAINT "SettlementEffect_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementEffect" ADD CONSTRAINT "SettlementEffect_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- What Prisma cannot model (prisma migrate diff ignores it).
-- ---------------------------------------------------------------------------
ALTER TABLE "SettlementEffect"
  ADD CONSTRAINT "SettlementEffect_kind_check" CHECK ("kind" IN
    ('LOAN', 'OVERTIME', 'PAYROLL_DRAFT', 'LEAVE_ACCRUAL', 'PAYMENT_REQUEST', 'EMPLOYMENT', 'LOGIN')),
  ADD CONSTRAINT "SettlementEffect_refId_check" CHECK (length(btrim("refId")) > 0);

ALTER TABLE "EmploymentMigrationReview"
  ADD CONSTRAINT "EmploymentMigrationReview_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "EmploymentMigrationReview_resolved_check" CHECK (("resolvedAt" IS NULL) = ("resolvedById" IS NULL)),
  ADD CONSTRAINT "EmploymentMigrationReview_resolution_check" CHECK ("resolution" IS NULL OR "resolvedAt" IS NOT NULL);

-- SettlementEffect is append-only (DOMAIN_MODEL §1.1): a reversal (R1) adds rows, never edits these.
CREATE FUNCTION "settlement_effect_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SettlementEffect is append-only (BL-LCY-015)' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "SettlementEffect_guard" BEFORE UPDATE OR DELETE ON "SettlementEffect"
  FOR EACH ROW EXECUTE FUNCTION "settlement_effect_guard"();
CREATE TRIGGER "SettlementEffect_no_truncate" BEFORE TRUNCATE ON "SettlementEffect"
  FOR EACH STATEMENT EXECUTE FUNCTION "settlement_effect_guard"();

-- A review item is never deleted and never rewritten; only its resolution is set, once.
CREATE FUNCTION "employment_migration_review_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'EmploymentMigrationReview rows are never deleted (resolve them instead)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId"
     OR NEW."stateChangeId" IS DISTINCT FROM OLD."stateChangeId" OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."details" IS DISTINCT FROM OLD."details" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'EmploymentMigrationReview %: only the resolution may change', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."resolvedAt" IS NOT NULL AND (NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
     OR NEW."resolvedById" IS DISTINCT FROM OLD."resolvedById" OR NEW."resolution" IS DISTINCT FROM OLD."resolution") THEN
    RAISE EXCEPTION 'EmploymentMigrationReview % is already resolved', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmploymentMigrationReview_guard" BEFORE UPDATE OR DELETE ON "EmploymentMigrationReview"
  FOR EACH ROW EXECUTE FUNCTION "employment_migration_review_guard"();
CREATE TRIGGER "EmploymentMigrationReview_no_truncate" BEFORE TRUNCATE ON "EmploymentMigrationReview"
  FOR EACH STATEMENT EXECUTE FUNCTION "employment_migration_review_guard"();

-- ---------------------------------------------------------------------------
-- Data move 1: Settlement.approvalEffects -> SettlementEffect.
-- The rules are those of the writer (src/lib/finance.ts settlementEffects): loans, overtime and
-- dropped drafts as listed (the log holds only changed ones); the leave accrual, employment and login
-- when their value changed (employment also when a state change was recorded); the payment request
-- whenever there is one. Employee-level effects reference the employee.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM "Settlement"
   WHERE "approvalEffects" IS NOT NULL
     AND ("approvalEffects"->>'version' IS DISTINCT FROM '1' OR jsonb_typeof("approvalEffects") <> 'object');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '9zd_lcy_tables: % settlement effect log(s) are not version 1; move them by hand first', v_bad;
  END IF;
END;
$$;

CREATE TEMP TABLE "lcy_effect_move" AS
SELECT s."id" AS "settlementId", s."employeeId", s."approvalEffects" AS "log",
       coalesce(("approvalEffects"->>'recordedAt')::timestamptz AT TIME ZONE 'UTC', s."updatedAt") AS "at"
  FROM "Settlement" s
 WHERE s."approvalEffects" IS NOT NULL;

INSERT INTO "SettlementEffect" ("id", "settlementId", "employeeId", "kind", "refId", "before", "after", "recordedAt")
SELECT gen_random_uuid()::text, m."settlementId", m."employeeId", x."kind", x."refId", x."before", x."after", m."at"
  FROM "lcy_effect_move" m
  CROSS JOIN LATERAL (
    SELECT 'LOAN' AS "kind", l->>'loanId' AS "refId", NULLIF(l->'before', 'null'::jsonb) AS "before", NULLIF(l->'after', 'null'::jsonb) AS "after"
      FROM jsonb_array_elements(coalesce(m."log"->'loans', '[]'::jsonb)) l
    UNION ALL
    SELECT 'OVERTIME', o->>'overtimeRequestId', NULLIF(o->'before', 'null'::jsonb), NULLIF(o->'after', 'null'::jsonb)
      FROM jsonb_array_elements(coalesce(m."log"->'overtime', '[]'::jsonb)) o
    UNION ALL
    SELECT 'PAYROLL_DRAFT', d->>'id', jsonb_build_object('year', d->'year', 'month', d->'month'), NULL
      FROM jsonb_array_elements(coalesce(m."log"->'droppedDrafts', '[]'::jsonb)) d
    UNION ALL
    SELECT 'LEAVE_ACCRUAL', m."employeeId",
           jsonb_build_object('leaveAccrualStartDate', m."log"->'leaveAccrualStartDate'->'before'),
           jsonb_build_object('leaveAccrualStartDate', m."log"->'leaveAccrualStartDate'->'after')
     WHERE m."log"->'leaveAccrualStartDate'->'before' IS DISTINCT FROM m."log"->'leaveAccrualStartDate'->'after'
    UNION ALL
    SELECT 'PAYMENT_REQUEST', m."log"->>'paymentRequestId', NULL, jsonb_build_object('paymentRequestId', m."log"->'paymentRequestId')
     WHERE coalesce(m."log"->>'paymentRequestId', '') <> ''
    UNION ALL
    SELECT 'EMPLOYMENT', m."employeeId", NULLIF(m."log"->'employment'->'before', 'null'::jsonb),
           coalesce(NULLIF(m."log"->'employment'->'after', 'null'::jsonb), '{}'::jsonb)
             || jsonb_build_object('stateChangeId', m."log"->'employment'->'stateChangeId', 'transition', m."log"->'employment'->'transition')
     WHERE m."log"->'employment'->'before' IS DISTINCT FROM m."log"->'employment'->'after'
        OR coalesce(m."log"->'employment'->>'stateChangeId', '') <> ''
    UNION ALL
    SELECT 'LOGIN', m."employeeId", NULLIF(m."log"->'login'->'before', 'null'::jsonb), NULLIF(m."log"->'login'->'after', 'null'::jsonb)
     WHERE m."log"->'login'->'before' IS DISTINCT FROM m."log"->'login'->'after'
  ) x
 WHERE coalesce(x."refId", '') <> ''
ON CONFLICT ("settlementId", "kind", "refId") DO NOTHING;

DO $$
DECLARE
  v_logs integer;
  v_rows integer;
  v_empty integer;
BEGIN
  SELECT count(*) INTO v_logs FROM "lcy_effect_move";
  SELECT count(*) INTO v_rows FROM "SettlementEffect";
  SELECT count(*) INTO v_empty FROM "lcy_effect_move" m WHERE NOT EXISTS (SELECT 1 FROM "SettlementEffect" e WHERE e."settlementId" = m."settlementId");
  RAISE NOTICE '9zd_lcy_tables: % settlement effect log(s) moved into % SettlementEffect row(s); % log(s) recorded no changed value', v_logs, v_rows, v_empty;
END;
$$;

DROP TABLE "lcy_effect_move";
DROP TRIGGER "Settlement_effects_guard" ON "Settlement";
DROP FUNCTION "settlement_effects_guard"();
ALTER TABLE "Settlement" DROP COLUMN "approvalEffects";

-- ---------------------------------------------------------------------------
-- Data move 2: EmploymentStateChange.legacy.review -> EmploymentMigrationReview.
-- ---------------------------------------------------------------------------
INSERT INTO "EmploymentMigrationReview" ("id", "employeeId", "stateChangeId", "code", "details", "createdAt")
SELECT gen_random_uuid()::text, c."employeeId", c."id", r."code", c."legacy" - 'review', c."recordedAt"
  FROM "EmploymentStateChange" c
  CROSS JOIN LATERAL jsonb_array_elements_text(c."legacy"->'review') AS r("code")
 WHERE c."transition" = 'LEGACY_OPENING'
   AND jsonb_typeof(c."legacy"->'review') = 'array'
ON CONFLICT ("employeeId", "code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- LCY-J1: THE opening of one employee's employment state (single definition; replaces the body of
-- 9y). Unchanged except where the review codes go: rows of EmploymentMigrationReview (details = the
-- values found) instead of legacy.review. Same signature and result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lifecycle_open_state"(p_employee_id text, p_actor text DEFAULT NULL)
RETURNS TABLE ("changeId" text, "outcome" text, "review" text[]) LANGUAGE plpgsql AS $$
DECLARE
  e record;
  p record;
  v_id text;
  v_state "EmploymentState";
  v_today date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_from date;
  v_term date;
  v_to date;
  v_review text[] := ARRAY[]::text[];
  v_found jsonb;
  v_at timestamp := (now() AT TIME ZONE 'UTC');
BEGIN
  IF p_employee_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_open_state: employee is required';
  END IF;
  -- One opening at a time per employee: the Employee row lock is taken first, as every lifecycle
  -- transition does (people.lockEmployees, ADR-0002 #2), so the two can never deadlock.
  SELECT em."id", em."joinDate", em."isTerminated", em."terminationDate", em."employmentStatus",
         em."exitReason", em."exitVoluntary", coalesce(em."legalCompanyId", em."actualCompanyId") AS "companyId"
    INTO e
    FROM "Employee" em WHERE em."id" = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_open_state: employee % not found', p_employee_id;
  END IF;

  SELECT c."id" INTO v_id FROM "EmploymentStateChange" c WHERE c."employeeId" = p_employee_id LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, 'ALREADY_OPENED'::text, NULL::text[];
    RETURN;
  END IF;

  v_from := e."joinDate"::date;
  v_term := e."terminationDate"::date;
  IF e."isTerminated" THEN
    v_state := 'TERMINATED';
    IF v_term IS NULL THEN
      v_review := v_review || 'TERMINATED_WITHOUT_DATE'::text;
    ELSIF v_term > v_today THEN
      v_review := v_review || 'NOTICE_CANDIDATE'::text;
    END IF;
    IF e."employmentStatus" IS DISTINCT FROM 'EXCLUDED' THEN
      v_review := v_review || 'STATUS_NOT_EXCLUDED'::text;
    END IF;
  ELSE
    v_state := 'ACTIVE';
    IF v_term IS NOT NULL THEN
      v_review := v_review || 'ACTIVE_WITH_TERMINATION_DATE'::text;
    END IF;
    IF e."employmentStatus" NOT IN ('ACTIVE', 'ON_LEAVE') THEN
      v_review := v_review || 'ACTIVE_STATUS_UNEXPECTED'::text;
    END IF;
    IF e."exitReason" IS NOT NULL THEN
      v_review := v_review || 'EXIT_REASON_WHILE_ACTIVE'::text;
    END IF;
  END IF;

  -- The employment period (9u opened one for every employee it could; this covers the ones hired
  -- since, through the same single writer). Nothing is invented for data that cannot make one.
  v_to := CASE WHEN v_state = 'TERMINATED' AND v_term IS NOT NULL THEN v_term + 1 END;
  IF v_state = 'TERMINATED' AND v_term IS NULL THEN
    NULL; -- no period: TERMINATED_WITHOUT_DATE already says why
  ELSIF v_to IS NOT NULL AND v_to <= v_from THEN
    v_review := v_review || 'TERMINATION_BEFORE_JOIN'::text;
  ELSE
    PERFORM 1 FROM "effective_open_legacy_period"('EMPLOYMENT', e."id", v_from, v_to, '{}'::jsonb, p_actor);
  END IF;
  SELECT ep."id", ep."lineageId" INTO p
    FROM "EmploymentPeriod" ep
   WHERE ep."employeeId" = e."id" AND ep."supersededAt" IS NULL
   ORDER BY ep."validFrom" DESC LIMIT 1;
  IF p."id" IS NULL THEN
    v_review := v_review || 'NO_EMPLOYMENT_PERIOD'::text;
  END IF;

  -- The values found, before anything is cleared (DEC-PO-051).
  v_found := jsonb_build_object(
    'isTerminated', e."isTerminated",
    'terminationDate', to_char(v_term, 'YYYY-MM-DD'),
    'employmentStatus', e."employmentStatus",
    'exitReason', e."exitReason",
    'exitVoluntary', e."exitVoluntary",
    'by', p_actor);

  v_id := gen_random_uuid()::text;
  INSERT INTO "EmploymentStateChange" (
    "id", "employeeId", "employmentLineageId", "periodId", "transition", "fromState", "toState",
    "effectiveDate", "terminationDate", "exitReason", "exitVoluntary", "reason", "sourceType", "sourceId",
    "companyId", "actorId", "approvedById", "singleOperator", "operationKey", "supersedesId", "legacy", "recordedAt")
  VALUES (
    v_id, e."id", p."lineageId", p."id", 'LEGACY_OPENING', NULL, v_state,
    CASE WHEN v_state = 'TERMINATED' AND v_term IS NOT NULL THEN v_term ELSE v_from END,
    CASE WHEN v_state = 'ACTIVE' THEN NULL ELSE v_term END,
    e."exitReason", e."exitVoluntary", NULL, 'LEGACY_OPENING', e."id",
    e."companyId", NULL, NULL, false, 'lifecycle:opening:' || e."id", NULL,
    v_found, v_at);

  -- The review items for HR (EmploymentMigrationReview, DEC-PO-128), one per code.
  INSERT INTO "EmploymentMigrationReview" ("id", "employeeId", "stateChangeId", "code", "details", "createdAt")
  SELECT gen_random_uuid()::text, e."id", v_id, x, v_found, v_at FROM unnest(v_review) AS x
  ON CONFLICT ("employeeId", "code") DO NOTHING;

  -- The projection (lifecycle's own columns). An active employee has no last working day: the
  -- value found is kept above (legacy and the ACTIVE_WITH_TERMINATION_DATE review item) for HR to decide.
  UPDATE "Employee"
     SET "employmentState" = v_state,
         "terminationDate" = CASE WHEN v_state = 'ACTIVE' THEN NULL ELSE "terminationDate" END
   WHERE "id" = e."id";

  RETURN QUERY SELECT v_id, 'OPENED'::text, v_review;
END;
$$;
