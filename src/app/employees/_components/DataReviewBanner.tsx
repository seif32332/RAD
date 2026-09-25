"use client";

// Warning shown on the employee profile and edit pages while Employee.dataReviewNote is set
// (e.g. an employee created from an onboarding request whose required dates were filled with
// the approval date). HR can clear it; it is also cleared automatically when an edit completes
// every listed field (PUT /api/employees/[id]).

import React, { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Pencil } from 'lucide-react';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { parseDataReviewNote } from '@/lib/employee-shared';

interface DataReviewBannerProps {
  note: string | null | undefined;
  employeeId: string;
  /** HR only: shows the "clear" button. */
  canClear: boolean;
  /** Link to the edit page (profile page only). */
  editHref?: string;
  onCleared: () => void;
}

export default function DataReviewBanner({ note, employeeId, canClear, editHref, onCleared }: DataReviewBannerProps) {
  const [isClearing, setIsClearing] = useState(false);
  const parsed = parseDataReviewNote(note);
  if (!parsed) return null;

  const handleClear = async () => {
    if (isClearing) return;
    const ok = await confirmDialog('هل تم استكمال البيانات الناقصة لهذا الموظف؟ سيتم إزالة التنبيه من ملفه.', {
      title: 'إزالة تنبيه البيانات الناقصة',
      confirmText: 'نعم، تم الاستكمال',
    });
    if (!ok) return;
    setIsClearing(true);
    try {
      const res = await fetch(`/api/employees/${encodeURIComponent(employeeId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataReviewNote: null }),
      });
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر إزالة التنبيه'));
        return;
      }
      toast.success('تمت إزالة تنبيه البيانات الناقصة');
      onCleared();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div role="alert" className="bg-amber-50 border border-amber-200 rounded-[1.5rem] p-5 flex flex-col gap-3" data-testid="data-review-banner">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <AlertTriangle size={20} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-black text-amber-900 text-[15px]">
            بيانات ناقصة يجب استكمالها{parsed.labels.length ? `: ${parsed.labels.join('، ')}` : ''}
          </p>
          {parsed.labels.length > 0 ? (
            <p className="text-[12px] font-bold text-amber-800/80 mt-1 leading-relaxed">{parsed.prefix}</p>
          ) : (
            <p className="text-[13px] font-bold text-amber-800 mt-1 leading-relaxed whitespace-pre-line">{parsed.prefix}</p>
          )}
        </div>
      </div>
      {(editHref || canClear) && (
        <div className="flex flex-wrap items-center gap-2 justify-end">
          {editHref && (
            <Link href={editHref} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-black text-[12px] transition-colors">
              <Pencil size={14} /> استكمال البيانات
            </Link>
          )}
          {canClear && (
            <button
              type="button"
              onClick={handleClear}
              disabled={isClearing}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 font-black text-[12px] transition-colors disabled:opacity-50"
            >
              <CheckCircle2 size={14} /> {isClearing ? 'جاري الحفظ...' : 'تم الاستكمال - إزالة التنبيه'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
