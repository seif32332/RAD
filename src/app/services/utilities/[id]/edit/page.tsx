"use client";

import React, { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import UtilityForm, { meterToForm, type UtilityFormValues } from '../../_components/UtilityForm';

export default function EditUtilityMeterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<UtilityFormValues | null>(null);

  const loadMeter = useCallback(async () => {
    setIsFetching(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/services/utilities/${encodeURIComponent(id)}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { setLoadError(await readApiError(res, 'العداد غير موجود')); return; }
      const data: unknown = await res.json();
      if (data && typeof data === 'object' && 'id' in data) {
        setInitialValues(meterToForm(data as Record<string, unknown>));
      } else {
        setLoadError('العداد غير موجود');
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsFetching(false);
    }
  }, [id]);

  useEffect(() => { loadMeter(); }, [loadMeter]);

  if (isFetching) {
    return (
      <DashboardLayout>
        <div className="flex justify-center items-center p-32">
          <RefreshCw className="animate-spin text-amber-500 w-10 h-10" />
        </div>
      </DashboardLayout>
    );
  }

  if (loadError || !initialValues) {
    return (
      <DashboardLayout>
        <div className="p-6 max-w-4xl mx-auto space-y-8 pb-32">
          <Link href="/services/utilities" className="flex items-center gap-1 text-slate-500 hover:text-amber-600 font-bold text-sm transition text-right w-fit">
            <ChevronRight size={16} /> العودة للعدادات
          </Link>
          <div className="bg-white rounded-[2rem] border border-rose-200 p-16 flex flex-col items-center justify-center text-center">
            <p className="text-rose-600 font-bold mb-4">{loadError || 'العداد غير موجود'}</p>
            <button type="button" onClick={loadMeter} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <UtilityForm mode="edit" initialValues={initialValues} submitUrl={`/api/services/utilities/${encodeURIComponent(id)}`} submitMethod="PUT" />
    </DashboardLayout>
  );
}
