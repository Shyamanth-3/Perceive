# Dev 1 — Extension & Local Vision Lead: Implementation Plan (v4 — Final)

## 1. Repository State

Greenfield. Only the master doc (`.md` + `.pdf`) exists. No code to preserve. No conflicts.

---

## 2. Scope — Strict Boundary

### ✅ Dev 1 Owns

| # | Responsibility |
|---|----------------|
| 1 | MV3 scaffold (manifest, directory layout, build config) |
| 2 | Content script + service worker + inference host architecture |
| 3 | Correlated screenshot + DOM snapshot capture with timing metadata |
| 4 | Transformers.js / ONNX Runtime Web integration |
| 5 | Local vision model (face / region bounding-box detection) |
| 6 | Rigorous WebGPU → WASM fallback with meaningful real-inference validation |
| 7 | Lazy/idempotent model initialization tolerating MV3 lifecycle restarts |
| 8 | MutationObserver-based debounced re-analysis (~250 ms) triggering full re-capture |
| 9 | On-device frame-diff caching with composite cache key |
| 10 | Chrome extension messaging API as the sole inter-context interface |
| 11 | Automated tests (mocked unit + real Chrome runtime) |
| 12 | **Runtime spike (Phase 0)** to determine architecture based on observed behavior |
| 13 | Candidate model benchmarking |

### 🚫 Dev 1 Does NOT Own

- DOM heuristics / sensitivity classification (Dev 2)
- PII regex/pattern matching (Dev 2)
- Sensitivity tier assignment (Dev 2)
- Semantic token generation (Dev 2)
- Canvas solid-box redaction (Dev 2)
- Backend / FastAPI / Groq / LLM (Dev 3)
- Action executor, transport, risk-tier (Dev 4)
- Demo/audit UI (Dev 5)

> [!IMPORTANT]
> Dev 1 captures **raw structural DOM metadata**. Dev 1 does NOT classify any element as sensitive. Dev 2 consumes the raw snapshot and applies their own heuristics/PII layer.

---

## 3. Phase 0 — Runtime Spike & Architecture Decision Procedure

Do not assume WebGPU fails in a service worker. Do not assume an offscreen document is required. The architecture decision must come from observed runtime behavior.

### 3.1 Spike Tests

Create a minimal throwaway extension with two contexts (Service Worker, Offscreen) and two backends (WASM, WebGPU). Run the following matrix:

| Context | Backend | What to Test |
|---------|---------|--------------|
| A1: Service Worker | WASM | Import, model init, real inference success |
| A2: Service Worker | WebGPU | navigator.gpu availability, adapter acquisition, model init, real inference success |
| B1: Offscreen | WASM | Import, model init, real inference success |
| B2: Offscreen | WebGPU | navigator.gpu availability, adapter acquisition, model init, real inference success |

### 3.2 Decision Matrix

Record the following concrete decision table during Phase 0:

| Context | Backend | `navigator.gpu` | Adapter | Init | Real inference | Latency | Result / Error |
|---------|---------|-----------------|---------|------|----------------|---------|----------------|
| Service Worker | WASM | N/A | N/A | PASS/FAIL | PASS/FAIL | ... ms | ... |
| Service Worker | WebGPU | YES/NO | YES/NO | PASS/FAIL | PASS/FAIL | ... ms | ... |
| Offscreen | WASM | N/A | N/A | PASS/FAIL | PASS/FAIL | ... ms | ... |
| Offscreen | WebGPU | YES/NO | YES/NO | PASS/FAIL | PASS/FAIL | ... ms | ... |

### 3.3 Architecture Decision Rules

```
IF Service Worker + WebGPU (A2) succeeds reliably AND provides acceptable performance:
  → Architecture: Service Worker only (simplest, no offscreen needed).

ELSE IF Service Worker + WASM (A1) succeeds reliably AND provides acceptable performance:
  → Architecture: Service Worker only (WebGPU not required).

ELSE IF Offscreen + WebGPU/WASM (B2 or B1) is required for success or acceptable performance:
  → Verify the selected ML runtime *actually* spawns Web Workers (e.g. for WASM threading).
  → IF it spawns workers: Architecture: Offscreen Document using reason `WORKERS`.
  → IF it does NOT spawn workers: Re-evaluate. Do not misuse the `WORKERS` reason as a mere workaround.
```

If offscreen is selected and validated, use `chrome.runtime.getContexts()` (Chrome 116+) for detection.

---

## 4. Final Security & Privacy Policy (Absolute Guarantees)

> [!CAUTION]
> This is a hard privacy constraint. Violations are critical bugs.

### 4.1 Security Guarantee

1. **Local Only:** Raw page data remains local. No screenshot, DOM snapshot, form value, model output, or diagnostic containing page data is sent to an external server by Dev 1.
2. **No Remote Calls:** No remote LLM/API call exists in Dev 1.
3. **No Persistence:** No user-entered values are persisted.
4. **No Sensitive Diagnostics:** No sensitive data is included in logs, diagnostic events, or cache keys.

### 4.2 Distinguishing Structural vs. User-Entered Text

**A. Structural Text (Permitted, truncated to 200 chars)**
- Button labels, static headings, visible labels, navigation text, ARIA attributes.
- Captured as `textContent`.

**B. User-Entered Text (Strict Rules Apply)**
User-entered fields intended for Dev 2 (for PII detection):
- `type="text"`, `"email"`, `"tel"`, `"number"`, `"search"`, `"url"` (Truncated to 100 chars, sent as `value`)
- `<textarea>` (Truncated to 100 chars, sent as `value`)

**C. ABSOLUTE EXCLUSIONS (Never Captured)**

| Input Type / Condition | `value` / `textContent` in Snapshot | Reason |
|------------------------|-------------------------------------|--------|
| `type="password"` | `value: null` | Hard privacy requirement |
| `type="file"` | `value: null` | Hard privacy requirement |
| `type="hidden"` | `value: null` | Structural/app data, no visual context |
| `contenteditable="true"` | `value: null`, `textContent: null` | High risk of arbitrary user data |
| Editable elements | `value: null`, `textContent: null` | High risk of arbitrary user data |

*(Structural metadata like tag, role, bounding box, and visibility are still captured for the above exclusions).*

### 4.3 Required Automated Tests (Privacy)

- Test `<input type="password" value="secret">`: Verify "secret" is absent.
- Test `<div contenteditable="true">Secret user text</div>`: Verify "Secret user text" is absent.
- Full pipeline response test: Deep-search the entire `ANALYSIS_RESULT` (including diagnostics/errors) to ensure prohibited test strings never appear.

---

## 5. Final Message Flow & Mutation-Triggered Re-Analysis

### 5.1 Flow on Mutation

Do NOT let the service worker reuse a stale DOM snapshot after a mutation. A mutation requires a full fresh capture cycle.

```
[Content Script] MutationObserver detects DOM change
      ↓
[Content Script] 250ms debounce period passes
      ↓
[Content Script] Sends MUTATION_DETECTED { tabId, timestamp, mutationCount }
      ↓
[Service Worker] Receives MUTATION_DETECTED, sends CAPTURE_DOM_REQUEST to content script
      ↓
[Content Script] Walks DOM, creates fresh DOMSnapshot
      ↓
[Content Script] Sends DOM_CAPTURE_RESULT { domSnapshot }
      ↓
[Service Worker] Starts capture sequence (Screenshot + Vision Inference)
      ↓
[Service Worker] Broadcasts ANALYSIS_RESULT
```

### 5.2 Capture Correlation Metadata

There is no atomic capture. Metadata reflects exactly when each step occurred using consistent cross-context time (`Date.now()`).

```js
CaptureMetadata = {
  requestId: string,
  domCapturedAt: number,             // Date.now() in content script
  screenshotCaptureStartedAt: number,// Date.now() in SW before captureVisibleTab
  screenshotCapturedAt: number,      // Date.now() in SW after captureVisibleTab resolves
  captureDelayMs: number,            // screenshotCaptureStartedAt - domCapturedAt
  screenshotDurationMs: number,      // screenshotCapturedAt - screenshotCaptureStartedAt
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  scrollX: number,
  scrollY: number
}
```

---

## 6. Final Concurrency Policy (LATEST_REQUEST_WINS)

Policy: **LATEST_REQUEST_WINS**. Never run uncontrolled parallel model inference.

1. At most one vision inference is active at any time.
2. If a newer `REQUEST_ANALYSIS` (or mutation trigger) arrives while inference is running, the older request is marked stale.
3. The latest request is queued and runs immediately after the current inference finishes (or if the current inference can be safely aborted, it is aborted).
4. Responses for superseded requests are returned with a specific status indicating cancellation:

```js
{
  type: 'ANALYSIS_RESULT',
  payload: {
    requestId: 'older_uuid',
    status: 'SUPERSEDED',
    // ... empty results
  }
}
```

---

## 7. Model Benchmarking, Validation, & Safety

### 7.1 Model Benchmarking (Before Final Commit)

Do not hard-code `yolos-tiny`. Benchmark 2-3 candidate models measuring:
- Face detection / sensitive-region detection capability
- Model size (MB)
- Cold start / First inference / Warm inference timings (ms)
- WebGPU vs WASM performance
- Memory footprint
- License (Apache 2.0 / MIT required)

### 7.2 Meaningful Proof-of-Work Validation

Do not use a generic 1x1 image and "no exception thrown" to validate the backend.

- Bundle a small, deterministic test image containing a known object (e.g., a synthetic face or specific object the selected model detects).
- Validation must check:
  1. Inference completes without throwing.
  2. Output tensor/structure is valid.
  3. The expected detection (label) is present.
  4. Confidence score is within a valid range.
  5. Bounding box coordinates are numerically valid (not NaNs/zeros where unexpected).

### 7.3 Screenshot Size & Messaging Safety

`captureVisibleTab` can produce massive Data URLs (especially on Retina screens). To prevent messaging bottlenecks/crashes:

- Format: `jpeg` with `quality: 80` (reduces size drastically vs PNG, sufficient for object detection).
- Limits: Check Data URL string length. If it exceeds a safe threshold (e.g., ~15MB base64 string), compress further via offscreen canvas resizing before passing to the ML pipeline.
- Locality: The screenshot remains entirely local to the extension process memory.

---

## 8. Frame Cache & Invalidation

### 8.1 Composite Cache Key

```js
CacheKey = {
  imageHash: string,
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  modelId: string,
  modelVersion: string,
  inferenceConfigHash: string
}
```

### 8.2 Invalidation Rules

Invalidate memory cache on:
1. Full navigation (`chrome.webNavigation.onCompleted` — manifest permission required).
2. URL change (SPA routing, detected via content script or `webNavigation.onHistoryStateUpdated`).
3. Viewport size or DevicePixelRatio change.
4. Model ID / version / inference config change.
5. Explicit `INVALIDATE_CACHE` message.

---

## 9. Final Test Matrix

No feature is marked complete based on mocked tests alone.

### Tier 1: Mocked Unit Tests (Jest)
- `capture.test.js`: Structural serialization, truncation limits.
- **`capture.privacy.test.js`**: Proves absolute exclusion of password/file/hidden/contenteditable values and user-text.
- `mutationWatcher.test.js`: Debounce timing, MUTATION_DETECTED emission.
- `concurrency.test.js`: LATEST_REQUEST_WINS logic verification.
- `cache.test.js`: Composite key matching, invalidation triggers.

### Tier 2: Real Chrome Runtime Tests
1. **Model Initialization**: Selected model loads in chosen architecture.
2. **WebGPU Inference**: Deterministic test image returns valid bounding boxes.
3. **WASM Inference**: Deterministic test image returns valid bounding boxes.
4. **WebGPU Fallback**: Force WebGPU failure, verify WASM fallback succeeds on test image.
5. **Service Worker Restart**:
   - Explicitly validate: service worker is allowed/forced to terminate (via DevTools or simulating idle timeout if API available).
   - Send `REQUEST_ANALYSIS`.
   - Verify service worker starts, reconstructs state, and analysis succeeds.
6. **Offscreen Recreation**: (If applicable) Close doc, request analysis, verify recreation and success.
7. **250ms Mutation Debounce**: Rapid DOM changes produce only one re-capture cycle.
8. **Concurrent Requests**: Send 3 simultaneous requests; verify older ones return `SUPERSEDED`, latest returns success.
9. **Cache Hit/Miss**: Analyze identical frames (hit), change viewport (miss).
10. **Coordinate Consistency**: Verify correlation metadata matches viewport bounds.
11. **Sensitive Value Exclusion (E2E)**: Page contains `<input type="password" value="test123">` and contenteditable. Run full pipeline, verify strings are completely absent from `ANALYSIS_RESULT`.

---

## 10. Implementation Phases

**Do not begin Phase 1 until approved.**

| Phase | What |
|-------|------|
| **Phase 0** | **Runtime Spike & Model Benchmark**: Execute Spike (§3.1) and Model Benchmark (§7.1). Produce `spike-results.md` containing the decision matrix and final model choice. |
| **Phase 1** | MV3 Scaffold, build config, and shared Types/Messages. |
| **Phase 2** | `capture.js` + Privacy Policy + `capture.privacy.test.js`. |
| **Phase 3** | `mutationWatcher.js` + mutation flow orchestration. |
| **Phase 4** | Inference Host (SW or Offscreen based on Phase 0) + Proof-of-Work validation. |
| **Phase 5** | Cache + LATEST_REQUEST_WINS Concurrency + `service-worker.js` router. |
| **Phase 6** | Tier 2 Chrome Runtime Tests. |
