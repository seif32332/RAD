// PROMOTION_DECISION (PRM) v1: the approved change of title and / or basic salary and its
// effective date; issuing it orders the change of the employee file (change-orders.ts).
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let c = d.change
#let primary = rgb(d.company.primaryColor)

نود إفادتكم بأنه تقرر ما يلي، اعتبارا من #text(weight: "bold")[#c.effectiveAr م]:

#table(
  columns: (1fr, 1fr, 1fr),
  align: (right, right, right),
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 2mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header([*البند*], [*قبل القرار*], [*بعد القرار*]),
  ..if c.toJobTitleAr != none { ([المسمى الوظيفي], [#c.fromJobTitleAr], [#text(weight: "bold", c.toJobTitleAr)]) } else { () },
  ..if c.toSalaryText != none {
    ([الراتب الأساسي الشهري (#c.currencyAr)], [#en(c.fromSalaryText)], [#en(text(weight: "bold", c.toSalaryText))])
  } else { () },
)

#if c.reasonAr != none [وذلك #c.reasonAr.]

وتبقى بقية شروط عقد عملكم دون تغيير. متمنين لكم دوام التوفيق.
