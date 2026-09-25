"use client";

import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { MonitorSmartphone, CheckCircle, RefreshCw } from 'lucide-react';
import { toast, readApiError } from '@/components/ui/feedback';
import { redirectToLogin } from '@/app/portal/_components/redirect-to-login';

interface EmployeeOption {
  id: string;
  firstNameArabic: string;
  lastNameArabic: string;
  jobTitle?: string | null;
}

export default function AssetRequestPage() {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [assetRequestForm, setAssetRequestForm] = useState({ employeeId: '', assetType: 'LAPTOP', description: '' });

  const loadEmployees = useCallback(async () => {
    setIsLoadingEmployees(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/manager-portal?action=get_employees');
      if (res.status === 401) { redirectToLogin(); return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل قائمة الموظفين');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      const list = Array.isArray(data) ? (data as EmployeeOption[]) : [];
      setEmployees(list);
      if (list.length > 0) {
        setAssetRequestForm(f => (f.employeeId ? f : { ...f, employeeId: list[0].id }));
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoadingEmployees(false);
    }
  }, []);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const handleAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!assetRequestForm.employeeId) { toast.error('يرجى اختيار الموظف المعني بالعهدة'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/manager-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'REQUEST_ASSET',
          // The requester is the signed-in user (taken from the server session), never sent by the client.
          ...assetRequestForm,
        })
      });
      if (res.status === 401) { redirectToLogin(); return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر إرسال الطلب')); return; }
      const data = await res.json().catch(() => ({}));

      toast.success(data?.message || 'تم رفع طلب احتياج العهدة للموارد البشرية');
      setAssetRequestForm(f => ({ ...f, description: '' }));
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-orange-200">
          <div>
            <h1 className="text-3xl font-black text-orange-900 tracking-tight flex items-center gap-3">
              <span className="bg-orange-100 text-orange-700 p-3 rounded-2xl"><MonitorSmartphone size={26} /></span>
              طلب احتياج عهدة
            </h1>
            <p className="text-orange-700 font-bold mt-3 text-[14px] leading-relaxed max-w-2xl">
              يمكنك من خلال هذه الشاشة رفع طلب احتياج عهدة (أجهزة حاسب، جوال، شريحة اتصال، أو غيرها) لأي موظف ليتم توفيرها واعتمادها من الموارد البشرية والخدمات المشتركة.
            </p>
          </div>
        </div>

        <div className="bg-white border border-slate-200 shadow-xl rounded-[2rem] p-8 md:p-12 relative overflow-hidden">
          <form onSubmit={handleAction} className="space-y-6">
            <h3 className="text-xl font-black text-orange-900 border-b border-orange-100 pb-4 mb-6 flex items-center gap-2">
              <MonitorSmartphone size={22} className="text-orange-500" /> نموذج طلب عهدة / جهاز لموظف
            </h3>
            {loadError && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-center justify-between gap-4">
                <p className="text-rose-700 font-bold text-[13px]">{loadError}</p>
                <button type="button" onClick={loadEmployees} className="inline-flex items-center gap-2 px-3 py-1.5 bg-white text-rose-700 border border-rose-200 rounded-lg font-bold text-[12px] hover:bg-rose-100 transition"><RefreshCw size={12}/> إعادة المحاولة</button>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="asset-req-employee" className="text-[12px] font-extrabold text-slate-700 block mb-2">الموظف المعني بالعهدة</label>
                <select id="asset-req-employee" required disabled={isLoadingEmployees} value={assetRequestForm.employeeId} onChange={e => setAssetRequestForm({...assetRequestForm, employeeId: e.target.value})} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px]">
                    {isLoadingEmployees && <option value="">جاري التحميل...</option>}
                    {!isLoadingEmployees && employees.length === 0 && <option value="">لا يوجد موظفون</option>}
                    {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.firstNameArabic} {emp.lastNameArabic}{emp.jobTitle ? ` - ${emp.jobTitle}` : ''}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="asset-req-type" className="text-[12px] font-extrabold text-slate-700 block mb-2">نوع العهدة المطلوبة</label>
                <select id="asset-req-type" required value={assetRequestForm.assetType} onChange={e => setAssetRequestForm({...assetRequestForm, assetType: e.target.value})} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px]">
                  <option value="LAPTOP">جهاز حاسب آلي (لابتوب)</option>
                  <option value="MOBILE">جهاز هاتف (جوال)</option>
                  <option value="SIM">شريحة اتصال / بيانات</option>
                  <option value="OTHER">عهدة أخرى</option>
                </select>
              </div>
              <div className="col-span-1 md:col-span-2">
                <label htmlFor="asset-req-desc" className="text-[12px] font-extrabold text-slate-700 block mb-2">المبررات ووصف العهدة المطلوبة</label>
                <textarea id="asset-req-desc" rows={4} maxLength={2000} placeholder="مثال: لابتوب بمواصفات عالية لعمل التصاميم، شريحة بيانات للمندوب..." required value={assetRequestForm.description} onChange={e => setAssetRequestForm({...assetRequestForm, description: e.target.value})} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px]"></textarea>
              </div>
            </div>
            <button type="submit" disabled={isSubmitting || !assetRequestForm.employeeId} className="mt-8 px-10 py-4 bg-orange-600 hover:bg-orange-700 text-white font-black rounded-xl w-full flex justify-center items-center gap-2 shadow-lg hover:-translate-y-1 transition duration-300 disabled:opacity-50 disabled:hover:translate-y-0">
              {isSubmitting ? 'جاري الإرسال...' : <>تأكيد الطلب وإرساله للموارد البشرية <CheckCircle size={18} /></>}
            </button>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
