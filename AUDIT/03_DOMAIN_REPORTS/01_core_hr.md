# 01 Core HR / People

## Scope and method

Read `prisma/schema.prisma` (Employee, SalaryChange, EmployeeChangeOrder models), `src/lib/employee.ts`,
`src/lib/employee-shared.ts`, `src/lib/identity.ts`, `src/lib/nationality.ts`, `src/lib/documents/change-orders.ts`,
`scripts/jobs.mjs` (apply-employee-changes), `src/app/api/employees/**` (route.ts, `[id]/route.ts`, `import/route.ts`),
`src/app/api/search/route.ts`, `src/app/employees/page.tsx` and `src/app/employees/[id]/page.tsx`. Ran
`npx vitest run` on `x-X-EMPLOYEES-employee.test.ts` and `documents-transfer.test.ts` (both pass). Did not connect
to a database; all findings are from static code/schema/migration inspection plus targeted test runs.

## Capability findings

### Employee profile CRUD (create / list / detail / edit / terminate)
Capability: create, view, list, edit, and terminate an employee record.
Status: COMPLETE
Evidence: EV-1001, EV-1006, EV-1007
Files: `src/app/api/employees/route.ts`, `src/app/api/employees/[id]/route.ts`, `src/lib/employee.ts`, `src/app/employees/page.tsx`, `src/app/employees/[id]/page.tsx`, `src/app/employees/[id]/edit`
Functions/classes: `POST /api/employees`, `GET /api/employees`, `GET/PUT/PATCH /api/employees/[id]`, `assertValidDirectManager`, `orgPlacementErrors`, `employeeDateIssues`
DB tables: `Employee`
API routes: `/api/employees`, `/api/employees/[id]`
UI routes: `/employees`, `/employees/new`, `/employees/[id]`, `/employees/[id]/edit`
Tests: `src/lib/__tests__/x-X-EMPLOYEES-employee.test.ts` (13/13 pass), `src/lib/__tests__/employee.test.ts`, `src/lib/__tests__/r3-R3-ORG-employee.test.ts`
Observed behavior: every mutating verb (POST, PUT, PATCH) calls `requireUser` with an explicit role group and `logAudit` with before/after payloads (EV-1006, EV-1007). Zod schemas validate money, dates, IBAN, gender/nationality requiredness.
Missing pieces: none material for the base CRUD path.
Risk: none identified for this slice.
Confidence: High

### Dependents (structured records)
Capability: recording an employee's dependents (name, relation, date of birth, ID) for HR/benefits purposes.
Status: MISSING
Evidence: EV-1003
Risk: Medical-insurance-class fields and workforce Nitaqat weighting reference a dependents *count* only; any product requirement to actually list dependents (e.g. for medical insurance enrollment or GOSI paperwork) has no data model to back it.
Confidence: High

### Emergency contacts
Capability: recording who to contact in an employee emergency.
Status: MISSING
Evidence: EV-1002
Risk: A common HR-compliance expectation with no schema field, no API, no UI. Medium priority gap — flagged as High severity in the matrix because it is a basic safety/compliance capability broadly expected in an HRMS and entirely absent.
Verifier correction (A-1): status MISSING confirmed (EV-1900). Severity corrected to **Medium**. It is a standard HRIS duty-of-care field, but no Saudi Labor Law or GOSI rule in this codebase depends on it, and nothing else in the product breaks without it.
Confidence: High

### Employment / job / salary history (timeline view)
Capability: seeing an employee's history of salary changes, title changes, department/branch moves over time.
Status: PARTIAL
Evidence: EV-1008, EV-1009, EV-1010, EV-1011, EV-1012, EV-1013
Files: `src/lib/employee.ts:270-280` (EMPLOYEE_DETAIL_INCLUDE), `prisma/schema.prisma:2139-2151` (SalaryChange), `prisma/schema.prisma:2490-2511` (EmployeeChangeOrder), `src/app/employees/[id]/page.tsx`
Functions/classes: `applyChangeOrder`, `applyDueChangeOrders`
DB tables: `SalaryChange`, `EmployeeChangeOrder`
API routes: none expose `SalaryChange`/`EmployeeChangeOrder` history to the profile UI
UI routes: `/employees/[id]` (no history/timeline section)
Tests: none found reading history back for display (the existing tests cover the write/apply side: `documents-transfer.test.ts`, documents pipeline tests)
Observed behavior: the underlying history data is written correctly and atomically whenever a promotion/raise/transfer decision is applied (`SalaryChange` row created, `EmployeeChangeOrder` kept as the record of what changed and when — see the 03 Contracts report for the full mechanics). But `EMPLOYEE_DETAIL_INCLUDE` (the query backing the employee profile page and API) does not select either table, and the profile page (1,222 lines) has no history/timeline UI. So the *record* of an employee's raises and moves exists and is reliable, but no product surface lets HR read it back per employee.
Missing pieces: an employee-scoped "history" endpoint/tab reading `SalaryChange` + `EmployeeChangeOrder` (+ terminations, + transfers) in chronological order.
Risk: HR must reconstruct salary/job history from the generic audit log or issued documents list instead of a dedicated view — workable but not a real product capability yet.
Verifier correction (A-2): the history data is **not** complete. Only decision-driven changes write `SalaryChange` (EV-1902). A salary, title, branch, department or manager change made through the employee edit form (`PUT /api/employees/[id]`) writes no `SalaryChange` row, and its audit entry stores only the changed field names, not the before/after values (EV-1901). The audit-log page is ADMIN-only and has no per-employee filter. The documents register can be filtered by employee, which gives HR a partial list of decision-driven changes (EV-1903). Status stays PARTIAL and severity stays High.
Confidence: High

### Manager / department / branch / cost center
Capability: assigning an employee's manager, department, branch, and cost center.
Status: PARTIAL
Evidence: EV-1020, EV-1021
Files: `prisma/schema.prisma:297-483`
Observed behavior: manager (`directManagerId` self-relation), department, and branch are all first-class FK fields on Employee, validated on create/edit (`orgPlacementErrors`, `assertValidDirectManager`) and changeable through the change-order/decision mechanism (see 03 Contracts). Cost center has no field or model at all (see 02 Organization report).
Missing pieces: cost center assignment.
Risk: any payroll/finance reporting that needs to slice by cost center cannot, because the concept does not exist in the schema.
Confidence: High

### Directory / search
Capability: cross-employee search by name, employee ID, national ID, etc.
Status: COMPLETE
Evidence: EV-1028
Files: `src/app/api/search/route.ts`, `src/app/search/page.tsx`
API routes: `/api/search`
UI routes: `/search`
Observed behavior: `requireUser(ROLE_GROUPS.STAFF)` guards read access; no explicit vulnerability found in this pass.
Confidence: Medium (route body only lightly reviewed for query construction/SQL-injection risk; uses Prisma query builder, not raw SQL, so injection risk is low by construction).

### Bulk operations (Excel import)
Capability: importing many employees from an Excel file with validation and review notes.
Status: COMPLETE
Evidence: EV-1026, EV-1027, EV-1029
Files: `src/app/api/employees/import/route.ts`, `src/lib/employee.ts` (IMPORT_* constants and helpers)
Functions/classes: `mapImportRow`, `employeeDataWarnings`, `employeeDateIssues`, `orgPlacementErrors`, `hijriLikeDateError`, `resolveOrgUnit`, `matchByName`
API routes: `/api/employees/import`
UI routes: `/employees/import`
Tests: exercised indirectly by employee.ts unit tests; `documents-transfer.test.ts`/`x-X-EMPLOYEES-employee.test.ts` pass locally
Observed behavior: `requireUser(ROLE_GROUPS.HR)`, row/file size caps (`IMPORT_MAX_ROWS`, `IMPORT_MAX_FILE_BYTES`), per-row validation reusing the same nationality/ID/date/org-placement checks as the single-employee form (`employeeDateIssues`, `orgPlacementErrors`, `hijriLikeDateError`), a single `logAudit` call per import run.
Missing pieces: audit-log granularity — one audit row per import, not one per affected employee row (EV-1027), so a later investigator cannot filter "what did import X change on employee Y" from the audit log alone.
Risk: Low-medium; the import response itself lists per-row outcomes at request time, but that detail is not persisted for later audit unless separately saved by the caller.
Confidence: High

### Custom fields
Capability: company-defined additional fields on the employee record.
Status: MISSING
Evidence: EV-1004
Risk: Low — no evidence any part of the product expects this; flagged for completeness since the brief asked for it explicitly.
Confidence: High

### Employee notes
Capability: a running log of free-text HR notes on an employee.
Status: MISSING
Evidence: EV-1005
Risk: Medium — `dataReviewNote` is a single overwritable field for one specific purpose (missing-data flag), not a notes log; any workflow that wants a running commentary trail on an employee has nowhere to write it.
Confidence: High

### Nationality classification
Capability: correctly classify an employee's nationality (Saudi / GCC / expat) for GOSI, Nitaqat, leave and workforce-cost rules.
Status: COMPLETE
Evidence: EV-1031
Files: `src/lib/nationality.ts`
Tests: `src/lib/__tests__/wf-nationality.test.ts`
Observed behavior: the module's own header documents that it replaced three previously-disagreeing ad-hoc detectors in gosi.ts/leave.ts/employee-shared.ts, and lists every value whose classification changed as a result (`NATIONALITY_RECLASSIFIED`) — genuine evidence of a real historical bug class being fixed centrally, not just self-reported.
Confidence: High

### National ID / Iqama / passport format validation
Capability: warn HR when an ID number does not match the expected Saudi format for its type.
Status: PARTIAL
Evidence: EV-1030
Files: `src/lib/identity.ts`
Observed behavior: 10-digit + leading-digit heuristic checks for NATIONAL_ID (leading 1) and IQAMA (leading 2); explicitly documented as a heuristic that only warns and never blocks a save (file header, L5-6). Passport/border numbers are lenient free text with no format check beyond charset.
Missing pieces: no real checksum/algorithmic validation (Saudi national ID has a Luhn-like check digit that is not verified here); passport numbers are not validated against any country-specific format.
Risk: Low — deliberately a soft warning, not a hard gate, consistent with the file's stated design intent.
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| National ID = 10 digits, starts with 1; Iqama = 10 digits, starts with 2 (heuristic, warning only) | src/lib/identity.ts | `idNumberWarning` | none found | 01 | No |
| Nationality classification (Saudi/GCC/expat) | src/lib/nationality.ts | `isSaudiNational`/classifier | wf-nationality.test.ts | 01, GOSI, leave, workforce (09/10/22) | No (single canonical module per its own header, replacing 3 old copies) |
| A promotion/raise/transfer decision applies exactly once, atomically, on its effective date | src/lib/documents/change-orders.ts | `applyChangeOrder` (DB guard: `updateMany` with `appliedAt:null` filter) | documents-transfer.test.ts (partial coverage of the transfer path) | 01, 03, 09 (payroll) | No |
| An applied change order cannot be revoked by cancelling its document | src/lib/documents/change-orders.ts | `cancelChangeOrder` | none found directly | 01, 03, 04 | No |
| Excel import row caps: max 5,000 rows | src/lib/employee.ts (`IMPORT_MAX_ROWS`) | `src/app/api/employees/import/route.ts` | none found directly | 01 | No |

## Edge cases checked

- **Employee history readback**: confirmed the profile page and its backing query never select `SalaryChange`/`EmployeeChangeOrder` (EV-1008, EV-1009) — a structural gap, not a bug in the write path.
- **Double-apply of a salary/job change**: `applyChangeOrder` uses an atomic `updateMany` guard (`appliedAt: null, cancelledAt: null` → must affect exactly 1 row) before doing any employee update, so a race (nightly job + manual apply, or two job runs) cannot double-apply (EV-1013). Confirmed by reading the code; no dedicated concurrency test found.
- **Revoking an already-applied decision**: `cancelChangeOrder` returns `'APPLIED'` rather than silently cancelling, forcing the caller to handle the case explicitly (EV-1016).
- **Bulk import row limits / oversized files**: capped by `IMPORT_MAX_ROWS`/`IMPORT_MAX_FILE_BYTES` before processing (EV-1026).
- **Arabic-Indic digits in ID numbers**: `normalizeIdNumber` explicitly converts Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits before format-checking (EV-1030).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 Core HR | 18 | 9 | 4 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | Emergency contacts missing; employee history/timeline not surfaced despite the underlying data existing | High |

## Adversarial verification

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| A-1 Emergency contacts | CONFIRMED (severity ADJUSTED) | MISSING / Medium | A broader search (English, Arabic "طوارئ" and "قريب", and synonyms such as relative, guardian, contactPerson, altPhone) and a read of the whole `Employee` model find only `mobileNumber` and `email`. The only hits are the `EMERGENCY` leave type and the "وفاة قريب" bereavement comment (EV-1900). The status stands. Severity is lowered from High to Medium: no compliance rule or downstream module in the codebase depends on this field. |
| A-2 Employee salary / job history | ADJUSTED (detail) | PARTIAL / High | The core claim holds: `EMPLOYEE_DETAIL_INCLUDE` (src/lib/employee.ts:270-280) selects neither table, and the profile page has no history section. Its only links out are the workforce true-cost and exit-cost pages, which use `SalaryChange` as calculation input and do not list it. The claim that `SalaryChange` records "every raise/promotion/move" is overstated. Direct edits through the employee form change salary and placement with no `SalaryChange` row and with an audit entry of field names only (EV-1901, EV-1902). So the history cannot be rebuilt reliably even if a UI were added. A partial workaround exists: the documents register can be filtered by employee (EV-1903). |

Scorecard and matrix: no status change. The Emergency contacts criticality in `_work/matrix_A.md` is corrected from High to Medium.
