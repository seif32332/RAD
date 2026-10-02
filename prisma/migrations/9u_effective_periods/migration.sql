-- 9u_effective_periods (master plan P1-FND-EFF; DOMAIN_MODEL §1.3, ARC-SYS-A3, ADR-0001 #9,
-- ADR-0002 #3/#4/#8/#12/#13)
--
-- Expand-only: three new FACT tables in the uniform effective-period shape, no change to any
-- existing table.
--
--   EmploymentPeriod    owner lifecycle     (EmploymentStateChange, the state fact of DEC-PO-119, is
--                                            added by P1-LCY M1, not here: ARC-LCY-A2)
--   CompensationPeriod  owner compensation
--   AssignmentPeriod    owner org           (minimal set: legal/actual company, branch, department,
--                                            manager; P3-ORG adds the rest)
--
-- Physical writer: src/modules/platform/effective (ARCH-012), called by the owning module.
-- What Prisma cannot model lives in the second half of this file (btree_gist, the EXCLUDE
-- constraints of INV-EFF-01, CHECKs, the partial unique index of the legacy opening, the
-- append-only triggers, and the legacy-opening functions); `prisma migrate diff` ignores it.
--
-- Legacy opening (ARC-SYS-A3: one function writes every LEGACY_OPENING period): the single
-- definition is the SQL function effective_open_legacy_period() below. This migration's backfill
-- and the TypeScript openLegacyPeriod() (src/modules/platform/sql/effective.ts) both call it; the
-- migration of every later period table (ContractPeriod BL-LCY-017, BankIdentityPeriod BL-PAY-004)
-- extends its kind list (CREATE OR REPLACE) and calls it too. Legacy openings emit no DomainEvent
-- (as J1 of ARC-LCY-A2: consumers must not react to a data migration); the backfill writes one
-- summary AuditRecord.
--
-- Rollback: the tables are new and nothing existing reads them; a previous release ignores them.
-- Rows cannot be deleted (append-only trigger); rolling back the data means dropping the tables.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateTable
CREATE TABLE "EmploymentPeriod" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "lineageId" TEXT NOT NULL,
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersedeReason" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "EmploymentPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationPeriod" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "lineageId" TEXT NOT NULL,
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersedeReason" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "basicSalary" DECIMAL(14,2) NOT NULL,
    "allowances" JSONB NOT NULL DEFAULT '[]',
    "gosiBaseOverride" DECIMAL(14,2),

    CONSTRAINT "CompensationPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentPeriod" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "lineageId" TEXT NOT NULL,
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersedeReason" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "legalCompanyId" TEXT NOT NULL,
    "actualCompanyId" TEXT,
    "branchId" TEXT,
    "departmentId" TEXT,
    "managerId" TEXT,

    CONSTRAINT "AssignmentPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentPeriod_supersedesId_key" ON "EmploymentPeriod"("supersedesId");

-- CreateIndex
CREATE INDEX "EmploymentPeriod_employeeId_validFrom_idx" ON "EmploymentPeriod"("employeeId", "validFrom");

-- CreateIndex
CREATE INDEX "EmploymentPeriod_lineageId_idx" ON "EmploymentPeriod"("lineageId");

-- CreateIndex
CREATE INDEX "EmploymentPeriod_sourceType_sourceId_idx" ON "EmploymentPeriod"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationPeriod_supersedesId_key" ON "CompensationPeriod"("supersedesId");

-- CreateIndex
CREATE INDEX "CompensationPeriod_employeeId_validFrom_idx" ON "CompensationPeriod"("employeeId", "validFrom");

-- CreateIndex
CREATE INDEX "CompensationPeriod_lineageId_idx" ON "CompensationPeriod"("lineageId");

-- CreateIndex
CREATE INDEX "CompensationPeriod_sourceType_sourceId_idx" ON "CompensationPeriod"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentPeriod_supersedesId_key" ON "AssignmentPeriod"("supersedesId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_employeeId_validFrom_idx" ON "AssignmentPeriod"("employeeId", "validFrom");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_lineageId_idx" ON "AssignmentPeriod"("lineageId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_sourceType_sourceId_idx" ON "AssignmentPeriod"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_legalCompanyId_idx" ON "AssignmentPeriod"("legalCompanyId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_actualCompanyId_idx" ON "AssignmentPeriod"("actualCompanyId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_branchId_idx" ON "AssignmentPeriod"("branchId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_departmentId_idx" ON "AssignmentPeriod"("departmentId");

-- CreateIndex
CREATE INDEX "AssignmentPeriod_managerId_idx" ON "AssignmentPeriod"("managerId");

-- AddForeignKey
ALTER TABLE "EmploymentPeriod" ADD CONSTRAINT "EmploymentPeriod_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentPeriod" ADD CONSTRAINT "EmploymentPeriod_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "EmploymentPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationPeriod" ADD CONSTRAINT "CompensationPeriod_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationPeriod" ADD CONSTRAINT "CompensationPeriod_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "CompensationPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_legalCompanyId_fkey" FOREIGN KEY ("legalCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_actualCompanyId_fkey" FOREIGN KEY ("actualCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "AssignmentPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Shape rules (DOMAIN_MODEL §1.3). Prisma models none of this.
-- ---------------------------------------------------------------------------
ALTER TABLE "EmploymentPeriod"
  ADD CONSTRAINT "EmploymentPeriod_valid_range_check" CHECK ("validTo" IS NULL OR "validFrom" < "validTo"),
  ADD CONSTRAINT "EmploymentPeriod_supersede_check" CHECK (("supersededAt" IS NULL) = ("supersedeReason" IS NULL)),
  ADD CONSTRAINT "EmploymentPeriod_supersedeReason_check" CHECK ("supersedeReason" IS NULL OR "supersedeReason" IN ('CORRECTION', 'CLOSE', 'VOID')),
  ADD CONSTRAINT "EmploymentPeriod_sourceType_check" CHECK ("sourceType" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "EmploymentPeriod_sourceId_check" CHECK (length(btrim("sourceId")) > 0),
  ADD CONSTRAINT "EmploymentPeriod_lineageId_check" CHECK (length(btrim("lineageId")) > 0),
  ADD CONSTRAINT "EmploymentPeriod_supersedesId_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id");

ALTER TABLE "CompensationPeriod"
  ADD CONSTRAINT "CompensationPeriod_valid_range_check" CHECK ("validTo" IS NULL OR "validFrom" < "validTo"),
  ADD CONSTRAINT "CompensationPeriod_supersede_check" CHECK (("supersededAt" IS NULL) = ("supersedeReason" IS NULL)),
  ADD CONSTRAINT "CompensationPeriod_supersedeReason_check" CHECK ("supersedeReason" IS NULL OR "supersedeReason" IN ('CORRECTION', 'CLOSE', 'VOID')),
  ADD CONSTRAINT "CompensationPeriod_sourceType_check" CHECK ("sourceType" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "CompensationPeriod_sourceId_check" CHECK (length(btrim("sourceId")) > 0),
  ADD CONSTRAINT "CompensationPeriod_lineageId_check" CHECK (length(btrim("lineageId")) > 0),
  ADD CONSTRAINT "CompensationPeriod_supersedesId_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
  ADD CONSTRAINT "CompensationPeriod_basicSalary_check" CHECK ("basicSalary" >= 0),
  ADD CONSTRAINT "CompensationPeriod_gosiBaseOverride_check" CHECK ("gosiBaseOverride" IS NULL OR "gosiBaseOverride" >= 0),
  ADD CONSTRAINT "CompensationPeriod_allowances_check" CHECK (jsonb_typeof("allowances") = 'array');

ALTER TABLE "AssignmentPeriod"
  ADD CONSTRAINT "AssignmentPeriod_valid_range_check" CHECK ("validTo" IS NULL OR "validFrom" < "validTo"),
  ADD CONSTRAINT "AssignmentPeriod_supersede_check" CHECK (("supersededAt" IS NULL) = ("supersedeReason" IS NULL)),
  ADD CONSTRAINT "AssignmentPeriod_supersedeReason_check" CHECK ("supersedeReason" IS NULL OR "supersedeReason" IN ('CORRECTION', 'CLOSE', 'VOID')),
  ADD CONSTRAINT "AssignmentPeriod_sourceType_check" CHECK ("sourceType" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "AssignmentPeriod_sourceId_check" CHECK (length(btrim("sourceId")) > 0),
  ADD CONSTRAINT "AssignmentPeriod_lineageId_check" CHECK (length(btrim("lineageId")) > 0),
  ADD CONSTRAINT "AssignmentPeriod_supersedesId_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
  ADD CONSTRAINT "AssignmentPeriod_manager_check" CHECK ("managerId" IS NULL OR "managerId" <> "employeeId");

-- INV-EFF-01 (BLOCKING, DB layer): no two non-superseded periods of one employee overlap.
-- daterange(validFrom, validTo, '[)') is [validFrom, validTo); a NULL validTo is unbounded.
ALTER TABLE "EmploymentPeriod" ADD CONSTRAINT "EmploymentPeriod_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("validFrom", "validTo", '[)') WITH &&) WHERE ("supersededAt" IS NULL);
ALTER TABLE "CompensationPeriod" ADD CONSTRAINT "CompensationPeriod_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("validFrom", "validTo", '[)') WITH &&) WHERE ("supersededAt" IS NULL);
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("validFrom", "validTo", '[)') WITH &&) WHERE ("supersededAt" IS NULL);

-- At most one legacy opening per employee and kind, ever (superseded rows included): re-running
-- the backfill can never open a second one.
CREATE UNIQUE INDEX "EmploymentPeriod_one_legacy_opening" ON "EmploymentPeriod"("employeeId") WHERE "sourceType" = 'LEGACY_OPENING';
CREATE UNIQUE INDEX "CompensationPeriod_one_legacy_opening" ON "CompensationPeriod"("employeeId") WHERE "sourceType" = 'LEGACY_OPENING';
CREATE UNIQUE INDEX "AssignmentPeriod_one_legacy_opening" ON "AssignmentPeriod"("employeeId") WHERE "sourceType" = 'LEGACY_OPENING';

-- ---------------------------------------------------------------------------
-- Append-only (DOMAIN_MODEL §1.1, ADR-0002 #3/#13). A row is never deleted and never rewritten.
-- The only updates accepted:
--   * supersede: supersededAt + supersedeReason set once, from NULL, nothing else changes;
--   * EmploymentPeriod only, the named exception of ADR-0001 #9: validTo of a non-superseded row
--     changes in place (lifecycle end / reopen), nothing else changes.
-- A successor (supersedesId) continues the lineage and employee of a row already superseded.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "effective_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p_employee text;
  p_lineage text;
  p_superseded timestamp(3);
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '% rows are never deleted (void = supersede without successor)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."supersededAt" IS NOT NULL THEN
      RAISE EXCEPTION '% % is inserted already superseded', TG_TABLE_NAME, NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersedesId" IS NOT NULL THEN
      EXECUTE format('SELECT "employeeId", "lineageId", "supersededAt" FROM %I WHERE "id" = $1', TG_TABLE_NAME)
        INTO p_employee, p_lineage, p_superseded USING NEW."supersedesId";
      IF p_employee IS DISTINCT FROM NEW."employeeId" OR p_lineage IS DISTINCT FROM NEW."lineageId" OR p_superseded IS NULL THEN
        RAISE EXCEPTION '% %: a successor continues the lineage and employee of a superseded row', TG_TABLE_NAME, NEW."id" USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NOT NULL
     AND (to_jsonb(NEW) - 'supersededAt' - 'supersedeReason') = (to_jsonb(OLD) - 'supersededAt' - 'supersedeReason') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'EmploymentPeriod' AND OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NULL
     AND (to_jsonb(NEW) - 'validTo') = (to_jsonb(OLD) - 'validTo') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% % is append-only (only supersede%)', TG_TABLE_NAME, OLD."id",
    CASE WHEN TG_TABLE_NAME = 'EmploymentPeriod' THEN ' and the in-place end of ADR-0001 #9' ELSE '' END
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "EmploymentPeriod_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmploymentPeriod"
  FOR EACH ROW EXECUTE FUNCTION "effective_period_guard"();
CREATE TRIGGER "EmploymentPeriod_no_truncate" BEFORE TRUNCATE ON "EmploymentPeriod"
  FOR EACH STATEMENT EXECUTE FUNCTION "effective_period_guard"();
CREATE TRIGGER "CompensationPeriod_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CompensationPeriod"
  FOR EACH ROW EXECUTE FUNCTION "effective_period_guard"();
CREATE TRIGGER "CompensationPeriod_no_truncate" BEFORE TRUNCATE ON "CompensationPeriod"
  FOR EACH STATEMENT EXECUTE FUNCTION "effective_period_guard"();
CREATE TRIGGER "AssignmentPeriod_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AssignmentPeriod"
  FOR EACH ROW EXECUTE FUNCTION "effective_period_guard"();
CREATE TRIGGER "AssignmentPeriod_no_truncate" BEFORE TRUNCATE ON "AssignmentPeriod"
  FOR EACH STATEMENT EXECUTE FUNCTION "effective_period_guard"();

-- ---------------------------------------------------------------------------
-- Legacy opening (ARC-SYS-A3): THE writer of every LEGACY_OPENING period.
-- ---------------------------------------------------------------------------

-- Payslip line of a recurring allowance. Mirrors allowanceLine() of src/lib/payroll-core.ts
-- exactly (its type, else its name); the parity is tested against that function in
-- src/modules/platform/__tests__/effective.it.test.ts. Used to classify the legacy Allowance rows
-- once, at the opening.
CREATE FUNCTION "effective_allowance_line"(p_type text, p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN upper(coalesce(p_type, '')) IN ('HOUSING', 'TRANSPORT') THEN upper(p_type)
    WHEN coalesce(p_type, '') <> '' THEN 'OTHER'
    WHEN coalesce(p_name, '') ~* '(سكن|housing)' THEN 'HOUSING'
    WHEN coalesce(p_name, '') ~* '(نقل|مواصلات|transport)' THEN 'TRANSPORT'
    ELSE 'OTHER'
  END
$$;

-- Opens the LEGACY_OPENING period of one employee and kind, once:
--   OPENED               a new row (new lineage, sourceId = employee id)
--   ALREADY_OPENED       the employee already has its legacy opening of this kind (idempotent)
--   SKIPPED_HAS_PERIODS  the kind already has periods for this employee: no opening under them
-- p_attrs carries the kind's own columns only.
CREATE FUNCTION "effective_open_legacy_period"(
  p_kind text, p_employee_id text, p_valid_from date, p_valid_to date, p_attrs jsonb, p_created_by text DEFAULT NULL
) RETURNS TABLE ("periodId" text, "outcome" text) LANGUAGE plpgsql AS $$
DECLARE
  tbl text;
  allowed text[];
  bad text;
  v_id text;
  v_row jsonb;
BEGIN
  tbl := CASE p_kind
    WHEN 'EMPLOYMENT' THEN 'EmploymentPeriod'
    WHEN 'COMPENSATION' THEN 'CompensationPeriod'
    WHEN 'ASSIGNMENT' THEN 'AssignmentPeriod'
  END;
  allowed := CASE p_kind
    WHEN 'EMPLOYMENT' THEN ARRAY[]::text[]
    WHEN 'COMPENSATION' THEN ARRAY['basicSalary', 'allowances', 'gosiBaseOverride']
    WHEN 'ASSIGNMENT' THEN ARRAY['legalCompanyId', 'actualCompanyId', 'branchId', 'departmentId', 'managerId']
  END;
  IF tbl IS NULL THEN
    RAISE EXCEPTION 'effective_open_legacy_period: unknown kind %', p_kind;
  END IF;
  IF p_employee_id IS NULL OR p_valid_from IS NULL THEN
    RAISE EXCEPTION 'effective_open_legacy_period: employee and validFrom are required';
  END IF;
  SELECT k INTO bad FROM jsonb_object_keys(coalesce(p_attrs, '{}'::jsonb)) AS k WHERE k <> ALL (allowed) LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'effective_open_legacy_period: % is not a column of a % period', bad, p_kind;
  END IF;

  -- One opening at a time per (kind, employee), also across concurrent callers.
  PERFORM pg_advisory_xact_lock(hashtextextended('effective-legacy/' || tbl || '/' || p_employee_id, 0));

  EXECUTE format('SELECT "id" FROM %I WHERE "employeeId" = $1 AND "sourceType" = ''LEGACY_OPENING''', tbl)
    INTO v_id USING p_employee_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'ALREADY_OPENED'::text;
    RETURN;
  END IF;
  EXECUTE format('SELECT "id" FROM %I WHERE "employeeId" = $1 LIMIT 1', tbl) INTO v_id USING p_employee_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, 'SKIPPED_HAS_PERIODS'::text;
    RETURN;
  END IF;

  v_id := gen_random_uuid()::text;
  v_row := coalesce(p_attrs, '{}'::jsonb) || jsonb_build_object(
    'id', v_id,
    'employeeId', p_employee_id,
    'validFrom', p_valid_from,
    'validTo', p_valid_to,
    'lineageId', gen_random_uuid()::text,
    'supersedesId', NULL,
    'supersededAt', NULL,
    'supersedeReason', NULL,
    'sourceType', 'LEGACY_OPENING',
    'sourceId', p_employee_id,
    'recordedAt', (now() AT TIME ZONE 'UTC'),
    'createdById', p_created_by);
  IF p_kind = 'COMPENSATION' AND NOT (v_row ? 'allowances') THEN
    v_row := v_row || '{"allowances": []}'::jsonb;
  END IF;
  EXECUTE format('INSERT INTO %1$I SELECT * FROM jsonb_populate_record(NULL::%1$I, $1)', tbl) USING v_row;
  RETURN QUERY SELECT v_id, 'OPENED'::text;
END;
$$;

-- The P1-FND-EFF backfill: one opening per employee and kind from today's Employee columns.
--   EMPLOYMENT    [joinDate, terminationDate + 1) when terminated (terminationDate = last working
--                 day), else [joinDate, open)
--   COMPENSATION  same window; basicSalary + the recurring (isMonthly) Allowance rows
--   ASSIGNMENT    same window; legal/actual company, branch, department, direct manager
-- Nothing is invented: an employee whose data cannot make a valid period is SKIPPED with a reason
-- (reported with the employee ids) for HR to complete, and the gap is INV-EFF-02's to report.
-- p_company_ids NULL = every employee (the named cross-company data migration); otherwise the
-- employees whose legal (else actual) company is in the list. Idempotent: a second run reports
-- ALREADY_OPENED and writes nothing but its summary audit row.
CREATE FUNCTION "effective_backfill_legacy_openings"(p_company_ids text[], p_actor text DEFAULT NULL)
RETURNS TABLE ("kind" text, "outcome" text, "reason" text, "employees" integer, "employeeIds" text[])
LANGUAGE plpgsql AS $$
DECLARE
  e record;
  r record;
  v_from date;
  v_to date;
  v_skip text;
  v_allowances jsonb;
  v_summary jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS "effective_backfill_result" (
    "kind" text, "outcome" text, "reason" text, "employeeId" text
  ) ON COMMIT DROP;
  DELETE FROM "effective_backfill_result";

  FOR e IN
    SELECT em."id", em."joinDate", em."isTerminated", em."terminationDate", em."basicSalary",
           em."legalCompanyId", em."actualCompanyId", em."branchId", em."departmentId", em."directManagerId"
      FROM "Employee" em
     WHERE p_company_ids IS NULL OR coalesce(em."legalCompanyId", em."actualCompanyId") = ANY (p_company_ids)
     ORDER BY em."id"
  LOOP
    v_from := e."joinDate"::date;
    v_to := CASE WHEN e."isTerminated" AND e."terminationDate" IS NOT NULL THEN e."terminationDate"::date + 1 END;
    v_skip := CASE
      WHEN e."isTerminated" AND e."terminationDate" IS NULL THEN 'TERMINATED_WITHOUT_DATE'
      WHEN v_to IS NOT NULL AND v_to <= v_from THEN 'TERMINATION_BEFORE_JOIN'
    END;

    -- EMPLOYMENT
    IF v_skip IS NOT NULL THEN
      INSERT INTO "effective_backfill_result" VALUES ('EMPLOYMENT', 'SKIPPED', v_skip, e."id");
    ELSE
      SELECT * INTO r FROM "effective_open_legacy_period"('EMPLOYMENT', e."id", v_from, v_to, '{}'::jsonb, p_actor);
      INSERT INTO "effective_backfill_result" VALUES ('EMPLOYMENT', r."outcome", NULL, e."id");
    END IF;

    -- COMPENSATION
    IF v_skip IS NOT NULL THEN
      INSERT INTO "effective_backfill_result" VALUES ('COMPENSATION', 'SKIPPED', v_skip, e."id");
    ELSIF e."basicSalary" IS NULL OR e."basicSalary" <= 0 THEN
      INSERT INTO "effective_backfill_result" VALUES ('COMPENSATION', 'SKIPPED', 'NO_BASIC_SALARY', e."id");
    ELSE
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'allowanceId', a."id",
               'name', a."name",
               'allowanceType', a."allowanceType",
               'line', "effective_allowance_line"(a."allowanceType", a."name"),
               'amount', round(a."amount"::numeric, 2),
               'countsTowardGosi', a."countsTowardGosi") ORDER BY a."createdAt", a."id"), '[]'::jsonb)
        INTO v_allowances
        FROM "Allowance" a
       WHERE a."employeeId" = e."id" AND a."isMonthly";
      SELECT * INTO r FROM "effective_open_legacy_period"('COMPENSATION', e."id", v_from, v_to,
        jsonb_build_object('basicSalary', round(e."basicSalary"::numeric, 2), 'allowances', v_allowances), p_actor);
      INSERT INTO "effective_backfill_result" VALUES ('COMPENSATION', r."outcome", NULL, e."id");
    END IF;

    -- ASSIGNMENT
    IF v_skip IS NOT NULL THEN
      INSERT INTO "effective_backfill_result" VALUES ('ASSIGNMENT', 'SKIPPED', v_skip, e."id");
    ELSIF e."legalCompanyId" IS NULL THEN
      INSERT INTO "effective_backfill_result" VALUES ('ASSIGNMENT', 'SKIPPED', 'NO_LEGAL_COMPANY', e."id");
    ELSE
      IF e."directManagerId" = e."id" THEN
        INSERT INTO "effective_backfill_result" VALUES ('ASSIGNMENT', 'NOTE', 'SELF_MANAGER_NOT_COPIED', e."id");
      END IF;
      SELECT * INTO r FROM "effective_open_legacy_period"('ASSIGNMENT', e."id", v_from, v_to,
        jsonb_build_object(
          'legalCompanyId', e."legalCompanyId",
          'actualCompanyId', e."actualCompanyId",
          'branchId', e."branchId",
          'departmentId', e."departmentId",
          'managerId', NULLIF(e."directManagerId", e."id")), p_actor);
      INSERT INTO "effective_backfill_result" VALUES ('ASSIGNMENT', r."outcome", NULL, e."id");
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', s."kind", 'outcome', s."outcome", 'reason', s."reason", 'employees', s."n")
                            ORDER BY s."kind", s."outcome", s."reason"), '[]'::jsonb)
    INTO v_summary
    FROM (SELECT x."kind", x."outcome", x."reason", count(*)::int AS "n"
            FROM "effective_backfill_result" x GROUP BY 1, 2, 3) s;
  INSERT INTO "AuditRecord" ("id", "actorType", "actorId", "action", "entityType", "after", "reason")
  VALUES (gen_random_uuid()::text, 'SYSTEM', coalesce(p_actor, 'effective_backfill_legacy_openings'),
          'effective.legacyOpenings.backfilled', 'EffectivePeriod',
          jsonb_build_object('companyIds', to_jsonb(p_company_ids), 'summary', v_summary),
          'P1-FND-EFF legacy opening (ARC-SYS-A3)');

  RETURN QUERY
    SELECT x."kind", x."outcome", x."reason", count(*)::int,
           CASE WHEN x."outcome" IN ('SKIPPED', 'NOTE', 'SKIPPED_HAS_PERIODS') THEN array_agg(x."employeeId" ORDER BY x."employeeId") END
      FROM "effective_backfill_result" x
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3;
END;
$$;

-- The one-time backfill of every existing employee (cross-company data migration).
SELECT * FROM "effective_backfill_legacy_openings"(NULL, 'migration:9u_effective_periods');
