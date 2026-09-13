import fs from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createAiDevServer } from "./server.mjs";
import { daemonInfoPath, daemonLockPath, runtimeDir, socketAddress } from "./core/runtime-paths.mjs";
import { SocketServerTransport } from "./transport/socket.mjs";

const VERSION = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;

// A daemon nobody is talking to should not outlive the day. Thirty minutes is
// long enough that a client reconnecting between tasks finds a warm process,
// short enough that a forgotten one goes away on its own.
const idleTimeout = Number(process.env.AI_DEV_IDLE_TIMEOUT_MS || 30 * 60 * 1000);

/**
 * Is a process still running under this pid?
 *
 * `EPERM` means it exists and belongs to somebody else, which still counts as
 * alive — treating it as dead would steal a lock that is in use.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Take the daemon lock, clearing one left behind by a dead process.
 *
 * Exclusive create (`wx`) is the whole race protection: two daemons starting
 * at once, only one file gets made. A stale lock — written by a pid that no
 * longer exists — is removed and the attempt repeats.
 *
 * @returns {Promise<boolean>} false when another live daemon holds it
 */
async function acquireLock() {
  await fs.mkdir(runtimeDir(), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(daemonLockPath(), String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = Number(await fs.readFile(daemonLockPath(), "utf8").catch(() => "0"));
    if (owner && pidAlive(owner)) return false;
    await fs.rm(daemonLockPath(), { force: true });
    return acquireLock();
  }
}

/**
 * Run the MCP server as a local daemon, one session per connection.
 *
 * This is the alternative to starting a fresh stdio server per client: the
 * process stays warm, so the search index and the embedding model are loaded
 * once rather than on every call. The socket is created inside a 0700
 * directory and chmodded 0600, so it is reachable only by its own user.
 *
 * @returns {Promise<boolean>} false when another daemon is already serving
 */
export async function runDaemon() {
  if (!(await acquireLock())) return false;

  const address = socketAddress();
  // A socket file outlives a process killed with SIGKILL, and `listen` refuses
  // to bind over it. Windows named pipes are not files and need no such sweep.
  if (process.platform !== "win32") await fs.rm(address, { force: true });

  let sessions = 0;
  let shuttingDown = false;
  let idleTimer;

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (shuttingDown || sessions > 0 || idleTimeout <= 0) return;
    idleTimer = setTimeout(shutdown, idleTimeout);
    // An armed timer must not be the reason the process stays alive.
    idleTimer.unref?.();
  };

  const cleanup = async () => {
    clearTimeout(idleTimer);
    listener.close();
    await Promise.all([
      fs.rm(daemonInfoPath(), { force: true }),
      fs.rm(daemonLockPath(), { force: true })
    ]);
    if (process.platform !== "win32") await fs.rm(address, { force: true });
  };

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanup();
    process.exit(0);
  }

  const listener = net.createServer(async (socket) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    sessions += 1;
    clearTimeout(idleTimer);
    const server = createAiDevServer();
    socket.once("close", () => {
      sessions = Math.max(0, sessions - 1);
      server.close().catch(() => undefined);
      armIdle();
    });
    try {
      await server.connect(new SocketServerTransport(socket));
    } catch {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(address, resolve);
  });
  if (process.platform !== "win32") await fs.chmod(address, 0o600);

  await fs.writeFile(
    daemonInfoPath(),
    `${JSON.stringify({
      pid: process.pid,
      version: VERSION,
      address,
      started_at: new Date().toISOString(),
      sessions
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  armIdle();
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runDaemon();
}
