/**
 * The thread that actually runs BGE-M3.
 *
 * It lives here rather than in `src/core/` because it is an entry point, not a
 * module: nothing imports it, `new Worker(...)` starts it, and the pool that
 * does is `src/core/dense-onnx.mjs`. Everything decidable — batching, timeouts,
 * a worker that dies mid-request — is decided there against a stub, so this
 * file holds only what genuinely needs the model loaded, and the gated
 * inference test is what covers it.
 *
 * Why a thread at all: `onnxruntime-node`'s inference call is synchronous
 * native work. Run on the main thread it would hold the MCP stdio loop for the
 * length of an indexing pass. See the note in `dense-onnx.mjs`.
 *
 * Protocol, both directions over `postMessage`:
 *   out: { type: "ready", ok, load_seconds } | { type: "ready", ok: false, error }
 *   in:  { id, method: "embed", texts, normalize, precision }
 *   out: { id, ok: true, embeddings } | { id, ok: false, error }
 */
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;

/**
 * Load the feature-extraction pipeline from the verified local directory.
 *
 * `allowRemoteModels = false` is the point: the export is downloaded once, by
 * checksum, through `dense-download.mjs`. A library that could quietly fetch a
 * different revision when a file looks missing would undo the whole manifest.
 *
 * transformers.js resolves a model as `${env.localModelPath}/${id}`, so the
 * model directory is split into its parent and its name rather than handed over
 * whole.
 *
 * @param {{ modelDir: string, manifest: object }} options
 * @returns {Promise<Function>} The extractor.
 */
async function loadExtractor({ modelDir, manifest }) {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.dirname(modelDir);
  // The dtype decides which file is loaded: "int8" resolves onnx/model_int8.onnx,
  // which is the file the manifest pins a sha256 for. Changing the dtype in the
  // manifest changes the weights loaded here and nothing else.
  return pipeline("feature-extraction", path.basename(modelDir), {
    dtype: manifest.dtype,
    local_files_only: true
  });
}

/**
 * Round one vector to the precision the index stores.
 *
 * Duplicated from `dense-onnx.mjs` rather than imported: rounding here means
 * the numbers that cross the thread boundary are already the ones that get
 * stored, instead of a full-precision copy being serialised and then discarded.
 *
 * @param {ArrayLike<number>} values
 * @param {number} precision
 * @returns {number[]}
 */
function roundVector(values, precision) {
  const factor = 10 ** precision;
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result[index] = Math.round(Number(values[index]) * factor) / factor;
  }
  return result;
}

let extractor = null;

try {
  const started = Date.now();
  extractor = await loadExtractor(workerData);
  port.postMessage({ type: "ready", ok: true, load_seconds: Number(((Date.now() - started) / 1000).toFixed(3)) });
} catch (error) {
  // The pool turns this into the caller's error. A stack trace here would reach
  // a user who asked for a search, so only the message travels.
  port.postMessage({ type: "ready", ok: false, error: String(error?.message ?? error) });
}

port.on("message", async (message) => {
  if (!message || message.method !== "embed") return;
  try {
    const output = await extractor(message.texts, {
      pooling: workerData.manifest.pooling || "cls",
      normalize: message.normalize !== false
    });
    const rows = output.tolist();
    port.postMessage({
      id: message.id,
      ok: true,
      embeddings: rows.map((row) => roundVector(row, message.precision ?? 6))
    });
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: String(error?.message ?? error) });
  }
});
