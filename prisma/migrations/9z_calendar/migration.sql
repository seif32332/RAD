-- P1-CAL: the calendar module (DOMAIN_BOUNDARIES §5.2: calendar owns WorkSchedule (= WorkPattern),
-- HolidayCalendar, RamadanPeriod). Evidence EV-3006, EV-3007, EV-5046, H11 (AUDIT/12, AUDIT/10).
--
--   1. WorkSchedule becomes the WorkPattern: companyId (scope key, = the branch's company, kept equal
--      by trigger), workWeekdays (structured working days parsed from the workDays label),
--      archivedAt (a referenced pattern is archived, never deleted).
--   2. The employee's pattern is a FK instead of a name: Employee.workPatternId (projection of org)
--      and AssignmentPeriod.workPatternId (the fact, DOMAIN_MODEL §1.3). Backfilled with the rule the
--      code applied at read time (pickEmployeeSchedule): the branch's pattern with the typed name,
--      else the branch's only pattern.
--   3. HolidayCalendar and RamadanPeriod, per company, edited by HR (DEC-PO-116). The fixed-date
--      official holidays are the SQL function calendar_official_fixed_holidays(year); the two Eids
--      follow the Hijri calendar and are announced each year, so they are never generated.
--   4. The existing companies get the fixed-date official holidays of 2026 and 2027.
--
-- The Ramadan hours cap (Labor Law Art. 98) is the rule RAMADAN_WORK_HOURS_PER_DAY_MAX of P1-RULE
-- (migration 9za_rules); nothing is seeded for it here.

-- ---------------------------------------------------------------------------
-- 1. WorkSchedule = WorkPattern
-- ---------------------------------------------------------------------------

-- Working weekdays named in a label, 0 = Sunday … 6 = Saturday, sorted; '{}' when nothing is
-- recognised. A range ("الأحد-الخميس", "من السبت إلى الأربعاء") is expanded, wrapping over the week.
-- Mirrors parseWeekdays() of src/modules/calendar/weekdays.ts; parity tested in calendar.it.test.ts.
CREATE FUNCTION "calendar_parse_weekdays"(p_label text) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t text;
  pats text[][] := ARRAY[
    ARRAY['احد', 'sun', ''],
    ARRAY['اثنين', 'اتنين', 'mon'],
    ARRAY['ثلاثا', 'tue', ''],
    ARRAY['اربعا', 'wed', ''],
    ARRAY['خميس', 'thu', ''],
    ARRAY['جمع', 'fri', ''],
    ARRAY['سبت', 'sat', '']
  ];
  d int;
  k int;
  pos int;
  best int;
  found_day int[] := '{}';
  found_at int[] := '{}';
  a int;
  b int;
  between_text text;
  out int[] := '{}';
BEGIN
  IF p_label IS NULL OR btrim(p_label) = '' THEN
    RETURN '{}';
  END IF;
  t := ' ' || lower(p_label) || ' ';
  t := translate(t, 'أإآىة', 'ااايه');
  t := regexp_replace(t, '[ـً-ْ]', '', 'g');
  FOR d IN 0..6 LOOP
    best := 0;
    FOR k IN 1..3 LOOP
      IF pats[d + 1][k] <> '' THEN
        pos := strpos(t, pats[d + 1][k]);
        IF pos > 0 AND (best = 0 OR pos < best) THEN
          best := pos;
        END IF;
      END IF;
    END LOOP;
    IF best > 0 THEN
      found_day := found_day || d;
      found_at := found_at || best;
    END IF;
  END LOOP;
  IF cardinality(found_day) = 0 THEN
    RETURN '{}';
  END IF;
  IF cardinality(found_day) = 2 THEN
    -- the two days in order of appearance
    IF found_at[1] <= found_at[2] THEN
      a := found_day[1]; b := found_day[2];
      between_text := substr(t, found_at[1], found_at[2] - found_at[1]);
    ELSE
      a := found_day[2]; b := found_day[1];
      between_text := substr(t, found_at[2], found_at[1] - found_at[2]);
    END IF;
    IF strpos(between_text, '-') > 0 OR strpos(between_text, '–') > 0 OR strpos(between_text, '—') > 0
       OR strpos(between_text, 'الي') > 0 OR strpos(between_text, 'حتي') > 0 OR strpos(between_text, ' to ') > 0 THEN
      d := a;
      LOOP
        out := out || d;
        EXIT WHEN d = b;
        d := (d + 1) % 7;
      END LOOP;
      RETURN ARRAY(SELECT x FROM unnest(out) AS x ORDER BY x);
    END IF;
  END IF;
  RETURN ARRAY(SELECT x FROM unnest(found_day) AS x ORDER BY x);
END;
$$;

ALTER TABLE "WorkSchedule" ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "workWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

UPDATE "WorkSchedule" ws SET "companyId" = b."companyId" FROM "Branch" b WHERE b."id" = ws."branchId";
UPDATE "WorkSchedule" SET "workWeekdays" = "calendar_parse_weekdays"("workDays");

ALTER TABLE "WorkSchedule" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "WorkSchedule"
  ADD CONSTRAINT "WorkSchedule_workWeekdays_check" CHECK ("workWeekdays" IS NULL OR "workWeekdays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]),
  ADD CONSTRAINT "WorkSchedule_name_check" CHECK (length(btrim("name")) > 0);

-- The pattern's company is its branch's company (INV-ORG-01 style, enforced at the DB layer): a
-- pattern is written with its branch's company, and a branch never moves under its patterns.
CREATE FUNCTION "work_pattern_company_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_company text;
BEGIN
  IF TG_TABLE_NAME = 'WorkSchedule' THEN
    SELECT "companyId" INTO v_company FROM "Branch" WHERE "id" = NEW."branchId";
    IF v_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'WorkSchedule %: companyId % is not the company of branch % (%)', NEW."id", NEW."companyId", NEW."branchId", v_company
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."companyId" IS DISTINCT FROM OLD."companyId"
        AND EXISTS (SELECT 1 FROM "WorkSchedule" WHERE "branchId" = NEW."id") THEN
    RAISE EXCEPTION 'Branch % has work patterns: move them before changing its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkSchedule_company_guard" BEFORE INSERT OR UPDATE OF "companyId", "branchId" ON "WorkSchedule"
  FOR EACH ROW EXECUTE FUNCTION "work_pattern_company_guard"();
CREATE TRIGGER "Branch_work_pattern_company_guard" BEFORE UPDATE OF "companyId" ON "Branch"
  FOR EACH ROW EXECUTE FUNCTION "work_pattern_company_guard"();

CREATE INDEX "WorkSchedule_companyId_idx" ON "WorkSchedule"("companyId");
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. The employee's pattern as a FK
-- ---------------------------------------------------------------------------

ALTER TABLE "Employee" ADD COLUMN "workPatternId" TEXT;
ALTER TABLE "AssignmentPeriod" ADD COLUMN "workPatternId" TEXT;
CREATE INDEX "Employee_workPatternId_idx" ON "Employee"("workPatternId");
CREATE INDEX "AssignmentPeriod_workPatternId_idx" ON "AssignmentPeriod"("workPatternId");
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_workPatternId_fkey" FOREIGN KEY ("workPatternId") REFERENCES "WorkSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssignmentPeriod" ADD CONSTRAINT "AssignmentPeriod_workPatternId_fkey" FOREIGN KEY ("workPatternId") REFERENCES "WorkSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The single writer of LEGACY_OPENING periods (9u, ARC-SYS-A3) accepts the new ASSIGNMENT column:
-- the definition of 9u unchanged except for 'workPatternId' in the ASSIGNMENT column list.
CREATE OR REPLACE FUNCTION "effective_open_legacy_period"(
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
    WHEN 'ASSIGNMENT' THEN ARRAY['legalCompanyId', 'actualCompanyId', 'branchId', 'departmentId', 'managerId', 'workPatternId']
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

-- Employee.workPatternId: the pattern of the employee's branch named Employee.workSchedule (the oldest
-- when two share the name), else the branch's only pattern: exactly pickEmployeeSchedule() over the
-- branch's schedules ordered by createdAt. Employees it cannot place stay NULL (reported below).
UPDATE "Employee" e SET "workPatternId" = x."patternId"
  FROM (
    SELECT DISTINCT ON (e2."id") e2."id" AS "employeeId", ws."id" AS "patternId"
      FROM "Employee" e2
      JOIN "WorkSchedule" ws ON ws."branchId" = e2."branchId"
     WHERE e2."branchId" IS NOT NULL
       AND (
         btrim(ws."name") = btrim(coalesce(e2."workSchedule", ''))
         OR (
           NOT EXISTS (SELECT 1 FROM "WorkSchedule" w2 WHERE w2."branchId" = e2."branchId" AND btrim(coalesce(e2."workSchedule", '')) <> '' AND btrim(w2."name") = btrim(e2."workSchedule"))
           AND (SELECT count(*) FROM "WorkSchedule" w3 WHERE w3."branchId" = e2."branchId") = 1
         )
       )
     ORDER BY e2."id", (btrim(ws."name") = btrim(coalesce(e2."workSchedule", ''))) DESC, ws."createdAt" ASC, ws."id" ASC
  ) x
 WHERE e."id" = x."employeeId";

-- AssignmentPeriod.workPatternId: the period tables are append-only (9u guard), so the running
-- period of an employee whose pattern is known and belongs to the period's branch is SUPERSEDED by
-- a successor that differs only by workPatternId (same lineage, same dates, reason CORRECTION,
-- sourceType CALENDAR_BACKFILL). "As recorded" before this migration the period had no pattern,
-- which is the truth of what the system knew. Idempotent: only periods without a pattern are touched.
DO $$
DECLARE
  r record;
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT ap.*, e."workPatternId" AS "newPatternId"
      FROM "AssignmentPeriod" ap
      JOIN "Employee" e ON e."id" = ap."employeeId"
      JOIN "WorkSchedule" ws ON ws."id" = e."workPatternId"
     WHERE ap."supersededAt" IS NULL
       AND ap."workPatternId" IS NULL
       AND ap."branchId" = ws."branchId"
       AND (ap."validTo" IS NULL OR ap."validTo" > (now() AT TIME ZONE 'Asia/Riyadh')::date)
     ORDER BY ap."id"
  LOOP
    UPDATE "AssignmentPeriod" SET "supersededAt" = v_now, "supersedeReason" = 'CORRECTION' WHERE "id" = r."id";
    INSERT INTO "AssignmentPeriod" (
      "id", "employeeId", "validFrom", "validTo", "lineageId", "supersedesId", "supersededAt", "supersedeReason",
      "sourceType", "sourceId", "recordedAt", "createdById",
      "legalCompanyId", "actualCompanyId", "branchId", "departmentId", "managerId", "workPatternId")
    VALUES (
      gen_random_uuid()::text, r."employeeId", r."validFrom", r."validTo", r."lineageId", r."id", NULL, NULL,
      'CALENDAR_BACKFILL', '9z_calendar', v_now, NULL,
      r."legalCompanyId", r."actualCompanyId", r."branchId", r."departmentId", r."managerId", r."newPatternId");
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO "AuditRecord" ("id", "actorType", "actorId", "action", "entityType", "after", "reason")
  VALUES (gen_random_uuid()::text, 'SYSTEM', 'migration:9z_calendar', 'calendar.workPattern.backfilled', 'WorkSchedule',
          jsonb_build_object(
            'patterns', (SELECT count(*) FROM "WorkSchedule"),
            'patternsWithoutWeekdays', (SELECT count(*) FROM "WorkSchedule" WHERE cardinality("workWeekdays") = 0),
            'employeesWithPattern', (SELECT count(*) FROM "Employee" WHERE "workPatternId" IS NOT NULL),
            'employeesNamedButUnplaced', (SELECT coalesce(jsonb_agg("id" ORDER BY "id"), '[]'::jsonb) FROM "Employee"
                                           WHERE "workPatternId" IS NULL AND btrim(coalesce("workSchedule", '')) <> ''),
            'assignmentPeriodsCorrected', v_count),
          'P1-CAL: work pattern by FK instead of by name (EV-3007)');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. HolidayCalendar and RamadanPeriod
-- ---------------------------------------------------------------------------

CREATE TABLE "HolidayCalendar" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMPANY',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "source" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolidayCalendar_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RamadanPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hijriYear" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "dailyHours" DOUBLE PRECISION NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RamadanPeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HolidayCalendar_companyId_startDate_idx" ON "HolidayCalendar"("companyId", "startDate");
CREATE UNIQUE INDEX "HolidayCalendar_companyId_name_startDate_key" ON "HolidayCalendar"("companyId", "name", "startDate");
CREATE INDEX "RamadanPeriod_companyId_startDate_idx" ON "RamadanPeriod"("companyId", "startDate");
CREATE UNIQUE INDEX "RamadanPeriod_companyId_hijriYear_key" ON "RamadanPeriod"("companyId", "hijriYear");

ALTER TABLE "HolidayCalendar" ADD CONSTRAINT "HolidayCalendar_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HolidayCalendar" ADD CONSTRAINT "HolidayCalendar_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RamadanPeriod" ADD CONSTRAINT "RamadanPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RamadanPeriod" ADD CONSTRAINT "RamadanPeriod_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HolidayCalendar"
  ADD CONSTRAINT "HolidayCalendar_kind_check" CHECK ("kind" IN ('OFFICIAL', 'COMPANY')),
  ADD CONSTRAINT "HolidayCalendar_name_check" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "HolidayCalendar_range_check" CHECK ("startDate" <= "endDate" AND "endDate" - "startDate" <= 30);

ALTER TABLE "RamadanPeriod"
  ADD CONSTRAINT "RamadanPeriod_hijriYear_check" CHECK ("hijriYear" BETWEEN 1400 AND 1600),
  ADD CONSTRAINT "RamadanPeriod_range_check" CHECK ("endDate" - "startDate" BETWEEN 28 AND 29),
  ADD CONSTRAINT "RamadanPeriod_dailyHours_check" CHECK ("dailyHours" > 0 AND "dailyHours" <= 24);

-- The fixed-date official holidays of a Gregorian year (the Hijri ones are entered by HR):
--   يوم التأسيس  22 February, from 2022 (Royal Order of 27 January 2022)
--   اليوم الوطني  23 September
-- When one falls on a weekend the substitute day is announced each year; HR adds it as a holiday.
CREATE FUNCTION "calendar_official_fixed_holidays"(p_year integer)
RETURNS TABLE ("name" text, "startDate" date, "endDate" date) LANGUAGE sql IMMUTABLE AS $$
  SELECT v."name", make_date(p_year, v."m", v."d"), make_date(p_year, v."m", v."d") + (v."days" - 1)
    FROM (VALUES ('يوم التأسيس', 2, 22, 1, 2022), ('اليوم الوطني', 9, 23, 1, 2005)) AS v("name", "m", "d", "days", "since")
   WHERE p_year >= v."since"
$$;

-- ---------------------------------------------------------------------------
-- 4. The existing companies: the fixed-date official holidays of 2026 and 2027 (HR edits them).
-- ---------------------------------------------------------------------------
INSERT INTO "HolidayCalendar" ("id", "companyId", "name", "kind", "startDate", "endDate", "source")
SELECT gen_random_uuid()::text, c."id", h."name", 'OFFICIAL', h."startDate", h."endDate", 'OFFICIAL_FIXED_DATE'
  FROM "Company" c
 CROSS JOIN LATERAL (SELECT * FROM "calendar_official_fixed_holidays"(2026) UNION ALL SELECT * FROM "calendar_official_fixed_holidays"(2027)) h
ON CONFLICT ("companyId", "name", "startDate") DO NOTHING;
