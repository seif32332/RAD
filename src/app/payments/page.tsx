"use client";

import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { CreditCard, Plus, Search, CheckCircle2, Receipt, X, Clock, Upload, Trash2, ShieldCheck, PiggyBank, RotateCcw, AlertTriangle, FileSpreadsheet, Send, RefreshCw } from 'lucide-react';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { LOAN_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';
import { formatDate } from '@/lib/dates';
import { formatMoney, sumMoney } from '@/lib/money';
import { paymentDeleteBlockReason } from '@/app/api/payments/access';

interface Payment {
  id: string;
  title: string;
  reason?: string | null;
  amount: number;
  accountNumber?: string | null;
  status: string;
  receiptUrl?: string | null;
  returnReason?: string | null;
  entityType?: string | null;
  createdAt: string;
  /** Maker-checker trail (GET /api/payments). */
  requestedByName?: string | null;
  approvedByName?: string | null;
  paidByName?: string | null;
  isOwnRequest?: boolean;
}

interface PendingLoan {
  id: string;
  amount: number;
  remainingAmount: number;
  reason?: string | null;
  status: string;
  isHrApproved?: boolean | null;
  isFinanceTransferred?: boolean | null;
  isForgiven?: boolean | null;
  employee?: { employeeId?: string | null; firstNameArabic?: string | null; lastNameArabic?: string | null } | null;
}

interface PaymentItem {
  id: string;
  title: string;
  amount: string;
  type: string;
  biller: string;
  sadadNumber: string;
  bankName: string;
  iban: string;
}

type PaymentItemField = Exclude<keyof PaymentItem, 'id'>;

let itemSeq = 0;
const newPaymentItem = (): PaymentItem => ({ id: `pay-item-${++itemSeq}`, title: '', amount: '', type: 'SADAD', biller: '', sadadNumber: '', bankName: '', iban: '' });

const OTHER_FIN_INITIAL = { requestType: 'BANK_STATEMENT', description: '', amount: '', priority: 'NORMAL' };

const OTHER_FIN_TYPE_LABELS: Record<string, string> = {
  BANK_STATEMENT: 'طلب كشف حساب بنكي',
  FINANCIAL_REPORT: 'طلب تقرير مالي',
  EXPENSE_REIMBURSEMENT: 'صرف بدل أو تعويض مصروفات',
  PETTY_CASH: 'طلب سحب من العهدة النثرية',
  BUDGET_REQUEST: 'طلب ميزانية أو اعتماد مالي',
  OTHER: 'طلب مالي آخر',
};

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

/** Uploads one file to /api/upload and returns its URL (toasts the error and returns null on failure). */
async function uploadFile(file: File, failMessage: string): Promise<string | null> {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (res.status === 401) {
      redirectToLogin();
      return null;
    }
    if (!res.ok) {
      toast.error(await readApiError(res, failMessage));
      return null;
    }
    const data = await res.json();
    const url = typeof data?.url === 'string' ? data.url : typeof data?.fileUrl === 'string' ? data.fileUrl : '';
    if (!url) {
      toast.error(failMessage);
      return null;
    }
    return url;
  } catch {
    toast.error(failMessage);
    return null;
  }
}

export default function PaymentsPage() {
  const { role } = useRole();
  // Paying, returning and transferring loans is finance-only on the server (403 for other roles).
  const canFinance = roleIn(role, ROLE_GROUPS.FINANCE);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isPayModalOpen, setIsPayModalOpen] = useState(false);

  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);

  const [paymentItems, setPaymentItems] = useState<PaymentItem[]>(() => [newPaymentItem()]);
  const [addReason, setAddReason] = useState('');
  const [addAttachmentUrl, setAddAttachmentUrl] = useState('');
  const [isUploadingAdd, setIsUploadingAdd] = useState(false);
  const [isSubmittingAdd, setIsSubmittingAdd] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmittingPay, setIsSubmittingPay] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Loans State
  const [loans, setLoans] = useState<PendingLoan[]>([]);
  const [isFinanceModalOpen, setIsFinanceModalOpen] = useState(false);
  const [selectedFinanceLoan, setSelectedFinanceLoan] = useState<PendingLoan | null>(null);
  const [financeReceiptUrl, setFinanceReceiptUrl] = useState('');
  const [isUploadingFinance, setIsUploadingFinance] = useState(false);
  const [isSubmittingFinance, setIsSubmittingFinance] = useState(false);

  // Return Payment State
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);

  // Other Financial Requests State
  const [isOtherFinModalOpen, setIsOtherFinModalOpen] = useState(false);
  const [otherFinData, setOtherFinData] = useState(OTHER_FIN_INITIAL);
  const [isSubmittingOtherFin, setIsSubmittingOtherFin] = useState(false);

  const fetchPayments = useCallback(async () => {
    setLoadError(null);
    try {
      const [payRes, hubRes] = await Promise.all([
        fetch('/api/payments'),
        fetch('/api/payroll-hub')
      ]);
      if (payRes.status === 401 || hubRes.status === 401) return redirectToLogin();
      if (!payRes.ok) {
        setLoadError(await readApiError(payRes, 'تعذر تحميل المدفوعات'));
      } else {
        const data = await payRes.json();
        setPayments(Array.isArray(data) ? data : []);
      }

      if (hubRes.ok) {
        const hubData = await hubRes.json();
        setLoans(Array.isArray(hubData?.loans) ? hubData.loans : []);
      } else if (hubRes.status !== 403) {
        // Loans awaiting transfer are secondary here; a 403 simply means this role cannot see them.
        toast.warning(await readApiError(hubRes, 'تعذر تحميل سلف الموظفين بانتظار السداد'));
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const handleAddAttachmentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setIsUploadingAdd(true);
    const url = await uploadFile(file, 'فشل رفع المرفق');
    if (url) setAddAttachmentUrl(url);
    input.value = '';
    setIsUploadingAdd(false);
  };

  const updateItem = (id: string, field: PaymentItemField, value: string) => {
    setPaymentItems(prev => prev.map((item) => item.id === id ? { ...item, [field]: value } : item));
  };

  const addNewItem = () => setPaymentItems(prev => [...prev, newPaymentItem()]);
  const removeItem = (id: string) => setPaymentItems(prev => prev.filter((item) => item.id !== id));

  const closeAddModal = () => {
    setIsAddModalOpen(false);
    setPaymentItems([newPaymentItem()]);
    setAddReason('');
    setAddAttachmentUrl('');
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingAdd) return;
    setIsSubmittingAdd(true);
    let created = 0;
    try {
      for (const item of paymentItems) {
        let finalAccountNumber = '';
        if (item.type === 'SADAD') {
          finalAccountNumber = `سداد | المفوتر: ${item.biller} - رقم: ${item.sadadNumber}`;
        } else {
          finalAccountNumber = `تحويل | بنك: ${item.bankName} - آيبان: ${item.iban}`;
        }
        const res = await fetch('/api/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.title,
            reason: addReason + (addAttachmentUrl ? ` [مرفق: ${addAttachmentUrl}]` : ''),
            amount: item.amount,
            accountNumber: finalAccountNumber,
            attachmentUrl: addAttachmentUrl || undefined
          })
        });
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          const msg = await readApiError(res, 'حدث خطأ أثناء الإضافة');
          // Keep only the items that were not saved so a retry cannot duplicate them.
          const remaining = paymentItems.slice(created);
          setPaymentItems(remaining.length ? remaining : [newPaymentItem()]);
          toast.error(created > 0 ? `تم حفظ ${created} بند، وتعذر حفظ البند "${item.title}": ${msg}` : msg);
          if (created > 0) await fetchPayments();
          return;
        }
        created += 1;
      }
      toast.success(created > 1 ? `تم تسجيل ${created} بنود سداد وإرسالها للاعتماد` : 'تم تسجيل السداد وإرساله للاعتماد');
      closeAddModal();
      await fetchPayments();
    } catch {
      toast.error("حدث خطأ أثناء الإضافة");
      if (created > 0) {
        setPaymentItems(prev => { const rest = prev.slice(created); return rest.length ? rest : [newPaymentItem()]; });
        await fetchPayments();
      }
    } finally {
      setIsSubmittingAdd(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('هل أنت متأكد من حذف هذا السداد؟', { danger: true }))) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/payments/${id}`, { method: 'DELETE' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حذف السداد'));
        return;
      }
      toast.success('تم حذف السداد');
      await fetchPayments();
    } catch {
      toast.error('تعذر حذف السداد');
    } finally {
      setBusyId(null);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setIsUploading(true);
    const url = await uploadFile(file, 'فشل رفع الملف. تأكد من حجم الملف والامتداد.');
    if (url) setReceiptUrl(url);
    input.value = '';
    setIsUploading(false);
  };

  const handlePaySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPayment || isSubmittingPay) return;
    if (!receiptUrl) {
      toast.warning("الرجاء إرفاق صورة السداد أو التحويل");
      return;
    }
    setIsSubmittingPay(true);
    try {
      const res = await fetch(`/api/payments/${selectedPayment.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PAID', receiptUrl })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res));
        return;
      }
      toast.success('تم تأكيد دفع الفاتورة');
      setIsPayModalOpen(false);
      setReceiptUrl('');
      await fetchPayments();
    } catch {
      toast.error("حدث خطأ");
    } finally {
      setIsSubmittingPay(false);
    }
  };

  const handleFinanceFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setIsUploadingFinance(true);
    const url = await uploadFile(file, 'فشل الرفع');
    if (url) setFinanceReceiptUrl(url);
    input.value = '';
    setIsUploadingFinance(false);
  };

  const closeFinanceModal = () => {
    setIsFinanceModalOpen(false);
    setFinanceReceiptUrl('');
    setSelectedFinanceLoan(null);
  };

  const submitFinanceApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFinanceLoan || isSubmittingFinance) return;
    if (!financeReceiptUrl) { toast.warning("يجب إرفاق الإيصال"); return; }
    setIsSubmittingFinance(true);
    try {
      const res = await fetch('/api/payroll-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'APPROVE_LOAN', payload: { id: selectedFinanceLoan.id, level: 'FINANCE', receiptUrl: financeReceiptUrl } })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res));
        return;
      }
      toast.success('تم تسجيل إيداع السلفة');
      closeFinanceModal();
      await fetchPayments();
    } catch {
      toast.error("حدث خطأ");
    } finally {
      setIsSubmittingFinance(false);
    }
  };

  const handleReturnSubmit = async () => {
    if (!selectedPayment || isSubmittingReturn || !returnReason.trim()) return;
    setIsSubmittingReturn(true);
    try {
      const res = await fetch(`/api/payments/${selectedPayment.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'RETURNED', returnReason: returnReason.trim() })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, "حدث خطأ أثناء رد السداد"));
        return;
      }
      toast.success('تم رد السداد');
      setIsReturnModalOpen(false);
      setReturnReason('');
      await fetchPayments();
    } catch {
      toast.error("حدث خطأ أثناء رد السداد");
    } finally {
      setIsSubmittingReturn(false);
    }
  };

  const handleOtherFinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingOtherFin) return;
    setIsSubmittingOtherFin(true);
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `[طلب مالي] ${OTHER_FIN_TYPE_LABELS[otherFinData.requestType] || otherFinData.requestType}`,
          reason: `${otherFinData.description}${otherFinData.priority === 'URGENT' ? ' [عاجل]' : ''}`,
          amount: otherFinData.amount || '0',
          accountNumber: `نوع الطلب: ${OTHER_FIN_TYPE_LABELS[otherFinData.requestType]} | الأولوية: ${otherFinData.priority === 'URGENT' ? 'عاجل' : 'عادي'}`,
        })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الطلب'));
        return;
      }
      toast.success('تم رفع الطلب المالي بنجاح وسيتم مراجعته من قبل الإدارة المالية.');
      setIsOtherFinModalOpen(false);
      setOtherFinData(OTHER_FIN_INITIAL);
      await fetchPayments();
    } catch {
      toast.error('حدث خطأ أثناء رفع الطلب');
    } finally {
      setIsSubmittingOtherFin(false);
    }
  };

  const filtered = payments.filter(p =>
    (p.title || '').includes(searchTerm) ||
    (p.reason && p.reason.includes(searchTerm)) ||
    (p.accountNumber && p.accountNumber.includes(searchTerm))
  );

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING_OWNER': return <span className="bg-indigo-50 text-indigo-600 border border-indigo-200 px-3 py-1 rounded-[0.5rem] text-[11px] font-bold flex items-center gap-1.5 w-max"><Clock size={12}/> بانتظار تعميد صاحب العمل</span>;
      case 'PENDING_FINANCE': return <span className="bg-orange-50 text-orange-600 border border-orange-200 px-3 py-1 rounded-[0.5rem] text-[11px] font-bold flex items-center gap-1.5 w-max"><Clock size={12}/> بانتظار سداد المالية</span>;
      case 'PAID': return <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 px-3 py-1 rounded-[0.5rem] text-[11px] font-bold flex items-center gap-1.5 w-max"><Receipt size={12} /> تم السداد / الدفع</span>;
      case 'COMPLETED': return <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 px-3 py-1 rounded-[0.5rem] text-[11px] font-bold flex items-center gap-1.5 w-max"><ShieldCheck size={12} /> مكتمل و مقفل</span>;
      case 'RETURNED': return <span className="bg-red-50 text-red-600 border border-red-200 px-3 py-1 rounded-[0.5rem] text-[11px] font-bold flex items-center gap-1.5 w-max"><RotateCcw size={12} /> مسترجع أو مرفوض</span>;
      default: return null;
    }
  };

  const pendingLoans = loans.filter((l) => l.isHrApproved && !l.isFinanceTransferred && !l.isForgiven && l.status !== LOAN_STATUS.REJECTED && l.remainingAmount > 0);

  return (
    <DashboardLayout>
      <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10 min-h-screen">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-8 rounded-[2rem] border border-slate-100 shadow-[0_5px_30px_rgba(0,0,0,0.02)]">
          <div>
            <span className="text-[11px] font-black uppercase tracking-widest text-slate-400 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-full shadow-sm mb-4 inline-flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              النظام المالي الداخلي
            </span>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <CreditCard className="text-blue-600" size={32} />
              إدارة المدفوعات والاعتمادات
            </h1>
            <p className="font-semibold text-slate-500 mt-3 text-[14px]">
              سداد الفواتير، الايجارات، رسوم التجديدات، والمخالفات ومتابعة الإقفال.
            </p>
          </div>
          <div className="flex flex-col md:flex-row items-center gap-3 w-full md:w-auto">
            <button type="button" onClick={() => setIsOtherFinModalOpen(true)} className="flex items-center justify-center gap-2 w-full md:w-auto px-6 py-4 bg-white hover:bg-indigo-50 border-2 border-indigo-200 text-indigo-700 rounded-2xl font-bold text-[13px] shadow-sm transition-all hover:-translate-y-1 hover:border-indigo-400">
              <FileSpreadsheet size={18} />
              طلبات مالية أخرى
            </button>
            <button type="button" onClick={() => setIsAddModalOpen(true)} className="flex items-center justify-center gap-2 w-full md:w-auto px-6 py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-bold text-[13px] shadow-lg shadow-blue-200 transition-all hover:-translate-y-1">
              <Plus size={18} />
              إضافة سداد مستحق جديد
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center bg-white p-4 rounded-[1.5rem] border border-slate-100 shadow-sm">
          <div className="relative w-full md:w-96">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 justify-center text-slate-400" size={20} />
            <input
              type="text"
              aria-label="بحث في المدفوعات"
              placeholder="ابحث برقم الفاتورة، أو المفوتر، أو السبب..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-50/50 hover:bg-white border-2 border-slate-100 focus:border-blue-400 rounded-xl pl-5 pr-12 py-3.5 font-bold text-slate-800 text-[13px] focus:outline-none transition-all placeholder:font-semibold placeholder:text-slate-400"
            />
          </div>
        </div>

        {loadError && (
          <div role="alert" className="bg-rose-50 border border-rose-200 rounded-[1.5rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-bold text-[13px] text-rose-800 flex items-center gap-2"><AlertTriangle size={18} /> {loadError}</p>
            <button type="button" onClick={() => { setIsFetching(true); fetchPayments(); }} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-rose-200 text-rose-700 font-black text-[12px] rounded-xl hover:bg-rose-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {/* Pending Employee Loans for Finance */}
        {pendingLoans.length > 0 && (
          <div className="mb-8">
             <h3 className="font-extrabold text-xl text-amber-600 mb-6 flex items-center gap-3">
                سلف الموظفين (بانتظار سداد المالية)
                <span className="bg-amber-100 text-amber-700 text-[12px] px-3 py-1 rounded-full animate-pulse">{pendingLoans.length}</span>
             </h3>
             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
               {pendingLoans.map((l) => (
                 <div key={l.id} className="bg-white border-2 border-emerald-100 p-6 rounded-[2rem] shadow-sm relative overflow-hidden flex flex-col justify-between">
                    <div>
                      <div className="flex justify-between items-start mb-4">
                        <div className="w-12 h-12 bg-emerald-50 text-emerald-600 flex items-center justify-center rounded-xl">
                          <PiggyBank size={24} />
                        </div>
                        <div className="text-left bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-100">
                           <p className="font-black text-[15px] text-amber-900">{formatMoney(l.amount)} ر.س</p>
                        </div>
                      </div>
                      <h4 className="font-black text-[16px] text-slate-800">{l.employee?.firstNameArabic} {l.employee?.lastNameArabic}</h4>
                      <p className="font-bold text-[12px] text-slate-400 mt-1 mb-4">
                        #{l.employee?.employeeId} | مبرر الطلب: {l.reason || 'بدون مبرر'}
                      </p>
                    </div>
                    {canFinance ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFinanceLoan(l);
                          setIsFinanceModalOpen(true);
                        }}
                        className="w-full mt-2 bg-emerald-50 hover:bg-emerald-600 hover:text-white text-emerald-600 border border-emerald-200 font-black text-[13px] px-4 py-3 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-sm"
                      >
                        <Upload size={16} />
                        إرفاق إيصال الدفع وسداد الموظف
                      </button>
                    ) : (
                      <p className="w-full mt-2 text-center text-[12px] font-bold text-slate-400 bg-slate-50 border border-slate-100 rounded-xl py-3">التحويل من صلاحية الإدارة المالية</p>
                    )}
                 </div>
               ))}
             </div>
          </div>
        )}

        {/* Table View */}
        <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_5px_30px_rgba(0,0,0,0.02)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="p-5 font-black text-slate-400 text-[12px]">البيان / الفاتورة</th>
                  <th className="p-5 font-black text-slate-400 text-[12px]">المبلغ</th>
                  <th className="p-5 font-black text-slate-400 text-[12px]">الحساب / المفوتر</th>
                  <th className="p-5 font-black text-slate-400 text-[12px]">حالة الطلب</th>
                  <th className="p-5 text-center font-black text-slate-400 text-[12px]">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {isFetching ? (
                  Array.from({length: 4}).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="p-5"><div className="h-4 bg-slate-100 rounded w-1/2"></div></td>
                      <td className="p-5"><div className="h-4 bg-slate-100 rounded w-1/3"></div></td>
                      <td className="p-5"><div className="h-4 bg-slate-100 rounded w-1/3"></div></td>
                      <td className="p-5"><div className="h-6 bg-slate-100 rounded-full w-24"></div></td>
                      <td className="p-5"><div className="h-8 bg-slate-100 rounded-xl w-full max-w-[120px] mx-auto"></div></td>
                    </tr>
                  ))
                ) : loadError ? (
                  <tr>
                    <td colSpan={5} className="p-16 text-center font-bold text-rose-600 text-[14px]">{loadError}</td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-16 text-center">
                      <div className="flex flex-col items-center justify-center opacity-40">
                         <CreditCard size={48} className="mb-4 text-slate-400" />
                         <p className="font-bold text-slate-500 text-[14px]">لم يتم العثور على أي بيانات سداد</p>
                      </div>
                    </td>
                  </tr>
                ) : filtered.map(pay => (
                  <tr key={pay.id} className="hover:bg-blue-50/20 transition-colors group">
                    <td className="p-5">
                       <p className="font-extrabold text-slate-800 text-[14px]">{pay.title}</p>
                       {pay.reason && <p className="font-semibold text-slate-500 text-[11px] mt-1">{pay.reason}</p>}
                       <p className="font-bold text-slate-400 text-[10px] mt-2">تاريخ: {formatDate(pay.createdAt)}</p>
                       {(pay.requestedByName || pay.approvedByName || pay.paidByName) && (
                         <p className="font-bold text-slate-400 text-[10px] mt-1">
                           {pay.requestedByName && <>مقدم الطلب: {pay.requestedByName}</>}
                           {pay.approvedByName && <> · المعتمد: {pay.approvedByName}</>}
                           {pay.paidByName && <> · مسجل السداد: {pay.paidByName}</>}
                         </p>
                       )}
                    </td>
                    <td className="p-5">
                       <span className="font-black text-emerald-600 text-[15px] bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-100/50 flex items-center gap-1 w-max">
                         {formatMoney(pay.amount)} <span className="text-[11px]">ر.س</span>
                       </span>
                    </td>
                    <td className="p-5">
                       {pay.accountNumber ? (
                         <span className="font-bold text-slate-600 text-[12px] bg-slate-100 px-3 py-1 rounded-[0.5rem] tracking-widest">{pay.accountNumber}</span>
                       ) : <span className="text-[11px] text-slate-400">لا يوجد بيانات للفوترة</span>}
                    </td>
                    <td className="p-5 align-middle">
                       {getStatusBadge(pay.status)}
                    </td>
                    <td className="p-5 text-center">
                      <div className="flex items-center justify-center gap-2">
                        {/* Status Actions */}
                        {pay.status === 'PENDING_FINANCE' && !canFinance && (
                           <span className="text-[11px] text-slate-400 font-bold">بانتظار الإدارة المالية</span>
                        )}
                        {pay.status === 'PENDING_FINANCE' && canFinance && (
                           <>
                             {pay.isOwnRequest && (
                               <span className="text-[10px] text-amber-700 font-bold" title="فصل الصلاحيات: لا يسجل سداد الطلب من أنشأه">طلبك: يسجل سداده مستخدم آخر</span>
                             )}
                             <button type="button" onClick={() => { setSelectedPayment(pay); setIsPayModalOpen(true); }} className="bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[11px] px-4 py-2 rounded-xl transition-all shadow-sm hover:shadow-md">
                               سداد الفاتورة
                             </button>
                             <button type="button" onClick={() => { setSelectedPayment(pay); setReturnReason(''); setIsReturnModalOpen(true); }} className="bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-600 border border-red-200 font-extrabold text-[11px] px-3 py-2 rounded-xl transition-all flex items-center gap-1">
                               <RotateCcw size={13} /> رد السداد
                             </button>
                             {/* Visa / settlement / loan requests cannot be deleted; they must be returned instead (server answers 409). */}
                             {!paymentDeleteBlockReason(pay) && (
                               <button type="button" aria-label="حذف السداد" disabled={busyId === pay.id} onClick={() => handleDelete(pay.id)} className="bg-slate-100 hover:bg-red-50 text-slate-400 hover:text-red-500 p-2 rounded-xl transition disabled:opacity-50">
                                 <Trash2 size={16} />
                               </button>
                             )}
                           </>
                        )}
                        {(pay.status === 'PAID' || pay.status === 'COMPLETED') && (
                           pay.receiptUrl ? (
                             <a href={pay.receiptUrl} target="_blank" rel="noopener noreferrer" className="bg-emerald-50 text-emerald-600 border border-emerald-200 font-extrabold text-[12px] px-4 py-2 w-full justify-center flex rounded-xl transition-all hover:bg-emerald-100 shadow-sm">
                               عرض الإيصال
                             </a>
                           ) : (
                             <span className="text-[12px] text-slate-400 font-bold w-full text-center block bg-slate-50 py-2 rounded-xl border border-slate-100">بدون إيصال</span>
                           )
                        )}
                        {pay.status === 'RETURNED' && (
                          <span className="text-[11px] text-red-500 font-bold bg-red-50 px-3 py-2 rounded-xl border border-red-100 flex items-center gap-1.5 w-max">
                            <AlertTriangle size={12} /> {pay.returnReason || 'مسترجع'}
                          </span>
                        )}
                        {pay.status === 'PENDING_OWNER' && (
                          <span className="text-[11px] text-indigo-500 font-bold bg-indigo-50 px-3 py-2 rounded-xl border border-indigo-100 flex items-center gap-1.5 w-max">
                            <Clock size={12} /> قيد المراجعة
                          </span>
                        )}
                        {/* Not yet approved, or returned: the requester may withdraw it unless it is linked to a visa / settlement / loan. */}
                        {(pay.status === 'RETURNED' || pay.status === 'PENDING_OWNER') && !paymentDeleteBlockReason(pay) && (
                          <button type="button" aria-label="حذف السداد" title="حذف السداد" disabled={busyId === pay.id} onClick={() => handleDelete(pay.id)} className="bg-slate-100 hover:bg-red-50 text-slate-400 hover:text-red-500 p-2 rounded-xl transition disabled:opacity-50">
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* -------------------- ADD MODAL -------------------- */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-100 animate-in slide-in-from-bottom-8 max-h-[90vh] flex flex-col">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
              <div>
                <h3 className="text-xl font-black text-slate-800 flex items-center gap-2">
                  <Plus className="text-blue-500" /> تسجيل سداد جديد
                </h3>
                <p className="text-slate-500 font-bold text-[12px] mt-1">يمكنك إضافة أكثر من بند سداد في نفس المعاملة</p>
              </div>
              <button type="button" aria-label="إغلاق" disabled={isSubmittingAdd} onClick={closeAddModal} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAddSubmit} className="p-8 space-y-5 overflow-y-auto flex-1">

               {/* Payment Items */}
               {paymentItems.map((item, idx) => (
                 <div key={item.id} className="bg-slate-50/50 border-2 border-slate-100 rounded-2xl p-5 space-y-4 relative group">
                   <div className="flex items-center justify-between mb-1">
                     <span className="text-[12px] font-black text-blue-600 bg-blue-50 px-3 py-1 rounded-full">بند #{idx + 1}</span>
                     {paymentItems.length > 1 && (
                       <button type="button" aria-label="حذف البند" onClick={() => removeItem(item.id)} className="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg transition opacity-0 group-hover:opacity-100 focus:opacity-100">
                         <Trash2 size={15} />
                       </button>
                     )}
                   </div>
                   <div>
                     <label className="block text-[12px] font-extrabold text-slate-700 mb-1.5">البيان <span className="text-red-500">*</span></label>
                     <input type="text" required value={item.title} onChange={e => updateItem(item.id, 'title', e.target.value)} placeholder="مثال: تجديد رخصة عمل..."
                       className="w-full bg-white border-2 border-slate-200 focus:border-blue-400 rounded-xl px-4 py-2.5 font-bold text-[13px] text-slate-800 outline-none transition" />
                   </div>
                   <div className="grid grid-cols-2 gap-4">
                     <div>
                       <label className="block text-[12px] font-extrabold text-slate-700 mb-1.5">المبلغ (ر.س) <span className="text-red-500">*</span></label>
                       <input type="number" required min="0.01" step="0.01" value={item.amount} onChange={e => updateItem(item.id, 'amount', e.target.value)} placeholder="0.00"
                         className="w-full bg-white border-2 border-slate-200 focus:border-blue-400 rounded-xl px-4 py-2.5 font-black text-[13px] text-emerald-600 outline-none transition" />
                     </div>
                     <div>
                       <label className="block text-[12px] font-extrabold text-slate-700 mb-1.5">طريقة السداد <span className="text-red-500">*</span></label>
                       <select value={item.type} onChange={e => updateItem(item.id, 'type', e.target.value)} className="w-full bg-white border-2 border-slate-200 focus:border-blue-400 rounded-xl px-4 py-2.5 font-bold text-[13px] text-slate-800 outline-none transition">
                         <option value="SADAD">سداد (مفوتر)</option>
                         <option value="BANK">آيبان (IBAN)</option>
                       </select>
                     </div>
                   </div>
                   {item.type === 'SADAD' ? (
                     <div className="grid grid-cols-2 gap-4 bg-blue-50/50 p-3 rounded-xl border border-blue-100">
                       <div>
                         <label className="block text-[11px] font-extrabold text-slate-600 mb-1">جهة المفوتر <span className="text-red-500">*</span></label>
                         <input type="text" required value={item.biller} onChange={e => updateItem(item.id, 'biller', e.target.value)} placeholder="وزارة التجارة"
                           className="w-full bg-white border border-slate-200 focus:border-blue-400 rounded-lg px-3 py-2 font-bold text-[12px] text-slate-800 outline-none transition" />
                       </div>
                       <div>
                         <label className="block text-[11px] font-extrabold text-slate-600 mb-1">رقم السداد <span className="text-red-500">*</span></label>
                         <input type="text" required value={item.sadadNumber} onChange={e => updateItem(item.id, 'sadadNumber', e.target.value)} placeholder="رقم الفاتورة" dir="ltr"
                           className="w-full bg-white border border-slate-200 focus:border-blue-400 rounded-lg px-3 py-2 font-bold text-[12px] text-slate-800 outline-none transition" />
                       </div>
                     </div>
                   ) : (
                     <div className="grid grid-cols-2 gap-4 bg-emerald-50/50 p-3 rounded-xl border border-emerald-100">
                       <div>
                         <label className="block text-[11px] font-extrabold text-slate-600 mb-1">البنك <span className="text-red-500">*</span></label>
                         <input type="text" required value={item.bankName} onChange={e => updateItem(item.id, 'bankName', e.target.value)} placeholder="البنك الأهلي"
                           className="w-full bg-white border border-slate-200 focus:border-emerald-400 rounded-lg px-3 py-2 font-bold text-[12px] text-slate-800 outline-none transition" />
                       </div>
                       <div>
                         <label className="block text-[11px] font-extrabold text-slate-600 mb-1">آيبان <span className="text-red-500">*</span></label>
                         <input type="text" required value={item.iban} onChange={e => updateItem(item.id, 'iban', e.target.value)} placeholder="SA00..." dir="ltr"
                           className="w-full bg-white border border-slate-200 focus:border-emerald-400 rounded-lg px-3 py-2 font-bold text-[12px] text-slate-800 outline-none transition" />
                       </div>
                     </div>
                   )}
                 </div>
               ))}

               {/* Add More Button */}
               <button type="button" onClick={addNewItem} className="w-full py-3 border-2 border-dashed border-blue-300 hover:border-blue-500 text-blue-600 hover:bg-blue-50 rounded-xl font-black text-[13px] transition-all flex items-center justify-center gap-2">
                 <Plus size={18} /> إضافة بند سداد آخر
               </button>

               {/* Total */}
               {paymentItems.length > 1 && (
                 <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center justify-between">
                   <span className="font-extrabold text-emerald-800 text-[13px]">إجمالي المعاملة ({paymentItems.length} بنود)</span>
                   <span className="font-black text-emerald-700 text-[18px]">{formatMoney(sumMoney(paymentItems.map((it) => parseFloat(it.amount) || 0)))} <span className="text-[12px]">ر.س</span></span>
                 </div>
               )}

               {/* Attachment */}
               <div>
                 <label className="block text-[13px] font-extrabold text-slate-700 mb-2">مرفق (اختياري)</label>
                 {addAttachmentUrl ? (
                   <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl flex items-center justify-between">
                     <span className="text-emerald-700 font-extrabold text-[12px] flex items-center gap-2"><CheckCircle2 size={16}/> تم إرفاق الملف</span>
                     <button type="button" onClick={() => setAddAttachmentUrl('')} className="text-[11px] font-bold text-red-500 hover:underline">إزالة</button>
                   </div>
                 ) : (
                   <label className={`border-2 border-dashed ${isUploadingAdd ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'} rounded-xl flex items-center justify-center gap-3 p-4 transition-all cursor-pointer`}>
                     <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx" onChange={handleAddAttachmentUpload} disabled={isUploadingAdd} />
                     {isUploadingAdd ? (
                       <><div className="w-5 h-5 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div><span className="text-[12px] font-bold text-blue-600">جاري الرفع...</span></>
                     ) : (
                       <><Upload size={18} className="text-slate-400" /><span className="text-[12px] font-bold text-slate-500">اضغط لإرفاق فاتورة أو مستند</span></>
                     )}
                   </label>
                 )}
               </div>

               {/* General Reason */}
               <div>
                 <label className="block text-[13px] font-extrabold text-slate-700 mb-2">سبب السداد / ملاحظات</label>
                 <textarea value={addReason} onChange={e => setAddReason(e.target.value)} placeholder="ملاحظات توضيحية للمحاسب..." rows={2}
                   className="w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-blue-400 rounded-xl px-4 py-3 font-bold text-[13px] text-slate-800 outline-none transition resize-none"></textarea>
               </div>

               <div className="pt-4 flex items-center justify-between border-t border-slate-100 mt-2">
                 <div className="text-[11px] font-bold text-slate-400">بمجرد الحفظ ستظهر المهمة بشاشة المالية</div>
                 <button type="submit" disabled={isUploadingAdd || isSubmittingAdd} className="bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[13px] px-8 py-3 rounded-xl transition-all shadow-lg shadow-blue-200 hover:-translate-y-0.5 flex items-center gap-2 disabled:opacity-50 disabled:hover:translate-y-0">
                   <Send size={16} /> {isSubmittingAdd ? 'جاري الحفظ...' : 'حفظ وإرسال للاعتماد'}
                 </button>
               </div>
            </form>
          </div>
        </div>
      )}

      {/* -------------------- PAY MODAL -------------------- */}
      {isPayModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md overflow-hidden border border-slate-100 animate-in slide-in-from-bottom-8">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h3 className="text-xl font-black text-slate-800 flex items-center gap-2">
                سداد التحويلة واعتمادها
              </h3>
              <button type="button" aria-label="إغلاق" disabled={isUploading || isSubmittingPay} onClick={() => { setIsPayModalOpen(false); setReceiptUrl(''); }} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handlePaySubmit} className="p-8 space-y-6">
               <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100 mb-6">
                 <p className="text-[12px] font-black text-slate-500 mb-1">بيان السداد:</p>
                 <p className="font-extrabold text-blue-900 text-[14px]">{selectedPayment?.title}</p>
                 <div className="flex justify-between items-center mt-3 pt-3 border-t border-blue-100/50">
                   <p className="text-[12px] font-bold text-slate-500">مطلوب دفعه:</p>
                   <p className="font-black text-emerald-600 text-[16px]">{formatMoney(selectedPayment?.amount)} ر.س</p>
                 </div>
               </div>

               <div className="space-y-4">
                 <label className="block text-[13px] font-extrabold text-slate-700">إرفاق إيصال أمر الدفع (إلزامي) <span className="text-red-500">*</span></label>
                 {receiptUrl ? (
                   <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-2xl flex items-center justify-between">
                     <span className="text-emerald-700 font-extrabold text-[12px] flex items-center gap-2"><CheckCircle2 size={16}/> تم إرفاق الإيصال</span>
                     <button type="button" onClick={() => setReceiptUrl('')} className="text-[11px] font-bold text-red-500 hover:underline">إلغاء المرفق</button>
                   </div>
                 ) : (
                   <label className={`border-2 border-dashed ${isUploading ? 'border-blue-400 bg-blue-50' : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'} rounded-2xl flex flex-col items-center justify-center p-8 transition-all cursor-pointer`}>
                      <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={handleFileUpload} disabled={isUploading} />
                      {isUploading ? (
                        <div className="flex flex-col items-center gap-3">
                          <div className="w-8 h-8 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin"></div>
                          <p className="text-[12px] font-bold text-blue-600">جاري الرفع...</p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-12 h-12 bg-white shadow-sm rounded-full flex items-center justify-center mb-2"><Upload size={20} className="text-slate-400" /></div>
                          <p className="text-[13px] font-extrabold text-slate-600">اضغط لرفع الإيصال للتوثيق</p>
                          <p className="text-[11px] font-bold text-slate-400">مسموح بـ ملفات PDF والصور</p>
                        </div>
                      )}
                   </label>
                 )}
               </div>

               <div className="pt-4 border-t border-slate-100">
                  <button disabled={!receiptUrl || isUploading || isSubmittingPay} type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[13px] px-8 py-3.5 rounded-xl transition-all shadow-lg shadow-emerald-200 hover:-translate-y-0.5 flex justify-center disabled:opacity-50 disabled:hover:translate-y-0">
                    {isSubmittingPay ? 'جاري الحفظ...' : 'تأكيد دفع الفاتورة'}
                  </button>
               </div>
            </form>
          </div>
        </div>
      )}

      {/* -------------------- FINANCE MODAL -------------------- */}
      {isFinanceModalOpen && selectedFinanceLoan && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md overflow-hidden border border-slate-100 animate-in slide-in-from-bottom-8">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h3 className="text-xl font-black text-slate-800 flex items-center gap-2">
                سداد الحوالة البنكية للموظف
              </h3>
              <button type="button" aria-label="إغلاق" disabled={isUploadingFinance || isSubmittingFinance} onClick={closeFinanceModal} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={submitFinanceApprove} className="p-8 space-y-6">
               <div className="bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100 mb-6 flex justify-between items-center">
                 <div>
                   <p className="text-[12px] font-black text-slate-500 mb-1">إجمالي المبلغ المحول:</p>
                   <p className="font-black text-emerald-600 text-[18px]">{formatMoney(selectedFinanceLoan.amount)} ر.س</p>
                 </div>
               </div>

               <div className="space-y-4">
                 <label className="block text-[13px] font-extrabold text-slate-700">إرفاق إيصال التحويل البنكي <span className="text-red-500">*</span></label>
                 {financeReceiptUrl ? (
                   <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-2xl flex items-center justify-between">
                     <span className="text-emerald-700 font-extrabold text-[12px] flex items-center gap-2"><CheckCircle2 size={16}/> تم إرفاق الإيصال</span>
                     <button type="button" onClick={() => setFinanceReceiptUrl('')} className="text-[11px] font-bold text-red-500 hover:underline">المرفق خطأ؟</button>
                   </div>
                 ) : (
                   <label className={`border-2 border-dashed ${isUploadingFinance ? 'border-blue-400 bg-blue-50' : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'} rounded-2xl flex flex-col items-center justify-center p-8 transition-all cursor-pointer`}>
                      <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={handleFinanceFileUpload} disabled={isUploadingFinance} />
                      {isUploadingFinance ? (
                        <div className="flex flex-col items-center gap-3">
                          <div className="w-8 h-8 rounded-full border-4 border-emerald-200 border-t-emerald-600 animate-spin"></div>
                          <p className="text-[12px] font-bold text-emerald-600">جاري الرفع...</p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-12 h-12 bg-white shadow-sm rounded-full flex items-center justify-center mb-2"><Upload size={20} className="text-slate-400" /></div>
                          <p className="text-[13px] font-extrabold text-slate-600">اضغط لرفع الإيصال</p>
                        </div>
                      )}
                   </label>
                 )}
               </div>

               <div className="pt-4 border-t border-slate-100">
                  <button disabled={!financeReceiptUrl || isUploadingFinance || isSubmittingFinance} type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[13px] px-8 py-3.5 rounded-xl transition-all shadow-lg shadow-emerald-200 hover:-translate-y-0.5 flex justify-center disabled:opacity-50">
                    {isSubmittingFinance ? 'جاري الحفظ...' : 'تأكيد إيداع السلفة'}
                  </button>
               </div>
            </form>
          </div>
        </div>
      )}

      {/* -------------------- RETURN PAYMENT MODAL -------------------- */}
      {isReturnModalOpen && selectedPayment && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md overflow-hidden border border-slate-100 animate-in slide-in-from-bottom-8">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-red-50/50">
              <h3 className="text-xl font-black text-slate-800 flex items-center gap-2">
                <RotateCcw className="text-red-500" size={22} /> رد السداد
              </h3>
              <button type="button" aria-label="إغلاق" disabled={isSubmittingReturn} onClick={() => setIsReturnModalOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition">
                <X size={18} />
              </button>
            </div>
            <div className="p-8 space-y-6">
               <div className="bg-red-50/50 p-4 rounded-2xl border border-red-100 mb-4">
                 <p className="text-[12px] font-black text-slate-500 mb-1">بيان السداد:</p>
                 <p className="font-extrabold text-red-900 text-[14px]">{selectedPayment?.title}</p>
                 <div className="flex justify-between items-center mt-3 pt-3 border-t border-red-100/50">
                   <p className="text-[12px] font-bold text-slate-500">المبلغ:</p>
                   <p className="font-black text-red-600 text-[16px]">{formatMoney(selectedPayment?.amount)} ر.س</p>
                 </div>
               </div>

               <div>
                 <label className="block text-[13px] font-extrabold text-slate-700 mb-2">سبب الاسترجاع <span className="text-red-500">*</span></label>
                 <textarea rows={3} value={returnReason} onChange={e => setReturnReason(e.target.value)} placeholder="مثال: انتهت صلاحية رقم السداد، تم إلغاء الفاتورة، خطأ في البيانات..."
                   className="w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-red-400 rounded-xl px-4 py-3 font-bold text-[13px] text-slate-800 outline-none transition resize-none"></textarea>
               </div>

               <div className="pt-4 border-t border-slate-100">
                  <button
                    type="button"
                    disabled={!returnReason.trim() || isSubmittingReturn}
                    onClick={handleReturnSubmit}
                    className="w-full bg-red-600 hover:bg-red-700 text-white font-extrabold text-[13px] px-8 py-3.5 rounded-xl transition-all shadow-lg shadow-red-200 hover:-translate-y-0.5 flex justify-center items-center gap-2 disabled:opacity-50 disabled:hover:translate-y-0">
                    <RotateCcw size={16} /> {isSubmittingReturn ? 'جاري الحفظ...' : 'تأكيد رد السداد'}
                  </button>
               </div>
            </div>
          </div>
        </div>
      )}

      {/* -------------------- OTHER FINANCIAL REQUESTS MODAL -------------------- */}
      {isOtherFinModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden border border-slate-100 animate-in slide-in-from-bottom-8">
            <div className="px-8 py-6 border-b border-indigo-100 flex items-center justify-between bg-gradient-to-r from-indigo-50 to-violet-50">
              <div>
                <h3 className="text-xl font-black text-indigo-900 flex items-center gap-2">
                  <FileSpreadsheet className="text-indigo-500" size={22} /> طلبات مالية أخرى
                </h3>
                <p className="text-indigo-600 font-bold text-[12px] mt-1">كشوفات حساب، تقارير مالية، صرف بدلات، وطلبات أخرى</p>
              </div>
              <button type="button" aria-label="إغلاق" onClick={() => setIsOtherFinModalOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-indigo-100 text-indigo-400 hover:text-indigo-600 transition">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleOtherFinSubmit} className="p-8 space-y-5">

              <div>
                <label className="block text-[13px] font-extrabold text-slate-700 mb-2">نوع الطلب المالي <span className="text-red-500">*</span></label>
                <select aria-label="نوع الطلب المالي" value={otherFinData.requestType} onChange={e => setOtherFinData({...otherFinData, requestType: e.target.value})} className="w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-indigo-400 rounded-xl px-4 py-3 font-bold text-[13px] text-slate-800 outline-none transition appearance-none">
                  <option value="BANK_STATEMENT">📄 طلب كشف حساب بنكي</option>
                  <option value="FINANCIAL_REPORT">📊 طلب تقرير مالي</option>
                  <option value="EXPENSE_REIMBURSEMENT">💰 صرف بدل أو تعويض مصروفات</option>
                  <option value="PETTY_CASH">🏦 طلب سحب من العهدة النثرية</option>
                  <option value="BUDGET_REQUEST">📋 طلب ميزانية أو اعتماد مالي</option>
                  <option value="OTHER">✉️ طلب مالي آخر</option>
                </select>
              </div>

              {(otherFinData.requestType === 'EXPENSE_REIMBURSEMENT' || otherFinData.requestType === 'PETTY_CASH' || otherFinData.requestType === 'BUDGET_REQUEST') && (
                <div>
                  <label className="block text-[13px] font-extrabold text-slate-700 mb-2">المبلغ المطلوب (ر.س)</label>
                  <input type="number" min="0" step="0.01" value={otherFinData.amount} onChange={e => setOtherFinData({...otherFinData, amount: e.target.value})} placeholder="0.00"
                    className="w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-indigo-400 rounded-xl px-4 py-3 font-black text-[14px] text-emerald-600 outline-none transition" />
                </div>
              )}

              <div>
                <label className="block text-[13px] font-extrabold text-slate-700 mb-2">تفاصيل الطلب <span className="text-red-500">*</span></label>
                <textarea required rows={4} value={otherFinData.description} onChange={e => setOtherFinData({...otherFinData, description: e.target.value})}
                  placeholder={otherFinData.requestType === 'BANK_STATEMENT' ? 'حدد الفترة المطلوبة واسم البنك...' : otherFinData.requestType === 'FINANCIAL_REPORT' ? 'حدد نوع التقرير والفترة الزمنية...' : otherFinData.requestType === 'EXPENSE_REIMBURSEMENT' ? 'اذكر تفاصيل المصروفات والمبررات...' : 'اكتب تفاصيل طلبك بالكامل...'}
                  className="w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-indigo-400 rounded-xl px-4 py-3 font-bold text-[13px] text-slate-800 outline-none transition resize-none placeholder:font-semibold placeholder:text-slate-400"></textarea>
              </div>

              <div>
                <label className="block text-[13px] font-extrabold text-slate-700 mb-2">الأولوية</label>
                <div className="flex gap-3">
                  <button type="button" onClick={() => setOtherFinData({...otherFinData, priority: 'NORMAL'})} className={`flex-1 py-3 rounded-xl font-bold text-[13px] border-2 transition-all ${otherFinData.priority === 'NORMAL' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'bg-slate-50 border-slate-100 text-slate-500 hover:border-slate-200'}`}>
                    🔵 طلب عادي
                  </button>
                  <button type="button" onClick={() => setOtherFinData({...otherFinData, priority: 'URGENT'})} className={`flex-1 py-3 rounded-xl font-bold text-[13px] border-2 transition-all ${otherFinData.priority === 'URGENT' ? 'bg-red-50 border-red-400 text-red-700' : 'bg-slate-50 border-slate-100 text-slate-500 hover:border-slate-200'}`}>
                    🔴 عاجل
                  </button>
                </div>
              </div>

              <div className="pt-4 flex items-center justify-between border-t border-slate-100 mt-2">
                <button type="button" onClick={() => setIsOtherFinModalOpen(false)} className="px-6 py-3 text-[13px] font-bold text-slate-500 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 transition">
                  إلغاء
                </button>
                <button type="submit" disabled={isSubmittingOtherFin} className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[13px] px-8 py-3 rounded-xl transition-all shadow-lg shadow-indigo-200 hover:-translate-y-0.5 flex items-center gap-2 disabled:opacity-50">
                  <Send size={16} />
                  {isSubmittingOtherFin ? 'جاري الإرسال...' : 'رفع الطلب المالي'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
