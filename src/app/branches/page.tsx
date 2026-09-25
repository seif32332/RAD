"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Plus, Search, GitBranch, Users, MapPin, ChevronLeft, AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import {
  branchDocumentAlerts,
  branchDocumentAlertsFromAdminAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  type AdminAlert,
  type BranchDocumentAlert,
} from '@/lib/alerts';

interface BranchRow {
  id: string;
  nameArabic: string;
  companyId?: string | null;
  company?: { nameArabic: string } | null;
  branchCode?: string | null;
  city?: string | null;
  district?: string | null;
  munLicenseExp?: string | null;
  civilDefenseExp?: string | null;
  rentContractExp?: string | null;
  wasteContractExp?: string | null;
  safetyContractExp?: string | null;
  cameraContractExp?: string | null;
  _count?: { employees?: number; departments?: number };
}

/** "منتهية" or "تنتهي خلال N يوم" for one branch document. */
function docStatusText(a: BranchDocumentAlert): string {
  if (a.level === 'expired') return `منتهية منذ ${Math.abs(a.daysLeft)} يوم`;
  if (a.daysLeft === 0) return 'تنتهي اليوم';
  return `تنتهي خلال ${a.daysLeft} يوم`;
}

interface CompanyOption {
  id: string;
  nameArabic: string;
}

export default function BranchesPage() {
  const router = useRouter();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCompany, setSelectedCompany] = useState('');
  // Branch document alerts from /api/admin/alerts (configured thresholds). null = that endpoint is
  // not available to this role: the default thresholds are used instead.
  const [serverDocAlerts, setServerDocAlerts] = useState<BranchDocumentAlert[] | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [bRes, cRes, aRes] = await Promise.all([
        fetch('/api/branches', { cache: 'no-store' }),
        fetch('/api/companies'),
        fetch('/api/admin/alerts', { cache: 'no-store' }).catch(() => null),
      ]);
      if (bRes.status === 401) {
        router.replace('/login');
        return;
      }
      if (!bRes.ok) {
        setLoadError(await readApiError(bRes, 'تعذر تحميل الفروع'));
        return;
      }
      const b: unknown = await bRes.json();
      setBranches(Array.isArray(b) ? (b as BranchRow[]) : []);
      if (cRes.ok) {
        const c: unknown = await cRes.json();
        setCompanies(Array.isArray(c) ? (c as CompanyOption[]) : []);
      }
      if (aRes?.ok) {
        const a = (await aRes.json().catch(() => null)) as { alerts?: unknown } | null;
        setServerDocAlerts(Array.isArray(a?.alerts) ? branchDocumentAlertsFromAdminAlerts(a.alerts as AdminAlert[]) : null);
      } else {
        setServerDocAlerts(null);
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

  // Every dated document of each branch (licences and contracts), classified like the alert screens.
  const docAlertsByBranch = useMemo(() => {
    const list = serverDocAlerts ?? branches.flatMap((b) => branchDocumentAlerts(b, DEFAULT_ALERT_THRESHOLDS));
    const map = new Map<string, BranchDocumentAlert[]>();
    for (const a of list) map.set(a.branchId, [...(map.get(a.branchId) ?? []), a]);
    for (const docs of map.values()) docs.sort((x, y) => x.daysLeft - y.daysLeft);
    return map;
  }, [branches, serverDocAlerts]);

  const filtered = useMemo(() => {
    const q = search.trim();
    return branches.filter(b => {
      const matchSearch = !q || b.nameArabic.includes(q) || (b.city || '').includes(q);
      const matchCompany = selectedCompany ? b.companyId === selectedCompany : true;
      return matchSearch && matchCompany;
    });
  }, [branches, search, selectedCompany]);

  const stats = useMemo(() => [
    { label: 'إجمالي الفروع', value: filtered.length, color: 'bg-violet-50 border-violet-100 text-violet-600' },
    { label: 'الموظفون الكلي', value: filtered.reduce((a, b) => a + (b._count?.employees || 0), 0), color: 'bg-blue-50 border-blue-100 text-blue-600' },
    { label: 'الأقسام الكلية', value: filtered.reduce((a, b) => a + (b._count?.departments || 0), 0), color: 'bg-emerald-50 border-emerald-100 text-emerald-600' },
    { label: 'وثائق تنتهي قريباً أو منتهية', value: filtered.reduce((a, b) => a + (docAlertsByBranch.get(b.id)?.length ?? 0), 0), color: 'bg-red-50 border-red-100 text-red-600' },
  ], [filtered, docAlertsByBranch]);

  const isFiltering = !!search.trim() || !!selectedCompany;

  return (
    <DashboardLayout>
      <div className="p-6 max-w-[1400px] mx-auto space-y-8 pb-32">

        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-800 flex items-center gap-3">
              <span className="bg-violet-100 text-violet-600 p-2.5 rounded-2xl">
                <GitBranch size={28} />
              </span>
              إدارة الفروع
            </h1>
            <p className="text-slate-500 font-semibold text-[15px] mt-2 ml-14">جميع الفروع التابعة للشركات المسجلة في المنظومة</p>
          </div>
          <div className="flex items-center gap-4 w-full md:w-auto ml-14 md:ml-0">
            <select
              aria-label="تصفية حسب الشركة"
              value={selectedCompany}
              onChange={e => setSelectedCompany(e.target.value)}
              className="pl-4 pr-10 py-3.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-100 font-bold text-[13px] text-slate-700 cursor-pointer shadow-sm appearance-none"
            >
              <option value="">كل الشركات</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.nameArabic}</option>)}
            </select>
            <div className="relative flex-1 md:w-56">
              <input type="text" aria-label="بحث عن فرع" placeholder="ابحث عن فرع..." value={search} onChange={e => setSearch(e.target.value)}
                className="w-full pl-10 pr-5 py-3.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-4 focus:ring-violet-100 focus:border-violet-400 font-bold text-sm shadow-sm transition-all" />
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            </div>
            <Link href="/branches/new" className="bg-slate-900 hover:bg-violet-600 text-white px-6 py-3.5 rounded-2xl flex items-center gap-2 transition-all duration-300 shadow-xl shadow-slate-200 hover:shadow-violet-500/30 font-bold hover:-translate-y-0.5 whitespace-nowrap">
              <Plus size={20} />إضافة فرع
            </Link>
          </div>
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map(s => (
            <div key={s.label} className={`rounded-2xl border p-5 ${s.color}`}>
              <p className="text-[11px] font-black uppercase tracking-widest opacity-70 mb-1">{s.label}</p>
              <p className="text-3xl font-black">{isLoading || loadError ? '—' : s.value}</p>
            </div>
          ))}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center p-32 bg-white rounded-[2rem] border border-slate-100">
            <div className="w-12 h-12 rounded-full border-4 border-violet-100 border-t-violet-600 animate-spin" aria-label="جاري التحميل" />
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-[2.5rem] border border-rose-100 p-20 text-center flex flex-col items-center justify-center">
            <AlertTriangle size={40} className="text-rose-400 mb-4" />
            <h2 className="text-xl font-black text-slate-800 mb-2">تعذر تحميل الفروع</h2>
            <p className="text-slate-500 mb-6 font-medium">{loadError}</p>
            <button type="button" onClick={load} className="px-6 py-3 bg-violet-600 text-white font-extrabold rounded-2xl hover:bg-violet-700 transition-all flex items-center gap-2">
              <RefreshCw size={18} />إعادة المحاولة
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-[2.5rem] border border-dashed border-slate-300 p-24 text-center flex flex-col items-center justify-center">
            <div className="w-20 h-20 bg-violet-50 rounded-3xl flex items-center justify-center mb-6">
              <GitBranch size={36} className="text-violet-400" />
            </div>
            <h2 className="text-xl font-black text-slate-800 mb-2">{isFiltering ? 'لا توجد نتائج' : 'لا يوجد فروع بعد'}</h2>
            <p className="text-slate-500 mb-8 font-medium">{isFiltering ? 'جرّب تغيير البحث أو الشركة المختارة' : 'قم بإضافة فرع وربطه بإحدى الشركات المسجلة'}</p>
            {!isFiltering && (
              <Link href="/branches/new" className="px-7 py-4 bg-violet-600 text-white font-extrabold rounded-2xl hover:bg-violet-700 transition-all flex items-center gap-2">
                <Plus size={20} />إضافة أول فرع
              </Link>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map(branch => (
              <div key={branch.id} className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_40px_rgba(109,40,217,0.08)] hover:border-violet-100 transition-all duration-300 group overflow-hidden">
                <div className="h-2 bg-gradient-to-r from-violet-500 to-indigo-500" />
                <div className="p-6">
                  <div className="flex items-start justify-between mb-5">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-violet-50 flex items-center justify-center text-violet-600 font-black text-xl group-hover:scale-110 transition-transform">
                        {branch.nameArabic.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-extrabold text-slate-800 text-[15px] group-hover:text-violet-700 transition-colors">{branch.nameArabic}</h3>
                        <p className="text-[12px] font-bold text-slate-400">{branch.company?.nameArabic}</p>
                      </div>
                    </div>
                    {branch.branchCode && (
                      <span className="text-[10px] font-black bg-slate-100 text-slate-500 px-2.5 py-1 rounded-lg font-mono">{branch.branchCode}</span>
                    )}
                  </div>

                  {branch.city && (
                    <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-500 mb-4">
                      <MapPin size={14} className="text-slate-400" />
                      {branch.city}{branch.district ? ` - ${branch.district}` : ''}
                    </div>
                  )}

                  <div className="flex items-center gap-4 mb-5">
                    <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-600 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-100">
                      <Users size={13} className="text-blue-500" />
                      {branch._count?.employees || 0} موظف
                    </div>
                    <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-600 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-100">
                      <Building2 size={13} className="text-purple-500" />
                      {branch._count?.departments || 0} قسم
                    </div>
                  </div>

                  {/* Licence and contract alerts */}
                  {(docAlertsByBranch.get(branch.id)?.length ?? 0) > 0 && (
                    <ul className="space-y-1.5 mb-4">
                      {docAlertsByBranch.get(branch.id)!.map((a) => (
                        <li key={a.type} className={`flex items-center gap-2 text-[12px] font-bold px-3 py-2 rounded-xl border ${a.level === 'expired' ? 'text-red-700 bg-red-50 border-red-100' : 'text-amber-700 bg-amber-50 border-amber-100'}`}>
                          <AlertCircle size={14} className="shrink-0" />
                          {a.label}: {docStatusText(a)}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex gap-2">
                    <Link href={`/branches/${branch.id}`}
                      className="flex-1 py-3 bg-slate-50 hover:bg-violet-50 hover:text-violet-600 text-slate-600 rounded-xl font-bold text-[13px] border border-slate-100 hover:border-violet-100 transition-all flex items-center justify-center gap-2">
                      <ChevronLeft size={16} />عرض التفاصيل
                    </Link>
                    <Link href={`/branches/${branch.id}/edit`}
                      className="py-3 px-4 bg-amber-50 hover:bg-amber-100 text-amber-600 rounded-xl font-bold text-[13px] border border-amber-100 hover:border-amber-200 transition-all flex items-center justify-center">
                      تعديل
                    </Link>
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
