/**
 * Which MCP clients run this install, and putting it into them or taking it
 * out: what `ai-dev clients` and `ai-dev setup` print and the control tools
 * (`clients_list`, `clients_install`, `clients_remove`) answer. Reading and
 * writing each client's config file is `mcp-clients.mjs`; this decides which
 * clients, with which command, and records what was written.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stableLaunch } from "./app-bundle.mjs";
import { APP_MARKER, appCli, appFolder } from "./app-home.mjs";
import { EXIT } from "./cli-args.mjs";
import { DISTRIBUTION_MARKER, PACKAGE_NAME, currentInstallLayout } from "./install-layout.mjs";
import {
  SERVER_NAME,
  clientEntry,
  describeEntry,
  discoverClients,
  installServer,
  parseClientSelection,
  readServerEntries,
  removeServer
} from "./mcp-clients.mjs";
import { explicitRuntimeHome, resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** `ai-dev-mcp-server/` of this install. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI a client config runs. */
export const CLI_PATH = path.join(SERVER_ROOT, "bin", "ai-dev.mjs");

/** A path under the home folder written as `~/…`, as a person reads it. */
export function tildify(target, home = os.homedir()) {
  if (!home || !target) return target;
  const relative = path.relative(home, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return `~${path.sep}${relative}`;
}

/** Where the record of written configs lives: the runtime home's state. */
export function clientStatePath(env = process.env) {
  return path.join(resolveRuntimeStateRoot("", env), "state", "mcp-clients.json");
}

/** The Obsidian vault this server sits in, if it sits in one (`<vault>/09-mcp/ai-dev-mcp-server`). */
function vaultAround(serverRoot) {
  const candidate = path.resolve(serverRoot, "..", "..");
  return existsSync(path.join(candidate, "03-skills-catalog")) || existsSync(path.join(candidate, "01-system")) ? candidate : "";
}

/** The CLI of the copy `setup` installed in the app home for this very package, or "". */
function installedAppCli(layout) {
  try {
    const distribution = JSON.parse(readFileSync(path.join(layout.root, DISTRIBUTION_MARKER), "utf8"));
    const folder = appFolder(layout.runtimeRoot, distribution);
    const marker = JSON.parse(readFileSync(path.join(folder, APP_MARKER), "utf8"));
    return marker.content_fingerprint === distribution.content_fingerprint && existsSync(appCli(folder)) ? appCli(folder) : "";
  } catch {
    return "";
  }
}

/**
 * The command line a client starts this install with: this Node, by its full
 * path, so a client that does not inherit the shell's PATH (Claude Desktop on
 * macOS, any GUI app launched from the Dock) still finds it; this CLI's file;
 * `mcp`. A vault install passes its vault on, as 2.x did, and a runtime folder
 * named by `AI_DEV_HOME` goes with it too: a client started from the Dock does
 * not see the shell's variables, and its server would look for the index,
 * the state and a package's vault in ~/.ai-dev instead (docs/DEFECTS.md, Д-176).
 *
 * A package npx runs from its cache is launched from the copy `setup`
 * installed in the app home, never from the cache npm may clear. The Windows
 * install is launched through its stable link, `<runtime>/app/current`: the
 * Node and the CLI of whichever runtime the app made current, so an update
 * changes no config (`app-bundle.mjs`).
 *
 * @param {{ env?: NodeJS.ProcessEnv, execPath?: string, cliPath?: string, serverRoot?: string, layout?: import("./install-layout.mjs").InstallLayout, appCliPath?: () => string, stable?: (layout: import("./install-layout.mjs").InstallLayout) => { command: string, cli: string } | null }} [options]
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function localLaunch({ env = process.env, execPath = process.execPath, cliPath = CLI_PATH, serverRoot = SERVER_ROOT, layout = currentInstallLayout(), appCliPath = () => installedAppCli(layout), stable = stableLaunch } = {}) {
  const vault = env.AI_DEV_VAULT_ROOT ? path.resolve(env.AI_DEV_VAULT_ROOT) : vaultAround(serverRoot);
  const runtimeHome = explicitRuntimeHome(env);
  let cli = cliPath;
  let command = execPath;
  const link = layout.kind === "package" ? stable(layout) : null;
  if (link) {
    command = link.command;
    cli = link.cli;
  } else if (layout.kind === "package" && layout.ephemeral) {
    cli = appCliPath();
    if (!cli) {
      throw Object.assign(new Error(`This copy runs from npx's cache (${layout.root}), which npm may clear, so a client config must not name it. `
        + `Run \`npx ${PACKAGE_NAME} setup\` first: it installs a copy that stays, and connects the clients to it.`), { exitCode: EXIT.failed });
    }
  }
  return {
    command,
    args: [cli, "mcp"],
    env: { ...(vault ? { AI_DEV_VAULT_ROOT: vault } : {}), ...(runtimeHome ? { AI_DEV_HOME: runtimeHome } : {}) }
  };
}

/**
 * The targets a selection picks: every detected one for `all`, every target
 * of a named client whether detected or not.
 *
 * @param {import("./mcp-clients.mjs").ClientTarget[]} targets
 * @param {string | undefined} spec - `all`, or client names separated by commas.
 * @returns {{ chosen: import("./mcp-clients.mjs").ClientTarget[], skipped: import("./mcp-clients.mjs").ClientTarget[] }}
 */
export function chooseTargets(targets, spec) {
  const selection = parseClientSelection(spec ?? "all");
  if (selection.all) {
    return { chosen: targets.filter((target) => target.detected), skipped: targets.filter((target) => !target.detected) };
  }
  const chosen = targets.filter((target) => selection.ids.includes(target.client)
    // The Store build's own config exists only where that build is installed.
    && (target.variant !== "store" || target.detected));
  return { chosen, skipped: [] };
}

/** A target's name as a person reads it. */
export function clientLabel(target) {
  return target.variant === "store" ? `${target.label} (Store)` : target.label;
}

/**
 * Put this install into the chosen clients.
 *
 * @param {object} options
 * @param {string | undefined} options.spec - `all` (the default) or client names.
 * @param {boolean} [options.apply]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {Promise<Array<object>>} Results, skipped clients included.
 */
export async function installClients({ spec, apply = true, env = process.env, home = os.homedir() }) {
  const targets = await discoverClients({ home, env });
  const { chosen, skipped } = chooseTargets(targets, spec);
  const launch = localLaunch({ env });
  const results = await installServer({
    targets: chosen,
    entryFor: (target) => clientEntry(target, launch),
    apply,
    statePath: clientStatePath(env)
  });
  return [
    ...results,
    ...skipped.map((target) => ({ client: target.client, label: target.label, file: target.file, status: "skipped", reason: `not installed (no ${tildify(target.marker, home)})` }))
  ];
}

/**
 * Take this server out of the chosen clients — every config it could be in
 * when none are named, installed or not.
 *
 * @param {{ spec?: string, apply?: boolean, env?: NodeJS.ProcessEnv, home?: string }} options
 * @returns {Promise<Array<object>>}
 */
export async function removeClients({ spec, apply = true, env = process.env, home = os.homedir() }) {
  const targets = await discoverClients({ home, env });
  const { chosen } = spec ? chooseTargets(targets, spec) : { chosen: targets };
  return removeServer({ targets: chosen, apply, statePath: clientStatePath(env) });
}

/**
 * Every client target, whether it is installed, and what its `ai-dev` entry
 * runs: this install, another one, Docker, the 2.x name, or nothing.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {Promise<Array<{ client: string, variant?: string, label: string, file: string, found: boolean, connected: boolean, entry: string, legacy: string[], error?: string, row: object }>>}
 */
export async function listClients({ env = process.env, home = os.homedir() } = {}) {
  let launch = null;
  try {
    launch = localLaunch({ env });
  } catch {
    // From npx's cache before setup: nothing here is "this install" yet.
  }
  const rows = await readServerEntries(await discoverClients({ home, env }));
  return rows.map((row) => {
    const current = row.entries[SERVER_NAME];
    const kind = current === undefined ? "none" : describeEntry(current, launch ? clientEntry(row, launch) : undefined).kind;
    const legacy = Object.keys(row.entries).filter((name) => name !== SERVER_NAME && row.entries[name] !== undefined);
    return {
      client: row.client,
      ...(row.variant ? { variant: row.variant } : {}),
      label: clientLabel(row),
      file: row.file,
      found: Boolean(row.detected),
      connected: kind === "current",
      entry: row.error ? "unreadable" : current === undefined ? (legacy.length ? "2.x" : "none") : kind === "current" ? "this install" : kind,
      legacy,
      ...(row.error ? { error: row.error } : {}),
      row
    };
  });
}
