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
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { createOnnxDenseRuntime, defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { denseDoctorStages, renderDenseDoctorReport, runDenseDoctor } from "../src/core/dense-doctor.mjs";
import { readDenseManifest, verifyDenseModelDirectory } from "../src/core/dense-manifest.mjs";

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
  loadRuntime: () => import("onnxruntime-node"),
  readManifest: () => readDenseManifest(),
  verifyFiles: (manifest) => verifyDenseModelDirectory({ manifest, dir: modelDir }),
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
process.stdout.write(`Backend: onnx (set AI_DEV_DENSE_BACKEND=python for the legacy path)\n`);
process.stdout.write(renderDenseDoctorReport(result));
if (runtime) await runtime.shutdown();
process.exitCode = result.ready ? 0 : 1;
