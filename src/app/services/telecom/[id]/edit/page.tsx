"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import TelecomForm, { simToForm, type TelecomFormValues } from '../../_components/TelecomForm';

export default function EditTelecomSimPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';

  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<TelecomFormValues | null>(null);

  const loadSim = useCallback(async () => {
    if (!id) return;
    setIsFetching(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/services/telecom/${encodeURIComponent(id)}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { setLoadError(await readApiError(res, 'تعذر تحميل بيانات الشريحة')); return; }
      const body = await res.json();
      const sim: unknown = body?.data ?? body;
      if (sim && typeof sim === 'object' && 'simNumber' in sim) {
        setInitialValues(simToForm(sim as Record<string, unknown>));
      } else {
        setLoadError('لم يتم العثور على الشريحة');
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsFetching(false);
    }
  }, [id]);

  useEffect(() => { loadSim(); }, [loadSim]);

  if (isFetching) {
    return (
      <DashboardLayout>
        <div className="flex justify-center items-center py-40">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
        </div>
      </DashboardLayout>
    );
  }

  if (loadError || !initialValues) {
    return (
      <DashboardLayout>
        <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8 md:py-12 space-y-8">
          <Link href="/services/telecom" className="inline-flex items-center gap-2 text-slate-400 hover:text-blue-600 transition font-bold text-[13px] group">
            <span className="w-8 h-8 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center group-hover:border-blue-200 transition">
              <ChevronRight size={16} />
            </span>
            العودة لشرائح الجوال والانترنت
          </Link>
          <div className="bg-white rounded-[2rem] border border-rose-200 p-16 flex flex-col items-center justify-center text-center">
            <p className="text-rose-600 font-bold mb-4">{loadError || 'لم يتم العثور على الشريحة'}</p>
            <button type="button" onClick={loadSim} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <TelecomForm mode="edit" initialValues={initialValues} submitUrl={`/api/services/telecom/${encodeURIComponent(id)}`} submitMethod="PUT" />
    </DashboardLayout>
  );
}
