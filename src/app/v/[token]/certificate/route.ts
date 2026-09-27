// Public certificate that sealed a document (the verification page links here): lets a recipient
// trust the issuer's self-issued certificate in Acrobat. The certificate is public data; the token
// only selects which one, and an unknown token or an unsealed document is a plain 404.
import { getClientIp } from '@/lib/auth';
import { sealCertificateForToken } from '@/lib/documents/service';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!rateLimit(`documents:verify:${getClientIp(req)}`, 30, 60_000).ok) return new Response('Too many requests', { status: 429 });
  const cert = await sealCertificateForToken(token);
  if (!cert) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(new Uint8Array(cert.certDer), {
    headers: {
      'Content-Type': 'application/pkix-cert',
      'Content-Disposition': `attachment; filename="${cert.number}-seal.cer"`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
