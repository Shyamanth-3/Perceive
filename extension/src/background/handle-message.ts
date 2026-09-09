/**
 * Service Worker message handler. Pure and testable – no chrome globals here.
 *
 * Returns the response Message to send back, or `null` when the message is an
 * asynchronous event that needs no response.
 *
 * Phase 2 routes CAPTURE_REQUEST / MUTATION_DETECTED / INVALIDATE_CACHE into
 * the (injected) capture orchestrator. DOM_CAPTURE_RESULT and ANALYSIS_RESULT
 * are never routed here — they are response channels of tabs.sendMessage /
 * runtime.sendMessage and are consumed directly by the capture graph deps.
 */

import {
  createErrorResponse,
  MESSAGE_TYPES,
  parseMessage,
  type CaptureSource,
  type Message,
} from "../shared/messages";
import type { RunCaptureOutcome } from "./capture-graph";
import type { ContextType } from "../shared/types";

export interface SwRuntimeState {
  startedAt: number;
  lastPing?: { requestId: string; receivedAt: number; origin: string };
  lastOffscreenReady?: { requestId: string; documentUrl: string };
  lastCapture?: { requestId: string; requestReceivedAt: number; source: CaptureSource };
  lastMutation?: { requestId: string; receivedAt: number; mutationCount: number };
  cacheEpoch: number;
}

export function createSwRuntimeState(): SwRuntimeState {
  return { startedAt: Date.now(), cacheEpoch: 0 };
}

/** Injected capture-graph plumbing (wired to the orchestrator in the SW). */
export interface SwHandlerDeps {
  enqueueCapture(input: {
    requestId: string;
    tabId: number;
    source: CaptureSource;
  }): Promise<RunCaptureOutcome | null>;
  invalidateCaptures(reason?: string): void;
}

/** Context of the sender, resolved by the SW listener (not the pure handler). */
export interface SwHandlerContext {
  senderTabId?: number;
}

export async function handleSwMessage(
  input: unknown,
  state: SwRuntimeState,
  origin: ContextType = "background",
  ctx: SwHandlerContext = {},
  deps?: SwHandlerDeps
): Promise<Message | null> {
  let message: Message;
  try {
    message = parseMessage(input);
  } catch (error) {
    return createErrorResponse(input, error, origin);
  }

  switch (message.type) {
    case MESSAGE_TYPES.PING: {
      state.lastPing = {
        requestId: message.requestId,
        receivedAt: Date.now(),
        origin: message.origin,
      };
      return {
        type: MESSAGE_TYPES.PING_RESPONSE,
        requestId: message.requestId,
        timestamp: Date.now(),
        ok: true,
        origin,
        swStartedAt: state.startedAt,
      } satisfies Message;
    }
    case MESSAGE_TYPES.OFFSCREEN_READY: {
      state.lastOffscreenReady = {
        requestId: message.requestId,
        documentUrl: message.documentUrl,
      };
      return null;
    }
    case MESSAGE_TYPES.CAPTURE_REQUEST:
    case MESSAGE_TYPES.MUTATION_DETECTED: {
      const source: CaptureSource =
        message.type === MESSAGE_TYPES.MUTATION_DETECTED
          ? (message.source ?? "mutation")
          : (message.source ?? "manual");
      const tabId = message.type === MESSAGE_TYPES.CAPTURE_REQUEST
        ? (message.tabId ?? ctx.senderTabId)
        : (message.tabId ?? ctx.senderTabId);
      if (!tabId) {
        return createErrorResponse(
          message,
          new Error(`${message.type}: no tab available to capture`),
          origin
        );
      }
      if (!deps?.enqueueCapture) {
        return createErrorResponse(
          message,
          new Error(`${message.type}: capture orchestrator not wired`),
          origin
        );
      }
      // getStatus().lastCapture must reflect the most recent capture *event*
      // regardless of its source — it used to be set only for CAPTURE_REQUEST,
      // so a mutation-triggered capture (which completes successfully) never
      // showed up here even though the underlying capture worked correctly.
      state.lastCapture = { requestId: message.requestId, requestReceivedAt: Date.now(), source };
      if (message.type === MESSAGE_TYPES.MUTATION_DETECTED) {
        state.lastMutation = {
          requestId: message.requestId,
          receivedAt: Date.now(),
          mutationCount: message.mutationCount,
        };
      }
      const outcome = await deps.enqueueCapture({
        requestId: message.requestId,
        tabId,
        source,
      });
      if (!outcome) {
        return {
          type: MESSAGE_TYPES.CAPTURE_RESULT,
          requestId: message.requestId,
          timestamp: Date.now(),
          ok: true,
          origin,
          superseded: true,
        } satisfies Message;
      }
      return {
        type: MESSAGE_TYPES.CAPTURE_RESULT,
        requestId: message.requestId,
        timestamp: Date.now(),
        ok: true,
        origin,
        capture: outcome.capture,
        analysis: outcome.analysis,
      } satisfies Message;
    }
    case MESSAGE_TYPES.INVALIDATE_CACHE: {
      state.cacheEpoch += 1;
      deps?.invalidateCaptures?.(`cacheEpoch=${state.cacheEpoch}`);
      return null;
    }
    default:
      return createErrorResponse(
        message,
        new Error(`SW does not handle message type '${message.type as string}'`),
        origin
      );
  }
}