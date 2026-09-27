// Biometric images: the reference selfie of a FaceProfile and the selfies kept as evidence for
// REJECTED / FLAGGED self punches.
//
// They live in UPLOAD_DIR/.biometric/ and are deliberately NOT registered in UploadedFile:
// - the leading dot makes the folder unreachable through /api/files (resolveInside and
//   storedNameFromSegments reject dot segments), and
// - the generic file ACL lets finance roles read every registered file (FULL_FILE_ROLES).
// They are served only by dedicated HR-only routes (audited, no-store) and removed by the
// purge-attendance-biometrics job, a face reset, or a consent withdrawal.
import 'server-only';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { NextResponse } from 'next/server';
import { getUploadDir, validateUpload, type UploadPolicy, type UploadValidation } from '@/lib/storage';
import { readImageSize } from '@/lib/image-dimensions';

export const BIOMETRIC_DIR_NAME = '.biometric';

/** Camera captures only: small JPEG / PNG / WebP. */
export const SELFIE_UPLOAD_POLICY: UploadPolicy = { maxBytes: 3 * 1024 * 1024, extensions: ['jpg', 'jpeg', 'png', 'webp'] };

export type BiometricExt = 'jpg' | 'png' | 'webp';

const MIME: Readonly<Record<BiometricExt, string>> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function getBiometricDir(): string {
  return path.join(getUploadDir(), BIOMETRIC_DIR_NAME);
}

export function isBiometricName(name: string | null | undefined): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function biometricMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1) as BiometricExt;
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * Largest image accepted, in pixels and per side. Portal captures are about 640x850; the cap only
 * stops "decompression bombs" (a small file declaring a huge image) before the face service.
 */
export const SELFIE_MAX_PIXELS = 16_000_000;
export const SELFIE_MAX_SIDE = 8_000;

/** Validates a camera capture (size, type, magic bytes, declared dimensions). 'jpeg' is normalized to 'jpg'. */
export function validateSelfie(fileName: string, bytes: Uint8Array): UploadValidation & { ext?: BiometricExt } {
  const v = validateUpload(fileName, bytes.byteLength, bytes, SELFIE_UPLOAD_POLICY);
  if (!v.ok) return v;
  const size = readImageSize(bytes);
  if (!size || !size.width || !size.height || size.width > SELFIE_MAX_SIDE || size.height > SELFIE_MAX_SIDE || size.width * size.height > SELFIE_MAX_PIXELS) {
    return { ok: false, status: 400, message: 'الصورة غير صالحة. أعد التقاطها من الكاميرا.' };
  }
  return { ok: true, ext: (v.ext === 'jpeg' ? 'jpg' : v.ext) as BiometricExt };
}

/** Writes an already-validated image; returns its stored name (<uuid>.<ext>). Owner-only permissions. */
export async function saveBiometricImage(data: Uint8Array, ext: BiometricExt): Promise<string> {
  const dir = getBiometricDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.${ext}`;
  await writeFile(path.join(dir, name), data, { flag: 'wx', mode: 0o600 });
  return name;
}

export async function readBiometricImage(name: string): Promise<Buffer | null> {
  if (!isBiometricName(name)) return null;
  try {
    return await readFile(path.join(getBiometricDir(), name));
  } catch {
    return null;
  }
}

/** Deletes a biometric image. Missing files are ignored (already purged). */
export async function deleteBiometricImage(name: string | null | undefined): Promise<void> {
  if (!isBiometricName(name)) return;
  try {
    await unlink(path.join(getBiometricDir(), name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}

/**
 * Best-effort delete once the database no longer references the file: never throws, so the
 * caller's audit entry is still written. A leftover is removed by the nightly orphan sweep of
 * purge-attendance-biometrics (scripts/jobs.mjs).
 */
export async function discardBiometricImage(name: string | null | undefined): Promise<void> {
  try {
    await deleteBiometricImage(name);
  } catch (err) {
    console.warn('[biometric] could not delete an unreferenced file; the nightly sweep will retry:', (err as NodeJS.ErrnoException)?.code ?? 'error');
  }
}

/** HTTP response for an HR viewer: never cached, never sniffed, not embeddable elsewhere. */
export function biometricImageResponse(name: string, data: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': biometricMime(name),
      'Content-Length': String(data.byteLength),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
