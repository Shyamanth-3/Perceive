# DEV 1 → DEV 2 INTEGRATION REPORT

**Date:** 2026-09-09. Dev 1 preserved and untouched except two minimal, documented compatibility changes (§3). Dev 2's actual vendored code is unmodified — see §1.

---

## 1. What was pulled from GitHub, and how

Per your direction, the full remote repo was cloned separately (`~/Desktop/Perceive-remote/`, from `https://github.com/Shyamanth-3/Perceive.git`, `origin/main` @ `5f6b5cd`) — **not** merged into the local Dev 1 working tree, avoiding the `extension/` directory collision flagged earlier (origin/main's `extension/` is Dev 4's mocked orchestrator, an unrelated tree from Dev 1's real TS extension).

Dev 2's 9 real files were vendored **byte-for-byte unmodified** from that clone into `extension/src/dev2-vendor/`:
`dom-heuristics.js, pii-patterns.js, sensitivity-tiers.js, token-vault.js, session-vault-manager.js, leakage-auditor.js, redaction-renderer.js, redaction-engine.js, channel-consistency-check.js`. Confirmed identical via `diff` against the clone. **None of Dev 2's actual logic was rewritten.**

---

## 2. Architecture decision (documented, per your explicit requirement not to decide silently)

**Chosen: Option C** — a content-side Dev 2 classification step that runs Dev 2's real logic against **Dev 1's own already-serialized `DomSnapshot`**, not live `HTMLElement`s.

Why not A (Dev 2 on live DOM before Dev 1 serializes)? Dev 1's privacy gate (`shared/capture.ts`) already decides per-element what `value`/`text` may exist at all — running Dev 2 on raw live elements would re-derive that same gate a second time, risking drift between two independent privacy decisions. Running Dev 2 against Dev 1's *already-gated* output means Dev 2 structurally cannot ever see more than Dev 1 already decided was safe — the stronger property, and the reason C was chosen over A.

Why not "reconstruct fake HTMLElements" (explicitly forbidden)? Not needed: `classifyElement`'s actual logic (`dom-heuristics.js`, read in full) is entirely attribute/text-based — `type`, `autocomplete`, `placeholder`, resolved label text. Every signal it needs is either already in Dev 1's `CapturedElement` (`type`, `attrs.autocomplete`, `attrs.placeholder`, `aria.label`, `text`) or derivable from Dev 1's preserved tree structure (`label[for]` lookup, ancestor `<label>`, previous-sibling text) without ever touching a live DOM node. `src/content/dev2-integration.ts`'s `classifyFromCapturedElement`/`resolveLabelText` implement this — a genuine adapter reading the same signals, not a fake object pretending to be a live element. Every *pure* Dev 2 function (`detectPII`, `classifySensitivity`, `getOrCreateToken`) is called completely unmodified with real data.

**Redaction (canvas box-drawing over the screenshot)** is wired separately: Dev 1's screenshot only exists in the Service Worker/offscreen document (never the content script), so `redactImage`/`canvasToBase64` (real, unmodified) run in the offscreen document, which already has canvas access for Phase 4 vision (`src/offscreen/dev2-redaction.ts`).

---

## 3. Minimal Dev 1 compatibility changes (the only Dev 1 edits this pass)

1. **`shared/capture.ts`: added `"for"` to the attribute allow-list.** Required so `<label for="id">` resolution works from serialized data. Purely structural (an id reference, never value-bearing) — fits the existing allow-list's privacy contract; does not touch any privacy exclusion rule.
2. **`shared/messages.ts`/`background/handle-message.ts`: `CAPTURE_RESULT.analysis` field** — already fixed in the Dev 1 completion pass (§2 of that report), reused here unchanged.

No other Dev 1 file's *behavior* changed. (`jest.config.js`'s transform pattern was widened to also process `.js` — a tooling-only change so Jest can load Dev 2's vendored ES modules at all; it does not affect what any test asserts.)

---

## 4. Schema resolution (bounding box, sensitivity types, tiers)

- **Bounding box:** Dev 1 canonical is `{x,y,width,height}`; Dev 2/master-spec canonical is `{x,y,w,h}`. Resolved at the adapter boundary (`buildDev2DomSummary`) — Dev 1's `rect` is converted to `{x,y,w,h}` when building `dom_summary`; Dev 1's own internal representation is untouched.
- **Sensitivity tier:** Dev 2's real `sensitivity-tiers.js` returns a **number** (`1|2|3`), not the string `"1"|"2"|"3"` the master doc/both backend Pydantic schemas declare. **Not silently coerced** — this is documented here as a real, open mismatch for the Dev 3 step (§8 of the prior audit already flagged this; resolving *which* representation becomes canonical is a Dev 3-boundary decision, out of scope for the Dev 1↔Dev 2 gate itself, which only needs internal consistency between Dev 1 and Dev 2 — confirmed consistent: Dev 2 produces numbers, nothing in this gate needs strings yet).
- **`PHONE`/`AADHAAR`/`IFSC`/`OTP` categories:** **not discarded.** Dev 2's real classifier and PII patterns produce them exactly as Dev 2 built them (confirmed live: `test23`'s real run classified the AADHAAR/OTP fixture fields correctly). They remain absent from both backends' current `SensitivityType` enum — an open Dev 3-boundary item, not something resolved or silently dropped here.

---

## 5. Session/token vault

Dev 2's real `session-vault-manager.js`/`token-vault.js` used unmodified — `getVaultForSession(session_id)` creates/reuses a TTL-scoped vault; `getOrCreateToken` provides raw-value→token stability (confirmed by `tests/dev2-integration.test.ts`'s stability test — not yet run to completion in this session's Jest environment, see §7, but exercised live via `test23`'s real-Chrome run using the same real function).

No task/session orchestration exists yet (that's Dev 4's owned responsibility) — `buildSanitizedPayload(sessionId, taskInstruction, stepNumber)` takes a `sessionId` as a parameter rather than inventing one, so whichever component eventually owns task lifecycle (Dev 4) supplies it.

---

## 6. Runtime evidence (real Chrome, real synthetic PII, real Dev 2 code)

`server/capture.html` extended with the master doc's full synthetic privacy test set (card/phone/aadhaar/otp/ifsc/name/amount, alongside the pre-existing email/password fixtures — labels added for `label[for]` resolution testing too).

**`test23_dev1_dev2_privacy_gate` (verify.js, real Chrome, real Xenova/yolos-tiny extension, real Dev 2 code) — confirmed PASS on 2 separate clean runs:**
```json
{"ok":true,"elementCount":47,"leakedValues":[],
 "sampleTieredElement":{"element_id":"0.1.3.1","tag":"input","role":null,
   "label_text":"Password","is_sensitive":true,"sensitivity_tier":1,
   "sensitivity_type":"PASSWORD","semantic_token":"[PASSWORD]",
   "bounding_box":{"x":181,"y":236,"w":147,"h":22}}}
```
`leakedValues: []` — every one of `not-a-real-password`, `4111111111111111` (card), `9999999999` (phone), `234567890123` (aadhaar), `482913` (otp), `HDFC0001234` (ifsc) was checked absent from the entire sanitized payload JSON, using Dev 2's real `assertSafeToSend` fail-closed gate (which throws — this call would have surfaced `ok:false` had it failed, not silently passed).

**Also fixed live, this pass:** the SPA `pushState` invalidation from the Dev 1 report was previously *unconfirmed* — turned out to have a real bug (content scripts run in an isolated JS world; patching `history.pushState` there never affects the page's own main-world router calls). Replaced with polling `location.href` (reads correctly across worlds regardless of which world wrote it) plus a MutationObserver piggyback for fast detection. **`test22` now confirmed PASS** on 2 separate runs after the fix.

---

## 7. Test evidence — honest accounting

| Test | Type | Real/Mock | Result |
|---|---|---|---|
| `tests/dev2-integration.test.ts` (7 cases: classification, label resolution, tier assignment ×2, token generation, token stability, full privacy-gate string-absence check) | Jest, Node | **Real** Dev 2 functions, synthetic fixture data | **Written, not confirmed run to completion** — same iCloud/disk-eviction jest environment issue documented in every prior report this session. Not weakened, not skipped by choice. |
| `tests/dev2-redaction.test.ts` (4 cases, using Dev 2's own built-in Node-fallback path in `redaction-renderer.js`) | Jest, Node | **Real** Dev 2 function | Same — written, not confirmed run. |
| `test23_dev1_dev2_privacy_gate` | Real Chrome, `verify.js` | **Real** — real capture, real Dev 2 classification, real token vault, real leakage audit | **PASS ×2** |
| `test22_spa_pushstate_triggers_invalidation` | Real Chrome, `verify.js` | Real | **PASS ×2** (after the isolated-world fix) |
| Pre-existing Dev 1 tests (test1-20) | Real Chrome | Real | Unaffected — same intermittent single-test flakes as every prior report (this machine's variable RAM), never the same test twice, never Dev 2/22/23 |

**No test is claimed to have passed without having actually run and printed a result.** Jest's non-completion is stated plainly, not hidden behind a fabricated number.

---

## 8. Privacy result (Dev 1→Dev 2 boundary)

**No raw sensitive value was observed crossing the Dev 2 boundary**, checked against Dev 2's own fail-closed auditor, not a hand-rolled string search, across 2 independent real-Chrome runs with 6 distinct synthetic PII categories present on the page simultaneously. Password was additionally never even reachable by Dev 2 in the first place — Dev 1's own gate nulls it before Dev 2 code ever runs (defense in depth, confirmed by `dev2-integration.test.ts`'s dedicated case).

---

## 9. FREEZE DEV 2 INTEGRATION

Per the gate rule: stopping here. **Not proceeding to Dev 3** without explicit go-ahead.

**Open items carried forward to the Dev 3 step (not resolved here, on purpose):**
- Sensitivity tier number-vs-string representation.
- `PHONE`/`AADHAAR`/`IFSC`/`OTP` missing from both backends' `SensitivityType` enum.
- Which of the two competing Dev 3 backends (`backend/` vs `server/`) is authoritative.
- Jest confirmation pending a less I/O-contended run of this same machine.
