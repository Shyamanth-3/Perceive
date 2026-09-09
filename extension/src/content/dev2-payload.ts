/**
 * Assembles the final Client→Server payload (master doc §4.1 shape) from
 * Dev 1's capture + Dev 2's classification, then runs Dev 2's real
 * `assertSafeToSend` (leakage-auditor.js, unmodified) as a hard, fail-closed
 * gate before the payload is considered safe to hand to a transport layer.
 *
 * This module does not send anything itself (no `fetch`) — that is Dev 3/4's
 * concern (out of scope for the Dev 1→Dev 2 gate). It only proves the
 * sanitized payload this pipeline produces passes Dev 2's own audit.
 */

import type { DomSnapshot } from "../shared/capture";
import { buildDev2DomSummary, type TokenVaultLike } from "./dev2-integration";
import { detectPII } from "../dev2-vendor/pii-patterns.js";
import { assertSafeToSend } from "../dev2-vendor/leakage-auditor.js";
import { cssRectToScreenshotRect } from "../shared/coords";
import type { RedactionRegion } from "../shared/messages";

/** Wire-format element: `sensitivity_tier` is the STRING canonical form
 * (Dev 2→Dev 3 boundary decision — see dev2-integration-report.md §4/dev3
 * contract doc). Dev 2's real `sensitivity-tiers.js` returns a JS number;
 * converted explicitly below, never left to implicit JSON coercion (a JS
 * number serializes to a JSON number, which the backend's Pydantic
 * `Literal["1","2","3"]` rejects outright — confirmed by direct testing
 * against the real backend). */
export interface ClientPayloadElement {
  element_id: string;
  tag: string;
  role: string | null;
  label_text: string | null;
  is_sensitive: boolean;
  sensitivity_tier: "1" | "2" | "3";
  sensitivity_type: string;
  semantic_token: string | null;
  bounding_box: { x: number; y: number; w: number; h: number } | null;
}

export interface ClientPayload {
  session_id: string;
  task_instruction: string;
  step_number: number;
  dom_summary: { url: string; elements: ClientPayloadElement[] };
  redacted_image_base64?: string;
  detection_confidence_notes: { element_id: string; confidence: number; method: "dom_heuristic" }[];
}

/**
 * Build the sanitized payload and assert (fail-closed — throws, does not
 * silently degrade) that it contains no raw PII per Dev 2's own auditor.
 * Throws `Error` (from `assertSafeToSend`) if the audit fails; the caller
 * must not catch-and-send-anyway.
 */
export function buildSanitizedClientPayload(params: {
  dom: DomSnapshot;
  url: string;
  tokenVault: TokenVaultLike | null;
  sessionId: string;
  taskInstruction: string;
  stepNumber: number;
  redactedImageBase64?: string;
}): ClientPayload {
  const { dom_summary, detection_confidence_notes } = buildDev2DomSummary(params.dom, params.url, params.tokenVault);

  const payload: ClientPayload = {
    session_id: params.sessionId,
    task_instruction: params.taskInstruction,
    step_number: params.stepNumber,
    dom_summary: {
      url: dom_summary.url,
      elements: dom_summary.elements.map((el) => ({
        ...el,
        // number -> string, explicit (see ClientPayloadElement doc above).
        sensitivity_tier: String(el.sensitivity_tier) as "1" | "2" | "3",
      })),
    },
    detection_confidence_notes,
    ...(params.redactedImageBase64 ? { redacted_image_base64: params.redactedImageBase64 } : {}),
  };

  // Fail-closed hard gate: Dev 2's own recursive payload walk + PII regex,
  // unmodified. Throws (does not return a boolean to ignore) on any
  // violation — see leakage-auditor.js.
  assertSafeToSend(payload, detectPII);

  return payload;
}

/**
 * Root-cause fix (redaction/coordinate bug): `dom_summary.elements[].bounding_box`
 * (built above via `buildDev2DomSummary`) is in CSS-pixel space — the same
 * space as `getBoundingClientRect()` — because that is what the wire contract
 * (master doc §4.1) and the backend/LLM expect. It is NOT the space the
 * screenshot bitmap is in: `chrome.tabs.captureVisibleTab` captures at
 * *device*-pixel resolution (CSS px × devicePixelRatio — confirmed 2x on a
 * Retina capture in this project's own test evidence). Drawing a redaction
 * box straight from the wire `bounding_box` onto that screenshot without this
 * conversion places every box at roughly half its true position/size —
 * exactly the "misplaced rectangle" symptom. This function is the ONLY place
 * that conversion should happen, and only sensitive (tier 1/2) elements
 * become redaction regions — never a vision/YOLO detection box, which has no
 * privacy meaning at all and must never be treated as one.
 */
export function buildScreenshotSensitiveRegions(
  payload: Pick<ClientPayload, "dom_summary">,
  devicePixelRatio: number
): RedactionRegion[] {
  const regions: RedactionRegion[] = [];
  for (const el of payload.dom_summary.elements) {
    if (!el.is_sensitive || !el.bounding_box) continue;
    const tier = Number(el.sensitivity_tier) as 1 | 2 | 3;
    const screenshotRect = cssRectToScreenshotRect(
      { x: el.bounding_box.x, y: el.bounding_box.y, width: el.bounding_box.w, height: el.bounding_box.h },
      devicePixelRatio
    );
    regions.push({
      bounding_box: {
        x: Math.round(screenshotRect.x),
        y: Math.round(screenshotRect.y),
        w: Math.round(screenshotRect.width),
        h: Math.round(screenshotRect.height),
      },
      sensitivity_tier: tier,
    });
  }
  return regions;
}
