/**
 * Tests Dev 2's real `redactImage`/`canvasToBase64` (dev2-vendor, unmodified)
 * directly, using the library's OWN built-in `typeof document === 'undefined'`
 * fallback (jest's `testEnvironment: "node"` has no `document`) — this is
 * not a mock or a reimplementation, it's Dev 2's own designed-for-Node path.
 */

import { redactImage, canvasToBase64, setRedactTier2 } from "../src/dev2-vendor/redaction-renderer.js";

function fakeSource(width: number, height: number) {
  return { width, height };
}

describe("redactImage (Dev 2's real function, Node fallback path)", () => {
  it("returns a canvas-like object sized to the source", () => {
    const out = redactImage(fakeSource(1200, 800), []);
    expect(out.width).toBe(1200);
    expect(out.height).toBe(800);
  });

  it("throws if no source is given (Dev 2's own guard)", () => {
    expect(() => redactImage(null as never, [])).toThrow(/Source canvas or image is required/);
  });

  it("accepts tier-1 and tier-2 regions without throwing", () => {
    setRedactTier2(true);
    expect(() =>
      redactImage(fakeSource(1200, 800), [
        { bounding_box: { x: 10, y: 10, w: 200, h: 24 }, sensitivity_tier: 1 },
        { bounding_box: { x: 10, y: 50, w: 200, h: 24 }, sensitivity_tier: 2 },
      ])
    ).not.toThrow();
  });

  it("canvasToBase64 returns empty string for a non-canvas-like input", () => {
    expect(canvasToBase64(null as never)).toBe("");
  });
});
