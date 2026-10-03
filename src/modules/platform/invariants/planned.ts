// The invariants of ARCHITECTURE_INVARIANTS §4.2.1 that are defined but not measured yet: their
// tables arrive with later packages (effective periods readers, PayrollSnapshot, DayRecord, the leave
// ledger, ExitCase, the workflow engine…). Each one moves to its own file with a `check` when the
// package that owns its data ships. Keeping them here makes the fixed-integrity list (DEC-PO-120 as
// amended by DEC-PO-122) and the blocking scopes one reviewed table, and the owner dashboard can show
// "not measured yet" instead of a silent zero.
import type { InvariantDefinition } from './types';

const PAYROLL_ALL = ['payroll.approve', 'payroll.export', 'payroll.pay'] as const;

export const PLANNED_INVARIANTS: readonly InvariantDefinition[] = [
  { id: 'INV-EFF-01', titleAr: 'لا تداخل في الفترات النافذة', owner: 'platform', severity: 'BLOCKING', integrity: true, blocks: [...PAYROLL_ALL, 'settlement.pay'], note: 'Enforced by the EXCLUDE constraint of 9u; no reconcile check.' },
  { id: 'INV-EFF-02', titleAr: 'لا فجوة غير مبررة في الأجر والتعيين داخل فترة توظيف مفتوحة', owner: 'compensation', severity: 'HIGH', integrity: false, blocks: ['payroll.approve'], expectedCategories: ['PENDING_INITIAL_COMPENSATION'] },
  { id: 'INV-LCY-02', titleAr: 'خارج الخدمة بعد المهلة بلا مستخدم نشط ولا مهام مسندة', owner: 'lifecycle', severity: 'HIGH', integrity: false, blocks: [] },
  { id: 'INV-SAL-01', titleAr: 'الراتب على ملف الموظف يطابق فترة الأجر النافذة', owner: 'compensation', severity: 'WARNING', integrity: false, blocks: [], expectedCategories: ['LEGACY_READY'] },
  // ADR-0002 #1 / DEC-PO-014: in SINGLE_OPERATOR the owner confirmation blocks the whole file before it is sent.
  { id: 'INV-PAY-03', titleAr: 'ملف WPS يطابق اللقطة المعتمدة سطراً بسطر', owner: 'payroll', severity: 'BLOCKING', integrity: true, blocks: ['payroll.export', 'payroll.pay'], ownerConfirmationBlocks: true },
  { id: 'INV-PAY-04', titleAr: 'الأيام المدفوعة تساوي أيام الاستحقاق ولا أجر بعد آخر يوم عمل', owner: 'payroll', severity: 'BLOCKING', integrity: true, blocks: [...PAYROLL_ALL] },
  // Detected after the file is sent: it blocks closing the month, nothing before (DEC-PO-018).
  { id: 'INV-PAY-05', titleAr: 'رد البنك أو مدد يطابق الملف المرسل', owner: 'payroll', severity: 'HIGH', integrity: true, blocks: ['payroll.close'] },
  { id: 'INV-PAY-06', titleAr: 'لكل سطر مسير سطر بنك مدفوع واحد على الأكثر', owner: 'payroll', severity: 'BLOCKING', integrity: true, blocks: ['payroll.pay', 'payroll.close'] },
  { id: 'INV-GOSI-01', titleAr: 'التأمينات لكل سطر = النسبة النافذة × الأساس المقصوص', owner: 'payroll', severity: 'BLOCKING', integrity: true, blocks: [...PAYROLL_ALL] },
  { id: 'INV-GOSI-02', titleAr: 'فاتورة التأمينات الشهرية = مجموع أسطر المسير', owner: 'payroll', severity: 'HIGH', integrity: false, blocks: [] },
  { id: 'INV-ATT-01', titleAr: 'لكل يوم عمل مجدول في فترة مغلقة سجل يوم واحد', owner: 'time', severity: 'BLOCKING', integrity: false, blocks: ['payroll.approve'] },
  { id: 'INV-ATT-02', titleAr: 'كل خصم أو إضافي من الحضور له أصل', owner: 'time', severity: 'BLOCKING', integrity: true, blocks: [...PAYROLL_ALL] },
  { id: 'INV-LEV-01', titleAr: 'رصيد الإجازة = مجموع الدفتر ولا سالب خارج المسموح', owner: 'leave', severity: 'HIGH', integrity: true, blocks: ['settlement.approve', 'settlement.pay'] },
  // ADR-0002 #7: the leave-to-payroll difference cases are owned by payroll.
  { id: 'INV-LEV-02', titleAr: 'كل إجازة ذات أثر مالي لها أثرها في الشهر الصحيح أو سطر فرق', owner: 'payroll', severity: 'BLOCKING', integrity: false, blocks: ['payroll.approve'] },
  { id: 'INV-EOS-01', titleAr: 'كل بند تسوية = إعادة الحساب من اللقطة وكل البنود المفتوحة مدرجة', owner: 'offboarding', severity: 'BLOCKING', integrity: true, blocks: ['settlement.approve', 'settlement.pay'] },
  { id: 'INV-OFF-01', titleAr: 'كل خروج معتمد له ملف خروج يُغلق بتسوية مدفوعة وعهدة صفرية', owner: 'offboarding', severity: 'HIGH', integrity: false, blocks: [] },
  { id: 'INV-WF-01', titleAr: 'كل طلب غير نهائي له مهمة مفتوحة بمكلف نشط', owner: 'workflow', severity: 'WARNING', integrity: false, blocks: [] },
  // Blocks the merge (CI), not a runtime operation.
  { id: 'INV-SCOPE-01', titleAr: 'لا صف من شركة خارج نطاق المستخدم في أي استجابة', owner: 'iam', severity: 'BLOCKING', integrity: true, blocks: [], note: 'Guarded by the per-route allow/deny/other-company tests (ARCH-016).' },
  // Blocks the merge (CI), not a runtime operation (ADR-0010).
  { id: 'INV-IAM-01', titleAr: 'لا يرفع فرد واحد صلاحيته المالية بنفسه بتغيير عضوية الشركات أو صفة المعتمد أو الدور أو حالة الحساب', owner: 'iam', severity: 'BLOCKING', integrity: false, blocks: [], note: 'Guarded by the permanent regression tests named in ADR-0010 and the gateway identity tables.' },
  { id: 'INV-RPT-01', titleAr: 'كل رقم في تقرير = الاستعلام القانوني لنطاقه', owner: 'reporting', severity: 'WARNING', integrity: false, blocks: [] },
  { id: 'INV-EVT-01', titleAr: 'لا حدث بلا استهلاك أكثر من ساعة ولا إشعار معلق أكثر من يوم', owner: 'platform', severity: 'WARNING', integrity: false, blocks: [] },
  { id: 'INV-RULE-01', titleAr: 'كل قيمة قانونية في حساب معتمد مسجلة في اللقطة بمفتاحها ونسختها', owner: 'rules', severity: 'HIGH', integrity: false, blocks: ['payroll.approve'] },
];
