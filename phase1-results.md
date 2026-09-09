# Phase 1 Results — MV3 Ext

## Build Result

```
TypeScript typecheck  : PASS
Production build      : PASS -> dist/ (service-worker.js ESM, content-script.js IIFE, offscreen.js ESM, manifest.json, offscreen.html, manifest)
Test-hook build       : PASS (TEST_HOOKS=1; __perceiveTest, __perceiveOffscreen, __perceiveContentLoaded, __perceivePingResult)
Jest unit suites      : PASS (5 suites / 39 tests)
verify.js             : PASS (14/14 runtime checks)
```

## Browser Used

- Browser: Google Chrome for Testing (arm64)
- Version: `155.0.8043.0`
- Machine: Apple M4, macOS (darwin)
- Node: v24.15.0 (npm 11.12.1), Python 3.14.3

## Runtime Build Verification

- The extension loaded via `--load-extension` with no manifest warnings.

## Service Worker

- Started successfully as a module SW (`background/service-worker.js`).
- SW responds to curl/PING messaging:
  - Content→SW `PING` -> `PING_RESPONSE` round-trip ok.
- SW exposes the offscreen-document lifecycle (idempotent create, reason `WORKERS`).

## Content Script

- Injected into the isolated world on `http://127.0.0.1/*` / `http://localhost/*`.
- `window.__perceiveContentLoaded` set; PING retry loop (15×750ms) works.

## Offscreen Document

- Created on-demand, exactly one instance (`contexts=1`):
  - `urls = ["chrome-extension://.../offscreen/offscreen.html"]`
- `OFFSCREEN_PING` -> `OFFSCREEN_PING_RESPONSE` round-trip ok.
- No external network requests from offscreen script or SW (resource lists empty).

## Restart + Idempotency

- SW restarted via `ServiceWorker.stopAllWorkers()`:
  - New SW `startedAt` timestamp (startedAt changed).
  - Content script PING on the new SW -> ok.
  - No duplicate offscreen document after restart (`created=false`, `contexts=1`).

## Automated Test Results

```
verify.js (CDP)        : 14/14 passed
Jest unit tests        : 39/39 passed
Console log safety     : PASS (only [SW]/[Content]/[Offscreen] lifecycle lines; zero page data)
```

## Errors Encountered During Development

- Oracle Desktop Python 3.7 too old for modern `requirements.txt` and opencv-py — solved
  by switching to system Python 3.14.3 with `venv`.
- Stable Google Chrome refused `--load-extension` — solved with Google Chrome for Testing.
- Offscreen creation without an existing document failed silently on first attempts —
  solved with the SW `ensureOffscreenDocument` (getContexts + createDocument) dedupe.
- `type: module` background service worker is required for ESM in MV3.

## Files Created / Modified (Phase 1)

- `extension/package.json`, `extension/tsconfig.json`, `extension/jest.config.js`
- `extension/build.js`, `extension/verify.js`, `extension/server/wake.html`
- `extension/src/manifest.json`
- `extension/src/global.d.ts`
- `extension/src/shared/{messages,request-id,types,constants,offscreen-lifecycle}.ts`
- `extension/src/background/{service-worker,handle-message}.ts`
- `extension/src/content/content-script.ts`
- `extension/src/offscreen/{offscreen.html,offscreen.ts,handle-message.ts}`
- `extension/tests/` (5 suites, 39 tests)
- `extension/dist/` (build output)
- `extension/verify-results.json` (14/14, errors: [])
- `extension/README.md`