// Client-safe labels and types for the documents screens (portal card, HR page, settings).

export interface DocView {
  id: string;
  number: string;
  issuedAt: string;
  validUntil: string | null;
  status: string;
  validity: 'VALID' | 'EXPIRED' | 'REVOKED' | 'SUPERSEDED' | 'PURGED';
  revokeReason: string | null;
}

export interface ProcessingView {
  status: string;
  lastError: string | null;
  attempts: number;
  number: string;
}

export const REQUEST_STATUS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'قيد التجهيز', tone: 'bg-slate-50 text-slate-600 border-slate-200' },
  PENDING_APPROVAL: { label: 'بانتظار الاعتماد', tone: 'bg-amber-50 text-amber-700 border-amber-200' },
  APPROVED: { label: 'قيد الإصدار', tone: 'bg-blue-50 text-blue-700 border-blue-200' },
  ISSUED: { label: 'صدر', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  REJECTED: { label: 'مرفوض', tone: 'bg-red-50 text-red-700 border-red-200' },
  CANCELLED: { label: 'ملغى', tone: 'bg-slate-50 text-slate-500 border-slate-200' },
};

export const VALIDITY: Record<DocView['validity'], { label: string; tone: string }> = {
  VALID: { label: 'ساري', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  EXPIRED: { label: 'منتهي الصلاحية', tone: 'bg-amber-50 text-amber-700 border-amber-200' },
  REVOKED: { label: 'ملغى', tone: 'bg-red-50 text-red-700 border-red-200' },
  SUPERSEDED: { label: 'مستبدل', tone: 'bg-slate-50 text-slate-600 border-slate-200' },
  PURGED: { label: 'انتهى الاحتفاظ', tone: 'bg-slate-50 text-slate-500 border-slate-200' },
};

/** Technical render state, shown only while a document is being produced (DOC-08). */
export function processingLabel(p: ProcessingView | null): string | null {
  if (!p) return null;
  if (p.status === 'BLOCKED') return 'تعذر الإصدار؛ يلزم تدخل الموارد البشرية';
  if (p.status === 'FAILED') return 'خدمة الإصدار غير متاحة مؤقتاً؛ ستُعاد المحاولة تلقائياً';
  return 'جارٍ تجهيز المستند';
}

export const pdfUrl = (documentId: string, inline = false) => `/api/documents/${encodeURIComponent(documentId)}/pdf${inline ? '?inline=1' : ''}`;
