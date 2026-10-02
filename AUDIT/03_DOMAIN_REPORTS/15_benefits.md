# 15 Benefits

## Scope and method
Read `MedicalInsurance`, Employee benefit fields and Settlement ticket fields in `prisma/schema.prisma`; `src/app/api/medical-insurance/**`; `src/app/medical-insurance/*`; `src/lib/alerts.ts`; workforce medical-premium settings and total-rewards loader. Negative searches for dependents, CCHI, enrollment, tickets. No tests exist for this domain (none found by name under `src/lib/__tests__`).

## Capability findings

### Medical insurance policy register
Capability: Record company medical policies (insurer, policy number, cost, expiry, class, network, files)
Status: PARTIAL
Evidence: EV-4101, EV-4102, EV-4105
Files: prisma/schema.prisma:1365-1389; src/app/api/medical-insurance/route.ts; src/app/api/medical-insurance/[id]/route.ts; src/app/medical-insurance/page.tsx
Functions/classes: GET/POST/PUT/DELETE handlers
DB tables: MedicalInsurance
API routes: /api/medical-insurance, /api/medical-insurance/[id]
UI routes: /medical-insurance, /medical-insurance/new, /medical-insurance/edit
Tests: none
Observed behavior: HR+GOV roles, zod validation, audit on create/update/delete; expiry alerts at 30 days.
Missing pieces: policy is per company only; no member list; no company scope on reads (EV-4327).
Risk: Medium
Confidence: High

### Employee enrollment / plan assignment
Status: PARTIAL (corrected from MISSING by adversarial verification)
Evidence: EV-4101, EV-4103, EV-4912
Observed behavior: Employee.medicalInsuranceClass is a per-employee plan tier validated against VIP / A+ / A / B / C (not free text at the API), shown on the employee file and used by total rewards / premium planning. There is no link between an employee and a MedicalInsurance policy, no enrollment/start/end dates, no member or card number.
Risk: Medium (plan tier is recorded; the system still cannot show which policy covers whom or since when)
Confidence: High

### Dependents
Status: MISSING
Evidence: EV-4103, EV-4104
Observed behavior: dependentsCount (integer) and dependentsFeePaidBy only; no dependant records (name, relation, ID, DOB).
Risk: Medium
Confidence: High

### Eligibility rules / packages
Status: MISSING
Evidence: EV-4104, EV-4106
Observed behavior: premium per class exists only as a cost-planning assumption in the workforce engine; no eligibility rule, grade-to-class mapping or benefit package.
Confidence: High

### Employer / employee contribution
Status: MISSING
Evidence: EV-4107
Observed behavior: no premium share is deducted in payroll; policyCost is a single company figure.
Confidence: High

### Benefit history
Status: MISSING
Evidence: EV-4101 (no history table), EV-4103
Confidence: High

### CCHI / insurer integration
Status: MISSING
Evidence: EV-4104
Confidence: High

### Annual air tickets
Status: MISSING (as a benefit); only a manual amount inside a settlement
Evidence: EV-4108
Confidence: High

### Total rewards statement (benefits visibility)
Status: PARTIAL
Evidence: EV-4106
Observed behavior: portal total-rewards statement (owner-enabled) reads medicalInsuranceClass and premium assumptions; it estimates value, it does not reflect actual enrollment.
Confidence: Medium

## Business rules
| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Policy expiry alert 30 days | SystemSetting alert_medical_insurance_days | src/lib/alerts.ts:117, 458-465 | none found | 15, 20 | No |
| Premium per class / per dependant | Workforce assumption (company setting) | src/lib/workforce/company-settings.ts:19-49 | workforce tests (domain 22) | 15, 22 | No |

## Edge cases checked
- Terminated employee: no enrollment record exists, so no deletion-from-policy step is possible (EV-4101).
- Multi-company: policies carry companyId, but reads are not scoped to the user's companies (EV-4102, EV-4327).
- Dependants of expatriates: only a count, fee payer flag (EV-4103).

## Scorecard
| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 15 Benefits | 9 | 0 | 3 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | Enrollment is a plan tier only (no policy link/dates), no dependants, no contribution, no CCHI | High |

## Adversarial verification
Verifier pass on 2026-09-27 (read-only).

| Finding | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| D-13 Medical insurance enrollment | ADJUSTED | Employee enrollment / plan assignment: PARTIAL / Medium (was MISSING / High) | The "free-text medicalInsuranceClass" detail is wrong: the API validates it against VIP / A+ / A / B / C, the employee file shows it, and total rewards uses it (EV-4912). So a per-employee plan tier exists. Still confirmed: no link to a MedicalInsurance policy, no member/card number or dates, no dependants model, no employee contribution line, no CCHI (EV-4101, EV-4103, EV-4104, EV-4107). The Dependents, Contribution and CCHI rows stay MISSING. Capability block, scorecard and matrix_D corrected. |
