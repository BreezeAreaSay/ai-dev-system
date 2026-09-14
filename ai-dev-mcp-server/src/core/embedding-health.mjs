/**
 * What the dense search backend needs, and what its absence actually means.
 *
 * Extracted from `system-health.mjs`, which is at its line ceiling, and grown
 * there rather than here because the question it answers turned out to be about
 * the *environment* rather than about files: the same missing weights mean
 * "download them" in a clone, "mount them" in a container built without the
 * Python stack, and "your install is half-built" in a clone whose download was
 * interrupted. One sentence covered all three, and two of them it sent the
 * reader to a command that cannot work where they are (docs/DEFECTS.md, Д-59).
 */

/**
 * Availability keys the BGE-M3 backend needs before dense search can run.
 *
 * The search index is deliberately not one of them. It used to be, and because
 * a missing index is not a model file, its absence tipped the whole check from
 * the soft "dense is not set up" into a critical failure naming five missing
 * files — so a fresh container, which has no index until its first start builds
 * one, reported one missing artefact as two critical failures. The index has
 * its own critical check, `search_index_file`, which says so once.
 */
export const EMBEDDING_BACKEND_REQUIREMENTS = Object.freeze([
  "embeddings_python",
  "embed_helper",
  "worker_helper",
  "model_dir",
  "model_file",
  "modules_file"
]);

/**
 * The requirements that arrive only with the optional dense step.
 *
 * The helpers ship with the repository; the Python environment and the weights
 * are built by `npm run setup -- --dense` — the step's own description calls it
 * "a Python environment plus 2.3 GB of weights" — so a clone that never asked
 * for them is not broken. Reporting their absence as a failure met every new
 * user with "Health: fail" on a correct install, measured on a clean clone on
 * both Linux and Windows.
 */
export const EMBEDDING_MODEL_REQUIREMENTS = Object.freeze([
  "embeddings_python",
  "model_dir",
  "model_file",
  "modules_file"
]);

/**
 * What to do about missing weights, in the environment the reader is in.
 *
 * The published image is built with `INSTALL_BGE_M3=0` and says so through
 * `AI_DEV_DENSE_INSTALLED`; inside it `npm run setup -- --dense` is not a thing
 * a user can run, and the weights arrive by mount instead.
 *
 * @param {{ installed?: boolean|null, reason?: string }} [dense] - From `embedding_status`.
 * @returns {string}
 */
export function denseSetupAdvice(dense = {}) {
  if (dense.reason === "image-opt-out") {
    return "This image was built without the BGE-M3 Python stack (INSTALL_BGE_M3=0). "
      + "Mount the weights — point AI_DEV_MODEL_PATH at the folder holding them before `docker/run-mcp.sh` — "
      + "or build an image variant with `--build-arg INSTALL_BGE_M3=1`.";
  }
  if (dense.reason === "image-opt-in") {
    return "This image carries the BGE-M3 Python stack, but weights are never in an image: "
      + "point AI_DEV_MODEL_PATH at the folder holding them before `docker/run-mcp.sh`.";
  }
  return "Run `npm run setup -- --dense` to enable it.";
}

/**
 * Grade the embedding backend from an `embedding_status` payload.
 *
 * Three outcomes rather than two. A shipped helper missing is a real failure.
 * Weights missing where nothing dense was ever installed is `skipped` — nobody
 * has to have the model. Weights missing where the Python stack *is* installed
 * is a `warn`: something was set up and did not finish, which is worth saying
 * out loud without failing a correct install.
 *
 * @param {{ availability?: object, workers?: object, dense?: object }} status
 * @returns {{ status: string, summary: string, details: object }}
 */
export function evaluateEmbeddingBackend(status) {
  const missing = EMBEDDING_BACKEND_REQUIREMENTS.filter((key) => !status.availability?.[key]?.exists);
  const dense = status.dense || {};
  const shared = { missing, dense, availability: status.availability, workers: status.workers };
  // Everything missing is model weights, and those are an opt-in download.
  // Anything else missing is a shipped file that should be there.
  const onlyModel = missing.length > 0 && missing.every((key) => EMBEDDING_MODEL_REQUIREMENTS.includes(key));
  if (onlyModel) {
    const advice = denseSetupAdvice(dense);
    if (dense.installed) {
      return {
        status: "warn",
        summary: `Dense search is installed but cannot run: ${missing.join(", ")} missing. ${advice}`,
        details: shared
      };
    }
    return {
      status: "skipped",
      summary: `Dense search is not set up: the model weights are not here. ${advice}`,
      details: { ...shared, optional: true }
    };
  }
  if (missing.length) {
    return {
      status: "fail",
      summary: `Embedding backend is missing required files: ${missing.join(", ")}.`,
      details: shared
    };
  }
  return {
    status: "ok",
    summary: status.workers.count > 0
      ? `Embedding backend files exist; ${status.workers.count} worker(s) currently tracked.`
      : "Embedding backend files exist; worker is not started yet.",
    details: {
      backend: status.backend,
      dense_model: status.dense_model,
      dense_dimensions: status.dense_dimensions,
      configured_device: status.configured_device,
      dense,
      workers: status.workers,
      paths: status.paths
    }
  };
}
