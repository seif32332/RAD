-- Company wording per document type (docs/document-engine/SPEC.md §15, owner decision 2026-09-26): an
-- opening and a closing paragraph around the fixed legal body. Every edit is a new row (history); the
-- latest row per company, type and slot is in force, and a document keeps the text of its snapshot.

-- CreateTable
CREATE TABLE "DocumentTextOverride" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "textAr" TEXT,
    "textEn" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTextOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentTextOverride_companyId_typeKey_slot_createdAt_idx" ON "DocumentTextOverride"("companyId", "typeKey", "slot", "createdAt");

-- Slot values.
ALTER TABLE "DocumentTextOverride" ADD CONSTRAINT "DocumentTextOverride_slot" CHECK ("slot" IN ('OPENING', 'CLOSING'));

CREATE FUNCTION "document_text_override_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DocumentTextOverride is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "DocumentTextOverride_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentTextOverride"
  FOR EACH ROW EXECUTE FUNCTION "document_text_override_append_only"();
