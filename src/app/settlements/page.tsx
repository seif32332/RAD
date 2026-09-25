"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Receipt, Plus, Search, Clock, Printer, CheckCircle, ShieldCheck, Banknote, DollarSign, Plane, AlertCircle, RefreshCw, XCircle, type LucideIcon } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, SETTLEMENT_STATUS, roleIn } from '@/lib/constants';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface SettlementRow {
  id: string;
  type: string;
  status: string;
  terminationReason?: string | null;
  totalSettlement?: number | null;
  workingDaysSalary?: number | null;
  workingDaysInMonth?: number | null;
  endOfServiceAmount?: number | null;
  yearsOfService?: number | null;
  leaveCompensation?: number | null;
  unusedLeaveDays?: number | null;
  additionalEntitlements?: number | null;
  additionalDeductions?: number | null;
  /** Loans deduction included in additionalDeductions (null for settlements created before it was stored). */
  loansDeduction?: number | null;
  /** Unpaid overtime included in additionalEntitlements (null when not tracked). */
  overtimeAmount?: number | null;
  additionalNotes?: string | null;
  ownerNotes?: string | null;
  transferReceiptUrl?: string | null;
  lastWorkingDate?: string | null;
  /** Article 88 deadline computed by GET /api/settlements (END_OF_SERVICE with a last working day). */
  paymentDeadline?: { dueDate: string; days: number; endedBy: 'EMPLOYER' | 'WORKER'; overdueDays: number } | null;
  createdAt: string;
  employee?: {
    firstNameArabic?: string | null;
    lastNameArabic?: string | null;
    employeeId?: string | null;
    basicSalary?: number | null;
    ibanNumber?: string | null;
    bankName?: string | null;
    legalCompany?: { nameArabic?: string | null } | null;
  } | null;
}

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const money2 = (v: number | null | undefined) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const typeMap: Record<string, { label: string; color: string }> = {
  LEAVE_SETTLEMENT: { label: '\u062a\u0635\u0641\u064a\u0629 \u0625\u062c\u0627\u0632\u0629', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  END_OF_SERVICE: { label: '\u062a\u0635\u0641\u064a\u0629 \u0646\u0647\u0627\u064a\u0629 \u062e\u062f\u0645\u0629', color: 'bg-red-50 text-red-700 border-red-200' },
};

const reasonMap: Record<string, string> = {
  COMPANY_TERMINATION: 'إنهاء من الشركة أو بالاتفاق',
  ARTICLE_81: 'المادة 81 (بانتظار تأكيد المستشار)',
  ARTICLE_87: 'المادة 87 (بانتظار تأكيد المستشار)',
  CONTRACT_EXPIRY: 'انتهاء العقد (بانتظار تأكيد المستشار)',
  RESIGNATION: 'استقالة',
  PROBATION: '\u0641\u062a\u0631\u0629 \u062a\u062c\u0631\u0628\u0629',
  ARTICLE_80: '\u0627\u0644\u0645\u0627\u062f\u0629 80',
};

const statusFlow: Record<string, { label: string; color: string; icon: LucideIcon; bg: string }> = {
  PENDING_APPROVAL: { label: 'بانتظار تعميد صاحب العمل', color: 'text-amber-700', icon: Clock, bg: 'bg-amber-50 border-amber-200' },
  OWNER_APPROVED: { label: 'معتمدة - بانتظار التحويل', color: 'text-blue-700', icon: Banknote, bg: 'bg-blue-50 border-blue-200' },
  PAID: { label: 'تم الدفع', color: 'text-emerald-700', icon: CheckCircle, bg: 'bg-emerald-50 border-emerald-200' },
  REJECTED: { label: 'مرفوضة من صاحب العمل', color: 'text-rose-700', icon: AlertCircle, bg: 'bg-rose-50 border-rose-200' },
  // Backward compatibility
  PENDING_TRANSFER: { label: 'بانتظار التعميد', color: 'text-amber-700', icon: Clock, bg: 'bg-amber-50 border-amber-200' },
  TRANSFERRED: { label: 'تم التحويل', color: 'text-emerald-700', icon: CheckCircle, bg: 'bg-emerald-50 border-emerald-200' },
};

function overdueLabel(n: number): string {
  if (n === 1) return 'يوماً واحداً';
  if (n === 2) return 'يومين';
  if (n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

/** "موعد الصرف النظامي" (article 88) with a late badge while the settlement is not paid. */
function PaymentDeadlineLine({ deadline, status }: { deadline: NonNullable<SettlementRow['paymentDeadline']>; status: string }) {
  const settled = status === 'PAID' || status === 'TRANSFERRED' || status === 'REJECTED';
  const basis = deadline.endedBy === 'WORKER' ? 'أسبوعان من آخر يوم عمل (أنهى العامل العقد)' : 'أسبوع من آخر يوم عمل';
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-bold text-slate-500">
      <span title={`المادة 88: ${basis}`}>
        موعد الصرف النظامي: <span className="text-slate-700">{formatDate(deadline.dueDate)}</span>
      </span>
      {!settled && deadline.overdueDays > 0 && (
        <span className="bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded-lg font-black">
          متأخر {overdueLabel(deadline.overdueDays)}
        </span>
      )}
    </p>
  );
}

export default function SettlementsPage() {
  const { role } = useRole();
  const canApprove = roleIn(role, ROLE_GROUPS.OWNER);
  const canPay = roleIn(role, ROLE_GROUPS.FINANCE);
  const [settlements, setSettlements] = useState<SettlementRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [filterType, setFilterType] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');

  const [selectedSettlement, setSelectedSettlement] = useState<SettlementRow | null>(null);
  const [receiptUrl, setReceiptUrl] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const fetchSettlements = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/settlements');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل التصفيات'));
        return;
      }
      const data = await res.json();
      setSettlements(Array.isArray(data) ? data : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettlements();
  }, [fetchSettlements]);

  const handleReject = async (id: string) => {
    const reason = await promptDialog('سبب رفض التصفية');
    if (reason === null) return;
    if (!reason.trim()) { toast.warning('يرجى كتابة سبب الرفض'); return; }
    setActionLoading(true);
    try {
      const res = await fetch('/api/settlements', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: SETTLEMENT_STATUS.REJECTED, ownerNotes: reason.trim() }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'خطأ في تحديث الحالة'));
        return;
      }
      toast.success('تم رفض التصفية');
      setSelectedSettlement(null);
      setReceiptUrl('');
      await fetchSettlements({ silent: true });
    } catch {
      toast.error('خطأ في تحديث الحالة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAction = async (id: string, newStatus: string) => {
    const msgs: Record<string, string> = {
      OWNER_APPROVED: '\u0647\u0644 \u062a\u0631\u064a\u062f \u0627\u0639\u062a\u0645\u0627\u062f \u0647\u0630\u0647 \u0627\u0644\u062a\u0635\u0641\u064a\u0629 \u0648\u0625\u0631\u0633\u0627\u0644\u0647\u0627 \u0644\u0644\u0645\u062f\u0641\u0648\u0639\u0627\u062a\u061f',
      PAID: '\u0647\u0644 \u062a\u0624\u0643\u062f \u0623\u0646 \u0627\u0644\u0645\u0628\u0644\u063a \u062a\u0645 \u062a\u062d\u0648\u064a\u0644\u0647 \u0644\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0648\u0638\u0641\u061f',
    };
    if (!(await confirmDialog(msgs[newStatus] || '\u062a\u0623\u0643\u064a\u062f\u061f'))) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/settlements', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus, transferReceiptUrl: receiptUrl || null }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, '\u062e\u0637\u0623 \u0641\u064a \u062a\u062d\u062f\u064a\u062b \u0627\u0644\u062d\u0627\u0644\u0629'));
      } else {
        toast.success(newStatus === 'OWNER_APPROVED' ? '\u062a\u0645 \u0627\u0644\u0627\u0639\u062a\u0645\u0627\u062f \u0648\u0625\u0631\u0633\u0627\u0644\u0647\u0627 \u0644\u0644\u0645\u062f\u0641\u0648\u0639\u0627\u062a' : '\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062f\u0641\u0639 \u0628\u0646\u062c\u0627\u062d');
        setSelectedSettlement(null);
        setReceiptUrl('');
        await fetchSettlements({ silent: true });
      }
    } catch {
      toast.error('\u062e\u0637\u0623 \u0641\u064a \u062a\u062d\u062f\u064a\u062b \u0627\u0644\u062d\u0627\u0644\u0629');
    } finally {
      setActionLoading(false);
    }
  };

  const filteredSettlements = settlements.filter(s => {
    const name = `${s.employee?.firstNameArabic || ''} ${s.employee?.lastNameArabic || ''} ${s.employee?.employeeId || ''}`;
    if (searchText && !name.includes(searchText)) return false;
    if (filterType !== 'ALL' && s.type !== filterType) return false;
    if (filterStatus !== 'ALL' && s.status !== filterStatus) return false;
    return true;
  });


  return (
    <DashboardLayout>
      <div className="print:hidden p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Receipt className="text-orange-500" />
              {'\u0625\u062f\u0627\u0631\u0629 \u0645\u0633\u062a\u062d\u0642\u0627\u062a \u0627\u0644\u0645\u0648\u0638\u0641\u064a\u0646 (\u0627\u0644\u062a\u0635\u0641\u064a\u0627\u062a)'}
            </h1>
            <p className="text-slate-500 text-sm mt-1">تصفيات الإجازات ونهاية الخدمة. أداة مساعدة، والقرار النظامي مسؤولية المنشأة.</p>
          </div>
          <Link href="/settlements/new" className="bg-orange-600 hover:bg-orange-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-orange-500/30 font-medium">
            <Plus size={20} />
            {'\u0625\u062c\u0631\u0627\u0621 \u062a\u0635\u0641\u064a\u0629 \u062c\u062f\u064a\u062f\u0629'}
          </Link>
        </div>

        {/* Workflow Steps */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
          <p className="text-[11px] font-black text-slate-400 mb-3 uppercase tracking-widest">{'\u0645\u0633\u0627\u0631 \u0627\u0644\u062a\u0635\u0641\u064a\u0629'}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 rounded-xl border border-amber-200">
              <Clock size={14} className="text-amber-600" />
              <span className="text-[12px] font-bold text-amber-700">1. {'\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u062a\u0639\u0645\u064a\u062f \u0635\u0627\u062d\u0628 \u0627\u0644\u0639\u0645\u0644'}</span>
            </div>
            <span className="text-slate-300 font-black">{'\u2192'}</span>
            <div className="flex items-center gap-2 bg-blue-50 px-4 py-2 rounded-xl border border-blue-200">
              <Banknote size={14} className="text-blue-600" />
              <span className="text-[12px] font-bold text-blue-700">2. {'\u0645\u0639\u062a\u0645\u062f\u0629 - \u062a\u0646\u0632\u0644 \u0644\u0644\u0645\u062f\u0641\u0648\u0639\u0627\u062a'}</span>
            </div>
            <span className="text-slate-300 font-black">{'\u2192'}</span>
            <div className="flex items-center gap-2 bg-emerald-50 px-4 py-2 rounded-xl border border-emerald-200">
              <CheckCircle size={14} className="text-emerald-600" />
              <span className="text-[12px] font-bold text-emerald-700">3. {'\u062a\u0645 \u0627\u0644\u062f\u0641\u0639'}</span>
            </div>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input type="text" aria-label="بحث" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder={'\u0627\u0628\u062d\u062b \u0628\u0627\u0633\u0645 \u0627\u0644\u0645\u0648\u0638\u0641 \u0623\u0648 \u0627\u0644\u0631\u0642\u0645 \u0627\u0644\u0648\u0638\u064a\u0641\u064a...'} className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-orange-100 text-sm font-semibold" />
          </div>
          <select aria-label="نوع التصفية" value={filterType} onChange={(e) => setFilterType(e.target.value)}
            className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[13px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-100 cursor-pointer min-w-[160px]">
            <option value="ALL">{'\u0643\u0644 \u0623\u0646\u0648\u0627\u0639 \u0627\u0644\u062a\u0635\u0641\u064a\u0629'}</option>
            <option value="LEAVE_SETTLEMENT">{'\u062a\u0635\u0641\u064a\u0629 \u0625\u062c\u0627\u0632\u0629'}</option>
            <option value="END_OF_SERVICE">{'\u062a\u0635\u0641\u064a\u0629 \u0646\u0647\u0627\u064a\u0629 \u062e\u062f\u0645\u0629'}</option>
          </select>
          <select aria-label="حالة التصفية" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
            className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[13px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-100 cursor-pointer min-w-[160px]">
            <option value="ALL">{'\u0643\u0644 \u0627\u0644\u062d\u0627\u0644\u0627\u062a'}</option>
            <option value="PENDING_APPROVAL">{'\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u062a\u0639\u0645\u064a\u062f'}</option>
            <option value="OWNER_APPROVED">{'\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u062f\u0641\u0639'}</option>
            <option value="PAID">{'\u062a\u0645 \u0627\u0644\u062f\u0641\u0639'}</option>
            <option value="REJECTED">مرفوضة</option>
          </select>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-20 gap-4">
            <div className="w-8 h-8 rounded-full border-4 border-orange-100 border-t-orange-600 animate-spin" />
          </div>
        ) : loadError ? (
          <div role="alert" className="bg-white rounded-2xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4">
            <AlertCircle size={48} className="text-rose-400" />
            <p className="font-bold text-slate-700">{loadError}</p>
            <button type="button" onClick={() => fetchSettlements()} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : settlements.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <Receipt size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">{'\u0644\u0627 \u062a\u0648\u062c\u062f \u062a\u0635\u0641\u064a\u0627\u062a \u0645\u0633\u062c\u0644\u0629'}</h2>
            <p className="text-slate-500 max-w-sm mb-8">{'\u0627\u0628\u062f\u0623 \u0628\u0625\u062c\u0631\u0627\u0621 \u0623\u0648\u0644 \u062a\u0635\u0641\u064a\u0629 \u0645\u0633\u062a\u062d\u0642\u0627\u062a \u0644\u0645\u0648\u0638\u0641.'}</p>
            <Link href="/settlements/new" className="px-6 py-3 bg-orange-600 text-white font-bold rounded-xl hover:bg-orange-700 transition">+ {'\u0625\u062c\u0631\u0627\u0621 \u062a\u0635\u0641\u064a\u0629'}</Link>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredSettlements.length === 0 && (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-500 font-bold">لا توجد تصفيات مطابقة لمعايير البحث.</div>
            )}
            {filteredSettlements.map((s) => {
              const tp = typeMap[s.type] || typeMap.LEAVE_SETTLEMENT;
              const st = statusFlow[s.status] || statusFlow.PENDING_APPROVAL;
              const StatusIcon = st.icon;
              return (
                <div key={s.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 hover:border-orange-200 hover:shadow-md transition">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className={`w-14 h-14 rounded-xl flex items-center justify-center shadow-inner shrink-0 ${s.type === 'LEAVE_SETTLEMENT' ? 'bg-blue-50 text-blue-500' : s.type === 'END_OF_SERVICE' ? 'bg-red-50 text-red-500' : 'bg-purple-50 text-purple-500'}`}>
                        {s.type === 'LEAVE_SETTLEMENT' ? <Plane size={28} /> : <DollarSign size={28} />}
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-800 text-lg">
                          {s.employee?.firstNameArabic} {s.employee?.lastNameArabic}
                          <span className="text-[11px] font-bold text-slate-400 mr-2">#{s.employee?.employeeId}</span>
                        </h3>
                        <div className="flex flex-wrap gap-2 mt-1.5">
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-lg border ${tp.color}`}>{tp.label}</span>
                          {s.terminationReason && (
                            <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">
                              {reasonMap[s.terminationReason] || s.terminationReason}
                            </span>
                          )}
                          {s.employee?.legalCompany && (
                            <span className="text-[10px] font-bold bg-slate-50 text-slate-500 px-2 py-0.5 rounded-lg border border-slate-100">{s.employee.legalCompany.nameArabic}</span>
                          )}
                        </div>
                        {s.paymentDeadline && <PaymentDeadlineLine deadline={s.paymentDeadline} status={s.status} />}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-3 w-full md:w-auto mt-4 md:mt-0">
                      <div className="flex items-center gap-3">
                        <div className={`flex flex-col items-center gap-1.5 px-3 py-1.5 ${st.bg} justify-center rounded-xl text-[11px] font-black border ${s.status === 'PENDING_APPROVAL' || s.status === 'PENDING_TRANSFER' ? 'animate-pulse' : ''}`}>
                          <div className="flex items-center gap-1.5">
                            <StatusIcon size={14} />
                            {st.label}
                          </div>
                          {s.status === 'REJECTED' && s.ownerNotes && (
                            <span className="text-rose-600 font-bold mt-1 text-[10px]">السبب: {s.ownerNotes}</span>
                          )}
                        </div>
                        <div className="text-center bg-orange-50 px-5 py-2.5 rounded-xl border border-orange-100 flex-shrink-0">
                          <p className="text-[10px] font-bold text-orange-500 mb-0.5">{'\u0635\u0627\u0641\u064a \u0627\u0644\u062a\u0635\u0641\u064a\u0629'}</p>
                          <p className="font-black text-orange-700 text-xl">{formatMoney(s.totalSettlement)} <span className="text-[11px]">{'\u0631.\u0633'}</span></p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedSettlement(s)}
                        className="w-full md:w-auto px-6 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[12px] rounded-xl transition flex items-center justify-center gap-2"
                      >
                        <Printer size={14} /> {'\u0639\u0631\u0636 \u0648\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0637\u0628\u0627\u0639\u0629'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* TICKET DETAILS MODAL */}
      {selectedSettlement && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 print:static print:block print:bg-white print:p-0">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto print:max-h-none print:shadow-none print:bg-white print:p-0 print:overflow-visible">
            <div className="p-8 print:p-4 border-b border-slate-100 flex justify-between items-center print:hidden">
               <h2 className="text-xl font-black text-slate-800">{'\u062a\u0641\u0627\u0635\u064a\u0644 \u0645\u062e\u0627\u0644\u0635\u0629 \u0648\u062a\u0635\u0641\u064a\u0629 \u0646\u0647\u0627\u0626\u064a\u0629'}</h2>
               <div className="flex gap-2">
                 <button type="button" onClick={() => window.print()} className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-[13px] font-bold flex items-center gap-2"><Printer size={16}/> {'\u0637\u0628\u0627\u0639\u0629 \u0627\u0644\u0645\u062e\u0627\u0644\u0635\u0629'}</button>
                 <button type="button" onClick={() => { setSelectedSettlement(null); setReceiptUrl(''); }} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-[13px] font-bold">{'\u0625\u063a\u0644\u0627\u0642'}</button>
               </div>
            </div>

            <div className="p-8 print:p-8 space-y-6 print:space-y-4">
               {/* Printable Header */}
               <div className="hidden print:block text-center border-b-2 border-slate-900 pb-4 mb-8">
                  <h1 className="text-2xl font-black text-slate-900">{'\u0645\u062e\u0627\u0644\u0635\u0629 \u0646\u0647\u0627\u0626\u064a\u0629 \u0648\u062a\u0635\u0641\u064a\u0629 \u0645\u0633\u062a\u062d\u0642\u0627\u062a'}</h1>
                  <p className="text-sm font-bold text-slate-500 mt-2">{'\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u0635\u062f\u0627\u0631'}: {formatDate(selectedSettlement.createdAt)}</p>
               </div>

               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">{'\u0627\u0633\u0645 \u0627\u0644\u0645\u0648\u0638\u0641'}</p>
                     <p className="font-black text-slate-800">{selectedSettlement.employee?.firstNameArabic} {selectedSettlement.employee?.lastNameArabic}</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">{'\u0627\u0644\u0631\u0642\u0645 \u0627\u0644\u0648\u0638\u064a\u0641\u064a'}</p>
                     <p className="font-black text-slate-800">#{selectedSettlement.employee?.employeeId}</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">{'\u0627\u0644\u0634\u0631\u0643\u0629'}</p>
                     <p className="font-black text-slate-800">{selectedSettlement.employee?.legalCompany?.nameArabic || '\u0645\u0631\u0643\u0632\u064a'}</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">{'\u0627\u0644\u0631\u0627\u062a\u0628 \u0627\u0644\u0623\u0633\u0627\u0633\u064a'}</p>
                     <p className="font-black text-slate-800">{formatMoney(selectedSettlement.employee?.basicSalary)} {'\u0631.\u0633'}</p>
                  </div>
               </div>

               {/* Bank Info for Accountant */}
               {(selectedSettlement.status === 'OWNER_APPROVED') && (
                 <div className="bg-blue-50 border-2 border-blue-200 p-5 rounded-2xl flex items-start gap-4">
                   <Banknote className="text-blue-600 shrink-0 mt-1" size={24} />
                   <div className="flex-1">
                     <h4 className="font-black text-blue-900 text-[14px] mb-2">{'\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u062a\u062d\u0648\u064a\u0644 \u0627\u0644\u0628\u0646\u0643\u064a'}</h4>
                     <div className="grid grid-cols-2 gap-3">
                       <div>
                         <p className="text-[10px] font-bold text-blue-500">{'\u0631\u0642\u0645 \u0627\u0644\u0622\u064a\u0628\u0627\u0646 (IBAN)'}</p>
                         <p className="font-black text-blue-900 text-[15px] tracking-wider" dir="ltr">{selectedSettlement.employee?.ibanNumber || '\u063a\u064a\u0631 \u0645\u0633\u062c\u0644'}</p>
                       </div>
                       <div>
                         <p className="text-[10px] font-bold text-blue-500">{'\u0627\u0644\u0628\u0646\u0643'}</p>
                         <p className="font-black text-blue-900 text-[15px]">{selectedSettlement.employee?.bankName || '\u063a\u064a\u0631 \u0645\u0633\u062c\u0644'}</p>
                       </div>
                       <div>
                         <p className="text-[10px] font-bold text-blue-500">{'\u0627\u0644\u0645\u0628\u0644\u063a \u0627\u0644\u0645\u0637\u0644\u0648\u0628 \u062a\u062d\u0648\u064a\u0644\u0647'}</p>
                         <p className="font-black text-orange-700 text-[20px]">{formatMoney(selectedSettlement.totalSettlement)} {'\u0631.\u0633'}</p>
                       </div>
                     </div>
                   </div>
                 </div>
               )}

               <div className="border border-slate-200 rounded-2xl overflow-hidden print:border-slate-800">
                  <table className="w-full text-right text-[13px]">
                     <thead className="bg-slate-50 border-b border-slate-200 print:bg-slate-100 print:border-slate-800">
                       <tr><th className="p-4 font-black text-slate-600">{'\u0627\u0644\u0628\u0646\u062f'}</th><th className="p-4 font-black text-slate-600">{'\u0627\u0644\u0645\u0628\u0644\u063a (\u0631.\u0633)'}</th></tr>
                     </thead>
                     <tbody className="divide-y divide-slate-100 print:divide-slate-800">
                        {(selectedSettlement.workingDaysSalary ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">{'\u0631\u0627\u062a\u0628 \u0623\u064a\u0627\u0645 \u0627\u0644\u0639\u0645\u0644'} ({selectedSettlement.workingDaysInMonth} {'\u064a\u0648\u0645'})</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.workingDaysSalary)}</td></tr>)}
                        {(selectedSettlement.endOfServiceAmount ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">{'\u0645\u0643\u0627\u0641\u0623\u0629 \u0646\u0647\u0627\u064a\u0629 \u0627\u0644\u062e\u062f\u0645\u0629'} ({selectedSettlement.yearsOfService?.toFixed(2)} {'\u0633\u0646\u0629'})</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.endOfServiceAmount)}</td></tr>)}
                        {(selectedSettlement.leaveCompensation ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">{'\u062a\u0639\u0648\u064a\u0636 \u0631\u0635\u064a\u062f \u0627\u0644\u0625\u062c\u0627\u0632\u0627\u062a'} ({selectedSettlement.unusedLeaveDays} {'\u064a\u0648\u0645'})</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.leaveCompensation)}</td></tr>)}
                        {(selectedSettlement.additionalEntitlements ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">{'\u0645\u0633\u062a\u062d\u0642\u0627\u062a \u0625\u0636\u0627\u0641\u064a\u0629'}{(selectedSettlement.overtimeAmount ?? 0) > 0 && <span className="text-slate-500 font-bold"> (منها عمل إضافي {money2(selectedSettlement.overtimeAmount)})</span>}</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.additionalEntitlements)}</td></tr>)}
                        {(selectedSettlement.additionalDeductions ?? 0) > 0 && (<tr><td className="p-4 font-bold text-rose-700">{'\u062e\u0635\u0648\u0645\u0627\u062a'}{(selectedSettlement.loansDeduction ?? 0) > 0 && <span className="text-rose-500 font-bold"> (منها سداد سلف {money2(selectedSettlement.loansDeduction)})</span>}</td><td className="p-4 font-black text-rose-600">-{money2(selectedSettlement.additionalDeductions)}</td></tr>)}
                        {selectedSettlement.additionalNotes && (
                          <tr><td colSpan={2} className="p-4 text-slate-500 font-bold whitespace-pre-line text-sm bg-slate-50/50">
                            ملاحظات التصفية وتفصيل العمليات الإضافية:
                            <br/>
                            <span className="text-slate-700">{selectedSettlement.additionalNotes}</span>
                          </td></tr>
                        )}
                     </tbody>
                     <tfoot className="bg-slate-900 print:bg-slate-100">
                       <tr><td className="p-4 font-black text-white print:text-slate-900 text-lg">{'\u0635\u0627\u0641\u064a \u0627\u0644\u062a\u0635\u0641\u064a\u0629 \u0627\u0644\u0645\u0633\u062a\u062d\u0642'}</td><td className="p-4 font-black text-orange-400 print:text-slate-900 text-xl">{formatMoney(selectedSettlement.totalSettlement)} {'\u0631.\u0633'}</td></tr>
                     </tfoot>
                  </table>
               </div>

               {/* Print signatures */}
               <div className="hidden print:grid grid-cols-2 gap-10 mt-20 pt-10 border-t border-dashed border-slate-300">
                  <div className="text-center">
                     <p className="font-bold text-slate-600 mb-10">{'\u062a\u0648\u0642\u064a\u0639 \u0645\u0633\u0624\u0648\u0644 \u0627\u0644\u0645\u0648\u0627\u0631\u062f \u0627\u0644\u0628\u0634\u0631\u064a\u0629'}</p>
                     <div className="w-40 border-b border-slate-400 mx-auto"></div>
                  </div>
                  <div className="text-center">
                     <p className="font-bold text-slate-600 mb-10">{'\u0625\u0642\u0631\u0627\u0631 \u0648\u062a\u0648\u0642\u064a\u0639 \u0627\u0644\u0645\u0648\u0638\u0641 \u0628\u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 \u0648\u0627\u0644\u062a\u062e\u0627\u0644\u0635'}</p>
                     <div className="w-40 border-b border-slate-400 mx-auto"></div>
                  </div>
               </div>

               {/* ACTION BUTTONS */}
               <div className="print:hidden space-y-4 mt-6">
                 {/* Step 1: Owner Approval */}
                 {canApprove && (selectedSettlement.status === 'PENDING_APPROVAL' || selectedSettlement.status === 'PENDING_TRANSFER') && (
                   <div className="bg-amber-50 border border-amber-200 p-6 rounded-[1.5rem]">
                      <div className="flex items-start gap-3 mb-4">
                        <ShieldCheck className="text-amber-600 shrink-0" size={22} />
                        <div>
                          <h4 className="font-black text-amber-800 text-[14px]">{'\u062a\u0639\u0645\u064a\u062f \u0635\u0627\u062d\u0628 \u0627\u0644\u0639\u0645\u0644'}</h4>
                          <p className="text-[12px] font-bold text-amber-600 mt-1">{'\u0628\u0639\u062f \u0627\u0644\u0627\u0639\u062a\u0645\u0627\u062f\u060c \u0633\u062a\u0646\u0632\u0644 \u0627\u0644\u062a\u0635\u0641\u064a\u0629 \u0644\u0644\u0645\u062f\u0641\u0648\u0639\u0627\u062a \u0628\u0631\u0642\u0645 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0648\u0638\u0641 \u0644\u0644\u0645\u062d\u0627\u0633\u0628.'}</p>
                        </div>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <button type="button" disabled={actionLoading} onClick={() => handleAction(selectedSettlement.id, 'OWNER_APPROVED')} className="flex-1 px-8 py-3 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-black text-[13px] rounded-xl transition shadow-lg flex justify-center items-center gap-2">
                          <ShieldCheck size={16}/> {actionLoading ? '\u062c\u0627\u0631\u064a...' : '\u0627\u0639\u062a\u0645\u0627\u062f \u0627\u0644\u062a\u0635\u0641\u064a\u0629'}
                        </button>
                        <button type="button" disabled={actionLoading} onClick={() => handleReject(selectedSettlement.id)} className="px-8 py-3 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-50 text-rose-700 font-black text-[13px] rounded-xl transition flex justify-center items-center gap-2">
                          <XCircle size={16}/> رفض
                        </button>
                      </div>
                   </div>
                 )}

                 {/* Step 2: Accountant confirms payment */}
                 {canPay && selectedSettlement.status === 'OWNER_APPROVED' && (
                   <div className="bg-blue-50 border border-blue-200 p-6 rounded-[1.5rem]">
                      <div className="flex items-start gap-3 mb-4">
                        <Banknote className="text-blue-600 shrink-0" size={22} />
                        <div>
                          <h4 className="font-black text-blue-800 text-[14px]">{'\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062f\u0641\u0639 (\u0627\u0644\u0645\u062d\u0627\u0633\u0628)'}</h4>
                          <p className="text-[12px] font-bold text-blue-600 mt-1">{'\u0628\u0639\u062f \u0627\u0644\u062a\u062d\u0648\u064a\u0644 \u0644\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0648\u0638\u0641\u060c \u0623\u062f\u062e\u0644 \u0631\u0642\u0645 \u0627\u0644\u062d\u0648\u0627\u0644\u0629 \u0648\u0623\u0643\u062f \u0627\u0644\u062f\u0641\u0639.'}</p>
                        </div>
                      </div>
                      <div className="flex flex-col md:flex-row gap-4">
                        <div className="flex-1">
                           <label className="text-[11px] font-black text-blue-600 block mb-2">{'\u0631\u0642\u0645 \u0625\u064a\u0635\u0627\u0644 \u0627\u0644\u062d\u0648\u0627\u0644\u0629 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'}</label>
                           <input type="text" value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder={'\u0645\u062b\u0627\u0644: \u062d\u0648\u0627\u0644\u0629 \u0645\u0635\u0631\u0641\u064a\u0629 \u0631\u0642\u0645 459392'} className="w-full px-4 py-3 rounded-xl border-none focus:ring-4 focus:ring-blue-200 bg-white font-bold text-[13px] outline-none" />
                        </div>
                        <div className="flex items-end">
                           <button type="button" disabled={actionLoading} onClick={() => handleAction(selectedSettlement.id, 'PAID')} className="w-full px-8 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black text-[13px] rounded-xl transition shadow-lg shadow-emerald-600/20 flex justify-center items-center gap-2">
                             <CheckCircle size={16}/> {actionLoading ? '\u062c\u0627\u0631\u064a...' : '\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062f\u0641\u0639'}
                           </button>
                        </div>
                      </div>
                   </div>
                 )}

                 {/* Step 3: Done */}
                 {(selectedSettlement.status === 'PAID' || selectedSettlement.status === 'TRANSFERRED') && (
                   <div className="bg-emerald-50 border border-emerald-200 p-6 rounded-[1.5rem] flex items-center gap-4">
                     <CheckCircle className="text-emerald-600 shrink-0" size={28} />
                     <div>
                       <h4 className="font-black text-emerald-800 text-[14px]">{'\u062a\u0645 \u0627\u0644\u062f\u0641\u0639 \u0628\u0646\u062c\u0627\u062d'}</h4>
                       <p className="text-[12px] font-bold text-emerald-600">{'\u062a\u0645 \u062a\u062d\u0648\u064a\u0644 \u0627\u0644\u0645\u0628\u0644\u063a \u0644\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0648\u0638\u0641. \u0627\u0644\u062a\u0635\u0641\u064a\u0629 \u0645\u0643\u062a\u0645\u0644\u0629.'}</p>
                       {selectedSettlement.transferReceiptUrl && <p className="text-[11px] text-emerald-500 mt-1">{'\u0631\u0642\u0645 \u0627\u0644\u0625\u064a\u0635\u0627\u0644'}: {selectedSettlement.transferReceiptUrl}</p>}
                     </div>
                   </div>
                 )}
               </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
