# Dev 2 → Dev 3 Contract (canonical, as implemented and verified)

## Selected authoritative backend

**`server/` (copied locally to `backend-server/`), not `backend/`.**

| Criterion | `server/` | `backend/` |
|---|---|---|
| Tests | 18 real tests, 4 files, 391 lines — all passing | **0 tests** |
| Retry on malformed LLM output | Real 3-attempt retry loop | None — first failure is a generic 500 |
| Hallucination guard | Validates `target_element_id` against real `dom_summary` element ids | None |
| Server-side risk-tier enforcement | Forces `risky` when the target element `is_sensitive`, regardless of what the LLM said | None |
| Session continuity defense | Rejects `step_number > 1` with no prior history (detects a forged/regenerated session) | None |
| Rate-limit handling | Explicit `RateLimitError` → 429 + `Retry-After`, not blindly retried | Generic exception handler only |
| Offline/local LLM mode | Real (`LLM_PROVIDER=offline` → local OpenAI-compatible endpoint) | None — Groq cloud only |
| Confidence field | Hardcoded `0.90` (not derived from the LLM — same limitation as `backend/`'s `0.85`) | Hardcoded `0.85` |
| `/telemetry` endpoint | Absent | Present (Dev 5-facing) |

`backend/`'s only advantages were the `/telemetry` endpoint and matching the literal project name in its FastAPI title — both cosmetic next to `server/`'s test coverage and safety mechanisms, several of which directly implement master-doc requirements (§4.3: "risk_tier='risky' actions must always require confirmation regardless of the LLM's own confidence").

**Disposition of `backend/`:** left untouched in the original remote repo (not deleted — still available as history/reference per the instruction not to destroy useful code without understanding it), but is **not** part of the active local integration path. `backend-server/` (the `server/` copy, fixed and running) is the only backend this project's local demo path talks to.

---

## Request schema (Client → Server, `POST /analyze`)

```ts
{
  session_id: string,
  task_instruction: string,
  step_number: number,
  dom_summary: {
    url: string,
    elements: {
      element_id: string,
      tag: string,
      role: string | null,        // was required, non-nullable — FIXED (see below)
      label_text: string | null,
      is_sensitive: boolean,
      sensitivity_tier: "1" | "2" | "3",   // STRING — see tier resolution below
      sensitivity_type: "PASSWORD"|"CARD_NUMBER"|"EMAIL"|"NAME"|"AMOUNT"|"UNKNOWN"
                        |"PHONE"|"AADHAAR"|"IFSC"|"OTP",  // extended — see below
      semantic_token: string | null,
      bounding_box: { x: number, y: number, w: number, h: number }
    }[]
  },
  redacted_image_base64?: string,   // optional, not sent by the current pipeline (see below)
  detection_confidence_notes: { element_id: string, confidence: number, method: "dom_heuristic"|"vision_model"|"ocr_regex" }[]
}
```

### Sensitivity tier: STRING is canonical
Dev 2's real `sensitivity-tiers.js` returns a JS **number** (`1|2|3`). The backend's Pydantic schema (both variants) declares `Literal["1","2","3"]` — a **string**. Chosen canonical: **string**, because it matches the master doc's own JSON schema example verbatim and both independently-written backends agree on it. Conversion happens explicitly in `extension/src/content/dev2-payload.ts` (`sensitivity_tier: String(el.sensitivity_tier)`) — never relied on implicit JSON coercion (confirmed by direct testing: sending a raw JS number produces a Pydantic `string_type` validation error).

### Category enum: extended, nothing dropped
`server/app/models.py`'s `SensitivityType` was `{PASSWORD, CARD_NUMBER, EMAIL, NAME, AMOUNT, UNKNOWN}` — missing exactly the four categories Dev 2's real `pii-patterns.js`/`sensitivity-tiers.js` also produce: `PHONE, AADHAAR, IFSC, OTP`. **Extended the enum** (not mapped to `UNKNOWN`/`OTHER` — that would lose real, spec-relevant information the Tiered Sensitivity Model depends on). Confirmed live: `test23`'s real-Chrome run correctly classified the fixture's AADHAAR/OTP fields with their true types.

### `role`: made optional (real bug fix)
Was `role: RoleType` (required, non-nullable). Dev 2's real classifier legitimately returns `null` for most elements (only a minority carry an ARIA/native role) — every real Dev 2 payload was being rejected outright before this fix. Confirmed: this exact error reproduced via a direct `curl` call before the fix, gone after.

### `redacted_image_base64`: implemented, not yet wired into the live pipeline
The canvas-redaction code path (`extension/src/offscreen/dev2-redaction.ts`, calling Dev 2's real `redactImage`/`canvasToBase64` unmodified) exists and is unit-testable (`tests/dev2-redaction.test.ts`, using Dev 2's own Node fallback), but the current `test23`/`test24` payloads don't include it — the master doc marks this field explicitly **optional** ("OPTIONAL if VLM path unused"), and DOM-summary-based redaction (semantic tokens) is what's actually exercised end-to-end. Wiring the SW→offscreen round-trip to attach a real redacted screenshot to every payload is a reasonable next increment, not required for this gate.

---

## Response schema (Server → Client)

```ts
{
  session_id: string,
  step_number: number,
  action: {
    type: "click"|"type"|"scroll"|"wait"|"ask_user_confirmation"|"task_complete"|"task_failed",
    target_element_id: string | null,
    value: string | null,        // real values only ever a semantic_token, never raw — enforced by prompt + confirmed live
    risk_tier: "safe" | "risky", // server-authoritative override wins over the LLM's own answer
    reasoning_short: string
  },
  confidence: number  // currently a hardcoded backend constant (0.90) — not model-derived on either backend
}
```

---

## Prohibited fields / privacy boundary

- No raw password, card number, Aadhaar, OTP, or other Tier 1/2 raw value may appear in `dom_summary` (only `semantic_token`) or in `action.value` (LLM instructed to always use the token; server does not itself re-validate this — see Known Limitations).
- No raw DOM text beyond what Dev 1's own privacy gate already permits (password/file/hidden/contenteditable already excluded upstream of Dev 2).
- No screenshot pixels of Tier 1 regions in `redacted_image_base64` when that field is populated (not yet wired — see above).

## Error behavior

- Malformed request → `422` with structured Pydantic error detail (custom `validation_exception_handler`).
- Malformed/hallucinated LLM output → retried up to 3×, then `500` with the last error message (never silently returns a garbage action).
- Groq rate limit → `429` + `Retry-After: 5` header, not blindly retried.
- Session continuity violation (`step_number > 1` with no history) → `400`.
- Missing `GROQ_API_KEY` → raised at client-construction time, surfaces as `500` from `/analyze` (confirmed live before a key was supplied).
