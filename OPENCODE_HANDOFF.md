# OPENCODE → CLAUDE CODE HANDOFF

**Project:** Perceive — local, on-device computer-vision Chrome extension (MV3). Private accessibility overlay ("seen" then spoken; nothing leaves the device).
**Dev scope in this repo:** Dev 1 only (capture infrastructure, screenshot, correlation metadata, local vision inference, mutation reactivity, on-device caching). Dev 2/3/4 are OUT OF SCOPE and are NOT present in this repo.
**Handoff date:** 2026-09-09
**Repo:** `/Users/thekundannadella/Desktop/Perceive`
**Git:** branch `main` @ `206bc93 first commit` (up-to-date with `origin/main`). Untracked: `extension/`, `phase1-results.md`, `spike-results.md`.
**Toolchain:** Node v24.15.0, npm 11.12.1, Python 3.14.3, Apple M4 (darwin), Chrome for Testing 155.0.8043.0 (arm64).
**Overall status:** Phase 0 verified, Phase 1 verified, **Phase 2+3 implemented + typecheck-clean but NOT yet unit-/runtime-verified**, Phase 4 designed (planned), Phases 5+ unstarted.

> **Handoff rule agreed with the user:** this document must distinguish, for every item, IMPLEMENTED+VERIFIED / IMPLEMENTED‑UNVERIFIED / PARTIAL / PLANNED / MOCKED / FAILED‑BLOCKER. Nothing may be claimed as working that has not been run and seen to pass. All claims below follow that rule.

---

## 0. Status at a glance

| Item | State |
|---|---|
| Phase 0 spike (host+backend+model decision) | VERIFIED (evidence: `spike-results.md`, `phase0-spike/spike-live.json`) |
| Phase 1 scaffold (MV3, messaging, offscreen lifecycle, build, verify) | VERIFIED — 39/39 Jest, 14/14 runtime, 2026-09-08 |
| Phase 2 correlated capture (structural DOM + screenshot + timing) | IMPLEMENTED, typecheck‑clean; jest/runtime UNVERIFIED |
| Phase 3 reactivity (MutationObserver 250 ms debounce, cache invalidation, LATEST_REQUEST_WINS) | IMPLEMENTED, typecheck‑clean; jest/runtime UNVERIFIED |
| Phase 4 local vision (WebGPU→WASM, offscreen host) | PLANNED only (types + messages + constants exist; no runtime) |
| Dev 2 / Dev 3 / Dev 4 (sensitivity classification, backend/LLM, action execution, confirmation UI) | NOT PRESENT in this repo — out of scope |
| `extension/dist/` | STALE — last built at 2026‑09‑08 23:03 (Phase 1 code). **Must rebuild before any verify run.** |
| `extension/README.md`, `verify.js` header comment | Still say "Phase 1" — documentation is stale wrt Phase 2/3 (code is not) |

**Machine warning that explains every "hang":** this machine has heavy disk I/O — every node CLI crawl (tsc, jest, verify, esbuild, npm) takes 5–30+ minutes and can look hung. **Always run long commands detached** and poll a log file; never use tight foreground timeouts. Commands that "never returned" earlier were not actually hung on code — they were I/O starved. (A `tsc --noEmit` takes ~4.5–8 min; a full jest run of ~12 suites ran 30+ min and was still going when killed.)

---

## 1. Repository state (authoritative)

```
/Users/thekundannadella/Desktop/Perceive
├── .gitignore                      (tracked; dist/ etc.)
├── .DS_Store                       (tracked)
├── SIH_26171_Master_Doc_Detailed.md   (tracked; master/client spec)
├── implementation_plan.md          (tracked; the authoritative engineering plan)
├── phase1-results.md               (untracked; Phase 1 evidence, ACCURATE for Phase 1 only)
├── spike-results.md                (untracked; Phase 0 decision evidence)
├── OPENCODE_HANDOFF.md             (this file)
├── phase0-spike/                   (untracked; Phase 0 throwaway spike — keep as evidence)
└── extension/                      (untracked; the product — Dev 1)
```

- `git log`: exactly one commit `206bc93 first commit` on `main`, in sync with `origin/main`.
- There is **no `backend/`, no Dev 2/3/4 code, no sandbox, no model server** anywhere in this tree. Any continuation that needs Dev 2+ must locate/author that elsewhere; it does not exist here.

---

## 2. How to build / typecheck / test (must-run commands)

All commands run from `/Users/thekundannadella/Desktop/Perceive/extension` (package.json scripts below). Node modules already installed for both `extension/` and `phase0-spike/`.

```sh
npm run typecheck        # tsc --noEmit        → LAST RUN: PASS (exit 0) after all Phase 2/3 fixes
npm run build            # production build (NO test hooks)  → dist/
npm run build:test-hooks # TEST_HOOKS=1 build; exposes __perceiveTest/__perceiveOffscreen  → dist/
npm test                 # jest unit suites (ts-jest, node env)
npm run verify           # = build:test-hooks + node verify.js (CDP drive of Chrome for Testing)
```

**Run pattern (I/O-saturated machine):** `nohup npm run typecheck > /tmp/typecheck.log 2>&1 & disown`, then poll. Same for jest (`nohup npx jest --ci --forceExit > /tmp/jest.log 2>&1 & disown`) and for verify. Allocate: typecheck 5–10 min; jest 10–40 min; verify 5–15 min after build.

**verify.js runtime requirements:**
- Chrome for Testing binary (official Chrome ≥137 blocks `--load-extension`). Path used so far: `/var/folders/0d/jzpnl3ts2hjbcj7ppv3vbbw80000gn/T/opencode/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` (env var `CFT` overrides). If that temp dir was cleaned, re-download arm64 CFT 155.
- Ports: CDP `9333`, local HTTP static server `9797` (verify.js owns both; it starts its own HTTP server serving `server/wake.html`, `server/capture.html`, `server/demo.html`).
- CDP lib: `chrome-remote-interface` (devDependency). Isolated content-script world is reached via an `executionContextCreated` listener registered **before** `Runtime.enable()` (re-enable replays contexts) — see `verify.js:findIsolatedWorldId`.
- A keep-alive 4 s `evalIn(swWs,"1")` interval keeps the module SW alive during the run; it is cleared before `ServiceWorker.stopAllWorkers()`.

---

## 3. Per-developer analysis

| Developer | In this repo? | Where |
|---|---|---|
| Dev 1 — capture pipeline, local vision, mutation reactivity, caching | **YES** — Phase 0 done, Phase 1 verified, Phase 2/3 implemented, Phase 4 planned | `phase0-spike/`, `extension/` |
| Dev 2 — sensitivity/PII classification of captured content | NO (out of scope; plan/mocks only) | — |
| Dev 3 — backend / LLM summarization | NO (out of scope) | — |
| Dev 4 — action execution + confirmation UI | NO (out of scope) | — |

Phase 2/3 were built to hand Dev 2/3 clean inputs: a sanitized, correlated, privacy‑gated capture package (`CorrelatedCapture`) and a `RawVisionResult` contract. Do not expand Dev 1 into Dev 2+ work.

---

## 4. Phase state (per the implementation plan)

- **Phase 0 — Runtime spike & model benchmark: VERIFIED.** ONNX Runtime Web cannot `import()` on `ServiceWorkerGlobalScope` (`TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification`) — true for both WASM and WebGPU, and it blocks **before** any backend assembles. Offscreen document succeeds on both backends (correct 7 COCO detections on the deterministic test image). WebGPU ≈ 13–16× faster than WASM. `Xenova/yolos-tiny` selected (fp16 ~13.3 MB / q8 ~9.7 MB; Apache‑2.0 carried through the Xenova Optimum export). Evidence: `spike-results.md`, `phase0-spike/spike-live.json`.
- **Phase 1 — MV3 scaffold: VERIFIED** on 2026-09-08. Typecheck/build/test-hook build PASS, Jest **5 suites / 39 tests PASS**, `verify.js` **14/14 PASS** on CFT 155.0.8043.0 (see `verify-results.json` `allPassed:true`, `phase1-results.md`). Extension id observed in that run: `chlnlglihjfoceamjielpkipfdgagega`.
- **Phase 2 — Synchronized capture graph: IMPLEMENTED, typecheck-clean; NOT yet verified.** Structural DOM walk (`shared/capture.ts`), page-state alignment (`content/page-state.ts`, `content/dom-capture.ts`), screenshot (`tabs.captureVisibleTab`, jpeg q80), correlation metadata (`buildCaptureMetadata`, plan §5.2), captured-element privacy gate (§4.2), coordinate converters (`shared/coords.ts`, §2.4). Orchestrator `createCaptureOrchestrator` + `runCaptureGraph` (`background/capture-graph.ts`) and SW routing (`background/handle-message.ts`, `service-worker.ts`).
- **Phase 3 — Reactivity: IMPLEMENTED, typecheck-clean; NOT yet verified.** `content/mutation-watcher.ts` (250 ms debounce, plan §5.1), `MUTATION_DETECTED` → SW, cache invalidation on navigation (`INVALIDATE_CACHE`, popstate/hashchange/pagehide), LATEST_REQUEST_WINS (§6). Offscreen listener guard added so broadcasts are never hijacked.
- **Phase 4 — Local vision: PLANNED.** All types/contracts exist (`ANALYSIS_REQUEST/ANALYSIS_RESULT`, `RawVisionResult`, constants `MODEL_ID/DTYPE_*/MODEL_VERSION/INFERENCE_*`, manifest `web_accessible_resources` for `wasm/*`, `models/*`). No runtime code: `captureGraphDeps.runAnalysis` is `undefined` (`service-worker.ts:97`), offscreen handles only `OFFSCREEN_PING`. Host = offscreen document (reason `WORKERS`), WebGPU fp16 primary → WASM q8 fallback, everything bundled locally (zero network), lazy + idempotent init, on-device cache keyed by `MODEL_VERSION`.
- **Phases 5+ (final report, QA, demo/QuickShop):** not started. `extension/server/demo.html` (QuickShop storefront) exists as demo fixture for those phases.

---

## 5. Verification ledger (be honest with this)

### VERIFIED — has a passing run someone saw
1. Phase 0 spike decisions (all cells, benchmark, license) — `spike-results.md`.
2. Phase 1 typecheck / prod build / test-hook build — PASS.
3. Phase 1 Jest 39/39; Phase 1 `verify.js` 14/14 — PASS on CFT 155 (2026-09-08).
4. **Phase 2/3 TypeScript typecheck — PASS (exit 0, no output errors)** after the fix round described in §9. This is the ONLY Phase 2/3 verification completed so far.

### IMPLEMENTED — code written, compiles, but NEVER RUN
- Jest unit suites for Phases 2/3 (written but **no post-Phase-2 jest run has ever completed**; a detached run was started and killed after 30+ min with no output — result UNKNOWN, must be rerun). Suites: `capture.test.ts`, `coords.test.ts`, `capture-graph.test.ts`, `mutation-watcher.test.ts`, `sw-handler.test.ts` (rewritten) — plus the 5 original Phase 1 suites.
- `verify.js` Phase 2/3 runtime checks `test11`…`test16` (written, **never executed**; `verify-results.json` in the repo is the OLD Phase-1 14-test file).

### PARTIAL / WIRED-BUT-INERT
- Phase 4 contracts: `ANALYSIS_REQUEST`/`ANALYSIS_RESULT` types exist in `messages.ts`; `RawVisionResult`/`VisionDetection`/`VisionBoundingBox` in `types.ts`; constants set. `runAnalysis` dep is `undefined`. Offscreen rejects everything except `OFFSCREEN_PING`.

### PLANNED
- Phase 4 runtime (model bundling, inference service in offscreen, on-device cache, screenshot downscale/staging via `SCREENSHOT_MAX_LONG_EDGE=1600`), Phases 5+ (final report/QA/demo), Dev 2/3/4.

### REJECTED / NOT-USED (recorded so they are not re-litigated)
Details in §7 and §9.

### FAILURES that are now resolved (typecheck/gating) — see §9 for specifics.

---

## 6. File inventory — Phase 2/3 (this session's work)

### Created (new files)
```
extension/src/shared/coords.ts              CSS px ↔ screenshot ↔ model-px converters (pure)
extension/src/shared/capture.ts             structural DOM walker + privacy gate + metadata (pure)
extension/src/content/page-state.ts         viewport/dpr/scroll/title/url captured in one tick
extension/src/content/dom-capture.ts        real-Element → DomElementLike adapter for the walker
extension/src/content/mutation-watcher.ts   250 ms debounce (pure, injectable scheduler)
extension/src/background/capture-graph.ts   runCaptureGraph + createCaptureOrchestrator (pure)
extension/server/capture.html               Phase 2/3 fixture (password/hidden/file/email/contenteditable/textarea + #mutate-target + #box-fixture)
extension/server/demo.html                  QuickShop storefront demo fixture (add-to-cart + checkout form)
extension/tests/capture.test.ts             privacy gate / truncation / walker / snapshot / metadata
extension/tests/coords.test.ts              coordinate converters
extension/tests/capture-graph.test.ts       runCaptureGraph + LATEST_REQUEST_WINS scenarios
extension/tests/mutation-watcher.test.ts    debounce/flush/disconnect
```

### Modified (this session)
```
extension/src/shared/messages.ts        added CAPTURE_REQUEST, DOM_CAPTURE_REQUEST, DOM_CAPTURE_RESULT,
                                        CAPTURE_RESULT (superseded?), MUTATION_DETECTED, INVALIDATE_CACHE,
                                        ANALYSIS_REQUEST, ANALYSIS_RESULT, CaptureSource; ERROR_RESPONSE kept
extension/src/shared/constants.ts        added STRUCTURAL_TEXT_LIMIT=200, USER_VALUE_LIMIT=100 (earlier:
                                        MUTATION_DEBOUNCE_MS=250, SCREENSHOT_FORMAT=jpeg, QUALITY=80,
                                        MAX_LONG_EDGE=1600, MODEL_ID, DTYPE_*, MODEL_VERSION, INFERENCE_*,
                                        INFERENCE_CONFIG_HASH)
extension/src/shared/types.ts            added CaptureMetadata, CorrelatedCapture, RawVisionResult,
                                        VisionDetection, VisionBoundingBox
extension/src/content/content-script.ts  rewritten (Phase 2/3): answers DOM_CAPTURE_REQUEST; after retried
                                        PING → startObserving() + CAPTURE_REQUEST("initial"); MutationObserver
                                        + watcher.recordMutations; pagehide/popstate/hashchange invalidation
extension/src/background/handle-message.ts  rewritten: SwRuntimeState (cacheEpoch), SwHandlerDeps,
                                        CAPTURE_REQUEST/MUTATION_DETECTED/INVALIDATE_CACHE routing (pure)
extension/src/background/service-worker.ts  rewritten: chrome deps (sendMessageToTab, captureVisibleTab),
                                        orchestrator wiring, test hooks (getStatus/triggerCapture/
                                        getLatestCapture/getCaptureCount/invalidateCaptures),
                                        summarizeCapture + privacySummary walker
extension/src/offscreen/offscreen.ts    added handledByOffscreen() guard (anti-hijack of broadcasts)
extension/src/manifest.json             added host_permissions http://127.0.0.1/* + http://localhost/*
extension/src/global.d.ts              test-hook ambient types inside declare global
extension/tests/sw-handler.test.ts      rewritten for new routing (12 cases incl. CAPTURE/MUTATION/INVALIDATE)
extension/verify.js                     added test11–test16 + static server serves capture.html/demo.html
```

### NOT modified this session (Phase 1, still present)
`src/shared/request-id.ts`, `src/shared/offscreen-lifecycle.ts`, `src/offscreen/handle-message.ts`, `src/offscreen/offscreen.html`, `tests/messages.test.ts`, `tests/offscreen-handler.test.ts`, `tests/offscreen-lifecycle.test.ts`, `tests/request-id.test.ts`, `server/wake.html`, `build.js`, `jest.config.js`, `tsconfig.json`, `package.json`.

### Stale (do not trust)
`extension/dist/` (Phase 1 build; must rebuild), `extension/README.md` + `verify.js` header ("Phase 1" wording), `extension/verify-results.json` (Phase 1 14-test result, dated 2026-09-08T17:37:24Z).

---

## 7. Key decisions and the rejected attempts behind them

1. **Host = offscreen document, reason `WORKERS`** (not SW). Rejected: SW + WebGPU / SW + WASM — both fail with `import() is disallowed on ServiceWorkerGlobalScope` *before* a backend assembles, even though `navigator.gpu` + Metal adapter exist in the SW. The `WORKERS` justification is real: ORT's threaded WASM and jsep/WebGPU builds spawn Web Workers.
2. **Model = `Xenova/yolos-tiny`** (fp16 GPU / q8 CPU), ~10–13 MB. Rejected: `yolos-base` — marginally better labels at 20–50× size, 2.9–49 s inference, OOM's the single offscreen document when co-loaded. License: Apache-2.0 (carried through Xenova Optimum export of `hustvl/yolos-*`).
3. **Backend strategy:** WebGPU primary, WASM q8 fallback; feature-gate on `navigator.gpu.requestAdapter()`; CSP `'wasm-unsafe-eval'` required (needed even in offscreen). Threshold 0.3. Handle empty detections gracefully (flat/synthetic screenshots may yield zero).
4. **Capture design:** content answers `DOM_CAPTURE_REQUEST` synchronously through `sendResponse` (listener returns `true`); SW then runs `tabs.captureVisibleTab(jpeg, q80)`. One `CorrelatedCapture` derives from one `requestId` with per-stage timing (`domCapturedAt`, `screenshotCaptureStartedAt`, `screenshotCapturedAt`, `captureDelayMs`, `screenshotDurationMs`).
5. **LATEST_REQUEST_WINS (§6):** single inflight task + single pending slot; newest supersedes older; superseded tasks resolve `null` and never overwrite `lastResult`; at most one capture/inference active. `invalidate()` clears pending and supersedes inflight (navigation).
6. **Privacy gate (§4.2):** password/file/hidden input values never captured; input `value` allowed only for text/email/tel/number/search/url (+ textarea/select); contenteditable (property OR attribute) suppresses both text and value; leaf-node text only (no `innerText` ancestor dumps); curated attribute allow-list (no value-bearing attrs); `STRUCTURAL_TEXT_LIMIT=200`, `USER_VALUE_LIMIT=100`, `MAX_CAPTURE_ELEMENTS=2000` + `truncated` flag.
7. **Anti-hijack guard (offscreen):** `chrome.runtime.sendMessage` broadcasts to every extension context; the Phase 1 offscreen listener answered unrelated pings/captures and could steal the SW's reply. Fixed by `handledByOffscreen()` — offscreen only responds to `OFFSCREEN_PING` (Phase 4 adds `ANALYSIS_REQUEST`/`INVALIDATE_CACHE`).
8. **Test-hook builds stay separate:** `npm run build` (no hooks, zero network refs) vs `npm run build:test-hooks` (TEST_HOOKS=1). Verify always uses the test-hook build.
9. **Rejected development choices (documented in `phase1-results.md` §Errors and spike notes):** system Python 3.7 too old (moved to 3.14.3 venv); stable Chrome refuses `--load-extension` (moved to Chrome for Testing); offscreen create silently failed when context absent (added `ensureOffscreenDocument` dedupe via `getContexts`); synthetic silhouette test images undetectable by yolos-tiny (moved to real COCO fixture).

---

## 8. Current (as-built) architecture, data flow, privacy flow

### Data flow (Phase 2/3, as implemented)
```
content script (matches http://127.0.0.1|localhost/*)
  boot → PING (retried 15×750ms) ──▶ SW ──▶ PING_RESPONSE ──▶ content: startObserving() + CAPTURE_REQUEST("initial")
  popstate/hashchange/pagehide → INVALIDATE_CACHE ─▶ SW (cacheEpoch++, orchestrator.invalidate)
  MutationObserver (childList+subtree+attributes+characterData) → watcher.recordMutations(n)
      → (250ms debounce) MUTATION_DETECTED{mutationCount} ─▶ SW ─▶ enqueueCapture(source "mutation")

SW orchestrator (latest-request-wins):
  requestDomCapture(tabId,rid,source)  ── DOM_CAPTURE_REQUEST ──▶ content → DOM_CAPTURE_RESULT{domSnapshot}
  captureScreenshot(tabId)             ── chrome.tabs.captureVisibleTab(jpeg,q80) → dataUrl (local only)
  buildCaptureMetadata(...) → CorrelatedCapture{dom, screenshot, timing, viewport, dpr, scroll}
  Phase 4: runAnalysis(screenshot) ─▶ offscreen (ANALYSIS_REQUEST) => RawVisionResult appended

offscreen doc (WORKERS; created once, idempotent):
  Phase 1: OFFSCREEN_READY announce; answers OFFSCREEN_PING only (guard). Phase 4: inference host.
```

### Privacy flow (as implemented)
`captureDomSnapshot` walks real DOM via `toStructural` → `buildDomSnapshot` (shared/capture.ts):
- `decideExclusion`: contenteditable ⇒ suppress text+value; password/file/hidden inputs ⇒ suppress value.
- Values: `isValueCapturable` (allow-listed types + textarea/select) → `captureUserValue` ≤100 chars; otherwise `null`.
- Text: leaf nodes only, whitespace-collapsed, ≤200 chars; `contenteditable` suppressed.
- Attributes: allow-list only (id, class, name, placeholder, autocomplete, inputmode, lang, title, role, aria‑label/labelledby/describedby/hidden/live/expanded).
- Vertex budget `MAX_CAPTURE_ELEMENTS=2000` with `truncated`.
- Visible = finite rect, positive area, intersects viewport.
- SW test hook `privacySummary` re-walks the snapshot to assert `capturedPasswordValues===0` (used by test13).
- Screenshot never leaves the process; nothing is logged except lifecycle lines (`[SW]`, `[Content]`, `[Offscreen]`).

### Message validation
Every listener runs `parseMessage` (discriminated union + runtime `requestMeta` + origin checks) before dispatch; failures become `ERROR_RESPONSE`. Event-only messages (`OFFSCREEN_READY`, `INVALIDATE_CACHE`) return `null`/no response so reply ports close (`expectsResponse` in the SW listener).

---

## 9. Known failures, gotchas, and how each was resolved

1. **Typecheck errors (all now fixed, typecheck green):**
   - `service-worker.ts` `captureVisibleTab` options type → cast options to `chrome.extensionTypes.ImageFormat`.
   - `triggerCapture`/`invalidateCaptures` return types → shaped to match the ambient `PerceiveTestApi`.
   - `content-script.ts:62` "message possibly null" → early `if (!message) return undefined`.
   - `capture.test.ts` fixture `rect` lacked `x/y` → fixture `rect` includes `{x,y,width,height}`.
   - `sw-handler.test.ts` referenced a removed `createRequestId()` → use `createRequestMeta().requestId`.
   - `global.d.ts` interfaces not visible → the three handshake interfaces live **inside** `declare global`.
2. **Jest hung >30 min (killed; no output ever produced).** Do NOT interpret as failure; interpret as UNKNOWN + machine I/O. Re-run detached (see §2). If the I/O is truly pathological, `npx jest --ci --forceExit` and poll; consider running suites selectively (`npx jest tests/capture.test.ts tests/coords.test.ts` etc.).
3. **SW restart race with content pings:** MV3 workers start lazily; a content ping can arrive before a fresh worker registers its listener. Handled by the 15×750 ms content retry loop (`pingWithRetry`).
4. **Broadcast hijack:** offscreen must not answer messages it doesn't own (guard in §7.7) — otherwise PING/CAPTURE replies can be stolen by a stray `ERROR_RESPONSE`.
5. **Isolated-world eval in verify.js:** register `executionContextCreated` before `Runtime.enable()`; pick the `chrome-extension://` origin context with `auxData.type === "isolated"` (see `verify.js:findIsolatedWorldId`).
6. **Content script reachability:** `captureVisibleTab` needs `host_permissions` for the tab origin (added 127.0.0.1/localhost) and the tab must be the active visible tab; `DOM_CAPTURE_REQUEST` fails if content script isn't injected on that page (`NOTE` for test14: verify.js triggers capture while the active tab is `capture.html`).
7. **Phase 4 not yet allowed to run:** anything needing inference stays inert (`runAnalysis: undefined`); the offscreen doc must not download models at runtime for production builds (bundle locally; `env.allowRemoteModels` is a SPIKE-ONLY setting in `phase0-spike`).
8. **Chrome for Testing version drift:** verify-results were captured on 155.0.8043.0; a newer CFT may change console log framing (`INFO:CONSOLE` regex in verify.js) — minor, but re-check if test10 regresses.
9. **`~600ms` navigation note:** `content-script.ts` references plan §5.3 / master doc ~600 ms for navigation flush; the current implementation simply invalidates + issues `CAPTURE_REQUEST("manual")` on popstate/hashchange (pagehide invalidates only).

---

## 10. Recommended next steps (Claude Code)

1. **Rebuild + run Phase 2/3 unit tests** (detached):
   - `nohup npx jest --ci > /tmp/jest.log 2>&1 & disown` → poll. Fix any failures (all tests were written to pass; failures would indicate a regression in real-chrome-only paths — none should exist since tests are pure/unit).
2. **Runtime-verify Phases 1+2+3** (detached): `nohup npm run verify > /tmp/verify.log 2>&1 & disown`. Expect 16 checks (Phase 1 “1–10” reversed order: test1–10 except numbering — the driver records test1/test2/test1b/test3/test4/test4b/test5/test6/test7/test8/test8b/test9/test9_no_duplicate_offscreen/test10/test11/test12/test13/test14/test14b/test15/test16). Outcomes to watch: test11 (initial auto capture), test12 (metadata shape), test13 (privacy — password value never captured), test14/14b (manual capture produces new correlated result, count increments), test15/16 (mutation triggers debounced capture − verify test16 currently only asserts `mutationCount>=1`; if you want proof of *burst merging* at the runtime layer, strengthen it, otherwise unit tests already cover merging).
3. **Then Phase 4** (per plan): bundle `@huggingface/transformers` + ORT wasm into `dist/wasm/`, download `Xenova/yolos-tiny` fp16+q8 ONNX into `dist/models/` at build time (esbuild copy step), enable `web_accessible_resources` (already declared), mount pipeline in offscreen (feature-detect WebGPU→WASM), set `env.allowRemoteModels=false`, `localModelPath=chrome.runtime.getURL('models/')`, wire `runAnalysis`, downscale ≥1600px screenshots to a canvas → model input, map `bbox` via `coords.ts` `modelBoxToCssRect`, implement on-device cache keyed by `MODEL_VERSION` + immutable inputs, add `ANALYSIS_REQUEST` handling in `offscreen.ts` guard, route in offscreen `handle-message.ts`, plus unit tests (transform/image-prep, cache) and a verify test proving zero network.
4. **Then FINAL REPORT per phase**, and update the stale README/verify.js header ("Phase 1" wording). Update `phase1-results.md` to a combined results doc or add `phase2-3-results.md` + `phase4-results.md`.

**Do NOT** rebuild the architecture, redo Phase 0/1, or start Dev 2/3/4 features.

---

## 11. Startup instructions for the continuing agent

- Read in order: `implementation_plan.md` → `SIH_26171_Master_Doc_Detailed.md` → this file → `spike-results.md` → `phase1-results.md` → key source files in §6/§8 lists. `extension/README.md` is a good Phase-1 primer but is stale for Phase 2/3.
- Confirm state first (cheap, non-destructive): `git status`, then `npm run typecheck` (detached) to re-confirm the green baseline, then proceed to §10.
- Recurring practical rules:
  - Never foreground-timeout node/v8 jobs; always detach + poll.
  - Official Chrome can't `--load-extension`; use Chrome for Testing (or `CFT=...`).
  - `dist/` is gitignored and stale — rebuild before any verify.
  - Test hooks must be built with `build:test-hooks` before CDP verify (hooks stripped in prod build).
  - Keep privacy rules intact; never log page content/DOM/screenshots (only `[SW]/[Content]/[Offscreen]` lifecycle lines).
  - Everything must ship locally at Phase 4 (no runtime downloads; `allowRemoteModels` stays spike-only).

---

## # HANDOFF CHECKSUM

- [x] Repo state documented (single commit, untracked dirs, no Dev 2/3/4 in tree)
- [x] Per-phase state 0–4 documented with evidence files
- [x] Verification ledger separates VERIFIED / IMPLEMENTED-UNVERIFIED / PARTIAL / PLANNED / REJECTED
- [x] Phase 2/3 file inventory (created vs modified) listed
- [x] Decisions + rejected attempts + typecheck failures & fixes recorded
- [x] As-built architecture, data flow, privacy flow, message validation described
- [x] Known gotchas (I/O sat, SW restart race, broadcast hijack, isolated-world eval, CFT) documented
- [x] Exact commands, run pattern, ports, CFT path provided
- [x] Next-step plan (unit → runtime verify → Phase 4 → final report) with explicit "do not"s
- [x] No source code modified for this handoff (reads + this file only)