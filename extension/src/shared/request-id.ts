/**
 * Shared request correlation infrastructure.
 *
 * Every cross-context request in Perceive carries a `requestId` and a
 * `timestamp` so messages can be correlated, de-duplicated, and ordered
 * (see LATEST_REQUEST_WINS policy planned for Phase 5).
 */

export interface RequestMeta {
  /** Unique, unforgeable id for a single request/response exchange. */
  requestId: string;
  /** Wall-clock time (ms since epoch) at which the message was created. */
  timestamp: number;
}

/**
 * Generate a globally unique request id. Prefers `crypto.randomUUID()`
 * (available in MV3 service worker, offscreen document, and content script
 * contexts) and falls back to a time+entropy hybrid elsewhere (e.g. jest).
 */
export function createRequestId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Build a fresh RequestMeta (id + timestamp) for a new message. */
export function createRequestMeta(): RequestMeta {
  return { requestId: createRequestId(), timestamp: Date.now() };
}

/** Structural guard for RequestMeta-valued values. */
export function isRequestMeta(value: unknown): value is RequestMeta {
  const v = value as Record<string, unknown> | null;
  return (
    !!v &&
    typeof v.requestId === "string" &&
    v.requestId.length > 0 &&
    typeof v.timestamp === "number" &&
    Number.isFinite(v.timestamp)
  );
}