/**
 * Coordinate system utilities (Dev 1, Phase 2 §2.4).
 *
 * DOM element bounding boxes and vision (model) bounding boxes must be
 * expressible in one coordinate system. This module provides pure conversion
 * helpers between:
 *
 *   CSS pixels  (element.getBoundingClientRect)  — "design" coordinates
 *   screenshot  pixels (captureVisibleTab output) — css × devicePixelRatio
 *   model input pixels (post-downscale image fed to the ONNX model)
 *
 * All helpers are pure (no DOM/Chrome access) and fully unit-tested.
 */

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface PointLike {
  x: number;
  y: number;
}

/** A numerical box {x, y, width, height}. Also the vision output shape. */
export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CSS-pixel → screenshot-pixel conversion scale factor. */
export function cssToScreenshotScale(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error(`invalid devicePixelRatio: ${devicePixelRatio}`);
  }
  return devicePixelRatio;
}

/** Convert a CSS-pixel point to screenshot-pixel coordinates. */
export function cssPointToScreenshotPoint(
  p: PointLike,
  devicePixelRatio: number
): PointLike {
  return {
    x: p.x * cssToScreenshotScale(devicePixelRatio),
    y: p.y * cssToScreenshotScale(devicePixelRatio),
  };
}

/** Convert a CSS-pixel rect to screenshot-pixel rect. */
export function cssRectToScreenshotRect(
  r: RectLike,
  devicePixelRatio: number
): RectLike {
  const s = cssToScreenshotScale(devicePixelRatio);
  return { x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s };
}

/** Inverse of {@link cssRectToScreenshotRect}. */
export function screenshotRectToCssRect(
  r: RectLike,
  devicePixelRatio: number
): RectLike {
  const s = cssToScreenshotScale(devicePixelRatio);
  return { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s };
}

/**
 * Map a box expressed in model-input pixels onto screenshot pixels. The model
 * image (<modelSize>) may be a downscaled canvas of the raw screenshot
 * (<screenshotSize>); each model box is scaled by (screenshot / model).
 */
export function modelBoxToScreenshotRect(
  box: BoxLike,
  modelSize: SizeLike,
  screenshotSize: SizeLike
): BoxLike {
  if (modelSize.width <= 0 || modelSize.height <= 0) {
    throw new Error(`invalid model size: ${modelSize.width}x${modelSize.height}`);
  }
  if (screenshotSize.width <= 0 || screenshotSize.height <= 0) {
    throw new Error(`invalid screenshot size: ${screenshotSize.width}x${screenshotSize.height}`);
  }
  const sx = screenshotSize.width / modelSize.width;
  const sy = screenshotSize.height / modelSize.height;
  return {
    x: box.x * sx,
    y: box.y * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

/** Model-input box → CSS-pixel box (model → screenshot → /dpr). */
export function modelBoxToCssRect(
  box: BoxLike,
  modelSize: SizeLike,
  screenshotSize: SizeLike,
  devicePixelRatio: number
): BoxLike {
  return screenshotRectToCssRect(
    modelBoxToScreenshotRect(box, modelSize, screenshotSize),
    devicePixelRatio
  );
}

/** Clamp a box so it lies entirely inside the given bounds. */
export function clampBoxToBounds(box: BoxLike, bounds: SizeLike): BoxLike {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(box.width, bounds.width - x);
  const height = Math.min(box.height, bounds.height - y);
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Validate a numerical bounding box: finite non-negative coordinates, positive
 * width/height, and (optionally) fully within the given image bounds.
 */
export function isValidBox(box: BoxLike, within?: SizeLike): boolean {
  const finite =
    [box.x, box.y, box.width, box.height].every((v) => Number.isFinite(v)) &&
    box.width > 0 &&
    box.height > 0;
  if (!finite) return false;
  if (!within) return true;
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= within.width && box.y + box.height <= within.height;
}

/** Force a screen-relative css rect to be inside the viewport (negative-layout guards). */
export function sanitizeCssRect(r: RectLike, viewport: SizeLike): RectLike {
  return clampBoxToBounds({ ...r }, viewport);
}

/**
 * Compute the target size for a screenshot fed to the local vision model
 * (Phase 4, plan `SCREENSHOT_MAX_LONG_EDGE`). Downscales so the longer edge
 * is at most `maxLongEdge`, preserving aspect ratio; images already at or
 * under the cap are returned unchanged (never upscaled). Pure integer math,
 * no canvas/DOM access, so it is unit-testable independent of the offscreen
 * document that actually draws the resized image.
 */
export function computeDownscaleSize(natural: SizeLike, maxLongEdge: number): SizeLike {
  if (natural.width <= 0 || natural.height <= 0) {
    throw new Error(`invalid natural size: ${natural.width}x${natural.height}`);
  }
  if (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0) {
    throw new Error(`invalid maxLongEdge: ${maxLongEdge}`);
  }
  const longEdge = Math.max(natural.width, natural.height);
  if (longEdge <= maxLongEdge) {
    return { width: Math.round(natural.width), height: Math.round(natural.height) };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}