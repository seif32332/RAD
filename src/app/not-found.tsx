import Link from "next/link";
import { Compass, Home } from "lucide-react";

export default function NotFound() {
  return (
    <div dir="rtl" className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg rounded-[2rem] border border-slate-200 bg-white p-8 text-center shadow-sm md:p-10">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-100 bg-blue-50 text-blue-600">
          <Compass size={30} aria-hidden="true" />
        </div>
        <p className="text-[12px] font-black tracking-[0.3em] text-blue-500" dir="ltr">
          404
        </p>
        <h1 className="mt-2 text-xl font-black text-slate-900">الصفحة غير موجودة</h1>
        <p className="mt-3 text-[14px] font-bold leading-relaxed text-slate-500">
          الرابط الذي فتحته غير صحيح أو أن الصفحة نُقلت أو حُذفت.
        </p>
        <div className="mt-8 flex justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-[13px] font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700"
          >
            <Home size={16} aria-hidden="true" /> العودة إلى الصفحة الرئيسية
          </Link>
        </div>
      </div>
    </div>
  );
}
