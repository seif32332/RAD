"use client";

import React, { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, PlugZap, Building2 } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import { callApi, type MuqeemStatus } from './shared';

function Flag({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className={`rounded-2xl border p-4 ${ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle2 size={18} className="text-emerald-600" /> : <XCircle size={18} className="text-rose-600" />}
        <span className={`text-[14px] font-black ${ok ? 'text-emerald-800' : 'text-rose-800'}`}>{label}</span>
      </div>
      <p className={`mt-1 text-[12px] font-bold leading-6 ${ok ? 'text-emerald-700' : 'text-rose-700'}`}>{hint}</p>
    </div>
  );
}

interface TestResult {
  ok: boolean;
  kind?: string;
  message?: string;
}

export default function StatusPanel({ status, canTest }: { status: MuqeemStatus; canTest: boolean }) {
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult & { at: string }>>({});
  const [showUnlinked, setShowUnlinked] = useState(false);

  const test = async (companyId: string) => {
    if (testing) return;
    setTesting(companyId);
    const res = await callApi<TestResult>('/api/integrations/muqeem/test-connection', { json: { companyId } });
    setTesting(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setResults((prev) => ({ ...prev, [companyId]: { ...res.data, at: new Date().toLocaleTimeString('ar-SA-u-nu-latn') } }));
    if (res.data.ok) toast.success('تم تسجيل الدخول إلى مقيم بنجاح');
    else toast.error(res.data.message || 'فشل الاتصال بمقيم');
  };

  const linkedCompanies = status.companies.filter((c) => c.linked);
  const unlinkedCompanies = status.companies.filter((c) => !c.linked);
  const linked = linkedCompanies.length;
  // Linked companies first; unlinked ones only on demand (there can be many).
  const rows = showUnlinked || linked === 0 ? [...linkedCompanies, ...unlinkedCompanies] : linkedCompanies;

  return (
    <section aria-labelledby="mq-status-title" className="space-y-5">
      <h2 id="mq-status-title" className="text-lg font-black text-slate-800">حالة الربط</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Flag ok={status.enabled} label={status.enabled ? 'الربط مفعّل' : 'الربط معطّل'} hint={status.enabled ? 'MUQEEM_ENABLED = true على الخادم.' : 'لن يُرسل أي طلب إلى مقيم حتى يفعّله مدير الخادم.'} />
        <Flag
          ok={status.configured}
          label={status.configured ? 'الإعدادات مكتملة' : 'إعدادات ناقصة'}
          hint={status.configured ? 'كل متغيرات البيئة الإلزامية موجودة.' : `المتغيرات الناقصة: ${status.missing.join('، ') || '—'}`}
        />
        <Flag
          ok={linked > 0}
          label={`${linked} من ${status.companies.length} شركة مربوطة`}
          hint="الشركة المستخدمة لكل موظف هي شركته القانونية (الكفيل)."
        />
      </div>

      {!status.usable && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] font-bold text-amber-800">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>الربط غير قابل للاستخدام حالياً: لن تعمل المطابقة ولا اختبار الاتصال حتى يكتمل الإعداد على الخادم (راجع تبويب «الإعدادات»).</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-slate-100 bg-white shadow-sm">
        <table className="w-full text-right text-[13px]">
          <thead className="bg-slate-50 text-[12px] font-black text-slate-500">
            <tr>
              <th className="px-4 py-3">الشركة</th>
              <th className="px-4 py-3">رقم المنشأة (700)</th>
              <th className="px-4 py-3">حساب مقيم</th>
              <th className="px-4 py-3">الحالة</th>
              <th className="px-4 py-3">اختبار الاتصال</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
            {status.companies.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">لا توجد شركات</td>
              </tr>
            )}
            {rows.map((c) => {
              const r = results[c.id];
              return (
                <tr key={c.id}>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2">
                      <Building2 size={15} className="text-slate-400" />
                      {c.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono" dir="ltr">{c.moiNumber || '—'}</td>
                  <td className="px-4 py-3">{c.platformName || '—'}</td>
                  <td className="px-4 py-3">
                    {c.linked ? (
                      <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-black text-emerald-700">مربوطة</span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span className="rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-500">غير مربوطة</span>
                        {status.canLink ? (
                          <Link href={`/companies/${c.id}/edit`} className="text-[12px] font-black text-blue-600 hover:underline">
                            ربط الشركة
                          </Link>
                        ) : (
                          <span className="text-[11px] font-bold text-slate-400">يربطها مدير النظام أو صاحب العمل</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.linked && canTest ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => test(c.id)}
                          disabled={!!testing || !status.usable}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {testing === c.id ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
                          اختبار
                        </button>
                        {r && (
                          <span className={`text-[12px] font-black ${r.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {r.ok ? `ناجح (${r.at})` : `${r.message ?? 'فشل'} (${r.at})`}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[12px] text-slate-400">{c.linked ? 'غير متاح لدورك' : '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {linked > 0 && unlinkedCompanies.length > 0 && (
        <button
          type="button"
          onClick={() => setShowUnlinked(!showUnlinked)}
          aria-expanded={showUnlinked}
          className="text-[12px] font-black text-blue-600 hover:underline"
        >
          {showUnlinked ? 'إخفاء الشركات غير المربوطة' : `عرض الشركات غير المربوطة (${unlinkedCompanies.length})`}
        </button>
      )}
      <p className="text-[12px] font-bold text-slate-400">اختبار الاتصال يسجّل الدخول إلى مقيم فقط ولا ينفّذ أي خدمة.</p>
    </section>
  );
}
