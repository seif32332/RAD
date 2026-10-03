"use client";

// The persistent single-operator banner (BL-PAY-021; pay-to-be.md BR-PAY-020 "شريط دائم"). Rendered by the
// application shell on every signed-in page. The mode comes from /api/controls-mode (computed on the server
// from the attested approvers); the banner cannot be dismissed while the tenant is in SINGLE_OPERATOR.

import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ShieldAlert } from "lucide-react";

interface ControlsState {
  mode: "ENFORCED" | "SINGLE_OPERATOR";
  banner: string | null;
  notices: string[];
}

export default function ControlsModeBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<ControlsState | null>(null);

  // Re-read on navigation: the mode moves only with identity changes, and the request is small.
  useEffect(() => {
    let alive = true;
    fetch("/api/controls-mode", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: ControlsState | null) => {
        if (alive && body && (body.mode === "ENFORCED" || body.mode === "SINGLE_OPERATOR")) setState(body);
      })
      .catch(() => {
        /* the banner is informative; the rule itself is enforced on the server */
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  if (!state) return null;
  const single = state.mode === "SINGLE_OPERATOR";
  if (!single && !state.notices.length) return null;
  return (
    <div
      role="status"
      dir="rtl"
      lang="ar"
      data-testid="controls-mode-banner"
      className={`mx-4 md:mx-10 mt-3 mb-1 rounded-2xl border px-4 py-3 text-[13px] font-bold flex items-start gap-3 print:hidden ${
        single ? "bg-amber-50 border-amber-300 text-amber-900" : "bg-slate-50 border-slate-300 text-slate-800"
      }`}
    >
      <ShieldAlert size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        {single && <p>{state.banner ?? "الشركة في وضع المشغّل الواحد: العمليات على مالك تُسجَّل وتُرسل لصاحب الشركة"}</p>}
        {state.notices.map((n) => (
          <p key={n} className="font-semibold">
            {n}
          </p>
        ))}
      </div>
    </div>
  );
}
