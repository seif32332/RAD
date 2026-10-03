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

interface IdentitySummary {
  identityStatus: 'UNATTESTED' | 'ATTESTED' | 'VENDOR_BOOTSTRAP';
  attested: boolean;
  countsTowardEnforced: boolean;
  isVendorStaff: boolean;
  tenantRoot: boolean;
  rootSuspended: boolean;
  attestedEmail: string | null;
  reattestRootOnly: boolean;
  twoChannelRequired: boolean;
}

interface AppUser {
  id: string;
  email: string;
  role: string;
  name?: string | null;
  isActive?: boolean;
  createdAt: string;
  employeeProfile?: { id: string; firstNameArabic?: string; lastNameArabic?: string; employeeId?: string } | null;
  // BL-PAY-005
  identity?: IdentitySummary | null;
  employeeLink?: { id: string; employeeId: string; status: 'PROPOSED' | 'CONFIRMED' | 'LEGACY_LINKED'; proposedById: string | null; employee?: { firstNameArabic?: string; lastNameArabic?: string; employeeId?: string } } | null;
  pendingChange?: { id: string; kind: string; nextRole: string | null; requestedById: string } | null;
}

interface PendingRequest {
  id: string;
  userId: string;
  kind: 'DEACTIVATE' | 'CHANGE_ROLE' | 'RESET_CREDENTIALS';
  nextRole: string | null;
  requestedById: string;
  requestedAt: string;
  reason: string | null;
  user: { email: string; name: string | null; role: string };
  requestedBy: { email: string; name: string | null };
}

interface HistoryEntry {
  id: string;
  action: string;
  at: string;
  actorId: string | null;
}

const CHANGE_KIND_LABELS: Record<string, string> = {
  DEACTIVATE: 'تعطيل الحساب',
  CHANGE_ROLE: 'تغيير الدور',
  RESET_CREDENTIALS: 'إعادة ضبط بيانات الدخول',
};

/** The identity badge of an account (BL-PAY-005). */
function identityBadge(i: IdentitySummary | null | undefined): { text: string; cls: string } {
  if (!i) return { text: '—', cls: 'text-slate-400 bg-slate-100' };
  if (i.isVendorStaff) return { text: 'حساب رديف', cls: 'text-slate-600 bg-slate-100' };
  if (i.tenantRoot) return i.rootSuspended ? { text: 'جذر الثقة (معلّق)', cls: 'text-amber-700 bg-amber-50' } : { text: 'جذر الثقة', cls: 'text-violet-700 bg-violet-50' };
  if (i.identityStatus === 'ATTESTED') return { text: 'هوية مُقرّ بها', cls: 'text-emerald-700 bg-emerald-50' };
  if (i.identityStatus === 'VENDOR_BOOTSTRAP') return { text: 'تمهيد المورّد (غير مُقرّ)', cls: 'text-amber-700 bg-amber-50' };
  return { text: i.reattestRootOnly ? 'غير مُقرّ (يعيده الجذر فقط)' : 'غير مُقرّ', cls: 'text-slate-600 bg-slate-100' };
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
  // BL-PAY-005: pending two-person identity changes, and the attestation panel of one account.
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [attesting, setAttesting] = useState<AppUser | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [attestForm, setAttestForm] = useState({ emailConfirmed: false, historyReviewed: false, verificationNote: '' });
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/identity-requests');
      if (!res.ok) return;
      const data = (await res.json()) as { requests?: PendingRequest[] };
      setPending(Array.isArray(data.requests) ? data.requests : []);
    } catch {
      /* the list of pending requests is secondary: the users table still loads */
    }
  }, []);

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      await Promise.all([fetchUsers(), fetchEmployees(), fetchPending()]);
    } catch (err) {
      const text = err instanceof Error ? err.message : 'تعذر الاتصال بالخادم';
      setLoadError(text);
      toast.error(text);
    } finally {
      setIsLoading(false);
    }
  }, [fetchUsers, fetchEmployees, fetchPending]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const refreshLists = async () => {
    try {
      await Promise.all([fetchUsers(), fetchEmployees(), fetchPending()]);
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

    // Password: required on create only. An admin never sets another user's password (DEC-PO-027):
    // an edit uses "إعادة ضبط بيانات الدخول" (a one-time link to the holder).
    if (!editingUserId) {
      const problem = passwordProblem(form.password);
      if (problem) { setMsg({ type: 'error', text: problem }); return; }
    }

    setIsSubmitting(true);
    try {
      const url = editingUserId ? `/api/settings/users/${editingUserId}` : '/api/settings/users';
      const method = editingUserId ? 'PATCH' : 'POST';
      const { password, ...rest } = form;
      const payload = editingUserId ? rest : { ...rest, password };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(payload)
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
      const body = await res.json().catch(() => ({}));
      // 202: an attested financial approver is deactivated only with a second person (DEC-PO-021).
      const text = res.status === 202 ? body?.message || 'أُرسل طلب التعطيل بانتظار الموافقة' : activate ? 'تم تفعيل الحساب' : 'تم تعطيل الحساب وإنهاء جلساته';
      setMsg({ type: 'success', text });
      if (res.status === 202) toast.info(text);
      else toast.success(text);
      refreshLists();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setTogglingId(null);
    }
  };

  /** POST /api/settings/users/:id/identity (BL-PAY-005). Returns the parsed body, or null on failure. */
  const identityAction = async (userId: string, body: Record<string, unknown>, failText: string) => {
    setBusyId(userId);
    try {
      const res = await fetch(`/api/settings/users/${userId}/identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (res.status === 401) { window.location.href = '/login'; return null; }
      if (!res.ok) { toast.error(await readApiError(res, failText)); return null; }
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return null;
    } finally {
      setBusyId(null);
    }
  };

  /** identity.resetCredentials: a one-time link to the holder; never a password chosen by the admin (DEC-PO-027). */
  const handleReset = async (user: AppUser) => {
    if (!(await confirmDialog(`إعادة ضبط بيانات دخول "${user.email}" تُنهي جلساته فوراً وتوقف كلمة مروره الحالية، ويصله رابط لمرة واحدة يختار به كلمة مرور جديدة. إن كان معتمداً مالياً مُقرّاً به فتحتاج موافقة شخص ثانٍ، ولا يعيد إقراره إلا جذر الثقة. متابعة؟`, { danger: true, confirmText: 'إعادة الضبط' }))) return;
    const r = await identityAction(user.id, { action: 'resetCredentials' }, 'تعذر إعادة ضبط بيانات الدخول');
    if (!r) return;
    const text = String(r.data.message || 'تمت إعادة الضبط');
    if (r.status === 202) toast.info(text);
    else toast.success(text);
    setMsg({ type: 'success', text });
    refreshLists();
  };

  /** The second step of the link (BR-PAY-005): confirm or refuse a proposed link. */
  const handleLink = async (user: AppUser, action: 'confirmLink' | 'rejectLink') => {
    if (!user.employeeLink) return;
    const r = await identityAction(user.id, { action, linkId: user.employeeLink.id }, 'تعذر تنفيذ الإجراء على الربط');
    if (!r) return;
    toast.success(String(r.data.message || 'تم'));
    refreshLists();
  };

  const openAttest = async (user: AppUser) => {
    setIssuedCode(null);
    setAttestForm({ emailConfirmed: false, historyReviewed: false, verificationNote: '' });
    setHistory([]);
    setAttesting(user);
    try {
      const res = await fetch(`/api/settings/users/${user.id}/identity`);
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحميل سجل بيانات الدخول')); return; }
      const data = (await res.json()) as { credentialHistory?: HistoryEntry[] };
      setHistory(Array.isArray(data.credentialHistory) ? data.credentialHistory : []);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const submitAttest = async () => {
    if (!attesting) return;
    const r = await identityAction(
      attesting.id,
      { action: 'attest', attestedEmail: attesting.email, emailConfirmed: attestForm.emailConfirmed, historyReviewed: attestForm.historyReviewed, verificationNote: attestForm.verificationNote },
      'تعذر إقرار الهوية',
    );
    if (!r) return;
    if (typeof r.data.code === 'string') {
      // Shown ONCE, never stored or emailed: the attester hands it over in person (RT-PAY-1201).
      setIssuedCode(r.data.code);
      toast.info(String(r.data.message || 'بدأ الإقرار الأول'));
    } else {
      toast.success(String(r.data.message || 'تم إقرار الهوية'));
      setAttesting(null);
    }
    refreshLists();
  };

  /** The second person of a pending identity change (DEC-PO-021 / 024). */
  const decidePending = async (req: PendingRequest, decision: 'APPROVE' | 'REJECT' | 'CANCEL') => {
    if (decision === 'APPROVE' && !(await confirmDialog(`الموافقة على "${CHANGE_KIND_LABELS[req.kind] || req.kind}" للحساب "${req.user.email}" تنفذه فوراً. متابعة؟`, { confirmText: 'موافقة' }))) return;
    setBusyId(req.id);
    try {
      const res = await fetch(`/api/settings/identity-requests/${req.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تنفيذ القرار')); return; }
      toast.success(String((await res.json().catch(() => ({})))?.message || 'تم'));
      refreshLists();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
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

              {editingUserId ? (
                <div>
                  <span className="text-[12px] font-extrabold text-slate-700 mb-2 block">كلمة المرور</span>
                  <p className="text-[12px] font-bold text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                    لا يضبط المسؤول كلمة مرور مستخدم آخر. استخدم زر «إعادة ضبط بيانات الدخول» في الجدول: يصل صاحب الحساب رابط لمرة واحدة يختار به كلمته.
                  </p>
                </div>
              ) : (
                <div>
                  <label htmlFor="user-password" className="text-[12px] font-extrabold text-slate-700 mb-2 block">كلمة المرور الافتراضية للبدء *</label>
                  <div className="relative">
                    <input id="user-password" type="text" required minLength={8} dir="ltr" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="8 أحرف على الأقل (حروف وأرقام)" className={`w-full pl-12 pr-5 py-3.5 bg-white border rounded-xl font-bold text-[14px] ${passwordHint ? 'border-rose-300' : 'border-slate-200'}`} />
                    <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                  </div>
                  <p className={`text-[10px] font-bold mt-1 ${passwordHint ? 'text-rose-500' : 'text-slate-400'}`}>
                    {passwordHint || 'الحد الأدنى 8 أحرف وتحتوي على حرف إنجليزي ورقم واحد على الأقل. الإقرار الأول بالهوية يفرض على صاحب الحساب اختيار كلمة جديدة.'}
                  </p>
                </div>
              )}

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

        {/* BL-PAY-005: pending two-person identity changes (DEC-PO-021 / 024) */}
        {pending.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-[2rem] p-6 space-y-3">
            <h2 className="text-[16px] font-black text-amber-900">طلبات بانتظار شخص ثانٍ</h2>
            <p className="text-[12px] font-bold text-amber-800">يوافق عليها صاحب الحساب نفسه أو مسؤول آخر مُقرّ بهويته، ولا يوافق عليها من قدّمها.</p>
            {pending.map(req => (
              <div key={req.id} className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white border border-amber-100 rounded-xl px-4 py-3">
                <div className="text-[13px] font-bold text-slate-700">
                  <span className="font-black">{CHANGE_KIND_LABELS[req.kind] || req.kind}</span>
                  {req.nextRole ? <> ← {roleLabel(req.nextRole)}</> : null} للحساب <span dir="ltr">{req.user.email}</span>
                  <span className="block text-[11px] text-slate-500">طلبه <span dir="ltr">{req.requestedBy.email}</span> في {formatDate(req.requestedAt)}{req.reason ? ` — ${req.reason}` : ''}</span>
                </div>
                <div className="flex gap-2">
                  {req.requestedById === currentUser?.id ? (
                    <button type="button" disabled={busyId === req.id} onClick={() => decidePending(req, 'CANCEL')} className="px-4 py-2 rounded-lg text-[12px] font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">سحب الطلب</button>
                  ) : (
                    <>
                      <button type="button" disabled={busyId === req.id} onClick={() => decidePending(req, 'APPROVE')} className="px-4 py-2 rounded-lg text-[12px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">موافقة</button>
                      <button type="button" disabled={busyId === req.id} onClick={() => decidePending(req, 'REJECT')} className="px-4 py-2 rounded-lg text-[12px] font-bold border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-40">رفض</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* BL-PAY-005: attestation of one account (chained to TENANT_ROOT; two channels the first time) */}
        {attesting && (
          <div className="bg-white p-8 rounded-[2rem] border border-emerald-200 shadow-sm space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[17px] font-black text-slate-800">إقرار هوية الحساب <span dir="ltr">{attesting.email}</span></h3>
              <button type="button" onClick={() => { setAttesting(null); setIssuedCode(null); }} className="text-[12px] font-bold text-slate-500 hover:underline">إغلاق</button>
            </div>
            {issuedCode ? (
              <div role="status" className="p-5 rounded-2xl border-2 border-emerald-300 bg-emerald-50 space-y-2">
                <p className="text-[13px] font-black text-emerald-900">سلّم هذا الرمز لصاحب الحساب بنفسك (حضورياً أو هاتفياً). لن يظهر مرة أخرى ولا يُرسل بالبريد:</p>
                <p dir="ltr" className="text-3xl font-black tracking-[0.3em] text-emerald-800 text-center">{issuedCode}</p>
                <p className="text-[12px] font-bold text-emerald-800">أُرسل رابط لمرة واحدة إلى البريد المُقرّ. لا يُعد الحساب مُقرّاً به حتى يستخدم صاحبه الرابط والرمز معاً ويختار كلمة مروره.</p>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-[12px] font-extrabold text-slate-700 mb-2">سجل بيانات الدخول منذ الإطلاق (تغييرات البريد وكلمة المرور وإعادات الضبط)</p>
                  <ul className="max-h-48 overflow-y-auto text-[12px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1">
                    {history.length === 0 ? <li>لا توجد تغييرات مسجلة.</li> : history.map(h => <li key={h.id}><span dir="ltr">{h.action}</span> — {formatDate(h.at)}</li>)}
                  </ul>
                </div>
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input type="checkbox" checked={attestForm.historyReviewed} onChange={e => setAttestForm({ ...attestForm, historyReviewed: e.target.checked })} className="w-5 h-5 mt-0.5 accent-emerald-600" />
                  <span className="text-[13px] font-extrabold text-slate-700">اطلعت على سجل بيانات الدخول أعلاه</span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input type="checkbox" checked={attestForm.emailConfirmed} onChange={e => setAttestForm({ ...attestForm, emailConfirmed: e.target.checked })} className="w-5 h-5 mt-0.5 accent-emerald-600" />
                  <span className="text-[13px] font-extrabold text-slate-700">أؤكد أن البريد <span dir="ltr">{attesting.email}</span> يخص هذا الشخص نفسه، وأنه شخص حقيقي مرتبط بالحساب الصحيح</span>
                </label>
                <div>
                  <label htmlFor="attest-note" className="text-[12px] font-extrabold text-slate-700 mb-2 block">كيف تحققت من الشخص خارج النظام؟ *</label>
                  <textarea id="attest-note" rows={3} maxLength={1000} value={attestForm.verificationNote} onChange={e => setAttestForm({ ...attestForm, verificationNote: e.target.value })} placeholder="مثال: مقابلة حضورية واطلاع على الهوية الوطنية" className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl font-bold text-[13px]" />
                </div>
                <div className="flex justify-end">
                  <button type="button" disabled={busyId === attesting.id || !attestForm.emailConfirmed || !attestForm.historyReviewed || attestForm.verificationNote.trim().length < 10} onClick={submitAttest} className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-[13px] disabled:opacity-50">إقرار الهوية</button>
                </div>
              </>
            )}
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
                        ) : u.employeeLink?.status === 'PROPOSED' ? (
                          <span className="font-bold text-[12px] text-amber-700">
                            {u.employeeLink.employee?.firstNameArabic} {u.employeeLink.employee?.lastNameArabic}
                            <span className="block text-[10px] text-amber-600">ربط مقترح بانتظار تأكيد شخص ثانٍ</span>
                            {u.employeeLink.proposedById !== currentUser?.id && !isSelf && (
                              <span className="flex gap-2 mt-1">
                                <button type="button" disabled={busyId === u.id} onClick={() => handleLink(u, 'confirmLink')} className="text-[11px] font-bold text-emerald-700 hover:underline disabled:opacity-40">تأكيد الربط</button>
                                <button type="button" disabled={busyId === u.id} onClick={() => handleLink(u, 'rejectLink')} className="text-[11px] font-bold text-rose-700 hover:underline disabled:opacity-40">رفض</button>
                              </span>
                            )}
                            {u.employeeLink.proposedById === currentUser?.id && (
                              <button type="button" disabled={busyId === u.id} onClick={() => handleLink(u, 'rejectLink')} className="block text-[11px] font-bold text-slate-600 hover:underline mt-1 disabled:opacity-40">سحب الاقتراح</button>
                            )}
                          </span>
                        ) : (
                          <span className="font-bold text-[11px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-md">إدارة عليا بدون موظف</span>
                        )}
                        {u.employeeLink?.status === 'LEGACY_LINKED' && <span className="block text-[10px] font-bold text-slate-400 mt-1">ربط قائم قبل الضوابط (يؤكده إقرار الهوية)</span>}
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
                        {(() => {
                          const b = identityBadge(u.identity);
                          return <span className={`block w-fit mt-1.5 font-bold text-[10px] px-2 py-0.5 rounded-md ${b.cls}`}>{b.text}</span>;
                        })()}
                        {u.pendingChange && <span className="block w-fit mt-1 font-bold text-[10px] px-2 py-0.5 rounded-md text-amber-700 bg-amber-50">طلب قائم: {CHANGE_KIND_LABELS[u.pendingChange.kind] || u.pendingChange.kind}</span>}
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
                          {!isSelf && u.isActive !== false && !u.identity?.isVendorStaff && (
                            <button type="button" title="رابط لمرة واحدة لصاحب الحساب يختار به كلمة مرور جديدة" disabled={busyId === u.id} onClick={() => handleReset(u)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-slate-600 hover:bg-slate-100 border border-transparent hover:border-slate-200 disabled:opacity-40">
                              <Key size={16} /> إعادة ضبط الدخول
                            </button>
                          )}
                          {!isSelf && u.isActive !== false && u.identity && !u.identity.attested && !u.identity.isVendorStaff && !u.identity.tenantRoot && (
                            <button type="button" title="إقرار أن الحساب لشخص حقيقي (من سلسلة جذر الثقة)" disabled={busyId === u.id} onClick={() => openAttest(u)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-emerald-700 hover:bg-emerald-50 border border-transparent hover:border-emerald-200 disabled:opacity-40">
                              <CheckCircle size={16} /> إقرار الهوية
                            </button>
                          )}
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
