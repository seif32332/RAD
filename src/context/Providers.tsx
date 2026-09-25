"use client";

import { RoleProvider } from "./RoleContext";
import { FeedbackHost } from "@/components/ui/feedback";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <RoleProvider>
      {children}
      <FeedbackHost />
    </RoleProvider>
  );
}
