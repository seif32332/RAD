// Muqeem (مقيم) integration settings, read from the environment.
//
//   MUQEEM_ENABLED        'true' to turn the integration on (anything else = off)
//   MUQEEM_BASE_URL       e.g. https://<host given by Elm>   (the OpenAPI spec lists no server URL)
//   MUQEEM_APP_ID         app-id header issued by Elm's API gateway
//   MUQEEM_APP_KEY        app-key header issued by Elm's API gateway (secret)
//   MUQEEM_INTEGRATOR_ID  optional: X-INTEGRATOR-ID header, ONLY for integrators (direct users omit it)
//   MUQEEM_TIMEOUT_MS     optional request timeout, default 20000
//
// The per-company Muqeem USER credentials are not here: they live encrypted in the GovPlatform
// vault and are linked through Company.muqeemPlatformId (see client.ts).
//
// Never log the values returned by readMuqeemSettings(): they contain secrets.
import 'server-only';
import { MuqeemError } from './errors';

export const MUQEEM_DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/** Environment variables that must be set for the integration to be usable. */
export const MUQEEM_REQUIRED_ENV = ['MUQEEM_BASE_URL', 'MUQEEM_APP_ID', 'MUQEEM_APP_KEY'] as const;

/** Public, secret-free view of the configuration (safe to return from an API). */
export interface MuqeemConfigStatus {
  /** MUQEEM_ENABLED === 'true'. */
  enabled: boolean;
  /** Every required value is set (and the base URL is a valid http(s) URL). */
  configured: boolean;
  /** enabled && configured: the integration can be called. */
  usable: boolean;
  /** Names (never values) of the missing / invalid variables. */
  missing: string[];
}

/** Full settings, including secrets. Server-only; never serialize or log. */
export interface MuqeemSettings {
  baseUrl: string;
  appId: string;
  appKey: string;
  integratorId: string | null;
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined): string => (v ?? '').trim();

function normalizeBaseUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function parseTimeout(raw: string): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return MUQEEM_DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/** Secret-free status of the configuration. `env` is injectable for tests. */
export function muqeemConfig(env: Env = process.env): MuqeemConfigStatus {
  const enabled = clean(env.MUQEEM_ENABLED).toLowerCase() === 'true';
  const missing: string[] = [];
  if (!normalizeBaseUrl(clean(env.MUQEEM_BASE_URL))) missing.push('MUQEEM_BASE_URL');
  if (!clean(env.MUQEEM_APP_ID)) missing.push('MUQEEM_APP_ID');
  if (!clean(env.MUQEEM_APP_KEY)) missing.push('MUQEEM_APP_KEY');
  const configured = missing.length === 0;
  return { enabled, configured, usable: enabled && configured, missing };
}

/**
 * Settings for calling Muqeem. Throws MuqeemError('NOT_CONFIGURED') unless the integration is
 * enabled and fully configured.
 */
export function readMuqeemSettings(env: Env = process.env): MuqeemSettings {
  const status = muqeemConfig(env);
  if (!status.usable) {
    throw new MuqeemError('NOT_CONFIGURED', {
      detail: status.enabled ? `missing: ${status.missing.join(', ')}` : 'MUQEEM_ENABLED is not true',
    });
  }
  return {
    baseUrl: normalizeBaseUrl(clean(env.MUQEEM_BASE_URL)) as string,
    appId: clean(env.MUQEEM_APP_ID),
    appKey: clean(env.MUQEEM_APP_KEY),
    integratorId: clean(env.MUQEEM_INTEGRATOR_ID) || null,
    timeoutMs: parseTimeout(clean(env.MUQEEM_TIMEOUT_MS)),
  };
}
