/**
 * Which dense backend runs, and why that one.
 *
 * Dense search now has two implementations of one contract — text in, a
 * normalized 1024-dimension vector out. `onnx` is the default and needs only
 * the verified export on disk; `python` is the legacy path from before Д-62 and
 * needs a virtualenv with torch in it. Nothing else in the server chooses
 * between them: it asks here and gets a name plus a sentence saying why, so the
 * answer is the same one `embedding_status`, `dense:doctor` and the health
 * check all report.
 *
 * Pure on purpose. Both probes arrive as plain booleans, so every combination —
 * including the two that only happen on a stranger's machine — is a test case
 * rather than a fixture.
 */

/** The ONNX backend's name, as it appears in status payloads and index metadata. */
export const DENSE_ONNX_BACKEND = "onnx";

/** The legacy Python backend's name. */
export const DENSE_PYTHON_BACKEND = "python";

/** What `AI_DEV_DENSE_BACKEND` accepts. */
export const DENSE_BACKEND_CHOICES = Object.freeze(["auto", DENSE_ONNX_BACKEND, DENSE_PYTHON_BACKEND]);

/**
 * Read the requested backend out of the environment.
 *
 * An unreadable value is `auto` rather than an error: this is consulted on
 * every search, and a typo in a shell profile must not make the server refuse
 * to answer. What it does instead is say so, through the `note` the caller can
 * surface.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ requested: string, note: string }}
 */
export function requestedDenseBackend(env = {}) {
  const raw = String(env.AI_DEV_DENSE_BACKEND ?? "").trim().toLowerCase();
  if (!raw) return { requested: "auto", note: "" };
  if (DENSE_BACKEND_CHOICES.includes(raw)) return { requested: raw, note: "" };
  return {
    requested: "auto",
    note: `AI_DEV_DENSE_BACKEND=${raw} is not one of ${DENSE_BACKEND_CHOICES.join(", ")}; using auto.`
  };
}

/**
 * Pick the backend.
 *
 * `auto` prefers ONNX whenever its model is verified on disk, falls back to the
 * Python stack when that one is complete, and otherwise reports that dense is
 * not installed — which is a state, not a failure: hybrid search runs its
 * keyword and sparse halves without any model at all (docs/DEFECTS.md, Д-59).
 *
 * An explicit choice is honoured even when it cannot run, and the reason names
 * the thing that is missing. Silently falling back from an explicit
 * `AI_DEV_DENSE_BACKEND=onnx` to Python would hide exactly the migration this
 * change exists to make visible.
 *
 * @param {object} options
 * @param {string} [options.requested] - "auto", "onnx" or "python".
 * @param {boolean} [options.onnxReady] - Export verified against the manifest.
 * @param {boolean} [options.pythonReady] - Interpreter and weights both present.
 * @returns {{ backend: string, available: boolean, reason: string, requested: string }}
 */
export function selectDenseBackend({ requested = "auto", onnxReady = false, pythonReady = false } = {}) {
  const choice = DENSE_BACKEND_CHOICES.includes(requested) ? requested : "auto";

  if (choice === DENSE_ONNX_BACKEND) {
    return {
      backend: DENSE_ONNX_BACKEND,
      available: Boolean(onnxReady),
      requested: choice,
      reason: onnxReady
        ? "AI_DEV_DENSE_BACKEND=onnx, and the verified export is on disk."
        : "AI_DEV_DENSE_BACKEND=onnx, but the export is not on disk. Run `npm run setup -- --dense`."
    };
  }

  if (choice === DENSE_PYTHON_BACKEND) {
    return {
      backend: DENSE_PYTHON_BACKEND,
      available: Boolean(pythonReady),
      requested: choice,
      reason: pythonReady
        ? "AI_DEV_DENSE_BACKEND=python, and the legacy Python stack is installed."
        : "AI_DEV_DENSE_BACKEND=python, but the legacy stack is incomplete. Run `npm run setup -- --dense-python`."
    };
  }

  if (onnxReady) {
    return {
      backend: DENSE_ONNX_BACKEND,
      available: true,
      requested: "auto",
      reason: "The verified ONNX export is on disk; no Python is involved."
    };
  }
  if (pythonReady) {
    return {
      backend: DENSE_PYTHON_BACKEND,
      available: true,
      requested: "auto",
      reason: "No ONNX export here, but the legacy Python stack is installed; using it."
    };
  }
  return {
    backend: DENSE_ONNX_BACKEND,
    available: false,
    requested: "auto",
    reason: "Dense search is not installed. Run `npm run setup -- --dense` to download the model (no Python needed)."
  };
}
