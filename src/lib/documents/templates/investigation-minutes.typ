// INVESTIGATION_MINUTES (INV) v1: the concluded investigation's record (subject, facts, findings,
// recommendation, decision, penalty), approved by a second person, acknowledged by the employee.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let m = d.minutes
#let primary = rgb(d.company.primaryColor)

#let paras(ps) = if ps != none { for p in ps { par(p.map(l => [#l]).join(linebreak())) } }
#let section(title, ps) = if ps != none [
  #text(weight: "bold", fill: primary, title)
  #paras(ps)
]

#table(
  columns: (34mm, 1fr),
  align: (right, right),
  stroke: 0.5pt + rule,
  inset: (x: 2.5mm, y: 1.6mm),
  [الموظف], [#e.fullNameAr · #en(e.employeeNumber) · #e.jobTitleAr],
  [موضوع التحقيق], [#text(weight: "bold", m.subjectAr)],
  ..if m.categoryAr != none { ([نوع المخالفة], [#m.categoryAr]) } else { () },
  [فتح التحقيق], [#m.openedAr م],
  [انتهاء التحقيق], [#m.closedAr م],
  [النتيجة], [#text(weight: "bold", m.outcomeAr)],
  ..if m.investigator != none { ([المحقق], [#m.investigator]) } else { () },
)

#section("الوقائع", m.description)
#section("ما انتهى إليه التحقيق", m.findings)
#section("التوصية", m.recommendation)
#section("القرار", m.finalDecision)

#if m.penaltyAmountText != none or m.penaltyDays != none [
  #text(weight: "bold", fill: primary)[الجزاء]
  #if m.penaltyDays != none [خصم #en(m.penaltyDays) يوما من الأجر]#if m.penaltyDays != none and m.penaltyAmountText != none [ ]#if m.penaltyAmountText != none [بمبلغ #en(m.penaltyAmountText) ريال سعودي].
]

#small[يمكن إبداء الملاحظات على هذا المحضر عند الإقرار باستلامه في بوابة الموظف.]
