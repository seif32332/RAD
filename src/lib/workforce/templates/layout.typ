// Internal workforce reports (محرك القرارات, SPEC §11 «تقارير PDF»): shared page, header, footer and blocks.
// Rules (as for the official document templates): data only from data.json, placed as text (never as
// markup); no packages; one font with fallback: false; fixed Arabic text without harakat; every string is
// already formatted by src/lib/workforce/report-pdf.ts (numbers, dates, numerals): this file formats nothing.
// NOT an official document: no number, no QR, no verification. Every page says so in its footer.

// Arabic-Indic digits are bidi class AN: a "-" between them resolves right to left even inside an LTR run
// ("٢٠٢٦-١٠" printed "١٠-٢٠٢٦"). Such a token is stacked left to right piece by piece (a stack ignores bidi).
#let an-re = regex("[\u{0660}-\u{0669}]")
#let lr(body) = {
  if type(body) == str and body.contains("-") and body.match(an-re) != none {
    let pieces = ()
    for (i, p) in body.split("-").enumerate() {
      if i > 0 { pieces.push(text("-")) }
      if p != "" { pieces.push(text(dir: ltr, p)) }
    }
    box(stack(dir: ltr, ..pieces))
  } else { text(dir: ltr, body) }
}
#let muted = luma(95)
#let rule-color = luma(200)
#let small(body) = text(size: 7.5pt, fill: muted, body)
#let has(v) = v != none and v != ""

// Numeric tokens (amounts, percentages, dates, times, codes with digits such as "wf-1.0.0") inside Arabic
// prose are laid out left to right; otherwise the bidi reordering scrambles them ("2026-09-26" became
// "26-09-2026", "12.75%" became "%12.75"). Every prose string of the data goes through rt(). Each token is
// an atomic box (with its parentheses when it is a bare "(0)"): "أقل من 3,000 (0)" otherwise came out "أقل من 0 (3,000)".
#let num-core = "[A-Za-z0-9\u{0660}-\u{0669}_%+-]*[0-9\u{0660}-\u{0669}](?:[A-Za-z0-9\u{0660}-\u{0669}_.,:/%\u{066B}\u{066C}+-]*[A-Za-z0-9\u{0660}-\u{0669}%])?"
#let num-re = regex("\\(" + num-core + "\\)|" + num-core)
#let arabic-re = regex("[\u{0621}-\u{064A}\u{067E}\u{0686}\u{0698}\u{06A4}\u{06A9}\u{06AF}\u{06CC}]")
#let rt(s) = {
  if type(s) != str { return s }
  // No Arabic letter at all (a Latin name, a formula, a code): the whole string left to right.
  if s.match(arabic-re) == none { return lr(s) }
  let out = ()
  let pos = 0
  for m in s.matches(num-re) {
    if m.start > pos { out.push(s.slice(pos, m.start)) }
    out.push(box(lr(m.text)))
    pos = m.end
  }
  if pos < s.len() { out.push(s.slice(pos)) }
  if out.len() == 0 { "" } else { out.join() }
}

#let tone-fill(tone) = if tone == "warn" { rgb("#FFF7E6") } else if tone == "risk" { rgb("#FDECEC") } else if tone == "ok" { rgb("#ECF8F1") } else { luma(245) }
#let tone-stroke(tone) = if tone == "warn" { rgb("#D98E04") } else if tone == "risk" { rgb("#C0392B") } else if tone == "ok" { rgb("#1E8449") } else { luma(160) }

// ---------------------------------------------------------------------------
// Page: header (company, report title, logo) and footer (internal-report notice, disclaimer, time, version)
// ---------------------------------------------------------------------------

#let report(d, body) = {
  let primary = rgb(d.brand.primaryColor)
  set document(title: d.title, author: d.brand.companyName)
  set text(font: ("IBM Plex Sans Arabic",), fallback: false, lang: "ar", size: 8.5pt, number-type: "lining")
  set par(leading: 0.65em, spacing: 0.85em)

  set page(
    paper: "a4",
    margin: (x: 14mm, top: 30mm, bottom: 30mm),
    header-ascent: 20%,
    header: {
      grid(
        columns: (1fr, auto, 1fr),
        align: (right + horizon, center + horizon, left + horizon),
        column-gutter: 5mm,
        [
          #text(size: 10.5pt, weight: "bold", fill: primary, rt(d.brand.companyName)) \
          #small(rt(d.title))
        ],
        if d.brand.hasLogo { image("logo.png", height: 13mm) } else { [] },
        box(inset: (x: 2mm, y: 1mm), radius: 2pt, stroke: 0.6pt + primary, text(size: 7.5pt, weight: "bold", fill: primary, rt(d.footer.badge))),
      )
      v(1.5mm)
      line(length: 100%, stroke: 1pt + primary)
    },
    footer-descent: 18%,
    footer: context {
      line(length: 100%, stroke: 0.5pt + rule-color)
      v(0.8mm)
      let cur = counter(page).display(d.pageNumbering)
      let total = numbering(d.pageNumbering, counter(page).final().first())
      grid(
        columns: (1fr, auto),
        column-gutter: 4mm,
        align: (right, left),
        text(size: 7.5pt, weight: "bold", fill: rgb("#8A1C1C"), rt(d.footer.internal)),
        small[#d.footer.pageLabel #cur #d.footer.ofLabel #total],
      )
      v(0.3mm)
      small(rt(d.footer.disclaimer))
      v(0.3mm)
      small[#rt(d.footer.generated) · #d.footer.engineLabel #lr(d.footer.engine)]
      if has(d.brand.contact) {
        v(0.3mm)
        small(rt(d.brand.contact))
      }
    },
  )

  // Title and the report's parameters
  align(center)[
    #text(size: 16pt, weight: "bold", fill: primary, rt(d.title))
    #if has(d.subtitle) [ \ #text(size: 9.5pt, fill: muted, rt(d.subtitle)) ]
  ]
  v(1mm)
  if d.meta.len() > 0 {
    block(width: 100%, inset: 2.5mm, radius: 2pt, fill: luma(246))[
      #grid(
        columns: (1fr, 1fr, 1fr),
        column-gutter: 4mm,
        row-gutter: 1.6mm,
        ..d.meta.map(m => [#small(rt(m.label)) \ #text(weight: "bold", if m.num { lr(m.value) } else { rt(m.value) })]),
      )
    ]
  }

  body
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

#let kpis(b, primary) = {
  let n = calc.min(4, calc.max(1, b.items.len()))
  grid(
    columns: (1fr,) * n,
    column-gutter: 2.5mm,
    row-gutter: 2.5mm,
    ..b.items.map(k => block(width: 100%, inset: 2.5mm, radius: 2pt, stroke: 0.6pt + primary.lighten(55%))[
      #small(rt(k.label)) \
      #text(size: 11pt, weight: "bold", fill: primary, if k.num { lr(k.value) } else { rt(k.value) })
      #if has(k.hint) [ \ #small(rt(k.hint)) ]
    ]),
  )
}

#let col-width(c) = if c.w == "auto" { auto } else if c.w == "2fr" { 2fr } else if c.w == "3fr" { 3fr } else { 1fr }

#let data-table(b, primary) = {
  let cols = b.columns
  let body-cell(v, c, style) = {
    let shown = if c.num { lr(v) } else { rt(v) }
    let styled = if style == "total" { text(weight: "bold", shown) } else if style == "muted" { text(fill: muted, shown) } else if style == "risk" { text(fill: rgb("#8A1C1C"), shown) } else { shown }
    let fill = if style == "total" { primary.lighten(82%) } else if style == "risk" { rgb("#FDECEC") } else if style == "muted" { luma(247) } else { auto }
    table.cell(fill: fill, styled)
  }
  // Only numeric (auto) columns: share the full width instead of a narrow table on one side.
  let widths = if cols.any(c => c.w != "auto") { cols.map(col-width) } else { cols.map(c => 1fr) }
  table(
    columns: widths,
    stroke: 0.4pt + rule-color,
    inset: (x: 1.6mm, y: 1.1mm),
    align: right + horizon,
    table.header(..cols.map(c => table.cell(fill: primary.lighten(86%), text(size: 7.8pt, weight: "bold", rt(c.label))))),
    ..b.rows.map(r => r.cells.zip(cols).map(((v, c)) => body-cell(v, c, r.style))).flatten(),
  )
  if has(b.caption) {
    v(-1mm)
    small(rt(b.caption))
  }
}

#let bullets(b) = {
  block(width: 100%, inset: 2.2mm, radius: 2pt, fill: tone-fill(b.tone), stroke: (right: 1.6pt + tone-stroke(b.tone)))[
    #grid(
      columns: (auto, 1fr),
      column-gutter: 1.6mm,
      row-gutter: 1.2mm,
      ..b.items.map(it => (text(fill: tone-stroke(b.tone), "-"), rt(it))).flatten(),
    )
  ]
}

#let callout(b) = {
  block(width: 100%, inset: 2.5mm, radius: 2pt, fill: tone-fill(b.tone), stroke: 0.8pt + tone-stroke(b.tone))[
    #if has(b.title) [#text(weight: "bold", rt(b.title)) \ ]
    #rt(b.text)
  ]
}

#let para(b) = block(width: 100%, rt(b.text))

#let signatures(b, primary) = {
  block(breakable: false, width: 100%)[
    #grid(
      columns: (1fr,) * calc.max(1, b.items.len()),
      column-gutter: 4mm,
      ..b.items.map(s => block(width: 100%, inset: 2.5mm, radius: 2pt, stroke: 0.6pt + rule-color)[
        #small(rt(s.role)) \
        #text(weight: "bold", rt(s.name)) \
        #small(rt(s.date))
        #if has(s.note) [ \ #small(rt(s.note)) ]
        #v(7mm)
        #line(length: 100%, stroke: 0.5pt + rule-color)
        #small(rt(s.signLabel))
      ]),
    )
  ]
}

#let render-block(b, primary) = {
  if b.type == "kpis" { kpis(b, primary) } else if b.type == "table" { data-table(b, primary) } else if b.type == "bullets" { bullets(b) } else if b.type == "callout" { callout(b) } else if b.type == "para" { para(b) } else if b.type == "signatures" { signatures(b, primary) }
}

#let section(s, primary) = {
  v(2.5mm)
  block(sticky: true, width: 100%)[
    #text(size: 11pt, weight: "bold", fill: primary, rt(s.title))
    #if has(s.note) [ \ #small(rt(s.note)) ]
  ]
  for b in s.blocks {
    render-block(b, primary)
    v(1mm)
  }
}

// «المصادر والحالات»: rule, value, effective date, status; the source URL on its own row (as text).
#let sources(src, primary) = {
  v(2.5mm)
  block(sticky: true, width: 100%)[
    #text(size: 11pt, weight: "bold", fill: primary, rt(src.title))
    #if has(src.note) [ \ #small(rt(src.note)) ]
  ]
  if src.rows.len() == 0 {
    small(rt(src.empty))
  } else {
    table(
      columns: (2fr, 1fr, auto, auto),
      stroke: 0.4pt + rule-color,
      inset: (x: 1.6mm, y: 1mm),
      align: right + horizon,
      table.header(..src.columns.map(c => table.cell(fill: primary.lighten(86%), text(size: 7.8pt, weight: "bold", rt(c))))),
      ..src.rows.map(r => {
        let main = (rt(r.label), if r.valueNum { lr(r.value) } else { rt(r.value) }, lr(r.effective), rt(r.status))
        if has(r.url) {
          main + (table.cell(colspan: 4, fill: luma(248), text(size: 6.8pt, fill: muted, lr(r.url))),)
        } else { main }
      }).flatten(),
    )
  }
}
