/**
 * Shared type contracts for the Perceive extension.
 *
 * Phase 1 establishes only the correlation envelope and the context taxonomy.
 * Later phases extend these types (DOM snapshot, capture metadata, vision
 * results) without changing the message transport.
 */

/** Which extension context produced / consumed a message. */
export const CONTEXT = {
  CONTENT_SCRIPT: "content-script",
  BACKGROUND: "background",
  OFFSCREEN: "offscreen",
} as const;

export type ContextType = (typeof CONTEXT)[keyof typeof CONTEXT];

/** Message classification used for routing and validation. */
export const MESSAGE_KIND = {
  REQUEST: "request",
  RESPONSE: "response",
  EVENT: "event",
} as const;

export type MessageKind = (typeof MESSAGE_KIND)[keyof typeof MESSAGE_KIND];

/**
 * Correlation envelope carried by every message. The full capture-metadata
 * object (§5.2 of the plan: domCapturedAt, screenshotCapturedAt, ...) is a
 * Phase 2 concern and deliberately NOT declared here yet.
 */
export interface MessageEnvelope {
  requestId: string;
  timestamp: number;
  origin: ContextType;
}

export interface CaptureMetadata {
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
}

/**
 * A single correlated capture (Phase 2 §2.3): DOM snapshot + screenshot +
 * per-stage timing, all tied to one requestId.
 */
export interface CorrelatedCapture {
  requestId: string;
  /** Where the capture originated. */
  source: "initial" | "mutation" | "manual";
  tabId?: number;
  timing: CaptureMetadata;
  domCapturedAt: number;
  screenshotStartTime: number;
  screenshotEndTime: number;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  /** DOM snapshot object (raw structural DomSnapshot). */
  dom: unknown;
  /** Screenshot as a local data URL (never exported). */
  screenshot: {
    dataUrl: string;
    format: string;
    quality: number;
  };
  /** Screenshot natural pixel size (filled in by the offscreen decode). */
  screenshotPixelSize?: { width: number; height: number };
}

/**
 * Phase 4 output contract (Dev 1 — raw vision result, NO sensitivity
 * classification; that is Dev 2's job).
 */
export interface VisionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionDetection {
  label: string;
  confidence: number;
  boundingBox: VisionBoundingBox;
}

export interface RawVisionResult {
  requestId: string;
  modelId: string;
  modelVersion: string;
  backend: "webgpu" | "wasm";
  /** Dimensions of the image actually fed to the model (model-space). */
  imageWidth: number;
  imageHeight: number;
  /** Raw object detections, coordinates in model-image pixels. */
  detections: VisionDetection[];
  inferenceTimeMs: number;
  /** True when the result came from the on-device cache. */
  cached: boolean;
}