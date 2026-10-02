-- Employee transfer decision (docs/document-engine/SPEC.md §15 item 38, 2026-09-27): moves the
-- employee to another branch / department / direct manager on the effective date, through the same
-- change order as a promotion. Also: per-company options of a document type (defaults the company
-- may change, DEC-PO-116), e.g. whether a transfer to another city may be decided without an addendum.

-- AlterTable
ALTER TABLE "EmployeeChangeOrder" ADD COLUMN "departmentId" TEXT,
ADD COLUMN "directManagerId" TEXT;

-- AlterTable
ALTER TABLE "DocumentTypeSetting" ADD COLUMN "optionsJson" TEXT;

-- The guard now also covers the new terms.
CREATE OR REPLACE FUNCTION "employee_change_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EmployeeChangeOrder rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."employeeId", NEW."documentId", NEW."effectiveDate", NEW."basicSalary", NEW."jobTitle", NEW."jobTitleEnglish", NEW."createdAt",
      NEW."housingAllowance", NEW."transportAllowance", NEW."branchId", NEW."contractEndDate", NEW."departmentId", NEW."directManagerId")
     IS DISTINCT FROM (OLD."id", OLD."employeeId", OLD."documentId", OLD."effectiveDate", OLD."basicSalary", OLD."jobTitle", OLD."jobTitleEnglish", OLD."createdAt",
      OLD."housingAllowance", OLD."transportAllowance", OLD."branchId", OLD."contractEndDate", OLD."departmentId", OLD."directManagerId")
     OR (OLD."appliedAt" IS NOT NULL AND NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (NEW."appliedAt" IS NOT NULL AND NEW."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'EmployeeChangeOrder is decided by its document' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
