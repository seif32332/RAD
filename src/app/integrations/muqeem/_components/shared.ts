// Client-side helpers of the Muqeem control page (labels, API calls). Client-safe.
import { readApiError } from '@/components/ui/feedback';

export { MUQEEM_OPERATION_LABELS, operationLabel } from '@/lib/muqeem-sync';

export const TX_STATUS_LABELS: Record<string, string> = {
  PENDING: 'قيد التنفيذ',
  SUCCEEDED: 'نجحت',
  FAILED: 'فشلت',
  UNKNOWN: 'نتيجة غير معروفة',
};

export const TX_STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-blue-50 text-blue-700 border-blue-200',
  SUCCEEDED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
  UNKNOWN: 'bg-amber-100 text-amber-800 border-amber-300',
};

/** Muqeem user roles on this page. */
export const CONNECTION_TEST_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS'] as const;

export interface MuqeemStatusCompany {
  id: string;
  name: string;
  moiNumber: string | null;
  linked: boolean;
  platformName: string | null;
}

export interface MuqeemStatus {
  enabled: boolean;
  configured: boolean;
  usable: boolean;
  missing: string[];
  canLink: boolean;
  companies: MuqeemStatusCompany[];
  platforms: { id: string; platformName: string }[];
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string; details?: unknown };

/** JSON fetch returning a typed result (never throws). Redirects to /login on 401. */
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
