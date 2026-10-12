/**
 * The control API: the tools the desktop app drives — what state the install
 * is in, setting it up, the local model, the AI clients it is connected to,
 * its logs, its settings and an overview of the work. They are the opt-in
 * `control` profile (`core/tool-profiles.mjs`): a session lists them only
 * when it names the profile, and an agent's context does not carry them.
 *
 * Each answer follows `core/control-contract.mjs`, handed to the client as the
 * tool's `outputSchema`; `docs/CONTROL-API.md` is rendered from the same
 * module. The long ones — setup, the model's download, import and check —
 * report progress and stop when the request is cancelled.
 *
 * In the daemon every call runs in its own client's environment, so a download
 * goes through that client's proxy and a client config is written for the
 * user the client runs as.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { installClients, listClients, removeClients } from "../core/client-connections.mjs";
import { CONTROL_API_VERSION, CONTROL_RESULTS, wrappedOutputSchema } from "../core/control-contract.mjs";
import { readDenseManifest } from "../core/dense-manifest.mjs";
import { parseClientSelection } from "../core/mcp-clients.mjs";
import { defaultOnnxModelDir } from "../core/dense-onnx.mjs";
import { currentInstallLayout } from "../core/install-layout.mjs";
import { MAX_TAIL_LINES, resolveLogFile, tailLines } from "../core/log-tail.mjs";
import { importModel, installModel, modelStatus, removeModel, verifyModel } from "../core/model-manager.mjs";
import { logsDir } from "../core/runtime-paths.mjs";
import { servingProcess } from "../core/serving-process.mjs";
import { SETTINGS, readSettings, sessionEnvironment, writeSettings } from "../core/settings.mjs";
import { inspectSetup, loadSetupSteps, runSetup } from "../core/setup-runner.mjs";
import { workspaceOverview } from "../core/workspace-overview.mjs";

/** The answer's version, for an app to check before it reads anything else. */
export { CONTROL_API_VERSION };

const CLIENTS_INPUT = {
  description: "\"all\" (every client found here), or client names: claude-code, claude-desktop, cursor, vscode, codex, gemini.",
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }]
};

/** The tools whose effect cannot be taken back: their annotations say so. */
const DESTRUCTIVE = new Set(["model_remove", "clients_remove"]);

/** A definition: the input schema, the contract's answer, no other properties. */
function tool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: wrappedOutputSchema(CONTROL_RESULTS[name]),
    ...(DESTRUCTIVE.has(name) ? { annotations: { destructiveHint: true } } : {})
  };
}

/** Arguments the schema does not know are refused, not ignored: a typo would otherwise do the default. */
function only(args, allowed) {
  const unknown = Object.keys(args ?? {}).filter((name) => !allowed.includes(name));
  if (unknown.length) throw new Error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. This tool takes ${allowed.length ? allowed.join(", ") : "none"}.`);
  return args ?? {};
}

function flag(args, name, fallback = false) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  return value;
}

/** A client selection: `all`, a comma list, or an array of names. */
function clientSpec(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error("clients is required: \"all\", or the client names.");
    return undefined;
  }
  if (Array.isArray(value)) {
    if (!value.length || value.some((name) => typeof name !== "string" || !name.trim())) throw new Error("clients must list client names.");
    return value.join(",");
  }
  if (typeof value !== "string" || !value.trim()) throw new Error("clients must be \"all\" or client names.");
  return value;
}

/** An error's message for the middle of a sentence. */
const clauseOf = (error) => String(error?.message ?? error ?? "").trim().replace(/\.+$/, "");

function countChanges(results) {
  return {
    changed: results.filter((result) => ["added", "updated", "removed", "restored"].includes(result.status)).length,
    failed: results.filter((result) => result.status === "failed").length
  };
}

/** What `settings_set` says of when its changes take effect. */
const APPLIES_NOTE = {
  now: "in force now, in this session too",
  new_session: "used by sessions started from now on — this one keeps what it started with until it reconnects",
  next_daemon: "used by the daemon started next — the running one keeps its own until it stops",
  app: "read by the desktop app"
};

function settingsNote(applies) {
  const names = Object.keys(applies);
  if (!names.length) return "Nothing changed: every value was already this.";
  const groups = new Map();
  for (const name of names) groups.set(applies[name], [...(groups.get(applies[name]) ?? []), name]);
  return `Saved. ${[...groups].map(([when, group]) => `${group.join(", ")}: ${APPLIES_NOTE[when]}`).join("; ")}. A variable set in a client's environment still wins over the file.`;
}

/** The model as the contract shows it. */
function modelState(status) {
  return {
    installed: status.installed,
    dir: status.dir,
    model: status.model,
    revision: status.revision,
    dtype: status.dtype,
    present: status.present,
    missing: status.missing,
    mismatched: status.mismatched,
    partial: status.partial,
    supported: status.supported,
    support_reason: status.support_reason,
    sources: status.sources
  };
}

/**
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createControlTools(host) {
  const version = (() => {
    try {
      return String(JSON.parse(readFileSync(path.join(host.serverRoot, "package.json"), "utf8")).version ?? "");
    } catch {
      return "";
    }
  })();
  const model = () => {
    const env = sessionEnvironment();
    return { env, manifest: readDenseManifest(), dir: defaultOnnxModelDir({ env }) };
  };
  const currentModel = async () => {
    const { env, manifest, dir } = model();
    return modelState(await modelStatus({ manifest, dir, env }));
  };
  const modelChange = async (placed) => {
    const model = await currentModel();
    return {
      ready: Boolean(placed.ready),
      dir: placed.dir,
      // An import says what it copied; what is there after it is the model's
      // own state (docs/DEFECTS.md, Д-223).
      present: placed.present ?? model.present,
      missing: placed.missing ?? model.missing,
      mismatched: placed.mismatched ?? model.mismatched,
      ...(placed.downloaded !== undefined ? { downloaded: placed.downloaded, resumed: placed.resumed ?? 0, bytes: placed.bytes ?? 0 } : {}),
      ...(placed.copied ? { copied: placed.copied, skipped: placed.skipped ?? [], from: placed.from } : {}),
      model
    };
  };
  const runtime = () => ({
    callTool: host.callTool,
    vaultRoot: host.vaultRoot,
    searchIndexPath: host.searchIndexPath,
    skillRoutingEvalCasesPath: host.skillRoutingEvalCasesPath
  });

  return {
    definitions: [
      tool("system_status", "What state this install is in, in one answer: ok, degraded or failed, and why — the version, where the data is, the process serving it, the local model, the search index, the AI clients connected, the settings' problems and the health checks. The desktop app's tray colour. Read-only.", {
        checks: { type: "boolean", default: true, description: "Run the health checks (about a second, more while Frontend QA's browser starts); false answers from what is on disk only — what a tray that polls asks for." }
      }),
      tool("setup_run", "Build what a fresh install does not ship — the skill registry, its quality report, the search index, the routing benchmark — and, when asked, the local model with its document vectors, Frontend QA, and the AI clients' configs. What is already built and current is skipped. Reports progress; a cancelled run stops after the current piece and keeps what is done.", {
        model: { type: "boolean", default: false, description: "Also download the local BGE-M3 model (about 600 MB) and embed the documents." },
        frontend_qa: { type: "boolean", default: false, description: "Also install the Frontend QA runner's dependencies and its Chromium." },
        clients: CLIENTS_INPUT,
        force: { type: "boolean", default: false, description: "Rebuild what is already there." }
      }),
      tool("model_install", "Download the local search model, checksum-verified, continuing a download that was cut off, through the mirror in the settings or AI_DEV_MODEL_MIRROR and the session's proxy. Reports bytes and speed; a cancelled download keeps what it fetched. Does not embed the documents: setup_run with model does, or rebuild_search_index.", {}),
      tool("model_import", "Put the local model in place from a folder or a .zip you already have (another machine, a USB stick), checked file by file against the pinned manifest. Reports progress; cancellable.", {
        source: { type: "string", description: "An absolute path to a folder or a .zip holding the model's files." }
      }, ["source"]),
      tool("model_verify", "Hash every file of the local model against the pinned manifest. Reports progress; cancellable. Read-only.", {}),
      tool("model_remove", "Delete the local model's files. Dense search stops until it is installed again; word search goes on. Only the model's own files are removed.", {
        confirm: { type: "boolean", description: "Must be true: the files are gone afterwards." }
      }, ["confirm"]),
      tool("clients_list", "Every MCP client this machine can have — Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini — whether it is installed, and what its ai-dev entry runs: this install, another one, Docker, the 2.x name, or nothing. Read-only.", {}),
      tool("clients_install", "Connect AI clients to this install: write the ai-dev entry into their configs (and take out ai-dev-system, the 2.x name). Each changed file keeps its previous bytes beside it. A client reads its config when it starts.", {
        clients: { ...CLIENTS_INPUT, default: "all" },
        dry_run: { type: "boolean", default: false, description: "Say what would change, write nothing." }
      }),
      tool("clients_remove", "Disconnect AI clients: take the ai-dev entry out of their configs; a file nothing else touched since goes back byte for byte.", {
        clients: { ...CLIENTS_INPUT, description: "Which clients; every config ai-dev could be in when left out." },
        confirm: { type: "boolean", description: "Must be true, unless dry_run is." },
        dry_run: { type: "boolean", default: false, description: "Say what would change, write nothing." }
      }),
      tool("logs_tail", "The last lines of a log in the runtime home's logs folder — the daemon's by default. Read-only.", {
        log: { type: "string", default: "daemon", description: "daemon, daemon.1 (the part set aside at 1 MB), or another log's file name." },
        lines: { type: "integer", minimum: 1, maximum: MAX_TAIL_LINES, default: 200 }
      }),
      tool("settings_get", "The settings the desktop app changes, from ~/.ai-dev/config.json: each value in force — an environment variable's where one overrides the file — where it comes from (default, the file, or that variable), the file's own values, what each setting means, and any stored value that is not valid. Read-only.", {}),
      tool("settings_set", "Change settings: each value is checked first, and nothing is written when one is wrong; null puts a setting back to its default. The answer says when each change takes effect: the mirror at once, the model folder and the profiles for sessions started afterwards (reconnect to use them), the idle time for the daemon started next. A variable set in a client's environment still wins.", {
        settings: { type: "object", description: `Settings to change: ${Object.keys(SETTINGS).join(", ")}.` }
      }, ["settings"]),
      tool("workspace_overview", "The work at a glance: the registered projects, the tasks open and lately finished, the epics and how far each has come, the latest decisions, and what the work has cost. Read-only.", {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10, description: "How many tasks, epics and decisions to list." }
      })
    ],
    handlers: {
      async system_status(args = {}) {
        const withChecks = flag(only(args, ["checks"]), "checks", true);
        const env = process.env;
        const layout = currentInstallLayout();
        const settings = (() => {
          try {
            return readSettings({ env }).problems;
          } catch (error) {
            return [error.message];
          }
        })();
        const [modelNow, index, clients, health] = await Promise.all([
          currentModel(),
          host.searchIndexStatus({ include_external_project_files: true }).catch((error) => ({ index_exists: false, unreadable: clauseOf(error) })),
          listClients({ env }).catch(() => []),
          withChecks ? host.handler("system_health_check")({ include_search_smoke: false, include_dense_smoke: false, include_search_eval: false }).catch((error) => ({ status: "fail", checks: [{ name: "system_health_check", status: "fail", summary: error.message }] })) : null
        ]);
        const checks = (health?.checks ?? []).map((check) => ({
          name: check.name,
          status: check.status,
          summary: String(check.summary ?? ""),
          ...(typeof check.critical === "boolean" ? { critical: check.critical } : {}),
          ...(check.details && typeof check.details === "object" && !Array.isArray(check.details) ? { details: check.details } : {})
        }));
        const built = index.index_exists === true;
        const failed = health?.status === "fail" || !built;
        const degraded = health?.status === "degraded" || settings.length > 0 || Boolean(index.stale);
        const status = failed ? "failed" : degraded ? "degraded" : "ok";
        const problems = [
          ...(index.unreadable ? [`the search index could not be read: ${index.unreadable}`] : []),
          ...(!built && !index.unreadable ? ["the search index is not built (setup_run builds it)"] : []),
          ...checks.filter((check) => check.status === "fail" || check.status === "warn").map((check) => `${check.name}: ${check.summary}`),
          ...settings
        ];
        return {
          api_version: CONTROL_API_VERSION,
          status,
          summary: problems.length ? problems.slice(0, 3).join("; ") : "Everything this install needs is in place.",
          version,
          install: { kind: layout.kind, root: layout.root, vault_root: host.vaultRoot, runtime_root: layout.runtimeRoot },
          served_by: servingProcess(),
          model: modelNow,
          index: {
            exists: built,
            documents: Number(index.indexed_document_count ?? 0),
            dense_documents: Number(index.dense_documents ?? 0),
            dense_pending: Number(index.dense_pending_documents ?? 0),
            fresh: built && !index.stale,
            built_at: index.built_at || null
          },
          clients: { found: clients.filter((client) => client.found).length, connected: clients.filter((client) => client.connected).length },
          settings_problems: settings,
          checks
        };
      },

      async setup_run(args = {}, { onProgress, signal } = {}) {
        only(args, ["model", "frontend_qa", "clients", "force"]);
        const want = { model: flag(args, "model"), frontendQa: flag(args, "frontend_qa") };
        const force = flag(args, "force");
        const clients = args.clients === false ? undefined : clientSpec(args.clients);
        // A misspelt client is refused before anything is built, as the CLI
        // refuses it (docs/DEFECTS.md, Д-220).
        if (clients) parseClientSelection(clients);
        const env = sessionEnvironment();
        const steps = await loadSetupSteps();
        const inspection = await inspectSetup({ runtime: runtime(), env, steps });
        const results = await runSetup({ runtime: runtime(), env, steps, inspection, want, force, signal, onProgress, commandOutput: "capture" });
        const cancelled = Boolean(signal?.aborted);
        const connected = clients && !cancelled ? await installClients({ spec: clients, env }) : null;
        return {
          succeeded: !cancelled && !results.some((step) => step.status === "failed") && !connected?.some((result) => result.status === "failed"),
          steps: results.map((step) => ({
            id: step.id,
            title: step.title,
            status: step.status,
            ...(step.reason ? { reason: String(step.reason) } : {}),
            ...(step.error ? { error: step.error } : {}),
            ...(Number.isFinite(step.duration_ms) ? { duration_ms: step.duration_ms } : {})
          })),
          clients: connected
        };
      },

      async model_install(args = {}, { onProgress, signal } = {}) {
        only(args, []);
        const { env, manifest, dir } = model();
        const notes = [];
        const placed = await installModel({ manifest, dir, env, signal, onProgress, log: (line) => notes.push(line) });
        return { ...await modelChange(placed), notes };
      },

      async model_import(args = {}, { onProgress, signal } = {}) {
        const { source } = only(args, ["source"]);
        if (typeof source !== "string" || !source.trim()) throw new Error("source is required: the folder or .zip to import the model from.");
        // The daemon runs in another folder than the app that asks: a relative
        // path would be read against the daemon's.
        if (!path.isAbsolute(source)) throw new Error(`source must be an absolute path, not ${JSON.stringify(source)}.`);
        const { manifest, dir } = model();
        return modelChange(await importModel({ manifest, source, dir, signal, onProgress }));
      },

      async model_verify(args = {}, { onProgress, signal } = {}) {
        only(args, []);
        const { manifest, dir } = model();
        const verified = await verifyModel({ manifest, dir, onProgress, signal });
        return { ready: verified.ready, dir: verified.dir, present: verified.present, missing: verified.missing, mismatched: verified.mismatched };
      },

      async model_remove(args = {}) {
        only(args, ["confirm"]);
        if (args.confirm !== true) throw new Error("model_remove deletes the model's files: call it with confirm true.");
        const { manifest, dir } = model();
        const removed = await removeModel({ manifest, dir });
        return { dir: removed.dir, removed: removed.removed, kept: removed.kept, freed_bytes: removed.freed };
      },

      async clients_list(args = {}) {
        only(args, []);
        const clients = await listClients({ env: process.env });
        return {
          clients: clients.map(({ row, legacy, variant, ...client }) => ({ ...client, ...(variant ? { variant } : {}), legacy }))
        };
      },

      async clients_install(args = {}) {
        only(args, ["clients", "dry_run"]);
        const results = await installClients({ spec: clientSpec(args.clients) ?? "all", apply: !flag(args, "dry_run"), env: process.env });
        return { results, ...countChanges(results) };
      },

      async clients_remove(args = {}) {
        only(args, ["clients", "confirm", "dry_run"]);
        const dryRun = flag(args, "dry_run");
        if (!dryRun && args.confirm !== true) throw new Error("clients_remove takes ai-dev out of client configs: call it with confirm true, or dry_run true to see what it would do.");
        const results = await removeClients({ spec: clientSpec(args.clients), apply: !dryRun, env: process.env });
        return { results, ...countChanges(results) };
      },

      async logs_tail(args = {}) {
        only(args, ["log", "lines"]);
        if (args.lines !== undefined && (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > MAX_TAIL_LINES)) {
          throw new Error(`lines must be a whole number from 1 to ${MAX_TAIL_LINES}.`);
        }
        const { log, file } = resolveLogFile(logsDir(), args.log);
        return { log, file, ...await tailLines(file, { lines: args.lines ?? 200, links: false }) };
      },

      async settings_get(args = {}) {
        only(args, []);
        const current = readSettings({ env: process.env });
        return {
          ...current,
          definitions: Object.entries(SETTINGS).map(([name, setting]) => ({
            name,
            type: setting.type,
            default: setting.default,
            env: setting.env ?? null,
            applies: setting.applies,
            description: setting.description
          }))
        };
      },

      async settings_set(args = {}) {
        only(args, ["settings"]);
        const result = await writeSettings(args.settings, { env: process.env });
        return { ...result, note: settingsNote(result.applies) };
      },

      async workspace_overview(args = {}) {
        only(args, ["limit"]);
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
          throw new Error("limit must be a whole number from 1 to 100.");
        }
        return workspaceOverview({
          projects: () => host.projectSummaries({ dedupe: true }),
          tasks: (options) => host.taskStore.list(options),
          usage: (options) => host.handler("usage_report")(options)
        }, { limit: args.limit });
      }
    },
    readOnly: ["system_status", "model_verify", "clients_list", "logs_tail", "settings_get", "workspace_overview"]
  };
}
