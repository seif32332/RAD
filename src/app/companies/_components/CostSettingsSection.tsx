"use client";

// «إعدادات الكلفة» of a company (private folder: not routed): the overtime hourly basis, the annual medical
// premiums per class / per dependent and the annual iqama fee. Set once per company and used everywhere
// (payroll, settlements, the decision engine). Editable by SUPER_ADMIN / COMPANY_ADMIN only (the API
// enforces it: src/app/api/companies/_workforce.ts); others see the values read-only.

import React from 'react';
import { Calculator } from 'lucide-react';
import { confirmDialog } from '@/components/ui/feedback';
import { useRole } from '@/context/RoleContext';
import { DEFAULT_PAYROLL_SETTINGS, overtimeHourlyRate } from '@/lib/payroll-core';
import { roundMoney } from '@/lib/money';
import {
  MEDICAL_PREMIUM_KEYS,
  MEDICAL_PREMIUM_LABELS,
  OVERTIME_BASIS_LABELS,
  OVERTIME_HOURLY_BASES,
  parseMedicalPremiums,
  type MedicalPremiumKey,
  type OvertimeHourlyBasis,
} from '@/lib/workforce/company-settings';

/** Roles that may change the cost settings (same rule as the API: _workforce.ts). */
export const COMPANY_COST_ROLES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN'];

export interface CostSettingsForm {
  overtimeHourlyBasis: OvertimeHourlyBasis;
  /** Text per key; '' = not entered. */
  medicalPremiums: Record<MedicalPremiumKey, string>;
  /** Text; '' = use the rule register value. */
  iqamaFeeYear: string;
}

export const EMPTY_MEDICAL_PREMIUMS: Record<MedicalPremiumKey, string> = { VIP: '', 'A+': '', A: '', B: '', C: '', DEPENDENT: '' };

/** Stored Company.medicalPremiumsJson -> form strings. */
export function premiumsToForm(json: string | null | undefined): Record<MedicalPremiumKey, string> {
  const p = parseMedicalPremiums(json ?? null);
  const out = { ...EMPTY_MEDICAL_PREMIUMS };
  for (const k of MEDICAL_PREMIUM_KEYS) if (typeof p[k] === 'number') out[k] = String(p[k]);
  return out;
}

/** Rule register iqama fee (IQAMA_FEE_YEAR) shown when the company field is blank. */
export interface IqamaFeeRuleView {
  value: number | null;
  status: string;
}

/** Worked example (illustrative numbers, default 8 h/day and multipliers 1.5 / 2.0). */
export const OT_EXAMPLE = { basic: 6000, allowances: 2000, hours: 10 };

export function overtimeExample(basis: OvertimeHourlyBasis): { normal: number; weekend: number } {
  const s = DEFAULT_PAYROLL_SETTINGS;
  const emp = { basicSalary: OT_EXAMPLE.basic, allowances: [{ amount: OT_EXAMPLE.allowances, isMonthly: true }] };
  return {
    normal: roundMoney(OT_EXAMPLE.hours * overtimeHourlyRate(emp, s.overtimeMultiplier, s, basis)),
    weekend: roundMoney(OT_EXAMPLE.hours * overtimeHourlyRate(emp, s.overtimeWeekendMultiplier, s, basis)),
  };
}

export const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const RULE_STATUS_TEXT: Record<string, string> = {
  VERIFIED_PRIMARY: 'موثّق',
  CORROBORATED_SECONDARY: 'مؤكَّد ثانوياً',
  PROVISIONAL: 'مؤقت',
  CONFLICTING: 'متعارض',
  USER_INPUT: 'إدخال المنشأة',
  MISSING: 'غير متوفر',
};

/** «650 ريال (مؤقت)» from the rule register (fallback text when it could not be loaded). */
export function iqamaRuleText(rule: IqamaFeeRuleView | null | undefined): string {
  if (rule && rule.value !== null) return `${money(rule.value)} ريال (${RULE_STATUS_TEXT[rule.status] ?? rule.status})`;
  return '650 ريال (مؤقت)';
}

const inputClass =
  'w-full px-4 py-3 text-[14px] font-black bg-[#F4F4F6] border-2 border-transparent focus:bg-white rounded-[1rem] focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 hover:bg-[#EFEFF1] transition-all text-slate-800 placeholder:text-slate-400 placeholder:font-bold disabled:opacity-60 disabled:cursor-not-allowed text-right';

const BASIS_FORMULA: Record<OvertimeHourlyBasis, string> = {
  BASIC: 'الساعة = الأساسي ÷ (30 × ساعات اليوم) × المعامل (1.5 في يوم العمل، و2.0 في العطلة افتراضياً).',
  TOTAL_PLUS_HALF_BASIC: 'الساعة = الأجر الكلي ÷ (30 × ساعات اليوم) + (المعامل − 1) × ساعة الأساسي: أي +50% من ساعة الأساسي في يوم العمل، و+100% في العطلة بمعامل 2.0.',
};

export function CostSettingsSection<T extends CostSettingsForm>({
  formData,
  setFormData,
  storedOvertimeBasis,
  iqamaFeeRule,
}: {
  formData: T;
  setFormData: React.Dispatch<React.SetStateAction<T>>;
  /** Basis stored for the company (new company: BASIC); choosing another one asks for confirmation. */
  storedOvertimeBasis: OvertimeHourlyBasis;
  iqamaFeeRule: IqamaFeeRuleView | null;
}) {
  const { role } = useRole();
  const canEdit = !!role && COMPANY_COST_ROLES.includes(role);
  const ex: Record<OvertimeHourlyBasis, { normal: number; weekend: number }> = {
    BASIC: overtimeExample('BASIC'),
    TOTAL_PLUS_HALF_BASIC: overtimeExample('TOTAL_PLUS_HALF_BASIC'),
  };
  const ruleText = iqamaRuleText(iqamaFeeRule);

  const chooseBasis = async (next: OvertimeHourlyBasis) => {
    if (!canEdit || next === formData.overtimeHourlyBasis) return;
    if (next !== storedOvertimeBasis) {
      const e = ex[next];
      const ok = await confirmDialog(
        `طريقة الحساب الجديدة: ${OVERTIME_BASIS_LABELS[next]}.\n\n` +
          'يؤثر التغيير على العمل الإضافي في مسيرات الرواتب للأشهر التي لم تُعتمد أو تُصرف بعد (عند توليدها أو إعادة توليدها)، وعلى التصفيات التي لم تُعتمد بعد، وعلى حسابات محرك القرارات. المسيرات المعتمدة أو المصروفة لا يُعاد حسابها.\n\n' +
          `مثال: أساسي ${money(OT_EXAMPLE.basic)} + بدلات ${money(OT_EXAMPLE.allowances)}، ${OT_EXAMPLE.hours} ساعات: ${money(e.normal)} ريال في يوم العمل، و${money(e.weekend)} ريال في العطلة (بدلاً من ${money(ex[formData.overtimeHourlyBasis].normal)} و${money(ex[formData.overtimeHourlyBasis].weekend)}).\n\n` +
          'يُنصح بتأكيد التفسير مع المستشار القانوني للشركة. لا يُحفظ التغيير إلا بعد «حفظ التعديلات».',
        { title: 'تغيير طريقة حساب أجر العمل الإضافي', confirmText: 'تأكيد التغيير' },
      );
      if (!ok) return;
    }
    setFormData((prev) => ({ ...prev, overtimeHourlyBasis: next }));
  };

  const setPremium = (k: MedicalPremiumKey, value: string) =>
    setFormData((prev) => ({ ...prev, medicalPremiums: { ...prev.medicalPremiums, [k]: value } }));

  return (
    <div id="company-cost-settings" className="relative pb-8 pt-8 border-t border-slate-100 scroll-mt-32">
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <h2 className="text-[1.3rem] font-black text-slate-900">إعدادات الكلفة</h2>
        <span className="text-[11px] font-black px-3 py-1.5 rounded-xl text-slate-500 bg-slate-100">الرواتب والتصفيات ومحرك القرارات</span>
      </div>
      <p className="text-[12px] font-bold text-slate-500 mb-8 leading-relaxed">
        تُضبط مرة واحدة لكل شركة وتُستخدم في كل مكان. تنطبق على موظفي الشركة القانونية، وعلى موظفي الشركة الفعلية ممن لا شركة قانونية لهم.
      </p>

      {/* Overtime basis */}
      <fieldset className="mb-10 min-w-0" disabled={!canEdit}>
        <legend className="text-[13px] font-extrabold text-slate-800 mb-3">طريقة حساب أجر العمل الإضافي</legend>
        <p className="text-[11.5px] font-bold text-slate-500 mb-4 leading-relaxed">
          تنص المادة 107 من نظام العمل على أن يُدفع للعامل عن الساعات الإضافية «أجر الساعة مضافاً إليه 50% من الأجر الأساسي». وتحتمل عبارة «أجر الساعة» قراءتين: من الأجر الأساسي وحده، أو من الأجر الكلي (الأساسي مع البدلات الشهرية). يُنصح بتأكيد التفسير مع المستشار القانوني للشركة.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {OVERTIME_HOURLY_BASES.map((b) => {
            const selected = formData.overtimeHourlyBasis === b;
            return (
              <label
                key={b}
                className={`flex items-start gap-3 p-4 rounded-[1.25rem] border-2 transition-colors ${selected ? 'border-blue-300 bg-blue-50/60' : 'border-slate-100 bg-[#F4F4F6]'} ${canEdit ? 'cursor-pointer' : 'opacity-70 cursor-not-allowed'}`}
              >
                <input
                  type="radio"
                  name="overtimeHourlyBasis"
                  value={b}
                  checked={selected}
                  disabled={!canEdit}
                  onChange={() => void chooseBasis(b)}
                  className="mt-1 w-4 h-4 accent-blue-600 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-extrabold text-slate-800 leading-relaxed">{OVERTIME_BASIS_LABELS[b]}</span>
                  <span className="block text-[11px] font-bold text-slate-500 mt-1 leading-relaxed">{BASIS_FORMULA[b]}</span>
                  <span className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] font-black text-slate-700">
                    <Calculator size={13} className="text-slate-400 shrink-0" aria-hidden="true" />
                    {`${money(ex[b].normal)} ريال في يوم العمل · ${money(ex[b].weekend)} ريال في العطلة`}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] font-bold text-slate-500 leading-relaxed">
          {`المثال: أساسي ${money(OT_EXAMPLE.basic)} + بدلات شهرية ${money(OT_EXAMPLE.allowances)}، ${OT_EXAMPLE.hours} ساعات إضافية، 8 ساعات عمل يومياً والمعاملات الافتراضية. يسري التغيير على مسيرات الأشهر التي لم تُعتمد بعد؛ المسيرات المعتمدة أو المصروفة لا تتغير.`}
        </p>
      </fieldset>

      {/* Medical premiums */}
      <fieldset className="mb-10 min-w-0" disabled={!canEdit}>
        <legend className="text-[13px] font-extrabold text-slate-800 mb-3">أقساط التأمين الطبي السنوية</legend>
        <p className="text-[11.5px] font-bold text-slate-500 mb-4 leading-relaxed">
          بالريال سنوياً لكل فئة، ولكل مرافق. اترك الحقل فارغاً إن لم تُعرف القيمة بعد (يظهر في محرك القرارات بنداً ناقصاً).
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-5">
          {MEDICAL_PREMIUM_KEYS.map((k) => {
            const id = `company-field-premium-${k === 'A+' ? 'Aplus' : k}`;
            return (
              <div key={k} className="flex flex-col gap-2 min-w-0">
                <label htmlFor={id} className="text-[12px] font-extrabold text-slate-800">
                  {k === 'DEPENDENT' ? (
                    MEDICAL_PREMIUM_LABELS[k]
                  ) : (
                    <>
                      الفئة <span dir="ltr">{k}</span>
                    </>
                  )}
                </label>
                <input
                  id={id}
                  name={`medicalPremiums.${k}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={formData.medicalPremiums[k]}
                  disabled={!canEdit}
                  placeholder="غير مدخل"
                  onChange={(e) => setPremium(k, e.target.value)}
                  className={inputClass}
                />
              </div>
            );
          })}
        </div>
      </fieldset>

      {/* Iqama fee */}
      <fieldset className="min-w-0" disabled={!canEdit}>
        <legend className="text-[13px] font-extrabold text-slate-800 mb-3">رسوم الإقامة السنوية</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 items-start">
          <div className="flex flex-col gap-2">
            <label htmlFor="company-field-iqamaFeeYear" className="text-[12px] font-extrabold text-slate-800">
              الرسوم بالريال سنوياً
            </label>
            <input
              id="company-field-iqamaFeeYear"
              name="iqamaFeeYear"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={formData.iqamaFeeYear}
              disabled={!canEdit}
              placeholder={`فارغ = ${ruleText}`}
              onChange={(e) => {
                const value = e.target.value;
                setFormData((prev) => ({ ...prev, iqamaFeeYear: value }));
              }}
              className={inputClass}
            />
          </div>
          <p className="text-[11.5px] font-bold text-slate-500 leading-relaxed md:pt-7">{`اتركه فارغاً لاستخدام قيمة سجل القواعد: ${ruleText}.`}</p>
        </div>
      </fieldset>

      {!canEdit && <p className="mt-6 text-[11px] font-bold text-slate-500">تعديل إعدادات الكلفة متاح لمدير النظام وصاحب العمل فقط.</p>}
    </div>
  );
}
