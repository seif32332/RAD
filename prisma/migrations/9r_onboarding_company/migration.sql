-- P0-05 / BL-ONB-012 (ARC-ONB-A4; audit EV-0026, EV-0027, H20): company keys for recruitment and
-- onboarding, and the legal / actual company of existing employees that have none.
--
-- Phase 0: nullable columns and backfill only. NOT NULL and the foreign keys (Restrict) come with
-- P1-FND-DB. Every step below only fills NULLs, so running it again changes nothing.
--
-- Derivation (never a guess): the company of the employee's branch (INV-ORG-01: the branch belongs to
-- the actual company), else the branch of his department, else the company of his administration,
-- else the only company when the database has exactly one. Anything else stays NULL and is counted.

-- AlterTable
ALTER TABLE "JobRequest" ADD COLUMN "companyId" TEXT;

-- AlterTable
ALTER TABLE "OnboardingRequest" ADD COLUMN "companyId" TEXT,
ADD COLUMN "jobApplicationId" TEXT;

-- CreateIndex
CREATE INDEX "JobRequest_companyId_idx" ON "JobRequest"("companyId");

-- CreateIndex
CREATE INDEX "OnboardingRequest_companyId_idx" ON "OnboardingRequest"("companyId");

-- CreateIndex
CREATE INDEX "OnboardingRequest_jobApplicationId_idx" ON "OnboardingRequest"("jobApplicationId");

-- The only company, when the database has exactly one (NULL otherwise).
CREATE TEMP TABLE "_9r_only_company" AS
  SELECT CASE WHEN COUNT(*) = 1 THEN MIN("id") END AS "id" FROM "Company";

-- JobRequest: company of the department's branch, else the only company.
UPDATE "JobRequest" j
SET "companyId" = COALESCE(
  (SELECT b."companyId" FROM "Department" d JOIN "Branch" b ON b."id" = d."branchId" WHERE d."id" = j."departmentId"),
  (SELECT "id" FROM "_9r_only_company")
)
WHERE j."companyId" IS NULL;

-- OnboardingRequest: company of the chosen branch, else of the department's branch, else of the
-- administration, else the only company.
UPDATE "OnboardingRequest" o
SET "companyId" = COALESCE(
  (SELECT b."companyId" FROM "Branch" b WHERE b."id" = o."branchId"),
  (SELECT b."companyId" FROM "Department" d JOIN "Branch" b ON b."id" = d."branchId" WHERE d."id" = o."departmentId"),
  (SELECT a."companyId" FROM "Administration" a WHERE a."id" = o."administrationId"),
  (SELECT "id" FROM "_9r_only_company")
)
WHERE o."companyId" IS NULL;

-- Employees without a legal or actual company: the derived company, recorded in the audit log.
CREATE TEMP TABLE "_9r_employee_company" AS
  SELECT e."id",
         e."legalCompanyId" IS NULL AS "setLegal",
         e."actualCompanyId" IS NULL AS "setActual",
         COALESCE(
           (SELECT b."companyId" FROM "Branch" b WHERE b."id" = e."branchId"),
           (SELECT b."companyId" FROM "Department" d JOIN "Branch" b ON b."id" = d."branchId" WHERE d."id" = e."departmentId"),
           (SELECT a."companyId" FROM "Administration" a WHERE a."id" = e."administrationId"),
           (SELECT "id" FROM "_9r_only_company")
         ) AS "companyId"
  FROM "Employee" e
  WHERE e."legalCompanyId" IS NULL OR e."actualCompanyId" IS NULL;

UPDATE "Employee" e
SET "legalCompanyId" = CASE WHEN c."setLegal" THEN c."companyId" ELSE e."legalCompanyId" END,
    "actualCompanyId" = CASE WHEN c."setActual" THEN c."companyId" ELSE e."actualCompanyId" END
FROM "_9r_employee_company" c
WHERE c."id" = e."id" AND c."companyId" IS NOT NULL;

INSERT INTO "AuditLog" ("id", "userId", "action", "entityType", "entityId", "details", "ipAddress", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || c."id")::uuid::text, NULL, 'UPDATE', 'Employee', c."id",
       json_build_object(
         'source', 'migration 9r_onboarding_company (BL-ONB-012)',
         'legalCompanyId', CASE WHEN c."setLegal" THEN c."companyId" END,
         'actualCompanyId', CASE WHEN c."setActual" THEN c."companyId" END
       )::text,
       NULL, CURRENT_TIMESTAMP
FROM "_9r_employee_company" c
WHERE c."companyId" IS NOT NULL;

-- Report what could not be derived (left NULL for HR; INV-ORG-01 / P0-10 reconciliation lists them).
DO $$
DECLARE
  employees_left integer;
  onboarding_left integer;
  jobs_left integer;
BEGIN
  SELECT COUNT(*) INTO employees_left FROM "Employee" WHERE "legalCompanyId" IS NULL OR "actualCompanyId" IS NULL;
  SELECT COUNT(*) INTO onboarding_left FROM "OnboardingRequest" WHERE "companyId" IS NULL;
  SELECT COUNT(*) INTO jobs_left FROM "JobRequest" WHERE "companyId" IS NULL;
  RAISE NOTICE '9r_onboarding_company: % employee(s) still without a legal or actual company, % onboarding request(s) and % job request(s) without a company', employees_left, onboarding_left, jobs_left;
END $$;

DROP TABLE "_9r_employee_company";
DROP TABLE "_9r_only_company";
