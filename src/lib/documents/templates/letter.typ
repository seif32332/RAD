// Shared letter layout for Radeef official documents (docs/document-engine).
// Rules (SPEC §4.2 "قواعد كتابة القوالب"): data only from data.json, placed as text; no packages;
// fallback: false; fixed Arabic text without harakat; signature block never split.
// Sent to radeef-render as letter.typ next to the type's main.typ.

#let en(body) = text(lang: "en", dir: ltr, body)
#let muted = luma(95)
#let rule = luma(200)
#let small(body) = text(size: 8pt, fill: muted, body)
#let has(v) = v != none and v != ""

// Arabic (right) / English (left) columns in bilingual letters; Arabic only otherwise.
#let pair(d, ar, en-body) = if d.doc.language == "ar-en" {
  grid(columns: (1fr, 1fr), column-gutter: 10mm, ar, en[#set align(left); #en-body])
} else { ar }

#let letter(d, body) = {
  let bi = d.doc.language == "ar-en"
  let primary = rgb(d.company.primaryColor)

  set document(title: d.doc.titleEn + " " + d.doc.number, author: if has(d.company.legalNameEn) { d.company.legalNameEn } else { d.company.legalNameAr })
  set text(font: ("IBM Plex Sans Arabic",), fallback: false, lang: "ar", size: 10pt, number-type: "lining")
  set par(leading: 0.8em, spacing: 1.1em)

  set page(
    paper: "a4",
    margin: (x: 18mm, top: 40mm, bottom: 30mm),
    header-ascent: 18%,
    header: {
      grid(
        columns: (1fr, auto, 1fr),
        align: (right + horizon, center + horizon, left + horizon),
        column-gutter: 6mm,
        [
          #text(size: 11pt, weight: "bold", fill: primary, d.company.legalNameAr) \
          #small[سجل تجاري: #en(d.company.crNumber)#if has(d.company.unifiedNumber) [ · الرقم الموحد: #en(d.company.unifiedNumber)]]
        ],
        if d.doc.hasLogo { image("logo.png", width: 20mm) } else { [] },
        if has(d.company.legalNameEn) {
          en[
            #set align(left)
            #text(size: 10pt, weight: "bold", fill: primary, d.company.legalNameEn) \
            #small[C.R.: #d.company.crNumber#if has(d.company.unifiedNumber) [ · Unified No.: #d.company.unifiedNumber]]
          ]
        } else { [] },
      )
      v(2mm)
      line(length: 100%, stroke: 1.2pt + primary)
    },
    footer-descent: 25%,
    footer: context {
      line(length: 100%, stroke: 0.5pt + rule)
      v(1mm)
      let cur = counter(page).display(d.doc.pageNumbering)
      let total = numbering(d.doc.pageNumbering, counter(page).final().first())
      grid(
        columns: (1fr, auto, 1fr),
        align: (right, center, left),
        small[رقم المستند: #en(d.doc.number)],
        small[صفحة #cur من #total],
        if bi { en(small[Doc No. #d.doc.number]) },
      )
      let contact = (d.company.addressAr, d.company.phone, d.company.email).filter(has)
      if contact.len() > 0 {
        v(0.5mm)
        align(center, small[#d.company.addressAr#if has(d.company.phone) [ · #en(d.company.phone)]#if has(d.company.email) [ · #en(d.company.email)]])
      }
    },
  )

  // Title and meta
  align(center)[
    #text(size: 17pt, weight: "bold", fill: primary, d.doc.titleAr)
    #if bi [ \ #en(text(size: 13pt, weight: "bold", fill: primary, d.doc.titleEn)) ]
  ]
  v(2mm)
  pair(d,
    [
      *رقم المستند:* #en(d.doc.number) \
      *التاريخ:* #d.doc.issuedGregorianAr م \
      *الموافق:* #d.doc.issuedHijriAr
    ],
    [
      *Document No.:* #d.doc.number \
      *Date:* #d.doc.issuedGregorianEn \
      *Hijri:* #d.doc.issuedHijriEn
    ],
  )
  v(1mm)
  pair(d, [*إلى:* #d.addressee.ar], [*To:* #d.addressee.en])

  body

  // Signature, stamp, QR: one block, never split across pages.
  v(4mm)
  block(breakable: false, width: 100%)[
    #let s = d.signature
    #grid(
      columns: (1fr, 34mm, 32mm),
      column-gutter: 6mm,
      align: (right + top, center + horizon, center + top),
      if s != none [
        #text(weight: "bold", s.titleAr) \
        #s.nameAr
        #if bi and has(s.titleEn) [ \ #en(small[#s.titleEn#if has(s.nameEn) [ — #s.nameEn]]) ]
        #v(1mm)
        #if s.printImage { image("signature.png", width: 45mm) } else { block(height: 14mm, width: 45mm, stroke: (bottom: 0.5pt + rule)) }
      ] else [],
      if s != none and s.printStamp { image("stamp.png", width: 30mm) } else { [] },
      [
        #image("qr.svg", width: 30mm)
        #small[للتحقق من صحة المستند]
        #if bi [ \ #en(small[Scan to verify]) ]
      ],
    )
  ]
}
