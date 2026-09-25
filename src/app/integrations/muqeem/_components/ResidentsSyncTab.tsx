"use client";

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Loader2, AlertTriangle, Info, CheckCheck, UserX, UserSearch, Users } from 'lucide-react';
import { toast, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort, formatDateTime } from '@/lib/dates';
import type { OnlyInMuqeemHint, ResidentDiff, SyncField } from '@/lib/muqeem-sync';
import { callApi, type MuqeemStatusCompany } from './shared';

interface SyncResponse {
  company: { id: string; name: string; moiNumber: string | null };
  fetchedAt: string;
  truncated: boolean;
  cap: number;
  total: number | null;
  pages: number;
  diff: ResidentDiff;
}

interface ApplyResponse {
  applied: { employeeId: string; employeeName: string; changes: { field: SyncField; label: string; before: string | null; after: string }[] }[];
  skipped: { employeeId: string; employeeName: string; reason: string; message: string }[];
  counts: { requested: number; applied: number; skipped: number };
}

const HINT_LABELS: Record<OnlyInMuqeemHint, string> = {
  TERMINATED_IN_RADEEF: 'منتهية خدمته في رديف لكنه ما زال مقيماً نشطاً على المنشأة في مقيم (هل تمّ الخروج النهائي أو نقل الخدمات؟)',
  OTHER_COMPANY: 'مسجل في رديف على كفالة شركة أخرى',
  SAUDI_IN_RADEEF: 'مسجل في رديف بجنسية سعودية: راجع جنسية الموظف',
};

const fmt = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDateShort(v) : v || '—');

function Stat({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-black text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-black ${tone}`}>{value}</p>
    </div>
  );
}

export default function ResidentsSyncTab({ companies, usable, canApply }: { companies: MuqeemStatusCompany[]; usable: boolean; canApply: boolean }) {
  const linked = companies.filter((c) => c.linked);
  const [companyId, setCompanyId] = useState(linked[0]?.id ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SyncResponse | null>(null);
  const [selected, setSelected] = useState<Record<string, SyncField[]>>({});
  const [applying, setApplying] = useState(false);
  const [lastApply, setLastApply] = useState<ApplyResponse | null>(null);

  const run = async (keepApplyResult = false) => {
    if (!companyId || loading) return;
    setLoading(true);
    setError(null);
    if (!keepApplyResult) setLastApply(null);
    const res = await callApi<SyncResponse>('/api/integrations/muqeem/residents/sync', { json: { companyId } });
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      setData(null);
      return;
    }
    setData(res.data);
    setSelected({});
  };

  const applicable = useMemo(() => (data ? data.diff.mismatched.filter((m) => m.diffs.length > 0) : []), [data]);
  const selectedCount = Object.values(selected).reduce((n, f) => n + f.length, 0);
  const selectedEmployees = Object.values(selected).filter((f) => f.length > 0).length;

  const toggle = (employeeId: string, field: SyncField) => {
    setSelected((prev) => {
      const cur = prev[employeeId] ?? [];
      const next = cur.includes(field) ? cur.filter((f) => f !== field) : [...cur, field];
      return { ...prev, [employeeId]: next };
    });
  };
  const selectAll = () => setSelected(Object.fromEntries(applicable.map((m) => [m.employeeId, m.diffs.map((d) => d.field)])));
  const clearAll = () => setSelected({});

  const apply = async () => {
    if (!data || applying || selectedCount === 0) return;
    const ok = await confirmDialog(
      `سيتم تحديث ${selectedCount} حقل لدى ${selectedEmployees} موظف في نظام رديف فقط، بالقيم المسجلة حالياً في مقيم.\n` +
        'يُعاد قراءة تقرير المقيمين من مقيم قبل التطبيق، ولا يُرسل أي طلب تعديل إلى مقيم ولا تترتب أي رسوم.\n' +
        'يُسجَّل كل تعديل في سجل التدقيق مع القيمة السابقة والجديدة.',
      { title: 'تطبيق بيانات مقيم على الموظفين', confirmText: 'تطبيق التحديثات' },
    );
    if (!ok) return;
    setApplying(true);
    const updates = Object.entries(selected)
      .filter(([, f]) => f.length > 0)
      .map(([employeeId, fields]) => ({ employeeId, fields }));
    const res = await callApi<ApplyResponse>('/api/integrations/muqeem/residents/apply', { json: { companyId: data.company.id, updates } });
    setApplying(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setLastApply(res.data);
    if (res.data.counts.applied > 0) toast.success(`تم تحديث ${res.data.counts.applied} موظف`);
    if (res.data.counts.skipped > 0) toast.warning(`لم يُعدَّل ${res.data.counts.skipped} موظف (انظر التفاصيل)`);
    await run(true);
  };

  if (!linked.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[14px] font-bold text-slate-600">
        لا توجد شركة مربوطة بمقيم بعد. اربط الشركة من صفحة تعديل الشركة (تبويب «الإعدادات» يشرح الخطوات).
      </div>
    );
  }

  const d = data?.diff;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row md:items-end gap-4">
          <label className="flex-1 space-y-1">
            <span className="text-[12px] font-black text-slate-500">الشركة (الكفيل)</span>
            <select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setData(null);
                setError(null);
                setLastApply(null);
              }}
              className="w-full h-11 rounded-xl border border-slate-200 bg-white px-3 text-[14px] font-bold"
            >
              {linked.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.moiNumber}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => run()}
            disabled={loading || !usable || !companyId}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 text-[14px] font-black text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {data ? 'إعادة المطابقة' : 'بدء المطابقة'}
          </button>
        </div>
        <p className="flex items-start gap-2 text-[12px] font-bold leading-6 text-slate-500">
          <Info size={15} className="mt-1 shrink-0 text-blue-500" />
          المطابقة تقرأ تقرير «المقيمين النشطين» للمنشأة من مقيم وتقارنه بموظفي هذه الشركة في رديف حسب رقم الإقامة. هي قراءة فقط: لا تغيّر شيئاً في مقيم ولا في رديف.
          السعوديون ليسوا مقيمين ولا تشملهم المطابقة.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-[13px] font-bold text-rose-800">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {lastApply && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-[13px] font-bold text-emerald-900 space-y-2">
          <p className="font-black">
            نتيجة آخر تطبيق: تم تحديث {lastApply.counts.applied} موظف، ولم يُعدَّل {lastApply.counts.skipped}.
          </p>
          {lastApply.applied.map((a) => (
            <p key={a.employeeId}>
              {a.employeeName}:{' '}
              {a.changes.map((c, i) => (
                <span key={c.field}>
                  {i > 0 && '، '}
                  {c.label} <bdi className="line-through decoration-1">{fmt(c.before)}</bdi> ← <bdi>{fmt(c.after)}</bdi>
                </span>
              ))}
            </p>
          ))}
          {lastApply.skipped.map((s) => (
            <p key={s.employeeId} className="text-amber-800">
              {s.employeeName}: {s.message}
            </p>
          ))}
        </div>
      )}

      {data && d && (
        <>
          <p className="text-[12px] font-bold text-slate-400">
            {data.company.name} — آخر قراءة من مقيم: {formatDateTime(data.fetchedAt)}
          </p>
          {data.truncated && (
            <div role="alert" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] font-bold text-amber-800">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <span>
                تم التوقف عند {data.cap.toLocaleString('en')} مقيم (الحد الأقصى للقراءة){data.total ? ` من أصل ${data.total.toLocaleString('en')}` : ''}. قد يظهر بعض الموظفين خطأً في قائمة «موجود في رديف فقط».
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <Stat label="مقيمون في مقيم" value={d.counts.residents} tone="text-slate-800" />
            <Stat label="مقيمون في رديف" value={d.counts.radeefResidents} tone="text-slate-800" />
            <Stat label="متطابقون" value={d.counts.matched} tone="text-emerald-600" />
            <Stat label="بينهم اختلافات" value={d.counts.mismatched} tone="text-amber-600" />
            <Stat label="في مقيم فقط" value={d.counts.onlyInMuqeem} tone="text-rose-600" />
            <Stat label="في رديف فقط" value={d.counts.onlyInRadeef} tone="text-rose-600" />
            <Stat label="سعوديون (مستثنون)" value={d.counts.skippedSaudi} tone="text-slate-400" />
          </div>

          {/* (a) mismatched */}
          <section className="rounded-2xl border border-slate-100 bg-white shadow-sm">
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100 p-4">
              <div>
                <h3 className="flex items-center gap-2 text-[15px] font-black text-slate-800">
                  <CheckCheck size={18} className="text-amber-500" /> موجودون في الطرفين مع اختلاف ({d.mismatched.length})
                </h3>
                <p className="mt-1 text-[12px] font-bold text-slate-500">
                  حدد الحقول التي تريد تحديثها في رديف بقيمة مقيم. اختلاف الاسم للعلم فقط ولا يُطبَّق.
                </p>
              </div>
              {canApply && applicable.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={selectAll} className="rounded-xl border border-slate-200 px-3 py-2 text-[12px] font-black text-slate-600 hover:bg-slate-50">
                    تحديد الكل
                  </button>
                  <button type="button" onClick={clearAll} className="rounded-xl border border-slate-200 px-3 py-2 text-[12px] font-black text-slate-600 hover:bg-slate-50">
                    إلغاء التحديد
                  </button>
                  <button
                    type="button"
                    onClick={apply}
                    disabled={applying || selectedCount === 0}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-[13px] font-black text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {applying && <Loader2 size={14} className="animate-spin" />}
                    تطبيق المحدد ({selectedCount})
                  </button>
                </div>
              )}
            </header>
            {d.mismatched.length === 0 ? (
              <p className="p-6 text-center text-[13px] font-bold text-slate-400">لا توجد اختلافات</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-[13px]">
                  <thead className="bg-slate-50 text-[12px] font-black text-slate-500">
                    <tr>
                      <th className="px-4 py-3">الموظف</th>
                      <th className="px-4 py-3">رقم الإقامة</th>
                      <th className="px-4 py-3">الاختلافات (رديف ← مقيم)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {d.mismatched.map((m) => (
                      <tr key={m.employeeId} className="align-top">
                        <td className="px-4 py-3">
                          <Link href={`/employees/${m.employeeId}`} className="font-black text-blue-700 hover:underline">
                            {m.employeeName}
                          </Link>
                          <div className="text-[11px] text-slate-400">{m.employeeCode}</div>
                        </td>
                        <td className="px-4 py-3 font-mono" dir="ltr">{m.iqamaNumber}</td>
                        <td className="px-4 py-3 space-y-2">
                          {m.diffs.map((df) => {
                            const checked = (selected[m.employeeId] ?? []).includes(df.field);
                            return (
                              <label key={df.field} className={`flex items-center gap-2 ${canApply ? 'cursor-pointer' : ''}`}>
                                {canApply && (
                                  <input type="checkbox" checked={checked} onChange={() => toggle(m.employeeId, df.field)} className="h-4 w-4 accent-emerald-600" />
                                )}
                                <span className="text-slate-500">{df.label}:</span>
                                <bdi className="text-rose-600 line-through decoration-1">{fmt(df.radeef)}</bdi>
                                <span className="text-slate-400">←</span>
                                <bdi className="text-emerald-700">{fmt(df.muqeem)}</bdi>
                              </label>
                            );
                          })}
                          {m.nameMismatch && (
                            <p className="flex items-start gap-1.5 text-[12px] text-slate-500">
                              <Info size={14} className="mt-0.5 shrink-0 text-blue-500" />
                              الاسم مختلف (للعلم): في مقيم «{m.residentName || m.residentTranslatedName || '—'}»
                              {m.residentName && m.residentTranslatedName ? ` / ${m.residentTranslatedName}` : ''}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* (b) only in Muqeem */}
          <section className="rounded-2xl border border-slate-100 bg-white shadow-sm">
            <header className="border-b border-slate-100 p-4">
              <h3 className="flex items-center gap-2 text-[15px] font-black text-slate-800">
                <UserSearch size={18} className="text-rose-500" /> في مقيم وغير موجودين في رديف ({d.onlyInMuqeem.length})
              </h3>
              <p className="mt-1 text-[12px] font-bold text-slate-500">مقيمون نشطون على المنشأة لا يقابلهم موظف فعّال لهذه الشركة في رديف: قد يكونون موظفين غير مسجلين.</p>
            </header>
            {d.onlyInMuqeem.length === 0 ? (
              <p className="p-6 text-center text-[13px] font-bold text-slate-400">لا يوجد</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-[13px]">
                  <thead className="bg-slate-50 text-[12px] font-black text-slate-500">
                    <tr>
                      <th className="px-4 py-3">الاسم في مقيم</th>
                      <th className="px-4 py-3">رقم الإقامة</th>
                      <th className="px-4 py-3">الجنسية / المهنة</th>
                      <th className="px-4 py-3">انتهاء الإقامة</th>
                      <th className="px-4 py-3">ملاحظة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {d.onlyInMuqeem.map((r) => (
                      <tr key={r.iqamaNumber} className="align-top">
                        <td className="px-4 py-3">
                          {r.name || '—'}
                          {r.translatedName && <div className="text-[11px] text-slate-400" dir="ltr">{r.translatedName}</div>}
                        </td>
                        <td className="px-4 py-3 font-mono" dir="ltr">{r.iqamaNumber}</td>
                        <td className="px-4 py-3">{[r.nationality, r.occupation].filter(Boolean).join(' / ') || '—'}</td>
                        <td className="px-4 py-3">{fmt(r.iqamaExpiry)}</td>
                        <td className="px-4 py-3 text-[12px]">
                          {r.hint ? (
                            <span className="text-amber-700">
                              {HINT_LABELS[r.hint]}
                              {r.employee && (
                                <>
                                  {' — '}
                                  <Link href={`/employees/${r.employee.id}`} className="text-blue-700 hover:underline">
                                    {r.employee.name}
                                  </Link>
                                </>
                              )}
                            </span>
                          ) : (
                            <span className="text-slate-500">غير مسجل في رديف</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* (c) only in Radeef */}
          <section className="rounded-2xl border border-slate-100 bg-white shadow-sm">
            <header className="border-b border-slate-100 p-4">
              <h3 className="flex items-center gap-2 text-[15px] font-black text-slate-800">
                <UserX size={18} className="text-rose-500" /> في رديف وغير موجودين في مقيم ({d.onlyInRadeef.length})
              </h3>
              <p className="mt-1 text-[12px] font-bold text-slate-500">
                موظفون فعّالون غير سعوديين على كفالة هذه الشركة لا يظهرون كمقيمين نشطين على المنشأة: ربما نُقلت خدماتهم أو غادروا نهائياً، أو رقم الإقامة مسجل خطأً في رديف.
              </p>
            </header>
            {d.onlyInRadeef.length === 0 ? (
              <p className="p-6 text-center text-[13px] font-bold text-slate-400">لا يوجد</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-[13px]">
                  <thead className="bg-slate-50 text-[12px] font-black text-slate-500">
                    <tr>
                      <th className="px-4 py-3">الموظف</th>
                      <th className="px-4 py-3">رقم الإقامة في رديف</th>
                      <th className="px-4 py-3">الجنسية</th>
                      <th className="px-4 py-3">انتهاء الإقامة في رديف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {d.onlyInRadeef.map((e) => (
                      <tr key={e.employeeId}>
                        <td className="px-4 py-3">
                          <Link href={`/employees/${e.employeeId}`} className="font-black text-blue-700 hover:underline">
                            {e.employeeName}
                          </Link>
                          <div className="text-[11px] text-slate-400">{e.employeeCode}</div>
                        </td>
                        <td className="px-4 py-3 font-mono" dir="ltr">{e.iqamaNumber}</td>
                        <td className="px-4 py-3">{e.nationality || '—'}</td>
                        <td className="px-4 py-3">{fmt(e.iqamaExpiry)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="flex items-center gap-2 text-[12px] font-bold text-slate-400">
            <Users size={14} /> {d.counts.matched} موظف متطابق تماماً مع مقيم (لا يُعرضون).
            {d.counts.duplicateResidents > 0 && ` تم تجاهل ${d.counts.duplicateResidents} سطر مكرر في تقرير مقيم.`}
          </p>
        </>
      )}
    </div>
  );
}
