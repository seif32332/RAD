-- Document issuance engine (docs/document-engine: ADR-001, SPEC §4.3).
-- Expand-only (DEC-004): new tables, one nullable column, indexes, foreign keys and guard triggers.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "jobTitleEnglish" TEXT;

-- CreateTable
CREATE TABLE "BrandProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "numberPrefix" TEXT NOT NULL,
    "logoAssetId" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#0F4C81',
    "numerals" TEXT NOT NULL DEFAULT 'latn',
    "addressAr" TEXT,
    "addressEn" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAsset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signatory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT,
    "signatureAssetId" TEXT,
    "stampAssetId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signatory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningAuthorization" (
    "id" TEXT NOT NULL,
    "signatoryId" TEXT NOT NULL,
    "legalCompanyId" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "scopeJson" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "SigningAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTypeSetting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "selfService" BOOLEAN,
    "requiresApproval" BOOLEAN,
    "validityDays" INTEGER,
    "signatoryId" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTypeSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRequest" (
    "id" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "legalCompanyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requestedById" TEXT,
    "source" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentSnapshotId" TEXT,
    "rejectReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSnapshot" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "contractVersion" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "dataSha256" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentApproval" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "snapshotSha256" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "invalidReason" TEXT,

    CONSTRAINT "DocumentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRenderJob" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "legalCompanyId" TEXT NOT NULL,
    "typeCode" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "verifyTokenHash" TEXT NOT NULL,
    "verifyTokenEnc" TEXT,
    "signatoryId" TEXT,
    "authorizationId" TEXT,
    "approvalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentRenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedDocument" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "legalCompanyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "snapshotSha256" TEXT NOT NULL,
    "approvalId" TEXT,
    "signatoryId" TEXT,
    "authorizationId" TEXT,
    "templateRef" TEXT NOT NULL,
    "templateSha256" TEXT NOT NULL,
    "rendererId" TEXT NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "typstSha256" TEXT NOT NULL,
    "fontsSha256" TEXT NOT NULL,
    "pdfStandard" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "pdfSha256" TEXT NOT NULL,
    "pdfSize" INTEGER NOT NULL,
    "verifyTokenHash" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "issuedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "supersededById" TEXT,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCounter" (
    "legalCompanyId" TEXT NOT NULL,
    "typeCode" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("legalCompanyId","typeCode","year")
);

-- CreateTable
CREATE TABLE "DocumentEvent" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "requestId" TEXT,
    "documentId" TEXT,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "ip" TEXT,
    "metaJson" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandProfile_companyId_key" ON "BrandProfile"("companyId");

-- CreateIndex
CREATE INDEX "DocumentAsset_companyId_kind_idx" ON "DocumentAsset"("companyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAsset_companyId_sha256_key" ON "DocumentAsset"("companyId", "sha256");

-- CreateIndex
CREATE INDEX "Signatory_companyId_isActive_idx" ON "Signatory"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "SigningAuthorization_signatoryId_typeKey_legalCompanyId_idx" ON "SigningAuthorization"("signatoryId", "typeKey", "legalCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTypeSetting_companyId_typeKey_key" ON "DocumentTypeSetting"("companyId", "typeKey");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRequest_currentSnapshotId_key" ON "DocumentRequest"("currentSnapshotId");

-- CreateIndex
CREATE INDEX "DocumentRequest_status_createdAt_idx" ON "DocumentRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentRequest_employeeId_createdAt_idx" ON "DocumentRequest"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentRequest_legalCompanyId_status_idx" ON "DocumentRequest"("legalCompanyId", "status");

-- CreateIndex
CREATE INDEX "DocumentSnapshot_requestId_idx" ON "DocumentSnapshot"("requestId");

-- CreateIndex
CREATE INDEX "DocumentApproval_requestId_idx" ON "DocumentApproval"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRenderJob_requestId_key" ON "DocumentRenderJob"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRenderJob_verifyTokenHash_key" ON "DocumentRenderJob"("verifyTokenHash");

-- CreateIndex
CREATE INDEX "DocumentRenderJob_status_nextAttemptAt_idx" ON "DocumentRenderJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRenderJob_legalCompanyId_number_key" ON "DocumentRenderJob"("legalCompanyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_requestId_key" ON "IssuedDocument"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_snapshotId_key" ON "IssuedDocument"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_storedName_key" ON "IssuedDocument"("storedName");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_verifyTokenHash_key" ON "IssuedDocument"("verifyTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_supersededById_key" ON "IssuedDocument"("supersededById");

-- CreateIndex
CREATE INDEX "IssuedDocument_employeeId_issuedAt_idx" ON "IssuedDocument"("employeeId", "issuedAt");

-- CreateIndex
CREATE INDEX "IssuedDocument_status_idx" ON "IssuedDocument"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_legalCompanyId_number_key" ON "IssuedDocument"("legalCompanyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentEvent_seq_key" ON "DocumentEvent"("seq");

-- CreateIndex
CREATE INDEX "DocumentEvent_documentId_idx" ON "DocumentEvent"("documentId");

-- CreateIndex
CREATE INDEX "DocumentEvent_requestId_idx" ON "DocumentEvent"("requestId");

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signatory" ADD CONSTRAINT "Signatory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningAuthorization" ADD CONSTRAINT "SigningAuthorization_signatoryId_fkey" FOREIGN KEY ("signatoryId") REFERENCES "Signatory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTypeSetting" ADD CONSTRAINT "DocumentTypeSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_legalCompanyId_fkey" FOREIGN KEY ("legalCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_currentSnapshotId_fkey" FOREIGN KEY ("currentSnapshotId") REFERENCES "DocumentSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "DocumentSnapshot_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRenderJob" ADD CONSTRAINT "DocumentRenderJob_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_legalCompanyId_fkey" FOREIGN KEY ("legalCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "DocumentSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Immutability of the issuance records (docs/document-engine/ADR-001: DOC-04, DOC-05, DOC-07,
-- DOC-09, DOC-12). Enforced in the database, not only in the application: a bug, a script or a
-- manual UPDATE cannot rewrite what was issued. Prisma does not model triggers, so they live here
-- only (and `prisma migrate diff` ignores them).
-- ---------------------------------------------------------------------------

-- DocumentEvent: append-only (hash chain).
CREATE FUNCTION "document_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DocumentEvent is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "DocumentEvent_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentEvent"
  FOR EACH ROW EXECUTE FUNCTION "document_event_append_only"();

-- IssuedDocument: never deleted. After creation only these may change:
--   status ISSUED -> REVOKED | SUPERSEDED (with revokedAt/revokedById/revokeReason or supersededById),
--   purgedAt NULL -> timestamp (end of retention: the file is deleted, the row stays).
CREATE FUNCTION "issued_document_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IssuedDocument rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."number", NEW."legalCompanyId", NEW."employeeId", NEW."typeKey", NEW."requestId",
      NEW."snapshotId", NEW."snapshotSha256", NEW."approvalId", NEW."signatoryId", NEW."authorizationId",
      NEW."templateRef", NEW."templateSha256", NEW."rendererId", NEW."rendererVersion", NEW."typstSha256",
      NEW."fontsSha256", NEW."pdfStandard", NEW."storedName", NEW."pdfSha256", NEW."pdfSize",
      NEW."verifyTokenHash", NEW."validUntil", NEW."issuedAt", NEW."issuedById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."number", OLD."legalCompanyId", OLD."employeeId", OLD."typeKey", OLD."requestId",
      OLD."snapshotId", OLD."snapshotSha256", OLD."approvalId", OLD."signatoryId", OLD."authorizationId",
      OLD."templateRef", OLD."templateSha256", OLD."rendererId", OLD."rendererVersion", OLD."typstSha256",
      OLD."fontsSha256", OLD."pdfStandard", OLD."storedName", OLD."pdfSha256", OLD."pdfSize",
      OLD."verifyTokenHash", OLD."validUntil", OLD."issuedAt", OLD."issuedById", OLD."createdAt") THEN
    RAISE EXCEPTION 'IssuedDocument % is immutable (DOC-07)', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'ISSUED' AND NEW."status" IN ('REVOKED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'IssuedDocument status % -> % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'ISSUED' AND (NEW."revokedAt", NEW."revokedById", NEW."revokeReason", NEW."supersededById")
     IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById", OLD."revokeReason", OLD."supersededById") THEN
    RAISE EXCEPTION 'IssuedDocument % is already closed', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."purgedAt" IS NOT NULL AND NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" THEN
    RAISE EXCEPTION 'IssuedDocument % purge mark cannot change', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "IssuedDocument_guard"
  BEFORE UPDATE OR DELETE ON "IssuedDocument"
  FOR EACH ROW EXECUTE FUNCTION "issued_document_guard"();

-- DocumentSnapshot: never deleted; content only cleared once, by the retention purge.
CREATE FUNCTION "document_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DocumentSnapshot rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."requestId", NEW."typeKey", NEW."contractVersion", NEW."dataSha256", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."requestId", OLD."typeKey", OLD."contractVersion", OLD."dataSha256", OLD."createdAt") THEN
    RAISE EXCEPTION 'DocumentSnapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."data", NEW."brand", NEW."purgedAt") IS DISTINCT FROM (OLD."data", OLD."brand", OLD."purgedAt")
     AND NOT (OLD."purgedAt" IS NULL AND NEW."purgedAt" IS NOT NULL AND NEW."data" = '{}' AND NEW."brand" = '{}') THEN
    RAISE EXCEPTION 'DocumentSnapshot content can only be purged (DOC-09)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DocumentSnapshot_guard"
  BEFORE UPDATE OR DELETE ON "DocumentSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "document_snapshot_guard"();

-- DocumentApproval: a decision is final; it can only be invalidated once (stale snapshot, DOC-05).
CREATE FUNCTION "document_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DocumentApproval rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."requestId", NEW."snapshotId", NEW."snapshotSha256", NEW."approverId", NEW."decision", NEW."note", NEW."decidedAt")
     IS DISTINCT FROM (OLD."id", OLD."requestId", OLD."snapshotId", OLD."snapshotSha256", OLD."approverId", OLD."decision", OLD."note", OLD."decidedAt")
     OR (OLD."invalidatedAt" IS NOT NULL AND (NEW."invalidatedAt", NEW."invalidReason") IS DISTINCT FROM (OLD."invalidatedAt", OLD."invalidReason")) THEN
    RAISE EXCEPTION 'DocumentApproval is immutable except a one-time invalidation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DocumentApproval_guard"
  BEFORE UPDATE OR DELETE ON "DocumentApproval"
  FOR EACH ROW EXECUTE FUNCTION "document_approval_guard"();

-- SigningAuthorization: never deleted; only accepted once and revoked once (DOC-04).
CREATE FUNCTION "signing_authorization_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SigningAuthorization rows are never deleted (revoke instead)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."signatoryId", NEW."legalCompanyId", NEW."typeKey", NEW."scopeJson", NEW."validFrom", NEW."validUntil", NEW."grantedById", NEW."grantedAt")
     IS DISTINCT FROM (OLD."id", OLD."signatoryId", OLD."legalCompanyId", OLD."typeKey", OLD."scopeJson", OLD."validFrom", OLD."validUntil", OLD."grantedById", OLD."grantedAt")
     OR (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt")
     OR (OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt", NEW."revokedById", NEW."revokeReason") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById", OLD."revokeReason")) THEN
    RAISE EXCEPTION 'SigningAuthorization can only be accepted or revoked once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SigningAuthorization_guard"
  BEFORE UPDATE OR DELETE ON "SigningAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "signing_authorization_guard"();

-- DocumentAsset: content-addressed; never changed. Deletion only while no document references it
-- is enforced by the application (the stored file is kept anyway for re-rendering old documents).
CREATE FUNCTION "document_asset_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DocumentAsset is immutable (upload a new asset instead)' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "DocumentAsset_guard"
  BEFORE UPDATE ON "DocumentAsset"
  FOR EACH ROW EXECUTE FUNCTION "document_asset_guard"();
