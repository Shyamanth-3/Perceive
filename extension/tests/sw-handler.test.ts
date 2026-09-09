import {
  createSwRuntimeState,
  handleSwMessage,
} from "../src/background/handle-message";
import { MESSAGE_TYPES } from "../src/shared/messages";
import { createRequestMeta } from "../src/shared/request-id";
import { buildCaptureMetadata } from "../src/shared/capture";
import type { CorrelatedCapture } from "../src/shared/types";

function fakeCapture(requestId: string): CorrelatedCapture {
  const timing = buildCaptureMetadata({
    requestId,
    domCapturedAt: 1,
    screenshotCaptureStartedAt: 2,
    screenshotCapturedAt: 3,
    viewport: { width: 100, height: 100 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
  });
  return {
    requestId,
    source: "manual",
    tabId: 7,
    timing,
    domCapturedAt: 1,
    screenshotStartTime: 2,
    screenshotEndTime: 3,
    viewport: { width: 100, height: 100 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
    dom: {},
    screenshot: { dataUrl: "data:image/jpeg;base64,AA==", format: "jpeg", quality: 80 },
  };
}

describe("Service Worker routing (handleSwMessage)", () => {
  it("PING → PING_RESPONSE with correlation + ok flag", async () => {
    const state = createSwRuntimeState();
    const requestId = createRequestMeta().requestId;
    const res = await handleSwMessage(
      { type: "PING", origin: "content-script", requestId, timestamp: 10 },
      state
    );
    expect(res).toMatchObject({
      type: "PING_RESPONSE",
      requestId,
      ok: true,
      origin: "background",
    });
    expect(res).not.toBeNull();
    if (res) expect(res.timestamp).toBeGreaterThanOrEqual(10);
    expect(state.lastPing).toEqual({ requestId, receivedAt: expect.any(Number), origin: "content-script" });
  });

  it("records the ping for later correlation", async () => {
    const state = createSwRuntimeState();
    const meta = createRequestMeta();
    await handleSwMessage({ type: "PING", origin: "offscreen", ...meta }, state);
    expect(state.lastPing?.requestId).toBe(meta.requestId);
    expect(state.lastPing?.origin).toBe("offscreen");
  });

  it("OFFSCREEN_READY is an event with no response (null)", async () => {
    const state = createSwRuntimeState();
    const res = await handleSwMessage(
      {
        type: "OFFSCREEN_READY",
        origin: "offscreen",
        documentUrl: "chrome-extension://x/offscreen/offscreen.html",
        ...createRequestMeta(),
      },
      state
    );
    expect(res).toBeNull();
    expect(state.lastOffscreenReady?.documentUrl).toContain("offscreen.html");
  });

  it("CAPTURE_REQUEST routes into the orchestrator and returns CAPTURE_RESULT", async () => {
    const state = createSwRuntimeState();
    const enqueueCapture = jest.fn(async ({ requestId }: { requestId: string }) => ({
      capture: fakeCapture(requestId),
      analysis: null,
    }));
    const deps = { enqueueCapture, invalidateCaptures: jest.fn() };
    const res = await handleSwMessage(
      { type: "CAPTURE_REQUEST", origin: "content-script", ...createRequestMeta() },
      state,
      "background",
      { senderTabId: 7 },
      deps
    );
    expect(enqueueCapture).toHaveBeenCalledWith({
      requestId: expect.any(String),
      tabId: 7,
      source: "manual",
    });
    expect(res?.type).toBe("CAPTURE_RESULT");
    expect((res as { superseded?: boolean })?.superseded).toBeUndefined();
    expect((res as { capture?: CorrelatedCapture })?.capture?.requestId).toBeDefined();
    expect(state.lastCapture?.source).toBe("manual");
  });

  it("CAPTURE_REQUEST without a tab → ERROR_RESPONSE", async () => {
    const state = createSwRuntimeState();
    const res = await handleSwMessage(
      { type: "CAPTURE_REQUEST", origin: "content-script", ...createRequestMeta() },
      state,
      "background",
      {},
      { enqueueCapture: jest.fn(), invalidateCaptures: jest.fn() }
    );
    expect(res?.type).toBe("ERROR_RESPONSE");
    expect((res as { error?: string })?.error).toMatch(/no tab available/);
  });

  it("a superseded capture reports superseded:true without a capture", async () => {
    const state = createSwRuntimeState();
    const res = await handleSwMessage(
      { type: "CAPTURE_REQUEST", origin: "content-script", ...createRequestMeta() },
      state,
      "background",
      { senderTabId: 2 },
      { enqueueCapture: jest.fn(async () => null), invalidateCaptures: jest.fn() }
    );
    expect(res?.type).toBe("CAPTURE_RESULT");
    expect((res as { superseded?: boolean })?.superseded).toBe(true);
    expect((res as { capture?: CorrelatedCapture }).capture).toBeUndefined();
  });

  it("MUTATION_DETECTED routes with source 'mutation' and records the count", async () => {
    const state = createSwRuntimeState();
    const enqueueCapture = jest.fn(async () => null);
    const res = await handleSwMessage(
      { type: "MUTATION_DETECTED", origin: "content-script", mutationCount: 12, ...createRequestMeta() },
      state,
      "background",
      { senderTabId: 3 },
      { enqueueCapture, invalidateCaptures: jest.fn() }
    );
    expect(enqueueCapture).toHaveBeenCalledWith({ requestId: expect.any(String), tabId: 3, source: "mutation" });
    expect(state.lastMutation?.mutationCount).toBe(12);
    expect(res?.type).toBe("CAPTURE_RESULT");
  });

  it("INVALIDATE_CACHE bumps cacheEpoch and invalidates captures; returns null", async () => {
    const state = createSwRuntimeState();
    const invalidateCaptures = jest.fn();
    const res = await handleSwMessage(
      { type: "INVALIDATE_CACHE", origin: "content-script", ...createRequestMeta() },
      state,
      "background",
      {},
      { enqueueCapture: jest.fn(), invalidateCaptures }
    );
    expect(res).toBeNull();
    expect(state.cacheEpoch).toBe(1);
    expect(invalidateCaptures).toHaveBeenCalledWith("cacheEpoch=1");
  });

  it("unhandled type → ERROR_RESPONSE", async () => {
    const state = createSwRuntimeState();
    const input = { type: "SCREENSHOT_REQUEST", origin: "content-script", ...createRequestMeta() };
    const res = await handleSwMessage(input, state);
    expect(res?.type).toBe("ERROR_RESPONSE");
    expect((res as { error?: string })?.error).toMatch(/does not handle/i);
  });

  it("malformed message → ERROR_RESPONSE (no throw)", async () => {
    const state = createSwRuntimeState();
    const res = await handleSwMessage({ type: "BOGUS", origin: "content-script" }, state);
    expect(res?.type).toBe("ERROR_RESPONSE");
    expect((res as { error?: string })?.error).toMatch(/Unknown message type/);
  });

  it("types consumed outside the SW router still error cleanly here", async () => {
    const state = createSwRuntimeState();
    for (const type of ["DOM_CAPTURE_RESULT", "SCREENSHOT_RESULT", "ANALYSIS_REQUEST", "ANALYSIS_RESULT", "CAPTURE_RESULT"]) {
      const res = await handleSwMessage({ type, origin: "content-script", ...createRequestMeta() }, state);
      expect(res?.type).toBe("ERROR_RESPONSE");
    }
  });
});