-- 9zg_financial_change (master plan P1-PAY-B: BL-PAY-004; pay-to-be.md BR-PAY-009 / §17 as amended by
-- arc-conformance.md ARC-PAY-A2 / A3 / A4; DOMAIN_MODEL §1.1 / §1.3; SOURCE_OF_TRUTH rows "الراتب الأساسي
-- والبدلات" and "طلب تغيير مالي أو آيبان" and "الهوية البنكية")
--
-- Order (BL-PAY-012): after 9zf_payroll_gateway; letter 9zg (never 10+).
--
-- 1. EmployeeFinancialChange (REQUEST, owner compensation): a pay or bank-identity change with an
--    effective date. PENDING -> PENDING_EFFECT -> APPLIED, or REJECTED / CANCELLED (ARC-PAY-A2). One
--    PENDING request per (employee, field); the decider is never the requester (CHECK, except a recorded
--    SINGLE_OPERATOR self-act, BR-PAY-020). No number is ever read from it (DOMAIN_MODEL §1.1): applying
--    it opens a CompensationPeriod or a BankIdentityPeriod (the facts).
--    LEGACY_UNVERIFIED (req-to-be §17 C11, moved here by ARC-REQ-A3): the IBAN changes still waiting in a
--    pending portal data-update request (AttendanceCorrection with the data-update prefix and an IBAN
--    line) become requests in this state, created only here. They are not "open" for the one-pending
--    rule, never expire (DEC-PO-109), and turn PENDING when the employee confirms them himself from the
--    portal after seeing the full IBAN; whoever filed or touched the original row
--    (legacyFiledByUserIds, from AuditLog) never decides them (G1b, RT-REQ-201 / 301, DEC-PO-115).
-- 2. BankIdentityPeriod (FACT, owner compensation; ADR-0001 #8): the IBAN (encrypted), its fingerprint
--    (sha256 of the normalized IBAN, BR-PAY-006) and last 4, the bank and the payment method, in the
--    uniform effective-period shape of 9u (EXCLUDE of INV-EFF-01, append-only guard, one legacy opening).
--    Never back-dated: a new identity starts on the day it is applied.
-- 3. Employee.payrollReady (projection, ARC-PAY-A4): written by compensation's projector only. Every
--    existing employee starts TRUE (DEC-PO-017, EXPECTED category LEGACY_READY of INV-SAL-01, ADR-0002
--    #9); a new employee starts FALSE until his pay (and his bank identity when paid by bank) is applied.
--    Employee.basicSalary gets DEFAULT 0: a new employee is created WITHOUT pay (money.gateway refuses a
--    pay column on an employee CREATE from this release on) and gets it through a financial change.
-- 4. The single writer of LEGACY_OPENING periods, effective_open_legacy_period (9u, extended by 9z), is
--    redefined with the BANK_IDENTITY kind (CREATE OR REPLACE: 9u / 9z are not edited), and the bank
--    identity of every existing employee is opened from today's Employee columns:
--      validFrom = joinDate, open-ended (a bank identity outlives the employment: the settlement pays to it);
--      BANK_TRANSFER / WPS with an IBAN  -> the IBAN as stored (the legacy plaintext, or an "enc:" value
--                                           some tenants hold), its fingerprint and last 4 (not computable
--                                           for an "enc:" value: left NULL, reported as LEGACY_ENCRYPTED);
--      CASH                              -> no IBAN;
--      BANK_TRANSFER / WPS without IBAN  -> SKIPPED (NO_IBAN): nothing is invented; the employee keeps
--                                           payrollReady = TRUE (LEGACY_READY, RT-SYS-618) and the
--                                           INV-SAL-01 check lists him.
--    Like 9u, the legacy opening emits no DomainEvent and writes one summary AuditRecord.
--    The employees created after 9u ran (they got no CompensationPeriod) get their COMPENSATION legacy
--    opening here, by the rules of 9u; pay columns edited directly after 9u are reported (INV-SAL-01).
--
-- Rollback: expand only. The previous release ignores the new tables and column; the DEFAULT on
-- basicSalary is harmless to it. Period rows cannot be deleted (append-only trigger): dropping the
-- tables undoes the data.

-- ---------------------------------------------------------------------------
-- 1. Employee
-- ---------------------------------------------------------------------------
ALTER TABLE "Employee" ADD COLUMN "payrollReady" BOOLEAN NOT NULL DEFAULT true;
-- DEC-PO-017: every existing employee is ready (LEGACY_READY); new rows start false.
ALTER TABLE "Employee" ALTER COLUMN "payrollReady" SET DEFAULT false;
ALTER TABLE "Employee" ALTER COLUMN "basicSalary" SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. BankIdentityPeriod
-- ---------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "BankIdentityPeriod" (
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
    "ibanEncrypted" TEXT,
    "ibanFingerprint" TEXT,
    "ibanLast4" TEXT,
    "bankName" TEXT,
    "paymentMethod" "PaymentMethod" NOT NULL,

    CONSTRAINT "BankIdentityPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankIdentityPeriod_supersedesId_key" ON "BankIdentityPeriod"("supersedesId");

-- CreateIndex
CREATE INDEX "BankIdentityPeriod_employeeId_validFrom_idx" ON "BankIdentityPeriod"("employeeId", "validFrom");

-- CreateIndex
CREATE INDEX "BankIdentityPeriod_lineageId_idx" ON "BankIdentityPeriod"("lineageId");

-- CreateIndex
CREATE INDEX "BankIdentityPeriod_sourceType_sourceId_idx" ON "BankIdentityPeriod"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "BankIdentityPeriod_ibanFingerprint_idx" ON "BankIdentityPeriod"("ibanFingerprint");

-- AddForeignKey
ALTER TABLE "BankIdentityPeriod" ADD CONSTRAINT "BankIdentityPeriod_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankIdentityPeriod" ADD CONSTRAINT "BankIdentityPeriod_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "BankIdentityPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. EmployeeFinancialChange
-- ---------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "EmployeeFinancialChange" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "companyId" TEXT,
    "field" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "effectiveDate" DATE NOT NULL,
    "compensation" JSONB,
    "ibanEncrypted" TEXT,
    "ibanFingerprint" TEXT,
    "ibanLast4" TEXT,
    "bankName" TEXT,
    "paymentMethod" "PaymentMethod",
    "beforeJson" JSONB,
    "note" TEXT,
    "batchKey" TEXT,
    "requestedById" TEXT,
    "legacyFiledByUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "decisionSelfAct" BOOLEAN NOT NULL DEFAULT false,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "compensationPeriodId" TEXT,
    "bankIdentityPeriodId" TEXT,
    "operationKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeFinancialChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeFinancialChange_operationKey_key" ON "EmployeeFinancialChange"("operationKey");

-- CreateIndex
CREATE INDEX "EmployeeFinancialChange_employeeId_field_status_idx" ON "EmployeeFinancialChange"("employeeId", "field", "status");

-- CreateIndex
CREATE INDEX "EmployeeFinancialChange_companyId_status_idx" ON "EmployeeFinancialChange"("companyId", "status");

-- CreateIndex
CREATE INDEX "EmployeeFinancialChange_status_effectiveDate_idx" ON "EmployeeFinancialChange"("status", "effectiveDate");

-- CreateIndex
CREATE INDEX "EmployeeFinancialChange_batchKey_idx" ON "EmployeeFinancialChange"("batchKey");

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_compensationPeriodId_fkey" FOREIGN KEY ("compensationPeriodId") REFERENCES "CompensationPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFinancialChange" ADD CONSTRAINT "EmployeeFinancialChange_bankIdentityPeriodId_fkey" FOREIGN KEY ("bankIdentityPeriodId") REFERENCES "BankIdentityPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Shape rules Prisma does not model (ignored by `prisma migrate diff`).
-- ---------------------------------------------------------------------------
ALTER TABLE "BankIdentityPeriod"
  ADD CONSTRAINT "BankIdentityPeriod_valid_range_check" CHECK ("validTo" IS NULL OR "validFrom" < "validTo"),
  ADD CONSTRAINT "BankIdentityPeriod_supersede_check" CHECK (("supersededAt" IS NULL) = ("supersedeReason" IS NULL)),
  ADD CONSTRAINT "BankIdentityPeriod_supersedeReason_check" CHECK ("supersedeReason" IS NULL OR "supersedeReason" IN ('CORRECTION', 'CLOSE', 'VOID')),
  ADD CONSTRAINT "BankIdentityPeriod_sourceType_check" CHECK ("sourceType" ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT "BankIdentityPeriod_sourceId_check" CHECK (length(btrim("sourceId")) > 0),
  ADD CONSTRAINT "BankIdentityPeriod_lineageId_check" CHECK (length(btrim("lineageId")) > 0),
  ADD CONSTRAINT "BankIdentityPeriod_supersedesId_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
  -- A bank payment carries an IBAN; a cash payment carries none. Only a legacy opening may hold an
  -- IBAN whose fingerprint could not be computed (an "enc:" value of an older tenant).
  ADD CONSTRAINT "BankIdentityPeriod_iban_check" CHECK (
    ("paymentMethod" = 'CASH' AND "ibanEncrypted" IS NULL AND "ibanFingerprint" IS NULL AND "ibanLast4" IS NULL)
    OR ("paymentMethod" <> 'CASH' AND "ibanEncrypted" IS NOT NULL
        AND ("ibanFingerprint" IS NOT NULL OR "sourceType" = 'LEGACY_OPENING'))),
  ADD CONSTRAINT "BankIdentityPeriod_fingerprint_check" CHECK ("ibanFingerprint" IS NULL OR "ibanFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "BankIdentityPeriod_last4_check" CHECK ("ibanLast4" IS NULL OR "ibanLast4" ~ '^[0-9A-Z]{4}$');

ALTER TABLE "BankIdentityPeriod" ADD CONSTRAINT "BankIdentityPeriod_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("validFrom", "validTo", '[)') WITH &&) WHERE ("supersededAt" IS NULL);

CREATE UNIQUE INDEX "BankIdentityPeriod_one_legacy_opening" ON "BankIdentityPeriod"("employeeId") WHERE "sourceType" = 'LEGACY_OPENING';

-- Append-only, exactly like the period tables of 9u (the guard function is generic over TG_TABLE_NAME).
CREATE TRIGGER "BankIdentityPeriod_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BankIdentityPeriod"
  FOR EACH ROW EXECUTE FUNCTION "effective_period_guard"();
CREATE TRIGGER "BankIdentityPeriod_no_truncate" BEFORE TRUNCATE ON "BankIdentityPeriod"
  FOR EACH STATEMENT EXECUTE FUNCTION "effective_period_guard"();

ALTER TABLE "EmployeeFinancialChange"
  ADD CONSTRAINT "EmployeeFinancialChange_field_check" CHECK ("field" IN ('COMPENSATION', 'BANK_IDENTITY')),
  ADD CONSTRAINT "EmployeeFinancialChange_source_check" CHECK ("source" IN ('FORM', 'IMPORT', 'ONBOARDING', 'EDIT', 'PORTAL')),
  ADD CONSTRAINT "EmployeeFinancialChange_status_check" CHECK ("status" IN ('LEGACY_UNVERIFIED', 'PENDING', 'PENDING_EFFECT', 'APPLIED', 'REJECTED', 'CANCELLED')),
  -- Every request has its requester, except a migrated legacy one until the employee confirms it.
  ADD CONSTRAINT "EmployeeFinancialChange_requester_check" CHECK ("requestedById" IS NOT NULL OR "status" IN ('LEGACY_UNVERIFIED', 'CANCELLED')),
  ADD CONSTRAINT "EmployeeFinancialChange_legacy_check" CHECK ("status" <> 'LEGACY_UNVERIFIED' OR ("field" = 'BANK_IDENTITY' AND "source" = 'PORTAL')),
  -- The payload of each field (the other field's columns stay empty).
  ADD CONSTRAINT "EmployeeFinancialChange_payload_check" CHECK (
    ("field" = 'COMPENSATION' AND "compensation" IS NOT NULL AND jsonb_typeof("compensation") = 'object'
       AND "paymentMethod" IS NULL AND "ibanEncrypted" IS NULL AND "ibanFingerprint" IS NULL)
    OR ("field" = 'BANK_IDENTITY' AND "compensation" IS NULL AND "paymentMethod" IS NOT NULL
       AND (("paymentMethod" = 'CASH' AND "ibanEncrypted" IS NULL AND "ibanFingerprint" IS NULL)
            OR ("paymentMethod" <> 'CASH' AND "ibanEncrypted" IS NOT NULL AND "ibanFingerprint" ~ '^[0-9a-f]{64}$')))),
  -- An IBAN change is filed by the employee himself, from the self-service portal (BR-PAY-009); the
  -- rule on the requester is the transition's (the column cannot see the session).
  ADD CONSTRAINT "EmployeeFinancialChange_portal_check" CHECK ("source" <> 'PORTAL' OR "field" = 'BANK_IDENTITY'),
  -- Decision columns follow the status.
  ADD CONSTRAINT "EmployeeFinancialChange_decision_check" CHECK (
    ("status" IN ('LEGACY_UNVERIFIED', 'PENDING') AND "decidedById" IS NULL AND "decidedAt" IS NULL)
    OR ("status" IN ('PENDING_EFFECT', 'APPLIED', 'REJECTED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)),
  ADD CONSTRAINT "EmployeeFinancialChange_applied_check" CHECK (
    ("status" = 'APPLIED') = ("appliedAt" IS NOT NULL)
    AND ("status" <> 'APPLIED' OR ("compensationPeriodId" IS NOT NULL) <> ("bankIdentityPeriodId" IS NOT NULL))),
  -- DEC-PO-003 / 007: the second person is not the requester. The one exception is the SINGLE_OPERATOR
  -- tenant, where the act goes through and is recorded (decisionSelfAct, BR-PAY-020).
  ADD CONSTRAINT "EmployeeFinancialChange_second_person_check" CHECK ("decidedById" IS NULL OR "requestedById" IS NULL OR "decidedById" <> "requestedById" OR "decisionSelfAct");

-- One open request per (employee, field) waiting for its decision (EX-PAY-005), and one decided change
-- per (employee, field, effective date) waiting for its date.
CREATE UNIQUE INDEX "EmployeeFinancialChange_one_pending" ON "EmployeeFinancialChange"("employeeId", "field") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "EmployeeFinancialChange_one_pending_effect" ON "EmployeeFinancialChange"("employeeId", "field", "effectiveDate") WHERE "status" = 'PENDING_EFFECT';

-- ---------------------------------------------------------------------------
-- 4. Legacy opening: the single writer (ARC-SYS-A3) learns the BANK_IDENTITY kind.
-- ---------------------------------------------------------------------------

-- The IBAN normalization of src/lib/iban.ts normalizeIban (bidi marks, white space and dashes removed,
-- Arabic-Indic digits converted, upper-cased). Parity is tested against the TypeScript function
-- (src/modules/compensation/__tests__/financial-change.it.test.ts).
CREATE FUNCTION "compensation_normalize_iban"(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(translate(regexp_replace(coalesce(p, ''), '[\u200E\u200F\u202A-\u202E[:space:]-]', '', 'g'),
                         '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'))
$$;

-- The fingerprint of BR-PAY-006: sha256 (hex) of the normalized IBAN. Same as ibanFingerprint() of
-- src/modules/compensation/bank.ts.
CREATE FUNCTION "compensation_iban_fingerprint"(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN "compensation_normalize_iban"(p) = '' THEN NULL
              ELSE encode(sha256(convert_to("compensation_normalize_iban"(p), 'UTF8')), 'hex') END
$$;

-- The definition of 9z unchanged except for the BANK_IDENTITY kind (table and column list).
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
    WHEN 'BANK_IDENTITY' THEN 'BankIdentityPeriod'
  END;
  allowed := CASE p_kind
    WHEN 'EMPLOYMENT' THEN ARRAY[]::text[]
    WHEN 'COMPENSATION' THEN ARRAY['basicSalary', 'allowances', 'gosiBaseOverride']
    WHEN 'ASSIGNMENT' THEN ARRAY['legalCompanyId', 'actualCompanyId', 'branchId', 'departmentId', 'managerId', 'workPatternId']
    WHEN 'BANK_IDENTITY' THEN ARRAY['ibanEncrypted', 'ibanFingerprint', 'ibanLast4', 'bankName', 'paymentMethod']
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

-- The bank-identity attributes of today's Employee columns (NULL = nothing to open: SKIPPED NO_IBAN).
CREATE FUNCTION "compensation_legacy_bank_attrs"(p_iban text, p_bank text, p_method text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_method = 'CASH' THEN jsonb_build_object('paymentMethod', 'CASH', 'bankName', NULLIF(btrim(coalesce(p_bank, '')), ''))
    WHEN "compensation_normalize_iban"(p_iban) = '' THEN NULL
    WHEN p_iban LIKE 'enc:%' THEN jsonb_build_object(
      'paymentMethod', p_method, 'bankName', NULLIF(btrim(coalesce(p_bank, '')), ''), 'ibanEncrypted', p_iban)
    ELSE jsonb_build_object(
      'paymentMethod', p_method,
      'bankName', NULLIF(btrim(coalesce(p_bank, '')), ''),
      'ibanEncrypted', "compensation_normalize_iban"(p_iban),
      'ibanFingerprint', "compensation_iban_fingerprint"(p_iban),
      'ibanLast4', right("compensation_normalize_iban"(p_iban), 4))
  END
$$;

-- The BANK_IDENTITY backfill (idempotent: a re-run reports ALREADY_OPENED). p_company_ids NULL = every
-- employee (the named cross-company data migration), as effective_backfill_legacy_openings of 9u.
CREATE FUNCTION "compensation_backfill_bank_identities"(p_company_ids text[], p_actor text DEFAULT NULL)
RETURNS TABLE ("outcome" text, "reason" text, "employees" integer, "employeeIds" text[])
LANGUAGE plpgsql AS $$
DECLARE
  e record;
  r record;
  v_attrs jsonb;
  v_summary jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS "compensation_bank_backfill_result" ("outcome" text, "reason" text, "employeeId" text) ON COMMIT DROP;
  DELETE FROM "compensation_bank_backfill_result";
  FOR e IN
    SELECT em."id", em."joinDate", em."ibanNumber", em."bankName", em."salaryPaymentMethod"::text AS "method"
      FROM "Employee" em
     WHERE p_company_ids IS NULL OR coalesce(em."legalCompanyId", em."actualCompanyId") = ANY (p_company_ids)
     ORDER BY em."id"
  LOOP
    v_attrs := "compensation_legacy_bank_attrs"(e."ibanNumber", e."bankName", e."method");
    IF v_attrs IS NULL THEN
      INSERT INTO "compensation_bank_backfill_result" VALUES ('SKIPPED', 'NO_IBAN', e."id");
      CONTINUE;
    END IF;
    SELECT * INTO r FROM "effective_open_legacy_period"('BANK_IDENTITY', e."id", e."joinDate"::date, NULL, v_attrs, p_actor);
    INSERT INTO "compensation_bank_backfill_result" VALUES (r."outcome", CASE WHEN v_attrs ? 'ibanEncrypted' AND NOT v_attrs ? 'ibanFingerprint' THEN 'LEGACY_ENCRYPTED' END, e."id");
  END LOOP;

  SELECT coalesce(jsonb_agg(jsonb_build_object('outcome', s."outcome", 'reason', s."reason", 'employees', s."n") ORDER BY s."outcome", s."reason"), '[]'::jsonb)
    INTO v_summary
    FROM (SELECT x."outcome", x."reason", count(*)::int AS "n" FROM "compensation_bank_backfill_result" x GROUP BY 1, 2) s;
  INSERT INTO "AuditRecord" ("id", "actorType", "actorId", "action", "entityType", "after", "reason")
  VALUES (gen_random_uuid()::text, 'SYSTEM', coalesce(p_actor, 'compensation_backfill_bank_identities'),
          'bankIdentity.legacyOpenings.backfilled', 'BankIdentityPeriod',
          jsonb_build_object('companyIds', to_jsonb(p_company_ids), 'summary', v_summary),
          'P1-PAY-B legacy opening of the bank identity (ARC-PAY-A3, ARC-SYS-A3)');

  RETURN QUERY
    SELECT x."outcome", x."reason", count(*)::int,
           CASE WHEN x."outcome" <> 'OPENED' OR x."reason" IS NOT NULL THEN array_agg(x."employeeId" ORDER BY x."employeeId") END
      FROM "compensation_bank_backfill_result" x
     GROUP BY 1, 2
     ORDER BY 1, 2;
END;
$$;

-- COMPENSATION openings of the employees that have none: those created after 9u ran (9u opened every
-- employee that existed then; until this release a new employee got no period) and rows written by a
-- seed script outside the application. Same window and values as the backfill of 9u
-- (effective_backfill_legacy_openings), through the same single writer; an employee that already has a
-- compensation period is not touched, and a new hire of this release (basicSalary 0 until his financial
-- change is applied) is skipped. Idempotent; the apply-financial-changes job runs it per company too.
CREATE FUNCTION "compensation_backfill_legacy_compensation"(p_company_ids text[], p_actor text DEFAULT NULL)
RETURNS TABLE ("outcome" text, "reason" text, "employees" integer, "employeeIds" text[])
LANGUAGE plpgsql AS $$
DECLARE
  e record;
  r record;
  v_from date;
  v_to date;
  v_allowances jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS "compensation_comp_backfill_result" ("outcome" text, "reason" text, "employeeId" text) ON COMMIT DROP;
  DELETE FROM "compensation_comp_backfill_result";
  FOR e IN
    SELECT em."id", em."joinDate", em."isTerminated", em."terminationDate", em."basicSalary"
      FROM "Employee" em
     WHERE NOT EXISTS (SELECT 1 FROM "CompensationPeriod" cp WHERE cp."employeeId" = em."id")
       AND (p_company_ids IS NULL OR coalesce(em."legalCompanyId", em."actualCompanyId") = ANY (p_company_ids))
     ORDER BY em."id"
  LOOP
    v_from := e."joinDate"::date;
    v_to := CASE WHEN e."isTerminated" AND e."terminationDate" IS NOT NULL THEN e."terminationDate"::date + 1 END;
    IF e."isTerminated" AND e."terminationDate" IS NULL THEN
      INSERT INTO "compensation_comp_backfill_result" VALUES ('SKIPPED', 'TERMINATED_WITHOUT_DATE', e."id");
      CONTINUE;
    END IF;
    IF v_to IS NOT NULL AND v_to <= v_from THEN
      INSERT INTO "compensation_comp_backfill_result" VALUES ('SKIPPED', 'TERMINATION_BEFORE_JOIN', e."id");
      CONTINUE;
    END IF;
    IF e."basicSalary" IS NULL OR e."basicSalary" <= 0 THEN
      INSERT INTO "compensation_comp_backfill_result" VALUES ('SKIPPED', 'NO_BASIC_SALARY', e."id");
      CONTINUE;
    END IF;
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
    INSERT INTO "compensation_comp_backfill_result" VALUES (r."outcome", NULL, e."id");
  END LOOP;
  RETURN QUERY
    SELECT x."outcome", x."reason", count(*)::int,
           CASE WHEN x."outcome" <> 'OPENED' THEN array_agg(x."employeeId" ORDER BY x."employeeId") END
      FROM "compensation_comp_backfill_result" x
     GROUP BY 1, 2
     ORDER BY 1, 2;
END;
$$;

-- How many employees of the companies have pay on their row without its fact (the job's cheap pre-check).
CREATE FUNCTION "compensation_missing_openings"(p_company_ids text[]) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int
    FROM "Employee" em
   WHERE (p_company_ids IS NULL OR coalesce(em."legalCompanyId", em."actualCompanyId") = ANY (p_company_ids))
     AND ((em."basicSalary" > 0 AND NOT EXISTS (SELECT 1 FROM "CompensationPeriod" cp WHERE cp."employeeId" = em."id"))
       OR ((em."salaryPaymentMethod" = 'CASH' OR "compensation_normalize_iban"(em."ibanNumber") <> '')
           AND NOT EXISTS (SELECT 1 FROM "BankIdentityPeriod" bp WHERE bp."employeeId" = em."id")))
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM "compensation_backfill_legacy_compensation"(NULL, 'migration:9zg_financial_change') LOOP
    RAISE NOTICE '9zg compensation openings of employees without a period: % % -> % employee(s)', r."outcome", coalesce(r."reason", ''), r."employees";
  END LOOP;
END;
$$;

-- Report (no write): employees whose Employee pay columns differ from the compensation period in force
-- today (pay edited directly between 9u and this release). INV-SAL-01 lists them; HR corrects them with a
-- financial change (two people), payroll reads the period from this release on.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM "Employee" em
    JOIN "CompensationPeriod" cp ON cp."employeeId" = em."id" AND cp."supersededAt" IS NULL
     AND cp."validFrom" <= (now() AT TIME ZONE 'Asia/Riyadh')::date
     AND (cp."validTo" IS NULL OR cp."validTo" > (now() AT TIME ZONE 'Asia/Riyadh')::date)
   WHERE round(em."basicSalary"::numeric, 2) <> cp."basicSalary";
  RAISE NOTICE '9zg: % employee(s) whose basicSalary differs from the compensation period in force today (INV-SAL-01)', v_count;
END;
$$;

-- LEGACY_UNVERIFIED requests (req-to-be §17 C11 / ARC-REQ-A3): the IBAN line of every PENDING portal
-- data-update request. The IBAN is kept as stored in the request text (legacy plaintext, like
-- Employee.ibanNumber; the application encrypts every new one); its filer comes from the AuditLog CREATE
-- of the row, else every user with an AuditLog entry on it (RT-REQ-301). Idempotent (operation key).
INSERT INTO "EmployeeFinancialChange" (
  "id", "employeeId", "companyId", "field", "source", "status", "effectiveDate",
  "ibanEncrypted", "ibanFingerprint", "ibanLast4", "bankName", "paymentMethod",
  "note", "requestedById", "legacyFiledByUserIds", "operationKey", "updatedAt")
SELECT gen_random_uuid()::text, x."employeeId", x."companyId", 'BANK_IDENTITY', 'PORTAL', 'LEGACY_UNVERIFIED',
       (now() AT TIME ZONE 'Asia/Riyadh')::date,
       x."iban", "compensation_iban_fingerprint"(x."iban"), right(x."iban", 4), x."bankName",
       CASE WHEN x."method" = 'WPS' THEN 'WPS' ELSE 'BANK_TRANSFER' END::"PaymentMethod",
       'ترحيل طلب تحديث بيانات من البوابة (' || x."correctionId" || ')',
       NULL,
       coalesce(
         (SELECT array_agg(DISTINCT l."userId") FROM "AuditLog" l
           WHERE l."entityType" = 'AttendanceCorrection' AND l."entityId" = x."correctionId" AND l."action" = 'CREATE' AND l."userId" IS NOT NULL),
         (SELECT array_agg(DISTINCT l."userId") FROM "AuditLog" l
           WHERE l."entityType" = 'AttendanceCorrection' AND l."entityId" = x."correctionId" AND l."userId" IS NOT NULL),
         ARRAY[]::text[]),
       'legacy-iban:' || x."correctionId",
       CURRENT_TIMESTAMP
  FROM (
    SELECT c."id" AS "correctionId", c."employeeId", em."legalCompanyId" AS "companyId", em."salaryPaymentMethod"::text AS "method",
           "compensation_normalize_iban"(substring(c."reason" from '(?m)^[[:space:]]*الآيبان[[:space:]]*:[[:space:]]*([^\n]+)$')) AS "iban",
           NULLIF(btrim(substring(c."reason" from '(?m)^[[:space:]]*اسم البنك[[:space:]]*:[[:space:]]*([^\n]+)$')), '') AS "bankName"
      FROM "AttendanceCorrection" c
      JOIN "Employee" em ON em."id" = c."employeeId"
     WHERE c."status" = 'PENDING'
       AND btrim(c."reason") LIKE '[طلب: تحديث بيانات]%'
  ) x
 WHERE x."iban" ~ '^SA[0-9]{22}$'
ON CONFLICT ("operationKey") DO NOTHING;

-- The one-time backfill of every existing employee (cross-company data migration), reported.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM "compensation_backfill_bank_identities"(NULL, 'migration:9zg_financial_change') LOOP
    RAISE NOTICE '9zg bank identity backfill: % % -> % employee(s)', r."outcome", coalesce(r."reason", ''), r."employees";
  END LOOP;
END;
$$;
