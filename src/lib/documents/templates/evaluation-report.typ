// EVALUATION_REPORT (EVL) v1: a closed evaluation (approved, acknowledged by the employee):
// scores by section, result, recommendation, texts, the employee's acknowledgement. Automatic.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let v = d.evaluation
#let primary = rgb(d.company.primaryColor)

#let paras(ps) = if ps != none { for p in ps { par(p.map(l => [#l]).join(linebreak())) } }
#let block-of(title, ps) = if ps != none [
  #text(weight: "bold", fill: primary, title)
  #paras(ps)
]

#text(weight: "bold")[#v.cycleTitle] · #v.periodAr \
الموظف: #e.fullNameAr · الرقم الوظيفي #en(e.employeeNumber) · #e.jobTitleAr

#for s in v.sections {
  table(
    columns: (1fr, 18mm, 1fr),
    align: (right, center, right),
    stroke: 0.5pt + rule,
    inset: (x: 2.5mm, y: 1.5mm),
    fill: (_, row) => if row == 0 { primary.lighten(85%) },
    table.header([*#s.title* #small[(الوزن #en(s.weight)%)]], [*الدرجة*], [*ملاحظة*]),
    ..s.items.map(i => ([#i.title], [#en(i.score + " / " + v.maxItem)], [#if i.note != none [#i.note]])).flatten(),
  )
}

#block(width: 100%, inset: 3mm, stroke: 1pt + primary, radius: 2pt)[
  #if v.totalScore != none [*النتيجة:* #en(text(weight: "bold", v.totalScore + " / " + v.maxTotal))]
  #if v.finalRating != none [ · *التقدير:* #v.finalRating]
  #if v.recommendationAr != none [ · *التوصية:* #v.recommendationAr]
  #if v.recommendationReason != none [ \ #small[#v.recommendationReason]]
]

#block-of("نقاط القوة", v.strengths)
#block-of("مجالات التحسين", v.improvements)
#block-of("ملاحظات ختامية", v.finalNotes)

#if v.acknowledgedAr != none [
  #text(weight: "bold", fill: primary)[إقرار الموظف]
  اطلع الموظف على التقييم وأقر به في #v.acknowledgedAr م.
  #if v.employeeComment != none [ \ #small[تعليق الموظف:] #paras(v.employeeComment)]
]
