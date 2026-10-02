"use client";

// التقويم (P1-CAL): العطل الرسمية وعطل الشركة، وفترة رمضان وساعاتها، لكل شركة. كل ذلك إعداد افتراضي
// تعدّله الموارد البشرية لكل شركة (DEC-PO-116). العيدان يتبعان التقويم الهجري ويُعلنان كل سنة، فتُدخَل
// تواريخهما هنا ولا تُولَّد آلياً. أيام العمل وأوقات الدوام في نمط العمل لكل فرع (صفحة الفرع).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Plus, Moon, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface Holiday {
  id: string;
  companyId: string;
  name: string;
  kind: 'OFFICIAL' | 'COMPANY';
  startDate: string;
  endDate: string;
  cancelledAt: string | null;
}

interface RamadanPeriod {
  id: string;
  companyId: string;
  hijriYear: number;
  startDate: string;
  endDate: string;
  dailyHours: number;
}

interface CalendarData {
  year: number;
  companies: { id: string; nameArabic: string }[];
  holidays: Holiday[];
  ramadanPeriods: RamadanPeriod[];
  rules: { RAMADAN_WORK_HOURS_PER_DAY_MAX?: number | null };
  canManage: boolean;
}

const KIND_LABELS: Record<Holiday['kind'], string> = { OFFICIAL: 'رسمية', COMPANY: 'الشركة' };
const inputCls = 'w-full p-2.5 border border-slate-200 rounded-xl text-[13px] font-bold focus:outline-none focus:border-teal-400';
const day = (iso: string) => iso.slice(0, 10);

export default function CalendarPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [companyId, setCompanyId] = useState('');
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [holidayForm, setHolidayForm] = useState({ name: '', startDate: '', endDate: '' });
  const [ramadanForm, setRamadanForm] = useState({ hijriYear: '', startDate: '', endDate: '', dailyHours: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/calendar?year=${year}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل التقويم'));
      const body = (await res.json()) as CalendarData;
      setData(body);
      setCompanyId((current) => (current && body.companies.some((c) => c.id === current) ? current : (body.companies[0]?.id ?? '')));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بالخادم');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const holidays = useMemo(() => (data?.holidays ?? []).filter((h) => h.companyId === companyId), [data, companyId]);
  const ramadans = useMemo(() => (data?.ramadanPeriods ?? []).filter((r) => r.companyId === companyId), [data, companyId]);
  const legalMax = data?.rules.RAMADAN_WORK_HOURS_PER_DAY_MAX ?? null;

  /** One request = one Idempotency-Key: a double click or a retry replays instead of doing it twice. */
  async function post(body: Record<string, unknown>, success: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readApiError(res, 'تعذر حفظ التعديل'));
      toast.success(success);
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بالخادم');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addHoliday(e: React.FormEvent) {
    e.preventDefault();
    if (!holidayForm.name.trim() || !holidayForm.startDate) { toast.warning('أدخل اسم العطلة وتاريخ بدايتها'); return; }
    const ok = await post(
      { action: 'saveHoliday', companyId, name: holidayForm.name.trim(), startDate: holidayForm.startDate, ...(holidayForm.endDate ? { endDate: holidayForm.endDate } : {}) },
      'تمت إضافة العطلة',
    );
    if (ok) setHolidayForm({ name: '', startDate: '', endDate: '' });
  }

  async function cancelHoliday(h: Holiday) {
    if (!(await confirmDialog(`إلغاء عطلة «${h.name}»؟ يبقى سجلها للتاريخ.`, { danger: true }))) return;
    await post({ action: 'cancelHoliday', id: h.id }, 'أُلغيت العطلة');
  }

  async function saveRamadan(e: React.FormEvent) {
    e.preventDefault();
    const hijriYear = Number(ramadanForm.hijriYear);
    if (!hijriYear || !ramadanForm.startDate || !ramadanForm.endDate) { toast.warning('أدخل السنة الهجرية وأول يوم وآخر يوم من رمضان'); return; }
    const ok = await post(
      {
        action: 'saveRamadan',
        companyId,
        hijriYear,
        startDate: ramadanForm.startDate,
        endDate: ramadanForm.endDate,
        ...(ramadanForm.dailyHours ? { dailyHours: Number(ramadanForm.dailyHours) } : {}),
      },
      'تم حفظ فترة رمضان',
    );
    if (ok) setRamadanForm({ hijriYear: '', startDate: '', endDate: '', dailyHours: '' });
  }

  async function removeRamadan(r: RamadanPeriod) {
    if (!(await confirmDialog(`حذف فترة رمضان ${r.hijriYear}هـ؟`, { danger: true }))) return;
    await post({ action: 'removeRamadan', id: r.id }, 'حُذفت فترة رمضان');
  }

  const canManage = !!data?.canManage && !!companyId;

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 mb-24 space-y-6" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CalendarDays className="w-7 h-7 text-teal-500" />
            <div>
              <h1 className="text-2xl font-black text-slate-800">التقويم: العطل ورمضان</h1>
              <p className="text-[12px] font-bold text-slate-400">لكل شركة. أيام العمل وأوقات الدوام تُحدَّد في نمط العمل من صفحة الفرع.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(data?.companies.length ?? 0) > 1 && (
              <select aria-label="الشركة" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
                {data?.companies.map((c) => <option key={c.id} value={c.id}>{c.nameArabic}</option>)}
              </select>
            )}
            <select aria-label="السنة" value={year} onChange={(e) => setYear(Number(e.target.value))} className={inputCls}>
              {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button type="button" onClick={load} aria-label="تحديث" className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:text-teal-600">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* العطل */}
        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-black text-slate-700">العطل الرسمية وعطل الشركة {year}</h2>
            {canManage && (
              <button type="button" disabled={busy} onClick={() => post({ action: 'seedOfficial', companyId, year }, 'أُضيفت العطل الرسمية ثابتة التاريخ')}
                className="px-4 py-2 rounded-xl bg-teal-50 text-teal-700 text-[12px] font-extrabold border border-teal-200 disabled:opacity-50">
                إضافة يوم التأسيس واليوم الوطني لسنة {year}
              </button>
            )}
          </div>
          <p className="text-[12px] font-bold text-slate-400">عيد الفطر وعيد الأضحى يتبعان التقويم الهجري: أدخل تواريخهما المعلنة لكل سنة. وإن وافقت عطلة يوم راحة فأضف يوم التعويض المعلن.</p>
          {holidays.length === 0 ? (
            <p className="text-[13px] font-bold text-slate-400">{loading ? 'جارٍ التحميل…' : 'لا توجد عطل مسجلة لهذه السنة.'}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-slate-400 text-right">
                    <th className="py-2 font-extrabold">العطلة</th>
                    <th className="py-2 font-extrabold">النوع</th>
                    <th className="py-2 font-extrabold">من</th>
                    <th className="py-2 font-extrabold">إلى</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.id} className={`border-t border-slate-50 ${h.cancelledAt ? 'text-slate-300 line-through' : 'text-slate-700'}`}>
                      <td className="py-2 font-bold">{h.name}</td>
                      <td className="py-2">{KIND_LABELS[h.kind] ?? h.kind}</td>
                      <td className="py-2">{formatDateShort(day(h.startDate))}</td>
                      <td className="py-2">{formatDateShort(day(h.endDate))}</td>
                      <td className="py-2 text-left">
                        {canManage && !h.cancelledAt && (
                          <button type="button" disabled={busy} onClick={() => cancelHoliday(h)} className="text-rose-500 text-[12px] font-extrabold disabled:opacity-50">إلغاء</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canManage && (
            <form onSubmit={addHoliday} className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">اسم العطلة
                <input className={inputCls} value={holidayForm.name} onChange={(e) => setHolidayForm({ ...holidayForm, name: e.target.value })} placeholder="مثال: عيد الفطر" />
              </label>
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">من
                <input type="date" className={inputCls} value={holidayForm.startDate} onChange={(e) => setHolidayForm({ ...holidayForm, startDate: e.target.value })} />
              </label>
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">إلى (اختياري)
                <input type="date" className={inputCls} value={holidayForm.endDate} onChange={(e) => setHolidayForm({ ...holidayForm, endDate: e.target.value })} />
              </label>
              <button type="submit" disabled={busy} className="flex items-center justify-center gap-1 px-4 py-2.5 rounded-xl bg-teal-500 text-white text-[13px] font-extrabold disabled:opacity-50">
                <Plus className="w-4 h-4" /> إضافة عطلة
              </button>
            </form>
          )}
        </section>

        {/* رمضان */}
        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Moon className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-black text-slate-700">فترة رمضان وساعات العمل</h2>
          </div>
          <p className="text-[12px] font-bold text-slate-400">
            نظام العمل (المادة 98): لا تزيد ساعات العمل الفعلية في رمضان للمسلمين على {legalMax ?? '—'} ساعات يومياً. تُستخدم هذه القيمة افتراضياً، ويمكن للشركة اختيار أقل منها.
          </p>
          {ramadans.length === 0 ? (
            <p className="text-[13px] font-bold text-slate-400">{loading ? 'جارٍ التحميل…' : 'لم تُسجَّل فترة رمضان بعد.'}</p>
          ) : (
            <ul className="space-y-2">
              {ramadans.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 text-[13px] font-bold text-slate-700">
                  <span>رمضان {r.hijriYear}هـ: من {formatDateShort(day(r.startDate))} إلى {formatDateShort(day(r.endDate))}، {r.dailyHours} ساعات يومياً</span>
                  {canManage && (
                    <span className="flex gap-3">
                      <button type="button" onClick={() => setRamadanForm({ hijriYear: String(r.hijriYear), startDate: day(r.startDate), endDate: day(r.endDate), dailyHours: String(r.dailyHours) })} className="text-teal-600 text-[12px] font-extrabold">تعديل</button>
                      <button type="button" disabled={busy} onClick={() => removeRamadan(r)} className="text-rose-500 text-[12px] font-extrabold disabled:opacity-50">حذف</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <form onSubmit={saveRamadan} className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end">
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">السنة الهجرية
                <input inputMode="numeric" className={inputCls} value={ramadanForm.hijriYear} onChange={(e) => setRamadanForm({ ...ramadanForm, hijriYear: e.target.value })} placeholder="مثال: 1448" />
              </label>
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">أول يوم
                <input type="date" className={inputCls} value={ramadanForm.startDate} onChange={(e) => setRamadanForm({ ...ramadanForm, startDate: e.target.value })} />
              </label>
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">آخر يوم
                <input type="date" className={inputCls} value={ramadanForm.endDate} onChange={(e) => setRamadanForm({ ...ramadanForm, endDate: e.target.value })} />
              </label>
              <label className="text-[12px] font-extrabold text-slate-600 space-y-1">ساعات يومياً
                <input inputMode="decimal" className={inputCls} value={ramadanForm.dailyHours} onChange={(e) => setRamadanForm({ ...ramadanForm, dailyHours: e.target.value })} placeholder={legalMax ? String(legalMax) : ''} />
              </label>
              <button type="submit" disabled={busy} className="px-4 py-2.5 rounded-xl bg-indigo-500 text-white text-[13px] font-extrabold disabled:opacity-50">حفظ فترة رمضان</button>
            </form>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
