/**
 * The client side of the daemon: find the one serving this runtime home, start
 * one when there is none or it is of another build, and ask it for its status
 * or to stop. Used by the `ai-dev mcp` bridge and by `ai-dev daemon`.
 *
 * A daemon is started detached and without a window (`windowsHide`), with its
 * output in `logs/daemon.log`, so it outlives the client that started it and
 * serves the next one warm.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ChannelError, controlRequest, daemonBuild, openChannel, readDaemonInfo } from "./daemon-channel.mjs";
import { processAlive } from "./file-lock.mjs";
import { daemonInfoPath, daemonLogPath } from "./runtime-paths.mjs";

/** How long a client waits for a daemon it started. A first start fills the vault and loads the tools. */
export const DEFAULT_START_TIMEOUT_MS = 20_000;

/** The log is set aside once it passes this, so it never grows without bound. */
const LOG_ROTATE_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `AI_DEV_DAEMON_START_TIMEOUT_MS`, or the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function startTimeoutMs(env = process.env) {
  const value = Number(String(env.AI_DEV_DAEMON_START_TIMEOUT_MS ?? "").trim() || Number.NaN);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_START_TIMEOUT_MS;
}

/**
 * Whether `AI_DEV_DAEMON` turns the daemon off: `0`, `off`, `false` or `no`.
 * Then `ai-dev mcp` serves in its own process, as 2.x did.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function daemonDisabled(env = process.env) {
  return ["0", "off", "false", "no"].includes(String(env.AI_DEV_DAEMON ?? "").trim().toLowerCase());
}

/** The log a started daemon writes to, opened for appending; set aside first when large. */
function openLog() {
  const file = daemonLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  return fs.openSync(file, "a", 0o600);
}

/**
 * The last lines of the daemon's log: what it said before it failed to start.
 *
 * @param {number} [count]
 * @returns {Promise<string>}
 */
export async function logTail(count = 4) {
  try {
    const text = await fsp.readFile(daemonLogPath(), "utf8");
    const lines = text.trimEnd().split(/\r?\n/).slice(-count);
    return lines.length ? `Its log (${daemonLogPath()}) ends with: ${lines.join(" | ")}` : "";
  } catch {
    return "";
  }
}

/**
 * Start a daemon in the background.
 *
 * @param {{ cliPath: string, serverRoot: string, env: NodeJS.ProcessEnv, spawnImpl?: typeof spawn }} options
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDaemon({ cliPath, serverRoot, env, spawnImpl = spawn }) {
  const log = openLog();
  try {
    const child = spawnImpl(process.execPath, [cliPath, "daemon", "run"], {
      cwd: serverRoot,
      env,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", log, log]
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(log);
  }
}

/** A channel to a running daemon, or null when there is none to reach. */
async function reach(info, options) {
  if (!info || !processAlive(info.pid)) return null;
  try {
    return await openChannel(info, options);
  } catch {
    return null;
  }
}

/**
 * A channel to a daemon of this build: the one running, or one started now.
 *
 * A daemon of another build — a `git pull`, a new version, a different
 * `AI_DEV_VAULT_ROOT` — is asked to retire: it gives up its address at once
 * and keeps serving the clients it has until they close.
 *
 * @param {object} options
 * @param {string} options.serverRoot
 * @param {string} options.cliPath
 * @param {string} options.version
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {"mcp" | "control"} [options.mode]
 * @param {string | null} [options.profiles]
 * @param {number} [options.timeoutMs]
 * @param {typeof spawn} [options.spawnImpl]
 * @returns {Promise<{ socket: import("node:net").Socket, welcome: Record<string, any>, rest: Buffer, info: object, started: boolean, replaced: number | null }>}
 */
export async function connectDaemon({ serverRoot, cliPath, version, env = process.env, mode = "mcp", profiles = null, timeoutMs = startTimeoutMs(env), spawnImpl = spawn }) {
  const build = await daemonBuild({ serverRoot, version, env });
  const infoPath = daemonInfoPath();
  const options = { mode, profiles, timeoutMs: 3_000 };
  let replaced = null;
  const retire = async (info, channel) => {
    channel.socket.destroy();
    await controlRequest(info, "retire", { timeoutMs: 3_000 }).catch(() => undefined);
    replaced = info.pid;
  };

  const running = await readDaemonInfo(infoPath);
  const channel = await reach(running, options);
  if (channel?.welcome.build === build) return { ...channel, info: running, started: false, replaced };
  if (channel) await retire(running, channel);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const child = spawnDaemon({ cliPath, serverRoot, env, spawnImpl });
    let exited = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
    });
    child.once("error", (error) => {
      exited = { error };
    });
    const deadline = Date.now() + timeoutMs;
    let other = false;
    while (Date.now() < deadline) {
      await sleep(50);
      const info = await readDaemonInfo(infoPath);
      if (info && info.pid !== replaced) {
        const found = await reach(info, options);
        if (found?.welcome.build === build) return { ...found, info, started: true, replaced };
        if (found) {
          // A client of another build started its daemon at the same moment
          // and won the lock: it steps aside once, and this one starts again.
          await retire(info, found);
          other = true;
          break;
        }
      }
      // Exit 0 is a daemon that found another serving: wait for that one.
      if (exited && (exited.error || exited.code !== 0)) {
        const why = exited.error ? exited.error.message : `it exited with ${exited.code ?? exited.signal}`;
        throw new ChannelError(`The daemon did not start: ${why}. ${await logTail()}`.trim(), { code: "ESTART" });
      }
    }
    if (!other) throw new ChannelError(`The daemon did not start within ${Math.round(timeoutMs / 1000)} s. ${await logTail()}`.trim(), { code: "ETIMEDOUT" });
  }
  throw new ChannelError("Two builds of AI Dev keep replacing each other's daemon; this client serves itself.", { code: "ESTART" });
}

/**
 * What the daemon says about itself, or why there is none.
 *
 * @param {{ serverRoot: string, version: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function daemonStatus({ serverRoot, version, env = process.env }) {
  const info = await readDaemonInfo(daemonInfoPath());
  if (!info) return { running: false, info: daemonInfoPath() };
  if (!processAlive(info.pid)) return { running: false, stale: true, pid: info.pid, reason: `daemon.json names pid ${info.pid}, which is not running` };
  let status;
  try {
    status = await controlRequest(info, "status");
  } catch (error) {
    return { running: false, stale: true, pid: info.pid, reason: error.message };
  }
  const build = await daemonBuild({ serverRoot, version, env });
  return { running: true, ...status, ok: undefined, current: status.build === build };
}

/**
 * Stop the daemon: a control request, the same on every system — Windows has
 * no signal to send it — then wait for its process to go.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ running: boolean, stopped?: boolean, pid?: number, sessions?: number, reason?: string }>}
 */
export async function stopDaemon({ timeoutMs = 10_000 } = {}) {
  const info = await readDaemonInfo(daemonInfoPath());
  if (!info || !processAlive(info.pid)) return { running: false };
  let answer;
  try {
    answer = await controlRequest(info, "stop");
  } catch (error) {
    return { running: true, stopped: false, pid: info.pid, reason: error.message };
  }
  const deadline = Date.now() + timeoutMs;
  while (processAlive(info.pid) && Date.now() < deadline) await sleep(50);
  return { running: false, stopped: !processAlive(info.pid), pid: info.pid, sessions: answer.sessions ?? 0 };
}
