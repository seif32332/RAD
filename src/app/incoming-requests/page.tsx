"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, CheckCircle, XCircle, Filter, Briefcase, ArrowDownToLine, UsersRound, Receipt, PiggyBank, UserMinus, ClipboardCheck, Building2, Crown, CalendarDays, Plane, MapPin, AlertTriangle, MonitorSmartphone, AlertCircle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import Modal from '@/components/ui/Modal';
import { redirectToLogin } from '@/app/portal/_components/redirect-to-login';
import { addDays, dateKey, formatDate } from '@/lib/dates';
import { SAUDI_BANKS } from '@/lib/banks';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';

/** Minimum length of a rejection reason (sent to the API and kept with the request / audit log). */
const REJECT_REASON_MIN = 3;

interface VacantAssetOption {
  id: string;
  assetType: string;
  description?: string | null;
  /** The asset type mentions the requested type (listed first). */
  matchesType?: boolean;
}

interface RequestCustomData {
  /** Leave: false for leave types that do not consume the annual balance (the card hides the balance). */
  usesAnnualBalance?: boolean | null;
  // Asset request
  status?: string | null;
  requestedForTerminated?: boolean | null;
  /** Purchasing stage only: warehouse assets that can be handed over instead of buying. */
  vacantAssets?: VacantAssetOption[] | null;
  leaveTypeMap?: string | null;
  totalDays?: number | string | null;
  notes?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isOutsideKSA?: boolean | null;
  availableBalance?: number | string | null;
  unpaidDays?: number | string | null;
  acceptUnpaidExtraDays?: boolean | null;
  /** Leave: the employee has a direct manager who has not approved yet. */
  isManagerApproved?: boolean | null;
  awaitingManagerApproval?: boolean | null;
  // Onboarding request record
  fullNameArabic?: string | null;
  lastNameArabic?: string | null;
  iqamaOrIdNumber?: string | null;
  mobileNumber?: string | null;
  jobTitle?: string | null;
  dateOfBirth?: string | null;
  iqamaOrIdExp?: string | null;
  joinDate?: string | null;
  basicSalary?: number | string | null;
  bankName?: string | null;
  ibanNumber?: string | null;
  iqamaCopyUrl?: string | null;
  passportCopyUrl?: string | null;
  ibanCertificateUrl?: string | null;
  resumeUrl?: string | null;
}

interface IncomingRequest {
  id: string;
  dbId: string;
  empDbId?: string | null;
  type: string;
  title: string;
  employeeName?: string | null;
  employeeId?: string | null;
  department?: string | null;
  createdAt: string;
  details?: string | null;
  customData?: RequestCustomData | null;
}

type Tab = 'EMPLOYEE' | 'MANAGER' | 'DEPT_MANAGER' | 'OWNER';

/** FULL: HR; FINANCE: finance/payroll items only; PURCHASING: asset requests at the purchasing stage. */
type HubScope = 'FULL' | 'FINANCE' | 'PURCHASING';

interface RequestsData {
  scope?: HubScope;
  employeeRequests: IncomingRequest[];
  managerRequests: IncomingRequest[];
  deptManagerRequests: IncomingRequest[];
  ownerRequests: IncomingRequest[];
}

/** Editable onboarding fields sent back to the API when HR approves an onboarding request. */
interface OnboardingEdit {
  fullNameArabic: string;
  lastNameArabic: string;
  iqamaOrIdNumber: string;
  mobileNumber: string;
  jobTitle: string;
  basicSalary: number;
  bankName: string;
  ibanNumber: string;
  /** 'YYYY-MM-DD' or '' (empty = HR leaves it; the server then uses today() and flags it). */
  dateOfBirth: string;
  iqamaOrIdExp: string;
  joinDate: string;
}

interface ActionResponse {
  message?: string;
  /** Onboarding approval: required dates filled with a placeholder that HR must complete. */
  warning?: string | null;
}

const EMPTY_DATA: RequestsData = { employeeRequests: [], managerRequests: [], deptManagerRequests: [], ownerRequests: [] };

const TAB_STYLE: Record<Tab, { badge: string; icon: React.ReactNode; tab: string }> = {
  EMPLOYEE: { badge: 'bg-blue-50 text-blue-600', icon: <UsersRound size={20} />, tab: 'bg-blue-50 text-blue-700 border-b-4 border-blue-500' },
  MANAGER: { badge: 'bg-purple-50 text-purple-600', icon: <Briefcase size={20} />, tab: 'bg-purple-50 text-purple-700 border-b-4 border-purple-500' },
  DEPT_MANAGER: { badge: 'bg-teal-50 text-teal-600', icon: <Building2 size={20} />, tab: 'bg-teal-50 text-teal-700 border-b-4 border-teal-500' },
  OWNER: { badge: 'bg-amber-50 text-amber-600', icon: <Crown size={20} />, tab: 'bg-amber-50 text-amber-700 border-b-4 border-amber-500' },
};

const TYPE_OPTIONS: Record<Tab, { label: string; value: string }[]> = {
  EMPLOYEE: [
    { label: 'جميع الطلبات', value: 'ALL' },
    { label: 'طلبات الإجازات', value: 'LEAVE' },
    { label: 'طلبات السلف', value: 'LOAN' },
    { label: 'إنهاء العقد/الاستقالة', value: 'TERMINATION' },
    { label: 'تصحيح البصمة', value: 'ATTENDANCE_CORRECTION' },
  ],
  MANAGER: [
    { label: 'جميع الطلبات', value: 'ALL' },
    { label: 'العمل الإضافي', value: 'OVERTIME' },
    { label: 'المهام والانتدابات', value: 'WORK_ASSIGNMENT' },
    { label: 'المخالفات والجزاءات', value: 'DEDUCTION' },
    { label: 'مباشرة العمل', value: 'RETURN_NOTICE' },
    { label: 'مباشرة موظف جديد', value: 'ONBOARDING' },
  ],
  DEPT_MANAGER: [
    { label: 'جميع الطلبات', value: 'ALL' },
    { label: 'احتياج وظيفي', value: 'HIRING' },
    { label: 'النقل الداخلي', value: 'TRANSFER' },
    { label: 'طلبات العهد والأجهزة', value: 'ASSET_REQUEST' },
  ],
  OWNER: [
    { label: 'جميع الطلبات', value: 'ALL' },
    { label: 'توجيهات الإدارة', value: 'OWNER_REQUEST' },
  ],
};

interface NavLink { href: string; label: string; icon: React.ReactNode; color: string }

function getNavigationLink(req: IncomingRequest): NavLink | null {
  const emp = encodeURIComponent(req.empDbId || '');
  switch (req.type) {
    case 'LEAVE': {
      const cd = req.customData || {};
      const start = dateKey(cd.startDate) ?? '';
      const end = dateKey(cd.endDate) ?? '';
      const lastWorkDay = cd.startDate ? dateKey(addDays(new Date(`${start}T00:00:00.000Z`), -1)) ?? '' : '';
      const params = new URLSearchParams({
        employeeId: req.empDbId || '',
        ls: start,
        le: end,
        rd: String(cd.totalDays ?? ''),
        outside: cd.isOutsideKSA ? '1' : '0',
        lwd: lastWorkDay,
        unpaid: String(cd.unpaidDays ?? '0'),
        acceptExcess: cd.acceptUnpaidExtraDays ? '1' : '0',
        type: 'LEAVE_SETTLEMENT',
      });
      return { href: `/settlements/new?${params.toString()}`, label: 'الانتقال لتصفية المستحقات', icon: <Receipt size={16} />, color: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-600 hover:text-white' };
    }
    case 'TERMINATION':
      return { href: `/settlements/new?employeeId=${emp}`, label: 'الانتقال لتصفية نهاية الخدمة', icon: <UserMinus size={16} />, color: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-600 hover:text-white' };
    case 'LOAN':
      return { href: '/loans', label: 'الانتقال لإدارة السلف', icon: <PiggyBank size={16} />, color: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-600 hover:text-white' };
    case 'OVERTIME':
      return { href: '/payrolls', label: 'الانتقال لمسير الرواتب', icon: <Receipt size={16} />, color: 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-600 hover:text-white' };
    case 'DEDUCTION':
      return { href: '/payrolls', label: 'الانتقال للجزاءات والمخالفات', icon: <ClipboardCheck size={16} />, color: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-600 hover:text-white' };
    case 'WORK_ASSIGNMENT':
      return { href: '/overtimes', label: 'الانتقال للتكليفات', icon: <Briefcase size={16} />, color: 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-600 hover:text-white' };
    case 'HIRING':
      return { href: '/recruitment', label: 'الانتقال لإدارة التوظيف', icon: <Users size={16} />, color: 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-600 hover:text-white' };
    case 'ASSET_REQUEST':
      return { href: '/assets', label: 'الانتقال لإدارة العهد', icon: <MonitorSmartphone size={16} />, color: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-600 hover:text-white' };
    default:
      return null;
  }
}

function toEdit(cd: RequestCustomData | null | undefined): OnboardingEdit {
  return {
    fullNameArabic: cd?.fullNameArabic ?? '',
    lastNameArabic: cd?.lastNameArabic ?? '',
    iqamaOrIdNumber: cd?.iqamaOrIdNumber ?? '',
    mobileNumber: cd?.mobileNumber ?? '',
    jobTitle: cd?.jobTitle ?? '',
    basicSalary: Number(cd?.basicSalary ?? 0) || 0,
    bankName: cd?.bankName ?? '',
    ibanNumber: cd?.ibanNumber ?? '',
    dateOfBirth: dateKey(cd?.dateOfBirth) ?? '',
    iqamaOrIdExp: dateKey(cd?.iqamaOrIdExp) ?? '',
    joinDate: dateKey(cd?.joinDate) ?? '',
  };
}

const INPUT = 'w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 font-bold text-slate-700 outline-none focus:border-indigo-400';

/** Why the approve button is disabled on this card (null when it can be approved). */
function approveBlockReason(req: IncomingRequest, canSkipManager: boolean): string | null {
  const cd = req.customData;
  // The server refuses HR approval before the direct manager (409); the owner may skip that step.
  if (req.type === 'LEAVE' && cd?.awaitingManagerApproval && !canSkipManager) {
    return 'لا يمكن الاعتماد قبل موافقة المدير المباشر على الطلب.';
  }
  if (req.type === 'ASSET_REQUEST' && cd?.status === 'PENDING_PURCHASING' && cd.requestedForTerminated) {
    return 'الموظف منتهية خدمته، فلا تُسلَّم له عهدة. يمكنك رفض الطلب.';
  }
  return null;
}

export default function IncomingRequestsPage() {
  const { role } = useRole();
  // SUPER_ADMIN / COMPANY_ADMIN may approve a leave without the direct manager's step (as the API does).
  const canSkipManager = roleIn(role, ROLE_GROUPS.OWNER);
  const [data, setData] = useState<RequestsData>(EMPTY_DATA);
  // Purchasing stage of an asset request: choose between a warehouse asset and a new purchase.
  const [fulfilReq, setFulfilReq] = useState<IncomingRequest | null>(null);
  const [fulfilAssetId, setFulfilAssetId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('EMPLOYEE');
  const [filterType, setFilterType] = useState('ALL');
  const [approvedItems, setApprovedItems] = useState<Record<string, IncomingRequest>>({});
  const [expandedReqId, setExpandedReqId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Onboarding review & edit
  const [reviewModalReq, setReviewModalReq] = useState<IncomingRequest | null>(null);
  const [editedData, setEditedData] = useState<OnboardingEdit>(toEdit(null));

  const fetchRequests = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setIsLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch('/api/incoming-requests', { cache: 'no-store' });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل الطلبات الواردة');
        if (opts.silent) toast.error(msg);
        else setLoadError(msg);
        return;
      }
      const json = (await res.json()) as Partial<RequestsData>;
      // The purchasing agent only gets asset requests (department-manager tab).
      if (json.scope === 'PURCHASING') setActiveTab('DEPT_MANAGER');
      setData({
        scope: json.scope,
        employeeRequests: json.employeeRequests || [],
        managerRequests: json.managerRequests || [],
        deptManagerRequests: json.deptManagerRequests || [],
        ownerRequests: json.ownerRequests || [],
      });
    } catch {
      if (opts.silent) toast.error('تعذر الاتصال بالخادم');
      else setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      if (!opts.silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  /**
   * Returns true when the action succeeded. A rejection always asks for a reason (sent to the API).
   * `opts.confirmed` skips the confirmation (the caller already showed its own dialog).
   */
  const handleAction = async (
    req: IncomingRequest,
    actionType: 'APPROVE' | 'REJECT',
    updatedData?: OnboardingEdit,
    opts: { existingAssetId?: string; confirmed?: boolean } = {},
  ): Promise<boolean> => {
    if (busyId) return false;
    let reason: string | undefined;
    if (actionType === 'REJECT') {
      const input = await promptDialog(`سبب رفض ${req.title}${req.employeeName ? ` (${req.employeeName})` : ''}`, {
        title: 'رفض الطلب',
        confirmText: 'رفض الطلب',
        danger: true,
        placeholder: 'اكتب سبب الرفض بوضوح',
      });
      if (input === null) return false;
      reason = input.trim();
      if (reason.length < REJECT_REASON_MIN) {
        toast.error(`سبب الرفض مطلوب (${REJECT_REASON_MIN} أحرف على الأقل)`);
        return false;
      }
    } else if (!updatedData && !opts.confirmed) {
      const ok = await confirmDialog('تأكيد الموافقة والاعتماد؟');
      if (!ok) return false;
    }
    setBusyId(req.id);
    try {
      const res = await fetch('/api/incoming-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType,
          type: req.type,
          dbId: req.dbId,
          updatedData,
          ...(reason ? { reason } : {}),
          ...(opts.existingAssetId ? { existingAssetId: opts.existingAssetId } : {}),
        }),
      });
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ في تنفيذ الإجراء'));
        return false;
      }
      const result = (await res.json().catch(() => ({}))) as ActionResponse;
      if (result.warning) toast.warning(result.warning);
      if (actionType === 'APPROVE') {
        toast.success(result.message || 'تم اعتماد الطلب بنجاح');
        setApprovedItems((prev) => ({ ...prev, [req.id]: req }));
      } else {
        toast.success(result.message || 'تم رفض الطلب');
        await fetchRequests({ silent: true });
      }
      return true;
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const currentList = activeTab === 'EMPLOYEE' ? data.employeeRequests
    : activeTab === 'MANAGER' ? data.managerRequests
      : activeTab === 'DEPT_MANAGER' ? data.deptManagerRequests
        : data.ownerRequests;
  const filteredList = filterType === 'ALL' ? currentList : currentList.filter((r) => r.type === filterType);

  const isPurchasingScope = data.scope === 'PURCHASING';
  const allTabs: { id: Tab; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'EMPLOYEE', label: 'طلبات الموظفين', icon: <Users size={16} />, count: data.employeeRequests.length },
    { id: 'MANAGER', label: 'طلبات المدراء المباشرين', icon: <Briefcase size={16} />, count: data.managerRequests.length },
    {
      id: 'DEPT_MANAGER',
      label: isPurchasingScope ? 'طلبات العهد بانتظار المشتريات' : 'طلبات مدير القسم',
      icon: <Building2 size={16} />,
      count: data.deptManagerRequests.length,
    },
    { id: 'OWNER', label: 'طلبات صاحب العمل', icon: <Crown size={16} />, count: data.ownerRequests.length },
  ];
  const tabs = isPurchasingScope ? allTabs.filter((t) => t.id === 'DEPT_MANAGER') : allTabs;

  /** Approve click: the purchasing stage of an asset request first asks how it is fulfilled. */
  const onApproveClick = (req: IncomingRequest) => {
    if (req.type === 'ASSET_REQUEST' && req.customData?.status === 'PENDING_PURCHASING') {
      setFulfilAssetId('');
      setFulfilReq(req);
      return;
    }
    void handleAction(req, 'APPROVE');
  };

  const submitFulfilment = async () => {
    if (!fulfilReq) return;
    const ok = await handleAction(fulfilReq, 'APPROVE', undefined, {
      confirmed: true,
      ...(fulfilAssetId ? { existingAssetId: fulfilAssetId } : {}),
    });
    if (ok) setFulfilReq(null);
  };
  const fulfilOptions = fulfilReq?.customData?.vacantAssets ?? [];

  const reviewAttachments = reviewModalReq?.customData;

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10 w-full">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-blue-100 text-blue-600 p-3 rounded-2xl"><ArrowDownToLine size={26} /></span>
              الطلبات الواردة (إدارة العمليات)
            </h1>
            <p className="text-slate-500 font-bold mt-2 text-[14px]">
              {isPurchasingScope
                ? 'طلبات العهد التي اعتمدتها الإدارة وتنتظر الصرف من المستودع أو الشراء.'
                : 'إدارة الطلبات المرفوعة من الموظفين والمدراء وصاحب العمل للموارد البشرية.'}
            </p>
          </div>

          {!isPurchasingScope && (
            <Link href="/incoming-requests/archive" className="shrink-0 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black px-6 py-4 rounded-xl flex items-center gap-3 transition">
              سجل أرشيف الطلبات المكتملة
            </Link>
          )}
        </div>

        {/* Tabs */}
        <div role="tablist" className="flex flex-wrap gap-3 border-b-2 border-slate-100 pb-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              onClick={() => { setActiveTab(t.id); setFilterType('ALL'); }}
              className={`px-5 py-3 rounded-t-xl font-black text-[13px] flex gap-2 items-center transition-all ${activeTab === t.id ? TAB_STYLE[t.id].tab : 'text-slate-400 hover:text-slate-600'}`}
            >
              {t.icon} {t.label}
              <span className="bg-white rounded-full px-2 text-[11px]">{t.count}</span>
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-4 items-center bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
          <label htmlFor="type-filter" className="flex items-center gap-2 text-slate-500 font-bold">
            <Filter size={18} /> تصفية حسب القسم:
          </label>
          <select
            id="type-filter"
            className="bg-slate-50 border border-slate-200 text-slate-700 font-bold px-4 py-2 rounded-xl focus:outline-none focus:border-blue-400 flex-1 w-full md:max-w-xs"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            {TYPE_OPTIONS[activeTab].map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="text-center py-20 text-slate-400 font-bold animate-pulse">جاري تحميل الطلبات الواردة...</div>
        ) : loadError ? (
          <div className="bg-white rounded-[2rem] border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4">
            <AlertCircle size={40} className="text-rose-400" />
            <p className="text-slate-600 font-bold">{loadError}</p>
            <button type="button" onClick={() => void fetchRequests()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-black text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : filteredList.length === 0 ? (
          <div className="bg-white rounded-[2rem] border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center shadow-sm">
            <div className="bg-slate-50 w-24 h-24 rounded-full flex items-center justify-center mb-6 text-slate-300 shadow-inner">
              <CheckCircle size={40} />
            </div>
            <h2 className="text-xl font-black text-slate-700 mb-2">لا توجد طلبات واردة حالياً</h2>
            <p className="text-slate-500 font-bold">لقد قمت بإنجاز كافة الطلبات، لا يوجد شيء يتطلب انتباهك.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {filteredList.map((req) => {
              const approved = approvedItems[req.id];
              const navLink = approved ? getNavigationLink(approved) : null;
              const tc = TAB_STYLE[activeTab];
              const cd = req.customData;
              const isBusy = busyId === req.id;
              const unpaid = Number(cd?.unpaidDays ?? 0) || 0;
              const balance = cd?.availableBalance != null ? Number(cd.availableBalance) : null;
              const blockReason = approveBlockReason(req, canSkipManager);
              const isPurchasingStage = req.type === 'ASSET_REQUEST' && cd?.status === 'PENDING_PURCHASING';

              return (
                <div key={req.id} className={`bg-white rounded-[1.5rem] p-6 border-2 shadow-sm hover:shadow-md transition-all flex flex-col justify-between ${approved ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-100'} ${isBusy ? 'opacity-60' : ''}`}>
                  <div>
                    <div className="flex justify-between items-start gap-2 mb-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`px-3 py-1.5 rounded-xl text-[11px] font-black ${approved ? 'bg-emerald-100 text-emerald-700' : tc.badge}`}>
                          {approved ? '✅ تم الاعتماد' : req.title}
                        </span>
                        {!approved && cd?.awaitingManagerApproval && (
                          <span className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
                            <AlertTriangle size={12} /> بانتظار موافقة المدير المباشر
                          </span>
                        )}
                        {!approved && req.type === 'ASSET_REQUEST' && cd?.requestedForTerminated && (
                          <span className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1">
                            <AlertTriangle size={12} /> الموظف منتهي الخدمة
                          </span>
                        )}
                      </div>
                      <span className="text-slate-400 font-bold text-[11px] shrink-0">{formatDate(req.createdAt)}</span>
                    </div>

                    <div className="flex items-start gap-4 mb-3">
                      <div className={`w-10 h-10 rounded-full flex justify-center items-center ${approved ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                        {approved ? <CheckCircle size={20} /> : tc.icon}
                      </div>
                      <div>
                        <h3 className="font-extrabold text-[15px] text-slate-800">{req.employeeName}</h3>
                        <p className="text-[12px] font-bold text-slate-400 mt-1">الرقم الوظيفي: {req.employeeId} | الإدارة: {req.department}</p>
                      </div>
                    </div>

                    <div className="bg-slate-50 border border-slate-100 p-4 rounded-xl mt-4 mb-4">
                      <p className="font-bold text-slate-700 text-[13px] leading-relaxed whitespace-pre-line">
                        {req.details}
                      </p>
                    </div>

                    {cd && (
                      <div className="mb-4">
                        {req.type === 'LEAVE' && (
                          <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-4 space-y-2.5">
                            <div className="flex items-center gap-2 mb-3">
                              <CalendarDays size={16} className="text-blue-600" />
                              <span className="font-black text-blue-800 text-[13px]">تفاصيل طلب الإجازة</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[12px]">
                              <InfoCell label="نوع الإجازة:" value={cd.leaveTypeMap || 'سنوية'} valueClass="text-blue-700" />
                              <InfoCell label="عدد الأيام:" value={`${cd.totalDays ?? '-'} يوم`} valueClass="text-blue-700" />
                              <InfoCell label="من تاريخ:" value={formatDate(cd.startDate)} valueClass="text-slate-700" />
                              <InfoCell label="إلى تاريخ:" value={formatDate(cd.endDate)} valueClass="text-slate-700" />
                              <div className="flex justify-between bg-white p-2 rounded-lg">
                                <span className="font-bold text-slate-500">الوجهة:</span>
                                <span className={`font-black flex items-center gap-1 ${cd.isOutsideKSA ? 'text-amber-600' : 'text-emerald-600'}`}>
                                  {cd.isOutsideKSA ? <><Plane size={12} /> خارج المملكة</> : <><MapPin size={12} /> داخل المملكة</>}
                                </span>
                              </div>
                              {cd.usesAnnualBalance !== false && (
                                <InfoCell label="الرصيد السنوي المتاح:" value={balance != null && Number.isFinite(balance) ? `${balance.toFixed(0)} يوم` : '-'} valueClass="text-emerald-700" />
                              )}
                            </div>
                            {(unpaid > 0 || cd.acceptUnpaidExtraDays) && (
                              <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 p-3 rounded-lg">
                                <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
                                <div className="text-[11px]">
                                  <span className="font-black text-amber-800">أيام زائدة عن الرصيد: {unpaid} يوم</span>
                                  {cd.acceptUnpaidExtraDays && <span className="block font-bold text-amber-600 mt-1">✓ تم الموافقة على خصم تكلفة الأيام الزائدة</span>}
                                </div>
                              </div>
                            )}
                            {cd.notes && (
                              <div className="mt-2 bg-white p-2 rounded-lg">
                                <span className="font-bold text-slate-500 text-[11px]">ملاحظات: </span>
                                <span className="font-bold text-slate-700 text-[11px]">{cd.notes}</span>
                              </div>
                            )}
                          </div>
                        )}
                        {req.type !== 'LEAVE' && (
                          <>
                            <button type="button" aria-expanded={expandedReqId === req.id} onClick={() => setExpandedReqId(expandedReqId === req.id ? null : req.id)} className="text-[12px] font-black text-indigo-600 bg-indigo-50 px-4 py-2 rounded-lg hover:bg-indigo-100 transition-colors w-full text-center">
                              {expandedReqId === req.id ? 'إخفاء التفاصيل ⬆️' : 'عرض التفاصيل ⬇️'}
                            </button>
                            {expandedReqId === req.id && (
                              <div className="mt-3 p-4 bg-indigo-50/50 border border-indigo-100 rounded-xl space-y-2 text-[12px]">
                                {cd.leaveTypeMap && (
                                  <div className="flex justify-between items-center border-b border-indigo-100 pb-2">
                                    <span className="font-bold text-slate-500">نوع:</span>
                                    <span className="font-black text-indigo-700">{cd.leaveTypeMap}</span>
                                  </div>
                                )}
                                {cd.totalDays ? (
                                  <div className="flex justify-between items-center border-b border-indigo-100 pb-2">
                                    <span className="font-bold text-slate-500">المدة الإجمالية:</span>
                                    <span className="font-black text-indigo-700">{cd.totalDays} أيام</span>
                                  </div>
                                ) : null}
                                {cd.notes && (
                                  <div>
                                    <span className="font-bold text-slate-500 block mb-1">ملاحظات:</span>
                                    <span className="font-bold text-slate-700 bg-white p-2 rounded block">{cd.notes}</span>
                                  </div>
                                )}
                                {!cd.leaveTypeMap && !cd.totalDays && !cd.notes && (
                                  <p className="font-bold text-slate-400">لا توجد تفاصيل إضافية.</p>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {approved ? (
                    <div className="flex flex-col gap-3 pt-4 border-t border-emerald-200">
                      <div className="flex items-center gap-2 text-emerald-600 font-black text-[13px]">
                        <CheckCircle size={16} /> تم اعتماد الطلب بنجاح
                      </div>
                      <div className="flex gap-2">
                        {navLink && (
                          <Link href={navLink.href} className={`flex-1 py-3 rounded-xl font-black text-[13px] flex items-center justify-center gap-2 transition border ${navLink.color}`}>
                            {navLink.icon} {navLink.label}
                          </Link>
                        )}
                        <button type="button" onClick={() => { setApprovedItems((prev) => { const n = { ...prev }; delete n[req.id]; return n; }); void fetchRequests({ silent: true }); }} className="bg-slate-100 text-slate-500 hover:bg-slate-200 py-3 px-4 rounded-xl font-bold text-[12px] transition">
                          إخفاء
                        </button>
                      </div>
                    </div>
                  ) : req.type === 'ONBOARDING' ? (
                    <div className="flex items-center gap-3 pt-4 border-t border-slate-100">
                      <button type="button" disabled={busyId !== null} onClick={() => { setReviewModalReq(req); setEditedData(toEdit(req.customData)); }} className="flex-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-600 hover:text-white py-3 rounded-xl font-black text-[13px] flex items-center justify-center gap-2 transition border border-indigo-100 hover:border-transparent disabled:opacity-50">
                        <CheckCircle size={16} /> استعراض وتعديل
                      </button>
                      <button type="button" disabled={busyId !== null} onClick={() => void handleAction(req, 'REJECT')} className="bg-rose-50 text-rose-700 hover:bg-rose-600 hover:text-white py-3 px-6 rounded-xl font-black text-[13px] flex items-center justify-center gap-1 transition border border-rose-100 hover:border-transparent disabled:opacity-50">
                        <XCircle size={16} /> رفض
                      </button>
                    </div>
                  ) : (
                    <div className="pt-4 border-t border-slate-100 space-y-2">
                      {blockReason && (
                        <p id={`block-${req.id}`} className="flex items-start gap-2 text-[12px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" /> {blockReason}
                        </p>
                      )}
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={busyId !== null || !!blockReason}
                          aria-describedby={blockReason ? `block-${req.id}` : undefined}
                          title={blockReason ?? undefined}
                          onClick={() => onApproveClick(req)}
                          className="flex-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white py-3 rounded-xl font-black text-[13px] flex items-center justify-center gap-2 transition border border-emerald-100 hover:border-transparent disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-50 disabled:hover:text-emerald-700"
                        >
                          <CheckCircle size={16} /> {isBusy ? 'جاري التنفيذ...' : isPurchasingStage ? 'صرف أو شراء وإقفال' : 'اعتماد الطلب'}
                        </button>
                        <button type="button" disabled={busyId !== null} onClick={() => void handleAction(req, 'REJECT')} className="bg-rose-50 text-rose-700 hover:bg-rose-600 hover:text-white py-3 px-6 rounded-xl font-black text-[13px] flex items-center justify-center gap-1 transition border border-rose-100 hover:border-transparent disabled:opacity-50">
                          <XCircle size={16} /> رفض
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Purchasing stage of an asset request: warehouse asset or new purchase */}
      <Modal
        open={!!fulfilReq}
        onClose={() => setFulfilReq(null)}
        title="إقفال طلب العهدة"
        description={fulfilReq ? `${fulfilReq.employeeName ?? ''} | ${fulfilReq.details ?? ''}` : undefined}
        icon={<MonitorSmartphone size={22} />}
        tone="emerald"
        busy={busyId !== null}
      >
        <div className="p-5 sm:p-6 space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-[13px] font-black text-slate-700 mb-2">كيف ستُسلَّم العهدة؟</legend>
            <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer ${fulfilAssetId === '' ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'}`}>
              <input type="radio" name="fulfil-mode" className="mt-1" checked={fulfilAssetId === ''} onChange={() => setFulfilAssetId('')} />
              <span>
                <span className="block font-black text-[13px] text-slate-800">شراء جديد</span>
                <span className="block font-bold text-[12px] text-slate-500">يُنشأ أصل جديد باسم الموظف في سجل العهد.</span>
              </span>
            </label>
            <label className={`flex items-start gap-3 p-3 rounded-xl border ${fulfilOptions.length ? 'cursor-pointer' : 'opacity-60'} ${fulfilAssetId !== '' ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'}`}>
              <input
                type="radio"
                name="fulfil-mode"
                className="mt-1"
                disabled={fulfilOptions.length === 0}
                checked={fulfilAssetId !== ''}
                onChange={() => setFulfilAssetId(fulfilOptions[0]?.id ?? '')}
              />
              <span className="flex-1 min-w-0">
                <span className="block font-black text-[13px] text-slate-800">صرف من المستودع</span>
                <span className="block font-bold text-[12px] text-slate-500">
                  {fulfilOptions.length
                    ? `يُسند أصل شاغر موجود بدل الشراء (${fulfilOptions.length} أصل شاغر).`
                    : 'لا توجد أصول شاغرة في المستودع حالياً.'}
                </span>
              </span>
            </label>
          </fieldset>

          {fulfilAssetId !== '' && (
            <label className="block">
              <span className="block text-[12px] font-bold text-slate-500 mb-1">الأصل الشاغر</span>
              <select value={fulfilAssetId} onChange={(e) => setFulfilAssetId(e.target.value)} className={INPUT}>
                {fulfilOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.matchesType ? '★ ' : ''}{a.assetType}{a.description ? ` - ${a.description}` : ''}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] font-bold text-slate-400 mt-1">★ نوعه يطابق النوع المطلوب.</span>
            </label>
          )}

          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 pt-2">
            <button type="button" onClick={() => setFulfilReq(null)} disabled={busyId !== null} className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 transition">
              إلغاء
            </button>
            <button
              type="button"
              onClick={() => void submitFulfilment()}
              disabled={busyId !== null}
              className="px-6 py-3 rounded-xl font-black text-white bg-emerald-600 hover:bg-emerald-700 transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <CheckCircle size={18} /> {busyId !== null ? 'جاري التنفيذ...' : fulfilAssetId ? 'صرف الأصل وإقفال الطلب' : 'تسجيل أصل جديد وإقفال الطلب'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Onboarding Review Modal */}
      {reviewModalReq && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-label="مراجعة بيانات مباشرة العمل" className="bg-white rounded-3xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h2 className="text-xl font-black text-slate-800 flex items-center gap-2">
                <Users size={22} className="text-indigo-600" />
                مراجعة بيانات مباشرة العمل
              </h2>
              <button type="button" aria-label="إغلاق" onClick={() => setReviewModalReq(null)} className="text-slate-400 hover:text-rose-500 transition">
                <XCircle size={28} />
              </button>
            </div>

            <form
              className="flex-1 flex flex-col overflow-hidden"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await handleAction(reviewModalReq, 'APPROVE', editedData);
                if (ok) setReviewModalReq(null);
              }}
            >
              <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50">
                {/* Personal Info */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100">
                  <h3 className="font-bold text-slate-700 mb-4 border-b pb-2">البيانات الشخصية</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <EditField label="الاسم الأول (عربي)"><input type="text" required value={editedData.fullNameArabic} onChange={(e) => setEditedData({ ...editedData, fullNameArabic: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="الاسم الأخير (عربي)"><input type="text" value={editedData.lastNameArabic} onChange={(e) => setEditedData({ ...editedData, lastNameArabic: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="رقم الهوية / الإقامة"><input type="text" required dir="ltr" value={editedData.iqamaOrIdNumber} onChange={(e) => setEditedData({ ...editedData, iqamaOrIdNumber: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="رقم الجوال"><input type="tel" required dir="ltr" value={editedData.mobileNumber} onChange={(e) => setEditedData({ ...editedData, mobileNumber: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="تاريخ الميلاد"><input type="date" value={editedData.dateOfBirth} onChange={(e) => setEditedData({ ...editedData, dateOfBirth: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="تاريخ انتهاء الهوية / الإقامة"><input type="date" value={editedData.iqamaOrIdExp} onChange={(e) => setEditedData({ ...editedData, iqamaOrIdExp: e.target.value })} className={INPUT} /></EditField>
                  </div>
                </div>

                {/* Job Info */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100">
                  <h3 className="font-bold text-slate-700 mb-4 border-b pb-2">البيانات الوظيفية والمالية</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <EditField label="المسمى الوظيفي"><input type="text" value={editedData.jobTitle} onChange={(e) => setEditedData({ ...editedData, jobTitle: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="تاريخ المباشرة"><input type="date" value={editedData.joinDate} onChange={(e) => setEditedData({ ...editedData, joinDate: e.target.value })} className={INPUT} /></EditField>
                    <EditField label="الراتب الأساسي"><input type="number" min={0} step="0.01" value={editedData.basicSalary || ''} onChange={(e) => setEditedData({ ...editedData, basicSalary: Number(e.target.value) })} className={INPUT} /></EditField>
                    <EditField label="اسم البنك">
                      <select value={editedData.bankName} onChange={(e) => setEditedData({ ...editedData, bankName: e.target.value })} className={INPUT}>
                        <option value="">— اختر البنك —</option>
                        {editedData.bankName && !SAUDI_BANKS.some((b) => b.value === editedData.bankName) && (
                          <option value={editedData.bankName}>{editedData.bankName}</option>
                        )}
                        {SAUDI_BANKS.map((b) => <option key={b.code} value={b.value}>{b.label} ({b.code})</option>)}
                      </select>
                    </EditField>
                    <EditField label="رقم الآيبان"><input type="text" dir="ltr" value={editedData.ibanNumber} onChange={(e) => setEditedData({ ...editedData, ibanNumber: e.target.value.toUpperCase().replace(/\s+/g, '') })} className={INPUT} /></EditField>
                  </div>
                </div>

                {/* Attachments */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100">
                  <h3 className="font-bold text-slate-700 mb-4 border-b pb-2">المرفقات</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                      { url: reviewAttachments?.iqamaCopyUrl, icon: '📄', label: 'صورة الهوية/الإقامة' },
                      { url: reviewAttachments?.passportCopyUrl, icon: '✈️', label: 'صورة الجواز' },
                      { url: reviewAttachments?.ibanCertificateUrl, icon: '🏦', label: 'شهادة الآيبان' },
                      { url: reviewAttachments?.resumeUrl, icon: '📋', label: 'السيرة الذاتية' },
                    ].filter((a) => !!a.url).map((a) => (
                      <a key={a.label} href={a.url ?? undefined} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center p-3 bg-slate-50 rounded-xl border border-slate-200 hover:border-indigo-400 transition">
                        <span className="text-2xl mb-2">{a.icon}</span>
                        <span className="text-[11px] font-bold text-slate-600 text-center">{a.label}</span>
                      </a>
                    ))}
                  </div>
                  {!reviewAttachments?.iqamaCopyUrl && !reviewAttachments?.passportCopyUrl && !reviewAttachments?.ibanCertificateUrl && !reviewAttachments?.resumeUrl && (
                    <p className="text-[12px] font-bold text-slate-400">لا توجد مرفقات مع هذا الطلب.</p>
                  )}
                </div>
              </div>

              <div className="p-6 border-t border-slate-100 bg-white flex justify-end gap-3">
                <button type="button" onClick={() => setReviewModalReq(null)} className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 transition">إلغاء</button>
                <button
                  type="submit"
                  disabled={busyId !== null}
                  className="px-6 py-3 rounded-xl font-black text-white bg-indigo-600 hover:bg-indigo-700 transition flex items-center gap-2 disabled:opacity-50"
                >
                  {busyId === reviewModalReq.id ? 'جاري الاعتماد...' : <><CheckCircle size={18} /> اعتماد وتسجيل الموظف</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

function InfoCell({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div className="flex justify-between bg-white p-2 rounded-lg">
      <span className="font-bold text-slate-500">{label}</span>
      <span className={`font-black ${valueClass}`}>{value}</span>
    </div>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] font-bold text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
