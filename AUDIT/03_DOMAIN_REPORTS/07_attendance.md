# 07 Attendance / Time / Shifts

## Scope and method
I read `src/lib/attendance.ts`, `self-attendance.ts`, `self-attendance-server.ts` and the attendance part of `hr-workflows.ts` (schedule resolution and corrections). I also read the routes `api/attendance-hub`, `api/portal/attendance/punch`, `api/attendance-corrections`, `api/attendance-punches`, `api/attendance-locations`, `api/work-schedules`, `api/portal/face`, and the overtime handlers in `api/payroll-hub`, `api/manager-portal` and `api/incoming-requests`.
Schema: `WorkSchedule`, `Attendance`, `AttendancePunch`, `AttendanceLocation`, `FaceProfile`, `OvertimeRequest`, `AttendanceCorrection`.
To test the Attendance -> Payroll path I read the payroll generation select (`src/lib/payroll.ts:440-520`) and `computePayrollLine` / `overtimeAmount` in `payroll-core.ts`.
I ran 8 existing test files (171 tests, all passing, EV-3029). The tests cover pure functions only; no test exercises an attendance route or the DB.
I did not reuse any claim from docs/council. Evidence IDs are in `AUDIT/_work/ledger_C.md`.

## Capability findings

### Manual attendance entry (HR)
Capability: HR records or edits check-in/check-out for an employee and day.
Status: PARTIAL
Evidence: EV-3011, EV-3002, EV-3004, EV-3010
Files: src/app/api/attendance-hub/route.ts, src/lib/attendance.ts, src/app/attendance/page.tsx
Functions/classes: POST ADD_ATTENDANCE, buildPunches, computeLateEarly, resolveEmployeeSchedule
DB tables: Attendance, WorkSchedule, AuditLog
API routes: GET/POST /api/attendance-hub
UI routes: /attendance
Tests: attendance.test.ts (pure computeLateEarly/buildPunches only)
Observed behavior: HR-only upsert per day. Times are Riyadh wall-clock. Minutes are recomputed from the schedule, or taken from HR's typed values when there is no schedule. Each write is audited as CREATE.
Missing pieces: No guard against a terminated employee, a day covered by an approved leave, or a future date. Status is always PRESENT. No bulk entry and no import.
Risk: Medium. Manual rows can contradict leave records, and nothing detects the contradiction.
Confidence: High

### Self (web/mobile) clock-in with GPS geofence and face verification
Capability: Employee punches IN/OUT from the portal; the server validates location and face.
Status: PARTIAL
Evidence: EV-3012, EV-3013, EV-3014, EV-3015, EV-3016, EV-3017, EV-3018, EV-3061, EV-3029
Files: src/app/api/portal/attendance/punch/route.ts, src/lib/self-attendance.ts, src/lib/self-attendance-server.ts, src/lib/geo.ts, src/lib/face.ts, services/face
Functions/classes: resolvePunchPlan, planForAction, checkLocation, checkFace, decidePunch, loadSelfAttendanceContext
DB tables: Attendance, AttendancePunch, AttendanceLocation, FaceProfile
API routes: POST /api/portal/attendance/punch, GET /api/portal/attendance, /api/portal/face
UI routes: /portal (SelfAttendancePanel)
Tests: self-attendance.test.ts (44), geo.test.ts (13), self-attendance-jobs.test.ts (4), all pure
Observed behavior: The server time is the only clock. The row lock plus re-planning prevents double punches. The face check fails closed. Rejected and flagged selfies are kept as evidence and purged by a job (EV-3057). Every attempt becomes an `AttendancePunch` row and an audit entry.
Missing pieces: (1) The feature is off by default (EV-3015), and the face thresholds are uncalibrated pilot values. (2) The ON_LEAVE flag reads `Employee.employmentStatus`. Only a paid LEAVE_SETTLEMENT sets that status, and nothing ever resets it to ACTIVE (EV-3016, EV-3017). An employee on an approved leave without a settlement punches as ACCEPTED. After any paid leave settlement, every later punch of that employee is FLAGGED ON_LEAVE indefinitely. (3) GPS coordinates and accuracy are client-supplied, so there is no protection against spoofed browser geolocation beyond the face check. (4) The flow has no route-level or face-service integration test in the default run.
Risk: High for the ON_LEAVE lifecycle defect (review noise, and leave/attendance overlaps go undetected). Otherwise the design is sound.
Confidence: High

### Geofencing / attendance locations
Capability: Define circular zones per branch; accept punches inside them.
Status: COMPLETE
Evidence: EV-3018, EV-3058, EV-3013, EV-3029
Files: src/app/api/attendance-locations/*, src/lib/geo.ts, src/app/branches/[branchId]/_components/AttendanceLocations.tsx
Functions/classes: nearestFence, checkLocation, isValidLatLng
DB tables: AttendanceLocation
API routes: GET/POST /api/attendance-locations, PUT/DELETE /api/attendance-locations/[id]
UI routes: /branches/[branchId]/edit
Tests: geo.test.ts, self-attendance.test.ts
Observed behavior: Several circles per branch. The punch is rejected when GPS accuracy exceeds the setting or the point is outside every circle. Writes are audited.
Missing pieces: No polygon zones, no per-employee or remote-work locations beyond the geo-exempt flag.
Risk: Low
Confidence: High

### Face verification and biometric data lifecycle
Capability: Consent-based enrolment, matching, liveness, retention and purge.
Status: COMPLETE
Evidence: EV-3018, EV-3056, EV-3057, EV-3013
Files: src/app/api/portal/face/route.ts, src/lib/face.ts, src/lib/biometric-storage.ts, services/face, scripts/jobs.mjs
Functions/classes: analyzeFace, openEmbedding, checkFace, purge-attendance-biometrics job
DB tables: FaceProfile, AttendancePunch.selfieStoredName/selfiePurgedAt
API routes: /api/portal/face (POST/PATCH/DELETE), /api/face-profiles/[employeeId]/photo (HR, audited)
UI routes: /portal
Tests: self-attendance.test.ts, self-attendance-jobs.test.ts; the face-service tests live under services/face/tests (not run here)
Observed behavior: The embedding is encrypted and never sent to the client. Consent is versioned; an outdated consent blocks the punch. HR reset and withdrawal are audited. A job purges selfies after 90 days and the templates of terminated employees.
Missing pieces: Calibration (pilot values). The purge relies on an external cron (see report 29).
Risk: Medium (PDPL-sensitive data; the controls are present)
Confidence: Medium

### Biometric device (fingerprint/face terminal) integration
Status: MISSING
Evidence: EV-3008 (UI text says the system does not connect to the device; negative search for vendor SDKs)
Risk: High for Saudi SMEs, which usually run ZKTeco-type terminals. Attendance from devices cannot enter the system except by manual HR typing.
Confidence: High

### QR-code attendance
Status: MISSING
Evidence: EV-3008 negative search (the `qrcode` library is used only for job applications and document verification: src/app/applications/page.tsx:208, src/lib/documents/qr.ts)
Risk: Low
Confidence: High

### Work schedules / shifts (fixed, split, flexible, night)
Capability: Define the working pattern and assign it to employees.
Status: PARTIAL
Evidence: EV-3001, EV-3005, EV-3059, EV-3060, EV-3004
Files: prisma/schema.prisma (WorkSchedule), src/app/api/work-schedules/route.ts, src/lib/attendance.ts, src/app/branches/_components/BranchForm.tsx
Functions/classes: scheduledShift, pickEmployeeSchedule, resolveEmployeeSchedule
DB tables: WorkSchedule, Employee.workSchedule (string)
API routes: GET/POST/PUT /api/work-schedules
UI routes: /branches/[branchId]/work-schedules/new, branch form
Tests: attendance.test.ts
Observed behavior: One schedule per branch is matched to the employee by name string. Night shifts cross midnight correctly (EV-3060). TWO_SHIFTS is supported only as first-start and last-end: lateness for the second period and absence between the periods are not computed (EV-3004).
Missing pieces: Date-effective assignment, a schedule history, per-day patterns and a foreign key (the name is a string match, so renaming the schedule silently unassigns employees).
Risk: Medium
Confidence: High

### Rotating shifts / rosters
Status: MISSING
Evidence: EV-3062 (no roster, rotation or shift-assignment concept), EV-3005
Risk: Medium (common in retail, security and healthcare employers)
Confidence: High

### Ramadan working hours
Status: MISSING
Evidence: EV-3006 (no Ramadan logic; the only Ramadan occurrences are circular texts in document tests)
Risk: High in Saudi Arabia. Labour law reduces working hours for Muslim workers during Ramadan (art. 98, for counsel to confirm). With fixed schedules, every Ramadan day shows false early-leave minutes, or HR must edit every schedule by hand.
Confidence: High

### Weekends / working days per schedule
Status: DISCONNECTED
Evidence: EV-3001, EV-3007, EV-3028
Observed behavior: `WorkSchedule.workDays` is captured in the UI and stored, but no code reads it. The only weekend notion is the tenant-wide `isWeekend` (Friday, plus Saturday for a 5-day week) used for the overtime multiplier.
Risk: Medium. Rest days per employee are unknown to the system, which blocks absence detection and correct overtime premiums.
Confidence: High

### Public holidays
Status: MISSING
Evidence: EV-3006 (no Holiday model or logic), EV-3028 (no holiday multiplier in overtime)
Risk: High. Eid al-Fitr, Eid al-Adha and National/Founding Day cannot be marked, so attendance, overtime premiums and leave counting all ignore them.
Confidence: High

### Breaks
Status: MISSING
Evidence: EV-3062
Risk: Low to Medium (worked minutes include breaks; the art. 101 rest-period rule is for counsel to confirm)
Confidence: High

### Late arrival / early departure / attendance overtime minutes
Capability: Compute lateness, early departure and extra minutes per day.
Status: PARTIAL
Evidence: EV-3004, EV-3011, EV-3012, EV-3023
Files: src/lib/attendance.ts
Functions/classes: computeLateEarly
DB tables: Attendance.lateMinutes/earlyLeaveMin/overtimeMin
Tests: attendance.test.ts
Observed behavior: The minutes are computed on every write path (manual, self and correction). They are displayed on the attendance page and the portal, and read-only in evaluations.
Missing pieces: No grace period, no rounding rule and no minimum overtime threshold (one minute past the end counts as overtime). Nothing consumes the minutes: no penalty and no payroll deduction (EV-3023).
Risk: Medium
Confidence: High

### Absence detection and recording
Status: MISSING
Evidence: EV-3009 (no writer of status ABSENT anywhere), EV-3007 (no working-day calendar), EV-3006 (no holidays)
Observed behavior: A day without punches simply has no `Attendance` row. The dashboards count `status = 'ABSENT'` (dept-manager, workforce benchmarks), a value that is never written, so they always show 0 absences.
Risk: Critical for an HRMS. Unauthorised absence is neither detected, deducted nor reported, and the manager and workforce dashboards report zero absences as fact.
Confidence: High

### Missing punches handling
Status: PARTIAL
Evidence: EV-3020, EV-3021, EV-3061
Observed behavior: A missing punch is fixed only when the employee or manager files a correction. The unlinked path invents the punch from the schedule's start or end. The self-attendance plan tolerates a check-out without a check-in. No job detects open days (a check-in with no check-out).
Missing pieces: Automatic detection or alerting of missing punches, and a time limit on submitting corrections.
Risk: Medium
Confidence: High

### Attendance corrections workflow
Capability: Request, then manager and HR approval, then the attendance day is fixed.
Status: PARTIAL
Evidence: EV-3019, EV-3020, EV-3021, EV-3065, EV-3052
Files: src/app/api/attendance-corrections/*, src/app/api/portal/correction/route.ts, src/lib/hr-workflows.ts
Functions/classes: approveAttendanceCorrection, applyAttendanceCorrection, rejectAttendanceCorrection
DB tables: AttendanceCorrection (also reused as the general "[طلب: ...]" request channel), Attendance, AttendancePunch
API routes: GET/POST /api/attendance-corrections, POST /api/attendance-corrections/[id]/action, POST /api/portal/correction
UI routes: /attendance-corrections, /attendance-corrections/new, /portal
Tests: none of the workflow (only pure helpers)
Observed behavior: Updates are guarded and audited, and self-approval is blocked. A correction linked to a rejected punch uses that punch's server time, so a deliberately failed punch cannot erase lateness. HR can finalise without the manager stage.
Missing pieces: No limit on backdating or future dates (EV-3021). An unlinked ABSENT/GENERAL correction turns a no-show into a full scheduled day with no evidence required. No notifications (EV-3052). The table is overloaded with non-attendance requests.
Risk: Medium (integrity of the attendance record)
Confidence: High

### Flagged/rejected punch review
Status: COMPLETE
Evidence: EV-3067, EV-3018
Observed behavior: HR lists punches, marks them reviewed (audited) and views evidence photos (audited, from a directory outside `/api/files`).
Risk: Low
Confidence: Medium

### Timesheets / attendance reports
Status: PARTIAL
Evidence: EV-3010
Observed behavior: The HR hub returns the latest 500 attendance rows for the whole tenant, with no period, employee or company filter and no export. Evaluations read raw rows for a cycle period.
Missing pieces: A period timesheet per employee, monthly summaries (worked, late, absent, overtime), export and approval/lock of a period.
Risk: High. With about 100 employees, 500 rows cover only about 5 days, so a monthly review is impossible in the product.
Confidence: High

### Overtime requests and approval
Status: PARTIAL
Evidence: EV-3024, EV-3025, EV-3026, EV-3062, EV-3066
Files: src/app/api/manager-portal/route.ts, src/app/api/payroll-hub/route.ts, src/app/api/incoming-requests/route.ts, src/app/overtimes/page.tsx
DB tables: OvertimeRequest
Observed behavior: Managers raise PENDING overtime (0-24 h) for managed employees. PAYROLL approves or rejects it. PAYROLL can also create "assignments" that are APPROVED immediately (maker = checker). A finalised payroll month is refused for new assignments. All paths are audited.
Missing pieces: Overtime is never derived from or checked against actual attendance. `Attendance.overtimeMin` is unused, and the "BIOMETRIC" type is typed hours (EV-3066). There is no annual or daily overtime cap (EV-3062) and no employee-consent step. Approval does not check that the employee is still in service.
Risk: Medium to High (overtime can be paid for hours the employee never attended)
Confidence: High

### Overtime -> payroll
Status: COMPLETE
Evidence: EV-3022, EV-3027, EV-3028, EV-3029
Files: src/lib/payroll.ts:456-466, 559-561, 638-650; src/lib/payroll-core.ts:286-307
Tests: r3-payroll-overtime.test.ts (26)
Observed behavior: Approved, unpaid overtime is reserved by the draft that pays it (`paidInPayrollId`) and carried to the next month when approved late.
Missing pieces (compliance, not wiring): The default basis BASIC pays basic hourly x 1.5, not the art. 107 literal reading of total hourly + 50 % of basic, which is an opt-in per company (EV-3027). The weekend premium uses the tenant setting, not the employee's rest days. There is no public-holiday premium.
Risk: Medium (compliance; a counsel decision is recorded in the code comments)
Confidence: High

### Attendance -> payroll (absence, lateness, early leave deductions)
Status: DISCONNECTED
Evidence: EV-3022, EV-3023, EV-3009
Observed behavior: Payroll generation loads no attendance data (src/lib/payroll.ts:440-520). No code converts late or early minutes into deductions (EV-3023). Absence is never recorded (EV-3009). Deductions reach payroll only as manually created `Deduction` rows (penalties).
Risk: Critical. Attendance is collected with biometric rigour but has zero financial effect unless HR manually re-keys penalties. A buyer would reasonably assume "attendance feeds payroll".
Confidence: High

### Leave -> attendance integration
Status: BROKEN
Evidence: EV-3016, EV-3017, EV-3011
Observed behavior: Attendance knows about leave only through `employmentStatus = ON_LEAVE`, which is set by a paid leave settlement and never cleared. Approved `Leave` rows are ignored when punching or when HR enters attendance manually.
Risk: High (see self-attendance above)
Confidence: High

### Attendance access control and multi-company scoping
Status: PARTIAL
Evidence: EV-3065, EV-3054, EV-3010
Observed behavior: Role checks exist on every route (HR for the hub, punches, photos and schedule writes; managers limited to their scope for corrections). The HR group sees every company in the tenant; `UserCompanyScope` is not applied.
Risk: Medium (multi-company tenants)
Confidence: High

### Attendance notifications
Status: MISSING
Evidence: EV-3052
Risk: Medium (no alert to managers about flagged punches, corrections or overtime requests)
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Times are Riyadh wall-clock (UTC+3); dates are date-only UTC midnight | src/lib/attendance.ts:1-11 | attendance.ts riyadhDateTime | attendance.test.ts | 07 | No |
| Overnight: out <= in means the next day | attendance.ts:66-71, 85 | buildPunches, scheduledShift | attendance.test.ts | 07 | No |
| Late = checkIn − first start, no grace | attendance.ts:137 | computeLateEarly | attendance.test.ts | 07, 13 (evaluations) | No |
| Overtime minutes = checkOut − last end, no threshold | attendance.ts:139 | computeLateEarly | attendance.test.ts | 07 (not consumed by 09) | No |
| Schedule = branch schedule matched by name | attendance.ts:149-160 | pickEmployeeSchedule | attendance.test.ts | 07 | No |
| Self punch: geofence + accuracy + face + liveness, fail closed | self-attendance.ts:134-153, 270-322 | decidePunch/checkLocation/checkFace | self-attendance.test.ts | 07, 24 | No |
| Server time is the only clock | punch/route.ts:92, 170-201 | punch route | self-attendance.test.ts (plan) | 07 | No |
| Correction linked to a punch uses the punch server time | hr-workflows.ts:1086-1096 | applyAttendanceCorrection | none | 07 | No |
| Overtime pay = basic hourly x 1.5 (weekend 2.0) default; art. 107 basis optional | payroll-core.ts:227-307 | overtimeAmount | r3-payroll-overtime.test.ts | 07, 09, 18 | No (also used by settlement.ts) |
| Weekend = Friday (+Saturday if <= 5 days/week) tenant-wide | payroll-core.ts:209-214 | isWeekend | payroll tests | 07, 09 | WorkSchedule.workDays stored but unused (conflicting source) |
| Selfie retention 90 days; terminated templates purged | self-attendance.ts:52-63; jobs.mjs:18-22 | purge job | self-attendance-jobs.test.ts | 07, 24 | No |

## Edge cases checked
- Terminated employee: the self punch is blocked (EV-3014). Manual HR entry is not blocked (EV-3011). Overtime approval does not check termination (EV-3025).
- Employee on approved leave: the punch is accepted without a flag unless a leave settlement was paid. After a paid leave settlement, all future punches are flagged forever (EV-3016, EV-3017).
- Night shift across midnight: handled; the punch is assigned to the previous work day (EV-3060, EV-3061).
- Split shift: second-period lateness and the mid-day gap are not evaluated (EV-3004).
- Ramadan: there is no reduced-hours schedule, so fixed schedules produce false early-leave minutes (EV-3006).
- Public holidays and Eid: unknown to the system; no holiday overtime premium (EV-3006, EV-3028).
- Backdating: a correction can target any date, including months with a closed payroll (EV-3021). This has no payroll effect only because attendance does not feed payroll (EV-3022).
- Timezone: Riyadh fixed offset without DST is correct for KSA (attendance.ts:9). A branch outside KSA would be wrong; that is not modelled.
- Multi-company: HR sees all companies (EV-3054).
- Double tap / two tabs: prevented by the row lock and re-planning (EV-3012).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 07 Attendance / Time / Shifts | 24 | 4 | 9 | 0 | 0 | 8 | 1 | 0 | 2 | 0 | 0 | Absence never recorded; attendance not consumed by payroll; no holidays, Ramadan or rest-day calendar; ON_LEAVE lifecycle broken; no device integration; timesheet view capped at 500 rows | High |

## Adversarial verification

Verifier pass on 2026-09-27 against the working tree. Each finding was re-opened at the cited lines and searched for missed code paths (other routes, jobs, shared libs, raw SQL, seeds, Arabic terms). No status changed in this report; the scorecard and matrix_C.md rows for these capabilities stand.

| Finding | Capability | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|---|
| C-1 | Attendance -> payroll (absence / lateness deductions) | CONFIRMED | DISCONNECTED / Critical | `prisma.attendance` is queried only by attendance-hub, punches, dept-manager, dashboard, evaluations, self-attendance and benchmarks; no payroll, settlement or finance module reads it, and `lateMinutes/earlyLeaveMin/overtimeMin` appear in no payroll file. The only bridge is manual: an ATTENDANCE-category penalty of type LATE or ABSENCE typed by a manager/payroll user (EV-3901), which the report already acknowledges. |
| C-2 | Absence detection and recording | CONFIRMED | MISSING / Critical | No writer of `status: 'ABSENT'` exists in src, scripts, seeds or raw SQL; the 'ABSENT' correction type actually sets PRESENT (EV-3909). Nuance: the main dashboard does compute today's attendance rate from expected vs. present employees, excluding approved leave (EV-3900), so "every dashboard reports zero absence" is too broad; the dept-manager `absentToday` tile and the workforce ABSENCE_RATE metric are the ones that are always 0. No per-employee absence is ever recorded. |
| C-3 | Leave -> attendance (ON_LEAVE) | CONFIRMED | BROKEN / High | Writers of `employmentStatus` are only finance.ts:650 (EXCLUDED), finance.ts:792 (ON_LEAVE on a paid LEAVE_SETTLEMENT) and leaves/[id]/action/route.ts:178 (EXCLUDED); no employee, import or document route writes it and nothing restores ACTIVE. The self-attendance context never loads `Leave` rows. Additional impact (EV-3902): the dept-manager stats keep a stuck ON_LEAVE employee out of the attendance counts and inside the on-leave count indefinitely. |
| C-7 | Public holidays, Ramadan hours, rest days | CONFIRMED | MISSING / High | A broad search (holiday, ramadan, رمضان, عيد, عطلة, اليوم الوطني, يوم التأسيس) finds no model, setting or logic; `workDays` is read only by BranchForm to render checkboxes. New evidence (EV-3906): the settings and cost-settings labels describe the weekend multiplier as covering "العطل", which the code does not do. |
| C-9 | Timesheets / attendance reports | CONFIRMED | PARTIAL / High | The attendance-hub GET is still the only HR list (`take: 500`, no filter). The other views found (EV-3907) are a client-side one-day filter on those 500 rows, a per-employee list inside an evaluation cycle, and monthly benchmark aggregates. None is a period timesheet or an export. |
| C-10 | Overtime requests and approval | CONFIRMED | PARTIAL / High | Verified at payroll-hub/route.ts:300-307 and 394-420: BIOMETRIC is treated as HOURS, the assignment is created APPROVED by the same PAYROLL user, and there is no termination, attendance or cap check (EV-3908). The only guard is the refusal of a finalised month. The manager path caps a single entry at 24 h; there is no daily or annual aggregate cap. |
| C-11 | Biometric device integration | CONFIRMED | MISSING / High | No device SDK, push endpoint, import route or job exists (searched zkteco, hikvision, suprema, anviz, biostar, iclock, push sdk, بصمة). The "بصمة" hits are UI labels, the `biometricId` field and document-seal fingerprints. The attendance page states that the system does not connect to the device. |

C-4, C-5, C-6 and C-8 (report 08) are verified in 08_leave.md.
