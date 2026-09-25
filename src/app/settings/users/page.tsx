"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Shield, UserPlus, Lock, Users, CheckCircle, Mail, Key, Edit, RefreshCw, Power } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Link from 'next/link';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { ALL_ROLES, ROLE_LABELS, type AppRole } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';

interface EmployeeOption {
  id: string;
  employeeId: string;
  firstNameArabic?: string;
  lastNameArabic?: string;
  userId?: string | null;
}

interface AppUser {
  id: string;
  email: string;
  role: string;
  name?: string | null;
  isActive?: boolean;
  createdAt: string;
  employeeProfile?: { id: string; firstNameArabic?: string; lastNameArabic?: string; employeeId?: string } | null;
}

const EMPTY_FORM = { employeeId: '', email: '', name: '', password: '', role: 'LEGAL_ADMIN' as AppRole, isActive: true };

/** Mirrors the server password policy (min 8 chars, at least one letter and one digit). */
function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'كلمة المرور يجب ألا تقل عن 8 أحرف';
  if (!/[A-Za-z]/.test(pw)) return 'كلمة المرور يجب أن تحتوي على حرف إنجليزي واحد على الأقل';
  if (!/\d/.test(pw)) return 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل';
  return null;
}

const roleLabel = (role: string) => (ROLE_LABELS as Record<string, string>)[role] || role;

export default function UsersPermissionsPage() {
  const { user: currentUser } = useRole();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Only a SUPER_ADMIN may grant SUPER_ADMIN (the server enforces it too).
  const assignableRoles = ALL_ROLES.filter(r => r !== 'SUPER_ADMIN' || currentUser?.role === 'SUPER_ADMIN' || form.role === 'SUPER_ADMIN');

  const fetchUsers = useCallback(async () => {
    const res = await fetch('/api/settings/users');
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل المستخدمين'));
    const data: unknown = await res.json();
    setUsers(Array.isArray(data) ? (data as AppUser[]) : []);
  }, []);

  const fetchEmployees = useCallback(async () => {
    try {
      const res = await fetch('/api/employees?fields=basic');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحميل قائمة الموظفين')); return; }
      const data: unknown = await res.json();
      // فقط الموظفين الذين ليس لديهم userId بعد يمكن إضافتهم كأعضاء
      setEmployees(Array.isArray(data) ? (data as EmployeeOption[]).filter(e => !e.userId) : []);
    } catch {
      toast.error('تعذر تحميل قائمة الموظفين');
    }
  }, []);

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      await Promise.all([fetchUsers(), fetchEmployees()]);
    } catch (err) {
      const text = err instanceof Error ? err.message : 'تعذر الاتصال بالخادم';
      setLoadError(text);
      toast.error(text);
    } finally {
      setIsLoading(false);
    }
  }, [fetchUsers, fetchEmployees]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const refreshLists = async () => {
    try {
      await Promise.all([fetchUsers(), fetchEmployees()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر تحديث القائمة');
    }
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setShowForm(false);
    setEditingUserId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setMsg({ type: '', text: '' });

    // Password is required on create; optional on edit (empty = unchanged).
    if (!editingUserId || form.password) {
      const problem = passwordProblem(form.password);
      if (problem) { setMsg({ type: 'error', text: problem }); return; }
    }

    setIsSubmitting(true);
    try {
      const url = editingUserId ? `/api/settings/users/${editingUserId}` : '/api/settings/users';
      const method = editingUserId ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        // Show the server message (e.g. weak password, e-mail already used).
        const text = await readApiError(res, 'تعذر حفظ المستخدم');
        setMsg({ type: 'error', text });
        toast.error(text);
        return;
      }
      const data = await res.json().catch(() => ({}));

      const text = data?.message || 'تم الحفظ بنجاح';
      setMsg({ type: 'success', text });
      toast.success(text);
      resetForm();
      refreshLists(); // تحديث المستخدمين والموظفين المتاحين
    } catch {
      setMsg({ type: 'error', text: 'تعذر الاتصال بالخادم' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (user: AppUser) => {
    setEditingUserId(user.id);
    setMsg({ type: '', text: '' });
    setForm({
      employeeId: user.employeeProfile?.id || '',
      email: user.email,
      name: user.name || '',
      password: '', // leave empty to not change
      isActive: user.isActive !== false,
      role: (ALL_ROLES as readonly string[]).includes(user.role) ? (user.role as AppRole) : 'EMPLOYEE'
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /**
   * Accounts are never deleted (their audit trail must keep its author): "تعطيل" calls DELETE,
   * which deactivates the account and ends its sessions; "تفعيل" re-enables it.
   */
  const handleToggleActive = async (user: AppUser) => {
    const activate = user.isActive === false;
    if (!activate && !(await confirmDialog(`تعطيل الحساب "${user.email}" يُخرجه من النظام فوراً ويمنعه من الدخول حتى إعادة التفعيل. يبقى الحساب وسجل عملياته محفوظين. متابعة؟`, { danger: true, confirmText: 'تعطيل الحساب' }))) return;
    setTogglingId(user.id);
    try {
      const res = activate
        ? await fetch(`/api/settings/users/${user.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: true }),
          })
        : await fetch(`/api/settings/users/${user.id}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحديث حالة الحساب')); return; }
      const text = activate ? 'تم تفعيل الحساب' : 'تم تعطيل الحساب وإنهاء جلساته';
      setMsg({ type: 'success', text });
      toast.success(text);
      refreshLists();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setTogglingId(null);
    }
  };

  const passwordHint = form.password ? passwordProblem(form.password) : null;

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <Link href="/settings" className="text-blue-600 font-bold text-[13px] hover:underline mb-4 block">← العودة للإعدادات</Link>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-slate-100 text-slate-700 p-3 rounded-2xl border border-slate-200"><Shield size={26} /></span>
              إدارة المستخدمين والصلاحيات
            </h1>
            <p className="text-slate-600 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              تعيين صلاحيات الدخول، إدارة المحامين، مدراء الموارد البشرية، وتحديد مستوى كل موظف في النظام.
            </p>
          </div>

          <button type="button" onClick={() => {
            if (showForm) {
               resetForm();
            } else {
               setMsg({ type: '', text: '' });
               setShowForm(true);
            }
          }} className="px-10 py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[14px] transition-all flex items-center gap-2 shadow-lg shadow-blue-600/20">
            <UserPlus size={18} />
            {showForm ? 'إلغاء النافذة' : 'منح صلاحية دخول لموظف'}
          </button>
        </div>

        {msg.text && (
          <div role={msg.type === 'error' ? 'alert' : 'status'} className={`p-5 rounded-2xl border-2 font-black text-[14px] flex items-center gap-3 ${msg.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            {msg.type === 'success' ? <CheckCircle size={20} /> : <Lock size={20} />}
            {msg.text}
          </div>
        )}

        {/* Form Container */}
        {showForm && (
          <div className="bg-white p-8 rounded-[2rem] border border-blue-100 shadow-[0_10px_40px_rgba(0,0,0,0.04)] animate-in slide-in-from-top-4">
            <h3 className="text-[18px] font-black text-slate-800 mb-6 flex items-center gap-2">
              <Key size={18} className="text-blue-500" />
              {editingUserId ? 'تعديل بيانات المستخدم وصلاحيته' : 'تخصيص عضوية (لموظف مسجل)'}
            </h3>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-8">

              <div>
                <label htmlFor="user-employee" className="text-[12px] font-extrabold text-slate-700 mb-2 block">اختيار الموظف (المراد منحه الدخول)</label>
                <select id="user-employee" disabled={!!editingUserId && form.employeeId !== ''} value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px] focus:outline-none focus:border-blue-400">
                  <option value="">بدون موظف محدد (تهيئة حساب خارجي)</option>
                  {employees.map(e => (
                    <option key={e.id} value={e.id}>{`${e.firstNameArabic || ''} ${e.lastNameArabic || ''} - ${e.employeeId}`}</option>
                  ))}
                  {!!editingUserId && form.employeeId !== '' && (
                    <option value={form.employeeId}>الموظف المرتبط حالياً (لا يفضل التغيير)</option>
                  )}
                </select>
                <p className="text-[10px] text-slate-400 font-bold mt-1">تظهر أسماء الموظفين الذين ليست لهم حسابات دخول فقط</p>
              </div>

              <div>
                <label htmlFor="user-role" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نوع الصلاحية الممنوحة له (Role) *</label>
                <select id="user-role" required value={form.role} onChange={e => setForm({ ...form, role: e.target.value as AppRole })} className="w-full px-5 py-3.5 bg-slate-50 border border-blue-200 rounded-xl font-black text-[14px] text-blue-800 focus:outline-none focus:border-blue-500">
                  {assignableRoles.map(key => (
                    <option key={key} value={key}>{ROLE_LABELS[key]}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="user-email" className="text-[12px] font-extrabold text-slate-700 mb-2 block">البريد الإلكتروني (يستخدم لتسجيل الدخول) *</label>
                <div className="relative">
                  <input id="user-email" type="email" required dir="ltr" autoComplete="off" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="admin@domain.com" className="w-full pl-12 pr-5 py-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px]" />
                  <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
              </div>

              <div>
                <label htmlFor="user-password" className="text-[12px] font-extrabold text-slate-700 mb-2 block">{editingUserId ? 'كلمة المرور الجديدة (اتركها فارغة لتجاهل التغيير)' : 'كلمة المرور الافتراضية للبدء *'}</label>
                <div className="relative">
                  <input id="user-password" type="text" required={!editingUserId} minLength={8} dir="ltr" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="8 أحرف على الأقل (حروف وأرقام)" className={`w-full pl-12 pr-5 py-3.5 bg-white border rounded-xl font-bold text-[14px] ${passwordHint ? 'border-rose-300' : 'border-slate-200'}`} />
                  <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
                <p className={`text-[10px] font-bold mt-1 ${passwordHint ? 'text-rose-500' : 'text-slate-400'}`}>
                  {passwordHint || 'الحد الأدنى 8 أحرف وتحتوي على حرف إنجليزي ورقم واحد على الأقل'}
                </p>
              </div>

              <div>
                <label htmlFor="user-name" className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم العرض (اختياري)</label>
                <input id="user-name" type="text" maxLength={120} autoComplete="off" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="يظهر في الشريط العلوي وسجل التدقيق" className="w-full px-5 py-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px]" />
              </div>

              {editingUserId && (
                <div className="flex items-center">
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input type="checkbox" checked={form.isActive} disabled={editingUserId === currentUser?.id} onChange={e => setForm({ ...form, isActive: e.target.checked })} className="w-5 h-5 accent-emerald-600" />
                    <span className="text-[13px] font-extrabold text-slate-700">الحساب نشط (إلغاء التحديد يعطّل الدخول ويُنهي الجلسات الحالية فوراً)</span>
                  </label>
                </div>
              )}

              <div className="md:col-span-2 flex justify-end">
                <button type="submit" disabled={isSubmitting} className="px-10 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-[13px] disabled:opacity-50 transition-colors shadow-lg shadow-emerald-600/20">
                  {isSubmitting ? 'جاري الحفظ...' : editingUserId ? 'حفظ التعديلات' : 'اعتماد وحفظ المستخدم الافتراضي'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Existing Users Table */}
        <div className="bg-white border border-slate-200 rounded-[2rem] shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <h2 className="text-[18px] font-black text-slate-900 flex items-center gap-3"><Users size={20} /> حسابات المستخدمين الحالية</h2>
          </div>

          {isLoading ? (
            <div className="p-20 text-center font-bold text-slate-400 animate-pulse">جاري تحميل المستخدمين...</div>
          ) : loadError ? (
            <div className="p-16 text-center">
              <p className="text-rose-600 font-bold mb-4">{loadError}</p>
              <button type="button" onClick={loadAll} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="px-6 py-4 text-[11px] font-black text-slate-500 uppercase tracking-widest">البريد (تسجيل الدخول)</th>
                    <th className="px-6 py-4 text-[11px] font-black text-slate-500 uppercase tracking-widest">الموظف المرتبط به</th>
                    <th className="px-6 py-4 text-[11px] font-black text-slate-500 uppercase tracking-widest">الصلاحية (الدور)</th>
                    <th className="px-6 py-4 text-[11px] font-black text-slate-500 uppercase tracking-widest">حالة الحساب</th>
                    <th className="px-6 py-4 text-[11px] font-black text-slate-500 uppercase tracking-widest">تاريخ الإنشاء</th>
                    <th className="px-6 py-4 text-[11px] font-black text-slate-500 uppercase tracking-widest">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr><td colSpan={6} className="p-8 text-center text-slate-400 font-bold text-[13px]">لا يوجد مستخدمون حتى الآن.</td></tr>
                  ) : users.map(u => {
                    const isSelf = currentUser?.id === u.id;
                    return (
                    <tr key={u.id} className="border-b border-slate-50 hover:bg-blue-50/30 transition-colors">
                      <td className="px-6 py-5 font-black text-[13px] text-slate-800"><span dir="ltr">{u.email}</span>{u.name && <span className="block text-[11px] font-bold text-slate-500 mt-0.5">{u.name}</span>}</td>
                      <td className="px-6 py-5">
                        {u.employeeProfile ? (
                          <span className="font-bold text-[13px] text-blue-700">{u.employeeProfile.firstNameArabic} {u.employeeProfile.lastNameArabic} <br /><span className="text-[10px] text-slate-400">#{u.employeeProfile.employeeId}</span></span>
                        ) : (
                          <span className="font-bold text-[11px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-md">إدارة عليا بدون موظف</span>
                        )}
                      </td>
                      <td className="px-6 py-5">
                        <span className={`font-black text-[12px] px-3 py-1.5 rounded-xl border ${u.role === 'SUPER_ADMIN' ? 'bg-rose-50 border-rose-200 text-rose-700' : u.role === 'LEGAL_ADMIN' ? 'bg-amber-50 border-amber-200 text-amber-700' : u.role === 'PAYROLL_ADMIN' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-blue-50 border-blue-200 text-blue-700'}`}>
                          {roleLabel(u.role)}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        {u.isActive === false
                          ? <span className="font-bold text-[11px] text-rose-600 bg-rose-50 px-2 py-1 rounded-md">معطّل</span>
                          : <span className="font-bold text-[11px] text-emerald-600 bg-emerald-50 px-2 py-1 rounded-md">نشط</span>}
                      </td>
                      <td className="px-6 py-5 font-bold text-[12px] text-slate-500">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="px-6 py-5">
                        <div className="flex items-center justify-end gap-2">
                          <button type="button" aria-label={`تعديل ${u.email}`} title="تعديل" onClick={() => handleEdit(u)} className="p-2 hover:bg-blue-100 text-blue-600 rounded-lg transition-colors border border-transparent hover:border-blue-200">
                             <Edit size={16} />
                          </button>
                          <button type="button" aria-label={`${u.isActive === false ? 'تفعيل' : 'تعطيل'} ${u.email}`} title={isSelf ? 'لا يمكنك تعطيل حسابك الحالي' : u.isActive === false ? 'إعادة تفعيل الحساب' : 'تعطيل الحساب (لا يُحذف، ويبقى سجل عملياته)'} disabled={isSelf || togglingId === u.id} onClick={() => handleToggleActive(u)} className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold transition-colors border border-transparent disabled:opacity-40 disabled:hover:bg-transparent ${u.isActive === false ? 'text-emerald-600 hover:bg-emerald-100 hover:border-emerald-200' : 'text-rose-600 hover:bg-rose-100 hover:border-rose-200'}`}>
                             <Power size={16} />
                             {u.isActive === false ? 'تفعيل' : 'تعطيل'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </DashboardLayout>
  );
}
