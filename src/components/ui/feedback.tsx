"use client";

// Imperative toast + confirm/prompt dialogs that replace window.alert/confirm/prompt.
//
//   import { toast, confirmDialog, promptDialog } from '@/components/ui/feedback';
//   toast.success('تم الحفظ');            toast.error('فشل الحفظ');      toast('معلومة');
//   if (!(await confirmDialog('هل أنت متأكد من الحذف؟', { danger: true }))) return;
//   const name = await promptDialog('اسم الجنسية الجديدة'); if (name === null) return;
//
// <FeedbackHost /> is mounted once in src/context/Providers.tsx.

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
interface DialogOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
}
interface DialogRequest extends DialogOptions {
  id: number;
  type: 'confirm' | 'prompt';
  message: string;
  resolve: (value: boolean | string | null) => void;
}

type Listener = () => void;
let toasts: ToastItem[] = [];
let dialogs: DialogRequest[] = [];
const listeners = new Set<Listener>();
let seq = 0;
const emit = () => listeners.forEach((l) => l());

function pushToast(kind: ToastKind, message: unknown) {
  const text = typeof message === 'string' ? message : message instanceof Error ? message.message : String(message ?? '');
  if (!text) return;
  const id = ++seq;
  toasts = [...toasts, { id, kind, message: text }].slice(-5);
  emit();
  setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4000);
}

function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

type ToastFn = ((message: unknown) => void) & {
  success: (message: unknown) => void;
  error: (message: unknown) => void;
  info: (message: unknown) => void;
  warning: (message: unknown) => void;
};

export const toast: ToastFn = Object.assign((message: unknown) => pushToast('info', message), {
  success: (m: unknown) => pushToast('success', m),
  error: (m: unknown) => pushToast('error', m),
  info: (m: unknown) => pushToast('info', m),
  warning: (m: unknown) => pushToast('warning', m),
});

function openDialog(type: 'confirm' | 'prompt', message: string, opts: DialogOptions = {}) {
  return new Promise<boolean | string | null>((resolve) => {
    if (typeof window === 'undefined') return resolve(type === 'confirm' ? false : null);
    dialogs = [...dialogs, { id: ++seq, type, message, resolve, ...opts }];
    emit();
  });
}

/** Resolves true if the user confirms, false otherwise. */
export function confirmDialog(message: string, opts?: DialogOptions): Promise<boolean> {
  return openDialog('confirm', message, opts) as Promise<boolean>;
}

/** Resolves the entered text, or null if cancelled. */
export function promptDialog(message: string, opts?: DialogOptions): Promise<string | null> {
  return openDialog('prompt', message, opts) as Promise<string | null>;
}

/** Extracts a readable Arabic error message from a fetch Response (JSON {message|error}). */
export async function readApiError(res: Response, fallback = 'حدث خطأ غير متوقع'): Promise<string> {
  try {
    const data = await res.clone().json();
    return data?.message || data?.error || fallback;
  } catch {
    return fallback;
  }
}

const KIND_STYLE: Record<ToastKind, { box: string; icon: React.ReactNode }> = {
  success: { box: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: <CheckCircle2 size={18} className="text-emerald-600 shrink-0" /> },
  error: { box: 'border-rose-200 bg-rose-50 text-rose-800', icon: <XCircle size={18} className="text-rose-600 shrink-0" /> },
  info: { box: 'border-blue-200 bg-blue-50 text-blue-800', icon: <Info size={18} className="text-blue-600 shrink-0" /> },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-800', icon: <AlertTriangle size={18} className="text-amber-600 shrink-0" /> },
};

export function FeedbackHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const active = dialogs[0];

  return (
    <>
      <div className="fixed bottom-4 left-4 z-[10000] flex flex-col gap-2 w-[min(92vw,380px)] print:hidden" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg text-[13px] font-bold ${KIND_STYLE[t.kind].box}`}>
            {KIND_STYLE[t.kind].icon}
            <span className="flex-1 whitespace-pre-line leading-6">{t.message}</span>
            <button type="button" aria-label="إغلاق" onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100">
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      {active && <DialogView key={active.id} req={active} />}
    </>
  );
}

function DialogView({ req }: { req: DialogRequest }) {
  const [value, setValue] = useState(req.defaultValue ?? '');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = (result: boolean | string | null) => {
    dialogs = dialogs.filter((d) => d.id !== req.id);
    emit();
    req.resolve(result);
  };
  const cancel = () => close(req.type === 'confirm' ? false : null);
  const ok = () => close(req.type === 'confirm' ? true : value.trim() === '' ? null : value.trim());

  useEffect(() => {
    (req.type === 'prompt' ? inputRef.current : confirmRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[10001] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={cancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`dlg-${req.id}`}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`dlg-${req.id}`} className="text-[16px] font-black text-slate-800 mb-2">
          {req.title ?? (req.type === 'confirm' ? 'تأكيد الإجراء' : 'إدخال قيمة')}
        </h2>
        <p className="text-[14px] text-slate-600 font-semibold whitespace-pre-line leading-7">{req.message}</p>
        {req.type === 'prompt' && (
          <input
            ref={inputRef}
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ok();
            }}
            className="mt-4 w-full h-11 rounded-xl border border-slate-200 px-4 text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
        <div className="mt-6 flex gap-3 justify-start">
          <button
            ref={confirmRef}
            type="button"
            onClick={ok}
            className={`h-11 px-6 rounded-xl text-white font-black text-[14px] ${req.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {req.confirmText ?? 'تأكيد'}
          </button>
          <button type="button" onClick={cancel} className="h-11 px-6 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[14px]">
            {req.cancelText ?? 'إلغاء'}
          </button>
        </div>
      </div>
    </div>
  );
}
