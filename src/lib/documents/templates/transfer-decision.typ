// TRANSFER_DECISION (TRF) v1: the employee's new branch / department / direct manager and the
// effective date; issuing it orders the change of the employee file (change-orders.ts).
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let t = d.transfer
#let primary = rgb(d.company.primaryColor)

نود إفادتكم بأنه تقرر نقلكم وفق ما يلي، اعتبارا من #text(weight: "bold")[#t.effectiveAr م]، مع بقائكم بوظيفة «#e.jobTitleAr»:

#table(
  columns: (1fr, 1fr, 1fr),
  align: (right, right, right),
  stroke: 0.5pt + rule,
  inset: (x: 3mm, y: 2mm),
  fill: (_, row) => if row == 0 { primary.lighten(85%) },
  table.header([*البند*], [*قبل النقل*], [*بعد النقل*]),
  ..t.rows.map(r => ([#r.labelAr], [#r.fromAr], [#text(weight: "bold", r.toAr)])).flatten(),
)

#if t.reasonAr != none [وذلك #t.reasonAr.]

وتبقى بقية شروط عقد عملكم دون تغيير. متمنين لكم دوام التوفيق.
