// WARNING_LETTER (WRN) v1: the text HR wrote, approved word for word by a second person. Arabic only.
// The body is data (paragraphs of lines), placed as text: nothing in it is interpreted as markup.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let w = d.warning

#v(1mm)
#text(weight: "bold")[الموضوع: #w.subjectAr]

#table(
  columns: (32mm, 1fr),
  align: (right, right),
  stroke: 0.5pt + rule,
  inset: 5pt,
  [الاسم], [#e.fullNameAr],
  [الرقم الوظيفي], [#en(e.employeeNumber)],
  [المسمى الوظيفي], [#e.jobTitleAr],
  ..if w.incidentDateAr != none { ([تاريخ الواقعة], [#w.incidentDateAr م]) } else { () },
)

#for p in w.paragraphs {
  par(p.map(l => [#l]).join(linebreak()))
}

#small[يعد هذا الإنذار جزءا من الملف الوظيفي، ويمكن إبداء الملاحظات عليه عند الإقرار باستلامه في بوابة الموظف.]
