"use client";

// Identity of the signed-in user, loaded once from the server session (GET /api/auth/me).
// The role can no longer be chosen on the client: it always comes from the signed session.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isAppRole, type AppRole } from "@/lib/constants";
import { isPublicPath } from "@/lib/menu";

export type { AppRole };

export interface CurrentUser {
  id: string;
  email: string;
  role: AppRole;
  name: string;
  avatarUrl: string | null;
  employeeId: string | null;
}

export interface RoleContextType {
  /** Role from the server session; null while loading or when signed out. Never defaults to an admin role. */
  role: AppRole | null;
  user: CurrentUser | null;
  /** Menu groups allowed by a custom RolePermission row; null means "use the role defaults". */
  allowedPages: string[] | null;
  loading: boolean;
  /** Set when /api/auth/me failed for a reason other than an expired session. */
  error: string | null;
  /** Re-reads the session (e.g. after editing the profile). */
  refresh: () => Promise<void>;
  /** @deprecated Roles come from the server session. Kept as a no-op for compatibility. */
  setRole: (role: AppRole) => void;
}

const RoleContext = createContext<RoleContextType | undefined>(undefined);

/** Keys written by the old client-side identity scheme. */
const LEGACY_STORAGE_KEYS = ["app_role", "app_user_id", "app_user_name", "radeef_profile"];

interface MeResponse {
  user?: Partial<CurrentUser> & { role?: unknown };
  allowedPages?: unknown;
}

function parseMe(data: MeResponse): { user: CurrentUser; allowedPages: string[] | null } | null {
  const u = data.user;
  if (!u || typeof u.id !== "string" || !isAppRole(u.role)) return null;
  const allowedPages = Array.isArray(data.allowedPages)
    ? data.allowedPages.filter((p): p is string => typeof p === "string")
    : null;
  return {
    user: {
      id: u.id,
      email: typeof u.email === "string" ? u.email : "",
      role: u.role,
      name: typeof u.name === "string" && u.name.trim() ? u.name : typeof u.email === "string" ? u.email.split("@")[0] : "",
      avatarUrl: typeof u.avatarUrl === "string" && u.avatarUrl ? u.avatarUrl : null,
      employeeId: typeof u.employeeId === "string" && u.employeeId ? u.employeeId : null,
    },
    allowedPages: allowedPages && allowedPages.length > 0 ? allowedPages : null,
  };
}

interface IdentityState {
  user: CurrentUser | null;
  allowedPages: string[] | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: IdentityState = { user: null, allowedPages: null, loading: true, error: null };

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = isPublicPath(pathname);
  const [state, setState] = useState<IdentityState>(INITIAL_STATE);
  const requestSeq = useRef(0);

  // Leaving the signed-in area (logout / session expiry) forgets the previous user, so the
  // next sign-in never shows the previous user's menu while /api/auth/me is loading.
  const [wasPublic, setWasPublic] = useState(isPublic);
  if (wasPublic !== isPublic) {
    setWasPublic(isPublic);
    if (isPublic) setState(INITIAL_STATE);
  }

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
      if (seq !== requestSeq.current) return;
      if (res.status === 401) {
        setState({ user: null, allowedPages: null, loading: false, error: null });
        const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
        if (!isPublicPath(here)) {
          router.replace(here && here !== "/" ? `/login?next=${encodeURIComponent(here)}` : "/login");
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseMe((await res.json()) as MeResponse);
      if (seq !== requestSeq.current) return;
      if (!parsed) throw new Error("Invalid /api/auth/me payload");
      setState({ user: parsed.user, allowedPages: parsed.allowedPages, loading: false, error: null });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error("[RoleContext] failed to load the current user", err);
      setState((prev) => ({ ...prev, loading: false, error: "تعذر تحميل بيانات المستخدم" }));
    }
  }, [router]);

  const refresh = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: prev.user === null, error: null }));
    await load();
  }, [load]);

  // Load the identity once per signed-in visit; forget it on public pages (login / logout).
  useEffect(() => {
    if (isPublic) {
      requestSeq.current++;
      return;
    }
    void load();
  }, [isPublic, load]);

  // Remove identity/business data written to localStorage by older versions.
  useEffect(() => {
    try {
      for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const setRole = useCallback(() => {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[RoleContext] setRole() is deprecated: the role comes from the server session.");
    }
  }, []);

  const value = useMemo<RoleContextType>(() => {
    // On public pages nobody is signed in from the client's point of view.
    const user = isPublic ? null : state.user;
    return {
      role: user?.role ?? null,
      user,
      allowedPages: isPublic ? null : state.allowedPages,
      loading: isPublic ? false : state.loading,
      error: isPublic ? null : state.error,
      refresh,
      setRole,
    };
  }, [isPublic, state, refresh, setRole]);

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextType {
  const context = useContext(RoleContext);
  if (!context) {
    throw new Error("useRole must be used within a RoleProvider");
  }
  return context;
}
