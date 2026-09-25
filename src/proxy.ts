import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

/** Pages reachable without a session. */
const PUBLIC_PAGE_PREFIXES = ['/login', '/apply'];

/** API routes reachable without a session (each one enforces its own limits). */
const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/health',
  '/api/apply', // public job application form
  '/api/upload', // the route itself only allows restricted anonymous uploads for job applications
];

/** Static assets in /public that the login page needs. */
const PUBLIC_ASSET = /^\/(?:logo\.png|manifest\.webmanifest|icons\/[\w.-]+\.png|[\w-]+\.svg|icon(?:\.\w+)?|robots\.txt|templates\/[\w.-]+)$/;

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  if (PUBLIC_ASSET.test(pathname)) return NextResponse.next();

  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);

  if (isApi) {
    if (session || matchesPrefix(pathname, PUBLIC_API_PREFIXES)) return NextResponse.next();
    return NextResponse.json({ message: 'يجب تسجيل الدخول أولاً', error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const isPublicPage = matchesPrefix(pathname, PUBLIC_PAGE_PREFIXES);

  if (!session && !isPublicPage) {
    const url = new URL('/login', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname + search);
    const res = NextResponse.redirect(url);
    // Clean up cookies from the old (insecure) auth scheme.
    res.cookies.delete('isLoggedIn');
    res.cookies.delete('userId');
    return res;
  }

  // Note: /login is NOT redirected for signed cookies. The proxy only checks the signature; a
  // session revoked server-side (logout elsewhere, password reset, deactivation) would otherwise
  // loop between /login and '/'. The login page asks /api/auth/me and redirects when truly valid.

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals. /uploads/* IS matched so legacy file URLs require a session.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
