"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Layers, Plus, Search, Users, Building2, GitBranch, Pencil, Trash2, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';

interface DepartmentRow {
  id: string;
  nameArabic: string;
  nameEnglish?: string | null;
  branchId?: string | null;
  branch?: { nameArabic: string; company?: { nameArabic: string } | null } | null;
  _count?: { employees?: number };
}

interface BranchOption {
  id: string;
  nameArabic: string;
}

export default function DepartmentsPage() {
  const router = useRouter();
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [dRes, bRes] = await Promise.all([fetch('/api/departments', { cache: 'no-store' }), fetch('/api/branches')]);
      if (dRes.status === 401) {
        router.replace('/login');
        return;
      }
      if (!dRes.ok) {
        setLoadError(await readApiError(dRes, 'تعذر تحميل الأقسام'));
        return;
      }
      const d: unknown = await dRes.json();
      setDepartments(Array.isArray(d) ? (d as DepartmentRow[]) : []);
      if (bRes.ok) {
        const b: unknown = await bRes.json();
        setBranches(Array.isArray(b) ? (b as BranchOption[]) : []);
      }
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
    const q = search.trim();
    return departments.filter(d => {
      const matchSearch = !q || d.nameArabic.includes(q) || (d.nameEnglish || '').toLowerCase().includes(q.toLowerCase());
      const matchBranch = selectedBranch ? d.branchId === selectedBranch : true;
      return matchSearch && matchBranch;
    });
  }, [departments, search, selectedBranch]);

  const stats = useMemo(() => [
    { label: 'إجمالي الأقسام', value: departments.length, color: 'bg-amber-50 border-amber-100 text-amber-600' },
    { label: 'إجمالي الموظفين', value: departments.reduce((a, d) => a + (d._count?.employees || 0), 0), color: 'bg-blue-50 border-blue-100 text-blue-600' },
    { label: 'الفروع المرتبطة', value: new Set(departments.map(d => d.branchId)).size, color: 'bg-violet-50 border-violet-100 text-violet-600' },
  ], [departments]);

  const isFiltering = !!search.trim() || !!selectedBranch;

  const handleDelete = async (id: string, name: string) => {
    if (deletingId) return;
    if (!(await confirmDialog(`هل أنت متأكد من حذف قسم "${name}"؟`, { danger: true, confirmText: 'حذف' }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/departments/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'فشل الحذف'));
        return;
      }
      setDepartments(prev => prev.filter(d => d.id !== id));
      toast.success('تم حذف القسم');
    } catch {
      toast.error('حدث خطأ في الاتصال');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6 max-w-[1400px] mx-auto space-y-8 pb-32">

        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-800 flex items-center gap-3">
              <span className="bg-amber-100 text-amber-600 p-2.5 rounded-2xl">
                <Layers size={28} />
              </span>
              إدارة الأقسام
            </h1>
            <p className="text-slate-500 font-semibold text-[15px] mt-2 ml-14">الأقسام الوظيفية التابعة للفروع المسجلة في المنظومة</p>
          </div>
          <div className="flex items-center gap-4 w-full md:w-auto ml-14 md:ml-0">
            <select aria-label="تصفية حسب الفرع" value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)}
              className="pl-4 pr-10 py-3.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-100 font-bold text-[13px] text-slate-700 cursor-pointer shadow-sm appearance-none">
              <option value="">كل الفروع</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.nameArabic}</option>)}
            </select>
            <div className="relative flex-1 md:w-56">
              <input type="text" aria-label="بحث عن قسم" placeholder="ابحث عن قسم..." value={search} onChange={e => setSearch(e.target.value)}
                className="w-full pl-10 pr-5 py-3.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-4 focus:ring-amber-100 focus:border-amber-400 font-bold text-sm shadow-sm transition-all" />
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            </div>
            <Link href="/departments/new" className="bg-slate-900 hover:bg-amber-600 text-white px-6 py-3.5 rounded-2xl flex items-center gap-2 transition-all duration-300 shadow-xl shadow-slate-200 hover:shadow-amber-500/30 font-bold hover:-translate-y-0.5 whitespace-nowrap">
              <Plus size={20} />إضافة قسم
            </Link>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {stats.map(s => (
            <div key={s.label} className={`rounded-2xl border p-5 ${s.color}`}>
              <p className="text-[11px] font-black uppercase tracking-widest opacity-70 mb-1">{s.label}</p>
              <p className="text-3xl font-black">{isLoading || loadError ? '—' : s.value}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center p-32 bg-white rounded-[2rem] border border-slate-100">
            <div className="w-12 h-12 rounded-full border-4 border-amber-100 border-t-amber-500 animate-spin" aria-label="جاري التحميل" />
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-[2.5rem] border border-rose-100 p-20 text-center flex flex-col items-center">
            <AlertTriangle size={40} className="text-rose-400 mb-4" />
            <h2 className="text-xl font-black text-slate-800 mb-2">تعذر تحميل الأقسام</h2>
            <p className="text-slate-500 mb-6 font-medium">{loadError}</p>
            <button type="button" onClick={load} className="px-6 py-3 bg-amber-500 text-white font-extrabold rounded-2xl hover:bg-amber-600 transition-all flex items-center gap-2">
              <RefreshCw size={18} />إعادة المحاولة
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-[2.5rem] border border-dashed border-slate-300 p-24 text-center flex flex-col items-center">
            <div className="w-20 h-20 bg-amber-50 rounded-3xl flex items-center justify-center mb-6">
              <Layers size={36} className="text-amber-400" />
            </div>
            <h2 className="text-xl font-black text-slate-800 mb-2">{isFiltering ? 'لا توجد نتائج' : 'لا يوجد أقسام بعد'}</h2>
            <p className="text-slate-500 mb-8 font-medium">{isFiltering ? 'جرّب تغيير البحث أو الفرع المختار' : 'قم بإنشاء أقسام وربطها بفروع الشركات'}</p>
            {!isFiltering && (
              <Link href="/departments/new" className="px-7 py-4 bg-amber-500 text-white font-extrabold rounded-2xl hover:bg-amber-600 transition-all flex items-center gap-2">
                <Plus size={20} />إضافة أول قسم
              </Link>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] overflow-hidden">
            <div className="hidden md:grid grid-cols-12 gap-4 p-5 bg-slate-50/80 border-b border-slate-100 rounded-t-[2rem] text-[11px] font-black tracking-widest text-slate-400 uppercase">
              <div className="col-span-4">اسم القسم</div>
              <div className="col-span-2">الفرع</div>
              <div className="col-span-3">الشركة</div>
              <div className="col-span-1 text-center">الموظفون</div>
              <div className="col-span-2 text-center">الإجراءات</div>
            </div>
            <div className="divide-y divide-slate-100">
              {filtered.map(dept => (
                <div key={dept.id} className={`grid grid-cols-1 md:grid-cols-12 gap-3 p-5 md:p-6 items-center hover:bg-amber-50/30 transition-all group ${deletingId === dept.id ? 'opacity-50' : ''}`}>
                  <div className="col-span-4 flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 font-black text-lg shrink-0 group-hover:scale-110 transition-transform">
                      {dept.nameArabic.charAt(0)}
                    </div>
                    <div>
                      <p className="font-extrabold text-slate-800 group-hover:text-amber-700 transition-colors">{dept.nameArabic}</p>
                      {dept.nameEnglish && <p className="text-[12px] text-slate-400 font-semibold">{dept.nameEnglish}</p>}
                    </div>
                  </div>
                  <div className="col-span-2 flex items-center gap-2 text-[13px] font-bold text-slate-600">
                    <GitBranch size={14} className="text-violet-400" />{dept.branch?.nameArabic || '—'}
                  </div>
                  <div className="col-span-3 flex items-center gap-2 text-[13px] font-bold text-slate-500">
                    <Building2 size={14} className="text-slate-300" />{dept.branch?.company?.nameArabic || '—'}
                  </div>
                  <div className="col-span-1 flex justify-center">
                    <span className="flex items-center gap-1.5 text-[12px] font-bold text-blue-600 bg-blue-50 border border-blue-100 px-3 py-1.5 rounded-xl">
                      <Users size={13} />{dept._count?.employees || 0}
                    </span>
                  </div>
                  {/* Visible on hover for pointers, always visible on keyboard focus and touch/small screens. */}
                  <div className="col-span-2 flex justify-center gap-2 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity">
                    <Link href={`/departments/${dept.id}/edit`} aria-label={`تعديل قسم ${dept.nameArabic}`} title="تعديل" className="w-8 h-8 rounded-lg bg-slate-100 text-slate-500 hover:bg-amber-100 hover:text-amber-600 flex items-center justify-center transition-colors">
                      <Pencil size={15} />
                    </Link>
                    <button type="button" aria-label={`حذف قسم ${dept.nameArabic}`} title="حذف" disabled={deletingId === dept.id} onClick={() => handleDelete(dept.id, dept.nameArabic)} className="w-8 h-8 rounded-lg bg-slate-100 text-slate-500 hover:bg-red-100 hover:text-red-600 flex items-center justify-center transition-colors disabled:opacity-50">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
