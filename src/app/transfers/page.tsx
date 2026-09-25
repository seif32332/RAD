"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, Send, CheckCircle, XCircle, Building, User, Package, Briefcase, AlertCircle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import Link from 'next/link';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { ROLE_GROUPS, TRANSFER_STATUS, roleIn } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';

type DecisionStatus = typeof TRANSFER_STATUS.APPROVED | typeof TRANSFER_STATUS.REJECTED;

interface TransferAsset { id: string; assetType?: string | null; description?: string | null; serialNumber?: string | null }

interface TransferEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  jobTitle?: string | null;
  branchId?: string | null;
  branch?: { id?: string; nameArabic?: string | null } | null;
  assets?: TransferAsset[];
}

interface WorkScheduleOption { id: string; name: string; startTime?: string | null; endTime?: string | null }
interface BranchOption { id: string; nameArabic: string; workSchedules?: WorkScheduleOption[] }
interface ManagerOption { id: string; employeeId?: string | null; firstNameArabic?: string | null; lastNameArabic?: string | null; jobTitle?: string | null }

interface Transfer {
  id: string;
  status: string;
  fromBranchId?: string | null;
  toBranchId?: string | null;
  toWorkSchedule?: string | null;
  assetAction?: string | null;
  reason?: string | null;
  hrNote?: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: TransferEmployee | null;
}

type Tab = 'CREATE' | 'PENDING' | 'HISTORY';

const EMPTY_FORM = { employeeId: '', requesterId: '', toBranchId: '', toWorkSchedule: '', reason: '', assetAction: 'RETAIN' };

const assetLabel = (a: TransferAsset) => [a.assetType, a.serialNumber || a.description].filter(Boolean).join(' - ');

export default function TransfersPage() {
  const { role } = useRole();
  // Approve / reject is HR-only (the server enforces it; the API also reports canDecide).
  const [serverCanDecide, setServerCanDecide] = useState<boolean | null>(null);
  const canDecide = serverCanDecide ?? roleIn(role, ROLE_GROUPS.HR);
  const [activeTab, setActiveTab] = useState<Tab>('CREATE');
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [employees, setEmployees] = useState<TransferEmployee[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);

  const fetchData = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch('/api/transfers', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل طلبات النقل');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      const data = (await res.json()) as {
        transfers?: Transfer[];
        metadata?: { employees?: TransferEmployee[]; branches?: BranchOption[]; managers?: ManagerOption[] };
        canDecide?: boolean;
      };
      setServerCanDecide(typeof data.canDecide === 'boolean' ? data.canDecide : null);
      setTransfers(Array.isArray(data.transfers) ? data.transfers : []);
      setEmployees(data.metadata?.employees || []);
      setBranches(data.metadata?.branches || []);
      setManagers(data.metadata?.managers || []);
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const selectedEmployee = employees.find((e) => e.id === form.employeeId);
  const selectedBranch = branches.find((b) => b.id === form.toBranchId);
  const branchName = (id: string | null | undefined) => branches.find((b) => b.id === id)?.nameArabic || '-';

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.employeeId || !form.toBranchId) {
      toast.warning('يرجى تحديد الموظف والفرع');
      return;
    }
    if (selectedEmployee?.branchId && selectedEmployee.branchId === form.toBranchId) {
      toast.warning('الموظف يعمل بالفعل في الفرع المختار');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر رفع طلب النقل'));
        return;
      }
      const data = (await res.json()) as { message?: string };
      toast.success(data.message || 'تم رفع طلب النقل بنجاح');
      setForm(EMPTY_FORM);
      await fetchData({ silent: true });
      setActiveTab('PENDING');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAction = async (id: string, status: DecisionStatus) => {
    if (busyId) return;
    let hrNote: string | undefined;
    if (status === TRANSFER_STATUS.APPROVED) {
      if (!(await confirmDialog('هل أنت متأكد من الموافقة على طلب النقل؟ سيتم نقل الموظف فعلياً للفرع الجديد.'))) return;
    } else {
      const note = await promptDialog('هل أنت متأكد من رفض طلب النقل؟', {
        title: 'رفض طلب النقل',
        placeholder: 'سبب الرفض (اختياري)',
        confirmText: 'رفض الطلب',
        danger: true,
      });
      if (note === null) return;
      hrNote = note.trim() || undefined;
    }
    setBusyId(id);
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'UPDATE_STATUS', payload: { id, status, ...(hrNote ? { hrNote } : {}) } }),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تنفيذ الإجراء'));
        return;
      }
      const data = (await res.json()) as { message?: string };
      toast.success(data.message || 'تم تنفيذ الإجراء');
      await fetchData({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  const pendingTransfers = transfers.filter((t) => t.status === TRANSFER_STATUS.PENDING);
  const closedTransfers = transfers.filter((t) => t.status !== TRANSFER_STATUS.PENDING);

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-teal-200">
          <div>
            <Link href="/recruitment" className="text-teal-600 font-bold text-[13px] hover:underline mb-4 block">← العودة لإدارة التوظيف والاستقطاب</Link>
            <h1 className="text-3xl font-black text-teal-900 tracking-tight flex items-center gap-3">
              <span className="bg-teal-100 text-teal-700 p-3 rounded-2xl"><ArrowRightLeft size={26} /></span>
              النقل الداخلي للموظفين
            </h1>
            <p className="text-teal-800 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              تقديم طلبات نقل الموظفين بين الفروع مع سلسلة موافقات إدارية. يقوم مدير الإدارة برفع الطلب ويتم إحالته للموارد البشرية للموافقة أو الرفض.
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div role="tablist" className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabBtn active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="رفع طلب نقل جديد" />
          <TabBtn active={activeTab === 'PENDING'} onClick={() => setActiveTab('PENDING')} label={`طلبات بانتظار الموافقة (${pendingTransfers.length})`} badge={pendingTransfers.length > 0} />
          <TabBtn active={activeTab === 'HISTORY'} onClick={() => setActiveTab('HISTORY')} label={`أرشيف طلبات النقل (${closedTransfers.length})`} />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري تحميل البيانات...</div>
        ) : loadError ? (
          <div className="bg-white border border-rose-200 rounded-[2rem] p-12 text-center flex flex-col items-center gap-4">
            <AlertCircle size={40} className="text-rose-400" />
            <p className="text-slate-600 font-bold">{loadError}</p>
            <button type="button" onClick={() => void fetchData()} className="flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-6 py-3 rounded-xl font-black text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* CREATE TAB */}
            {activeTab === 'CREATE' && (
              <form onSubmit={handleSubmit} className="bg-white border border-teal-100 rounded-[2rem] p-8 shadow-xl shadow-teal-900/5 space-y-10">

                {/* Source */}
                <div className="p-6 bg-slate-50 border border-slate-100 rounded-2xl">
                  <h3 className="font-extrabold text-[15px] text-slate-800 flex items-center gap-2 mb-6"><Briefcase size={18} /> مصدر الطلب (المدير المفوِّض)</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <SearchableSelect name="requesterId" value={form.requesterId} onChange={(e) => setForm({ ...form, requesterId: e.target.value })} label="المدير أو المسؤول رافع الطلب" accentColor="teal"
                      options={managers.map((m) => ({ label: `${m.firstNameArabic ?? ''} ${m.lastNameArabic ?? ''} - ${m.jobTitle || ''} (#${m.employeeId ?? ''})`, value: m.id }))} />
                  </div>
                </div>

                {/* Employee Selection */}
                <div>
                  <h3 className="font-extrabold text-[15px] text-teal-900 flex items-center gap-2 mb-6"><User size={18} /> تحديد الموظف المراد نقله</h3>
                  <SearchableSelect name="employeeId" value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} label="اختر الموظف" required accentColor="teal"
                    options={employees.map((e) => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''} (${e.branch?.nameArabic || 'بدون فرع'})`, value: e.id }))} />

                  {selectedEmployee && (
                    <div className="mt-6 bg-teal-50 border border-teal-100 rounded-2xl p-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                      <InfoBox label="الرقم الوظيفي" value={`#${selectedEmployee.employeeId ?? ''}`} />
                      <InfoBox label="المسمى الوظيفي" value={selectedEmployee.jobTitle || '-'} />
                      <InfoBox label="الفرع الحالي" value={selectedEmployee.branch?.nameArabic || '-'} />
                      <InfoBox label="العُهَد النشطة" value={`${selectedEmployee.assets?.length || 0} عهدة`} />
                    </div>
                  )}
                </div>

                {/* Destination */}
                <div>
                  <h3 className="font-extrabold text-[15px] text-teal-900 flex items-center gap-2 mb-6"><Building size={18} /> وجهة النقل (الفرع المنقول إليه)</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <SearchableSelect name="toBranchId" value={form.toBranchId} onChange={(e) => setForm({ ...form, toBranchId: e.target.value, toWorkSchedule: '' })} label="الفرع المنقول إليه" required accentColor="teal"
                      options={branches.filter((b) => b.id !== selectedEmployee?.branchId).map((b) => ({ label: b.nameArabic, value: b.id }))} />

                    {selectedBranch && (selectedBranch.workSchedules?.length ?? 0) > 0 && (
                      <SearchableSelect name="toWorkSchedule" value={form.toWorkSchedule} onChange={(e) => setForm({ ...form, toWorkSchedule: e.target.value })} label="جدول العمل في الفرع الجديد" accentColor="teal"
                        options={(selectedBranch.workSchedules || []).map((ws) => ({ label: `${ws.name} (${ws.startTime || ''} - ${ws.endTime || ''})`, value: ws.name }))} />
                    )}
                  </div>
                </div>

                {/* Assets */}
                {selectedEmployee && (selectedEmployee.assets?.length ?? 0) > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6">
                    <h3 className="font-extrabold text-[15px] text-amber-900 flex items-center gap-2 mb-4"><Package size={18} /> عُهَد الموظف النشطة</h3>
                    <div className="flex flex-wrap gap-2 mb-6">
                      {(selectedEmployee.assets || []).map((a) => (
                        <span key={a.id} className="bg-white border border-amber-200 text-amber-800 px-3 py-1.5 rounded-xl text-[12px] font-black">{assetLabel(a)}</span>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <label className={`flex items-center gap-3 p-4 border-2 rounded-xl cursor-pointer transition ${form.assetAction === 'RETAIN' ? 'bg-emerald-50 border-emerald-500' : 'bg-white border-slate-200'}`}>
                        <input type="radio" name="assetAction" checked={form.assetAction === 'RETAIN'} onChange={() => setForm({ ...form, assetAction: 'RETAIN' })} className="w-5 h-5" />
                        <div><p className="font-black text-[13px] text-slate-800">احتفاظ بالعُهَد</p><p className="text-[11px] text-slate-500">ينقل الموظف ومعه عهده الحالية</p></div>
                      </label>
                      <label className={`flex items-center gap-3 p-4 border-2 rounded-xl cursor-pointer transition ${form.assetAction === 'CLEAR' ? 'bg-rose-50 border-rose-500' : 'bg-white border-slate-200'}`}>
                        <input type="radio" name="assetAction" checked={form.assetAction === 'CLEAR'} onChange={() => setForm({ ...form, assetAction: 'CLEAR' })} className="w-5 h-5" />
                        <div><p className="font-black text-[13px] text-slate-800">إخلاء العُهَد</p><p className="text-[11px] text-slate-500">يتم استرداد جميع العهد قبل النقل</p></div>
                      </label>
                    </div>
                  </div>
                )}

                {/* Reason */}
                <div>
                  <label htmlFor="transfer-reason" className="text-[12px] font-extrabold text-slate-700 mb-2 block">سبب ومبرر النقل</label>
                  <textarea id="transfer-reason" rows={3} maxLength={2000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="اكتب هنا سبب طلب نقل الموظف (اختياري)..."
                    className="w-full p-5 bg-white border border-slate-200 focus:border-teal-400 rounded-xl font-bold text-[13px] shadow-sm outline-none resize-none" />
                </div>

                {/* Submit */}
                <div className="pt-6 border-t border-slate-100 flex justify-end">
                  <button type="submit" disabled={isSubmitting} className="px-12 py-3.5 bg-teal-600 hover:bg-teal-700 text-white font-black text-[15px] rounded-xl transition disabled:opacity-50 shadow-lg shadow-teal-600/20 flex items-center gap-2">
                    <Send size={18} /> {isSubmitting ? 'جاري الإرسال...' : 'رفع طلب النقل للموارد البشرية'}
                  </button>
                </div>
              </form>
            )}

            {/* PENDING TAB */}
            {activeTab === 'PENDING' && (
              <div className="space-y-6">
                {pendingTransfers.map((t) => {
                  const isBusy = busyId === t.id;
                  return (
                    <div key={t.id} className={`bg-white border-2 border-teal-100 rounded-[2rem] p-6 md:p-8 shadow-sm hover:border-teal-300 transition flex flex-col md:flex-row gap-8 ${isBusy ? 'opacity-60' : ''}`}>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-4">
                          <span className="bg-amber-100 text-amber-800 px-3 py-1 rounded-lg text-[10px] font-black animate-pulse">⏳ بانتظار موافقة الموارد البشرية</span>
                          {t.assetAction === 'CLEAR' && <span className="bg-rose-100 text-rose-700 px-3 py-1 rounded-lg text-[10px] font-black">🗑️ إخلاء عُهَد</span>}
                          {t.assetAction === 'RETAIN' && <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-lg text-[10px] font-black">📦 احتفاظ بالعهد</span>}
                        </div>
                        <h2 className="font-black text-xl text-slate-800 mb-1">{t.employee?.firstNameArabic} {t.employee?.lastNameArabic} <span className="text-slate-400 text-[14px]">#{t.employee?.employeeId}</span></h2>
                        <p className="text-[13px] font-bold text-slate-500 mb-4">{t.employee?.jobTitle || '-'}</p>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                          <InfoBox label="الفرع الحالي (من)" value={branchName(t.fromBranchId)} />
                          <InfoBox label="الفرع الجديد (إلى)" value={branchName(t.toBranchId)} />
                          <InfoBox label="جدول العمل الجديد" value={t.toWorkSchedule || 'لم يحدد'} />
                          <InfoBox label="تاريخ الطلب" value={formatDate(t.createdAt)} />
                        </div>

                        {t.reason && (
                          <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                            <p className="text-[11px] font-black text-teal-600 mb-1">سبب النقل:</p>
                            <p className="text-[13px] font-bold text-slate-700 whitespace-pre-line">{t.reason}</p>
                          </div>
                        )}

                        {(t.employee?.assets?.length ?? 0) > 0 && (
                          <div className="mt-4 flex flex-wrap gap-2">
                            <span className="text-[10px] font-black text-amber-600 uppercase">العُهد:</span>
                            {(t.employee?.assets || []).map((a) => (
                              <span key={a.id} className="bg-amber-50 border border-amber-200 text-amber-800 px-2 py-0.5 rounded text-[10px] font-bold">{a.assetType}</span>
                            ))}
                          </div>
                        )}
                      </div>

                      {canDecide && (
                        <div className="shrink-0 w-full md:w-56 flex flex-col justify-center gap-3 bg-slate-50 p-4 rounded-3xl border border-slate-100">
                          <button type="button" disabled={busyId !== null} onClick={() => void handleAction(t.id, TRANSFER_STATUS.APPROVED)} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[12px] py-3 rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50">
                            <CheckCircle size={15} /> موافقة ونقل فعلي
                          </button>
                          <button type="button" disabled={busyId !== null} onClick={() => void handleAction(t.id, TRANSFER_STATUS.REJECTED)} className="w-full bg-slate-200 hover:bg-rose-100 hover:text-rose-700 text-slate-600 font-black text-[12px] py-3 rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50">
                            <XCircle size={15} /> رفض طلب النقل
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {pendingTransfers.length === 0 && (
                  <div className="py-16 text-center text-teal-500 font-bold bg-white border border-teal-100 rounded-[2rem]">لا توجد طلبات نقل معلقة حالياً</div>
                )}
              </div>
            )}

            {/* HISTORY TAB */}
            {activeTab === 'HISTORY' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm overflow-x-auto">
                <table className="w-full text-right border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="p-5 text-[12px] font-black text-slate-500">الموظف</th>
                      <th className="p-5 text-[12px] font-black text-slate-500">من → إلى</th>
                      <th className="p-5 text-[12px] font-black text-slate-500">العُهَد</th>
                      <th className="p-5 text-[12px] font-black text-slate-500">التاريخ</th>
                      <th className="p-5 text-[12px] font-black text-slate-500">الحالة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {closedTransfers.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-50 transition">
                        <td className="p-5">
                          <p className="font-black text-[13px] text-slate-800">{t.employee?.firstNameArabic} {t.employee?.lastNameArabic}</p>
                          <p className="text-[11px] font-bold text-slate-400">#{t.employee?.employeeId}</p>
                        </td>
                        <td className="p-5 font-bold text-[12px] text-slate-600">
                          {branchName(t.fromBranchId)} → {branchName(t.toBranchId)}
                        </td>
                        <td className="p-5">
                          <span className={`text-[10px] font-black px-2 py-1 rounded ${t.assetAction === 'CLEAR' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>
                            {t.assetAction === 'CLEAR' ? 'إخلاء' : 'احتفاظ'}
                          </span>
                        </td>
                        <td className="p-5 font-bold text-[12px] text-slate-500">{formatDate(t.updatedAt)}</td>
                        <td className="p-5">
                          {t.status === TRANSFER_STATUS.APPROVED && <span className="font-black text-[10px] text-emerald-700 bg-emerald-50 px-2 py-1 border border-emerald-200 rounded-lg flex items-center w-fit gap-1"><CheckCircle size={14} /> تمت الموافقة والنقل</span>}
                          {t.status === TRANSFER_STATUS.REJECTED && <span className="font-black text-[10px] text-rose-700 bg-rose-50 px-2 py-1 border border-rose-200 rounded-lg flex items-center w-fit gap-1"><XCircle size={14} /> مرفوض</span>}
                          {t.hrNote && <p className="text-[11px] font-bold text-slate-500 mt-1 whitespace-pre-line">ملاحظة الموارد البشرية: {t.hrNote}</p>}
                        </td>
                      </tr>
                    ))}
                    {closedTransfers.length === 0 && (
                      <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">لا توجد طلبات نقل مغلقة</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (<div><p className="text-[10px] font-bold text-teal-600 mb-1 uppercase tracking-wider">{label}</p><p className="font-black text-teal-900 text-[14px]">{value}</p></div>);
}

function TabBtn({ active, onClick, label, badge = false }: { active: boolean; onClick: () => void; label: string; badge?: boolean }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${active ? 'bg-teal-900 text-teal-50 shadow-md border border-teal-900' : 'bg-transparent text-slate-500 hover:bg-teal-50 border-transparent hover:border-teal-200'}`}>
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-rose-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}
