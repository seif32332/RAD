'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2, Upload, ShieldCheck, Ban, Save } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError, promptDialog, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface Asset { id: string; kind: string; sha256: string; width: number; height: number; createdAt: string }
interface Signatory { id: string; userId: string | null; nameAr: string; nameEn: string | null; titleAr: string; titleEn: string | null; signatureAssetId: string | null; stampAssetId: string | null; isActive: boolean }
interface Authorization { id: string; signatoryId: string; typeKey: string; typeLabel: string; scopeJson: string | null; validFrom: string; validUntil: string | null; acceptedAt: string | null; revokedAt: string | null; revokeReason: string | null }
interface TypeRow { key: string; code: string; labelAr: string; defaults: { selfService: boolean; requiresApproval: boolean; validityDays: number | null }; setting: { enabled: boolean; selfService: boolean | null; requiresApproval: boolean | null; validityDays: number | null; signatoryId: string | null } | null }
interface Settings {
  companies: { id: string; nameArabic: string }[];
  companyId: string | null;
  canEdit: boolean;
  prefixLocked: boolean;
  scopes?: Record<string, string[]>;
  brand: { numberPrefix: string; primaryColor: string; numerals: string; addressAr: string | null; addressEn: string | null; phone: string | null; email: string | null; logoAssetId: string | null } | null;
  assets: Asset[];
  signatories: Signatory[];
  authorizations: Authorization[];
  types: TypeRow[];
}
interface UserOption { id: string; name: string | null; email: string; role: string }

const KIND_LABEL: Record<string, string> = { LOGO: 'شعار', SIGNATURE: 'توقيع', STAMP: 'ختم' };
const input = 'w-full border border-slate-300 rounded-xl px-3 py-2 text-[14px] disabled:bg-slate-50';

async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export default function DocumentSettingsPage() {
  const [data, setData] = useState<Settings | null>(null);
  const [companyId, setCompanyId] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState({ numberPrefix: '', primaryColor: '#0F4C81', numerals: 'latn', addressAr: '', addressEn: '', phone: '', email: '', logoAssetId: '' });
  const [sig, setSig] = useState({ id: '', userId: '', nameAr: '', nameEn: '', titleAr: '', titleEn: '', signatureAssetId: '', stampAssetId: '', isActive: true });
  const [grant, setGrant] = useState({ signatoryId: '', typeKey: '', validFrom: new Date().toISOString().slice(0, 10), validUntil: '', maxTotalSalary: '' });

  const load = useCallback(async (id?: string) => {
    const res = await fetch(`/api/documents/settings${id ? `?companyId=${encodeURIComponent(id)}` : ''}`, { cache: 'no-store' });
    if (res.status === 401) return window.location.assign('/login');
    if (!res.ok) return toast.error(await readApiError(res, 'تعذر تحميل الإعدادات'));
    const s: Settings = await res.json();
    setData(s);
    setCompanyId(s.companyId ?? '');
    setBrand({
      numberPrefix: s.brand?.numberPrefix ?? '', primaryColor: s.brand?.primaryColor ?? '#0F4C81', numerals: s.brand?.numerals ?? 'latn',
      addressAr: s.brand?.addressAr ?? '', addressEn: s.brand?.addressEn ?? '', phone: s.brand?.phone ?? '', email: s.brand?.email ?? '', logoAssetId: s.brand?.logoAssetId ?? '',
    });
  }, []);

  useEffect(() => {
    void load();
    void (async () => {
      const res = await fetch('/api/settings/users', { cache: 'no-store' });
      if (res.ok) setUsers(await res.json());
    })();
  }, [load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/documents/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر الحفظ'));
        return null;
      }
      toast.success(ok);
      const r = await res.json();
      await load(companyId);
      return r;
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function upload(kind: string, file: File | undefined) {
    if (!file) return;
    if (file.type !== 'image/png') return toast.error('الصورة يجب أن تكون PNG (بخلفية شفافة للتوقيع والختم)');
    if (file.size > 2 * 1024 * 1024) return toast.error('الحد الأقصى 2 ميجابايت');
    await post({ action: 'asset', companyId, kind, dataBase64: await toBase64(file) }, 'رُفعت الصورة.');
  }

  if (!data) return <DashboardLayout><div className="flex justify-center py-16"><Loader2 className="animate-spin text-slate-400" aria-label="جارٍ التحميل" /></div></DashboardLayout>;
  const ro = !data.canEdit || busy;
  const assetsOf = (kind: string) => data.assets.filter((a) => a.kind === kind);
  const sigName = (id: string) => data.signatories.find((s) => s.id === id)?.nameAr ?? '—';

  return (
    <DashboardLayout>
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/documents" className="text-[13px] text-slate-500 inline-flex items-center gap-1"><ArrowRight size={14} aria-hidden /> المستندات الرسمية</Link>
            <h1 className="text-2xl font-black text-slate-800">إعدادات المستندات</h1>
          </div>
          <select value={companyId} onChange={(e) => void load(e.target.value)} className="border rounded-xl px-3 py-2 text-[14px]" aria-label="الشركة النظامية">
            {data.companies.map((c) => <option key={c.id} value={c.id}>{c.nameArabic}</option>)}
          </select>
        </div>
        {!data.canEdit && <p className="rounded-xl border bg-amber-50 border-amber-200 p-3 text-[13px] text-amber-800">العرض فقط: تعديل الهوية والموقّعين والتفويضات للمالك.</p>}

        {/* Brand */}
        <section className="rounded-2xl border bg-white p-5 space-y-4">
          <h2 className="font-black text-slate-800">هوية المستندات</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <label className="block"><span className="text-[13px] font-bold">بادئة الترقيم *</span>
              <input dir="ltr" className={input} value={brand.numberPrefix} maxLength={6} disabled={ro || data.prefixLocked}
                onChange={(e) => setBrand({ ...brand, numberPrefix: e.target.value.toUpperCase() })} placeholder="ACM" />
              <span className="text-[11px] text-slate-500">{data.prefixLocked ? 'ثابتة بعد أول إصدار' : `مثال: ${brand.numberPrefix || 'ACM'}-SAL-2026-000001`}</span>
            </label>
            <label className="block"><span className="text-[13px] font-bold">اللون</span>
              <input type="color" className="w-full h-10 border rounded-xl" value={brand.primaryColor} disabled={ro} onChange={(e) => setBrand({ ...brand, primaryColor: e.target.value })} />
            </label>
            <label className="block"><span className="text-[13px] font-bold">الأرقام في المستند</span>
              <select className={input} value={brand.numerals} disabled={ro} onChange={(e) => setBrand({ ...brand, numerals: e.target.value })}>
                <option value="latn">لاتينية 123</option><option value="arab">عربية ١٢٣</option>
              </select>
            </label>
            <label className="block md:col-span-2"><span className="text-[13px] font-bold">العنوان (يظهر في التذييل)</span>
              <input className={input} value={brand.addressAr} maxLength={200} disabled={ro} onChange={(e) => setBrand({ ...brand, addressAr: e.target.value })} />
            </label>
            <label className="block"><span className="text-[13px] font-bold">الهاتف</span>
              <input dir="ltr" className={input} value={brand.phone} maxLength={40} disabled={ro} onChange={(e) => setBrand({ ...brand, phone: e.target.value })} />
            </label>
            <label className="block"><span className="text-[13px] font-bold">البريد</span>
              <input dir="ltr" className={input} value={brand.email} maxLength={120} disabled={ro} onChange={(e) => setBrand({ ...brand, email: e.target.value })} />
            </label>
            <label className="block"><span className="text-[13px] font-bold">الشعار</span>
              <select className={input} value={brand.logoAssetId} disabled={ro} onChange={(e) => setBrand({ ...brand, logoAssetId: e.target.value })}>
                <option value="">بلا شعار</option>
                {assetsOf('LOGO').map((a) => <option key={a.id} value={a.id}>شعار {a.width}×{a.height} · {formatDateShort(a.createdAt)}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <div className="flex gap-3 text-[13px]">
              {['LOGO', 'SIGNATURE', 'STAMP'].map((k) => (
                <label key={k} className={`inline-flex items-center gap-1 px-3 py-2 rounded-xl border font-bold ${ro ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50'}`}>
                  <Upload size={14} aria-hidden /> رفع {KIND_LABEL[k]}
                  <input type="file" accept="image/png" className="sr-only" disabled={ro} onChange={(e) => void upload(k, e.target.files?.[0])} />
                </label>
              ))}
            </div>
            <button type="button" disabled={ro || !brand.numberPrefix} className="px-4 py-2 rounded-xl bg-indigo-600 text-white font-bold text-[13px] inline-flex items-center gap-1 disabled:opacity-50"
              onClick={() => void post({ action: 'brand', companyId, ...brand, logoAssetId: brand.logoAssetId || null, addressEn: brand.addressEn || undefined, addressAr: brand.addressAr || undefined, phone: brand.phone || undefined, email: brand.email || undefined }, 'حُفظت الهوية.')}>
              <Save size={15} aria-hidden /> حفظ الهوية
            </button>
          </div>
        </section>

        {/* Signatories */}
        <section className="rounded-2xl border bg-white p-5 space-y-4">
          <h2 className="font-black text-slate-800">الموقّعون</h2>
          <p className="text-[12px] text-slate-500">صورة التوقيع لا تُطبع لمجرد وجودها: تُطبع فقط إذا اعتمد الموقّع المستند بنفسه، أو بتفويض مسبق ساري قبله الموقّع.</p>
          <ul className="divide-y text-[13px]">
            {data.signatories.map((s) => (
              <li key={s.id} className="py-2 flex items-center justify-between gap-2">
                <span><b>{s.nameAr}</b> · {s.titleAr} {s.userId ? '· مرتبط بحساب' : '· بلا حساب'} {s.signatureAssetId ? '· له توقيع' : ''} {s.stampAssetId ? '· له ختم' : ''} {!s.isActive && <span className="text-red-600">· غير نشط</span>}</span>
                {data.canEdit && <button type="button" className="text-indigo-700 font-bold" onClick={() => setSig({ id: s.id, userId: s.userId ?? '', nameAr: s.nameAr, nameEn: s.nameEn ?? '', titleAr: s.titleAr, titleEn: s.titleEn ?? '', signatureAssetId: s.signatureAssetId ?? '', stampAssetId: s.stampAssetId ?? '', isActive: s.isActive })}>تعديل</button>}
              </li>
            ))}
          </ul>
          {data.canEdit && (
            <form className="grid md:grid-cols-2 gap-3" onSubmit={(e) => {
              e.preventDefault();
              void post({ action: 'signatory', companyId, id: sig.id || undefined, userId: sig.userId || null, nameAr: sig.nameAr, nameEn: sig.nameEn || undefined, titleAr: sig.titleAr, titleEn: sig.titleEn || undefined, signatureAssetId: sig.signatureAssetId || null, stampAssetId: sig.stampAssetId || null, isActive: sig.isActive }, 'حُفظ الموقّع.')
                .then((r) => r && setSig({ id: '', userId: '', nameAr: '', nameEn: '', titleAr: '', titleEn: '', signatureAssetId: '', stampAssetId: '', isActive: true }));
            }}>
              <input className={input} required placeholder="الاسم بالعربية" value={sig.nameAr} onChange={(e) => setSig({ ...sig, nameAr: e.target.value })} />
              <input className={input} dir="ltr" placeholder="Name (English)" value={sig.nameEn} onChange={(e) => setSig({ ...sig, nameEn: e.target.value })} />
              <input className={input} required placeholder="المسمى (مثل: مدير الموارد البشرية)" value={sig.titleAr} onChange={(e) => setSig({ ...sig, titleAr: e.target.value })} />
              <input className={input} dir="ltr" placeholder="Title (English)" value={sig.titleEn} onChange={(e) => setSig({ ...sig, titleEn: e.target.value })} />
              <select className={input} value={sig.userId} onChange={(e) => setSig({ ...sig, userId: e.target.value })}>
                <option value="">بلا حساب في النظام</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email} ({u.email})</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <select className={input} value={sig.signatureAssetId} onChange={(e) => setSig({ ...sig, signatureAssetId: e.target.value })}>
                  <option value="">بلا توقيع</option>
                  {assetsOf('SIGNATURE').map((a) => <option key={a.id} value={a.id}>توقيع {formatDateShort(a.createdAt)}</option>)}
                </select>
                <select className={input} value={sig.stampAssetId} onChange={(e) => setSig({ ...sig, stampAssetId: e.target.value })}>
                  <option value="">بلا ختم</option>
                  {assetsOf('STAMP').map((a) => <option key={a.id} value={a.id}>ختم {formatDateShort(a.createdAt)}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={sig.isActive} onChange={(e) => setSig({ ...sig, isActive: e.target.checked })} /> نشط</label>
              <div className="flex justify-end gap-2">
                {sig.id && <button type="button" className="px-3 py-2 rounded-xl border text-[13px]" onClick={() => setSig({ id: '', userId: '', nameAr: '', nameEn: '', titleAr: '', titleEn: '', signatureAssetId: '', stampAssetId: '', isActive: true })}>جديد</button>}
                <button type="submit" disabled={busy} className="px-4 py-2 rounded-xl bg-indigo-600 text-white font-bold text-[13px]">{sig.id ? 'حفظ التعديل' : 'إضافة موقّع'}</button>
              </div>
            </form>
          )}
        </section>

        {/* Types */}
        <section className="rounded-2xl border bg-white p-5 space-y-3">
          <h2 className="font-black text-slate-800">سياسة الأنواع</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-slate-500 text-right"><tr><th className="py-2">النوع</th><th>مفعّل</th><th>من البوابة</th><th>اعتماد دائماً</th><th>الصلاحية (يوم)</th><th>الموقّع</th><th></th></tr></thead>
              <tbody className="divide-y">
                {data.types.map((t) => <TypeRowEditor key={t.key + companyId} row={t} signatories={data.signatories} disabled={ro}
                  onSave={(v) => void post({ action: 'type', companyId, typeKey: t.key, ...v }, 'حُفظت السياسة.')} />)}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-slate-500">«اعتماد دائماً» غير مفعّل = يصدر فوراً عند وجود تفويض مسبق ساري للموقّع، وإلا ينتظر الاعتماد.</p>
        </section>

        {/* Company scope of back-office users (owner) */}
        {data.canEdit && (
          <section className="rounded-2xl border bg-white p-5 space-y-3">
            <h2 className="font-black text-slate-800">نطاق المستخدمين حسب الشركة</h2>
            <p className="text-[12px] text-slate-500">
              حدّد الشركات النظامية التي يصدر لها المستخدم المستندات أو يعتمدها أو يلغيها. بلا تحديد = كل الشركات. المالك غير مقيد.
            </p>
            <ul className="divide-y text-[13px]">
              {users.filter((u) => !['SUPER_ADMIN', 'COMPANY_ADMIN', 'EMPLOYEE'].includes(u.role)).map((u) => (
                <ScopeRow key={u.id} user={u} companies={data.companies} selected={data.scopes?.[u.id] ?? []} disabled={busy}
                  onSave={(companyIds) => void post({ action: 'scope', userId: u.id, companyIds }, companyIds.length ? 'حُدّد نطاق المستخدم.' : 'أُزيل التقييد: كل الشركات.')} />
              ))}
            </ul>
          </section>
        )}

        {/* Authorizations */}
        <section className="rounded-2xl border bg-white p-5 space-y-4">
          <h2 className="font-black text-slate-800 flex items-center gap-2"><ShieldCheck size={18} aria-hidden /> التفويض المسبق بطباعة التوقيع</h2>
          <ul className="divide-y text-[13px]">
            {data.authorizations.length === 0 && <li className="py-2 text-slate-500">لا توجد تفويضات.</li>}
            {data.authorizations.map((a) => {
              const scope = a.scopeJson ? (JSON.parse(a.scopeJson) as { maxTotalSalary?: string }) : null;
              const state = a.revokedAt ? `ملغى ${formatDateShort(a.revokedAt)}` : a.acceptedAt ? 'ساري' : 'بانتظار قبول الموقّع';
              return (
                <li key={a.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span><b>{sigName(a.signatoryId)}</b> · {a.typeLabel} · من {formatDateShort(a.validFrom)}{a.validUntil ? ` إلى ${formatDateShort(a.validUntil)}` : ''}{scope?.maxTotalSalary ? ` · حتى راتب ${scope.maxTotalSalary}` : ''} · <span className={a.revokedAt ? 'text-red-600' : a.acceptedAt ? 'text-emerald-700' : 'text-amber-700'}>{state}</span></span>
                  {data.canEdit && !a.revokedAt && (
                    <button type="button" className="text-red-600 inline-flex items-center gap-1" onClick={async () => {
                      const reason = await promptDialog('سبب إلغاء التفويض:');
                      if (reason) await post({ action: 'revoke', authorizationId: a.id, reason }, 'أُلغي التفويض فوراً.');
                    }}><Ban size={14} aria-hidden /> إلغاء</button>
                  )}
                </li>
              );
            })}
          </ul>
          {data.canEdit && (
            <form className="grid md:grid-cols-5 gap-2 items-end" onSubmit={async (e) => {
              e.preventDefault();
              if (!(await confirmDialog('منح تفويض يسمح بطباعة توقيع الموقّع وختمه على هذا النوع دون اعتماده لكل مستند؟'))) return;
              const r = await post({ action: 'grant', companyId, signatoryId: grant.signatoryId, typeKey: grant.typeKey, validFrom: grant.validFrom, validUntil: grant.validUntil || null, maxTotalSalary: grant.maxTotalSalary || null }, 'مُنح التفويض.');
              if (r?.needsAcceptance) toast.info('يسري التفويض بعد قبول الموقّع له من صفحة المستندات.');
            }}>
              <select className={input} required value={grant.signatoryId} onChange={(e) => setGrant({ ...grant, signatoryId: e.target.value })}>
                <option value="">الموقّع</option>
                {data.signatories.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.nameAr}</option>)}
              </select>
              <select className={input} required value={grant.typeKey} onChange={(e) => setGrant({ ...grant, typeKey: e.target.value })}>
                <option value="">النوع</option>
                {data.types.map((t) => <option key={t.key} value={t.key}>{t.labelAr}</option>)}
              </select>
              <label className="text-[12px]">من<input type="date" className={input} required value={grant.validFrom} onChange={(e) => setGrant({ ...grant, validFrom: e.target.value })} /></label>
              <label className="text-[12px]">إلى (اختياري)<input type="date" className={input} value={grant.validUntil} onChange={(e) => setGrant({ ...grant, validUntil: e.target.value })} /></label>
              <label className="text-[12px]">حد الراتب (اختياري)<input dir="ltr" inputMode="decimal" className={input} value={grant.maxTotalSalary} onChange={(e) => setGrant({ ...grant, maxTotalSalary: e.target.value })} /></label>
              <button type="submit" disabled={busy} className="md:col-span-5 justify-self-end px-4 py-2 rounded-xl bg-indigo-600 text-white font-bold text-[13px]">منح التفويض</button>
            </form>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}

function TypeRowEditor({ row, signatories, disabled, onSave }: {
  row: TypeRow; signatories: Signatory[]; disabled: boolean;
  onSave: (v: { enabled: boolean; selfService: boolean | null; requiresApproval: boolean | null; validityDays: number | null; signatoryId: string | null }) => void;
}) {
  const s = row.setting;
  const [v, setV] = useState({
    enabled: s?.enabled ?? true,
    selfService: s?.selfService ?? row.defaults.selfService,
    requiresApproval: s?.requiresApproval ?? row.defaults.requiresApproval,
    validityDays: (s?.validityDays ?? row.defaults.validityDays)?.toString() ?? '',
    signatoryId: s?.signatoryId ?? '',
  });
  return (
    <tr>
      <td className="py-2">{row.labelAr} <span className="text-slate-400" dir="ltr">{row.code}</span></td>
      <td><input type="checkbox" aria-label="مفعّل" checked={v.enabled} disabled={disabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /></td>
      <td><input type="checkbox" aria-label="من البوابة" checked={v.selfService} disabled={disabled} onChange={(e) => setV({ ...v, selfService: e.target.checked })} /></td>
      <td><input type="checkbox" aria-label="اعتماد دائماً" checked={v.requiresApproval} disabled={disabled} onChange={(e) => setV({ ...v, requiresApproval: e.target.checked })} /></td>
      <td><input dir="ltr" className="w-20 border rounded-lg px-2 py-1" placeholder="بلا" value={v.validityDays} disabled={disabled} onChange={(e) => setV({ ...v, validityDays: e.target.value.replace(/\D/g, '') })} /></td>
      <td>
        <select className="border rounded-lg px-2 py-1" value={v.signatoryId} disabled={disabled} onChange={(e) => setV({ ...v, signatoryId: e.target.value })}>
          <option value="">بلا موقّع</option>
          {signatories.filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{x.nameAr}</option>)}
        </select>
      </td>
      <td>{!disabled && <button type="button" className="text-indigo-700 font-bold" onClick={() => onSave({ enabled: v.enabled, selfService: v.selfService, requiresApproval: v.requiresApproval, validityDays: v.validityDays ? Number(v.validityDays) : null, signatoryId: v.signatoryId || null })}>حفظ</button>}</td>
    </tr>
  );
}

function ScopeRow({ user, companies, selected, disabled, onSave }: {
  user: UserOption; companies: { id: string; nameArabic: string }[]; selected: string[]; disabled: boolean; onSave: (ids: string[]) => void;
}) {
  const [ids, setIds] = useState<string[]>(selected);
  const toggle = (id: string) => setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  return (
    <li className="py-2 flex flex-wrap items-center justify-between gap-2">
      <span className="font-bold">{user.name || user.email} <span className="text-slate-400 font-normal">({user.role})</span></span>
      <span className="flex flex-wrap items-center gap-3">
        {companies.map((c) => (
          <label key={c.id} className="inline-flex items-center gap-1"><input type="checkbox" checked={ids.includes(c.id)} onChange={() => toggle(c.id)} disabled={disabled} /> {c.nameArabic}</label>
        ))}
        <span className="text-slate-400">{ids.length ? '' : 'كل الشركات'}</span>
        <button type="button" disabled={disabled} className="text-indigo-700 font-bold" onClick={() => onSave(ids)}>حفظ</button>
      </span>
    </li>
  );
}
