/**
 * Offscreen local-vision inference runtime (Phase 4).
 *
 * Runs entirely inside the offscreen document (reason `WORKERS`) because
 * Phase 0 proved `import()` — which transformers.js's ONNX Runtime Web
 * backend needs for both WASM and WebGPU — is disallowed on
 * ServiceWorkerGlobalScope (see `spike-results.md`).
 *
 * - Backend: WebGPU (`fp16`) primary, WASM (`q8`) fallback, feature-gated on
 *   `navigator.gpu.requestAdapter()` (plan §7 / handoff §7.3).
 * - Everything is bundled locally: `env.allowRemoteModels = false`,
 *   `localModelPath` and the WASM runtime both resolve through
 *   `chrome.runtime.getURL(...)` — zero network requests at inference time.
 * - Lazy + idempotent init: the pipeline is created at most once per
 *   backend, on first use, and reused after (module-level promise cache).
 * - Results are memoized in the on-device `VisionCacheStore`
 *   (`shared/vision-cache.ts`), keyed by the plan §8.1 composite key
 *   (screenshot content hash + viewport + dpr + model id/version/config), so
 *   an unchanged capture never re-runs the model.
 */

import {
  MODEL_ID,
  MODEL_DTYPE_CPU,
  MODEL_DTYPE_GPU,
  MODEL_VERSION,
  INFERENCE_THRESHOLD,
  INFERENCE_CONFIG_HASH,
} from "../shared/constants";
import { createVisionCacheStore, lookupVisionCache, storeVisionCache } from "../shared/vision-cache";
import type { RawVisionResult, VisionDetection } from "../shared/types";
import { prepareScreenshotForModel } from "./image-prep";

type Backend = "webgpu" | "wasm";

/** Minimal shape of a transformers.js object-detection pipeline output item. */
interface RawDetection {
  score: number;
  label: string;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

type Detector = (input: string, options: { threshold: number }) => Promise<RawDetection[]>;

const cacheStore = createVisionCacheStore(50);

/** Single in-flight/definitive init promise; re-used across every call. */
let detectorPromise: Promise<{ detector: Detector; backend: Backend }> | null = null;

async function detectWebGpuBackend(): Promise<boolean> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } })
    .gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function loadDetector(backend: Backend): Promise<Detector> {
  // transformers.js is ESM-only; dynamic import works in the offscreen
  // document (unlike the Service Worker — see Phase 0 spike).
  const { pipeline, env } = await import("@huggingface/transformers");

  // SPIKE used env.allowRemoteModels = true to fetch from the HF hub; the
  // shipped product must never do that (plan: zero network at runtime).
  // allowLocalModels defaults to false in browser-like environments (which
  // the offscreen document is), so it must be explicitly enabled or
  // transformers.js refuses to load from ANY source (verified against a
  // real build: "Invalid configuration detected: both local and remote
  // models are disabled").
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = chrome.runtime.getURL("models/");
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
  }

  const dtype = backend === "webgpu" ? MODEL_DTYPE_GPU : MODEL_DTYPE_CPU;
  const detector = await pipeline("object-detection", MODEL_ID, {
    device: backend,
    dtype,
  });
  return detector as unknown as Detector;
}

/** Resolve (once) which backend to use and construct its detector. */
function ensureDetector(): Promise<{ detector: Detector; backend: Backend }> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const hasWebGpu = await detectWebGpuBackend();
      if (hasWebGpu) {
        try {
          return { detector: await loadDetector("webgpu"), backend: "webgpu" as const };
        } catch (error) {
          console.error("[Offscreen] WebGPU pipeline init failed, falling back to WASM", error);
        }
      }
      return { detector: await loadDetector("wasm"), backend: "wasm" as const };
    })().catch((error) => {
      // Allow a later call to retry (e.g. transient failure) instead of
      // permanently caching a rejected promise.
      detectorPromise = null;
      throw error;
    });
  }
  return detectorPromise;
}

function mapDetections(raw: RawDetection[]): VisionDetection[] {
  return raw.map((d) => ({
    label: d.label,
    confidence: d.score,
    boundingBox: {
      x: d.box.xmin,
      y: d.box.ymin,
      width: Math.max(0, d.box.xmax - d.box.xmin),
      height: Math.max(0, d.box.ymax - d.box.ymin),
    },
  }));
}

export interface RunVisionAnalysisInput {
  requestId: string;
  /** Screenshot dataUrl exactly as captured by `chrome.tabs.captureVisibleTab`. */
  screenshotDataUrl: string;
  /** CSS-pixel viewport size + dpr at capture time (plan §8.1 cache key). */
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
}

/**
 * Run (or reuse a cached) local vision analysis for one captured screenshot.
 * Cache key is the full plan §8.1 composite: (imageHash, viewport, dpr,
 * modelId, modelVersion, inferenceConfigHash) — so a viewport resize or a
 * config change (e.g. INFERENCE_THRESHOLD) correctly misses instead of
 * returning a stale result (plan §8.2 rules 3/4).
 *
 * Empty detections are a valid, expected outcome (flat/synthetic pages) and
 * are returned as an empty array rather than treated as an error.
 */
export async function runVisionAnalysis(input: RunVisionAnalysisInput): Promise<RawVisionResult> {
  const cacheParams = {
    screenshotDataUrl: input.screenshotDataUrl,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    devicePixelRatio: input.devicePixelRatio,
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    inferenceConfigHash: INFERENCE_CONFIG_HASH,
  };

  const cached = lookupVisionCache(cacheStore, { ...cacheParams, requestId: input.requestId });
  if (cached) return cached;

  const { detector, backend } = await ensureDetector();
  const prepared = await prepareScreenshotForModel(input.screenshotDataUrl);

  const t0 = performance.now();
  const raw = await detector(prepared.dataUrl, { threshold: INFERENCE_THRESHOLD });
  const inferenceTimeMs = performance.now() - t0;

  const result: RawVisionResult = {
    requestId: input.requestId,
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    backend,
    imageWidth: prepared.modelSize.width,
    imageHeight: prepared.modelSize.height,
    detections: mapDetections(raw),
    inferenceTimeMs,
    cached: false,
  };

  storeVisionCache(cacheStore, cacheParams, result);
  return result;
}

/** Test/debug hook: current cache size (used by verify.js Phase 4 checks). */
export function getVisionCacheSize(): number {
  return cacheStore.size;
}
