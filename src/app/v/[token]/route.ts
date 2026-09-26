// Public verification of an issued document (ADR DOC-06), reached from the QR code.
//
// A Route Handler, not a page: it returns exact status codes (200 / 404 / 429; the app's root
// loading boundary would stream a page with 200 before notFound()), ships no JavaScript bundle and
// no app shell, and sends its own strict CSP. The only script is the in-browser file check,
// allowed by its SHA-256 hash. Minimal, deliberate metadata: no personal data.
import { createHash } from 'crypto';
import { getClientIp } from '@/lib/auth';
import { formatGregorian } from '@/lib/documents/format';
import { verifyDocumentToken, type PublicVerification } from '@/lib/documents/service';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Compares the chosen PDF with data-sha (SHA-256 in the browser; the file is never uploaded). */
const FILE_CHECK_JS = `(() => {
  const input = document.getElementById('pdf');
  const out = document.getElementById('check-result');
  if (!input || !out) return;
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
      const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
      const ok = hex === input.dataset.sha;
      out.className = ok ? 'result ok' : 'result bad';
      out.textContent = ok ? 'الملف مطابق للمستند الصادر.' : 'الملف لا يطابق المستند الصادر؛ قد يكون معدَّلاً أو نسخة أخرى.';
    } catch {
      out.className = 'result warn';
      out.textContent = 'تعذرت قراءة الملف في هذا المتصفح.';
    }
  });
})();`;
const SCRIPT_HASH = `sha256-${createHash('sha256').update(FILE_CHECK_JS).digest('base64')}`;

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#0f172a;font-family:"Segoe UI",Tahoma,"Noto Sans Arabic",Arial,sans-serif}
main{max-width:34rem;margin:0 auto;padding:2.5rem 1rem}h1{font-size:1.1rem;margin:0 0 1.5rem;color:#475569}h1 small{color:#94a3b8;font-weight:400}
.status{border:1px solid;border-radius:.75rem;padding:1.1rem 1.25rem}.status b{display:block;font-size:1.15rem}.status span{font-size:.85rem;opacity:.8}
.VALID{background:#ecfdf5;border-color:#a7f3d0;color:#065f46}.EXPIRED,.SUPERSEDED{background:#fffbeb;border-color:#fde68a;color:#92400e}
.REVOKED,.missing{background:#fef2f2;border-color:#fecaca;color:#991b1b}.PURGED{background:#f8fafc;border-color:#e2e8f0;color:#334155}
dl{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:0 1.25rem;margin:1rem 0 0}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 0;border-bottom:1px solid #f1f5f9}.row:last-child{border-bottom:0}
dt{color:#64748b;font-size:.85rem}dd{margin:0;font-size:.9rem;font-weight:600;text-align:left}dd small{display:block;color:#64748b;font-weight:400}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:1.1rem 1.25rem;margin-top:1rem}.card label{font-weight:700;cursor:pointer}
.card p{color:#64748b;font-size:.85rem;margin:.35rem 0 0}.result{margin-top:.75rem;font-size:.9rem}.ok{color:#047857}.bad{color:#b91c1c}.warn{color:#b45309}
.note{color:#64748b;font-size:.75rem;line-height:1.7;margin-top:1.5rem}input[type=file]{margin-top:.6rem;font-size:.85rem;max-width:100%}`;

const STATUS: Record<PublicVerification['status'], [string, string]> = {
  VALID: ['مستند ساري', 'Valid document'],
  EXPIRED: ['انتهت صلاحية المستند', 'Expired'],
  REVOKED: ['المستند ملغى', 'Revoked'],
  SUPERSEDED: ['المستند مستبدل بإصدار أحدث', 'Superseded by a newer issue'],
  PURGED: ['انتهت مدة الاحتفاظ بالمستند', 'Retention period ended'],
};

function page(body: string, withScript: boolean): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>التحقق من مستند</title><style>${CSS}</style></head>
<body><main><h1>التحقق من صحة مستند <small dir="ltr">· Document verification</small></h1>${body}</main>${withScript ? `<script>${FILE_CHECK_JS}</script>` : ''}</body></html>`;
}

const row = (label: string, value: string, en?: string | null) =>
  `<div class="row"><dt>${esc(label)}</dt><dd>${esc(value)}${en ? `<small dir="ltr">${esc(en)}</small>` : ''}</dd></div>`;

function respond(status: number, html: string) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src '${SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = getClientIp(req);
  if (!rateLimit(`documents:verify:${ip}`, 30, 60_000).ok) {
    return respond(429, page('<div class="status missing"><b>محاولات كثيرة من هذا الجهاز؛ حاول بعد دقيقة.</b></div>', false));
  }
  const r = await verifyDocumentToken(token, ip === 'unknown' ? null : ip);
  if (!r) {
    return respond(404, page('<div class="status missing"><b>لم يُعثر على مستند بهذا الرمز.</b><span>تأكد من مسح رمز QR الموجود على المستند نفسه. <span dir="ltr">No document matches this code.</span></span></div>', false));
  }
  const [ar, en] = STATUS[r.status];
  const body = `
<div class="status ${r.status}"><b>${esc(ar)}</b><span dir="ltr">${esc(en)}</span></div>
<dl>
${row('نوع المستند', r.typeLabelAr, r.typeLabelEn)}
${row('رقم المستند', r.number)}
${row('الجهة المُصدرة', r.issuerAr, r.issuerEn)}
${row('تاريخ الإصدار', formatGregorian(r.issuedAt, 'ar'), formatGregorian(r.issuedAt, 'en'))}
${row('صالح حتى', r.validUntil ? formatGregorian(r.validUntil, 'ar') : 'بلا تاريخ انتهاء', r.validUntil ? formatGregorian(r.validUntil, 'en') : 'No expiry')}
${r.revokedAt ? row('تاريخ الإلغاء', formatGregorian(r.revokedAt, 'ar')) : ''}
</dl>
${r.pdfSha256 ? `<div class="card"><label for="pdf">مطابقة الملف <small dir="ltr">Check the PDF file</small></label>
<p>اختر ملف الـPDF الذي استلمته للتحقق من أنه مطابق تماماً للمستند الصادر.</p>
<input id="pdf" type="file" accept="application/pdf,.pdf" data-sha="${esc(r.pdfSha256)}"><div id="check-result" class="result" role="status"></div></div>` : ''}
<p class="note">تعرض هذه الصفحة حالة المستند وبياناته الأساسية فقط، ولا تعرض أي بيانات شخصية. للتأكد من أن الملف الذي بين يديك لم يُعدَّل، استخدم «مطابقة الملف»: تتم المطابقة داخل متصفحك ولا يُرفع الملف.</p>`;
  return respond(200, page(body, !!r.pdfSha256));
}
