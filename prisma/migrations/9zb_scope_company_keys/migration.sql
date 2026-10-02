-- P1-SCOPE part C: company scope keys of the gov, legal and assets tables (DOMAIN_BOUNDARIES §5.4.3,
-- INV-SCOPE-01; evidence EV-9017, EV-9072, EV-9015 in AUDIT/12). The iam scope layer derives its
-- scoped-model list from these columns (src/modules/iam/scope-models.ts), so each table below becomes
-- company-scoped with this migration.
--
--   GovPlatform       companyId: the company whose credentials these are (§5.4.3 gov, EV-5021).
--   LegalContract, Lawsuit, PromissoryNote, CertifiedAgency
--                     companyId: the company party to the contract / case / note / agency.
--   Asset             companyId: the owning company (§5.4.3 assets). A vacant asset keeps it, so
--                     it no longer falls out of every scoped list when its holder is removed.
--
-- Nullable, FK RESTRICT. Backfill where the company can be derived:
--   * GovPlatform: the only company whose Muqeem account (Company.muqeemPlatformId) is the platform;
--   * Asset: the holder's legal company;
--   * ComplianceViolation (already has companyId): a branch violation takes its branch's company;
--   * any table, when the database has exactly one company: that company.
-- A row left NULL is unknown: visible to unrestricted users (owner / no UserCompanyScope rows) only,
-- never to a scoped user (fail closed). The counts left NULL are reported with RAISE NOTICE.
--
-- Asset rows inserted without companyId (e.g. the onboarding custody hand-over) take the holder's
-- legal company through the trigger asset_default_company, so a writer that does not know the column
-- yet cannot create an asset that no scoped user can see.

ALTER TABLE "GovPlatform" ADD COLUMN "companyId" TEXT;
ALTER TABLE "LegalContract" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Lawsuit" ADD COLUMN "companyId" TEXT;
ALTER TABLE "PromissoryNote" ADD COLUMN "companyId" TEXT;
ALTER TABLE "CertifiedAgency" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Asset" ADD COLUMN "companyId" TEXT;

CREATE INDEX "GovPlatform_companyId_idx" ON "GovPlatform"("companyId");
CREATE INDEX "LegalContract_companyId_idx" ON "LegalContract"("companyId");
CREATE INDEX "Lawsuit_companyId_idx" ON "Lawsuit"("companyId");
CREATE INDEX "PromissoryNote_companyId_idx" ON "PromissoryNote"("companyId");
CREATE INDEX "CertifiedAgency_companyId_idx" ON "CertifiedAgency"("companyId");
CREATE INDEX "Asset_companyId_idx" ON "Asset"("companyId");

ALTER TABLE "GovPlatform" ADD CONSTRAINT "GovPlatform_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LegalContract" ADD CONSTRAINT "LegalContract_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lawsuit" ADD CONSTRAINT "Lawsuit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromissoryNote" ADD CONSTRAINT "PromissoryNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CertifiedAgency" ADD CONSTRAINT "CertifiedAgency_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------------------------------

-- GovPlatform: the Muqeem account of exactly one company.
UPDATE "GovPlatform" g
SET "companyId" = c."id"
FROM "Company" c
WHERE c."muqeemPlatformId" = g."id"
  AND (SELECT count(*) FROM "Company" c2 WHERE c2."muqeemPlatformId" = g."id") = 1;

-- Asset: the holder's legal company.
UPDATE "Asset" a
SET "companyId" = e."legalCompanyId"
FROM "Employee" e
WHERE a."employeeId" = e."id" AND e."legalCompanyId" IS NOT NULL AND a."companyId" IS NULL;

-- ComplianceViolation (existing scope key companyId): a violation registered against a BRANCH had no
-- company, so it was invisible to every scoped user. It now carries its branch's company (the API
-- writes it from now on; the display still names the branch first).
UPDATE "ComplianceViolation" v
SET "companyId" = b."companyId"
FROM "Branch" b
WHERE v."branchId" = b."id" AND v."companyId" IS NULL;

-- Single-company database: every remaining row belongs to that company.
DO $$
DECLARE
  only_company text;
BEGIN
  IF (SELECT count(*) FROM "Company") = 1 THEN
    SELECT "id" INTO only_company FROM "Company";
    UPDATE "GovPlatform" SET "companyId" = only_company WHERE "companyId" IS NULL;
    UPDATE "LegalContract" SET "companyId" = only_company WHERE "companyId" IS NULL;
    UPDATE "Lawsuit" SET "companyId" = only_company WHERE "companyId" IS NULL;
    UPDATE "PromissoryNote" SET "companyId" = only_company WHERE "companyId" IS NULL;
    UPDATE "CertifiedAgency" SET "companyId" = only_company WHERE "companyId" IS NULL;
    UPDATE "Asset" SET "companyId" = only_company WHERE "companyId" IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  RAISE NOTICE '9zb_scope_company_keys: rows left without a company (visible to unrestricted users only): GovPlatform %, LegalContract %, Lawsuit %, PromissoryNote %, CertifiedAgency %, Asset %',
    (SELECT count(*) FROM "GovPlatform" WHERE "companyId" IS NULL),
    (SELECT count(*) FROM "LegalContract" WHERE "companyId" IS NULL),
    (SELECT count(*) FROM "Lawsuit" WHERE "companyId" IS NULL),
    (SELECT count(*) FROM "PromissoryNote" WHERE "companyId" IS NULL),
    (SELECT count(*) FROM "CertifiedAgency" WHERE "companyId" IS NULL),
    (SELECT count(*) FROM "Asset" WHERE "companyId" IS NULL);
END $$;

-- ---------------------------------------------------------------------------------------------------
-- Asset: an insert without a company takes the holder's legal company
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION "asset_default_company"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."companyId" IS NULL AND NEW."employeeId" IS NOT NULL THEN
    SELECT "legalCompanyId" INTO NEW."companyId" FROM "Employee" WHERE "id" = NEW."employeeId";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "asset_default_company"
BEFORE INSERT ON "Asset"
FOR EACH ROW EXECUTE FUNCTION "asset_default_company"();
