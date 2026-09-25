"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { readApiError, toast } from "@/components/ui/feedback";
import { isAppRole, type AppRole } from "@/lib/constants";
import { landingPathFor } from "@/lib/menu";
import { errorFields, validateLoginForm, type LoginErrors, type LoginField } from "@/components/ui/login-validation";

const FIELD_LABELS: Record<LoginField, string> = { email: "البريد الإلكتروني", password: "كلمة المرور" };

/**
 * Landing page after a successful sign-in, from the role in the login response and the role's
 * custom menu (GET /api/auth/me). A `next` target the role cannot open falls back to its home page.
 */
async function resolveLanding(loginRes: Response, next: string | null): Promise<string> {
  let role: AppRole | null = null;
  let allowedPages: string[] | null = null;
  try {
    const data = (await loginRes.json()) as { user?: { role?: unknown } } | null;
    const loginRole = data?.user?.role;
    if (isAppRole(loginRole)) role = loginRole;
  } catch {
    /* not JSON: fall back to /api/auth/me */
  }
  try {
    const me = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (me.ok) {
      const data = (await me.json()) as { user?: { role?: unknown }; allowedPages?: unknown } | null;
      const meRole = data?.user?.role;
      if (isAppRole(meRole)) role = meRole;
      const pages = data?.allowedPages;
      if (Array.isArray(pages)) allowedPages = pages.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* network hiccup: the role defaults are good enough to pick a landing page */
  }
  return landingPathFor(role, allowedPages, next);
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  // Inline Arabic validation (the form is noValidate: no browser-language bubbles).
  const [fieldErrors, setFieldErrors] = useState<LoginErrors>({});
  const [showSummary, setShowSummary] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const fieldRefs = { email: emailRef, password: passwordRef };
  const invalidFields = errorFields(fieldErrors);

  // Move focus to the summary when a submit fails validation, so screen readers announce it.
  useEffect(() => {
    if (showSummary) summaryRef.current?.focus();
  }, [showSummary]);

  const clearFieldError = (field: LoginField) => {
    if (!fieldErrors[field]) return;
    const next = { ...fieldErrors };
    delete next[field];
    setFieldErrors(next);
    if (errorFields(next).length === 0) setShowSummary(false);
  };

  // Already signed in with a session the SERVER still accepts: go to the role's home page.
  // (The proxy no longer redirects /login by cookie signature alone, to avoid loops for
  // sessions revoked server-side.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
        if (!me.ok || cancelled) return;
        const data = (await me.json()) as { user?: { role?: unknown }; allowedPages?: unknown } | null;
        const role = isAppRole(data?.user?.role) ? (data?.user?.role as AppRole) : null;
        const pages = Array.isArray(data?.allowedPages) ? (data?.allowedPages as unknown[]).filter((x): x is string => typeof x === "string") : null;
        if (role && !cancelled) router.replace(landingPathFor(role, pages, new URLSearchParams(window.location.search).get("next")));
      } catch {
        /* stay on the login form */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    const errors = validateLoginForm({ email, password });
    setFieldErrors(errors);
    if (errorFields(errors).length > 0) {
      setError("");
      setShowSummary(false);
      // Re-trigger the focus effect even when the summary was already shown.
      requestAnimationFrame(() => setShowSummary(true));
      return;
    }
    setShowSummary(false);
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (!res.ok) {
        const fallback =
          res.status === 429
            ? "محاولات كثيرة لتسجيل الدخول. يرجى الانتظار قليلاً ثم المحاولة مرة أخرى"
            : res.status === 401
              ? "البريد الإلكتروني أو كلمة المرور غير صحيحة"
              : "تعذر تسجيل الدخول، حاول مرة أخرى";
        setError(await readApiError(res, fallback));
        setIsLoading(false);
        return;
      }

      // The session lives in an httpOnly cookie set by the server; nothing is stored client-side.
      router.replace(await resolveLanding(res, new URLSearchParams(window.location.search).get("next")));
      router.refresh();
      // Keep the button disabled while the next page loads.
    } catch {
      setError("حدث خطأ بالاتصال، تحقق من الشبكة وحاول مرة أخرى");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 relative overflow-hidden px-4">
      {/* Background Decorations */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-100 rounded-full blur-3xl opacity-50" aria-hidden="true"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-100 rounded-full blur-3xl opacity-50" aria-hidden="true"></div>

      <main className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl z-10 border border-slate-100">
        <div className="text-center mb-8">
          <div className="bg-gradient-to-br from-blue-500 to-indigo-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200 p-2.5">
            <Image src="/logo.png" alt="شعار رديف" width={44} height={43} priority className="w-full h-full object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">مرحباً بك في رديف</h1>
          <p className="text-slate-500 mt-2 text-sm">قم بتسجيل الدخول للوصول إلى لوحة التحكم</p>
        </div>

        {error && (
          <div role="alert" className="bg-red-50 text-red-700 p-3 rounded-lg text-sm mb-6 text-center border border-red-100">
            {error}
          </div>
        )}

        {showSummary && invalidFields.length > 0 && (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            aria-labelledby="login-error-summary-title"
            className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 mb-6 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          >
            <p id="login-error-summary-title" className="font-bold mb-1">
              {invalidFields.length === 1 ? "يرجى تصحيح الحقل التالي:" : "يرجى تصحيح الحقلين التاليين:"}
            </p>
            <ul className="list-disc pr-5 space-y-0.5">
              {invalidFields.map((f) => (
                <li key={f}>
                  <a
                    href={`#login-${f}`}
                    onClick={(e) => {
                      e.preventDefault();
                      fieldRefs[f].current?.focus();
                    }}
                    className="underline font-medium"
                  >
                    {FIELD_LABELS[f]}: {fieldErrors[f]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleLogin} noValidate className="space-y-6">
          <div>
            <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-2">
              البريد الإلكتروني
            </label>
            <input
              ref={emailRef}
              id="login-email"
              type="email"
              inputMode="email"
              required
              aria-required="true"
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={fieldErrors.email ? "login-email-error" : undefined}
              dir="ltr"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearFieldError("email");
              }}
              className={`w-full px-4 py-3 rounded-xl border text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all ${fieldErrors.email ? "border-red-400 bg-red-50/40" : "border-slate-200"}`}
              placeholder="name@company.com"
            />
            {fieldErrors.email && (
              <p id="login-email-error" className="mt-2 text-sm font-medium text-red-700">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-2">
              كلمة المرور
            </label>
            <input
              ref={passwordRef}
              id="login-password"
              type="password"
              required
              aria-required="true"
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? "login-password-error" : undefined}
              dir="ltr"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearFieldError("password");
              }}
              className={`w-full px-4 py-3 rounded-xl border text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all ${fieldErrors.password ? "border-red-400 bg-red-50/40" : "border-slate-200"}`}
              placeholder="••••••••"
            />
            {fieldErrors.password && (
              <p id="login-password-error" className="mt-2 text-sm font-medium text-red-700">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end text-sm">
            <button
              type="button"
              onClick={() => toast.info("لإعادة تعيين كلمة المرور يرجى التواصل مع مدير النظام في منشأتك")}
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              نسيت كلمة المرور؟
            </button>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            aria-busy={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-xl transition-all shadow-md shadow-blue-200 flex justify-center items-center h-12 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="sr-only">جاري تسجيل الدخول</span>
              </>
            ) : (
              "تسجيل الدخول"
            )}
          </button>
        </form>
      </main>
    </div>
  );
}
