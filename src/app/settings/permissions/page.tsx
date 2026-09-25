"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Save, CheckCircle, AlertTriangle, ListChecks, Lock, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError, toast } from '@/components/ui/feedback';
import { useRole } from '@/context/RoleContext';
import { ALL_ROLES, ROLE_LABELS, type AppRole } from '@/lib/constants';
import { MENU_GROUPS, allowedGroupKeys, defaultGroupKeys } from '@/lib/menu';

interface RolePermissionRow {
  role: string;
  allowedPages: string[];
}

/** Per-role selected group keys, exactly what the sidebar will show. */
type Selection = Record<string, Set<string>>;

/** Whether the role has a saved custom row (otherwise the defaults from src/lib/menu.ts apply). */
type CustomFlags = Record<string, boolean>;

function parseRows(data: unknown): RolePermissionRow[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .filter((r) => typeof r.role === 'string' && Array.isArray(r.allowedPages))
    .map((r) => ({
      role: r.role as string,
      allowedPages: (r.allowedPages as unknown[]).filter((p): p is string => typeof p === 'string'),
    }));
}

function buildSelection(rows: RolePermissionRow[]): { selection: Selection; custom: CustomFlags } {
  const selection: Selection = {};
  const custom: CustomFlags = {};
  for (const role of ALL_ROLES) {
    const row = rows.find((r) => r.role === role);
    const hasCustom = !!row && row.allowedPages.length > 0;
    custom[role] = hasCustom;
    const keys = hasCustom ? allowedGroupKeys(row.allowedPages) : defaultGroupKeys(role);
    for (const g of MENU_GROUPS) if (g.alwaysVisible) keys.add(g.key);
    selection[role] = keys;
  }
  return { selection, custom };
}

export default function RolePermissionsPage() {
  const router = useRouter();
  const { refresh: refreshIdentity } = useRole();
  const [selection, setSelection] = useState<Selection>({});
  const [custom, setCustom] = useState<CustomFlags>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);

  const fetchPermissions = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/settings/permissions', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        const message = await readApiError(res, 'تعذر تحميل الصلاحيات');
        setLoadError(message);
        toast.error(message);
        return;
      }
      const built = buildSelection(parseRows(await res.json()));
      setSelection(built.selection);
      setCustom(built.custom);
      setDirty({});
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void fetchPermissions();
  }, [fetchPermissions]);

  const handleToggle = (role: AppRole, key: string) => {
    const group = MENU_GROUPS.find((g) => g.key === key);
    if (!group || group.alwaysVisible || role === 'SUPER_ADMIN') return;
    setSelection((prev) => {
      const next = new Set(prev[role] ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [role]: next };
    });
    setDirty((prev) => ({ ...prev, [role]: true }));
  };

  /** Saves the role's selection, or (reset=true) clears the custom row so the role defaults apply again. */
  const handleSave = async (role: AppRole, reset = false) => {
    if (savingRole) return;
    setSavingRole(role);
    // Save stable keys in menu order (always-visible groups included for clarity).
    // An empty list means "no custom row": /api/auth/me then returns null and the defaults apply.
    const keys = reset ? [] : MENU_GROUPS.filter((g) => g.alwaysVisible || selection[role]?.has(g.key)).map((g) => g.key);
    try {
      const res = await fetch('/api/settings/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, allowedPages: keys }),
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر حفظ الصلاحيات'));
        return;
      }
      toast.success(reset ? `تمت استعادة القوائم الافتراضية: ${ROLE_LABELS[role]}` : `تم حفظ صلاحيات: ${ROLE_LABELS[role]}`);
      setCustom((prev) => ({ ...prev, [role]: !reset }));
      setDirty((prev) => ({ ...prev, [role]: false }));
      if (reset) {
        const defaults = defaultGroupKeys(role);
        for (const g of MENU_GROUPS) if (g.alwaysVisible) defaults.add(g.key);
        setSelection((prev) => ({ ...prev, [role]: defaults }));
      }
      // The admin's own sidebar reflects the change immediately.
      void refreshIdentity();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSavingRole(null);
    }
  };

  const roles: readonly AppRole[] = ALL_ROLES;

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <Link href="/settings" className="text-blue-600 font-bold text-[13px] hover:underline mb-4 block">
              ← العودة للإعدادات
            </Link>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-slate-100 text-slate-700 p-3 rounded-2xl border border-slate-200">
                <ListChecks size={26} />
              </span>
              تخصيص القوائم والصلاحيات
            </h1>
            <p className="text-slate-600 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              قم بتحديد القوائم الجانبية (الصفحات) التي يحق لكل وحدة أو دور وظيفي رؤيتها والوصول إليها عبر النظام. ما تختاره هنا هو
              بالضبط ما يظهر في القائمة الجانبية للدور.
            </p>
          </div>
        </div>

        <div className="p-5 rounded-2xl border-2 border-amber-200 bg-amber-50 text-amber-900 font-bold text-[13px] flex items-start gap-3 leading-relaxed">
          <AlertTriangle size={20} className="shrink-0 mt-0.5" />
          <span>
            إخفاء القائمة يمنع ظهورها في القائمة الجانبية فقط؛ صلاحيات الوصول الفعلية للبيانات تُفرض من الخادم حسب الدور، لذلك
            لا تظهر داخل القائمة الممنوحة إلا الصفحات التي يملك الدور صلاحية فتحها. &quot;بوابة الموظف&quot; متاحة دائماً لجميع
            الأدوار، ومدير النظام يرى جميع القوائم.
          </span>
        </div>

        {isLoading ? (
          <div className="p-20 text-center font-bold text-slate-400 animate-pulse">جاري تحميل الصلاحيات...</div>
        ) : loadError ? (
          <div className="p-12 text-center bg-white border border-rose-200 rounded-[2rem] space-y-4">
            <p className="font-black text-rose-700">{loadError}</p>
            <button
              type="button"
              onClick={() => void fetchPermissions()}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[13px] transition-colors"
            >
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {roles.map((role) => {
              const isSuperAdmin = role === 'SUPER_ADMIN';
              const selected = selection[role] ?? new Set<string>();
              return (
                <section key={role} className="bg-white border border-slate-200 rounded-[2rem] shadow-sm overflow-hidden" aria-labelledby={`role-${role}`}>
                  <div className="p-6 md:px-8 border-b border-slate-100 bg-slate-50/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h2 id={`role-${role}`} className="text-[18px] font-black text-slate-900 flex items-center gap-3">
                        <Shield size={20} className="text-blue-600" />
                        {ROLE_LABELS[role]}
                      </h2>
                      <p className="text-[12px] font-bold text-slate-400 mt-1">
                        {isSuperAdmin
                          ? 'يرى جميع القوائم دائماً'
                          : custom[role]
                            ? 'تخصيص محفوظ'
                            : 'الإعداد الافتراضي للدور (لم يُحفظ تخصيص بعد)'}
                        {dirty[role] && <span className="text-amber-600"> • تغييرات غير محفوظة</span>}
                      </p>
                    </div>
                    {!isSuperAdmin && (
                      <div className="flex flex-col sm:flex-row gap-2">
                        {custom[role] && (
                          <button
                            type="button"
                            onClick={() => void handleSave(role, true)}
                            disabled={savingRole !== null}
                            className="px-5 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl font-black text-[13px] disabled:opacity-50 transition-colors flex items-center gap-2 justify-center"
                          >
                            <RefreshCw size={16} />
                            استعادة الافتراضي
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleSave(role)}
                          disabled={savingRole !== null}
                          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[13px] disabled:opacity-50 transition-colors shadow-lg shadow-blue-600/20 flex items-center gap-2 justify-center"
                        >
                          {savingRole === role ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          ) : (
                            <Save size={16} />
                          )}
                          حفظ صلاحيات هذا الدور
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="p-6 md:p-8">
                    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {MENU_GROUPS.map((group) => {
                        const locked = isSuperAdmin || !!group.alwaysVisible;
                        const checked = isSuperAdmin || selected.has(group.key);
                        return (
                          <label
                            key={group.key}
                            className={`flex items-start gap-3 p-4 rounded-2xl border-2 transition-all ${locked ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'} ${checked ? 'bg-blue-50/50 border-blue-200' : 'bg-slate-50 border-transparent hover:border-slate-200'}`}
                          >
                            <div className="relative flex items-center justify-center mt-0.5">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={locked}
                                onChange={() => handleToggle(role, group.key)}
                                className="peer sr-only"
                              />
                              <div className="w-5 h-5 rounded-md border-2 border-slate-300 peer-checked:bg-blue-600 peer-checked:border-blue-600 peer-focus-visible:ring-4 peer-focus-visible:ring-blue-100 transition-all flex items-center justify-center">
                                <CheckCircle size={14} className={`text-white transition-transform ${checked ? 'scale-100' : 'scale-0'}`} />
                              </div>
                            </div>
                            <span className="flex-1 min-w-0">
                              <span className={`font-black text-[13px] flex items-center gap-1.5 ${checked ? 'text-blue-900' : 'text-slate-600'}`}>
                                {group.heading}
                                {locked && <Lock size={12} className="text-slate-400" aria-label="ثابت" />}
                              </span>
                              <span className="block text-[11px] font-bold text-slate-400 mt-1 leading-relaxed">
                                {group.items.map((i) => i.label).join('، ')}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
