| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| 28 Testing | Unit tests of pure domain calculators (payroll/GOSI/EOSB/leave/attendance) | COMPLETE | EV-10001,EV-10002,EV-10003,EV-10004,EV-10005 | High | High |
| 28 Testing | Route-handler (HTTP-level) tests | PARTIAL | EV-10006,EV-10007,EV-10008,EV-10009,EV-10010,EV-10902 | High | High |
| 28 Testing | Helper-module tests reached through `@/app/api/**/_lib` imports | PARTIAL | EV-10008,EV-10011 | High | High |
| 28 Testing | Database-integration tests (documents pipeline, Muqeem mock contract) | DISCONNECTED | EV-10012,EV-10013,EV-10014,EV-10015 | High | High |
| 28 Testing | Authorization core (`requireUser`) unit tests | PARTIAL | EV-10016,EV-10900,EV-10901 | Medium | High |
| 28 Testing | Edge authentication middleware (`src/proxy.ts`) tests | MISSING | EV-10017,EV-10911 | Medium | High |
| 28 Testing | Maker-checker rule tests | PARTIAL | EV-10018,EV-10019 | Medium | Medium |
| 28 Testing | File-scope access control tests | COMPLETE | EV-10020,EV-10005 | Medium | Medium |
| 28 Testing | Attendance lateness tests | COMPLETE | EV-10021 | Medium | High |
| 28 Testing | Sidecar service tests (render, face) wired into CI | DISCONNECTED | EV-10022,EV-10023,EV-10024,EV-10913 | Medium | High |
| 28 Testing | E2E / browser tests | MISSING | EV-10025,EV-10912 | High | High |
| 29 Infrastructure | Deployment (Dockerfile/docker-compose/pm2) | COMPLETE | EV-10101,EV-10102,EV-10103 | High | Medium |
| 29 Infrastructure | CI/CD pipeline trigger correctness | UNSAFE | EV-10104,EV-10105,EV-10106,EV-10903 | High | High |
| 29 Infrastructure | Migrations CI verification (drift + idempotent seed) | COMPLETE | EV-10107 | Critical | High |
| 29 Infrastructure | Backups (encryption, offsite, retention) | PARTIAL | EV-10108,EV-10109,EV-10110,EV-10111,EV-10904,EV-10905,EV-10906 | High | High |
| 29 Infrastructure | Restore (tested?) | PARTIAL | EV-10112,EV-10113,EV-10907 | High | High |
| 29 Infrastructure | Scheduled background jobs (systemd/cron actually installed) | PARTIAL | EV-10114,EV-10115,EV-10116,EV-10117,EV-10908,EV-10909,EV-10910 | High | High |
| 29 Infrastructure | Job idempotency / concurrency safety | COMPLETE | EV-10118,EV-10119,EV-10120 | High | Medium |
| 29 Infrastructure | Logging / monitoring / observability | PARTIAL | EV-10121,EV-10122,EV-10123 | Medium | High |
| 29 Infrastructure | Rate limiting | PARTIAL | EV-10124,EV-10125 | Medium | High |
| 29 Infrastructure | Disaster recovery documentation (RUNBOOK/DATABASE) | COMPLETE | EV-10126 | Low | Medium |
