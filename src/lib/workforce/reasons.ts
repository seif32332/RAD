// Fixed lists shared with the employee form, and the mapping between the two exit-reason lists. PURE.
//
// The employee form / APIs own src/app/api/employees/_workforce-fields.ts (MEDICAL_INSURANCE_CLASSES,
// EXIT_REASONS). The lib layer must not import from src/app, so the lists are COPIED here and
// src/lib/__tests__/wf-reasons.test.ts fails if the two copies drift apart.
import { TERMINATION_REASONS, type TerminationReasonValue } from '@/lib/settlement';

/** Employee.medicalInsuranceClass values (copy of _workforce-fields.ts MEDICAL_INSURANCE_CLASSES). */
export const MEDICAL_INSURANCE_CLASSES = ['VIP', 'A+', 'A', 'B', 'C'] as const;
export type MedicalInsuranceClassCode = (typeof MEDICAL_INSURANCE_CLASSES)[number];

/** Employee.exitReason values (copy of _workforce-fields.ts EXIT_REASONS). */
export const EMPLOYEE_EXIT_REASONS = [
  'RESIGNATION',
  'EMPLOYER_TERMINATION',
  'CONTRACT_END',
  'MUTUAL_AGREEMENT',
  'ARTICLE_80',
  'PROBATION',
  'RETIREMENT',
  'DEATH',
  'ABSCONDING',
  'OTHER',
] as const;
export type EmployeeExitReason = (typeof EMPLOYEE_EXIT_REASONS)[number];

/** 'a+' / ' A + ' / 'vip' -> 'A+' / 'VIP'; unknown -> null. */
export function normalizeMedicalClass(v: string | null | undefined): MedicalInsuranceClassCode | null {
  const s = (v ?? '').trim().toUpperCase().replace(/\s*\+\s*/g, '+').replace(/\s+/g, ' ');
  return (MEDICAL_INSURANCE_CLASSES as ReadonlyArray<string>).includes(s) ? (s as MedicalInsuranceClassCode) : null;
}

export interface ExitReasonMapping {
  /** Settlement reason used by computeExitCost / computeSettlement (null = the user must choose). */
  terminationReason: TerminationReasonValue | null;
  /** false = a reading that needs HR / counsel confirmation (shown with the note). */
  certain: boolean;
  note: string;
}

/**
 * Employee.exitReason (structured exit, employee file) -> settlement TerminationReason (EOSB rules).
 * The settlement list drives the award (art. 84/85/87/54/80); the employee list is descriptive.
 */
export const EXIT_REASON_TO_TERMINATION: Readonly<Record<EmployeeExitReason, ExitReasonMapping>> = {
  RESIGNATION: { terminationReason: 'RESIGNATION', certain: true, note: 'استقالة: المادة 85' },
  EMPLOYER_TERMINATION: { terminationReason: 'COMPANY_TERMINATION', certain: true, note: 'إنهاء من صاحب العمل: المادة 84، مع الإشعار وخطر المادة 77' },
  CONTRACT_END: { terminationReason: 'CONTRACT_EXPIRY', certain: true, note: 'انتهاء العقد محدد المدة: المكافأة كاملة (قراءة بانتظار المستشار)' },
  ARTICLE_80: { terminationReason: 'ARTICLE_80', certain: true, note: 'فصل وفق المادة 80: لا مكافأة' },
  PROBATION: { terminationReason: 'PROBATION', certain: true, note: 'إنهاء خلال التجربة: المادة 54، لا مكافأة' },
  RETIREMENT: {
    terminationReason: 'CONTRACT_EXPIRY',
    certain: false,
    note: 'التقاعد ينهي العقد دون استقالة: حُسبت المكافأة كاملة كانتهاء العقد (بانتظار المستشار)',
  },
  DEATH: { terminationReason: 'ARTICLE_87', certain: false, note: 'الوفاة: المكافأة كاملة للورثة، حُسبت ضمن حالات المكافأة الكاملة (بانتظار المستشار)' },
  ABSCONDING: {
    terminationReason: 'ARTICLE_80',
    certain: false,
    note: 'الانقطاع يُعامل كالمادة 80 فقط إن تحققت شروطها (غياب 30 يوماً متفرقة أو 15 متصلة مع الإنذار)؛ وإلا اختر السبب يدوياً',
  },
  MUTUAL_AGREEMENT: { terminationReason: null, certain: false, note: 'اتفاق الطرفين: تحدد المكافأة بحسب من بادر (صاحب العمل = كاملة، العامل = نسبة الاستقالة): اختر السبب' },
  OTHER: { terminationReason: null, certain: false, note: 'سبب آخر: اختر سبب التصفية' },
};

/** Settlement TerminationReason -> the closest Employee.exitReason (to prefill the employee file). */
export const TERMINATION_TO_EXIT_REASON: Readonly<Record<TerminationReasonValue, EmployeeExitReason>> = {
  COMPANY_TERMINATION: 'EMPLOYER_TERMINATION',
  RESIGNATION: 'RESIGNATION',
  PROBATION: 'PROBATION',
  ARTICLE_80: 'ARTICLE_80',
  ARTICLE_81: 'OTHER', // the worker left because of the employer's breach (art. 81)
  ARTICLE_87: 'OTHER', // force majeure / female worker cases (death is mapped the other way only)
  CONTRACT_EXPIRY: 'CONTRACT_END',
};

/**
 * Accepts a settlement TerminationReason or an Employee.exitReason and returns the settlement reason to use.
 * Settlement values are returned as is (certain).
 */
export function resolveTerminationReason(reason: string): ExitReasonMapping & { input: string } {
  if ((TERMINATION_REASONS as ReadonlyArray<string>).includes(reason)) {
    return { input: reason, terminationReason: reason as TerminationReasonValue, certain: true, note: '' };
  }
  const m = (EXIT_REASON_TO_TERMINATION as Record<string, ExitReasonMapping>)[reason];
  if (m) return { input: reason, ...m };
  return { input: reason, terminationReason: null, certain: false, note: 'سبب غير معروف' };
}
