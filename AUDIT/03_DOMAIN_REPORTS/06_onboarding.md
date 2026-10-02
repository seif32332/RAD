# 06 Onboarding

## Scope and method

Read `src/app/api/dashboard/onboarding.ts` in full (and found it is NOT the new-hire onboarding module —
see finding below). Read the `OnboardingRequest` model block in `prisma/schema.prisma` in full. Read the
approval transaction in `src/app/api/incoming-requests/route.ts:1080-1220` in full (employee-creation
path) and the creation call site in `src/app/api/manager-portal/route.ts:445-480`. Read
`src/lib/__tests__/r3-hubs-onboarding.test.ts` in full. Ran negative greps for onboarding-checklist,
orientation, equipment, and training models/routes across `src/app`, `src/lib`, and the schema. Did not
read `src/app/api/incoming-requests/route.ts` end to end (only the OnboardingRequest-specific sections)
and did not read `src/app/api/incoming-requests/_lib.ts` beyond what the test file exercises.

## Capability findings

### Onboarding request submission
Capability: a manager submits a new-hire's data (personal, ID, contact, assignment, bank, attachments) for HR review.
Status: COMPLETE
Evidence: EV-2012, EV-2013
Files: src/app/api/manager-portal/route.ts:445-480, prisma/schema.prisma:1281-1337
DB tables: OnboardingRequest
API routes: POST /api/manager-portal (creates OnboardingRequest)
UI routes: manager-portal (page not opened in this pass)
Observed behavior: a single form captures personal data, iqama/passport numbers and expiries, contact
info, assignment (branch/administration/department/directManager/jobTitle/joinDate/contractType), bank
details, and six document-attachment URLs (iqama/passport/iban/resume/workContract/health). Status starts
PENDING.
Missing pieces: form/route itself (validation specifics) not read in this pass.
Risk: Low.
Confidence: Medium (creation site confirmed; validation depth not verified).

### HR review, approval and Employee creation
Capability: HR reviews a pending onboarding request, can edit fields, approves it, and a real Employee
record is created transactionally.
Status: COMPLETE
Evidence: EV-2014, EV-2016
Files: src/app/api/incoming-requests/route.ts:1080-1210
Functions/classes: `onboardingRequestUpdate`, `nextEmployeeCode`, `onboardingPlaceholderFields`,
`onboardingDataReviewNote`, `onboardingNationality`
DB tables: OnboardingRequest, Employee
API routes: POST /api/incoming-requests (approve action)
Tests: src/lib/__tests__/r3-hubs-onboarding.test.ts (pure-helper unit tests only)
Observed behavior: single transaction does duplicate-iqama check (`employee.findUnique({iqamaOrIdNumber})`
-> 409 conflict naming the existing employee code if found), org-unit existence checks, direct-manager
validity check, employee-code allocation with retry on unique-violation
(`EMPLOYEE_CODE_ATTEMPTS`/`isUniqueViolationOn`), `onboardingRequest.updateMany` guarded to PENDING only
(optimistic concurrency -> 409 "already processed"), then `employee.create()` with required-but-missing
dates (dateOfBirth/iqamaOrIdExp/joinDate) defaulted to today() and flagged via `dataReviewNote` and a
`hrNote` placeholder note so HR is told to go complete them on the employee file; nationality is never
silently assumed Saudi for a blank value (would silently mis-deduct GOSI) — it is flagged
`UNSPECIFIED_NON_SAUDI_NATIONALITY` for review instead; two audit-log entries (OnboardingRequest APPROVE,
Employee CREATE with `source: 'OnboardingRequest'` and `needsCompletion` list).
Missing pieces: the approval transaction itself has no direct integration test (only the pure helper
functions it calls are unit-tested); no test drives the actual `employee.create()` / duplicate-detection /
retry-on-collision logic end-to-end.
Risk: Low-Medium (the logic itself is careful and defensive; the gap is test coverage of the transaction,
not an observed defect).
Confidence: High.

### Rejection flow
Capability: HR rejects a pending onboarding request with a reason.
Status: COMPLETE
Evidence: EV-2015
Files: src/app/api/incoming-requests/route.ts:1212-1220
Observed behavior: guarded to PENDING only, optional `hrNote` reason recorded, audit-logged.
Risk: Low.
Confidence: High.

### "Onboarding" dashboard checklist (naming false positive)
Capability: N/A — this is a company/tenant setup checklist, not new-employee onboarding.
Status: N/A (documented here to prevent double-counting in the audit)
Evidence: EV-2011
Files: src/app/api/dashboard/onboarding.ts
Observed behavior: tracks whether the tenant has at least one company, branch, work schedule, imported
employees, linked login accounts, and a first payroll run — a first-run setup wizard for the whole
system, unrelated to any individual employee's onboarding journey.
Risk: N/A.
Confidence: High.

### Onboarding checklist / task tracking (equipment, access account, orientation, training)
Capability: a per-hire checklist of onboarding tasks (issue equipment, create login account, schedule
orientation, assign training, track completion).
Status: MISSING
Evidence: EV-2010, EV-2017
Observed behavior: none of these concepts exist as data (no fields on `OnboardingRequest`, no separate
model). Once `Employee` is created, "linking a login account" is step 5 of the unrelated *company-setup*
checklist above (EV-2011) — a manual action an admin takes from `/settings/users`, not something driven by
or tracked against the specific onboarding case.
Missing pieces: everything past "the Employee row exists" — no structured, trackable onboarding journey
(equipment, IT access, orientation scheduling, training assignment, progress/completion percentage,
reminders to the manager or new hire).
Verifier note: status confirmed MISSING. Some adjacent steps do exist but are not tied to any onboarding case: an automatic WORK_COMMENCEMENT notice on approval (EV-2904), `dataReviewNote` data-completion flags (EV-2905), equipment custody in the Asset module (EV-2906) and probation-end alerts (EV-2907).
Risk: Medium (verifier-adjusted from High; see "Adversarial verification") — for a product marketed as covering the onboarding lifecycle end to end (per the audit brief:
templates, checklists, document collection, contract, government procedures, bank info, insurance,
equipment, access, orientation, training, manager assignment, probation, progress, reminders,
completion), only "document collection" (via the six attachment URLs) and "manager assignment" (via the
`directManagerId` field) are actually implemented; the rest is absent.
Confidence: High (exhaustive negative search of schema and routes for these concepts).

### Government procedures / bank info / insurance during onboarding
Capability: capturing and tracking government-procedure status, bank account, and insurance enrollment as
part of bringing a new hire on board.
Status: PARTIAL
Evidence: EV-2012 (bank fields exist: bankName/ibanNumber/basicSalary + ibanCertificateUrl)
Observed behavior: bank info is captured on the request and flows into the Employee record; no
government-procedure (Muqeem/visa/work-permit) fields on `OnboardingRequest` itself — those live entirely
in the separate Visa/Muqeem modules once the employee exists; no insurance-enrollment step here (medical
insurance is company-level, `MedicalInsurance`, not tied to individual onboarding).
Missing pieces: no explicit onboarding-stage link to Muqeem/visa processing or insurance enrollment.
Risk: Medium.
Confidence: Medium.

### Probation tracking as an onboarding step
Capability: track the probation period as part of the onboarding journey (reminders, extension, conversion
to permanent).
Status: MISSING (as an onboarding capability)
Evidence: EV-2017 — `probationEndDate` exists on `Employee` and is consumed by the renewals queue
(`src/app/api/renewals/route.ts:278`, threshold `t.probation`) and by termination (`ARTICLE_87`/probation
termination reason), but this is a post-hire HR/termination concern, not something the onboarding flow
itself surfaces, schedules, or checklists.
Risk: Low (the underlying data exists and is alerted on elsewhere; it's simply not framed as an onboarding
step).
Confidence: Medium.

### Recruitment -> Onboarding link
Capability: a hired candidate flows into the onboarding process without manual re-entry.
Status: **DISCONNECTED**
Evidence: EV-2022, EV-2023, EV-2013 (see full analysis in `05_recruitment.md`, "Candidate -> Offer -> Hire
-> Employee conversion")
Observed behavior: `OnboardingRequest` has no `jobApplicationId` and no code path creates one from a
`JobApplication`. A hired candidate's data (name, phone, email, resume) is never carried into the
onboarding form; HR must re-enter everything by hand through the unrelated manager-portal flow.
Risk: High (verifier-adjusted from Critical; duplicated in the Recruitment report; listed here too since it is squarely this domain's
entry point).
Confidence: High.

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| A duplicate iqama/ID number blocks onboarding approval, naming the existing employee | code (no doc comment found citing an ADR) | src/app/api/incoming-requests/route.ts:1104-1109 | none direct | Onboarding, Core HR (identity uniqueness) | No |
| Missing required dates (DOB, iqama expiry, join date) are never silently defaulted without a visible flag | inline comment "HR must complete them" | src/app/api/incoming-requests/route.ts:1111-1117,1136-1163; helpers in incoming-requests/_lib.ts | r3-hubs-onboarding.test.ts | Onboarding, Core HR | No |
| A blank nationality is never assumed Saudi (would silently affect GOSI) | test comment "GOSI would be deducted silently" | onboardingNationality() in incoming-requests/_lib.ts | r3-hubs-onboarding.test.ts:57-61 | Onboarding, Payroll/GOSI compliance | No |
| An onboarding request can only be approved/rejected once (PENDING-guarded) | inline comment | src/app/api/incoming-requests/route.ts:1119-1123, 1214-1218 | none direct | Onboarding | Yes — same optimistic-concurrency pattern used across JobRequest/JobApplication (05) |

## Edge cases checked

- **Duplicate national ID / iqama submitted twice**: explicit `findUnique` check inside the approval transaction returns a 409 naming the existing employee code (EV-2014). Finding: handled.
- **Missing required dates on the onboarding form**: defaulted to today() but flagged via `dataReviewNote`/`hrNote` for mandatory follow-up, never silently accepted as correct (EV-2014, EV-2016). Finding: handled.
- **Blank/ambiguous nationality (Saudi-alias vs. truly unspecified)**: `onboardingNationality()` distinguishes Saudi aliases (normalized to the canonical Arabic label), the legacy "NON_SAUDI"/"غير محدد" placeholder, and a truly blank value — all non-Saudi-alias cases are flagged `needsReview: true` rather than guessed (EV-2016). Finding: handled, and notably careful (explicit GOSI-risk comment in the test).
- **Concurrent double-approval / double-rejection of the same request**: PENDING-guarded `updateMany` -> 409 on the second attempt (EV-2014, EV-2015). Finding: handled.
- **Employee-code collision on creation**: retried up to `EMPLOYEE_CODE_ATTEMPTS` on a unique-violation (EV-2014). Finding: handled.
- **Hired candidate needing onboarding**: no automatic linkage; full manual re-entry required (see DISCONNECTED finding). Finding: gap.
- **Onboarding progress after the Employee row is created**: nothing tracks whether equipment/access/orientation/training were completed for that specific hire. Finding: gap (MISSING capability, not merely an edge case).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 06 Onboarding | 9 | 3 | 2 | 0 | 0 | 3 | 0 | 0 | 1 | 0 | 0 | Recruitment->Onboarding link is DISCONNECTED (High, verifier-adjusted from critical, shared with domain 05); onboarding checklist/task-tracking (equipment, access, orientation, training, progress) is MISSING as a per-hire journey (Medium, verifier-adjusted from High; adjacent automation exists) | High |

## Adversarial verification

**B-1: Recruitment -> Onboarding link. Verdict: ADJUSTED. Status stays DISCONNECTED; severity goes from Critical to High.**
The full reasoning is in `05_recruitment.md` under "Adversarial verification". In short:
- There is no FK in either direction between `JobApplication` and `OnboardingRequest`/`Employee` (EV-2903).
- Neither the HIRED transition nor the candidate's offer acceptance creates anything (EV-2902).
- HR is not forced through the manager-portal form: `POST /api/employees` is a direct HR path (EV-2900). It is equally manual and has no candidate prefill.
- The HIRED modal frames the step as "approve hiring and archive the file" (EV-2901).
- A manual workaround exists and no data, legal or payroll exposure was found, so the severity is High.

**B-2: Onboarding checklist / task tracking. Verdict: ADJUSTED. Status stays MISSING; severity goes from High to Medium; detail corrected.**
- **What holds.** No Task, Checklist, Training, Course or Orientation model exists, and no per-hire progress or completion state exists (EV-2908). The only "onboarding checklist" in the code is the admin company-setup widget (src/app/page.tsx:185,390-391, fed by src/app/api/dashboard/onboarding.ts), which the report already identified. Nothing records orientation, training assignment, login-account creation or overall completion for a given hire.
- **Overstated: "once HR approves ... nothing" happens or is tracked.** Four things do exist, but none of them forms a checklist or is tied to an onboarding case:
  - (a) Approving an onboarding request automatically issues a WORK_COMMENCEMENT notice through the document engine (src/app/api/incoming-requests/route.ts:715 -> src/lib/documents/service.ts:1068-1094; EV-2904).
  - (b) Placeholder data is flagged on the employee file and in the employee list via `dataReviewNote` (EV-2905).
  - (c) Equipment issuance is recorded in the custody module (`Asset.employeeId`/`receiveDate`, `AssetRequest`; EV-2906), so "nothing tracks equipment issuance" is not accurate.
  - (d) Probation end is alerted (src/lib/alerts.ts:115; EV-2907).
- **Why the severity drops.** This is a missing convenience and orchestration layer over steps that can each be carried out, and partly are recorded, elsewhere. There is no integrity, security or compliance exposure. That makes it a Medium product gap, not High.

Matrix rows updated in `AUDIT/_work/matrix_B.md` (criticality only; the statuses did not change, so the scorecard counts are unchanged).
New evidence: EV-2900 to EV-2908.

## Orchestrator tie-break (after verification)

The adversarial verifier for B-2 wrote that approving an onboarding request "automatically issues a WORK_COMMENCEMENT notice". The cross-domain auditor (lifecycle L3) said the notice is always SKIPPED. The orchestrator checked the code directly:

- `approveOnboarding` creates the Employee without `legalCompanyId` / `actualCompanyId` (`src/app/api/incoming-requests/route.ts:1129-1163`, EV-0026).
- `createDocumentRequest` rejects any employee without `legalCompanyId`, and `issueCommencementNotice` turns that rejection into `'SKIPPED'` (`src/lib/documents/service.ts:186-187, 1080-1090`, EV-0027).

Conclusion: the notice is **attempted** automatically but is **skipped for every new hire created through onboarding**, and it is not retried. The same missing legal company blocks every official document for that employee (letters, payslips as documents, certificates) until HR edits the employee file. The capability "Work commencement notice on onboarding approval" is **DISCONNECTED**, High, confidence High.
