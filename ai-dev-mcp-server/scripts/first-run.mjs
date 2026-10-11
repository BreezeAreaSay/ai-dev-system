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
 * QA runner's dependencies, and `--dense` installs the pinned BGE-M3 ONNX
 * model (about 600 MB, checksum-verified, resumable, no Python) and embeds the
 * documents with it. Ctrl-C during either keeps what is done: the next run
 * continues the download and the embedding (docs/DEFECTS.md, Д-98).
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { legacyDenseNotes } from "../src/core/dense-backend.mjs";
import { defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { readDenseManifest } from "../src/core/dense-manifest.mjs";
import { denseRuntimeSupport, installModel, modelStatus } from "../src/core/model-manager.mjs";
import { createProgressPrinter } from "../src/core/progress-line.mjs";
import { frontendQaInstallCommands, frontendQaInstalled, pinnedPnpmVersion } from "../src/core/frontend-qa-install.mjs";
import { LAUNCH_UNKNOWN, classifyFrontendQaLaunchFailure } from "../src/core/frontend-qa-launch.mjs";
import { resolveSpawnInvocation } from "../src/core/process-runner.mjs";
import { resolveRuntimeStateRoot } from "../src/core/runtime-home.mjs";
import { prepareRuntimeHome } from "../src/core/runtime-home-migration.mjs";
import {
  describeDenseCoverage,
  firstRunSucceeded,
  planFirstRun,
  renderFirstRunReport
} from "../src/core/first-run.mjs";
import {
  createRequiredActions,
  parseToolResult as parseResult,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan,
  summarizeToolResult as summarize
} from "./first-run-steps.mjs";
import { evaluateFrontendQaEnvironment } from "../src/core/system-health.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const qaRoot = path.join(repositoryRoot, "frontend-qa");

function parseArgs(argv) {
  const options = { want: {}, force: false, health: true };
  for (const argument of argv) {
    if (argument === "--dense") Object.assign(options.want, { dense_model: true, dense_index: true });
    else if (argument === "--dense-python") {
      // Kept as a name so a 2.x command line still works; what it built is gone.
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
    "Usage: npm run setup -- [--frontend-qa] [--dense] [--all] [--force] [--no-health]",
    "",
    "  (no flags)      skill registry, search index, routing benchmark",
    "  --frontend-qa   also install the Frontend QA runner's dependencies",
    "  --dense         also install the pinned BGE-M3 ONNX model (about 600 MB,",
    "                  checksum-verified, resumable, no Python) and embed the",
    "                  indexed documents. Behind a firewall: AI_DEV_MODEL_MIRROR,",
    "                  HTTPS_PROXY, or `npm run model -- import <folder or .zip>`",
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

/**
 * The Frontend QA runner's status, asked exactly as the health check asks it —
 * about the vault, so a Playwright the environment supplies first (NODE_PATH)
 * is the one judged here too, and setup and `doctor` cannot disagree. `launch:
 * false` only looks for the browser on disk. A runner that cannot start is
 * described the way the health check describes it.
 */
function frontendQaStatus({ launch = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(qaRoot, "frontend_qa_runner.mjs")], {
      cwd: qaRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const failed = (output) => {
      const failure = classifyFrontendQaLaunchFailure(output);
      settle({ playwright_available: false, chromium_available: false, browser_launch_ok: false, launch_failure: failure.kind, launch_error: failure.summary });
    };
    // As long as the server allows the same question (`runFrontendQaStatus`).
    const timer = setTimeout(() => {
      child.kill();
      failed("The Frontend QA runner did not answer within 60 s.");
    }, 60_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => undefined); // a runner that died early closed it; its exit says why
    child.on("error", (error) => failed(String(error?.message ?? error)));
    // `close`, not `exit`: only then is everything the runner printed read.
    child.on("close", (code) => {
      if (code !== 0) return failed(stderr || `exit code ${code}`);
      try {
        settle(JSON.parse(stdout));
      } catch {
        settle({ playwright_available: false, chromium_available: false, browser_launch_ok: false, launch_failure: LAUNCH_UNKNOWN, launch_error: "The Frontend QA runner answered with something other than JSON." });
      }
    });
    child.stdin.end(JSON.stringify({ action: "status", project_path: vaultRoot, launch }));
  });
}

// Data a 2.x install left one level too deep moves first, so every step below
// finds it (docs/DEFECTS.md, Д-90).
await prepareRuntimeHome();
const {
  callTool, shutdownBgeWorkers, vaultRoot, searchIndexPath, skillRoutingEvalCasesPath
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

// The model is the ONNX export and nothing else. What a 2.x install left of
// the Python backend — the flag, its variables, its torch weights — is named
// once here, with what replaced it (decision D3, docs/DEFECTS.md, Д-98).
const denseManifest = readDenseManifest();
const onnxModelDir = defaultOnnxModelDir({ env: process.env });
const legacyWeightsDir = path.join(process.env.BGE_M3_MODEL_DIR || path.join(resolveRuntimeStateRoot(), "models", "bge-m3"));
const legacyNotes = [
  ...(options.densePython ? ["--dense-python asked for the Python backend, which 3.0 removed; installing the ONNX model instead (the same as --dense)."] : []),
  ...legacyDenseNotes(process.env, { legacyWeightsDir: existsSync(path.join(legacyWeightsDir, "pytorch_model.bin")) ? legacyWeightsDir : "" })
];

const progress = createProgressPrinter();
let cancelled = false;

/**
 * Run the model download or the embedding so that Ctrl-C stops it between two
 * pieces of work and keeps what is done; a second Ctrl-C does not wait.
 */
async function cancellable(work) {
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) process.exit(130);
    progress.end();
    process.stdout.write("   Stopping after the current piece — what is done is kept. Ctrl-C again to quit now.\n");
    cancelled = true;
    controller.abort();
  };
  process.on("SIGINT", stop);
  try {
    return await work(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    progress.end();
  }
}

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

const qaDependencies = existsSync(path.join(qaRoot, "node_modules"));
const present = {
  ...requiredPresent,
  // Installed means the browser too: with only the packages a rerun skipped
  // the step as built while QA still could not start (docs/DEFECTS.md, Д-93).
  // Asked for by name, it means a browser that launches — one on disk that
  // does not start failed the step once and then counted as built.
  frontend_qa: frontendQaInstalled({
    dependencies: qaDependencies,
    status: qaDependencies ? await frontendQaStatus({ launch: Boolean(options.want.frontend_qa) }) : null,
    requireLaunch: Boolean(options.want.frontend_qa)
  }),
  dense_model: (await modelStatus({ manifest: denseManifest, dir: onnxModelDir, env: process.env })).installed,
  dense_index: Number(indexStatus?.dense_documents || 0) > 0
};

/** What each step actually does. Every one of them is idempotent. */
const ACTIONS = {
  ...createRequiredActions({ callTool }),
  // The lockfile with the pnpm the runner pins, then the Chromium build this
  // Playwright was released with, and a ✓ only when the browser launches —
  // the check `doctor` makes (docs/DEFECTS.md, Д-93). npm goes through the
  // process-runner adapter, which on Windows runs npm's own entry point
  // rather than npm.cmd.
  async frontend_qa() {
    const pnpmVersion = pinnedPnpmVersion(JSON.parse(await fs.readFile(path.join(qaRoot, "package.json"), "utf8")));
    for (const step of frontendQaInstallCommands({ qaRoot, pnpmVersion })) {
      const invocation = await resolveSpawnInvocation(step.command, step.args);
      await runOrThrow(step.label, invocation.executable, invocation.args, { cwd: step.cwd });
    }
    const verdict = evaluateFrontendQaEnvironment(await frontendQaStatus());
    if (verdict.status !== "ok") throw new Error(verdict.summary);
    return `pnpm@${pnpmVersion} install --frozen-lockfile, playwright install chromium; ${verdict.summary}`;
  },
  async dense_model() {
    // Where the runtime has no build, 600 MB that cannot load is not a favour
    // (docs/DEFECTS.md, Д-101); `npm run model -- install` still fetches them
    // for a container to mount.
    const support = denseRuntimeSupport();
    if (!support.supported) throw new Error(support.reason);
    const result = await cancellable((signal) => installModel({
      manifest: denseManifest,
      dir: onnxModelDir,
      env: process.env,
      signal,
      onProgress: progress,
      log: (line) => {
        progress.end();
        process.stdout.write(`   ${line}\n`);
      }
    }));
    if (!result.ready) {
      throw new Error(`Model directory is still incomplete: ${[...result.missing, ...result.mismatched].join(", ")}`);
    }
    return `${denseManifest.export} @ ${String(denseManifest.revision).slice(0, 12)} (${denseManifest.dtype}) `
      + `in ${onnxModelDir}, ${result.downloaded} file(s) fetched${result.resumed ? `, ${result.resumed} continued` : ""}`;
  },
  async dense_index() {
    // In this process the rebuild takes a progress callback and a signal;
    // over MCP the same arguments are JSON and carry neither.
    const result = await cancellable((signal) => callTool("rebuild_search_index", {
      include_external_project_files: true,
      dense_embeddings: true,
      dense_incremental: true,
      onProgress: progress,
      signal
    }));
    return summarize(result, (doc) => (
      `${doc.dense_documents ?? "?"} document(s) embedded, ${doc.dense_pending_documents ?? 0} still pending`
    ));
  }
};

const stale = {
  ...requiredStale,
  // Documents indexed since the last embedding run have no vector, so the
  // dense half of a hybrid query cannot see them.
  dense_index: Number(indexStatus?.dense_pending_documents || 0) > 0
};
const plan = planFirstRun({ present, stale, want: options.want, force: options.force });
console.log(`Vault: ${vaultRoot}`);
console.log(`Search index: ${searchIndexPath}`);
console.log(`Dense model: ${onnxModelDir} (ONNX, ${denseManifest.export} @ ${String(denseManifest.revision).slice(0, 12)})`);
if (indexStatus) console.log(describeDenseCoverage(indexStatus));
for (const note of legacyNotes) console.log(`Note: ${note}`);
console.log("");

const results = await runFirstRunPlan(
  plan,
  ACTIONS,
  (step) => process.stdout.write(`→ ${step.title}: ${step.detail}\n`)
);

console.log("");
console.log(renderFirstRunReport(results));

if (cancelled) {
  // A stop is not a fault, and a health check after it says nothing new
  // (docs/DEFECTS.md, Д-158).
  console.log("");
  console.log("Stopped with Ctrl-C. What was done is kept; run setup again to continue from there.");
} else if (options.health) {
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
process.exitCode = cancelled ? 130 : firstRunSucceeded(results) ? 0 : 1;
