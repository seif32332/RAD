| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| 19 Workflow engine | Generic/configurable workflow-definition engine | MISSING | EV-8001, EV-8002 | Medium | High |
| 19 Workflow engine | Per-module guarded status machines (Leave/Transfer/AttendanceCorrection/etc.) | COMPLETE | EV-8003, EV-8004 | High | High |
| 19 Workflow engine | Maker-checker / self-approval prevention (payments) | COMPLETE | EV-8006, EV-8007, EV-8008 | Critical | High |
| 19 Workflow engine | OwnerRequest tracked directive workflow | PARTIAL | EV-8009, EV-8010 | Low | High |
| 19 Workflow engine | Evaluation approval trail (EvaluationApproval) | PARTIAL | EV-8011 | Medium | Low |
| 19 Workflow engine | Cancellation (Leave) | COMPLETE | EV-8005, EV-8013 | Medium | High |
| 19 Workflow engine | Resubmission after rejection | MISSING | EV-8012 | Low | High |
| 19 Workflow engine | Delegation of approval authority (routing, not signing) | MISSING | EV-8014 | Medium | High |
| 19 Workflow engine | Escalation on timeout | MISSING | EV-8014 | Medium | High |
| 19 Workflow engine | SLA tracking on pending approvals | MISSING | EV-8014 | Medium | High |
| 19 Workflow engine | Approval reminders | MISSING | EV-8014 | Medium | High |
| 19 Workflow engine | Document approval chain (snapshot-bound, versioned) | COMPLETE | EV-8015, EV-8016 | High | High |
| 20 Notifications | Email delivery pipeline (outbox, retry, idempotency, lease) | COMPLETE | EV-8017, EV-8018, EV-8019 | High | High |
| 20 Notifications | Business-event triggers: documents engine | COMPLETE | EV-8021 | High | High |
| 20 Notifications | Business-event triggers: leave/payments/transfers/attendance/assets/owner-requests | PARTIAL (verifier: was DISCONNECTED) | EV-8020, EV-8022, EV-8900, EV-8901, EV-8902, EV-8903, EV-8904 | High | High |
| 20 Notifications | In-app notification center (persisted, read/unread) | PARTIAL (verifier: was MOCKED) | EV-8023, EV-8905 | Medium | High |
| 20 Notifications | SMS channel | MISSING | EV-8024, EV-8025 | Medium | High |
| 20 Notifications | Push channel | MISSING | EV-8024 | Low | High |
| 20 Notifications | WhatsApp channel | MISSING | EV-8024, EV-8025 | Medium | High |
| 20 Notifications | Notification templates (data-driven, editable) | MISSING | EV-8026 | Low | High |
| 20 Notifications | Per-user notification preferences | MISSING | EV-8026 | Low | High |
| 20 Notifications | Scheduled reminder digests (expiry-digest, documents-integrity) | COMPLETE | EV-8022 | Medium | High |
| 20 Notifications | Arabic/RTL email formatting | PARTIAL | EV-8027 | Low | Medium |
| 20 Notifications | Operational readiness (SMTP provider actually configured) | PARTIAL (verifier: aligned with finding H-4; was MISSING) | EV-8017, EV-8018, EV-8019, EV-8906, EV-8907 | High | High |
| 23 AI / decision intelligence | LLM/agent integration (chat, generation, NL-to-SQL, ranking) | MISSING | EV-8028, EV-8029, EV-8030 | N/A (by design) | High |
| 23 AI / decision intelligence | On-premise ML face service (correctly not "AI agent") | COMPLETE | EV-8031 | N/A (classification) | High |
| 23 AI / decision intelligence | Workforce rule-based decision support (not AI) | COMPLETE | EV-8032, EV-8033 | N/A (classification) | High |
