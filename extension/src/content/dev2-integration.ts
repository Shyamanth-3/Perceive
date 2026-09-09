/**
 * Dev 1 → Dev 2 integration adapter.
 *
 * ARCHITECTURE DECISION (documented, not silent — per integration instructions):
 * Dev 2's real code (`dev2-vendor/`, unmodified, vendored verbatim from
 * origin/main `dev2/`) is split into two kinds of function:
 *   1. Pure data transforms (`detectPII`, `classifySensitivity`,
 *      `getOrCreateToken`, `auditPayload`) — take/return plain objects,
 *      no DOM dependency at all.
 *   2. `classifyElement(el)` / `getNearbyLabelText(el)` — call live DOM
 *      methods (`el.getAttribute`, `el.closest`, `el.labels`) directly on
 *      an `HTMLElement`.
 *
 * Dev 1's actual output crosses a `chrome.runtime` message boundary as a
 * serialized `DomSnapshot` (plain JSON) — by the time anything downstream
 * of the content script sees it, there is no live DOM to hand `(2)`.
 *
 * Chosen option (of the three offered): **C — a content-side Dev 2
 * preprocessing step that runs (2)'s *equivalent logic* against Dev 1's own
 * already-serialized `CapturedElement` tree**, right here in the content
 * script, before anything crosses the message boundary. This is NOT a fake
 * `HTMLElement` reconstruction — `classifyFromCapturedElement` below reads
 * the same underlying signals `classifyElement` does (tag, type,
 * autocomplete, placeholder, resolved label text), just from Dev 1's
 * already-captured serialized fields instead of live attribute reads. Every
 * *pure* Dev 2 function (`detectPII`, `classifySensitivity`, token vault) is
 * called completely unmodified.
 *
 * Why not option A (Dev 2 runs directly on the live DOM in the content
 * script, before Dev 1 serializes)? Because Dev 1's own privacy gate
 * (`shared/capture.ts`) already decides, per element, what `value`/`text`
 * may exist at all (password/file/hidden/contenteditable excluded) — running
 * Dev 2's classifier on raw live elements would require re-deriving that
 * same gate a second time and risks the two gates drifting apart. Running
 * Dev 2 against Dev 1's *already-gated* serialized output means Dev 2 can
 * only ever see what Dev 1 already decided was safe to expose — a stronger
 * privacy property, and the reason this option was preferred.
 *
 * What Dev 2's real `redaction-engine.js`/`redaction-renderer.js` (the
 * canvas box-drawing over the screenshot) needs — real pixels — is NOT
 * available here (the content script never sees the screenshot; only the
 * Service Worker does, after `captureVisibleTab`). That half of Dev 2's
 * pipeline is wired separately, in the offscreen document (which already
 * has `OffscreenCanvas` for Phase 4 vision) — see `dev2-redaction.ts`.
 */

import type { CapturedElement, DomSnapshot } from "../shared/capture";
import { detectPII } from "../dev2-vendor/pii-patterns.js";
import { classifySensitivity } from "../dev2-vendor/sensitivity-tiers.js";

// ---- classifyElement equivalent, operating on Dev 1's serialized data ----

export interface ElementClassification {
  tag: string;
  role: string | null;
  label_text: string | null;
  is_sensitive: boolean;
  sensitivity_type: string | null;
}

interface TreeNode {
  el: CapturedElement;
  parent: TreeNode | null;
  siblings: CapturedElement[];
  indexInSiblings: number;
}

/** Flatten Dev 1's tree into a list of nodes with parent/sibling context —
 * `classifyElement`'s label resolution needs ancestor/sibling info that a
 * bare recursive walk would lose. */
function flattenWithContext(
  elements: readonly CapturedElement[],
  parent: TreeNode | null = null
): TreeNode[] {
  const out: TreeNode[] = [];
  elements.forEach((el, i) => {
    const node: TreeNode = { el, parent, siblings: elements as CapturedElement[], indexInSiblings: i };
    out.push(node);
    out.push(...flattenWithContext(el.children, node));
  });
  return out;
}

/** Search the whole flattened tree for a `<label for="id">` targeting `id`. */
function findLabelFor(id: string, allNodes: readonly TreeNode[]): string | null {
  if (!id) return null;
  for (const { el } of allNodes) {
    if (el.tag.toLowerCase() === "label" && el.attrs.for === id && el.text) {
      return el.text;
    }
  }
  return null;
}

/** Equivalent of `getNearbyLabelText(el)` (dom-heuristics.js) over serialized
 * data: label[for], ancestor <label>, aria-label, placeholder, previous
 * sibling text — same priority order, same signals, no live DOM needed. */
function resolveLabelText(node: TreeNode, allNodes: readonly TreeNode[]): string | null {
  const { el } = node;
  const forId = el.attrs.id ?? el.id;
  const byFor = findLabelFor(forId, allNodes);
  if (byFor) return byFor;

  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.el.tag.toLowerCase() === "label" && ancestor.el.text) return ancestor.el.text;
    ancestor = ancestor.parent;
  }

  if (el.aria.label) return el.aria.label;
  if (el.attrs.placeholder) return el.attrs.placeholder;

  for (let i = node.indexInSiblings - 1; i >= 0; i--) {
    const sib = node.siblings[i];
    if (sib.text) return sib.text;
  }

  return null;
}

/** Serialized-data equivalent of `classifyElement(el)` — same priority
 * order (button exclusion → PASSWORD → CARD_NUMBER → EMAIL → AMOUNT →
 * PHONE → NAME → UNKNOWN), reading Dev 1's already-captured fields instead
 * of live attributes. */
export function classifyFromCapturedElement(
  node: TreeNode,
  allNodes: readonly TreeNode[]
): ElementClassification {
  const { el } = node;
  const tag = el.tag.toLowerCase();
  const role = el.role;
  const typeAttr = (el.type ?? "").toLowerCase();
  const autocompleteAttr = (el.attrs.autocomplete ?? "").toLowerCase();
  const placeholderAttr = (el.attrs.placeholder ?? "").toLowerCase();

  if (tag === "button" || typeAttr === "submit" || typeAttr === "button" || role === "button") {
    return { tag: "button", role: "button", label_text: el.text, is_sensitive: false, sensitivity_type: null };
  }

  const label_text = resolveLabelText(node, allNodes);
  const elText = (el.text ?? "").trim();

  if (typeAttr === "password") {
    return { tag, role, label_text, is_sensitive: true, sensitivity_type: "PASSWORD" };
  }
  if (autocompleteAttr.includes("cc-number")) {
    return { tag, role, label_text, is_sensitive: true, sensitivity_type: "CARD_NUMBER" };
  }
  if (autocompleteAttr.includes("email") || typeAttr === "email") {
    return { tag, role, label_text, is_sensitive: true, sensitivity_type: "EMAIL" };
  }
  if (
    (label_text && /amount|price|total/i.test(label_text)) ||
    (placeholderAttr && /amount|price|total/i.test(placeholderAttr)) ||
    (elText && /amount|price|total|\$\d/i.test(elText))
  ) {
    return { tag, role, label_text: label_text || elText || null, is_sensitive: true, sensitivity_type: "AMOUNT" };
  }
  if (
    autocompleteAttr.includes("tel") ||
    typeAttr === "tel" ||
    (label_text && /phone|mobile|contact number/i.test(label_text)) ||
    (placeholderAttr && /phone|mobile|contact number/i.test(placeholderAttr))
  ) {
    return { tag, role, label_text, is_sensitive: true, sensitivity_type: "PHONE" };
  }
  if (autocompleteAttr.includes("name") || (label_text && /name/i.test(label_text))) {
    return { tag, role, label_text, is_sensitive: true, sensitivity_type: "NAME" };
  }
  return { tag, role, label_text, is_sensitive: false, sensitivity_type: "UNKNOWN" };
}

// ---- dom_summary assembly (plan §4.1 shape) ----

export interface Dev2DomSummaryElement {
  element_id: string;
  tag: string;
  role: string | null;
  label_text: string | null;
  is_sensitive: boolean;
  sensitivity_tier: 1 | 2 | 3;
  sensitivity_type: string;
  semantic_token: string | null;
  bounding_box: { x: number; y: number; w: number; h: number } | null;
}

export interface Dev2ClassificationResult {
  dom_summary: { url: string; elements: Dev2DomSummaryElement[] };
  detection_confidence_notes: { element_id: string; confidence: number; method: "dom_heuristic" }[];
}

/** Minimal vault interface — real `token-vault.js`'s `createTokenVault()`
 * return shape (or `session-vault-manager.js`'s `getVaultForSession`), used
 * exactly as Dev 2 built it, never reimplemented. */
export interface TokenVaultLike {
  getOrCreateToken(rawValue: string, sensitivityType: string): string;
}

/**
 * Run Dev 2's real classification pipeline (unmodified `detectPII` +
 * `classifySensitivity` + the caller's real token vault) over Dev 1's
 * serialized capture. Only ever sees what Dev 1's own privacy gate already
 * decided to expose (password/file/hidden/contenteditable values are
 * already `null` in `DomSnapshot` before this function ever runs).
 */
export function buildDev2DomSummary(dom: DomSnapshot, url: string, tokenVault: TokenVaultLike | null): Dev2ClassificationResult {
  const allNodes = flattenWithContext(dom.elements);
  const elements: Dev2DomSummaryElement[] = [];
  const notes: Dev2ClassificationResult["detection_confidence_notes"] = [];

  for (const node of allNodes) {
    const { el } = node;
    const classification = classifyFromCapturedElement(node, allNodes);
    const rawValue = el.value ?? el.text ?? null;
    const piiMatches = rawValue ? detectPII(rawValue) : [];
    const { sensitivity_tier, sensitivity_type, semantic_token } = classifySensitivity(
      classification,
      piiMatches,
      rawValue,
      tokenVault
    );

    const is_sensitive = sensitivity_tier === 1 || sensitivity_tier === 2;
    elements.push({
      element_id: el.id,
      tag: classification.tag,
      role: classification.role,
      label_text: classification.label_text,
      is_sensitive,
      sensitivity_tier,
      sensitivity_type,
      semantic_token,
      bounding_box: el.rect ? { x: Math.round(el.rect.x), y: Math.round(el.rect.y), w: Math.round(el.rect.width), h: Math.round(el.rect.height) } : null,
    });

    if (is_sensitive) {
      notes.push({ element_id: el.id, confidence: 1, method: "dom_heuristic" });
    }
  }

  return { dom_summary: { url, elements }, detection_confidence_notes: notes };
}
