/**
 * `ai-dev clients list | install | remove | doctor` — the `ai-dev` entry in
 * every MCP client on this machine. The writing is `core/mcp-clients.mjs`;
 * this is the part that chooses the clients and says what happened.
 */
import os from "node:os";
import path from "node:path";
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import {
  chooseTargets as chooseClientTargets,
  clientLabel,
  dockerOptions,
  installClients as installClientConfigs,
  localLaunch,
  removeClients,
  tildify,
  unsharedStateNote
} from "../core/client-connections.mjs";
import {
  CONTAINER_MODELS,
  CONTAINER_MODEL_DIR,
  CONTAINER_STATE_ROOT,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_DOCKER_VOLUME,
  dockerEntryOptions,
  dockerLaunch,
  missingBindSources,
  unreadableMounts
} from "../core/docker-launch.mjs";
import { checkServerCommand } from "../core/mcp-client-check.mjs";
import { MCP_CLIENTS, SERVER_NAME, clientEntry, describeEntry, discoverClients, parseClientSelection, readServerEntries } from "../core/mcp-clients.mjs";

export { clientStatePath } from "../core/client-connections.mjs";

const SUBCOMMANDS = ["list", "install", "remove", "doctor", "entry"];

export function usage() {
  return [
    "Usage: ai-dev clients <list | install | remove | doctor | entry> [options]",
    "",
    "  list       every supported client, whether it is installed, and what its ai-dev entry runs",
    "  install    add ai-dev to the clients (and take out ai-dev-system, the 2.x name)",
    "  remove     take ai-dev out again; an untouched file goes back as it was, less any ai-dev entry the install",
    "             replaced (its backup keeps it)",
    "  doctor     start each client's ai-dev command and check it answers initialize",
    "  entry <client>  print the entry install would write for one client, as JSON (writes nothing)",
    "",
    "  --clients=<names>   all (every client found here; the default), or some of claude-code,",
    "                      claude-desktop, cursor, vscode, codex, gemini (claude = both Claude apps).",
    "                      A client named here is written even where it does not look installed.",
    "  --dry-run           install and remove: say what would change, write nothing",
    "  --timeout=<seconds> doctor: how long each command has to answer initialize (30)",
    "  --json              print the result as JSON",
    "",
    "  --docker            install and entry: the clients run the server in Docker, `docker run -i --rm …`:",
    `    --image=<ref>         the image (${DEFAULT_DOCKER_IMAGE})`,
    "    --projects=<folder>   the projects folder the server sees (~/AI-Dev-Projects); made if missing",
    "    --model=<folder>      a folder holding bge-m3-onnx/, mounted read-only (otherwise the model is the volume's:",
    "                          `docker run --rm -it --network bridge … <image> ai-dev model install` puts it there once)",
    "    --volume=<name>       the data volume (ai-dev-system-data)",
    "    --state=<folder>      the state folder shared with the agent hooks (~/.ai-dev/state, where the image's user,",
    "                          uid 1000, is yours or Docker Desktop maps it); made if missing",
    "    --shared-state=yes|no|untried  decided already, and explained, by the caller (bootstrap.sh tries it); by default",
    "                          a Linux host tries it with the image (not pulled for it) before it goes into an entry",
    "    --docker-command=<path>  the Docker CLI (found on PATH)",
    "    --home, --platform    the host's, when this runs in the image on its behalf (bootstrap.sh)",
    "",
    "Each changed file keeps its previous bytes as <file>.backup-<time>."
  ].join("\n");
}

/** The options of `--docker`, read from the command line; the host's when it runs in the image on its behalf. */
async function dockerFrom(values, io, { apply = true, tryState = apply } = {}) {
  if (!values.docker) {
    const named = ["image", "projects", "model", "volume", "state", "shared-state", "docker-command"].find((name) => values[name] !== undefined);
    if (named) throw new CliUsageError(`--${named} is an option of --docker; add --docker to run the clients' server in Docker.`);
    return null;
  }
  const home = values.home || os.homedir();
  const platform = values.platform || process.platform;
  if (!["linux", "darwin", "win32"].includes(platform)) throw new CliUsageError(`--platform takes linux, darwin or win32; "${platform}" is not one.`);
  const shareState = values["shared-state"] ?? "";
  if (!["", "yes", "no", "untried"].includes(shareState)) throw new CliUsageError(`--shared-state takes yes, no or untried; "${shareState}" is not one.`);
  const paths = platform === "win32" ? path.win32 : path.posix;
  try {
    return await dockerOptions({
      image: values.image,
      volume: values.volume,
      projects: values.projects,
      model: values.model,
      // Named by the host, or under the home it names: the image's own AI_DEV_HOME is not the host's.
      state: values.state || (values.home ? paths.join(values.home, ".ai-dev", "state") : ""),
      shareState,
      docker: values["docker-command"],
      home,
      platform,
      env: io.env,
      apply,
      tryState
    });
  } catch (error) {
    throw new CliUsageError(error.message);
  }
}

/**
 * The targets a `--clients` value picks: every detected one for `all`, every
 * target of a named client whether detected or not.
 *
 * @param {import("../core/mcp-clients.mjs").ClientTarget[]} targets
 * @param {string | undefined} spec
 */
export function chooseTargets(targets, spec) {
  try {
    return chooseClientTargets(targets, spec);
  } catch (error) {
    throw new CliUsageError(error.message);
  }
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

const labelOf = clientLabel;

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
 * Put this install into the chosen clients; used by `ai-dev setup` too. A
 * `--clients` value that names no client is a usage error here.
 *
 * @param {{ spec: string | undefined, apply?: boolean, env?: NodeJS.ProcessEnv, home?: string }} options
 * @returns {Promise<Array<object>>} Results, skipped clients included.
 */
export async function installClients(options) {
  chooseTargets([], options.spec);
  return installClientConfigs(options);
}

function describeForList(row, expected, home) {
  if (row.error) return `unreadable: ${row.error}`;
  if (!row.exists) return "no config file yet";
  const current = row.entries[SERVER_NAME];
  const legacy = Object.entries(row.entries).find(([name, value]) => name !== SERVER_NAME && value !== undefined);
  const parts = [];
  const kind = current === undefined ? null : describeEntry(current, expected);
  if (kind) {
    parts.push(kind.kind === "current" ? "ai-dev → this install"
      : kind.direct ? `ai-dev → Docker: ${current.args.at(-1)}`
        : kind.kind === "docker" ? "ai-dev → the 2.x Docker launcher; `ai-dev clients install --docker` runs docker directly instead"
          : kind.kind === "local" ? `ai-dev → another install: ${tildify(kind.script, home)}`
            : `ai-dev → ${kind.command || "an entry without a command"}`);
  }
  if (legacy) {
    const old = describeEntry(legacy[1]);
    parts.push(`${legacy[0]} (2.x) → ${tildify(old.script ?? old.command ?? "?", home)}`);
  }
  if (!parts.length) return "no ai-dev entry";
  // A client run in Docker was chosen so: it is not pointed back at this install.
  if (!kind || (kind.kind !== "current" && kind.kind !== "docker")) parts.push("`ai-dev clients install` points it here");
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
  const docker = await dockerFrom(values, io, { apply: !values["dry-run"] });
  const results = await installClients({
    spec: values.clients,
    apply: !values["dry-run"],
    env: io.env,
    ...(docker ? { docker, home: values.home || os.homedir(), platform: docker.platform } : {})
  });
  // What the entries depend on that may go away: a model on another disk (Д-385), a state folder not shared.
  const note = [docker?.model?.note, unsharedStateNote(docker)].filter(Boolean).join("\n");
  if (values.json) io.out(JSON.stringify({ clients: results, ...(note ? { note } : {}) }, null, 2));
  else {
    for (const line of renderResults(results)) io.out(line);
    io.out();
    for (const line of summarize(results)) io.out(line);
    if (note) io.out(note);
  }
  return results.some((result) => result.status === "failed") ? EXIT.failed : EXIT.ok;
}

async function remove(values, io) {
  // Removing looks everywhere a config could be, installed or not.
  if (values.clients) chooseTargets([], values.clients);
  const results = await removeClients({ spec: values.clients, apply: !values["dry-run"], env: io.env });
  const shown = results.filter((result) => result.status !== "absent" || values.clients);
  if (values.json) io.out(JSON.stringify({ clients: results }, null, 2));
  else {
    for (const line of renderResults(shown)) io.out(line);
    if (shown.length) io.out();
    for (const line of summarize(shown, { removing: true })) io.out(line);
  }
  return results.some((result) => result.status === "failed") ? EXIT.failed : EXIT.ok;
}

/**
 * One word of a command to copy into a terminal: as it is where the shell reads
 * it so, quoted otherwise. On Windows that shell is PowerShell, where double
 * quotes still expand `$`: a word goes in single quotes there, a quote in it
 * doubled — the typographic ones are quotes to PowerShell too (Д-417).
 *
 * @param {string} word
 * @param {string} [platform]
 * @returns {string}
 */
export function commandWord(word, platform = process.platform) {
  if (platform === "win32") return /^[\w%+=:./\\-][\w@%+=:./\\-]*$/.test(word) ? word : `'${word.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * What `clients doctor` says of a Docker entry whose mounted folder is not here
 * (Д-385): the folder — for a link, where it leads — and what to do. The model
 * is optional, so the entries can be written without one; a projects or state
 * folder is one install makes again — but not through a link that leads
 * nowhere, so for that one the command takes another folder, for the person to
 * name. The command keeps the options the entry runs with: writing the entries
 * again with none of them put the default image in place of the one the entry
 * ran (docs/DEFECTS.md, Д-397). It writes this client's entry alone: written for
 * every client found, it made a client of a local install a Docker one, and it
 * drops `--model` whichever of the folders gone is the model's (Д-414).
 *
 * @param {string} client - The id of the client whose entry it is.
 * @param {{ args?: unknown }} entry
 * @param {Array<{ source: string, target: string, leadsTo?: string }>} gone - From {@link missingBindSources}.
 * @returns {string}
 */
function missingMountError(client, entry, gone) {
  const [first] = gone;
  const options = dockerEntryOptions(entry?.args);
  const roleOf = (mount) => (mount.target === CONTAINER_MODELS || mount.target === CONTAINER_MODEL_DIR ? "model"
    : mount.target === CONTAINER_STATE_ROOT ? "state" : "projects");
  const roles = [...new Set(gone.map(roleOf))];
  // mkdir through a link that leads nowhere fails, so install cannot make that folder: another one is named (Д-414).
  const elsewhere = [...new Set(gone.filter((mount) => mount.leadsTo && roleOf(mount) !== "model").map(roleOf))];
  const folder = (role, value) => `--${role}=${elsewhere.includes(role) ? "<folder>" : value}`;
  const flags = ["--docker", `--image=${options.image}`, `--clients=${client}`];
  if (options.volume && options.volume !== DEFAULT_DOCKER_VOLUME) flags.push(`--volume=${options.volume}`);
  if (options.projects) flags.push(folder("projects", options.projects));
  if (options.state) flags.push(folder("state", options.state));
  if (options.model && !roles.includes("model")) flags.push(`--model=${options.model}`);
  const command = ["ai-dev", "clients", "install", ...flags].map((word) => commandWord(word)).join(" ");
  const what = first.leadsTo
    ? `the folder this entry mounts at ${first.target}: ${first.source} leads to ${first.leadsTo}, which is not here`
    : `the folder this entry mounts at ${first.target} is not here: ${first.source}`;
  const more = gone.length > 1 ? ` (nor ${gone.length > 2 ? "are the ones" : "is the one"} it mounts at ${gone.slice(1).map((mount) => mount.target).join(" and ")})` : "";
  const made = roles.filter((role) => role !== "model" && !elsewhere.includes(role));
  const ways = [
    ...(made.length ? [`, which makes the ${gone.length > 1 ? `${made.join(" and ")} ` : ""}folder${made.length > 1 ? "s" : ""}`] : []),
    ...elsewhere.map((role) => ` with another ${role} folder in place of <folder>, as install cannot make one through a link that leads nowhere`),
    ...(roles.includes("model") ? [" with another model folder (--model=<folder>) or with none, the model then the volume's"] : [])
  ];
  const disk = gone.length > 1 ? "them: connect the disks they are on" : `it: connect the disk ${first.leadsTo ? "it leads to" : "it is on"}`;
  return `${what}${more}. Docker starts no session without ${disk}, or write the entries again${ways.join(", and")}: \`${command}\`.`;
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
      const described = describeEntry(entry);
      const kind = described.kind;
      // A 3.0 entry runs `docker run` and answers its own handshake: started
      // like any other. A 2.x launcher answered the handshake itself, so
      // starting it here says nothing about the server (docs/DEFECTS.md, Д-89).
      if ((kind === "docker" && !described.direct) || kind === "invalid") {
        report.push({ client: row.client, label: labelOf(row), file: row.file, name, ok: null, note: kind === "docker" ? "a 2.x Docker launcher: not started here — `ai-dev clients install --docker` replaces it with one that is" : "the entry is not an object" });
        continue;
      }
      // A --mount Docker cannot read: it refuses the whole command over it, before any folder is looked at, and its
      // own words for that are not the last line it prints (Д-417).
      const unreadable = kind === "docker" ? unreadableMounts(entry?.args) : [];
      if (unreadable.length) {
        report.push({ client: row.client, label: labelOf(row), file: row.file, name, ok: false, error: `its --mount ${JSON.stringify(unreadable[0])} cannot be read: Docker refuses the whole command over it and starts no session — correct it in ${tildify(row.file, home)}.` });
        continue;
      }
      // A folder the entry mounts that is not there: Docker would start no container, and the client gets only its
      // error. Said as what it is, without starting it (Д-385).
      const gone = kind === "docker" ? missingBindSources(entry?.args) : [];
      if (gone.length) {
        report.push({ client: row.client, label: labelOf(row), file: row.file, name, ok: false, error: missingMountError(row.client, entry, gone) });
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
 * The entry one client would get, as JSON on stdout: for a client whose config
 * the caller writes by other means — `bootstrap.sh` hands Claude Code's to
 * `claude mcp add-json`, since its config is a file in the home, which the
 * image is not given.
 */
async function entry(values, positionals, io) {
  const [name] = positionals;
  let ids;
  try {
    ids = parseClientSelection(name).ids;
  } catch (error) {
    throw new CliUsageError(error.message);
  }
  if (ids.length !== 1) throw new CliUsageError(`"${name}" names ${ids.length} clients; name one: ${ids.join(", ")}.`);
  const client = MCP_CLIENTS.find((item) => item.id === ids[0]);
  // The entry install would write, the state folder's sharing tried as install tries it (Д-334).
  const docker = await dockerFrom(values, io, { apply: false, tryState: true });
  io.out(JSON.stringify(clientEntry(client, docker ? dockerLaunch(docker) : localLaunch({ env: io.env }))));
  for (const note of [docker?.model?.note, unsharedStateNote(docker)]) if (note) io.err(note);
  return EXIT.ok;
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
  const dockerFlags = {
    docker: { type: "boolean" },
    image: { type: "string" },
    projects: { type: "string" },
    model: { type: "string" },
    volume: { type: "string" },
    state: { type: "string" },
    "shared-state": { type: "string" },
    "docker-command": { type: "string" },
    home: { type: "string" },
    platform: { type: "string" }
  };
  const options = {
    list: { json: { type: "boolean" } },
    install: { clients: { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" }, ...dockerFlags },
    remove: { clients: { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
    doctor: { clients: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } },
    entry: dockerFlags
  }[subcommand];
  const { values, positionals } = parseCommandLine(rest, { command: `clients ${subcommand}`, options, positionals: subcommand === "entry" ? { min: 1, max: 1, names: "client" } : {} });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  if (values.clients === false) throw new CliUsageError(`\`ai-dev clients ${subcommand}\`: --no-clients leaves nothing to do.`);
  if (subcommand === "list") return list(values, io);
  if (subcommand === "install") return install(values, io);
  if (subcommand === "remove") return remove(values, io);
  if (subcommand === "entry") return entry(values, positionals, io);
  return doctor(values, io);
}
