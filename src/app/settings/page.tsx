"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Bell, Shield, Calculator, Save, CheckCircle, Truck, Users, Calendar, UserCog, Key, AtSign, Eye, EyeOff, RefreshCw, Info, Scale } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { ROLE_LABELS } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';
import { DEFAULT_SETTINGS, PROVISIONAL_SETTING_KEYS, SETTING_DEFS, settingValueProblem } from '@/app/api/settings/definitions';

/** Shown next to settings whose defaults still await the legal / payroll counsel (DEC-003). */
const PROVISIONAL_LABEL = 'قيم افتراضية بانتظار تأكيد المستشار';

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
}

interface SectionDef {
  id: string;
  label: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  fields: FieldDef[];
  note?: string;
}

/**
 * Every field below is read by the server (see src/app/api/settings/definitions.ts for the
 * consumer of each key). Settings that nothing enforced (backup schedule, SMS/e-mail channels,
 * Hijri date format, time zone, recruitment limits, carry-forward cap, ...) were removed.
 */
const SETTING_SECTIONS: SectionDef[] = [
  {
    id: 'hr_alerts', label: 'تنبيهات الموارد البشرية', icon: <Users size={18}/>,
    title: 'فترات التنبيه - الموارد البشرية', subtitle: 'قبل كم يوم من تاريخ الانتهاء يظهر التنبيه في صفحات التنبيهات ولوحة التحكم',
    fields: [
      { key: 'alert_iqama_days', label: 'انتهاء الإقامة / الهوية (أيام)' },
      { key: 'alert_passport_days', label: 'انتهاء جواز السفر (أيام)' },
      { key: 'alert_health_cert_days', label: 'انتهاء الشهادة الصحية (أيام)' },
      { key: 'alert_contract_days', label: 'اقتراب انتهاء عقد العمل (أيام)' },
      { key: 'alert_probation_days', label: 'اقتراب انتهاء فترة التجربة (أيام)' },
      { key: 'alert_annual_leave_days', label: 'استحقاق الإجازة السنوية (أيام قبل الاستحقاق)' },
      { key: 'alert_medical_insurance_days', label: 'انتهاء التأمين الطبي (أيام)' },
    ],
  },
  {
    id: 'admin_alerts', label: 'تنبيهات الشؤون الإدارية', icon: <Bell size={18}/>,
    title: 'فترات التنبيه - الشؤون الإدارية', subtitle: 'توقيت إنذار انتهاء الوثائق الحكومية والتراخيص والعقود للفروع والشركات',
    fields: [
      { key: 'alert_commercial_reg_days', label: 'انتهاء السجل التجاري (أيام)' },
      { key: 'alert_municipal_license_days', label: 'انتهاء الرخصة البلدية (أيام)' },
      { key: 'alert_civil_defense_days', label: 'انتهاء شهادة الدفاع المدني (أيام)' },
      { key: 'alert_lease_contract_days', label: 'انتهاء عقد الإيجار (أيام)' },
      { key: 'alert_trademark_days', label: 'انتهاء العلامة التجارية (أيام)' },
      { key: 'alert_waste_contract_days', label: 'انتهاء عقد النظافة / النفايات (أيام)' },
      { key: 'alert_safety_contract_days', label: 'انتهاء عقد السلامة (أيام)' },
      { key: 'alert_camera_contract_days', label: 'انتهاء عقد كاميرات المراقبة (أيام)' },
    ],
  },
  {
    id: 'logistics_alerts', label: 'تنبيهات اللوجستي والمركبات', icon: <Truck size={18}/>,
    title: 'فترات التنبيه - الإدارة اللوجستية', subtitle: 'التحذير المبكر لانتهاء وثائق المركبات والسائقين',
    fields: [
      { key: 'alert_vehicle_license_days', label: 'انتهاء رخصة السير / الاستمارة (أيام)' },
      { key: 'alert_vehicle_insurance_days', label: 'انتهاء تأمين المركبة (أيام)' },
      { key: 'alert_vehicle_inspection_days', label: 'انتهاء الفحص الدوري (أيام)' },
      { key: 'alert_operating_card_days', label: 'انتهاء كرت التشغيل (أيام)' },
      { key: 'alert_driver_card_days', label: 'انتهاء بطاقة السائق (أيام)' },
      { key: 'alert_driving_auth_days', label: 'انتهاء تفويض القيادة (أيام)' },
    ],
  },
  {
    id: 'legal_alerts', label: 'تنبيهات الإدارة القانونية', icon: <Scale size={18}/>,
    title: 'فترات التنبيه - الإدارة القانونية', subtitle: 'التنبيه قبل انتهاء العقود والوكالات واستحقاق السندات',
    fields: [
      { key: 'alert_legal_contract_days', label: 'انتهاء العقود والاتفاقيات (أيام)' },
      { key: 'alert_agency_days', label: 'انتهاء الوكالات الموثقة (أيام)' },
      { key: 'alert_promissory_note_days', label: 'استحقاق السندات لأمر (أيام)' },
    ],
  },
  {
    id: 'payroll', label: 'إعدادات الرواتب والأجور', icon: <Calculator size={18}/>,
    title: 'إعدادات الرواتب والأجور', subtitle: 'تُستخدم عند إعداد مسير الرواتب: الأوفرتايم، حصة الموظف في التأمينات، وساعات العمل',
    fields: [
      { key: 'overtime_rate_multiplier', label: 'معامل ساعة العمل الإضافي (أيام العمل)', hint: 'نظام العمل السعودي: 1.5 من أجر الساعة' },
      { key: 'overtime_weekend_multiplier', label: 'معامل ساعة العمل الإضافي (العطل ونهاية الأسبوع)' },
      { key: 'gosi_employee_percentage', label: 'حصة الموظف السعودي في التأمينات الاجتماعية (%)', hint: 'تُخصم من راتب الموظف السعودي (معاشات + ساند)' },
      { key: 'gosi_employee_percentage_non_saudi', label: 'حصة الموظف غير السعودي في التأمينات (%)', hint: 'عادةً 0% (الأخطار المهنية على صاحب العمل)' },
      { key: 'default_work_hours_per_day', label: 'عدد ساعات العمل الرسمية في اليوم', hint: 'يُستخدم لحساب أجر الساعة' },
      { key: 'default_work_days_per_week', label: 'عدد أيام العمل الرسمية في الأسبوع' },
    ],
  },
  {
    id: 'leaves', label: 'الإجازات ونهاية الخدمة', icon: <Calendar size={18}/>,
    title: 'الإجازات ونهاية الخدمة', subtitle: 'تُستخدم في حساب رصيد الإجازة السنوية والمخالصات',
    fields: [
      {
        key: 'annual_leave_days',
        label: 'رصيد الإجازة السنوية حسب سياسة المنشأة (أيام) - اختياري',
        hint: 'اتركه فارغاً لتطبيق نظام العمل: 21 يوماً، و30 يوماً بعد إكمال 5 سنوات خدمة. أي قيمة تُدخل تُطبق فقط إذا كانت أكبر من الحد النظامي.',
      },
      { key: 'exit_reentry_visa_fee', label: 'رسوم تأشيرة الخروج والعودة (ر.س)', hint: 'تُستخدم عند إصدار تأشيرة الخروج والعودة ضمن المخالصة' },
    ],
  },
  {
    id: 'statutory_leaves', label: 'الإجازات النظامية', icon: <Calendar size={18}/>,
    title: 'الإجازات النظامية (وضع، مولود، زواج، وفاة، حج)', subtitle: 'أيام الإجازة المدفوعة لكل نوع. هذه الأنواع لا تُخصم من رصيد الإجازة السنوية.',
    fields: [
      { key: 'leave_maternity_days', label: 'إجازة الوضع بأجر كامل (أيام)', hint: 'تعديلات نظام العمل النافذة 2025-02-19: 12 أسبوعاً (84 يوماً). للموظفات فقط.' },
      { key: 'leave_maternity_unpaid_extension_days', label: 'تمديد إجازة الوضع بدون أجر (أيام)', hint: 'شهر واحد بدون أجر بطلب الموظفة' },
      { key: 'leave_paternity_days', label: 'إجازة المولود للأب (أيام)', hint: '3 أيام بأجر كامل' },
      { key: 'leave_paternity_window_days', label: 'مهلة أخذ إجازة المولود من تاريخ الولادة (أيام)', hint: 'تؤخذ خلال 7 أيام من تاريخ الولادة' },
      { key: 'leave_marriage_days', label: 'إجازة الزواج (أيام)', hint: '5 أيام بأجر كامل تُحتسب من تاريخ الزواج' },
      { key: 'leave_bereavement_days', label: 'إجازة وفاة الزوج/الزوجة أو أحد الأصول أو الفروع (أيام)', hint: '5 أيام بأجر كامل تُحتسب من تاريخ الوفاة' },
      { key: 'leave_bereavement_sibling_days', label: 'إجازة وفاة الأخ أو الأخت (أيام)', hint: '3 أيام بأجر كامل (أُضيفت في تعديلات 2025)' },
      { key: 'leave_hajj_days', label: 'إجازة الحج (أيام)', hint: 'النظام: من 10 إلى 15 يوماً شاملة إجازة عيد الأضحى، مرة واحدة طوال الخدمة' },
      { key: 'leave_hajj_min_service_years', label: 'الحد الأدنى لسنوات الخدمة المتصلة لاستحقاق إجازة الحج', hint: 'سنتان متصلتان على الأقل' },
    ],
    note: 'هذه القيم افتراضية مأخوذة من نصوص تعديلات نظام العمل المنشورة (أم القرى، وزارة الموارد البشرية) ولم يعتمدها المستشار القانوني بعد؛ عدّلها بعد تأكيده. إجازة الوضع للموظفات فقط وإجازة المولود للموظف الأب (حسب حقل الجنس في ملف الموظف). أداء الموظف للحج قبل التحاقه بالمنشأة لا يعرفه النظام ويجب أن تتحقق منه الموارد البشرية. إجازة رعاية المولود المريض وإجازة العدة غير مدعومتين حالياً.',
  },
  {
    id: 'self_attendance', label: 'الحضور الذاتي من البوابة', icon: <UserCog size={18}/>,
    title: 'الحضور والانصراف الذاتي (الموقع + التحقق من الوجه)', subtitle: 'يسجل الموظف حضوره وانصرافه من البوابة داخل نطاق مواقع فرعه، مع التحقق من وجهه',
    fields: [
      { key: 'self_attendance_enabled', label: 'تفعيل الحضور الذاتي (0 = متوقف، 1 = مفعل)', hint: 'لا تفعّله قبل: تحديد مواقع الفروع، وتشغيل خدمة التحقق من الوجه على الخادم، واعتماد نص إشعار الخصوصية.' },
      { key: 'attendance_gps_max_accuracy_m', label: 'أسوأ دقة موقع مقبولة (متر)', hint: 'إذا كانت دقة الموقع التي يبلغ عنها الجوال أسوأ من هذه القيمة تُرفض الحركة' },
      { key: 'attendance_geofence_default_radius_m', label: 'نصف القطر الافتراضي لموقع حضور جديد (متر)' },
      { key: 'attendance_face_accept_pct', label: 'حد قبول تطابق الوجه (%)', hint: 'عند هذه النسبة أو أعلى تُقبل الحركة' },
      { key: 'attendance_face_min_pct', label: 'حد رفض تطابق الوجه (%)', hint: 'أقل من هذه النسبة تُرفض الحركة؛ بين الحدين تُقبل وتُعلَّم للمراجعة' },
      { key: 'attendance_liveness_accept_pct', label: 'حد قبول فحص الالتقاط المباشر (%)' },
      { key: 'attendance_liveness_min_pct', label: 'حد رفض فحص الالتقاط المباشر (%)', hint: 'أقل منه يُشتبه أن الصورة من شاشة أو ورقة' },
      { key: 'attendance_selfie_retention_days', label: 'مدة الاحتفاظ بصور الحركات المرفوضة والمشبوهة (يوم)', hint: 'تُحذف تلقائياً بعدها. الحركات المقبولة لا تُحفظ صورها أصلاً.' },
    ],
    note: 'النسب المبدئية للتطابق وفحص الالتقاط تحتاج معايرة خلال فترة التجربة على موظفين حقيقيين. تحديد الموقع والصورة يأتيان من جوال الموظف ويمكن التلاعب بهما بأدوات متخصصة: هذه الفحوص ترفع كلفة التلاعب وتترك دليلاً للمراجعة، ولا تمنعه نهائياً.',
  },
  {
    id: 'security', label: 'الأمان وتسجيل الدخول', icon: <Shield size={18}/>,
    title: 'الأمان وتسجيل الدخول', subtitle: 'تُطبق مباشرة على الخادم عند تسجيل الدخول وتغيير كلمات المرور',
    fields: [
      { key: 'session_timeout_minutes', label: 'مدة صلاحية الجلسة (دقيقة)', hint: 'بعد انتهائها يجب تسجيل الدخول من جديد. تُطبق على الجلسات الجديدة (من 15 دقيقة حتى 7 أيام).' },
      { key: 'max_login_attempts', label: 'عدد محاولات الدخول المسموحة خلال 15 دقيقة', hint: 'بعد تجاوزها يُمنع الدخول لهذا الحساب من نفس العنوان مؤقتاً' },
      { key: 'password_min_length', label: 'الحد الأدنى لطول كلمة المرور', hint: 'يُطبق عند إنشاء المستخدمين وتغيير كلمات المرور (لا يقل عن 8، مع حرف ورقم)' },
    ],
    note: 'المصادقة الثنائية (2FA) غير متوفرة في هذا الإصدار. النسخ الاحتياطي لقاعدة البيانات يُدار من الخادم عبر ops/backup.sh (جدولة cron) وليس من هذه الصفحة، ولا يوجد إرسال رسائل SMS في النظام حالياً.',
  },
];

const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  SETTING_SECTIONS.flatMap(s => s.fields.map(f => [f.key, f.label.replace(/ \(.*\)$/, '')])),
);

function defaultHint(key: string): string {
  const def = SETTING_DEFS[key];
  if (!def) return '';
  const dflt = DEFAULT_SETTINGS[key];
  return dflt === '' ? `المسموح: ${def.min} - ${def.max}` : `الافتراضي: ${dflt} · المسموح: ${def.min} - ${def.max}`;
}

interface AdminProfile {
  email: string;
  role: string;
  isActive?: boolean;
  createdAt?: string;
}

/** Mirrors the server password policy (configured min length >= 8, at least one letter and one digit). */
function passwordProblem(pw: string, minLength = 8): string | null {
  if (pw.length < minLength) return `كلمة المرور يجب ألا تقل عن ${minLength} أحرف`;
  if (!/[A-Za-z]/.test(pw)) return 'كلمة المرور يجب أن تحتوي على حرف إنجليزي واحد على الأقل';
  if (!/\d/.test(pw)) return 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل';
  return null;
}

export default function SettingsPage() {
  const { refresh: refreshSession } = useRole();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState('account');
  /** false when the server refused the system settings (non-admin): only the account section is shown. */
  const [canEditSettings, setCanEditSettings] = useState(true);

  // Admin Profile State
  const [adminProfile, setAdminProfile] = useState<AdminProfile | null>(null);
  const [emailForm, setEmailForm] = useState({ newEmail: '', currentPassword: '' });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [profileMsg, setProfileMsg] = useState({ type: '', text: '' });
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const fetchSettings = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/settings');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (res.status === 403) { setCanEditSettings(false); setActiveSection('account'); return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل الإعدادات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json();
      if (data?.settings && typeof data.settings === 'object') setSettings(data.settings);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/profile');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحميل بيانات الحساب')); return; }
      const data = await res.json();
      if (data?.admin) {
        setAdminProfile(data.admin);
        setEmailForm(prev => ({ ...prev, newEmail: data.admin.email }));
      }
    } catch {
      toast.error('تعذر تحميل بيانات الحساب');
    }
  }, []);

  useEffect(() => { fetchSettings(); fetchProfile(); }, [fetchSettings, fetchProfile]);

  const handleEmailChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingEmail) return;
    setProfileMsg({ type: '', text: '' });
    setIsSavingEmail(true);
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'CHANGE_EMAIL', newEmail: emailForm.newEmail, currentPassword: emailForm.currentPassword })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحديث البريد الإلكتروني');
        setProfileMsg({ type: 'error', text: msg });
        return;
      }
      const data = await res.json().catch(() => ({}));
      const msg = data?.message || 'تم تحديث البريد الإلكتروني بنجاح';
      setProfileMsg({ type: 'success', text: msg });
      toast.success(msg);
      setEmailForm(prev => ({ ...prev, currentPassword: '' }));
      fetchProfile();
      refreshSession().catch(() => undefined);
    } catch {
      setProfileMsg({ type: 'error', text: 'تعذر الاتصال بالخادم' });
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingPassword) return;
    setProfileMsg({ type: '', text: '' });
    const problem = passwordProblem(passwordForm.newPassword, minPasswordLength);
    if (problem) { setProfileMsg({ type: 'error', text: problem }); return; }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setProfileMsg({ type: 'error', text: 'كلمتا المرور غير متطابقتين' });
      return;
    }
    setIsSavingPassword(true);
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'CHANGE_PASSWORD', ...passwordForm })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تغيير كلمة المرور');
        setProfileMsg({ type: 'error', text: msg });
        return;
      }
      const data = await res.json().catch(() => ({}));
      const msg = data?.message || 'تم تغيير كلمة المرور بنجاح';
      setProfileMsg({ type: 'success', text: msg });
      toast.success(msg);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch {
      setProfileMsg({ type: 'error', text: 'تعذر الاتصال بالخادم' });
    } finally {
      setIsSavingPassword(false);
    }
  };

  const minPasswordLength = Math.max(8, Number(settings.password_min_length) || 8);

  const updateSetting = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    if (isSaving) return;
    // Same rules as the server (definitions.ts), reported with the field labels.
    const invalid = Object.keys(SETTING_DEFS)
      .filter(k => settings[k] !== undefined)
      .map(k => ({ k, problem: settingValueProblem(k, settings[k] ?? '') }))
      .filter((x): x is { k: string; problem: string } => !!x.problem);
    if (invalid.length > 0) {
      toast.error(`قيم غير صالحة: ${invalid.map(x => `${FIELD_LABELS[x.k] || x.k}: ${x.problem}`).join(' | ')}`);
      const first = SETTING_SECTIONS.find(s => s.fields.some(f => f.key === invalid[0].k));
      if (first) setActiveSection(first.id);
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const data = await res.clone().json().catch(() => null);
        const fields = data?.details?.fields as Record<string, string> | undefined;
        toast.error(fields && typeof fields === 'object'
          ? `قيم غير صالحة: ${Object.entries(fields).map(([k, p]) => `${FIELD_LABELS[k] || k}: ${p}`).join(' | ')}`
          : await readApiError(res, 'خطأ في حفظ الإعدادات'));
        return;
      }
      const data = await res.json().catch(() => ({}));
      toast.success(data?.message || 'تم حفظ الإعدادات');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSaving(false);
    }
  };

  const sections = [
    { id: 'account', label: 'حسابي', icon: <UserCog size={18}/> },
    ...(canEditSettings ? SETTING_SECTIONS.map(s => ({ id: s.id, label: s.label, icon: s.icon })) : []),
  ];
  const activeSettingSection = canEditSettings ? SETTING_SECTIONS.find(s => s.id === activeSection) : undefined;

  return (
    <DashboardLayout>
       <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-slate-100 text-slate-700 p-3 rounded-2xl border border-slate-200"><Settings size={26} /></span>
              منطقة الإعدادات والتهيئة
            </h1>
            <p className="text-slate-600 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              {canEditSettings
                ? 'اضبط فترات التنبيه، إعدادات الرواتب والإجازات، وسياسات تسجيل الدخول. كل إعداد هنا يُطبق فعلياً على الخادم.'
                : 'إدارة بيانات حسابك: البريد الإلكتروني وكلمة المرور.'}
            </p>
          </div>

          {canEditSettings && (
          <button type="button" onClick={handleSave} disabled={isSaving || isLoading || !!loadError} className={`px-10 py-3.5 rounded-xl font-black text-[14px] transition-all flex items-center gap-2 shadow-lg ${saved ? 'bg-emerald-600 text-white shadow-emerald-600/20' : 'bg-slate-900 hover:bg-slate-800 text-white shadow-slate-900/20'} disabled:opacity-50`}>
             {saved ? <><CheckCircle size={18}/> تم حفظ التعديلات</> : isSaving ? <><Save size={18}/> جاري الحفظ...</> : <><Save size={18}/> حفظ الإعدادات</>}
          </button>
          )}
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري تحميل إعدادات النظام...</div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-8">

            {/* Sidebar Menu */}
            <aside className="lg:w-72 shrink-0">
              <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm p-3 lg:sticky lg:top-8 space-y-1">
                 {sections.map(s => (
                    <button type="button" key={s.id} aria-current={activeSection === s.id ? 'page' : undefined} onClick={() => setActiveSection(s.id)} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-right font-bold text-[13px] transition-all ${activeSection === s.id ? 'bg-slate-900 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'}`}>
                       {s.icon} {s.label}
                    </button>
                 ))}
              </div>
            </aside>

            {/* Content Area */}
            <div className="flex-1 animate-in fade-in slide-in-from-bottom-4 duration-500">

              {/* ADMIN ACCOUNT */}
              {activeSection === 'account' && (
                <div className="space-y-8">

                  {/* Profile Message */}
                  {profileMsg.text && (
                    <div role={profileMsg.type === 'error' ? 'alert' : 'status'} className={`p-4 rounded-2xl border font-bold text-[13px] flex items-center gap-2 ${profileMsg.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
                      {profileMsg.type === 'success' ? <CheckCircle size={18}/> : <Shield size={18}/>}
                      {profileMsg.text}
                    </div>
                  )}

                  {/* Account Info Card */}
                  <SettingsCard title="معلومات حسابي" subtitle="بيانات الحساب الحالي المسجل دخوله في النظام" icon={<UserCog size={20}/>}>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                       <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">البريد الإلكتروني الحالي</p>
                          <p className="font-black text-[16px] text-slate-800" dir="ltr">{adminProfile?.email || '...'}</p>
                       </div>
                       <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">مستوى الصلاحية</p>
                          <p className="font-black text-[16px] text-indigo-700">
                            {adminProfile?.role ? ((ROLE_LABELS as Record<string, string>)[adminProfile.role] || adminProfile.role) : '...'}
                          </p>
                       </div>
                       <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">حالة الحساب</p>
                          <p className={`font-black text-[16px] ${adminProfile?.isActive ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {adminProfile?.isActive ? '🟢 نشط ومفعّل' : '🔴 معطّل'}
                          </p>
                       </div>
                       <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">تاريخ إنشاء الحساب</p>
                          <p className="font-black text-[14px] text-slate-700">{adminProfile?.createdAt ? formatDate(adminProfile.createdAt) : '...'}</p>
                       </div>
                     </div>
                  </SettingsCard>

                  {/* Change Email */}
                  <SettingsCard title="تغيير البريد الإلكتروني" subtitle="تحديث بريد تسجيل الدخول الخاص بحسابك" icon={<AtSign size={20}/>}>
                     <form onSubmit={handleEmailChange} className="space-y-5">
                        <div>
                           <label htmlFor="settings-new-email" className="text-[12px] font-extrabold text-slate-700 mb-2 block">البريد الإلكتروني الجديد</label>
                           <input id="settings-new-email" type="email" required dir="ltr" autoComplete="email" value={emailForm.newEmail} onChange={e => setEmailForm({...emailForm, newEmail: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px] focus:border-indigo-400 focus:outline-none transition shadow-sm" />
                        </div>
                        <div>
                           <label htmlFor="settings-email-current-pass" className="text-[12px] font-extrabold text-slate-700 mb-2 block">كلمة المرور الحالية (للتحقق من الهوية)</label>
                           <div className="relative">
                              <input id="settings-email-current-pass" type={showCurrentPass ? 'text' : 'password'} required autoComplete="current-password" value={emailForm.currentPassword} onChange={e => setEmailForm({...emailForm, currentPassword: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px] focus:border-indigo-400 focus:outline-none transition shadow-sm" dir="ltr" />
                              <button type="button" aria-label={showCurrentPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} onClick={() => setShowCurrentPass(!showCurrentPass)} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                                {showCurrentPass ? <EyeOff size={18}/> : <Eye size={18}/>}
                              </button>
                           </div>
                           <p className="text-[10px] font-bold text-slate-400 mt-1.5">يجب إدخال كلمة المرور الحالية لتأكيد التغيير (للحماية)</p>
                        </div>
                        <button type="submit" disabled={isSavingEmail} className="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[13px] rounded-xl transition shadow-lg shadow-indigo-600/20 flex items-center gap-2 disabled:opacity-50">
                           <AtSign size={16}/> {isSavingEmail ? 'جاري التحديث...' : 'تحديث البريد الإلكتروني'}
                        </button>
                     </form>
                  </SettingsCard>

                  {/* Change Password */}
                  <SettingsCard title="تغيير كلمة المرور" subtitle="تحديث كلمة مرور الدخول - تُنهى جلساتك المفتوحة على الأجهزة الأخرى" icon={<Key size={20}/>}>
                     <form onSubmit={handlePasswordChange} className="space-y-5">
                        <div>
                           <label htmlFor="settings-current-pass" className="text-[12px] font-extrabold text-slate-700 mb-2 block">كلمة المرور الحالية</label>
                           <input id="settings-current-pass" type="password" required autoComplete="current-password" value={passwordForm.currentPassword} onChange={e => setPasswordForm({...passwordForm, currentPassword: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px] focus:border-indigo-400 focus:outline-none transition shadow-sm" dir="ltr" />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                           <div>
                              <label htmlFor="settings-new-pass" className="text-[12px] font-extrabold text-slate-700 mb-2 block">كلمة المرور الجديدة</label>
                              <div className="relative">
                                 <input id="settings-new-pass" type={showNewPass ? 'text' : 'password'} required minLength={minPasswordLength} autoComplete="new-password" value={passwordForm.newPassword} onChange={e => setPasswordForm({...passwordForm, newPassword: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px] focus:border-indigo-400 focus:outline-none transition shadow-sm" dir="ltr" />
                                 <button type="button" aria-label={showNewPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} onClick={() => setShowNewPass(!showNewPass)} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                                   {showNewPass ? <EyeOff size={18}/> : <Eye size={18}/>}
                                 </button>
                              </div>
                           </div>
                           <div>
                              <label htmlFor="settings-confirm-pass" className="text-[12px] font-extrabold text-slate-700 mb-2 block">تأكيد كلمة المرور الجديدة</label>
                              <input id="settings-confirm-pass" type="password" required minLength={8} autoComplete="new-password" value={passwordForm.confirmPassword} onChange={e => setPasswordForm({...passwordForm, confirmPassword: e.target.value})} className={`w-full px-5 py-3.5 bg-white border rounded-xl font-bold text-[14px] focus:outline-none transition shadow-sm ${passwordForm.confirmPassword && passwordForm.newPassword !== passwordForm.confirmPassword ? 'border-rose-400 bg-rose-50/30' : 'border-slate-200 focus:border-indigo-400'}`} dir="ltr" />
                              {passwordForm.confirmPassword && passwordForm.newPassword !== passwordForm.confirmPassword && (
                                 <p className="text-[10px] font-bold text-rose-500 mt-1">⚠️ كلمتا المرور غير متطابقتين!</p>
                              )}
                           </div>
                        </div>

                        {/* Password Strength Indicator */}
                        {passwordForm.newPassword && (
                          <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                             <p className="text-[11px] font-black text-slate-500 mb-2">قوة كلمة المرور:</p>
                             <div className="flex gap-1.5">
                                <div className={`flex-1 h-2 rounded-full transition-colors ${passwordForm.newPassword.length >= 1 ? 'bg-rose-400' : 'bg-slate-200'}`}></div>
                                <div className={`flex-1 h-2 rounded-full transition-colors ${passwordForm.newPassword.length >= 8 ? 'bg-amber-400' : 'bg-slate-200'}`}></div>
                                <div className={`flex-1 h-2 rounded-full transition-colors ${!passwordProblem(passwordForm.newPassword, minPasswordLength) ? 'bg-emerald-400' : 'bg-slate-200'}`}></div>
                                <div className={`flex-1 h-2 rounded-full transition-colors ${passwordForm.newPassword.length >= 10 && /[0-9]/.test(passwordForm.newPassword) && /[^a-zA-Z0-9]/.test(passwordForm.newPassword) ? 'bg-emerald-600' : 'bg-slate-200'}`}></div>
                             </div>
                             <p className="text-[10px] font-bold text-slate-400 mt-1.5">الحد الأدنى: {minPasswordLength} أحرف تحتوي على حرف إنجليزي ورقم. يُنصح بإضافة حروف كبيرة ورموز خاصة.</p>
                             {passwordProblem(passwordForm.newPassword, minPasswordLength) && (
                               <p className="text-[10px] font-bold text-rose-500 mt-1">{passwordProblem(passwordForm.newPassword, minPasswordLength)}</p>
                             )}
                          </div>
                        )}

                        <button type="submit" disabled={isSavingPassword || passwordForm.newPassword !== passwordForm.confirmPassword} className="px-8 py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-black text-[13px] rounded-xl transition shadow-lg shadow-rose-600/20 flex items-center gap-2">
                           <Key size={16}/> {isSavingPassword ? 'جاري التطبيق...' : 'تطبيق كلمة المرور الجديدة'}
                        </button>
                     </form>
                  </SettingsCard>

                </div>
              )}

              {activeSettingSection && (
                loadError ? (
                  <div className="py-16 text-center bg-white border border-rose-200 rounded-[2rem]">
                    <p className="text-rose-600 font-bold mb-4">{loadError}</p>
                    <button type="button" onClick={fetchSettings} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
                  </div>
                ) : (
                  <SettingsCard title={activeSettingSection.title} subtitle={activeSettingSection.subtitle} icon={activeSettingSection.icon}>
                    {activeSettingSection.fields.some(f => PROVISIONAL_SETTING_KEYS.includes(f.key)) && (
                      <div role="note" className="flex items-start gap-3 p-4 border border-amber-200 bg-amber-50 rounded-2xl">
                        <Info size={18} className="text-amber-600 shrink-0 mt-0.5" />
                        <p className="text-[12px] font-black text-amber-800 leading-relaxed">{PROVISIONAL_LABEL}</p>
                      </div>
                    )}
                    {activeSettingSection.fields.map(f => {
                      const value = settings[f.key] ?? '';
                      const problem = settingValueProblem(f.key, value);
                      return (
                        <SettingInput
                          key={f.key}
                          label={f.label}
                          badge={PROVISIONAL_SETTING_KEYS.includes(f.key) ? PROVISIONAL_LABEL : undefined}
                          value={value}
                          onChange={v => updateSetting(f.key, v)}
                          type="number"
                          hint={[f.hint, defaultHint(f.key)].filter(Boolean).join(' — ')}
                          error={problem}
                          placeholder={DEFAULT_SETTINGS[f.key] === '' ? 'حسب نظام العمل' : undefined}
                        />
                      );
                    })}
                    {activeSettingSection.note && (
                      <div className="flex items-start gap-3 p-5 border border-slate-200 bg-slate-50 rounded-2xl">
                        <Info size={18} className="text-slate-400 shrink-0 mt-0.5" />
                        <p className="text-[11px] font-bold text-slate-500 leading-relaxed">{activeSettingSection.note}</p>
                      </div>
                    )}
                  </SettingsCard>
                )
              )}

            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

/* ==============================
   REUSABLE SETTINGS COMPONENTS
   ============================== */

function SettingsCard({ title, subtitle, icon, children }: { title: string, subtitle: string, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-[2rem] shadow-sm overflow-hidden">
       <div className="p-8 border-b border-slate-100 bg-slate-50/50">
          <h2 className="text-[18px] font-black text-slate-900 flex items-center gap-3">{icon} {title}</h2>
          <p className="text-[13px] font-bold text-slate-500 mt-2">{subtitle}</p>
       </div>
       <div className="p-8 space-y-7">
          {children}
       </div>
    </div>
  );
}

function SettingInput({ label, value, onChange, type = 'text', hint, error, placeholder, badge }: { label: string, value: string, onChange: (v: string) => void, type?: string, hint?: string, error?: string | null, placeholder?: string, badge?: string }) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  return (
    <div>
       <label htmlFor={id} className="text-[12px] font-extrabold text-slate-700 mb-2 flex flex-wrap items-center gap-2">
         {label}
         {badge && <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{badge}</span>}
       </label>
       <input id={id} type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} value={value || ''} placeholder={placeholder} aria-invalid={!!error} aria-describedby={hint || error ? hintId : undefined} onChange={e => onChange(e.target.value)} className={`w-full px-5 py-3.5 bg-slate-50 border rounded-xl font-bold text-[14px] focus:outline-none transition shadow-sm ${error ? 'border-rose-400 bg-rose-50/30' : 'border-slate-200 focus:border-indigo-400'}`} />
       <div id={hintId}>
         {error && <p className="text-[11px] font-bold text-rose-600 mt-1.5 mr-1">{error}</p>}
         {hint && <p className="text-[10px] font-bold text-slate-400 mt-1.5 mr-1">{hint}</p>}
       </div>
    </div>
  );
}

