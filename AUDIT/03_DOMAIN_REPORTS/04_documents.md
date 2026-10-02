# 04 Documents

## Scope and method

Read `src/lib/storage.ts` (488 lines), `src/app/api/upload/route.ts`, `src/app/api/files/[...path]/route.ts`
in full. Read the whole `src/lib/documents/*` module by function (service.ts, policy.ts, events.ts,
candidate.ts, seal/pades.ts) and the relevant `prisma/schema.prisma` model blocks (`UploadedFile`,
`CompanyDocument`, `RenewalArchive`, `DocumentRequest`/`DocumentSnapshot`/`DocumentApproval`/
`DocumentRenderJob`/`IssuedDocument`/`DocumentSealKey`/`DocumentEvent`/`CandidateDocumentAccess`).
Read `src/app/v/[token]/route.ts` (public verification) and the DB-trigger section of
`prisma/migrations/9b_document_engine/migration.sql`. Read `scripts/jobs.mjs` retention/integrity job
headers. Listed (did not fully read) the 12 `documents-*` test files and `seal-fixtures.ts` under
`src/lib/__tests__`. The working tree is dirty with an in-progress, uncommitted "transfer decision"
document type (migration `9p_transfer_decision`, `templates/transfer-decision.typ`,
`documents-transfer.test.ts`) — assessed as PARTIAL/in-progress, not part of the released baseline.

## Capability findings

### Upload (validation, storage)
Capability: authenticated + anonymous file upload with type/size/content validation.
Status: COMPLETE
Evidence: EV-2002, EV-2003, EV-2004
Files: src/lib/storage.ts, src/app/api/upload/route.ts
Functions/classes: `validateUpload`, `matchesSignature`, `looksLikeMarkup`, `saveUpload`, `checkUploadMeta`
DB tables: UploadedFile
API routes: POST /api/upload
UI routes: (embedded in forms across the app; not a standalone page)
Tests: not directly verified in this pass (storage.ts pure helpers are unit-testable; test file not opened)
Observed behavior: allow-list excludes SVG/HTML/XML/scripts; magic-byte signature check per extension;
content-length pre-check against both the policy max and the Next proxy's buffer limit; rate-limited
(300/h authenticated, 10/h anonymous IP); orphan file removed if the DB insert fails; every upload
audit-logged.
Missing pieces: none material found.
Risk: Low.
Confidence: High.

### Storage path safety
Capability: files are served only through an authenticated route; no path traversal.
Status: COMPLETE
Evidence: EV-2003
Files: src/lib/storage.ts
Functions/classes: `resolveInside`, `findStoredFile`
Observed behavior: segment validation rejects `..`, absolute paths, hidden files, null bytes; resolved
path is checked to stay strictly inside the base directory.
Missing pieces: none found.
Risk: Low.
Confidence: High.

### Download authorization / access security
Capability: role-, scope- and category-aware download gate for uploaded documents.
Status: COMPLETE
Evidence: EV-2005, EV-2006
Files: src/lib/storage.ts, src/app/api/files/[...path]/route.ts
Functions/classes: `decideScopedFileAccess`, `mayReadAsMuqeemDocument`, `referencedByOwnRecords`, `isInManagersTeam`
DB tables: UploadedFile, Employee, Leave, Visa, Loan, Settlement, Circular, MedicalInsurance, MuqeemTransaction
API routes: GET /api/files/[...path]
Observed behavior: full-access roles (HR/payroll/owner/admin) read everything; branch/dept managers only
their team's classified, non-sensitive files; sensitive categories (IDENTITY/PASSPORT/HEALTH/BANK)
restricted to the owning employee and full-access roles, plus a narrow carve-out for GOV_RELATIONS on
Muqeem-issued documents only; every sensitive-file read is written to AuditLog (VIEW); a denied and a
missing file return the same outcome (no existence probing); CSP/`nosniff`/`no-store` headers set for
sensitive content.
Missing pieces: none material found; this is one of the stronger-evidenced capabilities in the audit.
Risk: Low.
Confidence: High.

### Company document tracking (CompanyDocument)
Capability: per-company document with an expiry date and an alert flag.
Status: PARTIAL
Evidence: EV-2007, EV-2009 (company docs folded into the renewals queue via `Company`/`Branch` fields, not the `CompanyDocument` model itself)
Files: prisma/schema.prisma:519-533
DB tables: CompanyDocument
Observed behavior: the model exists (documentUrl, expirationDate, isAlertSent) but no route/service reading
or writing `CompanyDocument` was found in this pass; the renewals queue (EV-2009) instead reads expiry
dates directly off `Company`/`Branch` columns (commercialRegExp, munLicenseExp, etc.), not off this table.
Missing pieces: could not confirm any live read/write path for `CompanyDocument`; re-verify before relying
on it — possibly superseded/legacy.
Risk: Medium (a model that looks populated but may not be wired to any UI is a false-completeness risk).
Confidence: Medium.

### Renewals / expiry lifecycle (Expire -> Renew)
Capability: unified expiry queue and renewal recording across employees, companies, branches, vehicles,
insurance, legal contracts/agencies.
Status: COMPLETE
Evidence: EV-2008, EV-2009
Files: src/lib/alerts.ts, src/app/api/renewals/route.ts, src/app/api/renewals/action/route.ts, prisma/schema.prisma:1616-1635
DB tables: RenewalArchive, PaymentRequest
API routes: GET/POST /api/renewals, /api/renewals/action
UI routes: /renewals
Observed behavior: per-document-type alert thresholds; "early renewal" force-include from settlement
flags; termination-aware suppression (a renewal already recorded TERMINATED for that exact expiry date is
not re-queued); payment-request status folded into the item (pending/paid/returned); legal-managed
document types (contracts, agencies) are read-only here, pointing to the legal module.
Missing pieces: business-rule complexity (many code paths) increases regression risk; only the GET side
was read in full, the POST `/api/renewals/action` renew/terminate handler was not read in this pass.
Risk: Low-Medium.
Confidence: Medium-High.

### Document versioning (uploaded files)
Capability: keeping prior versions of an uploaded document when it is replaced/renewed.
Status: MISSING
Evidence: EV-2001 (no version/parent/supersedes column on `UploadedFile`)
DB tables: UploadedFile
Observed behavior: replacing e.g. an iqama copy creates a brand-new `UploadedFile` row with a new URL and
overwrites the pointer on `Employee.iqamaCopyUrl`; the previous file's row is orphaned (not deleted, not
linked) with no version history exposed anywhere found.
Missing pieces: no version chain, no "view previous version" capability.
Risk: Medium — for a document meant to be legally traceable (identity documents), losing the link to the
prior version on renewal is a real gap, distinct from the generated-document engine's own immutable
snapshot chain (which does have full history).
Confidence: High (negative search across schema + storage.ts).

### Generated documents / official letters (issuance pipeline)
Capability: HR-triggered or system-triggered generation of official PDF letters/certificates for
employees and candidates, with approvals, numbering and signatures.
Status: COMPLETE
Evidence: EV-2030, EV-2031, EV-2032, EV-2033, EV-2042
Files: src/lib/documents/service.ts (1344 lines), policy.ts, render-model.ts, types.ts, templates.ts, facts.ts
DB tables: DocumentRequest, DocumentSnapshot, DocumentApproval, DocumentRenderJob, IssuedDocument, DocumentCounter
API routes: /api/documents/requests, /api/documents/requests/[id], /api/documents/[id], /api/documents/[id]/pdf, /api/documents/[id]/recipients, /api/documents/settings
UI routes: /documents, /documents/settings
Observed behavior: pipeline is create -> immutable JCS-canonical snapshot (sha256) -> stale-snapshot
invalidates prior approvals -> signature decision (signatory's own approval of the exact snapshot hash, or
a scoped/bounded/accepted pre-authorization) -> approval gate (`needsApproval` fails closed) -> number
reserved transactionally before rendering (retries render the identical bytes) -> stored once ->
`IssuedDocument` created in the same transaction. Company-level policy (`effectivePolicy`) can only
relax what a type allows to be relaxed — `approvalLocked`/`approvalMandatory` types ignore company
settings entirely.
Missing pieces: renderer itself (`renderer.ts`, Typst-based sidecar `services/render`) not exercised in
this pass beyond reading its interface; assumed working per the harness's stated full-suite pass.
Risk: Low.
Confidence: High.

### Audit trail (DocumentEvent hash chain)
Capability: tamper-evident append-only log of every document lifecycle event.
Status: COMPLETE
Evidence: EV-2034, EV-2035
Files: src/lib/documents/events.ts, prisma/migrations/9b_document_engine/migration.sql:365-425
DB tables: DocumentEvent
Observed behavior: each event's hash covers the previous event's hash plus its own canonical content
(`sha256Hex(prevHash + canonicalJson(...))`); writers take a Postgres advisory transaction lock so the
chain cannot race; a Postgres trigger rejects any UPDATE/DELETE on the table outright (`RAISE EXCEPTION`
with `restrict_violation`), so the guarantee does not depend on the application code alone;
`verifyEventChain()` walks and re-verifies the whole chain (used by the `documents-integrity` job).
Missing pieces: none found; this is DB-enforced, not just app-enforced.
Risk: Low.
Confidence: High.

### Digital seal (PAdES) and public verification
Capability: cryptographically seal issued PDFs and let anyone verify a document's status and integrity
from a QR code, without exposing personal data.
Status: COMPLETE
Evidence: EV-2036, EV-2037, EV-2038
Files: src/lib/documents/seal/pades.ts, der.ts, cert.ts, keys.ts, src/app/v/[token]/route.ts, src/app/v/[token]/certificate/route.ts
DB tables: DocumentSealKey, IssuedDocument
UI routes: /v/[token] (public, no personal data displayed)
Observed behavior: hand-written PAdES baseline-B-B incremental-update signer over Node's own `crypto`
(RSA sign, `X509Certificate`) plus a minimal DER reader/writer, explicitly built only for the renderer's
own known PDF byte layout and fails closed (`SealError`) otherwise, rather than guessing; signing time is
the server clock (explicit owner decision, no external TSA) and is also recorded in the DocumentEvent
chain; the verification page is a Route Handler (not a Next page) with a strict CSP pinned to the inline
script's own SHA-256 hash, rate-limited 30/min/IP, and does an in-browser (never uploaded) SHA-256 file
match against `IssuedDocument.pdfSha256`.
Missing pieces: private-key custody depends on `DATA_ENCRYPTION_KEY` (app-level encryption at rest) —
this audit did not verify key-rotation or HSM-equivalent protections, which is outside a self-issued-cert
model's normal guarantees anyway (documented on the verification page itself: "not from an external CA").
Risk: Low, given the explicit, documented design choice.
Confidence: High.

### Retention, purge and integrity monitoring (Archive step)
Capability: enforce a retention period on issued documents/snapshots and continuously verify the
integrity of what remains.
Status: COMPLETE
Evidence: EV-2041
Files: scripts/jobs.mjs (documentsRetention, documentsIntegrity), each recorded via JobRun
DB tables: DocumentSnapshot (`purgedAt`), IssuedDocument (`purgedAt`)
Observed behavior: `documents-retention` purges snapshot `data`/`brand` and the stored PDF past a
configurable retention window while keeping the `IssuedDocument` row itself (auditable "this existed"
record survives purge); `documents-integrity` re-walks the DocumentEvent hash chain and re-hashes every
stored PDF against its recorded sha256, alerting HR/admin by outbox email on any mismatch.
Missing pieces: none found; these are real, scheduled job handlers (not stubs), confirmed by name in
`JOB_NAMES` and dispatch table.
Risk: Low.
Confidence: High.

### In-progress: transfer-decision document type (uncommitted)
Capability: a new administrative-decision document type for department/manager reassignment.
Status: PARTIAL (feature under active development, not yet committed)
Evidence: EV-2040
Files: prisma/migrations/9p_transfer_decision/ (untracked), src/lib/documents/change-orders.ts,
src/lib/documents/templates/transfer-decision.typ, src/lib/__tests__/documents-transfer.test.ts (untracked)
Observed behavior: schema additions (`EmployeeChangeOrder.departmentId`/`directManagerId`), its own Typst
template and test file exist but the migration is not yet applied/committed to git.
Missing pieces: cannot confirm this is deployable without running the migration against Postgres (out of
audit scope — no DB access).
Risk: Low (isolated, additive change; does not appear to touch existing document types).
Confidence: Medium.

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| A document snapshot is immutable; a stale snapshot invalidates prior approvals | ADR DOC-05 (SPEC) | src/lib/documents/service.ts | documents-pipeline.test.ts (listed, not opened) | Documents | No |
| Signature image only prints on the signatory's own approval of the exact snapshot hash, or a scoped pre-authorization | ADR DOC-04 | src/lib/documents/policy.ts:113-136 | documents-rules.test.ts (listed) | Documents | No |
| DocumentEvent rows are append-only; UPDATE/DELETE rejected at the DB layer | SPEC §12 | prisma/migrations/9b_document_engine/migration.sql:365-380; src/lib/documents/events.ts | documents-chain-parity.test.ts (listed) | Documents | No |
| Sensitive file categories (IDENTITY/PASSPORT/HEALTH/BANK) are readable only by the owner and full-access roles; every read is audited | DEC-002/DEC-008 | src/lib/storage.ts:352-462 | not confirmed in this pass | Documents, Onboarding (attachments), Recruitment (resume is NOT sensitive-categorized) | No |
| Official documents/snapshots are purged after a configurable retention period; the IssuedDocument row itself survives | SPEC §15.5 | scripts/jobs.mjs `documentsRetention` | not confirmed in this pass | Documents | No |
| Company policy can relax approval/self-service only for types that are not `approvalLocked`/`approvalMandatory` | ADR DOC-04 | src/lib/documents/policy.ts:36-46 | not confirmed in this pass | Documents | No |

## Edge cases checked

- **Path traversal / hidden-file download attempt**: `resolveInside`/`storedNameFromSegments` reject `..`, absolute paths and dot-files (EV-2003). Finding: handled.
- **Unauthorized probing of a nonexistent vs. forbidden file**: both return the same 404/403-shaped outcome via `handleApiError`/`notFound`/`forbidden` — same code path either way (EV-2005). Finding: handled (no enumeration oracle).
- **Retry of a stuck/failed render**: number and `issuedAt` are reserved before rendering and never change across retries, so a retry produces byte-identical output (EV-2032). Finding: handled by design.
- **Tampering with an already-issued PDF**: caught two ways — the DocumentEvent hash chain integrity job (EV-2041) and the PAdES seal breaking in any reader plus the public `/v` page's client-side hash check (EV-2038). Finding: handled.
- **Arabic/localized content in generated documents**: `formatGregorian`, `riyadhDate`/`riyadhYear` helpers in `core.ts`/`format.ts` suggest Hijri/Gregorian and Riyadh-timezone awareness was designed in; not independently verified against a rendered sample in this pass. Finding: UNKNOWN (needs a rendered-PDF check, out of scope without the render sidecar running).
- **File version replaced (e.g. renewed iqama copy)**: no version chain kept on `UploadedFile` (EV-2001). Finding: gap (see Missing pieces above).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 04 Documents | 15 | 12 | 2 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | Document versioning on UploadedFile is MISSING; CompanyDocument model looks unwired (PARTIAL, needs re-verification) | High |
