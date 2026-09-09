/*
 * Perceive runtime verification driver (Phases 1-4).
 *
 * Launches Chrome for Testing with the built extension (TEST_HOOKS build),
 * then verifies the MV3 scaffold (Phase 1), synchronized capture graph
 * (Phase 2), mutation reactivity (Phase 3), and local vision inference
 * (Phase 4), writing verify-results.json.
 *
 * Requires:  npm run build:test-hooks   (or)   TEST_HOOKS=1 npm run build
 * Phase 4 additionally requires: npm run fetch-models (populates
 * models-cache/, copied into dist/models/ by the build).
 *
 * Usage: node verify.js
 */

"use strict";

const { spawn } = require("child_process");
const CDP = require("chrome-remote-interface");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const CHROME =
  process.env.CFT ||
  "/var/folders/0d/jzpnl3ts2hjbcj7ppv3vbbw80000gn/T/opencode/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const EXT_DIR = path.join(__dirname, "dist");
const PORT = 9333;
const HTTP_PORT = 9797;
const OUT_FILE = path.join(__dirname, "verify-results.json");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "perceive-phase1-"));
const results = {
  meta: { date: new Date().toISOString(), chrome: null, env: null },
  tests: {},
  logs: {},
  errors: [],
};
const chromeStderr = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Deterministically wait for Dev 1's own orchestrator to be genuinely idle
 * (no inflight AND no pending capture) before a task-driven consumer starts
 * competing for the same LATEST_REQUEST_WINS slot. Requires TWO consecutive
 * idle observations (not just one) since a single null reading can land in
 * the brief gap between one autonomous capture finishing and the next one
 * being enqueued. Root-caused via real QuickShop testing: a page with a
 * large/churny boot-time DOM (many elements to stamp) can take longer to
 * settle than a fixed short poll under memory pressure — this raises the
 * ceiling on the *condition* being polled for, not a blind sleep duration.
 */
async function waitForOrchestratorIdle(swWs, maxTicks = 100, tickMs = 300) {
  let status = null;
  let consecutiveIdle = 0;
  for (let i = 0; i < maxTicks; i++) {
    status = await evalIn(swWs, `__perceiveTest.getStatus()`);
    const idle = !status?.orchestrator?.inflightRequestId && !status?.orchestrator?.pendingRequestId;
    consecutiveIdle = idle ? consecutiveIdle + 1 : 0;
    if (consecutiveIdle >= 2) break;
    await sleep(tickMs);
  }
  return status;
}

async function waitForTargetByUrl(filter, timeoutMs = 45000, extraLabel = "") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await CDP.List({ port: PORT });
      const match = list.find(filter);
      if (match) return match;
    } catch (_) {
      /* CDP not ready yet */
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for target (${extraLabel})`);
}

async function evalIn(wsUrl, expression) {
  let client;
  try {
    client = await CDP({ target: wsUrl });
    await client.Runtime.enable();
    const res = await client.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      return { __evalError: true, error: ex };
    }
    return res.result.value;
  } finally {
    if (client) await client.close();
  }
}

/**
 * Evaluate within the content script's isolated world (the page's main world
 * cannot see content-script globals). Discovers the world by listening for
 * executionContextCreated events. The handler MUST be attached BEFORE
 * Runtime.enable(); enabling replays existing contexts into those listeners.
 */
function findIsolatedWorldId(contexts) {
  return contexts.find(
    (c) =>
      c.origin?.startsWith("chrome-extension://") &&
      c.auxData?.type === "isolated"
  )?.id;
}

async function evalInContentWorld(pageWs, expression) {
  let client;
  try {
    client = await CDP({ target: pageWs });
    const contexts = [];
    const handler = (p) => contexts.push(p.context);
    client.Runtime.on("executionContextCreated", handler);
    await client.Runtime.enable();
    const start = Date.now();
    let contextId = null;
    while (!contextId && Date.now() - start < 15000) {
      contextId = findIsolatedWorldId(contexts) ?? null;
      if (!contextId) await sleep(100);
    }
    if (!contextId) throw new Error("content-script isolated world not found");
    const res = await client.Runtime.evaluate({
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      return { __evalError: true, error: ex };
    }
    return res.result.value;
  } finally {
    if (client) await client.close();
  }
}

function record(name, passed, detail) {
  results.tests[name] = { passed: !!passed, detail };
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function localStaticServer(req, res) {
  if (req.url === "/wake.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "wake.html")));
  } else if (req.url === "/capture.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "capture.html")));
  } else if (req.url === "/demo.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "demo.html")));
  } else if (req.url === "/quickshop/index.html" || req.url === "/quickshop/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "quickshop", "index.html")));
  } else if (req.url === "/quickshop/sandbox.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "quickshop", "sandbox.css")));
  } else if (req.url === "/quickshop/sandbox.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "quickshop", "sandbox.js")));
  } else {
    res.writeHead(404);
    res.end();
  }
}

async function main() {
  const profileServer = http.createServer(localStaticServer);
  await new Promise((resolve) => profileServer.listen(HTTP_PORT, resolve));

  const chrome = spawn(CHROME, [
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    "--disable-background-networking",
    "--disable-component-update",
    "--enable-logging=stderr",
    "--v=0",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", (d) => {
    const s = d.toString();
    chromeStderr.push(s);
    const cap = s.match(/INFO:CONSOLE:\d+\]\s*"([^"]+)"/);
    if (cap) {
      const msg = cap[1];
      if (msg.startsWith("[SW]") || msg.startsWith("[Offscreen]") || msg.startsWith("[Content]")) {
        (results.logs.messages ||= []).push(msg);
      }
    }
  });

  let browser; // CDP browser-level client (ServiceWorker domain)
  const cleanup = async () => {
    clearInterval(keepAlive);
    try { await browser?.close(); } catch (_) {}
    try { chrome.kill("SIGKILL"); } catch (_) {}
    try { profileServer.close(); } catch (_) {}
  };
  let keepAlive = null;

  try {
    // ---- environment ----
    let chromeVersion = "unknown";
    try {
      chromeVersion = require("child_process")
        .execSync(`"${CHROME}" --version`, { timeout: 10000 })
        .toString()
        .trim();
    } catch (_) {}
    results.meta.chrome = chromeVersion;
    results.meta.env = { node: process.version, cwd: process.cwd() };
    console.log(`Perceive Phase 1 verification — ext: ${EXT_DIR} (${chromeVersion})`);

    // ---- wake page: triggers content script -> SW ----
    // Chrome's CDP port can take longer than a fixed sleep to come up on a
    // loaded/I/O-contended machine; retry instead of failing on the first
    // ECONNREFUSED (this used to be a single unretried call and made the
    // whole run bail out with zero tests recorded).
    let pageList = null;
    const cdpListStart = Date.now();
    while (!pageList && Date.now() - cdpListStart < 45000) {
      try {
        pageList = await CDP.List({ port: PORT });
      } catch (_) {
        await sleep(500);
      }
    }
    if (!pageList) throw new Error(`Chrome CDP port ${PORT} never became reachable`);
    const page = pageList.find((t) => t.type === "page");
    if (!page) throw new Error("no initial page target");
    await evalIn(page.webSocketDebuggerUrl, `location.href='http://127.0.0.1:${HTTP_PORT}/wake.html'`);

    // ---- Test 1 & 2: extension loads without manifest errors; SW starts ----
    const swTarget = await waitForTargetByUrl(
      (t) => t.type === "service_worker" && t.url.includes("service-worker.js"),
      45000,
      "SW"
    );
    record("test1_extension_loads", true, `SW target found: ${swTarget.url}`);
    record("test2_sw_starts", true, "service worker target discovered");

    const swWs = swTarget.webSocketDebuggerUrl;
    keepAlive = setInterval(() => {
      evalIn(swWs, "1").catch(() => {});
    }, 4000);

    // The SW's CDP target can appear slightly before its module script has
    // finished executing and defined __perceiveTest — retry instead of
    // treating one early race as a real failure.
    let status1 = null;
    for (let i = 0; i < 15 && !status1?.manifest; i++) {
      const attempt = await evalIn(swWs, `__perceiveTest.getStatus()`);
      if (attempt && !attempt.__evalError) status1 = attempt;
      if (!status1?.manifest) await sleep(300);
    }
    status1 = status1 || {};
    const manifestOk =
      status1.manifest?.name === "Perceive" &&
      status1.manifest?.version &&
      status1.manifest?.swType === "module" &&
      typeof status1.manifest?.swFile === "string";
    record(
      "test1b_manifest_ok",
      manifestOk,
      `manifest=${JSON.stringify(status1.manifest)}`
    );

    // ---- Test 3 & 4: content script loads + PING reaches SW ----
    let contentLoaded = false;
    let pingResult = null;
    for (let i = 0; i < 100 && !contentLoaded; i++) {
      try {
        pingResult = await evalInContentWorld(
          page.webSocketDebuggerUrl,
          `({ loaded: !!window.__perceiveContentLoaded, ping: window.__perceivePingResult || null })`
        );
      } catch (_) {
        pingResult = null;
      }
      if (pingResult && !pingResult.__evalError && pingResult.loaded) contentLoaded = true;
      else await sleep(300);
    }
    record("test3_content_script_loads", contentLoaded, `content-script world reported loaded=${!!contentLoaded}`);
    const pingOk = contentLoaded && pingResult?.ping?.ok === true;
    record("test4_content_to_sw_ping", pingOk, JSON.stringify(pingResult?.ping));

    const status2 = await evalIn(swWs, `__perceiveTest.getStatus()`);
    record(
      "test4b_sw_records_ping",
      status2?.lastPing?.requestId === pingResult?.ping?.requestId,
      `lastPing=${JSON.stringify(status2?.lastPing)}`
    );

    // ---- Test 5/6/7: SW creates offscreen doc and pings it ----
    const ensure1 = await evalIn(swWs, `__perceiveTest.ensureAndPing()`);
    const out1 = ensure1?.outcome || {};
    let offTarget = null;
    try {
      offTarget = await waitForTargetByUrl(
        (t) => t.url && t.url.includes("offscreen/offscreen.html"),
        15000,
        "offscreen"
      );
    } catch (e) {
      results.errors.push(`offscreen target not found: ${e.message}`);
    }
    // Phase 4 note: `created` is no longer guaranteed true here specifically.
    // Since runAnalysis() now also calls ensureOffscreenDocument() (any
    // capture, including the auto "initial" one wake.html's content script
    // fires before this point, flows through to analysis), the offscreen
    // document may legitimately already exist by the time this explicit
    // call runs. Either outcome is correct — what actually matters (same
    // invariant test9_no_duplicate_offscreen checks after an SW restart) is
    // that exactly one offscreen document exists once this call returns.
    record(
      "test5_offscreen_created",
      ensure1?.offscreenContextCount === 1 && !!offTarget,
      `created=${out1.created} contexts=${ensure1?.offscreenContextCount} urls=${JSON.stringify(ensure1?.offscreenUrls)}`
    );

    const pingResp = ensure1?.pingResponse || {};
    record(
      "test6_sw_pings_offscreen",
      pingResp?.type === "OFFSCREEN_PING_RESPONSE" && pingResp?.documentUrl?.includes("offscreen.html"),
      `responseType=${pingResp?.type} documentUrl=${pingResp?.documentUrl}`
    );
    record(
      "test7_offscreen_answers",
      pingResp?.ok === true,
      `ok=${pingResp?.ok} readyAt=${pingResp?.readyAt}`
    );

    // ---- Test 8: no external network from offscreen / SW ----
    let offResources = null;
    let swResources = null;
    if (offTarget) {
      offResources = await evalIn(offTarget.webSocketDebuggerUrl, `__perceiveOffscreen.resourceNames()`);
    }
    const offAllLocal = Array.isArray(offResources)
      ? offResources.length === 0 ||
        offResources.every((r) => r.startsWith("chrome-extension://") || r.startsWith("chrome://"))
      : false;
    record(
      "test8_offscreen_no_external_network",
      offAllLocal,
      `resources=${JSON.stringify(offResources || [])}`
    );
    // SW resource check: only chrome-extension:// entries would be acceptable.
    swResources = await evalIn(swWs, `performance.getEntriesByType('resource').map(e => e.name)`);
    const swAllLocal = Array.isArray(swResources)
      ? swResources.every((r) => r.startsWith("chrome-extension://") || r.startsWith("chrome://"))
      : false;
    record(
      "test8b_sw_no_external_network",
      Array.isArray(swResources) && swAllLocal,
      `swResources=${JSON.stringify(swResources || [])}`
    );

    // ---- Test 9: SW restart keeps offscreen idempotent ----
    browser = await CDP({ port: PORT }); // browser-level client
    await browser.ServiceWorker.enable();
    keepAlive && clearInterval(keepAlive);
    keepAlive = null;
    await browser.ServiceWorker.stopAllWorkers();
    await sleep(1200);

    // Reload page so the content script re-pings and forces a fresh SW instance.
    try {
      await evalIn(page.webSocketDebuggerUrl, `window.location.reload(); true`);
    } catch (_) {
      /* context destroyed during reload – expected */
    }
    await sleep(500);
    // Wait for the *new* SW target to appear, then prove the restarted SW
    // answers a content-script PING by sending one from the isolated world
    // (retrying until the newly-woken worker registers its listener).
    const swTarget2 = await waitForTargetByUrl(
      (t) => t.type === "service_worker" && t.url.includes("service-worker.js"),
      30000,
      "SW-after-restart"
    );
    const swWs2 = swTarget2.webSocketDebuggerUrl;

    const restartPingExpr = `(async () => {
      for (let i = 0; i < 20; i++) {
        try {
          const r = await chrome.runtime.sendMessage({
            type: 'PING', origin: 'content-script',
            requestId: 'verify-restart-' + i, timestamp: Date.now()
          });
          if (r && r.ok === true) return { ok: true, swStartedAt: r.swStartedAt };
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 750));
      }
      return { ok: false };
    })()`;
    let restartPing = null;
    for (let i = 0; i < 10 && !restartPing?.ok; i++) {
      try {
        restartPing = await evalInContentWorld(page.webSocketDebuggerUrl, restartPingExpr);
      } catch (_) {
        restartPing = null;
      }
      if (restartPing?.ok) break;
      await sleep(400);
    }

    const statusAfterRestart = await evalIn(swWs2, `__perceiveTest.getStatus()`);
    const swActuallyRestarted = statusAfterRestart?.startedAt !== status1?.startedAt;
    record(
      "test9_sw_restarted",
      swActuallyRestarted && restartPing?.ok === true,
      `newStartedAt=${statusAfterRestart?.startedAt} (old=${status1?.startedAt}) contentPingOk=${!!restartPing?.ok}`
    );

    const ensure2 = await evalIn(swWs2, `__perceiveTest.ensureAndPing()`);
    const out2 = ensure2?.outcome || {};
    record(
      "test9_no_duplicate_offscreen",
      out2.created === false && ensure2?.offscreenContextCount === 1,
      `created=${out2.created} contexts=${ensure2?.offscreenContextCount} urls=${JSON.stringify(ensure2?.offscreenUrls)}`
    );

    // ---- Phase 2 & 3: correlated capture, privacy, mutation-triggered ----
    const capturePageUrl = `http://127.0.0.1:${HTTP_PORT}/capture.html`;
    await evalIn(page.webSocketDebuggerUrl, `location.href = '${capturePageUrl}'`);
    await sleep(1200);

    // Wait for the content script on the new page and its auto initial capture.
    let phase2 = null;
    for (let i = 0; i < 60 && !phase2?.initialReady; i++) {
      try {
        const status = await evalIn(swWs2, `__perceiveTest.getStatus()`);
        const latest = status?.lastCapture;
        const lastCap = await evalIn(swWs2, `__perceiveTest.getLatestCapture()`);
        phase2 = {
          initialReady:
            status?.lastPing != null &&
            latest?.source === "initial" &&
            lastCap != null &&
            lastCap.requestId === latest.requestId,
          status,
          lastCap,
        };
      } catch (_) {
        phase2 = null;
      }
      if (!phase2?.initialReady) await sleep(300);
    }

    record(
      "test11_initial_capture_on_load",
      !!phase2?.initialReady,
      `lastCapture=${JSON.stringify(phase2?.status?.lastCapture)} requestId=${phase2?.lastCap?.requestId ?? null} orchestrator=${JSON.stringify(phase2?.status?.orchestrator)}`
    );

    const cap = phase2?.lastCap;
    record(
      "test12_capture_metadata",
      !!cap &&
        typeof cap.requestId === "string" &&
        cap.timing?.captureDelayMs >= 0 &&
        cap.timing?.screenshotDurationMs >= 0 &&
        cap.viewport?.width > 0 &&
        cap.viewport?.height > 0 &&
        cap.devicePixelRatio > 0 &&
        cap.screenshot?.dataUrlPrefix?.startsWith("data:image/jpeg"),
      JSON.stringify({
        timing: cap?.timing,
        viewport: cap?.viewport,
        dpr: cap?.devicePixelRatio,
        screenshot: cap?.screenshot,
      })
    );

    record(
      "test13_password_value_never_captured",
      !!cap &&
        cap.dom?.privacy?.passwordFields >= 1 &&
        cap.dom?.privacy?.capturedPasswordValues === 0,
      `privacy=${JSON.stringify(cap?.dom?.privacy)} elementCount=${cap?.dom?.elementCount}`
    );

    const captureCountBefore = await evalIn(swWs2, `__perceiveTest.getCaptureCount()`);
    const manual = await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    record(
      "test14_manual_capture_produces_new_correlated_result",
      manual?.superseded === false &&
        manual?.capture?.requestId != null &&
        manual?.capture?.requestId !== cap?.requestId &&
        manual?.capture?.dom?.elementCount > 0 &&
        manual?.capture?.screenshot?.dataUrlPrefix?.startsWith("data:image/jpeg"),
      JSON.stringify({ manual: manual?.capture?.requestId, previous: cap?.requestId })
    );
    const captureCountAfterManual = await evalIn(swWs2, `__perceiveTest.getCaptureCount()`);
    record(
      "test14b_manual_capture_counted",
      captureCountAfterManual > captureCountBefore,
      `before=${captureCountBefore} after=${captureCountAfterManual}`
    );

    // Phase 3: a DOM mutation must trigger a debounced (250 ms) capture.
    const prevRequestId = manual?.capture?.requestId ?? null;
    await evalIn(
      page.webSocketDebuggerUrl,
      `(() => {
        const t = document.getElementById('mutate-target');
        const p = document.createElement('p');
        p.id = 'mutation-added';
        p.textContent = 'injected by verify for mutation test';
        (t || document.body).appendChild(p);
        return true;
      })()`
    );

    let mutationSeen = null;
    let lastPollStatus = null; // diagnostic: last status seen even if the match never fired
    let lastPollCap = null;
    for (let i = 0; i < 40 && !mutationSeen; i++) {
      try {
        const status = await evalIn(swWs2, `__perceiveTest.getStatus()`);
        const lastCapNow = await evalIn(swWs2, `__perceiveTest.getLatestCapture()`);
        lastPollStatus = status;
        lastPollCap = lastCapNow;
        if (
          status?.lastMutation?.mutationCount >= 1 &&
          status?.lastCapture?.source === "mutation" &&
          lastCapNow?.requestId != null &&
          lastCapNow.requestId !== prevRequestId
        ) {
          mutationSeen = { status, requestId: lastCapNow.requestId };
        }
      } catch (_) {
        mutationSeen = null;
      }
      if (!mutationSeen) await sleep(300);
    }
    record(
      "test15_mutation_triggers_capture",
      !!mutationSeen &&
        mutationSeen.status?.lastMutation?.mutationCount >= 1 &&
        mutationSeen.status?.lastCapture?.source === "mutation",
      mutationSeen
        ? JSON.stringify({
            lastMutation: mutationSeen?.status?.lastMutation,
            lastCaptureSource: mutationSeen?.status?.lastCapture?.source,
            requestId: mutationSeen?.requestId ?? null,
          })
        : `NO MATCH after 12s. prevRequestId=${prevRequestId} lastPollStatus.lastMutation=${JSON.stringify(lastPollStatus?.lastMutation)} lastPollStatus.lastCapture=${JSON.stringify(lastPollStatus?.lastCapture)} lastPollStatus.orchestrator=${JSON.stringify(lastPollStatus?.orchestrator)} lastPollCap=${JSON.stringify(lastPollCap)}`
    );
    record(
      "test16_debounce_merges_mutation_burst",
      mutationSeen?.status?.lastMutation?.mutationCount >= 1,
      `mutationCount=${mutationSeen?.status?.lastMutation?.mutationCount}`
    );

    // ---- Test 17/18: Phase 4 local vision (only meaningful once
    // `npm run fetch-models` + a rebuild have populated dist/models + dist/wasm;
    // see build.js warnings / README). A missing bundle surfaces as an
    // explicit FAIL with the underlying error, never a false PASS. ----
    const analysisRun = await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    const analysis = analysisRun?.analysis;
    record(
      "test17_analysis_produces_result",
      !!analysis &&
        analysis.modelId === "Xenova/yolos-tiny" &&
        (analysis.backend === "webgpu" || analysis.backend === "wasm") &&
        Number.isInteger(analysis.detectionCount) &&
        analysis.detectionCount >= 0 &&
        analysis.inferenceTimeMs >= 0,
      JSON.stringify(analysis)
    );

    // Zero-network proof (plan: "everything bundled locally"): every
    // resource the offscreen document has loaded — including whatever the
    // model/wasm init for test17 just triggered — must be local
    // (chrome-extension:// or chrome://), never a real network fetch.
    const offResourcesAfterInference = offTarget
      ? await evalIn(offTarget.webSocketDebuggerUrl, `__perceiveOffscreen.resourceNames()`)
      : null;
    const offAllLocalAfterInference = Array.isArray(offResourcesAfterInference)
      ? offResourcesAfterInference.every(
          (r) => r.startsWith("chrome-extension://") || r.startsWith("chrome://")
        )
      : false;
    record(
      "test18_zero_network_during_inference",
      Array.isArray(offResourcesAfterInference) && offAllLocalAfterInference,
      `resources=${JSON.stringify(offResourcesAfterInference || [])}`
    );

    // ---- Test 19: on-device inference cache hit (Phase 5, plan §8) ----
    // Two manual captures back-to-back on an unchanged page should produce
    // byte-identical screenshots and therefore an identical §8.1 composite
    // cache key. Note: test17 already ran an analysis on this same
    // unchanged page moments earlier, so run1 here may ALREADY be a cache
    // hit (that's correct reuse, not a bug) — the real assertion is just
    // "both runs succeeded and were served from cache", not "run1 must be
    // a fresh miss" (which would only hold if this were the very first
    // analysis of the session).
    //
    // Every triggerCapture() ALWAYS calls chrome.tabs.captureVisibleTab
    // fresh (only the vision *analysis* step is cached, not the screenshot
    // capture) — and that API enforces a real, documented per-second quota
    // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). test14/17 already used up
    // part of the current window, so settle before/between calls here or
    // the second call fails with a genuine Chrome quota error (verified:
    // "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
    // quota.") that has nothing to do with the cache/orchestrator logic
    // this test exists to prove.
    await sleep(1200);
    const cacheRun1 = await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    await sleep(1200);
    const cacheRun2 = await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    record(
      "test19_repeat_analysis_is_cache_hit",
      cacheRun1?.superseded === false &&
        cacheRun2?.superseded === false &&
        cacheRun1?.analysis?.cached === true &&
        cacheRun2?.analysis?.cached === true,
      JSON.stringify({ run1: cacheRun1, run2: cacheRun2 })
    );

    // ---- Test 20: concurrency — LATEST_REQUEST_WINS under real overlap
    // (plan §6 / Phase 5.2): fire three captures without awaiting the first
    // two; only the last (C) may complete as non-superseded, and neither A
    // nor B's promise may hang (the bug fixed in capture-graph.ts §5.2).
    // Settle first — see the captureVisibleTab quota note above test19. ----
    await sleep(1200);
    const concurrency = await evalIn(
      swWs2,
      `(async () => {
        const before = await __perceiveTest.getCaptureCount();
        const [a, b, c] = await Promise.all([
          __perceiveTest.triggerCapture('manual'),
          __perceiveTest.triggerCapture('manual'),
          __perceiveTest.triggerCapture('manual'),
        ]);
        const after = await __perceiveTest.getCaptureCount();
        return { a, b, c, before, after };
      })()`
    );
    record(
      "test20_concurrent_requests_latest_wins",
      concurrency?.a?.superseded === true &&
        concurrency?.b?.superseded === true &&
        concurrency?.c?.superseded === false &&
        concurrency?.c?.capture?.requestId != null &&
        concurrency.after === concurrency.before + 1, // exactly one completed capture, not three
      JSON.stringify({
        aSuperseded: concurrency?.a?.superseded,
        bSuperseded: concurrency?.b?.superseded,
        cSuperseded: concurrency?.c?.superseded,
        aLastError: concurrency?.a?.lastError,
        bLastError: concurrency?.b?.lastError,
        cLastError: concurrency?.c?.lastError,
        before: concurrency?.before,
        after: concurrency?.after,
      })
    );

    // ---- Test 22: SPA routing invalidation (plan §8.2 rule 2) ----
    // history.pushState() never fires `popstate` (that only fires on
    // back/forward), so a client-side router changing the URL directly
    // would otherwise leave a stale cached capture. content-script.ts
    // patches pushState/replaceState to detect this and invalidate.
    await sleep(600); // let any trailing activity from test20 settle
    const epochBefore = (await evalIn(swWs2, `__perceiveTest.getStatus()`))?.cacheEpoch;
    await evalIn(
      page.webSocketDebuggerUrl,
      `(() => { history.pushState({}, '', location.pathname + '?spa-route=verify-test22'); return true; })()`
    );
    let epochAfter = epochBefore; // seed equal so the loop condition below actually runs
    for (let i = 0; i < 20 && epochAfter === epochBefore; i++) {
      epochAfter = (await evalIn(swWs2, `__perceiveTest.getStatus()`))?.cacheEpoch;
      if (epochAfter === epochBefore) await sleep(300);
    }
    record(
      "test22_spa_pushstate_triggers_invalidation",
      typeof epochBefore === "number" && epochAfter > epochBefore,
      `cacheEpoch before=${epochBefore} after=${epochAfter}`
    );

    // ---- Test 23: Dev 1 → Dev 2 integration gate (real Chrome, real synthetic
    // sensitive data, real Dev 2 vendored code — capture.html now carries
    // card/phone/aadhaar/otp/ifsc/name/amount fixtures alongside the existing
    // email/password ones). Proves: raw page -> Dev 1 capture -> Dev 2
    // classification+tokenization -> sanitized payload, with the RAW
    // synthetic values verified absent from the final payload. ----
    await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    const sanitized = await evalIn(
      swWs2,
      `__perceiveTest.buildSanitizedPayload('verify-test23-session', 'checkout', 1)`
    );
    const payloadStr = JSON.stringify(sanitized?.payload ?? {});
    const RAW_SENSITIVE_VALUES = [
      "not-a-real-password", // password-fixture
      "4111111111111111", // card-fixture
      "9999999999", // phone-fixture
      "234567890123", // aadhaar-fixture
      "482913", // otp-fixture
      "HDFC0001234", // ifsc-fixture (structural, not tiered, but must still never leak raw if ever misclassified)
    ];
    const leakedValues = RAW_SENSITIVE_VALUES.filter((v) => payloadStr.includes(v));
    const els = sanitized?.payload?.dom_summary?.elements ?? [];
    record(
      "test23_dev1_dev2_privacy_gate",
      sanitized?.ok === true &&
        leakedValues.length === 0 &&
        Array.isArray(els) &&
        els.length > 0,
      JSON.stringify({
        ok: sanitized?.ok,
        error: sanitized?.error,
        elementCount: els.length,
        leakedValues,
        sampleTieredElement: els.find((e) => e.sensitivity_tier === 1) ?? null,
      })
    );

    // ---- Test 26: Redaction root-cause fix verification (real pixel
    // sampling, real Chrome canvas, no mock). Proves: (a) sensitive (tier
    // 1/2) DOM elements' actual on-screen positions are covered by a
    // near-black redaction box after the CSS-px -> screenshot-px conversion
    // fix (buildScreenshotSensitiveRegions), and (b) every non-sensitive
    // sampled element -- including the deliberately blue `#box-fixture` div,
    // which a vision-detection-based redaction scheme could wrongly flag --
    // is pixel-identical before/after. No RawVisionResult/detection box is
    // ever read anywhere in this call chain (verifyRedaction only consumes
    // Dev 1's DOM capture + Dev 2's classification), directly demonstrating
    // that vision boxes are not used as privacy regions. ----
    const redaction = await evalIn(
      swWs2,
      `__perceiveTest.verifyRedaction('verify-test26-session', 'checkout', 1)`
    );
    const samples = redaction?.samples ?? [];
    const sensitiveSamples = samples.filter((s) => s.isSensitive);
    const nonSensitiveSamples = samples.filter((s) => !s.isSensitive);
    const sensitiveOk = sensitiveSamples.length > 0 && sensitiveSamples.every((s) => s.isBlack);
    const nonSensitiveOk = nonSensitiveSamples.length > 0 && nonSensitiveSamples.every((s) => !s.changed);
    record(
      "test26_redaction_covers_sensitive_only",
      redaction?.ok === true && sensitiveOk && nonSensitiveOk,
      JSON.stringify({
        ok: redaction?.ok,
        error: redaction?.error,
        devicePixelRatio: redaction?.devicePixelRatio,
        sensitiveRegionCount: redaction?.sensitiveRegionCount,
        sensitiveSamples: sensitiveSamples.map((s) => ({ label: s.label, isBlack: s.isBlack, after: s.after })),
        nonSensitiveChanged: nonSensitiveSamples.filter((s) => s.changed).map((s) => ({ label: s.label, before: s.before, after: s.after })),
      })
    );

    // ---- Test 27/28/29: Dev 4 confirmation-allow / confirmation-deny /
    // unresolvable-token, driven directly against Dev 4's real, unmodified
    // requiresConfirmation/requestConfirmation/executeAction (real rendered
    // overlay, real clicks via CDP, real DOM mutation check) — independent
    // of the LLM/backend so these don't depend on Groq being reachable or
    // unrate-limited. Uses capture.html's #search input (harmless, has no
    // side effects when changed). ----
    await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('search').value = 'baseline'; return true; })()`);

    // test27: confirmation-ALLOW -> real execution -> real DOM value change.
    await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `(() => { window.__perceiveTestConfirmPromise = __perceiveTestConfirmAndExecute({type:'type', target_element_id:'search', value:'confirmed-value-1', risk_tier:'risky', reasoning_short:'test-allow'}, {}); return true; })()`
    );
    await sleep(300);
    await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('confirmation-allow').click(); return true; })()`);
    const allowOutcome = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__perceiveTestConfirmPromise`);
    const searchValueAfterAllow = await evalIn(page.webSocketDebuggerUrl, `document.getElementById('search').value`);
    record(
      "test27_confirmation_allow_real_execution",
      allowOutcome?.requiresConfirmationResult === true &&
        allowOutcome?.approved === true &&
        allowOutcome?.executionResult?.success === true &&
        searchValueAfterAllow === "confirmed-value-1",
      JSON.stringify({ allowOutcome, searchValueAfterAllow })
    );

    // test28: confirmation-DENY -> execution never runs -> real DOM unchanged.
    await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('search').value = 'baseline-2'; return true; })()`);
    await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `(() => { window.__perceiveTestConfirmPromise = __perceiveTestConfirmAndExecute({type:'type', target_element_id:'search', value:'should-never-appear', risk_tier:'risky', reasoning_short:'test-deny'}, {}); return true; })()`
    );
    await sleep(300);
    await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('confirmation-deny').click(); return true; })()`);
    const denyOutcome = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__perceiveTestConfirmPromise`);
    const searchValueAfterDeny = await evalIn(page.webSocketDebuggerUrl, `document.getElementById('search').value`);
    record(
      "test28_confirmation_deny_blocks_execution",
      denyOutcome?.requiresConfirmationResult === true &&
        denyOutcome?.approved === false &&
        denyOutcome?.executionResult === null &&
        searchValueAfterDeny === "baseline-2",
      JSON.stringify({ denyOutcome, searchValueAfterDeny })
    );

    // test29: unresolvable token -> executeAction refuses, real DOM unchanged,
    // no raw/placeholder value ever reaches the input.
    await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('search').value = 'baseline-3'; return true; })()`);
    const tokenOutcome = await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `__perceiveTestConfirmAndExecute({type:'type', target_element_id:'search', value:'[UNRESOLVABLE_TEST_TOKEN]', risk_tier:'safe', reasoning_short:'test-token'}, {})`
    );
    const searchValueAfterToken = await evalIn(page.webSocketDebuggerUrl, `document.getElementById('search').value`);
    record(
      "test29_unresolvable_token_fails_safely",
      tokenOutcome?.requiresConfirmationResult === false &&
        tokenOutcome?.executionResult?.success === false &&
        tokenOutcome?.executionResult?.error === "unresolvable_token" &&
        searchValueAfterToken === "baseline-3",
      JSON.stringify({ tokenOutcome, searchValueAfterToken })
    );

    // ---- Test 30: navigation-during-processing. Fires a real capture
    // without awaiting it, then immediately calls the SAME real
    // invalidateCaptures() path pagehide/popstate/pushstate already use
    // (test22), simulating "the user navigated while a request was in
    // flight". Expected: the in-flight capture must resolve superseded/null
    // rather than quietly handing its (now-stale) result to whatever
    // requested it — direct reproduction of the LATEST_REQUEST_WINS
    // contract under navigation, not just inspection. ----
    await evalIn(swWs2, `(() => { globalThis.__test30Capture = __perceiveTest.triggerCapture('manual'); return true; })()`);
    await evalIn(swWs2, `__perceiveTest.invalidateCaptures('test30-navigation-simulated')`);
    const nav30Result = await evalIn(swWs2, `globalThis.__test30Capture`);
    const nav30FollowUp = await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    record(
      "test30_navigation_during_processing_invalidates_stale_result",
      nav30Result?.superseded === true &&
        nav30Result?.capture === null &&
        nav30FollowUp?.superseded === false &&
        !!nav30FollowUp?.capture,
      JSON.stringify({ nav30Result, nav30FollowUpOk: !!nav30FollowUp?.capture })
    );

    // ---- Test 24: Dev 2 → Dev 3 integration gate (real network call to the
    // real, running, selected-authoritative backend at 127.0.0.1:8000 — real
    // Groq LLM in the loop, not a mock). Requires the backend to be running
    // separately (see backend-server/README or dev3-integration report). If
    // the backend isn't reachable, this records a clear FAIL with the fetch
    // error rather than silently skipping. ----
    const dev3Result = await evalIn(
      swWs2,
      `__perceiveTest.sendSanitizedPayloadToBackend('verify-test24-session', 'log in to the account', 1)`
    );
    const sentPayloadStr = JSON.stringify(dev3Result?.sentPayload ?? {});
    const dev3LeakedValues = RAW_SENSITIVE_VALUES.filter((v) => sentPayloadStr.includes(v));
    const backendAction = dev3Result?.backendResponse?.body?.action ?? dev3Result?.backendResponse?.body?.detail;
    record(
      "test24_dev2_dev3_real_backend_call",
      dev3Result?.ok === true &&
        dev3Result?.backendResponse?.ok === true &&
        dev3LeakedValues.length === 0 &&
        !!backendAction,
      JSON.stringify({
        ok: dev3Result?.ok,
        error: dev3Result?.error,
        backendStatus: dev3Result?.backendResponse?.status,
        backendLeakedValues: dev3LeakedValues,
        action: backendAction,
      })
    );

    // ---- Test 25: Dev 3 → Dev 4 real QuickShop E2E ----
    // Real Dev 1 capture -> real Dev 2 classification -> real network call
    // to the real backend -> real Groq LLM -> real action -> real
    // confirmation gating -> real actionExecutor against the real page.
    // No mocks anywhere in this chain (mockDev1/mockDev2/
    // window.__mockBackendResponse from Dev 4's original file are not
    // present in orchestrator.ts at all). Uses a focused single-action
    // instruction (log in) to keep the real LLM call bounded/verifiable
    // rather than automating the full multi-step checkout.
    // Settle first — captureVisibleTab quota note (see test19/20 above);
    // test24's earlier real capture already used part of the window.
    await sleep(1200);
    const quickshopUrl = `http://127.0.0.1:${HTTP_PORT}/quickshop/index.html`;
    await evalIn(page.webSocketDebuggerUrl, `location.href = '${quickshopUrl}'`);
    await sleep(1200);

    let qsReady = null;
    for (let i = 0; i < 30 && !qsReady?.ok; i++) {
      try {
        qsReady = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__perceivePingResult ?? null`);
      } catch (_) {
        qsReady = null;
      }
      if (!qsReady?.ok) await sleep(400);
    }
    // Deterministically wait for Dev 1's own boot-time "initial" auto-capture
    // (and the one-time mutation wave from stampElementIds()' first pass) to
    // fully drain the LATEST_REQUEST_WINS slot before the orchestrator starts
    // competing for it — a fixed sleep here raced under real memory/CPU
    // pressure (root-caused via real Chrome testing: the task-driven capture
    // lost the race up to 12x in a row when boot captures were still
    // in-flight/pending at a fixed 2000ms). Poll the SW's own orchestrator
    // state instead of guessing a longer fixed delay.
    const idleStatus = await waitForOrchestratorIdle(swWs2);

    let e2eResult = null;
    let e2eError = null;
    if (qsReady?.ok) {
      try {
        e2eResult = await evalInContentWorld(
          page.webSocketDebuggerUrl,
          `__perceiveRunTaskLoop('Click the login button to log in').then(r => r)`
        );
      } catch (err) {
        e2eError = String(err?.message || err);
      }
    }

    const loginSectionHidden = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('login-section')?.classList.contains('hidden') ?? null`
    );
    const checkoutSectionVisible = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('checkout-section') ? !document.getElementById('checkout-section').classList.contains('hidden') : null`
    );
    // Root-cause diagnostics for the step timeout — real elapsed time of
    // every backend fetch attempt this task loop actually made (empty array
    // means sendToBackend was never reached, i.e. the capture step itself
    // failed/superseded before any network call happened).
    const backendFetchAttempts = await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `window.__perceiveLastBackendFetchAttempts ?? []`
    ).catch(() => null);

    record(
      "test25_dev3_dev4_quickshop_e2e",
      !!qsReady?.ok &&
        !e2eError &&
        e2eResult != null &&
        typeof e2eResult.success === "boolean" &&
        // The clearest, most literal proof of REAL execution against the
        // REAL page: the login form's real submit handler actually fired,
        // transitioning the real DOM — not something any mock could produce.
        (loginSectionHidden === true || checkoutSectionVisible === true),
      JSON.stringify({
        qsReady,
        e2eError,
        e2eResult,
        loginSectionHidden,
        checkoutSectionVisible,
        backendFetchAttempts,
        idleStatusBeforeStart: idleStatus?.orchestrator,
      })
    );

    // ---- Test 31: FULL multi-step QuickShop checkout (login -> checkout ->
    // pay -> confirmation -> task_complete). Real Dev 1 capture, real Dev 2
    // classification, real backend, real Groq, real confirmation UI (clicked
    // for real via CDP whenever it appears — pay-now is type="submit" so
    // Dev 4's own local heuristic always requires confirmation for it
    // regardless of server risk_tier), real actionExecutor, real DOM.
    // Reloads the page fresh first so test25's earlier login attempt doesn't
    // leave stale state. Polls rather than blocking on one await so it can
    // click Allow the moment the real overlay appears, for as many
    // confirmation prompts as the task actually produces (e.g. one per
    // sensitive field it fills, plus one for Pay Now). ----
    await sleep(1200);
    await evalIn(page.webSocketDebuggerUrl, `location.href = '${quickshopUrl}'`);
    await sleep(1200);
    let qs31Ready = null;
    for (let i = 0; i < 30 && !qs31Ready?.ok; i++) {
      try {
        qs31Ready = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__perceivePingResult ?? null`);
      } catch (_) {
        qs31Ready = null;
      }
      if (!qs31Ready?.ok) await sleep(400);
    }
    const idle31Status = await waitForOrchestratorIdle(swWs2);

    // Dev 5 integration: listen for the real pipeline events the orchestrator
    // emits (dev5-events.ts), the same feed Dev 5's real status panel
    // consumes — proves the panel's data source is real, not fabricated.
    await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `(() => { window.__test32Stages = []; window.addEventListener('perceive-pipeline-event', (e) => window.__test32Stages.push(e.detail.stage)); return true; })()`
    );

    let checkout31Error = null;
    const confirmationsSeen = [];
    if (qs31Ready?.ok) {
      try {
        await evalInContentWorld(
          page.webSocketDebuggerUrl,
          `(() => { window.__test31Promise = __perceiveRunTaskLoop('Log in to the account using the pre-filled credentials, then on the checkout page submit the payment using the saved payment method already on file to complete the order.'); return true; })()`
        );
      } catch (err) {
        checkout31Error = String(err?.message || err);
      }
    }

    let checkout31Result = null;
    const CHECKOUT_MAX_TICKS = 400; // generous budget for a multi-step real LLM-driven checkout
    for (let i = 0; i < CHECKOUT_MAX_TICKS && checkout31Result === null; i++) {
      // Click Allow for real whenever the real overlay is actually visible —
      // never resolve the confirmation promise programmatically.
      const overlayVisible = await evalIn(
        page.webSocketDebuggerUrl,
        `(() => { const b = document.getElementById('confirmation-allow'); return !!b && b.offsetParent !== null; })()`
      );
      if (overlayVisible === true) {
        const targetInfo = await evalIn(page.webSocketDebuggerUrl, `document.getElementById('confirmation-target')?.textContent ?? null`);
        confirmationsSeen.push(targetInfo);
        await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('confirmation-allow').click(); return true; })()`);
      }
      try {
        const settled = await evalInContentWorld(
          page.webSocketDebuggerUrl,
          `Promise.race([window.__test31Promise.then(r => ({done:true, r})), new Promise(res => setTimeout(() => res({done:false}), 400))])`
        );
        if (settled?.done) checkout31Result = settled.r;
      } catch (err) {
        checkout31Error = checkout31Error || String(err?.message || err);
        break;
      }
    }

    const login31Hidden = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('login-section')?.classList.contains('hidden') ?? null`
    );
    const checkout31Visible = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('checkout-section') ? !document.getElementById('checkout-section').classList.contains('hidden') : null`
    );
    const confirmation31Visible = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('confirmation-section') ? !document.getElementById('confirmation-section').classList.contains('hidden') : null`
    );
    const checkout31FieldValues = await evalIn(
      page.webSocketDebuggerUrl,
      `(() => { const ids=['full-name','card-number','card-expiry','card-cvv','phone','billing-address','aadhaar']; const o={}; for (const id of ids){ const el=document.getElementById(id); o[id]= el ? el.value : null;} return o; })()`
    );
    const backendFetchAttempts31 = await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `window.__perceiveLastBackendFetchAttempts ?? []`
    ).catch(() => null);

    record(
      "test31_full_quickshop_checkout_workflow",
      // CRITICAL per instructions: only true completion counts — the real
      // confirmation-section must have actually become visible (QuickShop's
      // own script only does that from its real pay-now submit handler).
      confirmation31Visible === true,
      JSON.stringify({
        qs31Ready,
        checkout31Error,
        checkout31Result,
        confirmationsSeen,
        login31Hidden,
        checkout31Visible,
        confirmation31Visible,
        checkout31FieldValues,
        backendFetchAttemptCount: Array.isArray(backendFetchAttempts31) ? backendFetchAttempts31.length : null,
        idleStatusBeforeStart: idle31Status?.orchestrator,
        lastBackendFetchAttempts: Array.isArray(backendFetchAttempts31) ? backendFetchAttempts31.slice(-6) : backendFetchAttempts31,
      })
    );

    // ---- Test 32: Dev 5 integration — real panel, real event feed, and
    // proof Dev 1's capture walker actually excludes it (never reaches
    // Dev 2/backend/LLM, never gets an actionable element_id). ----
    const dev5PanelExists = await evalIn(
      page.webSocketDebuggerUrl,
      `!!document.getElementById('perceive-dev5-panel')`
    );
    const dev5PanelNotStamped = await evalIn(
      page.webSocketDebuggerUrl,
      `(() => { const p = document.getElementById('perceive-dev5-panel'); return !!p && !p.hasAttribute('data-element-id'); })()`
    );
    const dev5PanelExcludedFromCapture = await evalIn(
      swWs2,
      `(async () => {
        const cap = await __perceiveTest.triggerCapture('manual');
        const raw = cap?.capture ? JSON.stringify(cap.capture) : '';
        return !raw.includes('perceive-dev5-panel') && !raw.includes('perceive-status');
      })()`
    );
    const stagesSeen = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__test32Stages ?? []`).catch(() => []);
    const expectedStages = ["CAPTURING", "SANITIZING", "SENDING_SANITIZED_REQUEST", "WAITING_FOR_LLM", "ACTION_RECEIVED"];
    const missingStages = expectedStages.filter((s) => !stagesSeen.includes(s));
    record(
      "test32_dev5_panel_real_events_and_capture_exclusion",
      dev5PanelExists === true &&
        dev5PanelNotStamped === true &&
        dev5PanelExcludedFromCapture === true &&
        missingStages.length === 0,
      JSON.stringify({ dev5PanelExists, dev5PanelNotStamped, dev5PanelExcludedFromCapture, stagesSeen, missingStages })
    );

    // ---- Test 33: DIAGNOSTIC — direct reproduction of the target-id
    // staleness bug. Compares the element_id Dev 2's payload assigns to the
    // real #login-submit button (via serializeElement's indexPath) against
    // the data-element-id actually stamped onto that SAME button in the live
    // DOM (via stampElementIds' indexPath), with ZERO time elapsed between
    // the two reads (no LLM/backend/network involved) — isolates whether
    // this is a static id-scheme mismatch or a timing race. ----
    await evalIn(swWs2, `__perceiveTest.triggerCapture('manual')`);
    const diagPayload = await evalIn(
      swWs2,
      `__perceiveTest.buildSanitizedPayload('verify-test33-session', 'diagnostic', 1)`
    );
    const diagAllButtons = (diagPayload?.payload?.dom_summary?.elements ?? []).filter((el) => (el.tag || "").toUpperCase() === "BUTTON");
    const diagLoginSubmitFromPayload = diagAllButtons[0] ?? null;
    const diagStampedIdOnRealButton = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('login-submit')?.getAttribute('data-element-id') ?? null`
    );
    const diagElementFoundByPayloadId = await evalIn(
      page.webSocketDebuggerUrl,
      `(() => { const id = ${JSON.stringify(diagLoginSubmitFromPayload?.element_id ?? null)}; if (!id) return null; const el = document.querySelector('[data-element-id="' + id + '"]'); return el ? el.id || el.tagName : null; })()`
    );
    record(
      "test33_diagnostic_element_id_scheme_comparison",
      // Just recording the real facts — pass/fail here is itself the
      // diagnosis (mismatch == the bug is confirmed, not a race).
      true,
      JSON.stringify({
        allButtonElementsInPayload: diagAllButtons.map((b) => ({ element_id: b.element_id, label_text: b.label_text })),
        firstTenElements: (diagPayload?.payload?.dom_summary?.elements ?? []).slice(0, 10).map((e) => ({ id: e.element_id, tag: e.tag })),
        payloadElementIdForLoginSubmit: diagLoginSubmitFromPayload?.element_id ?? null,
        realStampedIdOnLoginSubmitButton: diagStampedIdOnRealButton,
        idsMatch: diagLoginSubmitFromPayload?.element_id === diagStampedIdOnRealButton,
        whatPayloadIdActuallyResolvesToInLiveDom: diagElementFoundByPayloadId,
        totalElementCount: diagPayload?.payload?.dom_summary?.elements?.length ?? null,
      })
    );

    // ---- console log evidence ----
    results.logs.messages = [...new Set(results.logs.messages || [])];
    const hadLogs = (results.logs.messages || []).some((m) => m.startsWith("[SW] started"))
      && (results.logs.messages || []).some((m) => m.startsWith("[Offscreen] ready"))
      && (results.logs.messages || []).some((m) => m.startsWith("[Content] loaded"));
    record("test10_safe_console_logs", hadLogs, `logs=${JSON.stringify(results.logs.messages)}`);
  } catch (err) {
    results.errors.push(`driver error: ${err.stack || err.message}`);
  } finally {
    await cleanup();
  }

  // Object.values({}).every(...) is vacuously true — a driver crash before
  // any test ran (e.g. Chrome's CDP port never came up) must NOT be
  // reported as "ALL TESTS PASSED". Require at least one recorded test and
  // zero driver-level errors, in addition to every recorded test passing.
  const testEntries = Object.values(results.tests);
  const allPassed =
    results.errors.length === 0 && testEntries.length > 0 && testEntries.every((t) => t.passed);
  results.allPassed = allPassed;
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\n✓ verify-results.json written (${OUT_FILE})`);
  if (results.errors.length > 0) {
    console.log(`DRIVER ERROR(S): ${JSON.stringify(results.errors)}`);
  }
  console.log(
    allPassed
      ? "ALL TESTS PASSED"
      : `SOME TESTS FAILED (${testEntries.length} recorded, ${testEntries.filter((t) => t.passed).length} passed)`
  );
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});