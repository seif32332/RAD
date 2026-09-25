"use client";

import React, { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import InsuranceForm, { insuranceToForm, type InsuranceFormValues } from '../../_components/InsuranceForm';

export default function EditMedicalInsurancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<InsuranceFormValues | null>(null);

  const loadInsurance = useCallback(async () => {
    setIsFetching(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/medical-insurance/${encodeURIComponent(id)}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { setLoadError(await readApiError(res, 'تعذر تحميل بيانات الوثيقة')); return; }
      const data: unknown = await res.json();
      if (data && typeof data === 'object' && 'id' in data) {
        setInitialValues(insuranceToForm(data as Record<string, unknown>));
      } else {
        setLoadError('لم يتم العثور على الوثيقة');
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsFetching(false);
    }
  }, [id]);

  useEffect(() => { loadInsurance(); }, [loadInsurance]);

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
        <div className="p-8 max-w-[800px] mx-auto">
          <Link href="/medical-insurance" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition font-bold text-[14px] mb-8">
             <ArrowRight size={18} /> العودة لقائمة التأمين الطبي
          </Link>
          <div className="bg-white rounded-[2rem] border border-rose-200 p-16 flex flex-col items-center justify-center text-center">
            <p className="text-rose-600 font-bold mb-4">{loadError || 'لم يتم العثور على الوثيقة'}</p>
            <button type="button" onClick={loadInsurance} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <InsuranceForm
        mode="edit"
        initialValues={initialValues}
        submitUrl={`/api/medical-insurance/${encodeURIComponent(id)}`}
        submitMethod="PUT"
      />
    </DashboardLayout>
  );
}
