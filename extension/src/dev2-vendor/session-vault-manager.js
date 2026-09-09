import { createTokenVault } from './token-vault.js';

const sessionVaults = new Map(); // session_id -> { vault, createdAt, lastAccessedAt }
const MAX_SESSIONS_THRESHOLD = 20;
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes default TTL

/**
 * Gets an existing token vault instance for a session_id, or creates a new one.
 * Automatically checks for expired session vaults and invalidates them if TTL exceeded.
 * @param {string} session_id - Unique identifier for the active task session.
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS] - Optional custom TTL in milliseconds.
 * @returns {object} Token vault instance.
 */
export function getVaultForSession(session_id, ttlMs = DEFAULT_SESSION_TTL_MS) {
  if (!session_id || typeof session_id !== 'string') {
    throw new Error('Invalid session_id provided to getVaultForSession');
  }

  const now = Date.now();

  if (sessionVaults.has(session_id)) {
    const record = sessionVaults.get(session_id);
    if (now - record.lastAccessedAt > ttlMs) {
      // Session has expired -> clean up
      endSession(session_id);
    } else {
      record.lastAccessedAt = now;
      return record.vault;
    }
  }

  if (sessionVaults.size >= MAX_SESSIONS_THRESHOLD) {
    console.warn(
      `[Privacy Warning] Active session vault count reached ${sessionVaults.size + 1} (> ${MAX_SESSIONS_THRESHOLD}). Potential session leak: ensure endSession() is called upon task completion/error.`
    );
  }

  const newVault = createTokenVault();
  sessionVaults.set(session_id, {
    vault: newVault,
    createdAt: now,
    lastAccessedAt: now
  });
  return newVault;
}

/**
 * Clears and removes the token vault instance for a completed, terminated, or expired session.
 * @param {string} session_id - Unique identifier for the task session to end.
 */
export function endSession(session_id) {
  if (!session_id || typeof session_id !== 'string') return;

  const record = sessionVaults.get(session_id);
  if (record) {
    if (record.vault && typeof record.vault.clear === 'function') {
      record.vault.clear();
    }
    sessionVaults.delete(session_id);
  }
}

/**
 * Sweeps and prunes all expired session vaults exceeding TTL.
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS]
 * @returns {number} Count of expired sessions cleaned.
 */
export function cleanExpiredSessions(ttlMs = DEFAULT_SESSION_TTL_MS) {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [id, record] of sessionVaults.entries()) {
    if (now - record.lastAccessedAt > ttlMs) {
      endSession(id);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

/**
 * Returns the current count of active session vaults.
 * @returns {number} Count of active task sessions.
 */
export function getActiveSessionCount() {
  return sessionVaults.size;
}
