'use client';

import React, { useState } from 'react';
import { LogOut } from 'lucide-react';
import DocumentsCard from '@/app/portal/_components/DocumentsCard';

/**
 * "مستنداتي" for a leaver's documents-only session (owner decision 2026-09-26): after the end of
 * service the account opens only this page for `terminated_documents_access_days` (default 30) to
 * download the exit documents and accept or dispute the settlement release. Every other page and
 * API treats the session as logged out (src/lib/auth.ts getSessionUser). An active employee who
 * opens it simply sees his own documents.
 */
export default function MyDocumentsPage() {
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <main dir="rtl" className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" width={32} height={32} className="rounded-lg" />
            <span className="font-black text-slate-800">رديف</span>
          </div>
          <button type="button" onClick={() => void logout()} disabled={leaving}
            className="inline-flex items-center gap-1 text-[13px] font-bold text-slate-600 hover:text-red-600 disabled:opacity-50">
            <LogOut size={16} aria-hidden="true" /> تسجيل الخروج
          </button>
        </div>
      </header>
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <p className="text-[13px] text-slate-600 bg-white border border-slate-200 rounded-2xl p-4">
          يمكنك من هنا تنزيل مستنداتك الرسمية، والموافقة على بيان التسوية والمخالصة أو الاعتراض عليه.
          بعد انتهاء خدمتك يبقى هذا الدخول متاحاً لمدة محدودة فقط، فاحفظ نسخة من مستنداتك.
        </p>
        <DocumentsCard />
      </div>
    </main>
  );
}
