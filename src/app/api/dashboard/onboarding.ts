// Pure helpers of the dashboard (no DB / Next runtime) so they can be unit-tested.

/** Record counts the admin onboarding checklist is computed from. */
export interface OnboardingCounts {
  companies: number;
  branches: number;
  employees: number;
  /** Employees whose file is linked to a login account. */
  linkedUsers: number;
  workSchedules: number;
  payrolls: number;
}

export interface OnboardingStep {
  key: keyof OnboardingCounts;
  label: string;
  hint: string;
  href: string;
  count: number;
  done: boolean;
}

export interface Onboarding {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  allDone: boolean;
}

/** Order matters: each step depends on the previous ones (a branch needs a company, ...). */
const STEPS: ReadonlyArray<Omit<OnboardingStep, 'count' | 'done'>> = [
  { key: 'companies', label: 'أضف الشركة (السجل التجاري)', hint: 'بيانات المنشأة وتاريخ انتهاء السجل', href: '/companies/new' },
  { key: 'branches', label: 'أضف فرعاً واحداً على الأقل', hint: 'الموظفون وجداول الدوام تتبع الفروع', href: '/branches/new' },
  { key: 'workSchedules', label: 'عرّف جدول دوام للفرع', hint: 'من صفحة الفرع: أوقات الدوام وأيام العمل', href: '/branches' },
  { key: 'employees', label: 'أضف الموظفين أو استوردهم', hint: 'إدخال فردي أو استيراد ملف Excel', href: '/employees/import' },
  { key: 'linkedUsers', label: 'اربط حسابات دخول بملفات الموظفين', hint: 'ليستخدم الموظفون بوابة الخدمة الذاتية', href: '/settings/users' },
  { key: 'payrolls', label: 'ولّد أول مسير رواتب', hint: 'راجع المسودة قبل الاعتماد', href: '/payrolls' },
];

const safeCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Builds the checklist from current counts: a step is done when its count is above zero. */
export function buildOnboarding(counts: Partial<OnboardingCounts>): Onboarding {
  const steps = STEPS.map((s) => {
    const count = safeCount(counts[s.key]);
    return { ...s, count, done: count > 0 };
  });
  const completed = steps.filter((s) => s.done).length;
  return { steps, completed, total: steps.length, allDone: completed === steps.length };
}

/**
 * Wording of the alert-centre badge. "No alerts" is only claimed when there is something being
 * tracked; with no documents on file at all the dashboard says so instead of a reassuring tick.
 */
export function alertBadgeLabel(totalAlerts: number, trackedRecords: number): { label: string; tone: 'alert' | 'ok' | 'empty' } {
  if (totalAlerts > 0) return { label: `${totalAlerts} تنبيه نشط`, tone: 'alert' };
  if (trackedRecords <= 0) return { label: 'لم تُسجَّل وثائق بعد', tone: 'empty' };
  return { label: 'لا تنبيهات حالياً', tone: 'ok' };
}
