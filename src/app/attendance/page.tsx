"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Clock, CheckCircle, Fingerprint, Search, AlertCircle, RefreshCw, X, Info, PenLine } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { dateKey, formatDate, todayKey } from '@/lib/dates';

interface HubEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  biometricId?: string | null;
  branch?: { nameArabic?: string | null } | null;
  department?: { nameArabic?: string | null } | null;
}

interface HubAttendance {
  id: string;
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status?: string | null;
  lateMinutes?: number | null;
  earlyLeaveMin?: number | null;
  overtimeMin?: number | null;
  employee?: HubEmployee | null;
}

interface HubSchedule {
  id: string;
  name: string;
  startTime?: string | null;
  endTime?: string | null;
  branch?: { id?: string; nameArabic?: string | null } | null;
}

interface HubData {
  attendances: HubAttendance[];
  employees: HubEmployee[];
  schedules: HubSchedule[];
}

type Tab = 'ARCHIVE' | 'REPORT' | 'UNREGISTERED' | 'BIOMETRIC' | 'SCHEDULES';

const EMPTY: HubData = { attendances: [], employees: [], schedules: [] };

const formatTime = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
};

export default function AttendanceDashboardPage() {
  const [activeTab, setActiveTab] = useState<Tab>('UNREGISTERED');

  const [data, setData] = useState<HubData>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [biometricInput, setBiometricInput] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // Archive filter
  const [archiveDateInput, setArchiveDateInput] = useState('');
  const [archiveDate, setArchiveDate] = useState('');

  const fetchHubData = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch('/api/attendance-hub', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل بيانات الحضور');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      const json = (await res.json()) as Partial<HubData>;
      setData({
        attendances: Array.isArray(json.attendances) ? json.attendances : [],
        employees: Array.isArray(json.employees) ? json.employees : [],
        schedules: Array.isArray(json.schedules) ? json.schedules : [],
      });
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHubData();
  }, [fetchHubData]);

  const handleUpdateBiometric = async (id: string, biometricId: string) => {
    if (savingId) return;
    if (!biometricId && !(await confirmDialog('هل تريد مسح رقم جهاز البصمة المسجل لهذا الموظف؟', { danger: true }))) return;
    setSavingId(id);
    try {
      const res = await fetch('/api/attendance-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'UPDATE_BIOMETRIC', payload: { id, biometricId: biometricId.trim() } }),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تحديث البصمة'));
        return;
      }
      const nextId = biometricId.trim() || null;
      setData((prev) => ({
        ...prev,
        employees: prev.employees.map((e) => (e.id === id ? { ...e, biometricId: nextId } : e)),
      }));
      setBiometricInput((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast.success(nextId ? 'تم حفظ رقم جهاز البصمة للموظف' : 'تم مسح رقم جهاز البصمة');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSavingId(null);
    }
  };

  const registeredCount = data.employees.filter((e) => e.biometricId).length;
  const unregisteredEmployees = data.employees.filter((e) => !e.biometricId);

  const today = todayKey();
  const todayAttendances = useMemo(() => data.attendances.filter((a) => dateKey(a.date) === today), [data.attendances, today]);
  const archiveRows = useMemo(
    () => (archiveDate ? data.attendances.filter((a) => dateKey(a.date) === archiveDate) : data.attendances),
    [data.attendances, archiveDate],
  );

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
              <span className="bg-orange-100 text-orange-600 p-3 rounded-2xl"><Fingerprint size={26} /></span>
              الحضور والبصمة وجدول الدوام
            </h1>
            <p className="text-slate-500 font-semibold mt-2">تسجيل الحضور يدوياً، وحفظ أرقام الموظفين في أجهزة البصمة للمطابقة، ومتابعة الالتزام بجداول الدوام.</p>
          </div>
          {!isLoading && !loadError && (
            <p className="text-[12px] font-bold text-slate-400">موظفون لهم رقم في جهاز البصمة: {registeredCount} / {data.employees.length}</p>
          )}
        </div>

        {/* How attendance actually gets into the system (no device integration exists today). */}
        <div role="note" className="bg-blue-50 border border-blue-100 rounded-2xl p-4 md:p-5 flex items-start gap-3">
          <Info size={20} className="text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-[13px] font-bold text-blue-900 leading-relaxed">
            <p className="font-black mb-1">كيف تصل سجلات الحضور إلى النظام؟</p>
            <p>
              لا يتصل رديف حالياً بأجهزة البصمة ولا يستورد ملفاتها آلياً. تُنشأ سجلات الحضور بطريقتين فقط:
              (1) الإدخال اليدوي من الموارد البشرية في تبويب «تقرير دوام اليوم»،
              (2) اعتماد <Link href="/attendance-corrections" className="underline font-black">طلبات تصحيح الحضور</Link> التي يرفعها الموظفون.
              رقم الموظف في جهاز البصمة يُحفظ مرجعاً للمطابقة اليدوية فقط.
            </p>
          </div>
        </div>

        {/* --- Tabs --- */}
        <div role="tablist" className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'REPORT'} onClick={() => setActiveTab('REPORT')} label="تقرير دوام اليوم" />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => setActiveTab('ARCHIVE')} label="سجل محفظة الدوام السابق" />
          <TabButton active={activeTab === 'UNREGISTERED'} onClick={() => setActiveTab('UNREGISTERED')} label={`بدون رقم جهاز (${unregisteredEmployees.length})`} badge={unregisteredEmployees.length > 0} />
          <TabButton active={activeTab === 'BIOMETRIC'} onClick={() => setActiveTab('BIOMETRIC')} label="أرقام أجهزة البصمة" />
          <TabButton active={activeTab === 'SCHEDULES'} onClick={() => setActiveTab('SCHEDULES')} label="جداول العمل المرتبطة" />
        </div>

        {/* --- Content Area --- */}
        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري تحميل بيانات الحضور...</div>
        ) : loadError ? (
          <div className="bg-white border border-rose-200 rounded-[2rem] p-12 text-center flex flex-col items-center gap-4">
            <AlertCircle size={40} className="text-rose-400" />
            <p className="text-slate-600 font-bold">{loadError}</p>
            <button type="button" onClick={() => void fetchHubData()} className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white px-6 py-3 rounded-xl font-black text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* TAB: UNREGISTERED */}
            {activeTab === 'UNREGISTERED' && (
              <div className="space-y-6">
                <div className="bg-rose-50 border border-rose-200 rounded-2xl p-6 flex items-start gap-4">
                  <div className="bg-rose-100 p-2 rounded-xl text-rose-600"><AlertCircle size={24} /></div>
                  <div>
                    <h3 className="font-black text-rose-900 mb-1">موظفون بلا رقم جهاز بصمة:</h3>
                    <p className="text-rose-700 font-bold text-[13px] leading-relaxed">
                      لم يُسجَّل لهؤلاء الموظفين رقمهم في جهاز البصمة بعد.<br />
                      انسخ رقم المستخدم من شاشة الجهاز (قائمة المستخدمين) وأدخله في تبويب «أرقام أجهزة البصمة» لتسهيل مطابقة تقارير الجهاز يدوياً.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {unregisteredEmployees.length === 0 ? (
                    <div className="col-span-full py-12 text-center text-slate-500 font-bold bg-white border border-slate-200 rounded-[2rem]">كل الموظفين لديهم رقم جهاز بصمة مسجل.</div>
                  ) : unregisteredEmployees.map((e) => (
                    <div key={e.id} className="bg-white border border-slate-200 p-5 rounded-[1.5rem] shadow-sm flex flex-col gap-4">
                      <div>
                        <p className="font-black text-[15px] text-slate-800">{e.firstNameArabic} {e.lastNameArabic}</p>
                        <p className="font-bold text-[11px] text-slate-400 mt-0.5">الرقم الوظيفي: #{e.employeeId} | {e.department?.nameArabic || '-'}</p>
                      </div>
                      <div className="mt-auto">
                        <button type="button" onClick={() => setActiveTab('BIOMETRIC')} className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[12px] py-2.5 rounded-xl transition">إدخال رقم الجهاز للموظف</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB: BIOMETRIC SETTINGS */}
            {activeTab === 'BIOMETRIC' && (
              <div className="space-y-8">
                <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                  <div className="bg-slate-50 p-6 border-b border-slate-100 flex justify-between items-center">
                    <div>
                      <h3 className="font-black text-slate-800 text-[16px]">أرقام الموظفين في أجهزة البصمة</h3>
                      <p className="text-slate-500 font-bold text-[12px] mt-1">أدخل رقم المستخدم كما يظهر في شاشة جهاز الحضور (ZKTeco أو غيره). يُحفظ الرقم مرجعاً للمطابقة اليدوية فقط؛ النظام لا يتصل بالجهاز ولا يسحب الحركات منه.</p>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-right border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="p-4 text-[13px] font-black text-slate-500">الموظف / الفرع</th>
                          <th className="p-4 text-[13px] font-black text-slate-500">حالة الربط</th>
                          <th className="p-4 text-[13px] font-black text-slate-500">رقم الموظف في الجهاز</th>
                          <th className="p-4 text-[13px] font-black text-slate-500">إجراء</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {data.employees.map((e) => {
                          const input = biometricInput[e.id] || '';
                          const isSaving = savingId === e.id;
                          return (
                            <tr key={e.id} className="hover:bg-slate-50 transition">
                              <td className="p-4">
                                <p className="font-bold text-[14px] text-slate-800">{e.firstNameArabic} {e.lastNameArabic}</p>
                                <p className="text-slate-400 text-[11px] font-bold">وظيفي: #{e.employeeId} | {e.branch?.nameArabic || '-'}</p>
                              </td>
                              <td className="p-4">
                                {e.biometricId ? (
                                  <span className="bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg text-[11px] font-black flex w-fit items-center gap-1.5"><Fingerprint size={14} /> رقم مسجل ({e.biometricId})</span>
                                ) : (
                                  <span className="bg-rose-100 text-rose-700 px-3 py-1.5 rounded-lg text-[11px] font-black flex w-fit items-center gap-1.5"><AlertCircle size={14} /> لا يوجد رقم</span>
                                )}
                              </td>
                              <td className="p-4">
                                <input
                                  type="text"
                                  aria-label={`رقم جهاز البصمة للموظف ${e.firstNameArabic ?? ''}`}
                                  placeholder={e.biometricId || 'رقم الجهاز...'}
                                  value={input}
                                  onChange={(ev) => setBiometricInput((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                                  onKeyDown={(ev) => {
                                    if (ev.key === 'Enter' && input.trim()) void handleUpdateBiometric(e.id, input);
                                  }}
                                  className="px-4 py-2 border border-slate-300 rounded-lg text-[13px] font-bold focus:ring-2 focus:ring-orange-500 focus:border-orange-500 w-32"
                                  dir="ltr"
                                />
                              </td>
                              <td className="p-4">
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    disabled={!input.trim() || savingId !== null}
                                    onClick={() => void handleUpdateBiometric(e.id, input)}
                                    className="bg-orange-600 hover:bg-orange-700 text-white font-black text-[12px] px-4 py-2 rounded-lg transition disabled:opacity-40 shadow-md shadow-orange-600/20"
                                  >
                                    {isSaving ? 'جاري الحفظ...' : 'حفظ الرقم'}
                                  </button>
                                  {e.biometricId && (
                                    <button
                                      type="button"
                                      disabled={savingId !== null}
                                      onClick={() => void handleUpdateBiometric(e.id, '')}
                                      className="bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white font-black text-[12px] px-4 py-2 rounded-lg transition disabled:opacity-40"
                                    >
                                      مسح الرقم
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {data.employees.length === 0 && (
                          <tr><td colSpan={4} className="p-12 text-center text-slate-400 font-bold">لا يوجد موظفون مسجلون.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: DAILY REPORT */}
            {activeTab === 'REPORT' && (
              <div className="space-y-6">
                <ManualAttendanceForm employees={data.employees} today={today} onSaved={() => void fetchHubData({ silent: true })} />
                {todayAttendances.length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-[2rem] p-8 md:p-12 text-center flex flex-col items-center justify-center">
                    <div className="bg-orange-50 p-5 rounded-full text-orange-400 mb-5"><Clock size={40} aria-hidden="true" /></div>
                    <h3 className="text-xl font-black text-slate-800 tracking-tight mb-2">لم يُسجَّل حضور لأي موظف اليوم</h3>
                    <p className="text-slate-500 font-bold max-w-lg mb-6 leading-relaxed">
                      لا توجد سجلات حضور بتاريخ {formatDate(today)}. لا يوجد ربط آلي مع أجهزة البصمة: سجّل الحضور من النموذج أعلاه، أو راجع طلبات تصحيح الحضور الواردة من الموظفين.
                    </p>
                    <Link href="/attendance-corrections" className="px-6 py-3 bg-orange-600 hover:bg-orange-700 text-white font-black text-[14px] rounded-2xl shadow-lg shadow-orange-600/20 transition">
                      مراجعة طلبات تصحيح الحضور
                    </Link>
                  </div>
                ) : (
                  <AttendanceTable rows={todayAttendances} emptyText="" />
                )}
              </div>
            )}

            {/* TAB: ARCHIVE HISTORY */}
            {activeTab === 'ARCHIVE' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                <form
                  className="p-6 border-b border-slate-100 flex flex-wrap gap-4 bg-slate-50"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    setArchiveDate(archiveDateInput);
                  }}
                >
                  <input type="date" aria-label="تاريخ الأرشيف" value={archiveDateInput} max={today} onChange={(ev) => setArchiveDateInput(ev.target.value)} className="px-5 py-3 rounded-xl border border-slate-200 font-bold text-[13px]" />
                  <button type="submit" className="bg-slate-900 text-white px-6 py-3 rounded-xl font-black text-[13px] flex items-center gap-2"><Search size={16} /> الفلترة وبحث الأرشيف</button>
                  {archiveDate && (
                    <button type="button" onClick={() => { setArchiveDate(''); setArchiveDateInput(''); }} className="bg-white border border-slate-200 text-slate-600 px-4 py-3 rounded-xl font-bold text-[13px] flex items-center gap-2 hover:bg-slate-100">
                      <X size={14} /> عرض الكل
                    </button>
                  )}
                  <p className="text-[11px] font-bold text-slate-400 self-center">يعرض آخر 500 سجل حضور.</p>
                </form>
                <AttendanceTable rows={archiveRows} emptyText={archiveDate ? 'لا يوجد سجلات حضور في هذا التاريخ.' : 'المحفظة فارغة. لا يوجد سجلات حضور مسجلة.'} bare />
              </div>
            )}

            {/* TAB: SCHEDULES */}
            {activeTab === 'SCHEDULES' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {data.schedules.length === 0 ? (
                  <div className="col-span-full py-12 text-center text-slate-500 font-bold bg-white border border-slate-200 rounded-[2rem]">لا توجد جداول دوام أو شفتات معرّفة حالياً للشركة والفروع.</div>
                ) : data.schedules.map((s) => (
                  <div key={s.id} className="bg-white border border-slate-200 p-6 rounded-[2rem] shadow-sm flex flex-col gap-4 relative overflow-hidden group hover:border-orange-300 transition">
                    <div className="absolute top-0 right-0 w-2 h-full bg-orange-400 group-hover:w-4 transition-all"></div>
                    <h4 className="font-black text-slate-800 text-[18px] mr-2">{s.name}</h4>
                    <p className="text-slate-500 font-bold text-[12px] mr-2 bg-slate-50 w-fit px-3 py-1 rounded-lg">إدارة فرع: {s.branch?.nameArabic || 'مركزي للإدارة'}</p>

                    <div className="bg-slate-50 rounded-2xl p-4 mt-2 mr-2">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">بداية الدوام:</span>
                        <span className="font-black text-[15px] text-emerald-700 bg-emerald-100/50 px-2 py-1 rounded-md" dir="ltr">{s.startTime}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">نهاية الدوام:</span>
                        <span className="font-black text-[15px] text-rose-700 bg-rose-100/50 px-2 py-1 rounded-md" dir="ltr">{s.endTime}</span>
                      </div>
                    </div>
                    <div className="mr-2 mt-auto pt-2 text-[12px] font-bold flex gap-2">
                      <CheckCircle size={16} className="text-emerald-500" aria-hidden="true" /> يُستخدم لاحتساب التأخير والانصراف المبكر عند تسجيل الحضور يدوياً أو اعتماد تصحيح.
                    </div>
                  </div>
                ))}
              </div>
            )}

          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function AttendanceTable({ rows, emptyText, bare = false }: { rows: HubAttendance[]; emptyText: string; bare?: boolean }) {
  const table = (
    <div className="overflow-x-auto">
      <table className="w-full text-right border-collapse">
        <thead>
          <tr className="bg-white border-b border-slate-100">
            <th className="p-4 text-[13px] font-black text-slate-500">الموظف / رقم الجهاز</th>
            <th className="p-4 text-[13px] font-black text-slate-500">التاريخ</th>
            <th className="p-4 text-[13px] font-black text-emerald-600">وقت الدخول</th>
            <th className="p-4 text-[13px] font-black text-rose-600">وقت الخروج</th>
            <th className="p-4 text-[13px] font-black text-slate-500">التأخير (دقيقة)</th>
            <th className="p-4 text-[13px] font-black text-slate-500">الخروج المبكر (دقيقة)</th>
            <th className="p-4 text-[13px] font-black text-slate-500">أوفرتايم (دقيقة)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50 transition">
              <td className="p-4">
                <p className="font-bold text-[14px] text-slate-800">{a.employee?.firstNameArabic} {a.employee?.lastNameArabic}</p>
                <p className="text-slate-400 text-[11px] font-bold">رقم الجهاز: {a.employee?.biometricId || '—'} | {a.employee?.branch?.nameArabic || '-'}</p>
              </td>
              <td className="p-4 font-black text-[14px] text-slate-600">{formatDate(a.date)}</td>
              <td className="p-4 font-black text-[15px] text-emerald-700 bg-emerald-50/50">{formatTime(a.checkIn)}</td>
              <td className="p-4 font-black text-[15px] text-rose-700 bg-rose-50/50">{formatTime(a.checkOut)}</td>
              <td className="p-4 font-black text-[14px] text-slate-700">{(a.lateMinutes ?? 0) > 0 ? <span className="text-rose-600">+{a.lateMinutes}</span> : '0'}</td>
              <td className="p-4 font-black text-[14px] text-slate-700">{(a.earlyLeaveMin ?? 0) > 0 ? <span className="text-amber-600">-{a.earlyLeaveMin}</span> : '0'}</td>
              <td className="p-4 font-black text-[14px] text-indigo-700">{(a.overtimeMin ?? 0) > 0 ? `+${a.overtimeMin}` : '0'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={7} className="p-12 text-center text-slate-400 font-bold">{emptyText}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
  if (bare) return table;
  return <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">{table}</div>;
}

function TabButton({ active, onClick, label, badge = false }: { active: boolean; onClick: () => void; label: string; badge?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${
        active ? 'bg-slate-900 text-white shadow-md border border-slate-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'
      }`}
    >
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}

/**
 * Manual attendance entry (POST /api/attendance-hub ADD_ATTENDANCE). Late / early / overtime
 * minutes are computed on the server from the employee work schedule.
 */
function ManualAttendanceForm({ employees, today, onSaved }: { employees: HubEmployee[]; today: string; onSaved: () => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(today);
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(
    () => employees.map((e) => ({ value: e.id, label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} — #${e.employeeId ?? ''}`.trim() })),
    [employees],
  );

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (saving) return;
    if (!employeeId) return setError('اختر الموظف');
    if (!date) return setError('أدخل التاريخ');
    if (!checkIn && !checkOut) return setError('أدخل وقت الحضور أو الانصراف');
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/attendance-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'ADD_ATTENDANCE', payload: { employeeId, date, checkIn, checkOut } }),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        setError(await readApiError(res, 'تعذر حفظ سجل الحضور'));
        return;
      }
      toast.success('تم حفظ سجل الحضور');
      setCheckIn('');
      setCheckOut('');
      onSaved();
    } catch {
      setError('تعذر الاتصال بالخادم');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby="manual-attendance-title" className="bg-white border border-slate-200 rounded-[2rem] p-5 md:p-6 shadow-sm space-y-4">
      <div>
        <h3 id="manual-attendance-title" className="font-black text-slate-800 text-[16px] flex items-center gap-2">
          <PenLine size={18} className="text-orange-600" aria-hidden="true" /> تسجيل حضور يدوي
        </h3>
        <p className="text-[12px] font-bold text-slate-500 mt-1">يُحسب التأخير والانصراف المبكر تلقائياً من جدول دوام الموظف. تسجيل يوم موجود يستبدل أوقاته.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div className="md:col-span-2">
          <SearchableSelect name="employeeId" label="الموظف" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} options={options} placeholder="ابحث باسم الموظف أو رقمه" accentColor="orange" required />
        </div>
        <div>
          <label htmlFor="manual-att-date" className="block text-[13px] font-extrabold text-slate-700 mb-2">التاريخ</label>
          <input id="manual-att-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" className="w-full px-4 py-3 rounded-xl border border-slate-200 font-bold text-[14px]" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="manual-att-in" className="block text-[13px] font-extrabold text-slate-700 mb-2">الحضور</label>
            <input id="manual-att-in" type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} dir="ltr" className="w-full px-3 py-3 rounded-xl border border-slate-200 font-bold text-[14px]" />
          </div>
          <div>
            <label htmlFor="manual-att-out" className="block text-[13px] font-extrabold text-slate-700 mb-2">الانصراف</label>
            <input id="manual-att-out" type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} dir="ltr" className="w-full px-3 py-3 rounded-xl border border-slate-200 font-bold text-[14px]" />
          </div>
        </div>
      </div>
      {error && <p role="alert" className="text-[13px] font-bold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2">{error}</p>}
      <button type="submit" disabled={saving} className="bg-orange-600 hover:bg-orange-700 text-white px-6 py-3 rounded-xl font-black text-[14px] transition disabled:opacity-50">
        {saving ? 'جاري الحفظ...' : 'حفظ سجل الحضور'}
      </button>
    </form>
  );
}
