/**
 * Offscreen Document message handler. Pure and testable – chrome.location
 * is passed in so this module can be unit-tested.
 */

import {
  createErrorResponse,
  MESSAGE_TYPES,
  parseMessage,
  type Message,
} from "../shared/messages";
import type { ContextType } from "../shared/types";

export interface OffscreenRuntimeState {
  readyAt: number;
  documentUrl: string;
}

/** Injected so this handler stays testable without the ONNX runtime/DOM. */
export interface OffscreenHandlerDeps {
  runAnalysis(input: {
    requestId: string;
    screenshotDataUrl: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
  }): Promise<import("../shared/types").RawVisionResult>;
  runRedaction?(input: {
    screenshotDataUrl: string;
    sensitiveRegions: import("../shared/messages").RedactionRegion[];
    samplePoints: import("../shared/messages").RedactionSamplePoint[];
  }): Promise<{
    redactedDataUrl: string;
    samples: import("../shared/messages").RedactionSampleResult[];
  }>;
}

export async function handleOffscreenMessage(
  input: unknown,
  state: OffscreenRuntimeState,
  origin: ContextType = "offscreen",
  deps?: OffscreenHandlerDeps
): Promise<Message | null> {
  let message: Message;
  try {
    message = parseMessage(input);
  } catch (error) {
    return createErrorResponse(input, error, origin);
  }

  switch (message.type) {
    case MESSAGE_TYPES.OFFSCREEN_PING:
      return {
        type: MESSAGE_TYPES.OFFSCREEN_PING_RESPONSE,
        requestId: message.requestId,
        timestamp: Date.now(),
        ok: true,
        origin,
        documentUrl: state.documentUrl,
        readyAt: state.readyAt,
      } satisfies Message;
    case MESSAGE_TYPES.ANALYSIS_REQUEST: {
      if (!deps) {
        return createErrorResponse(
          message,
          new Error("Offscreen ANALYSIS_REQUEST handling is not wired (missing deps)"),
          origin
        );
      }
      try {
        const result = await deps.runAnalysis({
          requestId: message.requestId,
          screenshotDataUrl: message.screenshot,
          viewportWidth: message.screenshotContext?.viewportWidth ?? 0,
          viewportHeight: message.screenshotContext?.viewportHeight ?? 0,
          devicePixelRatio: message.screenshotContext?.devicePixelRatio ?? 1,
        });
        return {
          type: MESSAGE_TYPES.ANALYSIS_RESULT,
          requestId: message.requestId,
          timestamp: Date.now(),
          ok: true,
          origin,
          result,
        } satisfies Message;
      } catch (error) {
        return createErrorResponse(message, error, origin);
      }
    }
    case MESSAGE_TYPES.REDACT_REQUEST: {
      if (!deps?.runRedaction) {
        return createErrorResponse(
          message,
          new Error("Offscreen REDACT_REQUEST handling is not wired (missing deps)"),
          origin
        );
      }
      try {
        const { redactedDataUrl, samples } = await deps.runRedaction({
          screenshotDataUrl: message.screenshot,
          sensitiveRegions: message.sensitiveRegions,
          samplePoints: message.samplePoints ?? [],
        });
        return {
          type: MESSAGE_TYPES.REDACT_RESULT,
          requestId: message.requestId,
          timestamp: Date.now(),
          ok: true,
          origin,
          redactedDataUrl,
          samples,
        } satisfies Message;
      } catch (error) {
        return createErrorResponse(message, error, origin);
      }
    }
    default:
      return createErrorResponse(
        message,
        new Error(`Offscreen does not handle message type '${message.type as string}'`),
        origin
      );
  }
}