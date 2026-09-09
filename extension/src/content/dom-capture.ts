/**
 * Real-DOM adapter: converts a live browser `Element` into the structural
 * `DomElementLike` view used by the shared capture walker. Lives in the
 * content script side (needs the actual page DOM).
 */

import {
  buildDomSnapshot,
  type DomSnapshot,
  type DomElementLike,
  type RectLike,
} from "../shared/capture";
import { captureFromDocumentState, type PageState } from "./page-state";
import { PERCEIVE_UI_MARKER_ATTR } from "../shared/constants";

/**
 * Convert a single real Element to the structural view. `children` traverses
 * real element children via a lazy adapter.
 */
export function toStructural(el: Element): DomElementLike {
  const $self = el;
  return {
    tagName: $self.tagName,
    getAttribute: (n) => $self.getAttribute(n),
    getBoundingClientRect: (): RectLike | null => {
      const r = $self.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    textContent: $self.textContent,
    isContentEditable: ($self as HTMLElement).isContentEditable ?? false,
    disabled: ($self as HTMLInputElement).disabled ?? false,
    value: ($self as HTMLInputElement).value ?? null,
    type: ($self as HTMLInputElement).type ?? undefined,
    get children() {
      return Array.from($self.children).map((c) => toStructural(c as HTMLElement));
    },
  };
}

/**
 * Dev 3 → Dev 4 integration fix: `actionExecutor.js` targets elements via
 * `[data-element-id="<id>"]` (falling back to `getElementById`), but
 * nothing previously set that attribute — Dev 1's `element_id` is a
 * positional index-path (e.g. "0.1.2.1", from `buildStableId` in
 * `shared/capture.ts`), generated from serialized data, never written back
 * onto the real DOM. Every real action would have silently failed to find
 * its target.
 *
 * This walks the SAME root using the SAME traversal order
 * (`element.children[i]`, depth-first) `serializeElement` uses to assign
 * `indexPath` — guaranteed to produce identical ids for every element that
 * ends up in the snapshot (truncation only stops descending further, never
 * skips/renumbers earlier siblings — confirmed against `serializeElement`).
 * Call once per capture, right after the DOM walk, before any element_id is
 * used for targeting.
 *
 * IMPORTANT (found via real-Chrome testing): the content script's own
 * MutationObserver watches `attributes: true`. An earlier version of this
 * function unconditionally called `setAttribute` on every element on every
 * capture, which counts as an attribute mutation — creating a feedback loop
 * (stamp -> mutation observed -> debounced re-capture -> stamp -> ...) that
 * caused runaway repeated captures and exhausted Chrome's
 * `captureVisibleTab` per-second quota. Only write when the value actually
 * differs, so a stable page's second+ capture touches nothing and the loop
 * breaks after the first pass.
 */
export function stampElementIds(root: Element = document.body): void {
  function setIfChanged(el: Element, id: string): void {
    if (el.getAttribute("data-element-id") !== id) el.setAttribute("data-element-id", id);
  }
  function walk(el: Element, indexPath: number[]): void {
    setIfChanged(el, indexPath.join("."));
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      // Must mirror serializeElement's Dev 5 UI skip exactly, or stamped
      // ids drift from the ids Dev 2/the backend/the LLM actually see.
      if (child && child.getAttribute(PERCEIVE_UI_MARKER_ATTR) !== "true") walk(child, [...indexPath, i]);
    }
  }
  // Root itself is index-path [] per buildStableId([]) === "" — matches
  // serializeElement's very first call (indexPath = [] for the root).
  setIfChanged(root, "");
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child && child.getAttribute(PERCEIVE_UI_MARKER_ATTR) !== "true") walk(child, [i]);
  }
}

/**
 * Capture the current page DOM as a structural snapshot.
 * `doc`/`win` injected so the pure build can be tested; defaults to globals.
 */
export function captureDomSnapshot(
  requestId: string,
  state?: Partial<PageState>
): DomSnapshot {
  const root = (typeof document !== "undefined" ? document.body : null) ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!root) {
    throw new Error("captureDomSnapshot: no document root available");
  }
  const page = captureFromDocumentState(state);
  return buildDomSnapshot(toStructural(root), {
    requestId,
    domCapturedAt: page.domCapturedAt,
    viewport: page.viewport,
    devicePixelRatio: page.devicePixelRatio,
    scroll: page.scroll,
  });
}