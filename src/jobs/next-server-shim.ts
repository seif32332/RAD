// Stand-in for `next/server` inside the job bundle only (scripts/build-jobs.mjs SHIMS). Jobs never answer
// HTTP, but shared modules they load (src/lib/http.ts, reached through iam and platform) import
// NextResponse when they are loaded, and the runtime image ships the Next standalone server, not the
// `next/server` entry. Nothing in a job builds a response; if something did, this still behaves like
// a Web Response.
export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }
}

export class NextRequest extends Request {}
