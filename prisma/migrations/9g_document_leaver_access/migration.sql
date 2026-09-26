-- Leaver documents-only access (docs/document-engine/SPEC.md §15 item 19, src/lib/access.ts).
-- A terminated employee keeps access to his official documents only (download, accept or dispute
-- the settlement release) until this time; every other page and API treats the account as
-- logged out. scripts/jobs.mjs deactivate-terminated disables the account afterwards.
ALTER TABLE "User" ADD COLUMN     "documentsOnlyUntil" TIMESTAMP(3);
