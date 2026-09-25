"use client";

// Persistent application shell (sidebar + header). Rendered once from src/app/layout.tsx, so it
// survives client-side navigation: the menu, notifications and identity are loaded once instead
// of on every page. Public routes (/login, /apply/*) and print views render without it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, Loader2, LogOut, Menu, Pencil, RefreshCw, Search, Settings, User } from "lucide-react";
import { useRole } from "@/context/RoleContext";
import { ROLE_GROUPS, ROLE_LABELS, roleIn, type AppRole } from "@/lib/constants";
import { ALERT_VIEWER_ROLES, canAccessPath, homePathFor, isShellFreePath, visibleGroups, type MenuItem } from "@/lib/menu";
import { ShellContext } from "@/components/shell/ShellContext";
import { MENU_ICONS } from "@/components/shell/menu-icons";
import EditProfileModal from "@/components/shell/EditProfileModal";
import AccessDenied from "@/components/shell/AccessDenied";

interface ShellNotification {
  id: string;
  title: string;
  subtitle?: string;
  color?: string;
}

/** Static class lists (Tailwind cannot see dynamically built class names). */
const NOTIFICATION_DOT: Record<string, string> = {
  amber: "bg-amber-500",
  indigo: "bg-indigo-500",
  emerald: "bg-emerald-500",
  blue: "bg-blue-500",
  slate: "bg-slate-500",
  rose: "bg-rose-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  violet: "bg-violet-500",
  teal: "bg-teal-500",
};

const ROLE_BADGE: Record<AppRole, string> = {
  SUPER_ADMIN: "bg-indigo-100 text-indigo-700",
  COMPANY_ADMIN: "bg-amber-100 text-amber-700",
  HR_MANAGER: "bg-blue-100 text-blue-700",
  FINANCE_MANAGER: "bg-teal-100 text-teal-700",
  PAYROLL_ADMIN: "bg-teal-100 text-teal-700",
  GOV_RELATIONS: "bg-sky-100 text-sky-700",
  LEGAL_ADMIN: "bg-rose-100 text-rose-700",
  BRANCH_MANAGER: "bg-emerald-100 text-emerald-700",
  DEPT_MANAGER: "bg-emerald-100 text-emerald-700",
  PURCHASING_AGENT: "bg-orange-100 text-orange-700",
  EMPLOYEE: "bg-slate-200 text-slate-700",
};

function parseNotifications(data: unknown): ShellNotification[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .filter((n) => (typeof n.id === "string" || typeof n.id === "number") && typeof n.title === "string")
    .map((n) => ({
      id: String(n.id),
      title: String(n.title),
      subtitle: typeof n.subtitle === "string" ? n.subtitle : undefined,
      color: typeof n.color === "string" ? n.color : undefined,
    }));
}

/**
 * Shell-level mobile fixes applied to every page (DEC-005 / DEC-010), because each page renders its
 * own header markup:
 * - Phones (< 640px): form fields use a 16px font so iOS Safari does not zoom in on focus.
 * - Below md: the action group next to a page title (the element following the block that holds
 *   the <h1>) wraps instead of pushing buttons off-screen, and the "w-full ml-14" offset some
 *   headers use for desktop alignment is dropped (it overflowed the viewport by 56px).
 */
const MOBILE_CONTENT_FIXES = [
  "max-sm:[&_input]:text-base",
  "max-sm:[&_select]:text-base",
  "max-sm:[&_textarea]:text-base",
  "max-md:[&_div:has(>h1)~div]:flex-wrap",
  "max-md:[&_div:has(>h1)~div]:max-w-full",
  "max-md:[&_.w-full.ml-14]:ml-0",
].join(" ");

/** Longest menu href matching the current path ("/" only matches exactly). */
function findActiveHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
    if (matches && (!best || href.length > best.length)) best = href;
  }
  return best;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <ShellContext.Provider value={true}>
      {isShellFreePath(pathname) ? children : <ShellFrame>{children}</ShellFrame>}
    </ShellContext.Provider>
  );
}

function Avatar({ name, avatarUrl, className, textClassName }: { name: string; avatarUrl: string | null; className: string; textClassName: string }) {
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- user-uploaded avatar served by the API
    return <img src={avatarUrl} alt={`صورة ${name || "المستخدم"}`} className={`${className} object-cover`} />;
  }
  return (
    <span className={`${className} bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-black ${textClassName}`}>
      {name?.trim().charAt(0) || "م"}
    </span>
  );
}

export function ShellFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { role, user, allowedPages, loading, error, refresh } = useRole();

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<ShellNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const profileRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Close transient UI when the route changes (adjusting state during render, not in an effect).
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setIsSidebarOpen(false);
    setIsProfileOpen(false);
    setIsNotificationsOpen(false);
  }

  // The content area is a persistent scroll container: reset it on navigation.
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) setIsProfileOpen(false);
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) setIsNotificationsOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setIsProfileOpen(false);
      setIsNotificationsOpen(false);
      setIsSidebarOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const loadNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      // Not critical for the shell: roles without access simply see an empty list.
      setNotifications(res.ok ? parseNotifications(await res.json()) : []);
    } catch (err) {
      console.error("[AppShell] notifications", err);
    } finally {
      setNotificationsLoading(false);
    }
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetch("/api/notifications", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        const list = res.ok ? parseNotifications(await res.json()) : [];
        if (!cancelled) setNotifications(list);
      })
      .catch((err) => console.error("[AppShell] notifications", err));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const groups = useMemo(() => visibleGroups(role, allowedPages), [role, allowedPages]);
  const activeHref = useMemo(
    () => findActiveHref(pathname, groups.flatMap((g) => g.items.map((i) => i.href))),
    [pathname, groups],
  );
  const filteredGroups = useMemo(() => {
    const q = sidebarSearch.trim();
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, items: g.items.filter((item) => item.label.includes(q) || g.heading.includes(q)) }))
      .filter((g) => g.items.length > 0);
  }, [groups, sidebarSearch]);

  const logout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("[AppShell] logout", err);
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  const toggleNotifications = () => {
    const next = !isNotificationsOpen;
    setIsNotificationsOpen(next);
    setIsProfileOpen(false);
    if (next && userId) void loadNotifications();
  };

  const menuReady = !!role && !loading;
  const homeHref = useMemo(() => homePathFor(role, allowedPages), [role, allowedPages]);
  // Page-level guard (UX only; the API routes enforce access). The page is not mounted until the
  // identity is known, so a role never fires the API calls of a page it cannot open.
  const pageAccess: "pending" | "allowed" | "denied" | "redirect" = !role
    ? error
      ? "allowed" // identity failed to load: let the page (and the server) decide
      : "pending" // loading, or redirecting to /login after a 401
    : canAccessPath(role, allowedPages, pathname)
      ? "allowed"
      : pathname === "/"
        ? "redirect" // the root is everyone's entry point: send the role to its own home page
        : "denied";
  useEffect(() => {
    if (pageAccess === "redirect") router.replace(homeHref);
  }, [pageAccess, homeHref, router]);
  const canSearch = !!role && canAccessPath(role, allowedPages, "/search");
  const displayName = user?.name || "المستخدم";
  const roleLabel = role ? ROLE_LABELS[role] : "";
  const isAdmin = roleIn(role, ROLE_GROUPS.ADMIN);
  // Only roles that can read at least one alert source get the link (the page 403s otherwise).
  const canViewAlerts = roleIn(role, ALERT_VIEWER_ROLES);

  return (
    <div className="flex h-screen overflow-hidden print:h-auto print:overflow-visible bg-[#0A0B10] text-slate-800 font-sans">
      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <button
          type="button"
          aria-label="إغلاق القائمة"
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden cursor-default"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar (Right side for RTL) */}
      <aside
        id="app-sidebar"
        aria-label="القائمة الرئيسية"
        className={`fixed top-0 bottom-0 right-0 z-50 w-[280px] flex flex-col transition-transform duration-300 md:relative md:translate-x-0 ${isSidebarOpen ? "translate-x-0" : "translate-x-full"} bg-[#0A0B10] text-[#94A3B8] print:hidden`}
      >
        {/* Logo Area */}
        <Link href={role ? homeHref : "/"} className="h-28 flex items-center px-8 relative shrink-0 group cursor-pointer" aria-label="رديف - الصفحة الرئيسية">
          <div className="absolute inset-0 bg-gradient-to-b from-blue-500/10 to-transparent opacity-50 block transition-opacity group-hover:opacity-80" />
          <div className="flex items-center gap-4 relative z-10 w-full">
            <div className="w-11 h-11 rounded-[0.85rem] bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-[0_0_20px_rgba(59,130,246,0.3)] border border-blue-400/20 p-1.5 transition-transform group-hover:scale-105">
              <Image src="/logo.png" alt="" width={32} height={31} priority className="w-full h-full object-contain" />
            </div>
            <div className="flex-1">
              <p className="font-extrabold text-2xl text-white tracking-tight group-hover:text-blue-100 transition-colors">رديف</p>
              <p className="text-[11px] font-black text-blue-400 tracking-[0.3em] uppercase mt-0.5">RADEEF</p>
            </div>
          </div>
        </Link>

        {/* Sidebar Search */}
        <div className="px-5 mb-4 shrink-0">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="بحث في القائمة"
              placeholder="بحث في القائمة السريعة..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              className="w-full bg-white/5 border border-white/5 rounded-xl pl-4 pr-10 py-2.5 text-base md:text-[13px] text-white focus:outline-none focus:border-blue-500/50 focus:bg-white/10 transition-all placeholder:text-slate-500"
            />
          </div>
        </div>

        <nav className="flex-1 px-5 space-y-2 overflow-y-auto w-full pb-6 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-slate-700/50 hover:[&::-webkit-scrollbar-thumb]:bg-slate-600 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full">
          {!menuReady ? (
            error ? (
              <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5 text-center">
                <p className="text-[12px] font-bold text-slate-300">{error}</p>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-[12px] font-black text-white hover:bg-blue-700 transition"
                >
                  <RefreshCw size={14} /> إعادة المحاولة
                </button>
              </div>
            ) : (
              <SidebarSkeleton />
            )
          ) : (
            <>
              {filteredGroups.map((group, idx) => (
                <div key={group.key}>
                  <div className={`px-3 mb-3 ${idx > 0 ? "mt-8" : "mt-2"} text-[10px] font-bold uppercase tracking-widest text-slate-500`}>
                    {group.heading}
                  </div>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <NavItem key={`${group.key}:${item.href}`} item={item} active={item.href === activeHref} />
                    ))}
                  </div>
                </div>
              ))}
              {filteredGroups.length === 0 && (
                <div className="text-center py-10 text-slate-500 text-[12px] font-bold">لا توجد نتائج مطابقة لبحثك</div>
              )}
            </>
          )}
        </nav>

        <div className="p-5 shrink-0">
          <button
            type="button"
            onClick={logout}
            disabled={isLoggingOut}
            className="w-full text-right flex items-center gap-3.5 px-4 py-3.5 rounded-2xl transition-all duration-300 group font-bold text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-60"
          >
            <span className="transition-colors">
              {isLoggingOut ? <Loader2 size={18} className="animate-spin text-rose-500" /> : <LogOut size={18} className="text-rose-500" />}
            </span>
            <span className="text-[13px]">تسجيل الخروج بأمان</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area - Embedded White App Container */}
      <main className="flex-1 min-w-0 flex flex-col h-screen print:h-auto md:py-3 md:pl-3 print:p-0 relative overflow-hidden print:overflow-visible transition-all duration-500 ease-out">
        <div className="flex-1 bg-[#FAFAFA] md:rounded-tr-[2.5rem] md:rounded-bl-[2.5rem] lg:rounded-tl-2xl print:rounded-none flex flex-col overflow-hidden print:overflow-visible relative shadow-2xl print:shadow-none shadow-indigo-900/20 border-r border-t border-white/10 md:border-slate-200 print:border-none">
          {/* Top Header */}
          <header className="h-16 md:h-28 px-4 md:px-10 flex items-center justify-between shrink-0 bg-[#FAFAFA] z-50 relative w-full print:hidden">
            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-label="فتح القائمة"
                aria-controls="app-sidebar"
                aria-expanded={isSidebarOpen}
                className="md:hidden w-12 h-12 flex items-center justify-center bg-white rounded-2xl shadow-sm border border-slate-200 text-slate-800"
                onClick={() => setIsSidebarOpen(true)}
              >
                <Menu size={24} />
              </button>
              <div className="hidden md:flex flex-col">
                <h2 className="text-[1.35rem] font-black text-slate-900 tracking-tight">
                  مرحباً بعودتك{user?.name ? `، ${user.name}` : ""} 👋
                </h2>
                <div className="flex items-center gap-2 mt-1 min-h-[22px]">
                  {role ? (
                    <>
                      <p className="text-[13px] text-slate-500 font-medium">هذه الصلاحيات المعروضة مخصصة لدور:</p>
                      <span className={`px-2 py-0.5 rounded-lg text-[11px] font-black ${ROLE_BADGE[role]}`}>{roleLabel}</span>
                    </>
                  ) : (
                    <span className="h-4 w-56 rounded-md bg-slate-200 animate-pulse" aria-hidden="true" />
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 md:gap-5">
              {canSearch && (
                <form
                  role="search"
                  className="relative hidden md:flex items-center mr-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const q = globalSearch.trim();
                    if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
                  }}
                >
                  <Search className="absolute right-4 text-slate-400" size={18} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="بحث عام"
                    value={globalSearch}
                    onChange={(e) => setGlobalSearch(e.target.value)}
                    placeholder="ابحث عن موظف، مستند... (Enter للبحث)"
                    className="w-[280px] lg:w-[320px] h-12 pl-4 pr-12 rounded-2xl bg-white border border-slate-200 shadow-sm text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-700 placeholder:text-slate-400 font-semibold"
                  />
                </form>
              )}

              {/* Notifications Dropdown */}
              <div className="relative" ref={notificationsRef}>
                <button
                  type="button"
                  aria-label={notifications.length > 0 ? `التنبيهات (${notifications.length})` : "التنبيهات"}
                  aria-haspopup="true"
                  aria-expanded={isNotificationsOpen}
                  onClick={toggleNotifications}
                  className={`relative flex-shrink-0 w-12 h-12 flex items-center justify-center border rounded-2xl shadow-sm transition-all overflow-hidden ${isNotificationsOpen ? "bg-blue-50 border-blue-200 text-blue-600 shadow-blue-100" : "bg-white border-slate-200 text-slate-600 hover:text-blue-600 hover:border-blue-200 hover:shadow-blue-100"}`}
                >
                  <Bell size={20} className={isNotificationsOpen ? "animate-bounce" : ""} />
                  {notifications.length > 0 && (
                    <span className="absolute top-[11px] right-[11px] w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white" aria-hidden="true"></span>
                  )}
                </button>

                {isNotificationsOpen && (
                  <div className="absolute left-0 top-full mt-3 w-80 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 shadow-xl shadow-slate-200/50 rounded-3xl z-50 overflow-hidden divide-y divide-slate-100 p-2 animate-in fade-in slide-in-from-top-4 duration-200">
                    <div className="p-4 bg-slate-50 rounded-2xl flex items-center justify-between mb-2">
                      <h4 className="font-extrabold text-slate-800 text-[14px]">التنبيهات الأخيرة</h4>
                      <span className="bg-blue-100 text-blue-600 text-[11px] font-black px-2 py-1 rounded-lg flex items-center gap-1">
                        {notificationsLoading && <Loader2 size={11} className="animate-spin" />}
                        {notifications.length > 0 ? `${notifications.length} جديدة` : "لا يوجد"}
                      </span>
                    </div>
                    {notifications.length > 0 ? (
                      notifications.map((notif) => (
                        <div key={notif.id} className="p-4 hover:bg-slate-50 transition rounded-xl">
                          <p className="font-bold text-[13px] text-slate-800 flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full block shrink-0 ${NOTIFICATION_DOT[notif.color ?? ""] ?? "bg-blue-500"}`}></span>
                            {notif.title}
                          </p>
                          {notif.subtitle && <p className="text-[11px] font-bold text-slate-500 mt-1">{notif.subtitle}</p>}
                        </div>
                      ))
                    ) : (
                      <div className="p-6 text-center text-slate-400 font-bold text-[12px]">استرح قليلاً، لا توجد مهام معلقة. ☕</div>
                    )}
                    {canViewAlerts && (
                      <div className="p-3 text-center mt-2 border-t border-slate-100/50">
                        <Link href="/unified-alerts" className="text-blue-600 font-black text-[12px] hover:underline">
                          عرض الشاشة الكاملة للتنبيهات
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Profile Dropdown */}
              <div className="relative" ref={profileRef}>
                <button
                  type="button"
                  aria-label="قائمة الحساب"
                  aria-haspopup="true"
                  aria-expanded={isProfileOpen}
                  onClick={() => {
                    setIsProfileOpen(!isProfileOpen);
                    setIsNotificationsOpen(false);
                  }}
                  className={`block w-12 h-12 rounded-2xl overflow-hidden border-2 shadow-md flex-shrink-0 cursor-pointer transition-all ${isProfileOpen ? "border-blue-500 shadow-blue-200 rotate-3" : "border-white bg-white hover:border-blue-100"}`}
                >
                  {user ? (
                    <Avatar name={displayName} avatarUrl={user.avatarUrl} className="w-full h-full" textClassName="text-lg" />
                  ) : (
                    <span className="block w-full h-full bg-slate-200 animate-pulse" />
                  )}
                </button>

                {isProfileOpen && (
                  <div className="absolute left-0 top-full mt-3 w-64 bg-white border border-slate-200 shadow-xl shadow-slate-200/50 rounded-3xl z-50 overflow-hidden p-2 animate-in fade-in slide-in-from-top-4 duration-200">
                    <div className="p-4 border-b border-slate-100 mb-2 flex flex-col gap-2 bg-slate-50 rounded-2xl">
                      <div className="flex items-center gap-4">
                        <Avatar
                          name={displayName}
                          avatarUrl={user?.avatarUrl ?? null}
                          className="w-10 h-10 rounded-xl shadow-sm shrink-0"
                          textClassName="text-sm"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-black text-slate-800 text-[14px] truncate">{displayName}</p>
                          {user?.email && <p className="text-[11px] text-slate-400 font-bold truncate" dir="ltr">{user.email}</p>}
                          {roleLabel && (
                            <p className="font-bold text-blue-600 text-[11px] mt-0.5 bg-blue-50 px-2 py-0.5 rounded-md inline-block">{roleLabel}</p>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!user}
                      onClick={() => {
                        setIsEditProfileOpen(true);
                        setIsProfileOpen(false);
                      }}
                      className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-blue-50 text-slate-700 font-bold text-[13px] transition group disabled:opacity-50"
                    >
                      <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-500 flex items-center justify-center group-hover:scale-110 transition">
                        <Pencil size={16} />
                      </div>
                      تعديل الاسم والصورة
                    </button>
                    <Link
                      href="/portal"
                      className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-50 text-slate-700 font-bold text-[13px] transition group"
                    >
                      <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-500 flex items-center justify-center group-hover:scale-110 transition">
                        <User size={16} />
                      </div>
                      بوابة الموظف الذاتية
                    </Link>
                    {isAdmin && (
                      <Link
                        href="/settings"
                        className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-50 text-slate-700 font-bold text-[13px] transition group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-500 flex items-center justify-center group-hover:scale-110 transition">
                          <Settings size={16} />
                        </div>
                        إعدادات النظام العامة
                      </Link>
                    )}
                    <hr className="my-2 border-slate-100" />
                    <button
                      type="button"
                      onClick={logout}
                      disabled={isLoggingOut}
                      className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-rose-50 text-rose-600 font-bold text-[13px] transition mt-1 group disabled:opacity-60"
                    >
                      <div className="w-8 h-8 rounded-lg bg-rose-50 text-rose-500 flex items-center justify-center group-hover:bg-rose-500 group-hover:text-white transition">
                        {isLoggingOut ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
                      </div>
                      تسجيل الخروج وإنهاء الجلسة
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {isEditProfileOpen && user && (
            <EditProfileModal
              initialName={user.name}
              initialAvatarUrl={user.avatarUrl}
              onClose={() => setIsEditProfileOpen(false)}
              onSaved={refresh}
            />
          )}

          {/* Dynamic Content */}
          <div
            ref={scrollContainerRef}
            id="main-scroll-container"
            className={`flex-1 overflow-y-auto print:overflow-visible px-4 md:px-10 print:px-0 pb-10 print:pb-0 w-full relative ${MOBILE_CONTENT_FIXES}`}
          >
            {pageAccess === "allowed" ? (
              children
            ) : pageAccess === "denied" ? (
              <AccessDenied homeHref={homeHref} roleLabel={roleLabel} />
            ) : (
              <PageGuardPending />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function PageGuardPending() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" aria-busy="true" aria-live="polite">
      <Loader2 size={28} className="animate-spin text-blue-500" aria-hidden="true" />
      <span className="sr-only">جاري التحقق من الصلاحيات</span>
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-8 pt-2" aria-busy="true" aria-label="جاري تحميل القائمة">
      {[0, 1, 2].map((g) => (
        <div key={g} className="space-y-2">
          <div className="mx-3 h-2.5 w-24 rounded bg-white/10 animate-pulse" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3.5 px-4 py-3.5">
              <div className="h-[18px] w-[18px] rounded-md bg-white/10 animate-pulse" />
              <div className="h-3 flex-1 rounded bg-white/10 animate-pulse" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function NavItem({ item, active }: { item: MenuItem; active: boolean }) {
  const itemRef = useRef<HTMLAnchorElement>(null);
  const Icon = MENU_ICONS[item.iconName];

  // Bring the active item into view inside the sidebar only (scrollIntoView would also scroll
  // overflow-hidden ancestors, shifting the layout on mobile where the sidebar is off-canvas).
  useEffect(() => {
    const el = itemRef.current;
    const nav = el?.closest("nav");
    if (!active || !el || !nav) return;
    const itemRect = el.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    if (itemRect.top < navRect.top || itemRect.bottom > navRect.bottom) {
      nav.scrollTop += itemRect.top - navRect.top - navRect.height / 2 + itemRect.height / 2;
    }
  }, [active]);

  const baseClasses = "w-full text-right flex items-center gap-3.5 px-4 py-3.5 rounded-2xl transition-all duration-300 group font-bold";
  const activeClasses = "bg-blue-600/15 text-blue-500 relative shadow-sm";
  const inactiveClasses = "text-slate-400 hover:bg-white/5 hover:text-white";

  return (
    <Link
      ref={itemRef}
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`${baseClasses} ${active ? activeClasses : inactiveClasses}`}
    >
      <span className={`${active ? "text-blue-500" : "text-slate-500 group-hover:text-blue-400"} transition-colors`}>
        <Icon size={18} className={item.iconClassName} />
      </span>
      <span className="text-[13px]">{item.label}</span>
      {active && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-blue-500 rounded-l-full shadow-[0_0_10px_rgba(59,130,246,0.5)]"></div>
      )}
    </Link>
  );
}
