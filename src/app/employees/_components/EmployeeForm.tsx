"use client";

// Shared building blocks for the "new employee" and "edit employee" forms.
// The folder is private (leading underscore), so Next.js does not route it.

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Wallet, Fingerprint, ArrowRight, FileArchive, Check, Briefcase, Calculator, Plus, Trash2, AlertCircle, AlertTriangle, RefreshCw, ShieldCheck, Scale } from 'lucide-react';
import SearchableSelect, { type SelectChangeEvent } from '@/components/SearchableSelect';
import FileUploadField from '@/components/FileUploadField';
import { toast, promptDialog, readApiError } from '@/components/ui/feedback';
import { addDays, parseDateOnly } from '@/lib/dates';
import { formatMoney, sumMoney, toNumber } from '@/lib/money';
import { SAUDI_BANKS, bankOptions } from '@/lib/banks';
import { transliteratePersonName } from '@/lib/transliterate';
import {
  GOSI_REGIMES,
  GOSI_REGIME_LABELS,
  GOSI_SOURCE_SUGGESTIONS,
  SAUDI_NATIONALITY,
  employeeDataWarnings,
  normalizeNationality,
  type EmployeeDataWarning,
} from '@/lib/employee-shared';
import { ID_TYPES, ID_TYPE_LABELS } from '@/lib/identity';
import {
  ALLOWANCE_TYPES,
  ALLOWANCE_TYPE_LABELS,
  ALLOWANCE_TYPE_UNSET_LABEL,
  DEPENDENTS_FEE_PAYERS,
  DEPENDENTS_FEE_PAYER_LABELS,
  DEPENDENTS_MAX,
  MEDICAL_INSURANCE_CLASSES,
  PART_TIME_HOURS_MAX,
  PART_TIME_HOURS_MIN,
  allowanceTypeFromName,
} from '@/app/api/employees/_workforce-fields';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export interface EmployeeFormData {
  fullNameArabic: string;
  fullNameEnglish: string;
  nationality: string;
  dateOfBirth: string;
  maritalStatus: string;
  gender: string;
  iqamaOrIdNumber: string;
  iqamaOrIdExp: string;
  passportNumber: string;
  passportExp: string;
  healthCertificateNum: string;
  healthCertificateExp: string;
  joinDate: string;
  contractType: string;
  contractEndDate: string;
  probationDays: string;
  leaveAccrualStartDate: string;
  noticePeriodDays: string;
  mobileNumber: string;
  email: string;
  ibanNumber: string;
  bankName: string;
  bankCode: string;
  salaryPaymentMethod: string;
  legalCompanyId: string;
  actualCompanyId: string;
  administrationId: string;
  branchId: string;
  departmentId: string;
  jobTitle: string;
  /** English job title: bilingual official letters (docs/document-engine). */
  jobTitleEnglish: string;
  directManagerId: string;
  workSchedule: string;
  accommodationType: string;
  basicSalary: string;
  gosiDeduction: string;
  idDocUrl: string;
  passportDocUrl: string;
  healthCertDocUrl: string;
  contractDocUrl: string;
  /** GOSI regime (DEC-003): OLD / NEW / UNKNOWN. */
  gosiRegime: string;
  gosiRegistrationSource: string;
  gosiNumber: string;
  /** NATIONAL_ID / IQAMA / BORDER_NUMBER / PASSPORT or '' (not set). */
  idType: string;
  // Workforce decision engine ("بيانات الكلفة والسعودة"): all optional.
  occupationName: string;
  occupationCode: string;
  dependentsCount: string;
  /** COMPANY / EMPLOYEE or '' (not set). */
  dependentsFeePaidBy: string;
  medicalInsuranceClass: string;
  isDisabled: boolean;
  muawamaCertExpiry: string;
  isStudent: boolean;
  /** Only sent for a PART_TIME contract. */
  partTimeWeeklyHours: string;
  qiwaContractDocumented: boolean;
  /** '' with qiwaContractDocumented = today (set by the server). */
  qiwaContractDocumentedAt: string;
}

/** Canonical Saudi label (single source: src/lib/employee-shared.ts). It is never a default value. */
export { SAUDI_NATIONALITY };

/**
 * Maps legacy values ('SAUDI', 'السعودية'...) to the stored Arabic label so the select shows them.
 * Blank stays blank: the nationality must be chosen explicitly (DEC-002/003, no default).
 */
export function normalizeNationalityValue(v: string | null | undefined): string {
  return normalizeNationality(v) ?? '';
}

/**
 * 'FEMALE' / 'أنثى' -> FEMALE, 'MALE' / 'ذكر' -> MALE, anything else -> '' (the select then asks for
 * an explicit choice: there is no default gender, council WP-3).
 */
export function normalizeGenderValue(v: string | null | undefined): 'MALE' | 'FEMALE' | '' {
  const s = (v ?? '').trim();
  if (/^(female|f|أنثى|انثى|أنثي|انثي)$/i.test(s)) return 'FEMALE';
  if (/^(male|m|ذكر)$/i.test(s)) return 'MALE';
  return '';
}

export const GENDER_OPTIONS: Option[] = [
  { label: 'ذكر', value: 'MALE' },
  { label: 'أنثى', value: 'FEMALE' },
];

export const EMPTY_EMPLOYEE_FORM: EmployeeFormData = {
  fullNameArabic: '', fullNameEnglish: '',
  nationality: '', dateOfBirth: '',
  maritalStatus: '', gender: '',
  iqamaOrIdNumber: '', iqamaOrIdExp: '',
  passportNumber: '', passportExp: '',
  healthCertificateNum: '', healthCertificateExp: '',
  joinDate: '', contractType: 'FULL_TIME', contractEndDate: '', probationDays: '90',
  leaveAccrualStartDate: '',
  noticePeriodDays: '30',
  mobileNumber: '', email: '',
  ibanNumber: '', bankName: '', bankCode: '', salaryPaymentMethod: 'BANK_TRANSFER',
  legalCompanyId: '', actualCompanyId: '', administrationId: '',
  branchId: '', departmentId: '',
  jobTitle: '', jobTitleEnglish: '', directManagerId: '', workSchedule: '', accommodationType: '',
  basicSalary: '', gosiDeduction: '',
  idDocUrl: '', passportDocUrl: '', healthCertDocUrl: '', contractDocUrl: '',
  gosiRegime: 'UNKNOWN', gosiRegistrationSource: '', gosiNumber: '', idType: '',
  occupationName: '', occupationCode: '', dependentsCount: '', dependentsFeePaidBy: '', medicalInsuranceClass: '',
  isDisabled: false, muawamaCertExpiry: '', isStudent: false, partTimeWeeklyHours: '',
  qiwaContractDocumented: false, qiwaContractDocumentedAt: '',
};

export interface AllowanceDraft {
  id: string;
  name: string;
  amount: string;
  /** Allowance.countsTowardGosi ("يدخل في وعاء التأمينات"). */
  countsTowardGosi: boolean;
  /** Allowance.allowanceType: HOUSING / TRANSPORT / FOOD / OTHER, '' = not set (inferred from the name). */
  allowanceType: string;
}

/** Default of the GOSI-base checkbox for an allowance name: housing -> true (same rule as the API). */
export function defaultCountsTowardGosi(name: string): boolean {
  return /سكن|housing/i.test(name);
}

export interface Option {
  label: string;
  value: string;
}

interface NamedRow {
  id: string;
  nameArabic: string;
  /** Branch rows: owning company (GET /api/branches returns it). */
  companyId?: string | null;
  /** Department rows: owning branch (GET /api/departments returns it). */
  branchId?: string | null;
}

/** Contract types of the form (FREELANCE is freelance / self-employed work, not remote work). */
const CONTRACT_TYPE_OPTIONS: Option[] = [
  { label: 'دوام كامل', value: 'FULL_TIME' },
  { label: 'دوام جزئي', value: 'PART_TIME' },
  { label: 'عمل حر/مستقل', value: 'FREELANCE' },
];

/**
 * Inline hints for an inconsistent placement (same rules as POST /api/employees, which rejects a new
 * employee in this state): department outside the branch, branch outside the workplace company.
 */
export function placementHints(
  formData: Pick<EmployeeFormData, 'legalCompanyId' | 'actualCompanyId' | 'branchId' | 'departmentId'>,
  branches: ReadonlyArray<NamedRow>,
  departments: ReadonlyArray<NamedRow>,
): { branch: string | null; department: string | null } {
  const branch = formData.branchId ? branches.find((b) => b.id === formData.branchId) : undefined;
  const department = formData.departmentId ? departments.find((d) => d.id === formData.departmentId) : undefined;
  const company = formData.actualCompanyId || formData.legalCompanyId;
  return {
    branch:
      branch?.companyId && company && branch.companyId !== company
        ? formData.actualCompanyId
          ? 'هذا الفرع لا يتبع «الشركة الفعلية لمكان العمل» المختارة'
          : 'هذا الفرع لا يتبع الشركة القانونية المختارة — إن كان الموظف يعمل في فرع شركة أخرى من المجموعة فاختر تلك الشركة في «الشركة الفعلية لمكان العمل»'
        : null,
    department:
      department?.branchId && formData.branchId && department.branchId !== formData.branchId ? 'هذا القسم لا يتبع الفرع المختار' : null,
  };
}

export interface ManagerRow {
  id: string;
  employeeId: string;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  isTerminated?: boolean | null;
}

interface WorkScheduleRow {
  id?: string;
  name: string;
  startTime?: string | null;
  endTime?: string | null;
}

/** Shown until /api/nationalities answers (the server seeds the same list). */
const DEFAULT_NATIONALITIES: Option[] = [
  { label: SAUDI_NATIONALITY, value: SAUDI_NATIONALITY },
  { label: 'مصري', value: 'مصري' },
  { label: 'هندي', value: 'هندي' },
  { label: 'باكستاني', value: 'باكستاني' },
  { label: 'بنجلاديشي', value: 'بنجلاديشي' },
  { label: 'فلبيني', value: 'فلبيني' },
  { label: 'نيبالي', value: 'نيبالي' },
];

export const FORM_SECTIONS = [
  { id: 'personal', title: 'الهوية والمواصفات', subtitle: 'الأسماء، الجنسية، الاتصال', icon: Fingerprint, color: 'text-blue-500' },
  { id: 'job', title: 'العقد والتسكين', subtitle: 'الشركات، المنصب، الأقسام', icon: Briefcase, color: 'text-indigo-500' },
  { id: 'documents', title: 'الأوراق الثبوتية', subtitle: 'مراقبة انتهاء الصلاحيات', icon: FileArchive, color: 'text-violet-500' },
  { id: 'financial', title: 'الحزمة المالية', subtitle: 'الرواتب، البدلات، التأمينات', icon: Wallet, color: 'text-emerald-500' },
  { id: 'workforce', title: 'الكلفة والسعودة', subtitle: 'المهنة، المرافقون، قوى', icon: Scale, color: 'text-amber-500' },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function calcTotalSalary(formData: EmployeeFormData, allowances: AllowanceDraft[], isGosiEnabled: boolean): number {
  const gosi = isGosiEnabled ? toNumber(formData.gosiDeduction) : 0;
  return sumMoney([toNumber(formData.basicSalary), ...allowances.map((a) => toNumber(a.amount)), -gosi]);
}

/** Builds the POST/PUT body. Keeps the request shape the API has always accepted. */
export function buildEmployeePayload(formData: EmployeeFormData, allowances: AllowanceDraft[], isGosiEnabled: boolean) {
  const wordsAr = formData.fullNameArabic.trim().split(/\s+/);
  const firstNameAr = wordsAr[0] || 'بدون اسم';
  // A one-word name has no family name: send '' rather than a placeholder that would show in lists.
  const lastNameAr = wordsAr.slice(1).join(' ');

  const wordsEn = formData.fullNameEnglish.trim().split(/\s+/);
  const firstNameEn = wordsEn[0] || '';
  const lastNameEn = wordsEn.slice(1).join(' ') || '';

  let probationEndDate: string | undefined;
  const joinDate = parseDateOnly(formData.joinDate);
  const probationDays = Math.trunc(toNumber(formData.probationDays, NaN));
  if (joinDate && Number.isFinite(probationDays) && probationDays > 0) {
    probationEndDate = addDays(joinDate, probationDays).toISOString();
  }

  return {
    ...formData,
    probationEndDate,
    firstNameArabic: firstNameAr,
    lastNameArabic: lastNameAr,
    firstNameEnglish: firstNameEn,
    lastNameEnglish: lastNameEn,
    administrationId: formData.administrationId || null,
    gosiDeduction: isGosiEnabled ? formData.gosiDeduction : '0',
    // Dependent fields are only sent with the flag / contract type that makes them meaningful
    // ('' clears them; the API applies the same rules).
    partTimeWeeklyHours: formData.contractType === 'PART_TIME' ? formData.partTimeWeeklyHours : '',
    muawamaCertExpiry: formData.isDisabled ? formData.muawamaCertExpiry : '',
    qiwaContractDocumentedAt: formData.qiwaContractDocumented ? formData.qiwaContractDocumentedAt : '',
    allowances: allowances
      .filter((a) => a.name && a.amount)
      .map((a) => ({ id: a.id, name: a.name, amount: a.amount, countsTowardGosi: a.countsTowardGosi, allowanceType: a.allowanceType || null })),
  };
}

/** Probation days typed in the form (NaN / blank -> null). */
function formProbationDays(formData: EmployeeFormData): number | null {
  const n = Math.trunc(toNumber(formData.probationDays, NaN));
  return Number.isFinite(n) ? n : null;
}

/** Inline data-quality warnings of the form (same rules as the API; they never block saving). */
export function formWarnings(formData: EmployeeFormData): EmployeeDataWarning[] {
  return employeeDataWarnings({
    ibanNumber: formData.ibanNumber,
    iqamaOrIdNumber: formData.iqamaOrIdNumber,
    idType: formData.idType,
    nationality: formData.nationality,
    probationDays: formProbationDays(formData),
    contractEndDate: formData.contractEndDate,
  });
}

/** Shows the warnings returned by POST / PUT /api/employees after a save. */
export function toastSaveWarnings(body: unknown): void {
  const list = body && typeof body === 'object' && Array.isArray((body as { warnings?: unknown }).warnings)
    ? ((body as { warnings: unknown[] }).warnings)
    : [];
  const messages = list
    .map((w) => (w && typeof w === 'object' && typeof (w as { message?: unknown }).message === 'string' ? (w as { message: string }).message : null))
    .filter((m): m is string => !!m);
  if (messages.length) toast.warning(`تم الحفظ مع تنبيهات: ${messages.join(' — ')}`);
}

function mergeNationalities(fromDb: Option[], extra: string[] = []): Option[] {
  const seen = new Set<string>();
  const out: Option[] = [];
  for (const o of [...fromDb, ...DEFAULT_NATIONALITIES, ...extra.map((v) => ({ label: v, value: v }))]) {
    if (!o.value || seen.has(o.value)) continue;
    seen.add(o.value);
    out.push(o);
  }
  return out;
}

async function readArray<T>(res: Response): Promise<T[]> {
  if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل البيانات المرجعية'));
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface EmployeeFormReferences {
  companies: NamedRow[];
  administrations: NamedRow[];
  branches: NamedRow[];
  departments: NamedRow[];
  managers: ManagerRow[];
  nationalities: Option[];
}

/** Loads the dropdown data used by the employee form. */
export function useEmployeeFormReferences() {
  const router = useRouter();
  const [refs, setRefs] = useState<EmployeeFormReferences>({
    companies: [], administrations: [], branches: [], departments: [], managers: [], nationalities: DEFAULT_NATIONALITIES,
  });
  const [refsLoading, setRefsLoading] = useState(true);
  const [refsError, setRefsError] = useState<string | null>(null);

  const loadRefs = useCallback(async () => {
    setRefsLoading(true);
    setRefsError(null);
    try {
      const responses = await Promise.all([
        fetch('/api/companies'),
        fetch('/api/administrations'),
        fetch('/api/branches'),
        fetch('/api/departments'),
        fetch('/api/employees?fields=basic'),
        fetch('/api/nationalities'),
      ]);
      if (responses.some((r) => r.status === 401)) {
        router.replace('/login');
        return;
      }
      // Each list loads independently: one failing endpoint must not empty the other dropdowns.
      const errors: string[] = [];
      const safe = <T,>(p: Promise<T[]>) =>
        p.catch((err: unknown) => {
          errors.push(err instanceof Error && err.message ? err.message : 'تعذر تحميل البيانات المرجعية');
          return [] as T[];
        });
      const [companies, administrations, branches, departments, managers] = await Promise.all([
        safe(readArray<NamedRow>(responses[0])),
        safe(readArray<NamedRow>(responses[1])),
        safe(readArray<NamedRow>(responses[2])),
        safe(readArray<NamedRow>(responses[3])),
        safe(readArray<ManagerRow>(responses[4])),
      ]);
      // Nationalities are optional: fall back to the default list.
      const nats = await readArray<{ label: string }>(responses[5]).catch(() => []);
      if (errors.length) setRefsError(Array.from(new Set(errors)).join(' — '));
      setRefs((prev) => ({
        companies,
        administrations,
        branches,
        departments,
        managers,
        nationalities: mergeNationalities(
          nats.filter((n) => typeof n.label === 'string').map((n) => ({ label: n.label, value: n.label })),
          prev.nationalities.map((n) => n.value),
        ),
      }));
    } catch (err) {
      setRefsError(err instanceof Error && err.message ? err.message : 'تعذر تحميل البيانات المرجعية');
    } finally {
      setRefsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadRefs();
  }, [loadRefs]);

  /** Makes sure a value (e.g. the employee's saved nationality) is selectable. */
  const ensureNationality = useCallback((value: string) => {
    if (!value) return;
    setRefs((prev) => ({ ...prev, nationalities: mergeNationalities(prev.nationalities, [value]) }));
  }, []);

  return { refs, refsLoading, refsError, reloadRefs: loadRefs, ensureNationality };
}

/** Work schedules of the selected branch. */
export function useBranchSchedules() {
  const [branchSchedules, setBranchSchedules] = useState<WorkScheduleRow[]>([]);
  const loadBranchSchedules = useCallback(async (branchId: string) => {
    if (!branchId) {
      setBranchSchedules([]);
      return;
    }
    try {
      const res = await fetch(`/api/work-schedules?branchId=${encodeURIComponent(branchId)}`);
      if (!res.ok) {
        setBranchSchedules([]);
        toast.error(await readApiError(res, 'تعذر تحميل جداول العمل للفرع'));
        return;
      }
      const data: unknown = await res.json();
      setBranchSchedules(Array.isArray(data) ? (data as WorkScheduleRow[]) : []);
    } catch {
      setBranchSchedules([]);
      toast.error('تعذر تحميل جداول العمل للفرع');
    }
  }, []);
  return { branchSchedules, loadBranchSchedules };
}

/** Highlights the side-menu entry of the section in view. */
export function useActiveSegment(enabled = true) {
  const [activeSegment, setActiveSegment] = useState<string>('personal');
  useEffect(() => {
    if (!enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActiveSegment(entry.target.id);
        });
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    FORM_SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [enabled]);
  return activeSegment;
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

export function EmployeeFormSideNav({ activeSegment, backHref, backLabel, title }: { activeSegment: string; backHref: string; backLabel: string; title: React.ReactNode }) {
  return (
    <aside className="hidden lg:block w-[300px] shrink-0 border-l border-slate-200/60 p-8 h-[calc(100vh-80px)] sticky top-0 bg-white shadow-[10px_0_30px_rgba(0,0,0,0.01)] z-10 overflow-hidden">
      <Link href={backHref} className="inline-flex items-center gap-2 text-slate-400 hover:text-blue-600 transition font-bold text-[13px] mb-12 group">
        <span className="w-8 h-8 rounded-full bg-slate-50 border border-slate-200 flex items-center justify-center group-hover:bg-blue-50 group-hover:border-blue-200 transition">
          <ArrowRight size={16} />
        </span>
        {backLabel}
      </Link>

      <div className="mb-10">
        <h2 className="text-2xl font-black text-slate-800 leading-snug">{title}</h2>
      </div>

      <nav className="relative" aria-label="أقسام النموذج">
        <div className="absolute top-0 bottom-0 right-[25px] w-0.5 bg-slate-100 rounded-full" />
        <ul className="space-y-4">
          {FORM_SECTIONS.map((item) => {
            const isActive = activeSegment === item.id;
            const Icon = item.icon;
            return (
              <li key={item.id} className="relative z-10">
                <a
                  href={`#${item.id}`}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={(e) => { e.preventDefault(); document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' }); }}
                  className={`flex items-start gap-5 p-3 rounded-2xl transition-all duration-300 ${isActive ? 'bg-white shadow-[0_10px_30px_rgba(0,0,0,0.06)] scale-105 border border-slate-100' : 'hover:bg-slate-50 hover:translate-x-1'}`}
                >
                  <div className={`w-12 h-12 rounded-[1rem] flex items-center justify-center shrink-0 shadow-inner transition-colors duration-500 ${isActive ? `bg-blue-50 ${item.color}` : 'bg-slate-50 text-slate-300'}`}>
                    <Icon size={22} className={isActive ? 'animate-pulse' : ''} />
                  </div>
                  <div className="pt-1.5 flex flex-col justify-center">
                    <span className={`font-extrabold text-[14px] leading-none mb-1.5 transition-colors ${isActive ? 'text-slate-800' : 'text-slate-400'}`}>{item.title}</span>
                    <span className="text-[11px] font-bold text-slate-400">{item.subtitle}</span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

export function EmployeeFormSaveBar({ cancelHref, formId, isSubmitting, disabled, children }: { cancelHref: string; formId: string; isSubmitting: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 lg:right-[300px] h-[90px] bg-white/80 backdrop-blur-2xl border-t border-slate-200 shadow-[0_-20px_40px_rgba(0,0,0,0.02)] z-40 flex items-center justify-between px-8 md:px-14">
      <p className="hidden md:flex items-center gap-2 text-slate-500 font-bold text-[13px]">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] animate-pulse" />
        أرشيف رقمي آمن وموحد.
      </p>

      <div className="flex items-center gap-4 w-full md:w-auto">
        <Link href={cancelHref} className="px-6 py-4 flex-1 md:flex-none text-center rounded-[1.25rem] font-bold text-[13px] text-slate-500 hover:bg-slate-100 transition-colors">
          تجاهل وإلغاء
        </Link>
        <button
          disabled={isSubmitting || disabled}
          type="submit"
          form={formId}
          aria-busy={isSubmitting}
          className="px-8 py-4 flex-1 md:flex-none flex items-center justify-center gap-3 rounded-[1.25rem] font-black text-[14px] text-white bg-blue-600 hover:bg-blue-700 hover:shadow-[0_10px_25px_rgba(37,99,235,0.3)] hover:-translate-y-1 transition-all disabled:opacity-50 disabled:hover:translate-y-0 disabled:cursor-not-allowed"
        >
          {isSubmitting ? <span className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : children}
        </button>
      </div>
    </div>
  );
}

export function FormAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mb-10 bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4 animate-in slide-in-from-top-4">
      <AlertCircle className="text-red-500 shrink-0" size={24} />
      <p className="text-[14px] font-extrabold text-red-800 flex-1">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-red-200 text-red-700 font-black text-[12px] hover:bg-red-100 transition-colors">
          <RefreshCw size={14} /> إعادة المحاولة
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form fields (4 segments)
// ---------------------------------------------------------------------------

interface EmployeeFormFieldsProps {
  formData: EmployeeFormData;
  setFormData: React.Dispatch<React.SetStateAction<EmployeeFormData>>;
  allowances: AllowanceDraft[];
  setAllowances: React.Dispatch<React.SetStateAction<AllowanceDraft[]>>;
  isGosiEnabled: boolean;
  setIsGosiEnabled: (v: boolean) => void;
  refs: EmployeeFormReferences;
  ensureNationality: (value: string) => void;
  branchSchedules: WorkScheduleRow[];
  loadBranchSchedules: (branchId: string) => void;
  /** Employee being edited: excluded from the direct-manager list. */
  currentEmployeeId?: string;
}

type FieldChangeEvent = SelectChangeEvent | React.ChangeEvent<HTMLInputElement>;

export function EmployeeFormFields({
  formData,
  setFormData,
  allowances,
  setAllowances,
  isGosiEnabled,
  setIsGosiEnabled,
  refs,
  ensureNationality,
  branchSchedules,
  loadBranchSchedules,
  currentEmployeeId,
}: EmployeeFormFieldsProps) {
  const [isAddingNationality, setIsAddingNationality] = useState(false);
  const warnings = formWarnings(formData);
  const warningOf = (field: EmployeeDataWarning['field']) => warnings.find((w) => w.field === field)?.message ?? null;
  const placement = placementHints(formData, refs.branches, refs.departments);

  const handleChange = (e: FieldChangeEvent) => {
    const { name, value } = e.target;
    if (name === 'branchId') {
      // A new branch invalidates the selected work schedule.
      setFormData((prev) => ({ ...prev, branchId: value, workSchedule: '' }));
      loadBranchSchedules(value);
      return;
    }
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setFormData((prev) => ({ ...prev, fullNameArabic: val, fullNameEnglish: transliteratePersonName(val) }));
  };

  const handleAddNationality = async () => {
    if (isAddingNationality) return;
    const input = await promptDialog('أدخل الجنسية الجديدة (مثال: سوري، أردني):', { title: 'إضافة جنسية', placeholder: 'اسم الجنسية' });
    const val = input?.trim();
    if (!val) return;
    setIsAddingNationality(true);
    try {
      const res = await fetch('/api/nationalities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: val }),
      });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حفظ الجنسية'));
        return;
      }
      // The server stores Saudi aliases ('SAUDI'...) as the default label: select what it saved.
      const saved = (await res.json().catch(() => null)) as { label?: unknown } | null;
      const label = typeof saved?.label === 'string' && saved.label ? saved.label : normalizeNationalityValue(val);
      ensureNationality(label);
      setFormData((prev) => ({ ...prev, nationality: label }));
      toast.success('تمت إضافة الجنسية');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsAddingNationality(false);
    }
  };

  const addAllowance = () => setAllowances((prev) => [...prev, { id: crypto.randomUUID(), name: '', amount: '', countsTowardGosi: false, allowanceType: '' }]);
  const updateAllowance = (id: string, field: 'name' | 'amount', value: string) =>
    setAllowances((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        // Picking a name sets the GOSI-base default for it (housing -> yes); HR can still change it.
        // The type follows the name while it was not chosen by hand ('' or the previous name's type).
        if (field === 'name') {
          const autoType = !a.allowanceType || a.allowanceType === allowanceTypeFromName(a.name);
          return { ...a, name: value, countsTowardGosi: defaultCountsTowardGosi(value), allowanceType: autoType ? allowanceTypeFromName(value) : a.allowanceType };
        }
        return { ...a, amount: value };
      }),
    );
  const setAllowanceGosi = (id: string, value: boolean) =>
    setAllowances((prev) => prev.map((a) => (a.id === id ? { ...a, countsTowardGosi: value } : a)));
  const setAllowanceType = (id: string, value: string) =>
    setAllowances((prev) => prev.map((a) => (a.id === id ? { ...a, allowanceType: value } : a)));
  const setFlag = (name: 'isDisabled' | 'isStudent' | 'qiwaContractDocumented', value: boolean) =>
    setFormData((prev) => ({ ...prev, [name]: value }));
  const removeAllowance = (id: string) => setAllowances((prev) => prev.filter((a) => a.id !== id));

  const companyOptions = refs.companies.map((c) => ({ label: c.nameArabic, value: c.id }));
  const managerOptions = refs.managers
    .filter((e) => e.id !== currentEmployeeId && !e.isTerminated)
    .map((e) => ({ label: `${e.firstNameArabic || ''} ${e.lastNameArabic || ''} - #${e.employeeId}`, value: e.id }));

  return (
    <>
      {/* SEGMENT 1: Personal Info */}
      <FormSegment id="personal" title="البيانات الشخصية و الأساسية" badge="تعريف الهوية">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
          <PremiumInput name="fullNameArabic" value={formData.fullNameArabic} onChange={handleNameChange} label="الاسم بالكامل بالعربي" required />
          <PremiumInput name="fullNameEnglish" value={formData.fullNameEnglish} onChange={handleChange} label="الاسم بالكامل بالإنجليزية" required />

          <div className="flex flex-col gap-2">
            <SearchableSelect
              name="nationality"
              value={formData.nationality}
              onChange={handleChange}
              label="الجنسية"
              required
              accentColor="blue"
              options={refs.nationalities}
            />
            <button
              type="button"
              onClick={handleAddNationality}
              disabled={isAddingNationality}
              className="self-start inline-flex items-center gap-1 text-[12px] font-extrabold text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
            >
              <Plus size={14} /> إضافة جنسية غير موجودة
            </button>
            {!formData.nationality && <p className="text-[12px] font-bold text-slate-500">لا توجد جنسية افتراضية: اختر الجنسية صراحةً</p>}
            <FieldWarning message={warningOf('nationality')} />
          </div>
          <PremiumInput name="dateOfBirth" value={formData.dateOfBirth} onChange={handleChange} label="تاريخ الميلاد" type="date" required />
          <div className="flex flex-col gap-2">
            <SearchableSelect name="gender" value={formData.gender} onChange={handleChange} label="الجنس" required accentColor="blue" options={GENDER_OPTIONS} placeholder="— اختر —" />
            {!formData.gender && <p className="text-[12px] font-bold text-slate-500">لا توجد قيمة افتراضية: اختر الجنس صراحةً (يحدد أهلية إجازة الوضع)</p>}
          </div>
          <SearchableSelect name="maritalStatus" value={formData.maritalStatus} onChange={handleChange} label="الحالة الاجتماعية" accentColor="blue" options={[{ label: 'أعزب', value: 'أعزب' }, { label: 'متزوج', value: 'متزوج' }]} />

          <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10 border-t border-slate-100 pt-10">
            <PremiumInput name="mobileNumber" value={formData.mobileNumber} onChange={handleChange} label="الجوال الشخصي" type="tel" required />
            <PremiumInput name="email" value={formData.email} onChange={handleChange} label="البريد الإلكتروني" type="email" />
          </div>
        </div>
      </FormSegment>

      {/* SEGMENT 2: Job Info */}
      <div className="mt-24" />
      <FormSegment id="job" title="الارتباط التنظيمي و تفاصيل العقد" badge="هياكل الإدارة">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">

          {/* Companies & Branches */}
          <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10 bg-slate-50/50 p-6 rounded-[2rem] border border-slate-100">
            <SearchableSelect name="legalCompanyId" value={formData.legalCompanyId} onChange={handleChange} label="الشركة القانونية التابع لها" required accentColor="blue" options={companyOptions} />
            <SearchableSelect name="actualCompanyId" value={formData.actualCompanyId} onChange={handleChange} label="الشركة الفعلية لمكان العمل" accentColor="blue" options={companyOptions} />

            <SearchableSelect name="administrationId" value={formData.administrationId} onChange={handleChange} label="الإدارة التابع لها" accentColor="blue" options={refs.administrations.map((a) => ({ label: a.nameArabic, value: a.id }))} />
            <div className="flex flex-col gap-2">
              <SearchableSelect name="branchId" value={formData.branchId} onChange={handleChange} label="الفرع المرتبط به" accentColor="blue" options={refs.branches.map((b) => ({ label: b.nameArabic, value: b.id }))} />
              <FieldWarning message={placement.branch} />
            </div>
            <div className="flex flex-col gap-2">
              <SearchableSelect name="departmentId" value={formData.departmentId} onChange={handleChange} label="القسم الإداري" accentColor="blue" options={refs.departments.map((d) => ({ label: d.nameArabic, value: d.id }))} />
              <FieldWarning message={placement.department} />
            </div>
            <div className="md:col-span-2">
              <SearchableSelect name="directManagerId" value={formData.directManagerId} onChange={handleChange} label="المدير المباشر" accentColor="blue" options={managerOptions} />
            </div>
          </div>

          <PremiumInput name="jobTitle" value={formData.jobTitle} onChange={handleChange} label="المسمى الوظيفي المعتمد" required />
          <PremiumInput name="jobTitleEnglish" value={formData.jobTitleEnglish} onChange={handleChange} label="المسمى الوظيفي بالإنجليزية (للخطابات ثنائية اللغة)" dir="ltr" />
          <SearchableSelect
            name="workSchedule"
            value={formData.workSchedule}
            onChange={handleChange}
            label="جدول العمل / الشفتات"
            accentColor="blue"
            options={
              branchSchedules.length > 0
                ? branchSchedules.map((s) => ({ label: `${s.name}${s.startTime ? ` (${s.startTime} - ${s.endTime ?? ''})` : ''}`, value: s.name }))
                : [{ label: formData.branchId ? 'لا توجد جداول مسجلة في هذا الفرع' : 'اختر الفرع أولاً لعرض الجداول', value: '' }]
            }
          />

          <SearchableSelect name="accommodationType" value={formData.accommodationType} onChange={handleChange} label="محل السكن" accentColor="blue" options={[{ label: 'خارج الشركة', value: 'OUTSIDE_COMPANY' }, { label: 'سكن الشركة', value: 'INSIDE_COMPANY' }]} />

          {/* Contract Details */}
          <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-10 border-t border-slate-100 pt-10">
            <SearchableSelect name="contractType" value={formData.contractType} onChange={handleChange} label="نوع العقد" required accentColor="blue" options={CONTRACT_TYPE_OPTIONS} />
            <SearchableSelect name="noticePeriodDays" value={formData.noticePeriodDays} onChange={handleChange} label="فترة الإشعار لإنهاء العقد" required accentColor="blue" options={[{ label: '30 يوم', value: '30' }, { label: '60 يوم', value: '60' }, { label: '90 يوم', value: '90' }]} />
            <div />
            <PremiumInput name="joinDate" value={formData.joinDate} onChange={handleChange} label="تاريخ مباشرة العمل (آلياً للتصفية النهائية)" type="date" required />
            <PremiumInput name="leaveAccrualStartDate" value={formData.leaveAccrualStartDate} onChange={handleChange} label="تاريخ احتساب الإجازة / العودة من آخر إجازة" type="date" required />
            <PremiumInput name="contractEndDate" value={formData.contractEndDate} onChange={handleChange} label="تاريخ انتهاء العقد" type="date" warning={warningOf('contractEndDate')} />
            <PremiumInput name="probationDays" value={formData.probationDays} onChange={handleChange} label="مدة فترة التجربة (بالأيام)" type="number" min={0} warning={warningOf('probationDays')} />
            <div className="md:col-span-3 mt-2">
              <FileUploadField employeeId={currentEmployeeId} name="contractDocUrl" value={formData.contractDocUrl} onChange={handleChange} label="مرفق صورة العقد" accept=".pdf,.jpg,.jpeg,.png" />
            </div>
          </div>
        </div>
      </FormSegment>

      {/* SEGMENT 3: Documents */}
      <div className="mt-24" />
      <FormSegment id="documents" title="الوثائق الرسمية والثبوتية" badge="تنبيهات الانقضاء">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-12 gap-y-12">
          <div className="space-y-10">
            <h4 className="font-black text-[15px] text-slate-800 flex items-center gap-2">الهوية الوطنية / الإقامة</h4>
            <SearchableSelect name="idType" value={formData.idType} onChange={handleChange} label="نوع الهوية" accentColor="blue" options={ID_TYPES.map((t) => ({ label: ID_TYPE_LABELS[t], value: t }))} />
            <PremiumInput name="iqamaOrIdNumber" value={formData.iqamaOrIdNumber} onChange={handleChange} label="رقم الهوية / الإقامة" required dir="ltr" warning={warningOf('iqamaOrIdNumber')} />
            <PremiumInput name="iqamaOrIdExp" value={formData.iqamaOrIdExp} onChange={handleChange} label="تاريخ انتهاء الصلاحية" type="date" required />
            <FileUploadField employeeId={currentEmployeeId} name="idDocUrl" value={formData.idDocUrl} onChange={handleChange} label="مرفق صورة الهوية / الإقامة" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
          <div className="space-y-10 border-t md:border-t-0 md:border-r md:border-l border-slate-100 pt-10 md:pt-0 px-0 md:px-6">
            <h4 className="font-black text-[15px] text-slate-800 flex items-center gap-2">الجواز والسفر</h4>
            <PremiumInput name="passportNumber" value={formData.passportNumber} onChange={handleChange} label="رقم جواز السفر" />
            <PremiumInput name="passportExp" value={formData.passportExp} onChange={handleChange} label="تاريخ انتهاء الجواز" type="date" />
            <FileUploadField employeeId={currentEmployeeId} name="passportDocUrl" value={formData.passportDocUrl} onChange={handleChange} label="مرفق صورة جواز السفر" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
          <div className="space-y-10 border-t md:border-t-0 border-slate-100 pt-10 md:pt-0 pl-0 md:pl-6">
            <h4 className="font-black text-[15px] text-slate-800 flex items-center gap-2">الشهادة الصحية</h4>
            <PremiumInput name="healthCertificateNum" value={formData.healthCertificateNum} onChange={handleChange} label="رقم الشهادة الصحية" />
            <PremiumInput name="healthCertificateExp" value={formData.healthCertificateExp} onChange={handleChange} label="تاريخ انتهاء الشهادة" type="date" />
            <FileUploadField employeeId={currentEmployeeId} name="healthCertDocUrl" value={formData.healthCertDocUrl} onChange={handleChange} label="مرفق صورة الشهادة الصحية" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
      </FormSegment>

      {/* SEGMENT 4: Financial & Allowances */}
      <div className="mt-24" />
      <FormSegment id="financial" title="المستحقات ومسير الرواتب" badge="البنك و التأمينات" highlight>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">

          {/* Bank Info */}
          <div className="md:col-span-2 flex flex-col gap-6 p-6 bg-slate-50/50 rounded-[2rem] border border-slate-100">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <SearchableSelect name="salaryPaymentMethod" value={formData.salaryPaymentMethod} onChange={handleChange} label="طريقة استلام الراتب" required accentColor="blue"
                options={[{ label: 'حوالة بنكية خاصة', value: 'BANK_TRANSFER' }, { label: 'مدد (حماية الأجور)', value: 'WPS' }, { label: 'كاش نقدي', value: 'CASH' }]} />
              <SearchableSelect
                name="bankName"
                value={formData.bankName}
                onChange={(e) => {
                  const bank = SAUDI_BANKS.find((b) => b.value === e.target.value);
                  setFormData((prev) => ({ ...prev, bankName: e.target.value, bankCode: bank?.code || '' }));
                }}
                label="اسم البنك"
                accentColor="blue"
                options={bankOptions()}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <PremiumInput name="bankCode" value={formData.bankCode} onChange={handleChange} label="رمز البنك (SWIFT)" placeholder="مثال: RJHI" />
              <PremiumInput name="ibanNumber" value={formData.ibanNumber} onChange={handleChange} label="رقم الآيبان (IBAN)" dir="ltr" warning={warningOf('ibanNumber')} />
            </div>
          </div>

          {/* Base Salary */}
          <PremiumInput name="basicSalary" value={formData.basicSalary} onChange={handleChange} label="الراتب الأساسي الشهري" type="number" min={0} step="0.01" required icon={<span className="text-[11px] font-black text-emerald-500">ر.س</span>} />

          {/* GOSI Deduction */}
          <div className="flex flex-col gap-4">
            <label className="flex items-center gap-3 cursor-pointer group p-4 border-2 border-slate-100 rounded-2xl hover:border-blue-200 transition-colors">
              <input type="checkbox" className="sr-only" checked={isGosiEnabled} onChange={(e) => setIsGosiEnabled(e.target.checked)} />
              <div className={`w-6 h-6 rounded-lg flex items-center justify-center border-2 transition-colors ${isGosiEnabled ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>
                {isGosiEnabled && <Check size={14} className="text-white" />}
              </div>
              <div>
                <span className="text-[13px] font-extrabold text-slate-800">تجاوز يدوي لحصة الموظف (يُحسب آلياً إذا لم تُفعَّل)</span>
                <span className="block text-[11px] text-slate-500 font-bold mt-1">
                  بدون تفعيل: تُحسب حصة الموظف في المسير من جدول التأمينات. عند التفعيل: يُعتمد المبلغ الشهري المُدخل بدلاً منها.
                </span>
              </div>
            </label>
            {isGosiEnabled && (
              <div className="animate-in slide-in-from-top-2">
                <PremiumInput name="gosiDeduction" value={formData.gosiDeduction} onChange={handleChange} label="حصة الموظف الشهرية (مبلغ يدوي)" type="number" min={0} step="0.01" required={isGosiEnabled} icon={<span className="text-[11px] font-black text-red-500">- ر.س</span>} />
              </div>
            )}
          </div>

          {/* GOSI registration (DEC-003): the regime is confirmed from a document, never derived from a date */}
          <div className="md:col-span-2 flex flex-col gap-6 p-6 bg-slate-50/50 rounded-[2rem] border border-slate-100">
            <div className="flex items-center gap-2">
              <ShieldCheck size={18} className="text-blue-600" />
              <h4 className="font-extrabold text-[15px] text-slate-800">التسجيل في التأمينات الاجتماعية</h4>
            </div>
            <p className="text-[12px] font-bold text-slate-500 leading-relaxed">
              يُحدَّد نظام التأمينات من مستند (شهادة اشتراك أو قائمة مشتركي المنشأة في GOSI) ولا يُستنتج من تاريخ المباشرة. اتركه «غير مؤكد» حتى يتوفر المستند.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <SearchableSelect
                name="gosiRegime"
                value={formData.gosiRegime}
                onChange={handleChange}
                label="نظام التأمينات"
                accentColor="blue"
                options={GOSI_REGIMES.map((r) => ({ label: GOSI_REGIME_LABELS[r], value: r }))}
              />
              <div className="flex flex-col gap-2">
                <PremiumInput
                  name="gosiRegistrationSource"
                  value={formData.gosiRegistrationSource}
                  onChange={handleChange}
                  label="مصدر التأكيد"
                  list="gosi-source-suggestions"
                  required={formData.gosiRegime === 'OLD' || formData.gosiRegime === 'NEW'}
                />
                <datalist id="gosi-source-suggestions">
                  {GOSI_SOURCE_SUGGESTIONS.map((src) => <option key={src} value={src} />)}
                </datalist>
              </div>
              <PremiumInput name="gosiNumber" value={formData.gosiNumber} onChange={handleChange} label="رقم الاشتراك في التأمينات" dir="ltr" />
            </div>
          </div>

          {/* Allowances Builder */}
          <div className="md:col-span-2 pt-6 border-t border-slate-100">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h4 className="font-extrabold text-[15px] text-slate-800 flex items-center gap-2"><Plus size={16} className="text-emerald-500" /> البدلات والإضافات</h4>
                <p className="text-[12px] text-slate-500 font-bold">مثل بدل السكن، بدل النقل، المواصلات وغيرها</p>
              </div>
              <button type="button" onClick={addAllowance} className="text-[12px] font-extrabold text-blue-600 bg-blue-50 hover:bg-blue-100 px-4 py-2 rounded-xl transition-all">
                + إضافة بدل
              </button>
            </div>

            <div className="space-y-4 mb-8">
              {allowances.map((allw) => (
                <div key={allw.id} className="flex flex-wrap gap-4 items-center bg-white p-2 pl-4 pr-2 border border-slate-200 rounded-xl">
                  <select
                    aria-label="نوع البدل"
                    value={allw.name}
                    onChange={(e) => updateAllowance(allw.id, 'name', e.target.value)}
                    required
                    className="flex-1 px-4 py-2 font-bold text-[13px] focus:outline-none focus:text-blue-600 bg-transparent text-slate-800"
                  >
                    <option value="" disabled>اختر البدل...</option>
                    {!ALLOWANCE_NAMES.includes(allw.name) && allw.name && <option value={allw.name}>{allw.name}</option>}
                    {ALLOWANCE_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <select
                    aria-label="تصنيف البدل (لمحرك القرارات)"
                    title="تصنيف البدل: يحدد كيف يُحتسب في الكلفة الحقيقية. «غير محدد» = يُستنتج من الاسم"
                    value={allw.allowanceType}
                    onChange={(e) => setAllowanceType(allw.id, e.target.value)}
                    className="shrink-0 px-3 py-2 font-bold text-[12px] rounded-lg border border-slate-200 bg-slate-50 text-slate-700 focus:outline-none focus:border-blue-300"
                  >
                    <option value="">النوع: {ALLOWANCE_TYPE_UNSET_LABEL}</option>
                    {ALLOWANCE_TYPES.map((t) => <option key={t} value={t}>النوع: {ALLOWANCE_TYPE_LABELS[t]}</option>)}
                  </select>
                  <label className="flex items-center gap-2 shrink-0 text-[12px] font-bold text-slate-600 cursor-pointer select-none" title="يُحتسب هذا البدل ضمن الأجر الخاضع لاشتراك التأمينات (مثل بدل السكن)">
                    <input
                      type="checkbox"
                      checked={allw.countsTowardGosi}
                      onChange={(e) => setAllowanceGosi(allw.id, e.target.checked)}
                      className="w-4 h-4 rounded border-slate-300 accent-blue-600"
                    />
                    يدخل في وعاء التأمينات
                  </label>
                  <div className="w-px h-8 bg-slate-200" />
                  <input
                    type="number"
                    aria-label="مبلغ البدل"
                    placeholder="المبلغ"
                    min={0}
                    step="0.01"
                    value={allw.amount}
                    onChange={(e) => updateAllowance(allw.id, 'amount', e.target.value)}
                    required
                    className="w-32 px-4 py-2 font-bold text-[13px] focus:outline-none focus:text-emerald-600"
                  />
                  <button type="button" aria-label="حذف البدل" onClick={() => removeAllowance(allw.id)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500 transition-colors">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>

            {/* Total Salary Calculator */}
            <div className="bg-slate-900 rounded-[2rem] p-8 flex flex-col md:flex-row items-center justify-between gap-6 overflow-hidden relative shadow-2xl">
              <Calculator className="absolute -left-10 -top-10 text-white/5" size={180} />
              <div className="relative z-10 text-center md:text-right">
                <p className="text-white/60 font-bold text-[13px] mb-2 uppercase">إجمالي العقد المستحق (الراتب الشامل)</p>
                <p className="text-white/40 text-[11px] font-semibold">يشمل الراتب الأساسي + مجموع كافة البدلات المدرجة</p>
              </div>
              <div className="relative z-10 flex items-baseline gap-2 bg-white/10 px-8 py-5 rounded-3xl border border-white/20 backdrop-blur-md">
                <span className="text-4xl font-black text-white">{formatMoney(calcTotalSalary(formData, allowances, isGosiEnabled))}</span>
                <span className="text-emerald-400 font-extrabold text-sm">ر.س / شهرياً</span>
              </div>
            </div>
          </div>
        </div>
      </FormSegment>

      {/* SEGMENT 5: Workforce decision engine data (cost & Saudization) */}
      <div className="mt-24" />
      <FormSegment id="workforce" title="بيانات الكلفة والسعودة" badge="محرك القرارات">
        <p className="text-[12px] font-bold text-slate-500 leading-relaxed mb-10 -mt-4">
          تُستخدم في حساب الكلفة الحقيقية للموظف وأوزان نطاقات. كل الحقول اختيارية، ويمكن تحديث المهنة وعدد المرافقين من مطابقة مقيم.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-10">
          <PremiumInput name="occupationName" value={formData.occupationName} onChange={handleChange} label="المهنة (كما في مقيم / قوى)" placeholder="مثال: محاسب" />
          <PremiumInput name="occupationCode" value={formData.occupationCode} onChange={handleChange} label="رمز المهنة (اختياري — التصنيف السعودي الموحد للمهن)" dir="ltr" placeholder="241101" />

          <PremiumInput name="dependentsCount" value={formData.dependentsCount} onChange={handleChange} label="عدد المرافقين" type="number" min={0} max={DEPENDENTS_MAX} step="1" />
          <SearchableSelect
            name="dependentsFeePaidBy"
            value={formData.dependentsFeePaidBy}
            onChange={handleChange}
            label="من يدفع رسوم المرافقين"
            accentColor="blue"
            placeholder="غير محدد"
            options={[{ label: 'غير محدد', value: '' }, ...DEPENDENTS_FEE_PAYERS.map((p) => ({ label: DEPENDENTS_FEE_PAYER_LABELS[p], value: p }))]}
          />

          <SearchableSelect
            name="medicalInsuranceClass"
            value={formData.medicalInsuranceClass}
            onChange={handleChange}
            label="فئة التأمين الطبي"
            accentColor="blue"
            placeholder="غير محدد"
            options={[{ label: 'غير محدد', value: '' }, ...MEDICAL_INSURANCE_CLASSES.map((c) => ({ label: `فئة ${c}`, value: c }))]}
          />
          {formData.contractType === 'PART_TIME' ? (
            <PremiumInput
              name="partTimeWeeklyHours"
              value={formData.partTimeWeeklyHours}
              onChange={handleChange}
              label="ساعات الدوام الجزئي أسبوعياً"
              type="number"
              min={PART_TIME_HOURS_MIN}
              max={PART_TIME_HOURS_MAX}
              step="0.5"
            />
          ) : (
            <p className="self-end text-[12px] font-bold text-slate-400 pb-4">ساعات الدوام الجزئي تظهر عند اختيار عقد «دوام جزئي».</p>
          )}

          <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-6 border-t border-slate-100 pt-10">
            <div className="flex flex-col gap-4">
              <FlagCheckbox checked={formData.isDisabled} onChange={(v) => setFlag('isDisabled', v)} label="ذو إعاقة" hint="يُحتسب بوزن خاص في نطاقات عند وجود شهادة مواءمة سارية" />
              {formData.isDisabled && (
                <PremiumInput name="muawamaCertExpiry" value={formData.muawamaCertExpiry} onChange={handleChange} label="تاريخ انتهاء شهادة مواءمة" type="date" />
              )}
            </div>
            <FlagCheckbox checked={formData.isStudent} onChange={(v) => setFlag('isStudent', v)} label="طالب" hint="الطلاب يُحتسبون بوزن مختلف في نطاقات" />
            <div className="flex flex-col gap-4">
              <FlagCheckbox checked={formData.qiwaContractDocumented} onChange={(v) => setFlag('qiwaContractDocumented', v)} label="العقد موثّق في قوى" hint="اترك التاريخ فارغاً ليُسجَّل تاريخ اليوم" />
              {formData.qiwaContractDocumented && (
                <PremiumInput name="qiwaContractDocumentedAt" value={formData.qiwaContractDocumentedAt} onChange={handleChange} label="تاريخ توثيق العقد في قوى" type="date" />
              )}
            </div>
          </div>
        </div>
      </FormSegment>
    </>
  );
}

/** Checkbox card used by the workforce section. */
function FlagCheckbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer p-4 border-2 rounded-2xl transition-colors ${checked ? 'border-blue-200 bg-blue-50/40' : 'border-slate-100 hover:border-blue-200'}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 w-4 h-4 rounded border-slate-300 accent-blue-600" />
      <span>
        <span className="text-[13px] font-extrabold text-slate-800">{label}</span>
        {hint && <span className="block text-[11px] text-slate-500 font-bold mt-1">{hint}</span>}
      </span>
    </label>
  );
}

/** Same names as the Excel template columns / import (src/lib/employee.ts ALLOWANCE_NAMES). */
const ALLOWANCE_NAMES = ['بدل سكن', 'بدل نقل', 'بدلات أخرى'];

// ---------------------------------------------------------------------------
// Small UI components
// ---------------------------------------------------------------------------

function FormSegment({ id, title, badge, children, highlight }: { id: string; title: string; badge: string; children: React.ReactNode; highlight?: boolean }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-32 p-8 md:p-12 rounded-[2.5rem] border transition-all duration-300 ${highlight ? 'bg-white border-blue-100 shadow-[0_10px_40px_rgba(0,0,0,0.03)]' : 'bg-white border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.02)] hover:border-slate-200'}`}>
      <div className="flex items-center justify-between mb-12 border-b border-slate-100 pb-8">
        <h2 id={`${id}-title`} className={`font-black text-2xl ${highlight ? 'text-blue-900' : 'text-slate-800'}`}>{title}</h2>
        <span className={`text-[10px] font-black uppercase px-3 py-1.5 rounded-xl ${highlight ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{badge}</span>
      </div>
      <div>{children}</div>
    </section>
  );
}

interface PremiumInputProps {
  label: string;
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  icon?: React.ReactNode;
  min?: number;
  max?: number;
  step?: string;
  /** Data-quality warning shown under the field (never blocks saving). */
  warning?: string | null;
  dir?: 'ltr' | 'rtl';
  /** id of a <datalist> with suggestions. */
  list?: string;
}

/** Amber inline warning under a field. */
function FieldWarning({ message, id }: { message: string | null | undefined; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="status" className="flex items-start gap-1.5 text-[12px] font-bold text-amber-700 leading-relaxed">
      <AlertTriangle size={14} className="shrink-0 mt-0.5" /> <span>{message} <span className="text-amber-600/80">(تنبيه — لا يمنع الحفظ)</span></span>
    </p>
  );
}

function PremiumInput({ label, name, value, onChange, type = 'text', required, placeholder, icon, min, max, step, warning, dir, list }: PremiumInputProps) {
  const inputId = `emp-field-${name}`;
  const warningId = warning ? `${inputId}-warning` : undefined;
  return (
    <div className="flex flex-col gap-2.5 group relative">
      <label htmlFor={inputId} className="text-[13px] font-extrabold text-slate-700 group-focus-within:text-blue-600 transition-colors flex items-center justify-between">
        <span>{label} {required && <span className="text-red-500 text-sm">*</span>}</span>
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={type} name={name} value={value} onChange={onChange} required={required} placeholder={placeholder} min={min} max={max} step={step} list={list}
          aria-describedby={warningId}
          {...(type === 'date' ? { dir: 'ltr', lang: 'en' } : dir ? { dir } : {})}
          className={`w-full bg-slate-50/50 hover:bg-white border-2 ${warning ? 'border-amber-300' : 'border-slate-100'} focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all placeholder:text-slate-300 placeholder:font-semibold ${type === 'date' ? 'text-right' : ''}`}
        />
        {icon && (
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
            {icon}
          </div>
        )}
      </div>
      <FieldWarning message={warning} id={warningId} />
    </div>
  );
}
