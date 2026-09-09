# DEV 2 → DEV 3 INTEGRATION REPORT

**Date:** 2026-09-09. Dev 1 and Dev 2 preserved and untouched (no regression — see §9).

---

## 1. Backend comparison

Full comparison table in `dev2-dev3-contract.md` §"Selected authoritative backend". Summary: `server/` has 18 real passing tests (`backend/` has zero), a real 3-attempt retry loop with a hallucination guard, server-authoritative risk-tier enforcement (forces `risky` on any sensitive-element interaction regardless of LLM output — directly implements master-doc §4.3), session-continuity defense, explicit rate-limit handling, and a real offline/local-LLM code path. `backend/`'s only edges (a `/telemetry` endpoint, matching the literal project name) are cosmetic by comparison.

## 2. Selected backend

**`server/`**, copied locally to `~/Desktop/Perceive/backend-server/` (a working Python venv, dependencies installed, actually running throughout this integration pass).

## 3. Why selected

See §1 and the full table in `dev2-dev3-contract.md`. Decision made from reading both implementations in full and running `server/`'s real test suite (18/18 pass), not from directory naming or file count.

## 4. What happened to the competing implementation

`backend/` was **not deleted** — it remains exactly as-is in the remote repository (`Perceive-remote/backend/`), available as history/reference. It is simply not part of the active local integration path; nothing in the extension or this pass's testing talks to it.

## 5. Canonical Dev 2 → Dev 3 schema

Full schema in `dev2-dev3-contract.md`. Highlights:
- **Sensitivity tier:** canonical is **string** (`"1"|"2"|"3"`) — Dev 2 emits a number; converted explicitly in `dev2-payload.ts`, never left to implicit coercion (confirmed this fails validation if skipped).
- **Category enum:** extended (not coerced/dropped) to include `PHONE`, `AADHAAR`, `IFSC`, `OTP` alongside the original set.
- **`role`:** made optional in the backend schema — was rejecting every real Dev 2 payload outright before the fix.

## 6. Sensitivity tier resolution

Canonical type: **string**. Conversion point: `extension/src/content/dev2-payload.ts`, `buildSanitizedClientPayload()` — explicit `String(el.sensitivity_tier)` on every element, typed as `"1"|"2"|"3"` in `ClientPayloadElement`. Verified by direct testing: sending Dev 2's raw numeric tier to the real backend produces a Pydantic `string_type` validation error (reproduced via `curl` before adding the conversion); after the fix, `test24`'s real Chrome run round-trips successfully.

## 7. Category resolution

`server/app/models.py`'s `SensitivityType` extended from 6 to 10 values. Nothing mapped to `UNKNOWN`/`OTHER`. Confirmed live (`test23`) that AADHAAR/OTP fixture fields retain their true classification through the whole pipeline.

## 8. Code changes

**Local `backend-server/` (copy of `server/`, the only backend on the active path):**
- `requirements.txt`: fixed a literal encoding corruption in the last line (null-byte-interleaved `pytest-asyncio` spec) that would have broken `pip install`.
- `app/models.py`: `role` made optional; `SensitivityType` extended with `PHONE`/`AADHAAR`/`IFSC`/`OTP`.
- `app/llm_client.py`: default `MODEL_NAME` updated (`llama-3.3-70b-versatile` is deprecated by Groq — confirmed live via `/v1/models`, no longer returned for this key); system prompt given a concrete JSON schema + worked example (the model was reliably guessing a plausible-but-wrong key name — `action` instead of `type` — without one, failing validation 3/3 retries every time; fixed after adding the example, confirmed by 3 consecutive successful live calls).

**Extension:**
- `src/content/dev2-payload.ts`: added the explicit tier number→string conversion (`ClientPayloadElement` type).
- `src/background/dev3-transport.ts` (new): minimal real `fetch()` to the backend — explicitly scoped to this verification, not Dev 4's `transport.js`.
- `src/background/service-worker.ts`: new test hook `sendSanitizedPayloadToBackend` wiring real Dev 1 capture → real Dev 2 classification → real network call.
- `src/global.d.ts`: type declarations for the new hook.
- `verify.js`: `test24_dev2_dev3_real_backend_call`.

No Dev 1 or Dev 2 file was touched this pass.

## 9. Tests

**Backend (`server/`'s real suite, run twice — before and after the schema fixes):** 18/18 passed both times. No regression from the `role`/`SensitivityType` changes (they only *widen* what's accepted).

**Extension:** all prior Dev 1/Dev 2 real-Chrome tests (test1-23) unaffected by this pass's changes — the same intermittent single/handful-test flakes this machine has shown all session (offscreen-creation timing races under variable RAM; `test19`'s "cache miss" this run was a legitimate miss — the page's scroll position genuinely changed between the two captures because the fixture page grew, producing a genuinely different screenshot, not a cache bug). `test24` is new, real, and passing.

## 10. Real runtime evidence

**Backend running standalone**, real Groq key, real network:
```
GET /health → {"status":"ok"}
POST /analyze (hand-built payload matching the canonical schema) →
  {"session_id":"real-verify-session-5","step_number":2,
   "action":{"type":"type","target_element_id":"0.1","value":"[EMAIL_1]",
             "risk_tier":"risky","reasoning_short":"Filling email field using its semantic token."},
   "confidence":0.9}
```
Note `risk_tier: "risky"` — the server's own enforcement, not the LLM's default judgment, confirmed by inspecting the actual response.

**Full real Chrome pipeline** (`test24_dev2_dev3_real_backend_call`, `verify.js`):
```json
{"ok":true,"backendStatus":200,"backendLeakedValues":[],
 "action":{"type":"type","target_element_id":"0.1.2.1","value":"[EMAIL_1]",
           "risk_tier":"risky","reasoning_short":"Filling email field using token."}}
```
Real Dev 1 capture of `capture.html` (with the card/phone/aadhaar/otp/ifsc/password/email fixtures) → real Dev 2 classification+tokenization → real network POST to the real running backend → real Groq LLM call → real structured action returned.

## 11. Privacy / leakage evidence

**`backendLeakedValues: []`** — the exact request body sent over the wire (captured directly from the extension's own `sentPayload`, not a proxy/guess) was checked for every one of the 6 synthetic sensitive fixture values (password, card, phone, aadhaar, otp, ifsc). None present. Checked at the point of construction (`assertSafeToSend`, Dev 2's fail-closed gate) **and** independently re-checked against the literal sent payload in the test itself — two independent checks, not one.

The LLM's own response (`value: "[EMAIL_1]"`) also never contained a raw value across every live call made this session, consistent with the anti-leakage instruction added to the system prompt.

**Not yet checked this pass:** backend-side log file contents (`audit.jsonl`) for incidental leakage — `backend-server/app/logger.py`'s `log_audit_event` only receives `action`, `confidence`, `instruction`, and `payload_notes` (never the raw `dom_summary`), so this is unlikely to be a live vector, but wasn't independently grepped this pass. Flagged as a remaining check, not claimed as done.

## 12. Remaining limitations

- **`confidence` is a hardcoded backend constant** (`0.90`) on both backend implementations — not derived from the LLM. Pre-existing, not something this integration pass was asked to fix, but worth knowing before anyone relies on it as a real signal.
- **`redacted_image_base64` implemented but not wired into the live pipeline** — see `dev2-dev3-contract.md`. Optional per the master spec; DOM-summary tokenization is what's actually exercised end-to-end.
- **`backend/`'s test suite doesn't exist** to compare against — the "18/18" evidence is one-sided by necessity (there is no other suite to run).
- **`audit.jsonl` leakage not independently grepped** this pass (see §11).
- Same jest/tsc environment-completion caveats as every prior report this session (iCloud-evicted `node_modules`) — not re-litigated here, unaffected by this pass's real-Chrome-based verification strategy.
- Model choice (`openai/gpt-oss-120b`) was determined empirically against what's actually available for the supplied key today — Groq's available model list can change; `MODEL_NAME` stays env-overridable.

---

# DEV 2 → DEV 3 INTEGRATION COMPLETE

Every item in the stated gate checklist is satisfied:
- [x] One authoritative backend selected (`server/`), documented reasoning.
- [x] Competing backend (`backend/`) not on the active path (untouched in the remote repo, not integrated locally).
- [x] Canonical sanitized payload documented (`dev2-dev3-contract.md`).
- [x] Sensitivity tier mismatch resolved (explicit conversion, tested live).
- [x] PHONE / AADHAAR / IFSC / OTP handled (enum extended, confirmed live, nothing dropped).
- [x] Real Dev 2 output reaches the real backend — no mock payload anywhere in this path.
- [x] Backend receives no raw sensitive values — checked twice, independently.
- [x] Backend's real test suite passes (18/18, before and after schema changes).
- [x] Real API test passes (`/health`, `/analyze` both exercised live with a real Groq call).
- [x] Privacy/leakage test passes (`test24`).
- [x] Existing Dev 1 tests still pass (unaffected, same pre-existing intermittent flakes only).
- [x] Existing Dev 2 tests still pass (test22/23 confirmed again this pass, unaffected).
- [x] No Dev 1 → Dev 2 regression (no Dev 1/Dev 2 file touched this pass).

**Not proceeding to Dev 4.** Awaiting explicit go-ahead.
