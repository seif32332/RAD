"use client";

// Bottom tab bar of the employee portal on phones (DEC-005): jumps between the portal sections
// inside the shell's scroll container and highlights the section currently on screen.

import React, { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface PortalTab {
  /** id of the section element the tab scrolls to */
  id: string;
  label: string;
  icon: LucideIcon;
}

export default function PortalTabBar({ tabs }: { tabs: readonly PortalTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const root = document.getElementById('main-scroll-container');
    const targets = tabs.map((t) => document.getElementById(t.id)).filter((el): el is HTMLElement => !!el);
    if (targets.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      // A section counts as "current" while it crosses the upper 40% of the viewport.
      { root, rootMargin: '0px 0px -60% 0px', threshold: 0 },
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [tabs]);

  const go = (id: string) => {
    setActive(id);
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Move keyboard / screen-reader focus to the section too.
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  };

  return (
    <nav
      aria-label="أقسام بوابة الموظف"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-4px_20px_rgba(15,23,42,0.06)] pb-[env(safe-area-inset-bottom)] print:hidden"
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.id;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => go(t.id)}
                aria-current={isActive ? 'location' : undefined}
                className={`w-full min-h-[58px] flex flex-col items-center justify-center gap-1 text-[11px] font-black transition focus:outline-none focus-visible:bg-emerald-50 ${isActive ? 'text-emerald-700' : 'text-slate-500'}`}
              >
                <Icon size={21} aria-hidden="true" className={isActive ? 'text-emerald-600' : 'text-slate-400'} />
                {t.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
