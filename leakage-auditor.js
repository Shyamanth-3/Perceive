const SEMANTIC_TOKEN_PATTERN = /^\[[A-Z0-9_]+(?:\?|: [^\]]+)?\]$/;
const SENSITIVE_KEY_PATTERN = /password|pwd|secret|credit_card|cvv|ssn|aadhaar|otp/i;

/**
 * Recursively walks an object tree and invokes a callback for every string value found.
 * @param {*} node - Current node in the object tree.
 * @param {string} path - Dot-notation path to the current node.
 * @param {function} callback - Called with (stringValue, path) for each string leaf.
 * @param {Set} seen - Tracks visited references to avoid circular loops.
 */
function walkStrings(node, path, callback, seen) {
  if (node === null || node === undefined) return;

  if (seen.has(node)) return;

  if (typeof node === 'string') {
    callback(node, path);
    return;
  }

  if (typeof node !== 'object') return;

  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkStrings(node[i], path + '[' + i + ']', callback, seen);
    }
    return;
  }

  const keys = Object.keys(node);
  for (const key of keys) {
    const childPath = path ? path + '.' + key : key;
    walkStrings(node[key], childPath, callback, seen);
  }
}

/**
 * Scans an outgoing payload for any raw PII values or sensitive text that leaked through redaction.
 * @param {object} payload - The full payload object to audit.
 * @param {function} piiDetectFn - PII detection function with signature (text: string) => Array<{type: string, match: string}>
 * @returns {{ passed: boolean, violations: Array<{path: string, reason: string, matched_type: string}> }}
 */
export function auditPayload(payload, piiDetectFn) {
  const violations = [];

  if (!payload || typeof payload !== 'object') {
    return { passed: true, violations };
  }

  if (typeof piiDetectFn !== 'function') {
    return { passed: true, violations };
  }

  const seen = new Set();

  walkStrings(payload, '', function onString(value, path) {
    // Skip redacted_image_base64 — it's expected binary/opaque data.
    // But flag a warning if it looks suspiciously short or malformed.
    if (path === 'redacted_image_base64') {
      if (typeof value === 'string' && value.length < 100) {
        violations.push({
          path,
          reason: 'redacted_image_base64 is suspiciously short or malformed',
          matched_type: 'IMAGE_DATA_WARNING'
        });
      }
      return;
    }

    // Skip values that are semantic token placeholders
    if (SEMANTIC_TOKEN_PATTERN.test(value)) {
      return;
    }

    // 1. Check PII detection regex matches
    const matches = piiDetectFn(value);
    if (Array.isArray(matches) && matches.length > 0) {
      for (const match of matches) {
        violations.push({
          path,
          reason: 'raw PII value found outside semantic token',
          matched_type: match.type || 'UNKNOWN'
        });
      }
    }

    // 2. Check for unredacted passwords or secrets in sensitive fields/keys
    if (SENSITIVE_KEY_PATTERN.test(path) && value && !SEMANTIC_TOKEN_PATTERN.test(value)) {
      violations.push({
        path,
        reason: 'unredacted password or secret string found in sensitive field',
        matched_type: 'PASSWORD'
      });
    }
  }, seen);

  return {
    passed: violations.length === 0,
    violations
  };
}

/**
 * Hard gate that throws a descriptive Error if the payload contains leaked PII.
 * Intended to be called immediately before any fetch() call in the transport module.
 * @param {object} payload - The full payload object to audit.
 * @param {function} piiDetectFn - PII detection function.
 * @throws {Error} If any PII violations are detected.
 */
export function assertSafeToSend(payload, piiDetectFn) {
  const result = auditPayload(payload, piiDetectFn);

  if (!result.passed) {
    const details = result.violations
      .map(function (v) {
        return '  - [' + v.matched_type + '] at "' + v.path + '": ' + v.reason;
      })
      .join('\n');

    throw new Error(
      'Payload safety audit failed with ' + result.violations.length +
      ' violation(s). Blocking network request.\n' + details
    );
  }
}

/**
 * Higher-order transport wrapper enforcing fail-closed security.
 * Guarantees assertSafeToSend runs on the final payload immediately before transportFn is called.
 * If audit fails, transportFn is ZERO-invoked and an Error is thrown.
 *
 * @param {function} transportFn - Network send function with signature (payload) => Promise<any> | any
 * @param {function} piiDetectFn - PII detection function
 * @returns {function(object): Promise<any> | any} Wrapped transport function
 */
export function createSecureTransport(transportFn, piiDetectFn) {
  if (typeof transportFn !== 'function') {
    throw new Error('createSecureTransport requires a valid transport function.');
  }

  return function sendSecurePayload(payload) {
    // Hard gate assertion on the FINAL assembled payload immediately before transport
    assertSafeToSend(payload, piiDetectFn);
    return transportFn(payload);
  };
}
