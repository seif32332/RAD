// EXPERIENCE_CERTIFICATE (EXP) v1: service period; issued in or after service. No expiry.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let v = d.service

#pair(d,
  [
    تشهد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)،
    #e.nationalityAr الجنسية، ويحمل #e.idLabelAr رقم #en(e.idNumber)،
    #if v.inService [
      يعمل لدى الشركة بوظيفة «#e.jobTitleAr» اعتبارا من #v.startAr م ولا يزال على رأس العمل حتى تاريخه.
    ] else [
      عمل لدى الشركة بوظيفة «#e.jobTitleAr» خلال الفترة من #v.startAr م إلى #v.endAr م.
    ]
    وقد أعطيت له هذه الشهادة بناء على طلبه دون أدنى مسؤولية على الشركة.
  ],
  [
    This is to certify that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national,
    holder of #e.idLabelEn No. #e.idNumber,
    #if v.inService [
      has been employed by #d.company.legalNameEn as "#e.jobTitleEn" since #v.startEn and is still in service.
    ] else [
      was employed by #d.company.legalNameEn as "#e.jobTitleEn" from #v.startEn to #v.endEn.
    ]
    This certificate is issued upon request without any liability on the company.
  ],
)
