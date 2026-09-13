import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/**
 * The private, per-user state directory the standalone program runs from.
 *
 * Everything the daemon writes lives below it: the socket, the lock, the
 * descriptor other processes read to find a running daemon.
 *
 * @returns {string} absolute path
 */
export function aiDevHome() {
  return path.resolve(resolveRuntimeStateRoot());
}

/** Directory for live runtime artefacts (socket, lock, daemon descriptor). */
export const runtimeDir = () => path.join(aiDevHome(), "run");

/** Directory for runtime logs. */
export const logsDir = () => path.join(aiDevHome(), "logs");

/** Descriptor a running daemon publishes: pid, version, address, sessions. */
export const daemonInfoPath = () => path.join(runtimeDir(), "daemon.json");

/** Lock file that keeps a second daemon from taking the same socket. */
export const daemonLockPath = () => path.join(runtimeDir(), "daemon.lock");

/** Per-user client configuration (trusted projects, and what else accrues). */
export const clientConfigPath = () => path.join(aiDevHome(), "config.json");

/** Root of persisted task state. */
export const tasksStateRoot = () => path.join(aiDevHome(), "state");

/**
 * Sanitise a username for use inside a Windows named pipe.
 *
 * A pipe name is not a path: it accepts a narrow character set, and a domain
 * account (`CORP\Ivan Petrov`) carries a separator and a space that would end
 * the name early. Everything outside the safe set becomes an underscore.
 *
 * @param {string} username
 * @returns {string} a name safe to interpolate, never empty
 */
export function pipeSafeUsername(username) {
  const safe = String(username || "").replace(/[^A-Za-z0-9_-]/g, "_");
  return safe || "user";
}

/**
 * The address the daemon listens on, and clients dial.
 *
 * Windows has no Unix sockets, so it gets a named pipe; everywhere else the
 * socket lives beside the lock, inside a directory created with mode 0700.
 * The platform and username are parameters so the branch a machine will never
 * take is still testable.
 *
 * @param {{ platform?: string, username?: string, directory?: string }} [options]
 * @returns {string} socket path or pipe name
 */
export function socketAddress(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const username = options.username ?? os.userInfo().username;
    return `\\\\.\\pipe\\ai-dev-${pipeSafeUsername(username)}`;
  }
  return path.join(options.directory ?? runtimeDir(), "ai-dev.sock");
}
