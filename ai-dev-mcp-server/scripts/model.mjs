#!/usr/bin/env node
/**
 * `npm run model -- <command>` — the local model, by hand.
 *
 *   status              what is installed, what is missing, what stopped partway
 *   install             download (resumable; mirrors and proxies honoured), then embed the documents
 *   import <path>       copy from a folder or a .zip made on another machine, then embed
 *   verify              hash every file against the manifest
 *   remove              delete the model's files and nothing else
 *
 * The work is in `src/core/model-manager.mjs`; this is the part that prints.
 * `ai-dev model …` (phase 6 of the program) will be the same commands under
 * one CLI. Exit codes: 0 done, 1 failed, 2 a usage mistake, 130 stopped with
 * Ctrl-C (what was done is kept).
 */
import process from "node:process";
import { defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { legacyDenseNotes } from "../src/core/dense-backend.mjs";
import { readDenseManifest } from "../src/core/dense-manifest.mjs";
import { formatBytes } from "../src/core/disk-space.mjs";
import { denseRuntimeSupport, importModel, installModel, modelStatus, removeModel, verifyModel } from "../src/core/model-manager.mjs";
import { createProgressPrinter } from "../src/core/progress-line.mjs";

const COMMANDS = ["status", "install", "import", "verify", "remove", "help"];

function usage() {
  return [
    "The local BGE-M3 model.",
    "",
    "Usage: npm run model -- <command> [options]",
    "",
    "  status            what is installed, what is missing, what stopped partway",
    "  install           download the model (about 600 MB, resumable), then embed the documents",
    "  import <path>     copy it from a folder or a .zip made on another machine, then embed",
    "  verify            hash every file against the manifest",
    "  remove            delete the model's files and nothing else",
    "",
    "  --dir <path>      the model folder (default: BGE_M3_ONNX_DIR, or ~/.ai-dev/models/bge-m3-onnx)",
    "  --mirror <url>    a Hugging Face mirror for this run (as AI_DEV_MODEL_MIRROR, e.g. https://hf-mirror.com)",
    "  --no-index        install or import without embedding the documents",
    "  --json            print the result as JSON",
    "",
    "Behind a proxy, HTTPS_PROXY, HTTP_PROXY and NO_PROXY are honoured."
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ command: string, source: string, dir: string, mirror: string, index: boolean, json: boolean }}
 */
function parseModelArgs(argv) {
  const options = { command: "", source: "", dir: "", mirror: "", index: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value.`);
      index += 1;
      return next;
    };
    if (argument === "--dir") options.dir = value();
    else if (argument === "--mirror") options.mirror = value();
    else if (argument === "--no-index") options.index = false;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.command = "help";
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}. Try \`npm run model -- help\`.`);
    else if (!options.command) options.command = argument;
    else if (options.command === "import" && !options.source) options.source = argument;
    else throw new Error(`Unexpected argument: ${argument}.`);
  }
  if (!options.command) options.command = "status";
  if (!COMMANDS.includes(options.command)) throw new Error(`Unknown command: ${options.command}. One of: ${COMMANDS.join(", ")}.`);
  if (options.command === "import" && !options.source) throw new Error("import needs a folder or a .zip: `npm run model -- import <path>`.");
  return options;
}

let options;
try {
  options = parseModelArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
if (options.command === "help") {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (options.dir) process.env.BGE_M3_ONNX_DIR = options.dir;
if (options.mirror) process.env.AI_DEV_MODEL_MIRROR = options.mirror;

const manifest = readDenseManifest();
const dir = defaultOnnxModelDir({ env: process.env });
const progress = createProgressPrinter({ stream: options.json ? { isTTY: false, write: () => {} } : process.stdout });
const say = (line = "") => {
  if (!options.json) process.stdout.write(`${line}\n`);
};
let cancelled = false;
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  progress.end();
  say("   Stopping after the current piece — what is done is kept. Ctrl-C again to quit now.");
  cancelled = true;
  controller.abort();
});

/** Embed the documents with the model just put in place, through the server's own runtime. */
async function embedDocuments() {
  const { callTool, shutdownBgeWorkers } = await import("../src/mcp-stdio.mjs");
  try {
    say("Embedding the indexed documents (Membrane connectors are left out):");
    const result = await callTool("rebuild_search_index", {
      include_external_project_files: true,
      dense_embeddings: true,
      dense_incremental: true,
      onProgress: progress,
      signal: controller.signal
    });
    progress.end();
    const document = JSON.parse(result?.content?.[0]?.text ?? "{}");
    say(`   ${document.dense_embedded_documents ?? 0} embedded now, ${document.dense_documents ?? 0} with a vector in all, `
      + `${document.dense_pending_documents ?? 0} waiting.`);
    return document;
  } finally {
    progress.end();
    await shutdownBgeWorkers();
  }
}

async function run() {
  const support = denseRuntimeSupport();
  switch (options.command) {
    case "status": {
      const status = await modelStatus({ manifest, dir, env: process.env, support });
      const notes = legacyDenseNotes(process.env);
      if (options.json) return { ok: status.installed, ...status, legacy: notes };
      say(`Model: ${manifest.export} @ ${String(manifest.revision).slice(0, 12)} (${manifest.dtype}) in ${status.dir}`);
      say(status.installed ? "Installed: yes, every file matches the manifest." : "Installed: no.");
      if (status.missing.length) say(`Missing: ${status.missing.join(", ")}`);
      if (status.mismatched.length) say(`Not the pinned files: ${status.mismatched.join(", ")} — \`npm run model -- install\` fetches them again.`);
      for (const part of status.partial) say(`Stopped partway: ${part.file}, ${formatBytes(part.bytes)}${part.size ? ` of ${formatBytes(part.size)}` : ""} — \`npm run model -- install\` continues it.`);
      say(`Download from: ${status.sources_error || status.sources.map((source) => new URL(source).host).join(", ") || "nowhere, the manifest lists no sources"}`);
      if (!status.supported) say(status.support_reason);
      for (const note of notes) say(`Note: ${note}`);
      return { ok: status.installed };
    }
    case "verify": {
      const verified = await verifyModel({ manifest, dir, onProgress: progress });
      progress.end();
      if (options.json) return { ok: verified.ready, ...verified };
      say(verified.ready ? `Every file matches the manifest (${verified.present.length} checked in ${verified.dir}).`
        : `Missing: ${verified.missing.join(", ") || "none"}. Not the pinned files: ${verified.mismatched.join(", ") || "none"}.`);
      return { ok: verified.ready };
    }
    case "install":
    case "import": {
      if (!support.supported) say(`Note: ${support.reason} The files are still put in place, for a container or another machine to use.`);
      const placed = options.command === "install"
        ? await installModel({ manifest, dir, env: process.env, signal: controller.signal, onProgress: progress, log: (line) => {
          progress.end();
          say(`   ${line}`);
        } })
        : await importModel({ manifest, source: options.source, dir, signal: controller.signal, onProgress: progress });
      progress.end();
      say(options.command === "install"
        ? `Model in place: ${dir} — ${placed.downloaded} file(s) fetched${placed.resumed ? `, ${placed.resumed} continued` : ""}, ${formatBytes(placed.bytes)} over the network.`
        : `Model in place: ${dir} — ${placed.copied.length} file(s) copied from ${placed.from}, ${placed.skipped.length} already here.`);
      const embedded = options.index && support.supported ? await embedDocuments() : null;
      if (!options.index) say("Documents not embedded (--no-index): `npm run setup -- --dense` does it later.");
      return { ok: true, model: placed, index: embedded };
    }
    case "remove": {
      const removed = await removeModel({ manifest, dir });
      if (options.json) return { ok: true, ...removed };
      say(removed.removed.length ? `Removed ${removed.removed.length} file(s) from ${removed.dir}, ${removed.freed_text} freed.` : `Nothing to remove in ${removed.dir}.`);
      if (removed.kept.length) say(`Left in place, not the model's: ${removed.kept.join(", ")}`);
      return { ok: true };
    }
    default:
      return { ok: false };
  }
}

try {
  const outcome = await run();
  if (options.json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.ok ? 0 : 1;
} catch (error) {
  progress.end();
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, cancelled, error: error.message }, null, 2)}\n`);
  else process.stderr.write(`${error.message}\n`);
  process.exitCode = cancelled || error?.cancelled ? 130 : 1;
}
