"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { Landmark, Loader2, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS } from '@/lib/constants';
import StatusPanel from './_components/StatusPanel';
import ResidentsSyncTab from './_components/ResidentsSyncTab';
import TransactionsTab from './_components/TransactionsTab';
import SettingsTab from './_components/SettingsTab';
import { callApi, CONNECTION_TEST_ROLES, type ApiResult, type MuqeemStatus } from './_components/shared';

const fetchStatus = () => callApi<MuqeemStatus>('/api/integrations/muqeem/status');

type TabKey = 'residents' | 'transactions' | 'settings';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'residents', label: 'مطابقة المقيمين' },
  { key: 'transactions', label: 'سجل المعاملات' },
  { key: 'settings', label: 'الإعدادات' },
];

export default function MuqeemIntegrationPage() {
  const { role } = useRole();
  const [status, setStatus] = useState<MuqeemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('residents');

  const apply = useCallback((res: ApiResult<MuqeemStatus>) => {
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setStatus(res.data);
  }, []);

  const refresh = () => {
    setLoading(true);
    void fetchStatus().then(apply);
  };

  useEffect(() => {
    let active = true;
    void fetchStatus().then((res) => {
      if (active) apply(res);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  const canTest = !!role && (CONNECTION_TEST_ROLES as readonly string[]).includes(role);
  const canApply = !!role && (ROLE_GROUPS.GOV as readonly string[]).includes(role);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-teal-200">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-teal-100 text-teal-700 p-3 rounded-2xl">
                <Landmark size={26} />
              </span>
              الربط مع منصة مقيم
            </h1>
            <p className="text-slate-500 font-bold mt-3 text-[14px] leading-relaxed max-w-2xl">
              حالة الربط مع منصة مقيم (Elm)، ومطابقة بيانات المقيمين مع ملفات الموظفين، وسجل كل العمليات المرسلة إلى مقيم وتسوية ما لم تُحسم نتيجته.
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-[13px] font-black text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} تحديث الحالة
          </button>
        </div>

        {error && (
          <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-[13px] font-bold text-rose-800">
            {error}
          </div>
        )}

        {loading && !status && (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 size={28} className="animate-spin" />
          </div>
        )}

        {status && (
          <>
            <StatusPanel status={status} canTest={canTest} />

            <div>
              <div role="tablist" aria-label="أقسام الربط مع مقيم" className="flex gap-2 overflow-x-auto border-b border-slate-200">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    id={`mq-tab-${t.key}`}
                    aria-selected={tab === t.key}
                    aria-controls={`mq-panel-${t.key}`}
                    onClick={() => setTab(t.key)}
                    className={`whitespace-nowrap px-5 py-3 text-[14px] font-black border-b-2 -mb-px transition ${
                      tab === t.key ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id={`mq-panel-${tab}`} aria-labelledby={`mq-tab-${tab}`} className="pt-6">
                {tab === 'residents' && <ResidentsSyncTab companies={status.companies} usable={status.usable} canApply={canApply} />}
                {tab === 'transactions' && <TransactionsTab companies={status.companies} usable={status.usable} />}
                {tab === 'settings' && <SettingsTab status={status} />}
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
