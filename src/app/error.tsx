"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Details stay in the console / server logs; users only see a friendly message.
    console.error("[route error]", error);
  }, [error]);

  return <ErrorState digest={error.digest} onRetry={reset} />;
}
