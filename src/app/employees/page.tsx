"use client";

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Users, Plus, Search, MoreVertical, Briefcase, Building2, MapPin, UserCheck, ShieldAlert, UserPlus, Eye, Pencil, Ban, Printer, Download, SlidersHorizontal, ArrowUpDown, Upload, AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDateShort, todayKey, dateKey } from '@/lib/dates';
import { formatMoney, sumMoney } from '@/lib/money';
import { LEAVE_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { SAUDI_NATIONALITY, isSaudiNationalityValue } from '@/lib/employee-shared';
import { useRole } from '@/context/RoleContext';

interface NamedRef { id: string; nameArabic: string }
interface OrgRow extends NamedRef { companyId?: string | null; administrationId?: string | null }
interface EmployeeLeave { id: string; status: string; startDate: string; endDate: string; isReturned?: boolean | null }
interface EmployeeAllowance { id: string; amount: number | null }
interface EmployeeRow {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic?: string | null;
  firstNameEnglish?: string | null;
  lastNameEnglish?: string | null;
  jobTitle?: string | null;
  iqamaOrIdNumber?: string | null;
  iqamaOrIdExp?: string | null;
  contractEndDate?: string | null;
  passportNumber?: string | null;
  passportExp?: string | null;
  healthCertificateNum?: string | null;
  healthCertificateExp?: string | null;
  joinDate?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  mobileNumber?: string | null;
  email?: string | null;
  ibanNumber?: string | null;
  bankName?: string | null;
  salaryPaymentMethod?: string | null;
  basicSalary?: number | null;
  gosiDeduction?: number | null;
  isTerminated?: boolean;
  createdAt: string;
  legalCompanyId?: string | null;
  actualCompanyId?: string | null;
  administrationId?: string | null;
  branchId?: string | null;
  legalCompany?: NamedRef | null;
  administration?: NamedRef | null;
  branch?: NamedRef | null;
  department?: NamedRef | null;
  directManager?: { firstNameArabic: string; lastNameArabic?: string | null } | null;
  leaves?: EmployeeLeave[];
  allowances?: EmployeeAllowance[];
  /** Incomplete data HR must complete (HR rows only). */
  dataReviewNote?: string | null;
}

const totalSalaryOf = (emp: EmployeeRow) => sumMoney([emp.basicSalary ?? 0, ...(emp.allowances ?? []).map((a) => a.amount ?? 0)]);

/** True when the date-only value falls on or before `soonKey` (YYYY-MM-DD). */
const expiresSoon = (d: string | null | undefined, soonKey: string) => {
  const k = dateKey(d);
  return k !== null && k <= soonKey;
};


export default function EmployeesPage() {
  const router = useRouter();
  const { role } = useRole();
  // Create / import / edit / end-of-service are HR-only on the server too.
  const isHr = roleIn(role, ROLE_GROUPS.HR);
  // GOSI regime review (DEC-003): HR + payroll / finance (same guard as /api/employees/gosi-review).
  const canReviewGosi = roleIn(role, ROLE_GROUPS.PAYROLL);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  
  const [filterType, setFilterType] = useState('ALL');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterAdministration, setFilterAdministration] = useState('');
  const [filterBranch, setFilterBranch] = useState('');
  const [companies, setCompanies] = useState<OrgRow[]>([]);
  const [allAdministrations, setAllAdministrations] = useState<OrgRow[]>([]);
  const [allBranches, setAllBranches] = useState<OrgRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [sortColumn, setSortColumn] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('DESC');

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      setSortOrder(sortOrder === 'ASC' ? 'DESC' : 'ASC');
    } else {
      setSortColumn(col);
      setSortOrder('ASC');
    }
  };
  const [visibleCols, setVisibleCols] = useState({
    salary: false,
    contractExp: false,
    iqamaExp: true,
    bankInfo: true,
    mobile: false,
    email: false,
    passport: false,
    healthCert: false,
    joinDate: false,
    dob: false,
    nationality: false,
    branch: false,
    department: false,
    manager: false,
    gender: false,
    maritalStatus: false,
    gosi: false,
    englishName: false,
    iqamaNumber: false,
    administration: false,
    bankName: false,
    salaryMethod: false
  });
  const [showOptions, setShowOptions] = useState(false);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [empRes, compRes, admRes, brRes] = await Promise.all([
        fetch('/api/employees', { cache: 'no-store' }),
        fetch('/api/companies'),
        fetch('/api/administrations'),
        fetch('/api/branches'),
      ]);
      if (empRes.status === 401) {
        router.replace('/login');
        return;
      }
      if (!empRes.ok) {
        setLoadError(await readApiError(empRes, 'تعذر تحميل قائمة الموظفين'));
        return;
      }
      const emps: unknown = await empRes.json();
      setEmployees(Array.isArray(emps) ? (emps as EmployeeRow[]) : []);
      // Filter lists are optional: a failure only leaves the related filter empty.
      const readList = async (res: Response): Promise<OrgRow[]> => {
        if (!res.ok) return [];
        const data: unknown = await res.json().catch(() => []);
        return Array.isArray(data) ? (data as OrgRow[]) : [];
      };
      const [comps, admins, brnchs] = await Promise.all([readList(compRes), readList(admRes), readList(brRes)]);
      setCompanies(comps);
      setAllAdministrations(admins);
      setAllBranches(brnchs);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) {
        setShowOptions(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Derived state (memoized: recomputed only when the data or a filter changes)
  const onLeaveIds = useMemo(() => {
    const t = todayKey();
    const ids = new Set<string>();
    for (const emp of employees) {
      const onLeave = (emp.leaves ?? []).some((l) => {
        if (l.status !== LEAVE_STATUS.APPROVED || l.isReturned) return false;
        const start = dateKey(l.startDate);
        const end = dateKey(l.endDate);
        return start !== null && end !== null && start <= t && end >= t;
      });
      if (onLeave) ids.add(emp.id);
    }
    return ids;
  }, [employees]);

  const soonKey = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    return todayKey(d);
  }, []);

  const filteredEmployees = useMemo(() => {
    const q = search.trim();
    const FAR_FUTURE = 9999999999999;
    const time = (d: string | null | undefined, fallback: number) => (d ? new Date(d).getTime() : fallback);
    return employees
      .filter(emp =>
        !q ||
        emp.firstNameArabic.includes(q) ||
        (emp.lastNameArabic || '').includes(q) ||
        (emp.employeeId || '').includes(q) ||
        (emp.jobTitle || '').includes(q) ||
        (emp.iqamaOrIdNumber || '').includes(q)
      )
      .filter(emp => {
        if (filterType === 'ACTIVE') return !emp.isTerminated;
        if (filterType === 'TERMINATED') return !!emp.isTerminated;
        if (filterType === 'ON_LEAVE') return onLeaveIds.has(emp.id) && !emp.isTerminated;
        return true;
      })
      .filter(emp => {
        if (filterCompany && emp.legalCompanyId !== filterCompany && emp.actualCompanyId !== filterCompany) return false;
        if (filterAdministration && emp.administrationId !== filterAdministration) return false;
        if (filterBranch && emp.branchId !== filterBranch) return false;
        return true;
      })
      .sort((a, b) => {
        let valA: string | number;
        let valB: string | number;
        if (sortColumn === 'name') {
          valA = a.firstNameArabic; valB = b.firstNameArabic;
        } else if (sortColumn === 'job') {
          valA = a.jobTitle || ''; valB = b.jobTitle || '';
        } else if (sortColumn === 'status') {
          valA = a.isTerminated ? 1 : 0; valB = b.isTerminated ? 1 : 0;
        } else if (sortColumn === 'iqama') {
          valA = time(a.iqamaOrIdExp, FAR_FUTURE); valB = time(b.iqamaOrIdExp, FAR_FUTURE);
        } else if (sortColumn === 'contract') {
          valA = time(a.contractEndDate, FAR_FUTURE); valB = time(b.contractEndDate, FAR_FUTURE);
        } else {
          valA = time(a.createdAt, 0); valB = time(b.createdAt, 0);
        }
        if (valA < valB) return sortOrder === 'ASC' ? -1 : 1;
        if (valA > valB) return sortOrder === 'ASC' ? 1 : -1;
        return 0;
      });
  }, [employees, search, filterType, filterCompany, filterAdministration, filterBranch, sortColumn, sortOrder, onLeaveIds]);

  const noExtraCols = Object.values(visibleCols).every(v => !v);

  const exportExcel = async () => {
    if (isExporting) return;
    if (filteredEmployees.length === 0) {
      toast.warning('لا توجد بيانات للتصدير');
      return;
    }
    setIsExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows = filteredEmployees.map(emp => ({
        'الرقم الوظيفي': emp.employeeId,
        'الاسم': `${emp.firstNameArabic} ${emp.lastNameArabic || ''}`.trim(),
        'المنصب': emp.jobTitle || '',
        'حالة العقد': emp.isTerminated ? 'منتهي' : 'مستمر',
        'تاريخ انتهاء الهوية/الإقامة': emp.iqamaOrIdExp ? formatDateShort(emp.iqamaOrIdExp) : '',
        'إجمالي الراتب': totalSalaryOf(emp),
        'الحساب البنكي': emp.ibanNumber || '',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 14 }, { wch: 30 }, { wch: 22 }, { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 30 }];
      const wb = XLSX.utils.book_new();
      wb.Workbook = { Views: [{ RTL: true }] };
      XLSX.utils.book_append_sheet(wb, ws, 'الموظفين');
      XLSX.writeFile(wb, `employees_export_${todayKey()}.xlsx`);
      toast.success(`تم تصدير ${rows.length} موظف`);
    } catch {
      toast.error('تعذر إنشاء ملف Excel');
    } finally {
      setIsExporting(false);
    }
  };

  const colW = 'print:!w-[80px]';

  return (
    <DashboardLayout>
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <div className="p-6 print:p-0 max-w-[1400px] print:max-w-full mx-auto space-y-8 print:space-y-2 pb-32 print:pb-0 print:text-[10px]">

        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-4 print:mb-1">
          <div>
            <h1 className="text-3xl print:text-[14px] font-black text-slate-800 flex items-center gap-3">
              <span className="bg-blue-100 text-blue-600 p-2.5 rounded-2xl print:hidden"><Users size={28} /></span>
              إدارة الموظفين
              {!isLoading && !loadError && (
                <span className="bg-slate-100 text-slate-600 text-sm print:text-[10px] px-3 py-1 rounded-xl mr-2">
                  {filteredEmployees.length} موظف
                </span>
              )}
            </h1>
            <p className="text-slate-500 font-semibold text-[15px] mt-2 ml-14 print:hidden">الإدارة الشاملة لبيانات وعقود الموظفين المرتبطين بالمنظومة</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 w-full md:w-auto ml-14 md:ml-0 print:hidden">
            <div className="relative flex-1 md:w-64">
              <input type="text" aria-label="بحث في الموظفين" placeholder="ابحث بالاسم، الرقم الوظيفي، الهوية/الإقامة..." value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-5 py-3.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 font-bold text-sm shadow-[0_4px_24px_rgba(0,0,0,0.02)] transition-all" />
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            </div>
            {canReviewGosi && (
            <Link href="/employees/gosi-review" title="تأكيد نظام التأمينات (قديم / جديد) للموظفين السعوديين غير المؤكدين" className="bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 px-5 py-3.5 rounded-2xl flex items-center gap-2 transition-all duration-300 font-bold whitespace-nowrap text-[13px]">
              <ShieldCheck size={18} />مراجعة التأمينات
            </Link>
            )}
            {isHr && (<>
            <Link href="/employees/import" className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-3.5 rounded-2xl flex items-center gap-2 transition-all duration-300 shadow-xl shadow-emerald-200 hover:shadow-emerald-500/30 font-bold hover:-translate-y-0.5 whitespace-nowrap text-[13px]">
              <Upload size={18} />استيراد Excel
            </Link>
            <Link href="/employees/new" className="bg-slate-900 hover:bg-blue-600 text-white px-6 py-3.5 rounded-2xl flex items-center gap-2 transition-all duration-300 shadow-xl shadow-slate-200 hover:shadow-blue-500/30 font-bold hover:-translate-y-0.5 whitespace-nowrap">
              <Plus size={20} />تسجيل فرد جديد
            </Link>
            </>)}
          </div>
        </div>

        {/* Actions Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-3 rounded-[1.5rem] border border-slate-200 mb-4 shadow-sm relative print:hidden">
           <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setFilterType('ALL')} className={`px-4 py-2 rounded-xl text-[12px] font-black transition ${filterType === 'ALL' ? 'bg-slate-800 text-white shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>الجميع</button>
              <button type="button" onClick={() => setFilterType('ACTIVE')} className={`px-4 py-2 rounded-xl text-[12px] font-black transition ${filterType === 'ACTIVE' ? 'bg-emerald-600 text-white shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-emerald-50'}`}>على رأس العمل</button>
              <button type="button" onClick={() => setFilterType('ON_LEAVE')} className={`px-4 py-2 rounded-xl text-[12px] font-black transition ${filterType === 'ON_LEAVE' ? 'bg-amber-500 text-white shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-amber-50'}`}>في الإجازة</button>
              <button type="button" onClick={() => setFilterType('TERMINATED')} className={`px-4 py-2 rounded-xl text-[12px] font-black transition ${filterType === 'TERMINATED' ? 'bg-rose-600 text-white shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-rose-50'}`}>مستبعدين</button>
           </div>

           {/* Company & Branch Filters */}
           <div className="flex flex-wrap items-center gap-2">
              <select aria-label="تصفية حسب الشركة" value={filterCompany} onChange={(e) => { setFilterCompany(e.target.value); setFilterAdministration(''); setFilterBranch(''); }}
                className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-[12px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 cursor-pointer appearance-none min-w-[140px]">
                <option value="">كل الشركات</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.nameArabic}</option>)}
              </select>
              <select aria-label="تصفية حسب الإدارة" value={filterAdministration} onChange={(e) => { setFilterAdministration(e.target.value); setFilterBranch(''); }}
                className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-[12px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 cursor-pointer appearance-none min-w-[140px]">
                <option value="">كل الإدارات</option>
                {allAdministrations
                  .filter((adm) => !filterCompany || adm.companyId === filterCompany)
                  .map((adm) => <option key={adm.id} value={adm.id}>{adm.nameArabic}</option>)}
              </select>
              <select aria-label="تصفية حسب الفرع" value={filterBranch} onChange={(e) => setFilterBranch(e.target.value)}
                className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-[12px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 cursor-pointer appearance-none min-w-[140px]">
                <option value="">كل الفروع</option>
                {allBranches
                  .filter((br) => {
                     if (filterCompany && br.companyId !== filterCompany) return false;
                     if (filterAdministration && br.administrationId !== filterAdministration) return false;
                     return true;
                  })
                  .map((br) => <option key={br.id} value={br.id}>{br.nameArabic}</option>)}
              </select>
              {(filterCompany || filterAdministration || filterBranch) && (
                <button type="button" onClick={() => { setFilterCompany(''); setFilterAdministration(''); setFilterBranch(''); }}
                  className="px-3 py-2 bg-red-50 border border-red-200 rounded-xl text-[12px] font-bold text-red-600 hover:bg-red-100 transition">
                  مسح الفلتر
                </button>
              )}
           </div>

           <div className="flex items-center gap-2 relative" ref={optionsRef}>
              <button type="button" onClick={() => setShowOptions(!showOptions)} aria-label="تخصيص الأعمدة الإضافية" aria-expanded={showOptions} className={`p-2 border rounded-lg transition ${showOptions ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`} title="تخصيص الأعمدة الإضافية">
                 <SlidersHorizontal size={18} />
              </button>
              <button type="button" onClick={() => handleSort('createdAt')} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition flex items-center gap-2 text-[12px] font-bold">
                 <ArrowUpDown size={16} className={sortColumn === 'createdAt' ? "text-blue-500" : "text-slate-400"}/> {sortColumn === 'createdAt' && sortOrder === 'ASC' ? 'ترتيب: الأقدم (تاريخ التسجيل)' : 'ترتيب: الأحدث (الافتراضي)'}
              </button>
              <div className="h-6 w-px bg-slate-200 mx-1"></div>
              <button type="button" onClick={exportExcel} disabled={isExporting || isLoading} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-emerald-700 hover:bg-emerald-50 transition flex items-center gap-2 text-[12px] font-bold disabled:opacity-50 disabled:cursor-not-allowed" title="تصدير القائمة الحالية إلى ملف Excel">
                 <Download size={16}/> {isExporting ? 'جاري التصدير...' : 'إكسيل'}
              </button>
              <button type="button" onClick={() => window.print()} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-blue-700 hover:bg-blue-50 transition flex items-center gap-2 text-[12px] font-bold" title="طباعة الصفحة كتقرير">
                 <Printer size={16}/> طباعة
              </button>

           {/* Dropdown Options */}
           {showOptions && (
              <div className="absolute top-[110%] right-0 bg-white border border-slate-200 p-5 rounded-2xl shadow-xl z-50 w-72 max-h-96 overflow-y-auto animate-in fade-in">
                 <h4 className="text-[11px] font-black text-slate-400 mb-4 uppercase">الأعمدة الإضافية المتاحة للعرض</h4>

                 {COLUMN_OPTIONS.map((col) => (
                   <label key={col.key} className="flex items-center gap-3 font-bold text-[13px] text-slate-700 cursor-pointer mb-3 select-none hover:bg-slate-50 p-1.5 rounded-lg transition-colors">
                     <input
                        type="checkbox"
                        checked={visibleCols[col.key]}
                        onChange={() => setVisibleCols(prev => ({ ...prev, [col.key]: !prev[col.key] }))}
                        className="w-5 h-5 rounded border-slate-300 text-blue-600 accent-blue-600 focus:ring-blue-500"
                     />
                     {col.label}
                   </label>
                 ))}

              </div>
           )}
           </div>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-32 gap-6 bg-white rounded-[2.5rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.02)]">
            <div className="relative">
              <div className="w-16 h-16 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <Users className="text-blue-600 w-6 h-6 animate-pulse" />
              </div>
            </div>
            <p className="text-slate-500 font-bold text-lg animate-pulse">جاري فحص أرشيف الموظفين...</p>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-[2.5rem] border border-rose-100 p-20 text-center flex flex-col items-center justify-center">
            <AlertTriangle size={40} className="text-rose-500 mb-4" />
            <h2 className="text-xl font-black text-slate-800 mb-2">تعذر تحميل قائمة الموظفين</h2>
            <p className="text-slate-500 font-bold text-[14px] mb-6">{loadError}</p>
            <button type="button" onClick={loadData} className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black text-[14px] transition-colors">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : employees.length === 0 ? (
          <div className="bg-white rounded-[2.5rem] border border-dashed border-slate-300 p-24 text-center flex flex-col items-center justify-center">
            <div className="w-24 h-24 bg-blue-50 rounded-3xl flex items-center justify-center mb-8 shadow-inner rotate-3">
              <Users size={40} className="text-blue-500 -rotate-3" />
            </div>
            <h2 className="text-2xl font-black text-slate-800 mb-3">لم تقم بتسجيل أي موظف بعد!</h2>
            <p className="text-slate-500 font-medium max-w-md mx-auto mb-10 text-[15px] leading-relaxed">أضف أول موظف واستفد من الأتمتة الذكية وإدارة مسيرات الرواتب.</p>
            {isHr && (
            <Link href="/employees/new" className="px-8 py-4 bg-blue-600 text-white font-extrabold text-[15px] rounded-2xl hover:bg-blue-700 hover:shadow-xl hover:shadow-blue-500/30 transition-all duration-300 flex items-center gap-2 hover:-translate-y-1">
              <UserPlus size={20} />ابدأ الآن بتوثيق الموظفين
            </Link>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-[2rem] print:rounded-none border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.02)] print:shadow-none overflow-x-auto print:overflow-visible">
            <div className="min-w-max print:min-w-0">
            <div className="hidden lg:flex print:flex gap-4 print:gap-1 p-5 print:p-1 bg-slate-50/80 border-b border-slate-100/80 rounded-t-[2rem] print:rounded-none text-[12px] print:text-[8px] font-black text-slate-400 uppercase select-none w-full">
              <button type="button" className="w-[280px] print:w-[160px] shrink-0 pl-4 flex items-center gap-1 hover:text-blue-600 transition font-black uppercase text-right" onClick={() => handleSort('name')}>هوية الموظف {sortColumn === 'name' && <ArrowUpDown size={14} className="text-blue-600"/>}</button>
              <button type="button" className="w-[220px] print:w-[130px] shrink-0 flex items-center gap-1 hover:text-blue-600 transition font-black uppercase text-right" onClick={() => handleSort('job')}>المنصب والشركة {sortColumn === 'job' && <ArrowUpDown size={14} className="text-blue-600"/>}</button>
              <button type="button" className="w-[180px] print:w-[90px] shrink-0 flex items-center gap-1 hover:text-blue-600 transition font-black uppercase text-right" onClick={() => handleSort('status')}>الحالة {sortColumn === 'status' && <ArrowUpDown size={14} className="text-blue-600"/>}</button>

              {/* Dynamic Columns Headers */}
              {visibleCols.iqamaExp && <button type="button" className={`w-[140px] ${colW} shrink-0 flex items-center gap-1 hover:text-blue-600 transition font-black uppercase text-right`} onClick={() => handleSort('iqama')}>إنتهاء الهوية {sortColumn === 'iqama' && <ArrowUpDown size={14} className="text-blue-600"/>}</button>}
              {visibleCols.contractExp && <button type="button" className={`w-[140px] ${colW} shrink-0 flex items-center gap-1 hover:text-blue-600 transition font-black uppercase text-right`} onClick={() => handleSort('contract')}>نهاية العقد {sortColumn === 'contract' && <ArrowUpDown size={14} className="text-blue-600"/>}</button>}
              {visibleCols.salary && <div className={`w-[140px] ${colW} shrink-0`}>إجمالي الراتب</div>}
              {visibleCols.bankInfo && <div className={`w-[160px] ${colW} shrink-0`}>الحساب البنكي</div>}
              {visibleCols.mobile && <div className={`w-[140px] ${colW} shrink-0`}>رقم الجوال</div>}
              {visibleCols.email && <div className="w-[200px] print:w-[100px] shrink-0">البريد الإلكتروني</div>}
              {visibleCols.joinDate && <div className={`w-[140px] ${colW} shrink-0`}>تاريخ المباشرة</div>}
              {visibleCols.passport && <div className={`w-[160px] ${colW} shrink-0`}>جواز السفر</div>}
              {visibleCols.healthCert && <div className={`w-[160px] ${colW} shrink-0`}>الشهادة الصحية</div>}
              {visibleCols.dob && <div className={`w-[140px] ${colW} shrink-0`}>تاريخ الميلاد</div>}
              {visibleCols.nationality && <div className={`w-[120px] ${colW} shrink-0`}>الجنسية</div>}
              {visibleCols.branch && <div className={`w-[150px] ${colW} shrink-0`}>الفرع التابع له</div>}
              {visibleCols.department && <div className={`w-[150px] ${colW} shrink-0`}>القسم</div>}
              {visibleCols.manager && <div className={`w-[160px] ${colW} shrink-0`}>المدير المباشر</div>}
              {visibleCols.gender && <div className={`w-[100px] ${colW} shrink-0`}>الجنس</div>}
              {visibleCols.maritalStatus && <div className={`w-[120px] ${colW} shrink-0`}>الحالة الاجتماعية</div>}
              {visibleCols.gosi && <div className={`w-[140px] ${colW} shrink-0`}>التأمينات (GOSI)</div>}
              {visibleCols.englishName && <div className="w-[180px] print:w-[90px] shrink-0">الاسم بالإنجليزية</div>}
              {visibleCols.iqamaNumber && <div className={`w-[150px] ${colW} shrink-0`}>رقم الإقامة/الهوية</div>}
              {visibleCols.administration && <div className={`w-[150px] ${colW} shrink-0`}>الإدارة</div>}
              {visibleCols.bankName && <div className={`w-[150px] ${colW} shrink-0`}>اسم البنك</div>}
              {visibleCols.salaryMethod && <div className={`w-[140px] ${colW} shrink-0`}>طريقة الدفع</div>}

              {/* Placeholder when no columns are selected */}
              {noExtraCols && (
                  <div className="w-[250px] print:w-[100px] shrink-0 text-amber-500 font-bold">يمكنك تحديد أعمدة إضافية للعرض</div>
              )}

              <div className="w-[100px] shrink-0 text-center print:hidden mr-auto">إجراءات</div>
            </div>

            <div className="divide-y divide-slate-100 w-full" ref={menuRef}>
              {filteredEmployees.map((emp) => {
                const onLeave = onLeaveIds.has(emp.id);
                const isSaudi = isSaudiNationalityValue(emp.nationality);
                const totalSalary = totalSalaryOf(emp);
                return (
                <div key={emp.id} className="flex flex-col lg:flex-row print:flex-row gap-4 print:gap-1 p-5 lg:p-6 print:p-1 lg:items-center print:items-center hover:bg-blue-50/40 transition-all duration-300 group relative w-full print:break-inside-avoid">

                  <div className="w-[280px] print:w-[160px] shrink-0 flex items-center gap-4 print:gap-1">
                    <button type="button" aria-label={`عرض ملف ${emp.firstNameArabic}`} onClick={() => router.push(`/employees/${emp.id}`)} className="w-14 h-14 print:w-6 print:h-6 print:min-w-6 print:text-[10px] print:rounded-md rounded-[1.25rem] bg-gradient-to-br from-blue-100 to-indigo-50 flex items-center justify-center text-blue-700 font-black text-xl shadow-inner print:shadow-none shrink-0 group-hover:scale-105 group-hover:-rotate-3 transition-transform duration-300 cursor-pointer">
                      {emp.firstNameArabic.charAt(0)}
                    </button>
                    <div>
                      <Link href={`/employees/${emp.id}`} className="block font-extrabold text-[15px] print:text-[11px] text-slate-800 mb-1.5 print:mb-0 group-hover:text-blue-600 transition-colors hover:underline">
                        {emp.firstNameArabic} {emp.lastNameArabic}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2 print:gap-1 text-[12px] print:text-[9px] font-bold text-slate-500">
                        <span className="text-slate-600 bg-slate-100/80 px-2 py-0.5 rounded-md tabular-nums shrink-0">ID: {emp.employeeId}</span>
                        {emp.nationality !== undefined && (
                          <span className="flex items-center gap-1 shrink-0">
                            <MapPin size={12} className={isSaudi ? 'text-emerald-500' : 'text-amber-500'} />
                            {isSaudi ? 'مواطن' : 'أجنبي'}
                          </span>
                        )}
                        {emp.dataReviewNote && (
                          <Link href={`/employees/${emp.id}`} title={emp.dataReviewNote} className="flex items-center gap-1 shrink-0 text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md print:hidden">
                            <AlertTriangle size={12} /> بيانات ناقصة
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="w-[220px] print:w-[130px] shrink-0 flex flex-col justify-center space-y-2 print:space-y-0 mt-4 lg:mt-0 print:mt-0">
                    <p className="font-extrabold text-[14px] print:text-[9px] text-slate-800 flex items-center gap-2 line-clamp-1">
                      <Briefcase size={16} className="text-slate-400 shrink-0 print:hidden" /> {emp.jobTitle || 'موظف'}
                    </p>
                    <p className="text-[12px] print:text-[9px] font-bold text-slate-500 flex items-center gap-2 line-clamp-1">
                      <Building2 size={15} className="text-slate-400 shrink-0 print:hidden" /> {emp.legalCompany?.nameArabic || 'بدون ارتباط'}
                    </p>
                  </div>

                  <div className="w-[180px] print:w-[90px] shrink-0 flex flex-wrap items-center gap-2 mt-3 lg:mt-0 print:mt-0">
                    <div className={`px-3 py-1.5 print:px-1 print:py-px rounded-xl flex items-center gap-1.5 font-bold text-[11px] print:text-[9px]
                      ${emp.isTerminated ? 'bg-red-50 text-red-600 border border-red-100' : onLeave ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'}`}>
                      {emp.isTerminated ? <ShieldAlert size={14} /> : <UserCheck size={14} />}
                      {emp.isTerminated ? 'مستبعد' : onLeave ? 'في إجازة الآن' : 'على رأس العمل'}
                    </div>
                  </div>

                    {visibleCols.iqamaExp && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className={`font-bold text-[12px] print:text-[9px] tabular-nums ${expiresSoon(emp.iqamaOrIdExp, soonKey) ? 'text-red-600 bg-red-50 px-1 rounded' : 'text-slate-700'}`}>
                            {emp.iqamaOrIdExp ? formatDateShort(emp.iqamaOrIdExp) : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.contractExp && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700">
                            {emp.contractEndDate ? formatDateShort(emp.contractEndDate) : 'غير محدد'}
                          </span>
                        </div>
                    )}

                    {visibleCols.salary && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[13px] print:text-[9px] tabular-nums text-emerald-600 bg-emerald-50 px-2 py-1 print:p-0 rounded-md">
                            {totalSalary ? `SAR ${formatMoney(totalSalary)}` : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.bankInfo && (
                        <div className={`w-[160px] ${colW} shrink-0 overflow-hidden`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-600 truncate block">
                            {emp.ibanNumber || 'غير متوفر'}
                          </span>
                        </div>
                    )}

                    {visibleCols.mobile && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700" dir="ltr">
                            {emp.mobileNumber || 'غير متوفر'}
                          </span>
                        </div>
                    )}

                    {visibleCols.email && (
                        <div className="w-[200px] print:w-[100px] shrink-0">
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700 truncate block">
                            {emp.email || 'غير متوفر'}
                          </span>
                        </div>
                    )}

                    {visibleCols.joinDate && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700">
                            {emp.joinDate ? formatDateShort(emp.joinDate) : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.passport && (
                        <div className={`w-[160px] ${colW} shrink-0`}>
                          <span className={`font-bold text-[11px] print:text-[9px] tabular-nums block ${expiresSoon(emp.passportExp, soonKey) ? 'text-red-600 bg-red-50 px-1 rounded' : 'text-slate-700'}`}>
                            {emp.passportNumber || 'لا يوجد'}<br/>{emp.passportExp && `(${formatDateShort(emp.passportExp)})`}
                          </span>
                        </div>
                    )}

                    {visibleCols.healthCert && (
                        <div className={`w-[160px] ${colW} shrink-0`}>
                          <span className={`font-bold text-[11px] print:text-[9px] tabular-nums block ${expiresSoon(emp.healthCertificateExp, soonKey) ? 'text-red-600 bg-red-50 px-1 rounded' : 'text-slate-700'}`}>
                            {emp.healthCertificateNum || 'لا يوجد'}<br/>{emp.healthCertificateExp && `(${formatDateShort(emp.healthCertificateExp)})`}
                          </span>
                        </div>
                    )}

                    {visibleCols.dob && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700">
                            {emp.dateOfBirth ? formatDateShort(emp.dateOfBirth) : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.nationality && (
                        <div className={`w-[120px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700">
                            {isSaudi ? SAUDI_NATIONALITY : (emp.nationality || 'غير محددة')}
                          </span>
                        </div>
                    )}

                    {visibleCols.branch && (
                        <div className={`w-[150px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block">
                            {emp.branch?.nameArabic || 'غير محدد'}
                          </span>
                        </div>
                    )}

                    {visibleCols.department && (
                        <div className={`w-[150px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block">
                            {emp.department?.nameArabic || 'غير محدد'}
                          </span>
                        </div>
                    )}

                    {visibleCols.manager && (
                        <div className={`w-[160px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block">
                            {emp.directManager ? `${emp.directManager.firstNameArabic} ${emp.directManager.lastNameArabic || ''}` : 'لا يوجد'}
                          </span>
                        </div>
                    )}

                    {visibleCols.gender && (
                        <div className={`w-[100px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700">
                            {emp.gender === 'MALE' ? 'ذكر' : emp.gender === 'FEMALE' ? 'أنثى' : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.maritalStatus && (
                        <div className={`w-[120px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700">
                            {emp.maritalStatus === 'SINGLE' ? 'أعزب' : emp.maritalStatus === 'MARRIED' ? 'متزوج' : emp.maritalStatus || '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.gosi && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-red-600 bg-red-50 px-2 py-1 print:p-0 rounded-md">
                            {emp.gosiDeduction ? `SAR ${formatMoney(emp.gosiDeduction)}` : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.englishName && (
                        <div className="w-[180px] print:w-[90px] shrink-0">
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block" dir="ltr">
                            {emp.firstNameEnglish ? `${emp.firstNameEnglish} ${emp.lastNameEnglish || ''}` : '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.iqamaNumber && (
                        <div className={`w-[150px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] tabular-nums text-slate-700 block">
                            {emp.iqamaOrIdNumber || '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.administration && (
                        <div className={`w-[150px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block">
                            {emp.administration?.nameArabic || 'غير محدد'}
                          </span>
                        </div>
                    )}

                    {visibleCols.bankName && (
                        <div className={`w-[150px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block">
                            {emp.bankName || '-'}
                          </span>
                        </div>
                    )}

                    {visibleCols.salaryMethod && (
                        <div className={`w-[140px] ${colW} shrink-0`}>
                          <span className="font-bold text-[12px] print:text-[9px] text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis block">
                            {SALARY_METHOD_LABELS[emp.salaryPaymentMethod || ''] || emp.salaryPaymentMethod || '-'}
                          </span>
                        </div>
                    )}

                    {noExtraCols && (
                        <div className="w-[250px] print:w-[100px] shrink-0">
                            <span className="text-[11px] text-slate-400 italic font-medium">---</span>
                        </div>
                    )}

                  <div className="w-[100px] shrink-0 flex justify-end lg:justify-center mt-2 lg:mt-0 relative print:hidden mr-auto">
                    <button
                      type="button"
                      aria-label={`إجراءات الموظف ${emp.firstNameArabic}`}
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === emp.id}
                      onClick={() => setOpenMenuId(openMenuId === emp.id ? null : emp.id)}
                      className="w-10 h-10 rounded-[1rem] flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors border border-transparent hover:border-blue-100 hover:shadow-sm"
                    >
                      <MoreVertical size={20} />
                    </button>

                    {openMenuId === emp.id && (
                      <div role="menu" className="absolute left-0 top-12 z-50 w-52 bg-white rounded-2xl border border-slate-200 shadow-[0_20px_60px_rgba(0,0,0,0.12)] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="p-1.5">
                          <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); router.push(`/employees/${emp.id}`); }}
                            className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-blue-50 text-slate-700 hover:text-blue-600 transition-all font-bold text-[13px]">
                            <Eye size={16} className="text-slate-400" />عرض الملف الشخصي
                          </button>
                          {isHr && (<>
                          <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); router.push(`/employees/${emp.id}/edit`); }}
                            className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-blue-50 text-slate-700 hover:text-blue-600 transition-all font-bold text-[13px]">
                            <Pencil size={16} className="text-slate-400" />تعديل البيانات
                          </button>
                          {!emp.isTerminated && (
                            <>
                              <div className="my-1 border-t border-slate-100" />
                              <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); router.push(`/settlements/new?employeeId=${encodeURIComponent(emp.id)}&type=END_OF_SERVICE`); }}
                                className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-red-50 text-slate-700 hover:text-red-600 transition-all font-bold text-[13px]">
                                <Ban size={16} className="text-slate-400" />إنهاء الخدمات
                              </button>
                            </>
                          )}
                          </>)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
            </div>

            {filteredEmployees.length === 0 && (
              <div className="p-20 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center text-slate-300 mb-4">
                  <Search size={24} />
                </div>
                <p className="text-slate-600 font-bold text-lg">{search ? `لا توجد نتائج لـ "${search}"` : 'لا يوجد موظفون مطابقون للتصفية الحالية'}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

type ColumnKey =
  | 'salary' | 'contractExp' | 'iqamaExp' | 'bankInfo' | 'mobile' | 'email' | 'passport' | 'healthCert'
  | 'joinDate' | 'dob' | 'nationality' | 'branch' | 'department' | 'manager' | 'gender' | 'maritalStatus'
  | 'gosi' | 'englishName' | 'iqamaNumber' | 'administration' | 'bankName' | 'salaryMethod';

const COLUMN_OPTIONS: { key: ColumnKey; label: string }[] = [
  { key: 'iqamaExp', label: 'إنتهاء الإقامة/الهوية' },
  { key: 'contractExp', label: 'تاريخ الانتهاء للعقد' },
  { key: 'salary', label: 'إجمالي الراتب' },
  { key: 'bankInfo', label: 'معرف الحساب البنكي' },
  { key: 'mobile', label: 'رقم الجوال لتواصل' },
  { key: 'email', label: 'البريد الإلكتروني' },
  { key: 'passport', label: 'بيانات جواز السفر' },
  { key: 'healthCert', label: 'الشهادة الصحية' },
  { key: 'joinDate', label: 'تاريخ المباشرة للعمل' },
  { key: 'dob', label: 'تاريخ الميلاد' },
  { key: 'nationality', label: 'الجنسية الأصلية' },
  { key: 'branch', label: 'الفرع التابع له' },
  { key: 'department', label: 'تخصيص القسم' },
  { key: 'manager', label: 'المدير المباشر' },
  { key: 'gender', label: 'الجنس (النوع)' },
  { key: 'maritalStatus', label: 'الحالة الاجتماعية' },
  { key: 'gosi', label: 'خصم التأمينات' },
  { key: 'englishName', label: 'الاسم بالإنجليزية' },
  { key: 'iqamaNumber', label: 'رقم الإقامة/الهوية' },
  { key: 'administration', label: 'الإدارة' },
  { key: 'bankName', label: 'اسم البنك' },
  { key: 'salaryMethod', label: 'طريقة دفع الراتب' },
];

const SALARY_METHOD_LABELS: Record<string, string> = {
  BANK_TRANSFER: 'تحويل بنكي',
  CASH: 'نقدي',
  WAGE_PROTECTION: 'حماية الأجور',
};
