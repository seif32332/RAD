# 03 Contracts

## Scope and method

Read `prisma/schema.prisma` (Employee contract fields, ContractType enum, EmployeeChangeOrder, SalaryChange),
`src/lib/documents/change-orders.ts`, `src/lib/documents/types.ts` (document-type registry), the contract-related
Typst templates (`contract-addendum.typ`, `transfer-decision.typ`, `job-offer.typ`, `promotion-decision.typ`),
`scripts/jobs.mjs` (apply-employee-changes job), `prisma/migrations/9n_contract_addendum` and
`9p_transfer_decision`, and `src/lib/alerts.ts` for probation/contract-expiry alerting. Ran
`src/lib/__tests__/documents-transfer.test.ts` (6/6 pass). Contract acceptance/e-signing and the general
documents-issuance pipeline are primarily Group B's territory (domain 04 Documents); this report covers only
what directly determines contract terms and their effect on the employee record.

## Capability findings

### Contract type classification
Capability: classify an employee's employment arrangement.
Status: COMPLETE
Evidence: EV-1032
Files: `prisma/schema.prisma:316-320`
DB tables: `Employee.contractType`
Observed behavior: `enum ContractType { FULL_TIME, PART_TIME, FREELANCE }` on Employee, defaulted to `FULL_TIME`, validated through the create/edit zod schemas in `src/app/api/employees/route.ts`.
Missing pieces: this enum captures employment *type* (full/part-time/freelance), not the Saudi Labor Law fixed-term vs. unlimited-term contract distinction — see next finding.
Confidence: High

### Fixed-term vs. unlimited-term contract distinction
Capability: know whether a given employee's contract is محدد المدة (fixed-term) or غير محدد المدة (unlimited), since Saudi labor law treats notice periods, non-renewal, and end-of-service differently for each.
Status: COMPLETE (implicit, derived from contractEndDate; corrected from PARTIAL by adversarial verification, see EV-1908)
Evidence: EV-1033, EV-1908, EV-1909
Observed behavior: there is no stored field or enum value for this. The only signal is `Employee.contractEndDate` being set (implying fixed-term) vs. null (implying unlimited) — an inference derivable at read time, not an explicit classification any rule engine, alert, or document template can query directly and unambiguously (e.g., a fixed-term contract that is later made open-ended by removing its end date leaves no record that a classification change happened, vs. an EmployeeChangeOrder explicitly tracking a title/salary/branch change).
Risk: High for any legal-compliance logic (e.g., notice-period rules, automatic-renewal warnings, end-of-service calculation nuances) that must branch on contract type explicitly rather than by inferring it from a nullable date.
Verifier correction (A-9): the rules do branch on the derived type. Art. 77 exit-cost uses remaining term vs 15 days per year, the settlement reason CONTRACT_EXPIRY is 'انتهاء العقد محدد المدة', and the code also has an Art. 37 non-Saudi warning, contract-end alerts and the workforce assumed exit (EV-1908). The only residual gap is that renewals are not counted, so the Art. 55 conversion cannot be derived (EV-1909). Risk: **Low**.
Confidence: High

### Probation tracking and alerting
Capability: track probation period end date and surface it for review before it lapses.
Status: COMPLETE
Evidence: `src/lib/alerts.ts:115,171,300,322,424-436` (from the ledger_0 discovery pass); `Employee.probationEndDate`; `probationWarning` in `src/lib/employee-shared.ts:84`
Files: `src/lib/alerts.ts`, `src/lib/employee-shared.ts`
Observed behavior: a dedicated alert type (`probation`, 30-day default warning window, "expired forever afterwards" lookback logic per the code comment) surfaces both upcoming and already-passed probation end dates with Arabic messaging ("التقييم مطلوب"/"انتهت فترة التجربة"). `probationWarning` additionally flags data-quality issues (e.g. an unreasonably long probation) at data-entry time, non-blocking.
Confidence: Medium (alerting logic read directly; did not trace the alert through to a delivered notification in this pass — that is domain 20 Notifications' territory).

### Contract amendments / addenda
Capability: change specific contract terms (housing/transport allowance, work branch, contract end date) via a formal, effective-dated addendum, without touching unrelated terms.
Status: COMPLETE
Evidence: EV-1012, EV-1013, EV-1034, EV-1035, EV-1036
Files: `prisma/schema.prisma:2490-2511` (`EmployeeChangeOrder`), `src/lib/documents/change-orders.ts`, `src/lib/documents/templates/contract-addendum.typ`, `prisma/migrations/9n_contract_addendum/migration.sql`
DB tables: `EmployeeChangeOrder`, `Allowance`, `SalaryChange` (when basic salary is part of the addendum)
Functions/classes: `applyChangeOrder`, `setMonthlyAllowance`, `createChangeOrder`
Tests: exercised by the transfer-decision path (`documents-transfer.test.ts`, which shares the same `applyChangeOrder` engine); no test file specifically named for contract-addendum was found in this pass.
Observed behavior: every field on `EmployeeChangeOrder` is independently nullable and only non-null fields are applied ("only those given" per the type registry comment, EV-1036) — so an addendum that only changes the transport allowance does not touch job title, branch, or anything else. `setMonthlyAllowance` refuses to apply an allowance change when the employee file already has more than one monthly allowance of that kind (data-integrity guard, `src/lib/documents/change-orders.ts:67-79`), rather than silently picking one.
Missing pieces: no addendum-specific test file located (as distinct from the shared apply-engine tests covering the transfer-decision variant); functional coverage of the addendum's own field set (housing/transport/branch/contractEndDate) was not independently confirmed by a passing test in this pass.
Risk: Medium — the mechanism is shared and the shared mechanism is tested via the transfer path, but the addendum-specific fields (as opposed to transfer's department/manager fields) were not directly observed passing through a test.
Confidence: Medium

### Salary-term changes (promotions / raises) — effective-dated, atomic, audited
Capability: a salary increase or promotion is recorded as a decision and takes effect exactly on its stated date, never twice, with a full audit trail and payroll visibility.
Status: COMPLETE
Evidence: EV-1013, EV-1014, EV-1015, EV-1016
Files: `src/lib/documents/change-orders.ts`, `scripts/jobs.mjs:761-798,885`
Functions/classes: `applyChangeOrder` (atomic `updateMany` guard, EV-1013), `applyDueChangeOrders` (nightly job + "before payroll generation" per the file's own header comment, EV-1014), `applyEmployeeChanges` (job wiring, EV-1015)
DB tables: `EmployeeChangeOrder`, `SalaryChange`, `Allowance`, `AuditLog`
Tests: `documents-transfer.test.ts` (6/6 pass) exercises the shared apply engine for the transfer-decision field set; the salary-specific field set is exercised only by code inspection in this pass.
Observed behavior: the file's own top-of-file comment states the design intent explicitly — "applied to the employee file exactly once, on its effective date: at issuance when already due, otherwise by applyDueChangeOrders (nightly job, the documents list, and before payroll generation, so a due raise is never missed by a payroll run)". The atomic guard (`updateMany` requiring `appliedAt: null, cancelledAt: null` to affect exactly one row before any employee mutation happens) is a real double-apply safeguard, not merely a comment. `logAudit` records before/after state and the originating decision document ID.
Missing pieces: no test file was found that specifically drives a basic-salary-only change order through `applyChangeOrder` and asserts the resulting `SalaryChange` row and `Employee.basicSalary` — coverage is inferred from the shared mechanism being tested via the transfer variant, not proven for the salary variant itself.
Risk: Medium — the mechanism is well-designed and the concurrency guard is real, but a salary-specific regression (e.g. in the `SalaryChange` row creation on L38-40) would not be caught by the existing test file, which exercises department/manager fields.
Confidence: Medium-High

### Contract renewal
Capability: extend/renew a contract's end date as a distinct, trackable workflow (as opposed to an arbitrary field edit).
Status: UNKNOWN
Evidence: `contractEndDate` is a plain editable field on Employee and is also one of the fields an `EmployeeChangeOrder`/addendum can change (EV-1012); no dedicated "renewal" page, route, or document type (distinct from a generic addendum) was found in the time available for this pass. Not confirmed absent by an exhaustive search of `src/app/renewals` (the module is listed in the system map's UI inventory as existing, but its contents/wiring to Employee.contractEndDate were not traced in this pass).
Risk: Medium — likely PARTIAL or COMPLETE in reality (a `/renewals` page exists per the system map), but this report does not have enough direct evidence to assign a confident status; flagged for the cross-domain pass (Group X) or a follow-up read of `src/app/renewals/page.tsx` and its API.
Confidence: Low

### Acceptance / e-signing of contracts
Capability: an employee (or company signatory) formally accepts/signs a contract or contract change.
Status: UNKNOWN
Evidence: a `Signatory` model is referenced in the system map's summary of the document engine, but the signing/acceptance flow itself (candidate portal `/offer`, `/apply` per the system map's public-route list) was not read in this pass — it belongs primarily to domains 04 (Documents) and 06 (Onboarding), covered by Group B.
Risk: Not assessed in this report; avoid double-counting — see Group B's domain 04/06 reports for the authoritative finding.
Confidence: Low (out of this domain's primary scope; recorded here only because contracts terminology overlaps)

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Only non-null fields on a change order/addendum are applied to the employee record | src/lib/documents/types.ts (comments L100,L150), src/lib/documents/change-orders.ts:24-30 | `applyChangeOrder` | documents-transfer.test.ts (transfer field subset only) | 01, 03 | No |
| A monthly HOUSING/TRANSPORT allowance change refuses to apply if the employee already has more than one row of that kind | src/lib/documents/change-orders.ts:67-79 | `setMonthlyAllowance` | none found | 03, 09 (payroll) | No |
| A change order applies at issuance if already due, otherwise on its effective date via the nightly job or before payroll generation | src/lib/documents/change-orders.ts (header comment), scripts/jobs.mjs | `createChangeOrder`, `applyDueChangeOrders`, `applyEmployeeChanges` | documents-transfer.test.ts (partial) | 01, 03, 09 | No |
| An employment-type enum (FULL_TIME/PART_TIME/FREELANCE) exists but is distinct from — and does not encode — the fixed-term/unlimited-term legal distinction | prisma/schema.prisma:316-320 | Employee.contractType | none | 03, 10 (Saudi compliance) | N/A (gap, not duplication) |

## Edge cases checked

- **Double-apply of a promotion/raise/addendum**: prevented by the atomic `updateMany` guard in `applyChangeOrder` (EV-1013) — confirmed by direct code reading, not by a concurrency test.
- **Revoking a decision that already took effect**: `cancelChangeOrder` returns `'APPLIED'` instead of silently cancelling, forcing the caller to refuse the revocation (EV-1016) — this correctly prevents an already-effective contract change from being erased by cancelling its source document after the fact.
- **An addendum touching only one term (e.g. transport allowance) while other fields stay null**: confirmed by schema design (every EmployeeChangeOrder field independently nullable) and by the apply function only writing fields that are non-null (EV-1013) — a partial addendum cannot accidentally blank out unrelated contract terms.
- **More than one monthly allowance of the same kind on file**: `setMonthlyAllowance` throws rather than guessing which row to update (EV-1013 detail) — an explicit data-integrity refusal rather than silent misbehavior.
- **Backdating**: `createChangeOrder` compares the effective date to `riyadhEndOfToday()` and applies immediately if already due (src/lib/documents/change-orders.ts, `createChangeOrder`) — so a decision issued with a past or same-day effective date is not left pending; not independently verified against a true backdating scenario (effective date before the employee's join date, for example) in this pass.
- **Timezone**: the due-date comparison is explicitly pinned to Riyadh time (`riyadhEndOfToday`, UTC+3 offset computed manually) rather than server-local time — a deliberate design choice visible in the code, relevant since the deployment/test environment may run in a different timezone.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 03 Contracts | 7 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | Contract renewal and acceptance/signing not conclusively traced in this pass; fixed/unlimited term is derived from contractEndDate and used by the rules (verified, EV-1908); no renewal count for the Art. 55 conversion (Low) | Medium-High |

## Adversarial verification

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| A-9 Fixed-term vs unlimited-term classification | ADJUSTED | COMPLETE (implicit) / Low | The factual part is true: `ContractType` (prisma/schema.prisma:316-320) is an employment-type enum. Its conclusion is refuted. Under Saudi law a contract is fixed-term exactly when it has a term, and the code does derive the type from `contractEndDate` and branches on it in several places (EV-1908): Art. 77 compensation in exit-cost (remaining term vs 15 days/year), the `CONTRACT_EXPIRY` settlement reason ('انتهاء العقد محدد المدة', full award), the Art. 37 non-Saudi fixed-term warning, contract-end notice alerts, and the workforce assumed exit. EV-1033's negative search is wrong: "محدد المدة" appears in src/lib/settlement.ts:63, src/lib/employee-shared.ts:116 and src/app/api/workforce/_lib/shared.ts:151. Residual Low-severity gap: there is no renewal count or history, so the Art. 55 conversion to unlimited after 3 renewals or 4 years cannot be derived (EV-1909). |

Corrections applied: the "Fixed-term vs. unlimited-term contract distinction" block is now COMPLETE (implicit, via contractEndDate), Low. The scorecard below supersedes the one above: Complete 5, Partial 0. `_work/matrix_A.md` is updated to match.

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 03 Contracts (verified) | 7 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | Contract renewal and acceptance/signing not conclusively traced; no renewal count for Art. 55 fixed-to-unlimited conversion (Low) | Medium-High |
