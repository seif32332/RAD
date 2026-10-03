"use client";

// BL-PAY-005: the holder of an account chooses his password with a one-time link (DEC-PO-027: an admin never
// chooses another user's password). A first attestation also asks for the 8-digit code the attester handed over
// in person (RT-PAY-1201). The link secret is in the URL FRAGMENT (#t=…): browsers never send it to a server,
// so it reaches no access log; this page reads it and posts it to /api/auth/credential-setup, then removes it
// from the address bar. Public page (under /login).
import { useEffect, useState } from "react";
import Link from "next/link";
import { readApiError } from "@/components/ui/feedback";

type Phase = "checking" | "invalid" | "form" | "done";

export default function SetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [codeRequired, setCodeRequired] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    // Do not leave the secret in the address bar or the history.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!t) {
      setPhase("invalid");
      return;
    }
    setToken(t);
    (async () => {
      try {
        const res = await fetch("/api/auth/credential-setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "inspect", token: t }),
        });
        if (!res.ok) {
          setError(await readApiError(res, "الرابط غير صالح"));
          setPhase("invalid");
          return;
        }
        const data = (await res.json()) as { codeRequired?: boolean };
        setCodeRequired(!!data.codeRequired);
        setPhase("form");
      } catch {
        setError("تعذر الاتصال بالخادم");
        setPhase("invalid");
      }
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || busy) return;
    setError(null);
    if (password !== confirm) {
      setError("كلمة المرور وتأكيدها غير متطابقتين");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/credential-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", token, code: codeRequired ? code : undefined, password, confirmPassword: confirm }),
      });
      if (!res.ok) {
        setError(await readApiError(res, "تعذر حفظ كلمة المرور"));
        if (res.status === 410 || res.status === 409) setPhase("invalid");
        return;
      }
      const data = (await res.json()) as { message?: string };
      setPassword("");
      setConfirm("");
      setCode("");
      setMessage(data.message ?? "تم اختيار كلمة المرور. سجّل الدخول الآن.");
      setPhase("done");
    } catch {
      setError("تعذر الاتصال بالخادم");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-sm p-8 space-y-6">
        <h1 className="text-2xl font-black text-slate-900">اختيار كلمة المرور</h1>
        {phase === "checking" && <p className="text-[14px] font-bold text-slate-500">جاري التحقق من الرابط...</p>}
        {phase === "invalid" && (
          <div role="alert" className="space-y-4">
            <p className="text-[14px] font-bold text-rose-700">{error ?? "الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب من مسؤول النظام رابطاً جديداً."}</p>
            <Link href="/login" className="text-[13px] font-bold text-blue-600 hover:underline">العودة لتسجيل الدخول</Link>
          </div>
        )}
        {phase === "done" && (
          <div role="status" className="space-y-4">
            <p className="text-[14px] font-bold text-emerald-700">{message}</p>
            <Link href="/login" className="inline-block px-6 py-3 bg-blue-600 text-white rounded-xl font-black text-[13px]">تسجيل الدخول</Link>
          </div>
        )}
        {phase === "form" && (
          <form onSubmit={submit} className="space-y-4">
            {codeRequired && (
              <div>
                <label htmlFor="sp-code" className="text-[12px] font-extrabold text-slate-700 mb-2 block">الرمز الذي سلّمك إياه المسؤول (8 أرقام) *</label>
                <input id="sp-code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="1234-5678" className="w-full px-4 py-3 border border-slate-200 rounded-xl font-bold text-[15px] tracking-widest text-center" />
                <p className="text-[11px] font-bold text-slate-400 mt-1">لا يُرسل هذا الرمز بالبريد. إن لم تستلمه فاطلبه من المسؤول الذي أقرّ هويتك.</p>
              </div>
            )}
            <div>
              <label htmlFor="sp-password" className="text-[12px] font-extrabold text-slate-700 mb-2 block">كلمة المرور الجديدة *</label>
              <input id="sp-password" type="password" autoComplete="new-password" dir="ltr" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-4 py-3 border border-slate-200 rounded-xl font-bold text-[14px]" />
              <p className="text-[11px] font-bold text-slate-400 mt-1">8 أحرف على الأقل، وتحتوي على حرف إنجليزي ورقم.</p>
            </div>
            <div>
              <label htmlFor="sp-confirm" className="text-[12px] font-extrabold text-slate-700 mb-2 block">تأكيد كلمة المرور *</label>
              <input id="sp-confirm" type="password" autoComplete="new-password" dir="ltr" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full px-4 py-3 border border-slate-200 rounded-xl font-bold text-[14px]" />
            </div>
            {error && <p role="alert" className="text-[13px] font-bold text-rose-700">{error}</p>}
            <button type="submit" disabled={busy} className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-[14px] disabled:opacity-50">
              {busy ? "جاري الحفظ..." : "حفظ كلمة المرور"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
