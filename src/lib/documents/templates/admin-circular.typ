// ADMIN_CIRCULAR (CIR) v1: an administrative decision or a circular of the legal company to a group of
// employees (the "To:" line names them). The subject and body are HR's text, approved word for word;
// they are data (paragraphs of lines), placed as text: nothing in them is interpreted as markup.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let c = d.circular
#let primary = rgb(d.company.primaryColor)

#v(1mm)
#text(weight: "bold")[الموضوع: #c.subjectAr]

#for p in c.paragraphs {
  par(p.map(l => [#l]).join(linebreak()))
}

#if c.effectiveAr != none [
  ويعمل #if c.kind == "DECISION" [بهذا القرار] else [بهذا التعميم] اعتبارا من #text(weight: "bold")[#c.effectiveAr م].
]

#if c.listed != none [
  #table(
    columns: (30mm, 1fr),
    align: (right, right),
    stroke: 0.5pt + rule,
    inset: (x: 3mm, y: 1.6mm),
    fill: (_, row) => if row == 0 { primary.lighten(85%) },
    table.header([*الرقم الوظيفي*], [*الاسم*]),
    ..c.listed.map(r => ([#en(r.employeeNumber)], [#r.nameAr])).flatten(),
  )
]

#if c.acknowledge [
  #small[يجد كل موظف موجه إليه #if c.kind == "DECISION" [هذا القرار] else [هذا التعميم] في بوابة الموظف ويقر بالاطلاع عليه، وتحتفظ الموارد البشرية بسجل الإقرارات.]
]
