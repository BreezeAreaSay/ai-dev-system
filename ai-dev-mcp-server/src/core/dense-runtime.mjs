/**
 * The one place that answers "can dense search run here, and with what".
 *
 * Everything dense goes through here: the query vector a hybrid search needs,
 * the passage vectors an index rebuild needs, `embed_texts`, the semantic
 * duplicate check, what `embedding_status` reports and what the health check
 * grades. One answer for all of them, or each decides differently and a user
 * gets several accounts of one machine — and two of them went to a Python pool
 * the selected backend never was (docs/DEFECTS.md, Д-133, Д-144).
 *
 * "Is the model there" is answered from the record the last check left beside
 * the cache: an unchanged file is not read again, so the answer costs a few
 * `stat` calls rather than hashing 570 MB a minute (Д-143). It is still kept
 * for a minute, because a search asks it every time.
 */
import fs from "node:fs";
import path from "node:path";
import { DENSE_INSTALL_COMMAND, legacyDenseNotes, requestedDenseBackend, selectDenseBackend } from "./dense-backend.mjs";
import { usablePart } from "./dense-download.mjs";
import { denseVectorProvenance, verifiedStampPath, verifyDenseModelDirectory } from "./dense-manifest.mjs";
import { denseRuntimeSupport } from "./model-manager.mjs";

/** How long a verification result stands before it is taken again. */
export const DENSE_PROBE_TTL_MS = 60_000;

/**
 * Create the dense runtime.
 *
 * @param {object} deps
 * @param {object} deps.manifest - The parsed dense manifest.
 * @param {string} deps.onnxModelDir
 * @param {object} deps.onnxRuntime - From `createOnnxDenseRuntime`.
 * @param {string} [deps.stampDir] - Where verification records are kept; none, every check hashes.
 * @param {string} [deps.legacyModelDir] - Where a 2.x install kept its torch weights.
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(options: object) => Promise<object>} [deps.verify] - Injected for tests.
 * @param {() => { supported: boolean, reason: string }} [deps.support] - Injected for tests.
 * @param {(target: string) => boolean} [deps.exists]
 * @param {() => number} [deps.now]
 * @returns {object}
 */
export function createDenseRuntime({
  manifest,
  onnxModelDir,
  onnxRuntime,
  stampDir = "",
  legacyModelDir = "",
  env = {},
  verify = verifyDenseModelDirectory,
  support = () => denseRuntimeSupport(),
  exists = fs.existsSync,
  now = () => Date.now()
}) {
  let probe = null;
  let probedAt = 0;
  let supportAnswer = null;
  const stampFile = stampDir ? verifiedStampPath(stampDir, onnxModelDir) : "";

  /**
   * Verify the export, at most once a minute unless forced. Forced means
   * every file is read again, as `embedding_status {refresh: true}` asks.
   */
  async function onnxStatus({ refresh = false } = {}) {
    if (!refresh && probe && now() - probedAt < DENSE_PROBE_TTL_MS) return probe;
    probe = await verify({ manifest, dir: onnxModelDir, stampFile, trustStamp: !refresh });
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
    supportAnswer ??= support();
    const onnx = await onnxStatus({ refresh });
    const choice = selectDenseBackend({
      requested,
      onnxReady: onnx.ready,
      supported: supportAnswer.supported,
      supportReason: supportAnswer.reason,
      inContainer: String(env.AI_DEV_RUNTIME ?? "") === "docker"
    });
    const legacyWeightsDir = legacyModelDir && exists(path.join(legacyModelDir, "pytorch_model.bin")) ? path.resolve(legacyModelDir) : "";
    const legacy = legacyDenseNotes(env, { legacyWeightsDir });
    return {
      ...choice,
      note,
      provenance: denseVectorProvenance(manifest, choice.backend),
      onnx: {
        ready: onnx.ready,
        dir: onnx.dir,
        missing: onnx.missing,
        mismatched: onnx.mismatched,
        revision: manifest.revision,
        dtype: manifest.dtype,
        export: manifest.export
      },
      legacy: { notes: legacy, command: legacy.length ? DENSE_INSTALL_COMMAND : "" }
    };
  }

  /**
   * Embed through the model, or say why it cannot.
   *
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function embed(payload) {
    const chosen = await describe();
    if (!chosen.available) throw new Error(chosen.reason);
    return onnxRuntime.embedTexts(payload);
  }

  /**
   * The `embedding_status` payload: the backend and why, the model folder,
   * downloads that stopped partway, the worker, and what is left of 2.x.
   * Loads no model.
   *
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function status({ refresh = false } = {}) {
    const selected = await describe({ refresh: Boolean(refresh) });
    const partial = [];
    for (const relative of selected.onnx.missing ?? []) {
      const part = await usablePart(path.join(path.resolve(onnxModelDir), relative), { revision: manifest.revision, sha256: manifest.files[relative] });
      if (part.bytes > 0) partial.push({ file: relative, bytes: part.bytes, size: part.size });
    }
    return {
      backend: selected.backend,
      dense_model: manifest.model,
      dense_dimensions: manifest.dimensions,
      dense_revision: manifest.revision,
      model_dir: path.resolve(onnxModelDir),
      installed: selected.onnx.ready,
      available: selected.available,
      reason: selected.reason,
      partial,
      worker: onnxRuntime.status?.().worker ?? { started: false },
      dense_backend: selected
    };
  }

  /** Stop the worker. Best effort, as on process shutdown it always is. */
  async function shutdown() {
    await onnxRuntime.shutdown().catch(() => {});
  }

  return { describe, embed, onnxStatus, status, shutdown };
}
