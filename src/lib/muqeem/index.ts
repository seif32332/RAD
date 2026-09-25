// Public API of the Muqeem (مقيم) integration. Import from '@/lib/muqeem' in route handlers.
// Server-only (config / client / transactions import 'server-only'). Client components that only
// need the pure helpers can import '@/lib/muqeem/hijri' or '@/lib/muqeem/types' directly.
//
// See docs/integrations/muqeem/README.md for configuration, safety rules and the local mock.
export {
  muqeemConfig,
  readMuqeemSettings,
  MUQEEM_DEFAULT_TIMEOUT_MS,
  MUQEEM_REQUIRED_ENV,
  type MuqeemConfigStatus,
  type MuqeemSettings,
} from './config';

export {
  MuqeemError,
  isMuqeemError,
  toApiError,
  muqeemUserMessage,
  parseMuqeemErrorBody,
  redactSecrets,
  MUQEEM_ERROR_KINDS,
  MUQEEM_ERROR_HTTP_STATUS,
  MUQEEM_ERROR_MESSAGES,
  type MuqeemErrorKind,
  type MuqeemErrorOptions,
} from './errors';

export { toHijriDateString, hijriToGregorian, isHijriDateString, parseMuqeemGregorian, toMuqeemGregorian } from './hijri';

export * from './types';

export {
  createMuqeemClient,
  getCachedMuqeemLookup,
  clearMuqeemCaches,
  jwtExpiryMs,
  TOKEN_EXPIRY_SKEW_MS,
  DEFAULT_TOKEN_TTL_MS,
  LOOKUP_CACHE_TTL_MS,
  type MuqeemClient,
  type MuqeemFetch,
  type CreateMuqeemClientOptions,
} from './client';

export {
  runMuqeemTransaction,
  reconcileTransaction,
  muqeemIdempotencyKey,
  summarizeForStorage,
  MUQEEM_TX_STATUS,
  MUQEEM_OPERATIONS,
  STALE_PENDING_MS,
  type MuqeemTxStatus,
  type MuqeemOperation,
  type MuqeemEntityRef,
  type RunMuqeemTransactionInput,
  type RunMuqeemTransactionResult,
  type MuqeemReconcileOutcome,
} from './transactions';

export { IN_FLIGHT_MS, IN_FLIGHT_MESSAGE, isInFlightPending, featureSettlePath, last4 } from './tx-rules';
