import { createTokenVault } from './token-vault.js';

const sessionVaults = new Map();
const MAX_SESSIONS_THRESHOLD = 20;

/**
 * Gets an existing token vault instance for a session_id, or creates a new one.
 * @param {string} session_id - Unique identifier for the active task session.
 * @returns {object} Token vault instance.
 */
export function getVaultForSession(session_id) {
  if (!session_id || typeof session_id !== 'string') {
    throw new Error('Invalid session_id provided to getVaultForSession');
  }

  if (sessionVaults.has(session_id)) {
    return sessionVaults.get(session_id);
  }

  if (sessionVaults.size >= MAX_SESSIONS_THRESHOLD) {
    console.warn(
      `[Privacy Warning] Active session vault count reached ${sessionVaults.size + 1} (> ${MAX_SESSIONS_THRESHOLD}). Potential session leak: ensure endSession() is called upon task completion/error.`
    );
  }

  const newVault = createTokenVault();
  sessionVaults.set(session_id, newVault);
  return newVault;
}

/**
 * Clears and removes the token vault instance for a completed or terminated session.
 * @param {string} session_id - Unique identifier for the task session to end.
 */
export function endSession(session_id) {
  if (!session_id || typeof session_id !== 'string') return;

  const vault = sessionVaults.get(session_id);
  if (vault) {
    if (typeof vault.clear === 'function') {
      vault.clear();
    }
    sessionVaults.delete(session_id);
  }
}

/**
 * Returns the current count of active session vaults.
 * @returns {number} Count of active task sessions.
 */
export function getActiveSessionCount() {
  return sessionVaults.size;
}
