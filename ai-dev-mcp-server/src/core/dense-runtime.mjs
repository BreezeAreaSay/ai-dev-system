/**
 * The one place that answers "which dense backend, and can it run right now".
 *
 * Everything dense goes through here: the query vector a hybrid search needs,
 * the passage vectors an index rebuild needs, what `embedding_status` reports
 * and what `dense:doctor` checks. Before Д-62 there was one backend and the
 * answer was implicit; with two there has to be a single answer, or the status
 * tool, the health check and the rebuild can each decide differently and a user
 * gets three accounts of one machine.
 *
 * The probes are injected. Verifying the ONNX export means hashing hundreds of
 * megabytes, so the result is cached until something asks for a fresh look —
 * a search must not re-hash the weights to embed one query.
 */
import { DENSE_ONNX_BACKEND, DENSE_PYTHON_BACKEND, requestedDenseBackend, selectDenseBackend } from "./dense-backend.mjs";
import { denseVectorProvenance, verifyDenseModelDirectory } from "./dense-manifest.mjs";

/** How long a verification result stands before it is taken again. */
export const DENSE_PROBE_TTL_MS = 60_000;

/** What the legacy Python export's vectors are, as provenance. */
export const LEGACY_DENSE_DTYPE = "fp32";

/**
 * The revision the legacy Python path pins, when it pins one.
 *
 * `snapshot_download("BAAI/bge-m3")` without a revision is the unpinned download
 * Д-62 point 1 is about. The ONNX export is pinned by the manifest; the torch
 * repository is a different repository with a different commit, and this
 * sandbox cannot reach huggingface.co to read it — so the plumbing takes the
 * value and the value itself is configuration. Unset means unpinned, and the
 * index records it as such rather than implying a pin that is not there.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function legacyDenseRevision(env = {}) {
  return String(env.BGE_M3_PYTHON_REVISION ?? "").trim() || "unpinned";
}

/**
 * Create the dense runtime.
 *
 * @param {object} deps
 * @param {object} deps.manifest - The parsed dense manifest.
 * @param {string} deps.onnxModelDir
 * @param {object} deps.onnxRuntime - From `createOnnxDenseRuntime`.
 * @param {object} deps.pythonRuntime - From `createEmbeddingRuntime`.
 * @param {() => Promise<boolean>} deps.pythonReady - Legacy stack complete?
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(options: object) => Promise<object>} [deps.verify] - Injected for tests.
 * @param {() => number} [deps.now]
 * @returns {object}
 */
export function createDenseRuntime({
  manifest,
  onnxModelDir,
  onnxRuntime,
  pythonRuntime,
  pythonReady,
  env = {},
  verify = verifyDenseModelDirectory,
  now = () => Date.now()
}) {
  let probe = null;
  let probedAt = 0;

  /** Verify the ONNX export, at most once a minute unless forced. */
  async function onnxStatus({ refresh = false } = {}) {
    if (!refresh && probe && now() - probedAt < DENSE_PROBE_TTL_MS) return probe;
    probe = await verify({ manifest, dir: onnxModelDir });
    probedAt = now();
    return probe;
  }

  /**
   * Which backend runs, whether it can, and what its vectors would be.
   *
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function describe({ refresh = false } = {}) {
    const { requested, note } = requestedDenseBackend(env);
    const onnx = await onnxStatus({ refresh });
    const legacy = await pythonReady().catch(() => false);
    const choice = selectDenseBackend({ requested, onnxReady: onnx.ready, pythonReady: legacy });
    const provenance = choice.backend === DENSE_ONNX_BACKEND
      ? denseVectorProvenance(manifest, DENSE_ONNX_BACKEND)
      : {
        backend: DENSE_PYTHON_BACKEND,
        model: manifest.model,
        revision: legacyDenseRevision(env),
        dtype: LEGACY_DENSE_DTYPE,
        dimensions: manifest.dimensions
      };
    return {
      ...choice,
      note,
      provenance,
      onnx: {
        ready: onnx.ready,
        dir: onnx.dir,
        missing: onnx.missing,
        mismatched: onnx.mismatched,
        revision: manifest.revision,
        dtype: manifest.dtype,
        export: manifest.export
      },
      python: { ready: legacy }
    };
  }

  /**
   * Embed through whichever backend is running.
   *
   * The two runtimes answer in the same shape, so callers — a hybrid query, an
   * index rebuild, the `embed_texts` tool — do not branch on the backend.
   *
   * @param {object} payload
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async function embed(payload, options = {}) {
    const chosen = await describe();
    if (!chosen.available) throw new Error(chosen.reason);
    if (chosen.backend === DENSE_ONNX_BACKEND) return onnxRuntime.embedTexts(payload);
    return pythonRuntime.request(payload, options);
  }

  /** Stop whatever is running. Best effort, as on process shutdown it always is. */
  async function shutdown() {
    await onnxRuntime.shutdown().catch(() => {});
    pythonRuntime.shutdown();
  }

  return { describe, embed, onnxStatus, shutdown };
}
