/**
 * Creates an in-memory token vault for session-scoped mapping between sensitive values and tokens.
 * @returns {{
 *   getOrCreateToken: (rawValue: string, sensitivityType: string) => string,
 *   resolveToken: (token: string) => string | null,
 *   hasToken: (token: string) => boolean,
 *   clear: () => void,
 *   getStats: () => { totalTokens: number, byType: Record<string, number> }
 * }}
 */
export function createTokenVault() {
  const forwardMap = new Map(); // rawValue -> token
  const reverseMap = new Map(); // token -> rawValue
  const typeCounters = new Map(); // sensitivityType -> current counter integer

  return {
    /**
     * Gets existing token for rawValue or creates a new indexed token [TYPE_N].
     * @param {string} rawValue
     * @param {string} sensitivityType
     * @returns {string}
     */
    getOrCreateToken(rawValue, sensitivityType) {
      if (typeof rawValue !== 'string' || !rawValue) {
        return '';
      }

      const typeKey = (sensitivityType || 'UNKNOWN').toUpperCase();

      if (forwardMap.has(rawValue)) {
        return forwardMap.get(rawValue);
      }

      const currentCount = (typeCounters.get(typeKey) || 0) + 1;
      typeCounters.set(typeKey, currentCount);

      const token = `[${typeKey}_${currentCount}]`;
      forwardMap.set(rawValue, token);
      reverseMap.set(token, rawValue);

      return token;
    },

    /**
     * Resolves token back to raw value.
     * @param {string} token
     * @returns {string | null}
     */
    resolveToken(token) {
      if (typeof token !== 'string' || !token) {
        return null;
      }
      return reverseMap.get(token) || null;
    },

    /**
     * Checks if token exists in the vault.
     * @param {string} token
     * @returns {boolean}
     */
    hasToken(token) {
      if (typeof token !== 'string' || !token) {
        return false;
      }
      return reverseMap.has(token);
    },

    /**
     * Clears all mapped tokens and resets state for session teardown.
     */
    clear() {
      forwardMap.clear();
      reverseMap.clear();
      typeCounters.clear();
    },

    /**
     * Returns count statistics without exposing raw values or tokens.
     * @returns {{ totalTokens: number, byType: Record<string, number> }}
     */
    getStats() {
      const byType = {};

      for (const [token] of reverseMap.entries()) {
        const match = token.match(/^\[([A-Z_]+)_\d+\]$/);
        const type = match ? match[1] : 'UNKNOWN';
        byType[type] = (byType[type] || 0) + 1;
      }

      return {
        totalTokens: reverseMap.size,
        byType
      };
    }
  };
}
