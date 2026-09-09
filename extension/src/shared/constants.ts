/**
 * Stable cross-extension constants. Everything configurable about the
 * scaffold and, later, the inference pipeline is centralized here so it
 * can be changed in one place and validated by unit tests.
 */

export const EXTENSION_NAME = "Perceive";
export const EXTENSION_VERSION = "0.1.0";

/** Offscreen document URL, relative to the extension root. */
export const OFFSCREEN_URL = "offscreen/offscreen.html";

/**
 * The single validated offscreen creation reason. Phase 0 proved the ONNX
 * Runtime Web execution path genuinely spawns Web Workers (threaded WASM
 * build and WebGPU/jsep execution runner), so `WORKERS` is correct and we
 * must never add arbitrary reasons.
 */
export const OFFSCREEN_REASON = "WORKERS";

export const OFFSCREEN_JUSTIFICATION =
  "Local ONNX object-detection inference runs in Web-Worker-based WASM/WebGPU execution threads, which requires an offscreen document.";

/** Selected model (Phase 4 will bundle these assets locally). */
export const MODEL_ID = "Xenova/yolos-tiny";
export const MODEL_DTYPE_GPU = "fp16";
export const MODEL_DTYPE_CPU = "q8";

/**
 * Model version used for cache keys + results. Bump when swapping the bundled
 * weights so stale on-device caches are naturally invalidated.
 */
export const MODEL_VERSION = "yolos-tiny-optimum-onnx-v1";

/** Object-detection inference parameters (kept config-stable). */
export const INFERENCE_THRESHOLD = 0.3;
export const INFERENCE_CONFIG_HASH = "thr=0.3:dtype=webgpu-fp16/wasm-q8";

/** Screenshot capture settings (plan §7.3). */
export const SCREENSHOT_FORMAT = "jpeg";
export const SCREENSHOT_QUALITY = 80;
/** Compress screenshots above this many pixels (long edge) before inference. */
export const SCREENSHOT_MAX_LONG_EDGE = 1600;

/** MutationObserver → capture debounce (plan §5.1 / master doc ~250 ms). */
export const MUTATION_DEBOUNCE_MS = 250;

/** Structural visible-text truncation cap (plan §4.2 A). */
export const STRUCTURAL_TEXT_LIMIT = 200;

/** Max length of captured user-entered values (plan §4.2 B). */
export const USER_VALUE_LIMIT = 100;

/**
 * Dev 5 integration: any element (and its whole subtree) carrying this
 * attribute is the extension's OWN injected UI, not page content — Dev 1's
 * capture walker must skip it entirely so it never reaches Dev 2
 * classification, the sanitized payload, or the LLM. Dev 5's status panel is
 * the only current user of this marker.
 */
export const PERCEIVE_UI_MARKER_ATTR = "data-perceive-ui";

/** Content-script match patterns (currently restricted to local test pages). */
export const CONTENT_MATCHES = ["http://127.0.0.1/*", "http://localhost/*"];

/**
 * manifest.json `host_permissions` MUST be `<all_urls>` — not narrower
 * patterns like `http://127.0.0.1/*` — because `chrome.tabs.captureVisibleTab`
 * enforces a stricter check than ordinary host-permission-gated APIs
 * (`chrome.tabs.sendMessage`, content-script injection, etc. all work fine
 * with a narrow pattern). Chrome's own runtime error, verified against a
 * real build: "Either the '<all_urls>' or 'activeTab' permission is
 * required." `activeTab` doesn't fit here because captures fire
 * automatically (PING/mutation-triggered), not from a user gesture. This
 * does NOT widen where the content script itself runs — that stays scoped
 * to `CONTENT_MATCHES` above.
 */

export const TEST_HOOKS = process.env.TEST_HOOKS === "1";