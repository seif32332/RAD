"use client";

import React, { useState, useEffect, useCallback, use } from 'react';
import {
  Building2, ChevronRight, FileText, Edit, Trash2, Calendar, Hash, MapPin, ShieldCheck, Globe, AlertTriangle, RefreshCw, Link2, Calculator
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { MEDICAL_PREMIUM_KEYS, MEDICAL_PREMIUM_LABELS, OVERTIME_BASIS_SHORT, normalizeOvertimeBasis, parseMedicalPremiums } from '@/lib/workforce/company-settings';
import { iqamaRuleText, money, type IqamaFeeRuleView } from '../_components/CostSettingsSection';

interface CompanyDetails {
  id: string;
  nameArabic: string;
  nameEnglish?: string | null;
  commercialRegDate?: string | null;
  commercialRegExp?: string | null;
  commercialRegUrl?: string | null;
  unifiedNumber?: string | null;
  taxNumber?: string | null;
  molEstablishmentNumber?: string | null;
  gosiEstablishmentNumber?: string | null;
  taxCertificateUrl?: string | null;
  nationalAddress?: string | null;
  nationalAddressUrl?: string | null;
  establishmentDeedUrl?: string | null;
  trademarkNumber?: string | null;
  trademarkRegDate?: string | null;
  trademarkExpDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  _count?: { legalEmployees?: number };
  moiNumber?: string | null;
  muqeemPlatformId?: string | null;
  muqeemLinked?: boolean;
  muqeemPlatform?: { id: string; platformName: string } | null;
  overtimeHourlyBasis?: string | null;
  medicalPremiumsJson?: string | null;
  iqamaFeeYear?: number | null;
  iqamaFeeRule?: IqamaFeeRuleView | null;
}

type Tone = 'blue' | 'indigo' | 'emerald' | 'violet' | 'amber' | 'slate';
const HEADER_TONE: Record<Tone, string> = {
  blue: 'bg-blue-50/30',
  indigo: 'bg-indigo-50/30',
  emerald: 'bg-emerald-50/30',
  violet: 'bg-violet-50/30',
  amber: 'bg-amber-50/30',
  slate: 'bg-slate-50/30',
};

export default function CompanyDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [company, setCompany] = useState<CompanyDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (res.status === 404) {
        setCompany(null);
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل بيانات الشركة'));
        return;
      }
      setCompany((await res.json()) as CompanyDetails);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async () => {
    if (isDeleting) return;
    if (!(await confirmDialog('هل أنت متأكد من حذف هذه الشركة؟ لا يمكن التراجع عن هذا الإجراء.', { danger: true, confirmText: 'حذف' }))) return;
    setIsDeleting(true);
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
      toast.success('تم حذف الشركة');
      router.push('/companies');
    } catch {
      toast.error('حدث خطأ في الاتصال');
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96 gap-4">
          <div className="w-8 h-8 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" />
          <p className="text-slate-500 font-bold">جاري جلب بيانات الشركة...</p>
        </div>
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <AlertTriangle size={48} className="text-rose-300" />
          <p className="text-slate-600 font-bold">{loadError}</p>
          <div className="flex items-center gap-4">
            <button type="button" onClick={load} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-[13px] transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
            <Link href="/companies" className="text-blue-600 font-bold text-sm hover:underline">العودة لقائمة الشركات</Link>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (!company) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <Building2 size={48} className="text-slate-200" />
          <p className="text-slate-500 font-bold text-lg">الشركة غير موجودة</p>
          <Link href="/companies" className="text-blue-600 font-bold text-sm hover:underline">العودة لقائمة الشركات</Link>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 space-y-8">

        {/* Header */}
        <div>
          <Link href="/companies" className="inline-flex items-center gap-2 text-slate-400 hover:text-blue-600 transition font-bold text-[13px] mb-6 group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-blue-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لقائمة الشركات
          </Link>

          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-5">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-black text-3xl shadow-lg border border-blue-400/20">
                {company.nameArabic?.charAt(0) || '?'}
              </div>
              <div>
                <h1 className="text-3xl font-black text-slate-900">{company.nameArabic}</h1>
                {company.nameEnglish && <p className="text-slate-400 font-bold text-sm mt-0.5">{company.nameEnglish}</p>}
              </div>
            </div>

            <div className="flex gap-3">
              <Link href={`/companies/${id}/edit`}
                className="px-5 py-2.5 bg-amber-50 text-amber-700 rounded-xl font-bold text-[13px] hover:bg-amber-100 transition flex items-center gap-2 border border-amber-200">
                <Edit size={16} /> تعديل البيانات
              </Link>
              <button type="button" onClick={handleDelete} disabled={isDeleting}
                className="px-5 py-2.5 bg-red-50 text-red-600 rounded-xl font-bold text-[13px] hover:bg-red-100 transition flex items-center gap-2 border border-red-200 disabled:opacity-50">
                <Trash2 size={16} /> {isDeleting ? 'جاري الحذف...' : 'حذف'}
              </button>
            </div>
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

          {/* السجل التجاري */}
          <InfoCard icon={<FileText size={20} className="text-blue-500" />} title="السجل التجاري" color="blue">
            <InfoRow label="تاريخ البداية" value={formatDate(company.commercialRegDate)} />
            <InfoRow label="موعد التأكيد السنوي" value={formatDate(company.commercialRegExp)} />
            {company.commercialRegUrl && (
              <a href={company.commercialRegUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-blue-600 hover:underline mt-2 block">📎 عرض المرفق</a>
            )}
          </InfoCard>

          {/* الأرقام */}
          <InfoCard icon={<Hash size={20} className="text-indigo-500" />} title="الأرقام التعريفية" color="indigo">
            <InfoRow label="الرقم الموحد" value={company.unifiedNumber || '—'} />
            <InfoRow label="الرقم الضريبي" value={company.taxNumber || '—'} />
            <InfoRow label="رقم المنشأة (الموارد البشرية)" value={company.molEstablishmentNumber || '—'} />
            <InfoRow label="رقم المنشأة (التأمينات)" value={company.gosiEstablishmentNumber || '—'} />
            {company.taxCertificateUrl && (
              <a href={company.taxCertificateUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-indigo-600 hover:underline mt-2 block">📎 عرض الشهادة الضريبية</a>
            )}
            <InfoRow label="عدد الموظفين" value={`${company._count?.legalEmployees || 0} موظف`} />
          </InfoCard>

          {/* العنوان */}
          <InfoCard icon={<MapPin size={20} className="text-emerald-500" />} title="العنوان الوطني" color="emerald">
            <InfoRow label="الرقم المختصر" value={company.nationalAddress || '—'} />
            {company.nationalAddressUrl && (
              <a href={company.nationalAddressUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-emerald-600 hover:underline mt-2 block">📎 عرض المرفق</a>
            )}
          </InfoCard>

          {/* عقد التأسيس */}
          <InfoCard icon={<ShieldCheck size={20} className="text-violet-500" />} title="عقد التأسيس" color="violet">
            {company.establishmentDeedUrl ? (
              <a href={company.establishmentDeedUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] font-bold text-violet-600 hover:underline">📎 عرض عقد التأسيس</a>
            ) : (
              <p className="text-[12px] font-bold text-slate-400">لم يتم إرفاق عقد التأسيس</p>
            )}
          </InfoCard>

          {/* العلامة التجارية */}
          <InfoCard icon={<Globe size={20} className="text-amber-500" />} title="العلامة التجارية" color="amber">
            <InfoRow label="رقم التسجيل" value={company.trademarkNumber || '—'} />
            <InfoRow label="تاريخ التسجيل" value={formatDate(company.trademarkRegDate)} />
            <InfoRow label="تاريخ الانتهاء" value={formatDate(company.trademarkExpDate)} />
          </InfoCard>

          {/* الربط مع مقيم */}
          <InfoCard icon={<Link2 size={20} className="text-teal-500" />} title="الربط مع مقيم" color="emerald">
            <div className="flex justify-between items-center">
              <span className="text-[11px] font-bold text-slate-400">الحالة</span>
              <span
                className={`text-[11px] font-black px-2.5 py-1 rounded-lg ${company.muqeemLinked ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}
              >
                {company.muqeemLinked ? 'مربوطة بمقيم' : 'غير مربوطة'}
              </span>
            </div>
            <InfoRow label="رقم المنشأة (الجوازات)" value={company.moiNumber || '—'} />
            <InfoRow label="حساب مقيم" value={company.muqeemPlatform?.platformName || '—'} />
            {!company.muqeemLinked && (
              <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
                أدخل رقم المنشأة واختر حساب مقيم من صفحة تعديل البيانات لتفعيل خدمات مقيم.
              </p>
            )}
          </InfoCard>

          {/* إعدادات الكلفة */}
          <CostSettingsCard company={company} />

          {/* تاريخ التسجيل */}
          <InfoCard icon={<Calendar size={20} className="text-slate-500" />} title="تاريخ التسجيل في النظام" color="slate">
            <InfoRow label="تاريخ الإنشاء" value={formatDate(company.createdAt)} />
            <InfoRow label="آخر تحديث" value={formatDate(company.updatedAt)} />
          </InfoCard>

        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm">
          <h3 className="font-bold text-slate-700 text-sm mb-4">إجراءات سريعة</h3>
          <div className="flex flex-wrap gap-3">
            <Link href="/branches" className="px-5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[13px] font-bold text-slate-700 hover:border-blue-300 hover:text-blue-600 transition">
              إدارة الفروع
            </Link>
            <Link href="/departments" className="px-5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[13px] font-bold text-slate-700 hover:border-blue-300 hover:text-blue-600 transition">
              الهيكل التنظيمي
            </Link>
            <Link href="/employees" className="px-5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[13px] font-bold text-slate-700 hover:border-blue-300 hover:text-blue-600 transition">
              الموظفين
            </Link>
          </div>
        </div>

      </div>
    </DashboardLayout>
  );
}

function InfoCard({ icon, title, color, children }: { icon: React.ReactNode; title: string; color: Tone; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className={`px-5 py-3.5 border-b border-slate-100 flex items-center gap-3 ${HEADER_TONE[color]}`}>
        {icon}
        <h3 className="font-extrabold text-[13px] text-slate-800">{title}</h3>
      </div>
      <div className="p-5 space-y-3">{children}</div>
    </div>
  );
}

/** «إعدادات الكلفة» (read-only; edited in the company form by SUPER_ADMIN / COMPANY_ADMIN). */
function CostSettingsCard({ company }: { company: CompanyDetails }) {
  const premiums = parseMedicalPremiums(company.medicalPremiumsJson ?? null);
  const fee = typeof company.iqamaFeeYear === 'number' ? company.iqamaFeeYear : null;
  return (
    <InfoCard icon={<Calculator size={20} className="text-indigo-500" />} title="إعدادات الكلفة" color="indigo">
      <InfoRow label="أجر العمل الإضافي" value={OVERTIME_BASIS_SHORT[normalizeOvertimeBasis(company.overtimeHourlyBasis)]} />
      <div>
        <p className="text-[11px] font-bold text-slate-400 mb-1.5">أقساط التأمين الطبي السنوية (ريال)</p>
        <dl className="grid grid-cols-3 gap-x-3 gap-y-1">
          {MEDICAL_PREMIUM_KEYS.map((k) => (
            <div key={k} className="flex items-center justify-between gap-1 min-w-0">
              <dt className="text-[11px] font-bold text-slate-500" dir={k === 'DEPENDENT' ? undefined : 'ltr'}>
                {k === 'DEPENDENT' ? 'مرافق' : MEDICAL_PREMIUM_LABELS[k]}
              </dt>
              <dd className={`text-[12px] font-black ${typeof premiums[k] === 'number' ? 'text-slate-700' : 'text-slate-300'}`}>
                {typeof premiums[k] === 'number' ? money(premiums[k] as number) : '—'}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <InfoRow label="رسوم الإقامة السنوية" value={fee !== null ? `${money(fee)} ريال` : `سجل القواعد: ${iqamaRuleText(company.iqamaFeeRule)}`} />
      <Link href={`/companies/${company.id}/edit#company-cost-settings`} className="text-[11px] font-bold text-indigo-600 hover:underline block">
        تعديل إعدادات الكلفة ←
      </Link>
    </InfoCard>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[11px] font-bold text-slate-400">{label}</span>
      <span className="text-[12px] font-black text-slate-700">{value}</span>
    </div>
  );
}
