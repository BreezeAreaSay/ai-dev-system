import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = String(process.argv[2] || "help").toLowerCase();
const arguments_ = process.argv.slice(3);

function printHelp() {
  console.log(`AI Dev System local CLI

Commands:
  start                 Start the stdio MCP server
  doctor                Run local system diagnostics
  dashboard             Regenerate the live Obsidian dashboard
  reindex               Rebuild text search while preserving dense vectors
  refresh [flags]       Refresh overlays, outcomes, search, runtime, and dashboard
  acceptance            Run the full local acceptance suite
  backup [label]        Create a local ZIP backup plus SHA-256 (Windows only)
  distribution          Validate local/VPS distribution boundaries
`);
}

// The child inherits stdio and has already said what went wrong, so its exit
// code is passed on rather than rethrown: a stack trace here would bury it.
function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      shell: false
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function runNode(script, args = []) {
  process.exitCode = await runChild(process.execPath, [script, ...args]);
}

async function runPowerShell(script, args = []) {
  process.exitCode = await runChild("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args
  ]);
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "start") {
  await import("../src/server.mjs");
} else if (command === "acceptance") {
  // The cross-platform runner behind `npm run acceptance`; the PowerShell one
  // was a Windows wrapper around it (docs/DEFECTS.md, Д-61). It is spawned, not
  // imported: the Docker image ships neither it nor the suite it drives, and a
  // missing-module stack trace is not an answer.
  const runner = path.resolve(root, "scripts", "acceptance.mjs");
  if (await fs.access(runner).then(() => true, () => false)) {
    await runNode(runner, arguments_);
  } else {
    console.error([
      "acceptance is not available in this runtime: it runs in a source checkout,",
      "and this one ships neither the tests nor the dev dependencies."
    ].join(" "));
    process.exitCode = 1;
  }
} else if (command === "refresh") {
  process.argv.splice(2, process.argv.length - 2, ...arguments_);
  await import("./rebuild-live-state.mjs");
} else if (command === "backup") {
  if (process.platform === "win32") {
    await runPowerShell(
      path.resolve(root, "..", "scripts", "backup-ai-dev-system.ps1"),
      ["-Label", arguments_[0] || "cli"]
    );
  } else {
    // Saying so beats spawning a powershell.exe that is not there
    // (docs/DEFECTS.md, Д-61).
    console.error([
      "backup is Windows-only: it runs 09-mcp/scripts/backup-ai-dev-system.ps1,",
      "and no cross-platform backup script ships with this runtime.",
      "Copy the vault and the AI Dev home (AI_DEV_HOME) instead;",
      "in Docker, back up the /data volume (docker/README.md)."
    ].join(" "));
    process.exitCode = 1;
  }
} else {
  const { callTool, shutdownBgeWorkers } = await import("../src/mcp-stdio.mjs");
  try {
    let tool;
    let input;
    if (command === "doctor") {
      tool = "system_health_check";
      input = {
        include_search_smoke: true,
        include_dense_smoke: false,
        include_search_eval: false
      };
    } else if (command === "dashboard") {
      tool = "rebuild_system_dashboard";
      input = { rebuild_search: false };
    } else if (command === "reindex") {
      tool = "rebuild_search_index";
      input = {
        include_external_project_files: true,
        dense_embeddings: false,
        preserve_dense: true
      };
    } else if (command === "distribution") {
      tool = "runtime_distribution_status";
      input = {};
    } else {
      printHelp();
      process.exitCode = 1;
    }
    if (tool) {
      const result = await callTool(tool, input);
      console.log(result.content.find((item) => item.type === "text")?.text || "{}");
    }
  } finally {
    await shutdownBgeWorkers();
  }
}
