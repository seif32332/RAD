// CONTRACT_ADDENDUM (AMD) v1: the contract terms that change and from when, approved by a second
// person; it takes effect only when the employee accepts it in the portal by the effective date.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let a = d.addendum
#let primary = rgb(d.company.primaryColor)

#let value(v, ltr-run) = if ltr-run { en(v) } else { v }

هذا ملحق لعقد العمل المبرم بين #d.company.legalNameAr والموظف #e.fullNameAr (الرقم الوظيفي #en(e.employeeNumber))،
يعدل بموجبه البنود التالية اعتبارا من #text(weight: "bold")[#a.effectiveAr م]:

#table(
  columns: (1.2fr, 1fr, 1fr),
  align: (right, right, right),
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 2mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header([*البند*], [*قبل الملحق*], [*بعد الملحق*]),
  ..a.rows.map(r => (
    [#r.labelAr#if r.money [ (#a.currencyAr)]],
    [#value(r.fromText, r.ltr)],
    [#text(weight: "bold", value(r.toText, r.ltr))],
  )).flatten(),
)

#if a.reasonAr != none [وذلك #a.reasonAr.]

وتبقى بقية بنود عقد العمل دون تغيير، ويعد هذا الملحق جزءا لا يتجزأ منه.

يسري هذا الملحق بموافقة الموظف عليه في بوابة الموظف في موعد أقصاه تاريخ السريان، وتسجل موافقته إلكترونيا
مع تاريخها وتعد قبولا كتابيا منه لما ورد فيه. وإن لم يوافق عليه في هذا الموعد فلا يترتب عليه أي أثر.

#small[تظهر حالة موافقة الموظف على هذا الملحق في صفحة التحقق عبر رمز QR.]
