// EMPLOYMENT_CERTIFICATE (EMP) v1: employment letter without salary.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee

#pair(d,
  [
    تشهد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)،
    #e.nationalityAr الجنسية، ويحمل #e.idLabelAr رقم #en(e.idNumber)#if has(e.passportNumber) [ وجواز سفر رقم #en(e.passportNumber)]،
    يعمل لدى الشركة بوظيفة «#e.jobTitleAr» اعتبارا من #e.joinDateAr م، وبالرقم الوظيفي #en(e.employeeNumber)،
    ولا يزال على رأس العمل حتى تاريخه.
  ],
  [
    This is to certify that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national,
    holder of #e.idLabelEn No. #e.idNumber#if has(e.passportNumber) [ and Passport No. #e.passportNumber],
    has been employed by #d.company.legalNameEn as "#e.jobTitleEn" since #e.joinDateEn
    (Employee No. #e.employeeNumber) and is still in service.
  ],
)

#pair(d,
  [
    أعطي هذا الخطاب بناء على طلبه، دون أدنى مسؤولية على الشركة تجاه الغير.
    #if has(d.doc.validUntilAr) [ويسري حتى #d.doc.validUntilAr م.]
  ],
  [
    This letter is issued upon request without any liability on the company towards third parties.
    #if has(d.doc.validUntilEn) [Valid until #d.doc.validUntilEn.]
  ],
)
