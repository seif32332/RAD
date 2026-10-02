# Matrix F (Group F: 11 ESS, 12 MSS, 26 Mobile, 27 Arabic/RTL, 30 UX)

| Domain | Capability | Status | Evidence | Criticality | Confidence |
|---|---|---|---|---|---|
| 11 ESS | Profile / dashboard (GET /api/portal) | COMPLETE | EV-6001, EV-6007 | High | High |
| 11 ESS | IDOR protection across ESS write endpoints | COMPLETE | EV-6001..EV-6007 | Critical | High |
| 11 ESS | Attendance (self clock-in/out, GPS + face) | COMPLETE | EV-6002, EV-6015, EV-6016 | Critical | High |
| 11 ESS | Leave requests, balance, cancellation | COMPLETE | portal/page.tsx:300-432,435-465,645-685 | High | Medium |
| 11 ESS | Attendance correction requests (self-service) | COMPLETE | EV-6003 | High | High |
| 11 ESS | Loan request | PARTIAL | portal/page.tsx:687-730 (server side deferred to Domain 09) | Medium | Low |
| 11 ESS | Letters / certificates (document engine + fallback) | PARTIAL | portal/page.tsx:146-151,554-561 (primary path deferred to Domain 04) | Medium | Low |
| 11 ESS | Asset (custody) self-request | COMPLETE | EV-6012 | Medium | High |
| 11 ESS | Contract termination / resignation request | COMPLETE | EV-6005 | High | High |
| 11 ESS | Face enrollment / biometric consent lifecycle | COMPLETE | EV-6004 | Critical | High |
| 11 ESS | Payslip view / print | PARTIAL | portal/page.tsx:817-841 (client-built print, not signed PDF; only last 5 shown) | Low | High |
| 11 ESS | Total rewards statement | COMPLETE | EV-6006 | Medium | Medium |
| 11 ESS | Evaluation acknowledgment | COMPLETE | portal/page.tsx:313-323,467-493 | Medium | Medium |
| 11 ESS | Circulars shown without company scoping within a tenant | PARTIAL | EV-6027 | Medium | High |
| 12 MSS | Company->Branch->Department->Team scoping | COMPLETE | EV-6008, EV-6009, EV-6013 | Critical | High |
| 12 MSS | Team dashboard (department detail, stats) | COMPLETE | EV-6013, EV-6014 | High | High |
| 12 MSS | Approvals: leave, attendance correction (manager stage) | COMPLETE | dept-manager/route.ts:163-199; hr-workflows.ts multi-site assertCanManageEmployee calls | Critical | High |
| 12 MSS | Overtime / work-task / penalty assignment | COMPLETE | EV-6011 | High | High |
| 12 MSS | Hiring request / onboarding submission (manager-initiated) | COMPLETE | manager-portal/route.ts:262-269,277-310,405-482 | Medium | High |
| 12 MSS | Return-from-leave notice | COMPLETE | EV-6039 | Medium | Medium |
| 12 MSS | Asset requests raised on behalf of a team member | COMPLETE | EV-6012 | Medium | High |
| 12 MSS | Manager's own request history / team history feed | COMPLETE | manager-portal/route.ts:105-217 | Medium | High |
| 12 MSS | Scope-boundary functions lack dedicated automated tests | PARTIAL (gap) | EV-6029, EV-6900, EV-6901 | Medium (adjusted from High by adversarial verification F-1) | High |
| 26 Mobile | PWA installability (manifest) | COMPLETE | EV-6017 | Medium | High |
| 26 Mobile | Offline support | MISSING (by design) | EV-6018 | Low | High |
| 26 Mobile | Location (GPS) capture for attendance | COMPLETE | EV-6015 | Critical | High |
| 26 Mobile | Camera capture for face verification | COMPLETE | EV-6016 | Critical | High |
| 26 Mobile | Responsive layout (phone-width usability) | PARTIAL | portal/page.tsx responsive classes; PortalTabBar.tsx; manager pages unverified | Medium | Medium |
| 26 Mobile | Push / SMS notifications to the mobile portal | MISSING | SYSTEM_MAP EV-0014/0015, corroborated | Medium | High |
| 27 Arabic/RTL | Bilingual UI (Arabic/English toggle) | MISSING | EV-6019, EV-6020 | Medium | High |
| 27 Arabic/RTL | RTL layout correctness | COMPLETE | src/app/layout.tsx:31; 15-file dir="rtl" sample | High | Medium |
| 27 Arabic/RTL | Font (Arabic typography) | COMPLETE | src/app/layout.tsx:2,7-11; EV-6035 | Medium | High |
| 27 Arabic/RTL | Hijri / Gregorian date handling | PARTIAL | EV-6021, EV-6022 | Medium | High |
| 27 Arabic/RTL | Currency formatting (SAR, Arabic-Indic digits) | COMPLETE | EV-6033 | Medium | High |
| 27 Arabic/RTL | Validation and error messages | COMPLETE | sampled across Domains 11/12 routes | Medium | High |
| 27 Arabic/RTL | Transliteration (Arabic -> English name suggestion) | COMPLETE | EV-6034 | Low | Medium |
| 27 Arabic/RTL | Mixed Arabic/English data (bilingual names) | PARTIAL | EV-6036 | Low | High |
| 27 Arabic/RTL | Official PDF documents in Arabic (document engine) | PARTIAL | EV-6035 (source only, not rendered in this pass) | Medium | Medium |
| 30 UX | Navigation / menu, permission-mirrored | COMPLETE | EV-6024, EV-6030 | High | High |
| 30 UX | Error boundaries (route-level) | PARTIAL | EV-6023, EV-6038 | Medium | High |
| 30 UX | Loading states (route-level) | PARTIAL | EV-6023, EV-6038; portal/page.tsx:495-506 (ad hoc pattern) | Low | Medium |
| 30 UX | Empty states | COMPLETE | portal/page.tsx:526-534,920 | Low | Medium |
| 30 UX | Confirmation dialogs for destructive/formal actions | COMPLETE | EV-6031, EV-6032 | Medium | High |
| 30 UX | Toast / inline feedback for async actions | COMPLETE | consistent pattern across Domain 11/12 submit handlers | Medium | High |
| 30 UX | Fetch-target integrity (no calls to nonexistent APIs) | COMPLETE (sample) | EV-6025 | Medium | Medium |
| 30 UX | Pagination on request/queue lists | PARTIAL | EV-6026 | Medium | Medium |
| 30 UX | Dead buttons / stub features | COMPLETE (no counter-example found) | EV-6037 | Low | Medium |
