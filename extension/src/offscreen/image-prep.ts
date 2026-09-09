/**
 * Offscreen-only image preparation for local vision inference (Phase 4).
 *
 * Decodes the captured screenshot dataUrl and, if it exceeds
 * `SCREENSHOT_MAX_LONG_EDGE` on its longer edge, downscales it to a canvas
 * before it is handed to the model. This is the one piece of Phase 4 that
 * genuinely needs DOM/canvas access (`Image`, `OffscreenCanvas`), so unlike
 * the rest of Dev 1's Phase 4 code it is not unit-testable in plain node;
 * the pure size math it depends on (`computeDownscaleSize`) lives in
 * `shared/coords.ts` and *is* unit-tested.
 */

import { computeDownscaleSize } from "../shared/coords";
import { SCREENSHOT_MAX_LONG_EDGE } from "../shared/constants";

export interface PreparedImage {
  /** The (possibly downscaled) image, ready to feed to the model. */
  dataUrl: string;
  /** Natural size of the original screenshot, in screenshot pixels. */
  naturalSize: { width: number; height: number };
  /** Size actually fed to the model (== naturalSize when no downscale occurred). */
  modelSize: { width: number; height: number };
}

/** Decode a dataUrl into an ImageBitmap (works in the offscreen document). */
async function decodeImage(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Prepare a captured screenshot for the model: decode it, and downscale via
 * canvas when it exceeds `SCREENSHOT_MAX_LONG_EDGE` on the long edge.
 * Non-JPEG/local-only: the bitmap and canvas never leave this process.
 */
export async function prepareScreenshotForModel(
  screenshotDataUrl: string,
  maxLongEdge: number = SCREENSHOT_MAX_LONG_EDGE
): Promise<PreparedImage> {
  const bitmap = await decodeImage(screenshotDataUrl);
  const naturalSize = { width: bitmap.width, height: bitmap.height };
  const modelSize = computeDownscaleSize(naturalSize, maxLongEdge);

  if (modelSize.width === naturalSize.width && modelSize.height === naturalSize.height) {
    bitmap.close();
    return { dataUrl: screenshotDataUrl, naturalSize, modelSize };
  }

  const canvas = new OffscreenCanvas(modelSize.width, modelSize.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("OffscreenCanvas 2d context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, modelSize.width, modelSize.height);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const dataUrl = await blobToDataUrl(outBlob);
  return { dataUrl, naturalSize, modelSize };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}
