#!/usr/bin/env node
/**
 * `npm run dense:doctor` — can this machine run dense search, and if not, where
 * exactly does it stop?
 *
 * The stages and the wording are in `src/core/dense-doctor.mjs`; this file is
 * the half that touches the real dependencies. It deliberately imports nothing
 * from `mcp-stdio.mjs`: the point is to answer on a machine where the server
 * may not start, and loading a vault to ask about a model directory would make
 * the diagnostic depend on the thing being diagnosed.
 *
 * Exit code 0 when dense search is ready, 1 when it is not, so a script can
 * branch on it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { legacyDenseNotes } from "../src/core/dense-backend.mjs";
import { createOnnxDenseRuntime, defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { denseDoctorStages, renderDenseDoctorReport, runDenseDoctor } from "../src/core/dense-doctor.mjs";
import { readDenseManifest } from "../src/core/dense-manifest.mjs";
import { proxyFor } from "../src/core/http-download.mjs";
import { denseRuntimeSupport, modelStatus, verifyModel } from "../src/core/model-manager.mjs";
import { resolveRuntimeStateRoot } from "../src/core/runtime-home.mjs";

const modelDir = defaultOnnxModelDir({ env: process.env });
let runtime = null;

/** The ONNX runtime, made once and reused by the load and embed stages. */
function denseRuntime(manifest) {
  if (!runtime) {
    runtime = createOnnxDenseRuntime({
      modelDir,
      manifest,
      spawnWorker: ({ modelDir: dir, manifest: pinned }) => new Worker(
        new URL("../src/workers/dense-onnx-worker.mjs", import.meta.url),
        { workerData: { modelDir: dir, manifest: { ...pinned } } }
      )
    });
  }
  return runtime;
}

const result = await runDenseDoctor(denseDoctorStages({
  nodeVersion: process.version,
  support: () => denseRuntimeSupport(),
  loadRuntime: () => import("onnxruntime-node"),
  readManifest: () => readDenseManifest(),
  // Every byte, as a diagnostic should; what stopped partway comes from the
  // same status the setup step reads.
  verifyFiles: async (manifest) => ({
    ...await verifyModel({ manifest, dir: modelDir }),
    partial: (await modelStatus({ manifest, dir: modelDir, env: process.env })).partial
  }),
  loadModel: async (manifest) => {
    // Loading is not separately observable, so the cheapest possible embedding
    // stands in for it: if this returns, the session opened.
    const started = Date.now();
    await denseRuntime(manifest).embedTexts({ texts: ["warm"], include_embeddings: false });
    return { seconds: Number(((Date.now() - started) / 1000).toFixed(2)) };
  },
  embedProbe: async (manifest) => {
    const started = Date.now();
    const answer = await denseRuntime(manifest).embedTexts({ texts: ["dense search probe"] });
    return {
      vector: answer.embeddings[0] ?? [],
      seconds: Number(((Date.now() - started) / 1000).toFixed(3))
    };
  }
}));

process.stdout.write(`Model directory: ${modelDir}\n`);
try {
  const { modelSources } = await import("../src/core/dense-download.mjs");
  const sources = modelSources(readDenseManifest(), process.env);
  const proxy = sources.length ? proxyFor(sources[0], process.env) : null;
  process.stdout.write(`Download from: ${sources.map((source) => new URL(source).host).join(", ") || "nowhere, the manifest lists no sources"}`
    + `${proxy ? ` (through the proxy ${proxy.host})` : ""}\n`);
} catch (error) {
  process.stdout.write(`Download from: ${error.message}\n`);
}
const legacyDir = process.env.BGE_M3_MODEL_DIR || path.join(resolveRuntimeStateRoot("", process.env), "models", "bge-m3");
for (const note of legacyDenseNotes(process.env, { legacyWeightsDir: existsSync(path.join(legacyDir, "pytorch_model.bin")) ? legacyDir : "" })) {
  process.stdout.write(`Note: ${note}\n`);
}
process.stdout.write(renderDenseDoctorReport(result));
if (runtime) await runtime.shutdown();
process.exitCode = result.ready ? 0 : 1;
