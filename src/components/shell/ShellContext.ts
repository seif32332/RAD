"use client";

import { createContext, useContext } from "react";

/**
 * True for everything rendered below <AppShell> (src/app/layout.tsx). DashboardLayout uses it
 * to become a pass-through, so the sidebar/header are mounted once instead of on every page.
 */
export const ShellContext = createContext<boolean>(false);

export function useInsideAppShell(): boolean {
  return useContext(ShellContext);
}
