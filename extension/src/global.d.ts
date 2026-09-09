/**
 * Ambient declarations for the TEST_HOOKS-only globals exposed by the
 * bundled contexts (used by verify.js). These are undefined in production
 * builds (`npm run build`) because the hooks are stripped by esbuild.
 */

declare global {
interface PerceiveCaptureSummary {
  requestId: string;
  source: "initial" | "mutation" | "manual";
  tabId: number | null;
  timing: {
    requestId: string;
    domCapturedAt: number;
    screenshotCaptureStartedAt: number;
    screenshotCapturedAt: number;
    captureDelayMs: number;
    screenshotDurationMs: number;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
  };
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  dom: {
    elementCount: number;
    truncated: boolean;
    hasElements: boolean;
    privacy: { passwordFields: number; capturedPasswordValues: number };
  };
  screenshot: {
    format: string;
    quality: number;
    dataUrlLength: number;
    dataUrlPrefix: string;
  };
}

interface PerceiveOrchestratorState {
  latestSeq: number;
  inflightRequestId: string | null;
  pendingRequestId: string | null;
  superseded: string[];
  capturesCompleted: number;
  hasLastResult: boolean;
}

/** Phase 4: summarized RawVisionResult (no raw detections dump). */
interface PerceiveAnalysisSummary {
  requestId: string;
  modelId: string;
  modelVersion: string;
  backend: "webgpu" | "wasm";
  imageWidth: number;
  imageHeight: number;
  detectionCount: number;
  inferenceTimeMs: number;
  cached: boolean;
}

interface PerceiveTestApi {
  getStatus(): Promise<{
    startedAt: number;
    lastPing: { requestId: string; receivedAt: number; origin: string } | null;
    lastOffscreenReady: { requestId: string; documentUrl: string } | null;
    lastCapture: { requestId: string; requestReceivedAt: number; source: "initial" | "mutation" | "manual" } | null;
    lastMutation: { requestId: string; receivedAt: number; mutationCount: number } | null;
    cacheEpoch: number;
    captureCount: number;
    orchestrator: {
      latestSeq: number;
      inflightRequestId: string | null;
      pendingRequestId: string | null;
      superseded: string[];
      lastError: { requestId: string; message: string } | null;
    };
    offscreenContexts: unknown[];
    manifest: {
      name?: string;
      version?: string;
      swType?: string;
      swFile?: string;
    };
  }>;
  ensureAndPing(): Promise<{
    outcome: { created: boolean; present: boolean; documentUrls: string[] };
    offscreenContextCount: number;
    offscreenUrls: (string | undefined)[];
    pingResponse: unknown;
  }>;
  triggerCapture(source?: "initial" | "mutation" | "manual"): Promise<{
    superseded: boolean;
    capture: PerceiveCaptureSummary | null;
    analysis?: PerceiveAnalysisSummary | null;
    /** Set when superseded===true AND the underlying capture actually threw
     * (as opposed to being genuinely superseded by a newer request). */
    lastError?: { requestId: string; message: string } | null;
    error?: string;
  }>;
  getLatestCapture(): Promise<PerceiveCaptureSummary | null>;
  getCaptureCount(): Promise<number>;
  invalidateCaptures(reason?: string): Promise<PerceiveOrchestratorState>;
  /** Dev 1 → Dev 2 integration gate (verify.js real-Chrome proof). */
  buildSanitizedPayload(
    sessionId: string,
    taskInstruction: string,
    stepNumber: number
  ): Promise<{ ok?: boolean; payload?: unknown; error?: string }>;
  /** Dev 2 → Dev 3 integration gate: real network call to the real backend. */
  sendSanitizedPayloadToBackend(
    sessionId: string,
    taskInstruction: string,
    stepNumber: number
  ): Promise<{ ok?: boolean; sentPayload?: unknown; backendResponse?: unknown; error?: string }>;
  /** Redaction root-cause verification gate (real pixel sampling, no vision
   * boxes involved — DOM/Dev2 classification only). */
  verifyRedaction(
    sessionId: string,
    taskInstruction: string,
    stepNumber: number
  ): Promise<{
    ok?: boolean;
    error?: string;
    sensitiveRegionCount?: number;
    devicePixelRatio?: number;
    redactedDataUrlLength?: number;
    samples?: {
      label: string;
      isSensitive: boolean;
      before: [number, number, number, number];
      after: [number, number, number, number];
      changed: boolean;
      isBlack: boolean;
    }[];
  }>;
}

  var __perceiveTest: PerceiveTestApi | undefined;
  var __perceiveOffscreen:
    | {
        getState(): { readyAt: number; documentUrl: string };
        resourceNames(): string[];
      }
    | undefined;
}

export {};