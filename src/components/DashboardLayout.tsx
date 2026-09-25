"use client";

import React from "react";
import AppShell from "@/components/AppShell";
import { useInsideAppShell } from "@/components/shell/ShellContext";

/**
 * Kept for the ~85 pages that still wrap their content in <DashboardLayout>.
 *
 * The sidebar/header now live in <AppShell>, rendered once by src/app/layout.tsx, so inside it
 * this component is a pass-through and navigating between pages no longer remounts the shell.
 * Outside an AppShell (should not happen) it renders the shell itself.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const insideShell = useInsideAppShell();
  if (insideShell) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}
