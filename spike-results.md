# Phase 0 — Runtime Spike & Model Benchmark Results (`spike-results.md`)

**Deliverable for Phase 0 (§3.1/§3.2 decision matrix, §7.1 model benchmark, §7.2 proof-of-work, license verification).** Phase 1 has **not** started and will not begin until approved.

- **Date:** 2026-09-08
- **Hardware:** Apple M4 (Apple Silicon, Metal-3)
- **Runtime:** Google Chrome for Testing **155.0.8043.0** (arm64) via CDP (`chrome-remote-interface`).
  - Official Google Chrome 152 rejects `--load-extension` / `--disable-extensions-except` ("not allowed in Google Chrome, ignoring"); Chrome for Testing is used instead.
- **Toolchain:** Node v24.15.0, npm 11.12.1, Python 3.14.3 (PIL 12.2.0), `@huggingface/transformers@4.2.0`, `onnxruntime-web@1.29.0`, esbuild.
- **Artifacts:** `phase0-spike/` (throwaway spike extension + `drive.js` CDP driver), `phase0-spike/spike-live.json` (raw measured results).

---

## 1. Decision Matrix (§3.1 Spike Tests → §3.2)

Test extension: MV3, `type: "module"` service worker + offscreen document, shared `model-runtime.js`,
`content_security_policy: { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" }`.

Deterministic test input (fixed across all cells): COCO sample `cats.jpg` (640×480), base64-embedded in the bundle —
same image used in the model card, giving known ground-truth detections. Threshold 0.3.

| Cell | Context | Backend | `navigator.gpu` | Adapter | Init | Real inference | Latency (init / first / warm) | Result / Error |
|---|---|---|---|---|---|---|---|---|
| A1 | Service Worker | WASM | N/A | N/A | **FAIL** | FAIL | — | `TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification` |
| A2 | Service Worker | WebGPU | **YES** | **YES** (`apple`, `metal-3`) | **FAIL** | FAIL | — | Same `import() is disallowed` (blocked before a backend can be assembled) |
| B1 | Offscreen doc | WASM | N/A | N/A | **PASS** | **PASS** | 560.9 / **7,282.3** / 7,146.1 ms | 7 detections (`cat`, `remote`, `couch`) |
| B2 | Offscreen doc | WebGPU | **YES** | **YES** (`apple`, `metal-3`) | **PASS** | **PASS** | 99.1 / **553.5** / 451.4 ms | 7 detections (`cat`, `remote`, `couch`) |

**Key empirical findings:**

1. **WebGPU availability is not the blocker.** `navigator.gpu` and a Metal-3 adapter are present in *both* the service worker and the offscreen document. Do **not** assume WebGPU fails in a SW — it exists; the runtime simply cannot be imported there.
2. **Both SW cells fail identically.** ONNX Runtime Web performs a dynamic `import()` (`ort-wasm-simd-threaded.*.mjs`), which the HTML spec forbids on `ServiceWorkerGlobalScope`. This is a hard, runtime-level blocker for **both** WASM and WebGPU backend assembly in a service worker. Not configurable; not a workaround issue.
3. **Offscreen is strictly required.** B1 and B2 succeed with identical, correct detections on the same input.
4. **WebGPU is ~13× faster than WASM** on first inference and ~16× on warm inference for the same model/image (offscreen).
5. **All init numbers are cold-cache**: each run uses a fresh temp profile (`mkdtemp`), so model weights are re-fetched/downloaded every run. The ~99–561 ms "init" reflects pipeline/session construction after a local chrome-extension:// WASM fetch + Model-API download in the same run; total first-usable time is init + first inference.

---

## 2. Architecture Decision (§3.3 Decision Rules)

```
A2 (SW+WebGPU): FAIL  → rule 1 not met
A1 (SW+WASM):   FAIL  → rule 2 not met
B2/B1 (Offscreen): PASS → apply rule 3
```

**Decision: Offscreen Document, reason `WORKERS`** — validated, not assumed:

- The bundled WASM asset set is the **threaded build** (`ort-wasm-simd-threaded.*`), onnxruntime-web's Web-Worker-pool CPU backend, plus the **jsep** build (WebGPU execution provider run in a dedicated worker). Both genuinely spawn Web Workers to run inference.
- A worker-pool/Asyncify execution host requires a window-like context that supports dynamic `import()` and the `Worker` constructor — precisely the capability the service worker lacks (observed failure).
- The `WORKERS` justification is therefore real (runtime spawns Web Workers for threaded WASM and for WebGPU), and the offscreen document is the actual execution host, not a workaround.
- Detection on production (Chrome 116+): use `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })`; if absent, create via `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Local ONNX object-detection inference requires Web-Worker-based WASM/WebGPU execution.' })`.

**Consequence for Phase 4:** the inference host is the **offscreen document**; the service worker remains the message router/state holder.

---

## 3. WebGPU / WASM Backend Strategy

- **Primary: WebGPU** (`device: "webgpu"`, `dtype: "fp16"`) — 553 ms first / 451 ms warm on yolos-tiny, no threading side effects.
- **Fallback: WASM** (`device: "wasm"`, `dtype: "q8"`) — ~7.3 s first inference on the same image; correct but slow. Confirmed working.
- **Runtime feature detection** (both offscreen): `navigator.gpu?.requestAdapter()`; adapter probe returns `{vendor: apple, arch: metal-3}` in the offscreen document. If adapter acquisition fails (or wasm is forced), fall back to WASM with `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/')`.
- **CSP:** `'wasm-unsafe-eval'` in `extension_pages` is required; without it, ORT fails with `WebAssembly.instantiate ... neither 'wasm-eval' nor 'unsafe-wasm-eval'` even in the offscreen document.
- **Assets:** WASM glue/binaries copied from the bundled `onnxruntime-web/dist/` into `wasm/` (bundler step in `phase0-spike/build.js`).

---

## 4. Model Benchmark (§7.1)

Candidates evaluated (both are Optimum ONNX conversions by Xenova of Hugging Face **YOLOS**): `yolos-tiny`, `yolos-base`.
Measured on the same 640×480 COCO image, threshold 0.3, offscreen document.

| Metric | **yolos-tiny** | **yolos-base** |
|---|---|---|
| ONNX weight size (fp16 / q8) | **13.3 / 9.7 MB** | 256 / 248 MB |
| Cold init — WebGPU | 99 ms | 23,878 ms (dominated by 256 MB fp16 download) |
| Cold init — WASM | 561 ms | 21,518–25,519 ms (dominated by ~248 MB q8 download) |
| First inference — WebGPU | **553.5 ms** | 3,934.6 ms |
| Warm inference — WebGPU | **451.4 ms** | 2,934.2 ms |
| First inference — WASM | 7,282 ms | 46,701 ms |
| Warm inference — WASM | 7,146 ms | 49,523 ms |
| Detections on COCO test (valid) | **7** (`cat`, `remote`, `couch`) | 3–5 (`bed`, `remote`, `cat`) |
| Bounding-box quality | Correct, tight | Correct, tight; slightly better label granularity (`bed`), misses far `remote` at thr 0.3 on WebGPU |
| Memory footprint | Low (fits offscreen with headroom) | High; co-loading tiny+base OOM'd the offscreen doc (`std::bad_alloc`); usable only standalone |
| License | Apache-2.0 | Apache-2.0 |

**Decision: `yolos-tiny`.** It is the only candidate compatible with the product's local-only, low-memory, single-offscreen-document constraint; delivers real detections at interactive latency on WebGPU (≈0.5 s). yolos-base offers marginal detection granularity at **20–50×** the size cost, several-second latencies, and OOM pressure. (Face/sensitivity classification is Dev 2's scope; yolos-tiny bounding boxes are its input, consistent with item-level detection at scale.)

---

## 5. Meaningful Proof-of-Work Validation (§7.2)

Validated, not a 1×1 smoke test. Test image is a deterministic, known-content COCO frame bundled as base64 (`phase0-spike/extension/src/test-image-b64.js`). Checks performed on both offscreen backends:

1. **No throw** — both B1 (WASM) and B2 (WebGPU) complete.
2. **Valid output structure** — array of `{ score, label, box: {xmin, ymin, xmax, ymax} }` records.
3. **Expected labels present** — detections include `cat` (0.91–0.92), `remote` (0.99), `couch` (0.51–0.73), matching the model card's reference output on this exact image.
4. **Confidence in valid range** — all scores ∈ [0,1].
5. **Bounding boxes numerically valid** — integer coords within the 640×480 frame (no NaN/zeros), visually consistent with the two cats and remotes.

Honest iteration note: earlier synthetic silhouettes (`person_scene.png`) were *not* detected by yolos-tiny (one false "traffic light" at thr 0.5, zero at thr 0.3). That tuned-in on-image realism as a requirement for meaningful validation and for the real product's screenshot pipeline — arbitrary page screenshots must be treated as noisy input.

---

## 6. License Verification (§7.1)

- Upstream YOLOS models `hustvl/yolos-tiny` / `hustvl/yolos-base` (`huggingface.co/api/models/...`): **`license: apache-2.0`** on the model cards.
- `Xenova/yolos-tiny` + `Xenova/yolos-base` READMEs declare `base_model: hustvl/yolos-tiny|base` and are plain Optimum ONNX exports of the same weights (no added terms, same license carries through). Transformers.js loads the Xenova ONNX repos; the Apache-2.0 provenance is confirmed and is compatible with hackathon/demo use and redistribution with attribution.
- Runtime deps: `@huggingface/transformers` and `onnxruntime-web` are Apache-2.0 / MIT respectively. Test image `cats.jpg` is from the HF `transformers.js-docs` dataset (used for PoW validation only, not shipped in the product).

---

## 7. Recommendations & Consequence Summary

1. **Host:** Offscreen document (`reason: WORKERS`, valid) for all ONNX inference; SW is the router only.
2. **Backend:** WebGPU primary, WASM fallback; feature-gate on `navigator.gpu.requestAdapter()`; keep `wasm-unsafe-eval` CSP.
3. **Model:** `Xenova/yolos-tiny` (fp16 for WebGPU, q8 for WASM fallback), ~10–13 MB, local-only, Apache-2.0.
4. **Timing targets unlocked:** sub-second local inference on modern Apple-Silicon/WebGPU devices; WASM fallback is slow (~7 s) but functional.
5. **Known constraints recorded for later phases:** single-offscreen memory budget (no multi-model residency); cold-cache init dominates first-use cost; synthetic/flat screenshots may produce zero detections → the product must handle empty results gracefully and rely on Dev 2's assessment layer.

**Phase 1 (MV3 scaffold, build config, shared types/messages) is now cleared to proceed on approval.**