"use client";

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import {
  BellRing, CalendarDays, Archive, RefreshCw, X, ShieldAlert,
  Users, Building2, Truck, FileText, AlertTriangle, AlertCircle, Plus, Trash2, CheckCircle2, UserCheck, Scale, ExternalLink
} from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import SearchableSelect from '@/components/SearchableSelect';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { dateKey, daysUntil, formatDate, todayKey } from '@/lib/dates';
import { formatMoney, sumMoney, toNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

interface RenewalItem {
  id?: string;
  entityType: string;
  entityId: string;
  entityName: string;
  documentType: string;
  documentName: string;
  category: string;
  expirationDate: string;
  /** Server-computed days until expiry (Riyadh calendar day; 0 = today, < 0 = expired). */
  daysLeft?: number;
  level?: 'expired' | 'critical' | 'warning' | 'ok';
  iqamaNumber?: string | null;
  returnReason?: string | null;
  isEarlyRenewal?: boolean;
  isReferredForRenewal?: boolean;
  isPendingPayment?: boolean;
  isReturnedFromFinance?: boolean;
  isPaidAwaitingConfirmation?: boolean;
  /** Legal documents (agencies, legal contracts): visible here, renewed from the legal pages only. */
  readOnly?: boolean;
  readOnlyReason?: string;
  manageUrl?: string;
}

interface PaymentEntry {
  key: number;
  type: string;
  biller: string;
  sadadNumber: string;
  bankName: string;
  iban: string;
  amount: string;
  details: string;
}

type PaymentField = Exclude<keyof PaymentEntry, 'key'>;

let paymentKeySeq = 0;
const newPaymentEntry = (): PaymentEntry => ({ key: ++paymentKeySeq, type: 'SADAD', biller: '', sadadNumber: '', bankName: '', iban: '', amount: '', details: '' });

const ENTITY_TYPE_LABELS: Record<string, string> = {
  EMPLOYEE: 'موظف',
  COMPANY: 'شركة',
  BRANCH: 'فرع',
  VEHICLE: 'مركبة',
  LEGAL_CONTRACT: 'عقد قانوني',
  AGENCY: 'وكالة شرعية',
  MEDICAL_INSURANCE: 'تأمين طبي',
};

/** Adds whole months to a date-only value (clamped to the last day of the month). Returns 'YYYY-MM-DD' or ''. */
const calcNewExpDate = (oldDate: string, months: string): string => {
  const key = dateKey(oldDate);
  const add = parseInt(months, 10);
  if (!key || !Number.isFinite(add)) return '';
  const [y, m, d] = key.split('-').map(Number);
  const targetMonthIndex = m - 1 + add;
  const lastDay = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(y, targetMonthIndex, Math.min(d, lastDay)));
  return dateKey(result) ?? '';
};

function RenewalsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const employeeIdParam = searchParams?.get('employeeId');
  const [items, setItems] = useState<RenewalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(employeeIdParam ? 'HR' : 'ALL');
  const [selectedDocFilter, setSelectedDocFilter] = useState(employeeIdParam ? 'الإقامة / الهوية' : 'ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState('ALL');
  const [earlyMode, setEarlyMode] = useState(!!employeeIdParam);
  const [showExpiredOnly, setShowExpiredOnly] = useState(false);
  const [probationBusyKey, setProbationBusyKey] = useState<string | null>(null);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [actionType, setActionType] = useState<'RENEWED' | 'TERMINATED' | null>(null);
  const [selectedItem, setSelectedItem] = useState<RenewalItem | null>(null);

  // Form State
  const [renewalDuration, setRenewalDuration] = useState('12'); // months
  const [newExpDate, setNewExpDate] = useState('');
  const [confirmPastDate, setConfirmPastDate] = useState(false);
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [requiresPayment, setRequiresPayment] = useState(false);
  const [paymentEntries, setPaymentEntries] = useState<PaymentEntry[]>(() => [newPaymentEntry()]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      let url = '/api/renewals';
      if (employeeIdParam) url += `?early=true&employeeId=${encodeURIComponent(employeeIdParam)}`;
      else if (earlyMode) url += `?early=true`;

      const res = await fetch(url);
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل التجديدات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setItems(Array.isArray(data) ? (data as RenewalItem[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setLoading(false);
    }
  }, [earlyMode, employeeIdParam]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openActionModal = (type: 'RENEWED' | 'TERMINATED', item: RenewalItem) => {
    setActionType(type);
    setSelectedItem(item);
    setRenewalDuration('12');
    setNewExpDate(calcNewExpDate(item.expirationDate, '12'));
    setConfirmPastDate(false);
    setAttachmentUrl('');
    setNotes('');
    setRequiresPayment(false);
    setPaymentEntries([newPaymentEntry()]);
    setErrorMsg('');
    setModalOpen(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setModalOpen(false);
    setSelectedItem(null);
  };

  const addPaymentEntry = () => {
    setPaymentEntries(prev => [...prev, newPaymentEntry()]);
  };

  const removePaymentEntry = (key: number) => {
    setPaymentEntries(prev => prev.filter((p) => p.key !== key));
  };

  const updatePaymentEntry = (key: number, field: PaymentField, value: string) => {
    setPaymentEntries(prev => prev.map((p) => (p.key === key ? { ...p, [field]: value } : p)));
  };

  const totalPayment = sumMoney(paymentEntries.map((p) => toNumber(p.amount)));
  // A new date of today or earlier leaves the document expired: the server requires confirmPastDate.
  const newDateNotInFuture = !!newExpDate && newExpDate <= todayKey();

  const applyDuration = (months: string) => {
    setRenewalDuration(months);
    if (selectedItem) setNewExpDate(calcNewExpDate(selectedItem.expirationDate, months));
    setConfirmPastDate(false);
  };

  const handleActionSubmit = async () => {
    if (!selectedItem || submitting) return;
    if (actionType === 'RENEWED' && !requiresPayment && !newExpDate) {
      setErrorMsg('الرجاء إدخال تاريخ الانتهاء الجديد');
      return;
    }
    if (actionType === 'RENEWED' && requiresPayment && !(totalPayment > 0)) {
      setErrorMsg('الرجاء إدخال مبلغ السداد');
      return;
    }
    if (actionType === 'RENEWED' && newDateNotInFuture && !confirmPastDate) {
      setErrorMsg('تاريخ الانتهاء الجديد اليوم أو قبله. صحّح التاريخ أو أكّد أنه مقصود');
      return;
    }
    setSubmitting(true);
    setErrorMsg('');

    try {
      const res = await fetch('/api/renewals/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: actionType,
          entityType: selectedItem.entityType,
          entityId: selectedItem.entityId,
          documentType: selectedItem.documentType,
          oldExpDate: selectedItem.expirationDate,
          newExpDate: newExpDate || null,
          confirmPastDate: actionType === 'RENEWED' && newDateNotInFuture ? confirmPastDate : undefined,
          attachmentUrl: attachmentUrl || null,
          notes: notes || null,
          requiresPayment,
          paymentAmount: requiresPayment ? totalPayment : undefined,
          paymentEntries: requiresPayment ? paymentEntries.map(({ key: _key, ...rest }) => rest) : undefined
        })
      });

      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        setErrorMsg(await readApiError(res, 'حدث خطأ غير متوقع'));
        return;
      }
      const data = await res.json().catch(() => ({}));

      toast.success(data?.message || 'تم حفظ الإجراء بنجاح');
      setModalOpen(false);
      setSelectedItem(null);
      fetchData();
    } catch {
      setErrorMsg('تعذر الاتصال بالخادم');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePassProbation = async (item: RenewalItem) => {
    if (!(await confirmDialog('هل أنت متأكد من استكمال العقد وإخفاء هذا التنبيه؟'))) return;
    const busyKey = `${item.entityType}-${item.entityId}-${item.documentType}`;
    setProbationBusyKey(busyKey);
    try {
      const res = await fetch('/api/renewals/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'TERMINATED',
          entityType: item.entityType,
          entityId: item.entityId,
          documentType: item.documentType,
          oldExpDate: item.expirationDate,
          notes: 'تم استكمال العقد وتجاوز فترة التجربة.'
        })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (res.ok) {
        toast.success('تم استكمال العقد');
        fetchData();
      } else {
        toast.error(await readApiError(res, 'حدث خطأ'));
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setProbationBusyKey(null);
    }
  };

  /** Days until the expiry date (negative when expired); NaN when the date is missing/invalid. */
  /** Days until expiry: the server's value, falling back to the shared Riyadh-day helper. NaN when unknown. */
  const getDaysDiff = (item: RenewalItem) =>
    typeof item.daysLeft === 'number' ? item.daysLeft : (daysUntil(item.expirationDate) ?? NaN);

  const baseFilteredItems = items.filter(item => {
    if (selectedDocFilter !== 'ALL' && item.documentName !== selectedDocFilter) return false;
    if (selectedStatusFilter === 'REFERRED_FOR_RENEWAL' && !item.isReferredForRenewal) return false;
    if (selectedStatusFilter === 'PENDING_FINANCE' && !item.isPendingPayment) return false;
    if (selectedStatusFilter === 'RETURNED' && !item.isReturnedFromFinance) return false;
    if (selectedStatusFilter === 'PAID_AWAITING_CONFIRMATION' && !item.isPaidAwaitingConfirmation) return false;
    if (selectedStatusFilter === 'NEEDS_RENEWAL' && (item.isPendingPayment || item.isReturnedFromFinance || item.isPaidAwaitingConfirmation || item.isReferredForRenewal)) return false;

    if (showExpiredOnly) {
      const daysLeft = getDaysDiff(item);
      if (isNaN(daysLeft) || daysLeft >= 0) return false;
    }

    return true;
  });

  const filteredItems = baseFilteredItems.filter(item => {
    if (activeTab === 'REFERRED') {
      if (!item.isEarlyRenewal) return false;
    } else {
      if (activeTab !== 'ALL' && item.category !== activeTab) return false;
    }
    return true;
  });

  const availableDocs = Array.from(new Set(
    baseFilteredItems.filter(i => activeTab === 'ALL' || activeTab === 'REFERRED' ? true : i.category === activeTab).map(i => i.documentName)
  )).filter(Boolean) as string[];

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    setSelectedDocFilter('ALL');
    setSelectedStatusFilter('ALL');
  };

  useEffect(() => {
    if (employeeIdParam) {
      setActiveTab('HR');
      setSelectedDocFilter('الإقامة / الهوية');
      setEarlyMode(true);
    }
  }, [employeeIdParam]);

  return (
    <DashboardLayout>
      <div translate="no" className="notranslate max-w-6xl mx-auto px-4 sm:px-8 py-8 mb-20 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-orange-100 text-orange-600 p-3 rounded-2xl"><BellRing size={26} /></span>
              إدارة التجديدات الدورية
            </h1>
            <p className="text-slate-500 font-semibold mt-2 mr-16">
              متابعة الإقامات، الجوازات، التراخيص، والعقود التي شارفت على الانتهاء.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" aria-pressed={showExpiredOnly} onClick={() => setShowExpiredOnly(!showExpiredOnly)} className={`px-5 py-3 rounded-2xl font-black flex items-center gap-2 transition-all ${showExpiredOnly ? 'bg-red-500 text-white shadow-lg shadow-red-200' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white'}`}>
              {showExpiredOnly ? <X size={20} /> : <AlertTriangle size={20} />}
              المنتهية فقط
            </button>
            <button type="button" aria-pressed={earlyMode} onClick={() => setEarlyMode(!earlyMode)} className={`px-5 py-3 rounded-2xl font-black flex items-center gap-2 transition-all ${earlyMode ? 'bg-orange-500 text-white shadow-lg shadow-orange-200' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-600 hover:text-white'}`}>
              {earlyMode ? <X size={20} /> : <Plus size={20} />}
              {earlyMode ? 'إلغاء التجديد المبكر' : 'طلب تجديد مبكر'}
            </button>
          </div>
        </div>

        {/* Categories Tabs */}
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
          <TabButton active={activeTab === 'ALL'} onClick={() => handleTabChange('ALL')} icon={<FileText size={16} />} label={`الكل (${baseFilteredItems.length})`} />
          {baseFilteredItems.filter(i => i.isEarlyRenewal).length > 0 && (
            <TabButton active={activeTab === 'REFERRED'} onClick={() => handleTabChange('REFERRED')} icon={<AlertTriangle size={16} />} label={`المحال للتجديد (${baseFilteredItems.filter(i => i.isEarlyRenewal).length})`} color="blue" />
          )}
          <TabButton active={activeTab === 'HR'} onClick={() => handleTabChange('HR')} icon={<Users size={16} />} label={`تجديدات الموارد البشرية (${baseFilteredItems.filter(i => i.category === 'HR').length})`} />
          <TabButton active={activeTab === 'EMPLOYEE_DUES'} onClick={() => handleTabChange('EMPLOYEE_DUES')} icon={<UserCheck size={16} />} label={`استحقاقات الموظف (${baseFilteredItems.filter(i => i.category === 'EMPLOYEE_DUES').length})`} />
          <TabButton active={activeTab === 'ADMIN'} onClick={() => handleTabChange('ADMIN')} icon={<Building2 size={16} />} label={`التجديدات الإدارية (${baseFilteredItems.filter(i => i.category === 'ADMIN').length})`} />
          <TabButton active={activeTab === 'LEGAL_DOCS'} onClick={() => handleTabChange('LEGAL_DOCS')} icon={<ShieldAlert size={16} />} label={`التجديدات القانونية (${baseFilteredItems.filter(i => i.category === 'LEGAL_DOCS').length})`} />
          <TabButton active={activeTab === 'LOGISTICS'} onClick={() => handleTabChange('LOGISTICS')} icon={<Truck size={16} />} label={`التجديدات اللوجستية (${baseFilteredItems.filter(i => i.category === 'LOGISTICS').length})`} />
        </div>

        {/* Dynamic Filters Section */}
        <div className="bg-white border border-slate-100 p-5 rounded-[1.5rem] shadow-sm mb-6 flex flex-col md:flex-row items-center gap-6 relative z-10 w-full mt-2">

          <div className="flex items-center gap-4 w-full md:w-auto flex-1 opacity-90 hover:opacity-100 transition relative z-50">
             <div className="w-12 h-12 bg-indigo-50 border border-indigo-100 text-indigo-500 rounded-[1rem] flex items-center justify-center shrink-0 hidden md:flex">
               <FileText size={20} />
             </div>
             <div className="flex-1 w-full relative z-50">
                <SearchableSelect
                  name="docFilter"
                  value={selectedDocFilter}
                  onChange={(e) => setSelectedDocFilter(e.target.value)}
                  label="تصفية حسب نوع الوثيقة"
                  options={[
                    { label: '📄 جميع الوثائق المتاحة في القسم', value: 'ALL' },
                    ...availableDocs.map(doc => ({
                      label: `${doc} (${baseFilteredItems.filter(i => (activeTab === 'ALL' || i.category === activeTab) && i.documentName === doc).length})`,
                      value: doc
                    }))
                  ]}
                  accentColor="indigo"
                />
             </div>
          </div>

          <div className="w-full md:w-px h-px md:h-16 bg-slate-100 hidden md:block"></div>

          <div className="flex items-center gap-4 w-full md:w-auto flex-1 opacity-90 hover:opacity-100 transition relative z-40">
             <div className="w-12 h-12 bg-orange-50 border border-orange-100 text-orange-500 rounded-[1rem] flex items-center justify-center shrink-0 hidden md:flex">
               <AlertCircle size={20} />
             </div>
             <div className="flex-1 w-full relative z-40">
                <SearchableSelect
                  name="statusFilter"
                  value={selectedStatusFilter}
                  onChange={(e) => setSelectedStatusFilter(e.target.value)}
                  label="تصفية حسب الحالة"
                  options={[
                    { label: '⭕ جميع الحالات', value: 'ALL' },
                    { label: '📋 محال للتجديد (من التصفيات)', value: 'REFERRED_FOR_RENEWAL' },
                    { label: '⚠️ يحتاج تجديد (متاح للتجديد)', value: 'NEEDS_RENEWAL' },
                    { label: '⏳ بانتظار سداد المالية', value: 'PENDING_FINANCE' },
                    { label: '✅ بانتظار تأكيد التجديد', value: 'PAID_AWAITING_CONFIRMATION' },
                    { label: '🔄 مسترجع من المالية', value: 'RETURNED' },
                  ]}
                  accentColor="orange"
                />
             </div>
          </div>
        </div>

        {/* Content List */}
        {loading ? (
          <div className="py-20 flex flex-col justify-center items-center">
             <div className="w-10 h-10 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin"></div>
             <div className="text-orange-900 mt-4 font-black">جاري جلب التراخيص...</div>
          </div>
        ) : loadError ? (
          <div className="bg-white border border-rose-200 rounded-[2.5rem] py-16 flex flex-col items-center justify-center text-center shadow-sm">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchData} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] py-24 flex flex-col items-center justify-center text-center shadow-sm">
            <div className="w-24 h-24 bg-emerald-50 rounded-full flex items-center justify-center mb-6 text-emerald-500">
              <ShieldAlert size={40} />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">النظام آمن ومحدث بالكامل!</h3>
            <p className="text-slate-500 font-bold max-w-sm px-4">لا توجد أي تراخيص أو وثائق ستنتهي قريبًا ضمن هذا التصنيف.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredItems.map((item, index) => {
              const daysLeft = getDaysDiff(item);
              const isExpired = daysLeft < 0;
              const itemKey = `${item.entityType}-${item.entityId}-${item.documentType}`;

              return (
                <div key={`${item.id || itemKey}-${index}`} className="bg-white rounded-[2rem] p-6 border border-slate-200 shadow-[0_4px_24px_rgba(0,0,0,0.03)] hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col gap-5 relative overflow-hidden group">
                  {/* Status Indicator Bar */}
                  <div className={`absolute top-0 left-0 right-0 h-1.5 ${isExpired ? 'bg-red-500' : 'bg-orange-400'}`} />

                  <div className="flex justify-between items-start gap-3 w-full">
                    <div className="flex-1">
                       <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest mb-3 ${isExpired ? 'bg-red-50 text-red-600' : 'bg-orange-50 text-orange-600'}`}>
                          {item.documentName}
                       </span>
                       {item.isEarlyRenewal && (
                         <span className="inline-block px-2.5 py-1 rounded-lg text-[10px] font-black bg-blue-50 text-blue-600 border border-blue-100 mb-3 mr-2">
                           ⏰ تجديد مبكر (تصفية)
                         </span>
                       )}
                       {item.isReferredForRenewal && (
                          <span className="inline-block px-2.5 py-1 rounded-lg text-[10px] font-black bg-purple-50 text-purple-600 border border-purple-100 mb-3 mr-2">
                            📋 محال للتجديد
                          </span>
                        )}
                       <h3 className="font-extrabold text-[15px] text-slate-800 leading-snug">{item.entityName}</h3>
                       <p className="text-[12px] font-bold text-slate-400 mt-1">بطاقة: {ENTITY_TYPE_LABELS[item.entityType] || 'سجل'}</p>
                    </div>

                    <div className="text-left flex flex-col items-end shrink-0">
                       <div className={`p-2.5 rounded-2xl ${isExpired ? 'bg-red-50 text-red-500' : 'bg-orange-50 text-orange-500'}`}>
                          <CalendarDays size={20} />
                       </div>
                    </div>
                  </div>

                  <div className="bg-slate-50 border border-slate-100 rounded-[1.25rem] p-4 flex items-center justify-between">
                     <div>
                       <div className="text-[11px] font-extrabold text-slate-400 mb-1 leading-none">{isExpired ? 'انتهت منذ' : daysLeft === 0 ? 'تنتهي' : 'تنتهي بعد'}</div>
                       <div className={`font-black text-[16px] ${isExpired ? 'text-red-500' : 'text-orange-500'}`}>
                         {isNaN(daysLeft) ? '—' : daysLeft === 0 ? 'اليوم' : `${Math.abs(daysLeft)} ${Math.abs(daysLeft) === 1 ? 'يوم' : 'أيام'}`}
                       </div>
                     </div>
                     <div className="text-left">
                        <div className="text-[11px] font-extrabold text-slate-400 mb-1 leading-none">تاريخ الانتهاء</div>
                        <div className="font-bold text-[13px] text-slate-700">
                          {item.expirationDate ? formatDate(item.expirationDate) : 'غير محدد'}
                        </div>
                     </div>
                  </div>

                  {/* Returned from Finance Banner */}
                  {item.isReturnedFromFinance && (
                    <div className="bg-red-50 border border-red-200 rounded-[1rem] p-3 flex items-start gap-2">
                      <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
                      <div>
                        <div className="text-[11px] font-black text-red-600 mb-0.5">مسترجع من المالية</div>
                        <div className="text-[11px] font-bold text-red-500">{item.returnReason || 'بدون سبب محدد'}</div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-auto">
                    {item.readOnly ? (
                      <div className="flex-1 flex flex-col gap-2">
                        <p className="text-[11px] font-bold text-slate-500 flex items-center gap-1.5">
                          <Scale size={13} className="shrink-0" /> {item.readOnlyReason || 'يُدار من الشؤون القانونية'}، للاطلاع فقط.
                        </p>
                        {item.manageUrl && (
                          <Link href={item.manageUrl}
                            className="py-3 text-[13px] font-black bg-slate-50 text-slate-700 hover:bg-slate-800 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2">
                            <ExternalLink size={14} /> فتح في الشؤون القانونية
                          </Link>
                        )}
                      </div>
                    ) : item.isPaidAwaitingConfirmation ? (
                      <button type="button" onClick={() => openActionModal('RENEWED', item)}
                         className="flex-1 py-3 text-[13px] font-black bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2">
                         <CheckCircle2 size={14} /> مدفوع/بانتظار التاكيد
                      </button>
                    ) : item.isPendingPayment ? (
                      <button type="button" disabled
                        className="flex-1 py-3 text-[13px] font-black bg-orange-50 text-orange-500 rounded-[1rem] flex items-center justify-center gap-2 cursor-not-allowed">
                         <RefreshCw size={14} className="animate-spin" /> في انتظار السداد
                      </button>
                    ) : item.documentType === 'ANNUAL_LEAVE_DUE' ? (
                          <>
                            <button type="button" onClick={() => router.push(`/settlements/new?employeeId=${encodeURIComponent(item.entityId)}`)}
                              className="flex-1 py-3 text-[13px] font-black bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2">
                               <CheckCircle2 size={14} /> إجراء تصفية الإجازة
                            </button>
                            <button type="button" onClick={() => openActionModal('RENEWED', item)}
                              className="px-4 py-3 text-[13px] font-black bg-orange-50 text-orange-600 hover:bg-orange-600 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2">
                               <RefreshCw size={14} /> تأجيل الإجازة
                            </button>
                          </>
                    ) : item.documentType === 'PROBATION' ? (
                          <>
                            <button type="button" disabled={probationBusyKey === itemKey} onClick={() => handlePassProbation(item)}
                              className="flex-1 py-3 text-[13px] font-black bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
                               <CheckCircle2 size={14} /> استكمال العقد
                            </button>
                            <button type="button" onClick={() => router.push(`/settlements/new?employeeId=${encodeURIComponent(item.entityId)}`)}
                              className="px-4 py-3 text-[13px] font-black bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2">
                               <X size={16} /> إنهاء فترة التجربة
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => openActionModal('RENEWED', item)}
                              className={`flex-1 py-3 text-[13px] font-black rounded-[1rem] transition-colors flex items-center justify-center gap-2 ${item.isReturnedFromFinance ? 'bg-amber-50 text-amber-600 hover:bg-amber-500 hover:text-white' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white'}`}>
                               <RefreshCw size={14} /> {item.isReturnedFromFinance ? 'إعادة التجديد' : 'تجديد'}
                            </button>
                            <button type="button" onClick={() => openActionModal('TERMINATED', item)}
                              className="px-4 py-3 text-[13px] font-black bg-slate-50 text-slate-500 hover:bg-slate-800 hover:text-white rounded-[1rem] transition-colors flex items-center justify-center gap-2" title="تجاهل وترحيل للأرشيف">
                               <Archive size={16} /> إنهاء
                            </button>
                          </>
                        )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>

      {/* Action Modal */}
      {modalOpen && selectedItem && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity" onClick={closeModal}></div>

          {/* Modal Content */}
          <div className="bg-white w-full max-w-lg rounded-[2.5rem] p-6 sm:p-8 shadow-2xl relative z-10 animate-in fade-in slide-in-from-bottom-8 duration-300">
             <button type="button" aria-label="إغلاق" onClick={closeModal} className="absolute top-6 left-6 w-10 h-10 bg-slate-50 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full flex items-center justify-center transition">
               <X size={20} />
             </button>

             <div className="mb-8 pr-2 text-right">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-4 ${actionType === 'RENEWED' ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-600'}`}>
                   {actionType === 'RENEWED' ? <RefreshCw size={28} /> : <Archive size={28} />}
                </div>
                <h2 className="text-2xl font-black text-slate-800 mb-2">
                  {actionType === 'RENEWED' ? (selectedItem.documentType === 'ANNUAL_LEAVE_DUE' ? 'تأجيل استحقاق الإجازة' : 'تجديد الصلاحية') : 'إنهاء وإرسال للأرشيف'}
                </h2>
                <p className="text-[13px] font-bold text-slate-500 leading-relaxed">
                  أنت على وشك {actionType === 'RENEWED' ? (selectedItem.documentType === 'ANNUAL_LEAVE_DUE' ? 'تأجيل' : 'تجديد') : 'إنهاء'} <strong className="text-slate-800">&quot;{selectedItem.documentName}&quot;</strong> الخاص بـ <strong className="text-slate-800">&quot;{selectedItem.entityName}&quot; {selectedItem.iqamaNumber ? `(${selectedItem.iqamaNumber})` : ''}</strong>.
                </p>
             </div>

             {errorMsg && (
                <div className="mb-6 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-2xl flex items-center gap-2 text-[13px] font-bold">
                  <AlertCircle size={16} className="shrink-0" /> {errorMsg}
                </div>
             )}

             <div className="space-y-6 max-h-[55vh] overflow-y-auto pr-1">
                {actionType === 'RENEWED' && !requiresPayment && (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-[12px] font-extrabold text-slate-700">{selectedItem.documentType === 'ANNUAL_LEAVE_DUE' ? 'مدة التأجيل' : 'مدة التجديد'} <span className="text-red-500">*</span></label>
                      <select value={renewalDuration} onChange={e => applyDuration(e.target.value)}
                        className="w-full px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-emerald-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-100 transition-all appearance-none">
                        <option value="3">3 أشهر</option>
                        <option value="6">6 أشهر</option>
                        <option value="9">9 أشهر</option>
                        <option value="12">12 شهر (سنة)</option>
                        <option value="24">24 شهر (سنتين)</option>
                        <option value="36">36 شهر (3 سنوات)</option>
                      </select>
                    </div>
                    <NewDateField
                      label={selectedItem.documentType === 'ANNUAL_LEAVE_DUE' ? 'تاريخ الاستحقاق المؤجل' : 'تاريخ الانتهاء الجديد'}
                      value={newExpDate}
                      onChange={(v) => { setNewExpDate(v); setConfirmPastDate(false); }}
                      notInFuture={newDateNotInFuture}
                      confirmed={confirmPastDate}
                      onConfirmChange={setConfirmPastDate}
                    />
                  </div>
                )}

                {actionType === 'TERMINATED' && (
                  <div className="flex flex-col gap-2">
                    <label className="text-[12px] font-extrabold text-slate-700">ملاحظات سبب الإنهاء <span className="text-slate-400 font-bold">(اختياري)</span></label>
                    <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="مثال: تم إيقاف نشاط الفرع، تم إلغاء العقد..."
                      className="w-full px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-slate-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-slate-100 transition-all resize-none"></textarea>
                  </div>
                )}


                {/* Details / Notes */}
                {actionType === 'RENEWED' && (
                  <div className="flex flex-col gap-2">
                    <label className="text-[12px] font-extrabold text-slate-700">تفاصيل / ملاحظات <span className="text-slate-400 font-bold">(اختياري)</span></label>
                    <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="ملاحظات إضافية حول هذا التجديد..."
                      className="w-full px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-emerald-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[13px] focus:outline-none focus:ring-4 focus:ring-emerald-100 transition-all resize-none"></textarea>
                  </div>
                )}

                {/* Payment Options */}
                {actionType === 'RENEWED' && (
                  <div className="bg-slate-50 p-5 rounded-[1.25rem] border-2 border-slate-100">
                     <label className="flex items-center gap-3 cursor-pointer select-none">
                       <input type="checkbox" checked={requiresPayment} onChange={(e) => setRequiresPayment(e.target.checked)} className="w-5 h-5 rounded text-emerald-600 border-slate-300 focus:ring-emerald-500" />
                       <span className="text-[13px] font-black text-slate-800">يتطلب سداد رسوم؟ (يتم تحويلها للمالية)</span>
                     </label>
                     {requiresPayment && (
                       <div className="mt-5 space-y-5 animate-in slide-in-from-top-2">
                         <p className="text-[11px] text-amber-600 font-black bg-amber-50 border border-amber-100 px-3 py-2 rounded-xl">ℹ️ عند تحديد هذا الخيار، سيتم إرسال الطلب للمالية للسداد أولاً، وبعد السداد يتم تحديث التاريخ.</p>

                         {/* Duration for payment flow too */}
                         <div className="flex flex-col gap-2">
                           <label className="text-[12px] font-extrabold text-slate-700">مدة التجديد</label>
                           <select value={renewalDuration} onChange={e => applyDuration(e.target.value)}
                             className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl font-bold text-[13px] focus:outline-none focus:border-emerald-400 appearance-none">
                             <option value="3">3 أشهر</option>
                             <option value="6">6 أشهر</option>
                             <option value="9">9 أشهر</option>
                             <option value="12">12 شهر (سنة)</option>
                             <option value="24">24 شهر (سنتين)</option>
                             <option value="36">36 شهر (3 سنوات)</option>
                           </select>
                         </div>

                         <NewDateField
                           label="تاريخ الانتهاء الجديد المتوقع"
                           value={newExpDate}
                           onChange={(v) => { setNewExpDate(v); setConfirmPastDate(false); }}
                           notInFuture={newDateNotInFuture}
                           confirmed={confirmPastDate}
                           onConfirmChange={setConfirmPastDate}
                           compact
                         />

                         {paymentEntries.map((entry, idx) => (
                           <div key={entry.key} className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3 relative">
                             {paymentEntries.length > 1 && (
                               <button type="button" aria-label="حذف السداد" onClick={() => removePaymentEntry(entry.key)} className="absolute top-3 left-3 w-7 h-7 bg-red-50 text-red-400 hover:text-red-600 rounded-full flex items-center justify-center transition">
                                 <Trash2 size={14} />
                               </button>
                             )}
                             <div className="flex items-center gap-2 text-[11px] font-black text-slate-500">
                               سداد #{idx + 1}
                             </div>
                             <div className="grid grid-cols-2 gap-3">
                               <div>
                                 <label className="text-[11px] font-extrabold text-slate-600 block mb-1">طريقة السداد</label>
                                 <select value={entry.type} onChange={e => updatePaymentEntry(entry.key, 'type', e.target.value)}
                                   className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none focus:border-emerald-400 appearance-none">
                                   <option value="SADAD">رقم سداد (مفوتر)</option>
                                   <option value="BANK">حساب بنكي (IBAN)</option>
                                 </select>
                               </div>
                               <div>
                                 <label className="text-[11px] font-extrabold text-slate-600 block mb-1">المبلغ (ر.س)</label>
                                 <input type="number" step="0.01" min="0" value={entry.amount} onChange={e => updatePaymentEntry(entry.key, 'amount', e.target.value)} placeholder="0.00"
                                   className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-black text-[13px] text-emerald-700 focus:outline-none focus:border-emerald-400" />
                               </div>
                             </div>

                             {entry.type === 'SADAD' ? (
                               <div className="grid grid-cols-2 gap-3">
                                 <div>
                                   <label className="text-[11px] font-extrabold text-slate-600 block mb-1">جهة المفوتر</label>
                                   <input type="text" value={entry.biller} onChange={e => updatePaymentEntry(entry.key, 'biller', e.target.value)} placeholder="مثال: وزارة التجارة"
                                     className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none focus:border-emerald-400" />
                                 </div>
                                 <div>
                                   <label className="text-[11px] font-extrabold text-slate-600 block mb-1">رقم السداد</label>
                                   <input type="text" value={entry.sadadNumber} onChange={e => updatePaymentEntry(entry.key, 'sadadNumber', e.target.value)} placeholder="رقم الفاتورة" dir="ltr"
                                     className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none focus:border-emerald-400" />
                                 </div>
                               </div>
                             ) : (
                               <div className="grid grid-cols-2 gap-3">
                                 <div>
                                   <label className="text-[11px] font-extrabold text-slate-600 block mb-1">البنك</label>
                                   <input type="text" value={entry.bankName} onChange={e => updatePaymentEntry(entry.key, 'bankName', e.target.value)} placeholder="البنك الأهلي"
                                     className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none focus:border-emerald-400" />
                                 </div>
                                 <div>
                                   <label className="text-[11px] font-extrabold text-slate-600 block mb-1">رقم الآيبان</label>
                                   <input type="text" value={entry.iban} onChange={e => updatePaymentEntry(entry.key, 'iban', e.target.value)} placeholder="SA00000000..." dir="ltr"
                                     className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none focus:border-emerald-400" />
                                 </div>
                               </div>
                             )}

                             <div>
                               <label className="text-[11px] font-extrabold text-slate-600 block mb-1">تفاصيل / ملاحظات</label>
                               <input type="text" value={entry.details} onChange={e => updatePaymentEntry(entry.key, 'details', e.target.value)} placeholder="تفاصيل إضافية عن هذا السداد..."
                                 className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none focus:border-emerald-400" />
                             </div>
                           </div>
                         ))}

                         <button type="button" onClick={addPaymentEntry} className="w-full py-2.5 border-2 border-dashed border-emerald-200 text-emerald-600 font-black text-[12px] rounded-xl hover:bg-emerald-50 transition flex items-center justify-center gap-2">
                           <Plus size={14} /> إضافة سداد آخر
                         </button>

                         {paymentEntries.length > 0 && (
                           <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl flex items-center justify-between">
                             <span className="text-[12px] font-extrabold text-emerald-700">إجمالي المبالغ:</span>
                             <span className="font-black text-emerald-800 text-[15px]">{formatMoney(totalPayment)} ر.س</span>
                           </div>
                         )}
                       </div>
                     )}
                  </div>
                )}

                <div className="pt-2">
                   <FileUploadField name="attachment" value={attachmentUrl} onChange={(e) => setAttachmentUrl(e.target.value)}
                     label={actionType === 'RENEWED' ? "مرفق التجديد الجديد (أو إيصال السداد/الفاتورة)" : "مدرج ملف داعم لقرار الإنهاء (اختياري)"} />
                </div>
             </div>

             <div className="mt-8">
               <button type="button" onClick={handleActionSubmit} disabled={submitting}
                 className={`w-full py-4 text-[14px] font-black text-white rounded-[1.25rem] transition-all flex items-center justify-center gap-2 shadow-lg disabled:opacity-50 ${actionType === 'RENEWED' ? 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-200' : 'bg-slate-800 hover:bg-slate-900 shadow-slate-200'}`}>
                 {submitting ? (
                   <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                 ) : (
                   actionType === 'RENEWED' ? 'حفظ التحديث وتوثيق التجديد' : 'إنهاء التنبيه وحفظ في الأرشيف'
                 )}
               </button>
             </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

export default function RenewalsPage() {
  return (
    <Suspense fallback={
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
        </div>
      </DashboardLayout>
    }>
      <RenewalsPageContent />
    </Suspense>
  );
}

/** Editable new expiry date, pre-filled with the suggestion (old date + chosen duration). */
function NewDateField({ label, value, onChange, notInFuture, confirmed, onConfirmChange, compact }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  notInFuture: boolean;
  confirmed: boolean;
  onConfirmChange: (v: boolean) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="renewal-new-exp-date" className="text-[12px] font-extrabold text-slate-700">
        {label} <span className="text-red-500">*</span>
      </label>
      <input id="renewal-new-exp-date" type="date" value={value} onChange={(e) => onChange(e.target.value)} dir="ltr"
        className={compact
          ? 'w-full px-4 py-3 bg-white border border-slate-200 rounded-xl font-bold text-[13px] focus:outline-none focus:border-emerald-400 text-right'
          : 'w-full px-5 py-4 bg-slate-50 border-2 border-transparent focus:border-emerald-400 focus:bg-white rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-100 transition-all text-right'} />
      <p className="text-[11px] font-bold text-slate-400">معبأ بالتاريخ المقترح حسب المدة. عدّله ليطابق التاريخ الرسمي في الوثيقة الجديدة.</p>
      {value && !notInFuture && (
        <p className="text-[12px] font-extrabold text-emerald-700">سيُحفظ: {formatDate(value)}</p>
      )}
      {notInFuture && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <p className="text-[12px] font-extrabold text-amber-800 flex items-start gap-1.5">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            هذا التاريخ ({formatDate(value)}) اليوم أو قبله، فستبقى الوثيقة منتهية بعد الحفظ.
          </p>
          <label className="flex items-center gap-2 cursor-pointer select-none text-[12px] font-bold text-amber-900">
            <input type="checkbox" checked={confirmed} onChange={(e) => onConfirmChange(e.target.checked)} className="w-4 h-4 rounded border-amber-300" />
            أؤكد أن هذا التاريخ صحيح ومقصود
          </label>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, icon, label, onClick, color }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void; color?: 'blue' }) {
  const isBlue = color === 'blue';
  return (
    <button type="button" onClick={onClick} className={`whitespace-nowrap flex items-center gap-2 px-5 py-3 rounded-2xl text-[13px] font-extrabold transition-all ${active ? (isBlue ? 'bg-blue-600 text-white shadow-md shadow-blue-200' : 'bg-orange-500 text-white shadow-md shadow-orange-200') : (isBlue ? 'bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 hover:border-blue-300' : 'bg-white text-slate-500 border border-slate-200 hover:bg-orange-50 hover:border-orange-200 hover:text-orange-600')}`}>
      {icon} {label}
    </button>
  );
}
