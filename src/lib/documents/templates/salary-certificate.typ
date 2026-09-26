// SALARY_CERTIFICATE (SAL) v1. Data: render model (src/lib/documents/render-model.ts).
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let s = d.salary
#let primary = rgb(d.company.primaryColor)
#let bi = d.doc.language == "ar-en"

#pair(d,
  [
    تشهد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)،
    #e.nationalityAr الجنسية، ويحمل #e.idLabelAr رقم #en(e.idNumber)#if has(e.passportNumber) [ وجواز سفر رقم #en(e.passportNumber)]،
    يعمل لدى الشركة بوظيفة «#e.jobTitleAr» اعتبارا من #e.joinDateAr م، وبالرقم الوظيفي #en(e.employeeNumber)،
    ولا يزال على رأس العمل حتى تاريخه، ويتقاضى راتبا شهريا إجماليا قدره
    #text(weight: "bold")[#s.totalText #s.currencyAr] موزعا كما يلي:
  ],
  [
    This is to certify that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national,
    holder of #e.idLabelEn No. #e.idNumber#if has(e.passportNumber) [ and Passport No. #e.passportNumber],
    has been employed by #d.company.legalNameEn as "#e.jobTitleEn" since #e.joinDateEn
    (Employee No. #e.employeeNumber) and is still in service. The total monthly salary is
    #text(weight: "bold")[#s.currencyEn #s.totalTextEn], detailed as follows:
  ],
)

#table(
  columns: if bi { (1fr, 40mm, 1fr) } else { (1fr, 40mm) },
  align: if bi { (right, right, left) } else { (right, right) },
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 2mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header(
    [*البند*],
    [*المبلغ (#s.currencyAr)*],
    ..if bi { (en[*Item*],) } else { () },
  ),
  ..s.rows.map(r => (
    r.labelAr,
    en(r.amountText),
    ..if bi { (en(r.labelEn),) } else { () },
  )).flatten(),
  table.cell(fill: primary.lighten(70%))[*الإجمالي*],
  table.cell(fill: primary.lighten(70%))[#en(text(weight: "bold", s.totalText))],
  ..if bi { (table.cell(fill: primary.lighten(70%))[#en[*Total*]],) } else { () },
)

#pair(d,
  [
    أعطي هذا الخطاب بناء على طلبه، دون أدنى مسؤولية على الشركة تجاه الغير.
    #if has(d.doc.validUntilAr) [ويسري حتى #d.doc.validUntilAr م.]
  ],
  [
    This certificate is issued upon request without any liability on the company towards third parties.
    #if has(d.doc.validUntilEn) [Valid until #d.doc.validUntilEn.]
  ],
)
