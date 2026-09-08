import { classifyElement, getElementId } from './dom-heuristics.js';
import { detectPII } from './pii-patterns.js';
import { classifySensitivity } from './sensitivity-tiers.js';
import { redactImage, canvasToBase64 } from './redaction-renderer.js';

/**
 * Top-level orchestrator function to process page elements and source canvas/image for redaction.
 * @param {HTMLElement[]} elements - List of DOM elements to classify and inspect.
 * @param {HTMLCanvasElement | HTMLImageElement} sourceCanvasOrImage - Canvas or image element to redact.
 * @param {object} tokenVault - Session-scoped Token Vault instance (REQUIRED).
 * @returns {{
 *   dom_summary: {
 *     url: string,
 *     elements: Array<{
 *       element_id: string,
 *       tag: string,
 *       role: string | null,
 *       label_text: string | null,
 *       is_sensitive: boolean,
 *       sensitivity_tier: 1 | 2 | 3,
 *       sensitivity_type: string,
 *       semantic_token: string | null,
 *       has_stable_token: boolean,
 *       bounding_box: {x: number, y: number, w: number, h: number}
 *     }>
 *   },
 *   redacted_image_base64: string,
 *   detection_confidence_notes: Array<{element_id: string, confidence: number, method: 'dom_heuristic' | 'vision_model' | 'ocr_regex'}>
 * }}
 */
export function processPageForRedaction(elements = [], sourceCanvasOrImage, tokenVault) {
  const currentUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';

  const summaryElements = [];
  const confidenceNotes = [];
  const sensitiveRegions = [];
  const sensitiveRawValues = [];

  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (!el) continue;

      const element_id = getElementId(el);
      const elementClassification = classifyElement(el);

      const rect = typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect()
        : { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };

      const bounding_box = {
        x: Math.round(rect.x || rect.left || 0),
        y: Math.round(rect.y || rect.top || 0),
        w: Math.round(rect.width || 0),
        h: Math.round(rect.height || 0)
      };

      // 1. Extract rawValue by priority order
      let rawValue = null;
      if (el.value !== undefined && el.value !== null && String(el.value).trim() !== '') {
        rawValue = el.value;
      } else if (el.innerText && el.innerText.trim() !== '') {
        rawValue = el.innerText.trim();
      } else {
        rawValue = null;
      }

      const textToScan = rawValue || el.textContent || '';
      const piiMatches = detectPII(textToScan);

      // 2. Classify sensitivity passing rawValue and tokenVault
      const sensitivity = classifySensitivity(elementClassification, piiMatches, rawValue, tokenVault);
      const { sensitivity_tier, sensitivity_type, semantic_token } = sensitivity;
      const is_sensitive = sensitivity_tier !== 3;

      // 3. Verify token presence in vault
      const has_stable_token = Boolean(
        semantic_token &&
        tokenVault &&
        typeof tokenVault.hasToken === 'function' &&
        tokenVault.hasToken(semantic_token)
      );

      summaryElements.push({
        element_id,
        tag: elementClassification.tag,
        role: elementClassification.role,
        label_text: elementClassification.label_text,
        is_sensitive,
        sensitivity_tier,
        sensitivity_type,
        semantic_token,
        has_stable_token,
        bounding_box
      });

      let confidence = 0.92;
      let method = 'dom_heuristic';

      if (elementClassification && elementClassification.sensitivity_type !== 'UNKNOWN') {
        confidence = 0.92;
        method = 'dom_heuristic';
      } else if (piiMatches && piiMatches.length > 0) {
        confidence = 0.6;
        method = 'ocr_regex';
      }

      confidenceNotes.push({
        element_id,
        confidence,
        method
      });

      if (sensitivity_tier === 1 || sensitivity_tier === 2) {
        sensitiveRegions.push({
          bounding_box,
          sensitivity_tier
        });

        if (rawValue && String(rawValue).trim()) {
          sensitiveRawValues.push(String(rawValue).trim());
        }
        for (const m of piiMatches) {
          if (m && m.match && m.match.trim()) {
            sensitiveRawValues.push(m.match.trim());
          }
        }
      }
    }
  }

  const redactedCanvas = redactImage(sourceCanvasOrImage, sensitiveRegions);
  const redacted_image_base64 = canvasToBase64(redactedCanvas);

  const output = {
    dom_summary: {
      url: currentUrl,
      elements: summaryElements
    },
    redacted_image_base64,
    detection_confidence_notes: confidenceNotes
  };

  // Top-level Recursive Guard Assertion: confirm no sensitive raw values leak into output object tree
  function walkAndAssert(node, path) {
    if (node === null || node === undefined) return;
    if (path === 'redacted_image_base64') return;

    if (typeof node === 'string') {
      for (const rawVal of sensitiveRawValues) {
        if (!rawVal || rawVal.length < 3) continue;
        if (node.includes(rawVal) && !node.startsWith('[')) {
          throw new Error(`Privacy Assertion Violated: Raw sensitive value "${rawVal}" found in output object at "${path}"`);
        }
      }
      return;
    }

    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkAndAssert(node[i], `${path}[${i}]`);
      }
      return;
    }

    for (const key of Object.keys(node)) {
      const childPath = path ? `${path}.${key}` : key;
      walkAndAssert(node[key], childPath);
    }
  }

  walkAndAssert(output, '');

  return output;
}
