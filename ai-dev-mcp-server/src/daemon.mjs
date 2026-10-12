#!/usr/bin/env node
/**
 * The daemon: one warm server for every AI client of this user.
 *
 * Each client still starts a process of its own — `ai-dev mcp`, which is what
 * its config names — but that process is a bridge: it hands the client's
 * stdio to this daemon over a local socket (`src/core/daemon-bridge.mjs`).
 * The search index, the skill registry and the embedding model are loaded
 * once, here, and the state the tools write has one writer.
 *
 * What it does on its own:
 *
 * - takes `run/daemon.lock`, so one runtime home has one daemon;
 * - listens on a random address and publishes it, with a secret, in
 *   `run/daemon.json` (mode 0600); every connection proves it holds the secret
 *   before it is served (`src/core/daemon-channel.mjs`);
 * - keeps the session count in `daemon.json` live, answers `status`, `stop`
 *   and `retire` on a control connection, and logs what it does to stderr —
 *   `logs/daemon.log` when a bridge started it;
 * - exits after `AI_DEV_IDLE_TIMEOUT_MS` without a session (30 minutes), and
 *   when `daemon.json` no longer names it: a newer build took over, or someone
 *   removed the runtime home.
 *
 * Until 3.0 the daemon had no client at all, died on a socket path over 107
 * bytes and always said `sessions: 0` (docs/DEFECTS.md, Д-97); its Windows pipe
 * had a name anyone could take first (Д-107).
 */
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DAEMON_PROTOCOL,
  acceptHandshake,
  controlRequest,
  daemonBuild,
  newSecret,
  readDaemonInfo,
  readLine,
  removeDaemonInfo,
  writeDaemonInfo,
  writeLine
} from "./core/daemon-channel.mjs";
import { isDirectExecution } from "./core/direct-execution.mjs";
import { processAlive } from "./core/file-lock.mjs";
import { prepareRuntimeHome } from "./core/runtime-home-migration.mjs";
import {
  daemonAddressCandidates,
  daemonInfoPath,
  daemonLockPath,
  daemonLogPath,
  prepareSocketDirectory,
  runtimeDir
} from "./core/runtime-paths.mjs";
import { SocketServerTransport } from "./transport/socket.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(await fs.readFile(path.join(serverRoot, "package.json"), "utf8")).version;

/**
 * A daemon nobody is talking to should not outlive the day. Thirty minutes is
 * long enough that a client reconnecting between tasks finds a warm process,
 * short enough that a forgotten one goes away on its own.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** A lock this young may belong to a daemon that is still starting. */
const LOCK_STARTUP_GRACE_MS = 60_000;

/** How often the daemon checks that `daemon.json` still names it. */
const WATCH_INTERVAL_MS = 5_000;

/**
 * `AI_DEV_IDLE_TIMEOUT_MS`, or the default; 0 keeps the daemon until it is stopped.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function idleTimeoutMs(env = process.env) {
  const raw = String(env.AI_DEV_IDLE_TIMEOUT_MS ?? "").trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) ? Math.max(0, value) : DEFAULT_IDLE_TIMEOUT_MS;
}

/** A line for the daemon's log. */
function writeLog(line) {
  process.stderr.write(`${new Date().toISOString()} daemon ${process.pid}: ${line}\n`);
}

/** Who holds the lock: 2.x wrote a bare pid, this version a small JSON record. */
async function lockHolder(lockPath) {
  try {
    const [text, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
    let pid = Number(text.trim());
    if (!Number.isInteger(pid)) {
      try {
        pid = Number(JSON.parse(text).pid);
      } catch {
        pid = 0;
      }
    }
    return { pid: Number.isInteger(pid) ? pid : 0, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Whether the daemon `info` describes answers on its address. */
async function answers(info) {
  try {
    return (await controlRequest(info, "ping", { timeoutMs: 2_000 })).ok === true;
  } catch {
    return false;
  }
}

/**
 * Take the daemon lock. Exclusive create is the race protection: of two
 * daemons starting at once, one makes the file. A lock is taken over when its
 * pid is gone — or when its pid is alive, no daemon answers for it, and it is
 * older than a start takes: a pid the system has since given to another
 * program, or a daemon that hangs. Its process is left alone either way; a
 * pid in a file is not proof enough to kill anything.
 *
 * @returns {Promise<{ acquired: boolean, holder?: number }>}
 */
async function acquireLock({ lockPath, infoPath, log }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      return { acquired: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const holder = await lockHolder(lockPath);
    if (holder && holder.pid !== process.pid && processAlive(holder.pid)) {
      const info = await readDaemonInfo(infoPath);
      if (info?.pid === holder.pid && await answers(info)) return { acquired: false, holder: holder.pid };
      if (holder.ageMs < LOCK_STARTUP_GRACE_MS) return { acquired: false, holder: holder.pid };
      log(`taking the lock over from pid ${holder.pid}: the process is alive, but no daemon answers for it`);
    }
    await fs.rm(lockPath, { force: true });
  }
  return { acquired: false, holder: 0 };
}

/** Remove a file only while it still names this process. */
async function removeOwnLock(lockPath) {
  const holder = await lockHolder(lockPath);
  if (holder?.pid === process.pid) await fs.rm(lockPath, { force: true });
}

/**
 * Bind `listener` to an address: the umask keeps the socket this user's from
 * the moment it exists, and the chmod says so again.
 */
function listenOn(listener, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    listener.once("error", onError);
    // `listen` binds a path synchronously, so the umask is back before any
    // other code of this process creates a file.
    const previous = process.platform === "win32" ? null : process.umask(0o077);
    try {
      listener.listen(address, () => {
        listener.off("error", onError);
        resolve();
      });
    } finally {
      if (previous !== null) process.umask(previous);
    }
  });
}

/**
 * Listen on the first candidate address that works: a directory that is too
 * long, not this user's, or on a file system without sockets (a WSL mount, a
 * network share) passes the turn to the next one.
 */
async function listenSomewhere(listener, log) {
  const candidates = daemonAddressCandidates();
  let lastError = new Error("No directory leaves room for the daemon's socket.");
  for (const { address, directory } of candidates) {
    try {
      if (directory) await prepareSocketDirectory(directory);
      await listenOn(listener, address);
      if (directory) await fs.chmod(address, 0o600);
      return address;
    } catch (error) {
      lastError = error;
      log(`cannot listen at ${address}: ${error.message}`);
    }
  }
  throw lastError;
}

/**
 * Serve MCP to every client that connects, until stopped or idle.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [options]
 * @returns {Promise<boolean>} false when another daemon already serves this runtime home
 */
export async function runDaemon({ env = process.env, log = writeLog } = {}) {
  await prepareRuntimeHome({ env, log: (line) => log(line.replace(/^ai-dev: /, "")) });
  const infoPath = daemonInfoPath();
  const lockPath = daemonLockPath();
  await fs.mkdir(runtimeDir(), { recursive: true, mode: 0o700 });
  const lock = await acquireLock({ lockPath, infoPath, log });
  if (!lock.acquired) {
    log(`another daemon (pid ${lock.holder || "unknown"}) serves ${runtimeDir()}; this one is not needed`);
    return false;
  }

  // The tools, the index and the seed sync load while the socket already
  // takes connections; a session waits for them, a status request does not.
  let serverLoaded = false;
  const serverModule = import("./server.mjs").then((module) => {
    serverLoaded = true;
    return module;
  });
  serverModule.catch((error) => log(`the server failed to load: ${error.stack ?? error.message}`));

  const secret = newSecret();
  const build = await daemonBuild({ serverRoot, version: VERSION, env });
  const idleTimeout = idleTimeoutMs(env);
  const startedAt = new Date();
  const sockets = new Set();
  const clients = new Map();
  let sessions = 0;
  let served = 0;
  let retired = false;
  let stopping = false;
  let idleTimer = null;
  let watch = null;
  let address = "";

  const describe = () => ({
    protocol: DAEMON_PROTOCOL,
    pid: process.pid,
    version: VERSION,
    build,
    address,
    secret,
    started_at: startedAt.toISOString(),
    sessions,
    server_root: serverRoot,
    log: daemonLogPath(),
    idle_timeout_ms: idleTimeout
  });
  let publishing = Promise.resolve();
  const publish = () => {
    publishing = publishing
      .then(() => (retired || stopping ? undefined : writeDaemonInfo(infoPath, describe())))
      .catch((error) => log(`could not update ${infoPath}: ${error.message}`));
    return publishing;
  };

  const status = () => ({
    pid: process.pid,
    version: VERSION,
    build,
    address,
    started_at: startedAt.toISOString(),
    uptime_s: Math.round((Date.now() - startedAt.getTime()) / 1000),
    sessions,
    sessions_served: served,
    clients: [...clients.values()],
    rss_bytes: process.memoryUsage.rss(),
    idle_timeout_ms: idleTimeout,
    retired,
    server_root: serverRoot,
    log: daemonLogPath()
  });

  const releaseFiles = async () => {
    await publishing;
    await removeDaemonInfo(infoPath, process.pid).catch(() => undefined);
    await removeOwnLock(lockPath).catch(() => undefined);
    if (address && !address.startsWith("\\\\.\\pipe\\")) await fs.rm(address, { force: true }).catch(() => undefined);
  };

  const finish = async (reason) => {
    if (serverLoaded) {
      const { shutdownBgeWorkers } = await import("./mcp-stdio.mjs");
      await Promise.resolve(shutdownBgeWorkers()).catch(() => undefined);
    }
    log(`exits: ${reason}`);
    process.exit(0);
  };

  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    clearInterval(watch);
    log(`stopping: ${reason}; ${sessions} session(s) end with it`);
    listener.close();
    for (const socket of sockets) socket.destroy();
    await releaseFiles();
    await finish(reason);
  };

  // A retired daemon takes no new client and gives up its name, its lock and
  // its descriptor at once, so a successor can start; the sessions it has go on
  // until their clients close them.
  const retire = async (reason) => {
    if (retired || stopping) return;
    retired = true;
    clearTimeout(idleTimer);
    clearInterval(watch);
    log(`retiring: ${reason}; ${sessions} session(s) stay until their clients close them`);
    listener.close();
    await releaseFiles();
    if (sessions === 0) await finish(`retired: ${reason}`);
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (retired || stopping || sessions > 0 || idleTimeout <= 0) return;
    idleTimer = setTimeout(() => shutdown(`no session for ${Math.round(idleTimeout / 1000)} s`), idleTimeout);
    idleTimer.unref?.();
  };

  const control = async (socket, rest) => {
    const { message } = await readLine(socket, { buffered: rest });
    const reply = async (value) => {
      await writeLine(socket, value).catch(() => undefined);
      socket.end();
    };
    switch (message.control) {
      case "ping":
        return reply({ ok: true });
      case "status":
        return reply({ ok: true, ...status() });
      case "stop":
        await reply({ ok: true, stopping: true, sessions });
        return shutdown("asked to stop");
      case "retire":
        await reply({ ok: true, retiring: true, sessions });
        return retire("a client of another build replaces it");
      default:
        return reply({ ok: false, error: `Unknown control request: ${JSON.stringify(message.control ?? null)}.` });
    }
  };

  const serve = async (socket) => {
    const accepted = await acceptHandshake(socket, {
      secret,
      pid: process.pid,
      version: VERSION,
      build,
      welcome: async ({ mode, profiles }) => (mode === "mcp" ? (await serverModule).sessionToolCounts(profiles) : {})
    });
    if (accepted.mode === "control") return control(socket, accepted.rest);
    const { createAiDevServer } = await serverModule;
    if (socket.destroyed) return undefined;
    const id = ++served;
    sessions += 1;
    sockets.add(socket);
    clearTimeout(idleTimer);
    publish();
    const server = createAiDevServer({ profiles: accepted.profiles });
    server.onerror = (error) => log(`session ${id}: ${error.message}`);
    server.oninitialized = () => {
      const client = server.getClientVersion();
      clients.set(socket, { session: id, name: client?.name ?? "", version: client?.version ?? "", since: new Date().toISOString() });
      log(`session ${id} opened: ${client?.name ?? "a client"} ${client?.version ?? ""}`.trim());
    };
    socket.once("close", () => {
      sessions = Math.max(0, sessions - 1);
      sockets.delete(socket);
      clients.delete(socket);
      server.close().catch(() => undefined);
      log(`session ${id} closed; ${sessions} open`);
      if (retired && sessions === 0) {
        finish("retired, and its last session closed");
        return;
      }
      publish();
      armIdle();
    });
    await server.connect(new SocketServerTransport(socket, { buffered: accepted.rest }));
    return undefined;
  };

  const listener = net.createServer((socket) => {
    socket.on("error", () => undefined);
    if (retired || stopping) {
      socket.destroy();
      return;
    }
    serve(socket).catch((error) => {
      log(`refused a connection: ${error.message}`);
      socket.destroy();
    });
  });

  // A dead daemon's socket outlives it, and nothing else would remove it.
  const previous = await readDaemonInfo(infoPath);
  if (previous && previous.pid !== process.pid && !previous.address.startsWith("\\\\.\\pipe\\")) {
    await fs.rm(previous.address, { force: true }).catch(() => undefined);
  }
  try {
    address = await listenSomewhere(listener, log);
    await writeDaemonInfo(infoPath, describe());
  } catch (error) {
    await removeOwnLock(lockPath).catch(() => undefined);
    throw error;
  }
  log(`listening at ${address} — ai-dev ${VERSION}, build ${build}, idle timeout ${Math.round(idleTimeout / 1000)} s`);

  // `daemon.json` gone or naming another daemon means this one has been
  // replaced, or its runtime home removed: it steps aside instead of serving
  // on an address nobody can find.
  watch = setInterval(async () => {
    if (retired || stopping) return;
    const current = await readDaemonInfo(infoPath);
    if (!current || current.pid !== process.pid) retire(current ? `daemon.json names pid ${current.pid} now` : "daemon.json is gone");
  }, WATCH_INTERVAL_MS);
  watch.unref();

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  armIdle();
  return true;
}

if (await isDirectExecution(import.meta.url)) {
  await runDaemon();
}
