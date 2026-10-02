# 05 Recruitment / ATS

## Scope and method

Read `src/app/api/recruitment/route.ts`, `src/app/api/recruitment/shared.ts`, `src/app/api/applications/route.ts`
in full. Read `src/lib/documents/candidate.ts` in full (candidate-side offer flow inside the document
engine) and the `JobRequest`/`JobApplication`/`CandidateDocumentAccess` model blocks in
`prisma/schema.prisma`. Located but did not open `src/app/recruitment/page.tsx`, `src/app/applications/page.tsx`
(grepped for status-handling and button labels only), `src/app/apply/[jobRequestId]/page.tsx`,
`src/app/offer/[token]/route.ts` and `.../pdf/route.ts`. Ran negative greps for talent pool, scoring/
assessment, and recruitment-specific unit tests. Did not read `src/app/api/apply/[jobRequestId]/route.ts`
in full (only located it and its policy from `shared.ts`).

## Capability findings

### Manpower requisition (JobRequest)
Capability: managers raise staffing requests; HR approves/rejects/marks fulfilled.
Status: COMPLETE
Evidence: EV-2018, EV-2019
Files: src/app/api/recruitment/route.ts, src/app/api/recruitment/shared.ts
Functions/classes: `JOB_REQUEST_TRANSITIONS`, `JOB_REQUEST_STATUS`
DB tables: JobRequest, Department, Employee
API routes: GET/POST /api/recruitment
UI routes: /recruitment
Tests: none found (EV-2028)
Observed behavior: non-HR managers only see/raise requests for themselves or their own department; HR
sees and can approve/reject/fulfill everything; status transitions are guarded
(`JOB_REQUEST_TRANSITIONS`) and applied with an optimistic `updateMany` (count 0 -> 409 conflict, not a
silent no-op); every create/status-change is audit-logged.
Missing pieces: no automated test coverage for the transition guard or the scoping logic.
Risk: Low (logic is simple and readable), Medium for regression safety given zero tests.
Confidence: High.

### Candidate pipeline (JobApplication)
Capability: track a candidate from application through interview, offer, hire or rejection.
Status: COMPLETE (as a status machine; see gaps below for what it does NOT do)
Evidence: EV-2020, EV-2021
Files: src/app/api/applications/route.ts, src/app/api/recruitment/shared.ts
Functions/classes: `APPLICATION_TRANSITIONS`, `appendNoteEntries`, `buildOfferEmail`
DB tables: JobApplication, JobRequest
API routes: GET/POST /api/applications
UI routes: /applications (page.tsx renders pipeline tabs ALL/APPLIED/INTERVIEW/OFFERED/HIRED/REJECTED)
Tests: none dedicated (EV-2028); indirectly touched by documents-phase2.test.ts for the closed-candidate
error path (EV-2027's negative grep also covers this)
Observed behavior: `APPLICATION_TRANSITIONS` enforces a real state machine (e.g. OFFERED only reachable
from INTERVIEW, so the offer e-mail cannot double-fire by re-submitting the same request); HR notes are
appended as dated, Riyadh-timestamped, signed log lines and never overwritten; moving to OFFERED requires
`offerText` and triggers `sendMail()` with graceful degradation (NOT_CONFIGURED / INVALID_RECIPIENT /
TIMEOUT / SEND_FAILED all surfaced back to HR, request still succeeds); concurrency-safe update (notes
value included in the `where` filter so a racing edit becomes a 409, not a lost write).
Missing pieces: interview scheduling is a single `interviewDate` field (no multi-round support, no
calendar/reminder integration); no scoring/assessment (see below); no dedicated test file.
Risk: Medium (test-coverage gap on business-critical transition guards).
Confidence: High.

### Public job application (CV submission)
Capability: an unauthenticated candidate applies to an open vacancy with a CV upload.
Status: COMPLETE
Evidence: EV-2029, EV-2018 (`JOB_REQUEST_OPEN_STATUS` gate)
Files: src/app/api/apply/[jobRequestId]/route.ts, src/app/apply/[jobRequestId]/page.tsx
DB tables: JobApplication
API routes: POST /api/apply/[jobRequestId]
UI routes: /apply/[jobRequestId]
Tests: not found
Observed behavior (inferred from shared.ts validators, route itself not fully read): anonymous upload
policy caps at 5MB / pdf,doc,docx,jpg,png (`ANONYMOUS_UPLOAD_POLICY`), phone/email normalization and
validation (`zPhone`, `zOptEmail`), resume URL must come from `/api/upload` (`zUploadedFileUrl`).
Missing pieces: the route handler itself (rate limiting, duplicate-application handling) was not read in
this pass — re-verify before treating the anti-spam/duplicate-submission behavior as proven.
Risk: Low-Medium.
Confidence: Medium (route not fully read).

### Offer generation and candidate self-service accept/decline
Capability: issue a formal offer document, hand the candidate a private link, record their decision.
Status: COMPLETE
Evidence: EV-2024, EV-2025
Files: src/lib/documents/candidate.ts, src/app/offer/[token]/route.ts, src/app/offer/[token]/pdf/route.ts
Functions/classes: `grantCandidateAccess`, `candidateOffer`, `candidateOfferPdf`, `answerOffer`
DB tables: CandidateDocumentAccess, IssuedDocument, DocumentAcknowledgement, NotificationOutbox
Tests: documents-phase2.test.ts covers the CANDIDATE_CLOSED validation error (EV-2027's grep result)
Observed behavior: the offer link token is stored only as a hash (`tokenHash`) plus an HR-recoverable
encrypted copy (`tokenEnc`, via `decryptField`/`encryptField`); the outbox email to the candidate carries
no personal data beyond the offer number and the link; accept/decline is enforced idempotent (a unique
DB constraint turns a repeat answer into a 409 "already answered", not a silent overwrite); staff
(requester + approvers) are notified via `enqueueNotice` on the candidate's answer.
Missing pieces: acceptance does not itself trigger anything on the `JobApplication` (HR must still
manually move it to HIRED) — this is a reasonable human-in-the-loop design choice, not a defect, but it
means the "signal" from a candidate accepting is easy for HR to miss if they don't check `/offer`
notifications; not verified whether the notification is surfaced prominently in the HR UI.
Risk: Low.
Confidence: High.

### CV parsing
Capability: extract structured candidate data from an uploaded CV.
Status: MISSING
Evidence: no CV-parsing library, route, or service found; `resumeUrl` is stored as an opaque uploaded-file
URL or external link (`zStaffResumeUrl`) with no processing.
Risk: Low (feature absence, not a defect).
Confidence: High.

### Screening / evaluation / scoring / assessments
Capability: structured candidate scoring, interview scorecards, or assessment results.
Status: MISSING
Evidence: EV-2020 (no score/assessment fields on JobApplication, no child model), EV-2027 (negative grep)
Risk: Medium — HR relies entirely on free-text `notes` for evaluation; there is no comparable/structured
data to base a hiring decision on, and no audit trail of *why* a candidate was moved or rejected beyond
whatever text HR chooses to write.
Confidence: High.

### Talent pool
Capability: a pool of rejected-but-promising or not-yet-placed candidates for future vacancies.
Status: MISSING
Evidence: EV-2026
Risk: Low (feature absence).
Confidence: High.

### Recruitment analytics
Capability: funnel/conversion reporting for the hiring pipeline (time-to-hire, source, etc.).
Status: MISSING
Evidence: no recruitment-specific analytics route or dashboard found in `src/app/api` or `src/app`
beyond the raw pipeline list in `/applications` and `/recruitment`; `src/app/api/workforce/benchmarks/_load.ts:120`
uses the earliest HIRED application's `updatedAt` as one input to a workforce benchmark, which is a
side-use, not a recruitment analytics feature.
Risk: Low.
Confidence: Medium.

### Candidate -> Offer -> Hire -> Employee conversion
Capability: a candidate marked HIRED becomes a real Employee record (or at minimum an OnboardingRequest),
completing the recruitment-to-onboarding lifecycle.
Status: **DISCONNECTED**
Evidence: EV-2022, EV-2023
Files: src/app/api/applications/route.ts (UPDATE_STATUS handler, HIRED is just another status value),
src/app/applications/page.tsx:357 (button labeled "قبول التوظيف ومباشرة" — "accept hiring and start" — calls
the same status-update endpoint), prisma/schema.prisma (`OnboardingRequest` has no `jobApplicationId`)
DB tables: JobApplication, OnboardingRequest, Employee (no relation path between the first and the other two)
Observed behavior: setting `JobApplication.status = HIRED` only updates that one row and writes an audit
log entry (action APPROVE, entityType JobApplication). No code anywhere creates an `Employee`, creates an
`OnboardingRequest`, or writes any cross-reference. The UI button's Arabic label ("...ومباشرة" = "...and
starts work") actively implies onboarding begins automatically, which it does not — HR must separately,
manually go to manager-portal or incoming-requests and fill out a brand-new `OnboardingRequest` with no
prefill from the candidate's application data (name, phone, email, resume, job title, department all have
to be re-typed).
Missing pieces: any linkage at all between a hired candidate and the onboarding/employee-creation flow.
Risk: **High** (verifier-adjusted from Critical; see "Adversarial verification" below) — this is the core "so what happens after I hire someone" promise of an ATS, and it is
not implemented; it is also a data-entry and error-prone risk (mismatched name/iqama transcription between
the two independent forms) and a good candidate for building the OnboardingRequest pre-filled from
JobApplication data plus a `jobApplicationId` FK, mirroring the `DocumentRequest`/`IssuedDocument` pattern
that already links `jobApplicationId` for candidate documents.
Confidence: High (exhaustive grep for `HIRED` and for any employee/onboarding-creation call site
triggered from recruitment code found nothing).

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| A job request only accepts applications while APPROVED | code comment "vacancy is open" | src/app/api/recruitment/shared.ts:21; enforced in src/app/api/applications/route.ts:223-225 | none found | Recruitment | No |
| OFFERED is only reachable from INTERVIEW (prevents duplicate offer e-mails) | src/app/api/recruitment/shared.ts:47-56 comment | APPLICATION_TRANSITIONS | none found | Recruitment | No |
| Offer e-mail content is built ONLY from `offerText`, never from internal notes | code comment "HR-09" | src/app/api/applications/route.ts:144-149 | none found | Recruitment | No |
| A candidate document (offer) cannot be issued for a CLOSED (HIRED/REJECTED) candidate | src/lib/documents/types.ts:1534 | types.ts `CANDIDATE_CLOSED` check | documents-phase2.test.ts:383 | Recruitment, Documents | No |
| Interview date must be set when moving to INTERVIEW | src/app/api/applications/route.ts:143 | inline check | none found | Recruitment | No |

## Edge cases checked

- **Re-approving/double-clicking a status change**: guarded by `APPLICATION_TRANSITIONS`/`JOB_REQUEST_TRANSITIONS` plus an optimistic `updateMany` that reports a 409 conflict on a stale state, rather than silently reapplying (EV-2019, EV-2021). Finding: handled.
- **Concurrent HR edits to the same candidate's notes**: the current `notes` value is included in the update's `where` filter, turning a race into a conflict rather than a lost write (EV-2021). Finding: handled.
- **Candidate answers an expired or withdrawn offer link**: `answerOffer`/`candidateOfferPdf` explicitly check `expiresAt` (410 Gone) and `document.status !== 'ISSUED'` (409 "offer withdrawn") (EV-2024). Finding: handled.
- **Candidate answers twice**: unique constraint on the acknowledgement turns the second answer into a 409 (EV-2024). Finding: handled.
- **A candidate is HIRED**: no onboarding/employee record is created — see DISCONNECTED finding above. Finding: **gap**, not handled.
- **Arabic candidate names/phones**: `normalizePhone` converts Arabic-Indic digits to Latin before validation (src/app/api/recruitment/shared.ts:62-73). Finding: handled.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 05 Recruitment | 10 | 4 | 1 | 0 | 0 | 4 | 0 | 0 | 1 | 0 | 0 | Candidate->Employee conversion on HIRED is DISCONNECTED (High; verifier-adjusted from critical); scoring/assessment, talent pool, CV parsing, analytics all MISSING; zero dedicated test coverage of the pipeline state machine | High |

## Adversarial verification

**B-1: Candidate -> Offer -> Hire -> Employee/Onboarding conversion. Verdict: ADJUSTED. Status stays DISCONNECTED; severity goes from Critical to High.**

- **What holds.** I tried to refute the claim and could not. `UPDATE_STATUS` with `HIRED` (src/app/api/applications/route.ts:141-187) makes only three writes: a guarded `jobApplication.updateMany`, a note append and an audit log with action APPROVE. The only other write paths on a candidate are `src/lib/documents/candidate.ts` and `/offer/[token]`. Issuing an offer moves the application to OFFERED. When the candidate accepts, the system records an acknowledgement and notifies staff, and nothing more: it does not set HIRED, create an Employee or create an OnboardingRequest (EV-2902). Only three call sites create an employee: `src/app/api/employees/route.ts:211`, `src/app/api/employees/import/route.ts:661` and `src/app/api/incoming-requests/route.ts:1129`. None of them reads a JobApplication. There is no FK in either direction between `JobApplication` and `Employee`/`OnboardingRequest` (EV-2903). The finding cited the model at schema lines 1246-1248; it is actually at 1255-1278.
- **Detail corrected.** The finding says HR must re-key the data "into a completely separate manager-portal onboarding form". That is not accurate. HR can create the employee directly with `POST /api/employees` (ROLE_GROUPS.HR, EV-2900). The manager-portal `SUBMIT_ONBOARDING` form is a second, manager-side path. Both paths are manual and neither pre-fills anything from the candidate, so the disconnection is real.
- **Detail corrected (UI framing).** The report says the button label "implies onboarding begins automatically". The label does say "ومباشرة" ("and start work"). However, the modal it opens is titled "اعتماد التوظيف ونقل الملف للأرشيف" ("approve hiring and move the file to the archive") (EV-2901), and that matches what the code does. So the label is misleading, but the UI does not claim end to end that an employee is created.
- **Why the severity drops.** This is a missing integration with a working manual path (the direct employee-create form, plus the manager onboarding request). No data is lost. There is no security, legal or payroll-correctness exposure. The approval-side safeguards also catch transcription errors: the duplicate-iqama 409 and the data-review flags (see 06). The costs are re-keying effort, transcription risk, and lost traceability from employee back to the candidate and their offer letter. That makes this a High functional gap, not Critical.

New evidence: EV-2900, EV-2901, EV-2902, EV-2903.
