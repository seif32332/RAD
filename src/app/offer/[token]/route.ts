// A candidate's job offer, reached from the private link sent at issuance (src/lib/documents/candidate.ts).
//
// A Route Handler like /v/<token>: exact status codes, no app shell, no JavaScript, its own strict
// CSP. GET shows the offer (download link + accept / decline forms); POST records the answer once
// and redirects back (303). The token in the URL is the only credential; it expires with the offer.
import { getClientIp } from '@/lib/auth';
import { answerOffer, candidateOffer, type CandidateOfferView } from '@/lib/documents/candidate';
import { HttpError } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#0f172a;font-family:"Segoe UI",Tahoma,"Noto Sans Arabic",Arial,sans-serif}
main{max-width:34rem;margin:0 auto;padding:2.5rem 1rem}h1{font-size:1.15rem;margin:0 0 1.25rem}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:1.1rem 1.25rem;margin-top:1rem}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid #f1f5f9;font-size:.9rem}.row:last-child{border-bottom:0}
.muted{color:#64748b;font-size:.85rem}.status{border:1px solid;border-radius:.75rem;padding:1rem 1.25rem;margin-top:1rem;font-weight:700}
.ok{background:#ecfdf5;border-color:#a7f3d0;color:#065f46}.no{background:#fef2f2;border-color:#fecaca;color:#991b1b}.warn{background:#fffbeb;border-color:#fde68a;color:#92400e}
a.btn,button{display:inline-block;border:0;border-radius:.6rem;padding:.65rem 1.1rem;font-weight:700;font-size:.9rem;cursor:pointer;text-decoration:none}
a.btn{background:#4f46e5;color:#fff}.accept{background:#059669;color:#fff}.decline{background:#fff;color:#b91c1c;border:1px solid #fecaca}
textarea{width:100%;border:1px solid #cbd5e1;border-radius:.6rem;padding:.6rem;font:inherit;margin:.5rem 0}form{margin:0}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function respond(status: number, html: string) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

const NOT_FOUND = page('عرض وظيفي', '<div class="status no">الرابط غير صحيح أو لم يعد متاحاً.</div>');

function offerPage(token: string, o: CandidateOfferView, notice: string | null): string {
  const base = `/offer/${encodeURIComponent(token)}`;
  const status =
    o.status === 'ACCEPTED' ? `<div class="status ok">قبلتَ هذا العرض بتاريخ ${esc(o.answeredAt ?? '')}. سيتواصل معك قسم الموارد البشرية.</div>`
    : o.status === 'DECLINED' ? `<div class="status no">اعتذرتَ عن هذا العرض بتاريخ ${esc(o.answeredAt ?? '')}.</div>`
    : o.status === 'WITHDRAWN' ? '<div class="status no">سُحب هذا العرض.</div>'
    : o.expired ? `<div class="status warn">انتهت صلاحية هذا العرض في ${esc(o.expiresAt)}.</div>`
    : '';
  const canAnswer = o.status === 'OPEN' && !o.expired;
  return page(o.typeLabelAr, `
<h1>${esc(o.typeLabelAr)} <span class="muted">· ${esc(o.companyAr)}</span></h1>
${notice ? `<div class="status warn">${esc(notice)}</div>` : ''}
<div class="card">
  <div class="row"><span class="muted">إلى</span><span>${esc(o.candidateName)}</span></div>
  <div class="row"><span class="muted">رقم العرض</span><span dir="ltr">${esc(o.number)}</span></div>
  <div class="row"><span class="muted">تاريخ الإصدار</span><span>${esc(o.issuedAt)}</span></div>
  <div class="row"><span class="muted">يسري حتى</span><span>${esc(o.expiresAt)}</span></div>
</div>
${status}
${o.status === 'OPEN' || o.status === 'ACCEPTED' ? `<div class="card"><a class="btn" href="${base}/pdf">تنزيل العرض (PDF)</a><p class="muted">اقرأ العرض كاملاً قبل الرد.</p></div>` : ''}
${canAnswer ? `
<div class="card">
  <form method="post" action="${base}"><input type="hidden" name="decision" value="ACCEPTED">
    <button class="accept" type="submit">أقبل العرض</button>
    <p class="muted">القبول يسجَّل مرة واحدة، ثم يتواصل معك قسم الموارد البشرية لاستكمال التعيين وتوثيق العقد.</p>
  </form>
</div>
<div class="card">
  <form method="post" action="${base}"><input type="hidden" name="decision" value="DECLINED">
    <textarea name="comment" rows="3" maxlength="1000" placeholder="سبب الاعتذار (اختياري)"></textarea>
    <button class="decline" type="submit">أعتذر عن العرض</button>
  </form>
</div>` : ''}
<p class="muted" style="margin-top:1.5rem">هذا الرابط خاص بك؛ لا تشاركه.</p>`);
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = getClientIp(req);
  if (!rateLimit(`documents:offer:${ip}`, 30, 60_000).ok) return respond(429, page('عرض وظيفي', '<div class="status warn">محاولات كثيرة؛ حاول بعد دقيقة.</div>'));
  const o = await candidateOffer(token);
  if (!o) return respond(404, NOT_FOUND);
  const done = new URL(req.url).searchParams.get('done');
  return respond(200, offerPage(token, o, done === 'dup' ? 'سُجّل ردك على هذا العرض مسبقاً.' : null));
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = getClientIp(req);
  if (!rateLimit(`documents:offer-answer:${ip}`, 10, 10 * 60_000).ok) return respond(429, page('عرض وظيفي', '<div class="status warn">محاولات كثيرة؛ حاول لاحقاً.</div>'));
  const form = await req.formData().catch(() => null);
  const decision = form?.get('decision');
  const comment = String(form?.get('comment') ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null;
  if (decision !== 'ACCEPTED' && decision !== 'DECLINED') return respond(400, page('عرض وظيفي', '<div class="status no">طلب غير صالح.</div>'));
  const back = `/offer/${encodeURIComponent(token)}`;
  try {
    await answerOffer(token, decision, decision === 'DECLINED' ? comment : null, ip === 'unknown' ? null : ip);
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return new Response(null, { status: 303, headers: { Location: `${back}?done=dup` } });
    if (e instanceof HttpError && e.status === 404) return respond(404, NOT_FOUND);
    if (e instanceof HttpError) return respond(e.status, page('عرض وظيفي', `<div class="status no">${esc(e.message)}</div>`));
    throw e;
  }
  return new Response(null, { status: 303, headers: { Location: back } });
}
