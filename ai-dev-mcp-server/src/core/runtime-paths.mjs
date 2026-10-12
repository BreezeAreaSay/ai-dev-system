import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/**
 * The private, per-user state directory the standalone program runs from.
 *
 * Everything the daemon writes lives below it: the lock, the descriptor other
 * processes read to find a running daemon, and — when the path is short
 * enough — the socket.
 *
 * @returns {string} absolute path
 */
export function aiDevHome() {
  return path.resolve(resolveRuntimeStateRoot());
}

/** Directory for live runtime artefacts (lock, daemon descriptor, usually the socket). */
export const runtimeDir = () => path.join(aiDevHome(), "run");

/** Directory for runtime logs. */
export const logsDir = () => path.join(aiDevHome(), "logs");

/** Descriptor a running daemon publishes: pid, version, address, secret, sessions. */
export const daemonInfoPath = () => path.join(runtimeDir(), "daemon.json");

/** Lock file that keeps a second daemon from serving the same runtime home. */
export const daemonLockPath = () => path.join(runtimeDir(), "daemon.lock");

/** Where the daemon writes what it does, when a bridge started it. */
export const daemonLogPath = () => path.join(logsDir(), "daemon.log");

/** Per-user client configuration (trusted projects, and what else accrues). */
export const clientConfigPath = () => path.join(aiDevHome(), "config.json");

/** Root of persisted task state. */
export const tasksStateRoot = () => path.join(aiDevHome(), "state");

/**
 * The longest socket path used. `sockaddr_un` holds 108 bytes on Linux and 104
 * on macOS, terminating NUL included, and libuv cuts a longer path short
 * without a word: `listen` then makes a socket under a truncated name and the
 * daemon dies on the next call that names the real one (docs/DEFECTS.md, Д-97).
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * A new, unguessable name for one daemon's socket or pipe.
 *
 * Every daemon start draws its own, and `daemon.json` says which it is. A fixed
 * name — `\\.\pipe\ai-dev-<user>` until 3.0 — is one any local process can
 * create first and so receive every client's connection (docs/DEFECTS.md,
 * Д-107).
 *
 * @param {Buffer} [bytes]
 * @returns {string}
 */
export function randomDaemonName(bytes = crypto.randomBytes(12)) {
  return `ai-dev-${bytes.toString("hex")}`;
}

/**
 * The directories a daemon's Unix socket may live in, in order of preference:
 * the runtime's own `run/`, then `$XDG_RUNTIME_DIR/ai-dev`, then
 * `/tmp/ai-dev-<uid>`. The second and third are there for a runtime home whose
 * path leaves too little room for a socket name: a OneDrive profile, a CI
 * workspace, a container volume.
 *
 * @param {{ runDir?: string, env?: NodeJS.ProcessEnv, uid?: number, tmp?: string }} [options]
 * @returns {string[]}
 */
export function socketDirectoryCandidates({ runDir = runtimeDir(), env = process.env, uid = process.getuid?.() ?? 0, tmp = "/tmp" } = {}) {
  const candidates = [runDir];
  const xdg = String(env.XDG_RUNTIME_DIR ?? "").trim();
  if (xdg && path.isAbsolute(xdg)) candidates.push(path.join(xdg, "ai-dev"));
  candidates.push(path.join(tmp, `ai-dev-${uid}`));
  return candidates;
}

/**
 * Where a new daemon may listen: a named pipe on Windows; elsewhere, a socket
 * in each candidate directory whose full path fits {@link MAX_SOCKET_PATH_BYTES}
 * — counted in bytes, so a home spelled in Cyrillic is measured as the kernel
 * measures it. The daemon takes the first one it can prepare and bind.
 *
 * @param {{ platform?: string, name?: string, runDir?: string, env?: NodeJS.ProcessEnv, uid?: number, tmp?: string }} [options]
 * @returns {Array<{ address: string, directory: string | null }>}
 */
export function daemonAddressCandidates({ platform = process.platform, name = randomDaemonName(), ...where } = {}) {
  if (platform === "win32") return [{ address: `\\\\.\\pipe\\${name}`, directory: null }];
  return socketDirectoryCandidates(where)
    .map((directory) => ({ address: path.join(directory, `${name}.sock`), directory }))
    .filter(({ address }) => Buffer.byteLength(address) <= MAX_SOCKET_PATH_BYTES);
}

/**
 * Make a socket's directory, and make sure it is this user's alone: a plain
 * directory, not a link, owned by this uid, with no access for group or
 * others. `/tmp/ai-dev-<uid>` can be created by anyone before the daemon gets
 * there; a directory that is not ours is refused rather than used.
 *
 * @param {string} directory
 * @param {{ uid?: number }} [options]
 * @returns {Promise<void>}
 */
export async function prepareSocketDirectory(directory, { uid = process.getuid?.() } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${directory} is not a plain directory.`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${directory} belongs to uid ${stat.uid}, not to this user (${uid}).`);
  if ((stat.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
}
