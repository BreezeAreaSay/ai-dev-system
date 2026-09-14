/**
 * `npm run dense:doctor` — the six things that have to be true for dense search
 * to work, checked in the order they depend on each other, and reported as
 * sentences.
 *
 * Д-62 asked for this by name and said why: the old path failed through a
 * Python traceback, which tells a user who has just run an installer nothing
 * they can act on. A stage list fails at exactly one place, and the name of
 * that place *is* the diagnosis — "the model files are not here" and "the model
 * files are here but are not the pinned export" send a person to two different
 * commands, and a stack trace sends them to neither.
 *
 * Stages stop at the first failure on purpose: checking whether the model loads
 * when its weights are absent produces a second, more confusing error about the
 * first one.
 *
 * Every stage is injected, so the whole report — including the stages this
 * machine cannot reach, having no weights on it — is covered by tests that
 * stand in for the dependency rather than install it.
 */

/** The Node the ONNX runtime and this repository both require. */
export const MINIMUM_NODE = "22.12.0";

/**
 * Compare two dotted version strings.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} Negative when left is older.
 */
export function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether a vector is unit length, within the rounding the index stores.
 *
 * The backend is asked for normalized vectors and the scoring code takes that
 * on trust — it computes a plain dot product and calls the result a cosine. A
 * vector that is not unit length therefore does not fail, it just ranks wrong,
 * which is the kind of defect that survives a release. So the doctor measures
 * it rather than assuming it.
 *
 * @param {number[]} vector
 * @returns {{ norm: number, unit: boolean }}
 */
export function vectorNorm(vector) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + (value * value), 0));
  return { norm: Number(norm.toFixed(4)), unit: Math.abs(norm - 1) < 0.01 };
}

/**
 * Run the stages in order, stopping at the first failure.
 *
 * @param {{ key: string, title: string, run: () => Promise<object> }[]} stages
 * @returns {Promise<{ ready: boolean, stages: object[], failed: object|null }>}
 */
export async function runDenseDoctor(stages) {
  const results = [];
  let failed = null;
  for (const stage of stages) {
    if (failed) {
      results.push({ key: stage.key, title: stage.title, status: "skipped", detail: "" });
      continue;
    }
    let outcome;
    try {
      outcome = await stage.run();
    } catch (error) {
      // A thrown dependency is a failed stage, not a crashed doctor: the one
      // thing this command must never do is print a stack trace at a user.
      outcome = { ok: false, detail: String(error?.message ?? error), advice: stage.advice || "" };
    }
    const result = {
      key: stage.key,
      title: stage.title,
      status: outcome.ok ? "ok" : "fail",
      detail: String(outcome.detail ?? ""),
      advice: String(outcome.advice ?? stage.advice ?? "")
    };
    results.push(result);
    if (!outcome.ok) failed = result;
  }
  return { ready: !failed, stages: results, failed };
}

/**
 * Render the report a person reads.
 *
 * @param {{ ready: boolean, stages: object[], failed: object|null }} result
 * @returns {string}
 */
export function renderDenseDoctorReport(result) {
  const mark = { ok: "  ok  ", fail: " FAIL ", skipped: "  --  " };
  const lines = ["", `Dense search: ${result.ready ? "READY" : "UNAVAILABLE"}`, ""];
  for (const stage of result.stages) {
    lines.push(`[${mark[stage.status]}] ${stage.title}${stage.detail ? ` — ${stage.detail}` : ""}`);
  }
  if (result.failed) {
    lines.push("", `Stopped at: ${result.failed.title}.`);
    if (result.failed.detail) lines.push(result.failed.detail);
    if (result.failed.advice) lines.push("", `What to do: ${result.failed.advice}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the stage list.
 *
 * @param {object} deps
 * @param {string} deps.nodeVersion
 * @param {() => Promise<object>} deps.loadRuntime - Imports `onnxruntime-node`.
 * @param {() => object} deps.readManifest
 * @param {(manifest: object) => Promise<object>} deps.verifyFiles
 * @param {(manifest: object) => Promise<object>} deps.loadModel - Resolves when loaded.
 * @param {(manifest: object) => Promise<object>} deps.embedProbe - One trial embedding.
 * @returns {object[]}
 */
export function denseDoctorStages({ nodeVersion, loadRuntime, readManifest, verifyFiles, loadModel, embedProbe }) {
  let manifest = null;
  return [
    {
      key: "node",
      title: `Node ${MINIMUM_NODE} or newer`,
      advice: `Install Node ${MINIMUM_NODE} or newer and run this again.`,
      run: async () => ({
        ok: compareVersions(nodeVersion, MINIMUM_NODE) >= 0,
        detail: `this is ${nodeVersion}`
      })
    },
    {
      key: "runtime",
      title: "onnxruntime-node loads",
      advice: "Run `npm ci` in ai-dev-mcp-server/. If it still fails, the platform may have no prebuilt binary; "
        + "`npm rebuild onnxruntime-node` builds one.",
      run: async () => {
        const runtime = await loadRuntime();
        return { ok: Boolean(runtime?.InferenceSession), detail: "native binding available" };
      }
    },
    {
      key: "manifest",
      title: "model manifest reads",
      advice: "models/bge-m3.manifest.json is part of the package; reinstall or check out the repository again.",
      run: async () => {
        manifest = readManifest();
        return { ok: true, detail: `${manifest.export} @ ${String(manifest.revision).slice(0, 12)}, ${manifest.dtype}` };
      }
    },
    {
      key: "files",
      title: "model files present and unmodified",
      run: async () => {
        const status = await verifyFiles(manifest);
        if (status.ready) return { ok: true, detail: `${status.present.length} file(s) verified in ${status.dir}` };
        if (status.mismatched.length) {
          return {
            ok: false,
            detail: `these do not match the manifest: ${status.mismatched.join(", ")}`,
            advice: `Delete ${status.dir} and run \`npm run setup -- --dense\` again — the bytes there are not the pinned export.`
          };
        }
        return {
          ok: false,
          detail: `missing from ${status.dir}: ${status.missing.join(", ")}`,
          advice: "Run `npm run setup -- --dense` to download the model (about 600 MB, no Python needed)."
        };
      }
    },
    {
      key: "load",
      title: "model loads",
      advice: "The files verified but the runtime would not load them. Delete the model directory and download it again.",
      run: async () => {
        const loaded = await loadModel(manifest);
        return { ok: true, detail: `loaded in ${loaded.seconds}s` };
      }
    },
    {
      key: "embed",
      title: "trial embedding",
      advice: "The model loaded but produced a vector the index cannot use. Report this with the numbers above.",
      run: async () => {
        const probe = await embedProbe(manifest);
        const { norm, unit } = vectorNorm(probe.vector);
        const widthOk = probe.vector.length === manifest.dimensions;
        return {
          ok: widthOk && unit,
          detail: `${probe.vector.length} dimensions, norm ${norm}, ${probe.seconds}s`
            + (widthOk ? "" : ` — the manifest says ${manifest.dimensions}`)
            + (unit ? "" : " — vectors must be normalized")
        };
      }
    }
  ];
}
