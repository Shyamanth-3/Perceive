/**
 * Raw structural DOM capture (Dev 1, Phase 2 §2.1, plan §4.2).
 *
 * Dev 1 captures STRUCTURE — tag, type, curated attributes, bounding rect,
 * visibility, disabled state, semantic relationships, ARIA references, and
 * *limited* visible text. Dev 1 does NOT classify anything as sensitive; it
 * only applies the hard exclusion policy so password/file/hidden values and
 * arbitrary user-entered text never leave the page (those values are Dev 2's
 * input, not Dev 1's).
 *
 * The capture walker operates on a minimal structural view (`DomElementLike`)
 * that both a real `Element` (adapted in the content script) and a plain fake
 * (used by Jest) satisfy, so privacy logic is fully unit-testable.
 */

import type { CaptureMetadata } from "./types";
import {
  STRUCTURAL_TEXT_LIMIT,
  USER_VALUE_LIMIT,
  PERCEIVE_UI_MARKER_ATTR,
} from "./constants";

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportLike {
  width: number;
  height: number;
}

export interface ScrollLike {
  x: number;
  y: number;
}

/** Minimal structural element view. */
export interface DomElementLike {
  tagName: string;
  children: readonly DomElementLike[];
  getAttribute(name: string): string | null;
  getBoundingClientRect(): RectLike | null;
  textContent: string | null;
  isContentEditable?: boolean;
  disabled?: boolean;
  /** Form control value (inputs/textarea/select); undefined when not a control. */
  value?: string | null;
  type?: string;
}

export interface CapturedElement {
  /** Stable structural identifier (ancestor index path). */
  id: string;
  tag: string;
  /** Form control type attribute, else null. */
  type: string | null;
  role: string | null;
  aria: {
    label: string | null;
    labelledby: string | null;
    describedby: string | null;
    hidden: boolean | null;
    live: string | null;
    expanded: boolean | null;
  };
  /** Curated attributes (never includes value-bearing attributes). */
  attrs: Record<string, string>;
  /** Bounding rect in CSS px relative to layout viewport. */
  rect: RectLike | null;
  visible: boolean;
  disabled: boolean;
  /** Structural visible text (leaf nodes only), ≤ 200 chars. */
  text: string | null;
  /** User-entered value where allowed, ≤ 100 chars; null when excluded. */
  value: string | null;
  children: CapturedElement[];
}

export interface DomSnapshot {
  requestId: string;
  /** Date.now() when DOM capture began in the content script. */
  domCapturedAt: number;
  /** Viewport at capture time (CSS px). */
  viewport: ViewportLike;
  devicePixelRatio: number;
  scroll: ScrollLike;
  /** Root element tree (documentElement/body adapted) + subtree. */
  elements: CapturedElement[];
  elementCount: number;
  truncated: boolean;
}

/** Hard cap on captured nodes to bound payload size. */
export const MAX_CAPTURE_ELEMENTS = 2000;

const VALUE_TYPES = new Set(["text", "email", "tel", "number", "search", "url"]);

const HARD_EXCLUDED_INPUT_TYPES = new Set(["password", "file", "hidden"]);

const CONTENTEDITABLE_ATTR = "contenteditable";

/** ARIA attributes we consider structural (safe, reference-free IDs only). */
const ARIA_ATTRS = [
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "aria-live",
  "aria-expanded",
];

const ATTR_ALLOWLIST = [
  "id",
  "class",
  "name",
  "placeholder",
  "autocomplete",
  "inputmode",
  "lang",
  "title",
  // "for" (Dev 1→Dev 2 integration): required to resolve <label for="id">
  // text against the target input without live DOM access — a purely
  // structural relationship attribute (element id references), never
  // value-bearing, so it fits the existing allow-list's privacy contract.
  "for",
  ...ARIA_ATTRS,
];

export function attr(el: DomElementLike, name: string): string | null {
  try {
    return el.getAttribute(name);
  } catch {
    return null;
  }
}

// ---- Truncation (plan §4.2) ----

export function truncateStructuralText(text: string): string {
  return text.length > STRUCTURAL_TEXT_LIMIT ? text.slice(0, STRUCTURAL_TEXT_LIMIT) : text;
}

export function truncateUserValue(value: string): string {
  return value.length > USER_VALUE_LIMIT ? value.slice(0, USER_VALUE_LIMIT) : value;
}

export function isFormControl(tag: string): boolean {
  const t = tag.toUpperCase();
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

// ---- Privacy gate (plan §4.2 C) ----

export interface PrivacyDecision {
  /** Suppress the user-entered value entirely. */
  suppressValue: boolean;
  /** Suppress visible text entirely. */
  suppressText: boolean;
  reason: "password" | "file" | "hidden" | "editable" | "contenteditable" | null;
}

/** Decide the hard-exclusion policy for one element. */
export function decideExclusion(el: DomElementLike): PrivacyDecision {
  const ed = isEditable(el);
  if (ed) return { suppressValue: true, suppressText: true, reason: "contenteditable" };

  const tag = (el.tagName || "").toUpperCase();
  const type = (el.type ?? "").toLowerCase();
  if (tag === "INPUT") {
    if (type === "password") return { suppressValue: true, suppressText: false, reason: "password" };
    if (type === "file") return { suppressValue: true, suppressText: false, reason: "file" };
    if (type === "hidden") return { suppressValue: true, suppressText: false, reason: "hidden" };
  }
  return { suppressValue: false, suppressText: false, reason: null };
}

function isEditable(el: DomElementLike): boolean {
  if (el.isContentEditable) return true;
  const ce = attr(el, CONTENTEDITABLE_ATTR);
  return ce === "true" || ce === "";
}

export function isEditableSafe(el: DomElementLike): boolean {
  return isEditable(el);
}

/** Whether a form control's value may be captured (plan §4.2 B). */
export function isValueCapturable(el: DomElementLike): boolean {
  const tag = (el.tagName || "").toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  if (isEditable(el)) return false;
  if (tag === "INPUT") {
    const type = (el.type ?? "text").toLowerCase();
    if (HARD_EXCLUDED_INPUT_TYPES.has(type)) return false;
    return VALUE_TYPES.has(type);
  }
  return true; // TEXTAREA / SELECT
}

export function captureUserValue(el: DomElementLike): string | null {
  if (!isValueCapturable(el)) return null;
  const v = el.value;
  if (v == null) return null;
  if (Array.isArray(v)) return null;
  const s = String(v);
  return s.length === 0 ? null : truncateUserValue(s);
}

export function captureStructuralText(el: DomElementLike): string | null {
  // Only leaf nodes (no element children) yield structural text — we never
  // stringify an ancestor's combined text (no document.body.innerText dumps).
  if (el.children.length > 0) return null;
  if (isEditable(el)) return null;
  const raw = el.textContent;
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : truncateStructuralText(s);
}

export function captureAttributes(el: DomElementLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ATTR_ALLOWLIST) {
    const v = attr(el, name);
    if (v != null) out[name] = v;
  }
  return out;
}

export function isElementVisible(el: DomElementLike, viewport: ViewportLike): boolean {
  const r = rectOf(el);
  if (!r) return false;
  if (r.width <= 0 || r.height <= 0) return false;
  const withinX = r.x < viewport.width && r.x + r.width > 0;
  const withinY = r.y < viewport.height && r.y + r.height > 0;
  return withinX && withinY;
}

function rectOf(el: DomElementLike): RectLike | null {
  try {
    const r = el.getBoundingClientRect();
    if (!r) return null;
    if (![r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v))) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch {
    return null;
  }
}

// ---- Walker ----

export function buildStableId(indexPath: readonly number[]): string {
  return indexPath.join(".");
}

interface WalkState {
  max: number;
  count: number;
  truncated: boolean;
}

export function serializeElement(
  el: DomElementLike,
  indexPath: readonly number[],
  viewport: ViewportLike,
  walker: WalkState
): CapturedElement | null {
  if (walker.count >= walker.max) {
    walker.truncated = true;
    return null;
  }
  walker.count += 1;

  const tag = (el.tagName || "").toUpperCase();
  const rect = rectOf(el);
  const aria = {
    label: attr(el, "aria-label"),
    labelledby: attr(el, "aria-labelledby"),
    describedby: attr(el, "aria-describedby"),
    hidden: attr(el, "aria-hidden") === "true" ? true : null,
    live: attr(el, "aria-live"),
    expanded: attr(el, "aria-expanded") === "true" ? true : null,
  };

  const node: CapturedElement = {
    id: buildStableId(indexPath),
    tag,
    type: tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ? (el.type ?? null) : null,
    role: attr(el, "role"),
    aria,
    attrs: captureAttributes(el),
    rect,
    visible: isElementVisible(el, viewport),
    disabled: !!el.disabled,
    text: captureStructuralText(el),
    value: captureUserValue(el),
    children: [],
  };

  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (!child) continue;
    // Dev 5 integration: the extension's own injected UI (status panel) is
    // not page content — never walk it, never count it, never let it reach
    // Dev 2/the sanitized payload/the LLM.
    if (attr(child, PERCEIVE_UI_MARKER_ATTR) === "true") continue;
    const c = serializeElement(child, [...indexPath, i], viewport, walker);
    if (c) node.children.push(c);
  }
  return node;
}

export function buildDomSnapshot(
  root: DomElementLike,
  state: {
    requestId: string;
    domCapturedAt: number;
    viewport: ViewportLike;
    devicePixelRatio: number;
    scroll: ScrollLike;
  }
): DomSnapshot {
  const walker: WalkState = { max: MAX_CAPTURE_ELEMENTS, count: 0, truncated: false };
  // Root's indexPath MUST be [] (id ""), not [0] — `stampElementIds()`
  // (dom-capture.ts) stamps the SAME real root as "" and its children as
  // [i], not [0, i]. Root previously started at [0] here, giving every
  // non-root element an id one path-segment longer than what was actually
  // stamped onto the live DOM — e.g. the real login button was stamped
  // "0.1.1.2" while this produced "0.0.1.1.2" for the same element. Every
  // click/type action Dev 4 ever attempted against a non-root element was
  // therefore looking up an id that could never exist in the DOM
  // (`target_element_not_found`), independent of any timing/race — root-
  // caused via direct reproduction (verify.js test33), not a race condition.
  const rootNode = serializeElement(root, [], state.viewport, walker);
  const elements = rootNode ? [rootNode] : [];
  const count = countNodes(elements);
  return {
    requestId: state.requestId,
    domCapturedAt: state.domCapturedAt,
    viewport: state.viewport,
    devicePixelRatio: state.devicePixelRatio,
    scroll: state.scroll,
    elements,
    elementCount: count,
    truncated: walker.truncated,
  };
}

export function countNodes(nodes: readonly CapturedElement[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    n += countNodes(node.children);
  }
  return n;
}

/** Build the stage-correlation metadata (plan §5.2). */
export function buildCaptureMetadata(params: {
  requestId: string;
  domCapturedAt: number;
  screenshotCaptureStartedAt: number;
  screenshotCapturedAt: number;
  viewport: ViewportLike;
  devicePixelRatio: number;
  scroll: ScrollLike;
}): CaptureMetadata {
  const viewportWidth = params.viewport.width;
  const viewportHeight = params.viewport.height;
  return {
    requestId: params.requestId,
    domCapturedAt: params.domCapturedAt,
    screenshotCaptureStartedAt: params.screenshotCaptureStartedAt,
    screenshotCapturedAt: params.screenshotCapturedAt,
    captureDelayMs: params.screenshotCaptureStartedAt - params.domCapturedAt,
    screenshotDurationMs: params.screenshotCapturedAt - params.screenshotCaptureStartedAt,
    viewportWidth,
    viewportHeight,
    devicePixelRatio: params.devicePixelRatio,
    scrollX: params.scroll.x,
    scrollY: params.scroll.y,
  };
}