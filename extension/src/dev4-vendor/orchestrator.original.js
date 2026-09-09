import { executeAction } from './actionExecutor.js';
import { requiresConfirmation, requestConfirmation } from './confirmationUI.js';
import { RETRY_CONFIG } from '../shared/constants.js';

// NOTE: These are placeholders for Dev 1 and Dev 2's modules.
// In the real extension, these would be imported from their respective files.
const mockDev1 = {
    captureCurrentState: async () => ({ dom: {}, screenshot: "mock_screenshot_data" })
};
const mockDev2 = {
    getVaultForSession: (sessionId) => {
        return {
            id: sessionId,
            resolveToken: function(token) {
                // Mock resolution logic for E2E tests
                if (token === '[EMAIL]') return 'priya.sharma@example.com';
                if (token === '[PASSWORD]') return 'D3m0P@ss!';
                if (token === '[CARD_NUMBER_1]') return '4111 1111 1111 7890';
                if (token === '[UNKNOWN_TOKEN_XYZ]') return null; // Will trigger unresolvable token
                return `resolved_${token}`;
            }
        };
    },
    endSession: (sessionId) => {
        console.log(`[Dev 2] Vault cleared for session ${sessionId}`);
        if (window.__activeVaults !== undefined) {
            window.__activeVaults = Math.max(0, window.__activeVaults - 1);
        }
    },
    buildSanitizedPayload: async (snapshot, sessionId, taskInstruction, stepNumber) => {
        return {
            session_id: sessionId,
            task_instruction: taskInstruction,
            step_number: stepNumber,
            dom_summary: { elements: [] },
            mocked: true
        };
    }
};

const BACKEND_URL = 'http://localhost:8000';

const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Orchestrator-owned task cleanup. Called on EVERY exit path.
 * 
 * Three steps, in order:
 *   1. endSession(sessionId) — Dev 2's vault cleanup (session-scoped)
 *   2. POST /session/{id}/end — notify backend (fire-and-forget)
 *   3. Emit agent-session-end — for Dev 5's audit log
 */
async function finalizeTask(sessionId, reason) {
    console.log(`[Orchestrator] Finalizing task ${sessionId}. Reason: ${reason}`);
    
    // Step 1: Clear Dev 2's vault
    mockDev2.endSession(sessionId);

    // Step 2: Notify backend
    try {
        fetch(`${BACKEND_URL}/session/${sessionId}/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        }).catch(() => {}); // Fire and forget
    } catch (e) {
        // non-fatal, swallow silently
    }

    // Step 3: Emit event
    window.dispatchEvent(new CustomEvent('agent-session-end', {
        detail: { sessionId, reason }
    }));
}

export async function runTaskLoop(taskInstruction) {
    const sessionId = crypto.randomUUID();
    let stepNumber = 0;
    
    // Track active vaults for E2E testing
    if (window.__activeVaults === undefined) window.__activeVaults = 0;
    window.__activeVaults++;

    // Obtain vault ONCE at task start
    const vault = mockDev2.getVaultForSession(sessionId);
    const resolveToken = vault.resolveToken.bind(vault);

    try {
        while (stepNumber < RETRY_CONFIG.MAX_STEPS) {
            stepNumber++;
            let retriesLeft = RETRY_CONFIG.MAX_RETRIES_PER_STEP;
            let stepSuccess = false;

            while (retriesLeft > 0 && !stepSuccess) {
                try {
                    // 1. Capture
                    const snapshot = await mockDev1.captureCurrentState();

                    // 2. Redact + build payload
                    const payload = await mockDev2.buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber);

                    // 3. Send to backend (mocking transport logic directly here for testability without a real backend)
                    // In real code: const actionResponse = await sendToBackend(payload);
                    let actionResponse = null;
                    
                    // --- MOCK BACKEND RESPONSES FOR E2E ---
                    if (window.__mockBackendResponse) {
                        actionResponse = window.__mockBackendResponse(stepNumber, payload);
                    } else {
                        throw new Error("No mock backend provided for E2E tests");
                    }
                    // --------------------------------------

                    // 4. Check for terminal actions
                    if (actionResponse.action.type === 'task_complete') {
                        await finalizeTask(sessionId, 'completed');
                        return { success: true, steps: stepNumber };
                    }
                    if (actionResponse.action.type === 'task_failed') {
                        await finalizeTask(sessionId, 'failed_by_server');
                        return { success: false, reason: actionResponse.action.reasoning_short, steps: stepNumber };
                    }

                    // 5. Risk-tier confirmation
                    if (requiresConfirmation(actionResponse.action)) {
                        const approved = await requestConfirmation(actionResponse.action);
                        if (!approved) {
                            await finalizeTask(sessionId, 'denied_by_user');
                            return { success: false, reason: 'User denied risky action', steps: stepNumber };
                        }
                    }

                    // 6. Execute
                    let result;
                    if (window.__forceExecuteFailure) {
                        result = { success: false, error: 'forced_failure' };
                    } else {
                        result = await executeAction(actionResponse.action, resolveToken);
                    }

                    if (result.success) {
                        stepSuccess = true;
                        await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
                    } else {
                        console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
                        retriesLeft--;
                    }
                } catch (err) {
                    console.error(`[Orchestrator] Error during step ${stepNumber}:`, err);
                    retriesLeft--;
                    if (retriesLeft === 0) {
                        await finalizeTask(sessionId, 'max_retries_exceeded');
                        return { success: false, reason: `Step ${stepNumber} failed after max retries: ${err.message}` };
                    }
                }
            }
            
            if (!stepSuccess) {
                // Should be unreachable due to exception throwing inside loop but kept for safety
                await finalizeTask(sessionId, 'max_retries_exceeded');
                return { success: false, reason: 'Max retries exceeded' };
            }
        }

        // Max steps reached
        await finalizeTask(sessionId, 'max_steps_exceeded');
        return { success: false, reason: 'Max steps exceeded' };

    } catch (fatalError) {
        console.error("[Orchestrator] Fatal error:", fatalError);
        await finalizeTask(sessionId, 'fatal_error');
        throw fatalError;
    }
}

// Expose for testing
window.__runTaskLoop = runTaskLoop;
