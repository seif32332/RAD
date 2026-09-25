"use client";

// DEC-003: HR / payroll confirm the GOSI regime (OLD / NEW) of Saudi employees from a source
// document. The regime is never derived from the hire date; unconfirmed employees stay UNKNOWN.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ShieldCheck, RefreshCw, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { GOSI_REGIME_LABELS, GOSI_SOURCE_SUGGESTIONS } from '@/lib/employee-shared';

type Scope = 'unknown' | 'auto';
type Regime = 'OLD' | 'NEW';

interface ReviewRow {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic?: string | null;
  joinDate?: string | null;
  gosiRegime: string;
  gosiRegistrationSource?: string | null;
  gosiNumber?: string | null;
  legalCompany?: { id: string; nameArabic: string } | null;
  branch?: { id: string; nameArabic: string } | null;
}

interface Draft {
  regime: Regime | '';
  source: string;
}

const SCOPE_LABELS: Record<Scope, string> = {
  unknown: 'غير مؤكد (UNKNOWN)',
  auto: 'مُرحَّل آلياً من تاريخ التعيين',
};

export default function GosiReviewPage() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('unknown');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Draft>({ regime: '', source: '' });
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/employees/gosi-review?scope=${scope}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل قائمة المراجعة'));
        return;
      }
      const data = (await res.json()) as { employees?: ReviewRow[] };
      setRows(Array.isArray(data.employees) ? data.employees : []);
      setSelected(new Set());
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [scope, router]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim();
    if (!q) return rows;
    return rows.filter((r) => `${r.firstNameArabic} ${r.lastNameArabic ?? ''}`.includes(q) || r.employeeId.includes(q));
  }, [rows, search]);

  const draftOf = (id: string): Draft => drafts[id] ?? { regime: '', source: '' };
  const setDraft = (id: string, patch: Partial<Draft>) => setDrafts((prev) => ({ ...prev, [id]: { ...draftOf(id), ...patch } }));

  const submit = async (items: Array<{ employeeId: string; regime: Regime; source: string }>) => {
    const ids = items.map((i) => i.employeeId);
    setSavingIds((prev) => new Set([...prev, ...ids]));
    try {
      const res = await fetch('/api/employees/gosi-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (res.status === 401) {
        router.replace('/login');
        return false;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حفظ التأكيد'));
        return false;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      toast.success(data?.message || 'تم الحفظ');
      // Confirmed rows leave this list (they are no longer UNKNOWN / auto-migrated).
      setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      return true;
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return false;
    } finally {
      setSavingIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    }
  };

  const confirmOne = (row: ReviewRow) => {
    const d = draftOf(row.id);
    if (!d.regime) return toast.warning('اختر النظام: قديم أو جديد');
    if (!d.source.trim()) return toast.warning('اذكر مصدر التأكيد (مثلاً: شهادة اشتراك التأمينات)');
    void submit([{ employeeId: row.id, regime: d.regime, source: d.source.trim() }]);
  };

  const confirmBulk = async () => {
    if (selected.size === 0) return toast.warning('حدد موظفاً واحداً على الأقل');
    if (!bulk.regime) return toast.warning('اختر النظام للموظفين المحددين');
    if (!bulk.source.trim()) return toast.warning('اذكر مصدر التأكيد للموظفين المحددين');
    const ok = await confirmDialog(
      `سيتم تعيين «${GOSI_REGIME_LABELS[bulk.regime]}» لـ ${selected.size} موظف بمصدر: «${bulk.source.trim()}». هل أنت متأكد؟`,
      { title: 'تأكيد جماعي لنظام التأمينات' },
    );
    if (!ok) return;
    const regime = bulk.regime;
    const done = await submit([...selected].map((employeeId) => ({ employeeId, regime, source: bulk.source.trim() })));
    if (done) setBulk({ regime: '', source: '' });
  };

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected((prev) => {
      if (allVisibleSelected) return new Set([...prev].filter((id) => !visible.some((r) => r.id === id)));
      return new Set([...prev, ...visible.map((r) => r.id)]);
    });
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <DashboardLayout>
      <div className="p-4 md:p-8 max-w-[1200px] mx-auto space-y-6 pb-32">
        <Link href="/employees" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition font-bold text-[14px]">
          <ArrowRight size={18} /> العودة لقائمة الموظفين
        </Link>

        <div>
          <h1 className="text-2xl md:text-3xl font-black text-slate-800 flex items-center gap-3">
            <span className="bg-blue-100 text-blue-600 p-2.5 rounded-2xl"><ShieldCheck size={26} /></span>
            مراجعة نظام التأمينات الاجتماعية
          </h1>
          <p className="text-slate-500 font-bold text-[14px] mt-3 leading-relaxed max-w-3xl">
            الموظفون السعوديون الذين لم يُؤكَّد نظام اشتراكهم في التأمينات. يُحدَّد النظام من مستند (شهادة اشتراك أو قائمة مشتركي المنشأة في GOSI) وليس من تاريخ المباشرة:
            الموظف الذي كانت له مدة اشتراك قبل 2024-07-03 يبقى على النظام السابق حتى لو التحق بالمنشأة بعد ذلك.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {(Object.keys(SCOPE_LABELS) as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              aria-pressed={scope === s}
              className={`px-4 py-2 rounded-xl text-[13px] font-black transition ${scope === s ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
          <input
            type="search"
            aria-label="بحث بالاسم أو الرقم الوظيفي"
            placeholder="بحث بالاسم أو الرقم الوظيفي"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] px-4 py-2 rounded-xl bg-white border border-slate-200 text-[13px] font-bold focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
          <button type="button" onClick={load} className="px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-2 text-[13px] font-bold">
            <RefreshCw size={15} /> تحديث
          </button>
        </div>

        {scope === 'auto' && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-[13px] font-bold text-amber-800 flex items-start gap-2">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            هؤلاء عُيِّن لهم «النظام السابق» آلياً عند الترحيل بناءً على تاريخ التعيين فقط. يُنصح بتأكيد كل منهم من مستند رسمي.
          </div>
        )}

        {/* Bulk confirmation */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col md:flex-row md:items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bulk-regime" className="text-[12px] font-extrabold text-slate-600">النظام للمحددين ({selected.size})</label>
            <select
              id="bulk-regime"
              value={bulk.regime}
              onChange={(e) => setBulk((b) => ({ ...b, regime: e.target.value as Regime | '' }))}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-[13px] font-bold"
            >
              <option value="">— اختر —</option>
              <option value="OLD">{GOSI_REGIME_LABELS.OLD}</option>
              <option value="NEW">{GOSI_REGIME_LABELS.NEW}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <label htmlFor="bulk-source" className="text-[12px] font-extrabold text-slate-600">مصدر التأكيد</label>
            <input
              id="bulk-source"
              list="gosi-review-sources"
              value={bulk.source}
              onChange={(e) => setBulk((b) => ({ ...b, source: e.target.value }))}
              placeholder="مثال: قائمة مشتركي المنشأة في GOSI بتاريخ ..."
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-[13px] font-bold"
            />
          </div>
          <button
            type="button"
            onClick={confirmBulk}
            disabled={selected.size === 0 || savingIds.size > 0}
            className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-[13px] disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <CheckCircle2 size={16} /> تأكيد المحددين
          </button>
        </div>
        <datalist id="gosi-review-sources">
          {GOSI_SOURCE_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
        </datalist>

        {isLoading ? (
          <div className="bg-white rounded-2xl border border-slate-100 p-16 flex items-center justify-center gap-3 text-slate-500 font-bold">
            <Loader2 className="animate-spin" size={20} /> جاري التحميل...
          </div>
        ) : loadError ? (
          <div role="alert" className="bg-white rounded-2xl border border-rose-100 p-10 text-center">
            <AlertTriangle size={32} className="text-rose-500 mx-auto mb-3" />
            <p className="text-slate-700 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={load} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[13px]">إعادة المحاولة</button>
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center">
            <CheckCircle2 size={36} className="text-emerald-500 mx-auto mb-3" />
            <p className="text-slate-700 font-black">{rows.length === 0 ? 'لا يوجد موظفون بحاجة إلى مراجعة في هذه القائمة' : 'لا توجد نتائج مطابقة للبحث'}</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-[13px] min-w-[860px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-3 w-10">
                    <input type="checkbox" aria-label="تحديد الكل" checked={allVisibleSelected} onChange={toggleAll} className="w-4 h-4 accent-blue-600" />
                  </th>
                  <th className="p-3 text-right font-black">الموظف</th>
                  <th className="p-3 text-right font-black">الشركة / الفرع</th>
                  <th className="p-3 text-right font-black">تاريخ المباشرة</th>
                  <th className="p-3 text-right font-black">الحالي</th>
                  <th className="p-3 text-right font-black">النظام</th>
                  <th className="p-3 text-right font-black">مصدر التأكيد</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((row) => {
                  const d = draftOf(row.id);
                  const saving = savingIds.has(row.id);
                  return (
                    <tr key={row.id} className="hover:bg-blue-50/30">
                      <td className="p-3 text-center">
                        <input type="checkbox" aria-label={`تحديد ${row.firstNameArabic}`} checked={selected.has(row.id)} onChange={() => toggleOne(row.id)} className="w-4 h-4 accent-blue-600" />
                      </td>
                      <td className="p-3">
                        <Link href={`/employees/${row.id}`} className="font-extrabold text-slate-800 hover:text-blue-600 hover:underline">
                          {row.firstNameArabic} {row.lastNameArabic}
                        </Link>
                        <div className="text-[11px] font-bold text-slate-400 tabular-nums">{row.employeeId}</div>
                      </td>
                      <td className="p-3 font-bold text-slate-600">
                        {row.legalCompany?.nameArabic || '—'}
                        <div className="text-[11px] text-slate-400">{row.branch?.nameArabic || ''}</div>
                      </td>
                      <td className="p-3 font-bold text-slate-600 tabular-nums">{row.joinDate ? formatDateShort(row.joinDate) : '—'}</td>
                      <td className="p-3 text-[12px] font-bold text-slate-500">
                        {row.gosiRegime === 'OLD' ? 'قديم (آلي)' : 'غير مؤكد'}
                        {row.gosiRegistrationSource && <div className="text-[11px] text-slate-400">{row.gosiRegistrationSource}</div>}
                      </td>
                      <td className="p-3">
                        <select
                          aria-label={`نظام التأمينات لـ ${row.firstNameArabic}`}
                          value={d.regime}
                          onChange={(e) => setDraft(row.id, { regime: e.target.value as Regime | '' })}
                          className="px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-[12px] font-bold"
                        >
                          <option value="">— اختر —</option>
                          <option value="OLD">قديم</option>
                          <option value="NEW">جديد</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <input
                          aria-label={`مصدر التأكيد لـ ${row.firstNameArabic}`}
                          list="gosi-review-sources"
                          value={d.source}
                          onChange={(e) => setDraft(row.id, { source: e.target.value })}
                          placeholder="شهادة اشتراك..."
                          className="w-full min-w-[180px] px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-[12px] font-bold"
                        />
                      </td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() => confirmOne(row)}
                          disabled={saving}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-black disabled:opacity-50 whitespace-nowrap"
                        >
                          {saving ? 'جاري الحفظ...' : 'تأكيد'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
