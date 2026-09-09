/**
 * Perceive Content Script.
 *
 * Phase 1: PING handshake → proves content ↔ SW messaging.
 * Phase 2: answers DOM_CAPTURE_REQUEST with a raw structural DOM snapshot and
 *          requests an initial correlated capture once the SW is reachable.
 * Phase 3: observes DOM mutations (250 ms debounce), reports MUTATION_DETECTED
 *          to the SW, and invalidates the cache on navigation.
 *
 * NO screenshot capture or inference here (SW + offscreen only). NO password /
 * file / hidden input values or arbitrary user-entered text ever leave the
 * page (see shared/capture.ts privacy gate).
 */

import { createRequestMeta } from "../shared/request-id";
import {
  MESSAGE_TYPES,
  type CaptureSource,
} from "../shared/messages";
import { TEST_HOOKS, MUTATION_DEBOUNCE_MS } from "../shared/constants";
import { captureDomSnapshot, stampElementIds } from "./dom-capture";
import { runTaskLoop, lastBackendFetchAttempts, testConfirmAndExecute } from "./orchestrator";
import { mountDev5Panel } from "./dev5-panel";
import { MutationWatcher } from "./mutation-watcher";
import type { Message } from "../shared/messages";

const stats = {
  pingOkAt: null as number | null,
  capturesRequested: 0,
  mutationsObserved: 0,
  debouncedFires: 0,
  invalidationsSent: 0,
};

function sendRequest(payload: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime
    .sendMessage({ ...payload, ...createRequestMeta() })
    .catch(() => undefined);
}

function captureRequest(source: CaptureSource): Promise<void> {
  stats.capturesRequested += 1;
  return sendRequest({
    type: MESSAGE_TYPES.CAPTURE_REQUEST,
    origin: "content-script",
    source,
  }) as Promise<void>;
}

function invalidateCache(): Promise<void> {
  stats.invalidationsSent += 1;
  return sendRequest({
    type: MESSAGE_TYPES.INVALIDATE_CACHE,
    origin: "content-script",
  }) as Promise<void>;
}

// ---- SW message handling (SW → content) ----

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const message = raw as Partial<Message> & { requestId?: string } | null;
  if (!message) return undefined;
  if (message.type === MESSAGE_TYPES.DOM_CAPTURE_REQUEST) {
    const requestId = typeof message.requestId === "string" ? message.requestId : "unknown";
    respondToDomCapture(requestId, sendResponse);
    return true; // keep channel open for the async response
  }
  return undefined;
});

async function respondToDomCapture(
  requestId: string,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const domSnapshot = captureDomSnapshot(requestId);
    // Dev 4 targets elements by this same id (data-element-id) — stamp the
    // real DOM to match every capture, not just when an action is imminent,
    // so element_id stays valid even if the action arrives moments later.
    stampElementIds();
    sendResponse({
      type: MESSAGE_TYPES.DOM_CAPTURE_RESULT,
      origin: "content-script",
      requestId,
      timestamp: Date.now(),
      ok: true,
      domSnapshot,
    });
  } catch (error) {
    sendResponse({
      type: MESSAGE_TYPES.DOM_CAPTURE_RESULT,
      origin: "content-script",
      requestId,
      timestamp: Date.now(),
      ok: false,
      error: String((error as Error)?.message ?? error),
    });
  }
}

// ---- Mutation observation (Phase 3) ----

let mutationObserver: MutationObserver | null = null;

const watcher = new MutationWatcher({
  debounceMs: MUTATION_DEBOUNCE_MS,
  onDebounced: (count) => {
    stats.debouncedFires += 1;
    void sendRequest({
      type: MESSAGE_TYPES.MUTATION_DETECTED,
      origin: "content-script",
      mutationCount: count,
      source: "mutation",
    });
  },
});

function startObserving(): void {
  const root = document.body ?? document.documentElement;
  if (!root || mutationObserver) return;
  mutationObserver = new MutationObserver((records) => {
    stats.mutationsObserved += records.length;
    checkUrlChanged(); // SPA route changes almost always mutate the DOM too — catch it early
    watcher.recordMutations(records.length);
  });
  mutationObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
}

/**
 * Dev 3 → Dev 4 integration fix: found via real QuickShop testing —
 * `orchestrator.ts`'s task-driven captures share Dev 1's single
 * LATEST_REQUEST_WINS slot with Dev 1's own autonomous mutation-triggered
 * captures, and can lose that race repeatedly on a page active enough to
 * keep re-triggering the debounced mutation capture throughout the whole
 * retry window (backoff alone wasn't enough — confirmed by direct testing:
 * still failed after 12 backed-off attempts). Rather than fight the queue,
 * temporarily stop observing (reusing Dev 1's own existing
 * `MutationObserver`/`MutationWatcher.disconnect()`, the same mechanism
 * `pagehide` already uses — not a new capability) for the short window a
 * task-driven capture needs, then resume exactly as before.
 */
export function pauseMutationObserving(): void {
  mutationObserver?.disconnect();
  mutationObserver = null;
  watcher.disconnect();
}
export function resumeMutationObserving(): void {
  startObserving();
}

// ---- Navigation invalidation (plan §5.3 / master doc ~600ms) ----

function onNavigate(): void {
  void invalidateCache();
  void captureRequest("manual");
}

window.addEventListener("pagehide", () => {
  watcher.disconnect();
  mutationObserver?.disconnect();
  mutationObserver = null;
  void invalidateCache();
});
window.addEventListener("popstate", onNavigate);
window.addEventListener("hashchange", onNavigate);

// SPA routing (plan §8.2 rule 2): `history.pushState`/`replaceState` never
// fire `popstate` — that only fires on back/forward navigation — so a
// client-side router (React Router, etc.) calling pushState directly would
// otherwise leave a stale cached capture for the old route.
//
// A content script runs in an ISOLATED WORLD: monkey-patching
// `history.pushState` here does NOT affect calls made by the page's own
// (main-world) scripts — which is exactly what a real router uses — so an
// earlier version of this fix silently never fired in practice (confirmed
// via a real-Chrome test: the patch "worked" in the sense of not throwing,
// but the page's own pushState calls bypassed it entirely). Reading
// `location.href`, unlike patching a method, correctly reflects the true
// current URL regardless of which world changed it, so poll it instead —
// simple, robust, and immune to the isolated-world limitation. Piggybacks
// on the existing MutationObserver callback (SPA route changes almost
// always also mutate the DOM) plus a low-frequency fallback interval for
// the rare case of a route change with no accompanying DOM mutation.
let lastKnownUrl = location.href;
function checkUrlChanged(): void {
  if (location.href === lastKnownUrl) return;
  lastKnownUrl = location.href;
  onNavigate();
}
setInterval(checkUrlChanged, 500);

// ---- Boot: PING → observe + initial correlated capture ----

console.info("[Content] loaded");

// Dev 5: real (not test-only) demo/status panel + audit log. Safe to mount
// unconditionally — its root is excluded from Dev 1's capture (see
// shared/capture.ts's PERCEIVE_UI_MARKER_ATTR skip), so it can never affect
// what Dev 2/the backend/the LLM see, and mounting is idempotent.
if (document.body) {
  mountDev5Panel();
} else {
  window.addEventListener("DOMContentLoaded", () => mountDev5Panel(), { once: true });
}

async function pingServiceWorker(): Promise<string | null> {
  const meta = createRequestMeta();
  try {
    const response = (await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PING,
      origin: "content-script",
      ...meta,
    })) as { ok?: boolean; swStartedAt?: number } | null;
    const ok = !!response && response.ok === true;
    if (TEST_HOOKS) {
      (window as unknown as Record<string, unknown>).__perceivePingResult = {
        ok,
        requestId: meta.requestId,
        swStartedAt: response?.swStartedAt ?? null,
      };
    }
    return ok ? meta.requestId : null;
  } catch (error) {
    console.error("[Content] PING failed", error);
    if (TEST_HOOKS) {
      (window as unknown as Record<string, unknown>).__perceivePingResult = {
        ok: false,
        requestId: meta.requestId,
        error: String((error as Error)?.message ?? error),
      };
    }
    return null;
  }
}

// Retry so a cold-start race with the (possibly just-restarted) service
// worker cannot permanently fail the handshake: MV3 workers start lazily on
// first event, and a ping issued at document_idle can arrive before the new
// worker instance finishes registering its listener.
async function pingWithRetry(attempts = 15, delayMs = 750): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const requestId = await pingServiceWorker();
    if (requestId) return requestId;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

pingWithRetry().then((requestId) => {
  console.info(`[Content] PING ${requestId ? "ok" : "failed"}`);
  if (!requestId) return;
  stats.pingOkAt = Date.now();
  startObserving();
  void captureRequest("initial");
  if (TEST_HOOKS) {
    (window as unknown as Record<string, unknown>).__perceiveContentLoaded = true;
    (window as unknown as Record<string, unknown>).__perceiveStats = stats;
    // Dev 3 → Dev 4 integration gate: exposes the real (mocks-removed)
    // orchestrator for real-Chrome E2E verification (verify.js).
    (window as unknown as Record<string, unknown>).__perceiveRunTaskLoop = runTaskLoop;
    (window as unknown as Record<string, unknown>).__perceiveLastBackendFetchAttempts = lastBackendFetchAttempts;
    (window as unknown as Record<string, unknown>).__perceiveTestConfirmAndExecute = testConfirmAndExecute;
  }
});