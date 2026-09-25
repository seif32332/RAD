"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { History, Search, User, Smartphone, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { ROLE_LABELS } from '@/lib/constants';

interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: string | null;
  ipAddress?: string | null;
  createdAt: string;
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
    employeeProfile?: { firstNameArabic?: string; lastNameArabic?: string } | null;
  } | null;
}

const PAGE_SIZE = 200;

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'إنشاء سجل',
  UPDATE: 'تعديل سجل',
  DELETE: 'حذف سجل',
  LOGIN: 'تسجيل دخول للنظام',
  LOGIN_FAILED: 'محاولة دخول فاشلة',
  LOGOUT: 'تسجيل خروج من النظام',
  APPROVE: 'اعتماد / موافقة',
  REJECT: 'رفض',
  VIEW: 'اطلاع على بيانات حساسة',
  EXPORT: 'تصدير بيانات',
  IMPORT: 'استيراد بيانات',
  // Legacy action names
  CREATE_USER: 'منح صلاحية مستخدم لـموظف',
  UPDATE_USER_ROLE: 'تعديل الصلاحيات والأدوار',
  CREATE_EMPLOYEE: 'تسجيل موظف جديد',
  UPDATE_EMPLOYEE: 'تعديل بيانات موظف',
  DELETE_EMPLOYEE: 'طي قيد / حذف موظف',
  APPROVE_LOAN: 'اعتماد سلفة مالية',
  CREATE_LOAN: 'طلب سلفة مالية جديدة',
  FORGIVE_LOAN: 'إسقاط سلفة / عفو إداري',
  REJECT_LOAN: 'رفض طلب سلفة',
  CREATE_LEAVE: 'تقديم طلب إجازة',
  APPROVE_LEAVE: 'الموافقة على الإجازة',
};

const ENTITY_LABELS: Record<string, string> = {
  USER: 'وحدة المستخدمين والصلاحيات',
  User: 'وحدة المستخدمين والصلاحيات',
  EMPLOYEE: 'سجل القوى العاملة',
  Employee: 'سجل القوى العاملة',
  LOAN: 'السلف والعهد المالية',
  Loan: 'السلف والعهد المالية',
  LEAVE: 'الإجازات',
  Leave: 'الإجازات',
  PAYROLL: 'مسير الرواتب',
  Payroll: 'مسير الرواتب',
  SYSTEM: 'النظام العام',
  GovPlatform: 'المنصات الحكومية',
  File: 'الملفات والمرفقات',
  SystemSetting: 'إعدادات النظام',
  RolePermission: 'صلاحيات القوائم',
  Investigation: 'التحقيقات الإدارية',
  Asset: 'العهد والأصول',
  UtilityMeter: 'عدادات المرافق',
  MedicalInsurance: 'التأمين الطبي',
};

const translateAction = (action: string) => ACTION_LABELS[action] || action;
const translateEntity = (entity: string) => ENTITY_LABELS[entity] || entity;

const timeFormatter = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
});

function formatTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : timeFormatter.format(d);
}

function userDisplayName(log: AuditLog): string | null {
  const p = log.user?.employeeProfile;
  if (p && (p.firstNameArabic || p.lastNameArabic)) return `${p.firstNameArabic || ''} ${p.lastNameArabic || ''}`.trim();
  return log.user?.name || null;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  /** Keyset cursor of the next page (X-Next-Cursor); null when there are no more rows. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadPage = useCallback(async (cursor: string | null) => {
    const params = new URLSearchParams({ take: String(PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/settings/audit-logs?${params.toString()}`);
    if (res.status === 401) { window.location.href = '/login'; return null; }
    if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل سجل التدقيق'));
    const data: unknown = await res.json();
    const totalHeader = Number(res.headers.get('X-Total-Count'));
    return {
      rows: Array.isArray(data) ? (data as AuditLog[]) : [],
      total: Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null,
      nextCursor: res.headers.get('X-Next-Cursor'),
    };
  }, []);

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const page = await loadPage(null);
      if (!page) return;
      setLogs(page.rows);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'تعذر الاتصال بالخادم';
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  }, [loadPage]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const loadMore = async () => {
    if (isLoadingMore || !nextCursor) return;
    setIsLoadingMore(true);
    try {
      const page = await loadPage(nextCursor);
      if (!page) return;
      setNextCursor(page.nextCursor);
      setLogs(prev => {
        const seen = new Set(prev.map(l => l.id));
        return [...prev, ...page.rows.filter(r => !seen.has(r.id))];
      });
      if (page.total !== null) setTotal(page.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بالخادم');
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredLogs = logs.filter(log => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      translateAction(log.action),
      translateEntity(log.entityType),
      userDisplayName(log) || '',
      log.user?.email || '',
      log.action,
      log.entityType,
      log.ipAddress || '',
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });

  const hasMore = nextCursor !== null;

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-slate-100 text-slate-700 p-3 rounded-2xl"><History size={26} /></span>
              سجل التدقيق والمراقبة (Audit Logs)
            </h1>
            <p className="text-slate-500 font-bold mt-2 text-[14px]">
              يتم هنا تسجيل وتتبع جميع الحركات الحاسمة، التعديلات، وعمليات الاعتماد التي تتم داخل النظام لحماية البيانات.
            </p>
          </div>

          <div className="relative">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              aria-label="بحث في سجل التدقيق"
              placeholder="ابحث عن حركة، مستخدم، وحدة..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full md:w-[320px] px-5 pr-12 py-3.5 bg-white border border-slate-200 focus:border-slate-400 rounded-2xl font-bold text-[13px] focus:outline-none focus:ring-4 focus:ring-slate-50 transition-all text-slate-700 placeholder:text-slate-400"
            />
          </div>
        </div>

        {/* Logs Table */}
        <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-100">
                  <th className="p-5 text-[12px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">التاريخ والوقت</th>
                  <th className="p-5 text-[12px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">المستخدم المسؤول (المنفذ)</th>
                  <th className="p-5 text-[12px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">وحدة النظام</th>
                  <th className="p-5 text-[12px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">وصف الحركة (Action)</th>
                  <th className="p-5 text-[12px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">تفاصيل إضافية / IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="p-12 text-center text-slate-400 font-bold animate-pulse">
                      جاري جلب السجلات السرية...
                    </td>
                  </tr>
                ) : loadError ? (
                  <tr>
                    <td colSpan={5} className="p-12 text-center">
                      <p className="text-rose-600 font-bold mb-4">{loadError}</p>
                      <button type="button" onClick={fetchLogs} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
                    </td>
                  </tr>
                ) : filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-12 text-center text-slate-500 font-bold">
                      {logs.length === 0 ? 'لا توجد سجلات بعد.' : 'لا توجد سجلات مطابقة للبحث.'}
                    </td>
                  </tr>
                ) : filteredLogs.map((log) => {
                  const name = userDisplayName(log);
                  return (
                  <tr key={log.id} className="hover:bg-slate-50/50 transition duration-150">
                    <td className="p-5">
                      <div className="text-right">
                        <p className="font-bold text-[13px] text-slate-800">
                          {formatDateShort(log.createdAt)}
                        </p>
                        <p className="font-black text-[11px] text-slate-400 mt-1">
                          {formatTime(log.createdAt)}
                        </p>
                      </div>
                    </td>

                    <td className="p-5">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center font-black">
                          {name?.charAt(0) || <User size={16}/>}
                        </div>
                        <div>
                          <p className="font-bold text-[14px] text-slate-800">
                            {name || (log.user ? log.user.email : 'النظام الآلي / مسؤول خارجي')}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            {log.user?.role && (
                              <span className="bg-slate-100 text-slate-500 text-[10px] font-black px-2 py-0.5 rounded-md border border-slate-200">
                                {(ROLE_LABELS as Record<string, string>)[log.user.role] || log.user.role}
                              </span>
                            )}
                            {log.user?.email && name && (
                              <span className="text-[11px] font-bold text-slate-400 truncate max-w-[150px]" dir="ltr">{log.user.email}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="p-5">
                      <span className="inline-flex items-center gap-1.5 bg-indigo-50 text-indigo-700 border border-indigo-100 px-3 py-1.5 rounded-lg text-[12px] font-black">
                        {translateEntity(log.entityType)}
                      </span>
                    </td>

                    <td className="p-5">
                      <p className="font-black text-[13px] text-slate-800">
                        {translateAction(log.action)}
                      </p>
                      <p className="font-bold text-[10px] text-slate-400 mt-1 font-mono uppercase">
                        {log.action}
                      </p>
                    </td>

                    <td className="p-5">
                      <div className="space-y-2">
                        {log.ipAddress && (
                          <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded w-fit" dir="ltr">
                            <Smartphone size={12} /> {log.ipAddress}
                          </div>
                        )}
                        {log.details && (
                          <div className="bg-slate-50 border border-slate-200 p-2 rounded-lg text-[10px] font-mono text-slate-600 max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap overflow-x-auto scrollbar-hide" title={log.details} dir="ltr">
                            {log.details}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!isLoading && !loadError && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-[12px] font-bold text-slate-400">
              عرض {logs.length}{total !== null ? ` من أصل ${total}` : ''} سجل
            </p>
            {hasMore && (
              <button type="button" onClick={loadMore} disabled={isLoadingMore} className="px-6 py-3 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl font-bold text-[13px] text-slate-700 transition disabled:opacity-50">
                {isLoadingMore ? 'جاري التحميل...' : 'تحميل المزيد'}
              </button>
            )}
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}
