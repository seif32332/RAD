"use client";

// Card for signed-in accounts without an employee file (admins, finance, new hires not linked
// yet): the self-service portal needs one. Instead of a dead-end "back to home" button it offers
// a concrete next step: a ready-made message to send to HR (copy it into any channel), and for
// admins a direct link to the user settings where the account can be linked.

import React, { useState } from 'react';
import Link from 'next/link';
import { Copy, MessageSquareText, UserX, Settings } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { toast } from '@/components/ui/feedback';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { UNLINKED_ACCOUNT_MESSAGE, hrLinkRequestMessage } from '../_lib';

export default function UnlinkedAccountCard() {
  const { user, role } = useRole();
  const [open, setOpen] = useState(false);
  const message = hrLinkRequestMessage({ name: user?.name, email: user?.email });
  const canLinkAccounts = roleIn(role, ROLE_GROUPS.ADMIN);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.success('تم نسخ الرسالة. أرسلها للموارد البشرية عبر البريد أو المحادثة.');
    } catch {
      toast.error('تعذر النسخ تلقائياً. حدّد النص وانسخه يدوياً.');
    }
  };

  return (
    <div role="status" className="max-w-xl mx-auto bg-white border border-slate-200 rounded-[2rem] shadow-sm p-6 md:p-10 text-center">
      <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-amber-50 border border-amber-100 text-amber-500 flex items-center justify-center" aria-hidden="true">
        <UserX size={30} />
      </div>
      <h1 className="text-xl font-black text-slate-800 mb-2">{UNLINKED_ACCOUNT_MESSAGE}</h1>
      <p className="text-[13px] font-bold text-slate-500 leading-relaxed">
        بوابة الموظف تعرض بياناتك الوظيفية وطلباتك الشخصية، ولذلك تحتاج إلى ربط حسابك بملفك الوظيفي من قِبل الموارد البشرية.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-3 rounded-xl font-black text-[14px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
        >
          <MessageSquareText size={18} aria-hidden="true" /> تواصل مع الموارد البشرية
        </button>
        {canLinkAccounts && (
          <Link
            href="/settings/users"
            className="inline-flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-5 py-3 rounded-xl font-black text-[14px] transition"
          >
            <Settings size={18} aria-hidden="true" /> ربط الحسابات من إعدادات المستخدمين
          </Link>
        )}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        tone="emerald"
        size="md"
        icon={<MessageSquareText size={22} />}
        title="تواصل مع الموارد البشرية"
        description="أرسل هذه الرسالة لقسم الموارد البشرية في منشأتك ليتم ربط حسابك بملفك الوظيفي"
      >
        <div className="p-6 space-y-4 text-right">
          <ol className="list-decimal pr-5 space-y-1 text-[13px] font-bold text-slate-600">
            <li>انسخ الرسالة أدناه وأضف رقمك الوظيفي إن كنت تعرفه.</li>
            <li>أرسلها لمسؤول الموارد البشرية عبر البريد أو المحادثة المعتمدة في منشأتك.</li>
            <li>بعد ربط الحساب، سجّل الخروج ثم الدخول مجدداً لتظهر بوابتك.</li>
          </ol>
          <label htmlFor="hr-link-message" className="block text-[13px] font-extrabold text-slate-700">نص الرسالة</label>
          <textarea
            id="hr-link-message"
            readOnly
            rows={7}
            value={message}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full bg-slate-50 border-2 border-slate-100 rounded-2xl px-4 py-3 font-bold text-slate-800 text-[14px] leading-7 resize-none focus:outline-none focus:border-emerald-400"
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void copy()}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-2xl font-black text-[14px] transition"
            >
              <Copy size={16} aria-hidden="true" /> نسخ الرسالة
            </button>
            <button type="button" onClick={() => setOpen(false)} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-3 rounded-2xl font-bold transition">
              إغلاق
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
