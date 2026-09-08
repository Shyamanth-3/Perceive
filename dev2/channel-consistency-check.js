/**
 * Channel Consistency Check Module
 * 
 * Independent verification layer comparing STRUCTURAL redaction (dom_summary.elements)
 * with VISUAL redaction (redactedRegions) before network dispatch.
 */

/**
 * Checks whether structural redaction requirements match actual visual redaction regions.
 *
 * @param {object} payload - Payload containing dom_summary.elements
 * @param {Array<{element_id: string, bounding_box: object}>} redactedRegions - Regions visually redacted
 * @returns {{ consistent: boolean, mismatches: Array<{element_id: string, issue: string}> }}
 */
export function checkChannelConsistency(payload, redactedRegions) {
  const mismatches = [];

  const elements = (payload && payload.dom_summary && Array.isArray(payload.dom_summary.elements))
    ? payload.dom_summary.elements
    : [];

  const regions = Array.isArray(redactedRegions) ? redactedRegions : [];

  // 1. Set of element_ids that SHOULD be redacted
  const shouldBeRedacted = new Set();
  for (const el of elements) {
    if (el && el.is_sensitive === true && el.semantic_token !== null) {
      if (el.element_id) {
        shouldBeRedacted.add(el.element_id);
      }
    }
  }

  // 2. Set of element_ids that WERE ACTUALLY visually redacted
  const actuallyRedacted = new Set();
  for (const region of regions) {
    if (region && region.element_id) {
      actuallyRedacted.add(region.element_id);
    }
  }

  // 3. Compare sets
  // Structural claimed but visual missing
  for (const id of shouldBeRedacted) {
    if (!actuallyRedacted.has(id)) {
      mismatches.push({
        element_id: id,
        issue: 'structural redaction claimed but visual redaction missing'
      });
    }
  }

  // Visual present but structural missing/not sensitive
  for (const id of actuallyRedacted) {
    if (!shouldBeRedacted.has(id)) {
      mismatches.push({
        element_id: id,
        issue: 'visual redaction present but structural summary shows no sensitivity — possible over-redaction or stale data'
      });
    }
  }

  // 4. Consistent if no mismatches
  return {
    consistent: mismatches.length === 0,
    mismatches
  };
}

/**
 * Hard gate that throws a descriptive Error if visual and structural redactions do not agree.
 *
 * @param {object} payload - Payload containing dom_summary.elements
 * @param {Array<{element_id: string, bounding_box: object}>} redactedRegions - Regions visually redacted
 * @throws {Error} If channel consistency check fails
 */
export function assertChannelsConsistent(payload, redactedRegions) {
  const result = checkChannelConsistency(payload, redactedRegions);

  if (!result.consistent) {
    const details = result.mismatches
      .map(m => `  - [${m.element_id}]: ${m.issue}`)
      .join('\n');

    throw new Error(
      `Channel consistency check failed with ${result.mismatches.length} mismatch(es):\n${details}`
    );
  }
}
