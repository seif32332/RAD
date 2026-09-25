"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ShieldAlert, Plus, MoreVertical, Search, Filter, Truck, Clock, CheckCircle2, ArrowRightCircle, Edit3, Trash2, X, AlertTriangle, RefreshCw, type LucideIcon } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatMoney } from '@/lib/money';

interface ClaimRow {
  id: string;
  status: string;
  claimAmount?: number | null;
  insuranceCompany?: string | null;
  otherAttachmentsUrl?: string | null;
  vehicle?: {
    brand?: string | null;
    plateNumber?: string | null;
    vehicleCode?: string | null;
    driver?: { firstNameArabic?: string | null; lastNameArabic?: string | null } | null;
    legalCompany?: { nameArabic?: string | null } | null;
  } | null;
}

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const statusMap: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  PENDING_SUBMISSION: { label: 'بانتظار التقديم', color: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock },
  SUBMITTED: { label: 'تم تقديم المطالبة', color: 'bg-blue-50 text-blue-700 border-blue-200', icon: CheckCircle2 },
  TRANSFERRED: { label: 'تم استلام المطالبة (تحويل)', color: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: ArrowRightCircle },
};

export default function ClaimsPage() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [statusModal, setStatusModal] = useState<{isOpen: boolean; claimId: string; newStatus: string; attachmentUrl: string; isSubmitting: boolean}>({
    isOpen: false, claimId: '', newStatus: '', attachmentUrl: '', isSubmitting: false
  });

  useEffect(() => {
    const handleClickOutside = () => {
      setOpenMenuId(null);
      setIsFilterOpen(false);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const fetchClaims = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/claims');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل المطالبات'));
        return;
      }
      const data = await res.json();
      setClaims(Array.isArray(data) ? data : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchClaims(); }, [fetchClaims]);

  const handleDelete = async (id: string) => {
    setOpenMenuId(null);
    if (!(await confirmDialog('هل أنت متأكد من حذف هذه المطالبة؟', { danger: true }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/claims/${id}`, { method: 'DELETE' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حذف المطالبة'));
        return;
      }
      toast.success('تم حذف المطالبة بنجاح');
      await fetchClaims();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setDeletingId(null);
    }
  };

  const handleStatusClick = (id: string, newStatus: string) => {
    setOpenMenuId(null);
    setStatusModal({ isOpen: true, claimId: id, newStatus, attachmentUrl: '', isSubmitting: false });
  };

  const submitStatusChange = async () => {
    if (statusModal.isSubmitting) return;
    if (!statusModal.attachmentUrl) {
      toast.warning('يجب إرفاق ملف يثبت تعديل الحالة!');
      return;
    }

    setStatusModal(prev => ({ ...prev, isSubmitting: true }));
    try {
      // PUT replaces otherAttachmentsUrl, so the proof file is appended to the existing list here.
      const currentClaim = claims.find(c => c.id === statusModal.claimId);
      const existingAttachments = currentClaim?.otherAttachmentsUrl || '';
      const newAttachments = existingAttachments
        ? `${existingAttachments},${statusModal.attachmentUrl}`
        : statusModal.attachmentUrl;

      const res = await fetch(`/api/claims/${statusModal.claimId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: statusModal.newStatus,
          otherAttachmentsUrl: newAttachments
        })
      });
      if (res.status === 401) return redirectToLogin();
      if (res.ok) {
        toast.success('تم تحديث حالة المطالبة');
        setStatusModal({ isOpen: false, claimId: '', newStatus: '', attachmentUrl: '', isSubmitting: false });
        await fetchClaims();
      } else {
        toast.error(await readApiError(res, 'حدث خطأ أثناء التحديث'));
        setStatusModal(prev => ({ ...prev, isSubmitting: false }));
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      setStatusModal(prev => ({ ...prev, isSubmitting: false }));
    }
  };

  const filteredClaims = claims.filter(c => {
    const searchString = searchText.toLowerCase();
    const matchSearch = (c.insuranceCompany || '').toLowerCase().includes(searchString) ||
                        (c.vehicle?.plateNumber || '').toLowerCase().includes(searchString) ||
                        (c.vehicle?.brand || '').toLowerCase().includes(searchString);
    const matchStatus = filterStatus === 'ALL' || c.status === filterStatus;
    return matchSearch && matchStatus;
  });

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6 mb-32">

        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <ShieldAlert className="text-red-500" />
              مطالبات الحوادث
            </h1>
            <p className="text-slate-500 text-sm mt-1">تتبع مطالبات التأمين وحوادث سيارات الشركة وتغيير حالتها</p>
          </div>
          <Link href="/claims/new" className="bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-red-500/30 font-medium">
            <Plus size={20} />
            إضافة مطالبة جديدة
          </Link>
        </div>

        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="بحث في المطالبات" placeholder="ابحث برقم اللوحة، الماركة، أو شركة التأمين..." className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-red-100 text-sm font-semibold outline-none transition-all" />
          </div>
          <div className="relative flex items-center gap-2">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={isFilterOpen}
              onClick={(e) => { e.stopPropagation(); setIsFilterOpen(!isFilterOpen); }}
              className={`px-4 py-2.5 font-bold text-sm rounded-xl flex items-center gap-2 transition-all ${filterStatus !== 'ALL' || isFilterOpen ? 'bg-red-50 text-red-600 ring-2 ring-red-100' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
              <Filter size={18} /> {filterStatus === 'ALL' ? 'تصفية' : statusMap[filterStatus]?.label}
            </button>
            {filterStatus !== 'ALL' && (
               <button type="button" aria-label="إلغاء التصفية" onClick={(e) => { e.stopPropagation(); setFilterStatus('ALL'); }} className="w-6 h-6 rounded-full bg-red-100 hover:bg-red-200 text-red-700 flex items-center justify-center">×</button>
            )}

            {isFilterOpen && (
              <div className="absolute left-0 top-full mt-2 w-56 bg-white rounded-2xl shadow-[0_12px_40px_-10px_rgba(0,0,0,0.15)] ring-1 ring-slate-100 z-50 overflow-hidden py-2" onClick={(e) => e.stopPropagation()}>
                 <div className="px-4 py-2 text-[10px] font-black text-slate-400 tracking-wider">حسب حالة المطالبة</div>
                 <button type="button" onClick={() => { setFilterStatus('ALL'); setIsFilterOpen(false); }} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all ${filterStatus === 'ALL' ? 'bg-slate-50 text-indigo-600' : 'text-slate-700 hover:bg-slate-50'}`}>عرض الكل</button>
                 <button type="button" onClick={() => { setFilterStatus('PENDING_SUBMISSION'); setIsFilterOpen(false); }} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all ${filterStatus === 'PENDING_SUBMISSION' ? 'bg-amber-50 text-amber-700' : 'text-slate-700 hover:bg-amber-50/50'}`}>بانتظار التقديم</button>
                 <button type="button" onClick={() => { setFilterStatus('SUBMITTED'); setIsFilterOpen(false); }} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all ${filterStatus === 'SUBMITTED' ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-blue-50/50'}`}>تم تقديم المطالبة</button>
                 <button type="button" onClick={() => { setFilterStatus('TRANSFERRED'); setIsFilterOpen(false); }} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all ${filterStatus === 'TRANSFERRED' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-700 hover:bg-emerald-50/50'}`}>تم استلام المطالبة (تحويل)</button>
              </div>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-20 gap-4">
            <div className="w-8 h-8 rounded-full border-4 border-red-100 border-t-red-600 animate-spin" />
            <p className="text-slate-500 font-bold">جاري جلب المطالبات...</p>
          </div>
        ) : loadError ? (
          <div role="alert" className="bg-white rounded-2xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4 mt-10">
            <AlertTriangle size={48} className="text-rose-400" />
            <p className="font-bold text-slate-700">{loadError}</p>
            <button type="button" onClick={() => { setIsLoading(true); fetchClaims(); }} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : claims.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <ShieldAlert size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد مطالبات مسجلة</h2>
            <p className="text-slate-500 max-w-sm mb-8">ابدأ بإضافة أول مطالبة حادث وربطها بالمركبة المتضررة.</p>
            <Link href="/claims/new" className="px-6 py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 transition">+ إضافة مطالبة</Link>
          </div>
        ) : filteredClaims.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <Search size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد نتائج مطابقة</h2>
            <p className="text-slate-500 max-w-sm mb-8">جرب كتابة رقم لوحة آخر أو قم بإلغاء التصفية لإظهار كافة المطالبات.</p>
            <button type="button" onClick={() => {setSearchText(''); setFilterStatus('ALL');}} className="px-6 py-3 bg-red-50 text-red-600 font-bold rounded-xl hover:bg-red-100 transition">
              مسح الفلترة وعرض الكل
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredClaims.map((claim) => {
              const st = statusMap[claim.status] || statusMap.PENDING_SUBMISSION;
              const StatusIcon = st.icon;
              return (
                <div key={claim.id} className="bg-white rounded-[1.5rem] shadow-sm border border-slate-100 overflow-visible hover:border-red-200 transition p-6 relative">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    {/* Vehicle Info */}
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 rounded-xl bg-red-50 text-red-500 flex items-center justify-center shadow-inner shrink-0">
                        <Truck size={28} />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-800 text-lg">
                          {claim.vehicle?.brand} - <span className="font-black tracking-wider text-slate-900">{claim.vehicle?.plateNumber}</span>
                        </h3>
                        <div className="flex flex-wrap gap-2 mt-1.5">
                          <span className="text-[10px] font-black bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-lg border border-indigo-100">{claim.vehicle?.vehicleCode}</span>
                          {claim.vehicle?.driver && (
                            <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">
                              السائق: {claim.vehicle.driver.firstNameArabic} {claim.vehicle.driver.lastNameArabic}
                            </span>
                          )}
                          {claim.vehicle?.legalCompany && (
                            <span className="text-[10px] font-bold bg-slate-50 text-slate-600 px-2 py-0.5 rounded-lg border border-slate-100">
                              المالك: {claim.vehicle.legalCompany.nameArabic}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Claim Details */}
                    <div className="flex flex-wrap items-center gap-3 md:gap-5">
                      {claim.claimAmount && (
                        <div className="text-center">
                          <p className="text-[10px] font-bold text-slate-400 uppercase">المبلغ</p>
                          <p className="font-black text-slate-800 text-lg">{formatMoney(claim.claimAmount)} <span className="text-[11px] text-emerald-600">ر.س</span></p>
                        </div>
                      )}
                      {claim.insuranceCompany && (
                        <div className="text-center">
                          <p className="text-[10px] font-bold text-slate-400 uppercase">شركة التأمين</p>
                          <p className="font-bold text-slate-700 text-sm max-w-[100px] truncate">{claim.insuranceCompany}</p>
                        </div>
                      )}

                      <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-black border ${st.color}`}>
                        <StatusIcon size={14} />
                        {st.label}
                      </div>

                      {/* Menu Dropdown Button */}
                      <div className="relative z-20">
                        <button
                          type="button"
                          aria-label="إجراءات المطالبة"
                          aria-haspopup="menu"
                          aria-expanded={openMenuId === claim.id}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.nativeEvent) e.nativeEvent.stopImmediatePropagation();
                            setOpenMenuId(openMenuId === claim.id ? null : claim.id);
                          }}
                          className={`text-slate-400 hover:text-red-700 p-2.5 rounded-xl transition-all ${openMenuId === claim.id ? 'bg-red-50 text-red-600 ring-2 ring-red-100' : 'hover:bg-slate-100'}`}>
                          <MoreVertical size={20} />
                        </button>

                        {/* Dropdown Menu */}
                        {openMenuId === claim.id && (
                          <div className="absolute left-0 lg:right-0 top-full mt-2 w-64 bg-white rounded-2xl shadow-[0_12px_40px_-10px_rgba(0,0,0,0.15)] ring-1 ring-slate-100 z-50 overflow-hidden py-2"
                               onClick={(e) => e.stopPropagation()}>

                            <div className="px-4 py-2 text-[10px] font-black text-slate-400 tracking-wider">تغيير حالة المطالبة</div>

                            <button type="button" onClick={() => handleStatusClick(claim.id, 'PENDING_SUBMISSION')} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all flex items-center gap-2 hover:bg-amber-50 ${claim.status === 'PENDING_SUBMISSION' ? 'text-amber-700 bg-amber-50/50' : 'text-slate-700'}`}>
                               <Clock size={16} className={claim.status === 'PENDING_SUBMISSION' ? 'text-amber-500' : 'text-slate-400'}/>
                               إرجاع: بانتظار التقديم
                            </button>
                            <button type="button" onClick={() => handleStatusClick(claim.id, 'SUBMITTED')} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all flex items-center gap-2 hover:bg-blue-50 ${claim.status === 'SUBMITTED' ? 'text-blue-700 bg-blue-50/50' : 'text-slate-700'}`}>
                               <CheckCircle2 size={16} className={claim.status === 'SUBMITTED' ? 'text-blue-500' : 'text-slate-400'}/>
                               تم تقديم المطالبة
                            </button>
                            <button type="button" onClick={() => handleStatusClick(claim.id, 'TRANSFERRED')} className={`w-full text-right px-4 py-2.5 text-[13px] font-bold transition-all flex items-center gap-2 hover:bg-emerald-50 ${claim.status === 'TRANSFERRED' ? 'text-emerald-700 bg-emerald-50/50' : 'text-slate-700'}`}>
                               <ArrowRightCircle size={16} className={claim.status === 'TRANSFERRED' ? 'text-emerald-500' : 'text-slate-400'}/>
                               تم استلام المطالبة (والمبلغ)
                            </button>

                            <div className="h-[1px] bg-slate-100 my-2"></div>

                            <div className="px-4 py-1 text-[10px] font-black text-slate-400 tracking-wider">إجراءات إضافية</div>
                            <Link href={`/claims/${claim.id}/edit`} className="w-full text-right px-4 py-2.5 text-[13px] font-bold hover:bg-slate-50 transition-colors flex items-center gap-2 text-indigo-600">
                               <Edit3 size={16} />
                               تعديل بيانات المطالبة
                            </Link>
                            <button type="button" disabled={deletingId === claim.id} onClick={() => handleDelete(claim.id)} className="w-full text-right px-4 py-2.5 text-[13px] font-black hover:bg-red-50 transition-colors flex items-center gap-2 text-red-600 disabled:opacity-50">
                               <Trash2 size={16} />
                               حذف المطالبة نهائياً
                            </button>
                          </div>
                        )}
                      </div>

                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status Modal */}
      {statusModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="claim-status-title" className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden relative" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 id="claim-status-title" className="text-lg font-black text-slate-800">تأكيد تغيير حالة المطالبة</h2>
              <button type="button" aria-label="إغلاق" disabled={statusModal.isSubmitting} onClick={() => setStatusModal({ ...statusModal, isOpen: false })} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 text-slate-500 transition-colors">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-800">
                <p className="font-bold text-sm leading-relaxed">أنت على وشك تغيير حالة المطالبة إلى: <span className="font-black text-indigo-900 mx-1">{statusMap[statusModal.newStatus]?.label}</span></p>
                <p className="text-[12px] font-semibold opacity-80 mt-1">يجب إرفاق ملف يثبت هذا التحديث (مثل إيصال تحويل بنكي، خطاب تسليم، إلخ) حتى يتم اعتماد التغيير.</p>
              </div>

              <div>
                <FileUploadField
                  name="statusAttachment"
                  value={statusModal.attachmentUrl}
                  onChange={(e) => setStatusModal(prev => ({ ...prev, attachmentUrl: e.target.value }))}
                  label="مرفق الإثبات (مطلوب)"
                  accept=".pdf,.jpg,.jpeg,.png"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setStatusModal({ ...statusModal, isOpen: false })}
                  className="flex-1 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors"
                  disabled={statusModal.isSubmitting}
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={submitStatusChange}
                  disabled={!statusModal.attachmentUrl || statusModal.isSubmitting}
                  className="flex-[2] px-4 py-3 bg-red-600 hover:bg-red-700 text-white font-black rounded-xl transition-colors disabled:opacity-50 flex justify-center items-center gap-2"
                >
                  {statusModal.isSubmitting ? (
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    'تأكيد وتحديث الحالة'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
