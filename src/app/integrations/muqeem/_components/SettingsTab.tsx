"use client";

import React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import type { MuqeemStatus } from './shared';

const ENV_VARS: { name: string; required: string; description: string }[] = [
  { name: 'MUQEEM_ENABLED', required: 'نعم', description: 'يجب أن تكون true لتفعيل الربط. أي قيمة أخرى تعني أن الربط معطّل ولا يُرسل شيء إلى مقيم.' },
  { name: 'MUQEEM_BASE_URL', required: 'نعم', description: 'عنوان خدمة مقيم الذي تزودكم به Elm (بيئة تجريبية ثم إنتاج).' },
  { name: 'MUQEEM_APP_ID', required: 'نعم', description: 'معرّف التطبيق في بوابة مطوري Elm.' },
  { name: 'MUQEEM_APP_KEY', required: 'نعم (سري)', description: 'مفتاح التطبيق. لا يُعرض في أي شاشة ولا يُسجَّل.' },
  { name: 'MUQEEM_INTEGRATOR_ID', required: 'لا', description: 'للمُكاملين فقط. المنشأة التي تستخدم مقيم مباشرة تتركه فارغاً.' },
  { name: 'MUQEEM_TIMEOUT_MS', required: 'لا', description: 'مهلة الطلب بالمللي ثانية (الافتراضي 20000).' },
];

export default function SettingsTab({ status }: { status: MuqeemStatus }) {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm space-y-3">
        <h3 className="text-[15px] font-black text-slate-800">إعدادات الخادم (متغيرات البيئة)</h3>
        <p className="text-[13px] font-bold leading-7 text-slate-500">
          تُضبط هذه القيم على الخادم من قِبل مدير النظام التقني، ولا يمكن تعديلها من هذه الشاشة. تعرض الشاشة فقط هل هي موجودة، ولا تعرض قيمها.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-[13px]">
            <thead className="bg-slate-50 text-[12px] font-black text-slate-500">
              <tr>
                <th className="px-4 py-3">المتغير</th>
                <th className="px-4 py-3">إلزامي</th>
                <th className="px-4 py-3">الوصف</th>
                <th className="px-4 py-3">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
              {ENV_VARS.map((v) => {
                const missing = status.missing.includes(v.name);
                const optional = v.required === 'لا';
                const state =
                  v.name === 'MUQEEM_ENABLED'
                    ? status.enabled
                      ? <span className="font-black text-emerald-600">مفعّل</span>
                      : <span className="font-black text-rose-600">معطّل</span>
                    : missing
                      ? <span className="font-black text-rose-600">ناقص</span>
                      : optional
                        ? <span className="text-slate-400">اختياري</span>
                        : <span className="font-black text-emerald-600">مضبوط</span>;
                return (
                  <tr key={v.name}>
                    <td className="px-4 py-3 font-mono text-[12px]" dir="ltr">{v.name}</td>
                    <td className="px-4 py-3">{v.required}</td>
                    <td className="px-4 py-3 text-[12px] text-slate-600">{v.description}</td>
                    <td className="px-4 py-3 text-[12px]">{state}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm space-y-3">
        <h3 className="text-[15px] font-black text-slate-800">ربط شركة بمقيم</h3>
        <ol className="list-decimal pr-5 space-y-2 text-[13px] font-bold leading-7 text-slate-600">
          <li>
            في شاشة{' '}
            <Link href="/gov-platforms" className="text-blue-700 hover:underline">
              المنصات الحكومية
            </Link>{' '}
            أضف حساب مستخدم مقيم الخاص بالمنشأة باسم يحتوي «مقيم» (تُحفظ كلمة المرور مشفرة).
          </li>
          <li>في صفحة تعديل الشركة، قسم «الربط مع مقيم»: أدخل رقم المنشأة في الجوازات (700) واختر حساب مقيم.</li>
          <li>ارجع إلى هذه الشاشة واستخدم «اختبار الاتصال» للتأكد من صحة بيانات الدخول.</li>
        </ol>
        <p className="text-[12px] font-bold text-slate-500">
          تغيير الحساب المرتبط متاح لمدير النظام وصاحب العمل فقط. الشركة التي تُستخدم لكل موظف هي شركته القانونية (الكفيل) في ملفه.
        </p>
        {status.canLink ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {status.companies
              .filter((c) => c.linked)
              .map((c) => (
                <Link
                  key={c.id}
                  href={`/companies/${c.id}/edit`}
                  className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-black text-emerald-700"
                >
                  {c.name} (مربوطة)
                </Link>
              ))}
            <Link href="/companies" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-black text-slate-600 hover:bg-slate-50">
              قائمة الشركات ({status.companies.filter((c) => !c.linked).length} غير مربوطة)
            </Link>
          </div>
        ) : (
          <p className="text-[12px] font-bold text-slate-500">ربط الشركات يتم من قِبل مدير النظام أو صاحب العمل.</p>
        )}
      </section>

      <section className="rounded-2xl border border-blue-100 bg-blue-50 p-5 space-y-2 text-[13px] font-bold leading-7 text-blue-900">
        <h3 className="flex items-center gap-2 text-[15px] font-black">
          <ShieldCheck size={18} /> قواعد الأمان
        </h3>
        <ul className="list-disc pr-5 space-y-1">
          <li>أي عملية تغيّر بيانات في مقيم (إصدار أو تمديد أو إلغاء تأشيرة، تجديد إقامة، خروج نهائي...) تُنفَّذ فقط بطلب صريح من المستخدم بعد رسالة تأكيد، وقد تترتب عليها رسوم حكومية.</li>
          <li>كل عملية تُسجَّل مرة واحدة فقط: تكرار الضغط أو إعادة المحاولة لا يرسل الطلب مرتين.</li>
          <li>إذا انقطع الاتصال بعد الإرسال تُسجَّل النتيجة «غير معروفة» ولا يُعاد الطلب تلقائياً؛ يجب التحقق من تقرير الخدمات التفاعلية ثم التسوية من تبويب «سجل المعاملات».</li>
          <li>الموظف العادي لا يستطيع تنفيذ أي عملية على مقيم.</li>
        </ul>
      </section>
    </div>
  );
}
