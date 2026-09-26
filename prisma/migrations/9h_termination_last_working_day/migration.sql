-- Last working day of an approved resignation / termination request, set by HR when approving
-- (owner decision 2026-09-26); printed on the approval letter (docs/document-engine/SPEC.md §15).
ALTER TABLE "TerminationRequest" ADD COLUMN     "lastWorkingDate" TIMESTAMP(3);
