"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Home, ShieldAlert } from "lucide-react";

interface AccessDeniedProps {
  /** Landing page of the current role (see homePathFor in src/lib/menu.ts). */
  homeHref: string;
  /** Arabic label of the current role, shown for context. */
  roleLabel?: string;
}

/**
 * Friendly screen rendered by the AppShell instead of a page the current role may not open.
 * Pure UX: the page's API routes still enforce access on the server.
 */
export default function AccessDenied({ homeHref, roleLabel }: AccessDeniedProps) {
  const router = useRouter();
  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.replace(homeHref);
  };

  return (
    <div dir="rtl" className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <section
        role="alert"
        aria-labelledby="access-denied-title"
        data-testid="access-denied"
        className="w-full max-w-lg rounded-[2rem] border border-slate-200 bg-white p-8 text-center shadow-sm md:p-10"
      >
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-100 bg-amber-50 text-amber-500">
          <ShieldAlert size={30} aria-hidden="true" />
        </div>
        <p className="text-[12px] font-black tracking-[0.3em] text-amber-500" dir="ltr">
          403
        </p>
        <h1 id="access-denied-title" className="mt-2 text-xl font-black text-slate-900">
          ليس لديك صلاحية للوصول إلى هذه الصفحة
        </h1>
        <p className="mt-3 text-[14px] font-bold leading-relaxed text-slate-500">
          هذه الصفحة غير متاحة{roleLabel ? ` لدور «${roleLabel}»` : " لدورك الحالي"}. إذا كنت تحتاج إليها في عملك
          يرجى التواصل مع مدير النظام لمنحك الصلاحية المناسبة.
        </p>
        <div className="mt-8 flex flex-col-reverse justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-3 text-[13px] font-black text-slate-700 transition hover:bg-slate-50"
          >
            <ArrowRight size={16} aria-hidden="true" /> الرجوع
          </button>
          <Link
            href={homeHref}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-[13px] font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700"
          >
            <Home size={16} aria-hidden="true" /> الذهاب إلى صفحتي الرئيسية
          </Link>
        </div>
      </section>
    </div>
  );
}
