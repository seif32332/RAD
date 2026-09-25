"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Plus, MoreVertical, Users, Activity, FileText, Search, Edit, Trash2, Eye, Building, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';

interface CompanyRow {
  id: string;
  nameArabic: string;
  commercialRegNum?: string | null;
  unifiedNumber?: string | null;
  taxNumber?: string | null;
  _count?: { legalEmployees?: number };
}

export default function CompaniesPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/companies', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل الشركات'));
        return;
      }
      const data: unknown = await res.json();
      setCompanies(Array.isArray(data) ? (data as CompanyRow[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredCompanies = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(c =>
      (c.nameArabic || '').toLowerCase().includes(q) ||
      (c.commercialRegNum || '').toLowerCase().includes(q) ||
      (c.unifiedNumber || '').toLowerCase().includes(q) ||
      (c.taxNumber || '').toLowerCase().includes(q)
    );
  }, [companies, searchQuery]);

  const handleDelete = async (id: string) => {
    setMenuOpen(null);
    if (deletingId) return;
    if (!(await confirmDialog('هل أنت متأكد من حذف هذه الشركة؟', { danger: true, confirmText: 'حذف' }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'فشل في حذف الشركة'));
        return;
      }
      setCompanies(prev => prev.filter(c => c.id !== id));
      toast.success('تم حذف الشركة');
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
            <Building2 className="text-blue-600" />
            الشركات والكيانات
          </h1>
          <p className="text-slate-500 text-sm mt-1">إدارة الكيانات القانونية المستقلة لمجموعة رديف</p>
        </div>

        <Link
          href="/companies/new"
          className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-blue-500/30 font-medium"
        >
          <Plus size={20} />
          إضافة شركة جديدة
        </Link>
      </div>

      {/* Search Bar */}
      <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            aria-label="بحث في الشركات"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم الشركة، الرقم الموحد أو الرقم الضريبي..."
            className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-blue-100 text-sm font-semibold"
          />
        </div>
        {searchQuery && (
          <div className="flex items-center gap-2 text-[12px] font-bold text-slate-500">
            <span className="bg-blue-50 text-blue-600 px-3 py-1.5 rounded-lg">{filteredCompanies.length} نتيجة</span>
            <button type="button" onClick={() => setSearchQuery('')} className="text-red-500 hover:text-red-700 underline">مسح</button>
          </div>
        )}
      </div>

      {/* States Handling */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center p-20 gap-4">
           <div className="w-8 h-8 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" />
           <p className="text-slate-500 font-bold">جاري جلب الشركات من قاعدة البيانات...</p>
        </div>
      ) : loadError ? (
        <div className="bg-white rounded-2xl border border-rose-100 p-16 text-center flex flex-col items-center justify-center">
          <AlertTriangle size={48} className="text-rose-400 mb-4" />
          <h2 className="text-lg font-bold text-slate-700 mb-1">تعذر تحميل الشركات</h2>
          <p className="text-slate-500 text-sm mb-6">{loadError}</p>
          <button type="button" onClick={load} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-[13px] transition">
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      ) : filteredCompanies.length === 0 && !searchQuery ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
          <Building2 size={64} className="text-slate-200 mb-6" />
          <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد أي شركات حتى الآن</h2>
          <p className="text-slate-500 max-w-sm mb-8">ابدأ بتسجيل أول كيان قانوني خاص بك لتمكين إضافة الفروع والموظفين التابعين له.</p>
          <Link href="/companies/new" className="px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-blue-700 transition">
            + إنشاء أول شركة في النظام
          </Link>
        </div>
      ) : filteredCompanies.length === 0 && searchQuery ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center flex flex-col items-center justify-center">
          <Search size={48} className="text-slate-200 mb-4" />
          <h2 className="text-lg font-bold text-slate-600 mb-1">لا توجد نتائج مطابقة</h2>
          <p className="text-slate-400 text-sm">حاول تغيير كلمة البحث &quot;{searchQuery}&quot;</p>
        </div>
      ) : (
        /* Companies Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-4">
          {filteredCompanies.map((company, index) => (
            <div key={company.id} className={`bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden hover:shadow-md transition duration-300 ${deletingId === company.id ? 'opacity-50 pointer-events-none' : ''}`}>
              <div className="p-6 border-b border-slate-100 flex justify-between items-start">
                <div className="flex items-center gap-4">
                  <div className={`w-14 h-14 rounded-xl flex items-center justify-center font-bold text-2xl shadow-inner ${index % 2 === 0 ? 'bg-blue-50 text-blue-600' : 'bg-indigo-50 text-indigo-600'}`}>
                    {company.nameArabic?.charAt(0) || '؟'}
                  </div>
                  <div>
                    <Link href={`/companies/${company.id}`} className="block font-bold text-slate-800 text-lg leading-tight mb-1 hover:text-blue-600 transition-colors">{company.nameArabic}</Link>
                    <p className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md inline-flex items-center gap-1">
                      <Activity size={10} /> كيان نشط
                    </p>
                  </div>
                </div>
                {/* Action Menu */}
                <div className="relative">
                  <button
                    type="button"
                    aria-label={`إجراءات ${company.nameArabic}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen === company.id}
                    onClick={() => setMenuOpen(menuOpen === company.id ? null : company.id)}
                    className="text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-slate-50 transition"
                  >
                    <MoreVertical size={20} />
                  </button>
                  {menuOpen === company.id && (
                    <div role="menu" className="absolute left-0 top-full mt-1 bg-white rounded-xl shadow-xl border border-slate-100 z-50 w-44 overflow-hidden">
                      <Link href={`/companies/${company.id}/edit`} role="menuitem" onClick={() => setMenuOpen(null)}
                        className="flex items-center gap-2 px-4 py-3 text-[13px] font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-600 transition w-full">
                        <Edit size={15} /> تعديل البيانات
                      </Link>
                      <Link href={`/companies/${company.id}`} role="menuitem" onClick={() => setMenuOpen(null)}
                        className="flex items-center gap-2 px-4 py-3 text-[13px] font-bold text-slate-700 hover:bg-slate-50 transition w-full">
                        <Eye size={15} /> عرض التفاصيل
                      </Link>
                      <button type="button" role="menuitem" onClick={() => handleDelete(company.id)}
                        className="flex items-center gap-2 px-4 py-3 text-[13px] font-bold text-red-500 hover:bg-red-50 transition w-full text-right border-t border-slate-100">
                        <Trash2 size={15} /> حذف الشركة
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 bg-slate-50/50">
                <div className="grid grid-cols-2 gap-y-5 gap-x-4">
                  <div className="flex items-center gap-3 text-sm text-slate-600">
                    <div className="p-2 bg-white rounded-lg shadow-sm border border-slate-100">
                      <FileText size={18} className="text-slate-400" />
                    </div>
                    <div>
                      <p className="font-bold text-[11px] text-slate-400 uppercase mb-0.5">الرقم الضريبي</p>
                      <p className="text-xs font-black text-slate-700 tabular-nums">{company.taxNumber || '-'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-slate-600">
                    <div className="p-2 bg-white rounded-lg shadow-sm border border-slate-100">
                      <Building size={18} className="text-slate-400" />
                    </div>
                    <div>
                      <p className="font-bold text-[11px] text-slate-400 uppercase mb-0.5">الرقم الموحد</p>
                      <p className="text-xs font-black text-slate-700 tabular-nums">{company.unifiedNumber || '-'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-slate-600">
                    <div className="p-2 bg-white rounded-lg shadow-sm border border-slate-100">
                      <Users size={18} className="text-slate-400" />
                    </div>
                    <div>
                      <p className="font-bold text-[11px] text-slate-400 uppercase mb-0.5">الموظفين</p>
                      <p className="text-xs font-black text-slate-700">{company._count?.legalEmployees || 0} موظف</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
                <Link href="/branches" className="flex-1 text-center bg-white border-2 border-slate-100 text-slate-700 py-2.5 rounded-xl text-[13px] font-bold hover:border-blue-500 hover:text-blue-600 transition-colors">
                  إدارة الفروع
                </Link>
                <Link href="/departments" className="flex-1 text-center bg-white border-2 border-slate-100 text-slate-700 py-2.5 rounded-xl text-[13px] font-bold hover:border-blue-500 hover:text-blue-600 transition-colors">
                  الهيكل التنظيمي
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {/* Click outside to close menu */}
      {menuOpen && (
        <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setMenuOpen(null)} />
      )}
    </DashboardLayout>
  );
}
