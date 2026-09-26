// CLEARANCE_CERTIFICATE (CLR) v1: issued only when custody, loans and the end-of-service
// settlement are all settled (checked by the builder, types.ts). No expiry.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let v = d.service
#let c = d.clearance

#pair(d,
  [
    تشهد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)،
    #e.nationalityAr الجنسية، ويحمل #e.idLabelAr رقم #en(e.idNumber)، وبالرقم الوظيفي #en(e.employeeNumber)،
    قد عمل لدى الشركة بوظيفة «#e.jobTitleAr» خلال الفترة من #v.startAr م إلى #v.endAr م،
    وكان آخر يوم عمل له #c.lastWorkingAr م.

    وقد أخلى طرفه من الشركة، إذ سلم جميع ما كان في عهدته، ولا توجد عليه سلف أو التزامات مالية
    مستحقة للشركة، وصرفت له مستحقات نهاية الخدمة.
    وأعطيت له هذه الشهادة بناء على ذلك دون أدنى مسؤولية على الشركة.
  ],
  [
    This is to certify that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national,
    holder of #e.idLabelEn No. #e.idNumber, Employee No. #e.employeeNumber,
    was employed by #d.company.legalNameEn as "#e.jobTitleEn" from #v.startEn to #v.endEn\;
    the last working day was #c.lastWorkingEn.

    The employee has returned all company property in his/her custody, has no outstanding loans
    or financial obligations towards the company, and has received the end-of-service entitlements.
    This certificate is issued accordingly without any liability on the company.
  ],
)
