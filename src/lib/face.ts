// Client of the internal face-verification service (services/face, Python on 127.0.0.1).
//
// The service is stateless: it receives one image and returns the number of faces, a liveness
// score and the embedding of the single face. Matching happens here, so stored templates never
// leave Radeef. Every failure (not configured, busy, timeout, bad answer) returns null and the
// caller fails CLOSED (the punch is rejected with FACE_SERVICE_UNAVAILABLE).
import 'server-only';
import { decryptField, encryptField } from '@/lib/crypto';
import type { FaceAnalysis } from '@/lib/self-attendance';

/** Model that produces the embeddings. A change requires re-enrollment (FaceProfile.model). */
export const FACE_MODEL = 'sface_2021dec';
export const FACE_EMBEDDING_SIZE = 128;

const TIMEOUT_MS = 10_000;
/** Per-process cap on concurrent calls: beyond it the call fails closed instead of queueing. */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

export interface FaceServiceResult extends FaceAnalysis {
  /** Detector confidence of the face (0..1). */
  detScore: number | null;
  /** Face box area / image area. */
  faceRatio: number | null;
  /** Variance of the Laplacian (sharpness; higher = sharper). */
  blur: number | null;
  /** Mean brightness of the face region (0..255). */
  brightness: number | null;
  model: string | null;
}

function config(): { url: string; token: string } | null {
  const url = process.env.FACE_SERVICE_URL?.trim().replace(/\/+$/, '');
  const token = process.env.FACE_SERVICE_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export function faceServiceConfigured(): boolean {
  return config() !== null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Validates the service answer; null when it does not have the expected shape. */
export function parseFaceServiceResponse(data: unknown): FaceServiceResult | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const faces = num(d.faces);
  if (faces === null || faces < 0 || !Number.isInteger(faces)) return null;
  const quality = (d.quality && typeof d.quality === 'object' ? d.quality : {}) as Record<string, unknown>;
  const liveness = (d.liveness && typeof d.liveness === 'object' ? d.liveness : {}) as Record<string, unknown>;
  let embedding: number[] | null = null;
  if (Array.isArray(d.embedding)) {
    if (d.embedding.length !== FACE_EMBEDDING_SIZE || !d.embedding.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    embedding = d.embedding as number[];
  }
  if (faces === 1 && !embedding) return null;
  return {
    faces,
    liveness: num(liveness.score),
    embedding,
    detScore: num(d.detScore),
    faceRatio: num(quality.faceRatio),
    blur: num(quality.blur),
    brightness: num(quality.brightness),
    model: typeof d.model === 'string' ? d.model : null,
  };
}

/** Sends one image to the face service. Returns null whenever the result cannot be trusted. */
export async function analyzeFace(image: Uint8Array, mime: string): Promise<FaceServiceResult | null> {
  const cfg = config();
  if (!cfg) return null;
  if (inFlight >= MAX_IN_FLIGHT) {
    console.warn('[face] too many concurrent requests; failing closed');
    return null;
  }
  inFlight += 1;
  try {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)], { type: mime }), 'capture');
    const res = await fetch(`${cfg.url}/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[face] service answered HTTP ${res.status}`);
      return null;
    }
    const parsed = parseFaceServiceResponse(await res.json());
    if (!parsed) console.error('[face] unexpected response shape');
    return parsed;
  } catch (err) {
    // Never log the image or the embedding.
    console.error('[face] service unreachable:', err instanceof Error ? err.name : 'error');
    return null;
  } finally {
    inFlight -= 1;
  }
}

/** Service health for /api/health-style checks (never throws). */
export async function faceServiceHealthy(): Promise<boolean> {
  const cfg = config();
  if (!cfg) return false;
  try {
    const res = await fetch(`${cfg.url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Encrypts an embedding for FaceProfile.embedding (AES-256-GCM via encryptField). */
export function sealEmbedding(embedding: readonly number[]): string {
  return encryptField(JSON.stringify(embedding.map((x) => Math.round(x * 1e6) / 1e6)));
}

/** Decrypts FaceProfile.embedding; null when it cannot be read (wrong key, corrupt, wrong size). */
export function openEmbedding(sealed: string | null | undefined): number[] | null {
  if (!sealed) return null;
  try {
    const raw = decryptField(sealed);
    if (!raw) return null;
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== FACE_EMBEDDING_SIZE || !arr.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    return arr as number[];
  } catch {
    return null;
  }
}
