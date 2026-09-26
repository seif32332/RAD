// Storage of issued PDFs and document assets (ADR DOC-09 / DOC-10).
//
// - <UPLOAD_DIR>/.documents/<yyyy>/<uuid>.pdf  issued documents, written once, never replaced.
// - <UPLOAD_DIR>/.document-assets/<sha256>.png logos / signatures / stamps, content addressed.
// Both are dot-folders, like .biometric: /api/files refuses any path segment starting with a dot
// (storedNameFromSegments / resolveInside), so they are never reachable there. Issued documents
// stream through /api/documents/<id>/pdf with a per-document access check.
import 'server-only';
import { randomUUID } from 'crypto';
import { link, mkdir, open, readFile, unlink } from 'fs/promises';
import path from 'path';
import { getUploadDir } from '@/lib/storage';
import { sha256Hex } from './core';

export const DOCS_DIR_NAME = '.documents';
const DOCS = DOCS_DIR_NAME;
export const ASSETS_DIR_NAME = '.document-assets';
const ASSETS = ASSETS_DIR_NAME;
const STORED_DOC_RE = /^\d{4}\/[0-9a-f-]{36}\.pdf$/;
const STORED_ASSET_RE = /^[0-9a-f]{64}\.png$/;

function docPath(storedName: string): string {
  if (!STORED_DOC_RE.test(storedName)) throw new Error('invalid stored document name');
  return path.join(getUploadDir(), DOCS, ...storedName.split('/'));
}

/** Writes a file that must not exist yet: temp file + fsync + hard link (fails if the target exists). */
async function writeOnce(target: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'wx', 0o640);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await link(tmp, target); // EEXIST if anything is already there: never overwrite
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Stores an issued PDF; returns its stored name (relative, e.g. "2026/<uuid>.pdf"). */
export async function storeIssuedPdf(pdf: Buffer, issuedAt: Date): Promise<string> {
  const year = new Date(issuedAt.getTime() + 3 * 3600e3).getUTCFullYear();
  const storedName = `${year}/${randomUUID()}.pdf`;
  await writeOnce(docPath(storedName), pdf);
  return storedName;
}

/** Reads an issued PDF and checks it against the recorded hash (tampering on disk is detected). */
export async function readIssuedPdf(storedName: string, expectedSha256: string): Promise<Buffer> {
  const buf = await readFile(docPath(storedName));
  if (sha256Hex(buf) !== expectedSha256) throw new Error('issued document on disk does not match its recorded hash');
  return buf;
}

/** Deletes an issued PDF (retention purge only, DOC-09). */
export async function purgeIssuedPdf(storedName: string): Promise<void> {
  await unlink(docPath(storedName)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

export function assetStoredName(sha256: string): string {
  return `${sha256}.png`;
}

/** Stores an asset by content hash (idempotent: the same bytes are the same file). */
export async function storeAsset(png: Buffer): Promise<{ sha256: string; storedName: string }> {
  const sha256 = sha256Hex(png);
  const storedName = assetStoredName(sha256);
  try {
    await writeOnce(path.join(getUploadDir(), ASSETS, storedName), png);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return { sha256, storedName };
}

export async function readAsset(storedName: string): Promise<Buffer> {
  if (!STORED_ASSET_RE.test(storedName)) throw new Error('invalid asset name');
  const buf = await readFile(path.join(getUploadDir(), ASSETS, storedName));
  if (`${sha256Hex(buf)}.png` !== storedName) throw new Error('asset on disk does not match its hash');
  return buf;
}
