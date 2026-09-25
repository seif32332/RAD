"use client";

// Client-side helpers for POST /api/upload (shared by FileUploadField and the profile editor).

import { readApiError } from "@/components/ui/feedback";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_UPLOAD_ACCEPT = ".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx";

/** Returns true when the file matches an `accept` attribute value (".pdf,image/*,..."). */
export function matchesAccept(file: File, accept: string): boolean {
  const tokens = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

/** Returns an Arabic error message, or null when the file may be uploaded. */
export function validateUploadFile(file: File, accept: string = DEFAULT_UPLOAD_ACCEPT): string | null {
  if (file.size === 0) return "الملف فارغ";
  if (file.size > MAX_UPLOAD_BYTES) return "حجم الملف يتجاوز الحد المسموح (10 ميجابايت)";
  if (!matchesAccept(file, accept)) return "نوع الملف غير مسموح. الأنواع المسموحة: " + accept.replace(/,/g, "، ");
  return null;
}

export interface UploadResult {
  url: string;
  fileName: string;
}

/** Where the uploaded document belongs; drives its access category on the server (see /api/files). */
export interface UploadContext {
  /** Record field the file is for, e.g. "iqamaCopyUrl" (identity / passport / health / bank / contract). */
  field?: string;
  /** Employee.id the document belongs to (staff uploading on behalf of an employee). */
  employeeId?: string | null;
}

/** Uploads a file; throws an Error with a user-facing Arabic message on failure. */
export async function uploadFile(file: File, context: UploadContext = {}): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (context.field) formData.append("field", context.field);
  if (context.employeeId) formData.append("employeeId", context.employeeId);
  let res: Response;
  try {
    res = await fetch("/api/upload", { method: "POST", body: formData });
  } catch {
    throw new Error("تعذر الاتصال بالخادم، تحقق من الاتصال وحاول مرة أخرى");
  }
  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.assign("/login");
    throw new Error("انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى");
  }
  if (!res.ok) throw new Error(await readApiError(res, "فشل في رفع الملف"));
  const data = (await res.json().catch(() => null)) as { url?: unknown; fileName?: unknown } | null;
  if (!data || typeof data.url !== "string" || !data.url) throw new Error("فشل في رفع الملف");
  return { url: data.url, fileName: typeof data.fileName === "string" && data.fileName ? data.fileName : file.name };
}

/** Best-effort display name for an already-stored file URL (e.g. "/uploads/1712_contract.pdf"). */
export function fileNameFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const clean = url.split(/[?#]/)[0];
    const last = decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1));
    // Uploaded files are stored as "<timestamp>_<original name>".
    return last.replace(/^\d{10,}_/, "") || last;
  } catch {
    return "";
  }
}
