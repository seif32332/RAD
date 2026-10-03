// Radeef's vendor CLI on a tenant host (BL-PAY-017 / BL-PAY-022). radeef-manage (the vendor panel) runs it over
// SSH inside the tenant's app directory with the tenant's environment, and sends ONE JSON request on stdin
// (never on the command line: it may carry a national id):
//
//   cd <app> && set -a && . ./.env && set +a && node scripts/vendor.mjs < request.json
//
//   { "command": "status" | "set-root" | "suspend-root" | "register-person" | "revoke-person" | "link-person"
//                | "invite-person" | "set-owner-contact" | "release-code",
//     "operator": "<radeef-manage user>", "requestId": "<hex, one per submission>", "requestRef": "<owner request>",
//     …the command's fields }
//
// It answers ONE JSON line on stdout: { "ok": true, "result": … } or { "ok": false, "status": 4xx|500, "error": "…" }.
// Exit codes: 0 ok, 1 refused or failed, 2 usage. The same requestId is the same operation (a retry replays it).
// iam's own entry point (inside the module: it reads the vendor transitions, which index.ts does not export).
// Built into dist/vendor/vendor.cjs by scripts/build-jobs.mjs; a CLI, never an HTTP endpoint (DEC-009).
// Nothing is logged; the only secret ever written is release-code's code, on the first call only, to stdout
// (the SSH channel to the panel, which shows it once to its operator).
//
// No static value import on purpose: the Prisma pool is capped in DATABASE_URL before the client is created.

/** Prisma pool of a vendor CLI process (like a job: tenants x pools must fit max_connections). */
export const VENDOR_CONNECTION_LIMIT = 2;

export const VENDOR_COMMANDS = [
  'status',
  'set-root',
  'suspend-root',
  'register-person',
  'revoke-person',
  'link-person',
  'invite-person',
  'set-owner-contact',
  'release-code',
] as const;
export type VendorCommand = (typeof VENDOR_COMMANDS)[number];

type Env = Record<string, string | undefined>;
type Out = { write: (line: string) => void };

function withConnectionLimit(url: string, limit = VENDOR_CONNECTION_LIMIT): string {
  const [base, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !p.startsWith('connection_limit='));
  params.push(`connection_limit=${limit}`);
  return `${base}?${params.join('&')}`;
}

const REQUEST_ID = /^[a-f0-9]{16,64}$/;

/** Parses the request (pure): the command and its validated common fields. */
export function parseVendorRequest(raw: string): { command: VendorCommand; operator: string; requestId: string; requestRef: string; body: Record<string, unknown> } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON request'), { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('invalid request'), { status: 400 });
  const b = body as Record<string, unknown>;
  const command = String(b.command ?? '') as VendorCommand;
  if (!(VENDOR_COMMANDS as readonly string[]).includes(command)) throw Object.assign(new Error('unknown command'), { status: 400 });
  const requestId = String(b.requestId ?? '');
  if (command !== 'status' && !REQUEST_ID.test(requestId)) throw Object.assign(new Error('requestId must be 16-64 lowercase hex'), { status: 400 });
  return { command, operator: String(b.operator ?? ''), requestId, requestRef: String(b.requestRef ?? ''), body: b };
}

function reply(out: Out, value: unknown): void {
  out.write(`${JSON.stringify(value)}\n`);
}

export async function main(stdin: string, env: Env = process.env, out: Out = { write: (l) => process.stdout.write(l) }): Promise<number> {
  let req: ReturnType<typeof parseVendorRequest>;
  try {
    req = parseVendorRequest(stdin);
  } catch (err) {
    reply(out, { ok: false, status: 400, error: (err as Error).message });
    return 2;
  }
  if (!env.DATABASE_URL) {
    reply(out, { ok: false, status: 500, error: 'DATABASE_URL is not set (load the tenant .env)' });
    return 2;
  }
  env.DATABASE_URL = withConnectionLimit(env.DATABASE_URL);

  const [{ prisma }, { runIdentityTransaction }, vendor, transitions, credentials] = await Promise.all([
    import('@/lib/prisma'),
    import('./run'),
    import('./vendor'),
    import('./transitions/vendor'),
    import('./credentials'),
  ]);
  const ctx = { operator: req.operator, requestRef: req.requestRef, operationKey: `vendor:${req.command}:${req.requestId}` };
  const b = req.body;
  const run = <T,>(fn: (tx: import('@/modules/platform').TxClient) => Promise<T>) => runIdentityTransaction(prisma, fn);
  try {
    vendor.assertVendorProcess(env);
    let result: unknown;
    switch (req.command) {
      case 'status':
        result = await vendor.vendorStatus(prisma);
        break;
      case 'set-root':
        result = await run((tx) => transitions.setRoot(tx, { ctx, email: String(b.email ?? ''), replaceCurrent: b.replaceCurrent === true }));
        break;
      case 'suspend-root':
        result = await run((tx) => transitions.suspendRoot(tx, { ctx, reason: String(b.reason ?? '') }));
        break;
      case 'register-person':
        result = await run((tx) => transitions.registerNamedPerson(tx, { ctx, email: String(b.email ?? ''), nationalId: String(b.nationalId ?? ''), name: b.name == null ? null : String(b.name) }));
        break;
      case 'revoke-person':
        result = await run((tx) => transitions.revokeNamedPerson(tx, { ctx, email: String(b.email ?? '') }));
        break;
      case 'link-person':
        result = await run((tx) => transitions.linkNamedPerson(tx, { ctx, email: String(b.email ?? '') }));
        break;
      case 'invite-person':
        result = await run((tx) =>
          transitions.inviteNamedPerson(tx, { ctx, email: String(b.email ?? ''), role: String(b.role ?? '') as never, name: b.name == null ? null : String(b.name), linkHours: Number(b.linkHours ?? 72) }),
        );
        break;
      case 'set-owner-contact':
        result = await run((tx) =>
          transitions.setOwnerContact(tx, { ctx, email: b.email == null || b.email === '' ? null : String(b.email), mobile: b.mobile == null || b.mobile === '' ? null : String(b.mobile), name: b.name == null ? null : String(b.name) }),
        );
        break;
      case 'release-code': {
        const r = await run((tx) => transitions.releaseCode(tx, { ctx, email: String(b.email ?? '') }));
        // The code only on the first call: a replay (a lost answer) never re-reveals it; the root starts again.
        result = r.replayed ? { ...r, code: null } : { ...r, code: credentials.credentialCodeFor(r.tokenId) };
        break;
      }
    }
    reply(out, { ok: true, result });
    return 0;
  } catch (err) {
    const status =
      typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : (err as Error)?.name === 'OperationKeyConflictError' ? 409 : 500;
    // 4xx: the rule's own Arabic message. 5xx: no detail leaves the host (the panel shows a generic error).
    reply(out, { ok: false, status, error: status < 500 ? (err as Error).message : 'internal error', code: (err as { details?: { code?: string } }).details?.code ?? null });
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}
