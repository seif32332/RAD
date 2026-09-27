-- Contract addendum (docs/document-engine/SPEC.md §15 item 35, owner decision 2026-09-27): a
-- structured amendment the employee accepts in the portal; on acceptance its change order applies
-- to the file on the effective date, like a promotion decision. The order now also carries the
-- housing / transport allowances, the work location (branch) and the contract end date.

-- AlterTable
ALTER TABLE "EmployeeChangeOrder" ADD COLUMN "housingAllowance" DOUBLE PRECISION,
ADD COLUMN "transportAllowance" DOUBLE PRECISION,
ADD COLUMN "branchId" TEXT,
ADD COLUMN "contractEndDate" TIMESTAMP(3);

-- The guard now also covers the new terms (decided by the document, never edited).
CREATE OR REPLACE FUNCTION "employee_change_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EmployeeChangeOrder rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."employeeId", NEW."documentId", NEW."effectiveDate", NEW."basicSalary", NEW."jobTitle", NEW."jobTitleEnglish", NEW."createdAt",
      NEW."housingAllowance", NEW."transportAllowance", NEW."branchId", NEW."contractEndDate")
     IS DISTINCT FROM (OLD."id", OLD."employeeId", OLD."documentId", OLD."effectiveDate", OLD."basicSalary", OLD."jobTitle", OLD."jobTitleEnglish", OLD."createdAt",
      OLD."housingAllowance", OLD."transportAllowance", OLD."branchId", OLD."contractEndDate")
     OR (OLD."appliedAt" IS NOT NULL AND NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (NEW."appliedAt" IS NOT NULL AND NEW."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'EmployeeChangeOrder is decided by its document' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
