// Entry of the internal workforce reports (SPEC §11 «تقارير PDF»). Sent to radeef-render with layout.typ;
// the service provides data.json (built by src/lib/workforce/report-pdf.ts). Dispatches on d.kind:
// every kind is laid out from the same blocks (sections, then «المصادر والحالات»); a kind adds only
// what is its own (the statement's summary for the employee, the plan's approval block).
#import "layout.typ": *
#let d = json("data.json")
#let primary = rgb(d.brand.primaryColor)

#let body-true-cost(d) = { for s in d.sections { section(s, primary) } }
#let body-exit-cost(d) = { for s in d.sections { section(s, primary) } }
#let body-saudization(d) = { for s in d.sections { section(s, primary) } }
#let body-hire-scenario(d) = { for s in d.sections { section(s, primary) } }
#let body-sensitivity(d) = { for s in d.sections { section(s, primary) } }

// Workforce plan: the sections, then who prepared, submitted and decided (never split across pages).
#let body-plan(d) = {
  for s in d.sections { section(s, primary) }
  if d.approval != none {
    v(3mm)
    block(sticky: true, text(size: 11pt, weight: "bold", fill: primary, rt(d.approval.title)))
    if has(d.approval.status) { small(rt(d.approval.status)) }
    v(1mm)
    signatures(d.approval, primary)
  }
}

// Total rewards statement (employee): a short personal line before the sections.
#let body-total-rewards(d) = {
  if has(d.lead) { block(width: 100%, inset: 2.5mm, radius: 2pt, fill: primary.lighten(90%), rt(d.lead)) }
  for s in d.sections { section(s, primary) }
}

#show: report.with(d)

#{
  if d.kind == "true-cost" { body-true-cost(d) } else if d.kind == "exit-cost" { body-exit-cost(d) } else if d.kind == "saudization" { body-saudization(d) } else if d.kind == "plan" { body-plan(d) } else if d.kind == "total-rewards" { body-total-rewards(d) } else if d.kind == "hire-scenario" { body-hire-scenario(d) } else if d.kind == "sensitivity" { body-sensitivity(d) } else { panic("unknown report kind") }
}

#sources(d.sources, primary)
