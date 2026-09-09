// Minimal validation logic since we don't have Pydantic on the client
// but we want to ensure the server response is structurally sound before executing.

export function validateActionResponse(response) {
    if (!response || typeof response !== 'object') {
        throw new Error("Invalid response: Not an object");
    }

    if (!response.session_id) {
        throw new Error("Invalid response: Missing session_id");
    }

    if (typeof response.step_number !== 'number') {
        throw new Error("Invalid response: Invalid step_number");
    }

    const action = response.action;
    if (!action || typeof action !== 'object') {
        throw new Error("Invalid response: Missing action object");
    }

    const validTypes = ['click', 'type', 'scroll', 'wait', 'ask_user_confirmation', 'task_complete', 'task_failed'];
    if (!validTypes.includes(action.type)) {
        throw new Error(`Invalid response: Unknown action type '${action.type}'`);
    }

    if (!['safe', 'risky'].includes(action.risk_tier)) {
        throw new Error(`Invalid response: Unknown risk_tier '${action.risk_tier}'`);
    }

    return true;
}
