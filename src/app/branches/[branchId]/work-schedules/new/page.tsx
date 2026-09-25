"use client";

import React, { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Clock } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { toast, readApiError } from "@/components/ui/feedback";

export default function NewWorkSchedule() {
  const { branchId } = useParams<{ branchId: string }>();
  const router = useRouter();
  const [name, setName] = useState("");
  const [flexHours, setFlexHours] = useState("");
  const [workDays, setWorkDays] = useState("");
  const [exempt, setExempt] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!name.trim()) {
      toast.warning("يرجى إدخال اسم جدول العمل");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/work-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          name: name.trim(),
          shiftType: "FLEXIBLE",
          flexibleHours: flexHours === "" ? null : Number(flexHours),
          workDays,
          isExemptFromAttendance: exempt,
        }),
      });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, "فشل إنشاء جدول العمل"));
        return;
      }
      toast.success("تم إنشاء جدول العمل");
      router.push(`/branches/${branchId}`);
    } catch {
      toast.error("خطأ غير متوقع");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <Link href={`/branches/${branchId}`} className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition font-bold text-[14px]">
          <ArrowRight size={18} /> العودة لتفاصيل الفرع
        </Link>
        <form onSubmit={submit} className="p-6 bg-white rounded-2xl shadow-xl">
          <h1 className="text-2xl font-bold mb-4 flex items-center gap-2 text-slate-800">
            <Clock size={24} className="text-blue-600" /> إضافة جدول عمل مرن
          </h1>
          <div className="space-y-4">
            <input
              type="text"
              aria-label="اسم جدول العمل"
              placeholder="اسم جدول العمل"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full p-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} />
                إعفاء من البصمة / التحضير التلقائي
              </label>
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                max={24}
                step="0.5"
                aria-label="عدد الساعات المرنة"
                placeholder="عدد الساعات المرنة"
                value={flexHours}
                onChange={(e) => setFlexHours(e.target.value)}
                className="flex-1 p-3 border rounded-xl"
              />
              <input
                type="text"
                aria-label="أيام العمل"
                placeholder="أيام العمل (مثال: الأحد-الخميس)"
                value={workDays}
                onChange={(e) => setWorkDays(e.target.value)}
                className="flex-1 p-3 border rounded-xl"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "جارٍ الحفظ…" : <>إنشاء <ArrowRight size={18} /></>}
            </button>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
