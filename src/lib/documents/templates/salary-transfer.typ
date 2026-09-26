// SALARY_TRANSFER (STF) v1: commitment to the employee's bank to transfer his salary and end-of-
// service dues to the account in his file, and not to move them without the bank's release letter.
#import "letter.typ": *
#let d = json("data.json")
#show: letter.with(d)
#let e = d.employee
#let s = d.salary
#let k = d.bank

#pair(d,
  [
    تشهد #d.company.legalNameAr بأن السيد/ #text(weight: "bold", e.fullNameAr)، #e.nationalityAr الجنسية،
    ويحمل #e.idLabelAr رقم #en(e.idNumber)، يعمل لديها بوظيفة «#e.jobTitleAr» اعتبارا من #e.joinDateAr م
    وبالرقم الوظيفي #en(e.employeeNumber)، ويتقاضى راتبا شهريا إجماليا قدره #text(weight: "bold")[#s.totalText #s.currencyAr].

    وتلتزم الشركة بتحويل راتبه الشهري إلى حسابه لديكم رقم #en(text(weight: "bold", k.iban)) طوال مدة خدمته،
    وبعدم تحويله إلى بنك آخر إلا بعد حصولها على خطاب إخلاء طرف منكم، كما تلتزم بتحويل مستحقات نهاية خدمته
    إلى الحساب ذاته عند انتهاء خدمته لديها.

    ولا يترتب على هذا الخطاب أي التزام مالي على الشركة تجاهكم بخلاف ما ورد فيه.
    #if has(d.doc.validUntilAr) [ويسري حتى #d.doc.validUntilAr م.]
  ],
  [
    This is to certify that Mr./Ms. #text(weight: "bold", e.fullNameEn), #e.nationalityEn national, holder of
    #e.idLabelEn No. #e.idNumber, has been employed by #d.company.legalNameEn as "#e.jobTitleEn" since
    #e.joinDateEn (Employee No. #e.employeeNumber), with a total monthly salary of #text(weight: "bold")[#s.currencyEn #s.totalTextEn].

    The company undertakes to transfer the employee's monthly salary to his account with you,
    IBAN #text(weight: "bold", k.iban), throughout his employment; not to transfer it to another bank
    without first obtaining your clearance letter; and to transfer his end-of-service dues to the same account.

    This letter creates no financial obligation on the company towards you other than the above.
    #if has(d.doc.validUntilEn) [Valid until #d.doc.validUntilEn.]
  ],
)
