"use client";

// Replaces the root layout when it fails, so it must render its own <html>/<body> and must not
// depend on providers. Inline styles keep it readable even if the stylesheet failed to load.

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[global error]", error);
  }, [error]);

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          boxSizing: "border-box",
          background: "#0A0B10",
          color: "#1e293b",
          fontFamily: "Cairo, Tahoma, \"Segoe UI\", system-ui, sans-serif",
          colorScheme: "light",
        }}
      >
        <main
          role="alert"
          style={{
            width: "100%",
            maxWidth: 480,
            background: "#ffffff",
            borderRadius: "2rem",
            padding: "2.5rem 2rem",
            textAlign: "center",
            boxShadow: "0 20px 50px rgba(15, 23, 42, 0.35)",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 64,
              height: 64,
              margin: "0 auto 1.25rem",
              borderRadius: 18,
              background: "linear-gradient(135deg, #3b82f6, #4f46e5)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
              fontWeight: 900,
            }}
          >
            ر
          </div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 900, margin: 0, color: "#0f172a" }}>تعذر تشغيل النظام</h1>
          <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "#64748b", lineHeight: 1.8, margin: "0.75rem 0 0" }}>
            حدث خطأ غير متوقع أثناء تحميل رديف. يرجى إعادة المحاولة، وإذا استمرت المشكلة تواصل مع مدير النظام.
          </p>
          {error.digest && (
            <p style={{ fontSize: "0.7rem", fontWeight: 700, color: "#94a3b8", marginTop: "1rem" }}>
              رمز المرجع: <span dir="ltr" style={{ fontFamily: "monospace" }}>{error.digest}</span>
            </p>
          )}
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", marginTop: "2rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "0.75rem 1.5rem",
                fontSize: "0.85rem",
                fontWeight: 900,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              إعادة المحاولة
            </button>
            <button
              type="button"
              // A full page load is intentional: the application shell itself failed.
              onClick={() => window.location.assign("/")}
              style={{
                background: "#fff",
                color: "#334155",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "0.75rem 1.5rem",
                fontSize: "0.85rem",
                fontWeight: 900,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              الصفحة الرئيسية
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
