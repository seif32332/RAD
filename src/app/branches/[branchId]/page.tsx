"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  ChevronRight, Edit, Building2, MapPin, FileText, ShieldCheck,
  Trash2, GitBranch, AlertCircle, Link as LinkIcon, RefreshCw
} from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import {
  branchDocumentAlerts,
  branchDocumentAlertsFromAdminAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  type AdminAlert,
  type BranchDocumentAlert,
} from '@/lib/alerts';
import AttendanceLocations from './_components/AttendanceLocations';

interface BranchDetails {
  id: string;
  nameArabic: string;
  nameEnglish?: string | null;
  branchCode?: string | null;
  company?: { nameArabic: string } | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  locationUrl?: string | null;
  munLicenseNum?: string | null;
  munLicenseExp?: string | null;
  munLicenseUrl?: string | null;
  munLicenseCost?: number | null;
  civilDefenseNum?: string | null;
  civilDefenseExp?: string | null;
  civilDefenseUrl?: string | null;
  civilDefenseCost?: number | null;
  rentContractNum?: string | null;
  rentOwnerName?: string | null;
  rentOwnerPhone?: string | null;
  rentContractExp?: string | null;
  rentPaymentType?: string | null;
  rentContractAmount?: number | null;
  rentContractUrl?: string | null;
  wasteContractNum?: string | null;
  wasteContractExp?: string | null;
  wasteCompanyName?: string | null;
  wasteContractUrl?: string | null;
  safetyContractNum?: string | null;
  safetyContractExp?: string | null;
  safetyCompanyName?: string | null;
  safetyContractUrl?: string | null;
  cameraContractNum?: string | null;
  cameraContractExp?: string | null;
  cameraCompanyName?: string | null;
  cameraContractUrl?: string | null;
  buildingLicenseUrl?: string | null;
  blueprintsUrl?: string | null;
  engineeringHandoverUrl?: string | null;
  installationCompleteUrl?: string | null;
  externalPhotosUrls?: string | null;
  departments?: { id: string }[];
  employees?: { id: string }[];
}

/** Stored rentPaymentType -> Arabic (same options as the branch form). */
const RENT_PAYMENT_TYPE_LABELS: Record<string, string> = {
  ANNUAL: 'سنوي (دفعة واحدة)',
  SEMI_ANNUAL: 'نصف سنوي (دفعتان)',
  QUARTERLY: 'ربع سنوي (4 دفعات)',
  MONTHLY: 'شهري (12 دفعة)',
};

/** Safe href for stored links: keeps app-relative paths, forces http(s) for the rest. */
function safeHref(url: string): string {
  const u = url.trim();
  if (u.startsWith('/')) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u.replace(/^[a-z][a-z0-9+.-]*:/i, '')}`;
}

export default function ViewBranchPage() {
  const router = useRouter();
  const params = useParams<{ branchId: string }>();
  const branchId = params.branchId;

  const [branch, setBranch] = useState<BranchDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // This branch's document alerts from /api/admin/alerts (configured thresholds); null = not
  // available to this role, the default thresholds are used instead.
  const [serverDocAlerts, setServerDocAlerts] = useState<BranchDocumentAlert[] | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/branches/${encodeURIComponent(branchId)}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setErrorMsg(res.status === 404 ? 'الفرع غير موجود' : await readApiError(res, 'تعذر تحميل بيانات الفرع'));
        return;
      }
      setBranch((await res.json()) as BranchDetails);
      const aRes = await fetch('/api/admin/alerts', { cache: 'no-store' }).catch(() => null);
      if (aRes?.ok) {
        const a = (await aRes.json().catch(() => null)) as { alerts?: unknown } | null;
        setServerDocAlerts(Array.isArray(a?.alerts) ? branchDocumentAlertsFromAdminAlerts(a.alerts as AdminAlert[]).filter((x) => x.branchId === branchId) : null);
      } else {
        setServerDocAlerts(null);
      }
    } catch {
      setErrorMsg('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [branchId, router]);

  useEffect(() => {
    load();
  }, [load]);

  // Expiry badge per licence / contract, classified like the alert screens.
  const docAlerts = useMemo(() => {
    const list = serverDocAlerts ?? (branch ? branchDocumentAlerts(branch, DEFAULT_ALERT_THRESHOLDS) : []);
    return new Map(list.map((a) => [a.type, a]));
  }, [branch, serverDocAlerts]);

  const handleDelete = async () => {
    if (isDeleting) return;
    if (!(await confirmDialog('هل أنت متأكد من رغبتك في حذف هذا الفرع؟ لا يمكن التراجع عن هذا الإجراء.', { danger: true, confirmText: 'حذف' }))) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/branches/${encodeURIComponent(branchId)}`, { method: 'DELETE' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'فشل الحذف'));
        return;
      }
      toast.success('تم حذف الفرع');
      router.push('/branches');
      router.refresh();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96">
          <div className="w-12 h-12 rounded-full border-4 border-violet-100 border-t-violet-600 animate-spin" aria-label="جاري التحميل" />
        </div>
      </DashboardLayout>
    );
  }

  if (errorMsg || !branch) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <AlertCircle size={48} className="text-red-400" />
          <h2 className="text-xl font-bold text-slate-800">{errorMsg || 'الفرع غير موجود'}</h2>
          <div className="flex items-center gap-3 mt-4">
            {errorMsg && errorMsg !== 'الفرع غير موجود' && (
              <button type="button" onClick={load} className="inline-flex items-center gap-2 px-6 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-bold text-sm transition">
                <RefreshCw size={16} /> إعادة المحاولة
              </button>
            )}
            <Link href="/branches" className="px-6 py-2 bg-slate-100 text-slate-600 rounded-xl font-bold text-sm">العودة للفروع</Link>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const formatDate = (d: string | null | undefined) => (d ? formatDateShort(d) : 'غير متوفر');

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 mb-24 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <Link href="/branches" className="inline-flex items-center gap-2 text-slate-400 hover:text-violet-600 transition font-bold text-[13px] mb-4 group">
              <span className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center group-hover:border-violet-200 transition">
                <ChevronRight size={16} />
              </span>
              العودة لقائمة الفروع
            </Link>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-violet-100 text-violet-600 p-3 rounded-2xl"><GitBranch size={26} /></span>
              {branch.nameArabic}
              {branch.branchCode && <span className="text-lg bg-slate-100 px-3 py-1 rounded-xl text-slate-500 font-mono">#{branch.branchCode}</span>}
            </h1>
            <p className="mt-2 text-slate-500 font-bold flex items-center gap-2">
              <Building2 size={16} /> تابع لشركة: <span className="text-slate-700">{branch.company?.nameArabic || '—'}</span>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link href={`/branches/${branch.id}/edit`} className="bg-amber-100 hover:bg-amber-200 text-amber-700 px-6 py-3 rounded-2xl flex items-center gap-2 font-bold transition-all shadow-sm">
              <Edit size={18} />تعديل الفرع
            </Link>
            <button type="button" onClick={handleDelete} disabled={isDeleting} className="bg-red-50 hover:bg-red-100 text-red-600 px-4 py-3 rounded-2xl flex items-center gap-2 font-bold transition-all border border-red-100 hover:border-red-200 disabled:opacity-50">
              <Trash2 size={18} />{isDeleting ? 'جاري الحذف...' : 'حذف'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-10">

          {/* Main Content Column */}
          <div className="lg:col-span-2 space-y-8">

            <DetailSection title="معلومات العنوان" icon={<MapPin size={18} className="text-blue-500" />}>
              <div className="grid grid-cols-2 gap-6">
                <DetailItem label="المدينة/المنطقة" value={branch.city} />
                <DetailItem label="الحي" value={branch.district} />
                <DetailItem label="الشارع" value={branch.street} />
                <DetailItem label="الاسم الإنجليزي" value={branch.nameEnglish} />
                {branch.locationUrl && (
                  <div className="col-span-2">
                    <a href={safeHref(branch.locationUrl)} target="_blank" rel="noopener noreferrer" className="items-center gap-2 text-blue-600 hover:text-blue-800 font-bold bg-blue-50 p-3 rounded-xl border border-blue-100 inline-flex">
                      <MapPin size={18} /> فتح الموقع على خرائط جوجل
                    </a>
                  </div>
                )}
              </div>
            </DetailSection>

            <DetailSection title="مواقع الحضور من البوابة" icon={<MapPin size={18} className="text-violet-500" />}>
              <AttendanceLocations branchId={branch.id} branchName={branch.nameArabic} locationUrl={branch.locationUrl} />
            </DetailSection>

            <DetailSection title="رخصة البلدية" icon={<FileText size={18} className="text-emerald-500" />}>
              <div className="grid grid-cols-2 gap-6">
                <DetailItem label="رقم الرخصة" value={branch.munLicenseNum} />
                <div>
                  <DetailItem label="تاريخ الانتهاء" value={formatDate(branch.munLicenseExp)} />
                  <ExpiryBadge alert={docAlerts.get('MUN_LICENSE')} />
                </div>
                <DetailItem label="تكلفة التجديد" value={branch.munLicenseCost ? `${formatMoney(branch.munLicenseCost)} ريال` : null} />
                {branch.munLicenseUrl && (
                  <div className="col-span-2">
                    <AttachmentLink url={branch.munLicenseUrl} label="عرض صورة الرخصة" />
                  </div>
                )}
              </div>
            </DetailSection>

            <DetailSection title="رخصة الدفاع المدني" icon={<ShieldCheck size={18} className="text-red-500" />}>
              <div className="grid grid-cols-2 gap-6">
                <DetailItem label="رقم الرخصة" value={branch.civilDefenseNum} />
                <div>
                  <DetailItem label="تاريخ الانتهاء" value={formatDate(branch.civilDefenseExp)} />
                  <ExpiryBadge alert={docAlerts.get('CIVIL_DEFENSE')} />
                </div>
                <DetailItem label="تكلفة التجديد" value={branch.civilDefenseCost ? `${formatMoney(branch.civilDefenseCost)} ريال` : null} />
                {branch.civilDefenseUrl && (
                  <div className="col-span-2">
                    <AttachmentLink url={branch.civilDefenseUrl} label="عرض صورة رخصة الدفاع المدني" />
                  </div>
                )}
              </div>
            </DetailSection>

            <DetailSection title="بيانات الإيجار" icon={<Building2 size={18} className="text-purple-500" />}>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                <DetailItem label="رقم العقد" value={branch.rentContractNum} />
                <DetailItem label="اسم المؤجر" value={branch.rentOwnerName} />
                <DetailItem label="رقم التواصل" value={branch.rentOwnerPhone} />
                <div>
                  <DetailItem label="تاريخ الانتهاء" value={formatDate(branch.rentContractExp)} />
                  <ExpiryBadge alert={docAlerts.get('LEASE')} />
                </div>
                <DetailItem label="نوع الدفع" value={branch.rentPaymentType ? (RENT_PAYMENT_TYPE_LABELS[branch.rentPaymentType] ?? branch.rentPaymentType) : null} />
                <DetailItem label="قيمة العقد" value={branch.rentContractAmount ? `${formatMoney(branch.rentContractAmount)} ريال` : null} />

                {branch.rentContractUrl && (
                  <div className="col-span-2 md:col-span-3 mt-4 space-y-4">
                     {branch.rentContractUrl.split(',').filter(Boolean).map((item, index) => {
                        if (index === 0 && !item.includes('|')) {
                           return <AttachmentLink key={`${index}-${item}`} url={item} label="عرض العقد الأساسي المرفق" />;
                        }

                        let url = item, num = '', start = '', exp = '', amount = '';
                        if (item.includes('|')) {
                           [url, num = '', start = '', exp = '', amount = ''] = item.split('|');
                        }

                        return (
                           <div key={`${index}-${url}`} className="bg-slate-50 border border-slate-100 p-4 rounded-[1rem] flex flex-col gap-3">
                              <div className="flex justify-between items-center">
                                 <span className="font-black text-[13px] text-slate-800">عقد إضافي {index}</span>
                                 <AttachmentLink url={url} label="عرض المرفق" />
                              </div>
                              {(num || start || exp || amount) && (
                                 <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                                    {num && <div><span className="text-[11px] font-extrabold text-slate-400 block">رقم العقد</span><span className="text-[13px] font-bold text-slate-700">{num}</span></div>}
                                    {start && <div><span className="text-[11px] font-extrabold text-slate-400 block">تاريخ البداية</span><span className="text-[13px] font-bold text-slate-700">{formatDateShort(start)}</span></div>}
                                    {exp && <div><span className="text-[11px] font-extrabold text-slate-400 block">تاريخ الانتهاء</span><span className="text-[13px] font-bold text-slate-700">{formatDateShort(exp)}</span></div>}
                                    {amount && <div><span className="text-[11px] font-extrabold text-slate-400 block">القيمة</span><span className="text-[13px] font-bold text-slate-700">{amount}</span></div>}
                                 </div>
                              )}
                           </div>
                        );
                     })}
                  </div>
                )}
              </div>
            </DetailSection>

          </div>

          {/* Sidebar */}
          <div className="space-y-8">

            <DetailSection title="ملخص الأقسام والموظفين" icon={<GitBranch size={18} className="text-slate-500" />}>
              <div className="space-y-4">
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center">
                  <span className="font-bold text-slate-600">الأقسام المرتبطة:</span>
                  <span className="font-black text-xl text-slate-800">{branch.departments?.length || 0}</span>
                </div>
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center">
                  <span className="font-bold text-slate-600">إجمالي الموظفين:</span>
                  <span className="font-black text-xl text-slate-800">{branch.employees?.length || 0}</span>
                </div>
              </div>
            </DetailSection>

            <DetailSection title="عقود الصيانة والتشغيل" icon={<FileText size={18} className="text-teal-500" />}>
              <div className="space-y-6">
                <ContractMiniItem title="عقد النفايات" num={branch.wasteContractNum} exp={formatDate(branch.wasteContractExp)} company={branch.wasteCompanyName} url={branch.wasteContractUrl} alert={docAlerts.get('WASTE_CONTRACT')} />
                <div className="h-px bg-slate-100"></div>
                <ContractMiniItem title="صيانة السلامة" num={branch.safetyContractNum} exp={formatDate(branch.safetyContractExp)} company={branch.safetyCompanyName} url={branch.safetyContractUrl} alert={docAlerts.get('SAFETY_CONTRACT')} />
                <div className="h-px bg-slate-100"></div>
                <ContractMiniItem title="صيانة الكاميرات" num={branch.cameraContractNum} exp={formatDate(branch.cameraContractExp)} company={branch.cameraCompanyName} url={branch.cameraContractUrl} alert={docAlerts.get('CAMERA_CONTRACT')} />
              </div>
            </DetailSection>

            <DetailSection title="مرفقات عامة" icon={<LinkIcon size={18} className="text-amber-500" />}>
              <div className="flex flex-col gap-3">
                <AttachmentLink url={branch.buildingLicenseUrl} label="رخصة البناء" />
                <AttachmentLink url={branch.blueprintsUrl} label="المخططات الهندسية" />
                <AttachmentLink url={branch.engineeringHandoverUrl} label="شهادة الاستلام الهندسي" />
                <AttachmentLink url={branch.installationCompleteUrl} label="شهادة انهاء التركيبات" />
                <AttachmentLink url={branch.externalPhotosUrls} label="صور المحل من الخارج" />
              </div>
            </DetailSection>

          </div>
        </div>

      </div>
    </DashboardLayout>
  );
}

function DetailSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.02)] p-7">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-50">
        <span className="p-2.5 bg-slate-50 rounded-xl">{icon}</span>
        <h2 className="font-black text-lg text-slate-800">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function DetailItem({ label, value }: { label: string, value: string | null | undefined }) {
  return (
    <div>
      <p className="text-[12px] font-extrabold text-slate-400 mb-1">{label}</p>
      <p className="font-bold text-[14px] text-slate-800">{value || <span className="text-slate-300 font-normal">غير متوفر</span>}</p>
    </div>
  );
}

function AttachmentLink({ url, label }: { url: string | null | undefined, label: string }) {
  if (!url) return null;
  return (
    <a href={safeHref(url)} target="_blank" rel="noopener noreferrer"
       className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-violet-50 text-slate-600 hover:text-violet-700 font-bold text-[13px] rounded-xl border border-slate-200 hover:border-violet-200 transition-all">
      <LinkIcon size={14} /> {label}
    </a>
  );
}

/** "منتهي منذ N يوم" (red) or "ينتهي خلال N يوم" (amber); nothing when outside the alert window. */
function ExpiryBadge({ alert }: { alert: BranchDocumentAlert | undefined }) {
  if (!alert) return null;
  const expired = alert.level === 'expired';
  const text = expired
    ? `منتهٍ منذ ${Math.abs(alert.daysLeft)} يوم`
    : alert.daysLeft === 0 ? 'ينتهي اليوم' : `ينتهي خلال ${alert.daysLeft} يوم`;
  return (
    <p className={`text-[11px] font-bold mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${expired ? 'text-red-700 bg-red-50' : 'text-amber-700 bg-amber-50'}`}>
      <AlertCircle size={12} /> {text}
    </p>
  );
}

interface ContractMiniItemProps {
  title: string;
  num?: string | null;
  exp: string;
  company?: string | null;
  url: string | null | undefined;
  alert?: BranchDocumentAlert;
}

function ContractMiniItem({ title, num, exp, company, url, alert }: ContractMiniItemProps) {
  return (
    <div>
      <div className="flex justify-between items-center mb-2">
        <h4 className="font-bold text-slate-800 text-sm">{title}</h4>
        {url && <a href={safeHref(url)} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-md font-bold">عرض المرفق</a>}
      </div>
      <div className="text-xs text-slate-500 font-medium space-y-1">
        <p>الرقم: <span className="font-bold text-slate-700">{num || '-'}</span></p>
        <p>الشركة: <span className="font-bold text-slate-700">{company || '-'}</span></p>
        <p>الانتهاء: <span className="font-bold text-slate-700">{exp || '-'}</span></p>
      </div>
      <ExpiryBadge alert={alert} />
    </div>
  );
}
