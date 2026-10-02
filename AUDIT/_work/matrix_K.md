# Matrix K — Platform/DB and Platform/API

| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| Platform/DB | Schema/migration integrity (baseline→9p, drift-checked in CI) | COMPLETE | EV-11018, EV-11019, EV-11014, EV-11015 | High | High |
| Platform/DB | Money stored with exact precision (no float rounding risk) | PARTIAL | EV-11002, EV-11003, EV-11900, EV-11901, EV-11902 | High | High |
| Platform/DB | Multi-entity tenant ownership (Employee → legal/actual Company via FK) | COMPLETE | EV-11004 | High | High |
| Platform/DB | Company hard-delete safety (deletion blockers) | PARTIAL | EV-11006 | Medium | Medium |
| Platform/DB | Employee hard-delete safety / no destructive cascade in practice | COMPLETE | EV-11007 | High | High |
| Platform/DB | Lifecycle status values enforced at the DB layer (enum/CHECK) | PARTIAL | EV-11008, EV-11009, EV-11010, EV-11903, EV-11904 | Medium | High |
| Platform/DB | Single source of truth for employee salary | PARTIAL | EV-11011, EV-11012, EV-11013 | Medium | High |
| Platform/DB | Immutability / audit-trail guarantee for decided change orders | COMPLETE | EV-11014 | Medium | High |
| Platform/DB | No orphaned/unused schema surface | PARTIAL | EV-11016, EV-11017 | Low | Medium |
| Platform/DB | Referential integrity of "*ById" audit/actor columns | PARTIAL | EV-11021 | Low | Medium |
| Platform/DB | Indexing of high-cardinality lookups | COMPLETE | EV-11020 | Medium | Medium |
| Platform/API | Route inventory / auth-guard coverage | COMPLETE | EV-11022, EV-11023, EV-11024, EV-11025, EV-11026 | High | Medium |
| Platform/API | Scoped file-access control with audit logging | COMPLETE | EV-11028 | High | High |
| Platform/API | Upload endpoint auth boundary (anonymous cases) | UNKNOWN | EV-11027 | Medium | Low |
| Platform/API | Centralized, non-leaking error handling | COMPLETE | EV-11029, EV-11030 | Medium | High |
| Platform/API | Input validation coverage on write endpoints | COMPLETE | EV-11031, EV-11032, EV-11033, EV-11034 | High | Medium |
| Platform/API | Route↔page connectivity (no orphaned/undead endpoints found in sample) | PARTIAL | EV-11035, EV-11036, EV-11037, EV-11038 | Low | Low |
| Platform/API | Route-level (HTTP-wiring) automated test coverage | PARTIAL | EV-11039, EV-11040, EV-11905, EV-11906 | Medium | High |

Adversarial verification (K-1, K-2, K-4): the Money precision row changed from UNSAFE to PARTIAL because of the app-level halala-rounding convention in `src/lib/money.ts`. The Route-level test row changed from MISSING to PARTIAL because 3 test files invoke route handlers directly. The status-enforcement row keeps PARTIAL / Medium. Details are in the 05 and 06 reports under "Adversarial verification".
