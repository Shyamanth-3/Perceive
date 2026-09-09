import { handleOffscreenMessage, type OffscreenHandlerDeps } from "../src/offscreen/handle-message";
import { createRequestMeta } from "../src/shared/request-id";
import type { RawVisionResult } from "../src/shared/types";

const state = { readyAt: 1234, documentUrl: "chrome-extension://x/offscreen/offscreen.html" };

function makeVisionResult(requestId: string): RawVisionResult {
  return {
    requestId,
    modelId: "Xenova/yolos-tiny",
    modelVersion: "v1",
    backend: "wasm",
    imageWidth: 100,
    imageHeight: 100,
    detections: [],
    inferenceTimeMs: 5,
    cached: false,
  };
}

describe("Offscreen routing (handleOffscreenMessage)", () => {
  it("OFFSCREEN_PING → OFFSCREEN_PING_RESPONSE", async () => {
    const meta = createRequestMeta();
    const res = await handleOffscreenMessage(
      { type: "OFFSCREEN_PING", origin: "background", ...meta },
      state
    );
    expect(res).toMatchObject({
      type: "OFFSCREEN_PING_RESPONSE",
      requestId: meta.requestId,
      ok: true,
      origin: "offscreen",
      documentUrl: state.documentUrl,
      readyAt: state.readyAt,
    });
  });

  it("unknown type → ERROR_RESPONSE", async () => {
    const res = await handleOffscreenMessage(
      { type: "PING", origin: "background", ...createRequestMeta() },
      state
    );
    expect(res?.type).toBe("ERROR_RESPONSE");
    expect((res as { error?: string })?.error).toMatch(/does not handle/i);
  });

  it("malformed message → ERROR_RESPONSE (no throw)", async () => {
    const res = await handleOffscreenMessage({ nope: true }, state);
    expect(res?.type).toBe("ERROR_RESPONSE");
    expect((res as { error?: string })?.error).toMatch(/Unknown message type|Message must/);
  });

  describe("ANALYSIS_REQUEST (Phase 4)", () => {
    it("→ ANALYSIS_RESULT via injected runAnalysis dep", async () => {
      const meta = createRequestMeta();
      const deps: OffscreenHandlerDeps = {
        runAnalysis: async ({ requestId, screenshotDataUrl }) => {
          expect(screenshotDataUrl).toBe("data:image/jpeg;base64,AAAA");
          return makeVisionResult(requestId);
        },
      };
      const res = await handleOffscreenMessage(
        {
          type: "ANALYSIS_REQUEST",
          origin: "background",
          screenshot: "data:image/jpeg;base64,AAAA",
          ...meta,
        },
        state,
        "offscreen",
        deps
      );
      expect(res).toMatchObject({
        type: "ANALYSIS_RESULT",
        requestId: meta.requestId,
        ok: true,
        origin: "offscreen",
        result: { requestId: meta.requestId },
      });
    });

    it("→ ERROR_RESPONSE when no deps are wired (never silently no-ops)", async () => {
      const res = await handleOffscreenMessage(
        { type: "ANALYSIS_REQUEST", origin: "background", screenshot: "x", ...createRequestMeta() },
        state
      );
      expect(res?.type).toBe("ERROR_RESPONSE");
      expect((res as { error?: string })?.error).toMatch(/not wired/i);
    });

    it("→ ERROR_RESPONSE when runAnalysis rejects (e.g. model init failure)", async () => {
      const deps: OffscreenHandlerDeps = {
        runAnalysis: async () => {
          throw new Error("pipeline init failed");
        },
      };
      const res = await handleOffscreenMessage(
        { type: "ANALYSIS_REQUEST", origin: "background", screenshot: "x", ...createRequestMeta() },
        state,
        "offscreen",
        deps
      );
      expect(res?.type).toBe("ERROR_RESPONSE");
      expect((res as { error?: string })?.error).toMatch(/pipeline init failed/);
    });
  });
});