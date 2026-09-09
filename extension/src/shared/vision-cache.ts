/**
 * On-device local-vision inference cache (Phase 4, plan §8.1 composite key):
 *
 *   CacheKey = { imageHash, viewportWidth, viewportHeight, devicePixelRatio,
 *                modelId, modelVersion, inferenceConfigHash }
 *
 * `imageHash` is a content hash of the exact screenshot bytes fed to the
 * model; the rest pins the cache entry to the exact model + backend config
 * that produced it (plan §8.2 invalidation rule 3/4: viewport/dpr change or
 * model/config change must miss, not return a stale result). Two captures of
 * an unchanged viewport (e.g. a debounced mutation burst with no visible
 * change) reuse the same inference result instead of re-running the model.
 *
 * Pure and injectable (a plain Map by default) so it is unit-testable
 * without the offscreen document or any ONNX runtime.
 */

import type { RawVisionResult } from "./types";

export interface VisionCacheKeyInput {
  imageHash: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  modelId: string;
  modelVersion: string;
  inferenceConfigHash: string;
}

/** Build the stable composite cache key (plan §8.1). */
export function buildVisionCacheKey(input: VisionCacheKeyInput): string {
  return [
    input.modelId,
    input.modelVersion,
    input.inferenceConfigHash,
    input.viewportWidth,
    input.viewportHeight,
    input.devicePixelRatio,
    input.imageHash,
  ].join(":");
}

/**
 * Deterministic, allocation-light string hash (djb2 variant) for the
 * screenshot dataUrl. Not cryptographic — collision resistance for a
 * single-user, single-device cache of a few dozen entries is more than
 * sufficient, and it needs no Web Crypto / Node crypto dependency so it runs
 * identically in the offscreen document and in jest.
 */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // Two 32-bit halves concatenated as unsigned hex -> effectively a 64-bit hash.
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export interface VisionCacheStore {
  get(key: string): RawVisionResult | undefined;
  set(key: string, value: RawVisionResult): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

/** Simple bounded Map-backed store: evicts the oldest entry past `maxEntries`. */
export function createVisionCacheStore(maxEntries = 50): VisionCacheStore {
  const map = new Map<string, RawVisionResult>();
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    set: (key, value) => {
      // Refresh insertion order on overwrite so recently-reused entries
      // survive eviction longer (simple LRU-ish behavior via Map order).
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
      }
    },
    get size() {
      return map.size;
    },
  };
}

export interface VisionCacheLookupParams {
  screenshotDataUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  modelId: string;
  modelVersion: string;
  inferenceConfigHash: string;
  requestId: string;
}

function keyFromParams(params: Omit<VisionCacheLookupParams, "requestId">): string {
  return buildVisionCacheKey({
    imageHash: hashString(params.screenshotDataUrl),
    viewportWidth: params.viewportWidth,
    viewportHeight: params.viewportHeight,
    devicePixelRatio: params.devicePixelRatio,
    modelId: params.modelId,
    modelVersion: params.modelVersion,
    inferenceConfigHash: params.inferenceConfigHash,
  });
}

/**
 * Look up a cached result for the full composite key (plan §8.1). Returns
 * the cached `RawVisionResult` (with `cached: true` and the original
 * `requestId` swapped for the current one) or null on a miss.
 */
export function lookupVisionCache(
  store: VisionCacheStore,
  params: VisionCacheLookupParams
): RawVisionResult | null {
  const hit = store.get(keyFromParams(params));
  if (!hit) return null;
  return { ...hit, requestId: params.requestId, cached: true };
}

/** Store a freshly computed result, keyed by the full composite key. */
export function storeVisionCache(
  store: VisionCacheStore,
  params: Omit<VisionCacheLookupParams, "requestId">,
  result: RawVisionResult
): void {
  store.set(keyFromParams(params), { ...result, cached: false });
}
