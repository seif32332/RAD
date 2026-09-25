"use client";

import Link from "next/link";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";

interface ErrorStateProps {
  title?: string;
  message?: string;
  /** Next.js error digest: a reference the support team can look up in the server logs. */
  digest?: string;
  onRetry?: () => void;
  showHomeLink?: boolean;
}

/** On-brand Arabic error card used by the route error boundaries. Never shows stack traces. */
export default function ErrorState({
  title = "حدث خطأ غير متوقع",
  message = "تعذر عرض هذه الصفحة الآن. يمكنك إعادة المحاولة، وإذا استمرت المشكلة يرجى التواصل مع مدير النظام.",
  digest,
  onRetry,
  showHomeLink = true,
}: ErrorStateProps) {
  return (
    <div dir="rtl" className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div role="alert" className="w-full max-w-lg rounded-[2rem] border border-slate-200 bg-white p-8 text-center shadow-sm md:p-10">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-100 bg-rose-50 text-rose-500">
          <AlertTriangle size={30} aria-hidden="true" />
        </div>
        <h2 className="text-xl font-black text-slate-900">{title}</h2>
        <p className="mt-3 text-[14px] font-bold leading-relaxed text-slate-500">{message}</p>
        {digest && (
          <p className="mt-4 text-[11px] font-bold text-slate-400">
            رمز المرجع: <span dir="ltr" className="font-mono">{digest}</span>
          </p>
        )}
        <div className="mt-8 flex flex-col-reverse justify-center gap-3 sm:flex-row">
          {showHomeLink && (
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-3 text-[13px] font-black text-slate-700 transition hover:bg-slate-50"
            >
              <Home size={16} aria-hidden="true" /> الصفحة الرئيسية
            </Link>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-[13px] font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700"
            >
              <RefreshCw size={16} aria-hidden="true" /> إعادة المحاولة
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
