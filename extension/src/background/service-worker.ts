/**
 * Perceive Service Worker.
 *
 * Phase 1: lifecycle + message routing.
 * Phase 2: capture pipeline — DOM capture request → content script, then
 *          chrome.tabs.captureVisibleTab, producing one correlated capture.
 * Phase 3: LATEST_REQUEST_WINS orchestration + cache invalidation.
 * Phase 4: forwards ANALYSIS_REQUEST to the offscreen local-vision host.
 *
 * The Service Worker intentionally does NOT import Transformers.js or ONNX
 * Runtime. Phase 0 proved dynamic `import()` is disallowed on
 * ServiceWorkerGlobalScope, so inference can never run here.
 */

import {
  createSwRuntimeState,
  handleSwMessage,
  type SwHandlerDeps,
  type SwHandlerContext,
} from "./handle-message";
import {
  createCaptureOrchestrator,
  type CaptureGraphDeps,
  type RunCaptureOutcome,
} from "./capture-graph";
import { ensureOffscreenDocument } from "../shared/offscreen-lifecycle";
import { createRequestMeta } from "../shared/request-id";
import {
  MESSAGE_TYPES,
  type CaptureSource,
} from "../shared/messages";
import { OFFSCREEN_URL, TEST_HOOKS, SCREENSHOT_FORMAT, SCREENSHOT_QUALITY } from "../shared/constants";
import type { DomSnapshot } from "../shared/capture";
import { buildSanitizedClientPayload, buildScreenshotSensitiveRegions } from "../content/dev2-payload";
import type { TokenVaultLike } from "../content/dev2-integration";
import { getVaultForSession } from "../dev2-vendor/session-vault-manager.js";
import { sendToBackend } from "./dev3-transport";
import type { RawVisionResult } from "../shared/types";
import { cssRectToScreenshotRect } from "../shared/coords";
import type { RedactionSamplePoint, RedactionSampleResult } from "../shared/messages";

const swState = createSwRuntimeState();

console.info(`[SW] started (pid=${swState.startedAt})`);

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[SW] installed reason=${details.reason}`);
});

// ---- Capture graph chrome plumbing ----

function sendMessageToTab<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) =>
      resolve(response as T | undefined)
    );
  });
}

/**
 * `chrome.tabs.captureVisibleTab(windowId?, options, callback)` takes a
 * *window* id, not a tab id (easy to get backwards — the bug this replaced
 * silently passed `tabId` as `windowId`, which fails with no window found
 * whenever the numeric ids don't coincide). Resolve the tab's own window
 * first so this always captures the right window regardless of id spacing.
 */
let lastCaptureVisibleTabError: string | null = null;

function captureVisibleTab(
  tabId: number,
  options: { format: chrome.extensionTypes.ImageFormat; quality: number }
): Promise<string | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || typeof tab.windowId !== "number") {
        lastCaptureVisibleTabError = `chrome.tabs.get: ${chrome.runtime.lastError?.message ?? "no tab/windowId"}`;
        resolve(undefined);
        return;
      }
      chrome.tabs.captureVisibleTab(tab.windowId, options, (dataUrl) => {
        if (chrome.runtime.lastError) {
          lastCaptureVisibleTabError = `chrome.tabs.captureVisibleTab: ${chrome.runtime.lastError.message}`;
        }
        resolve(dataUrl);
      });
    });
  });
}

const captureGraphDeps: CaptureGraphDeps = {
  now: Date.now,
  requestDomCapture: async (tabId, requestId, source) => {
    const response = await sendMessageToTab<{
      ok?: boolean;
      domSnapshot?: DomSnapshot;
      error?: string;
    }>(tabId, {
      type: MESSAGE_TYPES.DOM_CAPTURE_REQUEST,
      origin: "background",
      requestId,
      timestamp: Date.now(),
      source,
    });
    if (!response?.ok || !response.domSnapshot) {
      throw new Error(
        `DOM capture failed (tab=${tabId}): ${response?.error ?? "content script unreachable"}`
      );
    }
    return {
      domSnapshot: response.domSnapshot,
      domCapturedAt: response.domSnapshot.domCapturedAt,
    };
  },
  captureScreenshot: async (tabId) => {
    const startedAt = Date.now();
    const dataUrl = await captureVisibleTab(tabId, {
      format: SCREENSHOT_FORMAT as chrome.extensionTypes.ImageFormat,
      quality: SCREENSHOT_QUALITY,
    });
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      throw new Error(`captureVisibleTab failed (tab=${tabId}): ${lastCaptureVisibleTabError ?? "unknown reason"}`);
    }
    return { dataUrl, startedAt, endedAt: Date.now() };
  },
  runAnalysis: async ({ requestId, screenshot, viewport, devicePixelRatio }) => {
    await ensureOffscreenDocument();
    const response = (await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ANALYSIS_REQUEST,
      origin: "background",
      requestId,
      timestamp: Date.now(),
      screenshot: screenshot.dataUrl,
      screenshotContext: {
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        devicePixelRatio,
      },
    })) as { ok?: boolean; result?: RawVisionResult; error?: string } | undefined;
    if (!response?.ok || !response.result) {
      throw new Error(`Local vision analysis failed (requestId=${requestId}): ${response?.error ?? "no response from offscreen"}`);
    }
    return response.result;
  },
};

async function runRedactionRequest(
  screenshotDataUrl: string,
  sensitiveRegions: import("../shared/messages").RedactionRegion[],
  samplePoints: RedactionSamplePoint[]
): Promise<{ ok?: boolean; redactedDataUrl?: string; samples?: RedactionSampleResult[]; error?: string }> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.REDACT_REQUEST,
    origin: "background",
    ...createRequestMeta(),
    screenshot: screenshotDataUrl,
    sensitiveRegions,
    samplePoints,
  })) as { ok?: boolean; redactedDataUrl?: string; samples?: RedactionSampleResult[]; error?: string } | undefined;
}

const orchestrator = createCaptureOrchestrator(captureGraphDeps);

const swDeps: SwHandlerDeps = {
  enqueueCapture: (input) => orchestrator.request(input),
  invalidateCaptures: (reason) => {
    orchestrator.invalidate({ reason });
    void chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPES.INVALIDATE_CACHE,
        origin: "background",
        ...createRequestMeta(),
      })
      .catch(() => undefined);
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const ctx: SwHandlerContext = { senderTabId: sender.tab?.id };
  // Only keep the channel open when this message can produce a response.
  // Event-only messages (OFFSCREEN_READY / INVALIDATE_CACHE) return null from
  // the handler and must not reserve a reply port forever.
  const type = (message as { type?: string } | null)?.type;
  const expectsResponse = type !== MESSAGE_TYPES.OFFSCREEN_READY && type !== MESSAGE_TYPES.INVALIDATE_CACHE;
  handleSwMessage(message, swState, "background", ctx, swDeps)
    .then((response) => {
      if (response) sendResponse(response);
    })
    .catch((error) => {
      console.error("[SW] handler error", error);
    });
  return expectsResponse;
});

// ---- Test hooks (only in TEST_HOOKS builds, used by verify.js) ----

if (TEST_HOOKS) {
  globalThis.__perceiveTest = {
    getStatus: async () => {
      const manifest = chrome.runtime.getManifest() as {
        name?: string;
        version?: string;
        background?: { service_worker?: string; type?: string };
      };
      let contexts: unknown[] = [];
      try {
        const entries = (await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
        })) as { contextType: string; documentUrl?: string }[];
        contexts = entries.map((e) => ({
          contextType: e.contextType,
          documentUrl: e.documentUrl,
        }));
      } catch (error) {
        contexts = [{ getContextsError: String((error as Error)?.message ?? error) }];
      }
      const o = orchestrator.getState();
      return {
        startedAt: swState.startedAt,
        lastPing: swState.lastPing ?? null,
        lastOffscreenReady: swState.lastOffscreenReady ?? null,
        lastCapture: swState.lastCapture ?? null,
        lastMutation: swState.lastMutation ?? null,
        cacheEpoch: swState.cacheEpoch,
        captureCount: o.capturesCompleted,
        orchestrator: {
          latestSeq: o.latestSeq,
          inflightRequestId: o.inflight?.requestId ?? null,
          pendingRequestId: o.pending?.requestId ?? null,
          superseded: o.superseded,
          lastError: o.lastError,
        },
        offscreenContexts: contexts,
        manifest: {
          name: manifest.name,
          version: manifest.version,
          swType: manifest.background?.type,
          swFile: manifest.background?.service_worker,
        },
      };
    },
    ensureAndPing: async () => {
      const outcome = await ensureOffscreenDocument();
      const ping = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.OFFSCREEN_PING,
        ...createRequestMeta(),
        origin: "background",
      });
      const entries = (await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      })) as { contextType: string; documentUrl?: string }[];
      return {
        outcome,
        offscreenContextCount: entries.length,
        offscreenUrls: entries.map((c) => c.documentUrl),
        pingResponse: ping,
      };
    },
    triggerCapture: async (source: CaptureSource = "manual") => {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab?.id) return { superseded: false, capture: null, error: "no active tab" };
      const outcome: RunCaptureOutcome | null = await orchestrator.request({
        requestId: createRequestMeta().requestId,
        tabId: tab.id,
        source,
      });
      return summarizeOutcome(outcome);
    },
    getLatestCapture: async () => {
      const cap = orchestrator.getState().lastResult?.capture;
      return summarizeCapture(cap);
    },
    getCaptureCount: async () => orchestrator.getState().capturesCompleted,
    invalidateCaptures: async (reason?: string) => {
      orchestrator.invalidate({ reason });
      return snapshotOrchestrator();
    },
    // Dev 1 → Dev 2 integration gate: builds the real sanitized ClientPayload
    // from the SW's most recent real Dev 1 capture, using Dev 2's real
    // vendored functions end-to-end (session vault, PII patterns,
    // sensitivity tiers, leakage audit) — no mocks. Throws (surfaced as
    // {error}) if Dev 2's own fail-closed audit rejects the payload.
    buildSanitizedPayload: async (sessionId: string, taskInstruction: string, stepNumber: number) => {
      const cap = orchestrator.getState().lastResult?.capture;
      if (!cap) return { error: "no capture available yet" };
      try {
        const vault = getVaultForSession(sessionId) as TokenVaultLike;
        const payload = buildSanitizedClientPayload({
          dom: cap.dom as DomSnapshot,
          url: "test-fixture",
          tokenVault: vault,
          sessionId,
          taskInstruction,
          stepNumber,
        });
        return { ok: true, payload };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) };
      }
    },
    // Dev 2 → Dev 3 integration gate: real network call to the selected
    // authoritative backend (server/, running locally). NOT Dev 4's
    // transport.js — see dev3-transport.ts.
    sendSanitizedPayloadToBackend: async (sessionId: string, taskInstruction: string, stepNumber: number) => {
      const cap = orchestrator.getState().lastResult?.capture;
      if (!cap) return { error: "no capture available yet" };
      try {
        const vault = getVaultForSession(sessionId) as TokenVaultLike;
        const payload = buildSanitizedClientPayload({
          dom: cap.dom as DomSnapshot,
          url: "test-fixture",
          tokenVault: vault,
          sessionId,
          taskInstruction,
          stepNumber,
        });
        const result = await sendToBackend(payload);
        return { ok: true, sentPayload: payload, backendResponse: result };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) };
      }
    },
    // Redaction root-cause verification gate: builds the real Dev 2
    // classification (same code path as the two hooks above), converts ONLY
    // the tier 1/2 (sensitive) elements' CSS bounding boxes into
    // screenshot-pixel regions (the fix — see dev2-payload.ts
    // buildScreenshotSensitiveRegions), redacts the real screenshot in the
    // offscreen document, then samples real pixels at every classified
    // element's center point to prove sensitive regions are covered and
    // every non-sensitive element (including any vision-detected but
    // non-sensitive region) is left untouched.
    verifyRedaction: async (sessionId: string, taskInstruction: string, stepNumber: number) => {
      const cap = orchestrator.getState().lastResult?.capture;
      if (!cap) return { error: "no capture available yet" };
      try {
        const dom = cap.dom as DomSnapshot;
        const vault = getVaultForSession(sessionId) as TokenVaultLike;
        const payload = buildSanitizedClientPayload({
          dom,
          url: "test-fixture",
          tokenVault: vault,
          sessionId,
          taskInstruction,
          stepNumber,
        });
        const sensitiveRegions = buildScreenshotSensitiveRegions(payload, dom.devicePixelRatio);
        const samplePoints: RedactionSamplePoint[] = payload.dom_summary.elements
          .filter((el) => el.bounding_box && el.bounding_box.w > 0 && el.bounding_box.h > 0)
          .map((el) => {
            const centerCss = {
              x: el.bounding_box!.x + el.bounding_box!.w / 2,
              y: el.bounding_box!.y + el.bounding_box!.h / 2,
              width: 0,
              height: 0,
            };
            const centerScreenshotPx = cssRectToScreenshotRect(centerCss, dom.devicePixelRatio);
            return {
              label: `${el.tag}:${el.label_text ?? el.element_id}`,
              isSensitive: el.is_sensitive,
              x: centerScreenshotPx.x,
              y: centerScreenshotPx.y,
            };
          });
        const response = await runRedactionRequest(cap.screenshot.dataUrl, sensitiveRegions, samplePoints);
        if (!response?.ok) {
          return { ok: false, error: response?.error ?? "no response from offscreen" };
        }
        return {
          ok: true,
          sensitiveRegionCount: sensitiveRegions.length,
          devicePixelRatio: dom.devicePixelRatio,
          samples: response.samples,
          redactedDataUrlLength: response.redactedDataUrl?.length ?? 0,
        };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) };
      }
    },
  };
  console.info(`[SW] test hooks enabled (offscreen url=${OFFSCREEN_URL})`);
}

function summarizeOutcome(outcome: RunCaptureOutcome | null) {
  if (!outcome) {
    // A null outcome means either "genuinely superseded by a newer request"
    // OR "the underlying capture threw" (orchestrator resolves null for
    // both — see capture-graph.ts). Surface lastError so callers/tests can
    // tell the two apart instead of assuming every null was a supersession.
    return { superseded: true, capture: null, analysis: null, lastError: orchestrator.getState().lastError };
  }
  return {
    superseded: false,
    capture: summarizeCapture(outcome.capture),
    analysis: summarizeAnalysis(outcome.analysis),
  };
}

/** Phase 4: summarize the RawVisionResult for test hooks (no raw detections
 * dump — just enough shape to assert wiring end-to-end). */
function summarizeAnalysis(analysis: RawVisionResult | null) {
  if (!analysis) return null;
  return {
    requestId: analysis.requestId,
    modelId: analysis.modelId,
    modelVersion: analysis.modelVersion,
    backend: analysis.backend,
    imageWidth: analysis.imageWidth,
    imageHeight: analysis.imageHeight,
    detectionCount: analysis.detections.length,
    inferenceTimeMs: analysis.inferenceTimeMs,
    cached: analysis.cached,
  };
}

function snapshotOrchestrator(): PerceiveOrchestratorState {
  const o = orchestrator.getState();
  return {
    latestSeq: o.latestSeq,
    inflightRequestId: o.inflight?.requestId ?? null,
    pendingRequestId: o.pending?.requestId ?? null,
    superseded: [...o.superseded],
    capturesCompleted: o.capturesCompleted,
    hasLastResult: o.lastResult != null,
  };
}

function summarizeCapture(cap: RunCaptureOutcome["capture"] | undefined) {
  if (!cap) return null;
  const dom = cap.dom as DomSnapshot;
  return {
    requestId: cap.requestId,
    source: cap.source,
    tabId: cap.tabId ?? null,
    timing: cap.timing,
    viewport: cap.viewport,
    devicePixelRatio: cap.devicePixelRatio,
    scroll: cap.scroll,
    dom: {
      elementCount: dom.elementCount,
      truncated: dom.truncated,
      hasElements: dom.elements.length > 0,
      privacy: privacySummary(dom.elements),
    },
    screenshot: {
      format: cap.screenshot.format,
      quality: cap.screenshot.quality,
      dataUrlLength: cap.screenshot.dataUrl.length,
      dataUrlPrefix: cap.screenshot.dataUrl.slice(0, 24),
    },
  };
}

/** Walk the captured snapshot to prove password values never leaked. */
function privacySummary(
  nodes: readonly { type?: string | null; value?: string | null; children: readonly unknown[] }[]
): { passwordFields: number; capturedPasswordValues: number } {
  let passwordFields = 0;
  let capturedPasswordValues = 0;
  const visit = (
    els: readonly { type?: string | null; value?: string | null; children: readonly unknown[] }[]
  ) => {
    for (const el of els) {
      if (el.type === "password") {
        passwordFields += 1;
        if (el.value != null) capturedPasswordValues += 1;
      }
      visit((el.children ?? []) as typeof els);
    }
  };
  visit(nodes);
  return { passwordFields, capturedPasswordValues };
}