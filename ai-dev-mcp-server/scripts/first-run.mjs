#!/usr/bin/env node
/**
 * `npm run setup` — build what a fresh clone does not ship.
 *
 * The server works the moment it is cloned, but four things are built rather
 * than shipped and one is downloaded; until then the health check reports them
 * and the search tools answer with a refusal. What to do is decided in
 * `src/core/first-run.mjs`; this does it and says what happened.
 *
 * Nothing here reaches the network unless asked: `--frontend-qa` installs the
 * QA runner's dependencies, `--dense` downloads the pinned BGE-M3 ONNX export
 * (about 600 MB, checksum-verified, no Python), and `--dense-python` builds the
 * legacy virtualenv and downloads the 2.3 GB torch weights instead
 * (docs/DEFECTS.md, Д-62).
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadDenseModel } from "../src/core/dense-download.mjs";
import { defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { readDenseManifest, verifyDenseModelDirectory } from "../src/core/dense-manifest.mjs";
import {
  describeDenseCoverage,
  firstRunSucceeded,
  planFirstRun,
  renderFirstRunReport,
  venvPythonPath
} from "../src/core/first-run.mjs";
import {
  createRequiredActions,
  parseToolResult as parseResult,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan,
  summarizeToolResult as summarize
} from "./first-run-steps.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");

function parseArgs(argv) {
  const options = { want: {}, force: false, health: true };
  for (const argument of argv) {
    if (argument === "--dense") Object.assign(options.want, { dense_model: true, dense_index: true });
    else if (argument === "--dense-python") {
      Object.assign(options.want, { dense_model: true, dense_index: true });
      options.densePython = true;
    }
    else if (argument === "--frontend-qa") options.want.frontend_qa = true;
    else if (argument === "--all") Object.assign(options.want, { dense_model: true, dense_index: true, frontend_qa: true });
    else if (argument === "--force") options.force = true;
    else if (argument === "--no-health") options.health = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}. Try --help.`);
  }
  return options;
}

function usage() {
  return [
    "Build what a fresh clone does not ship.",
    "",
    "Usage: npm run setup -- [--frontend-qa] [--dense] [--dense-python] [--all] [--force] [--no-health]",
    "",
    "  (no flags)      skill registry, search index, routing benchmark",
    "  --frontend-qa   also install the Frontend QA runner's dependencies",
    "  --dense         also download the pinned BGE-M3 ONNX export (about 600 MB,",
    "                  checksum-verified, no Python) and embed the indexed documents",
    "  --dense-python  the legacy path instead: a Python virtualenv, torch, and the",
    "                  2.3 GB weights. Same search, four more things to go wrong.",
    "  --all           everything above",
    "  --force         rebuild what is already there",
    "  --no-health     skip the closing diagnostic"
  ].join("\n");
}

/** Run a command, streaming its output, and resolve with its exit code. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function runOrThrow(label, command, args, options) {
  const code = await run(command, args, options);
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
}

const {
  callTool, shutdownBgeWorkers, vaultRoot, searchIndexPath, embeddingsDir, skillRoutingEvalCasesPath
} = await import("../src/mcp-stdio.mjs");

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  // A mistyped flag is a typo, not a crash: say which one and what to try.
  console.error(String(error?.message ?? error));
  process.exit(2);
}
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const modelDir = process.env.BGE_M3_MODEL_DIR
  || path.join(process.env.AI_DEV_HOME || process.env.HOME || process.env.USERPROFILE || "", ".ai-dev", "models", "bge-m3");
const venvDir = path.join(embeddingsDir, ".venv");
const densePython = process.env.AI_DEV_PYTHON || venvPythonPath({ venvDir, exists: existsSync });

// Which dense backend this run installs. `--dense` is the ONNX export and
// nothing else; the legacy virtualenv is asked for by name, or by the same
// environment variable that selects it at runtime (docs/DEFECTS.md, Д-62).
const denseManifest = readDenseManifest();
const onnxModelDir = defaultOnnxModelDir({ env: process.env });
const useLegacyDense = Boolean(options.densePython)
  || String(process.env.AI_DEV_DENSE_BACKEND ?? "").trim().toLowerCase() === "python";

// The three steps no install can do without are built by the same code the
// container entrypoint runs, so the two paths cannot drift apart again
// (docs/DEFECTS.md, Д-57). What is on disk is read the same way too.
const artefacts = requiredArtefactPaths({ vaultRoot, searchIndexPath });
const { indexStatus, present: requiredPresent, stale: requiredStale } = await readRequiredState({
  paths: artefacts,
  callTool,
  serverRoot,
  skillRoutingEvalCasesPath
});

const present = {
  ...requiredPresent,
  frontend_qa: existsSync(path.join(repositoryRoot, "frontend-qa", "node_modules")),
  dense_model: useLegacyDense
    ? existsSync(path.join(modelDir, "pytorch_model.bin"))
    : (await verifyDenseModelDirectory({ manifest: denseManifest, dir: onnxModelDir })).ready,
  dense_index: Number(indexStatus?.dense_documents || 0) > 0
};

/** What each step actually does. Every one of them is idempotent. */
const ACTIONS = {
  ...createRequiredActions({ callTool }),
  async frontend_qa() {
    const qaRoot = path.join(repositoryRoot, "frontend-qa");
    const hasPnpmLock = existsSync(path.join(qaRoot, "pnpm-lock.yaml"));
    const manager = hasPnpmLock && (await hasCommand("pnpm")) ? "pnpm" : "npm";
    await runOrThrow(`${manager} install`, manager, ["install"], { cwd: qaRoot });
    return `${manager} install in frontend-qa/`;
  },
  async dense_model() {
    if (!useLegacyDense) {
      // Download and verify, nothing more: five files, each checked against the
      // sha256 the manifest pins, into a directory of their own.
      const status = await downloadDenseModel({
        manifest: denseManifest,
        targetDir: onnxModelDir,
        log: (line) => process.stdout.write(`   ${line}\n`)
      });
      if (!status.ready) {
        throw new Error(`Model directory is still incomplete: ${[...status.missing, ...status.mismatched].join(", ")}`);
      }
      return `${denseManifest.export} @ ${String(denseManifest.revision).slice(0, 12)} (${denseManifest.dtype}) `
        + `in ${onnxModelDir}, ${status.downloaded} file(s) fetched`;
    }
    if (!existsSync(venvPythonPath({ venvDir, exists: existsSync }))) {
      await runOrThrow("python -m venv", process.env.AI_DEV_PYTHON_BASE || "python3", ["-m", "venv", venvDir]);
    }
    const python = venvPythonPath({ venvDir, exists: existsSync });
    await runOrThrow("pip install", python, [
      "-m", "pip", "install", "--disable-pip-version-check",
      "-r", path.join(embeddingsDir, "requirements-bge-m3.txt")
    ]);
    await fs.mkdir(modelDir, { recursive: true });
    // The revision is passed rather than left to float: an unpinned
    // `snapshot_download` is exactly the upstream-can-change-under-you problem
    // the ONNX manifest solves for the other path (docs/DEFECTS.md, Д-62,
    // point 1). Unset means the old behaviour, and the index records the
    // vectors as coming from an unpinned download.
    const legacyRevision = String(process.env.BGE_M3_PYTHON_REVISION ?? "").trim();
    await runOrThrow("model download", python, ["-c", [
      "from huggingface_hub import snapshot_download",
      `snapshot_download("BAAI/bge-m3", local_dir=${JSON.stringify(modelDir)},`,
      legacyRevision ? ` revision=${JSON.stringify(legacyRevision)},` : "",
      ' allow_patterns=["*.json", "*.model", "sentencepiece.bpe.model", "pytorch_model.bin"])'
    ].filter(Boolean).join("\n")]);
    return `model in ${modelDir}, interpreter ${python}`;
  },
  async dense_index() {
    const result = await callTool("rebuild_search_index", {
      include_external_project_files: true,
      dense_embeddings: true,
      dense_incremental: true
    });
    return summarize(result, (doc) => (
      `${doc.dense_documents ?? "?"} document(s) embedded, ${doc.dense_pending_documents ?? 0} still pending`
    ));
  }
};

async function hasCommand(command) {
  const code = await run(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
  return code === 0;
}

const stale = {
  ...requiredStale,
  // Documents indexed since the last embedding run have no vector, so the
  // dense half of a hybrid query cannot see them.
  dense_index: Number(indexStatus?.dense_pending_documents || 0) > 0
};
const plan = planFirstRun({ present, stale, want: options.want, force: options.force });
console.log(`Vault: ${vaultRoot}`);
console.log(`Search index: ${searchIndexPath}`);
console.log(useLegacyDense
  ? `Dense model: ${modelDir} (legacy Python backend, interpreter ${densePython})`
  : `Dense model: ${onnxModelDir} (ONNX backend, ${denseManifest.export} @ ${String(denseManifest.revision).slice(0, 12)})`);
if (indexStatus) console.log(describeDenseCoverage(indexStatus));
console.log("");

const results = await runFirstRunPlan(
  plan,
  ACTIONS,
  (step) => process.stdout.write(`→ ${step.title}: ${step.detail}\n`)
);

console.log("");
console.log(renderFirstRunReport(results));

if (options.health) {
  console.log("");
  const health = await callTool("system_health_check", {
    include_search_smoke: true,
    include_dense_smoke: false,
    include_search_eval: false
  });
  const doc = parseResult(health) ?? {};
  const checks = doc.checks ?? [];
  const unhappy = checks.filter((check) => check.status !== "passed" && check.status !== "ok" && check.status !== "skipped");
  console.log(`Health: ${doc.status} — ${checks.length} check(s), ${unhappy.length} not passing.`);
  for (const check of unhappy) {
    console.log(`  ${check.status}: ${check.name} — ${String(check.summary).replace(/\s+/g, " ").slice(0, 120)}`);
  }
  // The health check describes the vault, not this run, and the two disagree
  // when a step here failed: "1 failed" scrolled past and "Health: ok" was the
  // last line the reader saw (docs/DEFECTS.md, Д-78). Say which is which.
  if (!firstRunSucceeded(results)) {
    console.log("");
    console.log("That health check describes the vault, not this run — a step above failed. Fix it and run setup again.");
  }
}

await shutdownBgeWorkers();
process.exitCode = firstRunSucceeded(results) ? 0 : 1;
