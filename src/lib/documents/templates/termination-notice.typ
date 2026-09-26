// TERMINATION_NOTICE (TRM) v1: the company's decision to end the contract, approved by a second
// person. Reason text is fixed per reason; HR's optional clarification is data, placed as text.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let t = d.notice

#if t.reason == "NOTICE" [
  نود إشعاركم بقرار #d.company.legalNameAr إنهاء عقد عملكم بوظيفة «#e.jobTitleAr»، وذلك بإشعار مدته #en(t.noticeDaysText) يوما،
  على أن يكون آخر يوم عمل لكم #text(weight: "bold")[#t.lastAr م].
] else if t.reason == "NON_RENEWAL" [
  نود إشعاركم بعدم رغبة #d.company.legalNameAr في تجديد عقد عملكم بوظيفة «#e.jobTitleAr» عند انتهائه،
  على أن يكون آخر يوم عمل لكم #text(weight: "bold")[#t.lastAr م]، وتعد هذه المدة إشعارا مدته #en(t.noticeDaysText) يوما.
] else if t.reason == "PROBATION" [
  نود إشعاركم بقرار #d.company.legalNameAr إنهاء عقد عملكم بوظيفة «#e.jobTitleAr» خلال فترة التجربة،
  على أن يكون آخر يوم عمل لكم #text(weight: "bold")[#t.lastAr م].
] else [
  استنادا إلى المادة الثمانين من نظام العمل، وبناء على نتيجة التحقيق في «#t.investigation.subjectAr»
  المنتهي بتاريخ #t.investigation.closedAr م، نود إشعاركم بقرار #d.company.legalNameAr إنهاء عقد عملكم
  بوظيفة «#e.jobTitleAr» دون مكافأة أو إشعار أو تعويض، على أن يكون آخر يوم عمل لكم #text(weight: "bold")[#t.lastAr م].
]

#if t.paragraphs != none {
  for p in t.paragraphs {
    par(p.map(l => [#l]).join(linebreak()))
  }
}

ونأمل منكم تسليم ما في عهدتكم وإتمام إجراءات إخلاء الطرف، لتصرف مستحقاتكم وفق نظام العمل.

#small[يمكن إبداء الملاحظات على هذا الإشعار عند الإقرار باستلامه في بوابة الموظف.]
