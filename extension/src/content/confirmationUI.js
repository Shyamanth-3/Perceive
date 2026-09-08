import { RISK_TIERS } from '../shared/constants.js';

let confirmationOverlay = null;

function createOverlay() {
    if (confirmationOverlay) return confirmationOverlay;

    confirmationOverlay = document.createElement('div');
    Object.assign(confirmationOverlay.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        zIndex: '999999',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: 'sans-serif'
    });

    const dialog = document.createElement('div');
    Object.assign(dialog.style, {
        backgroundColor: 'white',
        padding: '20px',
        borderRadius: '8px',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        maxWidth: '400px',
        textAlign: 'center'
    });

    const title = document.createElement('h3');
    title.textContent = '🛡️ Agent wants to execute action';
    title.style.marginTop = '0';
    
    const targetInfo = document.createElement('p');
    targetInfo.id = 'confirmation-target';
    
    const reasoningInfo = document.createElement('p');
    reasoningInfo.id = 'confirmation-reasoning';
    reasoningInfo.style.fontStyle = 'italic';
    reasoningInfo.style.color = '#555';

    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'space-around';
    buttonContainer.style.marginTop = '20px';

    const allowBtn = document.createElement('button');
    allowBtn.textContent = 'Allow';
    allowBtn.id = 'confirmation-allow';
    Object.assign(allowBtn.style, {
        padding: '10px 20px',
        backgroundColor: '#28a745',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer'
    });

    const denyBtn = document.createElement('button');
    denyBtn.textContent = 'Deny';
    denyBtn.id = 'confirmation-deny';
    Object.assign(denyBtn.style, {
        padding: '10px 20px',
        backgroundColor: '#dc3545',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer'
    });

    buttonContainer.appendChild(allowBtn);
    buttonContainer.appendChild(denyBtn);

    dialog.appendChild(title);
    dialog.appendChild(targetInfo);
    dialog.appendChild(reasoningInfo);
    dialog.appendChild(buttonContainer);

    confirmationOverlay.appendChild(dialog);
    document.body.appendChild(confirmationOverlay);

    return confirmationOverlay;
}

/**
 * @param {Object} action — the action to confirm
 * @returns {Promise<boolean>} — true if user approved, false if denied/timed out
 */
export async function requestConfirmation(action) {
    const overlay = createOverlay();
    
    const targetEl = document.getElementById('confirmation-target');
    const reasoningEl = document.getElementById('confirmation-reasoning');
    
    targetEl.textContent = `Action: ${action.type}${action.target_element_id ? ` on target '${action.target_element_id}'` : ''}`;
    reasoningEl.textContent = action.reasoning_short || 'No reasoning provided.';
    
    overlay.style.display = 'flex';

    return new Promise((resolve) => {
        let timeoutId;

        const cleanup = (result) => {
            clearTimeout(timeoutId);
            overlay.style.display = 'none';
            document.getElementById('confirmation-allow').onclick = null;
            document.getElementById('confirmation-deny').onclick = null;
            resolve(result);
        };

        document.getElementById('confirmation-allow').onclick = () => cleanup(true);
        document.getElementById('confirmation-deny').onclick = () => cleanup(false);

        // Auto-dismiss after 30 seconds
        timeoutId = setTimeout(() => {
            console.warn('[ConfirmationUI] Timed out waiting for user confirmation.');
            cleanup(false);
        }, 30000);
    });
}

/**
 * Determine if an action needs confirmation based on risk_tier + local heuristics
 * @param {Object} action
 * @returns {boolean}
 */
export function requiresConfirmation(action) {
    if (action.risk_tier === RISK_TIERS.RISKY) return true;
    
    // Additional local heuristics
    if (action.type === 'click' && action.target_element_id) {
        let el = document.querySelector(`[data-element-id="${action.target_element_id}"]`);
        if (!el) el = document.getElementById(action.target_element_id);
        
        if (el) {
            if (el.type === 'submit' || (el.textContent && el.textContent.match(/pay|submit|delete|confirm/i))) {
                return true;
            }
        }
    }
    return false;
}
