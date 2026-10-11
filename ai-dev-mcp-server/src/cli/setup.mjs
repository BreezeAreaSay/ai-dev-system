/**
 * `ai-dev setup` (and `npm run setup`) — build what a fresh install does not
 * ship, connect the AI clients, and on request fetch the local model.
 *
 * The server works the moment it is cloned, but four things are built rather
 * than shipped; until then the health check reports them and the search tools
 * answer with a refusal. What to do is decided in `core/first-run.mjs`; this
 * does it and says what happened.
 *
 * At a terminal it asks: connect the clients found here, fetch the model,
 * install Frontend QA. `--yes` takes the defaults without asking (clients yes,
 * the two downloads no); with neither a terminal nor `--yes` (CI, a pipe) no
 * client config is written unless `--clients` names some.
 *
 * Nothing reaches the network unless asked: `--frontend-qa` installs the QA
 * runner's dependencies, `--model` the pinned BGE-M3 ONNX model (about 600 MB,
 * checksum-verified, resumable, no Python) and embeds the documents with it.
 * Ctrl-C during either keeps what is done: the next run continues.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { CliUsageError, EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { legacyDenseNotes } from "../core/dense-backend.mjs";
import { readDenseManifest } from "../core/dense-manifest.mjs";
import { defaultOnnxModelDir } from "../core/dense-onnx.mjs";
import { describeDenseCoverage, firstRunSucceeded, planFirstRun, renderFirstRunReport } from "../core/first-run.mjs";
import { frontendQaInstallCommands, frontendQaInstalled, pinnedPnpmVersion } from "../core/frontend-qa-install.mjs";
import { LAUNCH_UNKNOWN, classifyFrontendQaLaunchFailure } from "../core/frontend-qa-launch.mjs";
import { discoverClients, parseClientSelection } from "../core/mcp-clients.mjs";
import { denseRuntimeSupport, installModel, modelStatus } from "../core/model-manager.mjs";
import { resolveSpawnInvocation } from "../core/process-runner.mjs";
import { createProgressPrinter } from "../core/progress-line.mjs";
import { resolveRuntimeStateRoot } from "../core/runtime-home.mjs";
import { evaluateFrontendQaEnvironment } from "../core/system-health.mjs";
import { installClients, renderResults, summarize } from "./clients.mjs";
import { SERVER_ROOT } from "./context.mjs";

const REPOSITORY_ROOT = path.resolve(SERVER_ROOT, "..");
const QA_ROOT = path.join(REPOSITORY_ROOT, "frontend-qa");

export function usage() {
  return [
    "Build what a fresh install does not ship, and connect your AI clients.",
    "",
    "Usage: ai-dev setup [options]      (from a clone: npm run setup -- [options])",
    "",
    "  (no options)      skill registry, search index, routing benchmark; at a terminal it",
    "                    also asks about the clients, the model and Frontend QA",
    "  --yes, -y         ask nothing: connect every client found here, skip the downloads",
    "  --clients=<names> connect these clients: all, or some of claude-code, claude-desktop,",
    "                    cursor, vscode, codex, gemini; --no-clients connects none",
    "  --model           also install the pinned BGE-M3 ONNX model (about 600 MB, checksum-",
    "                    verified, resumable, no Python) and embed the documents. Behind a",
    "                    firewall: AI_DEV_MODEL_MIRROR, HTTPS_PROXY, or `ai-dev model import`",
    "                    (--dense is the same)",
    "  --frontend-qa     also install the Frontend QA runner and its Chromium",
    "  --all             both downloads",
    "  --force           rebuild what is already there",
    "  --no-health       skip the closing diagnostic"
  ].join("\n");
}

/** Run a command, streaming its output, and resolve with its exit code. */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPOSITORY_ROOT, stdio: "inherit", windowsHide: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function runOrThrow(label, command, args, options) {
  const code = await runCommand(command, args, options);
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
}

/**
 * The Frontend QA runner's status, asked exactly as the health check asks it,
 * about the vault, so setup and `doctor` cannot disagree. `launch: false` only
 * looks for the browser on disk.
 */
function frontendQaStatus(vaultRoot, { launch = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(QA_ROOT, "frontend_qa_runner.mjs")], {
      cwd: QA_ROOT,
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

export function parseSetupArgs(argv) {
  const { values } = parseCommandLine(argv, {
    command: "setup",
    options: {
      yes: { type: "boolean", short: "y" },
      clients: { type: "string" },
      model: { type: "boolean" },
      dense: { type: "boolean" },
      "dense-python": { type: "boolean" },
      "frontend-qa": { type: "boolean" },
      all: { type: "boolean" },
      force: { type: "boolean" },
      health: { type: "boolean", default: true }
    }
  });
  // A misspelt client is a usage mistake, caught before anything is built.
  if (typeof values.clients === "string") {
    try {
      parseClientSelection(values.clients);
    } catch (error) {
      throw new CliUsageError(`\`ai-dev setup\`: ${error.message}`);
    }
  }
  const modelFlag = values.model ?? values.dense ?? (values["dense-python"] || values.all ? true : undefined);
  return {
    help: Boolean(values.help),
    yes: Boolean(values.yes),
    clients: values.clients,
    model: modelFlag,
    densePython: Boolean(values["dense-python"]),
    frontendQa: values["frontend-qa"] ?? (values.all ? true : undefined),
    force: Boolean(values.force),
    health: values.health !== false
  };
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const options = parseSetupArgs(argv);
  if (options.help) {
    io.out(usage());
    return EXIT.ok;
  }

  // Data a 2.x install left one level too deep moves first, so every step
  // below finds it (docs/DEFECTS.md, Д-90).
  const { prepareRuntimeHome } = await import("../core/runtime-home-migration.mjs");
  await prepareRuntimeHome();
  const { callTool, shutdownBgeWorkers, vaultRoot, searchIndexPath, skillRoutingEvalCasesPath } = await import("../mcp-stdio.mjs");
  const steps = await import("../../scripts/first-run-steps.mjs");
  try {
    return await setup({ options, io, runtime: { callTool, vaultRoot, searchIndexPath, skillRoutingEvalCasesPath }, steps });
  } finally {
    await shutdownBgeWorkers();
  }
}

async function setup({ options, io, runtime, steps }) {
  const { callTool, vaultRoot, searchIndexPath, skillRoutingEvalCasesPath } = runtime;
  const say = io.out;
  // The model is the ONNX export and nothing else; what a 2.x install left of
  // the Python backend is named once, with what replaced it (D3, Д-98).
  const denseManifest = readDenseManifest();
  const onnxModelDir = defaultOnnxModelDir({ env: io.env });
  const legacyWeightsDir = io.env.BGE_M3_MODEL_DIR || path.join(resolveRuntimeStateRoot("", io.env), "models", "bge-m3");
  const legacyNotes = [
    ...(options.densePython ? ["--dense-python asked for the Python backend, which 3.0 removed; installing the ONNX model instead (the same as --model)."] : []),
    ...legacyDenseNotes(io.env, { legacyWeightsDir: existsSync(path.join(legacyWeightsDir, "pytorch_model.bin")) ? legacyWeightsDir : "" })
  ];
  const progress = createProgressPrinter({ stream: io.stdout });
  let cancelled = false;

  /** Ctrl-C stops between two pieces of work and keeps what is done; a second one does not wait. */
  async function cancellable(work) {
    const controller = new AbortController();
    const stop = () => {
      if (controller.signal.aborted) process.exit(EXIT.interrupted);
      progress.end();
      say("   Stopping after the current piece — what is done is kept. Ctrl-C again to quit now.");
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

  // The steps no install can do without are built by the code the container
  // entrypoint runs too, so the two paths cannot drift apart (Д-57).
  const artefacts = steps.requiredArtefactPaths({ vaultRoot, searchIndexPath });
  const { indexStatus, present: requiredPresent, stale: requiredStale } = await steps.readRequiredState({
    paths: artefacts,
    callTool,
    serverRoot: SERVER_ROOT,
    skillRoutingEvalCasesPath
  });
  const qaDependencies = existsSync(path.join(QA_ROOT, "node_modules"));
  const modelInstalled = (await modelStatus({ manifest: denseManifest, dir: onnxModelDir, env: io.env })).installed;

  say(`Vault: ${vaultRoot}`);
  say(`Search index: ${searchIndexPath}`);
  say(`Dense model: ${onnxModelDir} (ONNX, ${denseManifest.export} @ ${String(denseManifest.revision).slice(0, 12)})`);
  if (indexStatus) say(describeDenseCoverage(indexStatus));
  for (const note of legacyNotes) say(`Note: ${note}`);
  say("");

  // What to do beyond the required steps: flags first, then a question at a
  // terminal, then the default.
  const asking = io.interactive && !options.yes;
  let clientSpec = options.clients;
  if (clientSpec === undefined) {
    if (asking) {
      const found = (await discoverClients({ env: io.env })).filter((target) => target.detected);
      const names = [...new Set(found.map((target) => target.label))];
      clientSpec = names.length && await io.ask(`Connect ai-dev to ${names.join(", ")}?`, true) ? "all" : false;
      if (!names.length) say("No AI client found here; `ai-dev clients install --clients=<name>` writes one later.");
    } else {
      clientSpec = options.yes ? "all" : false;
    }
  }
  let wantModel = options.model;
  if (wantModel === undefined) {
    wantModel = !modelInstalled && asking
      ? await io.ask("Download the local search model too? About 600 MB, for semantic search; word search works without it.", false)
      : false;
  }
  let wantQa = options.frontendQa;
  if (wantQa === undefined) {
    wantQa = !qaDependencies && asking ? await io.ask("Install Frontend QA (Playwright and its Chromium) for UI checks?", false) : false;
  }
  if (asking) say("");

  const present = {
    ...requiredPresent,
    // Installed means the browser too, and asked for by name it means one that
    // launches — the check `doctor` makes (docs/DEFECTS.md, Д-93).
    frontend_qa: frontendQaInstalled({
      dependencies: qaDependencies,
      status: qaDependencies ? await frontendQaStatus(vaultRoot, { launch: Boolean(wantQa) }) : null,
      requireLaunch: Boolean(wantQa)
    }),
    dense_model: modelInstalled,
    dense_index: Number(indexStatus?.dense_documents || 0) > 0
  };

  const actions = {
    ...steps.createRequiredActions({ callTool }),
    // The lockfile with the pnpm the runner pins, then the Chromium build this
    // Playwright was released with, and a ✓ only when the browser launches.
    async frontend_qa() {
      const pnpmVersion = pinnedPnpmVersion(JSON.parse(await fs.readFile(path.join(QA_ROOT, "package.json"), "utf8")));
      for (const step of frontendQaInstallCommands({ qaRoot: QA_ROOT, pnpmVersion })) {
        const invocation = await resolveSpawnInvocation(step.command, step.args);
        await runOrThrow(step.label, invocation.executable, invocation.args, { cwd: step.cwd });
      }
      const verdict = evaluateFrontendQaEnvironment(await frontendQaStatus(vaultRoot));
      if (verdict.status !== "ok") throw new Error(verdict.summary);
      return `pnpm@${pnpmVersion} install --frozen-lockfile, playwright install chromium; ${verdict.summary}`;
    },
    async dense_model() {
      // Where the runtime has no build, 600 MB that cannot load is not a
      // favour (Д-101); `ai-dev model install` still fetches them for a container.
      const support = denseRuntimeSupport();
      if (!support.supported) throw new Error(support.reason);
      const result = await cancellable((signal) => installModel({
        manifest: denseManifest,
        dir: onnxModelDir,
        env: io.env,
        signal,
        onProgress: progress,
        log: (line) => {
          progress.end();
          say(`   ${line}`);
        }
      }));
      if (!result.ready) throw new Error(`Model directory is still incomplete: ${[...result.missing, ...result.mismatched].join(", ")}`);
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
      return steps.summarizeToolResult(result, (doc) => (
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
  const want = {
    ...(wantModel ? { dense_model: true, dense_index: true } : {}),
    ...(wantQa ? { frontend_qa: true } : {})
  };
  const plan = planFirstRun({ present, stale, want, force: options.force });
  const results = await steps.runFirstRunPlan(plan, actions, (step) => say(`→ ${step.title}: ${step.detail}`));
  say("");
  say(renderFirstRunReport(results));

  let clientsFailed = false;
  if (cancelled) {
    // A stop is not a fault, and nothing after it says anything new (Д-158).
    say("");
    say("Stopped with Ctrl-C. What was done is kept; run setup again to continue from there.");
    return EXIT.interrupted;
  }
  if (clientSpec) {
    say("");
    say("AI clients:");
    const connected = await installClients({ spec: clientSpec, env: io.env });
    for (const line of renderResults(connected)) say(line);
    for (const line of summarize(connected)) say(`  ${line}`);
    clientsFailed = connected.some((result) => result.status === "failed");
  } else {
    say("");
    say("AI clients: not changed. `ai-dev clients install` (from a clone: npm run clients:install) connects them.");
  }

  if (options.health) {
    say("");
    const health = await callTool("system_health_check", { include_search_smoke: true, include_dense_smoke: false, include_search_eval: false });
    const doc = steps.parseToolResult(health) ?? {};
    const checks = doc.checks ?? [];
    const unhappy = checks.filter((check) => check.status !== "passed" && check.status !== "ok" && check.status !== "skipped");
    say(`Health: ${doc.status} — ${checks.length} check(s), ${unhappy.length} not passing.`);
    for (const check of unhappy) say(`  ${check.status}: ${check.name} — ${String(check.summary).replace(/\s+/g, " ").slice(0, 120)}`);
    // The health check describes the vault, not this run; when a step here
    // failed, "Health: ok" must not be the last word (Д-78).
    if (!firstRunSucceeded(results)) {
      say("");
      say("That health check describes the vault, not this run — a step above failed. Fix it and run setup again.");
    }
  }
  return firstRunSucceeded(results) && !clientsFailed ? EXIT.ok : EXIT.failed;
}
