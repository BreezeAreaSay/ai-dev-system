/**
 * The commands that run the server or one of its tools: `mcp`, `doctor`,
 * `reindex`, `refresh`, `dashboard`, `galaxy`, `distribution`, `acceptance`,
 * `backup` — what `scripts/ai-dev.mjs` did, under the one CLI.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { SERVER_ROOT } from "./context.mjs";

const USAGE = {
  mcp: [
    "Usage: ai-dev mcp",
    "",
    "Serve MCP over stdin and stdout until the client closes it. This is the command",
    "`ai-dev clients install` writes into each client's config; nothing but the",
    "protocol is printed on stdout. `ai-dev start` is the same command."
  ],
  doctor: [
    "Usage: ai-dev doctor [--dense-smoke] [--search-eval]",
    "",
    "Run the health check and print it as JSON.",
    "  --dense-smoke   also load the local model and embed a probe",
    "  --search-eval   also run the golden search cases"
  ],
  reindex: ["Usage: ai-dev reindex", "", "Rebuild the text search index; dense vectors of unchanged documents are kept."],
  refresh: ["Usage: ai-dev refresh [flags]", "", "Refresh overlays, outcomes, search, runtime and the dashboard; flags go to scripts/rebuild-live-state.mjs."],
  dashboard: ["Usage: ai-dev dashboard", "", "Regenerate the live Obsidian dashboard."],
  galaxy: ["Usage: ai-dev galaxy [scope...]", "", "Render the vault as a 3D galaxy to fly through (HTML); scopes narrow it, e.g. `ai-dev galaxy knowledge workflows`."],
  distribution: ["Usage: ai-dev distribution", "", "Validate the local or VPS distribution boundaries."],
  acceptance: ["Usage: ai-dev acceptance [flags]", "", "Run the acceptance suite: ten consecutive `npm run check` runs. A source checkout only."],
  backup: ["Usage: ai-dev backup [label]", "", "ZIP backup of the vault plus SHA-256 — Windows vault installs only."]
};

/** @param {string} name */
export function usage(name) {
  return (USAGE[name] ?? [`Usage: ai-dev ${name}`]).join("\n");
}

// The child inherits stdio and has already said what went wrong, so its exit
// code is passed on rather than rethrown: a stack trace would bury it.
function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: SERVER_ROOT, stdio: "inherit", windowsHide: true, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? EXIT.failed));
  });
}

/** Call one tool in-process and print its text, as 2.x did. */
async function callAndPrint(io, tool, input) {
  // What 2.x left in AI_DEV_HOME/.ai-dev moves first: the tools read the
  // runtime tree (docs/DEFECTS.md, Д-90).
  const { prepareRuntimeHome } = await import("../core/runtime-home-migration.mjs");
  await prepareRuntimeHome();
  const { callTool, shutdownBgeWorkers } = await import("../mcp-stdio.mjs");
  try {
    const result = await callTool(tool, input);
    io.out(result.content.find((item) => item.type === "text")?.text || "{}");
    return result.isError ? EXIT.failed : EXIT.ok;
  } finally {
    await shutdownBgeWorkers();
  }
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 * @param {string} name
 * @returns {Promise<number | null>}
 */
export async function run(argv, io, name) {
  // `refresh` and `acceptance` hand their flags to the script that owns them.
  const passThrough = name === "refresh" || name === "acceptance";
  if (passThrough && (argv.includes("--help") || argv.includes("-h"))) {
    io.out(usage(name));
    return EXIT.ok;
  }
  const options = name === "doctor" ? { "dense-smoke": { type: "boolean" }, "search-eval": { type: "boolean" } } : {};
  const positionals = name === "galaxy" ? { max: Infinity, names: "scopes" } : name === "backup" ? { max: 1, names: "label" } : {};
  const { values, positionals: words } = passThrough
    ? { values: {}, positionals: argv }
    : parseCommandLine(argv, { command: name, options, positionals });
  if (values.help) {
    io.out(usage(name));
    return EXIT.ok;
  }

  switch (name) {
    case "mcp": {
      // Nothing may reach stdout before the server: it is the protocol channel.
      const { runStdioServer } = await import("../server.mjs");
      await runStdioServer();
      return null;
    }
    case "doctor":
      // `include_dense_smoke` is what the health check recommends, so the
      // command it prints under can take it (docs/DEFECTS.md, Д-77).
      return callAndPrint(io, "system_health_check", {
        include_search_smoke: true,
        include_dense_smoke: Boolean(values["dense-smoke"]),
        include_search_eval: Boolean(values["search-eval"])
      });
    case "reindex":
      return callAndPrint(io, "rebuild_search_index", { include_external_project_files: true, dense_embeddings: false, preserve_dense: true });
    case "dashboard":
      return callAndPrint(io, "rebuild_system_dashboard", { rebuild_search: false });
    case "galaxy":
      return callAndPrint(io, "render_knowledge_galaxy", words.length ? { scopes: words } : {});
    case "distribution":
      return callAndPrint(io, "runtime_distribution_status", {});
    case "refresh":
      return runChild(process.execPath, [path.join(SERVER_ROOT, "scripts", "rebuild-live-state.mjs"), ...words]);
    case "acceptance": {
      // Spawned, not imported: the Docker image ships neither the runner nor
      // the suite it drives, and a missing-module stack trace is not an answer.
      const runner = path.join(SERVER_ROOT, "scripts", "acceptance.mjs");
      if (!await fs.access(runner).then(() => true, () => false)) {
        io.err("acceptance is not available in this runtime: it runs in a source checkout, and this one ships neither the tests nor the dev dependencies.");
        return EXIT.failed;
      }
      return runChild(process.execPath, [runner, ...words]);
    }
    case "backup":
      if (process.platform !== "win32") {
        // Saying so beats spawning a powershell.exe that is not there (Д-61).
        io.err("backup is Windows-only: it runs 09-mcp/scripts/backup-ai-dev-system.ps1, and no cross-platform backup "
          + "script ships with this runtime. Copy the vault and the AI Dev home (AI_DEV_HOME) instead; in Docker, back up "
          + "the /data volume (docker/README.md).");
        return EXIT.failed;
      }
      return runChild("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.resolve(SERVER_ROOT, "..", "scripts", "backup-ai-dev-system.ps1"), "-Label", words[0] || "cli"]);
    default:
      return EXIT.usage;
  }
}
