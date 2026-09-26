-- Execution orders of promotion / salary-increase decisions (docs/document-engine/SPEC.md §15,
-- owner decision 2026-09-26: the approved decision letter carries out the change). Applied to the
-- employee file once, on the effective date (at issuance when already due, else by the nightly job
-- apply-employee-changes); cancelled if the decision is revoked before that.
CREATE TABLE "EmployeeChangeOrder" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "basicSalary" DOUBLE PRECISION,
    "jobTitle" TEXT,
    "jobTitleEnglish" TEXT,
    "appliedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeChangeOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmployeeChangeOrder_documentId_key" ON "EmployeeChangeOrder"("documentId");
CREATE INDEX "EmployeeChangeOrder_appliedAt_cancelledAt_effectiveDate_idx" ON "EmployeeChangeOrder"("appliedAt", "cancelledAt", "effectiveDate");
CREATE INDEX "EmployeeChangeOrder_employeeId_idx" ON "EmployeeChangeOrder"("employeeId");

-- An order is decided by its document: only the outcome (applied once, or cancelled once) changes.
CREATE FUNCTION "employee_change_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EmployeeChangeOrder rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."employeeId", NEW."documentId", NEW."effectiveDate", NEW."basicSalary", NEW."jobTitle", NEW."jobTitleEnglish", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."employeeId", OLD."documentId", OLD."effectiveDate", OLD."basicSalary", OLD."jobTitle", OLD."jobTitleEnglish", OLD."createdAt")
     OR (OLD."appliedAt" IS NOT NULL AND NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (NEW."appliedAt" IS NOT NULL AND NEW."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'EmployeeChangeOrder is decided by its document' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmployeeChangeOrder_guard"
  BEFORE UPDATE OR DELETE ON "EmployeeChangeOrder"
  FOR EACH ROW EXECUTE FUNCTION "employee_change_order_guard"();
