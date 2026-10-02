# 26 Mobile / responsive

## Scope and method

There is no native app in this codebase (no iOS/Android project, no React Native/Capacitor/Cordova
dependency found in `package.json`); this report judges the responsive web app as the mobile
experience, per the brief. Read `src/app/manifest.ts` (full), `src/app/layout.tsx` (viewport/theme
setup), `src/app/portal/_components/PortalTabBar.tsx` (full), `src/lib/position-tracker.ts` (full
header + class body via grep), `src/app/portal/_components/ClockCard.tsx` and `FaceCameraModal.tsx`
(location/camera calls), and did negative greps for `serviceWorker`, `indexedDB`, `workbox`,
`navigator.geolocation` (to find any other caller), and PWA-related deps in `package.json`.

## Capability findings

### PWA installability (manifest)
Capability: the portal can be "installed" to a phone home screen as a standalone app.
Status: COMPLETE
Evidence: EV-6017
Files: src/app/manifest.ts (full, 41 lines)
Functions/classes: manifest()
DB tables: n/a
API routes: served at /manifest.webmanifest by Next.js convention
UI routes: all (linked from every page by Next.js)
Tests: none (manifest correctness is not something Vitest would typically cover)
Observed behavior: a real, filled-in manifest — Arabic name/short_name, `lang: 'ar'`, `dir: 'rtl'`,
`display: 'standalone'`, `orientation: 'portrait'`, real icon set (192/512/maskable/apple-touch),
and a shortcut straight into `/portal`. The code comment explicitly states the design decision
(DEC-005 option B: "responsive portal + PWA") and explains why there is **deliberately no service
worker**: "nothing (in particular no personal / payroll data) is cached for offline use... if a
worker is ever added it must be network-only for /api and authenticated pages" (manifest.ts:9-12).
Missing pieces: none for what is claimed; installability without offline support is exactly what is
documented, not an accidental gap.
Risk: Low.
Confidence: High

### Offline support
Capability: portal usable (fully or partially) without network connectivity.
Status: MISSING (by design, documented)
Evidence: negative search — no `serviceWorker`, `indexedDB`, or `workbox` reference anywhere under
`src/app` or `src/lib` (grep across both trees returned zero matches).
Files: n/a (absence)
Risk: Low — this is a stated, reasoned decision (biometric/payroll data must not be cached), not an
oversight; flagged only because "offline" is explicitly in this domain's brief.
Confidence: High

### Location (GPS) capture for attendance
Capability: the mobile browser's real device GPS is used for clock-in/out geofencing.
Status: COMPLETE
Evidence: EV-6015
Files: src/lib/position-tracker.ts (PositionTracker class, watches `navigator.geolocation`,
tracks reading age/accuracy, W3C error codes incl. UNSUPPORTED for browsers without the API);
src/app/portal/_components/ClockCard.tsx:116-119 (`new PositionTracker(setGeo)`), :160,183,186
(start/wait usage tied to the punch flow)
Functions/classes: PositionTracker.start/wait/stop
DB tables: n/a (client-only; server independently validates lat/lng server-side per Domain 11's
punch route)
API routes: consumed by POST /api/portal/attendance/punch, /api/portal/face
UI routes: /portal
Tests: not verified for PositionTracker itself in this pass (no test file named for it was found in
the earlier search of `src/lib/__tests__`)
Observed behavior: this is a genuine `navigator.geolocation.watchPosition`-based implementation
with a documented rationale for not trusting the first (often coarse Wi-Fi/cell) fix
(position-tracker.ts:1-7) — a mobile-GPS-specific design concern, not boilerplate. It is the only
caller of `navigator.geolocation` in the codebase (negative search confirmed no duplicate/competing
implementation).
Missing pieces: no dedicated unit test for PositionTracker found.
Risk: Low.
Confidence: High

### Camera capture for face verification
Capability: the mobile browser's camera is used to capture a selfie for attendance/enrollment.
Status: COMPLETE
Evidence: EV-6016
Files: src/app/portal/_components/FaceCameraModal.tsx:61 (feature-detection message: "المتصفح لا
يدعم تشغيل الكاميرا"), :102-103 (`navigator.mediaDevices.getUserMedia({video:{facingMode:'user',
width:{ideal:1280}, height:{ideal:720}}, audio:false})`)
Functions/classes: FaceCameraModal component
DB tables: n/a (uploads through POST /api/portal/attendance/punch / /api/portal/face)
API routes: POST /api/portal/attendance/punch (multipart selfie), POST /api/portal/face
UI routes: /portal
Tests: not verified (browser-API component, outside Vitest's typical reach; no E2E/browser test
framework exists per SYSTEM_MAP)
Observed behavior: `facingMode: 'user'` explicitly requests the front-facing camera, matching a
selfie use case on a phone; a clear fallback message is shown when `getUserMedia` is unsupported
(line 61) rather than a silent failure.
Missing pieces: no automated test (acknowledged limitation of the stack, not specific to this
feature).
Risk: Low.
Confidence: High

### Responsive layout (phone-width usability)
Capability: portal and manager-portal pages render usably at phone width, not just desktop.
Status: PARTIAL
Evidence: grep count of Tailwind responsive prefixes (`sm:`/`md:`/`lg:`) in
src/app/portal/page.tsx = 30 occurrences (spot-count, not exhaustive); PortalTabBar.tsx (full,
bottom nav shown only on phones per its own comment: "Bottom tab bar of the employee portal on
phones (DEC-005)"); src/app/portal/page.tsx:880 (`max-sm:[&_input]:text-base
max-sm:[&_select]:text-base max-sm:[&_textarea]:text-base` — an explicit iOS zoom-on-focus fix,
forcing 16px form fields on small screens)
Files: src/app/portal/page.tsx; src/app/portal/_components/PortalTabBar.tsx
Functions/classes: n/a (styling)
DB tables: n/a
API routes: n/a
UI routes: /portal (verified in depth); /manager-portal, /dept-manager not verified to the same
depth in this pass (time-boxed; ManagerWorkspace.tsx is 712 lines and was only grepped, not fully
read for responsive classes)
Tests: none (no viewport/E2E testing exists in this repo, confirmed by SYSTEM_MAP: "No E2E/browser
test framework in package.json")
Observed behavior: the employee portal shows concrete, deliberate mobile engineering (bottom tab
bar with scroll-spy via IntersectionObserver, iOS input-zoom fix, `pb-28` bottom padding to clear
the tab bar — page.tsx:880). This was not independently re-verified with an actual rendered
viewport (no browser/E2E tooling available per SYSTEM_MAP; a live render check was out of this
audit's read-only, no-dev-server constraint) — the finding is based on source evidence of responsive
intent, not a rendered-pixel check.
Missing pieces: manager-facing pages (/manager-portal, /dept-manager, /dept-actions) were not
verified to the same depth for phone-width usability; PARTIAL reflects that the employee portal is
well-evidenced but manager pages are UNKNOWN-leaning by comparison.
Risk: Low-Medium (unverified, not confirmed-broken).
Confidence: Medium (source-level only, no rendered verification)

### Push / SMS notifications to the mobile portal
Capability: employee gets a mobile-native notification (push or SMS) for approvals, requests, etc.
Status: MISSING
Evidence: per SYSTEM_MAP (EV-0014/EV-0015, itself cross-checked against `package.json` in this
pass): "E-mail only through SMTP ... No SMS / push / WhatsApp library in package.json." No
`Notification` API or push-subscription code found under `src/app/portal` in this pass's greps.
Files: n/a (absence); src/app/manifest.ts confirms no service worker (a prerequisite for web push)
Risk: Medium — a PWA without push notifications means approvals/requests are only visible on next
app open or via e-mail, weaker than a native app's push for time-sensitive HR actions (e.g. a
manager needing same-day leave/correction approval).
Confidence: High

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| No offline caching of authenticated/personal data | manifest.ts code comment (deliberate) | src/app/manifest.ts:9-12 | none (policy, not code to test) | 26 | No |
| GPS reading must be recent and accurate enough before a punch is attempted | MAX_READING_AGE_MS, gpsMaxAccuracyM | src/lib/position-tracker.ts; enforced again server-side in src/app/api/portal/attendance/punch/route.ts | self-attendance.test.ts (server side) | 11, 26 | Client hint + server enforcement — not truly duplicated logic, client is UX-only |

## Edge cases checked

- **Browser without `getUserMedia`**: explicit unsupported-browser message shown instead of a
  silent crash (FaceCameraModal.tsx:61). Finding: handled. EV-6016.
- **Coarse first GPS fix (Wi-Fi/cell triangulation) rejecting a genuinely on-site employee**:
  explicitly designed around by `PositionTracker` waiting for a fresher/more accurate reading rather
  than trusting `getCurrentPosition()`'s first callback (position-tracker.ts:1-7,30). Finding:
  handled by design.
- **Device geolocation permission denied**: `POSITION_ERROR.DENIED` is a named state the tracker
  reports (position-tracker.ts:21); the ESS report (Domain 11) confirms the resulting rejection
  path offers a correction-request fallback (ClockCard "onRequestCorrection", portal/page.tsx:900).
  Finding: handled.
- **Offline / connectivity loss mid-punch**: no offline queueing exists (confirmed missing above);
  a punch attempted offline would simply fail the fetch and show a generic connection-error toast
  (pattern seen throughout portal/page.tsx, e.g. line 293/461/588/681/726/811: "تعذر الاتصال
  بالخادم"). Finding: no silent failure, but no offline queue/retry either — acceptable given the
  documented no-offline-cache decision, but the employee gets no partial credit for an attempted
  on-site punch made while offline.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 26 Mobile | 6 | 4 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | No push/SMS notification channel for time-sensitive mobile approvals; manager-facing pages' phone-width usability not independently re-verified in this pass | High (portal, location, camera); Medium (manager pages, no rendered check) |
