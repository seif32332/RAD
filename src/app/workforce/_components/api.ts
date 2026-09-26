"use client";

// Client-side fetch helpers of the workforce pages. Never throws; redirects to /login on 401.
import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiError } from '@/components/ui/feedback';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string; details?: unknown };

export async function callApi<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  try {
    const { json, ...rest } = init ?? {};
    const res = await fetch(url, {
      cache: 'no-store',
      ...rest,
      ...(json !== undefined
        ? { method: rest.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) }, body: JSON.stringify(json) }
        : {}),
    });
    if (res.status === 401) {
      window.location.href = '/login';
      return { ok: false, status: 401, message: 'انتهت الجلسة' };
    }
    if (!res.ok) {
      let details: unknown;
      try {
        details = (await res.clone().json())?.details;
      } catch {
        details = undefined;
      }
      return { ok: false, status: res.status, message: await readApiError(res), details };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0, message: 'تعذر الاتصال بالخادم' };
  }
}

/** GET `url` whenever it changes (null = do not load). Keeps the previous data while reloading. */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Key of the last finished request: loading = the current key has not finished yet. */
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const seq = useRef(0);
  const key = url ? `${url}#${tick}` : null;

  useEffect(() => {
    if (!url || !key) return;
    const id = ++seq.current;
    let active = true;
    void callApi<T>(url).then((res) => {
      if (!active || id !== seq.current) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.message);
      }
      setDoneKey(key);
    });
    return () => {
      active = false;
    };
  }, [url, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading: !!key && doneKey !== key, reload, setData };
}

/** Starts a download of `text` as `filename` (CSV export). */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
