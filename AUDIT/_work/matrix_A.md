| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| 01 Core HR | Employee profile CRUD (create/list/detail/edit) | COMPLETE | EV-1006, EV-1007 | Critical | High |
| 01 Core HR | Termination (status change) | COMPLETE | EV-1007 | Critical | High |
| 01 Core HR | Personal/contact info fields | COMPLETE | EV-1001 | High | High |
| 01 Core HR | Nationality classification | COMPLETE | EV-1031 | High | High |
| 01 Core HR | National ID / Iqama / passport format validation | PARTIAL | EV-1030 | Medium | High |
| 01 Core HR | Dependents (structured list) | MISSING | EV-1003 | Medium | High |
| 01 Core HR | Emergency contacts | MISSING | EV-1002, EV-1900 | Medium | High |
| 01 Core HR | Employment history / job history / salary history view | PARTIAL | EV-1008, EV-1009, EV-1010, EV-1011, EV-1901, EV-1902, EV-1903 | High | High |
| 01 Core HR | Salary history via promotion/raise decisions (data + apply engine) | COMPLETE | EV-1012, EV-1013, EV-1014, EV-1015, EV-1016 | High | High |
| 01 Core HR | Manager / department / branch / cost center assignment | PARTIAL | EV-1020, EV-1021 | High | High |
| 01 Core HR | Employee timeline (single-view chronology) | MISSING | EV-1009 | Medium | High |
| 01 Core HR | Directory / search | COMPLETE | EV-1028 | Medium | High |
| 01 Core HR | Bulk operations (Excel import) | COMPLETE | EV-1026, EV-1029 | High | High |
| 01 Core HR | Bulk import audit granularity | PARTIAL | EV-1027 | Low | Medium |
| 01 Core HR | Custom fields | MISSING | EV-1004 | Low | High |
| 01 Core HR | Employee notes | MISSING | EV-1005 | Medium | High |
| 01 Core HR | Permissions on employee mutations | COMPLETE | EV-1006, EV-1007 | Critical | High |
| 01 Core HR | Audit trail on employee mutations | COMPLETE | EV-1006, EV-1007, EV-1013 | Critical | High |
| 02 Organization | Legal entities / companies CRUD | COMPLETE | EV-1017, EV-1024 | Critical | High |
| 02 Organization | Administrations CRUD | COMPLETE | EV-1018, EV-1024 | High | High |
| 02 Organization | Branches CRUD | COMPLETE | EV-1019, EV-1024 | High | High |
| 02 Organization | Departments CRUD | COMPLETE | EV-1020, EV-1025 | High | High |
| 02 Organization | Divisions / teams | MISSING | EV-1021 | Low | High |
| 02 Organization | Positions / job titles as managed entities | MISSING | EV-1021 | Medium | High |
| 02 Organization | Grades / levels | MISSING | EV-1021 | Low | High |
| 02 Organization | Cost centers | MISSING | EV-1021 | Medium | High |
| 02 Organization | Headcount allocation / planning | PARTIAL | EV-1022, EV-1023 | Medium | High |
| 02 Organization | Reporting lines (manager hierarchy data) | COMPLETE | EV-1023 | Medium | High |
| 02 Organization | Org chart visualization | MISSING | EV-1023 | Medium | High |
| 02 Organization | Branch transfer workflow (employee moves branch) | COMPLETE | EV-1038, EV-1039 | High | High |
| 02 Organization | Department/manager (and branch) transfer via decision document | COMPLETE | EV-1012, EV-1013, EV-1036, EV-1904, EV-1907 | High | High |
| 02 Organization | Transfer mechanisms coordination (TransferRequest vs TRANSFER_DECISION) | DISCONNECTED | EV-1038, EV-1039, EV-1904, EV-1905, EV-1906 | High | High |
| 02 Organization | Transfer-decision reachable from UI | UNKNOWN | EV-1037 | Medium | Low |
| 02 Organization | Permissions on org-unit mutations | COMPLETE | EV-1024, EV-1025 | Critical | High |
| 02 Organization | Audit trail on org-unit mutations | COMPLETE | EV-1024, EV-1025 | Critical | High |
| 02 Organization | Page-level permission model (RolePermission) | PARTIAL | EV-1040 | Low | Medium |
| 03 Contracts | Contract type classification (employment type) | COMPLETE | EV-1032 | Medium | High |
| 03 Contracts | Fixed-term vs. unlimited-term distinction | COMPLETE | EV-1033, EV-1908, EV-1909 (implicit via contractEndDate, used by Art. 77/CONTRACT_EXPIRY/Art. 37 rules; residual Low gap: no renewal count for Art. 55) | Low | High |
| 03 Contracts | Probation tracking + alerting | COMPLETE | (ledger_0 alerts evidence; src/lib/alerts.ts:115,300,322,424-436) | Medium | Medium |
| 03 Contracts | Contract amendments/addenda (allowances, branch, contract end date) | COMPLETE | EV-1012, EV-1013, EV-1034, EV-1035, EV-1036 | High | High |
| 03 Contracts | Salary-term changes via decision (effective-dated, atomic, audited) | COMPLETE | EV-1013, EV-1014, EV-1016 | Critical | High |
| 03 Contracts | Allowance changes (housing/transport) on amendment | COMPLETE | EV-1013 | Medium | High |
| 03 Contracts | Background application of due decisions | COMPLETE | EV-1014, EV-1015 | High | High |
| 03 Contracts | Revocation safety (cannot silently undo an applied change) | COMPLETE | EV-1016 | Medium | High |
| 03 Contracts | Renewals (contract end-date extension as a first-class workflow) | UNKNOWN | (contractEndDate is editable via EmployeeChangeOrder/addendum, EV-1012; no dedicated "renewal" workflow/page found, but not exhaustively searched) | Medium | Low |
| 03 Contracts | Contract templates (offer / addendum letters) | COMPLETE | EV-1035, EV-1036 | Medium | High |
| 03 Contracts | Acceptance / e-signing of contracts | UNKNOWN | (Signatory model exists in schema per system map but signing/acceptance flow not verified in this pass — belongs mainly to Documents domain 04) | Medium | Low |
| 03 Contracts | Test coverage (transfer-decision path) | COMPLETE | EV-1029 | Medium | High |
