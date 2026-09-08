import { validateActionResponse } from '../shared/schemas.js';

const BACKEND_URL = 'http://localhost:8000';
const ANALYZE_ENDPOINT = '/analyze';
const TIMEOUT_MS = 15000;

class PayloadLeakageError extends Error {
    constructor(message) {
        super(message);
        this.name = "PayloadLeakageError";
    }
}

class TransportError extends Error {
    constructor(message) {
        super(message);
        this.name = "TransportError";
    }
}

/**
 * Runs a leakage scanner over the serialized JSON string.
 */
function assertNoLeakage(jsonString) {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phoneRegex = /\b\d{10}\b/;
    const cardRegex = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;
    const aadhaarRegex = /\b\d{4}\s?\d{4}\s?\d{4}\b/;

    if (emailRegex.test(jsonString)) throw new PayloadLeakageError("Email leaked in payload");
    if (phoneRegex.test(jsonString)) throw new PayloadLeakageError("Phone number leaked in payload");
    if (cardRegex.test(jsonString)) throw new PayloadLeakageError("Card number leaked in payload");
    if (aadhaarRegex.test(jsonString)) throw new PayloadLeakageError("Aadhaar number leaked in payload");
    
    // Additional checks can be added here (e.g. iterating parsed payload values checking for tokens)
}

/**
 * Sends sanitized payload to backend and returns action response.
 */
export async function sendToBackend(payload) {
    const jsonString = JSON.stringify(payload);
    
    // Hard abort if leakage detected
    assertNoLeakage(jsonString);   

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(`${BACKEND_URL}${ANALYZE_ENDPOINT}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: jsonString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new TransportError(`Server returned ${response.status}`);
        }

        const actionResponse = await response.json();
        
        // Schema validation
        validateActionResponse(actionResponse);  
        
        return actionResponse;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new TransportError('Request timed out');
        }
        throw err;
    }
}

// Background script message listener for passing messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SEND_PAYLOAD') {
        sendToBackend(message.payload)
            .then(action => {
                sendResponse({ success: true, action });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message, errorType: error.name });
            });
        return true; // Keep message channel open for async response
    }
});
