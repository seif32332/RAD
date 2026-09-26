// The offer PDF through the candidate's private link (until it expires, while the offer stands).
import { getClientIp } from '@/lib/auth';
import { candidateOfferPdf } from '@/lib/documents/candidate';
import { HttpError } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = getClientIp(req);
  if (!rateLimit(`documents:offer:${ip}`, 30, 60_000).ok) return new Response('Too many requests', { status: 429 });
  try {
    const out = await candidateOfferPdf(token, ip === 'unknown' ? null : ip);
    if (!out) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new Response(new Uint8Array(out.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(out.pdf.length),
        'Content-Disposition': `attachment; filename="${out.fileName}"`,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof HttpError) return new Response(e.message, { status: e.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    throw e;
  }
}
