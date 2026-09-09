/**
 * Phase 2/3 unit tests for the capture graph + LATEST_REQUEST_WINS
 * orchestrator (plan §6) and runCaptureGraph correlation.
 */

import {
  createCaptureOrchestrator,
  runCaptureGraph,
  type CaptureGraphDeps,
  type CaptureTask,
} from "../src/background/capture-graph";
import type { DomSnapshot } from "../src/shared/capture";
import type { CorrelatedCapture } from "../src/shared/types";

function fakeDomSnapshot(id: string, domCapturedAt = 1): DomSnapshot {
  return {
    requestId: id,
    domCapturedAt,
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
    elements: [],
    elementCount: 0,
    truncated: false,
  };
}

interface Controllable {
  domCalls: { tabId: number; requestId: string; source: string }[];
  screenshotCalls: number[];
  resolveDom(index: number, id: string, domCapturedAt?: number): void;
}

function makeControllableDeps(): { deps: CaptureGraphDeps; ctl: Controllable } {
  const domGates: {
    id: string;
    resolve: (v: { domSnapshot: DomSnapshot; domCapturedAt: number }) => void;
  }[] = [];
  const ctl: Controllable = {
    domCalls: [],
    screenshotCalls: [],
    resolveDom(index, id, domCapturedAt) {
      domGates[index]?.resolve({
        domSnapshot: fakeDomSnapshot(id, domCapturedAt ?? 1),
        domCapturedAt: domCapturedAt ?? 1,
      });
    },
  };
  const deps: CaptureGraphDeps = {
    now: () => 100,
    requestDomCapture: (tabId, requestId, source) => {
      ctl.domCalls.push({ tabId, requestId, source });
      return new Promise((resolve) => domGates.push({ id: requestId, resolve }));
    },
    captureScreenshot: async (tabId) => {
      ctl.screenshotCalls.push(tabId);
      return { dataUrl: "data:image/jpeg;base64,QUJD", startedAt: 20, endedAt: 25 };
    },
  };
  return { deps, ctl };
}

function expectCaptureShape(outcome: { capture: CorrelatedCapture } | null, expectedId: string) {
  expect(outcome?.capture.requestId).toBe(expectedId);
}

describe("runCaptureGraph", () => {
  it("builds one correlated capture with timing metadata", async () => {
    const { deps } = makeControllableDeps();
    deps.now = () => 100;
    const task: CaptureTask = { requestId: "R1", seq: 1, tabId: 7, source: "initial" };
    const { capture } = await runCaptureGraph(deps, task);
    expect(capture.requestId).toBe("R1");
    expect(capture.source).toBe("initial");
    expect(capture.tabId).toBe(7);
    expect(capture.screenshot.format).toBe("jpeg");
    expect(capture.screenshot.quality).toBe(80);
    expect(capture.screenshot.dataUrl).toMatch(/^data:image\//);
    expect(capture.screenshotStartTime).toBe(20);
    expect(capture.screenshotEndTime).toBe(25);
    expect(capture.timing.domCapturedAt).toBe(1);
    expect(capture.domCapturedAt).toBe(1);
    expect(capture.timing.captureDelayMs).toBeGreaterThanOrEqual(0);
    expect(capture.viewport).toEqual({ width: 800, height: 600 });
  });

  it("runs analysis when a runAnalysis dep is present", async () => {
    const { deps } = makeControllableDeps();
    deps.runAnalysis = async ({ requestId }) => ({
      requestId,
      modelId: "Xenova/yolos-tiny",
      modelVersion: "v",
      backend: "wasm",
      imageWidth: 320,
      imageHeight: 240,
      detections: [],
      inferenceTimeMs: 9,
      cached: false,
    });
    const { capture, analysis } = await runCaptureGraph(deps, {
      requestId: "R2",
      seq: 2,
      tabId: 1,
      source: "manual",
    });
    expect(analysis?.requestId).toBe("R2");
    expect(analysis?.backend).toBe("wasm");
    expect(capture.requestId).toBe("R2");
  });
});

describe("LATEST_REQUEST_WINS orchestrator", () => {
  it("serializes captures: A in-flight, B pending; A is superseded, B wins", async () => {
    const { deps, ctl } = makeControllableDeps();
    const orch = createCaptureOrchestrator(deps);

    const pA = orch.request({ requestId: "A", tabId: 1, source: "initial" });
    const pB = orch.request({ requestId: "B", tabId: 1, source: "mutation" });

    expect(orch.getState().inflight?.requestId).toBe("A");
    expect(orch.getState().pending?.requestId).toBe("B");

    ctl.resolveDom(0, "A", 10);
    expect(await pA).toBeNull(); // superseded
    expect(orch.getState().inflight?.requestId).toBe("B");

    ctl.resolveDom(1, "B", 20);
    const outcomeB = await pB;
    expectCaptureShape(outcomeB, "B");
    expect(orch.getState().superseded).toContain("A");
    expect(orch.getState().lastResult?.capture.requestId).toBe("B");
    expect(orch.getState().capturesCompleted).toBe(1);
  });

  it("a very new request supersedes an already-pending one (pending is replaced)", async () => {
    const { deps, ctl } = makeControllableDeps();
    const orch = createCaptureOrchestrator(deps);
    const pA = orch.request({ requestId: "A", tabId: 1, source: "initial" });
    const pB = orch.request({ requestId: "B", tabId: 1, source: "mutation" });
    const pC = orch.request({ requestId: "C", tabId: 1, source: "manual" });

    expect(orch.getState().pending?.requestId).toBe("C");

    ctl.resolveDom(0, "A", 1);
    expect(await pA).toBeNull();
    // B was never run (replaced while pending) → resolves superseded
    expect(await pB).toBeNull();
    expect(orch.getState().inflight?.requestId).toBe("C");

    ctl.resolveDom(1, "C", 2);
    expectCaptureShape(await pC, "C");
  });

  it("invalidate() drops pending work and supersedes inflight", async () => {
    const { deps, ctl } = makeControllableDeps();
    const orch = createCaptureOrchestrator(deps);
    const pA = orch.request({ requestId: "A", tabId: 1, source: "initial" });
    const pB = orch.request({ requestId: "B", tabId: 1, source: "mutation" });

    orch.invalidate({ reason: "navigation" });

    expect(await pA).toBeNull();
    expect(await pB).toBeNull();
    expect(orch.getState().superseded).toContain("A");
    expect(orch.getState().superseded).toContain("B");
    expect(orch.getState().capturesCompleted).toBe(0);
    expect(ctl.domCalls.length).toBe(1); // B never triggered a DOM walk
  });

  it("never runs two captures concurrently (at most one inference)", async () => {
    const { deps, ctl } = makeControllableDeps();
    const orch = createCaptureOrchestrator(deps);
    void orch.request({ requestId: "A", tabId: 1, source: "initial" });
    void orch.request({ requestId: "B", tabId: 1, source: "mutation" });

    ctl.resolveDom(0, "A", 1);
    ctl.resolveDom(1, "B", 2);
    await new Promise((r) => setTimeout(r, 10));

    // serialized: domCalls order [A, B], screenshotCalls order [A, B]
    expect(ctl.domCalls.map((c) => c.requestId)).toEqual(["A", "B"]);
    expect(ctl.screenshotCalls).toEqual([1, 1]);
    expect(orch.getState().inflight).toBeNull();
    expect(orch.getState().pending).toBeNull();
  });

  it("replacing a pending task resolves it to null (never hangs the caller)", async () => {
    // Regression test: request() used to overwrite `pending` without ever
    // calling the replaced task's resolve(), so a caller awaiting a
    // request that got superseded-while-pending would hang forever.
    const { deps, ctl } = makeControllableDeps();
    const orch = createCaptureOrchestrator(deps);
    const pA = orch.request({ requestId: "A", tabId: 1, source: "initial" });
    const pB = orch.request({ requestId: "B", tabId: 1, source: "mutation" });
    const pC = orch.request({ requestId: "C", tabId: 1, source: "manual" });
    const pD = orch.request({ requestId: "D", tabId: 1, source: "manual" });

    // B, C both replaced-while-pending before A even finishes; none may hang.
    ctl.resolveDom(0, "A", 1);
    await expect(pA).resolves.toBeNull();
    await expect(pB).resolves.toBeNull();
    await expect(pC).resolves.toBeNull();
    expect(orch.getState().superseded).toEqual(expect.arrayContaining(["A", "B", "C"]));

    ctl.resolveDom(1, "D", 2);
    expectCaptureShape(await pD, "D");
  });

  it("a genuine failure (dep throws) is recorded distinctly as lastError, not just superseded", async () => {
    const { deps, ctl } = makeControllableDeps();
    deps.captureScreenshot = async () => {
      throw new Error("captureVisibleTab failed (tab=1)");
    };
    const orch = createCaptureOrchestrator(deps);
    const p = orch.request({ requestId: "A", tabId: 1, source: "manual" });
    ctl.resolveDom(0, "A", 1); // DOM succeeds; the thrown screenshot is what fails
    await expect(p).resolves.toBeNull();
    const state = orch.getState();
    expect(state.lastError).toEqual({ requestId: "A", message: "captureVisibleTab failed (tab=1)" });
    expect(state.capturesCompleted).toBe(0);
  });

  it("fresh orchestrator instance (simulating an SW restart) starts with clean state", async () => {
    // A new module-level orchestrator (as created on every SW startup) must
    // not carry over any state from a previous instance (plan §Phase 5.6).
    const { deps: deps1, ctl: ctl1 } = makeControllableDeps();
    const orch1 = createCaptureOrchestrator(deps1);
    const p1 = orch1.request({ requestId: "R1", tabId: 1, source: "initial" });
    ctl1.resolveDom(0, "R1", 1);
    expectCaptureShape(await p1, "R1");
    expect(orch1.getState().capturesCompleted).toBe(1);

    // Simulate SW restart: brand-new deps + orchestrator, no shared state.
    const { deps: deps2, ctl: ctl2 } = makeControllableDeps();
    const orch2 = createCaptureOrchestrator(deps2);
    expect(orch2.getState().capturesCompleted).toBe(0);
    expect(orch2.getState().latestSeq).toBe(0);
    expect(orch2.getState().lastResult).toBeNull();

    const p2 = orch2.request({ requestId: "R2", tabId: 1, source: "initial" });
    ctl2.resolveDom(0, "R2", 1);
    expectCaptureShape(await p2, "R2");
    expect(orch2.getState().capturesCompleted).toBe(1);
  });
});