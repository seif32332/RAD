// LEAVE_APPROVAL (LVE) v1: issued automatically from an approved leave (unsigned); follows the
// leave (new dates -> new letter, cancelled -> revoked). No health leave types (sick, maternity).
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let l = d.leave

#pair(d,
  [
    تفيد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)، #e.nationalityAr الجنسية،
    ويحمل #e.idLabelAr رقم #en(e.idNumber)#if has(e.passportNumber) [ وجواز سفر رقم #en(e.passportNumber)]، يعمل لديها بوظيفة «#e.jobTitleAr»،
    وقد منح #text(weight: "bold", l.typeAr) مدتها #en(l.daysAr) يوما، من #l.startAr م إلى #l.endAr م#if l.outsideKsa [، يقضيها خارج المملكة]،
    على أن يعود إلى عمله في #text(weight: "bold")[#l.returnAr م].

    وقد أعطي هذا الخطاب دون أدنى مسؤولية على الشركة تجاه الغير.
  ],
  [
    #d.company.legalNameEn certifies that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national,
    holder of #e.idLabelEn No. #e.idNumber#if has(e.passportNumber) [ and Passport No. #e.passportNumber], employed as "#e.jobTitleEn",
    has been granted #text(weight: "bold", l.typeEn) of #l.daysEn days, from #l.startEn to #l.endEn#if l.outsideKsa [, to be spent outside the Kingdom],
    and is expected to resume work on #text(weight: "bold", l.returnEn).

    This letter is issued without any liability on the company towards third parties.
  ],
)

#pair(d,
  [#small[خطاب صادر آليا من إجازة معتمدة في النظام؛ يلغى تلقائيا إن ألغيت الإجازة أو تغيرت تواريخها. للتحقق امسح رمز QR.]],
  [#small[Issued automatically from an approved leave; revoked automatically if the leave is cancelled or its dates change. Scan the QR code to verify.]],
)
