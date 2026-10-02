# 27 Arabic / RTL

## Scope and method

Read `src/app/layout.tsx` (lang/dir/font setup), `src/lib/dates.ts` (full head + grep),
`src/lib/muqeem/hijri.ts` (head), `src/lib/transliterate.ts` (head, ~60 lines read),
`src/lib/money.ts` (head, Arabic-Indic digit handling), `src/lib/documents/templates/letter.typ`
and grepped all `.typ` templates for `lang:`/`dir:`. Negative-searched `package.json` for i18n
libraries and greped `src/app` for `dir="rtl"` usage counts. This domain is judged against the
brief's checklist: bilingual support vs. hard-coded Arabic, RTL correctness, Hijri/Gregorian dates,
currency formatting, validation messages, PDFs, mixed Arabic/English data, transliteration.

## Capability findings

### Bilingual UI (Arabic/English toggle)
Capability: the product can be used in English, or a user can switch language.
Status: MISSING
Evidence: EV-6019, EV-6020
Files: src/app/layout.tsx:31 (`<html lang="ar" dir="rtl" ...>` — hard-coded, no conditional);
package.json (no `next-intl`, `next-i18next`, `react-intl`, `i18next`, or any locale-routing
dependency; negative grep for `i18n|intl|locale` across `package.json` returned no matches)
Risk: Medium — this is a deliberate Arabic-first product (per SYSTEM_MAP, "Arabic-first UI"), so
MISSING here is a description of scope, not necessarily a defect; flagged because the domain brief
explicitly asks "is there i18n or hard-coded Arabic only?" The product has no path to serve an
English-speaking employee or an English-preferring expatriate workforce without a full UI
translation project — there is no `[locale]` routing segment, no message-catalog mechanism, and no
per-user language preference field found in `Employee`/`User` in this pass.
Confidence: High

### RTL layout correctness
Capability: the whole app renders right-to-left, consistently, not just individual components.
Status: COMPLETE
Evidence: src/app/layout.tsx:31 (dir="rtl" set once at the `<html>` root, inherited everywhere by
default — the correct, single-source-of-truth approach rather than per-component `dir="rtl"`
sprinkling); 15 files under `src/app` additionally set an explicit `dir="rtl"` (grep count), which
on inspection (e.g. `src/app/my-documents/page.tsx:27`) are stand-alone pages rendered outside the
normal layout tree (public/session-limited pages), where the explicit attribute is necessary
because they do not inherit from the authenticated shell's layout the same way.
Files: src/app/layout.tsx; src/app/my-documents/page.tsx (example of an explicit-dir page)
Observed behavior: RTL is applied structurally (html-level `dir`), not simulated with CSS
transforms — the correct approach for a genuinely RTL-first product, avoiding the common bug class
of "LTR app with RTL text" mixed directionality.
Missing pieces: not independently verified with a rendered screenshot in this pass (read-only,
no-dev-server audit); judged from markup/attributes only.
Risk: Low.
Confidence: Medium (source-level only)

### Font (Arabic typography)
Capability: a proper Arabic typeface is used, not a Latin fallback font rendering Arabic poorly.
Status: COMPLETE
Evidence: src/app/layout.tsx:2,7-11 (`Cairo` from `next/font/google`, weights including 800/900
specifically "to back the font-extrabold / font-black classes used throughout the UI" per the code
comment); src/lib/documents/templates/letter.typ:22 (`font: ("IBM Plex Sans Arabic",),
fallback: false, lang: "ar"`)
Files: src/app/layout.tsx; src/lib/documents/templates/letter.typ
Observed behavior: two purpose-fit Arabic fonts are used — Cairo for the web UI, IBM Plex Sans
Arabic for the Typst-rendered official PDFs — both are real Arabic-designed typefaces, not a Latin
font with a "hopefully it has Arabic glyphs" fallback. `fallback: false` in the PDF template is a
deliberate choice to fail loudly rather than silently substitute a wrong font for an official
document.
Risk: Low.
Confidence: High

### Hijri / Gregorian date handling
Capability: the system understands and can convert between Hijri and Gregorian calendars where the
Saudi context requires it (Muqeem, visas, government forms).
Status: PARTIAL
Evidence: EV-6021, EV-6022
Files: src/lib/dates.ts:1-40 (Gregorian-only, Riyadh-timezone storage convention: "date-only values
... are stored as UTC midnight of that calendar day"; explicit `RIYADH_OFFSET_MS` handling);
src/lib/muqeem/hijri.ts:1-20 (`Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', ...)` —
correct use of the Umm al-Qura calendar, the Saudi-official Hijri calendar, not a generic Islamic
calendar approximation)
Observed behavior: the core HR date library (`src/lib/dates.ts`) is deliberately Gregorian-only and
documents its storage convention precisely (UTC-midnight-per-Riyadh-calendar-day); Hijri conversion
exists **only** inside `src/lib/muqeem/hijri.ts`, scoped to talking to the Muqeem government
integration, which is documented as expecting Hijri dates for specific fields (e.g. visa
`returnBefore`). There is no evidence in this pass of a Hijri date *displayed to the employee* or
*entered by HR* anywhere in the ESS/MSS UI (portal/page.tsx uses `formatDate`/`formatDateShort` from
`src/lib/dates.ts` throughout, all Gregorian).
Missing pieces: for a Saudi HR product, HR staff and employees conventionally expect to see Hijri
dates alongside Gregorian ones for things like iqama/visa expiry (which the portal does show, e.g.
`MedicalInsurance.expiryDate`, visa fields) — this pass found no employee-facing Hijri display,
meaning expiry dates are Gregorian-only in the UI even though the underlying Muqeem integration
already has correct Hijri conversion machinery available to reuse.
Risk: Medium — not a correctness bug (Gregorian dates are unambiguous and legally valid), but a
product-completeness gap against Saudi HR user expectations; the fix is low-effort since the
conversion function already exists and is correct.
Confidence: High

### Currency formatting (SAR, Arabic-Indic digit input)
Capability: money is displayed and parsed correctly for a Saudi audience (SAR, ر.س, Arabic-Indic
digits).
Status: COMPLETE
Evidence: src/lib/money.ts:9-21 (`toNumber` strips/converts both Arabic-Indic (`٠-٩`) and
Extended/Persian Arabic-Indic (`۰-۹`) digit ranges, plus Arabic thousands separator `٬` and Arabic
decimal separator `٫`, before parsing); src/app/portal/page.tsx:832-836 (payslip print literal "ر.س"
suffix, not a raw "SAR")
Files: src/lib/money.ts; src/app/portal/page.tsx
Observed behavior: this is genuine, specific handling for a bilingual-digit input reality (a Saudi
user may type amounts using either Western or Arabic-Indic numerals depending on their keyboard) —
not a naive `Number(str)` that would silently fail or truncate on Arabic-Indic input.
Risk: Low.
Confidence: High

### Validation and error messages
Capability: form/API validation errors are in Arabic and are specific, not generic English
fallbacks.
Status: COMPLETE
Evidence: sampled across every route read in Domains 11/12 (e.g.
src/app/api/portal/correction/route.ts:36 `'لا يمكنك تقديم طلب لموظف آخر'`; :49
`'يوجد لديك طلب مطابق قيد الانتظار حالياً.'`; src/app/api/manager-portal/route.ts:350
`'عدد الساعات يجب أن يكون بين 0 و 24 ساعة'`; src/app/portal/page.tsx:772-781, mobile/email/IBAN
inline validation messages)
Files: every API route file read in this audit; src/app/portal/page.tsx
Observed behavior: every user-facing error string checked across both domains was Arabic and
specific to the failure (not a generic "Invalid request" or an English string leaking through). No
counter-example was found in this pass.
Risk: Low.
Confidence: High (within the files read; not exhaustively checked across all 153 API routes)

### Transliteration (Arabic -> English name suggestion)
Capability: HR can auto-generate a suggested English spelling of an Arabic name/organization for
bilingual records.
Status: COMPLETE
Evidence: src/lib/transliterate.ts:1-30+ (letter map, diacritics stripping, an `ORG_WORDS`
dictionary for organizational terms with established English forms, a `PERSON_NAMES` dictionary for
common first names with conventional spellings, e.g. "عبدالله" -> "Abdullah" rather than a
letter-by-letter "Abdallh")
Files: src/lib/transliterate.ts
Observed behavior: this is a real, curated transliteration table (not a naive character map) — it
specifically handles the common case where a phonetic letter-by-letter transliteration produces an
unnatural spelling (e.g. compound names, tashkeel, organizational vocabulary), and the code comment
is explicit that the result is "only a suggestion the user can edit," correctly scoping it as an
assist rather than an authoritative field.
Missing pieces: not verified against test cases in this pass; no dedicated test file was found for
transliterate.ts in the earlier `src/lib/__tests__` listing pass, though this is a low-risk pure
function.
Risk: Low.
Confidence: Medium (no test coverage confirmed)

### Mixed Arabic/English data (bilingual names, org units)
Capability: the data model supports both Arabic and English forms of a person/org name and displays
the right one in context.
Status: PARTIAL
Evidence: src/app/portal/page.tsx:67-76 (`PortalEmployee` interface has `firstNameArabic`/
`lastNameArabic` but no corresponding English fields consumed by the portal UI at all); the
document-engine Typst template (`letter.typ:6`) has an explicit `en(body)` wrapper for embedding
Latin-script runs (e.g. an English company name) inside an otherwise-Arabic RTL document.
Files: src/app/portal/page.tsx; src/lib/documents/templates/letter.typ
Observed behavior: the schema clearly carries both Arabic and English name fields at the Employee
level (implied by `firstNameArabic` naming convention, and confirmed indirectly by
`onboardingSchema.firstNameEnglish`/`lastNameEnglish` in `src/app/api/manager-portal/route.ts:282-283`),
but the employee-facing ESS portal UI reads and displays **only** the Arabic fields
(`employee.firstNameArabic`, `.lastNameArabic` — page.tsx:552, 874, 889-894) — there is no English
name shown anywhere in the portal, even though the data exists for onboarding/HR-facing screens.
This is consistent with "Arabic-first" being the whole product's design intent, but it does mean an
English-first user (e.g. certain expatriate staff) sees only their Arabic name in their own
self-service portal.
Missing pieces: no employee-facing display of the English name fields in the ESS portal.
Risk: Low-Medium (consistent with product intent, but a real completeness gap for
English-preferring users).
Confidence: High

### Official PDF documents in Arabic (document engine)
Capability: HR letters/certificates issued through the document engine render as correct
right-to-left Arabic PDFs.
Status: PARTIAL
Evidence: src/lib/documents/templates/letter.typ:6,22 (real `lang: "ar"` set with a dedicated Arabic
font and `fallback: false`; a distinct `en()` helper for embedded Latin runs — i.e. genuine
bidirectional text handling, not a hack); however, per the SYSTEM_MAP and this session's git status,
the document engine (including `9p_transfer_decision` migration and `transfer-decision.typ`) is
**uncommitted, in-progress work on the dirty working tree** — this ESS/MSS/Mobile/RTL/UX audit pass
did not independently re-render or test a PDF (that would require the render sidecar service,
explicitly out of scope per the audit's read-only/no-services constraint), so PDF *rendering
correctness* (not just template source correctness) is not verified here.
Files: src/lib/documents/templates/*.typ (11 template files found); src/lib/documents/templates/letter.typ
Observed behavior: template source shows correct RTL/Arabic-font intent; actual rendered-PDF
verification is Domain 04's responsibility and this audit's own hard rules explicitly forbid
starting the render service.
Missing pieces: no rendered-PDF visual verification in this pass (by design/constraint).
Risk: Low (template-level evidence is strong; residual risk is purely "was it actually tested
end-to-end," which is Domain 04's finding, not this one's).
Confidence: Medium (source-only)

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Dates are stored as UTC-midnight of the Riyadh calendar day | RIYADH_OFFSET_MS convention | src/lib/dates.ts:1-18 | not verified in this pass (Domain 07/08 territory) | 07, 08, 27 | No — single module |
| Hijri conversion uses the Umm al-Qura calendar, scoped to Muqeem only | Intl.DateTimeFormat('en-u-ca-islamic-umalqura...') | src/lib/muqeem/hijri.ts:9-14 | not verified in this pass | 10, 27 | No |
| Money parsing accepts Arabic-Indic and Extended Arabic-Indic digits | toNumber() digit-range replace | src/lib/money.ts:9-21 | not verified in this pass | 09, 27 | No |
| The portal displays only Arabic name fields, never English, even when both exist | UI field selection | src/app/portal/page.tsx:552,874,889-894 | none | 11, 27 | No |

## Edge cases checked

- **User typing an amount with Arabic-Indic digits (e.g. "١٢٣٤.٥٠")**: correctly parsed by
  `toNumber()` (money.ts:12-20). Finding: handled. 
- **Organization/person name transliteration for common compound Arabic names** (e.g. "عبدالرحمن"):
  a curated dictionary entry exists rather than a naive per-letter concatenation
  (transliterate.ts, `PERSON_NAMES` map). Finding: handled for the names in the dictionary; any name
  not in the dictionary falls back to per-letter transliteration (not independently verified for
  quality in this pass).
- **Employee expiry dates (iqama, insurance, visa) shown only in Gregorian**: confirmed no Hijri
  display anywhere in the ESS portal despite the underlying conversion utility already existing for
  Muqeem. Finding: gap (see "Hijri / Gregorian date handling" above).
- **Mixed-script official letters (Arabic body with an English company name or clause)**: the Typst
  template has a dedicated `en()` wrapper (letter.typ:6) rather than forcing the whole run through
  Arabic shaping. Finding: handled at the template-source level.
- **RTL for public, non-authenticated, or session-limited pages** (e.g. `/my-documents` for a
  leaver): sets its own explicit `dir="rtl"` rather than relying on inheritance from the normal
  authenticated shell layout. Finding: handled deliberately (my-documents/page.tsx:27).

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 27 Arabic/RTL | 8 | 4 | 3 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | No bilingual (English) UI path exists at all; Hijri dates are implemented only for the Muqeem integration and never surfaced to HR/employees despite the conversion utility already existing | High (RTL structure, fonts, money, validation messages); Medium (PDF rendering, only source-verified) |
