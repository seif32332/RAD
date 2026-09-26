// JOB_OFFER (OFR) v1: terms offered to a candidate (no employee file yet), approved by a second
// person; the candidate answers through the private link. Valid until the offer's deadline.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let o = d.offer
#let primary = rgb(d.company.primaryColor)
#let bi = d.doc.language == "ar-en"

#pair(d,
  [
    يسر #d.company.legalNameAr أن تقدم لكم عرضا للعمل لديها بوظيفة «#text(weight: "bold", o.jobTitleAr)»، وفق ما يلي:
  ],
  [
    #d.company.legalNameEn is pleased to offer you the position of "#text(weight: "bold", o.jobTitleEn)" on the following terms:
  ],
)

#table(
  columns: if bi { (1fr, 40mm, 1fr) } else { (1fr, 40mm) },
  align: if bi { (right, right, left) } else { (right, right) },
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 2mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header(
    [*الأجر الشهري*],
    [*المبلغ (#o.currencyAr)*],
    ..if bi { (en[*Monthly pay*],) } else { () },
  ),
  ..o.rows.map(r => (
    r.labelAr,
    en(r.amountText),
    ..if bi { (en(r.labelEn),) } else { () },
  )).flatten(),
  table.cell(fill: primary.lighten(70%))[*الإجمالي*],
  table.cell(fill: primary.lighten(70%))[#en(text(weight: "bold", o.totalText))],
  ..if bi { (table.cell(fill: primary.lighten(70%))[#en[*Total*]],) } else { () },
)

#pair(d,
  [
    - تاريخ المباشرة: #o.startAr م.
    - فترة التجربة: #en(o.probationDays) يوما.
    - الإجازة السنوية: #en(o.annualLeaveDays) يوما.
    #if o.notesAr != none [- #o.notesAr]

    ويخضع العقد لنظام العمل ويوثق في منصة قوى. #if has(d.doc.validUntilAr) [ويسري هذا العرض حتى #d.doc.validUntilAr م،] ويمكنكم الرد عليه بالقبول أو الاعتذار عبر الرابط المرسل إليكم.
  ],
  [
    - Start date: #o.startEn.
    - Probation: #o.probationDaysEn days.
    - Annual leave: #o.annualLeaveDaysEn days.

    The contract is governed by the Labor Law and documented on Qiwa. #if has(d.doc.validUntilEn) [This offer is valid until #d.doc.validUntilEn\;] you may accept or decline it through the link sent to you.
  ],
)
