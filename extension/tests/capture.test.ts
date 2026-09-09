/**
 * Phase 2 unit tests for shared/capture.ts — the structural DOM walker,
 * hard-exclusion privacy gate, truncation, and capture metadata.
 *
 * The walker operates on DomElementLike fakes, so no DOM/jsdom needed.
 */

import {
  buildCaptureMetadata,
  buildDomSnapshot,
  buildStableId,
  captureAttributes,
  captureStructuralText,
  captureUserValue,
  countNodes,
  decideExclusion,
  isElementVisible,
  isValueCapturable,
  MAX_CAPTURE_ELEMENTS,
  serializeElement,
  truncateStructuralText,
  truncateUserValue,
  type DomElementLike,
} from "../src/shared/capture";

const VIEWPORT = { width: 1280, height: 720 };

function buildEl(opts: {
  tag: string;
  attrs?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  text?: string | null;
  children?: DomElementLike[];
  value?: string | null;
  type?: string;
  contentEditable?: boolean;
  disabled?: boolean;
}): DomElementLike {
  return {
    tagName: opts.tag,
    getAttribute: (n) => opts.attrs?.[n] ?? null,
    getBoundingClientRect: () => opts.rect ?? null,
    textContent: opts.text ?? null,
    isContentEditable: opts.contentEditable,
    disabled: opts.disabled,
    value: opts.value ?? null,
    type: opts.type,
    children: opts.children ?? [],
  };
}

function serialize(root: DomElementLike, viewport = VIEWPORT) {
  return serializeElement(root, [0], viewport, { max: MAX_CAPTURE_ELEMENTS, count: 0, truncated: false });
}

describe("privacy gate (decideExclusion / isValueCapturable)", () => {
  it("never captures password input values", () => {
    const el = buildEl({ tag: "INPUT", type: "password", value: "hunter2" });
    expect(decideExclusion(el).reason).toBe("password");
    expect(decideExclusion(el).suppressValue).toBe(true);
    expect(isValueCapturable(el)).toBe(false);
    expect(captureUserValue(el)).toBeNull();
  });

  it("never captures file or hidden input values", () => {
    for (const type of ["file", "hidden"]) {
      const el = buildEl({ tag: "INPUT", type, value: "whatever" });
      expect(isValueCapturable(el)).toBe(false);
      expect(captureUserValue(el)).toBeNull();
    }
  });

  it("captures values only for the allow-listed input types", () => {
    for (const type of ["text", "email", "tel", "number", "search", "url"]) {
      const el = buildEl({ tag: "INPUT", type, value: "data-value" });
      expect(isValueCapturable(el)).toBe(true);
      expect(captureUserValue(el)).toBe("data-value");
    }
  });

  it("suppresses text+value on contenteditable elements", () => {
    const el = buildEl({
      tag: "DIV",
      contentEditable: true,
      text: "user typed text",
      children: [buildEl({ tag: "B", text: "x" })],
    });
    expect(isEditableSafe(el)).toBe(true);
    expect(decideExclusion(el).suppressText).toBe(true);
    expect(captureStructuralText(el)).toBeNull();
    expect(captureUserValue(el)).toBeNull();
  });

  it("detects contenteditable via attribute (not just property)", () => {
    const el = buildEl({ tag: "P", attrs: { contenteditable: "true" }, text: "t" });
    expect(decideExclusion(el).suppressText).toBe(true);
  });

  it("captures textarea/select values", () => {
    const ta = buildEl({ tag: "TEXTAREA", value: "multi\nline" });
    const sel = buildEl({ tag: "SELECT", value: "opt-2" });
    expect(isValueCapturable(ta)).toBe(true);
    expect(captureUserValue(ta)).toBe("multi\nline");
    expect(isValueCapturable(sel)).toBe(true);
    expect(captureUserValue(sel)).toBe("opt-2");
  });
});

describe("truncation (plan §4.2)", () => {
  it("truncates structural text to STRUCTURAL_TEXT_LIMIT (200)", () => {
    const long = "a".repeat(500);
    expect(truncateStructuralText(long).length).toBe(200);
    expect(truncateStructuralText("short").length).toBe(5);
    expect(captureStructuralText(buildEl({ tag: "P", text: long }) )?.length).toBe(200);
  });

  it("truncates user values to USER_VALUE_LIMIT (100)", () => {
    const long = "b".repeat(500);
    expect(truncateUserValue(long).length).toBe(100);
    const el = buildEl({ tag: "INPUT", type: "text", value: long });
    expect(captureUserValue(el)?.length).toBe(100);
  });

  it("captures text only on leaf nodes (no ancestor text dumps)", () => {
    const parent = buildEl({ tag: "DIV", text: "parent text", children: [buildEl({ tag: "P", text: "leaf" })] });
    expect(captureStructuralText(parent)).toBeNull();
    expect(captureStructuralText(buildEl({ tag: "P", text: "leaf" }))).toBe("leaf");
  });
});

describe("structural walker", () => {
  it("assigns stable index-path ids and counts nodes", () => {
    const root = buildEl({
      tag: "DIV",
      rect: { x: 0, y: 0, width: 100, height: 50 },
      children: [
        buildEl({ tag: "BUTTON", text: "Go", rect: { x: 10, y: 10, width: 20, height: 20 } }),
        buildEl({
          tag: "FORM",
          rect: { x: 0, y: 30, width: 100, height: 20 },
          children: [buildEl({ tag: "INPUT", type: "text", value: "abc", rect: { x: 5, y: 35, width: 50, height: 10 } })],
        }),
      ],
    });
    expect(buildStableId([0])).toBe("0");
    const node = serialize(root);
    expect(node?.id).toBe("0");
    expect(node?.children[0]?.id).toBe("0.0");
    expect(node?.children[1]?.children[0]?.id).toBe("0.1.0");
    expect(countNodes([node as NonNullable<typeof node>])).toBe(4);
  });

  it("keeps curated attributes only (allow-list)", () => {
    const el = buildEl({
      tag: "INPUT",
      type: "text",
      attrs: {
        id: "email-field",
        class: "field",
        name: "email",
        placeholder: "you@x.com",
        autocomplete: "email",
        "data-user": "secret",
        "aria-label": "Email",
      },
    });
    const attrs = captureAttributes(el);
    expect(attrs).toMatchObject({ id: "email-field", name: "email", "aria-label": "Email" });
    expect(attrs["data-user"]).toBeUndefined();
  });

  it("records tag, type, role, aria, rect, visible, disabled, text, value", () => {
    const el = buildEl({
      tag: "INPUT",
      type: "text",
      value: "k@x.io",
      rect: { x: 100, y: 100, width: 200, height: 30 },
      attrs: { role: "textbox", "aria-expanded": "true", "aria-hidden": "false" },
    });
    const node = serialize(el);
    expect(node).toMatchObject({
      tag: "INPUT",
      type: "text",
      role: "textbox",
      aria: { expanded: true, hidden: null, label: null },
      rect: { x: 100, y: 100, width: 200, height: 30 },
      visible: true,
      disabled: false,
      value: "k@x.io",
    });
  });

  it("marks elements outside the viewport as not visible", () => {
    const offscreen = buildEl({ tag: "P", rect: { x: 5000, y: 5000, width: 10, height: 10 } });
    const onscreen = buildEl({ tag: "P", rect: { x: 50, y: 50, width: 10, height: 10 } });
    expect(isElementVisible(offscreen, VIEWPORT)).toBe(false);
    expect(isElementVisible(onscreen, VIEWPORT)).toBe(true);
  });

  it("treats zero-area rects as not visible", () => {
    const el = buildEl({ tag: "P", rect: { x: 0, y: 0, width: 0, height: 10 } });
    expect(isElementVisible(el, VIEWPORT)).toBe(false);
  });
});

describe("buildDomSnapshot", () => {
  it("produces a well-formed snapshot with requestId + elementCount", () => {
    const root = buildEl({
      tag: "DIV",
      rect: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        buildEl({ tag: "P", text: "hi", rect: { x: 0, y: 0, width: 10, height: 10 } }),
        buildEl({ tag: "P", text: "bye", rect: { x: 20, y: 0, width: 10, height: 10 } }),
      ],
    });
    const snap = buildDomSnapshot(root, {
      requestId: "req-1",
      domCapturedAt: 42,
      viewport: VIEWPORT,
      devicePixelRatio: 2,
      scroll: { x: 0, y: 0 },
    });
    expect(snap.requestId).toBe("req-1");
    expect(snap.domCapturedAt).toBe(42);
    expect(snap.devicePixelRatio).toBe(2);
    expect(snap.elementCount).toBe(3);
    expect(snap.truncated).toBe(false);
  });

  it("sets truncated=true when the element budget is exhausted", () => {
    const many = Array.from({ length: MAX_CAPTURE_ELEMENTS + 50 }, () =>
      buildEl({ tag: "DIV", rect: { x: 0, y: 0, width: 1, height: 1 } })
    );
    const root = buildEl({ tag: "DIV", rect: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }, children: many });
    const snap = buildDomSnapshot(root, {
      requestId: "req-t",
      domCapturedAt: 1,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
      scroll: { x: 0, y: 0 },
    });
    expect(snap.truncated).toBe(true);
    expect(snap.elementCount).toBeLessThanOrEqual(MAX_CAPTURE_ELEMENTS);
  });

  it("a captured password field never leaks its value", () => {
    const root = buildEl({
      tag: "FORM",
      rect: { x: 0, y: 0, width: 300, height: 40 },
      children: [buildEl({ tag: "INPUT", type: "password", value: "s3cret", rect: { x: 0, y: 0, width: 100, height: 20 } })],
    });
    const snap = buildDomSnapshot(root, {
      requestId: "req-p",
      domCapturedAt: 1,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
      scroll: { x: 0, y: 0 },
    });
    const input = snap.elements[0]?.children[0];
    expect(input?.tag).toBe("INPUT");
    expect(input?.attrs.type ?? input?.type).toBe("password");
    expect(input?.value).toBeNull();
  });
});

describe("buildCaptureMetadata (plan §5.2)", () => {
  it("computes delay + duration and carries viewport/dpr/scroll", () => {
    const meta = buildCaptureMetadata({
      requestId: "req-m",
      domCapturedAt: 100,
      screenshotCaptureStartedAt: 110,
      screenshotCapturedAt: 125,
      viewport: { width: 1600, height: 900 },
      devicePixelRatio: 2,
      scroll: { x: 12, y: 34 },
    });
    expect(meta).toMatchObject({
      requestId: "req-m",
      captureDelayMs: 10,
      screenshotDurationMs: 15,
      viewportWidth: 1600,
      viewportHeight: 900,
      devicePixelRatio: 2,
      scrollX: 12,
      scrollY: 34,
    });
  });
});

// NOTE: pattern "isEditableSafe" re-exported above via closure trick; keep it wired.
import { isEditableSafe } from "../src/shared/capture";
void isEditableSafe;