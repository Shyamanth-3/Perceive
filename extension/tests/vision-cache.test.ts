/**
 * Phase 4 unit tests for shared/vision-cache.ts — the on-device local-vision
 * inference cache, keyed by the plan §8.1 composite key: { imageHash,
 * viewportWidth, viewportHeight, devicePixelRatio, modelId, modelVersion,
 * inferenceConfigHash }.
 */

import {
  buildVisionCacheKey,
  createVisionCacheStore,
  hashString,
  lookupVisionCache,
  storeVisionCache,
  type VisionCacheLookupParams,
} from "../src/shared/vision-cache";
import type { RawVisionResult } from "../src/shared/types";

function makeResult(overrides: Partial<RawVisionResult> = {}): RawVisionResult {
  return {
    requestId: "req-1",
    modelId: "Xenova/yolos-tiny",
    modelVersion: "v1",
    backend: "wasm",
    imageWidth: 640,
    imageHeight: 480,
    detections: [],
    inferenceTimeMs: 12.5,
    cached: false,
    ...overrides,
  };
}

const baseParams: Omit<VisionCacheLookupParams, "requestId"> = {
  screenshotDataUrl: "data:image/jpeg;base64,AAAA",
  viewportWidth: 1280,
  viewportHeight: 720,
  devicePixelRatio: 2,
  modelId: "Xenova/yolos-tiny",
  modelVersion: "v1",
  inferenceConfigHash: "thr=0.3:dtype=webgpu-fp16/wasm-q8",
};

describe("hashString", () => {
  it("is deterministic for identical input", () => {
    expect(hashString("data:image/jpeg;base64,AAAA")).toBe(hashString("data:image/jpeg;base64,AAAA"));
  });

  it("differs for different input (no trivial collisions on near-identical strings)", () => {
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).not.toBe(hashString("a"));
  });

  it("handles the empty string without throwing", () => {
    expect(() => hashString("")).not.toThrow();
  });
});

describe("buildVisionCacheKey (plan §8.1 composite key)", () => {
  it("combines every field of the composite key", () => {
    const key = buildVisionCacheKey({
      imageHash: "h1",
      viewportWidth: 1280,
      viewportHeight: 720,
      devicePixelRatio: 2,
      modelId: "Xenova/yolos-tiny",
      modelVersion: "v1",
      inferenceConfigHash: "cfg1",
    });
    expect(key).toBe("Xenova/yolos-tiny:v1:cfg1:1280:720:2:h1");
  });

  it("produces different keys when any one field changes", () => {
    const base = { imageHash: "h1", viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 2, modelId: "m", modelVersion: "v1", inferenceConfigHash: "cfg" };
    const baseKey = buildVisionCacheKey(base);
    expect(buildVisionCacheKey({ ...base, modelVersion: "v2" })).not.toBe(baseKey);
    expect(buildVisionCacheKey({ ...base, viewportWidth: 800 })).not.toBe(baseKey);
    expect(buildVisionCacheKey({ ...base, viewportHeight: 600 })).not.toBe(baseKey);
    expect(buildVisionCacheKey({ ...base, devicePixelRatio: 1 })).not.toBe(baseKey);
    expect(buildVisionCacheKey({ ...base, modelId: "other" })).not.toBe(baseKey);
    expect(buildVisionCacheKey({ ...base, inferenceConfigHash: "cfg2" })).not.toBe(baseKey);
    expect(buildVisionCacheKey({ ...base, imageHash: "h2" })).not.toBe(baseKey);
  });
});

describe("createVisionCacheStore", () => {
  it("get/set/has/delete/clear behave as a normal map", () => {
    const store = createVisionCacheStore(10);
    expect(store.size).toBe(0);
    store.set("k", makeResult());
    expect(store.has("k")).toBe(true);
    expect(store.get("k")?.requestId).toBe("req-1");
    expect(store.size).toBe(1);
    store.delete("k");
    expect(store.has("k")).toBe(false);
    store.set("a", makeResult());
    store.set("b", makeResult());
    store.clear();
    expect(store.size).toBe(0);
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const store = createVisionCacheStore(2);
    store.set("a", makeResult({ requestId: "a" }));
    store.set("b", makeResult({ requestId: "b" }));
    store.set("c", makeResult({ requestId: "c" }));
    expect(store.size).toBe(2);
    expect(store.has("a")).toBe(false); // oldest evicted
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
  });

  it("refreshes recency on overwrite so it isn't evicted next", () => {
    const store = createVisionCacheStore(2);
    store.set("a", makeResult({ requestId: "a" }));
    store.set("b", makeResult({ requestId: "b" }));
    store.set("a", makeResult({ requestId: "a2" })); // touch "a" again
    store.set("c", makeResult({ requestId: "c" })); // should evict "b", not "a"
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(true);
  });
});

describe("lookupVisionCache / storeVisionCache (composite-key addressed)", () => {
  it("misses on an empty cache", () => {
    const store = createVisionCacheStore();
    const hit = lookupVisionCache(store, { ...baseParams, requestId: "req-2" });
    expect(hit).toBeNull();
  });

  it("hits for identical composite key, rewriting requestId + cached:true", () => {
    const store = createVisionCacheStore();
    const fresh = makeResult({ requestId: "req-1", cached: false });
    storeVisionCache(store, baseParams, fresh);

    const hit = lookupVisionCache(store, { ...baseParams, requestId: "req-2" });
    expect(hit).not.toBeNull();
    expect(hit?.requestId).toBe("req-2"); // correlated to the *new* request
    expect(hit?.cached).toBe(true);
    expect(hit?.detections).toEqual(fresh.detections);
  });

  it("misses when the screenshot bytes differ even slightly", () => {
    const store = createVisionCacheStore();
    storeVisionCache(store, baseParams, makeResult());
    const hit = lookupVisionCache(store, {
      ...baseParams,
      screenshotDataUrl: "data:image/jpeg;base64,AAAB",
      requestId: "req-2",
    });
    expect(hit).toBeNull();
  });

  it("misses when modelVersion differs (bundled-weights bump invalidates stale cache)", () => {
    const store = createVisionCacheStore();
    storeVisionCache(store, baseParams, makeResult());
    const hit = lookupVisionCache(store, { ...baseParams, modelVersion: "v2", requestId: "req-2" });
    expect(hit).toBeNull();
  });

  it("misses when viewport or devicePixelRatio differs (plan §8.2 rule 3)", () => {
    const store = createVisionCacheStore();
    storeVisionCache(store, baseParams, makeResult());
    expect(
      lookupVisionCache(store, { ...baseParams, viewportWidth: 800, requestId: "req-2" })
    ).toBeNull();
    expect(
      lookupVisionCache(store, { ...baseParams, viewportHeight: 600, requestId: "req-3" })
    ).toBeNull();
    expect(
      lookupVisionCache(store, { ...baseParams, devicePixelRatio: 1, requestId: "req-4" })
    ).toBeNull();
  });

  it("misses when inferenceConfigHash differs (plan §8.2 rule 4)", () => {
    const store = createVisionCacheStore();
    storeVisionCache(store, baseParams, makeResult());
    const hit = lookupVisionCache(store, {
      ...baseParams,
      inferenceConfigHash: "thr=0.5:dtype=webgpu-fp16/wasm-q8",
      requestId: "req-2",
    });
    expect(hit).toBeNull();
  });

  it("always stores with cached:false regardless of the input result's flag", () => {
    const store = createVisionCacheStore();
    storeVisionCache(store, baseParams, makeResult({ cached: true }));
    const key = buildVisionCacheKey({
      imageHash: hashString(baseParams.screenshotDataUrl),
      viewportWidth: baseParams.viewportWidth,
      viewportHeight: baseParams.viewportHeight,
      devicePixelRatio: baseParams.devicePixelRatio,
      modelId: baseParams.modelId,
      modelVersion: baseParams.modelVersion,
      inferenceConfigHash: baseParams.inferenceConfigHash,
    });
    expect(store.get(key)?.cached).toBe(false);
  });
});
