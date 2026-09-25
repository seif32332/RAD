"use client";

import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import {
  Landmark, Plus, Search, Edit3, Trash2, Eye, EyeOff, X, Save,
  Phone, User, KeyRound, Globe, StickyNote, Copy, Check, RefreshCw, Loader2
} from 'lucide-react';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';

// قائمة المنصات الحكومية المعروفة
const KNOWN_PLATFORMS = [
  'أبشر أعمال', 'مقيم', 'قوى', 'مدد', 'التأمينات الاجتماعية', 'هيئة الزكاة والضريبة والجمارك',
  'مساند', 'نطاقات', 'المنصة الوطنية الموحدة', 'بلدي', 'سلامة', 'الدفاع المدني',
  'وزارة التجارة', 'منصة إيجار', 'نقل', 'تم', 'طاقات', 'مُدد أجور', 'ناجز',
  'صحة', 'وقاية', 'منصة اعتماد', 'بوابة حكومي', 'أخرى'
];
const OTHER_PLATFORM = 'أخرى';

interface GovPlatform {
  id: string;
  platformName: string;
  username: string;
  /** Always masked by the API; the real value is fetched on demand (audited). */
  password?: string;
  hasPassword?: boolean;
  phoneNumber?: string | null;
  authorizedPerson?: string | null;
  notes?: string | null;
  createdAt: string;
}

const EMPTY_FORM = {
  platformName: '',
  customPlatformName: '',
  username: '',
  password: '',
  phoneNumber: '',
  authorizedPerson: '',
  notes: '',
};

export default function GovPlatformsPage() {
  const [platforms, setPlatforms] = useState<GovPlatform[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Passwords revealed in this session (id -> password). Cleared when hidden. */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const [formData, setFormData] = useState(EMPTY_FORM);

  const fetchPlatforms = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/gov-platforms');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل المنصات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setPlatforms(Array.isArray(data) ? (data as GovPlatform[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlatforms(); }, [fetchPlatforms]);

  /** Fetches the real password (GET ?reveal=<id>, audited on the server). */
  const fetchPassword = async (id: string): Promise<string | null> => {
    if (revealed[id] !== undefined) return revealed[id];
    setRevealingId(id);
    try {
      const res = await fetch(`/api/gov-platforms?reveal=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/login'; return null; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر عرض كلمة المرور')); return null; }
      const data = await res.json();
      const password = typeof data?.password === 'string' ? data.password : '';
      setRevealed(prev => ({ ...prev, [id]: password }));
      return password;
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return null;
    } finally {
      setRevealingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const platformName = formData.platformName === OTHER_PLATFORM ? formData.customPlatformName.trim() : formData.platformName;
    if (!platformName) { toast.error('يرجى إدخال اسم المنصة'); return; }
    if (!editingId && !formData.password) { toast.error('كلمة المرور مطلوبة'); return; }

    setIsSubmitting(true);
    try {
      const method = editingId ? 'PUT' : 'POST';
      const body = {
        platformName,
        username: formData.username,
        // On edit an empty password keeps the stored one.
        password: formData.password,
        phoneNumber: formData.phoneNumber,
        authorizedPerson: formData.authorizedPerson,
        notes: formData.notes,
      };
      const payload = editingId ? { id: editingId, ...body } : body;

      const res = await fetch('/api/gov-platforms', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حفظ المنصة')); return; }
      const data = await res.json().catch(() => ({}));

      toast.success(data?.message || 'تم الحفظ بنجاح');
      if (editingId) setRevealed(prev => { const next = { ...prev }; delete next[editingId]; return next; });
      resetModal();
      fetchPlatforms();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirmDialog(`هل أنت متأكد من حذف منصة "${name}"؟ هذا الإجراء لا يمكن التراجع عنه.`, { danger: true }))) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/gov-platforms?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حذف المنصة')); return; }
      const data = await res.json().catch(() => ({}));
      toast.success(data?.message || 'تم حذف المنصة');
      fetchPlatforms();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setDeletingId(null);
    }
  };

  const openEdit = (item: GovPlatform) => {
    const known = KNOWN_PLATFORMS.includes(item.platformName) && item.platformName !== OTHER_PLATFORM;
    setEditingId(item.id);
    setFormData({
      platformName: known ? item.platformName : OTHER_PLATFORM,
      customPlatformName: known ? '' : item.platformName,
      username: item.username,
      // The stored password is never sent to the list; leave empty to keep it.
      password: '',
      phoneNumber: item.phoneNumber || '',
      authorizedPerson: item.authorizedPerson || '',
      notes: item.notes || '',
    });
    setIsModalOpen(true);
  };

  const resetModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setFormData(EMPTY_FORM);
  };

  const togglePassword = async (id: string) => {
    if (revealed[id] !== undefined) {
      setRevealed(prev => { const next = { ...prev }; delete next[id]; return next; });
      return;
    }
    await fetchPassword(id);
  };

  const copyToClipboard = async (text: string, fieldId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      toast.error('تعذر النسخ إلى الحافظة');
    }
  };

  const copyPassword = async (id: string) => {
    const password = await fetchPassword(id);
    if (password === null) return;
    // Do not keep it visible just because it was copied.
    setRevealed(prev => { const next = { ...prev }; delete next[id]; return next; });
    await copyToClipboard(password, `pass-${id}`);
  };

  const filtered = platforms.filter(p =>
    p.platformName.includes(searchTerm) ||
    p.username.includes(searchTerm) ||
    (p.authorizedPerson || '').includes(searchTerm) ||
    (p.phoneNumber || '').includes(searchTerm)
  );

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-blue-200">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-blue-100 text-blue-700 p-3 rounded-2xl"><Landmark size={26} /></span>
              إدارة المنصات الحكومية
            </h1>
            <p className="text-slate-500 font-bold mt-3 text-[14px] leading-relaxed max-w-2xl">
              توثيق بيانات الدخول لجميع المنصات الحكومية المستخدمة (أبشر، مقيم، قوى، التأمينات...) مع أسماء المفوضين وأرقام الجوالات المرتبطة.
            </p>
          </div>
          <button type="button" onClick={() => { resetModal(); setIsModalOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3.5 rounded-2xl font-black text-[14px] transition shadow-lg shadow-blue-200 shrink-0 hover:-translate-y-0.5">
            <Plus size={18} /> إضافة منصة جديدة
          </button>
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            aria-label="بحث في المنصات"
            placeholder="ابحث باسم المنصة، المستخدم، المفوض..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pr-12 pl-4 py-3.5 bg-white border-2 border-slate-100 rounded-2xl font-bold text-[14px] text-slate-700 focus:border-blue-400 focus:outline-none transition shadow-sm"
          />
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1">إجمالي المنصات</p>
            <p className="text-2xl font-black text-slate-800">{platforms.length}</p>
          </div>
          <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1">منصات مع مفوض</p>
            <p className="text-2xl font-black text-blue-600">{platforms.filter(p => p.authorizedPerson).length}</p>
          </div>
          <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1">منصات مع جوال</p>
            <p className="text-2xl font-black text-emerald-600">{platforms.filter(p => p.phoneNumber).length}</p>
          </div>
          <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1">نتائج البحث</p>
            <p className="text-2xl font-black text-amber-600">{filtered.length}</p>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : loadError ? (
          <div className="text-center py-16 bg-white rounded-[2rem] border border-rose-200 shadow-sm">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchPlatforms} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : platforms.length > 0 && filtered.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-[2rem] border border-slate-200 shadow-sm">
            <Search size={40} className="mx-auto text-slate-200 mb-4" />
            <h3 className="text-lg font-black text-slate-700 mb-4">لا توجد نتائج مطابقة للبحث</h3>
            <button type="button" onClick={() => setSearchTerm('')} className="bg-blue-50 hover:bg-blue-100 text-blue-700 px-6 py-2.5 rounded-xl font-bold transition text-[13px]">مسح البحث</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-[2rem] border border-slate-200 shadow-sm">
            <Landmark size={48} className="mx-auto text-slate-200 mb-4" />
            <h3 className="text-lg font-black text-slate-700 mb-2">لا توجد منصات مسجلة</h3>
            <p className="text-[13px] font-bold text-slate-400 mb-6">ابدأ بإضافة المنصات الحكومية التي تستخدمها مؤسستك.</p>
            <button type="button" onClick={() => { resetModal(); setIsModalOpen(true); }}
              className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-bold transition text-[14px]">
              <Plus size={16} className="inline ml-2" /> إضافة أول منصة
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {filtered.map(item => (
              <div key={item.id} className="bg-white rounded-[2rem] border border-slate-200 shadow-[0_4px_24px_rgba(0,0,0,0.03)] hover:shadow-xl hover:-translate-y-1 transition-all duration-300 overflow-hidden group">
                {/* Card Header */}
                <div className="bg-gradient-to-l from-blue-50 to-indigo-50 p-5 border-b border-blue-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200">
                        <Landmark size={20} />
                      </div>
                      <div>
                        <h3 className="font-black text-[15px] text-slate-800">{item.platformName}</h3>
                        <p className="text-[11px] font-bold text-slate-400 mt-0.5">
                          تمت الإضافة: {formatDate(item.createdAt)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label="تعديل المنصة" title="تعديل" onClick={() => openEdit(item)}
                        className="w-9 h-9 bg-white border border-slate-200 rounded-xl flex items-center justify-center text-slate-400 hover:text-blue-600 hover:border-blue-200 transition shadow-sm">
                        <Edit3 size={14} />
                      </button>
                      <button type="button" aria-label="حذف المنصة" title="حذف" disabled={deletingId === item.id} onClick={() => handleDelete(item.id, item.platformName)}
                        className="w-9 h-9 bg-white border border-slate-200 rounded-xl flex items-center justify-center text-slate-400 hover:text-red-600 hover:border-red-200 transition shadow-sm disabled:opacity-50">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Card Body */}
                <div className="p-5 space-y-3">
                  {/* Username */}
                  <div className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                    <div className="flex items-center gap-2">
                      <User size={14} className="text-slate-400" />
                      <span className="text-[11px] font-black text-slate-400">اسم المستخدم</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[13px] text-slate-700 font-mono" dir="ltr">{item.username}</span>
                      <button type="button" aria-label="نسخ اسم المستخدم" onClick={() => copyToClipboard(item.username, `user-${item.id}`)}
                        className="text-slate-300 hover:text-blue-500 transition">
                        {copiedField === `user-${item.id}` ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* Password */}
                  <div className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                    <div className="flex items-center gap-2">
                      <KeyRound size={14} className="text-slate-400" />
                      <span className="text-[11px] font-black text-slate-400">كلمة المرور</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[13px] text-slate-700 font-mono" dir="ltr">
                        {revealed[item.id] !== undefined ? revealed[item.id] : '••••••••'}
                      </span>
                      <button type="button" aria-label={revealed[item.id] !== undefined ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} disabled={revealingId === item.id} onClick={() => togglePassword(item.id)}
                        className="text-slate-300 hover:text-amber-500 transition disabled:opacity-50">
                        {revealingId === item.id ? <Loader2 size={13} className="animate-spin" /> : revealed[item.id] !== undefined ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button type="button" aria-label="نسخ كلمة المرور" disabled={revealingId === item.id} onClick={() => copyPassword(item.id)}
                        className="text-slate-300 hover:text-blue-500 transition disabled:opacity-50">
                        {copiedField === `pass-${item.id}` ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* Phone */}
                  {item.phoneNumber && (
                    <div className="flex items-center justify-between bg-emerald-50/50 rounded-xl px-4 py-3 border border-emerald-100">
                      <div className="flex items-center gap-2">
                        <Phone size={14} className="text-emerald-500" />
                        <span className="text-[11px] font-black text-emerald-600">الجوال المرتبط</span>
                      </div>
                      <span className="font-bold text-[13px] text-emerald-700 font-mono" dir="ltr">{item.phoneNumber}</span>
                    </div>
                  )}

                  {/* Authorized Person */}
                  {item.authorizedPerson && (
                    <div className="flex items-center justify-between bg-blue-50/50 rounded-xl px-4 py-3 border border-blue-100">
                      <div className="flex items-center gap-2">
                        <User size={14} className="text-blue-500" />
                        <span className="text-[11px] font-black text-blue-600">المفوض</span>
                      </div>
                      <span className="font-bold text-[13px] text-blue-700">{item.authorizedPerson}</span>
                    </div>
                  )}

                  {/* Notes */}
                  {item.notes && (
                    <div className="bg-amber-50/50 rounded-xl px-4 py-3 border border-amber-100">
                      <div className="flex items-center gap-2 mb-1">
                        <StickyNote size={12} className="text-amber-500" />
                        <span className="text-[10px] font-black text-amber-600">ملاحظات</span>
                      </div>
                      <p className="text-[12px] font-bold text-amber-700 leading-relaxed">{item.notes}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>

      {/* Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-blue-600 p-6 flex justify-between items-center text-white">
              <div>
                <h3 className="text-xl font-black flex items-center gap-2">
                  <Landmark size={24} /> {editingId ? 'تعديل بيانات المنصة' : 'إضافة منصة حكومية جديدة'}
                </h3>
                <p className="text-blue-200 text-xs font-bold mt-1">يرجى إدخال بيانات الدخول بدقة</p>
              </div>
              <button type="button" aria-label="إغلاق" onClick={resetModal} className="hover:bg-blue-500 p-2 rounded-full transition"><X size={20} /></button>
            </div>

            <form onSubmit={handleSubmit} className="p-8 space-y-5">
              {/* Platform Name */}
              <div>
                <label htmlFor="gov-platform-name" className="text-[13px] font-extrabold text-slate-700 mb-2 flex items-center gap-2">
                  <Globe size={14} className="text-blue-500" /> اسم المنصة <span className="text-red-500">*</span>
                </label>
                <select id="gov-platform-name" value={formData.platformName} onChange={e => setFormData({ ...formData, platformName: e.target.value })} required
                  className="w-full px-5 py-3.5 bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl font-bold text-slate-800 transition-all focus:outline-none text-[14px]">
                  <option value="">اختر المنصة...</option>
                  {KNOWN_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {formData.platformName === OTHER_PLATFORM && (
                  <input type="text" required aria-label="اسم المنصة" placeholder="اكتب اسم المنصة..."
                    value={formData.customPlatformName}
                    onChange={e => setFormData({ ...formData, customPlatformName: e.target.value })}
                    className="w-full mt-3 px-5 py-3 bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl font-bold text-[13px] focus:outline-none transition" />
                )}
              </div>

              {/* Username */}
              <div>
                <label htmlFor="gov-username" className="text-[13px] font-extrabold text-slate-700 mb-2 flex items-center gap-2">
                  <User size={14} className="text-slate-500" /> اسم المستخدم <span className="text-red-500">*</span>
                </label>
                <input id="gov-username" type="text" required autoComplete="off" value={formData.username}
                  onChange={e => setFormData({ ...formData, username: e.target.value })}
                  placeholder="اسم المستخدم أو البريد الإلكتروني"
                  className="w-full px-5 py-3.5 bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl font-bold text-slate-800 transition-all focus:outline-none text-[14px]" />
              </div>

              {/* Password */}
              <div>
                <label htmlFor="gov-password" className="text-[13px] font-extrabold text-slate-700 mb-2 flex items-center gap-2">
                  <KeyRound size={14} className="text-amber-500" /> كلمة المرور {!editingId && <span className="text-red-500">*</span>}
                </label>
                <input id="gov-password" type="text" required={!editingId} autoComplete="off" value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                  placeholder={editingId ? 'اتركها فارغة للإبقاء على كلمة المرور الحالية' : 'كلمة المرور'}
                  className="w-full px-5 py-3.5 bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl font-bold text-slate-800 transition-all focus:outline-none text-[14px] font-mono" dir="ltr" />
              </div>

              {/* Phone */}
              <div>
                <label htmlFor="gov-phone" className="text-[13px] font-extrabold text-slate-700 mb-2 flex items-center gap-2">
                  <Phone size={14} className="text-emerald-500" /> رقم الجوال المرتبط
                </label>
                <input id="gov-phone" type="text" value={formData.phoneNumber}
                  onChange={e => setFormData({ ...formData, phoneNumber: e.target.value })}
                  placeholder="05xxxxxxxx"
                  className="w-full px-5 py-3.5 bg-slate-50 border-2 border-slate-100 focus:border-emerald-400 focus:bg-white rounded-2xl font-bold text-slate-800 transition-all focus:outline-none text-[14px] font-mono" dir="ltr" />
              </div>

              {/* Authorized Person */}
              <div>
                <label htmlFor="gov-authorized" className="text-[13px] font-extrabold text-slate-700 mb-2 flex items-center gap-2">
                  <User size={14} className="text-blue-500" /> اسم الشخص المفوض
                </label>
                <input id="gov-authorized" type="text" value={formData.authorizedPerson}
                  onChange={e => setFormData({ ...formData, authorizedPerson: e.target.value })}
                  placeholder="اسم الشخص المسؤول عن هذه المنصة"
                  className="w-full px-5 py-3.5 bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl font-bold text-slate-800 transition-all focus:outline-none text-[14px]" />
              </div>

              {/* Notes */}
              <div>
                <label htmlFor="gov-notes" className="text-[13px] font-extrabold text-slate-700 mb-2 flex items-center gap-2">
                  <StickyNote size={14} className="text-amber-500" /> ملاحظات إضافية
                </label>
                <textarea id="gov-notes" rows={3} value={formData.notes}
                  onChange={e => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="أي ملاحظات مرتبطة بهذه المنصة..."
                  className="w-full px-5 py-3.5 bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl font-bold text-slate-800 transition-all focus:outline-none text-[13px] resize-none" />
              </div>

              {/* Action Buttons */}
              <div className="flex gap-4 pt-4">
                <button type="submit" disabled={isSubmitting}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-black transition disabled:opacity-50 text-[14px] flex items-center justify-center gap-2">
                  <Save size={18} /> {isSubmitting ? 'جاري الحفظ...' : (editingId ? 'تحديث البيانات' : 'حفظ المنصة')}
                </button>
                <button type="button" onClick={resetModal}
                  className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 py-4 rounded-2xl font-bold transition text-[14px]">
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
