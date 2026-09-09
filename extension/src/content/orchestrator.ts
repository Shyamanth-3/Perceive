/**
 * Dev 4's real orchestrator (`dev4-vendor/orchestrator.original.js`), with
 * exactly three replacements — everything else (retry loop, exit paths,
 * confirmation gating, terminal-action handling) is Dev 4's original logic,
 * unchanged. Authored as TypeScript only so it can import Dev 1/2's real
 * modules directly through the existing esbuild pipeline — not a rewrite.
 *
 * Replaced (previously mocked/stubbed on the actual demo path, confirmed by
 * reading `orchestrator.original.js` in full):
 *
 * 1. `mockDev1.captureCurrentState()` → a real `CAPTURE_REQUEST` message to
 *    the Service Worker, awaiting the real `CAPTURE_RESULT` (now carrying
 *    `analysis` too — see the Dev 1 completion report's fix). No second
 *    capture implementation: this is the exact same message Dev 1's own
 *    `content-script.ts` sends for its own auto-captures.
 *
 * 2. `mockDev2.buildSanitizedPayload()` → the real Dev 1→Dev 2 pipeline
 *    (`dev2-payload.ts`'s `buildSanitizedClientPayload`, unchanged from the
 *    Dev 1→Dev 2 integration), using a real session vault from Dev 2's real
 *    `session-vault-manager.js`.
 *
 * 3. `window.__mockBackendResponse` (previously: THROWS if unset — there was
 *    no real backend call on the demo path at all, only a commented-out
 *    line) → a real `sendToBackend()` call. Reuses `dev4-vendor/transport
 *    .original.js`'s real fetch/timeout/schema-validation logic almost
 *    verbatim, with one change: its own `assertNoLeakage` (a narrower,
 *    duplicate, hand-rolled regex check — email/phone/card/aadhaar only, no
 *    OTP, no sensitive-key-name check) is replaced with Dev 2's real,
 *    already-proven `assertSafeToSend` (the same fail-closed gate already
 *    used by `dev2-payload.ts`) — maintaining two divergent privacy checks
 *    for the same purpose was flagged as a real gap in the Dev 1→Dev 2
 *    report; fixed here.
 */

import { RETRY_CONFIG } from "../dev4-vendor/constants.js";
import { validateActionResponse } from "../dev4-vendor/schemas.js";
// @ts-expect-error -- Dev 4's real, unmodified action executor (plain JS)
import { executeAction } from "../dev4-vendor/actionExecutor.js";
// @ts-expect-error -- Dev 4's real, unmodified confirmation UI (plain JS)
import { requiresConfirmation, requestConfirmation } from "../dev4-vendor/confirmationUI.js";

import { MESSAGE_TYPES } from "../shared/messages";
import { createRequestMeta } from "../shared/request-id";
import { buildSanitizedClientPayload, type ClientPayload } from "./dev2-payload";
import { getVaultForSession, endSession } from "../dev2-vendor/session-vault-manager.js";
import { detectPII } from "../dev2-vendor/pii-patterns.js";
import { assertSafeToSend } from "../dev2-vendor/leakage-auditor.js";
import type { DomSnapshot } from "../shared/capture";
import { pauseMutationObserving, resumeMutationObserving } from "./content-script";
import { emitPipelineEvent, PIPELINE_STAGES } from "./dev5-events";

const BACKEND_URL = "http://127.0.0.1:8000";

class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Real Dev 1 capture — the SAME message Dev 1's own auto-capture flow uses.
 *
 * Found via real QuickShop testing: Dev 1's LATEST_REQUEST_WINS orchestrator
 * (frozen, unchanged) is shared between Dev 1's own autonomous
 * mutation-triggered captures and this orchestrator's on-demand ones — a
 * request the orchestrator makes can legitimately lose that race to a
 * newer, unrelated capture Dev 1 triggered on its own (e.g. right after a
 * DOM mutation). That's LATEST_REQUEST_WINS working exactly as designed,
 * not a bug — plan §6 explicitly calls a superseded request an expected
 * outcome, not a failure. Treating it as a step-level failure (consuming
 * one of the 3 step retries per §Retry policy) was wrong; retrying the
 * capture itself a few times, quickly, is the correct response.
 */
async function realCaptureCurrentState(): Promise<{ dom: DomSnapshot; url: string }> {
  // Dev 1's own autonomous mutation-triggered captures (and the
  // `data-element-id` re-stamping that comes with them) must stay paused for
  // the caller's ENTIRE step, not just this capture — see
  // `pauseMutationObserving()`'s doc comment and `runTaskLoop`'s pause/resume
  // wrapping around the whole capture→send→confirm→execute sequence for why.
  const MAX_SUPERSEDED_RETRIES = 12;
  for (let attempt = 0; attempt < MAX_SUPERSEDED_RETRIES; attempt++) {
    const meta = createRequestMeta();
    const response = (await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CAPTURE_REQUEST,
      origin: "content-script",
      source: "manual",
      ...meta,
    })) as { ok?: boolean; capture?: { dom: unknown }; error?: string; superseded?: boolean } | undefined;

    if (response?.ok && response.capture) {
      return { dom: response.capture.dom as DomSnapshot, url: location.href };
    }
    if (response?.superseded) {
      await new Promise((r) => setTimeout(r, 250 + attempt * 150));
      continue;
    }
    throw new Error(`capture failed: ${response?.error ?? "no response"}`);
  }
  throw new Error(`capture failed: superseded ${MAX_SUPERSEDED_RETRIES}x in a row`);
}

/** Real Dev 2 sanitized payload — reuses the exact function proven in the
 * Dev 1→Dev 2 integration gate, no reimplementation. */
async function realBuildSanitizedPayload(
  captureState: { dom: DomSnapshot; url: string },
  sessionId: string,
  taskInstruction: string,
  stepNumber: number
): Promise<ClientPayload> {
  const vault = getVaultForSession(sessionId);
  return buildSanitizedClientPayload({
    dom: captureState.dom,
    url: captureState.url,
    tokenVault: vault,
    sessionId,
    taskInstruction,
    stepNumber,
  });
}

/** Real Dev 3 network call — Dev 4's real fetch/timeout logic, Dev 2's real
 * leakage gate (not the narrower duplicate that used to live here). */
/** Diagnostic-only ring buffer (no page content, no payload) for verify.js
 * to inspect real fetch timing without guessing at sleeps — root-causing
 * the QuickShop step timeout requires knowing whether the fetch itself was
 * slow/hung vs. never reached at all (capture supersession). */
export const lastBackendFetchAttempts: { startedAt: number; elapsedMs: number; outcome: string }[] = [];

async function sendToBackend(payload: ClientPayload): Promise<unknown> {
  assertSafeToSend(payload, detectPII);

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${BACKEND_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      lastBackendFetchAttempts.push({ startedAt, elapsedMs: Date.now() - startedAt, outcome: `status=${response.status}` });
      throw new TransportError(`Server returned ${response.status}`);
    }
    const actionResponse = await response.json();
    lastBackendFetchAttempts.push({
      startedAt,
      elapsedMs: Date.now() - startedAt,
      outcome: `status=${response.status} action=${JSON.stringify({
        type: actionResponse?.action?.type,
        target: actionResponse?.action?.target_element_id,
        risk: actionResponse?.action?.risk_tier,
      })}`,
    });
    validateActionResponse(actionResponse);
    return actionResponse;
  } catch (err) {
    clearTimeout(timeoutId);
    lastBackendFetchAttempts.push({
      startedAt,
      elapsedMs: Date.now() - startedAt,
      outcome: `error name=${(err as Error)?.name} message=${(err as Error)?.message}`,
    });
    if ((err as { name?: string }).name === "AbortError") {
      throw new TransportError("Request timed out");
    }
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dev 4's own cleanup path, unchanged: clear Dev 2's vault, notify the
 * backend (fire-and-forget), emit the Dev 5-facing event. */
async function finalizeTask(sessionId: string, reason: string): Promise<void> {
  console.info(`[Orchestrator] Finalizing task ${sessionId}. Reason: ${reason}`);
  endSession(sessionId);
  try {
    fetch(`${BACKEND_URL}/session/${sessionId}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }).catch(() => undefined);
  } catch {
    /* non-fatal */
  }
  window.dispatchEvent(new CustomEvent("agent-session-end", { detail: { sessionId, reason } }));
}

export interface TaskResult {
  success: boolean;
  steps?: number;
  reason?: string;
}

/**
 * Test-only entry point (Stage 2 verification): drives Dev 4's real,
 * unmodified `requiresConfirmation` / `requestConfirmation` / `executeAction`
 * directly against a synthetic action, without going through the LLM/backend
 * at all — lets confirmation-allow, confirmation-deny, and token-resolution
 * failure be exercised as real (not mocked) executions independent of Groq
 * availability/rate limits. `tokenMap` stands in for the local vault's
 * `resolveToken` (never a real sensitive value in test cases — see verify.js
 * callers).
 */
export async function testConfirmAndExecute(
  action: { type: string; target_element_id: string | null; value: string | null; risk_tier: string; reasoning_short: string },
  tokenMap: Record<string, string> = {}
): Promise<{ requiresConfirmationResult: boolean; approved: boolean | null; executionResult: unknown }> {
  const needsConfirm = requiresConfirmation(action);
  let approved: boolean | null = null;
  if (needsConfirm) {
    approved = await requestConfirmation(action);
    if (!approved) {
      return { requiresConfirmationResult: true, approved: false, executionResult: null };
    }
  }
  const resolveToken = (token: string) => tokenMap[token] ?? null;
  const executionResult = await executeAction(action, resolveToken);
  return { requiresConfirmationResult: needsConfirm, approved, executionResult };
}

/**
 * Dev 4's real task loop — structure, retry policy, exit-path accounting,
 * and terminal-action/confirmation handling are unchanged from
 * `orchestrator.original.js`. Only the three upstream calls (capture,
 * sanitize, send) are now real.
 */
export async function runTaskLoop(taskInstruction: string): Promise<TaskResult> {
  const sessionId = crypto.randomUUID();
  let stepNumber = 0;

  const vault = getVaultForSession(sessionId);
  const resolveToken = (token: string) => vault.resolveToken(token);

  try {
    while (stepNumber < RETRY_CONFIG.MAX_STEPS) {
      stepNumber++;
      let retriesLeft = RETRY_CONFIG.MAX_RETRIES_PER_STEP;
      let stepSuccess = false;
      let lastExecutionError: string | undefined;
      let lastAction: unknown;

      while (retriesLeft > 0 && !stepSuccess) {
        // Root-cause fix (real QuickShop testing): pausing Dev 1's own
        // autonomous MutationObserver only around the capture sub-step left
        // it free to re-fire (and re-stamp `data-element-id`) during the
        // slow part of a step — the backend/LLM round trip and confirmation
        // wait — which could invalidate the very id the LLM just targeted
        // before `executeAction` ever ran, surfacing as a spurious
        // `target_element_not_found`. Pause for the whole step instead.
        pauseMutationObserving();
        try {
          // 1. Real Dev 1 capture.
          emitPipelineEvent({ stage: PIPELINE_STAGES.CAPTURING, sessionId, stepNumber });
          const captureState = await realCaptureCurrentState();

          // 2. Real Dev 2 classification + tokenization + fail-closed audit.
          emitPipelineEvent({ stage: PIPELINE_STAGES.SANITIZING, sessionId, stepNumber });
          const payload = await realBuildSanitizedPayload(captureState, sessionId, taskInstruction, stepNumber);
          const sensitiveElementCount = payload.dom_summary.elements.filter((el) => el.is_sensitive).length;
          emitPipelineEvent({ stage: PIPELINE_STAGES.SENSITIVE_DATA_DETECTED, sessionId, stepNumber, sensitiveElementCount });

          // 3. Real Dev 3 backend call.
          emitPipelineEvent({ stage: PIPELINE_STAGES.SENDING_SANITIZED_REQUEST, sessionId, stepNumber });
          emitPipelineEvent({ stage: PIPELINE_STAGES.WAITING_FOR_LLM, sessionId, stepNumber });
          const actionResponse = (await sendToBackend(payload)) as {
            action: { type: string; target_element_id: string | null; value: string | null; risk_tier: string; reasoning_short: string };
          };
          emitPipelineEvent({
            stage: PIPELINE_STAGES.ACTION_RECEIVED,
            sessionId,
            stepNumber,
            actionType: actionResponse.action.type,
            targetElementId: actionResponse.action.target_element_id,
            riskTier: actionResponse.action.risk_tier,
          });

          // 4. Terminal actions (Dev 4 original logic, unchanged).
          if (actionResponse.action.type === "task_complete") {
            emitPipelineEvent({ stage: PIPELINE_STAGES.COMPLETED, sessionId, stepNumber });
            await finalizeTask(sessionId, "completed");
            return { success: true, steps: stepNumber };
          }
          if (actionResponse.action.type === "task_failed") {
            emitPipelineEvent({ stage: PIPELINE_STAGES.FAILED, sessionId, stepNumber, reason: actionResponse.action.reasoning_short });
            await finalizeTask(sessionId, "failed_by_server");
            return { success: false, reason: actionResponse.action.reasoning_short, steps: stepNumber };
          }

          // 5. Risk-tier confirmation (Dev 4 original logic, unchanged —
          // the server's own risk_tier override from Dev 3 is respected
          // here exactly as returned, never re-evaluated/weakened).
          if (requiresConfirmation(actionResponse.action)) {
            emitPipelineEvent({
              stage: PIPELINE_STAGES.CONFIRMATION_REQUIRED,
              sessionId,
              stepNumber,
              actionType: actionResponse.action.type,
              targetElementId: actionResponse.action.target_element_id,
              riskTier: actionResponse.action.risk_tier,
            });
            const approved = await requestConfirmation(actionResponse.action);
            emitPipelineEvent({ stage: PIPELINE_STAGES.CONFIRMATION_REQUIRED, sessionId, stepNumber, approved });
            if (!approved) {
              emitPipelineEvent({ stage: PIPELINE_STAGES.FAILED, sessionId, stepNumber, reason: "denied_by_user" });
              await finalizeTask(sessionId, "denied_by_user");
              return { success: false, reason: "User denied risky action", steps: stepNumber };
            }
          }

          // 6. Real execution (Dev 4's real, unmodified actionExecutor).
          emitPipelineEvent({
            stage: PIPELINE_STAGES.EXECUTING,
            sessionId,
            stepNumber,
            actionType: actionResponse.action.type,
            targetElementId: actionResponse.action.target_element_id,
          });
          lastAction = actionResponse.action;
          const result = await executeAction(actionResponse.action, resolveToken);
          lastBackendFetchAttempts.push({
            startedAt: Date.now(),
            elapsedMs: 0,
            outcome: `executeAction type=${actionResponse.action.type} target=${actionResponse.action.target_element_id} result=${JSON.stringify(result)}`,
          });

          if (result.success) {
            stepSuccess = true;
            await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
          } else {
            lastExecutionError = result.error;
            console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
            retriesLeft--;
          }
        } catch (err) {
          console.error(`[Orchestrator] Error during step ${stepNumber}:`, err);
          retriesLeft--;
          if (retriesLeft === 0) {
            emitPipelineEvent({ stage: PIPELINE_STAGES.FAILED, sessionId, stepNumber, reason: (err as Error).message });
            await finalizeTask(sessionId, "max_retries_exceeded");
            return { success: false, reason: `Step ${stepNumber} failed after max retries: ${(err as Error).message}` };
          }
        } finally {
          resumeMutationObserving();
        }
      }

      if (!stepSuccess) {
        emitPipelineEvent({ stage: PIPELINE_STAGES.FAILED, sessionId, stepNumber, reason: "max_retries_exceeded" });
        await finalizeTask(sessionId, "max_retries_exceeded");
        return {
          success: false,
          reason: `Max retries exceeded (last execution error: ${lastExecutionError ?? "none"}; last action: ${JSON.stringify(lastAction)})`,
        };
      }
    }

    emitPipelineEvent({ stage: PIPELINE_STAGES.FAILED, sessionId, stepNumber, reason: "max_steps_exceeded" });
    await finalizeTask(sessionId, "max_steps_exceeded");
    return { success: false, reason: "Max steps exceeded" };
  } catch (fatalError) {
    console.error("[Orchestrator] Fatal error:", fatalError);
    emitPipelineEvent({ stage: PIPELINE_STAGES.FAILED, sessionId, stepNumber, reason: String((fatalError as Error)?.message ?? fatalError) });
    await finalizeTask(sessionId, "fatal_error");
    throw fatalError;
  }
}
