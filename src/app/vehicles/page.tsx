"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Truck, Plus, MoreVertical, Search, Filter, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';

interface VehicleRow {
  id: string;
  brand?: string | null;
  modelYear?: string | number | null;
  vehicleCode?: string | null;
  category?: string | null;
  plateNumber?: string | null;
  color?: string | null;
  isArchived?: boolean | null;
  licenseExpDate?: string | null;
  insuranceExpDate?: string | null;
  inspectionExpDate?: string | null;
  driver?: { firstNameArabic?: string | null; lastNameArabic?: string | null } | null;
  legalCompany?: { nameArabic?: string | null } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

export default function VehiclesPage() {
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const [searchText, setSearchText] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // States للمنصة التصفية
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [filterStatus, setFilterStatus] = useState<"all" | "expired" | "expiring_soon">("all");

  useEffect(() => {
    const handleClickOutside = () => {
      setOpenMenuId(null);
      // لا نغلق قائمة الفلتر هنا لكي لا يكون مزعجاً عند النقر داخله، لكن يمكن تحسينه لاحقاً
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // setState only runs in promise callbacks (never synchronously in the effect).
  const fetchVehicles = useCallback(() => fetch('/api/vehicles')
    .then(async (res) => {
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل المركبات'));
        return;
      }
      const data = await res.json();
      setVehicles(Array.isArray(data) ? data : []);
      setLoadError(null);
    })
    .catch(() => setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.'))
    .finally(() => setIsLoading(false)), []);

  useEffect(() => {
    void fetchVehicles();
  }, [fetchVehicles]);

  const isExpiringSoon = (dateStr: string | null | undefined) => {
    if (!dateStr) return false;
    const diff = new Date(dateStr).getTime() - now;
    return diff > 0 && diff < 30 * DAY_MS;
  };

  const isExpired = (dateStr: string | null | undefined) => {
    if (!dateStr) return false;
    return new Date(dateStr).getTime() < now;
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('هل أنت متأكد من حذف هذه المركبة؟ لا يمكن التراجع عن هذا الإجراء. (إذا كانت المركبة مرتبطة بمطالبات حوادث فسيتم أرشفتها بدلاً من حذفها)', { danger: true }))) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/vehicles/${id}`, { method: 'DELETE' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        // e.g. 409: the vehicle is linked to other records.
        toast.error(await readApiError(res, 'فشل الحذف. قد تكون المركبة مرتبطة بسجلات أخرى.'));
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.archived) {
        toast.info(typeof data.message === 'string' ? data.message : 'المركبة مرتبطة بمطالبات حوادث، لذلك تمت أرشفتها بدلاً من حذفها');
        setVehicles(prev => prev.map((v) => v.id === id ? { ...v, isArchived: true } : v));
      } else {
        toast.success(typeof data?.message === 'string' ? data.message : 'تم الحذف بنجاح');
        setVehicles(prev => prev.filter((v) => v.id !== id));
      }
    } catch {
      toast.error('خطأ في الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  const handleArchive = async (id: string) => {
    if (!(await confirmDialog('هل أنت متأكد من أرشفة هذه المركبة؟'))) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/vehicles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isArchived: true })
      });
      if (res.status === 401) return redirectToLogin();
      if (res.ok) {
        toast.success('تمت الأرشفة بنجاح');
        setVehicles(prev => prev.map((v) => v.id === id ? { ...v, isArchived: true } : v)); // Hidden from the active view
      } else {
        toast.error(await readApiError(res, 'فشل الأرشفة'));
      }
    } catch {
      toast.error('خطأ في الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  const filteredVehicles = vehicles.filter((v) => {
    if (v.isArchived) return false;

    // تطبيق تصفية الحالة (الفلتر)
    if (filterStatus === 'expired') {
      const anyExpired = isExpired(v.licenseExpDate) || isExpired(v.insuranceExpDate) || isExpired(v.inspectionExpDate);
      if (!anyExpired) return false;
    } else if (filterStatus === 'expiring_soon') {
      const anyExpiring = isExpiringSoon(v.licenseExpDate) || isExpiringSoon(v.insuranceExpDate) || isExpiringSoon(v.inspectionExpDate);
      const anyExpired = isExpired(v.licenseExpDate) || isExpired(v.insuranceExpDate) || isExpired(v.inspectionExpDate);
      if (!anyExpiring || anyExpired) return false;
    }

    // تطبيق تصفية البحث النصي
    const searchLower = searchText.toLowerCase();
    const plateMatch = v.plateNumber?.toLowerCase().includes(searchLower) || false;
    const driverMatch = v.driver ? `${v.driver.firstNameArabic || ''} ${v.driver.lastNameArabic || ''}`.toLowerCase().includes(searchLower) : false;
    const brandMatch = v.brand?.toLowerCase().includes(searchLower) || false;

    return plateMatch || driverMatch || brandMatch;
  });

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">

        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Truck className="text-indigo-600" />
              إدارة اللوجستي (المركبات)
            </h1>
            <p className="text-slate-500 text-sm mt-1">إدارة وتعقب سيارات الشركة والتراخيص والتأمين والسائقين</p>
          </div>

          <Link href="/vehicles/new" className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-indigo-500/30 font-medium">
            <Plus size={20} />
            إضافة مركبة جديدة
          </Link>
        </div>

        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4 relative z-40">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              aria-label="بحث في المركبات"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="ابحث برقم اللوحة أو السائق أو ماركة السيارة..."
              className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-indigo-100 text-sm font-semibold text-slate-700"
            />
          </div>

          <div className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={showFilterMenu}
              onClick={(e) => { e.stopPropagation(); setShowFilterMenu(!showFilterMenu); }}
              className={`px-4 py-2.5 font-bold text-sm rounded-xl flex items-center gap-2 transition ${filterStatus !== 'all' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
            >
              <Filter size={18} />
              تصفية
              {filterStatus !== 'all' && (
                <span className="w-2 h-2 rounded-full bg-indigo-500 ml-1 shadow-[0_0_8px_rgba(99,102,241,0.8)]"></span>
              )}
            </button>

            {showFilterMenu && (
              <div className="absolute left-0 mt-3 w-56 bg-white rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.1)] border border-slate-100 overflow-hidden z-[60]" onClick={(e) => e.stopPropagation()}>
                <div className="bg-slate-50 px-4 py-2 border-b border-slate-100 text-xs font-bold text-slate-400 text-right">
                  تصفية حسب حالة الوثائق
                </div>
                <div className="p-2 space-y-1">
                  <button
                    type="button"
                    onClick={() => { setFilterStatus('all'); setShowFilterMenu(false); }}
                    className={`block w-full text-right px-4 py-2.5 text-[13px] font-bold rounded-xl transition ${filterStatus === 'all' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-700 hover:bg-slate-50'}`}
                  >
                    عرض جميع المركبات
                  </button>
                  <button
                    type="button"
                    onClick={() => { setFilterStatus('expiring_soon'); setShowFilterMenu(false); }}
                    className={`block w-full text-right px-4 py-2.5 text-[13px] font-bold rounded-xl transition ${filterStatus === 'expiring_soon' ? 'bg-amber-50 text-amber-600' : 'text-slate-700 hover:bg-slate-50'}`}
                  >
                    وثائق تقارب على الانتهاء
                  </button>
                  <button
                    type="button"
                    onClick={() => { setFilterStatus('expired'); setShowFilterMenu(false); }}
                    className={`block w-full text-right px-4 py-2.5 text-[13px] font-bold rounded-xl transition ${filterStatus === 'expired' ? 'bg-red-50 text-red-600' : 'text-slate-700 hover:bg-slate-50'}`}
                  >
                    وثائق منتهية الصلاحية
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-20 gap-4">
            <div className="w-8 h-8 rounded-full border-4 border-indigo-100 border-t-indigo-600 animate-spin" />
            <p className="text-slate-500 font-bold">جاري جلب المركبات...</p>
          </div>
        ) : loadError ? (
          <div role="alert" className="bg-white rounded-2xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4 mt-10">
            <AlertTriangle size={48} className="text-rose-400" />
            <p className="font-bold text-slate-700">{loadError}</p>
            <button type="button" onClick={() => { setIsLoading(true); void fetchVehicles(); }} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : filteredVehicles.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <Truck size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">{(searchText || filterStatus !== 'all') ? 'لا توجد نتائج بحث تطابق الفلتر' : 'لا توجد مركبات مسجلة'}</h2>
            <p className="text-slate-500 max-w-sm mb-8">{(searchText || filterStatus !== 'all') ? 'حاول تغيير كلمات البحث أو إلغاء الفلاتر' : 'ابدأ بإضافة أول مركبة وربطها بالسائق والشركة المعنية.'}</p>
            {(!searchText && filterStatus === 'all') && (
              <Link href="/vehicles/new" className="px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition">
                + إضافة المركبة الأولى
              </Link>
            )}
            {(filterStatus !== 'all' || searchText) && (
              <button type="button" onClick={() => { setFilterStatus('all'); setSearchText(''); }} className="px-6 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">
                إلغاء التصفية
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 pt-4">
            {filteredVehicles.map((v) => (
              <div key={v.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-visible relative hover:border-indigo-200 hover:shadow-md transition group">
                <div className="p-6 border-b border-slate-50 flex justify-between items-start">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-inner">
                      <Truck size={24} />
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-800">{v.brand} - {v.modelYear}</h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] font-black bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-lg border border-indigo-100">{v.vehicleCode}</span>
                        <span className="text-[10px] font-bold bg-slate-50 text-slate-500 px-2 py-0.5 rounded-lg border border-slate-100">{v.category}</span>
                      </div>
                    </div>
                  </div>
                  <div className="relative z-30">
                    <button
                      type="button"
                      aria-label="إجراءات المركبة"
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === v.id}
                      disabled={busyId === v.id}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.nativeEvent) e.nativeEvent.stopImmediatePropagation();
                        setOpenMenuId(openMenuId === v.id ? null : v.id);
                      }}
                      className="text-slate-400 hover:text-indigo-600 p-2 rounded-lg transition hover:bg-indigo-50 relative focus:outline-none"
                    >
                      <MoreVertical size={18} />
                    </button>
                    {openMenuId === v.id && (
                      <div className="absolute left-0 mt-3 w-48 bg-white rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.15)] border border-slate-100/60 overflow-hidden z-[99]" onClick={(e) => {
                        e.stopPropagation();
                        if (e.nativeEvent) e.nativeEvent.stopImmediatePropagation();
                      }}>
                        <div className="p-2 space-y-1">
                          <Link href={`/vehicles/${v.id}/edit`} className="block w-full text-right px-4 py-2.5 text-[13px] font-bold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 rounded-xl transition">
                            تعديل المركبة
                          </Link>
                          <button type="button" onClick={() => { setOpenMenuId(null); handleArchive(v.id); }} className="block w-full text-right px-4 py-2.5 text-[13px] font-bold text-slate-700 hover:bg-slate-50 hover:text-amber-600 rounded-xl transition">
                            أرشفة المركبة
                          </button>
                          <div className="h-px bg-slate-100 my-1 w-full" />
                          <button type="button" onClick={() => { setOpenMenuId(null); handleDelete(v.id); }} className="block w-full text-right px-4 py-2.5 text-[13px] font-bold text-slate-700 hover:bg-slate-50 hover:text-red-600 rounded-xl transition">
                            حذف المركبة
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-6 space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-slate-500 font-semibold">رقم اللوحة:</span>
                    <span className="font-black text-slate-800 bg-slate-50 px-3 py-1 rounded-lg border border-slate-100 tracking-wider">{v.plateNumber}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-slate-500 font-semibold">اللون:</span>
                    <span className="font-bold text-slate-700">{v.color}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm pt-2 border-t border-slate-50">
                    <span className="text-slate-500 font-semibold">السائق:</span>
                    <span className="font-bold text-slate-700 truncate max-w-[150px]">
                      {v.driver ? `${v.driver.firstNameArabic ?? ''} ${v.driver.lastNameArabic ?? ''}` : <span className="text-amber-600 text-xs">غير مخصص</span>}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm pt-2 border-t border-slate-50">
                    <span className="text-slate-500 font-semibold">المالك القانوني:</span>
                    <span className="font-bold text-indigo-700 truncate max-w-[150px]">{v.legalCompany?.nameArabic || '-'}</span>
                  </div>

                  <div className="pt-3 border-t border-slate-50 space-y-2">
                    {[
                      { label: 'رخصة السير', date: v.licenseExpDate },
                      { label: 'التأمين', date: v.insuranceExpDate },
                      { label: 'الفحص', date: v.inspectionExpDate },
                    ].map((item) => {
                      const expired = isExpired(item.date);
                      const expiring = isExpiringSoon(item.date);
                      if (!expired && !expiring) return null;
                      return (
                        <div key={item.label} className={`flex items-center gap-2 text-[11px] font-bold px-3 py-1.5 rounded-lg ${expired ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                          <AlertTriangle size={12} />
                          <span>{item.label}: {expired ? 'منتهية الصلاحية!' : 'تنتهي قريباً'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
