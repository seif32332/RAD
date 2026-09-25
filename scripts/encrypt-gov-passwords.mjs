#!/usr/bin/env node
/**
 * One-off migration: encrypt legacy plaintext GovPlatform passwords.
 *
 *   node scripts/encrypt-gov-passwords.mjs                 # dry run (default): report only
 *   node scripts/encrypt-gov-passwords.mjs --apply         # encrypt and write
 *   node scripts/encrypt-gov-passwords.mjs --env-file /etc/radeef/<tenant>.env --apply
 *
 * Options:
 *   --apply              write the changes (without it nothing is modified)
 *   --env-file <path>    load environment variables from this file (default: ./.env when present)
 *   --name-prefix <p>    only rows whose platformName starts with <p> (testing / partial runs)
 *
 * The ciphertext format and key derivation are the same as src/lib/crypto.ts:
 *   writes "enc:v2:<kid>:<iv b64>:<tag b64>:<data b64>" (kid = DATA_ENCRYPTION_KEY_ID, default "k1"),
 *   reads  "enc:v2:..." and the older "enc:v1:<iv b64>:<tag b64>:<data b64>"; AES-256-GCM, 12-byte IV;
 *   key = DATA_ENCRYPTION_KEY (64 hex chars or base64 of 32 bytes; any other value is SHA-256 hashed).
 *   In production (NODE_ENV=production) DATA_ENCRYPTION_KEY is REQUIRED (fail closed, DEC-008).
 *   Outside production only: SHA-256("radeef-data-key:" + (SESSION_SECRET || NEXTAUTH_SECRET)),
 *   else SHA-256("dev-only-insecure-data-key").
 *   A tenant whose existing values were encrypted with the old SESSION_SECRET-derived key keeps them
 *   readable by setting, once, DATA_ENCRYPTION_KEY to that same key (hex):
 *     printf 'radeef-data-key:%s' "$SESSION_SECRET" | sha256sum | cut -d' ' -f1
 *   then verify with a dry run: the "Key check" line must say OK.
 * Run it with EXACTLY the environment the app runs with, otherwise the app cannot decrypt.
 *
 * Safety:
 *   - Rows already starting with "enc:v1:" or "enc:v2:" are skipped (idempotent: safe to run twice).
 *   - Before writing, one already-encrypted row (if any) is decrypted with the derived key; a
 *     failure means the key differs from the app's and the script aborts without writing.
 *   - Every encrypted value is decrypted again and compared before it is written.
 *   - Each row is updated only if its password is still the plaintext that was read.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const isEncrypted = (v) => typeof v === 'string' && (v.startsWith(PREFIX_V1) || v.startsWith(PREFIX_V2));

function keyFromSecret(raw) {
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : createHash('sha256').update(raw).digest();
}

function currentKeyId() {
  const kid = process.env.DATA_ENCRYPTION_KEY_ID?.trim() || 'k1';
  if (!KID_RE.test(kid)) throw new Error('DATA_ENCRYPTION_KEY_ID must match [A-Za-z0-9_-]{1,32}');
  return kid;
}

/** Key for a v2 key id (current id -> current key, other ids -> DATA_ENCRYPTION_KEY_<KID>). */
function keyForKid(kid, current) {
  if (kid === null || kid === currentKeyId()) return current;
  const raw = process.env[`DATA_ENCRYPTION_KEY_${kid.toUpperCase().replace(/-/g, '_')}`];
  if (!raw) throw new Error(`unknown key id "${kid}"`);
  return keyFromSecret(raw);
}

function parseArgs(argv) {
  const out = { apply: false, envFile: null, namePrefix: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--env-file') out.envFile = argv[++i];
    else if (a === '--name-prefix') out.namePrefix = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/encrypt-gov-passwords.mjs [--apply] [--env-file <path>] [--name-prefix <prefix>]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (out.envFile === undefined || out.namePrefix === undefined) {
    console.error('Missing value for --env-file / --name-prefix');
    process.exit(2);
  }
  return out;
}

function loadEnv(file) {
  const path = file ?? (existsSync('.env') ? '.env' : null);
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`env file not found: ${path}`);
  if (typeof process.loadEnvFile !== 'function') throw new Error('Node >= 20.12 is required for --env-file');
  process.loadEnvFile(path);
  return path;
}

/** Same derivation as getKey() in src/lib/crypto.ts. Returns the key and where it came from. */
function deriveKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length === 32) return { key: buf, source: 'DATA_ENCRYPTION_KEY' };
    return { key: createHash('sha256').update(raw).digest(), source: 'DATA_ENCRYPTION_KEY (hashed)' };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY must be set in production (no SESSION_SECRET fallback; see the header of this script)');
  }
  const fallback = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (!fallback) {
    return { key: createHash('sha256').update('dev-only-insecure-data-key').digest(), source: 'DEV FALLBACK (insecure, development only)' };
  }
  return {
    key: createHash('sha256').update(`radeef-data-key:${fallback}`).digest(),
    source: process.env.SESSION_SECRET ? 'derived from SESSION_SECRET' : 'derived from NEXTAUTH_SECRET',
  };
}

/** New values: v2 with the current key id (same as encryptField in src/lib/crypto.ts). */
function encrypt(plain, key) {
  const kid = currentKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX_V2}${kid}:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/** Reads v2 (key id) and v1 (current key) values. */
function decrypt(value, key) {
  let kid = null;
  let rest;
  if (value.startsWith(PREFIX_V2)) {
    const parts = value.slice(PREFIX_V2.length).split(':');
    if (parts.length !== 4) throw new Error('malformed enc:v2 value');
    kid = parts[0];
    rest = parts.slice(1);
  } else {
    rest = value.slice(PREFIX_V1.length).split(':');
    if (rest.length !== 3) throw new Error('malformed enc:v1 value');
  }
  const [ivB64, tagB64, dataB64] = rest;
  const decipher = createDecipheriv('aes-256-gcm', keyForKid(kid, key), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = loadEnv(args.envFile);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (export it, put it in .env or pass --env-file)');

  const { key, source } = deriveKey();
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12);
  console.log(`Mode        : ${args.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`Env file    : ${envPath ?? '(process environment only)'}`);
  console.log(`Key source  : ${source}  [fingerprint ${fingerprint}, key id ${currentKeyId()}]`);
  if (args.namePrefix) console.log(`Filter      : platformName starts with "${args.namePrefix}"`);

  const prisma = new PrismaClient();
  try {
    const where = args.namePrefix ? { platformName: { startsWith: args.namePrefix } } : {};
    const rows = await prisma.govPlatform.findMany({ where, select: { id: true, platformName: true, password: true } });
    const legacy = rows.filter((r) => r.password && !isEncrypted(r.password));
    const encrypted = rows.filter((r) => r.password && isEncrypted(r.password));
    const empty = rows.length - legacy.length - encrypted.length;
    console.log(`Rows        : ${rows.length} total, ${encrypted.length} already encrypted, ${legacy.length} plaintext, ${empty} empty`);

    // Key check: an already-encrypted row (any row, not only the filtered ones) must decrypt.
    const sample = encrypted[0] ?? (await prisma.govPlatform.findFirst({
        where: { OR: [{ password: { startsWith: PREFIX_V2 } }, { password: { startsWith: PREFIX_V1 } }] },
        select: { id: true, password: true },
      }));
    if (sample) {
      try {
        decrypt(sample.password, key);
        console.log(`Key check   : OK (decrypted existing row ${sample.id})`);
      } catch {
        console.error(`Key check   : FAILED - row ${sample.id} was encrypted with a different key.`);
        console.error('Aborting: run the script with the same DATA_ENCRYPTION_KEY / SESSION_SECRET as the app.');
        process.exitCode = 1;
        return;
      }
    } else {
      console.log('Key check   : skipped (no encrypted row yet) - make sure the environment matches the app');
    }

    for (const r of legacy) console.log(`  - ${r.id}  ${r.platformName}`);
    if (!legacy.length) {
      console.log('Nothing to do.');
      return;
    }
    if (!args.apply) {
      console.log(`\nDry run: ${legacy.length} password(s) would be encrypted. Re-run with --apply to write.`);
      return;
    }

    let done = 0;
    let skipped = 0;
    for (const r of legacy) {
      const cipher = encrypt(r.password, key);
      if (decrypt(cipher, key) !== r.password) throw new Error(`round-trip check failed for ${r.id}`);
      // Only if the row still holds the plaintext we read (not changed by the app meanwhile).
      const res = await prisma.govPlatform.updateMany({ where: { id: r.id, password: r.password }, data: { password: cipher } });
      if (res.count === 1) done++;
      else skipped++;
    }
    await prisma.auditLog.create({
      data: {
        userId: null,
        action: 'UPDATE',
        entityType: 'GovPlatform',
        entityId: null,
        details: JSON.stringify({ migration: 'encrypt-gov-passwords', encrypted: done, skippedChanged: skipped, keyFingerprint: fingerprint, keyId: currentKeyId() }),
      },
    });
    console.log(`\nEncrypted ${done} password(s)${skipped ? `, skipped ${skipped} changed meanwhile` : ''}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
