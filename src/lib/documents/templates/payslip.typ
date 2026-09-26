// PAYSLIP (PAY) v1: one employee, one paid month; the stored payroll columns, unsigned (issued
// automatically from an approved and paid payroll), numbered, verifiable by QR.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let p = d.payroll
#let primary = rgb(d.company.primaryColor)
#let bi = d.doc.language == "ar-en"

#let money-table(titleAr, titleEn, rows, totalAr, totalEn, total, total-en) = table(
  columns: if bi { (1fr, 40mm, 1fr) } else { (1fr, 40mm) },
  align: if bi { (right, right, left) } else { (right, right) },
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 1.6mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header(
    [*#titleAr*],
    [*المبلغ (#p.currencyAr)*],
    ..if bi { (en[*#titleEn*],) } else { () },
  ),
  ..rows.map(r => (
    r.labelAr,
    en(r.amountText),
    ..if bi { (en(r.labelEn),) } else { () },
  )).flatten(),
  table.cell(fill: primary.lighten(70%))[*#totalAr*],
  table.cell(fill: primary.lighten(70%))[#en(text(weight: "bold", total))],
  ..if bi { (table.cell(fill: primary.lighten(70%))[#en[*#totalEn*]],) } else { () },
)

#pair(d,
  [
    *الفترة:* #p.periodAr#if p.paidAr != none [ · *تاريخ الصرف:* #p.paidAr م] \
    *الموظف:* #e.fullNameAr · *الرقم الوظيفي:* #en(e.employeeNumber) · *الوظيفة:* #e.jobTitleAr
  ],
  [
    *Period:* #p.periodEn#if p.paidEn != none [ · *Paid on:* #p.paidEn] \
    *Employee:* #e.fullNameEn · *No.:* #e.employeeNumber · *Position:* #e.jobTitleEn
  ],
)

#money-table("الاستحقاقات", "Earnings", p.earnings, "إجمالي الاستحقاقات", "Gross earnings", p.grossText, p.grossTextEn)

#if p.deductions.len() > 0 {
  money-table("الاستقطاعات", "Deductions", p.deductions, "إجمالي الاستقطاعات", "Total deductions", p.totalDeductionsText, p.totalDeductionsTextEn)
}

#block(width: 100%, inset: 3mm, stroke: 1pt + primary, radius: 2pt)[
  #pair(d,
    [*صافي الراتب:* #en(text(weight: "bold", p.netText)) #p.currencyAr],
    [*Net salary:* #text(weight: "bold", p.netTextEn) #p.currencyEn],
  )
]

#pair(d,
  [#small[قسيمة صادرة آليا من مسير رواتب معتمد ومصروف، ولا تحتاج إلى توقيع. للتحقق من صحتها امسح رمز QR.]],
  [#small[Issued automatically from an approved and paid payroll; no signature required. Scan the QR code to verify.]],
)
