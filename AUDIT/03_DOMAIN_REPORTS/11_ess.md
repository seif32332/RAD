# 11 Employee self service (ESS)

## Scope and method

Read `src/app/portal/page.tsx` (1862 lines, full), `src/app/portal/_components/*` (ClockCard,
FaceCameraModal, DocumentsCard, TotalRewardsCard, CircularsSection, PortalTabBar,
UnlinkedAccountCard), `src/app/api/portal/**/route.ts` (route.ts, attendance/route.ts,
attendance/punch/route.ts, correction/route.ts, face/route.ts, termination/route.ts,
total-rewards/route.ts + total-rewards/pdf/route.ts by name), `src/app/my-documents/page.tsx`,
`src/app/asset-request/page.tsx`, `src/lib/auth.ts` (requireEmployeeId/requireUser),
`src/lib/hr-workflows.ts` (assertCanManageEmployee/managedEmployeesWhere),
`src/lib/position-tracker.ts`, `src/lib/self-attendance*.ts` by grep, and the portal-relevant test
files `c2-portal.test.ts`, `r3-hubs-portal.test.ts`, `self-attendance.test.ts`,
`self-attendance-jobs.test.ts`. IDOR check method: for every portal write route, traced where the
acted-on `employeeId` comes from (session vs. client body/query).

## Capability findings

### Profile / dashboard (GET /api/portal)
Capability: employee views own salary, allowances, branch, company, insurance summary.
Status: COMPLETE
Evidence: EV-6001, EV-6007
Files: src/app/api/portal/route.ts:77-124; src/lib/auth.ts:115-119
Functions/classes: GET() in route.ts; requireEmployeeId()
DB tables: Employee, Department, Branch, Company, MedicalInsurance
API routes: GET /api/portal
UI routes: /portal
Tests: none dedicated to this GET handler (only client-side helpers in r3-hubs-portal.test.ts)
Observed behavior: `employeeId` is derived exclusively via `requireEmployeeId(user)` from the
session (route.ts:83); no employeeId is ever read from query string or body. A user without a
linked Employee gets 404 with an "unlinked account" message, not another employee's data.
Missing pieces: no server-side test asserting the 404-vs-leak behavior; relies on manual trace.
Risk: Low (design is IDOR-safe; only a test-coverage gap).
Confidence: High

### IDOR protection across ESS write endpoints
Capability: an employee cannot act on another employee's records via API parameter tampering.
Status: COMPLETE
Evidence: EV-6001, EV-6002, EV-6003, EV-6004, EV-6005, EV-6006, EV-6007
Files:
- src/app/api/portal/route.ts:83 (GET, employeeId from session only)
- src/app/api/portal/attendance/punch/route.ts:67-68 (POST punch, employeeId from session)
- src/app/api/portal/correction/route.ts:34-36 (POST correction: `if (body.employeeId && body.employeeId !== employeeId) throw forbidden(...)`)
- src/app/api/portal/face/route.ts:48-49 (POST/PATCH/DELETE face enrollment, employeeId from session)
- src/app/api/portal/termination/route.ts:27-30 (POST, same guard pattern as correction)
- src/app/api/portal/total-rewards/route.ts:15-23 (GET, zod `.strict()` schema explicitly refuses
  any `employeeId` in the query string, comment: "The employee is taken from the session ONLY: any
  other query parameter (employeeId…) is refused (400)")
Functions/classes: requireEmployeeId (src/lib/auth.ts:115-119)
DB tables: Employee, Leave, Loan, AttendanceCorrection, TerminationRequest, FaceProfile,
AttendancePunch, Attendance
API routes: POST /api/portal/attendance/punch, /api/portal/correction, /api/portal/face,
/api/portal/termination; GET /api/portal/total-rewards
UI routes: /portal
Tests: c2-portal.test.ts (indirect, HR-workflow level, not the route handlers themselves)
Observed behavior: every write route recomputes `employeeId` server-side from the JWT session via
`requireEmployeeId`; a client-supplied `employeeId` in the body (kept only for a legacy field the
page still sends) is either ignored or, where still accepted, compared against the session value
and rejected with 403 on mismatch. No route trusts a client-supplied id to select which employee's
row is read or written.
Missing pieces: none found; this is a genuinely consistent pattern across all 6 routes checked.
Risk: Low.
Confidence: High

### Attendance (self clock-in/out, GPS + face)
Capability: employee clocks in/out from the portal with geofence + face-match checks; server owns
the timestamp.
Status: COMPLETE
Evidence: EV-6002, EV-6015, EV-6016
Files: src/app/api/portal/attendance/punch/route.ts (full, 273 lines); src/app/portal/_components/ClockCard.tsx (512 lines); src/app/portal/_components/FaceCameraModal.tsx (265 lines); src/lib/position-tracker.ts
Functions/classes: POST() punch handler; PositionTracker class; getUserMedia capture
DB tables: AttendancePunch, Attendance, FaceProfile
API routes: POST /api/portal/attendance/punch, GET /api/portal/attendance, POST /api/portal/face
UI routes: /portal (ClockCard section)
Tests: src/lib/__tests__/self-attendance.test.ts (333 lines), self-attendance-jobs.test.ts (53 lines)
Observed behavior: server time (`now`) is always used for the stored check-in/out, never a
client-supplied timestamp (punch/route.ts:163,180,201). Location and face checks run server-side
against `Attendance`/`FaceProfile`, with a durable per-employee rate limit
(`MAX_PUNCHES_PER_WINDOW`, punch/route.ts:37-38,112-115) plus an in-memory `rateLimit()`. The whole
punch is wrapped in `prisma.$transaction` with `lockEmployeeForUpdate` to prevent double-tap races
(punch/route.ts:156-161). This was already reviewed in depth by the C-group attendance specialist
per MEMORY.md ("Self-attendance implementation" note: base pushed, review fixes committed locally
c0b64c3/7dc214e, laptop test still pending) — this ESS review corroborates the code is real,
non-mocked, IDOR-safe, and covered by tests.
Missing pieces: per MEMORY.md the review-fix commits (c0b64c3, 7dc214e) are local/unpushed and a
laptop (real-device) test is still pending; that device-level verification is outside what static
code reading can confirm.
Risk: Low from a code-audit standpoint; Medium operationally until the pending device test is done.
Confidence: High

### Leave requests, balance, cancellation
Capability: employee requests leave, sees live server-calculated balance/preview, cancels a pending
leave.
Status: COMPLETE
Evidence: (portal page) src/app/portal/page.tsx:300-432 (balance load, debounced preview via
GET /api/leaves/preview), :435-465 (cancel via POST /api/leaves/{id}/action), :645-685 (submit via
POST /api/leaves)
Files: src/app/portal/page.tsx
Functions/classes: loadCurrentBalance, handleCancelLeave, handleLeaveSubmit
DB tables: Leave (via /api/leaves, outside this domain's file set but referenced)
API routes: GET /api/leaves/balance, GET /api/leaves/preview, POST /api/leaves,
POST /api/leaves/{id}/action
UI routes: /portal
Tests: not directly (leave calculation tests live in the C-group attendance/leave domain reports)
Observed behavior: balance and preview are always fetched from the server for the exact dates
typed (page.tsx:347-383, 404-429), not computed client-side and trusted; a `confirmDialog` guards
the destructive cancel action (page.tsx:437-443). Client-side checks (excess days, unpaid-leave
block) mirror but do not replace the server's `issue` field from the preview
(`previewBlocked`, page.tsx:857-860), so a client bypass still hits the same server validation.
Missing pieces: none observed within this file; deeper leave business-rule correctness is Domain 08
(Leave)'s responsibility, not re-verified here.
Risk: Low.
Confidence: Medium (balance/leave calculation internals not re-derived here, only the ESS request
path).

### Attendance correction requests (self-service)
Capability: employee requests a fingerprint/attendance correction, optionally linked to a rejected
self-punch.
Status: COMPLETE
Evidence: EV-6003
Files: src/app/api/portal/correction/route.ts (94 lines, full); src/app/portal/page.tsx:593-628
(handleCorrectionSubmit), :630-638 (openCorrectionForPunch, prefilled from a rejected punch)
Functions/classes: POST() in correction/route.ts
DB tables: AttendanceCorrection, AttendancePunch
API routes: POST /api/portal/correction
UI routes: /portal
Tests: none route-specific found; workflow-level tests in c2-portal.test.ts cover the *approval*
side (DOM-006), not this creation route.
Observed behavior: when linked to a punch, the punch's `employeeId` is re-checked against the
session employee (correction/route.ts:56) — a second IDOR guard beyond the top-level one. Duplicate
pending requests with the same reason are blocked (route.ts:44-50), and a duplicate correction for
the same punch is blocked separately (route.ts:59-64).
Missing pieces: no dedicated test file for this route.
Risk: Low.
Confidence: High

### Loan request
Capability: employee requests a salary advance from the portal.
Status: PARTIAL
Evidence: src/app/portal/page.tsx:687-730 (handleLoanSubmit, posts to POST /api/payroll-hub with
`actionType: 'CREATE_LOAN'`)
Files: src/app/portal/page.tsx
Functions/classes: handleLoanSubmit
DB tables: Loan (via payroll-hub, not read in this pass)
API routes: POST /api/payroll-hub
UI routes: /portal
Tests: not verified in this pass (payroll-hub is Domain 09's file, out of this group's assigned
scope)
Observed behavior: client-side validates amount > 0, installment > 0, installment <= amount
(page.tsx:690-699) before posting; the actual server-side authorization/validation of
`CREATE_LOAN` (who may request for whom, employeeId binding) lives in `/api/payroll-hub`, which is
Domain 09/16's file, not re-read here — cannot confirm its own IDOR posture from this pass.
Missing pieces: server-side verification of payroll-hub's employeeId binding for CREATE_LOAN was
not independently re-checked by this ESS-focused pass.
Risk: Medium (unverified cross-domain dependency for an IDOR-sensitive action; flagged for
cross-check against Domain 09's report).
Confidence: Low (on the server side only; the client path itself is COMPLETE)

### Letters / certificates (salary certificate, experience letter, employment letter, visit
certificate)
Capability: employee requests official letters, either through the document engine (auto-issue) or
as a manual HR request.
Status: PARTIAL
Evidence: src/app/portal/page.tsx:146-151 (ENGINE_LETTER_TYPES map), :554-561 (openGeneralRequest:
tries the document engine first, falls back to a manual /api/portal/correction request),
src/app/portal/_components/DocumentsCard.tsx (not fully read in this pass; referenced by ref/handle)
Files: src/app/portal/page.tsx; src/app/portal/_components/DocumentsCard.tsx
Functions/classes: openGeneralRequest, DocumentsCard (openRequest handle)
DB tables: n/a directly (delegates to /api/documents/requests, Domain 04's file)
API routes: /api/documents/requests (not re-verified here; Domain 04 owns it)
UI routes: /portal
Tests: not verified (out of this group's file set)
Observed behavior: the fallback path for un-configured companies uses the same
`/api/portal/correction` IDOR-safe route as other general requests (page.tsx:790-805, correctionType
'GENERAL'). The primary path (document engine auto-issue) was not re-verified in this pass — the
working tree has substantial uncommitted document-engine changes per git status (migration
9p_transfer_decision, src/lib/documents/* edits), so its current on-disk state may differ from what
was tested at the last full suite run.
Missing pieces: this pass did not re-read DocumentsCard.tsx or the document-engine service files;
correctness of the auto-issue letter path is Domain 04's responsibility.
Risk: Low-Medium (fallback path is safe; primary path unverified here).
Confidence: Low (deferred to Domain 04)

### Asset (custody) requests, self-service
Capability: employee requests equipment (laptop/mobile/SIM) for themselves.
Status: COMPLETE
Evidence: EV-6012
Files: src/app/api/manager-portal/route.ts:312-319 (assetSchema), :484-509 (REQUEST_ASSET case),
src/app/portal/page.tsx:739-759 (posts REQUEST_ASSET with the logged-in employee.id),
src/app/asset-request/page.tsx (136 lines, the standalone page for managers/logistics)
Functions/classes: POST() manager-portal/route.ts, REQUEST_ASSET branch
DB tables: AssetRequest
API routes: POST /api/manager-portal {actionType:'REQUEST_ASSET'}
UI routes: /portal (general request modal), /asset-request (manager-facing)
Tests: not found dedicated to this branch
Observed behavior: manager-portal/route.ts:485-494 explicitly branches self-service: `isSelf =
user.employeeId === data.employeeId`; a non-manager, non-logistics user may only pass their own id
(`throw forbidden('يمكنك طلب عهدة لنفسك فقط')` otherwise, line 487). The requester recorded is
always `user.employeeId ?? data.employeeId` from the session (line 498), and the comment explicitly
states a client-supplied requesterId is ignored.
Missing pieces: no dedicated automated test for the self-vs-manager branch found.
Risk: Low.
Confidence: High

### Contract termination / resignation request
Capability: employee requests to end their own contract.
Status: COMPLETE
Evidence: EV-6005
Files: src/app/api/portal/termination/route.ts (69 lines, full); src/app/portal/page.tsx:563-591,
863-872 (confirmDialog before opening the form)
Functions/classes: POST()
DB tables: TerminationRequest
API routes: POST /api/portal/termination
UI routes: /portal
Tests: none dedicated
Observed behavior: duplicate pending requests for the same employee are blocked inside a
`prisma.$transaction` with `lockEmployeeForUpdate` (route.ts:32-39), preventing a race from creating
two pending termination requests. A confirmation dialog is shown before the form even opens
(page.tsx:863-872) — this is one of the few destructive/formal actions with an explicit two-step
confirmation in the ESS UI.
Missing pieces: none found.
Risk: Low.
Confidence: High

### Face enrollment / biometric consent lifecycle
Capability: employee enrolls, renews consent for, or withdraws their own biometric face template.
Status: COMPLETE
Evidence: EV-6004
Files: src/app/api/portal/face/route.ts (239 lines, full: POST enroll, PATCH consent renewal,
DELETE withdrawal)
Functions/classes: POST, PATCH, DELETE handlers
DB tables: FaceProfile
API routes: POST/PATCH/DELETE /api/portal/face
UI routes: /portal (FaceCameraModal)
Tests: not directly (self-attendance.test.ts covers matching/decision logic, not this route)
Observed behavior: enrollment requires geofence presence (unless exempt), liveness + quality
thresholds, and a cross-employee duplicate-face check that blocks and audits at the ACCEPT
threshold (route.ts:114-135) — a genuine anti-fraud control, not a UI-only gate. Withdrawal (DELETE)
deletes the embedding/photo and marks the row `FACE_PROFILE_WITHDRAWN`, requiring HR to re-open
enrollment (route.ts:212-238) — this is a real PDPL-consistent lifecycle, not a stub.
Missing pieces: none found in this pass.
Risk: Low.
Confidence: High

### Payslip view / print
Capability: employee views recent payslips and prints one.
Status: PARTIAL
Evidence: src/app/portal/page.tsx:42-47 (PortalPayroll interface, data from GET /api/portal),
:817-841 (printPayslip: opens a new window and writes a client-built HTML payslip)
Files: src/app/portal/page.tsx
Functions/classes: printPayslip
DB tables: Payroll (read via GET /api/portal, payrolls relation, take 5, status != DRAFT —
route.ts:94-98)
API routes: GET /api/portal
UI routes: /portal
Tests: none
Observed behavior: the "print" is a client-side HTML page built from already-fetched JSON
(escaped via `escapeHtml`, page.tsx:193-195) — not a server-rendered/signed PDF. This is materially
different from the document-engine PDFs (Typst-rendered, per SYSTEM_MAP) used for official letters.
It is a genuine payslip view, but the printable artifact is not an official, tamper-evident
document.
Missing pieces: no official PDF payslip (compare with the document engine's letters); only the last
5 non-draft payrolls are shown (route.ts:94-98, take 5) — no full salary-history page/pagination was
found for the employee to see older payrolls than the most recent 5.
Risk: Low (cosmetic/product-completeness gap, not a security issue).
Confidence: High

### Total rewards statement
Capability: employee views/downloads own compensation statement (SPEC §9), company-gated.
Status: COMPLETE
Evidence: EV-6006
Files: src/app/api/portal/total-rewards/route.ts (37 lines, full); src/app/portal/_components/TotalRewardsCard.tsx (referenced, not fully read)
Functions/classes: GET()
DB tables: n/a directly (delegates to loadTotalRewards in workforce/total-rewards/_load)
API routes: GET /api/portal/total-rewards, GET /api/portal/total-rewards/pdf
UI routes: /portal
Tests: not verified in this pass (Domain 22/Workforce owns loadTotalRewards internals)
Observed behavior: the query schema is `.strict()` and explicitly documented to reject any
employeeId param (route.ts:15-17); a feature flag (`totalRewardsEnabled()`) gates the whole card off
for tenants that have not enabled it, returning `{enabled:false}` rather than a broken UI.
Missing pieces: internals of `loadTotalRewards` not re-verified (Domain 22's territory).
Risk: Low.
Confidence: Medium

### Evaluation acknowledgment
Capability: employee views and acknowledges a completed performance evaluation.
Status: COMPLETE
Evidence: src/app/portal/page.tsx:313-323 (loadPendingEvals from GET /api/evaluations?view=employee-pending),
:467-493 (handleAcknowledge, POST /api/evaluations {action:'EMPLOYEE_ACKNOWLEDGE'})
Files: src/app/portal/page.tsx
Functions/classes: loadPendingEvals, handleAcknowledge
DB tables: Evaluation (Domain 13's file, not re-read)
API routes: GET/POST /api/evaluations
UI routes: /portal
Tests: not verified (Domain 13 territory)
Observed behavior: acknowledgment is per-evaluation-id, posted with an optional employee comment;
UI removes the acked item from the pending list optimistically on success. The evaluation content
itself (scores, comments) is not independently re-verified as IDOR-safe in this pass since the
underlying `/api/evaluations` GET is Domain 13's route.
Missing pieces: none found within the ESS page code itself.
Risk: Low.
Confidence: Medium (route internals deferred to Domain 13)

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Employee acts only on own records | Session JWT `employeeId` | requireEmployeeId (src/lib/auth.ts:115-119), re-checked per route | none direct | 11 | No — single helper reused consistently |
| A manager may not approve their own request | assertCanManageEmployee | src/lib/hr-workflows.ts:282-284 | none direct found | 11, 12 | No |
| General requests (letters/data-update/asset) skip the direct-manager step | isHrDirectRequest | src/lib/hr-workflows.ts (referenced), src/app/api/portal/correction/route.ts:38 | c2-portal.test.ts:171-178 | 11, 12 | No |
| Only the last 5 non-draft payrolls are shown in the portal | hard `take: 5` | src/app/api/portal/route.ts:94-98 | none | 11 | No |
| Total rewards query rejects any client-supplied employeeId | zod `.strict()` schema | src/app/api/portal/total-rewards/route.ts:15-17 | none direct | 11 | No |

## Edge cases checked

- **Employee with no linked Employee record (pure admin account)**: GET /api/portal returns 404
  with a specific message; the portal page shows `UnlinkedAccountCard` instead of crashing
  (portal/route.ts:81-82; page.tsx:325-339, 526-534). Finding: handled. EV-6001.
- **Double-tap punch / two tabs**: guarded by `lockEmployeeForUpdate` + re-planning under the lock
  inside the transaction (punch/route.ts:156-161) and a `stateChanged()` 409 if the plan no longer
  matches. Finding: handled. EV-6002.
- **Rejected self-punch needing a correction**: the portal pre-fills a correction request from the
  rejected punch and links `punchId`, with a server-side check that the punch belongs to the same
  employee (correction/route.ts:54-56). Finding: handled. EV-6003.
- **Concurrent leave-return submissions**: RETURN_FROM_LEAVE in manager-portal/route.ts uses
  `FOR UPDATE` row locking and rejects a second submission with 409 (route.ts:423-432). Finding:
  handled (cross-listed under Domain 12 as well).
- **Employee tries to request an asset for someone else without manager/logistics role**: blocked
  with a specific Arabic message ("يمكنك طلب عهدة لنفسك فقط") — manager-portal/route.ts:487.
  Finding: handled. EV-6012.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 11 ESS | 11 | 8 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Loan-request server-side IDOR posture not independently re-verified (deferred to Domain 09); payslip print is client-built, not the official signed PDF | High (IDOR checks); Medium (cross-domain deferrals) |
