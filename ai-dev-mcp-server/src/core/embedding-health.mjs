/**
 * The health check's verdict on dense search, from the `embedding_status`
 * payload.
 *
 * Four answers, because they send a person to four different places. Ready is
 * `ok`. Not installed is `skipped` — nobody has to have the model, and a
 * correct install without it is not unhealthy (docs/DEFECTS.md, Д-59). Files
 * that are there and wrong are a `warn`, and so is anything left of the
 * removed Python backend: a 2.x setting that nothing reads any more is worth
 * a sentence and the command that replaces it, every time someone looks
 * (decision D3, Д-98). A machine the runtime has no build for is `skipped`
 * with that said plainly (Д-101).
 */
import { DENSE_MOUNT_ADVICE } from "./dense-backend.mjs";
import { formatBytes } from "./disk-space.mjs";

/**
 * Grade the dense backend from an `embedding_status` payload.
 *
 * @param {{ dense_backend?: object, model_dir?: string, partial?: object[], worker?: object }} status
 * @returns {{ status: string, summary: string, details: object }}
 */
export function evaluateEmbeddingBackend(status = {}) {
  const selected = status.dense_backend ?? {};
  const onnx = selected.onnx ?? {};
  const legacy = selected.legacy?.notes ?? [];
  const partial = status.partial ?? [];
  const details = { backend: selected.backend ?? "onnx", onnx, model_dir: status.model_dir ?? onnx.dir, partial, worker: status.worker, legacy };
  if (legacy.length) {
    return {
      status: "warn",
      summary: [...legacy, selected.available ? "" : selected.reason].filter(Boolean).join(" "),
      details
    };
  }
  if (selected.available) {
    return {
      status: "ok",
      summary: `Dense search is ready through the ONNX backend (${onnx.export} @ ${String(onnx.revision).slice(0, 12)}, ${onnx.dtype}); no Python is involved.`,
      details
    };
  }
  // Inside a container the model folder is a read-only mount: the fix is on
  // the host, not a command run here (docs/DEFECTS.md, Д-157).
  const inContainer = Boolean(status.in_container);
  if (onnx.mismatched?.length) {
    return {
      status: "warn",
      summary: `The model files in ${onnx.dir} do not match the manifest (${onnx.mismatched.join(", ")}). `
        + (inContainer ? `In this container, ${DENSE_MOUNT_ADVICE}` : "Run `npm run setup -- --dense`: it fetches those files again."),
      details
    };
  }
  if (partial.length) {
    const started = partial.map((entry) => `${formatBytes(entry.bytes)} of ${entry.file}`).join(", ");
    return {
      status: "skipped",
      summary: `Dense search is not installed: a model download stopped partway (${started}). `
        + (inContainer ? `In this container, ${DENSE_MOUNT_ADVICE}` : "`npm run setup -- --dense` continues it from there."),
      details: { ...details, optional: true }
    };
  }
  return { status: "skipped", summary: selected.reason || "Dense search is not installed.", details: { ...details, optional: true } };
}
