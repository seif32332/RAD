// EXIT_ACCEPTANCE (RSG) v1: the company accepts the employee's own request to end the contract
// (resignation, mutual agreement, non-renewal) with the last working day HR set on approval.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let x = d.exit

#pair(d,
  [
    #if x.kind == "RESIGNATION" [
      إشارة إلى استقالتكم المقدمة بتاريخ #x.requestAr م، نفيدكم بموافقة #d.company.legalNameAr على قبولها،
    ] else if x.kind == "MUTUAL_AGREEMENT" [
      إشارة إلى طلبكم المقدم بتاريخ #x.requestAr م لإنهاء عقد العمل بالاتفاق، نفيدكم بموافقة #d.company.legalNameAr على إنهائه بالتراضي،
    ] else [
      إشارة إلى طلبكم المقدم بتاريخ #x.requestAr م بعدم تجديد عقد العمل عند انتهائه، نفيدكم بموافقة #d.company.legalNameAr على ذلك،
    ]
    على أن يكون آخر يوم عمل لكم #text(weight: "bold")[#x.lastAr م].

    ونأمل منكم تسليم ما في عهدتكم وإتمام إجراءات إخلاء الطرف قبل هذا التاريخ، لتصرف مستحقاتكم وفق نظام العمل.
    شاكرين لكم ما قدمتموه خلال فترة عملكم بوظيفة «#e.jobTitleAr»، ومتمنين لكم التوفيق.
  ],
  [
    #if x.kind == "RESIGNATION" [
      With reference to your resignation submitted on #x.requestEn, #d.company.legalNameEn accepts it,
    ] else if x.kind == "MUTUAL_AGREEMENT" [
      With reference to your request of #x.requestEn to end the employment contract by mutual agreement, #d.company.legalNameEn agrees to end it,
    ] else [
      With reference to your request of #x.requestEn not to renew the employment contract at its expiry, #d.company.legalNameEn agrees,
    ]
    your last working day being #text(weight: "bold", x.lastEn).

    Please hand over any company property in your custody and complete the clearance before that date,
    so that your dues are paid in accordance with the Labor Law.
    We thank you for your work as "#e.jobTitleEn" and wish you every success.
  ],
)
