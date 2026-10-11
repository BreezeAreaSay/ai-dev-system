#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isDirectExecution } from "../src/core/direct-execution.mjs";
import { MCP_CLIENTS, installServer } from "../src/core/mcp-clients.mjs";
import { renderTable, upsertTables } from "../src/core/toml-edit.mjs";

export const SUPPORTED_DOCKER_CLIENTS = new Set(["codex", "cursor", "gemini", "vscode", "claude"]);

function parseArgs(argv) {
  const options = { apply: false, clients: [...SUPPORTED_DOCKER_CLIENTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (["--clients", "--launcher", "--launcher-env", "--claude-launcher", "--runtime-container", "--image", "--project-path", "--model-path", "--home", "--app-data", "--platform"].includes(argument)) {
      options[argument.slice(2).replaceAll("-", "_")] = String(argv[index + 1] || "");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  options.clients = String(options.clients || "")
    .split(",")
    .map((client) => client.trim().toLowerCase())
    .filter(Boolean);
  const unsupported = options.clients.filter((client) => !SUPPORTED_DOCKER_CLIENTS.has(client));
  if (unsupported.length) throw new Error(`Unsupported clients: ${unsupported.join(", ")}`);
  for (const key of ["image", "project_path"]) {
    if (!options[key] && !options.help) throw new Error(`Missing required argument: --${key.replaceAll("_", "-")}`);
  }
  if (!options.launcher && !options.launcher_env && !options.help) {
    throw new Error("Missing required argument: --launcher or --launcher-env");
  }
  return options;
}

export function resolveLauncher(options, platform = process.platform) {
  const source = options.launcher || (options.launcher_env ? process.env[options.launcher_env] : "");
  if (!source) throw new Error("Docker launcher path is empty.");
  return (platform === "win32" ? path.win32 : path.posix).resolve(source);
}

export function localPaths({
  home = os.homedir(),
  appData,
  platform = process.platform
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolvedAppData = appData || (platform === "darwin"
    ? pathApi.join(home, "Library", "Application Support")
    : platform === "win32"
      ? process.env.APPDATA || pathApi.join(home, "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || pathApi.join(home, ".config"));
  return {
    home,
    appData: resolvedAppData,
    codex: pathApi.join(home, ".codex", "config.toml"),
    cursor: pathApi.join(home, ".cursor", "mcp.json"),
    gemini: pathApi.join(home, ".gemini", "settings.json"),
    vscode: pathApi.join(resolvedAppData, "Code", "User", "mcp.json"),
    claude: pathApi.join(home, ".claude.json"),
    claudeDesktop: pathApi.join(resolvedAppData, "Claude", "claude_desktop_config.json")
  };
}

export function clientInstallTargets(client, paths) {
  if (client === "claude") {
    return [
      { client: "claude-code", target: paths.claude },
      { client: "claude-desktop", target: paths.claudeDesktop }
    ];
  }
  return [{ client, target: paths[client] }];
}

export function windowsClaudeDesktopStoreConfigPath(packageRoot) {
  return path.win32.join(packageRoot, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
}

async function installedWindowsClaudeDesktopTargets(platform) {
  if (platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const packagesRoot = path.win32.join(process.env.LOCALAPPDATA, "Packages");
  let packages;
  try {
    packages = await fs.readdir(packagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets = [];
  for (const entry of packages) {
    if (!entry.isDirectory() || !entry.name.startsWith("Claude_")) continue;
    const target = windowsClaudeDesktopStoreConfigPath(path.win32.join(packagesRoot, entry.name));
    try {
      await fs.access(target);
      targets.push({ client: "claude-desktop-msix", target });
    } catch {
      // An installed MSIX Claude profile may not exist until its first launch.
    }
  }
  return targets;
}

async function localClientInstallTargets(client, paths, platform) {
  const targets = [...clientInstallTargets(client, paths)];
  if (client === "claude") targets.push(...await installedWindowsClaudeDesktopTargets(platform));
  const seen = new Set();
  return targets.filter(({ target }) => {
    const identity = platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function buildDockerClientServerConfig(client, {
  launcher,
  claudeLauncher,
  runtimeContainer,
  image,
  projectPath,
  modelPath,
  platform = process.platform
}) {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const resolvedLauncher = pathApi.resolve(
    client === "claude" && windows && claudeLauncher ? claudeLauncher : launcher
  );
  const launcherIsAscii = /^[\x00-\x7F]+$/.test(resolvedLauncher);
  const launcherIsExecutable = windows && pathApi.extname(resolvedLauncher).toLowerCase() === ".exe";
  const config = {
    command: launcherIsExecutable ? resolvedLauncher : windows ? "powershell.exe" : "/bin/sh",
    args: launcherIsExecutable
      ? []
      : windows
      ? launcherIsAscii
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedLauncher]
        : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& $env:AI_DEV_MCP_LAUNCHER"]
      : [resolvedLauncher],
    env: {
      AI_DEV_IMAGE: image,
      AI_DEV_PROJECT_PATH: pathApi.resolve(projectPath),
      // The folder above the model directories, which the launcher mounts as
      // /models. Without it the cold launch path, and every Windows launch, has
      // no way to reach the weights the user downloaded (docs/DEFECTS.md Д-69).
      ...(modelPath ? { AI_DEV_MODEL_PATH: pathApi.resolve(modelPath) } : {}),
      ...(windows ? { AI_DEV_MCP_LAUNCHER: resolvedLauncher } : {}),
      ...(!windows && runtimeContainer ? { AI_DEV_RUNTIME_CONTAINER: runtimeContainer } : {})
    }
  };
  return client === "vscode" ? { type: "stdio", ...config } : config;
}

export function mergeDockerClientDocument(client, current, serverConfig) {
  const document = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  const key = client === "vscode" ? "servers" : "mcpServers";
  document[key] = {
    ...(document[key] && typeof document[key] === "object" ? document[key] : {}),
    "ai-dev": serverConfig
  };
  return document;
}

/** The Codex entry: the launcher, plus the timeouts a cold container start needs. */
function codexEntry(serverConfig) {
  return { command: serverConfig.command, args: serverConfig.args, env: serverConfig.env, startup_timeout_sec: 120, tool_timeout_sec: 3600 };
}

export function buildCodexMcpSection(serverConfig, eol = "\n") {
  return renderTable(["mcp_servers", "ai-dev"], codexEntry(serverConfig), eol).replace(new RegExp(`${eol}$`), "");
}

/**
 * The Codex config with the ai-dev server's tables replaced, subtables and
 * quoted spellings included, through the same editor the CLI uses. A regular
 * expression over the header used to leave `[mcp_servers.ai-dev.env]` behind,
 * and a file Codex refuses to read (docs/DEFECTS.md, Д-162).
 */
export function mergeCodexDocument(current, serverConfig) {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  return upsertTables(current, ["mcp_servers", "ai-dev"], renderTable(["mcp_servers", "ai-dev"], codexEntry(serverConfig), eol));
}

/** The shared module's description of a target, by this installer's client name. */
function sharedTarget(name, file) {
  const id = name === "claude-desktop-msix" ? "claude-desktop" : name;
  const client = MCP_CLIENTS.find((item) => item.id === id);
  return { client: id, ...client, file, detected: true, marker: file, ...(name === "claude-desktop-msix" ? { variant: "store" } : {}) };
}

export async function installDockerMcpClients(options) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const launcher = resolveLauncher(options, platform);
  const claudeLauncher = options.claude_launcher ? pathApi.resolve(options.claude_launcher) : undefined;
  const projectPath = pathApi.resolve(options.project_path || options.projectPath);
  try {
    await fs.access(launcher);
  } catch {
    throw new Error(`Docker launcher is missing: ${launcher}`);
  }
  if (claudeLauncher) {
    try {
      await fs.access(claudeLauncher);
    } catch {
      throw new Error(`Claude MCP launcher is missing: ${claudeLauncher}`);
    }
  }
  const paths = localPaths({ ...options, appData: options.app_data || options.appData });
  const runtimeContainer = options.runtime_container || options.runtimeContainer;
  const modelPath = options.model_path || options.modelPath || "";
  const normalized = { ...options, launcher, claudeLauncher, runtimeContainer, projectPath, modelPath, platform };
  const targets = [];
  const asked = new Map();
  for (const client of options.clients || [...SUPPORTED_DOCKER_CLIENTS]) {
    for (const destination of await localClientInstallTargets(client, paths, platform)) {
      targets.push(sharedTarget(destination.client, destination.target));
      asked.set(destination.target, client);
    }
  }
  // One file at a time, through the module the CLI writes with: an empty or
  // unreadable file is that client's failure and the rest are still written;
  // each write goes through a temp file after a re-read (Д-162, Д-163). The
  // record of writes sits in the host's runtime home, where `ai-dev clients
  // remove` reads it — this may run in a container with another HOME.
  const results = await installServer({
    targets,
    entryFor: (target) => {
      const config = buildDockerClientServerConfig(asked.get(target.file), normalized);
      return target.format === "toml" ? codexEntry(config) : config;
    },
    apply: options.apply,
    statePath: pathApi.join(paths.home, ".ai-dev", "state", "mcp-clients.json")
  });
  const failed = results.filter((result) => result.status === "failed");
  return {
    status: failed.length ? (failed.length === results.length ? "failed" : "partial") : options.apply ? "applied" : "dry-run",
    transport: "docker-stdio",
    clients: results.map((result) => ({
      ...result,
      client: result.variant === "store" ? "claude-desktop-msix" : result.client,
      target: result.file
    }))
  };
}

function usage() {
  return [
    "Install the Docker AI Dev MCP launcher for local AI clients.",
    "",
    "Usage:",
    "  node scripts/install-docker-mcp-clients.mjs --apply --launcher <run-mcp> --image <image> --project-path <folder> [--model-path <folder>] [--runtime-container <name>] [--clients codex,cursor,gemini,vscode,claude]"
  ].join("\n");
}

if (await isDirectExecution(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const result = await installDockerMcpClients(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      for (const item of result.clients.filter((entry) => entry.status === "failed")) {
        process.stderr.write(`${item.client}: ${item.target}: ${item.error}\n`);
      }
      if (result.status === "failed" || result.status === "partial") process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
