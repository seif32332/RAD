"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { BarChart3, BriefcaseBusiness, FileSignature, CreditCard, ChevronRight, AlertTriangle, CheckCircle2, Clock, Receipt, X, Printer, ShieldCheck, RefreshCw, Package } from 'lucide-react';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { SETTLEMENT_STATUS } from '@/lib/constants';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface OwnerSettlement {
  id: string;
  type: string;
  status: string;
  totalSettlement?: number | null;
  workingDaysSalary?: number | null;
  workingDaysInMonth?: number | null;
  endOfServiceAmount?: number | null;
  yearsOfService?: number | null;
  leaveCompensation?: number | null;
  unusedLeaveDays?: number | null;
  additionalEntitlements?: number | null;
  additionalDeductions?: number | null;
  excessLeaveDeduction?: number | null;
  loansDeduction?: number | null;
  additionalNotes?: string | null;
  ownerNotes?: string | null;
  createdAt: string;
  employee?: {
    firstNameArabic?: string | null;
    lastNameArabic?: string | null;
    employeeId?: string | null;
    basicSalary?: number | null;
    legalCompany?: { nameArabic?: string | null } | null;
  } | null;
}

/** Asset (custody) request awaiting the owner, as returned by GET /api/incoming-requests. */
interface OwnerAssetRequest {
  id: string;
  dbId: string;
  type: string;
  employeeName?: string | null;
  employeeId?: string | null;
  department?: string | null;
  createdAt: string;
  details?: string | null;
  customData?: { assetType?: string | null; description?: string | null; status?: string | null } | null;
}

const ASSET_TYPE_LABELS: Record<string, string> = { LAPTOP: 'لابتوب', MOBILE: 'جوال', SIM: 'شريحة' };

type LinkColor = 'amber' | 'blue' | 'rose' | 'violet';

/** Static Tailwind classes per card color (dynamic class names are invisible to Tailwind). */
const LINK_COLOR_CLASSES: Record<LinkColor, { card: string; blob: string; icon: string; title: string; footer: string; footerText: string; arrow: string }> = {
  amber: {
    card: 'border-amber-100 hover:border-amber-400',
    blob: 'bg-amber-500',
    icon: 'bg-amber-50 text-amber-600 border-amber-100 group-hover:bg-amber-600',
    title: 'group-hover:text-amber-700',
    footer: 'group-hover:bg-amber-50',
    footerText: 'group-hover:text-amber-600',
    arrow: 'group-hover:bg-amber-600 group-hover:shadow-amber-200',
  },
  blue: {
    card: 'border-blue-100 hover:border-blue-400',
    blob: 'bg-blue-500',
    icon: 'bg-blue-50 text-blue-600 border-blue-100 group-hover:bg-blue-600',
    title: 'group-hover:text-blue-700',
    footer: 'group-hover:bg-blue-50',
    footerText: 'group-hover:text-blue-600',
    arrow: 'group-hover:bg-blue-600 group-hover:shadow-blue-200',
  },
  rose: {
    card: 'border-rose-100 hover:border-rose-400',
    blob: 'bg-rose-500',
    icon: 'bg-rose-50 text-rose-600 border-rose-100 group-hover:bg-rose-600',
    title: 'group-hover:text-rose-700',
    footer: 'group-hover:bg-rose-50',
    footerText: 'group-hover:text-rose-600',
    arrow: 'group-hover:bg-rose-600 group-hover:shadow-rose-200',
  },
  violet: {
    card: 'border-violet-100 hover:border-violet-400',
    blob: 'bg-violet-500',
    icon: 'bg-violet-50 text-violet-600 border-violet-100 group-hover:bg-violet-600',
    title: 'group-hover:text-violet-700',
    footer: 'group-hover:bg-violet-50',
    footerText: 'group-hover:text-violet-600',
    arrow: 'group-hover:bg-violet-600 group-hover:shadow-violet-200',
  },
};

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const money2 = (v: number | null | undefined) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function OwnerPortalDashboard() {
  const [settlements, setSettlements] = useState<OwnerSettlement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selectedSettlement, setSelectedSettlement] = useState<OwnerSettlement | null>(null);

  const fetchSettlements = useCallback(async () => {
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

  // Asset (custody) requests that HR forwarded to the owner (status PENDING_OWNER).
  const [assetRequests, setAssetRequests] = useState<OwnerAssetRequest[]>([]);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [assetBusyId, setAssetBusyId] = useState<string | null>(null);

  const fetchAssetRequests = useCallback(async () => {
    setAssetError(null);
    try {
      const res = await fetch('/api/incoming-requests');
      if (res.status === 401) return redirectToLogin();
      if (res.status === 403) { setAssetRequests([]); return; }
      if (!res.ok) {
        setAssetError(await readApiError(res, 'تعذر تحميل طلبات العهد'));
        return;
      }
      const data = await res.json();
      const list: OwnerAssetRequest[] = Array.isArray(data?.deptManagerRequests) ? data.deptManagerRequests : [];
      setAssetRequests(list.filter((r) => r.type === 'ASSET_REQUEST' && r.customData?.status === 'PENDING_OWNER'));
    } catch {
      setAssetError('تعذر الاتصال بالخادم لتحميل طلبات العهد');
    }
  }, []);

  useEffect(() => {
    fetchAssetRequests();
  }, [fetchAssetRequests]);

  const handleAssetAction = async (req: OwnerAssetRequest, actionType: 'APPROVE' | 'REJECT') => {
    let reason: string | undefined;
    if (actionType === 'APPROVE') {
      if (!(await confirmDialog('اعتماد طلب العهدة وإحالته لمسؤول المشتريات؟'))) return;
    } else {
      const r = await promptDialog('سبب رفض طلب العهدة:');
      if (r === null) return;
      if (!r.trim()) { toast.warning('يرجى كتابة سبب الرفض'); return; }
      reason = r.trim();
    }
    setAssetBusyId(req.dbId);
    try {
      const res = await fetch('/api/incoming-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType, type: 'ASSET_REQUEST', dbId: req.dbId, reason }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تنفيذ الإجراء على طلب العهدة'));
        return;
      }
      const data = await res.json().catch(() => null);
      toast.success(typeof data?.message === 'string' ? data.message : actionType === 'APPROVE' ? 'تم اعتماد طلب العهدة' : 'تم رفض طلب العهدة');
      await fetchAssetRequests();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setAssetBusyId(null);
    }
  };

  /** Returns true when the settlement was updated. */
  const updateSettlement = async (id: string, body: Record<string, unknown>, successMsg: string, errorMsg: string): Promise<boolean> => {
    setLoadingId(id);
    try {
      const res = await fetch('/api/settlements', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body })
      });
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, errorMsg));
        return false;
      }
      toast.success(successMsg);
      await fetchSettlements();
      return true;
    } catch {
      toast.error(errorMsg);
      return false;
    } finally {
      setLoadingId(null);
    }
  };

  const handleApprove = async (id: string): Promise<boolean> => {
    if (!(await confirmDialog('هل أنت متأكد من اعتماد هذه التصفية والموافقة على صرفها؟'))) return false;
    return updateSettlement(id, { status: SETTLEMENT_STATUS.OWNER_APPROVED }, 'تم اعتماد التصفية وإرسالها للمالية', 'حدث خطأ أثناء الاعتماد');
  };

  const handleReject = async (id: string) => {
    const reason = await promptDialog('يرجى كتابة سبب الرفض وإعادته للموارد البشرية:');
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
      toast.warning('يرجى كتابة سبب الرفض');
      return;
    }
    await updateSettlement(id, { status: SETTLEMENT_STATUS.REJECTED, ownerNotes: reason.trim() }, 'تم رفض التصفية وإعادتها للموارد البشرية', 'حدث خطأ أثناء الرفض');
  };

  // Prisma SettlementType values (LEAVE_SETTLEMENT / END_OF_SERVICE); unknown values fall back to the raw type.
  const typeLabels: Record<string, string> = {
    LEAVE_SETTLEMENT: 'تصفية إجازة',
    END_OF_SERVICE: 'تصفية نهاية خدمة',
  };

  const pendingCount = settlements.filter(s => s.status === 'PENDING_APPROVAL').length;
  const displayedSettlements = showAll ? settlements : settlements.filter(s => s.status === 'PENDING_APPROVAL' || s.status === 'OWNER_APPROVED' || s.status === 'REJECTED');

  const portalLinks: { title: string; desc: string; href: string; icon: React.ReactNode; color: LinkColor }[] = [
    {
      title: "تقارير التكاليف والالتزامات ومتابعة العمليات",
      desc: "نفقات الرواتب، الإقامات، الإيجارات والمركبات وكافة الأوصاف المالية التحليلية.",
      href: "/owner-reports",
      icon: <BarChart3 size={32} />,
      color: "amber"
    },
    {
      title: "قرارات وتعاميم الإدارة",
      desc: "نشر وإصدار القرارات الرسمية للموظفين والأقسام وحفظها في الأرشيف الإداري.",
      href: "/owner-portal/circulars",
      icon: <FileSignature size={32} />,
      color: "blue"
    },
    {
      title: "الموافقات والتعميدات المالية",
      desc: "التصديق على أوامر الصرف المالي، السلف المقبولة، وتسوية العهد.",
      href: "/owner-portal/payments",
      icon: <CreditCard size={32} />,
      color: "rose"
    },
    {
      title: "طلبات وتوجيهات الإدارة",
      desc: "رفع أوامر وتوجيهات مباشرة للإدارات المحتلفة وتتبع حالة إنجازها.",
      href: "/owner-portal/requests",
      icon: <BriefcaseBusiness size={32} />,
      color: "violet"
    }
  ];

  return (
    <DashboardLayout>
      <div className="print:hidden max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-200">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-700 p-3 rounded-2xl"><BriefcaseBusiness size={26} /></span>
              بوابة صاحب العمل والإدارة العليا
            </h1>
            <p className="text-indigo-700 font-bold mt-3 text-[14px] leading-relaxed max-w-2xl">
              مركز التحكم الشامل لحركة المنشأة؛ التقارير التفصيلية، التوجيهات المباشرة، الموافقات الائتمانية والقرارات الحاسمة في منصة واحدة.
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="py-10 text-center text-slate-400 font-bold animate-pulse">جاري تحميل التصفيات...</div>
        )}

        {loadError && (
          <div role="alert" className="bg-rose-50 border border-rose-200 rounded-[2rem] p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-bold text-[14px] text-rose-800 flex items-center gap-2"><AlertTriangle size={18} /> {loadError}</p>
            <button type="button" onClick={() => { setIsLoading(true); fetchSettlements(); }} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-rose-200 text-rose-700 font-black text-[12px] rounded-xl hover:bg-rose-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {/* Asset requests awaiting the owner */}
        {assetError && (
          <div role="alert" className="bg-rose-50 border border-rose-200 rounded-[2rem] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-bold text-[13px] text-rose-800 flex items-center gap-2"><AlertTriangle size={16} /> {assetError}</p>
            <button type="button" onClick={fetchAssetRequests} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-rose-200 text-rose-700 font-black text-[12px] rounded-xl hover:bg-rose-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}
        {assetRequests.length > 0 && (
          <div className="border-2 border-violet-200 bg-violet-50/40 rounded-[2rem] p-6 md:p-8 shadow-sm">
            <div className="flex items-center gap-3 mb-5">
              <div className="p-2.5 rounded-xl bg-violet-600 text-white"><Package size={22} /></div>
              <div>
                <h2 className="text-xl font-black text-slate-900">طلبات عهد بانتظار اعتمادك</h2>
                <p className="text-slate-600 font-bold text-[13px]">يوجد {assetRequests.length} طلب عهدة/أجهزة معتمد من الموارد البشرية</p>
              </div>
            </div>
            <div className="space-y-3">
              {assetRequests.map((r) => (
                <div key={r.id} className="bg-white rounded-2xl border border-violet-100 p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-black text-slate-800 text-[14px]">
                      {r.employeeName || '-'}
                      <span className="text-[11px] font-bold text-slate-400 mr-2">#{r.employeeId}</span>
                    </h3>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <span className="text-[10px] font-black bg-violet-50 text-violet-700 px-2 py-0.5 rounded-lg border border-violet-100">
                        {ASSET_TYPE_LABELS[r.customData?.assetType ?? ''] ?? 'أخرى'}
                      </span>
                      {r.department && <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">{r.department}</span>}
                      <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">{formatDate(r.createdAt)}</span>
                    </div>
                    {r.customData?.description && <p className="text-[12px] font-semibold text-slate-500 mt-2 break-words">{r.customData.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button type="button" disabled={assetBusyId === r.dbId} onClick={() => handleAssetAction(r, 'APPROVE')} className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[12px] px-4 py-2.5 rounded-xl transition disabled:opacity-50 flex items-center gap-1.5">
                      <CheckCircle2 size={15} /> اعتماد
                    </button>
                    <button type="button" disabled={assetBusyId === r.dbId} onClick={() => handleAssetAction(r, 'REJECT')} className="bg-rose-100 hover:bg-rose-200 text-rose-700 font-black text-[12px] px-4 py-2.5 rounded-xl transition disabled:opacity-50 flex items-center gap-1.5">
                      <X size={15} /> رفض
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Settlements Section */}
        {!loadError && displayedSettlements.length > 0 && (
          <div className={`border-2 rounded-[2rem] p-6 md:p-8 shadow-lg ${pendingCount > 0 ? 'bg-gradient-to-br from-amber-50 to-orange-50 border-amber-300 shadow-amber-100/50' : 'bg-gradient-to-br from-slate-50 to-emerald-50/30 border-slate-200 shadow-slate-100/50'}`}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl ${pendingCount > 0 ? 'bg-amber-500 text-white animate-pulse' : 'bg-emerald-500 text-white'}`}>
                  {pendingCount > 0 ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-900">
                    {pendingCount > 0 ? 'تصفيات بانتظار موافقتك' : 'سجل التصفيات المعتمدة'}
                  </h2>
                  <p className="text-slate-600 font-bold text-[13px]">
                    {pendingCount > 0 ? `يوجد ${pendingCount} تصفية تحتاج لاعتمادك` : 'جميع التصفيات تمت الموافقة عليها'}
                  </p>
                </div>
              </div>
              <button type="button" onClick={() => setShowAll(!showAll)} className="text-[12px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 px-4 py-2 rounded-xl transition">
                {showAll ? 'إخفاء المكتملة' : `عرض الكل (${settlements.length})`}
              </button>
            </div>

            <div className="space-y-4">
              {displayedSettlements.map((s) => (
                <div key={s.id} className={`bg-white rounded-2xl border p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:shadow-md transition-shadow ${s.status === 'PENDING_APPROVAL' ? 'border-amber-200' : s.status === SETTLEMENT_STATUS.OWNER_APPROVED ? 'border-emerald-200' : 'border-slate-200'}`}>
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${s.status === 'PENDING_APPROVAL' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'}`}>
                      {s.status === 'PENDING_APPROVAL' ? <Receipt size={24} /> : <CheckCircle2 size={24} />}
                    </div>
                    <div>
                      <h3 className="font-black text-slate-800 text-[15px]">
                        {s.employee?.firstNameArabic} {s.employee?.lastNameArabic}
                        <span className="text-[11px] font-bold text-slate-400 mr-2">#{s.employee?.employeeId}</span>
                      </h3>
                      <div className="flex flex-wrap gap-2 mt-1">
                        <span className="text-[10px] font-black bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-lg border border-indigo-100">
                          {typeLabels[s.type] || s.type}
                        </span>
                        <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">
                          {formatDate(s.createdAt)}
                        </span>
                        {s.status === 'PENDING_APPROVAL' ? (
                          <span className="text-[10px] font-black bg-amber-50 text-amber-700 px-2 py-0.5 rounded-lg border border-amber-200 flex items-center gap-1">
                            <Clock size={10} /> بانتظار الاعتماد
                          </span>
                        ) : s.status === 'OWNER_APPROVED' ? (
                          <span className="text-[10px] font-black bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-lg border border-emerald-200 flex items-center gap-1">
                            <CheckCircle2 size={10} /> تمت الموافقة ✅
                          </span>
                        ) : s.status === 'PAID' ? (
                          <span className="text-[10px] font-black bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg border border-blue-200 flex items-center gap-1">
                            <CheckCircle2 size={10} /> تم الدفع
                          </span>
                        ) : s.status === 'REJECTED' ? (
                          <span className="text-[10px] font-black bg-rose-50 text-rose-700 px-2 py-0.5 rounded-lg border border-rose-200 flex items-center gap-1">
                            <X size={10} /> مرفوضة
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-center px-4">
                      <p className="text-[10px] font-bold text-slate-400">صافي التصفية</p>
                      <p className={`font-black text-lg ${(s.totalSettlement || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {formatMoney(s.totalSettlement)} <span className="text-[10px]">ر.س</span>
                      </p>
                    </div>
                    {s.status === 'PENDING_APPROVAL' ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleApprove(s.id)}
                          disabled={loadingId === s.id}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[12px] px-5 py-3 rounded-xl transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50 flex items-center gap-2"
                        >
                          {loadingId === s.id ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          ) : (
                            <CheckCircle2 size={16} />
                          )}
                          اعتماد الصرف
                        </button>
                        <button
                          type="button"
                          onClick={() => handleReject(s.id)}
                          disabled={loadingId === s.id}
                          className="bg-rose-100 hover:bg-rose-200 text-rose-700 font-black text-[12px] px-5 py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 flex items-center gap-2"
                        >
                          <X size={16} /> رفض
                        </button>
                      </div>
                    ) : s.status === 'REJECTED' ? (
                      <div className="bg-rose-50 text-rose-700 font-black text-[12px] px-5 py-3 rounded-xl border border-rose-200 flex flex-col items-start justify-center gap-1">
                        <div className="flex items-center gap-2"><X size={16} /> مرفوضة</div>
                        {s.ownerNotes && <span className="text-[10px] font-bold text-rose-500 max-w-[180px] truncate" title={s.ownerNotes}>السبب: {s.ownerNotes}</span>}
                      </div>
                    ) : (
                      <div className="bg-emerald-50 text-emerald-700 font-black text-[12px] px-5 py-3 rounded-xl border border-emerald-200 flex items-center gap-2">
                        <CheckCircle2 size={16} /> معتمدة
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedSettlement(s)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[12px] px-4 py-3 rounded-xl transition flex items-center gap-1"
                    >
                      التفاصيل
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {portalLinks.map((link) => {
            const c = LINK_COLOR_CLASSES[link.color];
            return (
            <Link key={link.href} href={link.href}>
              <div className={`bg-white border-2 ${c.card} p-8 rounded-[2rem] shadow-sm hover:shadow-xl hover:-translate-y-2 transition-all duration-300 group flex flex-col h-full relative overflow-hidden`}>

                {/* Background Decor */}
                <div className={`absolute -right-10 -top-10 w-32 h-32 ${c.blob} opacity-5 rounded-full blur-2xl group-hover:scale-150 transition-transform duration-700`} />
                <div className={`absolute -left-10 -bottom-10 w-32 h-32 ${c.blob} opacity-5 rounded-full blur-2xl group-hover:scale-150 transition-transform duration-700`} />

                <div className={`w-16 h-16 ${c.icon} rounded-[1.5rem] flex items-center justify-center mb-6 shadow-inner border group-hover:text-white transition-colors duration-300 relative z-10`}>
                  {link.icon}
                </div>

                <h3 className={`text-xl font-black text-slate-800 mb-2 leading-snug ${c.title} transition-colors relative z-10`}>{link.title}</h3>
                <p className="text-[13px] text-slate-500 font-bold leading-relaxed mb-8 flex-1 relative z-10">{link.desc}</p>

                <div className={`mt-auto flex items-center justify-between text-[13px] font-black p-3 bg-slate-50 ${c.footer} rounded-2xl transition-colors relative z-10`}>
                  <span className={`text-slate-500 ${c.footerText} transition-colors`}>اكتشف اللوحة</span>
                  <div className={`bg-white shadow w-8 h-8 rounded-full flex items-center justify-center text-slate-400 group-hover:text-white ${c.arrow} transition-all`}>
                     <ChevronRight size={16} />
                  </div>
                </div>
              </div>
            </Link>
            );
          })}
        </div>
      </div>

      {/* TICKET DETAILS MODAL */}
      {selectedSettlement && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 print:static print:block print:bg-white print:p-0">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto print:max-h-none print:shadow-none print:bg-white print:p-0 print:overflow-visible">
            <div className="p-8 print:p-4 border-b border-slate-100 flex justify-between items-center print:hidden">
               <h2 className="text-xl font-black text-slate-800">تفاصيل مخالصة وتصفية نهائية</h2>
               <div className="flex gap-2">
                 <button type="button" onClick={() => window.print()} className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-[13px] font-bold flex items-center gap-2"><Printer size={16}/> طباعة المخالصة</button>
                 <button type="button" onClick={() => { setSelectedSettlement(null); }} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-[13px] font-bold">إغلاق</button>
               </div>
            </div>

            <div className="p-8 print:p-8 space-y-6 print:space-y-4">
               {/* Printable Header */}
               <div className="hidden print:block text-center border-b-2 border-slate-900 pb-4 mb-8">
                  <h1 className="text-2xl font-black text-slate-900">مخالصة نهائية وتصفية مستحقات</h1>
                  <p className="text-sm font-bold text-slate-500 mt-2">تاريخ الإصدار: {formatDate(selectedSettlement.createdAt)}</p>
               </div>

               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">اسم الموظف</p>
                     <p className="font-black text-slate-800">{selectedSettlement.employee?.firstNameArabic} {selectedSettlement.employee?.lastNameArabic}</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">الرقم الوظيفي</p>
                     <p className="font-black text-slate-800">#{selectedSettlement.employee?.employeeId}</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">الشركة</p>
                     <p className="font-black text-slate-800">{selectedSettlement.employee?.legalCompany?.nameArabic || 'مركزي'}</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-transparent print:border-none print:p-0">
                     <p className="text-[11px] font-bold text-slate-400 mb-1">الراتب الأساسي</p>
                     <p className="font-black text-slate-800">{formatMoney(selectedSettlement.employee?.basicSalary)} ر.س</p>
                  </div>
               </div>

               <div className="border border-slate-200 rounded-2xl overflow-hidden print:border-slate-800">
                  <table className="w-full text-right text-[13px]">
                     <thead className="bg-slate-50 border-b border-slate-200 print:bg-slate-100 print:border-slate-800">
                       <tr><th className="p-4 font-black text-slate-600">البند</th><th className="p-4 font-black text-slate-600">المبلغ (ر.س)</th></tr>
                     </thead>
                     <tbody className="divide-y divide-slate-100 print:divide-slate-800">
                        {(selectedSettlement.workingDaysSalary ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">راتب أيام العمل ({selectedSettlement.workingDaysInMonth} يوم)</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.workingDaysSalary)}</td></tr>)}
                        {(selectedSettlement.endOfServiceAmount ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">مكافأة نهاية الخدمة ({selectedSettlement.yearsOfService?.toFixed(2)} سنة)</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.endOfServiceAmount)}</td></tr>)}
                        {(selectedSettlement.leaveCompensation ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">تعويض رصيد الإجازات ({selectedSettlement.unusedLeaveDays} يوم)</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.leaveCompensation)}</td></tr>)}
                        {(selectedSettlement.additionalEntitlements ?? 0) > 0 && (<tr><td className="p-4 font-bold text-slate-700">مستحقات إضافية</td><td className="p-4 font-black text-emerald-600">{money2(selectedSettlement.additionalEntitlements)}</td></tr>)}
                        {(selectedSettlement.additionalDeductions ?? 0) > 0 && (<tr><td className="p-4 font-bold text-rose-700">خصومات إضافية ويدوية</td><td className="p-4 font-black text-rose-600">-{money2(selectedSettlement.additionalDeductions)}</td></tr>)}
                        {(selectedSettlement.excessLeaveDeduction ?? 0) > 0 && (<tr><td className="p-4 font-bold text-rose-700">استرداد أيام إجازة تفوق الرصيد</td><td className="p-4 font-black text-rose-600">-{money2(selectedSettlement.excessLeaveDeduction)}</td></tr>)}
                        {(selectedSettlement.loansDeduction ?? 0) > 0 && (<tr><td className="p-4 font-bold text-rose-700">خصم مديونيات السلف</td><td className="p-4 font-black text-rose-600">-{money2(selectedSettlement.loansDeduction)}</td></tr>)}
                        {selectedSettlement.additionalNotes && (
                          <tr><td colSpan={2} className="p-4 text-slate-500 font-bold whitespace-pre-line text-sm bg-slate-50/50">
                            ملاحظات التصفية وتفصيل العمليات الإضافية:
                            <br/>
                            <span className="text-slate-700">{selectedSettlement.additionalNotes}</span>
                          </td></tr>
                        )}
                     </tbody>
                     <tfoot className="bg-slate-900 print:bg-slate-100">
                       <tr><td className="p-4 font-black text-white print:text-slate-900 text-lg">صافي التصفية المستحق</td><td className="p-4 font-black text-orange-400 print:text-slate-900 text-xl">{formatMoney(selectedSettlement.totalSettlement)} ر.س</td></tr>
                     </tfoot>
                  </table>
               </div>

               {/* Print signatures */}
               <div className="hidden print:grid grid-cols-2 gap-10 mt-20 pt-10 border-t border-dashed border-slate-300">
                  <div className="text-center">
                     <p className="font-bold text-slate-600 mb-10">توقيع مسؤول الموارد البشرية</p>
                     <div className="w-40 border-b border-slate-400 mx-auto"></div>
                  </div>
                  <div className="text-center">
                     <p className="font-bold text-slate-600 mb-10">إقرار وتوقيع الموظف بالاستلام والتخالص</p>
                     <div className="w-40 border-b border-slate-400 mx-auto"></div>
                  </div>
               </div>

               {/* ACTION BUTTONS */}
               <div className="print:hidden space-y-4 mt-6">
                 {(selectedSettlement.status === 'PENDING_APPROVAL' || selectedSettlement.status === 'PENDING_TRANSFER') && (
                   <div className="bg-amber-50 border border-amber-200 p-6 rounded-[1.5rem]">
                      <div className="flex items-start gap-3 mb-4">
                        <ShieldCheck className="text-amber-600 shrink-0" size={22} />
                        <div>
                          <h4 className="font-black text-amber-800 text-[14px]">اعتماد التصفية وإرسالها للمالية</h4>
                          <p className="text-[12px] font-bold text-amber-600 mt-1">بموافقتك هنا ستنزل التصفية بحالة &quot;جاهزة للدفع&quot; لدى المحاسب لإتمام التحويل.</p>
                        </div>
                      </div>
                      <button type="button" disabled={loadingId === selectedSettlement.id} onClick={async () => {
                         if (await handleApprove(selectedSettlement.id)) setSelectedSettlement(null);
                      }} className="w-full px-8 py-3 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-black text-[13px] rounded-xl transition shadow-lg flex justify-center items-center gap-2">
                        <ShieldCheck size={16}/> {loadingId === selectedSettlement.id ? 'جاري...' : 'اعتماد الصرف والتصفية'}
                      </button>
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
