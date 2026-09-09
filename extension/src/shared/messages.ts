/**
 * Typed message contracts for Content Script ↔ Service Worker ↔ Offscreen
 * Document communication.
 *
 * All messages are discriminated unions on `type`. Structure is enforced by
 * runtime validators (used by every listener before dispatch) so a malformed
 * message can never reach a handler.
 *
 * Phase 1 implemented PING / OFFSCREEN_* / ERROR. Phase 2 implements capture
 * (DOM_CAPTURE_*, SCREENSHOT plumbing is internal to the SW), Phase 3 the
 * mutation channel (MUTATION_DETECTED), Phase 4 local vision
 * (ANALYSIS_*). Every cross-context exchange is correlated by `requestId`.
 */

import type { RequestMeta } from "./request-id";
import { isRequestMeta } from "./request-id";
import type { ContextType, MessageEnvelope } from "./types";
import type { DomSnapshot } from "./capture";
import type { RawVisionResult, CorrelatedCapture } from "./types";

export const MESSAGE_TYPES = {
  // Phase 1 – liveness / scaffold
  PING: "PING",
  PING_RESPONSE: "PING_RESPONSE",
  OFFSCREEN_READY: "OFFSCREEN_READY",
  OFFSCREEN_PING: "OFFSCREEN_PING",
  OFFSCREEN_PING_RESPONSE: "OFFSCREEN_PING_RESPONSE",
  ERROR_RESPONSE: "ERROR_RESPONSE",
  // Phase 2 – synchronized capture graph
  CAPTURE_REQUEST: "CAPTURE_REQUEST", // (any context) → SW: run one full capture+analysis
  DOM_CAPTURE_REQUEST: "DOM_CAPTURE_REQUEST", // SW → content: do the DOM walk
  DOM_CAPTURE_RESULT: "DOM_CAPTURE_RESULT", // content → SW: structural DOM snapshot
  SCREENSHOT_REQUEST: "SCREENSHOT_REQUEST", // declared (Phase 4 offscreen uses ANALYSIS_*)
  SCREENSHOT_RESULT: "SCREENSHOT_RESULT",
  CAPTURE_RESULT: "CAPTURE_RESULT", // SW → subscribers: the correlated capture package
  // Phase 3 – mutation / orchestration
  MUTATION_DETECTED: "MUTATION_DETECTED", // content → SW
  INVALIDATE_CACHE: "INVALIDATE_CACHE",
  // Phase 4 – local vision
  ANALYSIS_REQUEST: "ANALYSIS_REQUEST", // SW → offscreen
  ANALYSIS_RESULT: "ANALYSIS_RESULT", // offscreen → SW
  // Redaction (Dev 2 visual redaction, drawn in the offscreen doc's canvas)
  REDACT_REQUEST: "REDACT_REQUEST", // SW → offscreen
  REDACT_RESULT: "REDACT_RESULT", // offscreen → SW
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

/** Leaf union members. */
type PingRequest = RequestMeta & {
  type: typeof MESSAGE_TYPES.PING;
  origin: ContextType;
};
type PingResponse = RequestMeta & {
  type: typeof MESSAGE_TYPES.PING_RESPONSE;
  ok: true;
  origin: ContextType;
  swStartedAt: number;
};

type OffscreenReady = RequestMeta & {
  type: typeof MESSAGE_TYPES.OFFSCREEN_READY;
  ok: true;
  origin: ContextType;
  documentUrl: string;
};

type OffscreenPing = RequestMeta & {
  type: typeof MESSAGE_TYPES.OFFSCREEN_PING;
  origin: ContextType;
};

type OffscreenPingResponse = RequestMeta & {
  type: typeof MESSAGE_TYPES.OFFSCREEN_PING_RESPONSE;
  ok: boolean;
  origin: ContextType;
  documentUrl: string;
  readyAt: number;
  error?: string;
};

type ErrorResponse = RequestMeta & {
  type: typeof MESSAGE_TYPES.ERROR_RESPONSE;
  ok: false;
  origin: ContextType;
  error: string;
};

// ---- Phase 2 capture ----

export type CaptureSource = "initial" | "mutation" | "manual";

type CaptureRequest = RequestMeta & {
  type: typeof MESSAGE_TYPES.CAPTURE_REQUEST;
  origin: ContextType;
  source?: CaptureSource;
  tabId?: number;
};

type DomCaptureRequest = RequestMeta & {
  type: typeof MESSAGE_TYPES.DOM_CAPTURE_REQUEST;
  origin: ContextType;
  tabId?: number;
  source?: CaptureSource;
};

type DomCaptureResult = RequestMeta & {
  type: typeof MESSAGE_TYPES.DOM_CAPTURE_RESULT;
  ok: boolean;
  origin: ContextType;
  domSnapshot?: DomSnapshot;
  error?: string;
};

type CaptureResult = RequestMeta & {
  type: typeof MESSAGE_TYPES.CAPTURE_RESULT;
  ok: boolean;
  origin: ContextType;
  capture?: CorrelatedCapture;
  /** Vision detections for this capture (plan §5.1 — the flow ends with the
   * analysis result reaching the requester, not just the DOM+screenshot).
   * Absent when Phase 4 analysis was skipped/failed independently of the
   * capture itself; the capture can still be valid with no analysis. */
  analysis?: RawVisionResult | null;
  /** True when a newer capture superseded this request (plan §6). */
  superseded?: boolean;
  error?: string;
};

// ---- Phase 4 vision ----

type AnalysisRequest = RequestMeta & {
  type: typeof MESSAGE_TYPES.ANALYSIS_REQUEST;
  origin: ContextType;
  /** dataUrl of the captured screenshot (jpeg). */
  screenshot: string;
  /** Model-space/downscale info so the offscreen can map boxes back. */
  screenshotContext?: {
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
  };
};

type AnalysisResult = RequestMeta & {
  type: typeof MESSAGE_TYPES.ANALYSIS_RESULT;
  ok: boolean;
  origin: ContextType;
  result?: RawVisionResult;
  error?: string;
};

// ---- Redaction ----

/** A DOM/Dev2-classified sensitive region in *screenshot*-pixel space (never
 * a vision/YOLO detection box — see dev2-payload.ts's
 * `buildScreenshotSensitiveRegions`, the only producer of this shape). */
export interface RedactionRegion {
  bounding_box: { x: number; y: number; w: number; h: number };
  sensitivity_tier: 1 | 2 | 3;
}

/** A screenshot-pixel point to sample before/after redaction, for real
 * pixel-level verification that only sensitive regions changed. */
export interface RedactionSamplePoint {
  label: string;
  isSensitive: boolean;
  x: number;
  y: number;
}

export interface RedactionSampleResult {
  label: string;
  isSensitive: boolean;
  before: [number, number, number, number];
  after: [number, number, number, number];
  changed: boolean;
  isBlack: boolean;
}

type RedactRequest = RequestMeta & {
  type: typeof MESSAGE_TYPES.REDACT_REQUEST;
  origin: ContextType;
  screenshot: string;
  sensitiveRegions: RedactionRegion[];
  samplePoints?: RedactionSamplePoint[];
};

type RedactResult = RequestMeta & {
  type: typeof MESSAGE_TYPES.REDACT_RESULT;
  ok: boolean;
  origin: ContextType;
  redactedDataUrl?: string;
  samples?: RedactionSampleResult[];
  error?: string;
};

// ---- Phase 3 mutation ----

type MutationDetected = RequestMeta & {
  type: typeof MESSAGE_TYPES.MUTATION_DETECTED;
  origin: ContextType;
  /** SW fills tab.id from the sender when the content script omits it. */
  tabId?: number;
  mutationCount: number;
  source?: CaptureSource;
};

type InvalidateCache = RequestMeta & {
  type: typeof MESSAGE_TYPES.INVALIDATE_CACHE;
  origin: ContextType;
};

// ---- Public union ----

export type Message =
  | PingRequest
  | PingResponse
  | OffscreenReady
  | OffscreenPing
  | OffscreenPingResponse
  | ErrorResponse
  | CaptureRequest
  | DomCaptureRequest
  | DomCaptureResult
  | CaptureResult
  | AnalysisRequest
  | AnalysisResult
  | RedactRequest
  | RedactResult
  | MutationDetected
  | InvalidateCache;

export type RequestMessage = Extract<Message, { origin: ContextType }>;

const ORIGINS: readonly string[] = ["content-script", "background", "offscreen"];

export class MessageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageParseError";
  }
}

/**
 * Validate the raw value from `chrome.runtime.onMessage` and return a typed
 * Message. Throws MessageParseError for anything structurally invalid so the
 * caller can route to an ERROR_RESPONSE.
 */
export function parseMessage(value: unknown): Message {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") {
    throw new MessageParseError("Message must be an object");
  }
  const type = v.type;
  if (typeof type !== "string" || !(type in MESSAGE_TYPES)) {
    throw new MessageParseError(`Unknown message type: ${String(type)}`);
  }
  if (!isRequestMeta(value)) {
    throw new MessageParseError("Message must carry a valid requestId and timestamp");
  }
  const origin = v.origin;
  if (typeof origin !== "string" || !ORIGINS.includes(origin)) {
    throw new MessageParseError(`Message must carry a valid origin, got: ${String(origin)}`);
  }
  return value as Message;
}

/** Throws if the message is not the given type. Useful in handlers. */
export function assertMessageType<T extends Message>(
  message: Message,
  expected: T["type"]
): asserts message is T {
  if (message.type !== expected) {
    throw new MessageParseError(`Expected type ${expected}, got ${message.type}`);
  }
}

/** Synthesize a typed ERROR_RESPONSE (used by listeners on parse/handle failure). */
export function createErrorResponse(
  input: unknown,
  error: unknown,
  origin: ContextType
): ErrorResponse {
  const base = input as Partial<RequestMeta> | null;
  const fallbackMeta = {
    requestId: base && typeof base.requestId === "string" ? base.requestId : "unknown",
    timestamp: Date.now(),
  };
  return {
    ...fallbackMeta,
    type: MESSAGE_TYPES.ERROR_RESPONSE,
    ok: false,
    origin,
    error: String((error as Error)?.message ?? error),
  };
}

/** MessageEnvelope alias so consumers can use one term for both. */
export type { MessageEnvelope };
export { MESSAGE_TYPES as MessageTypes };
export type { PingRequest, PingResponse };