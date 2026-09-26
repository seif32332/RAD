-- Document engine phase 2 (docs/document-engine/SPEC.md §14): system-suggested requests, the
-- employee's acknowledgement (receipt of a warning, acceptance or dispute of a settlement
-- statement) and the payment proof finance records when a settlement is paid.

-- A request created by the system from a business event (e.g. settlement:<id>): at most one per
-- type and source, so a retried or concurrent suggestion never creates a second request.
ALTER TABLE "DocumentRequest" ADD COLUMN     "sourceRef" TEXT;
CREATE UNIQUE INDEX "DocumentRequest_typeKey_sourceRef_key" ON "DocumentRequest"("typeKey", "sourceRef");

CREATE TABLE "DocumentAcknowledgement" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'RECEIVED',
    "comment" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentAcknowledgement_documentId_key" ON "DocumentAcknowledgement"("documentId");
CREATE INDEX "DocumentAcknowledgement_employeeId_idx" ON "DocumentAcknowledgement"("employeeId");

ALTER TABLE "DocumentAcknowledgement" ADD CONSTRAINT "DocumentAcknowledgement_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "IssuedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An acknowledgement is evidence: never deleted, never rewritten. The only change allowed is the
-- retention purge clearing the employee's comment (personal data) once.
CREATE FUNCTION "document_acknowledgement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DocumentAcknowledgement rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."documentId", NEW."employeeId", NEW."userId", NEW."decision", NEW."acknowledgedAt")
     IS DISTINCT FROM (OLD."id", OLD."documentId", OLD."employeeId", OLD."userId", OLD."decision", OLD."acknowledgedAt")
     OR (NEW."comment" IS DISTINCT FROM OLD."comment" AND NEW."comment" IS NOT NULL) THEN
    RAISE EXCEPTION 'DocumentAcknowledgement is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DocumentAcknowledgement_guard"
  BEFORE UPDATE OR DELETE ON "DocumentAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION "document_acknowledgement_guard"();

-- Payment proof of a settlement (method, reference, actual date), entered by finance when it
-- confirms the payment; printed on the settlement statement next to the receipt fingerprint.
ALTER TABLE "Settlement" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "paymentReference" TEXT;

