// POC template: salary certificate (ar | ar-en).
// All values come from data.json as plain strings and are placed as text, never evaluated as
// markup. Assets (logo, signature, stamp, QR) are files next to this template.
// Fixed Arabic text carries no harakat/tanween: Typst 0.15 maps combining marks to duplicated
// text in the PDF, which breaks copy/search (see docs/document-engine/POC.md, B).

#let d = json("data.json")
#let bi = d.doc.language == "ar-en"
#let primary = rgb(d.company.primaryColor)
#let muted = luma(95)
#let rule = luma(200)

#let en(body) = text(lang: "en", dir: ltr, body)
#let small(body) = text(size: 8pt, fill: muted, body)

#set document(title: d.doc.titleEn + " " + d.doc.number, author: d.company.legalNameEn)
#set text(font: ("IBM Plex Sans Arabic",), fallback: false, lang: "ar", size: 10pt, number-type: "lining")
#set par(leading: 0.8em, spacing: 1.1em)

#set page(
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
        #small[سجل تجاري: #d.company.crNumber · الرقم الموحد: #d.company.unifiedNumber]
      ],
      image("logo.png", width: 20mm),
      en[
        #set align(left)
        #text(size: 10pt, weight: "bold", fill: primary, d.company.legalNameEn) \
        #small[C.R.: #d.company.crNumber · Unified No.: #d.company.unifiedNumber]
      ],
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
      small[رقم المستند: #d.doc.number],
      small[صفحة #cur من #total],
      if bi { en(small[Doc No. #d.doc.number]) },
    )
    v(0.5mm)
    align(center, small[#d.company.addressAr · #en(d.company.phone) · #en(d.company.email)])
  },
)

// ---------- helpers ----------
#let pair(ar, en-body) = if bi {
  grid(columns: (1fr, 1fr), column-gutter: 10mm, ar, en[#set align(left); #en-body])
} else { ar }

#let cell-fill(row) = if row == 0 { primary.lighten(85%) }

// ---------- title & meta ----------
#align(center)[
  #text(size: 17pt, weight: "bold", fill: primary, d.doc.titleAr)
  #if bi [ \ #en(text(size: 13pt, weight: "bold", fill: primary, d.doc.titleEn)) ]
]

#v(2mm)
#pair(
  [
    *رقم المستند:* #d.doc.number \
    *التاريخ:* #d.doc.issuedGregorianAr م \
    *الموافق:* #d.doc.issuedHijriAr
  ],
  [
    *Document No.:* #d.doc.number \
    *Date:* #d.doc.issuedGregorianEn \
    *Hijri:* #d.doc.issuedHijriEn
  ],
)

#v(1mm)
#pair([*إلى:* #d.addressee.ar], [*To:* #d.addressee.en])

// ---------- body ----------
#pair(
  [
    تشهد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", d.employee.fullNameAr)
    (#en(d.employee.fullNameEn))، #d.employee.nationalityAr الجنسية، ويحمل #d.employee.idLabelAr رقم
    #en(d.employee.idNumber) وجواز سفر رقم #en(d.employee.passportNumber)، يعمل لدى الشركة بوظيفة
    «#d.employee.jobTitleAr» اعتبارا من #d.employee.joinDateAr م، وبالرقم الوظيفي #en(d.employee.employeeNumber)،
    ولا يزال على رأس العمل حتى تاريخه، ويتقاضى راتبا شهريا إجماليا قدره
    #text(weight: "bold")[#d.salary.totalText #d.salary.currencyAr] موزعا كما يلي:
  ],
  [
    This is to certify that Mr. #text(weight: "bold", d.employee.fullNameEn), #d.employee.nationalityEn national,
    holder of #d.employee.idLabelEn No. #d.employee.idNumber and Passport No. #d.employee.passportNumber,
    has been employed by #d.company.legalNameEn as "#d.employee.jobTitleEn" since #d.employee.joinDateEn
    (Employee No. #d.employee.employeeNumber) and is still in service. His total monthly salary is
    #text(weight: "bold")[#d.salary.currencyEn #d.salary.totalTextEn], detailed as follows:
  ],
)

// ---------- salary table ----------
#let rows = d.salary.rows
#table(
  columns: if bi { (1fr, 40mm, 1fr) } else { (1fr, 40mm) },
  align: if bi { (right, right, left) } else { (right, right) },
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 2mm),
  fill: (_, row) => cell-fill(row),
  table.header(
    [*البند*],
    [*المبلغ (#d.salary.currencyAr)*],
    ..if bi { (en[*Item*],) } else { () },
  ),
  ..rows.map(r => (
    r.labelAr,
    en(r.amountText),
    ..if bi { (en(r.labelEn),) } else { () },
  )).flatten(),
  table.cell(fill: primary.lighten(70%))[*الإجمالي*],
  table.cell(fill: primary.lighten(70%))[#en(text(weight: "bold", d.salary.totalText))],
  ..if bi { (table.cell(fill: primary.lighten(70%))[#en[*Total*]],) } else { () },
)

#pair(
  [
    أعطي هذا الخطاب بناء على طلبه، دون أدنى مسؤولية على الشركة تجاه الغير.
    ويسري حتى #d.doc.validUntilAr م.
  ],
  [
    This certificate is issued upon his request without any liability on the company towards third parties.
    Valid until #d.doc.validUntilEn.
  ],
)

// ---------- signature, stamp, QR (never split across pages) ----------
#v(4mm)
#block(breakable: false, width: 100%)[
  #grid(
    columns: (1fr, 34mm, 32mm),
    column-gutter: 6mm,
    align: (right + top, center + horizon, center + top),
    [
      #text(weight: "bold", d.signature.titleAr) \
      #d.signature.nameAr
      #if bi [ \ #en(small[#d.signature.titleEn — #d.signature.nameEn]) ]
      #v(1mm)
      #if d.signature.printImage {
        image("signature.png", width: 45mm)
      } else {
        block(height: 14mm, width: 45mm, stroke: (bottom: 0.5pt + rule))
      }
    ],
    if d.signature.printImage { image("stamp.png", width: 30mm) } else { [] },
    [
      #image("qr.svg", width: 30mm)
      #small[للتحقق من صحة المستند]
      #if bi [ \ #en(small[Scan to verify]) ]
    ],
  )
]
