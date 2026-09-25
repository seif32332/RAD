"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { Crosshair, Edit, ExternalLink, MapPin, Plus, Power, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { confirmDialog, readApiError, toast } from '@/components/ui/feedback';
import { GEOFENCE_RADIUS_LIMITS, mapsLink, parseLatLngFromMapsUrl } from '@/lib/geo';

interface AttendanceLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  isActive: boolean;
}

interface FormState {
  id: string | null;
  name: string;
  link: string;
  latitude: string;
  longitude: string;
  radiusM: string;
}

const EMPTY_FORM: FormState = { id: null, name: '', link: '', latitude: '', longitude: '', radiusM: '' };

const fieldClass = 'w-full bg-slate-50 border-2 border-slate-100 focus:bg-white focus:border-violet-400 rounded-2xl px-4 py-3 font-bold text-slate-800 transition-all focus:outline-none placeholder:font-semibold placeholder:text-slate-400';
const labelClass = 'text-[13px] font-extrabold text-slate-700 block mb-2';

/**
 * "مواقع الحضور" of a branch: circular geofences (center + radius) inside which the branch's
 * employees may clock in from the portal. Writes are allowed to ADMIN / HR (enforced by the API).
 */
export default function AttendanceLocations({ branchId, branchName, locationUrl }: { branchId: string; branchName: string; locationUrl?: string | null }) {
  const [locations, setLocations] = useState<AttendanceLocation[] | null>(null);
  const [defaultRadius, setDefaultRadius] = useState(150);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/attendance-locations?branchId=${encodeURIComponent(branchId)}`, { cache: 'no-store' });
      if (!res.ok) {
        setLocations([]);
        return;
      }
      const data = (await res.json()) as { locations: AttendanceLocation[]; defaultRadiusM: number };
      setLocations(data.locations);
      setDefaultRadius(data.defaultRadiusM);
    } catch {
      setLocations([]);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    const fromBranch = parseLatLngFromMapsUrl(locationUrl);
    setForm({
      ...EMPTY_FORM,
      name: locations && locations.length > 0 ? '' : branchName,
      link: fromBranch && locationUrl ? locationUrl : '',
      latitude: fromBranch ? String(fromBranch.latitude) : '',
      longitude: fromBranch ? String(fromBranch.longitude) : '',
      radiusM: String(defaultRadius),
    });
  };

  const openEdit = (l: AttendanceLocation) => {
    setForm({ id: l.id, name: l.name, link: '', latitude: String(l.latitude), longitude: String(l.longitude), radiusM: String(l.radiusM) });
  };

  const onLinkChange = (value: string) => {
    if (!form) return;
    const point = parseLatLngFromMapsUrl(value);
    setForm({ ...form, link: value, ...(point ? { latitude: String(point.latitude), longitude: String(point.longitude) } : {}) });
  };

  const useMyLocation = () => {
    if (!form) return;
    if (!('geolocation' in navigator)) {
      toast.error('المتصفح لا يدعم تحديد الموقع');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        setForm((f) => (f ? { ...f, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) } : f));
        toast.success(`تم تحديد موقعك بدقة تقارب ${Math.round(p.coords.accuracy)} م`);
      },
      () => {
        setLocating(false);
        toast.error('تعذر تحديد موقعك. اسمح للمتصفح بالوصول إلى الموقع وفعّل GPS.');
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  };

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!form || saving) return;
    const payload = {
      name: form.name,
      latitude: Number(form.latitude),
      longitude: Number(form.longitude),
      radiusM: Number(form.radiusM),
    };
    if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude) || !form.latitude || !form.longitude) {
      toast.error('حدد الإحداثيات: الصق رابط الموقع من خرائط Google أو استخدم موقعك الحالي');
      return;
    }
    setSaving(true);
    try {
      const res = form.id
        ? await fetch(`/api/attendance-locations/${encodeURIComponent(form.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/attendance-locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, branchId }) });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حفظ الموقع'));
        return;
      }
      toast.success(form.id ? 'تم تحديث الموقع' : 'تمت إضافة الموقع');
      setForm(null);
      void load();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (l: AttendanceLocation) => {
    try {
      const res = await fetch(`/api/attendance-locations/${encodeURIComponent(l.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !l.isActive }),
      });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تحديث الموقع'));
        return;
      }
      void load();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const remove = async (l: AttendanceLocation) => {
    if (!(await confirmDialog(`حذف موقع الحضور «${l.name}»؟ الحركات السابقة تحتفظ بنسخة من بياناته.`, { danger: true, confirmText: 'حذف' }))) return;
    try {
      const res = await fetch(`/api/attendance-locations/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حذف الموقع'));
        return;
      }
      toast.success('تم حذف الموقع');
      void load();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const previewPoint =
    form && form.latitude && form.longitude && Number.isFinite(Number(form.latitude)) && Number.isFinite(Number(form.longitude))
      ? { latitude: Number(form.latitude), longitude: Number(form.longitude) }
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-[13px] font-bold text-slate-500 leading-relaxed">
          يسجّل موظفو هذا الفرع حضورهم وانصرافهم من البوابة فقط داخل هذه النطاقات.
        </p>
        <button type="button" onClick={openNew} className="shrink-0 inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl font-bold text-[13px] transition">
          <Plus size={16} aria-hidden="true" /> إضافة موقع
        </button>
      </div>

      {locations === null ? (
        <p className="text-[13px] font-bold text-slate-400">جاري التحميل...</p>
      ) : locations.length === 0 ? (
        <p className="bg-amber-50 border border-amber-100 text-amber-900 rounded-2xl p-4 text-[13px] font-bold">
          لا توجد مواقع حضور لهذا الفرع. أضف موقعاً ليتمكن الموظفون من تسجيل الحضور من البوابة.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-2xl overflow-hidden">
          {locations.map((l) => (
            <li key={l.id} className={`p-4 flex flex-col xl:flex-row xl:items-center gap-3 ${l.isActive ? 'bg-white' : 'bg-slate-50'}`}>
              <div className="flex-1 min-w-0">
                <p className="font-black text-slate-800 text-[14px] flex items-center gap-2">
                  <MapPin size={15} className="text-violet-500" aria-hidden="true" /> {l.name}
                  {!l.isActive && <span className="text-[11px] font-bold bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">متوقف</span>}
                </p>
                <p className="text-[12px] font-bold text-slate-500 mt-1">
                  نصف القطر {l.radiusM} م · <span dir="ltr">{l.latitude.toFixed(6)}, {l.longitude.toFixed(6)}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={mapsLink(l)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-3 py-1.5 rounded-lg hover:bg-blue-100">
                  <ExternalLink size={13} aria-hidden="true" /> الخريطة
                </a>
                <button type="button" onClick={() => openEdit(l)} className="inline-flex items-center gap-1 text-[12px] font-bold text-amber-700 bg-amber-50 border border-amber-100 px-3 py-1.5 rounded-lg hover:bg-amber-100">
                  <Edit size={13} aria-hidden="true" /> تعديل
                </button>
                <button type="button" onClick={() => toggleActive(l)} className="inline-flex items-center gap-1 text-[12px] font-bold text-slate-700 bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-200">
                  <Power size={13} aria-hidden="true" /> {l.isActive ? 'إيقاف' : 'تفعيل'}
                </button>
                <button type="button" onClick={() => remove(l)} className="inline-flex items-center gap-1 text-[12px] font-bold text-red-600 bg-red-50 border border-red-100 px-3 py-1.5 rounded-lg hover:bg-red-100">
                  <Trash2 size={13} aria-hidden="true" /> حذف
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={form !== null}
        onClose={() => !saving && setForm(null)}
        busy={saving}
        tone="indigo"
        icon={<MapPin size={22} />}
        title={form?.id ? 'تعديل موقع الحضور' : 'إضافة موقع حضور'}
        description="نطاق دائري: مركز الموقع ونصف قطر بالمتر"
      >
        {form && (
          <form onSubmit={save} className="p-6 md:p-8 space-y-5">
            <div>
              <label htmlFor="att-loc-name" className={labelClass}>اسم الموقع</label>
              <input id="att-loc-name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثال: المقر الرئيسي، مستودع الشمال" className={fieldClass} />
            </div>

            <div>
              <label htmlFor="att-loc-link" className={labelClass}>رابط الموقع من خرائط Google أو الإحداثيات</label>
              <input id="att-loc-link" dir="ltr" value={form.link} onChange={(e) => onLinkChange(e.target.value)} placeholder="https://www.google.com/maps/... أو 24.7136, 46.6753" className={fieldClass} />
              <p className="text-[11px] font-bold text-slate-400 mt-1">الروابط المختصرة (maps.app.goo.gl) لا تحتوي الإحداثيات: افتحها وانسخ الرابط الكامل من شريط العنوان.</p>
            </div>

            <button type="button" onClick={useMyLocation} disabled={locating} className="w-full inline-flex items-center justify-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-2xl font-bold transition disabled:opacity-50">
              <Crosshair size={16} aria-hidden="true" /> {locating ? 'جاري تحديد موقعك...' : 'استخدم موقعي الحالي (وأنا في الموقع)'}
            </button>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="att-loc-lat" className={labelClass}>خط العرض</label>
                <input id="att-loc-lat" dir="ltr" inputMode="decimal" required value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} className={fieldClass} />
              </div>
              <div>
                <label htmlFor="att-loc-lng" className={labelClass}>خط الطول</label>
                <input id="att-loc-lng" dir="ltr" inputMode="decimal" required value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} className={fieldClass} />
              </div>
            </div>

            <div>
              <label htmlFor="att-loc-radius" className={labelClass}>نصف القطر (متر)</label>
              <input
                id="att-loc-radius"
                type="number"
                required
                min={GEOFENCE_RADIUS_LIMITS.min}
                max={GEOFENCE_RADIUS_LIMITS.max}
                value={form.radiusM}
                onChange={(e) => setForm({ ...form, radiusM: e.target.value })}
                className={fieldClass}
              />
              <p className="text-[11px] font-bold text-slate-400 mt-1">
                من {GEOFENCE_RADIUS_LIMITS.min} إلى {GEOFENCE_RADIUS_LIMITS.max} متر. داخل المباني قد تنحرف دقة الجوال عشرات الأمتار، فلا تجعله صغيراً جداً.
              </p>
            </div>

            {previewPoint && (
              <a href={mapsLink(previewPoint)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-[13px] font-bold text-blue-700">
                <ExternalLink size={14} aria-hidden="true" /> تأكد من المركز على الخريطة
              </a>
            )}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={saving} className="flex-1 bg-violet-600 hover:bg-violet-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50">
                {saving ? 'جاري الحفظ...' : 'حفظ الموقع'}
              </button>
              <button type="button" onClick={() => setForm(null)} disabled={saving} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3.5 rounded-2xl font-bold transition disabled:opacity-50">
                إلغاء
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
