/*
 * Focused runtime test: forces WebGPU unavailable (Chrome launch flag
 * `--disable-features=WebGPU`, applied BEFORE the extension or offscreen
 * document ever loads) and proves the WASM fallback path produces a real,
 * valid inference result — not just that the code compiles.
 *
 * This is master-doc Tier-2 test #4 (implementation_plan.md §9), which was
 * never previously exercised: the main `verify.js` run always has a working
 * WebGPU adapter available, so `vision-runtime.ts`'s WASM branch was only
 * ever verified by code inspection, not by a forced real failure.
 *
 * Separate script (not folded into verify.js) because it needs its own
 * Chrome launch with a different flag set — running it in the same browser
 * instance as the main suite would make every other test WASM-only too.
 *
 * Usage: node verify-wasm-fallback.js   (requires dist/ already built with
 * TEST_HOOKS=1 — run `TEST_HOOKS=1 node build.js` first, or just `npm run verify`
 * once, which leaves a usable dist/.)
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
const PORT = 9334; // different port from verify.js so both could theoretically run without colliding
const HTTP_PORT = 9798;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "perceive-wasm-fallback-"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTargetByUrl(filter, timeoutMs = 45000, label = "") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await CDP.List({ port: PORT });
      const match = list.find(filter);
      if (match) return match;
    } catch (_) {}
    await sleep(400);
  }
  throw new Error(`timeout waiting for target (${label})`);
}

async function evalIn(wsUrl, expression) {
  let client;
  try {
    client = await CDP({ target: wsUrl });
    await client.Runtime.enable();
    const res = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (res.exceptionDetails) {
      return { __evalError: true, error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
    }
    return res.result.value;
  } finally {
    if (client) await client.close();
  }
}

function localStaticServer(req, res) {
  if (req.url === "/wake.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "server", "wake.html")));
  } else {
    res.writeHead(404);
    res.end();
  }
}

async function main() {
  if (!fs.existsSync(EXT_DIR)) {
    console.error("[wasm-fallback] dist/ not found — build first (TEST_HOOKS=1 node build.js)");
    process.exit(1);
  }

  const httpServer = http.createServer(localStaticServer);
  await new Promise((resolve) => httpServer.listen(HTTP_PORT, resolve));

  console.log("[wasm-fallback] launching Chrome with --disable-features=WebGPU ...");
  const chrome = spawn(
    CHROME,
    [
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-gpu",
      "--disable-features=WebGPU", // the actual forced failure
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  const cleanup = async () => {
    try {
      chrome.kill("SIGKILL");
    } catch (_) {}
    try {
      httpServer.close();
    } catch (_) {}
  };

  let passed = false;
  let detail = "";
  try {
    let pageList = null;
    const start = Date.now();
    while (!pageList && Date.now() - start < 45000) {
      try {
        pageList = await CDP.List({ port: PORT });
      } catch (_) {
        await sleep(500);
      }
    }
    if (!pageList) throw new Error("Chrome CDP port never became reachable");
    const page = pageList.find((t) => t.type === "page");
    await evalIn(page.webSocketDebuggerUrl, `location.href='http://127.0.0.1:${HTTP_PORT}/wake.html'`);

    const swTarget = await waitForTargetByUrl(
      (t) => t.type === "service_worker" && t.url.includes("service-worker.js"),
      45000,
      "SW"
    );
    const swWs = swTarget.webSocketDebuggerUrl;

    // Confirm navigator.gpu is genuinely gone in the offscreen document
    // (not just "we didn't ask") before trusting the fallback result.
    await evalIn(swWs, `__perceiveTest.ensureAndPing()`);
    const offTarget = await waitForTargetByUrl(
      (t) => t.url && t.url.includes("offscreen/offscreen.html"),
      15000,
      "offscreen"
    );
    // The `navigator.gpu` object can still exist even with WebGPU disabled —
    // what actually matters (and what detectWebGpuBackend() itself checks)
    // is whether requestAdapter() resolves to a real adapter or null.
    const gpuCheck = await evalIn(
      offTarget.webSocketDebuggerUrl,
      `(async () => {
        if (!navigator.gpu) return { hasGpuObject: false, adapter: null };
        try {
          const adapter = await navigator.gpu.requestAdapter();
          return { hasGpuObject: true, adapter: adapter ? 'present' : null };
        } catch (e) {
          return { hasGpuObject: true, adapter: null, error: String(e) };
        }
      })()`
    );
    if (gpuCheck?.adapter) {
      throw new Error(`requestAdapter() still returned a real adapter (${JSON.stringify(gpuCheck)}) — GPU disable flags did not take effect; cannot prove a genuine forced fallback`);
    }

    let ping = null;
    for (let i = 0; i < 15 && !ping?.ok; i++) {
      ping = await evalIn(swWs, `__perceiveTest.getStatus().then(s => ({ok: s.lastPing != null}))`);
      if (!ping?.ok) await sleep(500);
    }

    const result = await evalIn(swWs, `__perceiveTest.triggerCapture('manual')`);
    passed =
      result?.superseded === false &&
      result?.analysis?.backend === "wasm" &&
      Number.isInteger(result?.analysis?.detectionCount) &&
      result?.analysis?.inferenceTimeMs >= 0;
    detail = JSON.stringify({ navigatorGpu: gpuCheck, analysis: result?.analysis, lastError: result?.lastError });
  } catch (err) {
    detail = `driver error: ${err.stack || err.message}`;
  } finally {
    await cleanup();
  }

  console.log(`[${passed ? "PASS" : "FAIL"}] test21_forced_webgpu_failure_wasm_fallback: ${detail}`);
  process.exit(passed ? 0 : 1);
}

main();
