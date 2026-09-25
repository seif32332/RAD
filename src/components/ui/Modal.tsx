"use client";

// Accessible modal dialog (DEC-010 item 6).
//
//   <Modal open={isOpen} onClose={() => setOpen(false)} title="تقديم طلب إجازة" tone="blue" icon={<CalendarClock size={22} />}>
//     <form>…</form>
//   </Modal>
//
// - role="dialog" + aria-modal + aria-labelledby (the visible title) + aria-describedby (description).
// - Focus moves into the dialog on open (initialFocusRef, else the first field of the body) and is
//   restored to the element that opened it on close.
// - Tab / Shift+Tab are trapped inside the dialog; focus that escapes (e.g. a click on the backdrop)
//   is pulled back. A dialog stacked on top (confirmDialog from ui/feedback) is left alone.
// - Escape, the close button and a backdrop click close it, unless `busy` (e.g. while submitting).
// - Rendered in a portal on <body>; a bottom sheet on phones, centred from `sm` up. Fields inside
//   use a 16px font on phones so iOS Safari does not zoom in on focus.

import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { FOCUSABLE_SELECTOR, trapTabIndex } from './focus-trap';

export type ModalTone = 'blue' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'cyan' | 'slate';
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

/** Static class lists (Tailwind cannot see dynamically built class names). */
const TONE: Record<ModalTone, { header: string; sub: string; close: string }> = {
  blue: { header: 'bg-blue-600', sub: 'text-blue-100', close: 'hover:bg-blue-500 focus-visible:ring-white/70' },
  emerald: { header: 'bg-emerald-600', sub: 'text-emerald-100', close: 'hover:bg-emerald-500 focus-visible:ring-white/70' },
  amber: { header: 'bg-amber-600', sub: 'text-amber-50', close: 'hover:bg-amber-500 focus-visible:ring-white/70' },
  rose: { header: 'bg-rose-600', sub: 'text-rose-100', close: 'hover:bg-rose-500 focus-visible:ring-white/70' },
  indigo: { header: 'bg-indigo-600', sub: 'text-indigo-100', close: 'hover:bg-indigo-500 focus-visible:ring-white/70' },
  cyan: { header: 'bg-cyan-700', sub: 'text-cyan-50', close: 'hover:bg-cyan-600 focus-visible:ring-white/70' },
  slate: { header: 'bg-slate-800', sub: 'text-slate-300', close: 'hover:bg-slate-700 focus-visible:ring-white/70' },
};

const SIZE: Record<ModalSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-xl',
  xl: 'sm:max-w-3xl',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the accessible name of the dialog. */
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: ModalTone;
  size?: ModalSize;
  /** While true, Escape / backdrop / close button do nothing (e.g. while a request is in flight). */
  busy?: boolean;
  /** Close when the dimmed backdrop is clicked (default true). */
  closeOnBackdrop?: boolean;
  /** Element to focus on open; defaults to the first focusable element of the body. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Content between the header and the scrolling body (e.g. a summary bar). */
  headerExtra?: React.ReactNode;
  closeLabel?: string;
  children: React.ReactNode;
}

export default function Modal(props: ModalProps) {
  if (!props.open || typeof document === 'undefined') return null;
  return createPortal(<ModalPanel {...props} />, document.body);
}

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

function ModalPanel({
  onClose,
  title,
  description,
  icon,
  tone = 'blue',
  size = 'md',
  busy = false,
  closeOnBackdrop = true,
  initialFocusRef,
  headerExtra,
  closeLabel = 'إغلاق',
  children,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Latest callbacks for the listeners registered once on mount.
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  });
  const requestClose = useCallback(() => {
    if (!busyRef.current) onCloseRef.current();
  }, []);

  // Focus in on open, restore on close; lock the page scroll container behind the dialog.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstField = bodyRef.current
      ? Array.from(bodyRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(isVisible)
      : undefined;
    (initialFocusRef?.current ?? firstField ?? panelRef.current)?.focus();

    const scroller = document.getElementById('main-scroll-container');
    const previousOverflow = scroller?.style.overflow ?? '';
    if (scroller) scroller.style.overflow = 'hidden';

    return () => {
      if (scroller) scroller.style.overflow = previousOverflow;
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, [initialFocusRef]);

  // Pull back focus that escapes the dialog (click on the backdrop, programmatic focus...).
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const panel = panelRef.current;
      const target = e.target;
      if (!panel || !(target instanceof Node) || panel.contains(target)) return;
      // Another dialog stacked on top (confirmDialog / promptDialog) owns the focus.
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return;
      panel.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = trapTabIndex(active ? items.indexOf(active) : -1, items.length, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    (next < 0 ? panel : items[next]).focus();
  };

  const t = TONE[tone];

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center sm:p-4 bg-slate-900/60 backdrop-blur-sm"
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`bg-white w-full ${SIZE[size]} rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92dvh] sm:max-h-[90vh] flex flex-col overflow-hidden focus:outline-none max-sm:[&_input]:text-base max-sm:[&_select]:text-base max-sm:[&_textarea]:text-base`}
      >
        <div className={`${t.header} px-5 py-4 sm:p-6 flex justify-between items-start gap-3 text-white shrink-0`}>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg sm:text-xl font-black flex items-center gap-2 leading-snug">
              {icon && <span className="shrink-0" aria-hidden="true">{icon}</span>}
              <span>{title}</span>
            </h2>
            {description && (
              <p id={descId} className={`${t.sub} text-xs font-bold mt-1`}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={requestClose}
            disabled={busy}
            className={`shrink-0 p-2 rounded-full transition focus:outline-none focus-visible:ring-2 disabled:opacity-50 ${t.close}`}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {headerExtra && <div className="shrink-0">{headerExtra}</div>}
        <div ref={bodyRef} className="overflow-y-auto overscroll-contain flex-1 min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
