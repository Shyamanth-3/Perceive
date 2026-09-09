/**
 * Phase 2 unit tests for shared/coords.ts — the coordinate-space converters
 * that keep DOM (CSS px), screenshot, and model-input pixels consistent.
 */

import {
  clampBoxToBounds,
  computeDownscaleSize,
  cssPointToScreenshotPoint,
  cssRectToScreenshotRect,
  cssToScreenshotScale,
  isValidBox,
  modelBoxToCssRect,
  modelBoxToScreenshotRect,
  screenshotRectToCssRect,
} from "../src/shared/coords";

describe("css ↔ screenshot pixels (dpr)", () => {
  it("scales by devicePixelRatio", () => {
    expect(cssToScreenshotScale(2)).toBe(2);
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    expect(cssRectToScreenshotRect(rect, 2)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
    expect(cssPointToScreenshotPoint({ x: 3, y: 4 }, 2)).toEqual({ x: 6, y: 8 });
  });

  it("round-trips css → screenshot → css for any dpr", () => {
    const rect = { x: 7.5, y: -3, width: 240, height: 120 };
    const dpr = 1.5;
    const back = screenshotRectToCssRect(cssRectToScreenshotRect(rect, dpr), dpr);
    expect(back).toEqual(rect);
  });

  it("rejects non-positive or non-finite dpr", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => cssToScreenshotScale(bad)).toThrow(/devicePixelRatio/);
    }
  });
});

describe("model → screenshot → css", () => {
  it("scales model boxes up to screenshot pixels by ratio", () => {
    const box = { x: 100, y: 50, width: 40, height: 60 };
    expect(modelBoxToScreenshotRect(box, { width: 640, height: 480 }, { width: 1280, height: 960 })).toEqual({
      x: 200,
      y: 100,
      width: 80,
      height: 120,
    });
  });

  it("rejects degenerate image sizes", () => {
    expect(() => modelBoxToScreenshotRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 10 }, { width: 10, height: 10 })).toThrow(/model size/);
  });

  it("model box → screenshot → /dpr yields CSS px", () => {
    const css = modelBoxToCssRect(
      { x: 320, y: 240, width: 80, height: 60 },
      { width: 640, height: 480 }, // model input
      { width: 1280, height: 960 }, // screenshot (2x css at dpr2)
      2
    );
    expect(css).toEqual({ x: 160, y: 120, width: 40, height: 30 });
  });
});

describe("validation + clamping", () => {
  it("validates finite positive boxes, optionally within bounds", () => {
    expect(isValidBox({ x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(isValidBox({ x: -1, y: 0, width: 10, height: 10 })).toBe(false);
    expect(isValidBox({ x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(isValidBox({ x: 0, y: 0, width: 10, height: 10 }, { width: 100, height: 100 })).toBe(true);
    expect(isValidBox({ x: 95, y: 0, width: 10, height: 10 }, { width: 100, height: 100 })).toBe(false);
    expect(isValidBox({ x: 0, y: 0, width: 10, height: NaN })).toBe(false);
  });

  it("clamps boxes to bounds", () => {
    const clamped = clampBoxToBounds({ x: -5, y: -10, width: 500, height: 500 }, { width: 100, height: 200 });
    expect(clamped).toEqual({ x: 0, y: 0, width: 100, height: 200 });
    const empty = clampBoxToBounds({ x: 90, y: 190, width: 500, height: 500 }, { width: 100, height: 200 });
    expect(empty.width).toBe(10);
    expect(empty.height).toBe(10);
  });
});

describe("computeDownscaleSize (Phase 4 §7.3 screenshot downscale)", () => {
  it("leaves images at or under the cap unchanged", () => {
    expect(computeDownscaleSize({ width: 1600, height: 900 }, 1600)).toEqual({ width: 1600, height: 900 });
    expect(computeDownscaleSize({ width: 800, height: 600 }, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("downscales the long edge to the cap, preserving aspect ratio", () => {
    // 3200x1800 landscape, cap 1600 -> long edge halved.
    expect(computeDownscaleSize({ width: 3200, height: 1800 }, 1600)).toEqual({ width: 1600, height: 900 });
    // Portrait: height is the long edge.
    expect(computeDownscaleSize({ width: 1200, height: 2400 }, 1600)).toEqual({ width: 800, height: 1600 });
  });

  it("never upscales", () => {
    expect(computeDownscaleSize({ width: 100, height: 50 }, 1600)).toEqual({ width: 100, height: 50 });
  });

  it("rejects degenerate inputs", () => {
    expect(() => computeDownscaleSize({ width: 0, height: 10 }, 1600)).toThrow(/natural size/);
    expect(() => computeDownscaleSize({ width: 10, height: 10 }, 0)).toThrow(/maxLongEdge/);
    expect(() => computeDownscaleSize({ width: 10, height: 10 }, -1)).toThrow(/maxLongEdge/);
  });

  it("always rounds to whole pixels and guards against zero at extreme ratios", () => {
    const size = computeDownscaleSize({ width: 10000, height: 1 }, 1600);
    expect(Number.isInteger(size.width)).toBe(true);
    expect(Number.isInteger(size.height)).toBe(true);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});