// NO_OBJECTION (NOC) v1: the company does not object, for one listed purpose and destination
// (written by the employee, approved word for word by HR). Valid 30 days by default.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let n = d.noc

#pair(d,
  [
    تفيد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)، #e.nationalityAr الجنسية،
    ويحمل #e.idLabelAr رقم #en(e.idNumber)، يعمل لديها بوظيفة «#e.jobTitleAr» اعتبارا من #e.joinDateAr م،
    #if n.purpose == "SERVICE_TRANSFER" [
      وأنه لا مانع لديها من نقل خدماته إلى #text(weight: "bold", n.targetAr)، على أن يتم ذلك وفق الأنظمة المعمول بها وبعد إتمام إجراءات إخلاء الطرف.
    ] else if n.purpose == "STUDY" [
      وأنه لا مانع لديها من التحاقه بالدراسة لدى #text(weight: "bold", n.targetAr)، على ألا يتعارض ذلك مع ساعات عمله وواجباته الوظيفية.
    ] else if n.purpose == "TRAVEL" [
      وأنه لا مانع لديها من سفره إلى #text(weight: "bold", n.targetAr) خلال إجازته المعتمدة.
    ] else [
      وأنه لا مانع لديها من حصوله على #text(weight: "bold", n.targetAr).
    ]
    #if n.detailsAr != none [#n.detailsAr.]

    وقد أعطي هذا الخطاب بناء على طلبه دون أدنى مسؤولية على الشركة.
    #if has(d.doc.validUntilAr) [ويسري حتى #d.doc.validUntilAr م.]
  ],
  [
    #d.company.legalNameEn certifies that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national,
    holder of #e.idLabelEn No. #e.idNumber, has been employed as "#e.jobTitleEn" since #e.joinDateEn,
    #if n.purpose == "SERVICE_TRANSFER" [
      and has no objection to the transfer of his/her services to #text(weight: "bold", n.targetAr), in accordance with the applicable regulations and after completing the clearance.
    ] else if n.purpose == "STUDY" [
      and has no objection to his/her enrolment at #text(weight: "bold", n.targetAr), provided it does not conflict with working hours and duties.
    ] else if n.purpose == "TRAVEL" [
      and has no objection to his/her travel to #text(weight: "bold", n.targetAr) during approved leave.
    ] else [
      and has no objection to his/her obtaining #text(weight: "bold", n.targetAr).
    ]
    #if n.detailsAr != none [#n.detailsAr.]

    This letter is issued upon request without any liability on the company.
    #if has(d.doc.validUntilEn) [Valid until #d.doc.validUntilEn.]
  ],
)
