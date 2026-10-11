/**
 * `ai-dev clients list | install | remove | doctor` — the `ai-dev` entry in
 * every MCP client on this machine. The writing is `core/mcp-clients.mjs`;
 * this is the part that chooses the clients and says what happened.
 */
import os from "node:os";
import path from "node:path";
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import { checkServerCommand } from "../core/mcp-client-check.mjs";
import {
  SERVER_NAME,
  clientEntry,
  describeEntry,
  discoverClients,
  installServer,
  parseClientSelection,
  readServerEntries,
  removeServer
} from "../core/mcp-clients.mjs";
import { resolveRuntimeStateRoot } from "../core/runtime-home.mjs";
import { localLaunch, tildify } from "./context.mjs";

const SUBCOMMANDS = ["list", "install", "remove", "doctor"];

export function usage() {
  return [
    "Usage: ai-dev clients <list | install | remove | doctor> [options]",
    "",
    "  list       every supported client, whether it is installed, and what its ai-dev entry runs",
    "  install    add ai-dev to the clients (and take out ai-dev-system, the 2.x name)",
    "  remove     take ai-dev out again; a file nothing else touched since goes back byte for byte",
    "  doctor     start each client's ai-dev command and check it answers initialize",
    "",
    "  --clients=<names>   all (every client found here; the default), or some of claude-code,",
    "                      claude-desktop, cursor, vscode, codex, gemini (claude = both Claude apps).",
    "                      A client named here is written even where it does not look installed.",
    "  --dry-run           install and remove: say what would change, write nothing",
    "  --timeout=<seconds> doctor: how long each command has to answer initialize (30)",
    "  --json              print the result as JSON",
    "",
    "Each changed file keeps its previous bytes as <file>.backup-<time>."
  ].join("\n");
}

/** Where the record of written configs lives: the runtime home's state. */
export function clientStatePath(env = process.env) {
  return path.join(resolveRuntimeStateRoot("", env), "state", "mcp-clients.json");
}

/**
 * The targets a `--clients` value picks: every detected one for `all`, every
 * target of a named client whether detected or not.
 *
 * @param {import("../core/mcp-clients.mjs").ClientTarget[]} targets
 * @param {string | undefined} spec
 * @returns {{ chosen: import("../core/mcp-clients.mjs").ClientTarget[], skipped: import("../core/mcp-clients.mjs").ClientTarget[] }}
 */
export function chooseTargets(targets, spec) {
  let selection;
  try {
    selection = parseClientSelection(spec ?? "all");
  } catch (error) {
    throw new CliUsageError(error.message);
  }
  if (selection.all) {
    return { chosen: targets.filter((target) => target.detected), skipped: targets.filter((target) => !target.detected) };
  }
  const chosen = targets.filter((target) => selection.ids.includes(target.client)
    // The Store build's own config exists only where that build is installed.
    && (target.variant !== "store" || target.detected));
  return { chosen, skipped: [] };
}

const STATUS_WORD = {
  added: "added",
  updated: "updated",
  unchanged: "unchanged",
  "would-add": "would add",
  "would-update": "would update",
  removed: "removed",
  restored: "restored",
  absent: "not there",
  "would-remove": "would remove",
  "would-restore": "would restore",
  failed: "FAILED",
  skipped: "skipped"
};

function labelOf(target) {
  return target.variant === "store" ? `${target.label} (Store)` : target.label;
}

/** One line per result, for a person. */
export function renderResults(results, { home = os.homedir() } = {}) {
  return results.map((result) => {
    const notes = [];
    if (result.previous === "docker") notes.push("replaced the Docker launcher entry");
    else if (result.previous === "local") notes.push("replaced the entry of another install");
    else if (result.previous && result.previous !== "current") notes.push(`replaced an ${SERVER_NAME} entry that ran something else`);
    if (result.migrated?.length) notes.push(`removed the 2.x entry ${result.migrated.join(", ")}`);
    if (result.backup) notes.push(`previous file: ${tildify(result.backup, home)}`);
    if (result.reason) notes.push(result.reason);
    const tail = result.status === "failed" ? `: ${result.error}` : notes.length ? ` — ${notes.join("; ")}` : "";
    return `  ${labelOf(result).padEnd(24)}${(STATUS_WORD[result.status] ?? result.status).padEnd(14)}${tildify(result.file, home)}${tail}`;
  });
}

/** The closing sentence: what changed, what failed, and what to do next. */
export function summarize(results, { removing = false } = {}) {
  const counted = results.filter((result) => result.status !== "skipped");
  const failed = counted.filter((result) => result.status === "failed");
  const changed = counted.filter((result) => ["added", "updated", "removed", "restored"].includes(result.status));
  const planned = counted.filter((result) => result.status.startsWith("would-"));
  const lines = [];
  if (!counted.length) {
    lines.push(removing ? "No client config to change." : "No client found here. Name one to write it anyway: --clients=cursor,vscode,…");
  } else if (planned.length) {
    lines.push(`Dry run: ${planned.length} file(s) would change, ${counted.length - planned.length - failed.length} would stay as they are.`);
  } else if (!changed.length && !failed.length) {
    lines.push(removing ? "No changes: no client has ai-dev in its config." : "No changes: every client already runs this install.");
  } else {
    lines.push(`${changed.length} changed, ${counted.length - changed.length - failed.length} unchanged${failed.length ? `, ${failed.length} failed` : ""}.`);
  }
  if (changed.length && !removing) {
    const names = [...new Set(changed.map((result) => labelOf(result)))];
    lines.push(`Restart ${names.join(", ")} to pick it up (a running client reads its config at start).`);
  }
  if (failed.length) lines.push("A failed file was left exactly as it was; fix what it says and run the command again.");
  return lines;
}

/**
 * Put this install into the chosen clients; used by `ai-dev setup` too.
 *
 * @param {object} options
 * @param {string | undefined} options.spec - `--clients`.
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

function describeForList(row, expected, home) {
  if (row.error) return `unreadable: ${row.error}`;
  if (!row.exists) return "no config file yet";
  const current = row.entries[SERVER_NAME];
  const legacy = Object.entries(row.entries).find(([name, value]) => name !== SERVER_NAME && value !== undefined);
  const parts = [];
  if (current !== undefined) {
    const kind = describeEntry(current, expected);
    parts.push(kind.kind === "current" ? "ai-dev → this install"
      : kind.kind === "docker" ? "ai-dev → Docker launcher"
        : kind.kind === "local" ? `ai-dev → another install: ${tildify(kind.script, home)}`
          : `ai-dev → ${kind.command || "an entry without a command"}`);
  }
  if (legacy) {
    const kind = describeEntry(legacy[1]);
    parts.push(`${legacy[0]} (2.x) → ${tildify(kind.script ?? kind.command ?? "?", home)}`);
  }
  if (!parts.length) return "no ai-dev entry";
  if (current === undefined || describeEntry(current, expected).kind !== "current") parts.push("`ai-dev clients install` points it here");
  return parts.join("; ");
}

async function list(values, io) {
  const home = os.homedir();
  const launch = localLaunch({ env: io.env });
  const rows = await readServerEntries(await discoverClients({ home, env: io.env }));
  if (values.json) {
    io.out(JSON.stringify({ clients: rows.map((row) => ({ client: row.client, variant: row.variant, file: row.file, detected: row.detected, exists: row.exists, entries: row.entries, error: row.error, current: row.entries[SERVER_NAME] !== undefined && describeEntry(row.entries[SERVER_NAME], clientEntry(row, launch)).kind === "current" })) }, null, 2));
    return EXIT.ok;
  }
  for (const row of rows) {
    const state = row.detected ? describeForList(row, clientEntry(row, launch), home) : "not installed";
    io.out(`  ${labelOf(row).padEnd(24)}${state}`);
    io.out(`  ${"".padEnd(24)}${tildify(row.file, home)}`);
  }
  return EXIT.ok;
}

async function install(values, io) {
  const results = await installClients({ spec: values.clients, apply: !values["dry-run"], env: io.env });
  if (values.json) io.out(JSON.stringify({ clients: results }, null, 2));
  else {
    for (const line of renderResults(results)) io.out(line);
    io.out();
    for (const line of summarize(results)) io.out(line);
  }
  return results.some((result) => result.status === "failed") ? EXIT.failed : EXIT.ok;
}

async function remove(values, io) {
  const targets = await discoverClients({ env: io.env });
  // Removing looks everywhere a config could be, installed or not.
  const { chosen } = values.clients ? chooseTargets(targets, values.clients) : { chosen: targets };
  const results = await removeServer({ targets: chosen, apply: !values["dry-run"], statePath: clientStatePath(io.env) });
  const shown = results.filter((result) => result.status !== "absent" || values.clients);
  if (values.json) io.out(JSON.stringify({ clients: results }, null, 2));
  else {
    for (const line of renderResults(shown)) io.out(line);
    if (shown.length) io.out();
    for (const line of summarize(shown, { removing: true })) io.out(line);
  }
  return results.some((result) => result.status === "failed") ? EXIT.failed : EXIT.ok;
}

async function doctor(values, io) {
  const home = os.homedir();
  const targets = await discoverClients({ home, env: io.env });
  const { chosen } = chooseTargets(targets, values.clients);
  const rows = await readServerEntries(chosen);
  const seconds = values.timeout === undefined ? 30 : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // A bad value used to run the check anyway and report "within NaN s" (docs/DEFECTS.md, Д-172).
    throw new CliUsageError(`--timeout takes the seconds each command has to answer, a number above 0; "${values.timeout}" is not one.`);
  }
  const timeoutMs = seconds * 1000;
  const report = [];
  for (const row of rows) {
    const named = [SERVER_NAME, ...Object.keys(row.entries).filter((name) => name !== SERVER_NAME)]
      .filter((name) => row.entries[name] !== undefined);
    if (row.error) {
      report.push({ client: row.client, label: labelOf(row), file: row.file, ok: false, error: `unreadable: ${row.error}` });
      continue;
    }
    if (!named.length) {
      report.push({ client: row.client, label: labelOf(row), file: row.file, ok: null, note: "no ai-dev entry — `ai-dev clients install` adds it" });
      continue;
    }
    for (const name of named) {
      const entry = row.entries[name];
      const kind = describeEntry(entry).kind;
      if (kind === "docker" || kind === "invalid") {
        report.push({ client: row.client, label: labelOf(row), file: row.file, name, ok: null, note: kind === "docker" ? "a Docker launcher: not started here" : "the entry is not an object" });
        continue;
      }
      const check = await checkServerCommand(entry, { timeoutMs, env: io.env });
      report.push({ client: row.client, label: labelOf(row), file: row.file, name, ...check });
    }
  }
  if (values.json) io.out(JSON.stringify({ clients: report }, null, 2));
  else {
    for (const item of report) {
      const head = `  ${item.label.padEnd(24)}${item.name && item.name !== SERVER_NAME ? `${item.name}: ` : ""}`;
      if (item.ok === null) io.out(`${head}${item.note}`);
      else if (item.ok) io.out(`${head}ok — ${item.server?.name ?? "server"} ${item.server?.version ?? ""} answered in ${item.ms} ms, instructions ${item.instructions} chars`);
      else io.out(`${head}FAILED — ${item.error}`);
    }
    if (!report.length) io.out("No client found here.");
  }
  return report.some((item) => item.ok === false) ? EXIT.failed : EXIT.ok;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    io.out(usage());
    return subcommand ? EXIT.ok : EXIT.usage;
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    const near = closest(subcommand, SUBCOMMANDS);
    throw new CliUsageError(`\`ai-dev clients\` has no "${subcommand}".${near ? ` Did you mean \`ai-dev clients ${near}\`?` : ""} It takes ${SUBCOMMANDS.join(", ")}.`);
  }
  const options = {
    list: { json: { type: "boolean" } },
    install: { clients: { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
    remove: { clients: { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
    doctor: { clients: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } }
  }[subcommand];
  const { values } = parseCommandLine(rest, { command: `clients ${subcommand}`, options });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  if (values.clients === false) throw new CliUsageError(`\`ai-dev clients ${subcommand}\`: --no-clients leaves nothing to do.`);
  if (subcommand === "list") return list(values, io);
  if (subcommand === "install") return install(values, io);
  if (subcommand === "remove") return remove(values, io);
  return doctor(values, io);
}
