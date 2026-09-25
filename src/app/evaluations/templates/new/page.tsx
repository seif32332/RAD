"use client";

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ChevronRight, GripVertical, Save, FileText, X } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { weightsAreValid } from '@/app/api/evaluations/scoring';

interface TemplateItem {
  key: number;
  title: string;
  description: string;
  isRequired: boolean;
}

interface TemplateSection {
  key: number;
  title: string;
  weight: string;
  items: TemplateItem[];
}

export default function CreateTemplatePage() {
  const router = useRouter();
  const keySeq = useRef(2);
  const nextKey = () => ++keySeq.current;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetType, setTargetType] = useState('GENERAL');
  const [evalType, setEvalType] = useState('QUARTERLY');
  const [sections, setSections] = useState<TemplateSection[]>([
    { key: 1, title: '', weight: '', items: [{ key: 2, title: '', description: '', isRequired: true }] },
  ]);
  const [isSaving, setIsSaving] = useState(false);

  const newItem = (): TemplateItem => ({ key: nextKey(), title: '', description: '', isRequired: true });

  const addSection = () => {
    setSections((prev) => [...prev, { key: nextKey(), title: '', weight: '', items: [newItem()] }]);
  };

  const removeSection = async (key: number) => {
    const sec = sections.find((s) => s.key === key);
    const hasContent = !!sec && (sec.title.trim() !== '' || sec.items.some((i) => i.title.trim() !== ''));
    if (hasContent && !(await confirmDialog('هل تريد حذف هذا المحور وجميع عناصره؟', { danger: true }))) return;
    setSections((prev) => prev.filter((s) => s.key !== key));
  };

  const updateSection = (key: number, patch: Partial<Pick<TemplateSection, 'title' | 'weight'>>) => {
    setSections((prev) => prev.map((sec) => (sec.key === key ? { ...sec, ...patch } : sec)));
  };

  const addItem = (sectionKey: number) => {
    setSections((prev) => prev.map((sec) => (sec.key === sectionKey ? { ...sec, items: [...sec.items, newItem()] } : sec)));
  };

  const removeItem = (sectionKey: number, itemKey: number) => {
    setSections((prev) => prev.map((sec) => (sec.key === sectionKey ? { ...sec, items: sec.items.filter((i) => i.key !== itemKey) } : sec)));
  };

  const updateItem = (sectionKey: number, itemKey: number, patch: Partial<Omit<TemplateItem, 'key'>>) => {
    setSections((prev) => prev.map((sec) => (
      sec.key === sectionKey ? { ...sec, items: sec.items.map((item) => (item.key === itemKey ? { ...item, ...patch } : item)) } : sec
    )));
  };

  const weights = sections.map((sec) => parseFloat(sec.weight) || 0);
  const totalWeight = Math.round(weights.reduce((s, w) => s + w, 0) * 100) / 100;
  const weightsOk = sections.length > 0 && weightsAreValid(weights);

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSaving) return;
    if (!name.trim()) return toast.warning('يرجى إدخال اسم النموذج');
    if (sections.length === 0) return toast.warning('يجب إضافة محور واحد على الأقل');
    if (sections.some((s) => !s.title.trim() || !s.weight)) return toast.warning('يرجى تعبئة اسم ووزن كل محور');
    if (!weightsOk) return toast.warning(`مجموع الأوزان يجب أن يساوي 100%، المجموع الحالي: ${totalWeight}%`);
    if (sections.some((s) => s.items.length === 0 || s.items.some((i) => !i.title.trim()))) return toast.warning('يرجى تعبئة عنوان كل عنصر');

    setIsSaving(true);
    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'CREATE_TEMPLATE',
          name,
          description,
          targetType,
          evalType,
          sections: sections.map((s) => ({
            title: s.title,
            weight: s.weight,
            items: s.items.map((i) => ({ title: i.title, description: i.description, isRequired: i.isRequired })),
          })),
        }),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ في الحفظ'));
        return;
      }
      toast.success('تم إنشاء النموذج بنجاح!');
      router.push('/evaluations');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DashboardLayout>
      <form onSubmit={handleSave} className="max-w-5xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-8">

        {/* Breadcrumb */}
        <nav aria-label="مسار التنقل" className="flex items-center gap-2 text-[13px] font-bold text-slate-400">
          <Link href="/evaluations" className="hover:text-violet-600 transition">إدارة التقييم</Link>
          <ChevronRight size={14} />
          <span className="text-slate-700">إنشاء نموذج تقييم مخصص</span>
        </nav>

        {/* Header */}
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <span className="bg-violet-100 text-violet-600 p-2.5 rounded-2xl"><FileText size={22} /></span>
            إنشاء نموذج تقييم مخصص
          </h1>
          <p className="text-slate-500 font-bold mt-2 text-[13px]">صمم نموذج التقييم الخاص بالوظيفة أو القسم المستهدف.</p>
        </div>

        {/* Basic Info */}
        <div className="bg-white rounded-[1.5rem] p-6 border border-slate-100 shadow-sm space-y-5">
          <h3 className="font-black text-slate-800 text-[15px]">البيانات الأساسية</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="tpl-name" className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم النموذج <span className="text-red-500">*</span></label>
              <input id="tpl-name" type="text" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="مثال: نموذج تقييم عمال الفروع"
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition" />
            </div>
            <div>
              <label htmlFor="tpl-desc" className="text-[12px] font-extrabold text-slate-700 mb-2 block">وصف النموذج</label>
              <input id="tpl-desc" type="text" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="وصف مختصر..."
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition" />
            </div>
            <div>
              <label htmlFor="tpl-target" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نوع الوظائف المستهدفة</label>
              <select id="tpl-target" value={targetType} onChange={(e) => setTargetType(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition appearance-none">
                <option value="GENERAL">عام (جميع الوظائف)</option>
                <option value="OPERATIONAL">تشغيلي (عمال الفروع)</option>
                <option value="LEADERSHIP">قيادي (مدراء ومشرفين)</option>
                <option value="CUSTOM">مخصص</option>
              </select>
            </div>
            <div>
              <label htmlFor="tpl-eval" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نوع التقييم</label>
              <select id="tpl-eval" value={evalType} onChange={(e) => setEvalType(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition appearance-none">
                <option value="MONTHLY">شهري</option>
                <option value="QUARTERLY">ربع سنوي</option>
                <option value="ANNUAL">سنوي</option>
                <option value="PROBATION">فترة تجربة</option>
              </select>
            </div>
          </div>
        </div>

        {/* Sections */}
        {sections.map((section, si) => (
          <div key={section.key} className="bg-white rounded-[1.5rem] p-6 border-2 border-slate-100 shadow-sm hover:border-violet-100 transition">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-black text-slate-800 text-[15px] flex items-center gap-2">
                <GripVertical size={16} className="text-slate-300" /> المحور {si + 1}
              </h3>
              <button type="button" aria-label={`حذف المحور ${si + 1}`} onClick={() => void removeSection(section.key)} className="text-red-400 hover:text-red-600 p-1 rounded-lg hover:bg-red-50 transition"><Trash2 size={16} /></button>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-5">
              <div className="col-span-2">
                <input type="text" aria-label={`اسم المحور ${si + 1}`} maxLength={200} value={section.title} onChange={(e) => updateSection(section.key, { title: e.target.value })}
                  placeholder="اسم المحور (مثال: الأداء الوظيفي)"
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition" />
              </div>
              <div>
                <input type="number" aria-label={`وزن المحور ${si + 1}`} min={1} max={100} step="0.01" value={section.weight} onChange={(e) => updateSection(section.key, { weight: e.target.value })}
                  placeholder="الوزن %"
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[13px] focus:outline-none transition" />
              </div>
            </div>

            {/* Items */}
            <div className="space-y-3 mr-4">
              {section.items.map((item, ii) => (
                <div key={item.key} className="flex items-center gap-3 bg-slate-50 rounded-xl p-3 border border-slate-100">
                  <span className="text-[11px] font-black text-slate-400 min-w-[20px]">{ii + 1}.</span>
                  <input type="text" aria-label={`اسم العنصر ${ii + 1}`} maxLength={300} value={item.title} onChange={(e) => updateItem(section.key, item.key, { title: e.target.value })}
                    placeholder="اسم العنصر"
                    className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg font-bold text-[12px] focus:outline-none focus:border-violet-400 transition" />
                  <input type="text" aria-label={`وصف العنصر ${ii + 1}`} maxLength={1000} value={item.description} onChange={(e) => updateItem(section.key, item.key, { description: e.target.value })}
                    placeholder="وصف (اختياري)"
                    className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg font-bold text-[12px] focus:outline-none focus:border-violet-400 transition hidden md:block" />
                  <label className="flex items-center gap-1 text-[11px] font-bold text-slate-500 shrink-0">
                    <input type="checkbox" checked={item.isRequired} onChange={(e) => updateItem(section.key, item.key, { isRequired: e.target.checked })} className="accent-violet-500" />
                    إلزامي
                  </label>
                  <button type="button" aria-label={`حذف العنصر ${ii + 1}`} onClick={() => removeItem(section.key, item.key)} className="text-red-300 hover:text-red-500 transition"><X size={14} /></button>
                </div>
              ))}
              <button type="button" onClick={() => addItem(section.key)} className="text-violet-500 hover:text-violet-700 font-bold text-[12px] flex items-center gap-1 mr-6 transition">
                <Plus size={14} /> إضافة عنصر جديد
              </button>
            </div>
          </div>
        ))}

        {/* Weight Summary + Add */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <button type="button" onClick={addSection} className="bg-violet-50 text-violet-600 hover:bg-violet-100 px-5 py-3 rounded-xl font-black text-[13px] flex items-center gap-2 transition border border-violet-200">
            <Plus size={16} /> إضافة محور جديد
          </button>
          <div className={`font-black text-[14px] px-5 py-3 rounded-xl border-2 ${weightsOk ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
            مجموع الأوزان: {totalWeight}% {weightsOk ? '✅' : '❌ (يجب أن يساوي 100%)'}
          </div>
        </div>

        {/* Save */}
        <button type="submit" disabled={isSaving}
          className="w-full bg-violet-600 hover:bg-violet-700 text-white py-4 rounded-xl font-black text-[15px] flex items-center justify-center gap-2 transition shadow-lg shadow-violet-200 disabled:opacity-50">
          <Save size={20} /> {isSaving ? 'جاري الحفظ...' : 'حفظ النموذج'}
        </button>
      </form>
    </DashboardLayout>
  );
}
