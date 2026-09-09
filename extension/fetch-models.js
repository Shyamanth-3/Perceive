#!/usr/bin/env node
/*
 * One-time (or re-run-when-stale) download of the bundled local-vision
 * model weights (Phase 4). This is the ONLY place in the Dev 1 toolchain
 * that talks to the network — it populates `models-cache/`, which `build.js`
 * then copies verbatim into `dist/models/`. The shipped extension itself
 * (`env.allowRemoteModels = false` in `vision-runtime.ts`) never fetches
 * anything at runtime.
 *
 * Files match the `Xenova/yolos-tiny` Optimum ONNX export layout expected by
 * @huggingface/transformers' local-model resolution
 * (`<localModelPath>/<model_id>/<file>`, mirroring its remote path template
 * `{model}/resolve/{revision}/{file}`), and the dtype -> filename suffix
 * mapping baked into the library (`_fp16`, `_quantized` for q8).
 */
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const MODEL_ID = "Xenova/yolos-tiny";
const REVISION = "main";
const CACHE_ROOT = path.join(__dirname, "models-cache");
const MODEL_DIR = path.join(CACHE_ROOT, MODEL_ID);

const FILES = [
  "config.json",
  "preprocessor_config.json",
  "onnx/model_fp16.onnx",
  "onnx/model_quantized.onnx",
];

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { headers: { "User-Agent": "perceive-extension-fetch-models" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.rmSync(destPath, { force: true });
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          // HF's resolve endpoint issues *relative* redirects; resolve
          // against the current URL's origin (new URL() handles both
          // relative and absolute Location headers correctly).
          const nextUrl = new URL(res.headers.location, url).toString();
          return resolve(download(nextUrl, destPath, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.rmSync(destPath, { force: true });
          return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(undefined)));
      })
      .on("error", (err) => {
        file.close();
        fs.rmSync(destPath, { force: true });
        reject(err);
      });
  });
}

async function main() {
  console.log(`[fetch-models] target: ${MODEL_ID}@${REVISION} -> ${MODEL_DIR}`);
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  for (const file of FILES) {
    const destPath = path.join(MODEL_DIR, file);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      console.log(`[fetch-models] cached, skipping: ${file}`);
      continue;
    }
    const url = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${file}`;
    console.log(`[fetch-models] downloading: ${file}`);
    await download(url, destPath);
    const size = fs.statSync(destPath).size;
    console.log(`[fetch-models] done: ${file} (${(size / 1024).toFixed(1)} KB)`);
  }

  console.log("[fetch-models] complete. Re-run `npm run build`/`npm run verify` to bundle into dist/.");
}

main().catch((err) => {
  console.error("[fetch-models] FAILED:", err.message);
  process.exit(1);
});
