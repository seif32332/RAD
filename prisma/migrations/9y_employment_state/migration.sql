-- 9y_employment_state (master plan P1-LCY = LCY-M1 + LCY-J1 of lcy-to-be.md §17 as amended by
-- ARC-LCY-A1/A2; DEC-PO-119, ADR-0002 #3/#5/#12)
--
-- Expand only (Release B). Nothing the previous release reads changes meaning:
--   * enum "EmploymentState" and the NULLABLE projection Employee.employmentState (lifecycle writes
--     it; Release C / LCY-M2 makes it NOT NULL with the CHECKs, after INV-LCY-01 = 0 everywhere);
--   * EmploymentStateChange: the employment-state FACT (DEC-PO-119), append-only, a correction is a
--     new row with supersedesId (ADR-0002 #3); sole writer lifecycle.transitionEmploymentState;
--   * Settlement.approvalEffects: the BL-LCY-015 effect log of the owner approval, written once. The
--     design's separate SettlementEffect table would be a model without an owner in
--     DOMAIN_BOUNDARIES §5.2 (ARCH-002.owner); the log lives on the offboarding-owned Settlement row
--     instead (proposal: docs/architecture/decisions/ADR-0004-lcy-release-b-deviations.md).
--
-- LCY-J1 (the opening): lifecycle_open_state() below is the ONE definition of an employee's opening
-- state change (LEGACY_OPENING). It reuses the single writer of legacy periods of 9u
-- (effective_open_legacy_period, ARC-SYS-A3) for the EmploymentPeriod of an employee that has none
-- (hired after 9u), and records the found values and the review codes (DEC-PO-051) in "legacy"
-- before it clears anything. Mapping (lcy-to-be.md §17, NOTICE not released yet, ADR-0004):
--     isTerminated  terminationDate   state        review codes
--     false         null              ACTIVE       ACTIVE_STATUS_UNEXPECTED when employmentStatus not ACTIVE/ON_LEAVE
--     false         set               ACTIVE       ACTIVE_WITH_TERMINATION_DATE (the date is cleared; the value is kept in legacy)
--     true          <= today          TERMINATED   STATUS_NOT_EXCLUDED when employmentStatus <> EXCLUDED
--     true          > today           TERMINATED   NOTICE_CANDIDATE (becomes NOTICE with BL-LCY-012, HR decides)
--     true          null              TERMINATED   TERMINATED_WITHOUT_DATE (no period can be made)
-- The migration runs it once for every employee (named cross-company data migration); the job
-- employment-state-opening runs it again per company for employees created since (J1 "repeated
-- until no empty row remains"). No DomainEvent (ARC-LCY-A2: a data migration is not a business
-- event); one summary AuditRecord per run.
--
-- Rollback: the previous release ignores the new column, table and functions (expand only). Rows of
-- EmploymentStateChange cannot be deleted (trigger); rolling the data back means dropping the table,
-- the column and the type.

-- CreateEnum
CREATE TYPE "EmploymentState" AS ENUM ('ACTIVE', 'NOTICE', 'TERMINATED');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "employmentState" "EmploymentState";

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "approvalEffects" JSONB;

-- CreateTable
CREATE TABLE "EmploymentStateChange" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employmentLineageId" TEXT,
    "periodId" TEXT,
    "transition" TEXT NOT NULL,
    "fromState" "EmploymentState",
    "toState" "EmploymentState" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "terminationDate" DATE,
    "exitReason" TEXT,
    "exitVoluntary" BOOLEAN,
    "reason" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "companyId" TEXT,
    "actorId" TEXT,
    "approvedById" TEXT,
    "singleOperator" BOOLEAN NOT NULL DEFAULT false,
    "operationKey" TEXT NOT NULL,
    "supersedesId" TEXT,
    "legacy" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "EmploymentStateChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentStateChange_operationKey_key" ON "EmploymentStateChange"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentStateChange_seq_key" ON "EmploymentStateChange"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentStateChange_supersedesId_key" ON "EmploymentStateChange"("supersedesId");

-- CreateIndex
CREATE INDEX "EmploymentStateChange_employeeId_recordedAt_idx" ON "EmploymentStateChange"("employeeId", "recordedAt");

-- CreateIndex
CREATE INDEX "EmploymentStateChange_employmentLineageId_idx" ON "EmploymentStateChange"("employmentLineageId");

-- CreateIndex
CREATE INDEX "EmploymentStateChange_companyId_idx" ON "EmploymentStateChange"("companyId");

-- CreateIndex
CREATE INDEX "EmploymentStateChange_sourceType_sourceId_idx" ON "EmploymentStateChange"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Employee_employmentState_terminationDate_idx" ON "Employee"("employmentState", "terminationDate");

-- AddForeignKey
ALTER TABLE "EmploymentStateChange" ADD CONSTRAINT "EmploymentStateChange_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentStateChange" ADD CONSTRAINT "EmploymentStateChange_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "EmploymentStateChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- What Prisma cannot model (prisma migrate diff ignores it).
-- ---------------------------------------------------------------------------
ALTER TABLE "EmploymentStateChange"
  ADD CONSTRAINT "EmploymentStateChange_transition_check" CHECK ("transition" IN
    ('HIRE', 'NOTICE', 'CANCEL_EXIT', 'NOTICE_END', 'TERMINATE', 'TERMINATE_IN_NOTICE', 'REHIRE', 'AMEND', 'VOID', 'LEGACY_OPENING')),
  ADD CONSTRAINT "EmploymentStateChange_sourceType_check" CHECK ("sourceType" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "EmploymentStateChange_sourceId_check" CHECK (length(btrim("sourceId")) > 0),
  ADD CONSTRAINT "EmploymentStateChange_operationKey_check" CHECK (length(btrim("operationKey")) > 0),
  ADD CONSTRAINT "EmploymentStateChange_supersedesId_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
  -- An active employee has no last working day; a notice always has one (BR-LCY-001).
  ADD CONSTRAINT "EmploymentStateChange_active_date_check" CHECK ("toState" <> 'ACTIVE' OR "terminationDate" IS NULL),
  ADD CONSTRAINT "EmploymentStateChange_notice_date_check" CHECK ("toState" <> 'NOTICE' OR "terminationDate" IS NOT NULL),
  -- Only the opening has no "from" state (and only it may carry legacy values).
  ADD CONSTRAINT "EmploymentStateChange_from_check" CHECK (("fromState" IS NULL) = ("transition" IN ('LEGACY_OPENING', 'HIRE'))),
  ADD CONSTRAINT "EmploymentStateChange_legacy_check" CHECK ("legacy" IS NULL OR "transition" = 'LEGACY_OPENING');

-- One opening per employee, ever.
CREATE UNIQUE INDEX "EmploymentStateChange_one_opening" ON "EmploymentStateChange"("employeeId") WHERE "transition" IN ('LEGACY_OPENING', 'HIRE');

-- Append-only (DOMAIN_MODEL §1.1, ADR-0002 #3/#13): a row is never updated nor deleted.
CREATE FUNCTION "employment_state_change_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EmploymentStateChange is append-only (a correction is a new row with supersedesId)' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "EmploymentStateChange_guard" BEFORE UPDATE OR DELETE ON "EmploymentStateChange"
  FOR EACH ROW EXECUTE FUNCTION "employment_state_change_guard"();
CREATE TRIGGER "EmploymentStateChange_no_truncate" BEFORE TRUNCATE ON "EmploymentStateChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "employment_state_change_guard"();

-- The effect log of a settlement approval is written once (BL-LCY-015): never changed or cleared.
CREATE FUNCTION "settlement_effects_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."approvalEffects" IS NOT NULL AND NEW."approvalEffects" IS DISTINCT FROM OLD."approvalEffects" THEN
    RAISE EXCEPTION 'Settlement % approvalEffects is written once (BL-LCY-015)', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Settlement_effects_guard" BEFORE UPDATE OF "approvalEffects" ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION "settlement_effects_guard"();

-- ---------------------------------------------------------------------------
-- LCY-J1: THE opening of one employee's employment state (single definition).
--   OPENED          a LEGACY_OPENING row was written and Employee.employmentState projected
--   ALREADY_OPENED  the employee already has a state change (idempotent)
-- ---------------------------------------------------------------------------
CREATE FUNCTION "lifecycle_open_state"(p_employee_id text, p_actor text DEFAULT NULL)
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
    jsonb_build_object(
      'isTerminated', e."isTerminated",
      'terminationDate', to_char(v_term, 'YYYY-MM-DD'),
      'employmentStatus', e."employmentStatus",
      'exitReason', e."exitReason",
      'exitVoluntary', e."exitVoluntary",
      'review', to_jsonb(v_review),
      'by', p_actor),
    (now() AT TIME ZONE 'UTC'));

  -- The projection (lifecycle's own columns). An active employee has no last working day: the
  -- value found is kept in "legacy" above (ACTIVE_WITH_TERMINATION_DATE) for HR to decide.
  UPDATE "Employee"
     SET "employmentState" = v_state,
         "terminationDate" = CASE WHEN v_state = 'ACTIVE' THEN NULL ELSE "terminationDate" END
   WHERE "id" = e."id";

  RETURN QUERY SELECT v_id, 'OPENED'::text, v_review;
END;
$$;

-- LCY-J1 over a set of companies (legal, else actual company) or, with NULL, every employee (the
-- named cross-company data migration). Idempotent: employees that already have a state change are
-- not selected. Returns one row per (outcome, review code) with the employee ids of review rows.
CREATE FUNCTION "lifecycle_backfill_state_openings"(p_company_ids text[], p_actor text DEFAULT NULL)
RETURNS TABLE ("outcome" text, "review" text, "employees" integer, "employeeIds" text[])
LANGUAGE plpgsql AS $$
DECLARE
  e record;
  r record;
  v_summary jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS "lifecycle_backfill_result" ("outcome" text, "review" text, "employeeId" text) ON COMMIT DROP;
  DELETE FROM "lifecycle_backfill_result";

  FOR e IN
    SELECT em."id"
      FROM "Employee" em
     WHERE (p_company_ids IS NULL OR coalesce(em."legalCompanyId", em."actualCompanyId") = ANY (p_company_ids))
       AND NOT EXISTS (SELECT 1 FROM "EmploymentStateChange" c WHERE c."employeeId" = em."id")
     ORDER BY em."id"
  LOOP
    SELECT * INTO r FROM "lifecycle_open_state"(e."id", p_actor);
    IF r."review" IS NULL OR cardinality(r."review") = 0 THEN
      INSERT INTO "lifecycle_backfill_result" VALUES (r."outcome", NULL, e."id");
    ELSE
      INSERT INTO "lifecycle_backfill_result" SELECT r."outcome", x, e."id" FROM unnest(r."review") AS x;
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_agg(jsonb_build_object('outcome', s."outcome", 'review', s."review", 'employees', s."n") ORDER BY s."outcome", s."review"), '[]'::jsonb)
    INTO v_summary
    FROM (SELECT x."outcome", x."review", count(DISTINCT x."employeeId")::int AS "n" FROM "lifecycle_backfill_result" x GROUP BY 1, 2) s;
  INSERT INTO "AuditRecord" ("id", "actorType", "actorId", "action", "entityType", "after", "reason")
  VALUES (gen_random_uuid()::text, 'SYSTEM', coalesce(p_actor, 'lifecycle_backfill_state_openings'),
          'employment.state.openingsBackfilled', 'EmploymentStateChange',
          jsonb_build_object('companyIds', to_jsonb(p_company_ids), 'summary', v_summary),
          'P1-LCY LCY-J1 opening state (ARC-LCY-A2)');

  RETURN QUERY
    SELECT x."outcome", x."review", count(DISTINCT x."employeeId")::int,
           CASE WHEN x."review" IS NOT NULL THEN array_agg(DISTINCT x."employeeId") END
      FROM "lifecycle_backfill_result" x
     GROUP BY 1, 2
     ORDER BY 1, 2 NULLS FIRST;
END;
$$;

-- The one-time opening of every existing employee (cross-company data migration, LCY-J1).
SELECT * FROM "lifecycle_backfill_state_openings"(NULL, 'migration:9y_employment_state');
