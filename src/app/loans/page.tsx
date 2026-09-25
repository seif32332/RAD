"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { PiggyBank, CheckCircle, Gift, AlertTriangle, Upload, X, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { LOAN_PENDING_STATUSES, LOAN_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';
import { formatDate } from '@/lib/dates';
import { formatMoney, roundMoney } from '@/lib/money';

interface LoanEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  basicSalary?: number | null;
  branch?: { nameArabic?: string | null } | null;
}

interface Loan {
  id: string;
  employeeId: string;
  employee?: LoanEmployee | null;
  amount: number;
  remainingAmount: number;
  monthlyInstallment: number;
  reason?: string | null;
  isForgiven?: boolean | null;
  status: string;
  isManagerApproved?: boolean | null;
  isHrApproved?: boolean | null;
  isFinanceTransferred?: boolean | null;
  receiptUrl?: string | null;
  createdAt: string;
}

const EMPTY_LOAN_FORM = {
  employeeId: '',
  policy: 'OPEN', // ONE_MONTH, TWO_MONTHS, PERCENTAGE, OPEN
  amount: '',
  monthlyInstallment: '',
  reason: '',
  percentage: '50'
};

/** Loans still in the approval chain (including the final HR confirmation after the transfer). */
const IN_APPROVAL_STATUSES: string[] = [...LOAN_PENDING_STATUSES, LOAN_STATUS.FINANCE_TRANSFERRED];
/** Finally approved loans whose installments run through payroll ('APPROVED' is a legacy value). */
const ACTIVE_STATUSES: string[] = [LOAN_STATUS.FINANCE_APPROVED, 'APPROVED'];
const CLOSED_STATUSES: string[] = [LOAN_STATUS.REJECTED, LOAN_STATUS.COMPLETED, LOAN_STATUS.FORGIVEN];

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const fullName = (e?: LoanEmployee | null) => `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim() || '—';

export default function LoansPage() {
  const { role } = useRole();
  // The transfer step (receipt upload) is finance-only on the server (403 for HR).
  const canFinance = roleIn(role, ROLE_GROUPS.FINANCE);
  const [employees, setEmployees] = useState<LoanEmployee[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Finance Modal State
  const [isFinanceModalOpen, setIsFinanceModalOpen] = useState(false);
  const [selectedFinanceLoan, setSelectedFinanceLoan] = useState<Loan | null>(null);
  const [financeReceiptUrl, setFinanceReceiptUrl] = useState('');
  const [isUploadingFinance, setIsUploadingFinance] = useState(false);
  const [isSubmittingFinance, setIsSubmittingFinance] = useState(false);

  // Form states
  const [loanForm, setLoanForm] = useState(EMPTY_LOAN_FORM);

  const fetchHubData = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setIsLoading(true);
    setLoadError(null);
    try {
      // Only the loans list (not every payroll / overtime / allowance of the hub).
      const res = await fetch('/api/payroll-hub?sections=loans');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل السلف'));
        return;
      }
      const json = await res.json();
      setLoans(Array.isArray(json?.loans) ? json.loans : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchEmployees = useCallback(async () => {
    try {
      const res = await fetch('/api/employees');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تحميل قائمة الموظفين'));
        return;
      }
      const d = await res.json();
      if (Array.isArray(d)) setEmployees(d);
    } catch {
      toast.error('تعذر تحميل قائمة الموظفين');
    }
  }, []);

  useEffect(() => {
    fetchEmployees();
    fetchHubData();
  }, [fetchEmployees, fetchHubData]);

  const selectedEmployee = employees.find(e => e.id === loanForm.employeeId);

  // Policy-derived amount (read-only unless the policy is OPEN).
  const salary = Number(selectedEmployee?.basicSalary) || 0;
  const policyAmount = (() => {
    if (!selectedEmployee) return '';
    if (loanForm.policy === 'ONE_MONTH') return String(roundMoney(salary));
    if (loanForm.policy === 'TWO_MONTHS') return String(roundMoney(salary * 2));
    if (loanForm.policy === 'PERCENTAGE') {
      const pct = parseFloat(loanForm.percentage);
      return Number.isFinite(pct) ? String(roundMoney((salary * pct) / 100)) : '';
    }
    return '';
  })();
  const effectiveAmount = loanForm.policy === 'OPEN' ? loanForm.amount : policyAmount;

  /** POST to the payroll hub; returns true on success (toasts the server message). */
  const postHub = async (body: Record<string, unknown>, successFallback: string): Promise<boolean> => {
    const res = await fetch('/api/payroll-hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) {
      redirectToLogin();
      return false;
    }
    if (!res.ok) {
      toast.error(await readApiError(res));
      return false;
    }
    const json = await res.json().catch(() => null);
    toast.success(typeof json?.message === 'string' ? json.message : successFallback);
    return true;
  };

  const handleAddLoan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const amount = parseFloat(effectiveAmount);
    const installment = parseFloat(loanForm.monthlyInstallment);
    if (!(amount > 0) || !(installment > 0)) {
      toast.error('الرجاء التأكد من صحة المبلغ والقسط');
      return;
    }
    if (installment > amount) {
      toast.error('لا يمكن أن يتجاوز القسط الشهري مبلغ السلفة');
      return;
    }
    setIsSubmitting(true);
    try {
      const ok = await postHub(
        { actionType: 'CREATE_LOAN', payload: { ...loanForm, amount: effectiveAmount } },
        'تم تسجيل السلفة بنجاح وإضافتها لحساب الموظف!'
      );
      if (ok) {
        setLoanForm(EMPTY_LOAN_FORM);
        await fetchHubData({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const runLoanAction = async (id: string, body: Record<string, unknown>, successFallback: string) => {
    setBusyId(id);
    try {
      if (await postHub(body, successFallback)) await fetchHubData({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  const handleForgiveLoan = async (id: string, name: string) => {
    if (!(await confirmDialog(`هل أنت متأكد من إسقاط (العفو عن) مديونية الموظف [ ${name} ] تبرعاً من الشركة؟\nهذا الإجراء لا يمكن التراجع عنه!`, { danger: true }))) return;
    await runLoanAction(id, { actionType: 'FORGIVE_LOAN', payload: { id } }, 'تم إسقاط السلفة بنجاح!');
  };

  const handleApproveLoan = async (id: string, level: string) => {
    if (!(await confirmDialog(`هل تؤكد الموافقة من طرف (${level})؟`))) return;
    await runLoanAction(id, { actionType: 'APPROVE_LOAN', payload: { id, level } }, 'تم اعتماد الطلب بنجاح');
  };

  const handleFinanceFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setIsUploadingFinance(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'فشل الرفع'));
        return;
      }
      const data = await res.json();
      const url = typeof data?.url === 'string' ? data.url : typeof data?.fileUrl === 'string' ? data.fileUrl : '';
      if (url) setFinanceReceiptUrl(url);
      else toast.error('فشل الرفع');
    } catch {
      toast.error('فشل الرفع');
    } finally {
      input.value = '';
      setIsUploadingFinance(false);
    }
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
      const ok = await postHub(
        { actionType: 'APPROVE_LOAN', payload: { id: selectedFinanceLoan.id, level: 'FINANCE', receiptUrl: financeReceiptUrl } },
        'تم تسجيل إيداع السلفة'
      );
      if (ok) {
        closeFinanceModal();
        await fetchHubData({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmittingFinance(false);
    }
  };

  const handleRejectLoan = async (id: string) => {
    if (!(await confirmDialog("هل أنت متأكد من رفض الطلب وإلغائه بالكامل؟", { danger: true }))) return;
    const reason = await promptDialog('سبب الرفض (اختياري)');
    await runLoanAction(id, { actionType: 'REJECT_LOAN', payload: reason?.trim() ? { id, reason: reason.trim() } : { id } }, 'تم رفض طلب السلفة');
  };

  const pendingLoans = loans.filter((l) => IN_APPROVAL_STATUSES.includes(l.status) && !l.isForgiven && l.remainingAmount > 0);
  const activeLoans = loans.filter((l) => ACTIVE_STATUSES.includes(l.status) && l.remainingAmount > 0 && !l.isForgiven);
  const pastLoans = loans.filter((l) => l.remainingAmount <= 0 || !!l.isForgiven || CLOSED_STATUSES.includes(l.status));

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-3xl font-black text-emerald-900 tracking-tight flex items-center gap-3">
              <span className="bg-emerald-100 text-emerald-600 p-3 rounded-2xl"><PiggyBank size={26} /></span>
              إدارة سياسات السلف والعُهَد المالية
            </h1>
            <p className="text-emerald-700 font-bold mt-3 text-[14px]">يتم قيد السلفة كمديونية على الموظف تُخصم أقساطها تلقائياً من المسير الشهري ما لم يتم إسقاطها من الإدارة.</p>
          </div>
        </div>

        {/* --- Form Section --- */}
        <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
           <form onSubmit={handleAddLoan} className="space-y-6">
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <SearchableSelect name="employeeId" value={loanForm.employeeId} onChange={(e) => setLoanForm({...loanForm, employeeId: e.target.value})} label="الموظف المستفيد من السلفة" required accentColor="emerald"
                   options={employees.map(e => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''}`, value: e.id }))} />
                
                <SearchableSelect name="policy" value={loanForm.policy} onChange={(e) => setLoanForm({...loanForm, policy: e.target.value})} label="سياسة وضوابط السلفة" required accentColor="emerald"
                   options={[
                     { label: 'راتب شهر واحد كحد أقصى', value: 'ONE_MONTH' },
                     { label: 'راتب شهرين كحد أقصى', value: 'TWO_MONTHS' },
                     { label: 'نسبة معينة من الراتب', value: 'PERCENTAGE' },
                     { label: 'مبلغ مفتوح (بدون سياسة محددة)', value: 'OPEN' },
                   ]} />
              </div>

              {selectedEmployee && (
                <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-xl flex items-center gap-3 animate-in fade-in">
                   <CheckCircle className="text-emerald-500" size={18} />
                   <p className="font-bold text-[13px] text-emerald-800">
                     الراتب الأساسي للموظف المحدد هو: <span className="font-black text-[15px]">{formatMoney(selectedEmployee.basicSalary || 0)} ر.س</span>
                   </p>
                </div>
              )}

              {loanForm.policy === 'PERCENTAGE' && (
                <div className="animate-in fade-in">
                  <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">النسبة المئوية (%) المسموح بها من الراتب</label>
                  <input type="number" min="1" max="100" required value={loanForm.percentage} onChange={(e) => setLoanForm({...loanForm, percentage: e.target.value})} className="w-full md:w-1/2 px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-emerald-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-50 transition-all text-right" dir="ltr" />
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-6 rounded-[1.5rem] border border-slate-100">
                 <div>
                    <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">إجمالي مبلغ السلفة المُعتمد (ر.س)</label>
                    <input type="number" step="0.01" required value={effectiveAmount} onChange={(e) => setLoanForm({...loanForm, amount: e.target.value})} readOnly={loanForm.policy !== 'OPEN'} className={`w-full px-5 py-4 bg-white border border-slate-200 focus:border-emerald-400 rounded-2xl font-black text-[16px] text-emerald-900 focus:outline-none focus:ring-4 focus:ring-emerald-50 transition-all text-left ${loanForm.policy !== 'OPEN' ? 'opacity-80 cursor-not-allowed bg-slate-100' : ''}`} dir="ltr" />
                 </div>
                 <div>
                    <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">القسط الشهري المُقسط (ر.س) للخصم الآلي</label>
                    <input type="number" step="0.01" required value={loanForm.monthlyInstallment} onChange={(e) => setLoanForm({...loanForm, monthlyInstallment: e.target.value})} className="w-full px-5 py-4 bg-white border border-emerald-200 focus:border-emerald-500 rounded-2xl font-black text-[16px] text-emerald-900 focus:outline-none focus:ring-4 focus:ring-emerald-100 transition-all text-left shadow-sm shadow-emerald-900/5" dir="ltr" />
                 </div>
              </div>

              <div>
                 <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">السبب التفصيلي للموافقة على السلفة</label>
                 <input type="text" placeholder="مثال: مساعدة زواج، ظروف طارئة..." value={loanForm.reason} onChange={(e) => setLoanForm({...loanForm, reason: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-emerald-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-emerald-50 transition-all" />
              </div>

              <div className="pt-4 border-t border-slate-100">
                 <button type="submit" disabled={isSubmitting || isLoading} className="w-full md:w-auto px-10 py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[15px] rounded-[1.25rem] transition disabled:opacity-50 shadow-lg shadow-emerald-600/20">{isSubmitting ? 'جاري الحفظ...' : 'تأكيد وإيداع السلفة كمديونية وحفظ الجدولة'}</button>
              </div>
           </form>
        </div>

        {loadError && (
          <div role="alert" className="bg-white border border-rose-200 rounded-[2rem] p-10 text-center flex flex-col items-center gap-4">
            <div className="bg-rose-50 p-4 rounded-full text-rose-500"><AlertTriangle size={32} /></div>
            <p className="font-black text-slate-800">{loadError}</p>
            <button type="button" onClick={() => fetchHubData()} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-black text-[13px] rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        )}

        {/* --- Pending Approvals List --- */}
        {!loadError && pendingLoans.length > 0 && (
        <div className="mb-12">
           <h3 className="font-extrabold text-2xl text-amber-600 mb-6 flex items-center gap-3">
              طلبات السلف المعلقة (بانتظار سلسلة الموافقات)
              <span className="bg-amber-100 text-amber-700 text-[12px] px-3 py-1 rounded-full animate-pulse">{pendingLoans.length}</span>
           </h3>
           <div className="grid grid-cols-1 gap-6">
             {pendingLoans.map((l) => (
               <div key={l.id} className="bg-white border-2 border-amber-200/60 p-6 rounded-[2rem] shadow-sm relative overflow-hidden">
                 <div className="flex justify-between items-start mb-6">
                    <div>
                      <h4 className="font-black text-[16px] text-slate-800">{fullName(l.employee)}</h4>
                      <p className="font-bold text-[12px] text-slate-400 mt-1">
                        #{l.employee?.employeeId} | مبرر الطلب: {l.reason || 'بدون مبرر'}
                      </p>
                    </div>
                    <div className="text-left bg-amber-50 px-4 py-2 rounded-2xl border border-amber-100">
                       <p className="font-black text-[18px] text-amber-900">{formatMoney(l.amount)} ر.س</p>
                    </div>
                 </div>

                 {/* Workflow UI */}
                 <div className="bg-slate-50 border border-slate-100 p-5 rounded-2xl mb-6 flex flex-col md:flex-row items-center justify-between gap-4">
                    {/* Level 1: Manager */}
                    <div className="flex-1 w-full text-center">
                       <button
                         type="button"
                         onClick={() => handleApproveLoan(l.id, 'MANAGER')}
                         disabled={!!l.isManagerApproved || busyId === l.id}
                         className={`w-full py-3 rounded-xl font-bold text-[12px] transition ${l.isManagerApproved ? 'bg-emerald-100 text-emerald-700 opacity-100 cursor-default shadow-inner' : 'bg-white border-2 border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600'}`}
                       >
                         {l.isManagerApproved ? '✓ تم (المدير المباشر)' : 'بانتظار (المدير المباشر)'}
                       </button>
                    </div>
                    <div className="hidden md:block w-8 h-0.5 bg-slate-200 shrink-0"></div>
                    {/* Level 2: HR */}
                    <div className="flex-1 w-full text-center">
                       <button
                         type="button"
                         onClick={() => handleApproveLoan(l.id, 'HR')}
                         disabled={!l.isManagerApproved || !!l.isHrApproved || busyId === l.id}
                         className={`w-full py-3 rounded-xl font-bold text-[12px] transition ${l.isHrApproved ? 'bg-emerald-100 text-emerald-700 opacity-100 cursor-default shadow-inner' : (!l.isManagerApproved ? 'bg-slate-100 text-slate-300 cursor-not-allowed' : 'bg-white border-2 border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600')}`}
                       >
                         {l.isHrApproved ? '✓ تم (الموارد البشرية)' : 'بانتظار (الموارد البشرية)'}
                       </button>
                    </div>
                    <div className="hidden md:block w-8 h-0.5 bg-slate-200 shrink-0"></div>
                    {/* Level 3: Finance */}
                    <div className="flex-1 w-full text-center">
                       <button
                         type="button"
                         onClick={() => {
                           if (!l.isFinanceTransferred) {
                             setSelectedFinanceLoan(l);
                             setIsFinanceModalOpen(true);
                           }
                         }}
                         disabled={!l.isHrApproved || !!l.isFinanceTransferred || !canFinance || busyId === l.id}
                         title={!canFinance && !l.isFinanceTransferred ? 'التحويل من صلاحية الإدارة المالية' : undefined}
                         className={`w-full py-3 rounded-xl font-bold text-[11px] transition ${l.isFinanceTransferred ? 'bg-emerald-100 text-emerald-700 opacity-100 cursor-default shadow-inner' : (!l.isHrApproved || !canFinance ? 'bg-slate-100 text-slate-300 cursor-not-allowed' : 'bg-white border-2 border-emerald-200 text-emerald-600 hover:bg-emerald-600 hover:text-white hover:shadow-lg hover:shadow-emerald-600/20')}`}
                       >
                         {l.isFinanceTransferred ? '✓ تم (المالية)' : 'إرفاق إيصال الدفع (المالية)'}
                       </button>
                    </div>
                    <div className="hidden md:block w-8 h-0.5 bg-slate-200 shrink-0"></div>
                    {/* Level 4: HR Final */}
                    <div className="flex-1 w-full text-center flex flex-col gap-2">
                       <button
                         type="button"
                         onClick={() => handleApproveLoan(l.id, 'HR_FINAL')}
                         disabled={!l.isFinanceTransferred || busyId === l.id}
                         className={`w-full py-3 rounded-xl font-bold text-[11px] transition ${!l.isFinanceTransferred ? 'bg-slate-100 text-slate-300 cursor-not-allowed' : 'bg-emerald-600 border border-emerald-700 text-white hover:bg-emerald-700 shadow-md font-extrabold flex items-center justify-center gap-1.5'}`}
                       >
                         {l.isFinanceTransferred ? <><CheckCircle size={14}/> تأكيد واستلام الحوالة</> : 'بانتظار تأكيد استلام (الموارد)'}
                       </button>
                       {l.isFinanceTransferred && l.receiptUrl && (
                          <a href={l.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold text-blue-600 underline text-center">عرض إيصال التحويل البنكي</a>
                       )}
                    </div>
                 </div>

                 <div className="flex justify-end border-t border-slate-100 pt-4">
                   <button type="button" disabled={busyId === l.id} onClick={() => handleRejectLoan(l.id)} className="text-[12px] font-black text-rose-500 bg-rose-50 hover:bg-rose-100 px-5 py-2 rounded-xl transition disabled:opacity-50">رفض وإلغاء الطلب</button>
                 </div>
               </div>
             ))}
           </div>
        </div>
        )}

        {/* --- Active Loans List --- */}
        {!loadError && (
        <div>
           <h3 className="font-extrabold text-2xl text-slate-800 mb-6 flex items-center gap-3">
              السُلف والمديونيات النشطة (للمعتمدة نهائياً)
              <span className="bg-slate-200 text-slate-600 text-[12px] px-3 py-1 rounded-full">{activeLoans.length}</span>
           </h3>
           <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
             {isLoading ? (
                <div className="col-span-full py-10 text-center animate-pulse text-slate-400 font-bold">جاري تحميل المديونيات...</div>
             ) : activeLoans.length === 0 ? (
                <div className="col-span-full py-12 text-center text-slate-500 font-bold bg-white border border-slate-200 rounded-[2rem]">كل الموظفين مخلى طرفهم، ولا توجد مديونيات معلقة.</div>
             ) : activeLoans.map((l) => (
               <div key={l.id} className="bg-white border border-slate-200 p-6 rounded-[2rem] shadow-sm hover:shadow-lg hover:shadow-emerald-900/5 transition duration-300">
                 <div className="flex justify-between items-start mb-6">
                    <div>
                      <h4 className="font-black text-[16px] text-slate-800">{fullName(l.employee)}</h4>
                      <p className="font-bold text-[12px] text-slate-400 mt-1">
                        #{l.employee?.employeeId} | {l.employee?.branch?.nameArabic || 'الفرع الرئيسي'}
                      </p>
                    </div>
                    <div className="text-left bg-emerald-50 px-4 py-2 rounded-2xl border border-emerald-100">
                       <p className="text-[10px] font-black text-emerald-600 mb-0.5">القيمة الإجمالية</p>
                       <p className="font-black text-[18px] text-emerald-900">{formatMoney(l.amount)} ر.س</p>
                    </div>
                 </div>

                 <div className="bg-slate-50 rounded-2xl p-4 grid grid-cols-2 gap-y-4 mb-6">
                   <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">المبلغ المتبقي</p>
                      <p className="font-black text-[14px] text-rose-600 flex items-center gap-1.5"><AlertTriangle size={14}/> {formatMoney(l.remainingAmount)} ر.س</p>
                   </div>
                   <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">الاستقطاع الشهري</p>
                      <p className="font-black text-[14px] text-slate-700">{formatMoney(l.monthlyInstallment)} ر.س</p>
                   </div>
                   <div className="col-span-2">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">تبرير الإدارة</p>
                      <p className="font-bold text-[12px] inline-block bg-white border border-slate-200 p-2 rounded-lg text-slate-600 w-full">{l.reason || 'بدون سبب'}</p>
                   </div>
                 </div>

                 <div className="border-t border-slate-100 pt-5">
                   <button
                     type="button"
                     disabled={busyId === l.id}
                     onClick={() => handleForgiveLoan(l.id, fullName(l.employee))}
                     className="w-full flex justify-center items-center gap-2 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold px-6 py-3.5 rounded-xl transition-all disabled:opacity-50"
                   >
                     <Gift size={18} /> العفو عن السلفة وإسقاط المديونية المتبقية للموظف!
                   </button>
                 </div>
               </div>
             ))}
           </div>
        </div>
        )}

        {/* --- Forgiven & Paid Loans Log --- */}
        {!loadError && pastLoans.length > 0 && (
          <div>
            <h3 className="font-extrabold text-xl text-slate-800 mb-6 border-t border-slate-200 pt-8 flex items-center gap-3">
              أرشيف السُلف المنتهية / والمُسقطة بقرار الإدارة
            </h3>
            <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
               <table className="w-full text-right border-collapse">
                 <thead>
                   <tr className="bg-slate-50 border-b border-slate-100">
                     <th className="p-4 text-[13px] font-black text-slate-500">الموظف المقترض</th>
                     <th className="p-4 text-[13px] font-black text-slate-500">المبلغ الإجمالي</th>
                     <th className="p-4 text-[13px] font-black text-slate-500">الحالة النهائية</th>
                     <th className="p-4 text-[13px] font-black text-slate-500">تاريخ التسجيل</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-slate-100">
                   {pastLoans.map((l) => (
                     <tr key={l.id} className="hover:bg-slate-50 transition">
                       <td className="p-4 font-bold text-slate-800 text-[14px]">{fullName(l.employee)} <span className="text-slate-400 block mt-1 text-[11px]">#{l.employee?.employeeId}</span></td>
                       <td className="p-4 font-black text-slate-700 text-[14px]">{formatMoney(l.amount)} ر.س</td>
                       <td className="p-4">
                         {l.status === LOAN_STATUS.REJECTED ? (
                           <span className="bg-rose-100 text-rose-800 border border-rose-200 px-3 py-1.5 rounded-lg text-[11px] font-black inline-flex items-center gap-1"><AlertTriangle size={14}/> مرفوضة كلياً</span>
                         ) : (l.isForgiven || l.status === LOAN_STATUS.FORGIVEN) ? (
                           <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 px-3 py-1.5 rounded-lg text-[11px] font-black inline-flex items-center gap-1"><Gift size={14}/> مُسقطة بعفو الإدارة</span>
                         ) : (
                           <span className="bg-slate-100 text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg text-[11px] font-black inline-flex items-center gap-1"><CheckCircle size={14}/> مُسددة بالكامل</span>
                         )}
                       </td>
                       <td className="p-4 font-bold text-slate-500 text-[12px]">{formatDate(l.createdAt)}</td>
                     </tr>
                   ))}
                 </tbody>
               </table>
            </div>
          </div>
        )}
      </div>

      {/* Finance Modal */}
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
                     <span className="text-emerald-700 font-extrabold text-[12px] flex items-center gap-2"><CheckCircle size={16}/> تم إرفاق الإيصال</span>
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

    </DashboardLayout>
  );
}
