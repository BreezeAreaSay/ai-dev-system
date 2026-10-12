/**
 * The environment a daemon session runs in: its own client's.
 *
 * One daemon serves every AI client of a user (`src/daemon.mjs`), but clients
 * do not share an environment. A terminal's PATH holds the user's gitleaks or a
 * virtualenv that an app started from the Dock lacks; one client goes through a
 * proxy and another does not. In 2.x every client ran a server of its own, and
 * a tool found the programs and the network its client had. The daemon keeps
 * that: the bridge sends its environment once the daemon has proven itself
 * (`daemon-channel.mjs`), and everything a session's messages set off — the
 * tools, the processes they start, the downloads they make — reads that
 * environment through `process.env`. Work of the daemon's own, outside any
 * session, reads the environment it was started with (docs/DEFECTS.md, Д-190).
 *
 * What clients of one daemon cannot set differently is what the server reads
 * once, when it loads, or shares between sessions: where its data is, which
 * model it loads. Those variables are part of the daemon's build
 * (`daemonWideEnvironment`), and a client that sets them otherwise is served by
 * a daemon of its own (Д-191).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import process from "node:process";

/**
 * The variables a daemon reads once or shares between its sessions: two
 * clients that set any of them differently are served by two daemons.
 */
export const DAEMON_WIDE_VARIABLES = Object.freeze([
  // Where the data is: the runtime home, the vault, the state, the index, the artifacts.
  "AI_DEV_HOME",
  "HOME",
  "USERPROFILE",
  "AI_DEV_VAULT_ROOT",
  "AI_DEV_STATE_ROOT",
  "AI_DEV_SEARCH_INDEX_DIR",
  "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_RECEIPTS_ROOT",
  // The model every session shares, and how it runs.
  "BGE_M3_ONNX_DIR",
  "BGE_M3_MODEL_DIR",
  "BGE_M3_DEVICE",
  "AI_DEV_MODEL_MANIFEST",
  "AI_DEV_DENSE_BACKEND",
  // The server's flavour.
  "AI_DEV_RUNTIME"
]);

const DAEMON_WIDE = new Set(DAEMON_WIDE_VARIABLES);

/**
 * AI Dev's own variables that are not the daemon's to share: each session
 * reads them from its own client's environment, the daemon's lifetime comes
 * from the client that started it, and the rest belong to the hooks, the
 * Docker launchers and the installers, and never reach the server. Any other
 * `AI_DEV_*` or `BGE_*` name counts as daemon-wide, so a variable added later
 * splits the daemon rather than leaks between clients until it is listed here.
 */
export const NOT_DAEMON_WIDE = Object.freeze({
  session: Object.freeze([
    "AI_DEV_PROFILES",
    "AI_DEV_OFFLINE",
    "AI_DEV_MODEL_MIRROR",
    "AI_DEV_PYTHON",
    "AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT",
    // Read only to tell their users that 3.0 removed the Python backend.
    "BGE_M3_PYTHON",
    "BGE_M3_PYTHON_REVISION",
    "AI_DEV_EMBEDDINGS_PYTHON",
    "AI_DEV_PYTHON_BASE"
  ]),
  lifecycle: Object.freeze(["AI_DEV_DAEMON", "AI_DEV_DAEMON_START_TIMEOUT_MS", "AI_DEV_IDLE_TIMEOUT_MS"]),
  hooks: Object.freeze([
    "AI_DEV_CONTEXT_WINDOW_TOKENS",
    "AI_DEV_DISABLED_HOOKS",
    "AI_DEV_FACT_FORCE",
    "AI_DEV_FACT_FORCE_EXEMPT",
    "AI_DEV_HOOKS_ENABLED",
    "AI_DEV_HOOK_PROFILE",
    "AI_DEV_OSV_API",
    "AI_DEV_SESSION_START_MAX_CHARS",
    "AI_DEV_SUPPLY_CHAIN"
  ]),
  launchers: Object.freeze([
    "AI_DEV_IMAGE",
    "AI_DEV_PROJECT_PATH",
    "AI_DEV_MODEL_PATH",
    "AI_DEV_DATA_VOLUME",
    "AI_DEV_DOCKER_NETWORK",
    "AI_DEV_RUNTIME_CONTAINER",
    "AI_DEV_MCP_LAUNCHER",
    "AI_DEV_MCP_BEARER_TOKEN",
    "AI_DEV_NODE",
    "AI_DEV_DEBUG_LOG",
    "AI_DEV_VERSION",
    "AI_DEV_BOOTSTRAP_NODE_IMAGE",
    "AI_DEV_INSTALLER_LAUNCHER"
  ]),
  tooling: Object.freeze([
    "AI_DEV_FAKE_BACKEND",
    "AI_DEV_MCP_SERVER_PATH",
    "AI_DEV_SOURCE_VAULT_ROOT",
    "AI_DEV_SYSTEM_ROOT",
    "AI_DEV_TEST_LAUNCHER",
    "AI_DEV_TEST_SH"
  ])
});

const NOT_DAEMON_WIDE_NAMES = new Set(Object.values(NOT_DAEMON_WIDE).flat());

/**
 * Variables that hold a path. The bridge resolves them against its own working
 * directory before anything else sees them: the daemon runs in another one,
 * and a relative `AI_DEV_HOME` meant one folder to the client and another to
 * the daemon it started (docs/DEFECTS.md, Д-194).
 */
const PATH_VARIABLES = new Set([
  "AI_DEV_HOME",
  "HOME",
  "USERPROFILE",
  "AI_DEV_VAULT_ROOT",
  "AI_DEV_STATE_ROOT",
  "AI_DEV_SEARCH_INDEX_DIR",
  "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_RECEIPTS_ROOT",
  "AI_DEV_MODEL_MANIFEST",
  "BGE_M3_ONNX_DIR",
  "BGE_M3_MODEL_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR"
]);

/** A variable's name as the system compares it: Windows ignores case. */
const foldName = (name, platform) => (platform === "win32" ? name.toUpperCase() : name);

/**
 * Whether two clients must set `name` alike to share a daemon.
 *
 * @param {string} name
 * @param {{ platform?: string }} [options]
 * @returns {boolean}
 */
export function isDaemonWide(name, { platform = process.platform } = {}) {
  const key = foldName(String(name), platform);
  if (DAEMON_WIDE.has(key)) return true;
  return /^(?:AI_DEV|BGE)_/.test(key) && !NOT_DAEMON_WIDE_NAMES.has(key);
}

/**
 * The daemon-wide variables `env` sets, sorted by name; a blank value counts
 * as unset, as the server reads it. On Windows the names are upper-cased.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ platform?: string }} [options]
 * @returns {Array<[string, string]>}
 */
export function daemonWideEnvironment(env, { platform = process.platform } = {}) {
  const found = new Map();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null || !String(value).trim()) continue;
    if (!isDaemonWide(name, { platform })) continue;
    const key = foldName(name, platform);
    if (!found.has(key)) found.set(key, String(value));
  }
  return [...found].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * A copy of `env` with every path variable made absolute against `cwd`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ cwd?: string, platform?: string }} [options]
 * @returns {Record<string, string>}
 */
export function absolutePathVariables(env, { cwd = process.cwd(), platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const copy = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    copy[name] = PATH_VARIABLES.has(foldName(name, platform)) && text.trim() && !paths.isAbsolute(text) ? paths.resolve(cwd, text) : text;
  }
  return copy;
}

/**
 * An environment object as `process.env` is one: string values, an assignment
 * stored as a string, and on Windows names that ignore case, so a session's
 * `Path` is found as `PATH`.
 *
 * @param {Record<string, unknown>} variables
 * @param {{ platform?: string }} [options]
 * @returns {Record<string, string>}
 */
export function environmentObject(variables, { platform = process.platform } = {}) {
  const fold = (name) => foldName(name, platform);
  const entries = new Map();
  for (const [name, value] of Object.entries(variables ?? {})) {
    if (value === undefined || value === null) continue;
    if (!entries.has(fold(name))) entries.set(fold(name), [name, String(value)]);
  }
  const own = (name) => typeof name === "string" && entries.has(fold(name));
  const store = (name, value) => {
    const key = fold(name);
    entries.set(key, [entries.get(key)?.[0] ?? name, String(value)]);
    return true;
  };
  return new Proxy({}, {
    get: (target, name) => (own(name) ? entries.get(fold(name))[1] : Reflect.get(target, name)),
    set: (target, name, value) => (typeof name === "string" ? store(name, value) : Reflect.set(target, name, value)),
    has: (target, name) => own(name) || Reflect.has(target, name),
    deleteProperty: (target, name) => {
      if (typeof name === "string") entries.delete(fold(name));
      return true;
    },
    ownKeys: () => [...entries.values()].map(([name]) => name),
    getOwnPropertyDescriptor: (target, name) => (own(name)
      ? { value: entries.get(fold(name))[1], writable: true, enumerable: true, configurable: true }
      : undefined),
    defineProperty: (target, name, descriptor) => (typeof name === "string" && "value" in descriptor ? store(name, descriptor.value) : false)
  });
}

const sessions = new AsyncLocalStorage();

/**
 * Run `operation` for a session: until it and everything it sets off are done,
 * `process.env` is `environment` — once {@link scopeProcessEnvironment} has
 * made it so in this process.
 *
 * @template T
 * @param {Record<string, string>} environment - from {@link environmentObject}
 * @param {() => T} operation
 * @returns {T}
 */
export function runInSession(environment, operation) {
  return sessions.run(environment, operation);
}

/** The environment of the session this code runs for, or null outside any session. */
export const currentSessionEnvironment = () => sessions.getStore() ?? null;

const scoped = new WeakSet();

/**
 * Make `target.env` the environment of the session the running code belongs
 * to, and the process's own outside any session. Done once, by the daemon,
 * before it loads the server; a process without sessions is never changed.
 *
 * Reading, writing, listing and spreading `process.env` all go to the
 * session's environment, and so does a child process started without an
 * `env` of its own. What reads the system's environment directly — native
 * code, `os.tmpdir()`, a worker thread's copy — sees the daemon's.
 *
 * @param {{ env: NodeJS.ProcessEnv }} [target]
 */
export function scopeProcessEnvironment(target = process) {
  if (scoped.has(target)) return;
  scoped.add(target);
  const own = target.env;
  const current = () => sessions.getStore() ?? own;
  target.env = new Proxy({}, {
    get: (_, name) => Reflect.get(current(), name),
    set: (_, name, value) => Reflect.set(current(), name, value),
    has: (_, name) => Reflect.has(current(), name),
    deleteProperty: (_, name) => Reflect.deleteProperty(current(), name),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_, name) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), name);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    defineProperty: (_, name, descriptor) => Reflect.defineProperty(current(), name, descriptor)
  });
}
