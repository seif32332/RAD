# Nitaqat Mutawar 2026 extraction: evidence log

Working dir: `nitaqat/`. Extraction date: 2026-09-26.

## 1. Source currency
- `nit2026_03.pdf` was re-downloaded from `https://www.hrsd.gov.sa/sites/default/files/2026-03/ntaqat-almtwr.pdf` (`live_ntaqat.pdf`). It is byte-identical: sha256 `8ecb78d8…2e11`, HTTP last-modified 2026-06-01.
- The HRSD guide page (last updated 2026/09/23) links this 2026-03 file as the current guide.
- The January version is `nit2026_01.pdf` (Word export, 2026-01-21).

## 2. How the annex (المرفق 1) was read
The annex is on PDF pages 9–15 (printed 8–14) of the March file and pages 8–14 of the January file. It has 41 activities × 4 bands = 164 rows.

Three independent reads were made:
1. **Structural read (`extract.py` → `raw_03.json`).** The table uses teal-filled cells for activity names, fill RGB (0.08, 0.51, 0.52). PyMuPDF `get_drawings()` gives one teal rectangle per activity. Inside each rectangle, the band label lines (`أخضر منخفض/متوسط/مرتفع`, `بلاتيني`) define the rows. The numbers on each row are then sorted by x. The column order left→right is 2028, 2027, 2026, curve constant (m); the header on p9 confirms it: `القيمة الثابتة لعام 2028 | …2027 | …2026 | القيمة الثابتة للمنحنى | اللون | النشاط`. Every row had exactly 4 numbers, with no issues and no leftover text except the header.
2. **Geometric read (`extract01.py` → `rows_03.json`, `rows_01.json`).** Rows come from the grey row-separator rectangles on the name cell's left edge, and the band is taken from row order. It gave the same values as read 1 for all 164 March rows. This method was also used for January, because its band labels are garbled by broken Arabic glyph mapping in that file's text layer.
3. **Visual read.** Every March annex page was rendered at 170 dpi (`hi03/p09.png` … `p15.png`) and compared number by number with the printed dump. All 164 rows match. Per-activity crops are in `crops/pNN_KK.png` (path stored in each JSON row as `cropImage`).

Result: **41 activities, all HIGH confidence.** Each activity has its own merged teal cell and exactly 4 labelled band rows, so no name block is ever next to a grouped number block. **AMBIGUOUS rows: none.**

Observations recorded in the row `note` fields:
- **Activity codes.** The guide prints no codes. The codes in the JSON come from the official HRSD calculator dropdown (`calc_options.json`, `select#ddlNitaqatActivivty`), which has 41 options and matches all 41 annex names 1:1. Four names are spelled differently there:
  - `الطاقة والمياه وخدماتها` → `أنشطة …`
  - `المقاهي و محلات…`
  - `حراسات أمنية` (the guide prints `أمينة`, sic)
  - `كيانات المجمعة`
- `السلع النسائية، بيع الهواتف المحمولة وصيانتها` is one cell and one number block covering two sub-activities (calculator code 462). This is not ambiguous for the data, but it is worth knowing.
- **No establishment-size segmentation exists in the annex.** Size enters only through ln(X).
- **Signs.** `-0.37` (construction; cleaning & laundries, Low/Medium Green) is printed with a leading minus. Numerous `m = 0.00` rows are flat thresholds.
- **Sanity checks (`build_curves.py`).** For every activity and year, LG ≤ MG ≤ HG ≤ PLAT holds for X from 6 to 50,000, and Y never exceeds 100 in that range.

## 3. January vs March cross-check
All 164 rows were compared programmatically: **0 differences** in m, c2026, c2027 or c2028. The annex numbers did not change between versions.

Visual samples (March crop vs January render):

| Activity | Band | m | c2026 / c2027 / c2028 | Jan | Mar |
|---|---|---|---|---|---|
| الإنتاج الزراعي والحيواني وخدماتها واندية الفروسية | all 4 | 0.19 / 0.58 / 0.58 / 0.58 | LG 4.38×3 … PLAT 14.38×3 | `hi01/p08.png` | `hi03/p09.png` |
| أنشطة الهيدروكربونات وعملياتها | LG | 4.98 | 5.62 / 7.62 / 9.62 | `hi01/p08.png` | `hi03/p09.png` |
| المؤسسات المالية | all 4 | 2.60 | 50 / 57 / 62 / 65 (flat across years) | `crop_jan_p12_financial.png` | `crops/p13_29.png` |
| خدمات الاعمال | LG | 1.03 | 33.78 / 36.78 / 39.78 | `crop_jan_p13_business.png` | `crops/p14_30.png` |

The non-annex text of the two versions was compared visually for the band-consequence pages only (Jan p7 vs Mar p8: identical). The rest of the January text layer is garbled, so no full text diff was attempted.

## 4. Rules pages
- **Formula and definitions:** p5 (printed 4) and p3 (printed 2). The log is natural: `القيمة اللوغاريثمية الطبيعية`.
- **Band ranges:** p6 (printed 5). The printed inequality signs are reversed in the logical text; the monotone reading is recorded in `nitaqat_rules.json`.
- **Consequences:** p7–p8 (printed 6–7).
- **Not in the guide:** weights, the ≤5 rule and calculation windows. These were taken from:
  - Qiwa "What is Nitaqat and how is it calculated?" (rendered in the in-app browser, page last modified 10/09/2026)
  - the HRSD calculator page footnotes
  - HRSD news 777585

## 5. Localization decisions (`loc/*.pdf`)
The Word-exported PDFs render badly with MuPDF (disconnected glyphs), so pdfium renders `loc/*_f*.png` were used for the visual pass. Their text layers also swap ligature characters, for example `فين`→`فني`, `مخترب`→`مختبر`, `غري`→`غير`. Because of this, Arabic occupation names for dental, pharmacy and engineering-technical were **transcribed from the rendered images**, not the text layer. Codes were cross-checked against a coordinate-based text-layer extraction (engineering-technical: 188/188 codes identical). The macOS-exported files (eng2026, mkt) have clean text.

Pages visually verified:

| File | Pages |
|---|---|
| sales | p4, p6 |
| mkt | p4, p6 |
| pm | p4, p6 |
| eng2026 | p4, p5, p7 |
| engtech | p4, p5 (two crops), p6 (two crops) |
| pharm | p4, p5, p6 |
| dental | p4, p6 |
| acct | p6, p9 |

Only the engtech p7 timeline was taken from the text layer; its digits are clean.

Discrepancies found:
- mkt: the text layer gives `202 243`; the visual read is **243202**.
- `find_tables()` produced wrong codes for sales (`243190`, `243160`); the visual and text layer agree on **243109** and **243106**.
- sales and pm guides have **no minimum-wage clause**, so `minWage = null` and status is PARTIAL.
- pharm example: labelled 45% but computed at 35%.
- mkt example: says "مهن المبيعات" (copy-paste from the sales guide).
- engtech cover date misprinted as "62/01/2025".

## 6. AMBIGUOUS rows
None. All 164 curve rows are HIGH confidence.
