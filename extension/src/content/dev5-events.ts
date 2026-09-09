/**
 * Dev 5 integration: a real (not test-only, not mocked) event feed of the
 * orchestrator's actual pipeline state, for Dev 5's demo/status panel to
 * consume. Every event is emitted from the exact real transition it names —
 * never fabricated/simulated — and every field is safe-by-construction:
 * action `value` is never included (it is only ever null or a semantic
 * token already, per the privacy design, but this module doesn't even take
 * that risk — it only accepts the specific scalar fields below).
 */

export const PIPELINE_STAGES = {
  CAPTURING: "CAPTURING",
  SANITIZING: "SANITIZING",
  SENSITIVE_DATA_DETECTED: "SENSITIVE_DATA_DETECTED",
  SENDING_SANITIZED_REQUEST: "SENDING_SANITIZED_REQUEST",
  WAITING_FOR_LLM: "WAITING_FOR_LLM",
  ACTION_RECEIVED: "ACTION_RECEIVED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  EXECUTING: "EXECUTING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[keyof typeof PIPELINE_STAGES];

export const PIPELINE_EVENT_NAME = "perceive-pipeline-event";

export interface PipelineEventDetail {
  stage: PipelineStage;
  ts: number;
  sessionId?: string;
  stepNumber?: number;
  sensitiveElementCount?: number;
  actionType?: string;
  targetElementId?: string | null;
  riskTier?: string;
  approved?: boolean;
  reason?: string;
}

export function emitPipelineEvent(detail: Omit<PipelineEventDetail, "ts">): void {
  window.dispatchEvent(
    new CustomEvent<PipelineEventDetail>(PIPELINE_EVENT_NAME, { detail: { ...detail, ts: Date.now() } })
  );
}
