"use client";

// Building blocks of the «خطة القوى العاملة» pages: status badge, the «إجراءات أخرى» menu of a plan, response
// types, the position / raise / header dialogs (mounted only while open, with a key: their state starts from
// the props) and the «لماذا؟» dialog of a planned item. Display and input only: every number comes from
// the API (projectPlan / planVsActual).
import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { MEDICAL_INSURANCE_CLASSES } from '@/lib/workforce/reasons';
import {
  PLAN_EXIT_REASONS,
  PLAN_EXIT_REASON_LABELS,
  PLAN_MONTHS,
  PLAN_NATIONALITY_CLASSES,
  PLAN_NATIONALITY_LABELS,
  PLAN_STATUS_LABELS,
  POSITION_KIND_LABELS,
  RAISE_SCOPES,
  RAISE_SCOPE_LABELS,
  type PlanItemResult,
  type PlanProjection,
  type PlanStatus,
  type PositionKind,
  type RaiseScope,
} from '@/lib/workforce/planning';
import type { WfStatus } from '@/lib/workforce/types';
import { callApi } from '../../_components/api';
import { Money, Segmented, SelectField, StatusBadge, buttonClass, inputClass } from '../../_components/ui';

// ---------------------------------------------------------------------------
// Types (GET /api/workforce/plans/[id])
// ---------------------------------------------------------------------------

export interface PositionRow {
  id: string;
  kind: PositionKind;
  kindLabel: string;
  title: string;
  companyId: string | null;
  branchId: string | null;
  departmentId: string | null;
  nationalityClass: string | null;
  gosiRegime: string | null;
  gender: string | null;
  occupationName: string | null;
  basicSalary: number | null;
  housingAllowance: number | null;
  otherAllowances: number | null;
  dependentsCount: number | null;
  medicalClass: string | null;
  startMonth: string | null;
  exitEmployeeId: string | null;
  exitMonth: string | null;
  exitReason: string | null;
  notes: string | null;
}

export interface RaiseRow {
  id: string;
  scope: RaiseScope;
  scopeLabel: string;
  scopeId: string | null;
  pct: number | null;
  amount: number | null;
  effectiveMonth: string;
  notes: string | null;
}

export interface PlanHeader {
  id: string;
  name: string;
  status: PlanStatus;
  statusLabel: string;
  companyId: string | null;
  companyName: string | null;
  fromMonth: string;
  months: number;
  attritionPct: number | null;
  notes: string | null;
  basedOnId: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  submittedAt: string | null;
  submittedById: string | null;
  submittedByName: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  /** «اعتمدها» / «رفضها» of decidedBy (an archived plan keeps its decision). */
  decisionLabel: string | null;
  archivedByName: string | null;
  archivedAt: string | null;
  decisionNote: string | null;
  basedOn: { id: string; name: string; status: string } | null;
}

export interface PlanDetailResponse {
  plan: PlanHeader;
  positions: PositionRow[];
  raises: RaiseRow[];
  projection: Omit<PlanProjection, 'people'>;
  frozen: { snapshotId: string; createdAt: string } | null;
  permissions: { edit: boolean; submit: boolean; approve: boolean; reject: boolean; archive: boolean; copy: boolean; decideReason: string | null };
  names: { employees: Record<string, string>; branches: Record<string, string>; departments: Record<string, string>; companies: Record<string, string> };
  role: string;
}

export interface Lookups {
  companies: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; name: string; employeeNo: string | null; companyId: string | null }>;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-300',
  SUBMITTED: 'bg-amber-50 text-amber-800 border-amber-300',
  APPROVED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-800 border-rose-200',
  ARCHIVED: 'bg-slate-50 text-slate-500 border-slate-200',
};

export function PlanStatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded-lg border px-2 py-0.5 text-[11px] font-black ${STATUS_CLASS[status] ?? STATUS_CLASS.DRAFT}`}>{PLAN_STATUS_LABELS[status as PlanStatus] ?? status}</span>;
}

export const SEVERITY_CLASS: Record<string, string> = {
  ERROR: 'border-rose-200 bg-rose-50 text-rose-800',
  WARNING: 'border-amber-200 bg-amber-50 text-amber-900',
  INFO: 'border-slate-200 bg-slate-50 text-slate-700',
};

// ---------------------------------------------------------------------------
// «إجراءات أخرى»: the secondary actions of a plan in one dropdown (Escape or a click outside closes it)
// ---------------------------------------------------------------------------

export interface MenuAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export function ActionsMenu({ actions, label = 'إجراءات أخرى' }: { actions: ReadonlyArray<MenuAction>; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!actions.length) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)} className={buttonClass.secondary}>
        <MoreHorizontal size={16} aria-hidden="true" /> {label} <ChevronDown size={14} className={`transition ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="absolute left-0 z-30 mt-2 w-60 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-right text-[13px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const WF_STATUSES: ReadonlyArray<string> = ['VERIFIED_PRIMARY', 'CORROBORATED_SECONDARY', 'PROVISIONAL', 'CONFLICTING', 'USER_INPUT', 'MISSING', 'DERIVED'];
export const asWfStatus = (s: string): WfStatus => (WF_STATUSES.includes(s) ? (s as WfStatus) : 'DERIVED');

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

function Field({ label, children, hint }: { label: string; children: (id: string) => React.ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-extrabold text-slate-600 mb-1.5">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-[11px] font-bold text-slate-400">{hint}</p>}
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  return message ? <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-[12.5px] font-bold text-rose-800">{message}</p> : null;
}

const s = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v));

// ---------------------------------------------------------------------------
// Position dialog
// ---------------------------------------------------------------------------

interface PositionForm {
  kind: PositionKind;
  title: string;
  companyId: string;
  branchId: string;
  departmentId: string;
  nationalityClass: string;
  gosiRegime: string;
  gender: string;
  occupationName: string;
  basicSalary: string;
  housingAllowance: string;
  otherAllowances: string;
  dependentsCount: string;
  medicalClass: string;
  startMonth: string;
  exitEmployeeId: string;
  exitMonth: string;
  exitReason: string;
  notes: string;
}

function toForm(kind: PositionKind, p: Partial<PositionRow> | null, fromMonth: string): PositionForm {
  return {
    kind,
    title: p?.title ?? '',
    companyId: s(p?.companyId),
    branchId: s(p?.branchId),
    departmentId: s(p?.departmentId),
    nationalityClass: s(p?.nationalityClass) || (kind === 'EXIT' ? '' : 'SAUDI'),
    gosiRegime: s(p?.gosiRegime),
    gender: s(p?.gender) || 'MALE',
    occupationName: s(p?.occupationName),
    basicSalary: s(p?.basicSalary),
    housingAllowance: s(p?.housingAllowance),
    otherAllowances: s(p?.otherAllowances),
    dependentsCount: s(p?.dependentsCount),
    medicalClass: s(p?.medicalClass),
    startMonth: s(p?.startMonth) || (kind === 'NEW_HIRE' ? fromMonth : ''),
    exitEmployeeId: s(p?.exitEmployeeId),
    exitMonth: s(p?.exitMonth) || (kind === 'EXIT' ? fromMonth : ''),
    exitReason: s(p?.exitReason) || (kind === 'EXIT' ? 'RESIGNATION' : ''),
    notes: s(p?.notes),
  };
}

function positionPayload(f: PositionForm) {
  const hire = f.kind !== 'EXIT';
  return {
    kind: f.kind,
    title: f.title,
    companyId: f.companyId || null,
    branchId: f.branchId || null,
    departmentId: f.departmentId || null,
    nationalityClass: hire ? f.nationalityClass || null : null,
    gosiRegime: hire && f.nationalityClass === 'SAUDI' ? f.gosiRegime || null : null,
    gender: hire ? f.gender || null : null,
    occupationName: f.occupationName || null,
    basicSalary: hire ? f.basicSalary : null,
    housingAllowance: hire ? f.housingAllowance : null,
    otherAllowances: hire ? f.otherAllowances : null,
    dependentsCount: hire && f.nationalityClass === 'EXPAT' ? f.dependentsCount : null,
    medicalClass: hire ? f.medicalClass || null : null,
    startMonth: hire ? f.startMonth || null : null,
    exitEmployeeId: f.kind === 'NEW_HIRE' ? null : f.exitEmployeeId || null,
    exitMonth: f.kind === 'EXIT' ? f.exitMonth || null : null,
    exitReason: f.kind === 'EXIT' ? f.exitReason || null : null,
    notes: f.notes || null,
  };
}

export function PositionDialog({
  planId,
  open,
  kind,
  editing,
  prefill,
  plan,
  lookups,
  names,
  onClose,
  onSaved,
}: {
  planId: string;
  open: boolean;
  kind: PositionKind;
  editing: PositionRow | null;
  prefill?: Partial<PositionRow> | null;
  plan: Pick<PlanHeader, 'companyId' | 'fromMonth' | 'months'>;
  lookups: Lookups;
  names: PlanDetailResponse['names'];
  onClose: () => void;
  onSaved: (created: { id: string; kind: PositionKind; exitEmployeeId: string | null; addBackfill: boolean }) => void;
}) {
  const [f, setF] = useState<PositionForm>(() => toForm(kind, editing ?? prefill ?? null, plan.fromMonth));
  const [addBackfill, setAddBackfill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const up = <K extends keyof PositionForm>(k: K, v: PositionForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const hire = f.kind !== 'EXIT';
  const employees = lookups.employees.filter((e) => !plan.companyId || e.companyId === plan.companyId);
  const empOptions = employees.map((e) => ({ value: e.id, label: e.employeeNo ? `${e.name} (${e.employeeNo})` : e.name }));
  if (f.exitEmployeeId && !empOptions.some((o) => o.value === f.exitEmployeeId)) empOptions.unshift({ value: f.exitEmployeeId, label: names.employees[f.exitEmployeeId] ?? f.exitEmployeeId });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const url = editing ? `/api/workforce/plans/${encodeURIComponent(planId)}/positions/${encodeURIComponent(editing.id)}` : `/api/workforce/plans/${encodeURIComponent(planId)}/positions`;
    const r = await callApi<{ id: string }>(url, { method: editing ? 'PATCH' : 'POST', json: positionPayload(f) });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onSaved({ id: r.data.id, kind: f.kind, exitEmployeeId: f.exitEmployeeId || null, addBackfill: f.kind === 'EXIT' && !editing && addBackfill });
  };
  const monthField = (k: 'startMonth' | 'exitMonth', label: string, hint?: string) => (
    <Field label={label} hint={hint}>{(id) => <input id={id} type="month" className={inputClass} value={f[k]} onChange={(e) => up(k, e.target.value)} />}</Field>
  );
  const money = (k: 'basicSalary' | 'housingAllowance' | 'otherAllowances', label: string, hint?: string) => (
    <Field label={label} hint={hint}>{(id) => <input id={id} inputMode="decimal" className={inputClass} value={f[k]} onChange={(e) => up(k, e.target.value)} />}</Field>
  );
  return (
    <Modal open={open} onClose={onClose} busy={busy} tone="indigo" size="lg" title={`${editing ? 'تعديل' : 'إضافة'}: ${POSITION_KIND_LABELS[f.kind]}`} description="بيانات افتراضية في الخطة فقط: لا يُنشأ موظف ولا يتغير راتب.">
      <form onSubmit={submit} className="space-y-3 p-5">
        <Field label="المسمى">{(id) => <input id={id} className={inputClass} value={f.title} maxLength={120} onChange={(e) => up('title', e.target.value)} required />}</Field>
        {f.kind !== 'NEW_HIRE' && (
          <SelectField label={f.kind === 'EXIT' ? 'الموظف المغادر' : 'الموظف الذي يُستبدل'} value={f.exitEmployeeId} onChange={(v) => up('exitEmployeeId', v)} placeholder="اختر الموظف" options={empOptions} />
        )}
        {f.kind === 'EXIT' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {monthField('exitMonth', 'شهر الخروج', 'آخر يوم عمل = آخر يوم في الشهر')}
            <SelectField label="سبب الخروج" value={f.exitReason} onChange={(v) => up('exitReason', v)} options={PLAN_EXIT_REASONS.map((r) => ({ value: r, label: PLAN_EXIT_REASON_LABELS[r] }))} />
          </div>
        )}
        {hire && (
          <>
            <Segmented label="الجنسية" value={f.nationalityClass || 'SAUDI'} options={PLAN_NATIONALITY_CLASSES.map((c) => ({ value: c, label: PLAN_NATIONALITY_LABELS[c] }))} onChange={(v) => up('nationalityClass', v)} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {money('basicSalary', 'الراتب الأساسي')}
              {money('housingAllowance', 'بدل السكن', 'يدخل في التأمينات')}
              {money('otherAllowances', 'بدلات أخرى')}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {monthField('startMonth', 'شهر البداية', f.kind === 'BACKFILL' ? 'يبدأ البديل في الأحدث بين هذا الشهر وشهر خروج الموظف' : undefined)}
              <SelectField label="الجنس" value={f.gender} onChange={(v) => up('gender', v)} options={[{ value: 'MALE', label: 'ذكر' }, { value: 'FEMALE', label: 'أنثى' }]} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {f.nationalityClass === 'SAUDI' && (
                <SelectField label="نظام التأمينات" value={f.gosiRegime} onChange={(v) => up('gosiRegime', v)} placeholder="الجديد (للمعيّن الجديد)" options={[{ value: 'NEW', label: 'الجديد' }, { value: 'OLD', label: 'القديم (له مدد سابقة)' }]} />
              )}
              {f.nationalityClass === 'EXPAT' && (
                <Field label="عدد المرافقين">{(id) => <input id={id} inputMode="numeric" className={inputClass} value={f.dependentsCount} onChange={(e) => up('dependentsCount', e.target.value.replace(/[^\d]/g, ''))} />}</Field>
              )}
              <SelectField label="فئة التأمين الطبي" value={f.medicalClass} onChange={(v) => up('medicalClass', v)} placeholder="غير محددة" options={MEDICAL_INSURANCE_CLASSES.map((m) => ({ value: m, label: m }))} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {!plan.companyId && <SelectField label="الشركة القانونية" value={f.companyId} onChange={(v) => up('companyId', v)} placeholder={f.kind === 'BACKFILL' ? 'شركة الموظف المغادر' : 'اختر الشركة'} options={lookups.companies.map((c) => ({ value: c.id, label: c.name }))} />}
              <SelectField label="الفرع" value={f.branchId} onChange={(v) => up('branchId', v)} placeholder="—" options={lookups.branches.map((b) => ({ value: b.id, label: b.name }))} />
              <SelectField label="الإدارة" value={f.departmentId} onChange={(v) => up('departmentId', v)} placeholder="—" options={lookups.departments.map((d) => ({ value: d.id, label: d.name }))} />
            </div>
            <Field label="المهنة" hint="لقرارات التوطين">{(id) => <input id={id} className={inputClass} value={f.occupationName} maxLength={120} onChange={(e) => up('occupationName', e.target.value)} />}</Field>
          </>
        )}
        <Field label="ملاحظات">{(id) => <textarea id={id} rows={2} className={inputClass} value={f.notes} maxLength={2000} onChange={(e) => up('notes', e.target.value)} />}</Field>
        {f.kind === 'EXIT' && !editing && (
          <label className="inline-flex items-center gap-2 text-[12.5px] font-bold text-slate-700">
            <input type="checkbox" checked={addBackfill} onChange={(e) => setAddBackfill(e.target.checked)} /> أضف بديلاً لهذا الموظف بعد الحفظ
          </label>
        )}
        <FormError message={error} />
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button type="button" onClick={onClose} className={buttonClass.secondary}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Raise dialog
// ---------------------------------------------------------------------------

export function RaiseDialog({
  planId,
  open,
  editing,
  plan,
  lookups,
  names,
  onClose,
  onSaved,
}: {
  planId: string;
  open: boolean;
  editing: RaiseRow | null;
  plan: Pick<PlanHeader, 'companyId' | 'fromMonth'>;
  lookups: Lookups;
  names: PlanDetailResponse['names'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const init = () => ({
    scope: (editing?.scope ?? 'ALL') as RaiseScope,
    scopeId: editing?.scopeId ?? '',
    mode: (editing && editing.amount !== null ? 'amount' : 'pct') as 'pct' | 'amount',
    value: editing ? s(editing.pct ?? editing.amount) : '',
    effectiveMonth: editing?.effectiveMonth ?? plan.fromMonth,
    notes: editing?.notes ?? '',
  });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeOptions =
    f.scope === 'COMPANY'
      ? lookups.companies.filter((c) => !plan.companyId || c.id === plan.companyId).map((c) => ({ value: c.id, label: c.name }))
      : f.scope === 'DEPARTMENT'
        ? lookups.departments.map((d) => ({ value: d.id, label: d.name }))
        : lookups.employees.filter((e) => !plan.companyId || e.companyId === plan.companyId).map((e) => ({ value: e.id, label: e.employeeNo ? `${e.name} (${e.employeeNo})` : e.name }));
  if (f.scope === 'EMPLOYEE' && f.scopeId && !scopeOptions.some((o) => o.value === f.scopeId)) scopeOptions.unshift({ value: f.scopeId, label: names.employees[f.scopeId] ?? f.scopeId });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { scope: f.scope, scopeId: f.scope === 'ALL' ? null : f.scopeId || null, pct: f.mode === 'pct' ? f.value : null, amount: f.mode === 'amount' ? f.value : null, effectiveMonth: f.effectiveMonth, notes: f.notes || null };
    const url = editing ? `/api/workforce/plans/${encodeURIComponent(planId)}/raises/${encodeURIComponent(editing.id)}` : `/api/workforce/plans/${encodeURIComponent(planId)}/raises`;
    const r = await callApi<{ id: string }>(url, { method: editing ? 'PATCH' : 'POST', json: body });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onSaved();
  };
  return (
    <Modal open={open} onClose={onClose} busy={busy} tone="indigo" size="md" title={editing ? 'تعديل زيادة مخططة' : 'زيادة مخططة'} description="في الخطة فقط: لا يُنشأ تغيير راتب في ملف الموظف.">
      <form onSubmit={submit} className="space-y-3 p-5">
        <SelectField label="النطاق" value={f.scope} onChange={(v) => setF({ ...f, scope: v as RaiseScope, scopeId: '' })} options={RAISE_SCOPES.map((x) => ({ value: x, label: RAISE_SCOPE_LABELS[x] }))} />
        {f.scope !== 'ALL' && <SelectField label={RAISE_SCOPE_LABELS[f.scope]} value={f.scopeId} onChange={(v) => setF({ ...f, scopeId: v })} placeholder="اختر" options={scopeOptions} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Segmented label="النوع" value={f.mode} options={[{ value: 'pct', label: 'نسبة من الأساسي' }, { value: 'amount', label: 'مبلغ شهري' }]} onChange={(v) => setF({ ...f, mode: v })} />
          <Field label={f.mode === 'pct' ? 'النسبة %' : 'المبلغ (ريال شهرياً)'}>{(id) => <input id={id} inputMode="decimal" className={inputClass} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required />}</Field>
        </div>
        <Field label="من شهر" hint="تنطبق على من باشر قبل هذا الشهر">{(id) => <input id={id} type="month" className={inputClass} value={f.effectiveMonth} onChange={(e) => setF({ ...f, effectiveMonth: e.target.value })} required />}</Field>
        <Field label="ملاحظات">{(id) => <textarea id={id} rows={2} className={inputClass} value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        <FormError message={error} />
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button type="button" onClick={onClose} className={buttonClass.secondary}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Header dialog
// ---------------------------------------------------------------------------

export function HeaderDialog({ open, plan, hasItems, companies, onClose, onSaved }: { open: boolean; plan: PlanHeader; hasItems: boolean; companies: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void }) {
  const init = () => ({ name: plan.name, companyId: plan.companyId ?? '', fromMonth: plan.fromMonth, months: plan.months, attrition: s(plan.attritionPct), notes: plan.notes ?? '' });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { name: f.name, fromMonth: f.fromMonth, months: f.months, attritionPct: f.attrition === '' ? null : f.attrition, notes: f.notes || null };
    if (!hasItems) body.companyId = f.companyId || null;
    const r = await callApi(`/api/workforce/plans/${encodeURIComponent(plan.id)}`, { method: 'PATCH', json: body });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onSaved();
  };
  return (
    <Modal open={open} onClose={onClose} busy={busy} tone="indigo" size="md" title="بيانات الخطة">
      <form onSubmit={submit} className="space-y-3 p-5">
        <Field label="اسم الخطة">{(id) => <input id={id} className={inputClass} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
        <SelectField label="الشركة القانونية (نطاق الخطة)" value={f.companyId} onChange={(v) => setF({ ...f, companyId: v })} placeholder="كل الشركات" disabled={hasItems} options={companies.map((c) => ({ value: c.id, label: c.name }))} />
        {hasItems && <p className="text-[11px] font-bold text-slate-400">لا يتغير النطاق بعد إضافة البنود: انسخ الخطة لنطاق آخر.</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Field label="أول شهر">{(id) => <input id={id} type="month" className={inputClass} value={f.fromMonth} onChange={(e) => setF({ ...f, fromMonth: e.target.value })} required />}</Field>
          <Segmented label="المدة" value={f.months} options={PLAN_MONTHS.map((m) => ({ value: m, label: `${m} شهراً` }))} onChange={(v) => setF({ ...f, months: v })} />
        </div>
        <Field label="الدوران السنوي المفترض %" hint="فارغ = الدوران الفعلي للمنشأة آخر 12 شهراً؛ 0 = بلا دوران">
          {(id) => <input id={id} inputMode="decimal" className={inputClass} value={f.attrition} onChange={(e) => setF({ ...f, attrition: e.target.value })} />}
        </Field>
        <Field label="ملاحظات">{(id) => <textarea id={id} rows={2} className={inputClass} value={f.notes} maxLength={5000} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        <FormError message={error} />
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button type="button" onClick={onClose} className={buttonClass.secondary}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// «لماذا؟» of a planned item
// ---------------------------------------------------------------------------

export function ItemWhyDialog({ item, onClose }: { item: PlanItemResult | null; onClose: () => void }) {
  return (
    <Modal open={!!item} onClose={onClose} tone="indigo" size="xl" title={item ? `لماذا هذا الرقم؟ ${item.title}` : ''}>
      {item && (
        <div className="space-y-4 p-5 sm:p-6">
          <ul className="list-disc space-y-1.5 pr-5 text-[13px] font-bold text-slate-700 leading-relaxed">
            {item.why.map((w) => <li key={w}>{w}</li>)}
          </ul>
          {(['12', '24', '36', 'horizon'] as const).some((k) => item.windows[k]) && (
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px] font-bold">
              {(['12', '24', '36', 'horizon'] as const).filter((k) => item.windows[k]).map((k) => (
                <div key={k} className="rounded-xl bg-slate-50 p-2">
                  <dt className="text-slate-500">{k === 'horizon' ? 'مدة الخطة' : `${k} شهراً`}</dt>
                  <dd className="text-slate-900"><Money value={item.windows[k]!.net} /></dd>
                  <dd className="text-[11px] text-slate-500">قبل الدعم <Money value={item.windows[k]!.cost} /></dd>
                </div>
              ))}
            </dl>
          )}
          {item.lines.length > 0 && (
            <div>
              <h3 className="text-[12px] font-black text-slate-500 mb-1">{item.kind === 'EXIT' ? 'أثر الخروج على بنود الكلفة (مقارنة ببقائه)' : 'بنود الكلفة طوال الخطة'}</h3>
              <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
                {item.lines.map((l) => (
                  <li key={l.key} className="flex items-center justify-between gap-2 px-3 py-1.5 text-[12.5px] font-bold">
                    <span className="text-slate-700">{l.label}{l.kind === 'MEMO' ? ' (للعلم)' : ''}</span>
                    <Money value={l.amount} className={l.amount < 0 ? 'text-green-700' : 'text-slate-900'} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {item.exitCost && (
            <div>
              <h3 className="text-[12px] font-black text-slate-500 mb-1">{`تكاليف الخروج (${item.exitCost.reasonLabel}، ${item.exitCost.yearsOfService} سنة خدمة، الأجر ${item.exitCost.wageUsed})`}</h3>
              <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
                {item.exitCost.lines.map((l) => (
                  <li key={l.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[12px] font-bold">
                    <span className="min-w-0 text-slate-700">
                      {l.label}
                      <span dir="auto" className="block text-[11px] text-slate-400">{l.basis}</span>
                    </span>
                    <span className="flex items-center gap-2"><StatusBadge status={asWfStatus(l.status)} /><Money value={l.amount} /></span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] font-bold text-slate-600">
                لمرة واحدة في شهر الخروج: <Money value={item.exitCost.payable} /> — استرداد المخصص: <Money value={item.exitCost.accrualRelease} />
              </p>
            </div>
          )}
          {item.flags.length > 0 && (
            <ul className="space-y-1.5">
              {item.flags.map((f, i) => <li key={`${f.code}-${i}`} className={`rounded-xl border px-3 py-2 text-[12px] font-bold ${SEVERITY_CLASS[f.severity]}`}>{f.message}</li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
