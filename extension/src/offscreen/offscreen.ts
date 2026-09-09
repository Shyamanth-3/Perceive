/**
 * Perceive Offscreen Document.
 *
 * Phase 1: a minimal, idle execution host that:
 *   - loads successfully
 *   - announces readiness to the Service Worker (OFFSCREEN_READY)
 *   - answers OFFSCREEN_PING with OFFSCREEN_PING_RESPONSE
 *
 * Phase 4 mounts the real local-vision pipeline here (WebGPU primary, WASM
 * fallback — see `vision-runtime.ts`) and answers ANALYSIS_REQUEST.
 */

import { handleOffscreenMessage, type OffscreenRuntimeState } from "./handle-message";
import { runVisionAnalysis } from "./vision-runtime";
import { redactScreenshotWithSamples } from "./dev2-redaction";
import { createRequestMeta } from "../shared/request-id";
import { MESSAGE_TYPES } from "../shared/messages";
import { TEST_HOOKS } from "../shared/constants";

const state: OffscreenRuntimeState = {
  readyAt: Date.now(),
  documentUrl: location.href,
};

console.info("[Offscreen] ready");

/** Types this context must respond to; everything else is ignored so that a
 * broadcast (e.g. content→SW PING or CAPTURE_REQUEST) can never be hijacked
 * by an offscreen ERROR_RESPONSE racing the Service Worker's reply. */
function handledByOffscreen(raw: unknown): raw is { type?: unknown } {
  const type = (raw as { type?: unknown } | null)?.type;
  return (
    type === MESSAGE_TYPES.OFFSCREEN_PING ||
    type === MESSAGE_TYPES.ANALYSIS_REQUEST ||
    type === MESSAGE_TYPES.REDACT_REQUEST
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!handledByOffscreen(message)) return undefined;
  handleOffscreenMessage(message, state, "offscreen", {
    runAnalysis: ({ requestId, screenshotDataUrl, viewportWidth, viewportHeight, devicePixelRatio }) =>
      runVisionAnalysis({ requestId, screenshotDataUrl, viewportWidth, viewportHeight, devicePixelRatio }),
    runRedaction: ({ screenshotDataUrl, sensitiveRegions, samplePoints }) =>
      redactScreenshotWithSamples(screenshotDataUrl, sensitiveRegions, samplePoints),
  })
    .then((response) => {
      if (response) sendResponse(response);
    })
    .catch((error) => {
      console.error("[Offscreen] handler error", error);
    });
  return true;
});

// Announce readiness so the Service Worker can track us. No response expected.
chrome.runtime
  .sendMessage({
    type: MESSAGE_TYPES.OFFSCREEN_READY,
    ok: true,
    origin: "offscreen",
    documentUrl: state.documentUrl,
    ...createRequestMeta(),
  })
  .catch(() => {
    /* SW restarts are expected; readiness is best-effort. */
  });

if (TEST_HOOKS) {
  globalThis.__perceiveOffscreen = {
    getState: () => ({ readyAt: state.readyAt, documentUrl: state.documentUrl }),
    resourceNames: () => performance.getEntriesByType("resource").map((e) => e.name),
  };
  console.info("[Offscreen] test hooks enabled");
}