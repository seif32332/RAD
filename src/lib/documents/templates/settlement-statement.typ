// SETTLEMENT_STATEMENT (STL) v1: itemized settlement (as stored, checked against its total), the
// payment proof finance recorded, and the discharge the employee accepts or disputes in the portal.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let s = d.settlement
#let p = s.payment
#let primary = rgb(d.company.primaryColor)
#let bi = d.doc.language == "ar-en"

#let money-table(titleAr, titleEn, rows, totalAr, totalEn, total, totalEn-text) = table(
  columns: if bi { (1fr, 40mm, 1fr) } else { (1fr, 40mm) },
  align: if bi { (right, right, left) } else { (right, right) },
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 1.6mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header(
    [*#titleAr*],
    [*المبلغ (#s.currencyAr)*],
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
    بيان #s.kindAr للموظف #text(weight: "bold", e.fullNameAr)، الرقم الوظيفي #en(e.employeeNumber)،
    ويحمل #e.idLabelAr رقم #en(e.idNumber)، بوظيفة «#e.jobTitleAr»، تاريخ المباشرة #e.joinDateAr م#if s.lastWorkingAr != none [، وآخر يوم عمل #s.lastWorkingAr م]#if s.reasonAr != none [، وسبب انتهاء العلاقة التعاقدية: #s.reasonAr]#if s.yearsOfService != none [، ومدة الخدمة #en(s.yearsOfService) سنة].
  ],
  [
    #s.kindEn of #text(weight: "bold", e.fullNameEn), Employee No. #e.employeeNumber, #e.idLabelEn No. #e.idNumber,
    "#e.jobTitleEn", joined on #e.joinDateEn#if s.lastWorkingEn != none [, last working day #s.lastWorkingEn]#if s.reasonEn != none [, reason: #s.reasonEn]#if s.yearsOfService != none [, service #s.yearsOfService years].
  ],
)

#money-table("المستحقات", "Entitlements", s.entitlements, "إجمالي المستحقات", "Total entitlements", s.totalEntitlementsText, s.totalEntitlementsTextEn)

#if s.deductions.len() > 0 {
  money-table("الخصومات", "Deductions", s.deductions, "إجمالي الخصومات", "Total deductions", s.totalDeductionsText, s.totalDeductionsTextEn)
}

#block(width: 100%, inset: 3mm, stroke: 1pt + primary, radius: 2pt)[
  #pair(d,
    [*صافي المستحقات المصروفة:* #en(text(weight: "bold", s.netText)) #s.currencyAr],
    [*Net amount paid:* #text(weight: "bold", s.netTextEn) #s.currencyEn],
  )
]

#pair(d,
  [
    *إثبات الصرف:* #p.methodAr، #p.referenceLabelAr #en(p.reference)، بتاريخ #p.paidAr م.
    #if p.receiptFingerprint != none [\ #small[بصمة إيصال الصرف المحفوظ في النظام: #en(p.receiptFingerprint)]]
  ],
  [
    *Payment:* #p.methodEn, reference #p.reference, on #p.paidEn.
    #if p.receiptFingerprint != none [\ #small[Receipt fingerprint: #p.receiptFingerprint]]
  ],
)

#block(breakable: false, width: 100%, inset: 3mm, fill: luma(246), radius: 2pt)[
  #pair(d,
    [
      *إقرار ومخالصة:* أقر أنا الموظف المذكور أعلاه بأنني استلمت صافي مستحقاتي المبينة في هذا البيان
      وقدره #en(s.netText) #s.currencyAr بموجب #p.methodAr رقم #en(p.reference) بتاريخ #p.paidAr م،
      #if s.isFinal [
        وأبرئ ذمة #d.company.legalNameAr إبراء تاما من جميع حقوقي ومستحقاتي الناشئة عن عقد العمل، ولا تبقى لي أي مطالبة تجاهها.
      ] else [
        وأبرئ ذمة #d.company.legalNameAr من المستحقات الواردة في هذا البيان.
      ]
      \
      #small[تسري هذه المخالصة بموافقة الموظف الإلكترونية من حسابه في بوابة الموظف، ويظهر تاريخ موافقته أو اعتراضه في صفحة التحقق عبر رمز QR.]
    ],
    [
      *Acknowledgement and release:* I, the employee named above, acknowledge receipt of my net dues stated here,
      #s.currencyEn #s.netTextEn, by #p.methodEn No. #p.reference on #p.paidEn,
      #if s.isFinal [
        and fully release #d.company.legalNameEn from all rights and dues arising from the employment contract, with no remaining claim against it.
      ] else [
        and release #d.company.legalNameEn from the dues stated in this statement.
      ]
      \
      #small[This release takes effect upon the employee's electronic acceptance in the employee portal; the date of acceptance or dispute is shown on the verification page (QR code).]
    ],
  )
]
