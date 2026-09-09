/**
 * Capture graph: orchestrates one synchronized DOM + screenshot capture with
 * timing metadata and LATEST_REQUEST_WINS concurrency (§5.2, §6 of the plan).
 *
 * The graph itself is pure and chrome-free (all IO is injected), so unit tests
 * can drive it with fakes. `service-worker.ts` wires the real chrome impl.
 */

import { buildCaptureMetadata, type DomSnapshot } from "../shared/capture";
import type {
  CaptureMetadata,
  CorrelatedCapture,
  RawVisionResult,
} from "../shared/types";
import type { CaptureSource } from "../shared/messages";
import { MESSAGE_TYPES } from "../shared/messages";
import {
  SCREENSHOT_FORMAT,
  SCREENSHOT_QUALITY,
} from "../shared/constants";

export interface ScreenshotOutcome {
  dataUrl: string;
  startedAt: number;
  endedAt: number;
}

export interface CaptureGraphDeps {
  /** Ask the content script for a fresh DOM snapshot. */
  requestDomCapture(tabId: number, requestId: string, source: CaptureSource): Promise<{
    domSnapshot: DomSnapshot;
    domCapturedAt: number;
  }>;
  /** Capture the visible tab as a local image (never leaves the process). */
  captureScreenshot(tabId: number): Promise<ScreenshotOutcome>;
  /**
   * Run local vision inference (Phase 4; undefined before then → skipped).
   * Viewport/dpr are included so the offscreen host can build the plan §8.1
   * composite cache key (imageHash, viewport, dpr, modelId/version, config).
   */
  runAnalysis?(input: {
    requestId: string;
    screenshot: ScreenshotOutcome;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
  }): Promise<RawVisionResult>;
  now(): number;
}

export interface CaptureTask {
  requestId: string;
  seq: number;
  tabId: number;
  source: CaptureSource;
}

export interface CorrelatedCapturePackage {
  capture: CorrelatedCapture;
  analysis: RawVisionResult | null;
}

export type RunCaptureOutcome = CorrelatedCapturePackage;

/** Execute a single capture: DOM → screenshot → (analysis) with timestamps. */
export async function runCaptureGraph(
  deps: CaptureGraphDeps,
  task: CaptureTask
): Promise<RunCaptureOutcome> {
  const dom = await deps.requestDomCapture(task.tabId, task.requestId, task.source);
  const screenshot = await deps.captureScreenshot(task.tabId);

  const domCapturedAt = dom.domCapturedAt;
  const screenshotStartTime = screenshot.startedAt;
  const screenshotEndTime = screenshot.endedAt;

  const timing: CaptureMetadata = buildCaptureMetadata({
    requestId: task.requestId,
    domCapturedAt,
    screenshotCaptureStartedAt: screenshotStartTime,
    screenshotCapturedAt: screenshotEndTime,
    viewport: { width: dom.domSnapshot.viewport.width, height: dom.domSnapshot.viewport.height },
    devicePixelRatio: dom.domSnapshot.devicePixelRatio,
    scroll: dom.domSnapshot.scroll,
  });

  let analysis: RawVisionResult | null = null;
  if (deps.runAnalysis) {
    analysis = await deps.runAnalysis({
      requestId: task.requestId,
      screenshot,
      viewport: { width: dom.domSnapshot.viewport.width, height: dom.domSnapshot.viewport.height },
      devicePixelRatio: dom.domSnapshot.devicePixelRatio,
    });
  }

  const capture: CorrelatedCapture = {
    requestId: task.requestId,
    source: task.source,
    tabId: task.tabId,
    timing,
    domCapturedAt,
    screenshotStartTime,
    screenshotEndTime,
    viewport: { width: dom.domSnapshot.viewport.width, height: dom.domSnapshot.viewport.height },
    devicePixelRatio: dom.domSnapshot.devicePixelRatio,
    scroll: dom.domSnapshot.scroll,
    dom: dom.domSnapshot,
    screenshot: {
      dataUrl: screenshot.dataUrl,
      format: SCREENSHOT_FORMAT,
      quality: SCREENSHOT_QUALITY,
    },
  };

  return { capture, analysis };
}

export interface OrchestratorState {
  latestSeq: number;
  inflight: CaptureTask | null;
  pending: CaptureTask | null;
  lastResult: RunCaptureOutcome | null;
  superseded: string[];
  capturesCompleted: number;
  /** Most recent genuine failure (DOM/screenshot/analysis threw) — distinct
   * from a request being superseded by a newer one. Diagnostic only. */
  lastError: { requestId: string; message: string } | null;
}

export interface CaptureOrchestrator {
  /**
   * Request a capture; LATEST_REQUEST_WINS (serialized, newest supersedes).
   * Resolves with the completed package, or null if the request was
   * superseded by a newer one (plan §6).
   */
  request(params: { requestId: string; tabId: number; source: CaptureSource }): Promise<RunCaptureOutcome | null>;
  /** Drop pending + supersede inflight (navigation / invalidation). */
  invalidate(opts?: { reason?: string }): void;
  getState(): OrchestratorState;
}

interface QueuedTask extends CaptureTask {
  resolve: (v: RunCaptureOutcome | null) => void;
}

/**
 * LATEST_REQUEST_WINS coordinator (plan §6): at most one capture+inference in
 * flight; a newer request supersedes an older one so its result can never
 * overwrite the newest active result.
 */
export function createCaptureOrchestrator(deps: CaptureGraphDeps): CaptureOrchestrator {
  let latestSeq = 0;
  let inflight: QueuedTask | null = null;
  let pending: QueuedTask | null = null;
  let lastResult: RunCaptureOutcome | null = null;
  const superseded: string[] = [];
  let capturesCompleted = 0;
  let lastError: { requestId: string; message: string } | null = null;

  async function pump(task: QueuedTask): Promise<void> {
    try {
      const outcome = await runCaptureGraph(deps, task);
      const isSuperseded = task.seq !== latestSeq;
      if (isSuperseded) {
        superseded.push(task.requestId);
        task.resolve(null);
        return;
      }
      lastResult = outcome;
      capturesCompleted += 1;
      task.resolve(outcome);
    } catch (error) {
      // A genuine failure (DOM/screenshot/analysis threw) is NOT the same
      // as "superseded by a newer request" — record it distinctly so it's
      // diagnosable instead of silently resolving null like a stale request.
      lastError = { requestId: task.requestId, message: String((error as Error)?.message ?? error) };
      task.resolve(null);
    } finally {
      inflight = null;
      const next = pending;
      pending = null;
      if (next) {
        inflight = next;
        void pump(next);
      }
    }
  }

  return {
    request(params) {
      latestSeq += 1;
      return new Promise<RunCaptureOutcome | null>((resolve) => {
        const task: QueuedTask = {
          requestId: params.requestId,
          seq: latestSeq,
          tabId: params.tabId,
          source: params.source,
          resolve,
        };
        if (!inflight) {
          inflight = task;
          void pump(task);
        } else {
          // A newer request replaces whatever was pending (LATEST_REQUEST_WINS,
          // plan §6): the task being replaced must still be resolved (never
          // silently dropped) or its caller would hang forever awaiting it.
          if (pending) {
            superseded.push(pending.requestId);
            pending.resolve(null);
          }
          pending = task;
        }
      });
    },
    invalidate(opts) {
      latestSeq += 1;
      const reason = opts?.reason ?? "invalidate";
      if (pending) {
        superseded.push(pending.requestId);
        pending.resolve(null);
        pending = null;
      }
      if (inflight) superseded.push(inflight.requestId);
      void reason;
    },
    getState(): OrchestratorState {
      return { latestSeq, inflight, pending, lastResult, superseded, capturesCompleted, lastError };
    },
  };
}

/** Message-type helper used by the background wrapper. */
export function captureRequestMessage(requestId: string, tabId: number, source: CaptureSource) {
  return {
    type: MESSAGE_TYPES.DOM_CAPTURE_REQUEST,
    origin: "background" as const,
    requestId,
    timestamp: Date.now(),
    tabId,
    source,
  };
}