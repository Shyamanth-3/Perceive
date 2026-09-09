/**
 * Dev 2 image redaction, run in the offscreen document (has real
 * `document`/canvas access, unlike the Service Worker). Uses Dev 2's real
 * `redactImage`/`canvasToBase64` (`dev2-vendor/redaction-renderer.js`,
 * unmodified) — this file only decodes the screenshot dataUrl into
 * something `redactImage` can draw from.
 *
 * Runs the SAME real function whether tested in plain Node (its own
 * built-in `typeof document === 'undefined'` fallback, exercised by
 * `tests/dev2-redaction.test.ts`) or here, in the actual offscreen
 * document — no fork, no reimplementation.
 */

import { redactImage, canvasToBase64 } from "../dev2-vendor/redaction-renderer.js";
import type { RedactionRegion, RedactionSamplePoint, RedactionSampleResult } from "../shared/messages";

export type SensitiveRegion = RedactionRegion;

/**
 * Decode a screenshot dataUrl into an `<img>` element (regular
 * HTMLImageElement, not OffscreenCanvas/ImageBitmap — `redactImage` uses
 * `document.createElement('canvas')` + `ctx.drawImage`, both of which need
 * a real image-like source in this document's live DOM).
 */
function decodeImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode screenshot for redaction"));
    img.src = dataUrl;
  });
}

/**
 * Redact `sensitiveRegions` (Dev 2's dom_summary bounding boxes/tiers) onto
 * the captured screenshot and return a PNG data URL. Tier 1 always redacted;
 * Tier 2 redacted unless `redactTier2` is false (mirrors
 * `redaction-renderer.js`'s own `REDACT_TIER_2` flag).
 */
export async function redactScreenshot(
  screenshotDataUrl: string,
  sensitiveRegions: SensitiveRegion[]
): Promise<string> {
  const img = await decodeImageElement(screenshotDataUrl);
  const canvas = redactImage(img, sensitiveRegions);
  const base64 = canvasToBase64(canvas);
  return `data:image/png;base64,${base64}`;
}

function toCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

function samplePixel(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const ctx = canvas.getContext("2d")!;
  const cx = Math.min(Math.max(Math.round(x), 0), canvas.width - 1);
  const cy = Math.min(Math.max(Math.round(y), 0), canvas.height - 1);
  const data = ctx.getImageData(cx, cy, 1, 1).data;
  return [data[0], data[1], data[2], data[3]];
}

/**
 * Redact `sensitiveRegions` onto the screenshot AND, in the same pass,
 * sample pixel colors at `samplePoints` before/after — real, executable
 * proof (not code inspection) that sensitive regions are covered and every
 * other sampled point is left untouched. Runs entirely in this document
 * (the only context with a live canvas), so no image data needs to leave
 * the extension to be verified.
 */
export async function redactScreenshotWithSamples(
  screenshotDataUrl: string,
  sensitiveRegions: SensitiveRegion[],
  samplePoints: RedactionSamplePoint[]
): Promise<{ redactedDataUrl: string; samples: RedactionSampleResult[] }> {
  const img = await decodeImageElement(screenshotDataUrl);
  const originalCanvas = toCanvas(img);
  const redactedCanvas = redactImage(img, sensitiveRegions) as HTMLCanvasElement;

  const samples: RedactionSampleResult[] = samplePoints.map((p) => {
    const before = samplePixel(originalCanvas, p.x, p.y);
    const after = samplePixel(redactedCanvas, p.x, p.y);
    const changed = before.some((v, i) => v !== after[i]);
    const isBlack = after[0] < 30 && after[1] < 30 && after[2] < 30;
    return { label: p.label, isSensitive: p.isSensitive, before, after, changed, isBlack };
  });

  const base64 = canvasToBase64(redactedCanvas);
  return { redactedDataUrl: `data:image/png;base64,${base64}`, samples };
}
