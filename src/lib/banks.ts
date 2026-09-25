// Saudi banks used by employee bank-account fields (employee create/edit, portal data-update requests).
// `value` is what is stored in Employee.bankName; `code` is the SWIFT-style short code shown in lists.

export interface SaudiBank {
  label: string;
  value: string;
  code: string;
}

export const SAUDI_BANKS: readonly SaudiBank[] = [
  { label: 'البنك الأهلي السعودي', value: 'البنك الأهلي السعودي', code: 'NCBK' },
  { label: 'مصرف الراجحي', value: 'مصرف الراجحي', code: 'RJHI' },
  { label: 'بنك الرياض', value: 'بنك الرياض', code: 'RIBL' },
  { label: 'مصرف الإنماء', value: 'مصرف الإنماء', code: 'INMA' },
  { label: 'البنك السعودي للاستثمار', value: 'البنك السعودي للاستثمار', code: 'SIBC' },
  { label: 'البنك السعودي الفرنسي', value: 'البنك السعودي الفرنسي', code: 'BSFR' },
  { label: 'البنك العربي الوطني', value: 'البنك العربي الوطني', code: 'ARNB' },
  { label: 'بنك البلاد', value: 'بنك البلاد', code: 'ALBI' },
  { label: 'بنك الجزيرة', value: 'بنك الجزيرة', code: 'BJAZ' },
  { label: 'البنك السعودي البريطاني (ساب)', value: 'البنك السعودي البريطاني', code: 'SABB' },
  { label: 'بنك stc', value: 'بنك stc', code: 'STCB' },
  { label: 'بنك الخليج الدولي', value: 'بنك الخليج الدولي', code: 'GULF' },
];

/** Option list for select inputs: "البنك الأهلي السعودي (NCBK)". */
export function bankOptions(): { label: string; value: string }[] {
  return SAUDI_BANKS.map((b) => ({ label: `${b.label} (${b.code})`, value: b.value }));
}

export function findBank(value: string | null | undefined): SaudiBank | undefined {
  if (!value) return undefined;
  return SAUDI_BANKS.find((b) => b.value === value);
}
