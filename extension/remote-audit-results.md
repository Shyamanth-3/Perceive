# REMOTE REPOSITORY AUDIT — github.com/Shyamanth-3/Perceive

**Performed:** 2026-09-09. **Method:** `git fetch`/`git ls-remote`/`git show`/`git log` against the real remote (no local working tree touched, no code modified) + GitHub REST API for PR history. All citations below are `<branch>:<path>` or commit SHAs you can re-check yourself.

---

## 1. Branches

| Branch | Tip commit | Contains |
|---|---|---|
| `main` | `5f6b5cd` | **Everything** — Dev 1 planning docs, Dev 2 (merged), Dev 3/backend (merged, twice, by two different people), Dev 4 (merged). This is the authoritative branch. |
| `dev2` | `6cb4336` | An **earlier, superseded** snapshot of Dev 2's work (files at repo root, pre-refactor). `main` already contains a later, more complete version (`dev2/` subdirectory, "Dev 2 COMPLETE: 20/20 tests pass"). Nothing on `dev2` is missing from `main`. |

No `dev3`, `dev4`, or `dev5` branches exist (live or in reflog/PR history beyond what's already merged). One branch named `dev3/backend-llm` existed and was merged into `main` via PR #2, then deleted — its content is now part of `main`'s `server/` directory.

**Merged PR history** (via GitHub API):
- PR #1 (`main` → `dev3/backend-llm`, merged 2026-09-08 17:55): brought shared docs into the backend branch.
- PR #2 (`dev3/backend-llm` → `main`, merged 2026-09-08 17:58): merged Dev 3's `server/` backend into `main`.

**Important:** your **local** `main` (this session's working copy, commit `206bc93` "first commit") is an *ancestor* of `origin/main`, not a fork — `origin/main` has 13 commits your local copy never received. My earlier report ("Dev 2/3/4 don't exist") was correct **for the local repository as it stood**, but the same claim is false for `origin/main`. That correction is warranted and I'm making it explicitly.

---

## 2. Dev 1 (this session's own work)

**Location:** local working tree only (`/Users/thekundannadella/Desktop/Perceive/extension/`), **not yet pushed** to `origin/main`. `origin/main` has its own, unrelated `extension/` directory (see §5) that does **not** contain any of your capture/vision code.

**Status:** unaffected by this audit. All 7 bug fixes and the 25/25 real-Chrome verification from the Phase 5/6 report stand — nothing in this audit touches those files. Verified still present: `capture-graph.ts` (lastError + replaced-pending fix), `service-worker.ts` (captureVisibleTab windowId fix), `manifest.json` (`<all_urls>`), `vision-runtime.ts` (`allowLocalModels`), `handle-message.ts` (lastCapture fix), `verify.js` (non-vacuous allPassed + assertion fixes).

**Consequence:** whoever integrates Phase 7 needs to push Dev 1's `extension/` to `origin/main` first (or reconcile the directory-name collision — see §8), since `origin/main` currently has no real capture/vision code at all under `extension/`.

---

## 3. Dev 2 — Privacy pipeline

**Location:** `main:dev2/` (14 files). **Author:** Sreesatvik. **Commits:** `7cc2148`, `ad9203e`, `3ecbb6c` (WIP), `acc79f8` (refactor into `dev2/`), `6cb4336` ("Dev 2 COMPLETE: Privacy pipeline E2E verified (20/20 tests pass)"), merged via `427415e`/`63bf06e`/`fbad3cb`.

| Component | File | Status |
|---|---|---|
| DOM heuristics | `dom-heuristics.js` | **Implemented.** `getNearbyLabelText`, `classifyElement`, `getElementId` — operates on **live DOM elements** (`el.getAttribute`, `el.closest`, `el.labels`), not serialized JSON. |
| PII patterns | `pii-patterns.js` | **Implemented.** Regex-based: `EMAIL, PHONE, CARD_NUMBER, AADHAAR, IFSC`, plus context-aware `OTP` detection. **No `PASSWORD` type** — passwords are presumably caught via `is_sensitive`/input-type classification elsewhere, not PII regex. |
| Sensitivity tiers | `sensitivity-tiers.js` | **Implemented.** `TIER_1 = {PASSWORD, CARD_NUMBER, AADHAAR, OTP}`, `TIER_2 = {NAME, AMOUNT, EMAIL, PHONE, IFSC}`, else `TIER_3`. Includes amount-range bucketing (`[AMOUNT: $10-50]` etc.) and (per test file) a `classifyActionRisk` export. |
| Semantic tokens / vault | `token-vault.js`, `session-vault-manager.js` | **Implemented.** In-memory `rawValue ↔ [TYPE_N]` map, session-scoped with TTL (`getVaultForSession`, `endSession`, `cleanExpiredSessions`, `getActiveSessionCount`). |
| Redaction engine | `redaction-engine.js` | **Implemented.** `processPageForRedaction(elements, sourceCanvasOrImage, tokenVault)` — produces `{dom_summary, redacted_image_base64, detection_confidence_notes, redacted_regions}`. Requires **live DOM elements + a Canvas/Image object** as direct inputs (see §8 — this doesn't match how Dev 1 actually produces data). |
| Redaction renderer | `redaction-renderer.js` | **Implemented** (referenced by redaction-engine; not separately read in depth this pass — canvas blackout + `canvasToBase64`). |
| Leakage auditor | `leakage-auditor.js` | **Implemented, and genuinely good.** `auditPayload`/`assertSafeToSend`/`createSecureTransport` recursively walk an entire payload object, regex-scan every string, and hard-fail-closed before any network call. This is a real, substantive safety mechanism — **but see §9: nobody outside Dev 2's own tests actually calls it.** |
| Channel consistency | `channel-consistency-check.js` | **Implemented** (not read in depth this pass). |
| Tests | `test-dev2.js` (+ 3 `.html` manual harnesses) | **Real, but partial.** `node test-dev2.js` runs 20 assertions with `assert.strictEqual`, commit message claims "20/20 pass". **However:** the tests exercise `sensitivity-tiers.js`/`token-vault.js`/`leakage-auditor.js` mostly with **hand-built mock classification objects** (`{tag, role, label_text, is_sensitive, sensitivity_type}`), not real DOM elements run through `dom-heuristics.js`/`classifyElement`. No `jsdom` dependency exists (`dev2/package.json` has zero dependencies). So: **the DOM-heuristic code path itself is not exercised by the automated test suite** — only its output shape is, via mocks. This is a real "tests don't fully exercise the implementation" gap, not a fabrication — the tests are real and do pass, they just don't cover everything the module does. |

### DEV 1 OUTPUT vs DEV 2 INPUT — documented, no adapter built

Dev 1 (`CorrelatedCapture.dom`, actual code, `shared/capture.ts`/`shared/types.ts`):
```
DomSnapshot.elements: DomElement[]   // plain serialized JSON, built in the content script,
                                       // sent across a chrome.runtime message boundary
DomElement { tag, id?, classes?, attrs (allow-listed only), rect:{x,y,width,height},
             text?: string, value?: string, children: DomElement[] }
```
Dev 2's actual entry point (`redaction-engine.js:processPageForRedaction`):
```
processPageForRedaction(elements: HTMLElement[], sourceCanvasOrImage: Canvas|Image, tokenVault)
```
**Mismatches, concretely:**
1. **Element representation.** Dev 2 expects live `HTMLElement` references (calls `.getAttribute`, `.closest`, `.getBoundingClientRect` directly on them). Dev 1 produces already-serialized plain objects, generated in the content script and shipped across a message-passing boundary to the Service Worker/offscreen document — by the time Dev 1's data reaches anywhere Dev 2's code could run, the live DOM is gone. **Dev 2's redaction code can only run inside the content script itself**, before Dev 1 serializes anything — meaning the current Dev 1→Dev 2 handoff point doesn't exist yet; Dev 2 would need to run *during* Dev 1's capture, not after it.
2. **Image representation.** Dev 2 wants a `Canvas`/`Image` object; Dev 1 produces a `data:image/jpeg;...` string (a `chrome.tabs.captureVisibleTab` result, only available in the Service Worker, not the content script — the exact opposite context from where Dev 2's DOM code needs to run).
3. **`bounding_box` field shape.** Dev 2 produces `{x, y, w, h}` (short keys); Dev 1's `DomElement.rect` is `{x, y, width, height}` (long keys). Trivial but real.
4. **`SensitivityType` enum gap** (also affects Dev 3, see §8): Dev 2 detects `PHONE`, `AADHAAR`, `IFSC`, `OTP` — none of these four exist in either backend's `SensitivityType` schema (§4).

**No adapter was written.** This is a documentation of the gap only, per your instruction.

---

## 4. Dev 3 — Backend / LLM

**Two independent, competing implementations exist in the same tree on `main`. This itself is a finding — nobody has reconciled them.**

### 4a. `backend/` — author Sriya C, single commit `5f6b5cd` ("feat: initial commit for Perceive privacy agent backend") — **currently the tip of `main`**

| File | Role |
|---|---|
| `backend/main.py` | FastAPI app, `POST /analyze`, `POST /telemetry`, `GET /health`. |
| `backend/schemas.py` | Pydantic models — see §8 for the full schema. |
| `backend/llm_client.py` | **Real Groq API integration** (`groq` SDK, model `llama-3.3-70b-versatile`, `GROQ_API_KEY` env var required). **No local/offline LLM mode exists** — it's cloud-only. On failure, falls back to a **static, canned `fallback_response.json`** (not a real model, just a fixed JSON response for demo safety). |
| `backend/session_manager.py` | Not read in depth; referenced by `main.py` for session continuity. |
| `backend/audit_logger.py` | Appends structured JSON lines (`session_id, step_number, payload_summary, action, confidence`) to `audit_log.jsonl`. **Does not appear to hash/redact `payload_summary` beyond whatever `main.py` already sanitized before calling it** — worth checking at integration time (§9). |
| Tests | **None found under `backend/`.** No `backend/tests/` directory exists. |

### 4b. `server/app/` — author "ANT1517" (latest fix commit `1184a3d`), earlier/base work merged via `2c8e192`/`38e841d`

| File | Role |
|---|---|
| `server/app/main.py` | FastAPI app, `POST /analyze`, `GET /health`. **No `/telemetry` endpoint.** Includes real retry logic against `groq.RateLimitError`/`APIError`, and an explicit **session-continuity defense** (rejects `step_number > 1` with no prior session history — audited and logged). |
| `server/app/models.py` | Pydantic models, **stricter** than `backend/schemas.py` (`bounding_box` required, not optional; `reject_non_enum_risk_tier` validator explicitly rejects numeric/non-enum risk tiers with a descriptive error). |
| `server/app/llm_client.py`, `session.py`, `logger.py` | Not read in depth this pass. |
| Tests | **Real: `server/tests/`** — `test_api.py`, `test_llm_client.py`, `test_models.py`, `test_session.py` (compiled `.pyc` cache present, confirming they've actually been run with pytest at some point). `backend/` has no equivalent test suite. |

**Which is authoritative?** Unclear from the repo alone — no README or commit message says "use this one, not that one." Signals: `backend/` is the current tip-of-branch and matches the project's actual name ("Perceive privacy agent backend") and has the `/telemetry` endpoint Dev 5's schema expects; `server/` has real tests, stricter validation, and more defensive coding (retry logic, session-continuity checks) but is untitled generically ("Lightweight Browser Agent Backend") and predates `backend/`. **This needs a human decision, not an inference** — I'm reporting it, not resolving it.

### What Dev 3 expects from Dev 2 (both variants)
`ClientPayload { session_id, task_instruction, step_number, dom_summary: {url, elements: DOMElement[]}, redacted_image_base64?, detection_confidence_notes[] }` — see §8 for the exact `DOMElement` schema and its mismatches against Dev 2's actual output.

---

## 5. Dev 4 — Action executor / orchestrator

**Location:** `main:extension/src/...`. **Author:** sushruthpippiri-cell. **Commit:** single commit `2e9b6e9` ("feat: Dev 4 implementation - action executor, orchestrator, and E2E tests").

| File | Role | Status |
|---|---|---|
| `extension/src/content/orchestrator.js` | Task loop: obtain session vault → loop steps → call transport → validate → execute or confirm → finalize. | **Explicitly MOCKED for Dev 1 and Dev 2.** Direct quote from the file itself: `"NOTE: These are placeholders for Dev 1 and Dev 2's modules. In the real extension, these would be imported from their respective files."` `mockDev1.captureCurrentState()` returns a hardcoded `{dom: {}, screenshot: "mock_screenshot_data"}`. `mockDev2.buildSanitizedPayload()` returns a hardcoded stub; `mockDev2.getVaultForSession()` returns fake hardcoded token resolutions (`'priya.sharma@example.com'`, etc.). **This is not integrated with either Dev 1 or Dev 2 — it is a self-contained mock harness.** |
| `extension/src/content/actionExecutor.js` | Executes `click`/`type`/`scroll`/`wait` actions against real DOM elements by `element_id`. Not read in exhaustive depth, but structurally plausible/real. |
| `extension/src/content/confirmationUI.js` | `requiresConfirmation`/`requestConfirmation` — gates `risk_tier: "risky"` actions on user approval before executing. Real, not a stub, based on function signatures used in orchestrator.js. |
| `extension/src/background/transport.js` | `sendToBackend(payload)` → `fetch('http://localhost:8000/analyze', ...)`. **Has its own leakage check, `assertNoLeakage`** — a much cruder inline regex scan (email/phone/card/aadhaar) that **duplicates and does not call Dev 2's `leakage-auditor.js`**, despite Dev 2 already building a more thorough, reusable version of exactly this. |
| `extension/src/shared/schemas.js` | `validateActionResponse()` — client-side structural validation of the server's `ServerResponse`. Matches backend's `ActionType`/`RiskTier` enums exactly. |
| `extension/tests/e2e/e2eRunner.js` + `e2eChecklist.md` | **Real test harness, but it tests the mocked orchestrator, not a real Dev1/Dev2 integration** (imports `runTaskLoop` from `orchestrator.js`, which uses `mockDev1`/`mockDev2` internally — there is no way to inject real Dev 1/Dev 2 modules from outside without editing orchestrator.js itself). **The checked-in `e2eChecklist.md` records `Result: 0/20 PASSED`, every checkbox unmarked.** This is not "tests exist but weren't re-run" — it's a template showing the suite has never produced a passing run, checked into the repo as-is. |

**Determination: Dev 4 is PARTIAL/STUBBED, not REAL.** The action-execution and confirmation-UI logic looks genuinely implemented, but the entire pipeline it sits inside has never been connected to real Dev 1 or Dev 2 code, and its own E2E suite — against the mocks it does have — has a checked-in 0/20 result. Per your instruction: **this mock integration harness is not being treated as end-to-end integration.**

### What Dev 4 expects from Dev 3
The exact `ServerResponse`/`ActionInstruction` shape both backend variants produce (§8) — this part is consistent and compatible.

---

## 6. Dev 5

**No implementation code exists anywhere in the tree.** Confirmed by full-repo search for `dev5`/`Dev 5`/`telemetry` (case-insensitive) — hits are only in: `README.md`, `SIH_26171_Master_Doc_Detailed.md`, `implementation_plan.md` (role descriptions), and `backend/main.py`/`backend/schemas.py` (a `/telemetry` receiving endpoint + `TelemetryPayload` schema, presumably scaffolded by Dev 3 in anticipation).

**Per the master spec** (`SIH_26171_Master_Doc_Detailed.md`, lines ~242, 503, 634, 748-858), Dev 5's actual responsibility is **not** "telemetry code" — it's: **live split-screen demo UI panel, redaction audit-log UI, README/docs polish, backup demo video.** The spec explicitly frames it as "decoupled from the critical path — nothing else blocks on it, and it cannot break the core pipeline." **Status: 🔴 MISSING**, but by design low-priority/non-blocking per the spec itself.

---

## 7. Interface map (actual message/schema names, as they exist today)

```
Web Page
   ↓ (content script, live DOM — Dev 1, real, this session's work, NOT yet on origin/main)
Dev 1: CorrelatedCapture { requestId, source, tabId, timing, dom: DomSnapshot{elements:DomElement[]},
                           screenshot:{dataUrl,format,quality} }
       + RawVisionResult { requestId, modelId, modelVersion, backend, detections[] }
   ↓ ✗ NO REAL CONNECTION EXISTS ✗
Dev 2: processPageForRedaction(HTMLElement[], Canvas|Image, tokenVault)
       → { dom_summary:{url,elements:[{element_id,tag,role,label_text,is_sensitive,
           sensitivity_tier,sensitivity_type,semantic_token,has_stable_token,bounding_box:{x,y,w,h}}]},
           redacted_image_base64, detection_confidence_notes[], redacted_regions[] }
   ↓ ✗ NO REAL CONNECTION EXISTS (Dev 4's orchestrator uses mockDev2 instead) ✗
Dev 3: POST /analyze  ClientPayload{session_id,task_instruction,step_number,dom_summary,
                                    redacted_image_base64?,detection_confidence_notes[]}
       → ServerResponse{session_id,step_number,action:{type,target_element_id,value,
                                                        risk_tier,reasoning_short},confidence}
   ↓ (real fetch() call exists in transport.js, but only ever fed mock payloads so far)
Dev 4: validateActionResponse() → requiresConfirmation()? → executeAction()
   ↓
Browser DOM (real, via actionExecutor.js)
```

**Every arrow marked "✗ NO REAL CONNECTION EXISTS" is a genuine, unbuilt integration point** — not a schema tweak, an actual missing wire.

---

## 8. Schema mismatches (concrete)

| # | Field/Area | Dev 1 (real) | Dev 2 (real) | Dev 3 `backend/` | Dev 3 `server/` | Issue |
|---|---|---|---|---|---|---|
| 1 | Bounding box keys | `{x,y,width,height}` | `{x,y,w,h}` | `BoundingBox{x,y,w,h}` | `BoundingBox{x,y,w,h}` | Dev 1 uses long key names; everyone downstream uses short. Trivial to adapt, but real. |
| 2 | Element input type | Serialized plain-object tree | **Live `HTMLElement`** required | Serialized `DOMElement` (post-Dev2) | same | Dev 2's actual function signature cannot accept Dev 1's actual output — needs to run in a different execution context (content script, pre-serialization) than currently designed. |
| 3 | `sensitivity_tier` type | n/a (Dev 1 doesn't classify) | JSDoc says `1\|2\|3` (**number**, in the one place it's documented in code) | `SensitivityTier(str, Enum)` = `"1"\|"2"\|"3"` (**string**) | `Literal["1","2","3"]` (**string**) | Numeric-vs-string tier is a real, silent Pydantic-validation-failure risk if Dev 2's actual runtime output is a JS number, not a string — needs checking against Dev 2's actual runtime values, not just the JSDoc, before integration. |
| 4 | `SensitivityType` enum | n/a | Emits `EMAIL, PHONE, CARD_NUMBER, AADHAAR, IFSC, OTP` (+ presumably `PASSWORD` from elsewhere) | `{PASSWORD,CARD_NUMBER,EMAIL,NAME,AMOUNT,UNKNOWN,NONE}` | `{PASSWORD,CARD_NUMBER,EMAIL,NAME,AMOUNT,UNKNOWN}` | **`PHONE`, `AADHAAR`, `IFSC`, `OTP` are not valid values in either backend schema.** A real Dev 2 output containing any of these would fail Pydantic validation at the `/analyze` endpoint. This is the exact kind of gap you asked me to name explicitly. |
| 5 | `bounding_box` optionality | n/a | Always produced | `Optional[BoundingBox]` | **Required `BoundingBox`** (no `Optional`) | The two backend variants disagree with each other, not just with Dev 2. |
| 6 | `/telemetry` endpoint | n/a | n/a | **Exists** | **Does not exist** | If Dev 5 is ever built against `server/`, this endpoint is missing there. |
| 7 | Leakage/PII regex | n/a | `leakage-auditor.js`: full recursive payload walk, PII regex + sensitive-key-name regex, fail-closed | n/a | n/a | `extension/src/background/transport.js` reimplements its **own**, narrower version (`assertNoLeakage`: only email/phone/card/aadhaar, no OTP, no key-name check, no recursive walk beyond a flat regex test on the whole JSON string) instead of calling Dev 2's. Two independent, inconsistent privacy gates. |
| 8 | `buildSanitizedPayload` | n/a | **Does not exist** — Dev 2's real export is `processPageForRedaction`, which returns `dom_summary`/`redacted_image_base64`/etc., **not** the full `ClientPayload` wrapper (no `session_id`/`task_instruction`/`step_number`) | expects the full `ClientPayload` | same | Dev 4's `mockDev2.buildSanitizedPayload()` invents a function name/shape Dev 2 never actually built. Someone has to write the wrapping logic — it doesn't exist on either side yet. |

---

## 9. Privacy risks (concrete findings, not fixed)

1. **Dev 2's `leakage-auditor.js` (the thorough one) is never called by Dev 4's real transport code.** `transport.js` uses its own weaker `assertNoLeakage`, which does not check `OTP`, does not check sensitive-key-name patterns (`password|pwd|secret|cvv|ssn|aadhaar|otp` — the exact regex Dev 2 built for this), and does a single flat regex test on the whole JSON string rather than Dev 2's recursive per-field walk. **A raw OTP or password value sitting in a field whose value merely resembles a password (not an email/phone/card/aadhaar pattern) would pass Dev 4's check and be sent to the backend.**
2. **No real end-to-end run has ever happened**, so there's no evidence either way about whether raw values actually leak in practice — this is a structural risk (the guard that exists is weaker than the one that was built) rather than an observed leak.
3. **`backend/audit_logger.py` logs `payload_summary` to a plaintext `.jsonl` file** — I did not verify whether `payload_summary` (constructed in `backend/main.py`, not fully read this pass) is guaranteed to already be token-redacted before logging, or whether it's the raw incoming payload. This needs a direct check before Phase 7, since a logging bug here would defeat any client-side redaction entirely.
4. **`server/`'s session-continuity defense is a real, good privacy-adjacent control** (rejects a payload claiming `step_number > 1` with no matching session history — prevents a forged/replayed mid-task payload) that `backend/` does not appear to have (not fully confirmed — `backend/session_manager.py` wasn't read in depth).

No fixes were applied, per your instruction.

---

## 10. Phase status (re-evaluated against `origin/main`, not the old local-only picture)

| Phase | Status | Evidence |
|---|---|---|
| 0 | ✅ VERIFIED | Unchanged — local `spike-results.md`. |
| 1 | ✅ VERIFIED | Unchanged — local, 25/25 real-Chrome (includes Phase 1's 9 checks). |
| 2 | ✅ VERIFIED | Unchanged — local, real-Chrome test11-14b. |
| 3 | ✅ VERIFIED | Unchanged — local, real-Chrome test15/16. |
| 4 | ✅ VERIFIED | Unchanged — local, real-Chrome test17/18, real WebGPU inference. |
| 5 | ✅ VERIFIED | Unchanged — local, real-Chrome test19/20, cache + concurrency. |
| 6 | ✅ VERIFIED (Dev 1 only) | Unchanged — 25/25 on `origin/main` would additionally need Dev 1's `extension/` actually pushed there (currently only local). |
| 7 | 🔴 **BLOCKED** — was correctly not attempted before; now confirmed still not attempable without real work, not just an oversight of missing code. Dev 2: 🟡 implemented, partially tested. Dev 3: 🟡 implemented (×2, unreconciled), Groq-real, no tests on the currently-authoritative variant. Dev 4: 🔵 MOCKED/STUBBED — self-admittedly mocked against Dev 1/Dev 2, own E2E suite at 0/20. Dev 5: 🔴 MISSING (non-blocking by spec design). |

---

## 11. Phase 7 readiness

# **OUTCOME C — STILL BLOCKED**

Not because the code doesn't exist (it does — this was the whole point of re-auditing), but because:
1. Dev 1's real extension code isn't on `origin/main` at all yet (only Dev 4's unrelated placeholder `extension/` directory is).
2. Dev 4's orchestrator is explicitly, self-admittedly wired to mocks for both Dev 1 and Dev 2 — there is no code path today that calls real Dev 1 or Dev 2 functions.
3. Dev 2's actual redaction entry point (`processPageForRedaction`) requires live DOM + Canvas in one call, which doesn't match where/how Dev 1 or Dev 4 currently produce or need that data — this needs an architectural decision (where does redaction actually run?), not a field rename.
4. Two competing, unreconciled Dev 3 backends exist with different schemas from each other.
5. A real `SensitivityType` enum gap would reject valid Dev 2 output at the Pydantic layer on either backend.
6. Dev 4's own mocked E2E suite has a checked-in 0/20 result — even the fake-data path has never been shown to work.

This is more than "small adapters." It requires: picking one Dev 3 backend, deciding where Dev 2's redaction actually executes, writing the real Dev1↔Dev2↔Dev4 wiring (not adapters over existing wiring — the wiring doesn't exist), and expanding the `SensitivityType` enum. None of that was done — per your instruction, nothing was invented or implemented this pass.

---

## 12. Exact next action

**Smallest correct next step, in order:**
1. **Get a human decision** on which Dev 3 backend (`backend/` vs `server/`) is authoritative — this blocks everything downstream and isn't mine to decide from code alone.
2. Push Dev 1's real `extension/` to a branch (not directly to `main`, to avoid clobbering Dev 4's existing `extension/` tree) so it can be reviewed against Dev 4's expectations before any merge.
3. With the people who own Dev 2 and Dev 4, jointly decide **where Dev 2's redaction actually runs** (content script, before Dev 1 serializes) — this is an architecture question, not something I should guess and encode into an adapter.
4. Only after 1-3: write the real (not mock) Dev1→Dev2→Dev3→Dev4 wiring, expand the `SensitivityType` enum, and replace Dev 4's `assertNoLeakage` with Dev 2's `leakage-auditor.js`.

I have not started any of these. Awaiting direction on which to do first, and specifically on decision #1 (backend choice) since I can't infer that from the repository alone.
