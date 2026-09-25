"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Briefcase, AlertCircle, Plus, Trash2, CheckCircle, Package, Clock, Search, MoreVertical, Settings2, PackageMinus, ArrowRightLeft, Ban, X, UserCheck, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate, todayKey } from '@/lib/dates';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';

interface EmployeeOption {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic: string;
  /** Custody is never handed to an employee whose service has ended (the API refuses with 409). */
  isTerminated?: boolean | null;
}

interface Asset {
  id: string;
  assetType: string;
  description?: string | null;
  status: string;
  employeeId?: string | null;
  receiveDate?: string | null;
  /** A telecom SIM shown as a custody item (only the custody actions apply to it). */
  isTelecomSim?: boolean;
  employee?: { employeeId?: string; firstNameArabic?: string; lastNameArabic?: string; isTerminated?: boolean | null } | null;
}

/** Tab id that loads GET /api/assets?heldByTerminated=1 (assets + SIMs still held by employees who left). */
const TERMINATED_TAB = 'TERMINATED';
const DAMAGE_REASON_MIN = 5;

type AssetAction = 'edit' | 'assign' | 'transfer' | 'clear' | 'damage';

interface AssetRow { key: number; assetType: string; description: string; receiveDate: string }

let rowKeySeq = 0;
const newAssetRow = (): AssetRow => ({ key: ++rowKeySeq, assetType: '', description: '', receiveDate: todayKey() });

export default function AssetsPage() {
  const { role } = useRole();
  // Creating assets and custody actions are LOGISTICS-only on the server; other staff can only view.
  const canManage = roleIn(role, ROLE_GROUPS.LOGISTICS);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('ALL'); // ALL, ACTIVE, VACANT, DAMAGED, TERMINATED
  const [damageReason, setDamageReason] = useState('');

  const [assetItems, setAssetItems] = useState<AssetRow[]>(() => [newAssetRow()]);

  const [isLoading, setIsLoading] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Action Modal State
  const [actionModal, setActionModal] = useState<{ isOpen: boolean, action: AssetAction | '', asset: Asset | null }>({ isOpen: false, action: '', asset: null });
  const [newEmployeeId, setNewEmployeeId] = useState('');
  const [editData, setEditData] = useState({ assetType: '', description: '' });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const heldByTerminated = activeTab === TERMINATED_TAB;
  const fetchAssets = useCallback(async () => {
    setAssetsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(heldByTerminated ? '/api/assets?heldByTerminated=1' : '/api/assets');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل الأصول');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setAssets(Array.isArray(data) ? (data as Asset[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setAssetsLoading(false);
    }
  }, [heldByTerminated]);

  // Deep link: /assets?heldByTerminated=1 opens the "held by employees who left" tab.
  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get('heldByTerminated');
      if (v === '1' || v === 'true') setActiveTab(TERMINATED_TAB);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchAssets();
  }, [fetchAssets]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/employees?fields=basic');
        if (res.status === 401) { window.location.href = '/login'; return; }
        if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحميل قائمة الموظفين')); return; }
        const d: unknown = await res.json();
        // Only employees in service can receive custody (the API refuses the others with 409).
        if (Array.isArray(d)) setEmployees((d as EmployeeOption[]).filter((e) => !e.isTerminated));
      } catch {
        toast.error('تعذر تحميل قائمة الموظفين');
      }
    })();
  }, []);

  const handleAssetChange = (key: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAssetItems(prev => prev.map(row => (row.key === key ? { ...row, [name]: value } : row)));
  };

  const addAssetRow = () => {
    setAssetItems(prev => [...prev, newAssetRow()]);
  };

  const removeAssetRow = (key: number) => {
    setAssetItems(prev => (prev.length > 1 ? prev.filter(row => row.key !== key) : prev));
  };

  const closeActionModal = () => setActionModal({ isOpen: false, action: '', asset: null });

  const openActionModal = (asset: Asset, action: AssetAction) => {
    setOpenMenuId(null);
    setActionModal({ isOpen: true, action, asset });
    setNewEmployeeId('');
    setDamageReason('');
    if (action === 'edit') {
      setEditData({ assetType: asset.assetType, description: asset.description || '' });
    }
  };

  const handleAssetAction = async () => {
    const { action, asset } = actionModal;
    if (!asset || !action || isLoading) return;
    setIsLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          employeeId: newEmployeeId,
          assetType: editData.assetType,
          description: editData.description,
          ...(action === 'damage' ? { reason: damageReason.trim() } : {}),
        })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تنفيذ الإجراء');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json().catch(() => ({}));

      const msg = data?.message || 'تم تنفيذ الإجراء بنجاح';
      setSuccessMsg(msg);
      toast.success(msg);
      closeActionModal();
      fetchAssets();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    // Filter out rows that have empty assetType
    const validItems = assetItems.filter(a => a.assetType.trim() !== '');
    if (validItems.length === 0) {
      setErrorMsg("الرجاء إدخال نوع الأصل على الأقل");
      return;
    }
    setIsLoading(true);

    try {
      const payload = validItems.map(item => ({
        employeeId: employeeId || null,
        assetType: item.assetType,
        description: item.description,
        receiveDate: employeeId ? item.receiveDate : null
      }));

      const res = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assets: payload })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر حفظ الأصول');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json().catch(() => ({}));

      const msg = data?.message || "تم إضافة الأصول/العهد بنجاح!";
      setSuccessMsg(msg);
      toast.success(msg);
      setAssetItems([newAssetRow()]);
      // keep employeeId selected so the next batch can go to the same employee
      fetchAssets();
    } catch {
      setErrorMsg('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  };

  const matchesFilters = (a: Asset) => {
    // Filter by Tab (the TERMINATED tab is already filtered by the API)
    if (activeTab === 'ACTIVE' && a.status !== 'ACTIVE') return false;
    if (activeTab === 'VACANT' && (a.status !== 'VACANT' && a.status !== 'RETURNED')) return false;
    if (activeTab === 'DAMAGED' && a.status !== 'DAMAGED') return false;

    // Filter by Search
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const empId = a.employee?.employeeId?.toLowerCase() || '';
    const nameAr = `${a.employee?.firstNameArabic || ''} ${a.employee?.lastNameArabic || ''}`.toLowerCase();
    const assetType = a.assetType?.toLowerCase() || '';
    const desc = a.description?.toLowerCase() || '';

    return empId.includes(q) || nameAr.includes(q) || assetType.includes(q) || desc.includes(q);
  };

  const visibleAssets = assets.filter(matchesFilters);

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        {/* Header */}
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-indigo-100 text-indigo-600 p-3 rounded-2xl"><Package size={26} /></span>
            إدارة العُهَد والأصول
          </h1>
          <p className="text-slate-500 font-semibold mt-2 mr-16">إدارة وحفظ أصول الشركة ومستودعها، وإسنادها كعُهد للموظفين.</p>
        </div>

        {errorMsg && (
          <div className="bg-red-50 border-2 border-red-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <AlertCircle className="text-red-500 shrink-0" size={22} />
            <p className="font-extrabold text-red-800 text-[14px]">{errorMsg}</p>
          </div>
        )}

        {successMsg && (
          <div className="bg-emerald-50 border-2 border-emerald-200 rounded-[1.5rem] p-5 flex items-center gap-4">
            <CheckCircle className="text-emerald-500 shrink-0" size={22} />
            <p className="font-extrabold text-emerald-800 text-[14px]">{successMsg}</p>
          </div>
        )}

        {/* Input Form */}
        {canManage && (
        <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] p-8">
          <form onSubmit={handleSubmit} className="space-y-8">
            <h2 className="font-extrabold text-lg text-slate-800 border-b border-slate-100 pb-4">إضافة أصل جديد للمستودع (أو إسناده مباشرة كعهدة)</h2>

            <div className="bg-indigo-50/50 p-6 rounded-3xl border border-indigo-100">
              <SearchableSelect
                name="employeeId"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                label="إسناد إلى موظف كعهدة (اتركه فارغاً ليُحفظ كأصل شاغر في المستودع)"
                required={false}
                accentColor="indigo"
                options={[
                  { label: "— بدون موظف (أصل شاغر في المستودع) —", value: "" },
                  ...employees.map(e => ({ label: `${e.firstNameArabic} ${e.lastNameArabic} - #${e.employeeId}`, value: e.id }))
                ]}
              />
            </div>

            <div className="space-y-4">
               {assetItems.map((item) => (
                 <div key={item.key} className="bg-slate-50 border border-slate-200 rounded-3xl p-6 relative group transition-all hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-900/5">
                   {assetItems.length > 1 && (
                     <button type="button" aria-label="حذف الصنف" onClick={() => removeAssetRow(item.key)} className="absolute left-6 top-6 text-slate-400 hover:text-red-500 bg-white rounded-full p-2 border border-slate-200 shadow-sm transition">
                       <Trash2 size={16} />
                     </button>
                   )}
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                     <div className="flex flex-col gap-2 md:col-span-1">
                       <label className="text-[12px] font-extrabold text-slate-700">نوع الأصل/العهدة (مثال: سيارة، لابتوب)</label>
                       <input type="text" name="assetType" value={item.assetType} onChange={(e) => handleAssetChange(item.key, e)} required placeholder="اكتب نوع الأصل..." className="px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                     </div>
                     {employeeId ? (
                       <div className="flex flex-col gap-2">
                         <label className="text-[12px] font-extrabold text-slate-700">تاريخ الاستلام</label>
                         <input type="date" name="receiveDate" value={item.receiveDate} onChange={(e) => handleAssetChange(item.key, e)} required dir="ltr" className="px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-right" />
                       </div>
                     ) : (
                       <div className="flex flex-col gap-2">
                         <label className="text-[12px] font-extrabold text-slate-300">تاريخ الاستلام (مخفي لأن الأصل شاغر)</label>
                         <input type="date" disabled value="" className="px-5 py-3.5 bg-slate-100 border border-slate-200 rounded-2xl font-bold text-[14px] text-slate-400 cursor-not-allowed text-right" dir="ltr" />
                       </div>
                     )}
                     <div className="md:col-span-3 flex flex-col gap-2">
                       <label className="text-[12px] font-extrabold text-slate-700">مواصفاتها (رقم اللوحة / الموديل / السيريال)</label>
                       <input type="text" name="description" value={item.description} onChange={(e) => handleAssetChange(item.key, e)} placeholder="اكتب المواصفات والبيانات..." className="px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                     </div>
                   </div>
                 </div>
               ))}
            </div>

            <div className="flex flex-col sm:flex-row justify-between items-center gap-4 pt-4 border-t border-slate-100">
               <button type="button" onClick={addAssetRow} className="text-indigo-600 font-bold text-[13px] bg-indigo-50 px-6 py-3 rounded-xl hover:bg-indigo-100 transition flex items-center gap-2">
                 <Plus size={16} /> إضافة صنف آخر
               </button>

               <button type="submit" disabled={isLoading} className="w-full sm:w-auto px-10 py-3.5 text-[14px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-indigo-600 disabled:opacity-50 transition-all shadow-lg flex justify-center items-center gap-2">
                 {isLoading ? 'جاري الحفظ...' : employeeId ? 'حفظ وإسناد العهد' : 'حفظ الأصناف في المستودع'}
               </button>
            </div>
          </form>
        </div>
        )}

        {/* Existing Assets List / Warehouse */}
        <div className="space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 px-2 py-4">
            <div className="flex flex-col gap-2">
              <h2 className="font-extrabold text-xl text-slate-800">مستودع الأصول وسجل العُهَد</h2>
              <p className="text-sm font-semibold text-slate-500">يعرض كافة الممتلكات سواء شاغرة أو مسندة لموظف.</p>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4">
              {/* Filters */}
              <div className="bg-slate-100 p-1.5 rounded-2xl flex items-center gap-1 w-full sm:w-auto overflow-x-auto whitespace-nowrap hide-scrollbar">
                {[
                  { id: 'ALL', label: 'الكل' },
                  { id: 'ACTIVE', label: 'مُسندة لعهدة' },
                  { id: 'VACANT', label: 'شاغرة (أصول)' },
                  { id: 'DAMAGED', label: 'تالفة / مؤرشفة' },
                  { id: TERMINATED_TAB, label: 'لدى منتهي الخدمة' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-5 py-2.5 rounded-xl text-[13px] font-bold transition-all ${
                      activeTab === tab.id
                        ? 'bg-white text-indigo-600 shadow-sm border border-slate-200'
                        : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-auto">
                <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  aria-label="بحث في الأصول"
                  placeholder="ابحث بالاسم، الرقم، أو الأصل..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-4 pr-12 py-3.5 bg-white w-full sm:w-72 border border-slate-200 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 rounded-2xl font-bold text-[13px] outline-none transition"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {assetsLoading && assets.length === 0 && (
               <div className="col-span-full py-16 text-center text-slate-400 font-bold animate-pulse">جاري تحميل الأصول...</div>
            )}

            {!assetsLoading && loadError && (
               <div className="col-span-full py-16 text-center bg-white rounded-[2rem] border border-rose-200 shadow-sm flex flex-col items-center justify-center gap-4">
                 <p className="text-rose-600 font-bold">{loadError}</p>
                 <button type="button" onClick={fetchAssets} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
               </div>
            )}

            {!loadError && visibleAssets.map((asset) => {
               const isDamaged = asset.status === 'DAMAGED';
               // History row left for the previous holder after a transfer: read-only.
               const isHistory = asset.status === 'TRANSFERRED';
               const isVacant = !isDamaged && !isHistory && (!asset.employeeId || asset.status === 'VACANT' || asset.status === 'RETURNED');
               const isAssigned = asset.status === 'ACTIVE' && !!asset.employeeId;

               return (
                <div key={asset.id} className="bg-white rounded-[2rem] border border-slate-100 p-6 flex flex-col gap-4 shadow-sm hover:shadow-xl hover:shadow-indigo-900/5 hover:-translate-y-1 transition-all duration-300 relative group overflow-visible">

                  {/* Actions Menu */}
                  {canManage && !isHistory && (
                  <div className="absolute top-6 left-6 z-10">
                    <button type="button" aria-label="خيارات الأصل" aria-haspopup="menu" aria-expanded={openMenuId === asset.id} onClick={() => setOpenMenuId(openMenuId === asset.id ? null : asset.id)} className="text-slate-400 hover:text-indigo-600 outline-none">
                      <MoreVertical size={20} />
                    </button>
                    {openMenuId === asset.id && (
                        <>
                          {/* Invisible Backdrop to close menu */}
                          <button type="button" aria-label="إغلاق القائمة" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpenMenuId(null)}></button>

                          <div className="absolute left-0 top-6 bg-white border border-slate-100 shadow-[0_10px_40px_rgba(0,0,0,0.1)] rounded-2xl w-56 overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                            <div className="p-1 relative z-50">
                              {!asset.isTelecomSim && (
                                <button type="button" onClick={() => openActionModal(asset, 'edit')} className="w-full text-right px-4 py-3 text-[13px] font-bold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 rounded-xl flex items-center gap-3 transition-colors"><Settings2 size={16}/>تعديل المواصفات</button>
                              )}

                              {isVacant && (
                                <button type="button" onClick={() => openActionModal(asset, 'assign')} className="w-full text-right px-4 py-3 text-[13px] font-bold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 rounded-xl flex items-center gap-3 transition-colors"><UserCheck size={16}/>إسناد إلى موظف</button>
                              )}

                              {isAssigned && (
                                <>
                                  <button type="button" onClick={() => openActionModal(asset, 'transfer')} className="w-full text-right px-4 py-3 text-[13px] font-bold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 rounded-xl flex items-center gap-3 transition-colors"><ArrowRightLeft size={16}/>نقل لعهدة موظف آخر</button>
                                  <div className="my-1 border-t border-slate-50"></div>
                                  <button type="button" onClick={() => openActionModal(asset, 'clear')} className="w-full text-right px-4 py-3 text-[13px] font-bold hover:bg-orange-50 text-orange-600 rounded-xl flex items-center gap-3 transition-colors"><PackageMinus size={16}/>إخلاء واسترداد للمستودع</button>
                                </>
                              )}

                              {!isDamaged && (
                                <button type="button" onClick={() => openActionModal(asset, 'damage')} className="w-full text-right px-4 py-3 text-[13px] font-bold hover:bg-red-50 text-red-600 rounded-xl flex items-center gap-3 transition-colors"><Ban size={16}/>{asset.isTelecomSim ? 'تلف أو فقد الشريحة' : 'إتلاف و أرشفة الأصل'}</button>
                              )}
                            </div>
                          </div>
                        </>
                    )}
                  </div>
                  )}

                  <div className="flex items-start gap-4 pr-2">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black shrink-0 ${
                      isDamaged ? 'bg-red-50 text-red-500' :
                      isVacant ? 'bg-emerald-50 text-emerald-500' :
                      'bg-indigo-50 text-indigo-600'
                    }`}>
                      {isDamaged ? <Ban size={26} /> : <Briefcase size={26} />}
                    </div>
                    <div className="overflow-hidden translate-y-1">
                      <h3 className="font-extrabold text-[16px] text-slate-800 tracking-tight truncate pl-8">{asset.assetType}</h3>

                      <div className="mt-1.5 flex items-center gap-2">
                        {isDamaged && <span className="inline-flex py-0.5 px-2.5 rounded-md bg-red-100 text-red-700 text-[10px] font-black tracking-wide">تالف / مؤرشف</span>}
                        {isVacant && !isDamaged && <span className="inline-flex py-0.5 px-2.5 rounded-md bg-emerald-100 text-emerald-700 text-[10px] font-black tracking-wide">أصل شاغر بالمستودع</span>}
                        {isAssigned && <span className="inline-flex py-0.5 px-2.5 rounded-md bg-indigo-100 text-indigo-700 text-[10px] font-black tracking-wide">مُسندة كعهدة</span>}
                        {isHistory && <span className="inline-flex py-0.5 px-2.5 rounded-md bg-slate-100 text-slate-600 text-[10px] font-black tracking-wide">منقولة لموظف آخر (سجل)</span>}
                      </div>
                    </div>
                  </div>

                  {isAssigned && asset.employee && (
                    <div className="mt-2 flex border border-slate-100 items-center gap-3 bg-white shadow-sm p-3 rounded-2xl">
                       <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0"><UserCheck size={16} /></div>
                       <div className="truncate">
                         <p className="font-extrabold text-[12px] text-slate-700 truncate">{asset.employee.firstNameArabic} {asset.employee.lastNameArabic}</p>
                         <p className="font-bold text-[10px] text-slate-400 mt-0.5">الرقم الوظيفي: #{asset.employee.employeeId}</p>
                       </div>
                       {asset.employee.isTerminated && (
                         <span className="mr-auto shrink-0 inline-flex py-0.5 px-2.5 rounded-md bg-rose-100 text-rose-700 text-[10px] font-black" title="العهدة ما زالت مسجلة على موظف انتهت خدمته: استردها قبل التصفية النهائية">
                           منتهي الخدمة
                         </span>
                       )}
                    </div>
                  )}

                  <div className="bg-slate-50 p-4 rounded-xl mt-auto border border-slate-100/50">
                     <p className="text-[12px] font-bold text-slate-600 leading-relaxed truncate">{asset.description || 'بدون مواصفات مسجلة'}</p>

                     {asset.receiveDate && isAssigned && (
                        <p className="text-[10px] font-black text-indigo-500 mt-3 flex items-center gap-1.5"><Clock size={12}/> استلمها الموظف في: {formatDate(asset.receiveDate)}</p>
                     )}

                     {isVacant && (
                        <p className="text-[10px] font-black text-slate-400 mt-3 flex items-center gap-1.5"><Clock size={12}/> متوفرة في المستودع</p>
                     )}
                  </div>
                </div>
               );
             })}

            {!loadError && assets.length > 0 && visibleAssets.length === 0 && (
               <div className="col-span-full py-16 text-center text-slate-500 font-bold bg-white rounded-[2rem] border border-slate-100 shadow-sm flex flex-col items-center justify-center gap-4">
                 <Search size={40} className="text-slate-200" />
                 لا توجد نتائج مطابقة لبحثك في هذا القسم.
               </div>
            )}

            {!assetsLoading && !loadError && assets.length === 0 && (
               <div className="col-span-full py-16 text-center text-slate-500 font-bold bg-white rounded-[2rem] border border-slate-100 shadow-sm flex flex-col items-center justify-center gap-4">
                 <Package size={40} className="text-slate-200" />
                 {heldByTerminated
                   ? 'لا توجد عهد أو شرائح لدى موظفين انتهت خدماتهم.'
                   : 'المستودع فارغ تماماً. قم بإضافة أصول جديدة.'}
               </div>
            )}
          </div>
        </div>

      </div>

      {actionModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
           <div className="bg-white rounded-[3rem] p-8 max-w-md w-full shadow-2xl border border-slate-200 relative">
              <button type="button" aria-label="إغلاق" onClick={closeActionModal} className="absolute top-6 left-6 text-slate-400 hover:text-red-500 bg-slate-50 rounded-full p-2 transition">
                <X size={18} />
              </button>

              <h3 className="text-2xl font-black text-slate-900 mb-6 pb-4 border-b border-slate-100 flex items-center gap-3">
                 {actionModal.action === 'edit' && <><Settings2 size={24} className="text-indigo-500" /> تعديل بيانات الأصل</>}
                 {actionModal.action === 'assign' && <><UserCheck size={24} className="text-emerald-500" /> إسناد الأصل لموظف</>}
                 {actionModal.action === 'transfer' && <><ArrowRightLeft size={24} className="text-indigo-500" /> نقل العهدة لموظف</>}
                 {actionModal.action === 'clear' && <><PackageMinus size={24} className="text-orange-500" /> إخلاء للمستودع</>}
                 {actionModal.action === 'damage' && <><Ban size={24} className="text-red-500" /> إتلاف نهائي</>}
              </h3>

              <div className="space-y-6">
                {actionModal.action === 'edit' && (
                  <>
                    <div className="flex flex-col gap-2">
                      <label className="text-[12px] font-extrabold text-slate-700">نوع الأصل/العهدة</label>
                      <input type="text" value={editData.assetType} onChange={e => setEditData({...editData, assetType: e.target.value})} className="px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] outline-none transition" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-[12px] font-extrabold text-slate-700">المواصفات والتفاصيل</label>
                      <textarea value={editData.description} onChange={e => setEditData({...editData, description: e.target.value})} className="px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] outline-none min-h-[120px] transition" />
                    </div>
                  </>
                )}

                {actionModal.action === 'assign' && (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-bold text-slate-500 mb-2">اختر الموظف الذي ترغب بإسناد هذا الأصل إليه كعهدة:</p>
                    <SearchableSelect
                      name="newEmployeeId"
                      value={newEmployeeId}
                      onChange={(e) => setNewEmployeeId(e.target.value)}
                      label="الموظف المستلم *"
                      required={true}
                      accentColor="emerald"
                      options={employees.map(e => ({ label: `${e.firstNameArabic} ${e.lastNameArabic} - #${e.employeeId}`, value: e.id }))}
                    />
                  </div>
                )}

                {actionModal.action === 'transfer' && (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-bold text-slate-500 mb-2">سيتم إخلاء طرف الموظف الحالي ونقل العهدة إلى:</p>
                    <SearchableSelect
                      name="newEmployeeId"
                      value={newEmployeeId}
                      onChange={(e) => setNewEmployeeId(e.target.value)}
                      label="الموظف الجديد المستلم *"
                      required={true}
                      accentColor="indigo"
                      options={employees.map(e => ({ label: `${e.firstNameArabic} ${e.lastNameArabic} - #${e.employeeId}`, value: e.id })).filter(e => e.value !== actionModal.asset?.employeeId)}
                    />
                  </div>
                )}

                {actionModal.action === 'clear' && (
                  <p className="font-bold text-slate-600 leading-relaxed text-[15px] bg-orange-50 p-4 rounded-2xl border border-orange-100">
                    هل أنت متأكد من إخلاء طرف الموظف عن <strong>{actionModal.asset?.assetType}</strong> ورده إلى مستودع الشركة كـ&quot;أصل شاغر&quot;؟
                  </p>
                )}

                {actionModal.action === 'damage' && (
                  <>
                    {actionModal.asset?.isTelecomSim ? (
                      <p className="font-bold text-red-600 leading-relaxed text-[15px] bg-red-50 p-4 rounded-2xl border border-red-100">
                        ستُفصل الشريحة عن الموظف فقط. الخط يبقى فعّالاً لدى المشغل حتى تطلب إلغاءه منه.
                      </p>
                    ) : (
                      <p className="font-bold text-red-600 leading-relaxed text-[15px] bg-red-50 p-4 rounded-2xl border border-red-100">
                        تحذير: هذا الإجراء سيجعل الأصل أو العهدة <strong>تالفة وغير صالحة للاستخدام</strong> وسيتم أرشفتها نهائياً!
                      </p>
                    )}
                    <label className="flex flex-col gap-2">
                      <span className="text-[12px] font-extrabold text-slate-700">سبب الإتلاف أو الفقد *</span>
                      <textarea
                        value={damageReason}
                        onChange={(e) => setDamageReason(e.target.value)}
                        required
                        minLength={DAMAGE_REASON_MIN}
                        maxLength={1000}
                        placeholder="مثال: كسر في الشاشة بعد سقوط الجهاز، أو فقد مع بلاغ برقم..."
                        className="px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-red-400 rounded-2xl font-bold text-[14px] outline-none min-h-[100px] transition"
                      />
                      <span className="text-[11px] font-bold text-slate-400">يُحفظ السبب واسم الحائز في سجل التدقيق ({DAMAGE_REASON_MIN} أحرف على الأقل).</span>
                    </label>
                  </>
                )}

                <div className="flex flex-col sm:flex-row gap-3 pt-4">
                   <button type="button" onClick={handleAssetAction} disabled={isLoading || ((actionModal.action === 'transfer' || actionModal.action === 'assign') && !newEmployeeId) || (actionModal.action === 'edit' && !editData.assetType) || (actionModal.action === 'damage' && damageReason.trim().length < DAMAGE_REASON_MIN)}
                           className={`flex-1 py-4 font-black rounded-2xl transition-all disabled:opacity-50 text-white shadow-lg ${
                            actionModal.action === 'damage' ? 'bg-red-600 hover:bg-red-700' :
                            actionModal.action === 'clear' ? 'bg-orange-500 hover:bg-orange-600' :
                            actionModal.action === 'assign' ? 'bg-emerald-600 hover:bg-emerald-700' :
                            'bg-indigo-600 hover:bg-indigo-700'
                           }`}>
                     {isLoading ? 'جاري التنفيذ...' : 'تأكيد وحفظ'}
                   </button>
                   <button type="button" onClick={closeActionModal} className="py-4 px-8 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-2xl transition-all">إلغاء</button>
                </div>
              </div>
           </div>
        </div>
      )}

    </DashboardLayout>
  );
}
