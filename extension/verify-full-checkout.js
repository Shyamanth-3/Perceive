/*
 * Standalone, minimal full-QuickShop-checkout driver.
 *
 * Isolated from the main verify.js suite deliberately: on this constrained
 * machine, running the full 30+ test suite first accumulates enough
 * memory/CPU pressure that Chrome's own CDP endpoint can crash before
 * reaching the full-checkout scenario. This script does only what's needed
 * to prove (or disprove) the complete login->payment->confirmation->
 * task_complete workflow, against whichever backend is currently running
 * (real Groq, or LLM_PROVIDER=deterministic_test) — same real extension,
 * same real Dev 1-5 code, no mocks.
 *
 * Usage: node verify-full-checkout.js
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
const PORT = 9335;
const HTTP_PORT = 9798;
const OUT_FILE = path.join(__dirname, "verify-full-checkout-results.json");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "perceive-checkout-"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTargetByUrl(filter, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await CDP.List({ port: PORT });
      const match = list.find(filter);
      if (match) return match;
    } catch (_) {}
    await sleep(400);
  }
  throw new Error("timeout waiting for target");
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

function findIsolatedWorldId(contexts) {
  return contexts.find((c) => c.origin?.startsWith("chrome-extension://") && c.auxData?.type === "isolated")?.id;
}

async function evalInContentWorld(pageWs, expression) {
  let client;
  try {
    client = await CDP({ target: pageWs });
    const contexts = [];
    client.Runtime.on("executionContextCreated", (p) => contexts.push(p.context));
    await client.Runtime.enable();
    const start = Date.now();
    let contextId = null;
    while (!contextId && Date.now() - start < 15000) {
      contextId = findIsolatedWorldId(contexts) ?? null;
      if (!contextId) await sleep(100);
    }
    if (!contextId) throw new Error("content-script isolated world not found");
    const res = await client.Runtime.evaluate({ expression, contextId, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (res.exceptionDetails) {
      return { __evalError: true, error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
    }
    return res.result.value;
  } finally {
    if (client) await client.close();
  }
}

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

function localStaticServer(req, res) {
  if (req.url === "/quickshop/index.html" || req.url === "/quickshop/") {
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
  const result = { meta: {}, steps: {}, final: {}, error: null };
  const profileServer = http.createServer(localStaticServer);
  await new Promise((resolve) => profileServer.listen(HTTP_PORT, resolve));

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
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  const cleanup = async () => {
    try {
      chrome.kill("SIGKILL");
    } catch (_) {}
    try {
      profileServer.close();
    } catch (_) {}
  };

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
    if (!pageList) throw new Error(`Chrome CDP port ${PORT} never became reachable`);
    const page = pageList.find((t) => t.type === "page");

    const swTarget = await waitForTargetByUrl((t) => t.type === "service_worker" && t.url.includes("service-worker.js"));
    result.meta.swFound = true;

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
    result.steps.qsReady = qsReady;

    const swWs = swTarget.webSocketDebuggerUrl;
    const idleStatus = await waitForOrchestratorIdle(swWs);
    result.steps.idleStatusBeforeStart = idleStatus?.orchestrator;

    await evalInContentWorld(
      page.webSocketDebuggerUrl,
      `(() => { window.__stages = []; window.addEventListener('perceive-pipeline-event', (e) => window.__stages.push({stage: e.detail.stage, actionType: e.detail.actionType, targetElementId: e.detail.targetElementId, riskTier: e.detail.riskTier, approved: e.detail.approved, reason: e.detail.reason}));
                 window.addEventListener('agent-session-end', (e) => window.__sessionEnd = e.detail); return true; })()`
    );

    let taskError = null;
    if (qsReady?.ok) {
      try {
        await evalInContentWorld(
          page.webSocketDebuggerUrl,
          `(() => { window.__checkoutPromise = __perceiveRunTaskLoop('Log in to the account using the pre-filled credentials, then on the checkout page submit the payment using the saved payment method already on file to complete the order.'); return true; })()`
        );
      } catch (err) {
        taskError = String(err?.message || err);
      }
    }

    let finalResult = null;
    const MAX_TICKS = 400;
    for (let i = 0; i < MAX_TICKS && finalResult === null; i++) {
      const overlayVisible = await evalIn(
        page.webSocketDebuggerUrl,
        `(() => { const b = document.getElementById('confirmation-allow'); return !!b && b.offsetParent !== null; })()`
      );
      if (overlayVisible === true) {
        await evalIn(page.webSocketDebuggerUrl, `(() => { document.getElementById('confirmation-allow').click(); return true; })()`);
      }
      try {
        const settled = await evalInContentWorld(
          page.webSocketDebuggerUrl,
          `Promise.race([window.__checkoutPromise.then(r => ({done:true, r})), new Promise(res => setTimeout(() => res({done:false}), 400))])`
        );
        if (settled?.done) finalResult = settled.r;
      } catch (err) {
        taskError = taskError || String(err?.message || err);
        break;
      }
    }
    result.steps.taskError = taskError;
    result.steps.taskResult = finalResult;
    result.steps.stagesSeen = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__stages ?? []`).catch(() => []);
    result.steps.sessionEnd = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__sessionEnd ?? null`).catch(() => null);
    result.steps.backendFetchAttempts = await evalInContentWorld(page.webSocketDebuggerUrl, `window.__perceiveLastBackendFetchAttempts ?? []`).catch(() => []);

    result.final.loginSectionHidden = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('login-section')?.classList.contains('hidden') ?? null`
    );
    result.final.checkoutSectionVisible = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('checkout-section') ? !document.getElementById('checkout-section').classList.contains('hidden') : null`
    );
    result.final.confirmationSectionVisible = await evalIn(
      page.webSocketDebuggerUrl,
      `document.getElementById('confirmation-section') ? !document.getElementById('confirmation-section').classList.contains('hidden') : null`
    );
    result.final.fieldValues = await evalIn(
      page.webSocketDebuggerUrl,
      `(() => { const ids=['full-name','card-number','card-expiry','card-cvv','phone','billing-address','aadhaar']; const o={}; for (const id of ids){ const el=document.getElementById(id); o[id]= el ? el.value : null;} return o; })()`
    );
  } catch (err) {
    result.error = String(err?.stack || err);
  } finally {
    await cleanup();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nwritten -> ${OUT_FILE}`);
}

main();
