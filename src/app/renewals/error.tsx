"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function RenewalsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Details stay in the console / server logs; users only see a friendly message.
    console.error("[renewals] page error", error);
  }, [error]);

  return (
    <ErrorState
      title="تعذر تحميل شاشة التجديدات"
      message="حدث خطأ أثناء تحميل بيانات التجديدات الدورية. يرجى إعادة المحاولة، وإذا استمرت المشكلة تواصل مع مدير النظام."
      digest={error.digest}
      onRetry={reset}
    />
  );
}
