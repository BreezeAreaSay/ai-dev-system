#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../src/core/direct-execution.mjs";

const SUPPORTED_CLIENTS = new Set(["cursor", "gemini", "vscode", "claude"]);

function parseArgs(argv) {
  const options = { apply: false, clients: [...SUPPORTED_CLIENTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--clients") {
      options.clients = String(argv[index + 1] || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const unsupported = options.clients.filter((client) => !SUPPORTED_CLIENTS.has(client));
  if (unsupported.length) throw new Error(`Unsupported clients: ${unsupported.join(", ")}`);
  return options;
}

// Where this script's own server is. A vault install has it at
// `<vault>/09-mcp/ai-dev-mcp-server/`; a plain checkout has it right here, and
// computing the path from a vault root that does not exist produced
// `<home>/09-mcp/ai-dev-mcp-server/src/server.mjs` and a refusal to install
// anything — for the one command a new user is told to run.
const localServerPath = path.resolve(fileURLToPath(new URL("../src/server.mjs", import.meta.url)));
const repoVaultRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** The Obsidian layout, by the two directories the server itself looks for. */
function looksLikeVault(root) {
  return existsSync(path.join(root, "03-skills-catalog")) || existsSync(path.join(root, "01-system"));
}

function resolvePython(nodeExecutable) {
  if (process.env.AI_DEV_PYTHON) return process.env.AI_DEV_PYTHON;
  // Codex-runtime layout: <runtime>/node/bin/node + <runtime>/python/...
  const bundled = path.resolve(
    path.dirname(nodeExecutable),
    "..",
    "..",
    "python",
    process.platform === "win32" ? "python.exe" : "bin/python"
  );
  return existsSync(bundled) ? bundled : "python3";
}

/**
 * Where Node, the server and Python are, for the client configuration.
 *
 * Exported for the test: the server path is the one thing here that used to be
 * computed from a vault that a plain checkout does not have.
 */
export function portablePaths({
  home = os.homedir(),
  platform = process.platform,
  // Where the editor configuration tree lives, which is a different place on
  // each platform. This used to be the Windows answer everywhere, so on macOS
  // and Linux `--apply` created `~/AppData/Roaming/Code/User/mcp.json` — a
  // folder neither system has — and VS Code went on not knowing about the
  // server (docs/DEFECTS.md, Д-74). `install-docker-mcp-clients.mjs` resolves
  // it correctly; this is the same resolution.
  appData = platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : platform === "win32"
      ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
  nodeExecutable = process.execPath,
  vaultRoot = process.env.AI_DEV_VAULT_ROOT
    || (looksLikeVault(repoVaultRoot) ? repoVaultRoot : "")
} = {}) {
  // Without a vault the server finds the bundled seed itself, so the client
  // config carries no AI_DEV_VAULT_ROOT rather than a guess at one.
  const linkedVaultRoot = vaultRoot ? path.resolve(vaultRoot) : "";
  const vaultServerPath = linkedVaultRoot
    ? path.join(linkedVaultRoot, "09-mcp", "ai-dev-mcp-server", "src", "server.mjs")
    : "";
  const serverPath = vaultServerPath && existsSync(vaultServerPath) ? vaultServerPath : localServerPath;
  const pythonExecutable = resolvePython(nodeExecutable);
  return {
    home,
    appData,
    linkedVaultRoot,
    serverPath,
    nodeExecutable,
    pythonExecutable
  };
}

export function buildClientServerConfig(client, paths = portablePaths()) {
  const config = {
    command: paths.nodeExecutable,
    args: [paths.serverPath],
    env: {
      ...(paths.linkedVaultRoot ? { AI_DEV_VAULT_ROOT: paths.linkedVaultRoot } : {}),
      AI_DEV_PYTHON: paths.pythonExecutable
    }
  };
  return ["vscode", "claude"].includes(client)
    ? { type: "stdio", ...config }
    : config;
}

export function mergeClientDocument(client, current, serverConfig) {
  const document = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  const key = client === "vscode" ? "servers" : "mcpServers";
  document[key] = {
    ...(document[key] && typeof document[key] === "object" ? document[key] : {}),
    "ai-dev-system": serverConfig
  };
  return document;
}

function clientTargets(paths) {
  return {
    cursor: path.join(paths.home, ".cursor", "mcp.json"),
    gemini: path.join(paths.home, ".gemini", "settings.json"),
    vscode: path.join(paths.appData, "Code", "User", "mcp.json"),
    claude: path.join(paths.home, ".claude.json")
  };
}

async function readJsonDocument(target) {
  let text;
  try {
    text = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read ${target}: ${error.message}`);
  }
  // An empty file is a client that made the file and wrote nothing yet, which
  // is not the same as a corrupt one. VS Code ships exactly that, and a zero-byte
  // mcp.json used to end the whole install with "Unexpected end of JSON input"
  // — for every client, not just that one (docs/DEFECTS.md, Д-74).
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${target}: ${error.message}`);
  }
}

function backupSuffix() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

async function installClient(client, target, paths, { apply }) {
  const current = await readJsonDocument(target);
  const next = mergeClientDocument(client, current, buildClientServerConfig(client, paths));
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (currentText === nextText) return { client, target, status: "current" };
  if (!apply) return { client, target, status: "would-update" };

  await fs.mkdir(path.dirname(target), { recursive: true });
  let backup = null;
  try {
    await fs.access(target);
    backup = `${target}.backup-${backupSuffix()}`;
    await fs.copyFile(target, backup);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(target, nextText, "utf8");
  return { client, target, status: "updated", backup };
}

export async function installLocalMcpClients(options = {}) {
  const paths = portablePaths(options);
  const targets = clientTargets(paths);
  const missing = [];
  for (const [label, candidate] of [
    ["Node.js", paths.nodeExecutable],
    ["MCP entrypoint", paths.serverPath],
    ...(paths.linkedVaultRoot ? [["AI Dev vault link", paths.linkedVaultRoot]] : [])
  ]) {
    try {
      await fs.access(candidate);
    } catch {
      missing.push(`${label}: ${candidate}`);
    }
  }
  if (missing.length) throw new Error(`Required local paths are missing:\n${missing.join("\n")}`);

  const results = [];
  for (const client of options.clients || [...SUPPORTED_CLIENTS]) {
    try {
      results.push(await installClient(client, targets[client], paths, options));
    } catch (error) {
      // Report it against the client it belongs to and carry on. One
      // unparseable file used to abort the run before any client was written
      // (docs/DEFECTS.md, Д-74): the reader saw a stack trace and an install
      // that had done nothing, with no way to tell which file was at fault.
      results.push({
        client,
        target: targets[client],
        status: "failed",
        error: String(error?.message ?? error)
      });
    }
  }
  const failed = results.filter((item) => item.status === "failed");
  return {
    status: failed.length
      ? (failed.length === results.length ? "failed" : "partial")
      : (options.apply ? "applied" : "dry-run"),
    transport: "stdio",
    server: paths.serverPath,
    clients: results
  };
}

function usage() {
  return [
    "Install the local AI Dev MCP server for common AI clients.",
    "",
    "Usage:",
    "  node scripts/install-local-mcp-clients.mjs [--apply] [--clients cursor,gemini,vscode,claude]",
    "",
    "Without --apply the command only reports planned changes."
  ].join("\n");
}

if (await isDirectExecution(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(await installLocalMcpClients(options), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
