import { classifyElement } from './dom-heuristics.js';
import { detectPII } from './pii-patterns.js';

const TIER_1_TYPES = new Set(['PASSWORD', 'CARD_NUMBER', 'AADHAAR', 'OTP']);
const TIER_2_TYPES = new Set(['NAME', 'AMOUNT', 'EMAIL', 'PHONE', 'IFSC']);

/**
 * Returns numeric tier rank for a given sensitivity type.
 * Lower number = higher sensitivity (Tier 1 > Tier 2 > Tier 3).
 * @param {string} type
 * @returns {1|2|3}
 */
function getTierNumber(type) {
  if (!type || type === 'UNKNOWN') return 3;
  if (TIER_1_TYPES.has(type)) return 1;
  if (TIER_2_TYPES.has(type)) return 2;
  return 3;
}

/**
 * Formats a numeric value into a rough dollar amount range token string.
 * @param {number} val
 * @returns {string}
 */
function formatAmountRange(val) {
  if (isNaN(val) || val === null) return '[AMOUNT]';
  if (val < 10) return '[AMOUNT: $<10]';
  if (val >= 10 && val <= 50) return '[AMOUNT: $10-50]';
  if (val > 50 && val <= 100) return '[AMOUNT: $50-100]';
  if (val > 100 && val <= 500) return '[AMOUNT: $100-500]';
  if (val > 500 && val <= 1000) return '[AMOUNT: $500-1000]';
  return '[AMOUNT: $1000+]';
}

/**
 * Extracts a numeric amount value and formats it into a semantic token range.
 * @param {object} elementClassification
 * @param {Array} piiMatches
 * @returns {string}
 */
function getAmountToken(elementClassification, piiMatches) {
  let numberStr = null;

  if (Array.isArray(piiMatches)) {
    for (const m of piiMatches) {
      if (m && m.match) {
        const numMatch = m.match.match(/\d+(?:\.\d+)?/);
        if (numMatch) {
          numberStr = numMatch[0];
          break;
        }
      }
    }
  }

  if (!numberStr && elementClassification) {
    const textToSearch = [
      elementClassification.label_text,
      elementClassification.value
    ].filter(Boolean).join(' ');

    const numMatch = textToSearch.match(/\d+(?:\.\d+)?/);
    if (numMatch) {
      numberStr = numMatch[0];
    }
  }

  if (numberStr) {
    const val = parseFloat(numberStr);
    if (!isNaN(val)) {
      return formatAmountRange(val);
    }
  }

  return '[AMOUNT]';
}

/**
 * Classifies sensitivity into a 3-tier model combining DOM heuristics and PII pattern matches.
 * Optionally integrates with Token Vault to produce session-scoped indexed tokens.
 * @param {object} elementClassification - Output from classifyElement()
 * @param {Array} piiMatches - Output from detectPII()
 * @param {string|null} [rawValue=null] - Raw string value of the element if available
 * @param {object|null} [tokenVault=null] - Optional Token Vault instance
 * @returns {{ sensitivity_tier: 1|2|3, sensitivity_type: string, semantic_token: string|null }}
 */
export function classifySensitivity(elementClassification, piiMatches = [], rawValue = null, tokenVault = null) {
  const domType = (elementClassification && elementClassification.sensitivity_type && elementClassification.sensitivity_type !== 'UNKNOWN')
    ? elementClassification.sensitivity_type
    : null;

  const validPiiMatches = Array.isArray(piiMatches) ? piiMatches.filter(m => m && m.type) : [];

  let chosenType = null;

  if (validPiiMatches.length > 0) {
    // Pick highest sensitivity (lowest tier number) among PII matches
    let bestPiiType = validPiiMatches[0].type;
    let bestPiiTier = getTierNumber(bestPiiType);

    for (let i = 1; i < validPiiMatches.length; i++) {
      const t = validPiiMatches[i].type;
      const tier = getTierNumber(t);
      if (tier < bestPiiTier) {
        bestPiiType = t;
        bestPiiTier = tier;
      }
    }

    if (!domType) {
      chosenType = bestPiiType;
    } else if (domType === bestPiiType) {
      chosenType = domType;
    } else {
      const domTier = getTierNumber(domType);

      if (domTier < bestPiiTier) {
        chosenType = domType;
      } else if (bestPiiTier < domTier) {
        chosenType = bestPiiType;
      } else {
        chosenType = bestPiiType;
      }

      console.warn(
        `Sensitivity type mismatch: DOM heuristic detected "${domType}" (Tier ${domTier}) but PII pattern detected "${bestPiiType}" (Tier ${bestPiiTier}). Defaulting to higher sensitivity tier type: "${chosenType}".`
      );
    }
  } else if (domType) {
    chosenType = domType;
  }

  if (!chosenType || chosenType === 'UNKNOWN') {
    return {
      sensitivity_tier: 3,
      sensitivity_type: 'UNKNOWN',
      semantic_token: null
    };
  }

  const tier = getTierNumber(chosenType);

  let semantic_token = null;

  if (tier === 1 || tier === 2) {
    if (tokenVault && typeof tokenVault.getOrCreateToken === 'function' && rawValue !== null && rawValue !== undefined && rawValue !== '') {
      semantic_token = tokenVault.getOrCreateToken(rawValue, chosenType);
    } else {
      if (tier === 1) {
        semantic_token = `[${chosenType}]`;
      } else {
        semantic_token = chosenType === 'AMOUNT'
          ? getAmountToken(elementClassification, piiMatches)
          : `[${chosenType}]`;
      }
    }
  }

  return {
    sensitivity_tier: tier,
    sensitivity_type: chosenType,
    semantic_token
  };
}

/**
 * Confidence-gated wrapper around classifySensitivity that determines redaction action
 * and applies uncertainty markers to semantic tokens for low-confidence detections.
 * @param {object} elementClassification - Output from classifyElement()
 * @param {Array} piiMatches - Output from detectPII()
 * @param {number} confidence - Detection confidence score (0–1)
 * @param {string|null} [rawValue=null] - Raw string value of the element if available
 * @param {object|null} [tokenVault=null] - Optional Token Vault instance
 * @returns {{ sensitivity_tier: 1|2|3, sensitivity_type: string, semantic_token: string|null, confidence: number, action: 'hard_redact'|'soft_redact_flagged'|'no_redact' }}
 */
export function classifySensitivityWithConfidence(elementClassification, piiMatches, confidence, rawValue = null, tokenVault = null) {
  const base = classifySensitivity(elementClassification, piiMatches, rawValue, tokenVault);

  if (base.sensitivity_tier === 1) {
    let semantic_token = base.semantic_token;

    if (confidence < 0.75) {
      semantic_token = semantic_token
        ? semantic_token.replace(/\]$/, '?]')
        : null;
    }

    return {
      sensitivity_tier: base.sensitivity_tier,
      sensitivity_type: base.sensitivity_type,
      semantic_token,
      confidence,
      action: 'hard_redact'
    };
  }

  if (base.sensitivity_tier === 2) {
    if (confidence >= 0.6) {
      return {
        sensitivity_tier: base.sensitivity_tier,
        sensitivity_type: base.sensitivity_type,
        semantic_token: base.semantic_token,
        confidence,
        action: 'hard_redact'
      };
    }

    const semantic_token = base.semantic_token
      ? base.semantic_token.replace(/\]$/, ': uncertain]')
      : `[${base.sensitivity_type}: uncertain]`;

    return {
      sensitivity_tier: base.sensitivity_tier,
      sensitivity_type: base.sensitivity_type,
      semantic_token,
      confidence,
      action: 'soft_redact_flagged'
    };
  }

  return {
    sensitivity_tier: base.sensitivity_tier,
    sensitivity_type: base.sensitivity_type,
    semantic_token: base.semantic_token,
    confidence,
    action: 'no_redact'
  };
}

/**
 * Returns a badge color string based on confidence score for UI rendering.
 * @param {number} confidence - Detection confidence score (0–1)
 * @returns {'green'|'yellow'|'red'}
 */
export function getConfidenceBadgeColor(confidence) {
  if (confidence >= 0.85) return 'green';
  if (confidence >= 0.6) return 'yellow';
  return 'red';
}

/**
 * Classifies the risk tier of an agent action.
 * Action risk tier MUST be string ("safe" | "risky"), NEVER numeric 1, 2, 3.
 * @param {object} action - Action payload { type: string, target_element_id?: string, value?: string, risk_tier?: string|number, sensitivity_tier?: number }
 * @returns {'safe'|'risky'}
 */
export function classifyActionRisk(action) {
  if (!action || typeof action !== 'object') {
    return 'safe';
  }

  if (action.risk_tier === 'risky' || action.risk_tier === 'safe') {
    return action.risk_tier;
  }

  if (typeof action.risk_tier === 'number') {
    return (action.risk_tier === 1 || action.risk_tier === 2) ? 'risky' : 'safe';
  }

  if (action.sensitivity_tier === 1 || action.sensitivity_tier === 2) {
    return 'risky';
  }

  const target = String(action.target_element_id || '').toLowerCase();
  const val = String(action.value || '');

  if (/card|pwd|password|email|phone|ssn|aadhaar|otp|cvv|credit/i.test(target)) {
    return 'risky';
  }

  if (/\[(CARD_NUMBER|PASSWORD|AADHAAR|OTP|EMAIL|PHONE|NAME|AMOUNT|IFSC)(?:_\d+)?(?:\?|: [^\]]+)?\]/.test(val)) {
    return 'risky';
  }

  return 'safe';
}

