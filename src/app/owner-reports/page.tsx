"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import {
  Building2, CalendarDays, Key, Users, CarFront, FileText,
  ShieldPlus, Banknote, BarChart3, CheckSquare, Printer, AlertTriangle, RefreshCw
} from 'lucide-react';
import { readApiError } from '@/components/ui/feedback';
import { dateKey, formatDate, formatDateShort, todayKey } from '@/lib/dates';
import { formatMoney, roundMoney, sumMoney } from '@/lib/money';
import { estimateMonthWage, type ReportMonthKind } from '@/lib/payroll-core';

interface ReportEmployee {
  id: string;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  joinDate?: string | null;
  iqamaOrIdExp?: string | null;
  iqamaRenewalCost?: number | null;
  basicSalary?: number | null;
  allowances?: { amount?: number | null; isMonthly?: boolean | null }[] | null;
}
interface ReportMedical { id: string; insuranceIssuer?: string | null; expiryDate?: string | null; policyCost?: number | null }
interface ReportCompany { id: string; nameArabic?: string | null; commercialRegExp?: string | null; commercialRegCost?: number | null; trademarkExpDate?: string | null; trademarkCost?: number | null }
interface ReportBranch {
  id: string;
  nameArabic?: string | null;
  munLicenseExp?: string | null;
  munLicenseCost?: number | null;
  civilDefenseExp?: string | null;
  civilDefenseCost?: number | null;
  rentContractStart?: string | null;
  rentContractExp?: string | null;
  rentContractAmount?: number | null;
  rentPaymentType?: string | null;
  rentPaymentCount?: number | null;
}
interface ReportVehicle { id: string; brand?: string | null; plateNumber?: string | null; insuranceExpDate?: string | null; insuranceCost?: number | null }
interface ReportMeter { id: string; accountNumber?: string | null; meterNumber?: string | null }
interface ReportSim { id: string; provider?: string | null; simNumber?: string | null; serviceType?: string | null }
interface ReportLawsuit {
  id: string;
  subject?: string | null;
  lawFirmName?: string | null;
  caseTypeLabel?: string | null;
  plaintiff?: string | null;
  defendant?: string | null;
  status?: string | null;
  statusLabel?: string | null;
}
interface ReportContract { id: string; title?: string | null; secondParty?: string | null; endDate?: string | null; status?: string | null; statusLabel?: string | null }

interface ActualMonth {
  year: number;
  month: number;
  label: string;
  kind: ReportMonthKind;
  lines: number;
  gross: number;
  gosiEmployer: number;
  overtimeCost: number;
  bonusAmount: number;
  netSalary: number;
  gosiIncomplete: boolean;
}

interface ReportData {
  employees?: ReportEmployee[];
  medicalInsurances?: ReportMedical[];
  companies?: ReportCompany[];
  branches?: ReportBranch[];
  vehicles?: ReportVehicle[];
  utilityMeters?: ReportMeter[];
  telecomSims?: ReportSim[];
  lawsuits?: ReportLawsuit[];
  legalContracts?: ReportContract[];
  /** Employer GOSI share of the reference payroll month (latest APPROVED / PAID, not in the future). */
  employerGosi?: {
    year: number;
    month: number;
    label?: string;
    gosiEmployer: number;
    gosiEmployee: number;
    employees: number;
    byStatus: Record<string, number>;
    gosiIncomplete?: boolean;
  } | null;
  /** Stored APPROVED / PAID payroll lines of the requested period, month by month. */
  payrollActual?: {
    months: ActualMonth[];
    totals: { lines: number; gross: number; gosiEmployer: number; overtimeCost: number; bonusAmount: number; netSalary: number; employerCost: number };
    actualMonths: number;
    missingMonths: number;
    estimateMonths: number;
    gosiIncompleteMonths: number;
  } | null;
  metrics?: Record<string, number | undefined>;
}

const PAYROLL_STATUS_LABELS: Record<string, string> = { DRAFT: 'مسودة', APPROVED: 'معتمد', PAID: 'مصروف' };

type LicenseRow = { id: string; name: string; type: string; date: string | null | undefined };

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const formatDateLocal = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** UTC-midnight time of a 'YYYY-MM-DD' value or a stored date-only value. */
const dayTime = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

/** A stored date-only value that is already past (Riyadh day). */
const isPast = (v: string | null | undefined): boolean => {
  const k = dateKey(v);
  return !!k && k < todayKey();
};

/** Payments per year of each Branch.rentPaymentType (BranchForm options). */
const RENT_PAYMENTS_PER_YEAR: Record<string, number> = { ANNUAL: 1, SEMI_ANNUAL: 2, QUARTERLY: 4, MONTHLY: 12 };

const addMonthsUtc = (t: number, months: number): number => {
  const d = new Date(t);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), lastDay));
};

/**
 * Rent payments of a branch falling inside [from, to]: the contract amount split into equal
 * payments (rentPaymentCount, else payments per year x contract years), due from the contract
 * start every 12 / paymentsPerYear months. Without a start date the schedule is counted back from
 * the end date. `missingCost` = a payment date falls in the period but no amount is recorded.
 */
function rentInPeriod(b: ReportBranch, from: number, to: number): { amount: number; payments: number; missingCost: boolean } {
  const none = { amount: 0, payments: 0, missingCost: false };
  const perYear = RENT_PAYMENTS_PER_YEAR[b.rentPaymentType ?? ''] ?? 1;
  const step = 12 / perYear;
  const exp = dayTime(b.rentContractExp);
  let start = dayTime(b.rentContractStart);
  if (start === null && exp === null) return none;
  let count = b.rentPaymentCount && b.rentPaymentCount > 0 ? Math.round(b.rentPaymentCount) : 0;
  if (!count) {
    if (start !== null && exp !== null && exp > start) {
      const d1 = new Date(start);
      const d2 = new Date(exp + 86400000); // end date inclusive
      const months = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
      count = Math.max(1, Math.round(months / step));
    } else {
      count = perYear;
    }
  }
  if (start === null && exp !== null) start = addMonthsUtc(exp + 86400000, -count * step);
  if (start === null) return none;
  let payments = 0;
  for (let i = 0; i < count && i < 600; i++) {
    const due = addMonthsUtc(start, i * step);
    if (due > to) break;
    if (due >= from) payments++;
  }
  if (!payments) return none;
  const total = b.rentContractAmount ?? 0;
  if (!(total > 0)) return { amount: 0, payments, missingCost: true };
  return { amount: roundMoney((total / count) * payments), payments, missingCost: false };
}

/** Value of a cost card: the amount, or "N بند بلا تكلفة مسجلة" instead of a misleading 0. */
function CostValue({ total, missing }: { total: number; missing: number }) {
  if (total === 0 && missing > 0) {
    return <h2 className="text-2xl font-black text-amber-700">{missing} بند بلا تكلفة مسجلة</h2>;
  }
  return (
    <div>
      <h2 className="text-3xl font-black text-slate-800">{formatMoney(total)} <span className="text-sm font-bold text-slate-400">ر.س</span></h2>
      {missing > 0 && <span className="text-[11px] font-bold text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-3 inline-block">إضافة إلى {missing} بند بلا تكلفة مسجلة</span>}
    </div>
  );
}

/** Expired vs expiring badge of a dated item. */
function ExpiryBadge({ date }: { date: string | null | undefined }) {
  return isPast(date)
    ? <span className="text-[10px] font-black bg-red-100 text-red-700 px-2 py-0.5 rounded-md">منتهية</span>
    : <span className="text-[10px] font-black bg-amber-100 text-amber-700 px-2 py-0.5 rounded-md">تنتهي خلال الفترة</span>;
}

function ExpiryCounts({ dates }: { dates: Array<string | null | undefined> }) {
  const expired = dates.filter(isPast).length;
  return (
    <span className="text-[11px] font-bold text-slate-500 block mt-1">منتهية {expired} · قادمة {dates.length - expired}</span>
  );
}

const PRINT_TH = 'p-3 border border-slate-200 font-bold text-[13px] text-slate-600';
const PRINT_TD = 'p-3 border border-slate-200 text-[14px] font-bold text-slate-800';

function PrintEmptyRow({ cols }: { cols: number }) {
  return (
    <tr><td colSpan={cols} className="p-3 border border-slate-200 text-[13px] font-bold text-slate-400 text-center">لا توجد سجلات ضمن الفترة</td></tr>
  );
}

export default function OwnerReportsPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('costs'); // costs, operations, custom
  const [issuedAt] = useState(() => new Date());

  const [reportConfig, setReportConfig] = useState({
    employees: true,
    companies: true,
    branches: true,
    vehicles: true,
    medicalInsurances: true,
    utilityMeters: true,
    telecomSims: true,
    lawsuits: true,
    legalContracts: true,
  });

  const handleConfigChange = (key: keyof typeof reportConfig) => {
    setReportConfig(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const [dateFilter, setDateFilter] = useState('monthly'); // 'monthly', 'yearly', 'custom'
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return formatDateLocal(d);
  });
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(0);
    return formatDateLocal(d);
  });

  const rangeStart = dayTime(startDate);
  const rangeEnd = dayTime(endDate);
  const rangeValid = rangeStart !== null && rangeEnd !== null && rangeEnd >= rangeStart;

  // Only the latest request may update the page (a slower response for an older period is dropped).
  const requestSeq = useRef(0);
  const fetchReport = useCallback(async (from: string, to: string) => {
    const seq = ++requestSeq.current;
    setLoadError(null);
    try {
      const res = await fetch(`/api/owner-reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const message = await readApiError(res, 'تعذر تحميل التقارير');
        if (seq === requestSeq.current) setLoadError(message);
        return;
      }
      const json = (await res.json()) as ReportData;
      if (seq === requestSeq.current) setData(json);
    } catch {
      if (seq === requestSeq.current) setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      if (seq === requestSeq.current) setIsFetching(false);
    }
  }, []);

  // The actual payroll figures depend on the period: reload when it changes.
  useEffect(() => {
    if (rangeValid) fetchReport(startDate, endDate);
  }, [fetchReport, startDate, endDate, rangeValid]);

  const handleFilterChange = (val: string) => {
    setDateFilter(val);
    const today = new Date();
    if (val === 'monthly') {
      const d1 = new Date(today.getFullYear(), today.getMonth(), 1);
      const d2 = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      setStartDate(formatDateLocal(d1));
      setEndDate(formatDateLocal(d2));
    } else if (val === 'yearly') {
      const d1 = new Date(today.getFullYear(), 0, 1);
      const d2 = new Date(today.getFullYear(), 11, 31);
      setStartDate(formatDateLocal(d1));
      setEndDate(formatDateLocal(d2));
    }
  };

  const isDateInRange = (dString: string | null | undefined) => {
    const t = dayTime(dString);
    if (t === null || !rangeValid || rangeStart === null || rangeEnd === null) return false;
    return t >= rangeStart && t <= rangeEnd;
  };

  // --- Calculations & Lists ---
  const employees = data?.employees ?? [];
  const expiringIqamas = employees.filter((e) => isDateInRange(e.iqamaOrIdExp));
  const iqamaTotal = sumMoney(expiringIqamas.map((e) => e.iqamaRenewalCost || 0));
  const iqamaMissing = expiringIqamas.filter((e) => !(e.iqamaRenewalCost && e.iqamaRenewalCost > 0)).length;

  // Payroll: ACTUAL from the stored approved / paid lines of elapsed months (server), ESTIMATE
  // only for the current month without an approved payroll and future months.
  const payrollMonths = data?.payrollActual?.months ?? [];
  const actualTotals = data?.payrollActual?.totals;
  const actualMonths = payrollMonths.filter((m) => m.kind === 'ACTUAL');
  const missingMonths = payrollMonths.filter((m) => m.kind === 'MISSING');
  const estimateMonths = payrollMonths.filter((m) => m.kind === 'ESTIMATE');
  const gosiIncompleteMonths = actualMonths.filter((m) => m.gosiIncomplete);
  const estimateParts = estimateMonths.map((m) => estimateMonthWage(employees, m.year, m.month));
  const estimateTotal = sumMoney(estimateParts.map((p) => p.amount));
  const actualPayrollCost = sumMoney([actualTotals?.gross ?? 0, actualTotals?.gosiEmployer ?? 0]);
  const payrollTotal = sumMoney([actualPayrollCost, estimateTotal]);

  const expiringMedical = (data?.medicalInsurances ?? []).filter((m) => isDateInRange(m.expiryDate));
  const medicalTotal = sumMoney(expiringMedical.map((m) => m.policyCost || 0));
  const medicalMissing = expiringMedical.filter((m) => !(m.policyCost && m.policyCost > 0)).length;

  const expiringLicenses: LicenseRow[] = [];
  const licenseCosts: number[] = [];
  let licensesMissing = 0;
  const addLicense = (cost: number | null | undefined, row: LicenseRow) => {
    expiringLicenses.push(row);
    if (cost && cost > 0) licenseCosts.push(cost);
    else licensesMissing++;
  };
  for (const c of data?.companies ?? []) {
    if (isDateInRange(c.commercialRegExp)) addLicense(c.commercialRegCost, { id: c.id, name: c.nameArabic || '', type: 'سجل تجاري', date: c.commercialRegExp });
    if (isDateInRange(c.trademarkExpDate)) addLicense(c.trademarkCost, { id: c.id, name: c.nameArabic || '', type: 'علامة تجارية', date: c.trademarkExpDate });
  }
  for (const b of data?.branches ?? []) {
    if (isDateInRange(b.munLicenseExp)) addLicense(b.munLicenseCost, { id: b.id, name: b.nameArabic || '', type: 'رخصة بلدية', date: b.munLicenseExp });
    if (isDateInRange(b.civilDefenseExp)) addLicense(b.civilDefenseCost, { id: b.id, name: b.nameArabic || '', type: 'دفاع مدني', date: b.civilDefenseExp });
  }
  const licensesTotal = sumMoney(licenseCosts);

  const rentRows = rangeValid && rangeStart !== null && rangeEnd !== null
    ? (data?.branches ?? []).map((b) => ({ b, ...rentInPeriod(b, rangeStart, rangeEnd) })).filter((r) => r.payments > 0)
    : [];
  const rentTotal = sumMoney(rentRows.map((r) => r.amount));
  const rentMissing = rentRows.filter((r) => r.missingCost).length;
  const rentPayments = rentRows.reduce((n, r) => n + r.payments, 0);

  const expiringVehicles = (data?.vehicles ?? []).filter((v) => isDateInRange(v.insuranceExpDate));
  const vehiclesTotal = sumMoney(expiringVehicles.map((v) => v.insuranceCost || 0));
  const vehiclesMissing = expiringVehicles.filter((v) => !(v.insuranceCost && v.insuranceCost > 0)).length;

  const renewalsTotal = sumMoney([iqamaTotal, medicalTotal, licensesTotal, vehiclesTotal, rentTotal]);
  const overallTotal = sumMoney([payrollTotal, renewalsTotal]);
  const missingTotal = iqamaMissing + medicalMissing + licensesMissing + vehiclesMissing + rentMissing;

  // Printable tables follow the selected period (undated records are listed in full).
  const printCompanies = (data?.companies ?? []).filter((c) => isDateInRange(c.commercialRegExp) || isDateInRange(c.trademarkExpDate));
  const printBranches = (data?.branches ?? []).filter((b) => isDateInRange(b.munLicenseExp) || isDateInRange(b.civilDefenseExp) || isDateInRange(b.rentContractExp));
  const printContracts = (data?.legalContracts ?? []).filter((c) => isDateInRange(c.endDate));
  const periodText = `${formatDate(startDate)} - ${formatDate(endDate)}`;

  return (
    <DashboardLayout>
      <div className="p-4 sm:p-8 max-w-[1200px] mx-auto min-h-screen">

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black text-slate-800 tracking-tight flex items-center gap-3">
              <BarChart3 className="text-indigo-600" size={38} />
              تقارير صاحب العمل
            </h1>
            <p className="text-slate-500 font-bold mt-2">تكاليف المنشأة للفترة المختارة: الرواتب الفعلية من المسيرات المعتمدة، وتقدير للأشهر القادمة، وتكاليف التجديد المسجلة.</p>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-[2rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100 p-5 sm:p-8 mb-10 print:hidden">
           <div className="flex flex-col md:flex-row gap-8">
              <div className="flex-1">
                 <label className="text-[13px] font-extrabold text-slate-700 block mb-3">نوع التقرير الزمني</label>
                 <div className="flex bg-slate-100 p-1.5 rounded-2xl w-full">
                    <button
                       type="button"
                       onClick={() => handleFilterChange('monthly')}
                       className={`flex-1 py-3 font-bold text-[14px] rounded-xl transition-all ${dateFilter === 'monthly' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500 hover:text-slate-800'}`}>
                       تقرير شهري
                    </button>
                    <button
                       type="button"
                       onClick={() => handleFilterChange('yearly')}
                       className={`flex-1 py-3 font-bold text-[14px] rounded-xl transition-all ${dateFilter === 'yearly' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500 hover:text-slate-800'}`}>
                       تقرير سنوي
                    </button>
                    <button
                       type="button"
                       onClick={() => handleFilterChange('custom')}
                       className={`flex-1 py-3 font-bold text-[14px] rounded-xl transition-all ${dateFilter === 'custom' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500 hover:text-slate-800'}`}>
                       فترة مخصصة
                    </button>
                 </div>
              </div>

              {dateFilter === 'custom' && (
                <div className="flex-1 grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="report-start" className="text-[13px] font-extrabold text-slate-700 block mb-2">من تاريخ</label>
                    <input id="report-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                       className="w-full bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 rounded-2xl px-5 py-3.5 font-bold text-slate-800 focus:outline-none" />
                  </div>
                  <div>
                    <label htmlFor="report-end" className="text-[13px] font-extrabold text-slate-700 block mb-2">إلى تاريخ</label>
                    <input id="report-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                       className="w-full bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 rounded-2xl px-5 py-3.5 font-bold text-slate-800 focus:outline-none" />
                  </div>
                </div>
              )}
           </div>
           {!rangeValid && (
             <p role="alert" className="mt-4 text-[13px] font-bold text-rose-700">تاريخ نهاية الفترة يسبق تاريخ بدايتها أو غير مكتمل؛ صحّح الفترة لعرض التقرير.</p>
           )}
        </div>

        <div className="flex flex-wrap gap-4 mb-8 print:hidden">
           <button
             type="button"
             onClick={() => setActiveTab('costs')}
             className={`px-8 py-3.5 rounded-2xl font-black text-[15px] flex items-center gap-2 transition-all ${activeTab === 'costs' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-100'}`}>
             <BarChart3 size={18} />
             تقارير التكلفة الشاملة
           </button>
           <button
             type="button"
             onClick={() => setActiveTab('operations')}
             className={`px-8 py-3.5 rounded-2xl font-black text-[15px] flex items-center gap-2 transition-all ${activeTab === 'operations' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-100'}`}>
             <FileText size={18} />
             تقارير متابعة العمليات
           </button>
           <button
             type="button"
             onClick={() => setActiveTab('custom')}
             className={`px-8 py-3.5 rounded-2xl font-black text-[15px] flex items-center gap-2 transition-all ${activeTab === 'custom' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-100'}`}>
             <CheckSquare size={18} />
             التقارير المخصصة للطباعة
           </button>
        </div>

        {isFetching ? (
           <div className="flex justify-center items-center py-20">
              <div className="w-10 h-10 border-4 border-slate-200 border-t-indigo-600 rounded-full animate-spin"></div>
           </div>
        ) : loadError ? (
           <div role="alert" className="bg-white rounded-[2rem] border border-rose-200 p-16 flex flex-col items-center gap-4 text-center">
              <AlertTriangle size={40} className="text-rose-400" />
              <p className="font-bold text-slate-700">{loadError}</p>
              <button type="button" onClick={() => { setIsFetching(true); fetchReport(startDate, endDate); }} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-black text-[13px] rounded-xl transition">
                <RefreshCw size={16} /> إعادة المحاولة
              </button>
           </div>
        ) : activeTab === 'costs' ? (
           <div className="space-y-8">

             {/* Total Overview */}
             <div className="bg-gradient-to-l from-indigo-700 to-indigo-900 rounded-[2rem] p-6 sm:p-10 text-white flex flex-col items-center justify-center relative overflow-hidden shadow-2xl shadow-indigo-500/30">
                <div className="relative z-10 text-center">
                  <span className="text-indigo-200 font-extrabold tracking-wider text-sm mb-4 block">إجمالي تكاليف الفترة المحددة ({periodText})</span>
                  <div className="flex items-center justify-center gap-3">
                     <h1 className="text-5xl md:text-7xl font-black">{formatMoney(overallTotal)}</h1>
                     <span className="text-2xl font-bold text-indigo-300">ر.س</span>
                  </div>
                  <p className="text-[12px] font-bold text-indigo-200 mt-4 leading-relaxed">
                    رواتب فعلية من المسيرات المعتمدة: {formatMoney(actualPayrollCost)} ر.س · رواتب تقديرية: {formatMoney(estimateTotal)} ر.س · تجديدات وإيجارات: {formatMoney(renewalsTotal)} ر.س
                  </p>
                  {missingTotal > 0 && (
                    <p className="text-[12px] font-bold text-amber-200 mt-1">لا يشمل {missingTotal} بند بلا تكلفة مسجلة.</p>
                  )}
                </div>
             </div>

             {/* Detailed Reports Grid */}
             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

                {/* Payroll: actual vs estimate */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col gap-4 md:col-span-2">
                   <div className="flex items-center gap-4">
                      <div className="w-14 h-14 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600">
                         <Banknote size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">الرواتب</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">الأشهر المنقضية من المسيرات المعتمدة أو المصروفة، والأشهر القادمة تقديراً</span>
                      </div>
                   </div>
                   <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                     <div className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4">
                       <span className="text-[11px] font-black bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md">فعلي</span>
                       <h2 className="text-2xl font-black text-slate-800 mt-2">{formatMoney(actualPayrollCost)} <span className="text-sm font-bold text-slate-400">ر.س</span></h2>
                       {actualMonths.length > 0 ? (
                         <ul className="text-[12px] font-bold text-slate-600 mt-2 space-y-0.5">
                           <li>{actualMonths.length} شهر: {actualMonths.map((m) => m.label).join('، ')}</li>
                           <li>إجمالي المستحق: {formatMoney(actualTotals?.gross)} ر.س</li>
                           <li>حصة صاحب العمل في التأمينات: {formatMoney(actualTotals?.gosiEmployer)} ر.س{gosiIncompleteMonths.length > 0 ? ' (ناقص)' : ''}</li>
                           <li>منه عمل إضافي: {formatMoney(actualTotals?.overtimeCost)} ر.س · مكافآت: {formatMoney(actualTotals?.bonusAmount)} ر.س</li>
                         </ul>
                       ) : (
                         <p className="text-[12px] font-bold text-slate-500 mt-2">لا يوجد مسير معتمد أو مصروف ضمن الفترة.</p>
                       )}
                       {gosiIncompleteMonths.length > 0 && (
                         <p className="text-[11px] font-bold text-amber-800 bg-amber-50 rounded-lg px-2 py-1 mt-2">
                           ناقص: حصة صاحب العمل غير مسجلة في {gosiIncompleteMonths.map((m) => m.label).join('، ')} (مسيرات وُلِّدت قبل حفظ هذا التفصيل).
                         </p>
                       )}
                       {missingMonths.length > 0 && (
                         <p className="text-[11px] font-bold text-rose-700 bg-rose-50 rounded-lg px-2 py-1 mt-2">
                           {missingMonths.length} شهر منقضٍ بلا مسير معتمد ({missingMonths.map((m) => m.label).join('، ')})، ولم يُقدَّر.
                         </p>
                       )}
                     </div>
                     <div className="rounded-2xl border border-amber-100 bg-amber-50/40 p-4">
                       <span className="text-[11px] font-black bg-amber-100 text-amber-800 px-2 py-0.5 rounded-md">تقديري</span>
                       <h2 className="text-2xl font-black text-slate-800 mt-2">{formatMoney(estimateTotal)} <span className="text-sm font-bold text-slate-400">ر.س</span></h2>
                       {estimateMonths.length > 0 ? (
                         <ul className="text-[12px] font-bold text-slate-600 mt-2 space-y-0.5">
                           {estimateMonths.map((m, i) => (
                             <li key={`${m.year}-${m.month}`}>{m.label}: {formatMoney(estimateParts[i]?.amount)} ر.س ({estimateParts[i]?.employees ?? 0} موظف)</li>
                           ))}
                         </ul>
                       ) : (
                         <p className="text-[12px] font-bold text-slate-500 mt-2">لا توجد أشهر قادمة في الفترة.</p>
                       )}
                       <p className="text-[11px] font-bold text-amber-800 mt-2 leading-relaxed">
                         الأساسي والبدلات الشهرية للموظفين الحاليين، مع استبعاد من لم يباشر وتناسب شهر المباشرة. لا يشمل التأمينات ولا العمل الإضافي ولا المكافآت.
                       </p>
                     </div>
                   </div>
                </div>

                {/* Employer GOSI cost (stored payroll values of the reference month) */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col justify-between">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="w-14 h-14 bg-teal-50 rounded-2xl flex items-center justify-center text-teal-600">
                         <ShieldPlus size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">حصة صاحب العمل في التأمينات (GOSI)</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">
                          {data?.employerGosi
                            ? `آخر مسير معتمد: ${data.employerGosi.label ?? `${data.employerGosi.month}/${data.employerGosi.year}`} - ${data.employerGosi.employees} موظف (${Object.entries(data.employerGosi.byStatus).map(([k, v]) => `${PAYROLL_STATUS_LABELS[k] ?? k}: ${v}`).join('، ')})`
                            : 'لا يوجد مسير معتمد بعد'}
                        </span>
                      </div>
                   </div>
                   <h2 className="text-3xl font-black text-slate-800">
                     {formatMoney(data?.employerGosi?.gosiEmployer ?? 0)} <span className="text-sm font-bold text-slate-400">ر.س</span>
                     {data?.employerGosi?.gosiIncomplete && <span className="text-[12px] font-black bg-amber-100 text-amber-800 px-2 py-0.5 rounded-md mr-2 align-middle">ناقص</span>}
                   </h2>
                   <span className="text-[11px] font-bold text-slate-500 mt-3 block leading-relaxed">تكلفة على المنشأة لا تُخصم من رواتب الموظفين، من قيم ذلك المسير المخزنة. تدخل حصة الأشهر الفعلية في الإجمالي أعلاه ضمن الرواتب الفعلية.</span>
                </div>

                {/* Iqama Renewals */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col justify-between">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
                         <Users size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">تجديد الإقامات</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">منتهية أو تنتهي خلال الفترة ({expiringIqamas.length})</span>
                      </div>
                   </div>
                   <CostValue total={iqamaTotal} missing={iqamaMissing} />
                </div>

                {/* Medical Insurance */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col justify-between">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="w-14 h-14 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-600">
                         <ShieldPlus size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">وثائق التأمين الطبي</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">وثائق تنتهي خلال الفترة ({expiringMedical.length})</span>
                      </div>
                   </div>
                   <CostValue total={medicalTotal} missing={medicalMissing} />
                </div>

                {/* Official Documents & Licenses */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col justify-between">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600">
                         <FileText size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">تجديد الرخص والمستندات الرسمية</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">سجل تجاري، علامة تجارية، رخص البلدية والدفاع المدني ({expiringLicenses.length})</span>
                      </div>
                   </div>
                   <CostValue total={licensesTotal} missing={licensesMissing} />
                </div>

                {/* Vehicles Insurance */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col justify-between">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="w-14 h-14 bg-orange-50 rounded-2xl flex items-center justify-center text-orange-600">
                         <CarFront size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">تأمين المركبات</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">تأمين ينتهي خلال الفترة ({expiringVehicles.length})</span>
                      </div>
                   </div>
                   <CostValue total={vehiclesTotal} missing={vehiclesMissing} />
                </div>

                {/* Real-estate Rent */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.02)] flex flex-col justify-between md:col-span-2 lg:col-span-2">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="w-14 h-14 bg-purple-50 rounded-2xl flex items-center justify-center text-purple-600">
                         <Building2 size={28} />
                      </div>
                      <div>
                        <h4 className="font-black text-slate-800 text-lg">دفعات الإيجار المستحقة (للمقرات والفروع)</h4>
                        <span className="text-xs font-bold text-slate-400 block mt-1">
                          {rentPayments > 0 ? `${rentPayments} دفعة في ${rentRows.length} فرع خلال الفترة. ` : 'لا توجد دفعات إيجار خلال الفترة. '}
                          مواعيد الدفعات محسوبة من تاريخ بداية العقد ونوع السداد، وقيمة الدفعة = قيمة العقد ÷ عدد الدفعات.
                        </span>
                      </div>
                   </div>
                   <CostValue total={rentTotal} missing={rentMissing} />
                </div>

             </div>

           </div>
        ) : activeTab === 'operations' ? (
           <div className="space-y-8">

             {/* Key Metrics / Operations Summary */}
             <div className="bg-slate-900 rounded-[2rem] p-8 mt-4 shadow-xl mb-8">
                <div className="flex items-center gap-3 mb-8">
                   <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center text-indigo-400">
                      <BarChart3 size={20} />
                   </div>
                   <h3 className="text-xl font-black text-white">إحصائيات العمليات والأصول</h3>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">الموظفين على رأس العمل</p>
                      <p className="text-3xl font-black text-white">{data?.metrics?.activeEmployees || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">الموظفين المستبعدين</p>
                      <p className="text-3xl font-black text-rose-400">{data?.metrics?.terminatedEmployees || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">في إجازة حالياً</p>
                      <p className="text-3xl font-black text-amber-400">{data?.metrics?.employeesOnLeave || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">إجمالي الشركات</p>
                      <p className="text-3xl font-black text-white">{data?.metrics?.companies || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">الفروع والمقرات</p>
                      <p className="text-3xl font-black text-white">{data?.metrics?.branches || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">أسطول المركبات</p>
                      <p className="text-3xl font-black text-white">{data?.metrics?.vehicles || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">عدادات الكهرباء والمياه</p>
                      <p className="text-3xl font-black text-blue-400">{data?.metrics?.utilityMeters || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">شرائح الاتصال والنت</p>
                      <p className="text-3xl font-black text-emerald-400">{data?.metrics?.telecomSims || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">القضايا والمنازعات</p>
                      <p className="text-3xl font-black text-purple-400">{data?.metrics?.lawsuits || 0}</p>
                   </div>
                   <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-slate-400 font-bold text-xs mb-2">العقود والاتفاقيات</p>
                      <p className="text-3xl font-black text-orange-400">{data?.metrics?.legalContracts || 0}</p>
                   </div>
                </div>
             </div>

             {/* Operations Reports Grid */}
             <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* Iqamas */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-sm">
                   <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                         <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
                            <Users size={24} />
                         </div>
                         <div>
                           <h4 className="font-black text-slate-800 text-xl">إقامات منتهية أو تنتهي خلال الفترة</h4>
                           <ExpiryCounts dates={expiringIqamas.map((e) => e.iqamaOrIdExp)} />
                         </div>
                      </div>
                      <span className="bg-blue-100 text-blue-800 font-extrabold px-4 py-1.5 rounded-full text-lg">{expiringIqamas.length}</span>
                   </div>
                   <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                     {expiringIqamas.length === 0 ? <p className="text-slate-400 font-bold text-sm">لا يوجد إقامات تنتهي في هذه الفترة</p> : expiringIqamas.map((e) => (
                       <div key={e.id} className="flex justify-between items-center gap-2 bg-slate-50 p-3 rounded-xl">
                          <span className="font-bold text-slate-700 text-[14px]">{e.firstNameArabic} {e.lastNameArabic}</span>
                          <span className="flex items-center gap-2">
                            <ExpiryBadge date={e.iqamaOrIdExp} />
                            <span className="text-[12px] font-bold text-slate-400">{formatDateShort(e.iqamaOrIdExp)}</span>
                          </span>
                       </div>
                     ))}
                   </div>
                </div>

                {/* Licenses */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-sm">
                   <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                         <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center text-amber-600">
                            <FileText size={24} />
                         </div>
                         <div>
                           <h4 className="font-black text-slate-800 text-xl">تراخيص منتهية أو تنتهي خلال الفترة</h4>
                           <ExpiryCounts dates={expiringLicenses.map((l) => l.date)} />
                         </div>
                      </div>
                      <span className="bg-amber-100 text-amber-800 font-extrabold px-4 py-1.5 rounded-full text-lg">{expiringLicenses.length}</span>
                   </div>
                   <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                     {expiringLicenses.length === 0 ? <p className="text-slate-400 font-bold text-sm">لا يوجد تراخيص تنتهي في هذه الفترة</p> : expiringLicenses.map((l) => (
                       <div key={`${l.id}-${l.type}`} className="flex justify-between items-center gap-2 bg-slate-50 p-3 rounded-xl">
                          <div>
                            <span className="font-bold text-slate-700 text-[14px]">{l.name}</span>
                            <span className="text-[11px] font-bold bg-slate-200 text-slate-600 px-2 py-0.5 rounded-md mr-2">{l.type}</span>
                          </div>
                          <span className="flex items-center gap-2">
                            <ExpiryBadge date={l.date} />
                            <span className="text-[12px] font-bold text-slate-400">{formatDateShort(l.date)}</span>
                          </span>
                       </div>
                     ))}
                   </div>
                </div>

                {/* Medical Insurance */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-sm">
                   <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                         <div className="w-12 h-12 bg-rose-50 rounded-xl flex items-center justify-center text-rose-600">
                            <ShieldPlus size={24} />
                         </div>
                         <div>
                           <h4 className="font-black text-slate-800 text-xl">وثائق تأمين طبي منتهية أو تنتهي</h4>
                           <ExpiryCounts dates={expiringMedical.map((m) => m.expiryDate)} />
                         </div>
                      </div>
                      <span className="bg-rose-100 text-rose-800 font-extrabold px-4 py-1.5 rounded-full text-lg">{expiringMedical.length}</span>
                   </div>
                   <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                     {expiringMedical.length === 0 ? <p className="text-slate-400 font-bold text-sm">لا يوجد تأمين ينتهي في هذه الفترة</p> : expiringMedical.map((m) => (
                       <div key={m.id} className="flex justify-between items-center gap-2 bg-slate-50 p-3 rounded-xl">
                          <span className="font-bold text-slate-700 text-[14px]">{m.insuranceIssuer}</span>
                          <span className="flex items-center gap-2">
                            <ExpiryBadge date={m.expiryDate} />
                            <span className="text-[12px] font-bold text-slate-400">{formatDateShort(m.expiryDate)}</span>
                          </span>
                       </div>
                     ))}
                   </div>
                </div>

                {/* Vehicles */}
                <div className="bg-white p-7 rounded-3xl border border-slate-100 shadow-sm">
                   <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                         <div className="w-12 h-12 bg-orange-50 rounded-xl flex items-center justify-center text-orange-600">
                            <CarFront size={24} />
                         </div>
                         <div>
                           <h4 className="font-black text-slate-800 text-xl">تأمين مركبات منتهٍ أو ينتهي</h4>
                           <ExpiryCounts dates={expiringVehicles.map((v) => v.insuranceExpDate)} />
                         </div>
                      </div>
                      <span className="bg-orange-100 text-orange-800 font-extrabold px-4 py-1.5 rounded-full text-lg">{expiringVehicles.length}</span>
                   </div>
                   <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                     {expiringVehicles.length === 0 ? <p className="text-slate-400 font-bold text-sm">لا يوجد مركبات مطلوب تجديد تأمينها</p> : expiringVehicles.map((v) => (
                       <div key={v.id} className="flex justify-between items-center gap-2 bg-slate-50 p-3 rounded-xl">
                          <span className="font-bold text-slate-700 text-[14px]">{v.brand} - لوحة: {v.plateNumber}</span>
                          <span className="flex items-center gap-2">
                            <ExpiryBadge date={v.insuranceExpDate} />
                            <span className="text-[12px] font-bold text-slate-400">{formatDateShort(v.insuranceExpDate)}</span>
                          </span>
                       </div>
                     ))}
                   </div>
                </div>

             </div>
           </div>
        ) : activeTab === 'custom' ? (
           <div className="space-y-8">
              <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-slate-100 print:hidden">
                 <h2 className="text-xl font-black text-slate-800 mb-2 flex items-center gap-2">
                   <CheckSquare className="text-indigo-600" />
                   حدد عناصر التقرير المراد إضافتها في الطباعة
                 </h2>
                 <p className="text-[13px] font-bold text-slate-500 mb-6">الجداول المؤرخة تعرض ما ينتهي خلال الفترة المختارة ({periodText})، أما العدادات والشرائح والقضايا فتُعرض كاملة لأنها غير مرتبطة بتاريخ.</p>
                 <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
                    {[
                      { key: 'employees', label: 'الإقامات' },
                      { key: 'companies', label: 'الشركات والسجلات' },
                      { key: 'branches', label: 'الفروع والرخص' },
                      { key: 'vehicles', label: 'المركبات' },
                      { key: 'medicalInsurances', label: 'التأمين الطبي' },
                      { key: 'utilityMeters', label: 'عدادات الكهرباء والمياه' },
                      { key: 'telecomSims', label: 'شرائح الاتصال والنت' },
                      { key: 'lawsuits', label: 'القضايا والمنازعات' },
                      { key: 'legalContracts', label: 'العقود والاتفاقيات' },
                    ].map(item => (
                      <label key={item.key} className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${reportConfig[item.key as keyof typeof reportConfig] ? 'border-indigo-500 bg-indigo-50' : 'border-slate-100 bg-slate-50 hover:border-indigo-200'}`}>
                        <input type="checkbox" checked={reportConfig[item.key as keyof typeof reportConfig]} onChange={() => handleConfigChange(item.key as keyof typeof reportConfig)} className="w-5 h-5 text-indigo-600 rounded" />
                        <span className="font-bold text-[14px] text-slate-700">{item.label}</span>
                      </label>
                    ))}
                 </div>
                 <button type="button" onClick={() => window.print()} className="w-full md:w-auto px-10 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-[1.25rem] transition-all flex items-center justify-center gap-3 shadow-lg shadow-indigo-200">
                   <Printer size={20} />
                   طباعة التقرير كاملاً
                 </button>
              </div>

              {/* Printable Area */}
              <div className="bg-white p-4 sm:p-10 rounded-[2rem] shadow-sm border border-slate-100 print:shadow-none print:border-none print:p-0 overflow-x-auto">
                 <div className="hidden print:block text-center border-b-2 border-slate-800 pb-6 mb-10">
                    <h1 className="text-4xl font-black text-slate-900 mb-3">التقرير الشامل لأصول وعمليات المنشأة</h1>
                    <p className="text-xl font-bold text-slate-600">الفترة: {periodText}</p>
                    <p className="text-base font-bold text-slate-500 mt-1">تاريخ الإصدار: {formatDate(issuedAt)}</p>
                 </div>

                 {reportConfig.employees && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><Users className="text-indigo-600" /> الإقامات المنتهية أو التي تنتهي خلال الفترة</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>اسم الموظف</th>
                            <th className={PRINT_TH}>تاريخ انتهاء الإقامة</th>
                            <th className={PRINT_TH}>الحالة</th>
                            <th className={PRINT_TH}>تكلفة التجديد المسجلة</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expiringIqamas.length === 0 ? <PrintEmptyRow cols={4} /> : expiringIqamas.map((e) => (
                            <tr key={e.id}>
                              <td className={PRINT_TD}>{e.firstNameArabic} {e.lastNameArabic}</td>
                              <td className={PRINT_TD}>{formatDate(e.iqamaOrIdExp)}</td>
                              <td className={PRINT_TD}>{isPast(e.iqamaOrIdExp) ? 'منتهية' : 'تنتهي خلال الفترة'}</td>
                              <td className={PRINT_TD}>{e.iqamaRenewalCost && e.iqamaRenewalCost > 0 ? `${formatMoney(e.iqamaRenewalCost)} ر.س` : 'غير مسجلة'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.companies && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><Building2 className="text-indigo-600" /> الشركات: سجلات وعلامات تنتهي خلال الفترة</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>اسم الشركة</th>
                            <th className={PRINT_TH}>تاريخ انتهاء السجل</th>
                            <th className={PRINT_TH}>انتهاء العلامة التجارية</th>
                          </tr>
                        </thead>
                        <tbody>
                          {printCompanies.length === 0 ? <PrintEmptyRow cols={3} /> : printCompanies.map((c) => (
                            <tr key={c.id}>
                              <td className={PRINT_TD}>{c.nameArabic}</td>
                              <td className={PRINT_TD}>{formatDate(c.commercialRegExp)}</td>
                              <td className={PRINT_TD}>{c.trademarkExpDate ? formatDate(c.trademarkExpDate) : 'لا يوجد'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.branches && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><Building2 className="text-indigo-600" /> الفروع: رخص وعقود إيجار تنتهي خلال الفترة</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>اسم الفرع</th>
                            <th className={PRINT_TH}>رخصة البلدية</th>
                            <th className={PRINT_TH}>الدفاع المدني</th>
                            <th className={PRINT_TH}>قيمة عقد الإيجار / الانتهاء</th>
                          </tr>
                        </thead>
                        <tbody>
                          {printBranches.length === 0 ? <PrintEmptyRow cols={4} /> : printBranches.map((b) => (
                            <tr key={b.id}>
                              <td className={PRINT_TD}>{b.nameArabic}</td>
                              <td className={PRINT_TD}>{formatDate(b.munLicenseExp)}</td>
                              <td className={PRINT_TD}>{formatDate(b.civilDefenseExp)}</td>
                              <td className={PRINT_TD}>{b.rentContractAmount ? `${formatMoney(b.rentContractAmount)} ر.س` : 'غير مسجلة'} / {formatDate(b.rentContractExp)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.vehicles && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><CarFront className="text-indigo-600" /> المركبات: تأمين ينتهي خلال الفترة</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>المركبة</th>
                            <th className={PRINT_TH}>اللوحة</th>
                            <th className={PRINT_TH}>انتهاء التأمين</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expiringVehicles.length === 0 ? <PrintEmptyRow cols={3} /> : expiringVehicles.map((v) => (
                            <tr key={v.id}>
                              <td className={PRINT_TD}>{v.brand}</td>
                              <td className={PRINT_TD}>{v.plateNumber}</td>
                              <td className={PRINT_TD}>{formatDate(v.insuranceExpDate)}{isPast(v.insuranceExpDate) ? ' (منتهٍ)' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.medicalInsurances && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><ShieldPlus className="text-indigo-600" /> التأمين الطبي: وثائق تنتهي خلال الفترة</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>شركة التأمين (المُصدر)</th>
                            <th className={PRINT_TH}>تاريخ الانتهاء</th>
                            <th className={PRINT_TH}>تكلفة الوثيقة</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expiringMedical.length === 0 ? <PrintEmptyRow cols={3} /> : expiringMedical.map((m) => (
                            <tr key={m.id}>
                              <td className={PRINT_TD}>{m.insuranceIssuer}</td>
                              <td className={PRINT_TD}>{formatDate(m.expiryDate)}{isPast(m.expiryDate) ? ' (منتهية)' : ''}</td>
                              <td className={PRINT_TD}>{m.policyCost && m.policyCost > 0 ? `${formatMoney(m.policyCost)} ر.س` : 'غير مسجلة'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.utilityMeters && (data?.utilityMeters?.length ?? 0) > 0 && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><CalendarDays className="text-indigo-600" /> عدادات الكهرباء والمياه</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>رقم الحساب/السداد</th>
                            <th className={PRINT_TH}>رقم العداد</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data?.utilityMeters?.map((m) => (
                            <tr key={m.id}>
                              <td className={PRINT_TD}>{m.accountNumber}</td>
                              <td className={PRINT_TD}>{m.meterNumber || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.telecomSims && (data?.telecomSims?.length ?? 0) > 0 && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><FileText className="text-indigo-600" /> شرائح الاتصال والنت</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>المزود</th>
                            <th className={PRINT_TH}>رقم الشريحة</th>
                            <th className={PRINT_TH}>النوع</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data?.telecomSims?.map((s) => (
                            <tr key={s.id}>
                              <td className={PRINT_TD}>{s.provider}</td>
                              <td className={PRINT_TD} dir="ltr">{s.simNumber}</td>
                              <td className={PRINT_TD}>{s.serviceType}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.lawsuits && (data?.lawsuits?.length ?? 0) > 0 && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><Key className="text-indigo-600" /> القضايا والمنازعات</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>الموضوع</th>
                            <th className={PRINT_TH}>التصنيف</th>
                            <th className={PRINT_TH}>مكتب المحاماة</th>
                            <th className={PRINT_TH}>الحالة</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data?.lawsuits?.map((l) => (
                            <tr key={l.id}>
                              <td className={PRINT_TD}>{l.subject}</td>
                              <td className={PRINT_TD}>{l.caseTypeLabel || '-'}</td>
                              <td className={PRINT_TD}>{l.lawFirmName || 'غير محدد'}</td>
                              <td className={PRINT_TD}>{l.statusLabel || l.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 {reportConfig.legalContracts && (
                    <div className="mb-12 print:break-inside-avoid">
                      <h2 className="text-2xl font-black text-slate-800 mb-6 pb-2 border-b-2 border-indigo-100 flex items-center gap-2"><FileText className="text-indigo-600" /> العقود والاتفاقيات: تنتهي خلال الفترة</h2>
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className={PRINT_TH}>العقد</th>
                            <th className={PRINT_TH}>الطرف الثاني</th>
                            <th className={PRINT_TH}>الحالة</th>
                            <th className={PRINT_TH}>انتهاء العقد</th>
                          </tr>
                        </thead>
                        <tbody>
                          {printContracts.length === 0 ? <PrintEmptyRow cols={4} /> : printContracts.map((c) => (
                            <tr key={c.id}>
                              <td className={PRINT_TD}>{c.title}</td>
                              <td className={PRINT_TD}>{c.secondParty || '-'}</td>
                              <td className={PRINT_TD}>{c.statusLabel || c.status}</td>
                              <td className={PRINT_TD}>{formatDate(c.endDate)}{isPast(c.endDate) ? ' (منتهٍ)' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                 )}

                 <div className="hidden print:block text-center mt-12 pt-6 border-t border-slate-200">
                    <p className="font-bold text-slate-500">تم إنشاء هذا التقرير تلقائياً من نظام رديف ERP</p>
                 </div>
              </div>
           </div>
        ) : null}

      </div>
    </DashboardLayout>
  );
}
