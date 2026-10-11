/**
 * Whether dense search can run here, and what to tell the person if it cannot.
 *
 * Since 3.0 dense search has one backend: the pinned ONNX export, run by
 * onnxruntime-node in a worker thread. The legacy Python backend — a
 * virtualenv, torch and 2.3 GB of weights — is gone (decision D3,
 * docs/DEFECTS.md, Д-98). What remains of it here is its settings, read for
 * one reason: whoever still has `AI_DEV_DENSE_BACKEND=python` in a client
 * config, or a 2.x image's variables, is told in a sentence what replaced it
 * and the one command that moves them over, instead of being silently ignored.
 *
 * Pure on purpose: every probe arrives as a value, so each state — including
 * the ones only a stranger's machine reaches — is a test case.
 */

/** The backend's name, as status payloads and index metadata record it. */
export const DENSE_ONNX_BACKEND = "onnx";

/** What `AI_DEV_DENSE_BACKEND` accepts. `python` is still recognised, to explain itself. */
export const DENSE_BACKEND_CHOICES = Object.freeze(["auto", DENSE_ONNX_BACKEND]);

/** The one command that installs the model and embeds the documents with it. */
export const DENSE_INSTALL_COMMAND = "npm run setup -- --dense";

/** The command that copies the model from a folder or archive another machine made. */
export const DENSE_IMPORT_COMMAND = "npm run model -- import <folder or .zip>";

/** Variables of the removed Python backend, each with what it used to do. */
export const LEGACY_DENSE_VARIABLES = Object.freeze({
  BGE_M3_PYTHON: "the interpreter of the Python backend",
  AI_DEV_EMBEDDINGS_PYTHON: "the interpreter of the Python backend",
  AI_DEV_PYTHON_BASE: "the Python that built the backend's virtualenv",
  BGE_M3_PYTHON_REVISION: "the revision of the Python backend's weights",
  BGE_M3_MODEL_DIR: "the folder of the Python backend's torch weights"
});

/**
 * The backend the environment asks for.
 *
 * An unreadable value is `auto`, with a note, rather than an error: this is
 * read on every search, and a typo in a shell profile must not stop the server
 * answering. `python` is `auto` too — the backend it named is gone — and the
 * note says what to do about it.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ requested: string, note: string }}
 */
export function requestedDenseBackend(env = {}) {
  const raw = String(env.AI_DEV_DENSE_BACKEND ?? "").trim().toLowerCase();
  if (!raw) return { requested: "auto", note: "" };
  if (DENSE_BACKEND_CHOICES.includes(raw)) return { requested: raw, note: "" };
  if (raw === "python") {
    return {
      requested: "auto",
      note: "AI_DEV_DENSE_BACKEND=python asks for the Python backend, which 3.0 removed: dense search runs on the "
        + `ONNX model now, with no Python. Run \`${DENSE_INSTALL_COMMAND}\` once — it installs the model and embeds the `
        + "documents again — and remove the variable."
    };
  }
  return {
    requested: "auto",
    note: `AI_DEV_DENSE_BACKEND=${raw} is not one of ${DENSE_BACKEND_CHOICES.join(", ")}; using auto.`
  };
}

/**
 * What is left of a 2.x Python install on this machine, as sentences.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ legacyWeightsDir?: string }} [found] - The folder holding 2.x torch weights, when there is one.
 * @returns {string[]}
 */
export function legacyDenseNotes(env = {}, { legacyWeightsDir = "" } = {}) {
  const notes = [];
  const { note } = requestedDenseBackend(env);
  if (/python/i.test(String(env.AI_DEV_DENSE_BACKEND ?? ""))) notes.push(note);
  for (const [name, meaning] of Object.entries(LEGACY_DENSE_VARIABLES)) {
    if (String(env[name] ?? "").trim()) {
      notes.push(`${name} is set and nothing reads it any more: it named ${meaning}, which 3.0 removed. Remove it.`);
    }
  }
  if (legacyWeightsDir) {
    notes.push(`${legacyWeightsDir} holds the Python backend's torch weights (about 2.3 GB), which nothing uses any more; `
      + "once dense search works with the ONNX model, the folder can be deleted.");
  }
  return notes;
}

/**
 * Whether dense search runs, and the sentence that says why or why not.
 *
 * Not installed is a state, not a failure: hybrid search runs its keyword and
 * sparse halves without any model (docs/DEFECTS.md, Д-59). The sentence names
 * the command that changes it — a download, or a copy from another machine for
 * one that cannot reach the download — and, in a container, the mount.
 *
 * @param {object} [options]
 * @param {string} [options.requested] - "auto" or "onnx".
 * @param {boolean} [options.onnxReady] - Export verified against the manifest.
 * @param {boolean} [options.supported] - onnxruntime has a build for this machine.
 * @param {string} [options.supportReason]
 * @param {boolean} [options.inContainer]
 * @returns {{ backend: string, available: boolean, reason: string, requested: string }}
 */
export function selectDenseBackend({ requested = "auto", onnxReady = false, supported = true, supportReason = "", inContainer = false } = {}) {
  const choice = DENSE_BACKEND_CHOICES.includes(requested) ? requested : "auto";
  if (!supported) {
    return { backend: DENSE_ONNX_BACKEND, available: false, requested: choice, reason: supportReason || "This machine has no build of onnxruntime-node." };
  }
  if (onnxReady) {
    return {
      backend: DENSE_ONNX_BACKEND,
      available: true,
      requested: choice,
      reason: choice === DENSE_ONNX_BACKEND
        ? "AI_DEV_DENSE_BACKEND=onnx, and the verified ONNX export is on disk; no Python is involved."
        : "The verified ONNX export is on disk; no Python is involved."
    };
  }
  return {
    backend: DENSE_ONNX_BACKEND,
    available: false,
    requested: choice,
    reason: inContainer
      ? "Dense search is not installed in this container: mount a folder holding bge-m3-onnx/ at /models "
        + "(AI_DEV_MODEL_PATH with docker/run-mcp.sh)."
      : `Dense search is not installed: the model is not on this machine. Run \`${DENSE_INSTALL_COMMAND}\` to download it `
        + `(about 600 MB, no Python), or \`${DENSE_IMPORT_COMMAND}\` to copy it from another machine.`
  };
}
