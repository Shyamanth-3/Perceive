/*
 * Perceive production build.
 *
 * - Compiles TS and bundles the three extension contexts with esbuild.
 *   Service Worker and Offscreen are ES modules (MV3 `type: module` and
 *   `<script type="module">`); Content Script is an IIFE.
 * - Copies manifest.json and the offscreen HTML document into dist/.
 * - Phase 4: copies the ONNX Runtime Web WASM binaries (from
 *   @huggingface/transformers' bundled onnxruntime-web) into dist/wasm/, and
 *   the locally-cached `Xenova/yolos-tiny` weights (see `fetch-models.js`,
 *   `models-cache/`) into dist/models/ — both declared as
 *   `web_accessible_resources` in manifest.json. Missing model/wasm assets
 *   are a WARNING, not a build failure: Phase 1-3 (capture/reactivity) work
 *   without them, and `npm run fetch-models` populates them on demand.
 * - Completes in a clean dist/ (stale output removed first).
 * - Fails loudly (non-zero exit + message) on any build error.
 *
 * TEST_HOOKS=1 (via `npm run build:test-hooks`) additionally exposes the
 * `__perceiveTest` / `__perceiveOffscreen` / `__perceive*` hooks used by
 * verify.js. The default `npm run build` output contains NO test hooks.
 * Model/wasm assets are bundled identically in both build modes (they are
 * local files either way, never fetched at runtime — see `vision-runtime.ts`).
 */

"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, ".");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

const TEST_HOOKS = process.env.TEST_HOOKS === "1";

function fail(message, cause) {
  console.error(`[build] FAILED: ${message}`);
  if (cause) console.error((cause && cause.stack) || cause);
  process.exit(1);
}

async function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, "background"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "content"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "offscreen"), { recursive: true });

  const base = {
    bundle: true,
    sourcemap: false,
    minify: false,
    target: "chrome116",
    logLevel: "info",
    define: {
      "process.env.TEST_HOOKS": JSON.stringify(TEST_HOOKS ? "1" : "0"),
    },
  };

  const entries = [
    {
      entry: path.join(srcDir, "background", "service-worker.ts"),
      out: path.join(distDir, "background", "service-worker.js"),
      format: "esm",
    },
    {
      entry: path.join(srcDir, "content", "content-script.ts"),
      out: path.join(distDir, "content", "content-script.js"),
      format: "iife",
    },
    {
      entry: path.join(srcDir, "offscreen", "offscreen.ts"),
      out: path.join(distDir, "offscreen", "offscreen.js"),
      format: "esm",
    },
  ];

  try {
    await Promise.all(
      entries.map((e) =>
        esbuild.build({ ...base, entryPoints: [e.entry], outfile: e.out, format: e.format })
      )
    );
  } catch (cause) {
    fail("esbuild bundle step", cause);
  }

  try {
    fs.copyFileSync(path.join(srcDir, "manifest.json"), path.join(distDir, "manifest.json"));
    fs.copyFileSync(
      path.join(srcDir, "offscreen", "offscreen.html"),
      path.join(distDir, "offscreen", "offscreen.html")
    );
  } catch (cause) {
    fail("asset copy step", cause);
  }

  copyWasmAssets();
  copyModelAssets();

  const lantern = Buffer.from(
    fs.readFileSync(path.join(distDir, "manifest.json")).toString()
  ).length;
  console.log(`[build] complete -> ${path.join(distDir)} (manifest ${lantern} bytes)`);
  console.log(`[build] test hooks: ${TEST_HOOKS ? "ENABLED" : "disabled"}`);
}

/** Copy ONNX Runtime Web's WASM binaries + glue (bundled inside the
 * @huggingface/transformers dependency) into dist/wasm/. Warns (does not
 * fail the build) if the dependency isn't installed yet — Phases 1-3 don't
 * need it. */
function copyWasmAssets() {
  // npm may hoist onnxruntime-web to the top level (no version conflict) or
  // nest it under @huggingface/transformers/node_modules (version pinned);
  // check both layouts.
  const candidates = [
    path.join(root, "node_modules", "onnxruntime-web", "dist"),
    path.join(
      root,
      "node_modules",
      "@huggingface",
      "transformers",
      "node_modules",
      "onnxruntime-web",
      "dist"
    ),
  ];
  const wasmSrc = candidates.find((p) => fs.existsSync(p));
  if (!wasmSrc) {
    console.warn(
      "[build] WARNING: onnxruntime-web wasm assets not found (run `npm install`); dist/wasm/ will be empty. Phase 4 inference will not work until this is fixed."
    );
    return;
  }
  const wasmOut = path.join(distDir, "wasm");
  fs.mkdirSync(wasmOut, { recursive: true });
  const files = fs
    .readdirSync(wasmSrc)
    .filter((f) => f.startsWith("ort-wasm") || f === "ort.wasm.mjs" || f === "ort.wasm.js");
  files.forEach((f) => fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmOut, f)));
  console.log(`[build] copied ${files.length} wasm asset(s) -> dist/wasm/`);
}

/** Copy the locally-cached Xenova/yolos-tiny weights (populated by
 * `npm run fetch-models`) into dist/models/. Warns (does not fail the
 * build) if the cache is empty. */
function copyModelAssets() {
  const modelsSrc = path.join(root, "models-cache");
  if (!fs.existsSync(modelsSrc)) {
    console.warn(
      "[build] WARNING: models-cache/ not found (run `npm run fetch-models`); dist/models/ will be empty. Phase 4 inference will not work until this is fixed."
    );
    return;
  }
  const modelsOut = path.join(distDir, "models");
  let fileCount = 0;
  const copyRecursive = (srcPath, outPath) => {
    fs.mkdirSync(outPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath, { withFileTypes: true })) {
      const s = path.join(srcPath, entry.name);
      const o = path.join(outPath, entry.name);
      if (entry.isDirectory()) copyRecursive(s, o);
      else {
        fs.copyFileSync(s, o);
        fileCount++;
      }
    }
  };
  copyRecursive(modelsSrc, modelsOut);
  if (fileCount === 0) {
    console.warn(
      "[build] WARNING: models-cache/ is empty (run `npm run fetch-models`); dist/models/ will be empty."
    );
  } else {
    console.log(`[build] copied ${fileCount} model asset file(s) -> dist/models/`);
  }
}

main().catch((cause) => fail("unexpected", cause));