| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| 24 Security | Password authentication | COMPLETE | EV-9003, EV-9004, EV-9007, EV-9009 | Critical | High |
| 24 Security | Brute-force protection / lockout | PARTIAL | EV-9007, EV-9008, EV-9055, EV-9057 | High | High |
| 24 Security | Password policy | PARTIAL | EV-9011 | Medium | High |
| 24 Security | Multi-factor authentication | MISSING | EV-9010 | High | High |
| 24 Security | Self-service password reset | MISSING | EV-9012 | Low | High |
| 24 Security | Session management and revocation | COMPLETE | EV-9004, EV-9006, EV-9013, EV-9014, EV-9066 | Critical | High |
| 24 Security | Cookie security flags | COMPLETE | EV-9006 | High | High |
| 24 Security | Route-level auth guard coverage (246 handlers) | COMPLETE | EV-9001, EV-9002, EV-9003, EV-9065 | Critical | High |
| 24 Security | Role-based authorization (code-defined) | COMPLETE | EV-9015, EV-9069 | Critical | High |
| 24 Security | Configurable RBAC (RolePermission) | UI_ONLY | EV-9016 | Medium | High |
| 24 Security | Manager team scope (ABAC) | COMPLETE | EV-9021, EV-9058, EV-9059, EV-9060 | High | High |
| 24 Security | Company isolation for company-scoped staff | PARTIAL | EV-9017, EV-9018, EV-9019, EV-9072 | High | High |
| 24 Security | Field-level permissions (salary, IBAN, ID) | PARTIAL | EV-9020, EV-9023, EV-9068 | High | High |
| 24 Security | Document / file access control | COMPLETE | EV-9022, EV-9023, EV-9024, EV-9025 | Critical | High |
| 24 Security | IDOR protection on [id] routes | COMPLETE | EV-9058, EV-9059, EV-9060, EV-9061, EV-9062, EV-9063 | High | Medium |
| 24 Security | Privilege escalation protection | COMPLETE | EV-9032, EV-9071 | Critical | High |
| 24 Security | Maker-checker on payments | PARTIAL | EV-9033, EV-9073 | High | High |
| 24 Security | Payroll segregation of duties | MISSING | EV-9034 | High | High |
| 24 Security | Secrets management | COMPLETE | EV-9005, EV-9040, EV-9041, EV-9042, EV-9044 | Critical | High |
| 24 Security | Encryption at rest | PARTIAL | EV-9035, EV-9036, EV-9043 | High | High |
| 24 Security | Gov-platform credential vault | COMPLETE | EV-9037 | High | High |
| 24 Security | Audit logging | PARTIAL | EV-9038, EV-9039 | High | High |
| 24 Security | Upload validation | COMPLETE | EV-9026, EV-9027 | Medium | High |
| 24 Security | Public routes (/apply, /offer, /v) | COMPLETE | EV-9027, EV-9028, EV-9029 | Medium | High |
| 24 Security | CSRF protection | PARTIAL | EV-9006, EV-9031 | Medium | High |
| 24 Security | Security headers / CSP | PARTIAL | EV-9030 | Medium | High |
| 24 Security | Error handling without leakage | COMPLETE | EV-9056 | Low | High |
| 24 Security | Database least privilege | COMPLETE | EV-9044, EV-9046 | High | High |
| 24 Security | Backup confidentiality | PARTIAL | EV-9043 | Medium | High |
| 24 Security | Terminated-employee access cut-off | COMPLETE | EV-9066, EV-9025 | High | High |
| 24 Security | Security test coverage | PARTIAL | EV-9025, EV-9057 | Medium | High |
| 25 Multi-tenancy | Per-tenant deployment / process | COMPLETE | EV-9045 | Critical | High |
| 25 Multi-tenancy | Per-tenant database and role | COMPLETE | EV-9044, EV-9046 | Critical | High |
| 25 Multi-tenancy | Per-tenant secrets | COMPLETE | EV-9044, EV-9046, EV-9067 | Critical | High |
| 25 Multi-tenancy | Storage separation (UPLOAD_DIR) | COMPLETE | EV-9044, EV-9045, EV-9047 | High | High |
| 25 Multi-tenancy | Tenant-aware background jobs | COMPLETE | EV-9047 | High | High |
| 25 Multi-tenancy | Cross-tenant session/cookie leakage prevention | COMPLETE | EV-9006, EV-9067, EV-9004 | Critical | High |
| 25 Multi-tenancy | Shared sidecar services (face, render) | PARTIAL | EV-9048 | Low | Medium |
| 25 Multi-tenancy | Intra-tenant company isolation | PARTIAL | EV-9017, EV-9018, EV-9019, EV-9072, EV-9054 | High | High |
| 25 Multi-tenancy | Company-scoped administrator | MISSING | EV-9015, EV-9017 | Medium | High |
| 25 Multi-tenancy | Database row-level security | MISSING | EV-9049 | Low | High |
| 25 Multi-tenancy | Cascading deletes on HR history | PARTIAL | EV-9050, EV-9052 | Medium | High |
| 25 Multi-tenancy | Soft deletion / historical records | MISSING | EV-9051 | Low | Medium |
| 25 Multi-tenancy | Tenant manager panel security | COMPLETE | EV-9046 | High | Medium |
| 25 Multi-tenancy | Tenant-level backup separation | PARTIAL | EV-9043 | Medium | High |
| 25 Multi-tenancy | Tenant-wide circulars (no company) | PARTIAL | EV-9053 | Low | High |
