"""POC acceptance checks (docs/document-engine/POC.md, AC-01..AC-14, AC-16 literal text, AC-19).

Runs in the checker container, never in the renderer container:
    python harness/check.py            -> prints a table, writes out/results.json

Reference text extractor: xpdf 4.x `pdftotext`, run on the host by render.sh (out/<fx>.txt).
Poppler and PyMuPDF reverse multi-character Arabic ligature glyphs (lam-alef etc.) for Typst AND
Chromium output alike, so they are reported as an INFO matrix, not gated. PyMuPDF is used for
geometry, fonts and images.
"""
import json, os, re, statistics, subprocess, sys, unicodedata
import cv2, numpy as np, pymupdf
from fontTools.ttLib import TTFont

OUT, WORK, FONTS = "out", "work", "fonts"
MM = 72 / 25.4
A4 = (595.28, 841.89)
MARGIN_X = 18 * MM
ALLOWED_FONTS = {"IBMPlexSansArabic-Regular", "IBMPlexSansArabic-Bold", "IBMPlexSansArabic-Medium"}
BIDI_CTRL = re.compile("[‎‏‪-‮⁦-⁩]")
ARABIC = re.compile("[؀-ۿ]")
LATIN = re.compile("[A-Za-z]")

results = []


def record(ac, fixture, ok, detail=""):
    results.append({"ac": ac, "fixture": fixture, "ok": bool(ok), "detail": detail})


def squash(s):
    """NFKC, no bidi controls, no whitespace: poppler inserts spurious spaces inside Arabic words."""
    return re.sub(r"\s+", "", BIDI_CTRL.sub("", unicodedata.normalize("NFKC", s)))


PUNCT = re.compile(r"[\s:،,.()«»\"“”/#]+")


def words_in(s, T):
    """Every word of `s` is findable. Used on bilingual pages, where ANY extractor re-orders
    RTL/LTR segments (verified identical for Chromium output, POC.md §B)."""
    return all(squash(w) in T for w in PUNCT.split(s) if w)


def ref_text(fx, page=None):
    return open(os.path.join(OUT, f"{fx}.p{page}.txt" if page else f"{fx}.txt"), encoding="utf-8").read()


def poppler_text(pdf):
    return subprocess.run(["pdftotext", "-enc", "UTF-8", pdf, "-"], capture_output=True, text=True, check=True).stdout


def spans(page):
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                if s["text"].strip():
                    yield s


def find_span(page, needle):
    """First span whose squashed text contains `needle` (PyMuPDF may reverse RTL span text)."""
    n = squash(needle)
    for s in spans(page):
        t = squash(s["text"])
        if n in t or n in t[::-1]:
            return s
    return None


def strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from strings(v)


cmaps = {n: set(TTFont(os.path.join(FONTS, f"{n}.ttf")).getBestCmap()) for n in ("IBMPlexSansArabic-Regular", "IBMPlexSansArabic-Bold")}
fixtures = sorted(d for d in os.listdir(WORK) if d.startswith("F"))

for fx in fixtures:
    pdf = os.path.join(OUT, f"{fx}.pdf")
    data = json.load(open(os.path.join(WORK, fx, "data.json"), encoding="utf-8"))
    doc = pymupdf.open(pdf)
    text = ref_text(fx)
    T = squash(text)
    emp, co, sal = data["employee"], data["company"], data["salary"]
    bi = data["doc"]["language"] == "ar-en"

    # AC-01 A4
    sizes = [(round(p.rect.width, 2), round(p.rect.height, 2)) for p in doc]
    record("AC-01", fx, all(abs(w - A4[0]) <= 0.5 and abs(h - A4[1]) <= 0.5 for w, h in sizes), f"{sizes}")

    # AC-02 searchable Arabic in logical order
    if fx != "F7-inject":
        need = [co["legalNameAr"], emp["fullNameAr"], emp["jobTitleAr"], data["doc"]["titleAr"],
                data["addressee"]["ar"], "تشهد", "ولا يزال على رأس العمل حتى تاريخه", "أعطي هذا الخطاب بناء على طلبه"]
        miss = [n for n in need if not (words_in(n, T) if bi else squash(n) in T)]
        record("AC-02", fx, not miss, f"missing={miss}" if miss else f"{len(need)} strings found")
        pop, mu = squash(poppler_text(pdf)), squash("".join(p.get_text() for p in doc))
        record("INFO-extract", fx, True, f"found by poppler={sum(squash(n) in pop for n in need)}/{len(need)} "
               f"mupdf={sum(squash(n) in mu for n in need)}/{len(need)} xpdf={len(need) - len(miss)}/{len(need)}")

    # AC-04 bidi order inside the Arabic sentence
    if fx in ("F1-ar", "F5-arabnum"):  # single-direction pages; bilingual order is checked visually (AC-03/04)
        seq = ["إقامة رقم", emp["idNumber"], "وجواز سفر رقم", emp["passportNumber"], "وبالرقم الوظيفي", emp["employeeNumber"]]
        if fx == "F1-ar":
            seq = [emp["fullNameAr"], emp["fullNameEn"]] + seq
        pos, last, ok = [], -1, True
        for s in seq:
            i = T.find(squash(s), last + 1)
            pos.append(i)
            ok = ok and i > last
            last = max(last, i)
        record("AC-04", fx, ok, f"positions={pos}")

    # AC-05 bilingual pairs: Arabic right half, English left half, same baseline (+-4pt)
    if bi and fx != "F7-inject":
        # Anchor words free of punctuation and lam-alef (PyMuPDF merges punctuation and reverses ligatures)
        # first addressee word that PyMuPDF can match (no lam-alef, no alef maksura ligatures)
        addr_ar = next(w for w in data["addressee"]["ar"].split() if not re.search("ل[اأإآ]|ى", w))
        addr_en = " ".join(data["addressee"]["en"].split()[:2])
        pairs = [("المستند", "Document No."), (addr_ar, addr_en), ("تشهد", "This is to certify"),
                 ("السكن", "Housing Allowance"), ("الخطاب", "This certificate is issued")]
        mid, bad = doc[0].rect.width / 2, []
        for ar, en in pairs:
            # both halves of a pair must be on the same page (F6 pushes the closing to page 2)
            a = e = None
            for pg in doc:
                a, e = find_span(pg, ar), find_span(pg, en)
                if a and e:
                    break
            if not a or not e:
                bad.append(f"{ar}|{en}: not found"); continue
            ax, ex = (a["bbox"][0] + a["bbox"][2]) / 2, (e["bbox"][0] + e["bbox"][2]) / 2
            dy = abs(a["bbox"][1] - e["bbox"][1])
            if not (ax > mid and ex < mid and dy <= 4):
                bad.append(f"{ar}: ax={ax:.0f} ex={ex:.0f} dy={dy:.1f}")
        record("AC-05", fx, not bad, "; ".join(bad) or f"{len(pairs)} pairs aligned")

    # AC-06 fonts: allow-list, embedded subsets, cmap coverage, no Typst warnings
    fonts = {f[3] for p in doc for f in p.get_fonts()}
    base = {f.split("+", 1)[-1] for f in fonts}
    subset = all(re.match(r"^[A-Z]{6}\+", f) for f in fonts)
    embedded = all(f[1] not in ("", "n/a") for p in doc for f in p.get_fonts())
    chars = {ord(c) for s in strings(data) for c in s if not c.isspace()}
    uncovered = sorted(hex(c) for c in chars if c not in cmaps["IBMPlexSansArabic-Regular"] or c not in cmaps["IBMPlexSansArabic-Bold"])
    stderr = open(os.path.join(OUT, f"{fx}.stderr.txt"), encoding="utf-8").read().strip()
    record("AC-06", fx, base <= ALLOWED_FONTS and subset and embedded and not uncovered and not stderr,
           f"fonts={sorted(base)} subset={subset} embedded={embedded} uncovered={uncovered} stderr={stderr[:80]!r}")

    # AC-07 Hijri + Gregorian (26 Sep 2026 = 15 Rabi II 1448, Umm al-Qura)
    if fx == "F5-arabnum":
        exp = ["١٥ ربيع الآخر ١٤٤٨", "٢٦ سبتمبر ٢٠٢٦"]
    else:
        exp = ["15 ربيع الآخر 1448", "26 سبتمبر 2026"] + (["Rabiʻ II 15, 1448 AH", "26 September 2026"] if bi else [])
    miss = [e for e in exp if not (words_in(e, T) if bi else squash(e) in T)]
    record("AC-07", fx, not miss, f"missing={miss}" if miss else "; ".join(exp))

    # AC-08 logo in the top quarter
    imgs = [(i, im) for i, p in enumerate(doc) for im in p.get_image_info()]
    logo = [im for i, im in imgs if i == 0 and im["bbox"][3] < A4[1] / 4]
    record("AC-08", fx, bool(logo), f"top-quarter images={len(logo)}")

    # AC-09 table order, total = sum, amounts share one alignment edge
    # Row order via the English labels on bilingual pages (LTR runs keep their order in extraction)
    labels = [r["labelEn"] for r in sal["rows"]] + ["Total"] if bi else [r["labelAr"] for r in sal["rows"]] + ["الإجمالي"]
    idx = [T.find(squash(l)) for l in labels]
    order_ok = all(i >= 0 for i in idx) and idx == sorted(idx)
    total_ok = sum(round(float(r["amount"]) * 100) for r in sal["rows"]) == round(float(sal["total"]) * 100)
    # Row amounts occur only in the table; the total also occurs in the paragraphs, so take the
    # total's occurrence closest to the column edge.
    edges = []
    row_amounts = {squash(r["amountText"]) for r in sal["rows"]}
    for p in doc:
        for a in {r["amountText"] for r in sal["rows"]}:
            edges += [round(r.x1, 1) for r in p.search_for(a)]
        if data["doc"]["numerals"] == "arab":  # search_for does not match Eastern Arabic digits; use spans
            edges += [round(s["bbox"][2], 1) for s in spans(p) if squash(s["text"]) in row_amounts or squash(s["text"])[::-1] in row_amounts]
    if edges:
        col = statistics.median(edges)
        tot = [r.x1 for p in doc for r in p.search_for(sal["totalText"])]
        tot += [s["bbox"][2] for p in doc for s in spans(p) if squash(s["text"]) in (squash(sal["totalText"]), squash(sal["totalText"])[::-1])]
        if tot:
            edges.append(round(min(tot, key=lambda x: abs(x - col)), 1))
    spread = round(max(edges) - min(edges), 2) if edges else None
    edge_ok = spread is not None and spread <= 1
    record("AC-09", fx, order_ok and total_ok and edge_ok,
           f"order={order_ok} total={total_ok} right-edge spread={spread}pt n={len(edges)}")

    # AC-10 nothing crosses the side margins (all fixtures; F3 is the long-name case)
    over = []
    for i, p in enumerate(doc):
        for s in spans(p):
            x0, _, x1, _ = s["bbox"]
            if x0 < MARGIN_X - 1 or x1 > p.rect.width - MARGIN_X + 1:
                over.append(f"p{i + 1}:{s['text'][:25]!r}")
    name_ok = all((words_in(n, T) if bi else squash(n) in T) for n in (emp["fullNameAr"], emp["fullNameEn"]))
    record("AC-10", fx, not over and name_ok, f"overflow={over[:3]} fullName={name_ok}")

    # AC-11 amount formatting
    exp = [sal["totalText"], sal["rows"][0]["amountText"], sal["currencyAr"]]
    fmt_ok = all(squash(e) in T for e in exp)
    pattern_ok = re.fullmatch(r"[\d٠-٩]{1,3}([,٬][\d٠-٩]{3})*[.٫][\d٠-٩]{2}", sal["totalText"]) is not None
    record("AC-11", fx, fmt_ok and pattern_ok, f"total={sal['totalText']!r}")

    # AC-12 signature area
    last = doc[-1]
    n_img_last = len(last.get_image_info())
    has_names = squash(data["signature"]["nameAr"]) in T and squash(data["signature"]["titleAr"]) in T
    if data["signature"]["printImage"]:
        ok = n_img_last >= (3 if len(doc) == 1 else 3)  # logo(header) + signature + stamp on the last page
    else:
        ok = n_img_last == 1  # logo only
    record("AC-12", fx, ok and has_names, f"images on last page={n_img_last} printImage={data['signature']['printImage']} names={has_names}")

    # AC-13 QR decodes to the verify URL; symbol >= 22mm
    pix = last.get_pixmap(dpi=200)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY if pix.n == 3 else cv2.COLOR_RGBA2GRAY)
    val, pts, _ = cv2.QRCodeDetector().detectAndDecode(gray)
    size_mm = None
    if pts is not None:
        p = pts.reshape(-1, 2)
        size_mm = float(np.linalg.norm(p[1] - p[0])) / 200 * 25.4
    record("AC-13", fx, val == data["doc"]["verifyUrl"] and size_mm and size_mm >= 22,
           f"decoded={val!r} symbol={size_mm and round(size_mm, 1)}mm")

    # AC-14 pagination
    n = len(doc)
    if fx == "F6-stress":
        per = [squash(ref_text(fx, i + 1)) for i in range(n)]
        num_ok = all(squash(data["doc"]["number"]) in t for t in per)
        # "صفحة X من Y" (xpdf may emit the digits of a bilingual page in either order)
        pages_ok = all(re.search(rf"صفحة{i + 1}من{n}|{n}من{i + 1}صفحة", t) for i, t in enumerate(per))
        header_ok = all(squash("البند") in t and "Item" in t for t in per)
        sig_last = squash(data["signature"]["nameAr"]) in per[-1] and squash("للتحقق من صحة المستند") in per[-1]
        sig_not_first = squash(data["signature"]["nameAr"]) not in per[0]
        sig_img_last = len(doc[-1].get_image_info()) >= 3
        ok = n == 2 and num_ok and pages_ok and header_ok and sig_last and sig_not_first and sig_img_last
        record("AC-14", fx, ok, f"pages={n} docNo/page={num_ok} pageXofY={pages_ok} header-repeat={header_ok} "
               f"sig-block-last={sig_last and sig_img_last} not-split={sig_not_first}")
    else:
        pg = "١ من ١" if data["doc"]["numerals"] == "arab" else "1 من 1"
        record("AC-14", fx, n == 1 and all(squash(w) in T for w in ("صفحة", pg)), f"pages={n}")

    # AC-16 (literal part): markup-looking data is printed verbatim, never evaluated
    if fx == "F7-inject":
        lits = ['#read("/etc/passwd")', "*x*", "$y$", "<l>", "@ref", '#panic("boom")', "`raw`", "#let z = 1",
                '#import "@preview/tiaoma:0.3.0": qrcode', "= Heading ]] #{ 1 + 1 }"]
        # RTL cells put a leading "#" at the far end of the run, so match without "#" and count them
        miss = [l for l in lits if squash(l.replace("#", "")) not in T.replace("#", "")]
        miss += ["#-count"] if T.count("#") < sum(l.count("#") for l in lits) else []
        record("AC-16", fx, not miss and "root:" not in text, f"missing={miss}" if miss else "all injected strings printed literally")

    # AC-19 size
    kb = os.path.getsize(pdf) / 1024
    record("AC-19", fx, kb < 300 or n > 1, f"{kb:.0f} KB")

json.dump(results, open(os.path.join(OUT, "results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
fails = [r for r in results if not r["ok"]]
for r in results:
    print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['ac']:<6} {r['fixture']:<11} {r['detail']}")
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
