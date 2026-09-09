# Perceive — Chrome Extension (Dev 1: Capture + Local Vision)

Private, local-only web-privacy overlay. This extension implements Dev 1's scope: the
MV3 scaffold, a typed messaging backbone between a Service Worker / Content Script /
Offscreen Document, synchronized DOM+screenshot capture, mutation reactivity, and local
(on-device) object-detection inference. Nothing captured ever leaves the device.

## Status

- **Phase 0 (spike)**: complete. Decided inference host = offscreen document, backend =
  WebGPU primary / WASM fallback, model = `Xenova/yolos-tiny`. See `../spike-results.md`.
- **Phase 1 (MV3 scaffold)**: complete, runtime-verified (39/39 Jest, 14/14 `verify.js`).
- **Phase 2 (synchronized capture graph)**: implemented — structural DOM walk +
  screenshot + correlation metadata (`shared/capture.ts`, `background/capture-graph.ts`).
- **Phase 3 (reactivity)**: implemented — 250ms-debounced `MutationObserver`,
  navigation cache invalidation, LATEST_REQUEST_WINS (`content/mutation-watcher.ts`).
- **Phase 4 (local vision)**: implemented — WebGPU-primary/WASM-fallback object detection
  (`Xenova/yolos-tiny`) running in the offscreen document, on-device inference cache
  (`shared/vision-cache.ts`), zero runtime network (`env.allowRemoteModels = false`).
  Requires `npm run fetch-models` once to populate the bundled weights (see Build below).

## Why inference lives in an Offscreen Document

ONNX Runtime Web cannot initialize in a Manifest V3 **service worker**:

> `TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification`

This fails for both WASM and WebGPU backends. The offscreen document is a full page
context the browser keeps alive for us, so it can:

1. `import()`/load model+backend code (no dynamic-import restriction),
2. use Web Workers (`WORKERS` reason) which is what ORT's threaded WASM and WebGPU-in-worker
   builds require.

The SW therefore stays a thin message router and never loads the model.

## Architecture

```
┌─────────────┐  chrome.runtime.onMessage   ┌──────────────────┐  portal  ┌─────────────────┐
│ Content     │ ──────────────────────────▶ │ Service Worker   │ ───────▶ │ Offscreen       │
│ Script      │ (PING, later DOM_CAPTURE…)  │ (router, state)  │          │ Document (host) │
└─────────────┘                             └──────────────────┘          │ future inference│
                                                                          └─────────────────┘
```

- `src/content/content-script.ts` — runs on `http://127.0.0.1/*` and `http://localhost/*`;
  sends `PING` (retried 15×750ms to survive worker restarts), then answers
  `DOM_CAPTURE_REQUEST` and reports debounced `MUTATION_DETECTED` events.
- `src/background/service-worker.ts` — module worker; routes messages via
  `handle-message.ts`; owns offscreen lifecycle + the LATEST_REQUEST_WINS capture
  orchestrator (`capture-graph.ts`).
- `src/offscreen/` — answers `OFFSCREEN_PING`, and (Phase 4) `ANALYSIS_REQUEST`: runs
  local object-detection inference (`vision-runtime.ts`, `image-prep.ts`) and returns a
  `RawVisionResult`. Never fetches anything at runtime.
- `src/shared/` — contracts: `messages.ts` (typed union + `parseMessage`), `request-id.ts`,
  `types.ts`, `constants.ts`, `offscreen-lifecycle.ts` (idempotent
  `ensureOffscreenDocument`, reason = `WORKERS`), `capture.ts` (DOM privacy gate),
  `coords.ts` (CSS/screenshot/model pixel conversions), `vision-cache.ts` (on-device
  inference cache).

Every message carries a `requestId` + `timestamp` + `origin` so replies can be correlated.

## Security posture

- CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` — no remote code, no
  blanket `unsafe-eval`.
- Zero runtime network: model weights, WASM, and the ONNX runtime are all bundled into
  the extension (`dist/models/`, `dist/wasm/`, `web_accessible_resources`) and loaded via
  `chrome.runtime.getURL(...)`; `env.allowRemoteModels = false` in `vision-runtime.ts`.
  The only network access anywhere in this repo is the one-time, explicit
  `npm run fetch-models` build-time download — never the shipped extension itself.
- Privacy gate (Phase 2, `shared/capture.ts`): password/file/hidden input values and
  `contenteditable` content are never captured; other input values are allow-listed by
  type and truncated (`USER_VALUE_LIMIT`); structural text is leaf-node only, truncated
  (`STRUCTURAL_TEXT_LIMIT`); vision detections carry no PII classification (that's Dev 2).
- Logging: only lifecycle lines (`[SW] started`, `[Content] loaded`, `[Offscreen] ready`);
  never page content, DOM, screenshots, or detection contents.
- All network is off except the exact sites the user navigates to.

## Repository layout

```
extension/
  src/
    manifest.json           MV3 manifest (module SW, offscreen permission, CSP, matches,
                             web_accessible_resources for wasm/*, models/*)
    background/             service-worker.ts, handle-message.ts, capture-graph.ts
    content/                content-script.ts, dom-capture.ts, page-state.ts,
                             mutation-watcher.ts
    offscreen/               offscreen.html + offscreen.ts + handle-message.ts +
                             vision-runtime.ts + image-prep.ts (Phase 4)
    shared/                  messages, request-id, types, constants, offscreen-lifecycle,
                             capture.ts (privacy gate), coords.ts, vision-cache.ts
    global.d.ts             ambient types for test hooks
  tests/                    Jest unit suites
  server/                   wake.html, capture.html, demo.html (verify/manual fixtures)
  fetch-models.js           one-time download of Xenova/yolos-tiny weights → models-cache/
  models-cache/             (gitignore-worthy; local cache, copied into dist/models/)
  build.js                  esbuild bundler + wasm/model asset copy
  verify.js                 CDP-driven runtime verification (Phases 1-4)
  dist/                     build output (gitignored)
```

## Build

Requires Node ≥ 18 (developed on Node 24).

```sh
npm install
npm run fetch-models      # one-time: downloads Xenova/yolos-tiny weights (network, build-time only)
npm run typecheck         # tsc --noEmit
npm run build              # production build → dist/ (no test hooks; bundles wasm+models)
npm run build:test-hooks   # TEST_HOOKS=1; exposes __perceive* for verify.js
npm test                   # jest unit suites
npm run verify              # node verify.js + build:test-hooks (needs Chrome for Testing)
```

`npm run fetch-models` is the **only** step in this toolchain that touches the network; it
populates `models-cache/` (config, preprocessor config, `model_fp16.onnx`,
`model_quantized.onnx`) which `build.js` then copies into `dist/models/`. Skipping it still
produces a working Phase 1-3 build — Phase 4 inference just has no weights to load (a
logged warning, not a build failure).

`verify.js` launches Chrome for Testing with the built extension and asserts, across
Phases 1-4: SW starts, content script loads in its isolated world, PING round-trips,
offscreen document is created exactly once (`WORKERS`), no external network, SW restart
keeps the offscreen doc idempotent, initial/manual/mutation-triggered captures produce
correlated DOM+screenshot packages with correct privacy gating, and (Phase 4) local
vision analysis produces a result with zero network access.

Launch flags used: `--no-first-run`, `--no-default-browser-check`, `--disable-extensions-except`,
`--load-extension`, plus background/component-network disable flags for hermetic testing.

## Loading in Chrome for Testing

1. `npm run build` (run `npm run fetch-models` first for working Phase 4 inference)
2. In **Chrome for Testing** (official Google Chrome ≥ 137 blocks `--load-extension`),
   visit `chrome://extensions`, enable Developer mode, **Load unpacked**, pick `dist/`.
   Or launch with `--load-extension=dist/`.
3. Open `http://127.0.0.1:8580/server/...` (any page on the allowed hosts) and the bundled
   content script will run.

## Out of scope (Dev 2/3/4, not present in this repo)

- No PII/sensitivity classification of captured content (Dev 2).
- No backend/LLM summarization (Dev 3).
- No action execution or confirmation UI (Dev 4).
- Phase 4 vision output is raw (`RawVisionResult`: label/confidence/bbox per detection),
  intentionally un-redacted and un-classified — that's Dev 2's contract to consume.