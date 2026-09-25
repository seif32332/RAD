"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Network, Plus, MoreVertical, Search, Trash2, Building, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';

interface AdministrationRow {
  id: string;
  nameArabic: string;
  company?: { nameArabic: string } | null;
  _count?: { branches?: number; employees?: number };
}

export default function AdministrationsPage() {
  const router = useRouter();
  const [administrations, setAdministrations] = useState<AdministrationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/administrations', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل الإدارات'));
        return;
      }
      const data: unknown = await res.json();
      setAdministrations(Array.isArray(data) ? (data as AdministrationRow[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return administrations;
    return administrations.filter(a =>
      (a.nameArabic || '').toLowerCase().includes(q) ||
      (a.company?.nameArabic || '').toLowerCase().includes(q)
    );
  }, [administrations, searchQuery]);

  const handleDelete = async (id: string) => {
    setMenuOpen(null);
    if (deletingId) return;
    if (!(await confirmDialog('هل أنت متأكد من حذف هذه الإدارة؟', { danger: true, confirmText: 'حذف' }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/administrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'فشل في حذف الإدارة'));
        return;
      }
      setAdministrations(prev => prev.filter(a => a.id !== id));
      toast.success('تم حذف الإدارة');
    } catch {
      toast.error('حدث خطأ في الاتصال');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Network className="text-indigo-600" />
            الإدارات المركزية
          </h1>
          <p className="text-slate-500 text-sm mt-1">إدارة الأقسام الإدارية المركزية التابعة للشركات</p>
        </div>

        <Link
          href="/administrations/new"
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-indigo-500/30 font-medium"
        >
          <Plus size={20} />
          إضافة إدارة جديدة
        </Link>
      </div>

      {/* Search */}
      <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            aria-label="بحث في الإدارات"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم الإدارة أو الشركة..."
            className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-indigo-100 text-sm font-semibold"
          />
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center p-20 gap-4">
           <div className="w-8 h-8 rounded-full border-4 border-indigo-100 border-t-indigo-600 animate-spin" aria-label="جاري التحميل" />
        </div>
      ) : loadError ? (
        <div className="bg-white rounded-2xl border border-rose-100 p-16 text-center flex flex-col items-center justify-center mt-10">
          <AlertTriangle size={48} className="text-rose-400 mb-4" />
          <h2 className="text-lg font-bold text-slate-700 mb-1">تعذر تحميل الإدارات</h2>
          <p className="text-slate-500 text-sm mb-6">{loadError}</p>
          <button type="button" onClick={load} className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-[13px] transition">
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      ) : filtered.length === 0 && searchQuery.trim() ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center flex flex-col items-center justify-center mt-10">
          <Search size={48} className="text-slate-200 mb-4" />
          <h2 className="text-lg font-bold text-slate-600 mb-1">لا توجد نتائج مطابقة</h2>
          <p className="text-slate-400 text-sm">حاول تغيير كلمة البحث &quot;{searchQuery}&quot;</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
          <Network size={64} className="text-slate-200 mb-6" />
          <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد إدارات حالياً</h2>
          <Link href="/administrations/new" className="px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-indigo-700 transition mt-4">
            + إنشاء أول إدارة
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-4">
          {filtered.map((admin) => (
            <div key={admin.id} className={`bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden hover:shadow-md transition duration-300 ${deletingId === admin.id ? 'opacity-50 pointer-events-none' : ''}`}>
              <div className="p-6 border-b border-slate-100 flex justify-between items-start">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl flex items-center justify-center font-bold text-2xl shadow-inner bg-indigo-50 text-indigo-600">
                    {admin.nameArabic?.charAt(0) || '؟'}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800 text-lg leading-tight mb-1">{admin.nameArabic}</h3>
                    <p className="text-[12px] font-bold text-slate-500 inline-flex items-center gap-1">
                      <Building size={12} /> {admin.company?.nameArabic || '—'}
                    </p>
                  </div>
                </div>

                <div className="relative">
                  <button
                    type="button"
                    aria-label={`إجراءات ${admin.nameArabic}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen === admin.id}
                    onClick={() => setMenuOpen(menuOpen === admin.id ? null : admin.id)}
                    className="text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-slate-50 transition"
                  >
                    <MoreVertical size={20} />
                  </button>
                  {menuOpen === admin.id && (
                    <div role="menu" className="absolute left-0 top-full mt-1 bg-white rounded-xl shadow-xl border border-slate-100 z-50 w-44 overflow-hidden">
                      <button type="button" role="menuitem" onClick={() => handleDelete(admin.id)}
                        className="flex items-center gap-2 px-4 py-3 text-[13px] font-bold text-red-500 hover:bg-red-50 transition w-full text-right border-t border-slate-100">
                        <Trash2 size={15} /> حذف الإدارة
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 flex gap-3 bg-slate-50">
                <div className="flex-1 text-center">
                  <p className="font-bold text-slate-400 text-[11px] mb-1">عدد الفروع</p>
                  <p className="font-black text-slate-700">{admin._count?.branches || 0}</p>
                </div>
                <div className="flex-1 text-center">
                  <p className="font-bold text-slate-400 text-[11px] mb-1">الموظفين</p>
                  <p className="font-black text-slate-700">{admin._count?.employees || 0}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {menuOpen && <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setMenuOpen(null)} />}
    </DashboardLayout>
  );
}
