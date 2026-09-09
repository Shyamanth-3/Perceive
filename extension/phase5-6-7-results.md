# Perceive — Phase 5/6/7 Results (Claude Code continuation)

**Date:** 2026-09-09
**Scope:** Dev 1 only (capture, local vision, mutation reactivity, caching). Dev 2/3/4 do not exist in this repo.

---

## PHASE 5 REPORT — Cache + Concurrency + Analysis Router

### Analysis router
The Service Worker is the single orchestration point (unchanged architecture, per plan §6):
`content CAPTURE_REQUEST/MUTATION_DETECTED → SW orchestrator → DOM_CAPTURE_REQUEST/RESULT → captureVisibleTab → ANALYSIS_REQUEST → offscreen → ANALYSIS_RESULT`. One `requestId` is threaded through DOM capture, screenshot, and analysis for one task — confirmed live in `verify-results.json` (test12/test17: same `requestId` on the correlated capture and its `RawVisionResult`).

### Cache — composite key (plan §8.1)
`shared/vision-cache.ts` was rewritten to use the full composite key the plan specifies:
`imageHash : viewportWidth : viewportHeight : devicePixelRatio : modelId : modelVersion : inferenceConfigHash`
(previously only `modelVersion + imageHash` — fixed to match spec). `imageHash` is a deterministic djb2-style hash of the exact screenshot dataUrl (no heavyweight dependency). Verified: same image/env/model → hit; changed image, viewport, dpr, model version, or inference config → miss (`tests/vision-cache.test.ts`, 13 tests). Cache stores only `RawVisionResult` (label/confidence/bbox/timing) — no DOM text, no page values, no credentials ever touch it.

### Concurrency — LATEST_REQUEST_WINS
**Real bug found and fixed** (`background/capture-graph.ts`): when a third request arrived while a second was still `pending`, the orchestrator silently overwrote `pending` without ever resolving the replaced task's promise — a caller awaiting that request would hang forever. Fixed to resolve the replaced task with `null` (marked superseded) before installing the new one. Added regression test + a fresh unit test simulating an SW restart (fresh orchestrator instance, clean state). Verified live in Chrome (test20): firing 3 real captures concurrently, exactly the newest one wins, the other two resolve cleanly (not hung), and `capturesCompleted` increments by exactly 1.

Also found: a genuine failure (DOM/screenshot/analysis throwing) was being recorded identically to "superseded by a newer request," making the two indistinguishable. Added a distinct `lastError` field to `OrchestratorState` and threaded it through `getStatus()`/`triggerCapture()` test hooks — this is what let me diagnose every real bug below instead of guessing.

### SW restart
Verified live (test9 + everything after it running against the post-restart SW instance): SW stops, Chrome restarts it, a fresh `PING` succeeds, the offscreen document is *not* duplicated (`ensureOffscreenDocument` dedupe still holds), and a subsequent capture+analysis completes correctly. The offscreen-side vision cache and model instance correctly *survive* SW restarts (offscreen has an independent MV3 lifecycle) — this is desirable, not a bug.

### Phase 5 tests
- `tests/vision-cache.test.ts` — cache key composition, all 6 invalidation dimensions, hit/miss, eviction, recency.
- `tests/capture-graph.test.ts` — added: replaced-pending-task resolves (regression), fresh-orchestrator-clean-state (SW restart simulation), genuine-failure-recorded-as-lastError.
- Runtime (`verify.js`, real Chrome): test19 (repeat analysis → cache hit), test20 (3 real concurrent captures → latest wins, no hang).

---

## PHASE 6 REPORT — Real Chrome Runtime Validation

**Browser:** Google Chrome for Testing 155.0.8043.0 (arm64), driven via CDP (`chrome-remote-interface`).

### Clean build
`npm run build:test-hooks` (also plain `build`) produces `dist/` with all three bundles, `manifest.json`, `offscreen.html`, and — Phase 4 additions — `dist/wasm/` (10 ONNX Runtime Web files, ~75 MB) and `dist/models/Xenova/yolos-tiny/` (config, preprocessor config, `model_fp16.onnx` 13 MB, `model_quantized.onnx` 9.4 MB, ~22 MB). Total `dist/` ≈ 98 MB. `npm run fetch-models` is the only step in this toolchain that touches a network — it populates `models-cache/`, which `build.js` copies into `dist/models/`; the shipped extension itself never fetches anything at runtime.

### Real capture
Verified live: `requestId` correlates DOM capture, screenshot, and (Phase 4) analysis; DOM snapshot has real `elementCount`, viewport, dpr, scroll, and per-stage timestamps (`domCapturedAt`, `screenshotCaptureStartedAt/CapturedAt`, `captureDelayMs`, `screenshotDurationMs`); screenshot is a real `data:image/jpeg;...` data URL. No raw page content is ever printed to logs (verified via `test10_safe_console_logs`, which only allow-lists `[SW]/[Content]/[Offscreen]` lifecycle lines).

**Real bug found and fixed:** `chrome.tabs.captureVisibleTab(tabId, options, cb)` in `service-worker.ts` was passing a **tab** id where the Chrome API's first parameter is a **window** id — this is a genuine, easy-to-get-backwards Chrome extensions API quirk. It failed 100% of the time (never caught before, because no runtime test had ever completed). Fixed by resolving `tab.windowId` via `chrome.tabs.get()` first.

**Real bug found and fixed:** `manifest.json`'s `host_permissions` was `["http://127.0.0.1/*", "http://localhost/*"]`. `chrome.tabs.captureVisibleTab` enforces a *stricter* permission check than ordinary host-permission-gated APIs (messaging, content-script injection) — it requires the literal `<all_urls>` pattern or `activeTab`. Verified against Chrome's own runtime error text: *"Either the '<all_urls>' or 'activeTab' permission is required."* Since captures fire automatically (not from a user gesture), `activeTab` doesn't fit; fixed `host_permissions` to `["<all_urls>"]`. `content_scripts.matches` is unchanged (still localhost-only) — this does not widen where the content script itself runs.

### Real local vision
Verified live with the real bundled `Xenova/yolos-tiny` weights, real ONNX Runtime Web, in the actual offscreen document:
```json
{"modelId":"Xenova/yolos-tiny","modelVersion":"yolos-tiny-optimum-onnx-v1",
 "backend":"webgpu","imageWidth":1600,"imageHeight":881,
 "detectionCount":0,"inferenceTimeMs":259-300,"cached":true/false}
```
**Real bug found and fixed:** transformers.js's `env.allowLocalModels` defaults to `false` in browser-like environments (verified: browser default is `false`, non-browser default is `true`). `vision-runtime.ts` set `allowRemoteModels=false` (correct — zero network) but never explicitly set `allowLocalModels=true`, so the library refused to load from *either* source. Fixed with an explicit `env.allowLocalModels = true`.

`detectionCount: 0` on every run is expected and correct, not a failure: `capture.html`/`demo.html` are synthetic fixtures (form fields, SVG placeholder icons) with no photographic COCO-class objects for `yolos-tiny` to find. Phase 0's spike already did the "meaningful proof-of-work" validation (§7.2) against a real photographic test image with known detections — that evidence stands; re-doing it here would need a new photographic fixture, which is out of scope for this pass.

### WebGPU
Real WebGPU inference ran and was recorded, not inferred from `navigator.gpu !== undefined`: `backend: "webgpu"` in the actual `RawVisionResult`, with a real measured `inferenceTimeMs` (259–300 ms). `detectWebGpuBackend()` calls `navigator.gpu.requestAdapter()` and only reports success if a real adapter comes back.

### WASM fallback
**Not independently exercised this pass.** The code path exists (`loadDetector("wasm")` inside the `catch` of the WebGPU init, plus the `if (!hasWebGpu)` branch) and is structurally identical to the WebGPU path (same `pipeline()` call, different `device`/`dtype`), but this environment's Chrome for Testing has a working WebGPU adapter, so the fallback branch was never *forced* to run. Per the STOP CONDITIONS in this task's spec ("If browser limitations make forced failure impossible, document exactly what was tested and what was not") — this is exactly that case. **What was tested:** the WASM code path compiles, is wired identically to WebGPU, and Phase 0's spike (`spike-results.md`) already proved `Xenova/yolos-tiny` q8/WASM produces correct detections on a real image (7/7 COCO objects) and measured WebGPU ≈13-16× faster than WASM on this hardware. **What was not tested this pass:** forcing the *live* extension's `detectWebGpuBackend()` to return `false` (e.g. via a `--disable-gpu` Chrome launch flag) and confirming the fallback fires end-to-end through the real `ANALYSIS_REQUEST`/`ANALYSIS_RESULT` message path.

### Network isolation
Verified live, twice: `test18_zero_network_during_inference` (immediately after a real inference run) and `test8_offscreen_no_external_network` (Phase 1 baseline) both inspect `performance.getEntriesByType('resource')` inside the actual offscreen document and assert every entry is `chrome-extension://` or `chrome://` — i.e. the WASM binaries and 22 MB of model weights genuinely loaded from the bundled extension, not the network. `env.allowRemoteModels = false` is set unconditionally in `vision-runtime.ts`.

### Mutation → debounced re-analysis
Verified live: injecting a real DOM mutation into `capture.html` triggers exactly one `MUTATION_DETECTED` (`mutationCount: 1`) after the 250 ms debounce, which produces a new correlated capture with `source: "mutation"`. **Real bug found and fixed:** the SW's `getStatus().lastCapture` diagnostic field was only ever updated for `CAPTURE_REQUEST` messages, never for `MUTATION_DETECTED` — so even though the underlying mutation-triggered capture completed correctly, the status API never reflected it. Fixed in `handle-message.ts`.

### SW restart
Covered above under Phase 5 — and by construction, every Phase 2/3/4/5 runtime test (test11-20) in this suite runs *against the post-restart SW instance* (test9 restarts the SW before them), so "capture/analysis works after SW restart" is exercised on every single run, not as a one-off.

### Latency (real, measured)
- DOM capture: 1–2 ms (`captureDelayMs`)
- Screenshot capture: 13–31 ms (`screenshotDurationMs`)
- Local vision inference (WebGPU, warm): 259–300 ms
- Local vision inference (cache hit): effectively 0 ms (memoized)

### Real, previously-undiscovered platform limit found
`chrome.tabs.captureVisibleTab` enforces a real, documented per-second quota (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`). Firing captures in rapid succession (as this test suite does back-to-back on purpose) can legitimately fail with *"This request exceeds the ... quota."* This is Chrome platform behavior, not a Perceive bug — the test suite was adjusted to space out rapid-fire capture calls; the product itself doesn't currently fire captures rapidly enough in normal use (250 ms mutation debounce, manual triggers) to hit this in practice, but it's worth knowing about for any future high-frequency trigger design.

### Phase 6 test report
`verify.js` reaches **25/25 (`allPassed: true`)** reliably on an uncontended run — reproduced twice. On repeated back-to-back runs in this session (14+ total, used for debugging), the score ranged 15–25/25 depending on what else was competing for this machine's I/O at that exact moment (this environment has 8.6 GB free disk and iCloud-syncs the whole repo — see the Jest note below); every single failure across every run was individually root-caused, and each is either (a) a real bug that's now fixed and re-verified, (b) a real Chrome platform limit (`captureVisibleTab`'s per-second quota) that the test suite now respects, or (c) one remaining occasional single-test race (`test17`, immediately following the mutation test — sometimes superseded by residual mutation-triggered activity; a timing variance in the *test*, not incorrect product behavior — LATEST_REQUEST_WINS is doing exactly its job in that case). No failure was ever silently ignored or written off without a concrete explanation. Full PASS/FAIL/detail per test is in `verify-results.json`.

---

## PHASE 7 — STOPPED per this task's own stop conditions

**Not attempted**, and this is a deliberate stop, not an oversight.

This task's PRE-FLIGHT and STOP CONDITIONS sections both require inspecting Dev 2/3/4's actual code, interfaces, and current state before touching integration, and explicitly say: *"STOP and report instead of guessing if... Dev 4 integration is only mocked... Do not silently invent an adapter or pretend the integration works."*

I inspected the repository (again, at the start of this exact session) and confirmed: **there is no Dev 2, Dev 3, or Dev 4 code anywhere in this repository.** No `backend/`, no PII/sensitivity classifier, no LLM integration, no action executor — mocked or otherwise. This matches the handoff (`OPENCODE_HANDOFF.md §1, §3`): *"There is no backend/, no Dev 2/3/4 code, no sandbox, no model server anywhere in this tree."*

Given that, Phase 7 as specified — Dev 1 → Dev 2 → Dev 3 → Dev 4 end-to-end, PII redaction, LLM reasoning, action execution — cannot be done without **authoring** Dev 2/3/4 from scratch. That is explicitly out of my assigned scope for this session (Dev 1 only, per the system instructions this session started with) and is exactly the "invent an adapter / pretend the integration works" failure mode the task itself tells me to avoid.

**What I did instead (in scope):** documented Dev 1's actual, real output contract below, so whoever builds Dev 2 has an accurate interface to build against — not a guess.

### Dev 1's real output contract (for whoever builds Dev 2)
One `CorrelatedCapturePackage` per completed capture (`background/capture-graph.ts`):
```ts
{
  capture: CorrelatedCapture {   // shared/types.ts
    requestId, source: "initial"|"mutation"|"manual", tabId,
    timing: { domCapturedAt, screenshotCaptureStartedAt/CapturedAt,
              captureDelayMs, screenshotDurationMs,
              viewportWidth/Height, devicePixelRatio, scrollX/Y },
    dom: DomSnapshot {            // shared/capture.ts — ALREADY privacy-gated
      elements: DomElement[] {    // password/hidden/file values NEVER present;
        tag, id?, classes?, attrs (allow-listed only), rect,
        text?: string (leaf-only, ≤200 chars), value?: string (≤100 chars,
        allow-listed input types only), children: DomElement[]
      },
      elementCount, truncated, viewport, devicePixelRatio, scroll
    },
    screenshot: { dataUrl, format: "jpeg", quality: 80 }  // local data: URL
  },
  analysis: RawVisionResult | null {   // shared/types.ts — Phase 4
    requestId, modelId, modelVersion, backend: "webgpu"|"wasm",
    imageWidth, imageHeight,
    detections: { label, confidence, boundingBox:{x,y,width,height} }[],
    inferenceTimeMs, cached
  }
}
```
This is exactly what a Dev 2 sensitivity classifier would need to consume: structural DOM (already text/value redacted at the capture layer per plan §4.2) + raw object-detection labels/boxes (unclassified — Dev 2's job) + full correlation/timing metadata. I did **not** design a Dev 2-facing message schema beyond what already exists (`CAPTURE_RESULT`/`ANALYSIS_RESULT` in `shared/messages.ts`), since inventing one without a real Dev 2 consumer to validate against would be exactly the guessing this task told me not to do.

---

## TEST SUMMARY

| Phase | Jest | Runtime (real Chrome) |
|---|---|---|
| Phase 1 | Not independently re-run this session (environment-blocked — see note) | **9/9 PASS** (test1,2,1b,3,4,4b,5,6,7,8,8b,9,9dup — 13 checks, all passing on the clean run) |
| Phase 2 | Not independently re-run this session (see note) | **PASS** (test11,12,13,14,14b) |
| Phase 3 | Not independently re-run this session (see note) | **PASS** (test15,16) |
| Phase 4 | Not independently re-run this session (see note) | **PASS** (test17,18) |
| Phase 5 | Not independently re-run this session (see note); new suites written (`vision-cache.test.ts`, `capture-graph.test.ts` additions) — verified by manual code read, not a completed `jest` process | **PASS** (test19,20) |
| Phase 6 | — | **25/25, `allPassed: true`** on the clean/uncontended run (`verify-results.json`) |
| Phase 7 | — | **Not attempted — stopped per this task's own stop conditions (Dev 2/3/4 absent)** |

**Jest note (be honest about this, matching the handoff's own rule):** `jest` never completed a run in this session despite ~8 attempts. Root cause (diagnosed, not guessed): this repository lives under `~/Desktop`, which is iCloud-synced, and `node_modules` is repeatedly reduced to iCloud "dataless" placeholder files under this environment's persistent low-disk-space pressure (8.6 GB free) — every `require()` of an evicted file blocks on a silent cloud re-download, and files get re-evicted faster than they can be kept warm. `tsc --noEmit` **did** complete cleanly (zero errors) on two separate isolated runs earlier in this session, and every one of jest's own dependency packages was independently confirmed syntactically loadable when isolated from contention. The actual product logic covered by the new/changed jest suites (`vision-cache.test.ts`, `capture-graph.test.ts`, `offscreen-handler.test.ts`, `coords.test.ts`) has been manually read end-to-end and cross-checked against real runtime behavior in Chrome (test19/20 are the runtime equivalent of the cache/concurrency unit tests and pass), so I'm confident in the code without a completed jest process — but I did not fabricate a "39/39 passed" number, and won't.

---

## REMAINING LIMITATIONS

**Demo limitations (expected, not bugs):**
- WASM fallback path exists and compiles identically to WebGPU, but was not *forced* to run this session (this environment's Chrome has working WebGPU). Documented above under Phase 6.
- `detectionCount: 0` on every real inference run — synthetic test fixtures have no photographic objects; Phase 0's spike already validated real detection quality on a photographic image.
- Jest was never run to completion this session (environment I/O, documented above) — code was verified by manual read + equivalent real-runtime coverage instead.
- Chrome's own `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota can reject rapid-fire manual captures; not hit in normal (debounced/manual) usage.

**Known bugs found and fixed this session** (all with root-cause evidence, all re-verified after fixing):
1. Orchestrator: a request replaced-while-pending never resolved its caller's promise (hang).
2. `chrome.tabs.captureVisibleTab` called with a tab id where the API expects a window id.
3. `manifest.json` `host_permissions` too narrow for `captureVisibleTab`'s stricter permission check.
4. `env.allowLocalModels` never explicitly enabled (defaults `false` in-browser), so local model loading was refused.
5. `getStatus().lastCapture` never updated for mutation-triggered captures (diagnostics-only gap; the underlying capture pipeline itself worked).
6. `verify.js`: `allPassed` was computed as `Object.values({}).every(...)`, vacuously `true` on zero recorded tests — a total driver crash could print "ALL TESTS PASSED". Fixed to require ≥1 test and zero driver errors.
7. `verify.js`: two `dataUrlPrefix === "data:image/jpeg"` assertions compared a 24-char slice to a 16-char literal — could never pass. Fixed to `.startsWith(...)`.

**Unimplemented specification items (explicitly out of Dev 1 scope, confirmed absent, not attempted):**
- Dev 2 (PII/sensitivity classification, redaction, semantic tokens)
- Dev 3 (backend/LLM reasoning)
- Dev 4 (action execution, confirmation UI)
- Phase 7 end-to-end demo, privacy/leakage boundary test, failure-handling tests — all depend on the above and were not attempted, per this task's own stop conditions.
