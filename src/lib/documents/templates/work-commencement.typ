// WORK_COMMENCEMENT (CMN, automatic notice) and WORK_COMMENCEMENT_LETTER (CML, signed on request) v1:
// the employee started work on joining, or came back from a leave on the confirmed date.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let c = d.commencement

#if c.kind == "JOIN" [
  تفيد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)، #e.nationalityAr الجنسية،
  ويحمل #e.idLabelAr رقم #en(e.idNumber)، قد باشر عمله لديها بوظيفة «#e.jobTitleAr» وبالرقم الوظيفي #en(e.employeeNumber)
  اعتبارا من #text(weight: "bold")[#c.dateAr م].
] else [
  تفيد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)، #e.nationalityAr الجنسية،
  ويحمل #e.idLabelAr رقم #en(e.idNumber)، ويعمل لديها بوظيفة «#e.jobTitleAr» وبالرقم الوظيفي #en(e.employeeNumber)،
  قد باشر عمله بعد انتهاء إجازته#if c.leave.typeAr != none [ (#c.leave.typeAr)]
  التي بدأت في #c.leave.startAr م وانتهت في #c.leave.endAr م، وذلك اعتبارا من #text(weight: "bold")[#c.dateAr م]#if c.leave.late != none [،
  متأخرا #if c.leave.late.number != none [#en(c.leave.late.number) ]#c.leave.late.unit عن موعد عودته المقرر في #c.leave.scheduledAr م].
]

#if c.requested [أعطي هذا الخطاب بناء على طلبه، دون أدنى مسؤولية على الشركة تجاه الغير.] else [صدر هذا الإشعار آليا عند تأكيد الموارد البشرية للمباشرة.]
